/**
 * Sinking funds: money put in every month, to be spent later, kept in Savings.
 *
 * An envelope marked Saved in Savings has a goal, and the goal says what to put
 * in each month. Its balance is the envelope's own (carried in, plus funded,
 * less what was spent from it), so the funds add up, and what they add up to
 * can be held against what the savings account says it has. Nothing here
 * writes; the month plan, the Budget screen and the Today card read it.
 */

import { ZERO, add, cents, fmt, fmtExact, sub } from './money.ts';
import type { Cents } from './money.ts';
import { carriedInto, envelopeFor, matches, openMonths } from './envelopes.ts';
import { fundedFor } from './replay.ts';
import { nextMonth } from './income.ts';
import { MONTHS_SHORT, monthKey, monthOf } from './types.ts';
import type { AccountBalance, BudgetId, Day, Envelope, EnvelopeId, Month, SinkingEstimate, State } from './types.ts';

/** A balance older than this is not compared: the funds have moved on since, and the answer would mislead. */
export const STALE_AFTER_DAYS = 35;

// ─── the monthly figure ───────────────────────────────────────────────────────

/** Months from `from` to `to`, both counted: November to March is 5. None or fewer once `to` has passed. */
export function monthsThrough(from: Month, to: Month): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty * 12 + tm) - (fy * 12 + fm) + 1;
}

/**
 * Every so often: each estimate's cost spread over the months until it comes
 * round again, added up, and rounded up to the cent once, so the goal is met
 * rather than missed by a cent a month.
 */
export function everyMonthly(estimates: readonly SinkingEstimate[]): Cents {
  const exact = estimates.reduce((n, e) => n + e.cost / (e.everyYears * 12), 0);
  // A sum of fractions that should be whole can land a hair above it.
  return cents(Math.max(0, Math.ceil(exact - 1e-9)));
}

/**
 * By a date: what is still to save over the months left, this one included,
 * rounded up so the last month is not left short. Worked out again each month
 * from what was saved by then. Once the month has passed there is nothing left
 * to plan toward; the envelope keeps what it has.
 */
export function byMonthly(target: Cents, saved: Cents, month: Month, by: Month):
  { monthly: Cents; monthsLeft: number; passed: boolean } {
  const monthsLeft = monthsThrough(month, by);
  if (monthsLeft <= 0) return { monthly: ZERO, monthsLeft: 0, passed: true };
  const left = target - saved;
  return { monthly: left > 0 ? cents(Math.ceil(left / monthsLeft)) : ZERO, monthsLeft, passed: false };
}

/** One of a sinking envelope's categories, with its estimate if it has one. */
export interface Estimate {
  readonly category: string;
  readonly label: string;
  readonly cost: Cents | null;
  readonly everyYears: number | null;
  /** Its own share of the monthly figure, rounded up; zero without an estimate. */
  readonly monthly: Cents;
}

export interface GoalView {
  readonly kind: 'every' | 'by';
  /** What it should be planned at this month. */
  readonly monthly: Cents;
  /** What the bar fills toward: the estimates' costs together, or the target. */
  readonly target: Cents;
  readonly by: Month | null;
  readonly monthsLeft: number | null;
  /** A goal by a date whose month has gone by. */
  readonly passed: boolean;
  /** Every category feeding it, so the estimates can be edited on the envelope. */
  readonly estimates: readonly Estimate[];
}

/** An envelope's categories, each with its estimate from the world (the category), if it has one. */
export function estimatesFor(state: State, env: Envelope): Estimate[] {
  return env.match.categories.map((id) => {
    const c = state.categories.get(id);
    const s = c?.sinking;
    return {
      category: id, label: c?.label ?? id,
      cost: s?.cost ?? null, everyYears: s?.everyYears ?? null,
      monthly: s ? everyMonthly([s]) : ZERO,
    };
  });
}

/**
 * A sinking envelope's goal as it stands in `month`. A goal by a date counts
 * what was saved as what the envelope carried into the month, so the figure
 * holds still while the month is lived in. Null for an ordinary envelope.
 */
export function goalFor(state: State, budget: BudgetId, env: Envelope, month: Month): GoalView | null {
  const goal = env.sinking;
  if (!goal) return null;
  const estimates = estimatesFor(state, env);
  if (goal.kind === 'every') {
    const known = estimates.flatMap((e) => (e.cost !== null && e.everyYears !== null ? [{ cost: e.cost, everyYears: e.everyYears }] : []));
    return {
      kind: 'every', monthly: everyMonthly(known), target: cents(known.reduce((n, e) => n + e.cost, 0)),
      by: null, monthsLeft: null, passed: false, estimates,
    };
  }
  const saved = carriedInto(state, budget, month, env.id);
  const { monthly, monthsLeft, passed } = byMonthly(goal.target, saved, month, goal.by);
  return { kind: 'by', monthly, target: goal.target, by: goal.by, monthsLeft, passed, estimates };
}

/** What a month opening now would plan each sinking envelope at: what its goal needs that month. */
export function sinkingPlan(state: State, budget: BudgetId, month: Month): Map<EnvelopeId, Cents> {
  const out = new Map<EnvelopeId, Cents>();
  const b = state.budgets.get(budget);
  if (!b) return out;
  for (const env of b.envelopes.values()) {
    const goal = goalFor(state, budget, env, month);
    if (goal) out.set(env.id, goal.monthly);
  }
  return out;
}

