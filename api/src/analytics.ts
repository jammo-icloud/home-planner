/**
 * Every number the briefing quotes.
 *
 * Deterministic and pure — `today` is always injected, never read from the
 * clock. Claude reads these, explains them and decides what's worth saying; it
 * never computes them. Financial figures have to be identical every time you
 * ask, and reproducible when you ask where one came from.
 */

import { ZERO, add, sub, cents, fmt, sum } from './money.ts';
import type { Cents } from './money.ts';
import { monthView, envelopeFor } from './envelopes.ts';
import type { EnvelopeView, MonthView } from './envelopes.ts';
import { fundedFor, plannedFor } from './replay.ts';
import { isSpend, monthKey, monthOf, prevMonth } from './types.ts';
import type { Day, EnvelopeId, Month, State, Txn } from './types.ts';

// ─── the month's clock ────────────────────────────────────────────────────────

export interface MonthClock {
  readonly month: Month;
  readonly daysInMonth: number;
  readonly dayOfMonth: number;
  readonly daysLeft: number;
  /** 0..1. Drives every projection. */
  readonly elapsed: number;
  readonly complete: boolean;
}

export function monthClock(month: Month, today: Day): MonthClock {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const current = monthOf(today) === month;
  const past = today.slice(0, 7) > month;
  const dayOfMonth = current ? Number(today.slice(8, 10)) : past ? daysInMonth : 0;
  return {
    month, daysInMonth, dayOfMonth,
    daysLeft: Math.max(0, daysInMonth - dayOfMonth),
    elapsed: daysInMonth === 0 ? 0 : dayOfMonth / daysInMonth,
    complete: past || dayOfMonth >= daysInMonth,
  };
}

// ─── fixed monthly charges ────────────────────────────────────────────────────

export interface FixedCharge {
  /** Normalised payee and category together, so callers can match a transaction. */
  readonly key: string;
  readonly payee: string;
  readonly category: string;
  /** What it bills, averaged across the months it has been seen in. */
  readonly typical: Cents;
  readonly months: readonly Month[];
}

/**
 * Payees that bill once a month, every month, at about the same amount.
 *
 * The once-per-month test is what separates rent and the power bill from
 * groceries. Both recur, but only one of them is a commitment whose month-end
 * total is already known — a merchant charged eight times in July tells you
 * nothing about what the ninth will be.
 *
 * Deliberately tighter than `recurring()`, which exists to spot subscriptions
 * that crept in. Here a wrong answer suppresses a real overspend warning, so
 * two months is enough evidence to stop extrapolating but a month with two
 * charges in it disqualifies the payee outright.
 *
 * Grouped by payee AND category, because a bank descriptor is not always a
 * merchant. Rent and a $60 Zelle payment both arrive as "P2P PAYMENT"; keyed on
 * the descriptor alone the second one makes the month look double-billed and
 * rent starts extrapolating again. Their categories are what tell them apart.
 */
/** Empty when the transaction cannot be a fixed charge at all. */
const chargeKey = (payee: string, category: string | null): string => {
  const p = normalisePayee(payee);
  return p && category ? `${p}|${category}` : '';
};

export function fixedCharges(
  state: State,
  opts: { minMonths?: number; tolerance?: number } = {},
): FixedCharge[] {
  const minMonths = opts.minMonths ?? 2;
  const tolerance = opts.tolerance ?? 0.15;

  const byPayee = new Map<string, Txn[]>();
  for (const t of state.txns.values()) {
    if (t.amount >= 0) continue;
    if (t.category === null || !isSpend(t.category)) continue; // transfers, income and unsorted rows are not charges
    const key = chargeKey(t.payee, t.category);
    if (!key) continue;
    (byPayee.get(key) ?? byPayee.set(key, []).get(key)!).push(t);
  }

  const out: FixedCharge[] = [];
  for (const [key, txns] of byPayee) {
    const perMonth = new Map<Month, Txn[]>();
    for (const t of txns) {
      const m = monthOf(t.date);
      (perMonth.get(m) ?? perMonth.set(m, []).get(m)!).push(t);
    }
    if (perMonth.size < minMonths) continue;
    // a month with two charges in it means this is not a fixed monthly bill
    if ([...perMonth.values()].some((rows) => rows.length !== 1)) continue;

    const amounts = txns.map((t) => Math.abs(t.amount));
    const typical = cents(amounts.reduce((a, b) => a + b, 0) / amounts.length);
    if (!amounts.every((a) => Math.abs(a - typical) <= typical * tolerance)) continue;

    out.push({
      key, payee: txns[0]!.payee, category: txns[0]!.category as string,
      typical: typical as Cents, months: [...perMonth.keys()].sort(),
    });
  }
  return out.sort((a, b) => b.typical - a.typical);
}

