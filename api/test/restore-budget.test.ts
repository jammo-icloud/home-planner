// api/test/restore-budget.test.ts
//
// A household has one budget, and a restore never merges two. The Budget band
// (and the Months band with it) restores in place only into a household whose
// budget is empty; anywhere else it is a collision in words. Receipts need
// envelopes to be sorted into; one naming an envelope that is not here lands
// in To sort. A backup from before 0.10.0 is refused by name.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Households } from '../src/households.ts';
import { toSort } from '../src/analytics.ts';
import { budgetIsEmpty, eventsToApply, parseBackup, planRestore, scopeOf, unreadableBackup } from '../src/restore.ts';
import type { ParsedBackup } from '../src/restore.ts';
import { replay } from '../src/replay.ts';
import type { Store } from '../src/store.ts';
import type { Event } from '../src/types.ts';
import { parseDollars } from '../src/money.ts';
import { figuresOf } from './household-figures.ts';

const ALREADY = 'This household already has a budget. Restore it as a new household instead.';
const NO_ENVELOPES = "Receipts and rules are sorted into envelopes, and this household's budget has none yet: choose Budget too, or restore it as a new household.";
const MONTHS_NEED = 'Months need the budget they were planned in: choose Budget too.';

const households = async () => new Households(join(await mkdtemp(join(tmpdir(), 'pb-restore-budget-')), 'households'));
const backupOf = async (store: Store): Promise<ParsedBackup> => parseBackup(await readFile(store.path, 'utf8'));

/**
 * Home: a category, two envelopes, a rule, receipts sorted into them, where it
 * is, and a month. The rule and the receipts come before the second envelope,
 * as a household that imported before it planned would write them.
 */
async function homeOf(hh: Households): Promise<Store> {
  const { store } = await hh.create('alice', 'Home');
  await store.append('alice', [
    { op: 'category.add', category: 'food', label: 'Food' },
    { op: 'envelope.define', envelope: 'groceries', label: 'Groceries', category: 'food', template: parseDollars('600.00'), order: 0 },
    { op: 'rule.add', rule: 'r-market', match: 'EXAMPLE MARKET', envelope: 'groceries' },
    { op: 'txn.add', txns: [
      { id: 't1', date: '2026-11-02', payee: 'EXAMPLE MARKET', amount: parseDollars('-120.00'), dedupeKey: 't1', envelope: 'groceries' },
      { id: 't2', date: '2026-11-03', payee: 'CORNER BISTRO', amount: parseDollars('-80.00'), dedupeKey: 't2', envelope: 'dining' },
    ] },
    { op: 'rule.add', rule: 'r-bistro', match: 'CORNER BISTRO', envelope: 'dining' },
    { op: 'envelope.define', envelope: 'dining', label: 'Dining', category: 'food', template: parseDollars('200.00'), order: 1 },
    { op: 'household.locate', location: { label: 'Springfield, IL', state: 'IL', postal: '62701' }, why: 'where we live' },
    { op: 'month.open', month: '2026-11', income: parseDollars('5000.00') },
    { op: 'assign', month: '2026-11', envelope: 'dining', to: parseDollars('250.00'), why: 'a birthday' },
  ]);
  return store;
}

async function setUp() {
  const hh = await households();
  const home = await homeOf(hh);
  const backup = await backupOf(home);
  const fresh = (await hh.create('alice', 'Fresh')).store;
  const { store: other } = await hh.create('alice', 'Other');
  await other.append('alice', [
    { op: 'category.add', category: 'home', label: 'Home' },
    { op: 'envelope.define', envelope: 'rent', label: 'Rent', category: 'home', template: parseDollars('2500.00'), order: 0 },
  ]);
  return { hh, home, backup, fresh, other };
}

