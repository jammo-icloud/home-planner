/**
 * Where a new household starts: common categories, and the rules that keep a
 * card payment and a paycheque out of spending.
 *
 * Offered, never imposed. add_starter_set proposes only what a household is
 * missing, and nothing is written until it is approved.
 *
 * Nothing here describes any one household or bank. The rules are a few
 * descriptors many banks share, and deliberately no more: a wrong substring
 * silently files real spending as a transfer, so a bank's own wording is left
 * to the rule the unsorted queue offers the first time a receipt is sorted by
 * hand.
 */

import { TRANSFER, INCOME } from './types.ts';
import type { Assignment, CategoryId, State } from './types.ts';

export interface StarterCategory {
  readonly id: CategoryId;
  readonly label: string;
  readonly kind: 'House' | 'People' | 'Future';
}

export interface StarterRule {
  readonly id: string;
  readonly match: string;
  readonly category: Assignment;
  /** Why this descriptor is not spending, for the proposal. */
  readonly why: string;
}

// rent, tax and elec are the ids pricing from local data fills, so the evidence
// it finds lands in a named category rather than one called "rent".
export const STARTER_CATEGORIES: readonly StarterCategory[] = [
  { id: 'rent', label: 'Rent or mortgage', kind: 'House' },
  { id: 'tax', label: 'Property tax', kind: 'House' },
  { id: 'homeins', label: 'Home insurance', kind: 'House' },
  { id: 'elec', label: 'Electricity', kind: 'House' },
  { id: 'heat', label: 'Gas & heating', kind: 'House' },
  { id: 'water', label: 'Water & trash', kind: 'House' },
  { id: 'internet', label: 'Internet & phone', kind: 'House' },
  { id: 'upkeep', label: 'Repairs & upkeep', kind: 'House' },
  { id: 'groceries', label: 'Groceries', kind: 'People' },
  { id: 'dining', label: 'Dining out', kind: 'People' },
  { id: 'transport', label: 'Fuel & transport', kind: 'People' },
  { id: 'carins', label: 'Car insurance', kind: 'People' },
  { id: 'health', label: 'Health & medical', kind: 'People' },
  { id: 'clothing', label: 'Clothing', kind: 'People' },
  { id: 'personal', label: 'Personal care', kind: 'People' },
  { id: 'subscriptions', label: 'Subscriptions', kind: 'People' },
  { id: 'gifts', label: 'Gifts', kind: 'People' },
  { id: 'fun', label: 'Fun', kind: 'People' },
  { id: 'emergency', label: 'Emergency fund', kind: 'Future' },
  { id: 'savings', label: 'Savings', kind: 'Future' },
  { id: 'travel', label: 'Travel', kind: 'Future' },
];

export const STARTER_RULES: readonly StarterRule[] = [
  { id: 'r-starter-card-payment', match: 'PAYMENT THANK YOU', category: TRANSFER,
    why: 'a card receiving a payment from checking' },
  { id: 'r-starter-card-payment-from-checking', match: 'CREDIT CARD PAYMENT', category: TRANSFER,
    why: 'checking paying a card' },
  { id: 'r-starter-payroll', match: 'PAYROLL', category: INCOME, why: 'a paycheque' },
  { id: 'r-starter-dividend', match: 'DIVIDEND', category: INCOME, why: 'interest or dividends paid in' },
];

export interface MissingStarter {
  readonly categories: readonly StarterCategory[];
  readonly rules: readonly StarterRule[];
  /** Labels of starter categories this household already has, by id or by name. */
  readonly skippedCategories: readonly string[];
  /** Starter rules left out because they overlap a different rule already here. */
  readonly skippedRules: readonly string[];
}

/**
 * What of the starter set this household does not have yet.
 *
 * A category is already here if its id or its name is, and is never offered
 * again — define_category renames on an existing id, so offering it would
 * relabel someone's own category. A rule is left out if it overlaps any rule
 * already here, either way round: rules are last-match-wins, so a starter rule
 * appended after the household's own would override it wherever both match.
 */
export function missingStarter(state: State): MissingStarter {
  const names = new Set([...state.categories.values()].map((c) => c.label.trim().toLowerCase()));
  const categories: StarterCategory[] = [];
  const skippedCategories: string[] = [];
  for (const s of STARTER_CATEGORIES) {
    if (state.categories.has(s.id) || names.has(s.label.toLowerCase())) skippedCategories.push(s.label);
    else categories.push(s);
  }

  const rules: StarterRule[] = [];
  const skippedRules: string[] = [];
  for (const s of STARTER_RULES) {
    const mine = s.match.toLowerCase();
    if (state.rules.some((r) => r.match.toLowerCase() === mine)) continue;
    const overlap = state.rules.find((r) => {
      const theirs = r.match.toLowerCase();
      return theirs !== '' && (theirs.includes(mine) || mine.includes(theirs));
    });
    if (overlap) skippedRules.push(`"${s.match}" — it overlaps your rule "${overlap.match}", which would stop winning`);
    else rules.push(s);
  }
  return { categories, rules, skippedCategories, skippedRules };
}
