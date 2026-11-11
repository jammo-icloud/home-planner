import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cents } from '../src/money.ts';
import { apply, replay } from '../src/replay.ts';
import { envelopeIdFor, monthView } from '../src/envelopes.ts';
import { fixedCharges, monthClock, pace, toSort } from '../src/analytics.ts';
import { balanceAsOf, goalFor } from '../src/sinking.ts';
import { STARTER_CATEGORIES, STARTER_RULES } from '../src/starter.ts';
import { INCOME, SPLIT, TRANSFER } from '../src/types.ts';
import type { Event, State, Txn } from '../src/types.ts';
import type { DistributiveOmit } from '../src/util-types.ts';

let seq = 0;
type EvInput = DistributiveOmit<Event, 'id' | 'at' | 'who'> & { id?: string; at?: string; who?: string };
const ev = (e: EvInput): Event =>
  ({ id: `e${++seq}`, at: `2026-11-01T00:00:0${seq % 10}Z`, who: 'alice', ...e }) as Event;
const claim = () => ev({ op: 'household.claim', label: 'Home' });

/** Food (Groceries $600, Dining $200) and Fun (Gym $40); September, October and November open, September closed, then `more`. */
const house = (more: Event[] = []): State => replay([
  claim(),
  ev({ op: 'category.add', category: 'food', label: 'Food' }),
  ev({ op: 'category.add', category: 'fun', label: 'Fun' }),
  ev({ op: 'envelope.define', envelope: 'groceries', label: 'Groceries', category: 'food', template: cents(60000) }),
  ev({ op: 'envelope.define', envelope: 'dining', label: 'Dining', category: 'food', template: cents(20000) }),
  ev({ op: 'envelope.define', envelope: 'gym', label: 'Gym', category: 'fun', template: cents(4000) }),
  ev({ op: 'month.open', month: '2026-09', income: cents(500000) }),
  ev({ op: 'month.open', month: '2026-10', income: cents(500000) }),
  ev({ op: 'month.open', month: '2026-11', income: cents(500000) }),
  ev({ op: 'month.close', month: '2026-09', closed: true, why: 'done' }),
  ...more,
]);
const t = (id: string, date: string, payee: string, dollars: string): Txn =>
  ({ id, date, payee, amount: cents(Math.round(Number(dollars) * 100)), dedupeKey: id, envelope: null });
const add = (txn: Txn) => ev({ op: 'txn.add', txns: [txn] });
const sortTo = (id: string, envelope: string) => ev({ op: 'txn.sort', txn: id, envelope, manual: true });
const spent = (s: State, month: string) =>
  Object.fromEntries(monthView(s, month)!.envelopes.map((e) => [e.envelope.id, e.activity as number]));
const bad = (e: EvInput, re: RegExp) => assert.throws(() => apply(house(), [ev(e)]), re);

