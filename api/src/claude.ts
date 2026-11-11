/**
 * The Claude client.
 *
 * Two rules shape everything here:
 *
 *   Claude never does arithmetic that matters. Every number it sees comes from
 *   analytics.ts, already computed and already formatted. It explains,
 *   prioritises and proposes; it does not calculate. Financial figures have to
 *   be identical every time you ask.
 *
 *   Claude never writes. It calls the same tools the UI does, and the write
 *   ones return proposals. A proposal only becomes an event when a person
 *   approves it, and the event is attributed to the approver.
 */

import Anthropic from '@anthropic-ai/sdk';

import { claudeAccepted, claudeRejected, resolvedEnv } from './connectors.ts';
import { DEFAULT_MATCH_MODEL } from './match.ts';
import { TOOLS, ToolError, forClaude, runTool, toolByName } from './tools.ts';
import type { Tool, ToolContext } from './tools.ts';

/**
 * Opus 5 thinks by default and `max_tokens` caps thinking *and* response text
 * together, so this needs real headroom — a tight limit truncates mid-answer.
 */
const MAX_TOKENS = Number(process.env['CLAUDE_MAX_TOKENS'] ?? 16000);
const MODEL = process.env['CLAUDE_MODEL'] ?? 'claude-opus-5';
const EFFORT = (process.env['CLAUDE_EFFORT'] ?? 'medium') as
  'low' | 'medium' | 'high' | 'xhigh' | 'max';

export class ClaudeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeUnavailable';
  }
}

/** Declined by a safety classifier — a 200 response, not an error. */
export class ClaudeRefused extends Error {
  readonly category: string | null;
  constructor(category: string | null, explanation?: string) {
    super(explanation ?? `Claude declined this request (${category ?? 'no category'})`);
    this.name = 'ClaudeRefused';
    this.category = category;
  }
}

let client: Anthropic | null = null;
let forced = false;

/** The key as it stands now: a saved one (as ANTHROPIC_API_KEY), else ANTHROPIC_API_KEY, else ANTHROPIC_AUTH_TOKEN; null when off or unset. */
export function claudeKey(): { readonly key: string; readonly as: 'apiKey' | 'authToken' } | null {
  const env = resolvedEnv();
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (apiKey) return { key: apiKey, as: 'apiKey' };
  const authToken = env['ANTHROPIC_AUTH_TOKEN'];
  if (authToken) return { key: authToken, as: 'authToken' };
  return null;
}

/**
 * A client built with the key as it stands, every call, never cached with a key
 * in it: a key saved, reset or revoked counts from the next request. A test's
 * client from setClaudeClient wins. Bounded: a screen waits on these, and an
 * outage should cost a minute at most, not the SDK's ten-minute default times three.
 */
export function claude(): Anthropic {
  if (client) return client;
  const found = claudeKey();
  if (!found) throw new ClaudeUnavailable('Claude is off on this NAS');
  return new Anthropic({
    apiKey: found.as === 'apiKey' ? found.key : null,
    authToken: found.as === 'authToken' ? found.key : null,
    timeout: 90_000,
    maxRetries: 1,
  });
}

/** Swap in a stub so the suite runs — and stays honest — without an API key. */
export function setClaudeClient(fake: Anthropic | null): void {
  client = fake;
  forced = fake !== null;
}

/** Never reads ANTHROPIC_BASE_URL: a base address alone is not a key. */
export const claudeConfigured = (): boolean => forced || claudeKey() !== null;

/** The one place a request leaves for Anthropic: a 401 is remembered and rethrown, a success clears it. */
async function live<T>(send: () => Promise<T>): Promise<T> {
  try {
    const reply = await send();
    claudeAccepted();
    return reply;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) claudeRejected(Date.now());
    throw err;
  }
}

/** One minimal request to the deployment's envelope model, for This NAS's Test. Never throws; never says the key. */
export async function testClaude(): Promise<{ ok: boolean; words: string }> {
  try {
    const api = claude();
    await live(() => api.messages.create({
      model: process.env['CLAUDE_MATCH_MODEL'] || DEFAULT_MATCH_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }));
    return { ok: true, words: 'Claude answered' };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, words: 'the key has expired or been revoked' };
    // Only Anthropic's own answers, and ours, are worded from the error. Anything
    // thrown on the way out (a key the headers refuse, say) may quote the key.
    if (err instanceof Anthropic.APIError || err instanceof ClaudeUnavailable) return { ok: false, words: unavailableReason(err) };
    return { ok: false, words: 'the key could not be sent' };
  }
}

// ─── the standing instructions ───────────────────────────────────────────────

/**
 * Kept byte-stable and passed first so it caches. Anything that varies per
 * request goes in the user turn, after the cache breakpoint.
 */
/**
 * What the assistant is told, before it is told anything about you.
 *
 * The method is the application; the household is not. This describes zero-based
 * budgeting and the rules that keep the figures trustworthy — nothing here names
 * a person or a place, so the same image runs for anyone.
 *
 * Who lives here comes from the log at request time and is appended below.
 */
