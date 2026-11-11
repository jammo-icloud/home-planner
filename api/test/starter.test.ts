import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { toolByName, commit, ProposalStore } from '../src/tools.ts';
import type { Proposal, ToolContext } from '../src/tools.ts';
import { byRule } from '../src/replay.ts';
import { STARTER_CATEGORIES, STARTER_RULES, PRICED, missingRules } from '../src/starter.ts';
import { TRANSFER, INCOME } from '../src/types.ts';
import type { NewEvent } from '../src/store.ts';

const NOW = '2026-08-13T09:00:00Z';

async function household(seed: NewEvent[] = []): Promise<ToolContext> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-starter-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('alice', [{ op: 'household.claim', label: 'Home' }, ...seed]);
  return { store, who: 'alice', today: '2026-08-13', proposals: new ProposalStore(), sid: null };
}

/** The walkthrough's Envelopes step, with one starter row ticked. */
const propose = (c: ToolContext) => toolByName.get('make_starter_envelopes')!.run(
  { envelopes: [{ label: 'Groceries', id: 'groceries', category: 'food' }] }, c) as Proposal;

describe('the starter set', () => {
  test('the starter rules this household lacks come with the starter envelopes, and land on approval', async () => {
    const c = await household();
    const p = propose(c);
    assert.equal(c.store.state.rules.length, 0, 'nothing is written until it is approved');
    await commit(p.id, c);
    assert.deepEqual(c.store.state.rules.map((r) => [r.match, r.envelope]), STARTER_RULES.map((r) => [r.match, r.envelope]));
  });

  test('its envelope ids are the ones pricing from local data fills, so evidence lands in a named envelope', () => {
    const ids = new Set(STARTER_CATEGORIES.flatMap((c) => c.envelopes.map((e) => e.id)));
    for (const id of ['rent', 'tax', 'elec']) assert.ok(ids.has(id), id);
  });

  test('a card payment, the checking side of it, and a paycheque are sorted on import', async () => {
    const c = await household();
    await commit(propose(c).id, c);
    const rules = c.store.state.rules;
    // Common card-payment and payroll descriptors, as they arrive.
    assert.equal(byRule(rules, { payee: 'PAYMENT THANK YOU - WEB Q1W2E3' }), TRANSFER);
    assert.equal(byRule(rules, { payee: 'ACH Debit EXAMPLE BANK CREDIT CARD PAYMENT' }), TRANSFER);
    assert.equal(byRule(rules, { payee: 'ACH Credit ACME CORP PAYROLL' }), INCOME);
    assert.equal(byRule(rules, { payee: 'Dividend' }), INCOME);
    assert.equal(byRule(rules, { payee: 'HILLTOP FOODS #0123' }), null, 'and nothing else');
  });

  test('a starter category already here by name is used and never renamed', async () => {
    const c = await household([{ op: 'category.add', category: 'eating', label: 'food' }]);
    const p = propose(c);
    assert.equal(p.events.some((e) => e.op === 'category.add'), false);
    await commit(p.id, c);
    assert.equal(c.store.state.categories.get('eating')!.label, 'food');
    assert.equal(c.store.state.envelopes.get('groceries')!.category, 'eating');
  });

  test('a rule overlapping one already here is skipped, because the last match wins', async () => {
    // Appended after the household's own rule, a broader starter rule would
    // override it on every receipt both match.
    const c = await household([
      { op: 'category.add', category: 'side', label: 'Side work' },
      { op: 'envelope.define', envelope: 'side', label: 'Side work', category: 'side', template: 0 as never },
      { op: 'rule.add', rule: 'r-mine', match: 'ACME PAYROLL', envelope: 'side' },
    ]);
    const p = propose(c);
    assert.ok(!p.events.some((e) => e.op === 'rule.add' && e.match === 'PAYROLL'));
    assert.ok(p.effects.some((e) => /"PAYROLL".*overlaps your rule "ACME PAYROLL"/.test(e)));
    await commit(p.id, c);
    assert.equal(byRule(c.store.state.rules, { payee: 'ACME PAYROLL' }), 'side');
  });

  test('it says rules sort what is imported from now on, not what is already here', async () => {
    const p = propose(await household());
    assert.ok(p.effects.some((e) => /imported from now on/.test(e)));
  });

  test('a second run adds no rule', async () => {
    const c = await household();
    await commit(propose(c).id, c);
    assert.deepEqual(missingRules(c.store.state), { rules: [], skippedRules: [] });
    const again = toolByName.get('make_starter_envelopes')!.run({ envelopes: [{ label: 'Dining out', id: 'dining', category: 'food' }] }, c) as Proposal;
    assert.equal(again.events.some((e) => e.op === 'rule.add'), false);
  });
});

describe('the starter categories', () => {
  test("six categories in the spec's order, each with today's starter envelopes", () => {
    assert.deepEqual(STARTER_CATEGORIES.map((c) => c.label),
      ['Home', 'Food', 'Insurance', 'Utilities', 'Savings and sinking funds', 'Everyday']);
    assert.deepEqual(STARTER_CATEGORIES.map((c) => c.envelopes.map((e) => e.id)), [
      ['rent', 'tax', 'upkeep'],
      ['groceries', 'dining'],
      ['homeins', 'carins', 'healthins'],
      ['elec', 'heat', 'water', 'internet'],
      ['emergency', 'savings', 'travel', 'gifts'],
      ['transport', 'clothing', 'personal', 'subscriptions', 'fun'],
    ]);
    const all = STARTER_CATEGORIES.flatMap((c) => c.envelopes);
    assert.equal(all.some((e) => e.id === 'health'), false, 'Health & medical is not a starter envelope');
    assert.equal(all.find((e) => e.id === 'healthins')?.label, 'Health insurance');
  });

  test('PRICED is rent, tax and elec', () => {
    assert.deepEqual([...PRICED].sort(), ['elec', 'rent', 'tax']);
  });
});