describe('a receipt is sorted into one envelope', () => {
  test('txn.sort files it, and it counts there and only there', () => {
    const s = house([add(t('m1', '2026-11-03', 'EXAMPLE MARKET', '-120.00')), ev({ op: 'txn.sort', txn: 'm1', envelope: 'groceries', manual: true })]);
    assert.deepEqual(spent(s, '2026-11'), { groceries: 12000, dining: 0, gym: 0 });
    assert.equal(s.txns.get('m1')!.envelope, 'groceries');
    assert.equal('category' in s.txns.get('m1')!, false);
  });
  test('suggestedBy stays when the same envelope is confirmed and goes when it changes', () => {
    const s = house([add(t('m1', '2026-11-03', 'EXAMPLE MARKET', '-120.00')),
      ev({ op: 'txn.sort', txn: 'm1', envelope: 'groceries', suggestedBy: 'claude' })]);
    assert.equal(s.txns.get('m1')!.suggestedBy, 'claude');
    const same = apply(s, [sortTo('m1', 'groceries')]);
    assert.equal(same.txns.get('m1')!.suggestedBy, 'claude');
    const changed = apply(same, [sortTo('m1', 'dining')]);
    assert.equal(changed.txns.get('m1')!.suggestedBy, undefined);
    assert.equal(changed.txns.get('m1')!.manual, true);
  });
  test('a split counts each part in its own envelope', () => {
    const s = house([add(t('w1', '2026-11-04', 'EXAMPLE MARKET', '-60.00')),
      ev({ op: 'txn.split', txn: 'w1', parts: [{ envelope: 'groceries', amount: cents(-2000) }, { envelope: 'dining', amount: cents(-4000) }] })]);
    assert.deepEqual(spent(s, '2026-11'), { groceries: 2000, dining: 4000, gym: 0 });
    assert.equal(s.txns.get('w1')!.envelope, SPLIT);
  });
  test('the fold refuses', () => {
    bad({ op: 'txn.sort', txn: 'm1', envelope: SPLIT }, /a split is written with txn\.split/);
    bad({ op: 'txn.split', txn: 'm1', parts: [{ envelope: 'dining', amount: cents(-6000) }, { envelope: 'dining', amount: cents(-6000) }] }, /an envelope appears twice in the split/);
    bad({ op: 'txn.split', txn: 'm1', parts: [{ category: 'dining', amount: cents(-12000) }] } as never, /a part names its envelope/);
    bad({ op: 'txn.add', txns: [{ ...t('x', '2026-11-01', 'X', '-1.00'), envelope: SPLIT }] }, /split/);
  });
  test('a receipt or rule naming an envelope that is not here replays, and is To sort in any month', () => {
    const s = house([add({ ...t('o', '2026-09-02', 'OLD', '-5.00'), envelope: 'nowhere' }), ev({ op: 'rule.add', rule: 'r', match: 'OLD', envelope: 'nowhere' })]);
    assert.deepEqual(toSort(s).txnIds, ['o']);
    assert.equal(monthView(s, '2026-09')!.activity, 0);
  });
});

describe('categories are headings', () => {
  test('added last, renamed, moved to a place, removed only when empty', () => {
    const s = apply(house(), [ev({ op: 'category.add', category: 'home', label: 'Home' })]);
    assert.deepEqual([...s.categories.keys()], ['food', 'fun', 'home']);
    const moved = apply(s, [ev({ op: 'category.move', category: 'home', to: 0 }), ev({ op: 'category.rename', category: 'food', label: 'Food and drink' })]);
    assert.deepEqual([...moved.categories.keys()], ['home', 'food', 'fun']);
    assert.equal(moved.categories.get('food')!.label, 'Food and drink');
    assert.throws(() => apply(moved, [ev({ op: 'category.move', category: 'home', to: 3 })]), /a category moves to a place in the list/);
    assert.throws(() => apply(moved, [ev({ op: 'category.remove', category: 'fun' })]), /Fun still holds envelopes/);
    assert.deepEqual([...apply(moved, [ev({ op: 'category.remove', category: 'home' })]).categories.keys()], ['food', 'fun']);
  });
  test('names are unique, case and spaces ignored', () => {
    bad({ op: 'category.add', category: 'food2', label: ' food ' }, /There is already a category called Food\./);
    bad({ op: 'category.rename', category: 'fun', label: 'FOOD' }, /There is already a category called Food\./);
    bad({ op: 'envelope.define', envelope: 'g2', label: 'GROCERIES', category: 'food', template: cents(0) }, /There is already an envelope called Groceries\./);
    // An envelope keeps its own name when it is defined again.
    assert.equal(apply(house(), [ev({ op: 'envelope.define', envelope: 'groceries', label: 'groceries', category: 'food', template: cents(0) })]).envelopes.get('groceries')!.label, 'groceries');
  });
  test('an envelope needs a category that is here', () => bad({ op: 'envelope.define', envelope: 'x', label: 'X', category: 'nope', template: cents(0) }, /no such category: nope/));
  test('the month lists envelopes in category order, then envelope order', () => {
    const s = apply(house(), [ev({ op: 'category.move', category: 'fun', to: 0 })]);
    assert.deepEqual(monthView(s, '2026-11')!.envelopes.map((e) => e.envelope.id), ['gym', 'groceries', 'dining']);
  });
});