export const METHOD_RULES = `You are this household's assistant: its budget, its plans and its calendar. You speak to
the people who share it as a careful colleague would: plainly, briefly, and without flattery.

HOW THE BUDGET WORKS

The plan is zero-based: every dollar of take-home is assigned a job, and the month balances to zero
rather than reporting a surplus. The household has one budget: a set of ENVELOPES, each a month's
money for one thing, sitting under CATEGORIES, which are only headings that group them on the page.

Every receipt is sorted by a person into exactly one envelope, or split across several, and counts
there and nowhere else. A receipt not sorted yet is in To sort, and no envelope counts it. Your
suggestions name an envelope; a person decides.

Each month the budget opens with a PLAN, snapshotted from its template. That plan is never rewritten.
Money moved between envelopes during the month is an ADJUSTMENT layered on top, so "planned $325,
funded $421" is always answerable. A move is zero-sum and never changes the month's total; an
assignment does change it, and has to come out of what is left to assign.

Transfers between their own accounts, and payments to a credit card whose charges are already
imported, are not spending: they are sorted as a transfer, and income as income, and no envelope
counts either.

TWO RULES YOU MUST FOLLOW

1. Never do arithmetic. Every figure you state must be copied verbatim from a tool result. Do not
   add, subtract, average, project or convert numbers yourself, even when it looks trivial — the
   tools have already computed everything, and a number you derive can disagree with the app. If
   you need a figure no tool gives you, say so rather than working it out.

2. Never claim to have changed anything. The write tools return a proposal, not a result. Describe
   what a proposal would do and let them approve it. Never say a change has been made.

HOW TO BE USEFUL

The most valuable observation you can make is that a PLAN is wrong, not that a month is over.
"Over by $96" is a this-month problem they will patch. "Planned $325 three months running, funded
$421, $390 and $408" is a wrong-plan problem they can fix once. Prefer the second whenever the
tools show it.

Be specific about consequences and name the source of a fix. "Dining out is $96 over with 18 days
left, and Personal has $310 spare" is useful; "you are overspending" is not.

Assume they know the method and do not need it explained.

When asked to put something on a calendar, work out the day from TODAY where the household is:
"tomorrow" is the day after today, "Thursday" the next Thursday to come. Propose the time they said
and no other; never move it without saying so, and leave any other time to the free ones the card
offers. Name every clash by its calendar and time. Make a plan with it only if they asked for one.

Write in plain sentences. No emoji, no headers, no bullet lists unless asked. Short is good;
unclear is not.`;

/**
 * Who lives here, assembled from the log rather than written into the source.
 *
 * Appended after the cacheable method above, so the stable prefix stays stable
 * across households and the specifics change without touching a prompt.
 */
export function householdContext(state: {
  label: string;
  members: ReadonlySet<string>;
  location: { label: string } | null;
}): string {
  const people = [...state.members].sort();
  return `THIS HOUSEHOLD\n\n`
    + `${state.label}. The people who use it: ${people.join(' and ') || 'nobody yet'}.\n`
    + (state.location ? `Where it is: ${state.location.label}.\n` : '')
    + `Anything else you need about them is in the tools — ask rather than assume.`;
}

/** The full system prompt: the stable method, then this household. */
export const houseRules = (state: Parameters<typeof householdContext>[0]): string =>
  `${METHOD_RULES}\n\n${householdContext(state)}`;

// ─── tools, in the shape the API wants ───────────────────────────────────────

export const anthropicTools = (
  kinds: ReadonlyArray<'read' | 'write'> = ['read', 'write'],
  allow: (t: Tool) => boolean = () => true,
) =>
  TOOLS.filter((t) => kinds.includes(t.kind) && allow(t)).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input as Anthropic.Tool.InputSchema,
  }));

// ─── the loop ────────────────────────────────────────────────────────────────

export interface AskResult {
  readonly text: string;
  readonly toolsUsed: readonly string[];
  /** Every tool call, with its arguments, so a write can be offered again by name. */
  readonly calls: readonly { name: string; args: Record<string, unknown>; kind: 'read' | 'write' }[];
  /** Proposals Claude wants approved. Nothing has been written. */
  readonly proposals: readonly unknown[];
  readonly usage: { input: number; output: number };
  readonly model: string;
}

/**
 * Answer a question, letting Claude call the same tools the UI calls.
 *
 * Runs the loop manually rather than through the SDK's tool runner: write tools
 * must surface their proposals to the caller rather than being applied, and the
 * runner is built around tools that actually execute.
 */