// ─── pace ─────────────────────────────────────────────────────────────────────

export interface Pace {
  readonly envelope: EnvelopeId;
  readonly label: string;
  readonly funded: Cents;
  readonly spent: Cents;
  readonly available: Cents;
  /** Spent so far on charges that arrive once a month at a known amount. */
  readonly committed: Cents;
  /** Committed bills this envelope expects that have not landed yet. */
  readonly stillExpected: Cents;
  /** Spent so far on everything else — the part that genuinely varies. */
  readonly discretionary: Cents;
  /** Month-end total: commitments at their known amount, the rest at this rate. */
  readonly projected: Cents;
  /** Positive means projected to finish over. */
  readonly projectedOver: Cents;
  readonly status: 'ok' | 'watch' | 'over' | 'projected-over';
}

/** An envelope on Today's money rail: what is left, or by how much it is over, as words the engine wrote. */
export interface LowEnvelope {
  readonly envelope: EnvelopeId;
  readonly label: string;
  readonly status: Pace['status'];
  readonly left: string;
  /** How far it is over, when it is; null when it is not. */
  readonly over: string | null;
}

/**
 * The envelopes Today's money rail lists, read from the same pace the
 * briefing is written from, so the two never disagree about what is short:
 * those over, then those projected to finish over, then the rest by least
 * left. One with nothing funded, or with all it was funded still in it, is
 * not low. At most `n`.
 */
export function lowEnvelopes(paced: readonly Pace[], n: number): LowEnvelope[] {
  const rank = (p: Pace) => (p.status === 'over' ? 0 : p.status === 'projected-over' ? 1 : 2);
  return paced
    .filter((p) => rank(p) < 2 || (p.funded > 0 && p.available < p.funded))
    .sort((a, b) => rank(a) - rank(b) || a.available - b.available)
    .slice(0, n)
    .map((p) => ({
      envelope: p.envelope, label: p.label, status: p.status,
      left: fmt((p.available < 0 ? 0 : p.available) as Cents),
      over: p.available < 0 ? fmt(-p.available as Cents) : null,
    }));
}

/**
 * What each envelope is on course to finish the month at.
 *
 * A straight line through everything was wrong in both directions. Rent paid on
 * the 2nd extrapolated to fifteen months of rent and cried wolf; a power bill
 * due on the 25th extrapolated to nearly nothing, read as fine, and then blew
 * the envelope. Neither of those is a forecast anybody should act on.
 *
 * So the month is split. Charges that arrive once a month at a known amount
 * count once, whether or not they have landed yet. Everything else — the part
 * that actually varies with behaviour — is still extrapolated at the current
 * rate, because "at this rate" is what a person means about groceries.
 *
 * Spending on a sinking category is never extrapolated either: those are
 * periodic by definition and already funded as reserves.
 */
export function pace(view: MonthView, clock: MonthClock, state: State): Pace[] {
  const fixed = fixedCharges(state);
  const byKey = new Map(fixed.map((f) => [f.key, f]));

  // Which envelope each fixed charge belongs to, from where it has landed
  // before. A bill that has never been seen in this budget expects nothing.
  const expectedFor = new Map<EnvelopeId, Map<string, Cents>>();
  const budget = state.budgets.get(view.budget);
  if (budget) {
    for (const t of state.txns.values()) {
      const f = byKey.get(chargeKey(t.payee, t.category));
      if (!f) continue;
      const env = envelopeFor(budget, t);
      if (!env) continue;
      (expectedFor.get(env.id) ?? expectedFor.set(env.id, new Map()).get(env.id)!).set(f.key, f.typical);
    }
  }

  const out: Pace[] = [];
  for (const e of view.envelopes) {
    if (e.funded === 0 && e.activity === 0) continue;

    let committed = ZERO;
    let discretionary = ZERO;
    const landed = new Set<string>();
    // By part: a split receipt counts its share here, never the whole.
    for (const line of e.lines) {
      const t = state.txns.get(line.txnId);
      if (!t) continue;
      const amount = cents(Math.abs(line.amount));
      const key = chargeKey(t.payee, line.category);
      const sinking = isSpend(line.category)
        && state.categories.get(line.category)?.sinking !== undefined;
      if (byKey.has(key) || sinking) {
        committed = add(committed, amount);
        landed.add(key);
      } else {
        discretionary = add(discretionary, amount);
      }
    }

    // Bills this envelope gets every month that have not arrived yet. This is
    // the half that used to read as "ok" right up until it wasn't.
    let stillExpected = ZERO;
    if (!clock.complete) {
      for (const [key, typical] of expectedFor.get(e.envelope.id) ?? []) {
        if (!landed.has(key)) stillExpected = add(stillExpected, typical);
      }
    }

    const variable = clock.elapsed > 0 && !clock.complete
      ? cents(discretionary / clock.elapsed)
      : discretionary;
    const projected = add(add(committed, stillExpected), variable);
    const projectedOver = sub(projected, add(e.funded, e.carried));
    // "Watch" needs a rate to watch. An envelope that is nothing but fixed
    // bills sits at exactly 100% of its plan the moment they are paid — that is
    // budgeting working, not a warning, and flagging it every month would teach
    // them to ignore the colour.
    const budgetForMonth = add(e.funded, e.carried);
    const status: Pace['status'] =
      e.available < 0 ? 'over'
      : projectedOver > 0 ? 'projected-over'
      : discretionary > 0 && budgetForMonth > 0 && projected / budgetForMonth > 0.85 ? 'watch'
      : 'ok';
    out.push({
      envelope: e.envelope.id, label: e.envelope.label,
      funded: e.funded, spent: e.activity, available: e.available,
      committed, stillExpected, discretionary,
      projected, projectedOver, status,
    });
  }
  // worst first: that's the order the briefing wants
  const rank = { over: 0, 'projected-over': 1, watch: 2, ok: 3 } as const;
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.projectedOver - a.projectedOver);
}