describe('removing an envelope', () => {
  const gymTxns = () => [add(t('g9', '2026-09-05', 'EXAMPLE GYM', '-40.00')), sortTo('g9', 'gym'), add(t('g11', '2026-11-05', 'EXAMPLE GYM', '-40.00')), sortTo('g11', 'gym'),
    add(t('b11', '2026-11-12', 'CORNER BISTRO', '-80.00')), ev({ op: 'txn.split', txn: 'b11', parts: [{ envelope: 'dining', amount: cents(-5000) }, { envelope: 'gym', amount: cents(-3000) }] })];
  const removed = () => house([...gymTxns(), ev({ op: 'envelope.remove', envelope: 'gym', why: 'cancelled' })]);
  test('a closed month keeps its receipts under its name, marked removed', () => {
    const g = monthView(removed(), '2026-09')!.envelopes.find((e) => e.envelope.id === 'gym')!;
    assert.deepEqual([g.removed, g.envelope.label, g.activity], [true, 'Gym', 4000]);
    assert.equal(g.planned, 4000, 'its plan entry stays');
    assert.equal(removed().removedEnvelopes.get('gym')!.category, 'fun');
    assert.deepEqual(removed().removedEnvelopes.get('gym')!.keptIn, ['2026-09']);
  });
  test('a month not closed sends them to To sort; a split goes whole and its other part still counts', () => {
    const s = removed();
    assert.deepEqual([...toSort(s).txnIds].sort(), ['b11', 'g11']);
    assert.deepEqual(toSort(s).missing.get('b11'), ['gym']);
    assert.equal(toSort(s).missing.has('g11'), false);
    assert.equal(monthView(s, '2026-11')!.envelopes.find((e) => e.envelope.id === 'dining')!.activity, 5000);
    assert.equal(monthView(s, '2026-11')!.envelopes.some((e) => e.envelope.id === 'gym'), false);
  });
  test("To sort's money out is a split's missing part, not the whole receipt; a whole receipt counts whole", () => {
    // g11 is $40 whole; b11 is $80 of which $50 already counts in Dining, so only the Gym part's $30 is in no envelope.
    assert.equal(toSort(removed()).outflow, 7000);
  });
  test('a fixed charge counts only receipts that count in an envelope: kept months, never To sort', () => {
    const gym = (id: string, date: string) => [add(t(id, date, 'EXAMPLE GYM', '-40.00')), sortTo(id, 'gym')];
    const s = house([...gym('g9', '2026-09-05'), ...gym('g10', '2026-10-05'), ...gym('g11', '2026-11-05'),
      ev({ op: 'month.close', month: '2026-10', closed: true, why: 'done' }),
      ev({ op: 'envelope.remove', envelope: 'gym', why: 'cancelled' })]);
    assert.deepEqual(fixedCharges(s).map((f) => [f.key, f.months]), [['example gym|gym', ['2026-09', '2026-10']]]);
    const nowhere = house(['2026-09-05', '2026-10-05', '2026-11-05'].map((d, i) => add({ ...t(`n${i}`, d, 'EXAMPLE GYM', '-40.00'), envelope: 'nowhere' })));
    assert.deepEqual(fixedCharges(nowhere), [], 'an envelope that never was here gives no charge');
  });
  test('a month closed after the removal keeps its receipts in To sort; a kept month reopened sends them there too', () => {
    const later = apply(removed(), [ev({ op: 'month.close', month: '2026-11', closed: true, why: 'done' })]);
    assert.ok(toSort(later).txnIds.includes('g11'));
    const reopened = apply(removed(), [ev({ op: 'month.close', month: '2026-09', closed: false, why: 'a late receipt' })]);
    assert.ok(toSort(reopened).txnIds.includes('g9'));
  });
  test('a kept month reopened and closed again keeps its receipts in To sort', () => {
    const again = apply(removed(), [
      ev({ op: 'month.close', month: '2026-09', closed: false, why: 'a late receipt' }),
      ev({ op: 'month.close', month: '2026-09', closed: true, why: 'done again' }),
    ]);
    assert.deepEqual(again.removedEnvelopes.get('gym')!.keptIn, []);
    assert.ok(toSort(again).txnIds.includes('g9'));
    assert.equal(monthView(again, '2026-09')!.envelopes.some((e) => e.envelope.id === 'gym'), false);
  });
  test("a closed month's figures for it are the same before and after the removal", () => {
    // Gym rolls over: August's leftover carries into September, both closed when it goes.
    const lived = [
      ev({ op: 'household.claim', label: 'Home' }),
      ev({ op: 'category.add', category: 'fun', label: 'Fun' }),
      ev({ op: 'envelope.define', envelope: 'gym', label: 'Gym', category: 'fun', template: cents(4000) }),
      ev({ op: 'envelope.define', envelope: 'swim', label: 'Swim', category: 'fun', template: cents(1000) }),
      ev({ op: 'month.open', month: '2026-08', income: cents(500000) }),
      ev({ op: 'month.open', month: '2026-09', income: cents(500000) }),
      ev({ op: 'month.open', month: '2026-10', income: cents(500000) }),
      add(t('g8', '2026-08-05', 'EXAMPLE GYM', '-10.00')), sortTo('g8', 'gym'),
      add(t('g9', '2026-09-05', 'EXAMPLE GYM', '-25.00')), sortTo('g9', 'gym'),
      ev({ op: 'month.close', month: '2026-08', closed: true, why: 'done' }),
      ev({ op: 'month.close', month: '2026-09', closed: true, why: 'done' }),
    ];
    const figures = (s: State, month: string) => {
      const v = monthView(s, month)!;
      const g = v.envelopes.find((e) => e.envelope.id === 'gym')!;
      return [g.planned, g.funded, g.carried, g.activity, g.available, v.planned, v.funded, v.activity, v.toAssign];
    };
    const before = replay(lived);
    const after = apply(before, [ev({ op: 'envelope.remove', envelope: 'gym', why: 'cancelled' })]);
    for (const month of ['2026-08', '2026-09']) assert.deepEqual(figures(after, month), figures(before, month), month);
    assert.deepEqual(figures(after, '2026-09').slice(2, 5), [3000, 2500, 4500], 'August left $30, carried into September');
  });
  test('its id is reserved, and the same name takes a fresh one', () => {
    assert.throws(() => apply(removed(), [ev({ op: 'envelope.define', envelope: 'gym', label: 'Gym', category: 'fun', template: cents(0) })]), /gym was removed; a new envelope takes a new id/);
    assert.equal(envelopeIdFor(removed(), 'Gym'), 'gym-2');
    const back = apply(removed(), [ev({ op: 'envelope.define', envelope: 'gym-2', label: 'Gym', category: 'fun', template: cents(0) })]);
    assert.deepEqual([...toSort(back).txnIds].sort(), ['b11', 'g11'], 'old receipts are never pulled back');
  });
  test('a rule still sorting into it refuses the removal; its bills go with it', () => {
    const ruled = house([...gymTxns(), ev({ op: 'rule.add', rule: 'r-gym', match: 'EXAMPLE GYM', envelope: 'gym' })]);
    assert.throws(() => apply(ruled, [ev({ op: 'envelope.remove', envelope: 'gym', why: 'w' })]), /a rule still sorts into Gym/);
    const billed = apply(ruled, [
      ev({ op: 'bill.set', envelope: 'gym', bill: 'example gym', name: 'EXAMPLE GYM', date: { kind: 'due', per: 'month', day: 5 } }),
      ev({ op: 'rule.remove', rule: 'r-gym' }),
      ev({ op: 'envelope.remove', envelope: 'gym', why: 'w' }),
    ]);
    assert.equal([...billed.bills.values()].some((b) => b.envelope === 'gym'), false);
    assert.equal(billed.envelopes.has('gym'), false);
  });
});

