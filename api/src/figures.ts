/**
 * What helps a household give an envelope its first figure, and what is left to
 * assign in words.
 *
 * Pure: it reads state and answers. Nothing here proposes or writes, so the
 * Budget screen can ask for it on every read.
 */

import { ZERO, add, cents, fmt } from './money.ts';
import type { Cents } from './money.ts';
import { incomeFor, sourcesFor } from './income.ts';
import { PRICED } from './starter.ts';
import { INCOME, PER_YEAR, isSpend, monthOf, partsOf, prevMonth } from './types.ts';
import type { Basis, CategoryId, Day, Envelope, EnvelopeId, Month, Per, State } from './types.ts';
import type { MonthView } from './envelopes.ts';
import { donors, monthClock } from './analytics.ts';

export { PER_YEAR };
export type { Basis, Per };

/**
 * The monthly a figure given as the bill is known becomes. Rounded up at the cent,
 * as a sinking fund's monthly is, so twelve months never fall short of the year.
 * The only place this arithmetic lives: the server works the monthly out from the
 * basis it is given rather than taking one alongside it.
 */
export function monthlyOf(b: Basis): Cents {
  return cents(Math.ceil((b.amount * PER_YEAR[b.per]) / 12));
}

const PER_WORD: Readonly<Record<Per, string>> = {
  week: 'week', fortnight: 'fortnight', month: 'month', quarter: 'quarter', 'half-year': 'half year', year: 'year',
};
/** How a period reads after "a": "a week", "a half year". */
export const perWord = (per: Per): string => PER_WORD[per];

export interface Hint {
  readonly text: string;
  /** A figure the household can take as it stands. */
  readonly use?: { readonly cents: Cents; readonly label: string };
  /** Public data for the household's place can price this envelope. */
  readonly price?: true;
  /** What its receipts averaged over the last 1, 3 and 6 months, in whole dollars; only the windows that had any. */
  readonly averages?: readonly { readonly months: 1 | 3 | 6; readonly cents: Cents }[];
}

/**
 * Net money out of `categories` in each of the `n` months before `month`, the latest
 * first, and whether any receipt landed in it at all. Refunds count against it, and a
 * split receipt counts by its parts, as the month's own spending does.
 */
function monthsBefore(state: State, categories: readonly CategoryId[], month: Month, n: number): { spent: Cents; any: boolean }[] {
  const months: Month[] = [];
  for (let m = prevMonth(month); months.length < n; m = prevMonth(m)) months.push(m);
  const out = months.map(() => ({ spent: ZERO, any: false }));
  for (const t of state.txns.values()) {
    const i = months.indexOf(monthOf(t.date));
    if (i < 0) continue;
    for (const p of partsOf(t)) {
      if (!isSpend(p.category) || !categories.includes(p.category)) continue;
      out[i] = { spent: add(out[i]!.spent, cents(-p.amount)), any: true };
    }
  }
  return out;
}

/** Net money out of `categories` in the month before `month`. */
export function lastMonthSpent(state: State, categories: readonly CategoryId[], month: Month): Cents {
  return monthsBefore(state, categories, month, 1)[0]!.spent;
}

/** The mean of the months among `nets` that had any receipt; null when none did. */
function meanOfSeen(nets: readonly { spent: Cents; any: boolean }[]): Cents | null {
  const seen = nets.filter((m) => m.any);
  if (seen.length === 0) return null;
  return cents(Math.round(seen.reduce((sum, m) => sum + m.spent, 0) / seen.length));
}

/**
 * What `categories` spent a month, on average, over the last `months` months before
 * `month`. Only the months that had receipts count: a household that imported two of
 * the last six gets the average of those two, not a third of it. Null with none.
 */
export function spentOver(state: State, categories: readonly CategoryId[], month: Month, months: 1 | 3 | 6): Cents | null {
  return meanOfSeen(monthsBefore(state, categories, month, months));
}

const WINDOWS = [1, 3, 6] as const;
const wholeDollars = (c: Cents): Cents => cents(Math.round(c / 100) * 100);