// ─── plan drift: the signal the immutable plan exists to produce ──────────────

export interface Drift {
  readonly envelope: EnvelopeId;
  readonly label: string;
  readonly months: readonly { month: Month; planned: Cents; funded: Cents; spent: Cents }[];
  /** How many of those months were topped up above plan. */
  readonly toppedUp: number;
  /** Mean funded across the window — the number the plan probably ought to be. */
  readonly averageFunded: Cents;
  readonly averagePlanned: Cents;
}

/**
 * Walk back over open months comparing what was planned against what it took.
 *
 * "Planned $325 three times, funded $421, $390, $408" is a wrong-plan problem,
 * which is a different and more useful finding than "over by $96 this month".
 * Only possible because the opening plan is never overwritten.
 */
export function drift(state: State, budget: string, month: Month, lookback = 3): Drift[] {
  const b = state.budgets.get(budget);
  if (!b) return [];

  const months: Month[] = [];
  let cursor = month;
  for (let i = 0; i < lookback; i++) {
    if (state.months.has(monthKey(budget, cursor))) months.unshift(cursor);
    cursor = prevMonth(cursor);
  }
  if (months.length === 0) return [];

  const views = new Map<Month, MonthView>();
  for (const m of months) {
    const v = monthView(state, budget, m);
    if (v) views.set(m, v);
  }

  const out: Drift[] = [];
  for (const env of b.envelopes.values()) {
    const rows: { month: Month; planned: Cents; funded: Cents; spent: Cents }[] = [];
    for (const m of months) {
      const plan = state.months.get(monthKey(budget, m));
      const view = views.get(m);
      if (!plan || !view) continue;
      const ev = view.envelopes.find((x) => x.envelope.id === env.id);
      rows.push({
        month: m,
        planned: plannedFor(plan, env.id),
        funded: fundedFor(plan, env.id),
        spent: ev?.activity ?? ZERO,
      });
    }
    if (rows.length === 0) continue;
    const toppedUp = rows.filter((r) => r.funded > r.planned).length;
    out.push({
      envelope: env.id,
      label: env.label,
      months: rows,
      toppedUp,
      averageFunded: cents(sum(rows.map((r) => r.funded)) / rows.length),
      averagePlanned: cents(sum(rows.map((r) => r.planned)) / rows.length),
    });
  }
  // the ones topped up most often, and by the most, first
  return out.sort((a, b2) =>
    b2.toppedUp - a.toppedUp ||
    (b2.averageFunded - b2.averagePlanned) - (a.averageFunded - a.averagePlanned));
}

// ─── recurring merchants ──────────────────────────────────────────────────────

export interface Recurring {
  readonly payee: string;
  readonly category: string | null;
  readonly months: readonly Month[];
  readonly typical: Cents;
  /** True when it recurs but no rule covers it — a subscription you haven't noticed. */
  readonly unruled: boolean;
}

/**
 * Merchants charging in three or more distinct months at a stable amount.
 * Catches subscriptions that crept in without ever being planned for.
 */