describe('restoring a budget', () => {
  test('into a household whose budget is empty, as today', async () => {
    const { home, backup, fresh } = await setUp();
    const plan = planRestore(fresh.state, backup, ['facts', 'budget', 'months'], await fresh.ids());
    assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);
    assert.ok(plan.summary.includes('the budget: 2 envelopes in 1 category'), plan.summary.join(' | '));
    await fresh.adopt(eventsToApply(plan));
    assert.deepEqual([...fresh.state.envelopes], [...home.state.envelopes]);
    assert.deepEqual([...fresh.state.categories], [...home.state.categories]);
    assert.deepEqual(fresh.state.location, home.state.location);
    assert.deepEqual([...fresh.state.months], [...home.state.months]);
    assert.deepEqual([...fresh.state.txns], [...home.state.txns]);
  });

  test("a household's own backup restores over itself: its lines are left out", async () => {
    const { home, backup } = await setUp();
    const plan = planRestore(home.state, backup, ['facts', 'budget', 'months'], await home.ids());
    assert.deepEqual([plan.collisions, plan.missingPrerequisites, plan.take], [[], [], []]);
    assert.deepEqual(plan.summary, ['Every line selected from this backup is already here: there is nothing to restore.']);
  });

  test('into a household that already has a budget, a collision in words', async () => {
    const { backup, other } = await setUp();
    const ids = await other.ids();
    const plan = planRestore(other.state, backup, ['budget'], ids);
    assert.deepEqual(plan.collisions.map((c) => c.why), [ALREADY]);
    assert.deepEqual(plan.collisions.map((c) => c.kind), ['budget']);
    assert.deepEqual(planRestore(other.state, backup, ['months'], ids).collisions.map((c) => c.why), [ALREADY]);
    assert.deepEqual(planRestore(other.state, backup, ['months'], ids).missingPrerequisites, [], 'not also a missing budget');
    // All three: still the one collision, said once, and nothing applies.
    const all = planRestore(other.state, backup, ['facts', 'budget', 'months'], ids);
    assert.deepEqual([all.collisions.map((c) => c.why), all.missingPrerequisites], [[ALREADY], []]);
    const before = other.state;
    assert.throws(() => eventsToApply(all), /collision/);
    assert.equal(other.state, before);
    // Receipts alone into it are not a budget: they restore, and land where they can.
    const facts = planRestore(other.state, backup, ['facts'], ids);
    assert.deepEqual([facts.collisions, facts.missingPrerequisites], [[], []]);
    await other.adopt(eventsToApply(facts));
    assert.deepEqual([...other.state.envelopes.keys()], ['rent'], 'no envelope of the backup came with them');
    assert.deepEqual([...toSort(other.state).txnIds].sort(), ['t1', 't2']);
  });

  test('a budget is empty only with no categories, envelopes, income sources, bills, location or months', async () => {
    const hh = await households();
    const made = async (n: number, events: object[]) => {
      const { store } = await hh.create('alice', `Part ${n}`);
      if (events.length) await store.append('alice', events as never);
      return store.state;
    };
    assert.equal(budgetIsEmpty((await hh.create('alice', 'Bare')).store.state), true);
    const parts: object[][] = [
      [{ op: 'category.add', category: 'food', label: 'Food' }],
      [{ op: 'category.add', category: 'food', label: 'Food' },
        { op: 'envelope.define', envelope: 'groceries', label: 'Groceries', category: 'food', template: parseDollars('0.00'), order: 0 },
        { op: 'category.add', category: 'spare', label: 'Spare' }],
      [{ op: 'income.source.define', source: 'pay', label: 'Pay', earner: 'alice', amount: parseDollars('5000.00'), frequency: 'monthly', anchor: '2026-11-01' }],
      [{ op: 'household.locate', location: { label: 'Springfield, IL' }, why: 'where we live' }],
      [{ op: 'month.open', month: '2026-11', income: parseDollars('0.00') }],
    ];
    for (const [i, events] of parts.entries()) assert.equal(budgetIsEmpty(await made(i, events)), false, JSON.stringify(events));
    // A bill alone cannot be written without its envelope, so it is read from the state's own map.
    const state = await made(9, []);
    assert.equal(budgetIsEmpty({ ...state, bills: new Map([['x', {} as never]]) }), false);
    // A receipt, a rule or a plan is not the budget.
    assert.equal(budgetIsEmpty(await made(10, [
      { op: 'txn.add', txns: [{ id: 'r1', date: '2026-11-02', payee: 'QUIKSTOP', amount: parseDollars('-5.00'), dedupeKey: 'r1', envelope: null }] },
      { op: 'rule.add', rule: 'r-q', match: 'QUIKSTOP', envelope: 'fuel' },
    ])), true);
  });

  test('receipts without the Budget band, into a budget with no envelopes, is a missing prerequisite', async () => {
    const { backup, fresh } = await setUp();
    assert.deepEqual(planRestore(fresh.state, backup, ['facts']).missingPrerequisites, [NO_ENVELOPES]);
    assert.deepEqual(planRestore(fresh.state, backup, ['months']).missingPrerequisites, [MONTHS_NEED]);
    assert.deepEqual(planRestore(fresh.state, backup, ['facts', 'months']).missingPrerequisites, [NO_ENVELOPES, MONTHS_NEED]);
    assert.throws(() => eventsToApply(planRestore(fresh.state, backup, ['facts'])), /missing prerequisite/);
    // With the Budget band, the same receipts restore.
    assert.deepEqual(planRestore(fresh.state, backup, ['facts', 'budget']).missingPrerequisites, []);
  });

  test('a receipt naming an envelope that is not here lands in To sort, never refused or left out', async () => {
    const { hh, backup } = await setUp();
    const { store: groceries } = await hh.create('alice', 'Groceries only');
    await groceries.append('alice', [
      { op: 'category.add', category: 'food', label: 'Food' },
      { op: 'envelope.define', envelope: 'groceries', label: 'Groceries', category: 'food', template: parseDollars('600.00'), order: 0 },
    ]);
    const plan = planRestore(groceries.state, backup, ['facts'], await groceries.ids());
    assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);
    await groceries.adopt(eventsToApply(plan));
    assert.deepEqual([...groceries.state.txns.keys()].sort(), ['t1', 't2'], 'none left out');
    assert.equal(groceries.state.txns.get('t2')!.envelope, 'dining', 'still names the envelope it was sorted into');
    assert.deepEqual([...toSort(groceries.state).txnIds], ['t2']);
    assert.deepEqual(groceries.state.rules.map((r) => [r.match, r.envelope]),
      [['EXAMPLE MARKET', 'groceries'], ['CORNER BISTRO', 'dining']], 'the rule naming Dining is kept too');
  });

  test('the Budget band is written before the receipts', async () => {
    const { backup, fresh } = await setUp();
    const ids = (events: readonly Event[], band: string) => events.filter((e) => scopeOf(e) === band).map((e) => e.id);
    // The backup really has a receipt and rules ahead of a budget line, or this says nothing.
    const at = (events: readonly Event[]) => ({
      lastBudget: events.findLastIndex((e) => scopeOf(e) === 'budget'),
      firstFacts: events.findIndex((e) => scopeOf(e) === 'facts'),
    });
    assert.ok(at(backup.events).firstFacts < at(backup.events).lastBudget);

    const out = eventsToApply(planRestore(fresh.state, backup, ['facts', 'budget', 'months'], await fresh.ids()));
    assert.ok(at(out).lastBudget < at(out).firstFacts, out.map((e) => e.op).join(', '));
    for (const band of ['budget', 'facts', 'months']) assert.deepEqual(ids(out, band), ids(backup.events, band), `${band}, in its own order`);
  });

  test('a Budget line never moves past a month, and a removal never past its rule: the household log restores with every figure the same', async () => {
    // The log holds an envelope added after a month opened, a rule removed
    // and then its envelope, and closed months that keep the removed one.
    // Moved past those, a month would plan an envelope it never had, and a
    // closed month would lose the one removed: the figures would change.
    const frozen = JSON.parse(readFileSync(new URL('./fixtures/household-log.figures.json', import.meta.url), 'utf8'));
    const text = readFileSync(new URL('./fixtures/household-log.jsonl', import.meta.url), 'utf8');
    const backup = parseBackup(text);
    assert.deepEqual([backup.skipped, backup.unknown], [[], []]);
    const { store } = await (await households()).create('alice', 'Restored here');
    await store.append('alice', { op: 'household.zone', zone: 'America/Denver' });
    const plan = planRestore(store.state, backup, ['facts', 'budget', 'months'], await store.ids());
    assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);
    await store.adopt(eventsToApply(plan));
    assert.deepEqual(figuresOf(store.state), frozen);
    assert.deepEqual(figuresOf(replay(eventsToApply(plan))), figuresOf(replay(backup.events)));
  });

  test('a backup from before 0.10.0 is refused in words', () => {
    const b = parseBackup('{"id":"x1","at":"2026-10-01T00:00:00Z","who":"alice","op":"budget.create","budget":"home","label":"Home"}\n');
    assert.equal(unreadableBackup(b), 'This backup was made before Home Planner 0.10.0, which keeps one budget and sorts receipts into envelopes. It cannot be restored into this version.');
  });

  test('every retired op names 0.10.0, even beside an op from a newer build; a newer op alone is still "newer"', () => {
    const line = (e: object) => JSON.stringify({ at: '2026-10-01T00:00:00Z', who: 'alice', ...e });
    const claim = line({ id: 'x0', op: 'household.claim', label: 'Home' });
    const before = /^This backup was made before Home Planner 0\.10\.0/;
    for (const op of ['budget.create', 'budget.rename', 'budget.archive', 'budget.locate', 'txn.categorize',
      'category.define', 'category.archive', 'category.sinking']) {
      assert.match(unreadableBackup(parseBackup([claim, line({ id: 'x1', op })].join('\n')))!, before, op);
    }
    assert.match(unreadableBackup(parseBackup([claim, line({ id: 'x1', op: 'chore.set' }), line({ id: 'x2', op: 'txn.categorize' })].join('\n')))!, before);
    assert.equal(unreadableBackup(parseBackup([claim, line({ id: 'x1', op: 'chore.set' })].join('\n'))),
      'This backup was made by a newer Home Planner. It holds chore.set, which this version cannot read.');
    assert.equal(unreadableBackup(parseBackup(claim)), null);
  });
});
