/**
 * Rolling receipts up into the household's envelopes.
 *
 * A person sorts each receipt into one envelope, or splits it across several,
 * and each part counts there and only there. A part in an envelope since
 * removed counts in that envelope's history only in a month that was closed
 * when it went and is closed still; anywhere else it counts nowhere, and To
 * sort holds the receipt (analytics.ts).
 */

import { ZERO, add, sub, max, cents } from './money.ts';
import type { Cents } from './money.ts';
import { ToolError } from './errors.ts';
import { fundedFor, plannedFor, trailFor } from './replay.ts';
import { INCOME, SPLIT, TRANSFER, isSpend, monthOf, partsOf, prevMonth, slug } from './types.ts';
import type {
  Adjustment, CategoryId, Envelope, EnvelopeId, Month, MonthPlan, State,
} from './types.ts';

/**
 * Whether a removed envelope keeps `month` in its history: the month was
 * closed when it was removed, and is closed still. Reopening it sends its
 * receipts to To sort; closing a month after the removal does not take them.
 */
export function keptIn(state: Pick<State, 'removedEnvelopes' | 'months'>, envelope: EnvelopeId, month: Month): boolean {
  const gone = state.removedEnvelopes.get(envelope);
  return gone !== undefined && gone.keptIn.includes(month) && state.months.get(month)?.closed === true;
}

// ─── ids ──────────────────────────────────────────────────────────────────────

const RESERVED: ReadonlySet<string> = new Set([TRANSFER, INCOME, SPLIT]);
/** Ids already taken: a map of the state, or that and the ones a proposal is making. */
interface Taken { has(id: string): boolean }

