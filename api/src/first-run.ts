/**
 * Where a budget's walkthrough is: the one step a person has still to take, read
 * from what the log already says. Nothing is stored, so a walkthrough left
 * halfway is picked up where it was, on any device.
 *
 * Pure: it reads state and answers.
 */

import { fmtExact } from './money.ts';
import { incomeSuggestion } from './figures.ts';
import { sourcesFor } from './income.ts';
import { PRICED, STARTER_GROUPS } from './starter.ts';
import { monthKey, monthOf } from './types.ts';
import type { BudgetId, Day, Month, State } from './types.ts';

export type FirstRunStep = 'budget' | 'income' | 'envelopes';

export interface FirstRun {
  /** Null: the budget has envelopes, so the Budget screen shows. */
  readonly step: FirstRunStep | null;
  /** The asked budget if live, else the first live one, else null. */
  readonly budget: BudgetId | null;
  readonly month: Month;
  readonly monthOpen: boolean;
  /** True once the budget has envelopes: its income step is then only about opening the month. */
  readonly hasEnvelopes: boolean;
  readonly income: {
    readonly suggestion: { readonly exact: string; readonly from: 'source' | 'imports' } | null;
    readonly hasSource: boolean;
  };
  /** The budget's location label. */
  readonly location: string | null;
  readonly groups: readonly {
    readonly name: string;
    readonly envelopes: readonly { readonly id: string; readonly label: string; readonly priced: boolean }[];
  }[];
}

export function firstRun(state: State, asked: string | null, today: Day): FirstRun {
  const month = monthOf(today);
  // An archived budget is not one to walk through, so asking for it falls to a live one.
  const live = [...state.budgets.values()].filter((b) => !b.archived);
  const budget = live.find((b) => b.id === asked) ?? live[0] ?? null;
  // The groups do not depend on the budget: they are the starter set, with the rows pricing can fill marked.
  const groups = STARTER_GROUPS.map((g) => ({
    name: g.name,
    envelopes: g.envelopes.map((e) => ({ id: e.id, label: e.label, priced: PRICED.has(e.id) })),
  }));
  if (!budget) {
    return { step: 'budget', budget: null, month, monthOpen: false, hasEnvelopes: false, income: { suggestion: null, hasSource: false }, location: null, groups };
  }
  const monthOpen = state.months.has(monthKey(budget.id, month));
  const suggestion = incomeSuggestion(state, budget.id, month);
  const hasSource = sourcesFor(state, budget.id).length > 0;
  const hasEnvelopes = budget.envelopes.size > 0;
  // Step 1 is done once this month is open, which Skip does by opening it at zero. A month not
  // open with no source to open it from is the income step even with envelopes: opening from
  // the template needs a source, so there would be no other way in. With envelopes and a
  // source, the Budget screen's own prompt opens the month from the template.
  const step: FirstRunStep | null = !monthOpen && (!hasSource || !hasEnvelopes) ? 'income'
    : !hasEnvelopes ? 'envelopes' : null;
  return {
    step,
    budget: budget.id,
    month,
    monthOpen,
    hasEnvelopes,
    income: {
      suggestion: suggestion ? { exact: fmtExact(suggestion.cents), from: suggestion.from } : null,
      hasSource,
    },
    location: budget.location?.label ?? null,
    groups,
  };
}
