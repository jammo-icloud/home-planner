/**
 * Where the budget's walkthrough is: the one step a person has still to take, read
 * from what the log already says. Nothing is stored, so a walkthrough left
 * halfway is picked up where it was, on any device.
 *
 * Pure: it reads state and answers.
 */

import { fmtExact } from './money.ts';
import { incomeSuggestion } from './figures.ts';
import { sourcesFor } from './income.ts';
import { PRICED, STARTER_GROUPS } from './starter.ts';
import { monthOf } from './types.ts';
import type { Day, Month, State } from './types.ts';

export type FirstRunStep = 'where' | 'income' | 'envelopes';

export interface FirstRun {
  /** Null: the budget has envelopes, so the Budget screen shows. */
  readonly step: FirstRunStep | null;
  /** True once the household has a location or an envelope: the budget is begun. */
  readonly started: boolean;
  readonly month: Month;
  readonly monthOpen: boolean;
  /** True once the budget has envelopes: its income step is then only about opening the month. */
  readonly hasEnvelopes: boolean;
  readonly income: {
    readonly suggestion: { readonly exact: string; readonly from: 'source' | 'imports' } | null;
    readonly hasSource: boolean;
  };
  /** Where the household is, as its label says it. */
  readonly location: string | null;
  readonly groups: readonly {
    readonly name: string;
    readonly envelopes: readonly { readonly id: string; readonly label: string; readonly priced: boolean }[];
  }[];
}

export function firstRun(state: State, today: Day): FirstRun {
  const month = monthOf(today);
  // The groups are the starter set, with the rows pricing can fill marked.
  const groups = STARTER_GROUPS.map((g) => ({
    name: g.name,
    envelopes: g.envelopes.map((e) => ({ id: e.id, label: e.label, priced: PRICED.has(e.id) })),
  }));
  const started = state.location !== null || state.envelopes.size > 0;
  const monthOpen = state.months.has(month);
  const suggestion = incomeSuggestion(state, month);
  const hasSource = sourcesFor(state).length > 0;
  const hasEnvelopes = state.envelopes.size > 0;
  // Where it is comes first, until the budget is begun or this month is open: its Skip is held
  // on the page, and the income step that follows opens the month. The income step is done once
  // this month is open, which Skip does by opening it at zero. A month not open with no source to
  // open it from is the income step even with envelopes: opening from the template needs a
  // source, so there would be no other way in. With envelopes and a source, the Budget screen's
  // own prompt opens the month from the template.
  const step: FirstRunStep | null = !started && !monthOpen ? 'where'
    : !monthOpen && (!hasSource || !hasEnvelopes) ? 'income'
    : !hasEnvelopes ? 'envelopes' : null;
  return {
    step,
    started,
    month,
    monthOpen,
    hasEnvelopes,
    income: {
      suggestion: suggestion ? { exact: fmtExact(suggestion.cents), from: suggestion.from } : null,
      hasSource,
    },
    location: state.location?.label ?? null,
    groups,
  };
}