/** `base`, else `base-2`, `base-3`… the first that `taken` does not hold. */
function fresh(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

function idBase(label: string): string {
  const base = slug(label);
  if (!base) throw new ToolError('that name has no letters or numbers in it');
  return base;
}

/**
 * The id a new envelope called `label` takes: from its name, then `-2`, `-3`…
 * while a live envelope, a removed one or a reserved value has it. A removed
 * envelope's id is never given again, so a new envelope of the same name never
 * pulls old receipts back. `base` keeps a starter row's own id when it is free.
 */
export function envelopeIdFor(
  state: { readonly envelopes: Taken; readonly removedEnvelopes: Taken }, label: string, base?: string,
): EnvelopeId {
  return fresh(base ?? idBase(label), (id) => state.envelopes.has(id) || state.removedEnvelopes.has(id) || RESERVED.has(id));
}

/** The id a new category called `label` takes: from its name, then `-2`… while a live category has it. */
export function categoryIdFor(state: { readonly categories: Taken }, label: string, base?: string): CategoryId {
  return fresh(base ?? idBase(label), (id) => state.categories.has(id));
}

// ─── month rollup ─────────────────────────────────────────────────────────────

/**
 * One part of one receipt landing in an envelope. A plain receipt is one line;
 * a split receipt is a line per part that lands here.
 */
export interface EnvelopeLine {
  readonly txnId: string;
  /** Money out, positive. The part's share, not the whole receipt. */
  readonly amount: Cents;
  readonly split: boolean;
}

export interface EnvelopeView {
  readonly envelope: Envelope;
  /** Set when the month opened. Never changes. */
  readonly planned: Cents;
  /** Planned plus in-month adjustments. */
  readonly funded: Cents;
  /** Carried in from last month, when this envelope rolls over. */
  readonly carried: Cents;
  /** Money out, net of refunds. Positive means spent. */
  readonly activity: Cents;
  /** carried + funded − activity. */
  readonly available: Cents;
  readonly overspent: boolean;
  /** Set when in-month adjustments moved it off plan. Drives the "was $325" line. */
  readonly adjustedBy: Cents;
  readonly trail: readonly Adjustment[];
  /** Each distinct receipt that lands here, in first-seen order. */
  readonly txnIds: readonly string[];
  /** Each part that lands here. What pace and the receipts list count. */
  readonly lines: readonly EnvelopeLine[];
  /**
   * Only in a month that keeps a removed envelope: its `envelope` is built from
   * the record (rollover false, template 0), and it sits after its category's
   * live envelopes.
   */
  readonly removed?: true;
}

export interface MonthView {
  readonly month: Month;
  readonly income: Cents;
  readonly planned: Cents;
  readonly funded: Cents;
  readonly activity: Cents;
  readonly toAssign: Cents;
  /** In category order, then envelope order; a removed envelope kept here after its category's live ones. */
  readonly envelopes: readonly EnvelopeView[];
  readonly moveCount: number;
}

/**
 * Roll one month of the budget up.
 *
 * Rollover walks back through earlier open months rather than keeping a running
 * balance, so recomputing any month is self-contained.
 */
export function monthView(state: State, month: Month): MonthView | null {
  const plan = state.months.get(month);
  if (!plan) return null;

  const activity = new Map<EnvelopeId, Cents>();
  const lines = new Map<EnvelopeId, EnvelopeLine[]>();
  let totalActivity = ZERO;

  for (const t of state.txns.values()) {
    if (monthOf(t.date) !== month) continue;
    // Each part is its own spending, in its own envelope. A split receipt's
    // marker is not spending, so only its parts count.
    for (const p of partsOf(t)) {
      if (!isSpend(p.envelope)) continue;
      if (!state.envelopes.has(p.envelope) && !keptIn(state, p.envelope, month)) continue;
      const out = cents(-p.amount); // outflow positive
      activity.set(p.envelope, add(activity.get(p.envelope) ?? ZERO, out));
      (lines.get(p.envelope) ?? lines.set(p.envelope, []).get(p.envelope)!)
        .push({ txnId: t.id, amount: out, split: !!t.split });
      totalActivity = add(totalActivity, out);
    }
  }

  const envelopes: EnvelopeView[] = [];
  let plannedSum = ZERO;
  let fundedSum = ZERO;

  const view = (env: Envelope, removed: boolean): EnvelopeView => {
    const planned = plannedFor(plan, env.id);
    const funded = fundedFor(plan, env.id);
    const act = activity.get(env.id) ?? ZERO;
    const carried = env.rollover ? carriedInto(state, month, env.id) : ZERO;
    const available = sub(add(carried, funded), act);
    plannedSum = add(plannedSum, planned);
    fundedSum = add(fundedSum, funded);
    return {
      envelope: env,
      planned, funded, carried, activity: act, available,
      overspent: available < 0,
      adjustedBy: sub(funded, planned),
      trail: trailFor(plan, env.id),
      txnIds: [...new Set((lines.get(env.id) ?? []).map((l) => l.txnId))],
      lines: lines.get(env.id) ?? [],
      ...(removed ? { removed: true as const } : {}),
    };
  };

  for (const env of ordered(state, month)) envelopes.push(view(env.envelope, env.removed));

  return {
    month,
    income: plan.income,
    planned: plannedSum,
    funded: fundedSum,
    activity: totalActivity,
    toAssign: sub(plan.income, fundedSum),
    envelopes,
    moveCount: plan.adjustments.filter((a) => a.kind === 'move').length / 2,
  };
}

/**
 * The envelopes a month shows, in category order then envelope order, each
 * category's removed envelopes this month keeps after its live ones. Any whose
 * category is not here come last.
 */
function ordered(state: State, month: Month): { envelope: Envelope; removed: boolean }[] {
  const place = new Map([...state.categories.keys()].map((id, i) => [id, i]));
  const rank = (c: CategoryId) => place.get(c) ?? place.size;
  const live = [...state.envelopes.values()].map((envelope) => ({ envelope, removed: false }));
  const gone = [...state.removedEnvelopes.values()]
    .filter((r) => keptIn(state, r.id, month))
    .map((r) => ({
      envelope: { id: r.id, label: r.label, category: r.category, rollover: false, template: ZERO, order: 0 } as Envelope,
      removed: true,
    }));
  return [...live, ...gone].sort((a, b) =>
    rank(a.envelope.category) - rank(b.envelope.category)
    || Number(a.removed) - Number(b.removed)
    || (a.removed ? a.envelope.label.localeCompare(b.envelope.label) : a.envelope.order - b.envelope.order));
}

/**
 * What an envelope carries into `month` from the one before.
 *
 * Recursive by design: each month's leftover depends on the one before it.
 * Bounded by how many months are actually open.
 */
export function carriedInto(
  state: State, month: Month, env: EnvelopeId,
  seen = new Set<Month>(),
): Cents {
  const prev = prevMonth(month);
  if (seen.has(prev)) return ZERO; // defensive: never loop
  seen.add(prev);

  const plan = state.months.get(prev);
  if (!plan) return ZERO;
  const envelope = state.envelopes.get(env);
  if (!envelope) return ZERO;

  let act = ZERO;
  for (const t of state.txns.values()) {
    if (monthOf(t.date) !== prev) continue;
    for (const p of partsOf(t)) if (p.envelope === env) act = add(act, cents(-p.amount));
  }

  const carried = envelope.rollover ? carriedInto(state, prev, env, seen) : ZERO;
  const available = sub(add(carried, fundedFor(plan, env)), act);
  // Overspending carries forward as a debt, the same way YNAB does it — it has to
  // come out of somewhere, and hiding it would make the next month read too rich.
  return available;
}

/** Every open month of the budget, oldest first. */
export const openMonths = (state: State): Month[] => [...state.months.keys()].sort();

export const latestMonth = (state: State): Month | null => openMonths(state).at(-1) ?? null;

export type { MonthPlan };
export { max };
