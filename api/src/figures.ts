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
import { INCOME, isSpend, monthOf, partsOf, prevMonth } from './types.ts';
import type { Budget, BudgetId, CategoryId, Envelope, EnvelopeId, Month, State } from './types.ts';
import type { MonthView } from './envelopes.ts';

export interface Hint {
  readonly text: string;
  /** A figure the household can take as it stands. */
  readonly use?: { readonly cents: Cents; readonly label: string };
  /** Public data for the budget's place can price this envelope. */
  readonly price?: true;
}

/**
 * Net money out of `categories` in the month before `month`. Refunds count against
 * it, and a split receipt counts by its parts, as the month's own spending does.
 */
export function lastMonthSpent(state: State, categories: readonly CategoryId[], month: Month): Cents {
  const last = prevMonth(month);
  let out = ZERO;
  for (const t of state.txns.values()) {
    if (monthOf(t.date) !== last) continue;
    for (const p of partsOf(t)) {
      if (!isSpend(p.category) || !categories.includes(p.category)) continue;
      out = add(out, cents(-p.amount));
    }
  }
  return out;
}

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

/** What to say beside an envelope that has no figure. Keyed by the envelope's id, which a starter envelope shares with its category. */
export function hintFor(state: State, budget: Budget, env: Envelope, month: Month): Hint | null {
  const where = SHOWN[env.id];
  if (where) {
    const spent = lastMonthSpent(state, env.match.categories, month);
    if (spent <= 0) return null;
    return { text: `Last month's imports show ${fmt(spent)} ${where}`, use: { cents: spent, label: `Use ${fmt(spent)}` } };
  }
  const fixed = FIXED[env.id];
  if (fixed) return { text: fixed };
  if (PRICED.has(env.id) && budget.location) {
    return { text: `Public data for ${budget.location.label} can price this.`, price: true };
  }
  return null;
}

export interface IncomeSuggestion { readonly cents: Cents; readonly from: 'source' | 'imports' }

/**
 * What to offer as the month's income: the paydays the sources say fall in it,
 * else what arrived last month. Counted, never a twelfth of a year.
 */
export function incomeSuggestion(state: State, budget: BudgetId, month: Month): IncomeSuggestion | null {
  const planned = incomeFor(sourcesFor(state, budget), month).total;
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
      const need = flagged.length === 1 ? 'needs a figure; give it one' : `need a figure; give each one`;
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
