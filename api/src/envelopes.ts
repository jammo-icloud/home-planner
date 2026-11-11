/**
 * Rolling facts up into the household's envelopes.
 *
 * This is the join between the two layers. A transaction carries a category
 * forever; the envelopes decide which one that category lands in. Change the
 * mapping and every past month recomputes — correct for a view, and the reason
 * categorizing work is never wasted.
 */

import { ZERO, add, sub, max, cents } from './money.ts';
import type { Cents } from './money.ts';
import { fundedFor, plannedFor, trailFor } from './replay.ts';
import { isSpend, monthOf, partsOf, prevMonth } from './types.ts';
import type {
  Adjustment, CategoryId, Envelope, EnvelopeId, Month, MonthPlan, State, Txn,
} from './types.ts';

/**
 * Does this transaction belong in this envelope?
 *
 * Takes a probe rather than a whole Txn: a split receipt asks once per part,
 * with the part's category and the receipt's payee and memo.
 */
export function matches(env: Envelope, t: Pick<Txn, 'payee' | 'memo' | 'category'>): boolean {
  if (!isSpend(t.category)) return false;
  if (!env.match.categories.includes(t.category)) return false;
  if (env.match.payee) {
    const hay = `${t.payee ?? ''} ${t.memo ?? ''}`.toLowerCase();
    if (!hay.includes(env.match.payee.toLowerCase())) return false;
  }
  return true;
}

/**
 * Which envelope owns a transaction, or null if none does.
 *
 * Payee-narrowed envelopes win over plain category ones, so the months of a
 * move can define "Utilities — old house" (electricity + payee
 * EXAMPLE POWER) alongside a catch-all
 * without the order of definition deciding the answer.
 */
export function envelopeFor(state: Pick<State, 'envelopes'>, t: Pick<Txn, 'payee' | 'memo' | 'category'>): Envelope | null {
  let broad: Envelope | null = null;
  for (const env of state.envelopes.values()) {
    if (!matches(env, t)) continue;
    if (env.match.payee) return env;
    broad ??= env;
  }
  return broad;
}

/**
 * Categories the envelopes claim more than once without narrowing by payee.
 * Ambiguous ownership would double-count, so the envelope editor blocks on this.
 */
export function overlappingCategories(state: Pick<State, 'envelopes'>): Map<string, EnvelopeId[]> {
  const seen = new Map<string, EnvelopeId[]>();
  for (const env of state.envelopes.values()) {
    if (env.match.payee) continue;
    for (const c of env.match.categories) {
      const list = seen.get(c) ?? [];
      list.push(env.id);
      seen.set(c, list);
    }
  }
  for (const [c, list] of seen) if (list.length < 2) seen.delete(c);
  return seen;
}

// ─── month rollup ─────────────────────────────────────────────────────────────

/**
 * One part of one receipt landing in an envelope. A plain receipt is one line;
 * a split receipt is a line per part that lands here, so two parts of the same
 * receipt can both be lines of one envelope.
 */
export interface EnvelopeLine {
  readonly txnId: string;
  readonly category: CategoryId;
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
}

export interface MonthView {
  readonly month: Month;
  readonly income: Cents;
  readonly planned: Cents;
  readonly funded: Cents;
  readonly activity: Cents;
  readonly toAssign: Cents;
  readonly envelopes: readonly EnvelopeView[];
  /** Spent on categories no envelope matches. Never silently dropped. */
  readonly outside: { readonly total: Cents; readonly txnIds: readonly string[] };
  readonly moveCount: number;
}

/**
 * Roll one month of the budget up.
 *
 * Rollover walks back through earlier open months rather than keeping a running
 * balance, so recomputing any month is self-contained and a changed mapping
 * propagates without a migration.
 */
export function monthView(state: State, month: Month): MonthView | null {
  const plan = state.months.get(month);
  if (!plan) return null;

  const activity = new Map<EnvelopeId, Cents>();
  const lines = new Map<EnvelopeId, EnvelopeLine[]>();
  const outsideIds: string[] = [];
  let outsideTotal = ZERO;
  let totalActivity = ZERO;

  for (const t of state.txns.values()) {
    if (monthOf(t.date) !== month) continue;
    // Each part is its own spending: its own envelope, or outside. A split
    // receipt's marker category is not spending, so only its parts count.
    for (const p of partsOf(t)) {
      if (!isSpend(p.category)) continue;
      const out = cents(-p.amount); // outflow positive
      const env = envelopeFor(state, { ...t, category: p.category });
      if (!env) {
        outsideTotal = add(outsideTotal, out);
        if (!outsideIds.includes(t.id)) outsideIds.push(t.id);
        continue;
      }
      activity.set(env.id, add(activity.get(env.id) ?? ZERO, out));
      (lines.get(env.id) ?? lines.set(env.id, []).get(env.id)!)
        .push({ txnId: t.id, category: p.category, amount: out, split: !!t.split });
      totalActivity = add(totalActivity, out);
    }
  }

  const envelopes: EnvelopeView[] = [];
  let plannedSum = ZERO;
  let fundedSum = ZERO;

  const ordered = [...state.envelopes.values()].sort((a, b) => a.order - b.order);
  for (const env of ordered) {
    const planned = plannedFor(plan, env.id);
    const funded = fundedFor(plan, env.id);
    const act = activity.get(env.id) ?? ZERO;
    const carried = env.rollover ? carriedInto(state, month, env.id) : ZERO;
    const available = sub(add(carried, funded), act);
    plannedSum = add(plannedSum, planned);
    fundedSum = add(fundedSum, funded);
    envelopes.push({
      envelope: env,
      planned, funded, carried, activity: act, available,
      overspent: available < 0,
      adjustedBy: sub(funded, planned),
      trail: trailFor(plan, env.id),
      txnIds: [...new Set((lines.get(env.id) ?? []).map((l) => l.txnId))],
      lines: lines.get(env.id) ?? [],
    });
  }

  return {
    month,
    income: plan.income,
    planned: plannedSum,
    funded: fundedSum,
    activity: totalActivity,
    toAssign: sub(plan.income, fundedSum),
    envelopes,
    outside: { total: outsideTotal, txnIds: outsideIds },
    moveCount: plan.adjustments.filter((a) => a.kind === 'move').length / 2,
  };
}

/**
 * What an envelope carries into `month` from the one before.
 *
 * Recursive by design: each month's leftover depends on the one before it.
 * Bounded by how many months are actually open, and memoised per call tree.
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
    for (const p of partsOf(t)) {
      if (!isSpend(p.category)) continue;
      const probe = { ...t, category: p.category };
      if (!matches(envelope, probe)) continue;
      if (envelopeFor(state, probe)?.id !== env) continue;
      act = add(act, cents(-p.amount));
    }
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