// ─── balances, and the check against Savings ──────────────────────────────────

/**
 * What an envelope held at the end of `day`: carried in, plus that month's
 * funding, less what it had spent by then. A month's funding counts from its
 * first day, the way the money goes over at the start of the month. A day in
 * a month not opened yet reads the last open month's end; one before any, nothing.
 */
export function balanceAsOf(state: State, budget: BudgetId, env: EnvelopeId, day: Day): Cents {
  const envelope = state.budgets.get(budget)?.envelopes.get(env);
  if (!envelope) return ZERO;
  const month = monthOf(day);
  const plan = state.months.get(monthKey(budget, month));
  if (!plan) {
    const before = openMonths(state, budget).filter((m) => m < month).at(-1);
    return before ? carriedInto(state, budget, nextMonth(before), env) : ZERO;
  }
  const b = state.budgets.get(budget)!;
  let spent = ZERO;
  for (const t of state.txns.values()) {
    if (monthOf(t.date) !== month || t.date > day) continue;
    if (!matches(envelope, t) || envelopeFor(b, t)?.id !== env) continue;
    spent = add(spent, cents(-t.amount));
  }
  const carried = envelope.rollover ? carriedInto(state, budget, month, env) : ZERO;
  return sub(add(carried, fundedFor(plan, env)), spent);
}

/** The budget's sinking envelopes, in the order they were defined. */
export const sinkingEnvelopes = (state: State, budget: BudgetId): Envelope[] =>
  [...(state.budgets.get(budget)?.envelopes.values() ?? [])].filter((e) => e.sinking).sort((a, b) => a.order - b.order);

/** All the sinking envelopes held on a day, together. */
export const heldAsOf = (state: State, budget: BudgetId, day: Day): Cents =>
  sinkingEnvelopes(state, budget).reduce((n, e) => add(n, balanceAsOf(state, budget, e.id, day)), ZERO);

export type CheckStatus = 'no-account' | 'no-balance' | 'stale' | 'even' | 'over' | 'short';

export interface SavingsCheck {
  readonly status: CheckStatus;
  readonly account: string | null;
  readonly balance: AccountBalance | null;
  /** What the sinking envelopes held: on the balance's day when it is compared, else today. */
  readonly held: Cents;
  /** Savings less the funds: above zero is money in Savings no fund holds, below it a shortfall. */
  readonly difference: Cents;
  /** How old the balance is, in days. Null without one. */
  readonly daysOld: number | null;
  /** The check in words: what the funds hold, what Savings showed, and what that means. */
  readonly words: { readonly held: string; readonly showed: string | null; readonly verdict: string };
}

const daysBetween = (from: Day, to: Day): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** "Oct 31". */
export const shortDay = (day: Day): string => `${MONTHS_SHORT[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

/** Whole dollars, unless that would round a real difference away to "$0". */
const amount = (c: Cents): string => (Math.abs(c) < 100 ? fmtExact(c) : fmt(c));

/**
 * The sinking envelopes against the savings account. Compared as of the
 * balance's day, so last week's statement meets last week's envelopes; a
 * balance older than `STALE_AFTER_DAYS` is said to be old instead. Null when
 * the budget has no sinking envelopes: there is nothing to check.
 */
export function savingsCheck(state: State, budget: BudgetId, today: Day): SavingsCheck | null {
  if (!sinkingEnvelopes(state, budget).length) return null;
  const account = state.savings.account;
  const balance = account ? state.savings.balances.get(account) ?? null : null;
  const daysOld = balance ? Math.max(0, daysBetween(balance.asOf, today)) : null;
  const compared = balance !== null && daysOld !== null && daysOld <= STALE_AFTER_DAYS;
  const day = compared ? balance.asOf : today;
  const held = heldAsOf(state, budget, day);
  const on = (d: Day) => (d === today ? 'today' : `on ${shortDay(d)}`);
  const words = (verdict: string) => ({
    held: `Sinking funds ${day === today ? `hold ${fmt(held)}` : `held ${fmt(held)} ${on(day)}`}.`,
    showed: balance ? `Savings showed ${fmt(balance.cents)} ${on(balance.asOf)}.` : null,
    verdict,
  });
  const base = { account, balance, held, daysOld };
  if (!account) {
    return { ...base, status: 'no-account', difference: ZERO, words: words('Choose the savings account in Settings to check them against it.') };
  }
  if (!balance) {
    return { ...base, status: 'no-balance', difference: ZERO,
      words: words('Savings has no balance yet: import a statement, or type what it shows in Settings.') };
  }
  if (!compared) {
    return { ...base, status: 'stale', difference: ZERO,
      words: words(`That was ${daysOld} days ago, too long ago to compare: import a statement, or type what Savings shows today.`) };
  }
  const difference = sub(balance.cents, held);
  if (difference === 0) return { ...base, status: 'even', difference, words: words('Every dollar in Savings is in a fund.') };
  return difference > 0
    ? { ...base, status: 'over', difference, words: words(`${amount(difference)} in Savings isn't in any fund.`) }
    : { ...base, status: 'short', difference, words: words(`Savings is ${amount(cents(-difference))} short of the sinking funds.`) };
}

/** "every year", "every 4 years", "every 1.5 years". */
export const everyWords = (years: number): string => (years === 1 ? 'every year' : `every ${years} years`);
