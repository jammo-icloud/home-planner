/**
 * Sorting receipts in the language of envelopes, with Haiku suggesting.
 *
 * A person thinks "that goes in Groceries". So the picker lists the household's
 * envelopes by name under their categories, and choosing one sorts the receipt
 * into that envelope: the option's value is the envelope's id.
 *
 * Rules run first: free and exact. Whatever they leave is offered to Haiku as
 * payee names and envelope names only — no amounts, dates or accounts — and
 * what comes back is a suggestion until a person accepts it.
 */

import { classify, claudeConfigured, unavailableReason } from './claude.ts';
import type { Source } from './connectors.ts';
import { inToSort } from './analytics.ts';
import { byRule } from './replay.ts';
import { INCOME, SPLIT, TRANSFER } from './types.ts';
import type { SortedInto, State } from './types.ts';

export interface PickerOption { readonly value: string; readonly label: string; readonly group: string }
export interface Suggestion {
  readonly value: string;
  readonly confidence: number;
  /** The merchant's name as a rule would match it; present only when it passed `ruleProblem`. */
  readonly rule?: string;
  /** When `value` is a split: the envelopes the model thinks it is usually divided between. */
  readonly parts?: readonly string[];
}

/** Below this, a suggestion is a guess, and a guess left unsorted is better than one filed wrong. */
export const MATCH_THRESHOLD = 0.7;

// `||`, not `??`: compose passes an unset variable through as an empty string.
export const DEFAULT_MATCH_MODEL = 'claude-haiku-5-5';
/** The models Settings offers: today's default, and one more careful. */
export const MATCH_MODELS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5: quick, and the default' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5: slower and more careful' },
];

/** The list Settings offers: MATCH_MODELS, and CLAUDE_MATCH_MODEL when set and not among them, marked from the deployment. */
export function modelChoices(env: NodeJS.ProcessEnv = process.env): { id: string; label: string; fromDeployment: boolean }[] {
  const out = MATCH_MODELS.map((m) => ({ id: m.id, label: m.label, fromDeployment: false }));
  const deployed = env['CLAUDE_MATCH_MODEL']?.trim();
  if (deployed && !out.some((m) => m.id === deployed)) out.push({ id: deployed, label: deployed, fromDeployment: true });
  return out;
}

/** The household's choice, else CLAUDE_MATCH_MODEL, else the default. Read per call. */
export function matchModel(state: State, env: NodeJS.ProcessEnv = process.env): string {
  return state.settings.model ?? (env['CLAUDE_MATCH_MODEL']?.trim() || DEFAULT_MATCH_MODEL);
}

/** Where `matchModel` got its answer, in the words Settings uses. */
export function modelSource(state: State, env: NodeJS.ProcessEnv = process.env): Source {
  if (state.settings.model !== null) return 'saved';
  return env['CLAUDE_MATCH_MODEL']?.trim() ? 'from the deployment' : 'default';
}
const NOT_SPENDING = 'Not spending';

/** Offered last, to the person and to the model alike: one list serves both. */
export const SPLIT_OPTION: PickerOption = { value: SPLIT, label: 'Split across envelopes…', group: 'Several envelopes' };

/**
 * What a receipt can be sorted into: each live envelope by name, grouped under
 * its category's label, in category order then envelope order; then the two
 * kinds of money that are not spending; then a split.
 */
export function pickerOptions(state: State): PickerOption[] {
  const place = new Map([...state.categories.keys()].map((id, i) => [id, i]));
  const rank = (c: string) => place.get(c) ?? place.size;
  const envelopes = [...state.envelopes.values()]
    .sort((a, b) => rank(a.category) - rank(b.category) || a.order - b.order);
  return [
    ...envelopes.map((e) => ({ value: e.id, label: e.label, group: state.categories.get(e.category)?.label ?? e.category })),
    { value: TRANSFER, label: 'Transfer between our accounts', group: NOT_SPENDING },
    { value: INCOME, label: 'Income', group: NOT_SPENDING },
    SPLIT_OPTION,
  ];
}

