/**
 * Where a new household starts: the starter envelopes under their categories,
 * and the rules that keep a card payment and a paycheque out of spending.
 *
 * Offered, never imposed. The walkthrough shows them, a person ticks the ones
 * they want, and make_starter_envelopes writes those, with the categories
 * they sit under and the rules this household lacks.
 *
 * Nothing here describes any one household or bank. The rules are a few
 * descriptors many banks share, and deliberately no more: a wrong substring
 * silently files real spending as a transfer, so a bank's own wording is left
 * to the rule To sort offers the first time a receipt is sorted by hand.
 */

import { TRANSFER, INCOME } from './types.ts';
import type { CategoryId, EnvelopeId, SortedInto, State } from './types.ts';

export interface StarterCategory {
  readonly id: CategoryId;
  readonly label: string;
  readonly envelopes: readonly { readonly id: EnvelopeId; readonly label: string }[];
}

export interface StarterRule {
  readonly id: string;
  readonly match: string;
  readonly envelope: SortedInto;
  /** Why this descriptor is not spending, for the proposal. */
  readonly why: string;
}

// The categories the walkthrough offers, in the order it shows them, each with
// its starter envelopes. The ids are the ones pricing and the figure hints key
// on (rent, tax and elec are what local data fills), so they are kept.
export const STARTER_CATEGORIES: readonly StarterCategory[] = [
  { id: 'home', label: 'Home', envelopes: [
    { id: 'rent', label: 'Rent or mortgage' }, { id: 'tax', label: 'Property tax' }, { id: 'upkeep', label: 'Repairs & upkeep' }] },
  { id: 'food', label: 'Food', envelopes: [
    { id: 'groceries', label: 'Groceries' }, { id: 'dining', label: 'Dining out' }] },
  { id: 'insurance', label: 'Insurance', envelopes: [
    { id: 'homeins', label: 'Home insurance' }, { id: 'carins', label: 'Car insurance' }, { id: 'healthins', label: 'Health insurance' }] },
  { id: 'utilities', label: 'Utilities', envelopes: [
    { id: 'elec', label: 'Electricity' }, { id: 'heat', label: 'Gas & heating' }, { id: 'water', label: 'Water & trash' },
    { id: 'internet', label: 'Internet & phone' }] },
  { id: 'sinking', label: 'Savings and sinking funds', envelopes: [
    { id: 'emergency', label: 'Emergency fund' }, { id: 'savings', label: 'Savings' }, { id: 'travel', label: 'Travel' },
    { id: 'gifts', label: 'Gifts' }] },
  { id: 'everyday', label: 'Everyday', envelopes: [
    { id: 'transport', label: 'Fuel & transport' }, { id: 'clothing', label: 'Clothing' }, { id: 'personal', label: 'Personal care' },
    { id: 'subscriptions', label: 'Subscriptions' }, { id: 'fun', label: 'Fun' }] },
];

// The envelopes public data can put a figure on: rent and property tax from
// local figures, electricity from the local rate.
export const PRICED: ReadonlySet<EnvelopeId> = new Set(['rent', 'tax', 'elec']);

export const STARTER_RULES: readonly StarterRule[] = [
  { id: 'r-starter-card-payment', match: 'PAYMENT THANK YOU', envelope: TRANSFER,
    why: 'a card receiving a payment from checking' },
  { id: 'r-starter-card-payment-from-checking', match: 'CREDIT CARD PAYMENT', envelope: TRANSFER,
    why: 'checking paying a card' },
  { id: 'r-starter-payroll', match: 'PAYROLL', envelope: INCOME, why: 'a paycheque' },
  { id: 'r-starter-dividend', match: 'DIVIDEND', envelope: INCOME, why: 'interest or dividends paid in' },
];

export interface MissingRules {
  readonly rules: readonly StarterRule[];
  /** Starter rules left out because they overlap a different rule already here. */
  readonly skippedRules: readonly string[];
}

/**
 * The starter rules this household does not have yet. A rule is left out if it
 * overlaps any rule already here, either way round: rules are last-match-wins,
 * so a starter rule appended after the household's own would override it
 * wherever both match.
 */
export function missingRules(state: Pick<State, 'rules'>): MissingRules {
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
  return { rules, skippedRules };
}
