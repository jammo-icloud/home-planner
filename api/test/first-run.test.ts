import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cents } from '../src/money.ts';
import { Store } from '../src/store.ts';
import type { NewEvent } from '../src/store.ts';
import { firstRun } from '../src/first-run.ts';
import { STARTER_GROUPS } from '../src/starter.ts';

const NOW = '2026-11-04T09:00:00Z';
const TODAY = '2026-11-04';

async function fresh(seed: NewEvent[] = []): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-first-run-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('alex', [{ op: 'household.claim', label: 'Rivera' }, ...seed]);
  return store;
}

const placitas: NewEvent = { op: 'budget.create', budget: 'placitas', label: 'Placitas' };
const open: NewEvent = { op: 'month.open', budget: 'placitas', month: '2026-11', income: cents(0) };
const envelope: NewEvent[] = [
  { op: 'category.define', category: 'groceries', label: 'Groceries' },
  { op: 'envelope.define', budget: 'placitas', envelope: 'groceries', label: 'Groceries', group: 'Food',
    match: { categories: ['groceries'] }, template: cents(0), rollover: true, order: 0, needsFigure: true },
];
const pay = (amount: number): NewEvent => ({ op: 'income.source.define', source: 'pay', budget: 'placitas', label: 'Pay',
  earner: 'alex', amount: cents(amount), frequency: 'monthly', anchor: '2026-10-01' });

describe('where the walkthrough is', () => {
  test('no budget is the budget step', async () => {
    const s = await fresh();
    const r = firstRun(s.state, null, TODAY);
    assert.equal(r.step, 'budget');
    assert.equal(r.budget, null);
    assert.equal(r.month, '2026-11');
    assert.equal(r.monthOpen, false);
  });

  test('a budget with no month is the income step, with its suggestion', async () => {
    const s = await fresh([placitas, pay(640000)]);
    const r = firstRun(s.state, 'placitas', TODAY);
    assert.equal(r.step, 'income');
    assert.equal(r.budget, 'placitas');
    assert.deepEqual(r.income.suggestion, { exact: '$6,400.00', from: 'source' });
  });

  test('an open month with no envelopes is the envelopes step', async () => {
    const s = await fresh([placitas, open]);
    const r = firstRun(s.state, null, TODAY);
    assert.equal(r.step, 'envelopes');
    assert.equal(r.monthOpen, true);
    assert.equal(r.income.suggestion, null);
  });

  test('envelopes mean no walkthrough', async () => {
    const s = await fresh([placitas, ...envelope]);
    assert.equal(firstRun(s.state, 'placitas', TODAY).step, null);
  });

  test('an archived budget asked for falls to a live one', async () => {
    const s = await fresh([placitas, { op: 'budget.create', budget: 'cabin', label: 'Cabin' },
      { op: 'budget.archive', budget: 'cabin', archived: true, why: 'sold' }]);
    assert.equal(firstRun(s.state, 'cabin', TODAY).budget, 'placitas');
  });

  test('the groups are the starter groups, rent, tax and elec marked priced', async () => {
    const s = await fresh([placitas]);
    const r = firstRun(s.state, null, TODAY);
    assert.deepEqual(r.groups.map((g) => g.name), STARTER_GROUPS.map((g) => g.name));
    const rows = r.groups.flatMap((g) => g.envelopes);
    assert.deepEqual(rows.filter((e) => e.priced).map((e) => e.id).sort(), ['elec', 'rent', 'tax']);
    assert.equal(rows.length, STARTER_GROUPS.flatMap((g) => g.envelopes).length);
  });

  test('hasSource is true once an income source is recorded', async () => {
    const s = await fresh([placitas]);
    assert.equal(firstRun(s.state, null, TODAY).income.hasSource, false);
    await s.append('alex', [pay(200000)]);
    assert.equal(firstRun(s.state, null, TODAY).income.hasSource, true);
  });
});