const SYSTEM = `You sort a household's bank transactions into their budget envelopes.

You are given the envelopes (each with an id and a name) and a list of payee strings exactly as the
bank wrote them. For each payee, choose the one envelope id it most plausibly belongs to, and say how
sure you are from 0 to 1. Bank descriptors are noisy: store numbers, city names and reference codes
are not part of the merchant. If you cannot tell, give a low confidence rather than a guess. Choose
only from the ids given.

A household sometimes divides one merchant's receipts across several envelopes every time: a
warehouse store, say, is groceries and household goods on the same receipt. For such a payee answer
the id __split, and in parts list the ids it is usually divided between, when you can say. Never
answer __split for a merchant that sells one kind of thing.

For every payee also give rule: the shortest run of the payee text, as written, that identifies the
merchant and nothing else. Store numbers, cities, dates and reference codes are not the merchant.
HILLTOP FOODS #12 SPRINGFIELD gives hilltop foods. BIGBOX WHSE #0100 gives bigbox. If you cannot say,
give an empty string.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matches'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['payee', 'choice', 'confidence', 'rule'],
        properties: {
          payee: { type: 'string' },
          choice: { type: 'string' },
          confidence: { type: 'number' },
          rule: { type: 'string' },
          parts: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

/**
 * Ask Haiku once for every distinct payee. Anything not confidently one of the
 * options is dropped. What rides along is checked too, but a bad `rule` or
 * `parts` costs only itself: the suggestion stays.
 */
export async function suggest(state: State, payees: readonly string[], options: readonly PickerOption[]):
  Promise<Map<string, Suggestion>> {
  const out = new Map<string, Suggestion>();
  const asked = [...new Set(payees.map((p) => p.trim()).filter(Boolean))];
  if (!asked.length || !claudeConfigured()) return out;

  const envelopes = options.map((o) => ({ id: o.value, name: o.label, group: o.group }));
  const reply = await classify<{ matches: { payee: string; choice: string; confidence: number; rule?: string; parts?: string[] }[] }>(
    matchModel(state), SYSTEM, JSON.stringify({ envelopes, payees: asked }), SCHEMA as unknown as Record<string, unknown>);

  const valid = new Set(options.map((o) => o.value));
  const sent = new Set(asked);
  for (const m of reply.matches) {
    if (!sent.has(m.payee) || !valid.has(m.choice) || !(m.confidence >= MATCH_THRESHOLD)) continue;
    const parts = m.choice === SPLIT && Array.isArray(m.parts)
      ? [...new Set(m.parts)].filter((p) => p !== SPLIT && valid.has(p)) : [];
    const rule = typeof m.rule === 'string' ? m.rule.trim() : '';
    const ok = rule !== '' && ruleProblem(state, m.payee, rule, m.choice) === null;
    out.set(m.payee, {
      value: m.choice, confidence: m.confidence,
      ...(ok ? { rule } : {}),
      ...(parts.length ? { parts } : {}),
    });
  }
  return out;
}

/**
 * Suggestions for the rows no rule sorted, keyed by row id, and the ids of rows
 * a rule has already said to divide.
 *
 * Those are a person's to divide, so they are never sent. An open row that
 * `byRule` would mark split (the queue, whose rows carry the memo it reads)
 * comes back in `toDivide`; a row already marked split (Import) is just left
 * out, since that screen already knows.
 *
 * Never throws for Claude being unavailable: an import without suggestions is
 * still an import, so the reason comes back beside an empty answer.
 */
export async function suggestForRows(state: State,
  rows: readonly { id: string; payee: string; memo?: string; envelope: SortedInto | string | null }[]):
  Promise<{ suggested: Map<string, Suggestion>; toDivide: Set<string>; error?: string }> {
  const suggested = new Map<string, Suggestion>();
  const toDivide = new Set<string>();
  const open: typeof rows[number][] = [];
  for (const r of rows) {
    if (r.envelope !== null) continue;
    if (byRule(state.rules, r) === SPLIT) toDivide.add(r.id); else open.push(r);
  }
  if (!open.length) return { suggested, toDivide };
  try {
    const byPayee = await suggest(state, open.map((r) => r.payee), pickerOptions(state));
    for (const r of open) {
      const s = byPayee.get(r.payee.trim());
      if (s) suggested.set(r.id, s);
    }
    return { suggested, toDivide };
  } catch (err) {
    return { suggested, toDivide, error: `Claude could not suggest envelopes: ${unavailableReason(err)}` };
  }
}

/** What a sorted receipt or a part of one is called on a card: a split, a transfer, income, or its envelope's name (a removed one's too). */
export const filedLabel = (state: State, e: SortedInto): string =>
  e === SPLIT ? 'a split' : e === TRANSFER ? 'a transfer' : e === INCOME ? 'income'
  : state.envelopes.get(e)?.label ?? state.removedEnvelopes.get(e)?.label ?? e;

/**
 * Why a rule string may not be offered, or null when it may: empty, under 3
 * characters, not in the payee (when `payee` is given), already a rule, or
 * already filed elsewhere.
 *
 * A rule rewrites every future receipt it matches, so one that contradicts what
 * a person already did is worse than none. The scan reads receipts the way
 * `byRule` does — payee and memo, lower-cased, by substring — so what it
 * rejects is exactly what the rule would have swept up. A receipt To sort holds
 * (nobody has filed it yet, or it names an envelope that has gone, in a month
 * that does not keep it) is filed nowhere and never blocks; a split counts as
 * filed under "a split", which is only agreeable to a rule that also says split.
 */
export function ruleProblem(state: State, payee: string | null, rule: string, target: string): string | null {
  const match = rule.trim().toLowerCase();
  if (match.length < 3) return 'a rule needs at least 3 characters';
  if (payee !== null && !payee.toLowerCase().includes(match)) return 'not in the payee';
  if (state.rules.some((r) => r.match.trim().toLowerCase() === match)) return 'already a rule';
  const elsewhere = new Set<string>();
  for (const t of state.txns.values()) {
    if (t.envelope === null || t.envelope === target || inToSort(state, t)) continue;
    if (byRule([{ id: '', match, envelope: target }], t) !== null) elsewhere.add(filedLabel(state, t.envelope));
  }
  return elsewhere.size ? `already filed under ${[...elsewhere].join(', ')}` : null;
}