// Where last month's receipts are said to have been spent, for the three envelopes
// the imports can speak for.
const SHOWN: Readonly<Record<string, string>> = {
  groceries: 'at grocers',
  dining: 'at restaurants',
  transport: 'on fuel and transport',
};

const FIXED: Readonly<Record<string, string>> = {
  upkeep: "A common rule is 1% of the home's value a year.",
  homeins: "Your policy's annual premium, divided by 12.",
  carins: "Your policy's annual premium, divided by 12.",
  healthins: "Your policy's annual premium, divided by 12.",
  emergency: 'Many start at $1,000, then three months of the envelopes above.',
  travel: 'A sinking fund: a yearly amount, saved by the month.',
  gifts: 'A sinking fund: a yearly amount, saved by the month.',
};

/**
 * What to say beside an envelope, to help give it a figure. Keyed by the envelope's id,
 * which a starter envelope shares with its category. An envelope with receipts is
 * offered their averages; a sinking one never is, its spending being lumpy by design.
 */
export function hintFor(state: State, env: Envelope, month: Month): Hint | null {
  const categories = env.match.categories;
  if (!env.sinking && categories.length > 0) {
    const nets = monthsBefore(state, categories, month, 6);
    const averages: { months: 1 | 3 | 6; cents: Cents }[] = [];
    for (const months of WINDOWS) {
      const mean = meanOfSeen(nets.slice(0, months));
      // Whole dollars, as fmt rounds, so the figure taken is the one the text shows.
      if (mean !== null && wholeDollars(mean) > 0) averages.push({ months, cents: wholeDollars(mean) });
    }
    if (averages.length > 0) {
      // 3-month first, then last month, then 6-month: any average there is can be taken.
      const pick = averages.find((a) => a.months === 3) ?? averages.find((a) => a.months === 1) ?? averages[0]!;
      const where = SHOWN[env.id];
      const last = nets[0]!.spent;
      const text = where && last > 0
        ? `Last month's imports show ${fmt(wholeDollars(last))} ${where}`
        : `Your receipts average ${fmt(pick.cents)} a month over the last ${pick.months === 1 ? 'month' : `${pick.months} months`}`;
      const use = {
        cents: pick.cents,
        label: `Use ${fmt(pick.cents)} (${pick.months === 1 ? 'last month' : `${pick.months}-month average`})`,
      };
      // Averages add to pricing, never take it away.
      const price = PRICED.has(env.id) && state.location ? { price: true as const } : {};
      return { text, use, ...price, averages };
    }
  }
  const fixed = FIXED[env.id];
  if (fixed) return { text: fixed };
  if (PRICED.has(env.id) && state.location) {
    return { text: `Public data for ${state.location.label} can price this.`, price: true };
  }
  return null;
}

export interface IncomeSuggestion { readonly cents: Cents; readonly from: 'source' | 'imports' }

/**
 * What to offer as the month's income: the paydays the sources say fall in it,
 * else what arrived last month. Counted, never a twelfth of a year.
 */
export function incomeSuggestion(state: State, month: Month): IncomeSuggestion | null {
  const planned = incomeFor(sourcesFor(state), month).total;
  if (planned > 0) return { cents: planned, from: 'source' };
  const last = prevMonth(month);
  let arrived = ZERO;
  for (const t of state.txns.values()) {
    if (t.category === INCOME && monthOf(t.date) === last) arrived = add(arrived, t.amount);
  }
  return arrived > 0 ? { cents: arrived, from: 'imports' } : null;
}

export type CardTone = 'warm' | 'over' | 'done';

export interface Card {
  readonly tone: CardTone;
  readonly headline: string;
  readonly line: string;
  /** The first envelope still needing a figure, by order. */
  readonly next: EnvelopeId | null;
  readonly green: string;
}

const GREEN = 'When every envelope has a figure and they add up to income, this card turns green.';