export function recurring(state: State, opts: { minMonths?: number; tolerance?: number } = {}): Recurring[] {
  const minMonths = opts.minMonths ?? 3;
  const tolerance = opts.tolerance ?? 0.15;

  const byPayee = new Map<string, Txn[]>();
  for (const t of state.txns.values()) {
    if (t.amount >= 0) continue; // inflows aren't subscriptions
    const key = normalisePayee(t.payee);
    if (!key) continue;
    (byPayee.get(key) ?? byPayee.set(key, []).get(key)!).push(t);
  }

  const out: Recurring[] = [];
  for (const [key, txns] of byPayee) {
    const months = [...new Set(txns.map((t) => monthOf(t.date)))].sort();
    if (months.length < minMonths) continue;
    const amounts = txns.map((t) => Math.abs(t.amount));
    const typical = cents(amounts.reduce((a, b) => a + b, 0) / amounts.length);
    // a real subscription is roughly the same every time
    const steady = amounts.every((a) => Math.abs(a - typical) <= typical * tolerance);
    if (!steady) continue;
    const covered = state.rules.some((r) => key.includes(r.match.toLowerCase()));
    out.push({
      payee: txns[0]!.payee,
      category: txns[0]!.category,
      months,
      typical: typical as Cents,
      unruled: !covered,
    });
  }
  return out.sort((a, b) => b.typical - a.typical);
}

/** Strip the reference tail so the same merchant groups across months. */
export function normalisePayee(payee: string): string {
  return (payee ?? '')
    .toLowerCase()
    .replace(/[#*]\s*\w+/g, ' ')
    .replace(/\b\d[\d-]{2,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

// ─── the queue ────────────────────────────────────────────────────────────────

export interface Unsorted {
  readonly count: number;
  /** Money out. This is the figure that means "spending not yet accounted for". */
  readonly outflow: Cents;
  /** Money in — paycheques and card payments that just haven't been ruled yet. */
  readonly inflow: Cents;
  readonly oldest: Day | null;
  readonly txnIds: readonly string[];
}

/**
 * Uncategorised transactions, with money in and money out kept apart.
 *
 * Summing the absolute value of both would report an unsorted paycheque and a
 * card payment as if they were unexplained spending — on a real import that
 * reads as tens of thousands of dollars missing, which is alarming and false.
 */
export function unsorted(state: State): Unsorted {
  const ids: string[] = [];
  let outflow = ZERO;
  let inflow = ZERO;
  let oldest: Day | null = null;
  for (const t of state.txns.values()) {
    if (t.category !== null) continue;
    ids.push(t.id);
    if (t.amount < 0) outflow = add(outflow, cents(-t.amount));
    else inflow = add(inflow, cents(t.amount));
    if (!oldest || t.date < oldest) oldest = t.date;
  }
  return { count: ids.length, outflow, inflow, oldest, txnIds: ids };
}

// ─── where to pull money from ─────────────────────────────────────────────────

export interface Donor {
  readonly envelope: EnvelopeId;
  readonly label: string;
  readonly available: Cents;
  /** Spare after leaving the rest of the month's usual burn alone. */
  readonly spare: Cents;
}

/**
 * Envelopes that could fund a shortfall without being pushed over themselves.
 *
 * Answers "what should I pull from to increase food, and by how much" with a
 * ranked list rather than a guess — the projection decides what's genuinely
 * spare, not just what currently has a balance.
 */
export function donors(view: MonthView, clock: MonthClock, exclude: EnvelopeId, state: State): Donor[] {
  const paced = new Map(pace(view, clock, state).map((p) => [p.envelope, p]));
  const out: Donor[] = [];
  for (const e of view.envelopes) {
    if (e.envelope.id === exclude) continue;
    if (e.available <= 0) continue;
    const p = paced.get(e.envelope.id);
    // keep back whatever it still looks likely to spend
    const stillLikely = p ? max0(sub(p.projected, e.activity)) : ZERO;
    const spare = max0(sub(e.available, stillLikely));
    if (spare <= 0) continue;
    out.push({ envelope: e.envelope.id, label: e.envelope.label, available: e.available, spare });
  }
  return out.sort((a, b) => b.spare - a.spare);
}

const max0 = (c: Cents): Cents => (c > 0 ? c : ZERO);

// ─── one bundle for the briefing ──────────────────────────────────────────────

export interface Snapshot {
  readonly budget: string;
  readonly month: Month;
  readonly clock: MonthClock;
  readonly view: MonthView;
  readonly pace: readonly Pace[];
  readonly drift: readonly Drift[];
  readonly unsorted: Unsorted;
  readonly recurring: readonly Recurring[];
  readonly balanced: boolean;
}

/**
 * Everything the briefing needs in one call.
 *
 * Tools are shaped like the questions people ask, not like tables — answering
 * "how are we doing?" shouldn't cost six round trips.
 */
export function snapshot(state: State, budget: string, month: Month, today: Day): Snapshot | null {
  const view = monthView(state, budget, month);
  if (!view) return null;
  const clock = monthClock(month, today);
  return {
    budget, month, clock, view,
    pace: pace(view, clock, state),
    drift: drift(state, budget, month),
    unsorted: unsorted(state),
    recurring: recurring(state).filter((r) => r.unruled),
    balanced: Math.abs(view.toAssign) < 100,
  };
}
