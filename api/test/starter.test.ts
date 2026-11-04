import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { toolByName, commit, ProposalStore, ToolError } from '../src/tools.ts';
import type { Proposal, ToolContext } from '../src/tools.ts';
import { categorize } from '../src/replay.ts';
import { STARTER_CATEGORIES, STARTER_RULES, STARTER_GROUPS, PRICED, groupOrder, groupKind, missingStarter } from '../src/starter.ts';
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

const propose = (c: ToolContext) => toolByName.get('add_starter_set')!.run({}, c) as Proposal;

describe('the starter set', () => {
  test('a new household is offered every category and rule, and gets them on approval', async () => {
    const c = await household();
    const p = propose(c);
    assert.equal(p.summary, `Add ${STARTER_CATEGORIES.length} categories and ${STARTER_RULES.length} rules`);
    assert.equal(c.store.state.categories.size, 0, 'nothing is written until it is approved');

    await commit(p.id, c);
    for (const s of STARTER_CATEGORIES) assert.equal(c.store.state.categories.get(s.id)?.label, s.label);
    assert.equal(c.store.state.rules.length, STARTER_RULES.length);
  });

  test('its ids are the ones pricing from local data fills, so evidence lands in a named category', () => {
    const ids = new Set(STARTER_CATEGORIES.map((s) => s.id));
    for (const id of ['rent', 'tax', 'elec']) assert.ok(ids.has(id), id);
  });

  test('a card payment, the checking side of it, and a paycheque are sorted on import', async () => {
    const c = await household();
    await commit(propose(c).id, c);
    const rules = c.store.state.rules;
    // Common card-payment and payroll descriptors, as they arrive.
    assert.equal(categorize(rules, { payee: 'PAYMENT THANK YOU - WEB Q1W2E3' }), TRANSFER);
    assert.equal(categorize(rules, { payee: 'ACH Debit EXAMPLE BANK CREDIT CARD PAYMENT' }), TRANSFER);
    assert.equal(categorize(rules, { payee: 'ACH Credit ACME CORP PAYROLL' }), INCOME);
    assert.equal(categorize(rules, { payee: 'Dividend' }), INCOME);
    assert.equal(categorize(rules, { payee: 'HILLTOP FOODS #0123' }), null, 'and nothing else');
  });

  test('a category already here, by id or by name, is skipped and never renamed', async () => {
    // define_category renames when the id exists, so offering it again would
    // quietly relabel someone's own category.
    const c = await household([
      { op: 'category.define', category: 'rent', label: 'Mortgage' },
      { op: 'category.define', category: 'electricity', label: 'Electricity' },
    ]);
    const p = propose(c);
    assert.ok(!p.events.some((e) => e.op === 'category.define' && (e.category === 'rent' || e.category === 'elec')));
    assert.ok(p.effects.some((e) => /Already here, so skipped: .*Rent or mortgage.*Electricity/.test(e)));
    await commit(p.id, c);
    assert.equal(c.store.state.categories.get('rent')!.label, 'Mortgage');
  });

  test('a rule overlapping one already here is skipped, because the last match wins', async () => {
    // Appended after the household's own rule, a broader starter rule would
    // override it on every receipt both match.
    const c = await household([
      { op: 'category.define', category: 'side', label: 'Side work' },
      { op: 'rule.add', rule: 'r-mine', match: 'ACME PAYROLL', category: 'side' },
    ]);
    const p = propose(c);
    assert.ok(!p.events.some((e) => e.op === 'rule.add' && e.match === 'PAYROLL'));
    assert.ok(p.effects.some((e) => /"PAYROLL".*overlaps your rule "ACME PAYROLL"/.test(e)));
    await commit(p.id, c);
    assert.equal(categorize(c.store.state.rules, { payee: 'ACME PAYROLL' }), 'side');
  });

  test('it says rules sort what is imported from now on, not what is already here', async () => {
    const p = propose(await household());
    assert.ok(p.effects.some((e) => /imported from now on/.test(e)));
  });

  test('a second run has nothing to offer and says so', async () => {
    const c = await household();
    await commit(propose(c).id, c);
    assert.deepEqual(missingStarter(c.store.state), { categories: [], rules: [], skippedCategories: STARTER_CATEGORIES.map((s) => s.label), skippedRules: [] });
    assert.throws(() => propose(c), (e: ToolError) => e instanceof ToolError && /already has everything/.test(e.message));
  });
});

describe('the starter groups', () => {
  test("six groups in the spec's order, each envelope a starter category", () => {
    assert.deepEqual(STARTER_GROUPS.map((g) => g.name),
      ['Home', 'Food', 'Insurance', 'Utilities', 'Savings and sinking funds', 'Everyday']);
    assert.deepEqual(STARTER_GROUPS.map((g) => g.envelopes.map((e) => e.id)), [
      ['rent', 'tax', 'upkeep'],
      ['groceries', 'dining'],
      ['homeins', 'carins', 'healthins'],
      ['elec', 'heat', 'water', 'internet'],
      ['emergency', 'savings', 'travel', 'gifts'],
      ['transport', 'clothing', 'personal', 'subscriptions', 'fun'],
    ]);
    for (const g of STARTER_GROUPS) {
      for (const e of g.envelopes) {
        assert.equal(e.label, STARTER_CATEGORIES.find((s) => s.id === e.id)?.label);
      }
    }
    const grouped = new Set(STARTER_GROUPS.flatMap((g) => g.envelopes.map((e) => e.id)));
    assert.equal(grouped.has('health'), false);
    assert.ok(STARTER_CATEGORIES.some((s) => s.id === 'health'));
    const hi = STARTER_CATEGORIES.find((s) => s.id === 'healthins');
    assert.equal(hi?.label, 'Health insurance');
    assert.equal(hi?.kind, 'People');
  });

  test('PRICED is rent, tax and elec', () => {
    assert.deepEqual([...PRICED].sort(), ['elec', 'rent', 'tax']);
  });

  test('groupOrder puts the six first and the rest alphabetically', () => {
    assert.deepEqual(groupOrder(['People', 'Food', 'Zeta', 'Home', 'Alpha', 'Food']),
      ['Home', 'Food', 'Alpha', 'People', 'Zeta']);
  });

  test('groupKind', () => {
    assert.equal(groupKind('Home'), 'House');
    assert.equal(groupKind('Utilities'), 'House');
    assert.equal(groupKind('Savings and sinking funds'), 'Future');
    for (const g of ['Food', 'Insurance', 'Everyday', 'Pets']) assert.equal(groupKind(g), 'People');
  });
});