/** Says in words what is left to assign, and what it will take to reach zero. */
export function cardFor(view: MonthView): Card {
  const flagged = view.envelopes.filter((e) => e.envelope.needsFigure);
  const priced = view.envelopes.length - flagged.length;
  const next = [...flagged].sort((a, b) => a.envelope.order - b.envelope.order)[0]?.envelope.id ?? null;
  const left = view.toAssign;

  const tone: CardTone = left < 0 ? 'over' : flagged.length > 0 || left > 0 ? 'warm' : 'done';
  const headline = left > 0 ? `${fmt(left)} still to assign` : left < 0 ? `${fmt(cents(-left))} over` : 'Nothing left to assign';

  const noIncome = view.income === 0;
  let line: string;
  if (flagged.length > 0) {
    const lead = noIncome ? 'No income is set for this month yet.' : `Income is ${fmt(view.income)}.`;
    if (priced > 0) {
      const plural = priced === 1 ? 'envelope plans' : 'envelopes plan';
      const need = flagged.length === 1 ? 'needs a figure; give it one' : 'need a figure; give each one';
      line = `${lead} The ${priced} priced ${plural} ${fmt(view.funded)}. The other ${flagged.length} ${need} and this reaches zero.`;
    } else if (flagged.length === 1) {
      line = `${lead} The envelope has no figure yet; give it one and this reaches zero.`;
    } else {
      line = `${lead} None of the ${flagged.length} envelopes has a figure yet; give each one and this reaches zero.`;
    }
  } else {
    const lead = noIncome
      ? 'No income is set for this month yet. Every envelope has a figure.'
      : `Income is ${fmt(view.income)} and every envelope has a figure.`;
    const tail = left > 0 ? `${fmt(left)} is still unassigned.`
      : left < 0 ? `They plan ${fmt(cents(-left))} more than the income.`
      : 'They add up to the income.';
    line = `${lead} ${tail}`;
  }
  return { tone, headline, line, next, green: GREEN };
}

export interface Cover {
  /** The shortfall, positive. */
  readonly amount: Cents;
  /** The latest line to land in the envelope: the one that most likely tipped it over. */
  readonly receipt: { readonly payee: string; readonly amount: Cents } | null;
  /** What it had left before that receipt. */
  readonly hadLeft: Cents;
  /** True when it was already short before that receipt (it had less than nothing left). */
  readonly alreadyShort: boolean;
  /** Envelopes that can spare the whole shortfall, most first, at most three. */
  readonly donors: readonly { readonly envelope: EnvelopeId; readonly label: string; readonly spare: Cents }[];
  /** What unassigned income could cover: the shortfall, or less while less is unassigned; null at none. */
  readonly assign: Cents | null;
}

/** What it would take to cover an overspent envelope, and who could give it; null unless it is short. */
export function coverFor(state: State, view: MonthView, envelope: EnvelopeId, today: Day): Cover | null {
  const e = view.envelopes.find((v) => v.envelope.id === envelope);
  if (!e || e.available >= 0) return null;
  const amount = cents(-e.available);

  // The latest by the receipt's own date; of two on one day, the one listed later.
  let latest: { date: Day; payee: string; amount: Cents } | null = null;
  for (const line of e.lines) {
    const t = state.txns.get(line.txnId);
    if (!t) continue;
    if (latest === null || t.date >= latest.date) latest = { date: t.date, payee: t.payee, amount: line.amount };
  }
  // With no receipt in it (a move took its money), it had nothing left to start from.
  const hadLeft = latest ? add(e.available, latest.amount) : ZERO;

  const spare = donors(view, monthClock(view.month, today), envelope, state)
    .filter((d) => d.spare >= amount)
    .slice(0, 3)
    .map((d) => ({ envelope: d.envelope, label: d.label, spare: d.spare }));

  return {
    amount,
    receipt: latest ? { payee: latest.payee, amount: latest.amount } : null,
    hadLeft,
    alreadyShort: hadLeft < 0,
    donors: spare,
    assign: view.toAssign > 0 ? cents(Math.min(amount, view.toAssign)) : null,
  };
}