describe('savings and repeating charges', () => {
  const roof = (more: Event[] = []) => house([
    ev({ op: 'envelope.define', envelope: 'roof', label: 'Roof', category: 'fun', template: cents(0),
      sinking: { kind: 'every', estimate: { cost: cents(120000), everyYears: 4 } } }),
    ...more,
  ]);
  test("an every goal's estimate is the envelope's own", () => {
    const s = roof();
    const g = goalFor(s, s.envelopes.get('roof')!, '2026-11')!;
    assert.equal(g.monthly, 2500);
    assert.equal(g.target, 120000);
    assert.deepEqual(g.estimate, { cost: 120000, everyYears: 4 });
  });
  test('the balance on a day counts split parts', () => {
    const s = roof([add(t('h1', '2026-11-05', 'EXAMPLE HARDWARE', '-100.00')),
      ev({ op: 'txn.split', txn: 'h1', parts: [{ envelope: 'groceries', amount: cents(-6000) }, { envelope: 'roof', amount: cents(-4000) }] })]);
    assert.equal(balanceAsOf(s, 'roof', '2026-11-30'), -4000);
    assert.equal(balanceAsOf(s, 'roof', '2026-11-04'), 0);
  });
  test('pace counts a savings envelope as committed', () => {
    const s = roof([add(t('h2', '2026-11-05', 'EXAMPLE ROOFER', '-40.00')), sortTo('h2', 'roof')]);
    const row = pace(monthView(s, '2026-11')!, monthClock('2026-11', '2026-11-10'), s).find((p) => p.envelope === 'roof')!;
    assert.equal(row.committed, 4000);
    assert.equal(row.discretionary, 0);
  });
  test('a repeating charge is grouped by payee and envelope', () => {
    // Two P2P PAYMENTs a month into one envelope are one charge seen twice a month, so not fixed (was: two fixed charges by category).
    const both = (rent: string, other: string) => house([
      add(t('p10a', '2026-10-01', 'P2P PAYMENT', '-2500.00')), sortTo('p10a', rent),
      add(t('p10b', '2026-10-15', 'P2P PAYMENT', '-60.00')), sortTo('p10b', other),
      add(t('p11a', '2026-11-01', 'P2P PAYMENT', '-2500.00')), sortTo('p11a', rent),
      add(t('p11b', '2026-11-15', 'P2P PAYMENT', '-60.00')), sortTo('p11b', other),
    ]);
    assert.deepEqual(fixedCharges(both('groceries', 'groceries')), []);
    const apart = fixedCharges(both('groceries', 'dining'));
    assert.deepEqual(apart.map((f) => [f.envelope, f.typical]), [['groceries', 250000], ['dining', 6000]]);
    assert.notEqual(apart[0]!.key, apart[1]!.key);
  });
});

describe('the starter set', () => {
  test('six categories of starter envelopes, keeping today\'s ids', () => {
    assert.deepEqual(STARTER_CATEGORIES.map((c) => c.id), ['home', 'food', 'insurance', 'utilities', 'sinking', 'everyday']);
    assert.deepEqual(STARTER_CATEGORIES.map((c) => c.label), ['Home', 'Food', 'Insurance', 'Utilities', 'Savings and sinking funds', 'Everyday']);
    assert.deepEqual(STARTER_CATEGORIES.find((c) => c.id === 'utilities')!.envelopes.map((e) => e.id), ['elec', 'heat', 'water', 'internet']);
    assert.equal(STARTER_CATEGORIES.flatMap((c) => c.envelopes).some((e) => e.id === 'health'), false, 'Health & medical is gone');
    assert.deepEqual(STARTER_RULES.map((r) => r.envelope), [TRANSFER, TRANSFER, INCOME, INCOME]);
  });
});