export async function ask(
  question: string,
  ctx: ToolContext,
  /**
   * `tools` narrows what Claude is handed; a call outside it is refused like an unknown tool.
   * `bind` sets the args a call is run with, from the args Claude gave: what the caller fixes, not Claude.
   */
  opts: {
    maxTurns?: number; context?: string; tools?: (t: Tool) => boolean;
    bind?: (t: Tool, args: Record<string, unknown>) => Record<string, unknown>;
  } = {},
): Promise<AskResult> {
  const allow = opts.tools ?? (() => true);
  const maxTurns = opts.maxTurns ?? 6;
  const api = claude();

  const messages: Anthropic.Beta.BetaMessageParam[] = [{
    role: 'user',
    content: [
      ...(opts.context ? [{ type: 'text' as const, text: opts.context }] : []),
      { type: 'text' as const, text: question },
    ],
  }];

  const toolsUsed: string[] = [];
  const done: { name: string; args: Record<string, unknown>; kind: 'read' | 'write' }[] = [];
  const proposals: unknown[] = [];
  let input = 0;
  let output = 0;
  let model = MODEL;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await live(() => api.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // Stable first so the prefix caches; the question is already in messages.
      // Method first and cached; the household after the breakpoint, so the
      // stable prefix stays stable and the specifics cost nothing to change.
      system: [
        { type: 'text', text: METHOD_RULES, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: householdContext(ctx.store.state) },
      ],
      tools: anthropicTools(['read', 'write'], allow),
      messages,
    }));

    input += response.usage.input_tokens ?? 0;
    output += response.usage.output_tokens ?? 0;
    model = response.model ?? model;

    // A classifier decline is a 200 with an empty or partial body — check this
    // before touching content, or the read blows up on an empty array.
    if (response.stop_reason === 'refusal') {
      throw new ClaudeRefused(response.stop_details?.category ?? null, response.stop_details?.explanation ?? undefined);
    }

    messages.push({ role: 'assistant', content: response.content });

    const calls = response.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (calls.length === 0 || response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text).join('\n').trim();
      return { text, toolsUsed, calls: done, proposals, usage: { input, output }, model };
    }

    // Every tool_use needs a matching tool_result in one user message, or the
    // next request is rejected.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      toolsUsed.push(call.name);
      const found = toolByName.get(call.name);
      const tool = found && forClaude(found) && allow(found) ? found : undefined;
      if (!tool) {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true,
                       content: found ? `${call.name} is not available here` : `no tool named ${call.name}` });
        continue;
      }
      try {
        const given = (call.input ?? {}) as Record<string, unknown>;
        const args = opts.bind ? opts.bind(tool, given) : given;
        // runTool records the args on a write's proposal, for its effect on approval.
        const result = await runTool(tool, args, ctx);
        done.push({ name: call.name, args, kind: tool.kind });
        if (tool.kind === 'write') proposals.push(result);
        results.push({ type: 'tool_result', tool_use_id: call.id,
                       content: JSON.stringify(result) });
      } catch (err) {
        // Hand the error back rather than aborting — Claude can usually
        // recover by calling something else.
        const message = err instanceof ToolError ? err.message : 'that tool failed';
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: message });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  throw new ClaudeUnavailable(`gave up after ${maxTurns} turns without a final answer`);
}

/**
 * A small structured call on a cheap model, for sorting rather than reasoning.
 *
 * Haiku takes no server-side fallback, so none is asked for; a refusal still
 * surfaces as one. Low effort, because matching a payee to an envelope name is
 * recognition, not analysis.
 */
export async function classify<T>(
  model: string,
  system: string,
  userContent: string,
  schema: Record<string, unknown>,
): Promise<T> {
  const api = claude();
  const response = await live(() => api.beta.messages.create({
    model,
    max_tokens: 8000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  }));
  if (response.stop_reason === 'refusal') {
    throw new ClaudeRefused(response.stop_details?.category ?? null, response.stop_details?.explanation ?? undefined);
  }
  if (response.stop_reason === 'max_tokens') throw new ClaudeUnavailable('the reply was cut off');
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text).join('');
  return JSON.parse(text) as T;
}

/** One structured call, no tools. Used for the briefing. */
export async function structured<T>(
  system: string,
  userContent: string,
  schema: Record<string, unknown>,
): Promise<{ value: T; usage: { input: number; output: number } }> {
  const api = claude();
  const response = await live(() => api.beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  }));

  if (response.stop_reason === 'refusal') {
    throw new ClaudeRefused(response.stop_details?.category ?? null, response.stop_details?.explanation ?? undefined);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ClaudeUnavailable('the response was cut off — raise CLAUDE_MAX_TOKENS');
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text).join('');
  return {
    value: JSON.parse(text) as T,
    usage: { input: response.usage.input_tokens ?? 0, output: response.usage.output_tokens ?? 0 },
  };
}

/**
 * One readable sentence for why Claude was unavailable.
 *
 * The SDK's message is the HTTP status and the raw JSON body. The API's own
 * sentence is inside it, and only its first sentence is worth a place on the
 * screen — "Please go to Plans & Billing" is advice for the operator.
 */
export function unavailableReason(err: unknown): string {
  const inner = (err as { error?: { error?: { message?: unknown } } })?.error?.error?.message;
  const text = typeof inner === 'string' && inner ? inner : (err as Error)?.message ?? String(err);
  const first = text.split(/(?<=\.)\s/)[0] ?? text;
  return first.replace(/\.$/, '').slice(0, 160);
}
