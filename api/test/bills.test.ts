import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars } from '../src/money.ts';
import { replay, apply } from '../src/replay.ts';
import { billDateWords, billKey, billsOf, fixedCharges } from '../src/analytics.ts';
import { describe as describeEvent } from '../src/tools.ts';
import { newerBackup, parseBackup, planRestore, eventsToApply, scopeOf } from '../src/restore.ts';
import { Households } from '../src/households.ts';
import type { BillDate, Event, State, Txn } from '../src/types.ts';
import type { DistributiveOmit } from '../src/util-types.ts';

let n = 0;
export const ev = (b: DistributiveOmit<Event, 'id' | 'at' | 'who'>, at = '2026-11-02T18:00:00Z'): Event =>
  ({ id: `e${++n}`, at, who: 'alice', ...b }) as Event;
export const pay = (id: string, date: string, payee: string, dollars: string, category: string | null): Txn =>
  ({ id, date, payee, amount: parseDollars(dollars), dedupeKey: id, category });

const envelope = (envelope: string, label: string, categories: string[], template: string, order: number, extra: object = {}) =>
  ev({ op: 'envelope.define', budget: 'harbor', envelope, label, group: 'House', match: { categories },
    template: parseDollars(template), rollover: false, order, ...extra } as never);

/** Claimed by alice. Harbor: `util` "Utilities" {elec, water}, `daily` "Daily life" {groceries}, `heat` "Heating" {gas, template 0}, `roof` "Roof" {roofing, sinking: { kind: 'every' }}. October and November open. */
export const houseEvents = (txns: readonly Txn[] = [], more: readonly Event[] = []): Event[] => [
  ev({ op: 'household.claim', label: 'Home' }),
  ...(['elec:Electricity', 'water:Water', 'groceries:Groceries', 'gas:Gas', 'roofing:Roofing'] as const).map((c) =>
    ev({ op: 'category.define', category: c.split(':')[0]!, label: c.split(':')[1]! })),
  ev({ op: 'budget.create', budget: 'harbor', label: 'Harbor' }),
  envelope('util', 'Utilities', ['elec', 'water'], '300.00', 0),
  envelope('daily', 'Daily life', ['groceries'], '600.00', 1),
  envelope('heat', 'Heating', ['gas'], '0.00', 2),
  envelope('roof', 'Roof', ['roofing'], '0.00', 3, { sinking: { kind: 'every' } }),
  ev({ op: 'month.open', budget: 'harbor', month: '2026-10', income: parseDollars('9600.00') }),
  ev({ op: 'month.open', budget: 'harbor', month: '2026-11', income: parseDollars('9600.00') }),
  ...(txns.length ? [ev({ op: 'txn.add', txns })] : []),
  ...more,
];
export const house = (txns: readonly Txn[] = [], more: readonly Event[] = []): State => replay(houseEvents(txns, more));
export const POWER = ['2026-08-14', '2026-09-14', '2026-10-14'].map((d) => pay(`p${d}`, d, 'EXAMPLE POWER BILLP', '-146.00', 'elec'));
export const SET = { op: 'bill.set', budget: 'harbor', envelope: 'util', bill: 'example power billp', name: 'Example Power', date: { kind: 'due', per: 'month', day: 16 } } as const;
const bills = (s: State) => [...s.budgets.get('harbor')!.bills.values()];

describe('a bill in the log', () => {
  test('bill.set keeps the bill on its budget, with the household day it was given', () => {
    const s = house([], [ev({ op: 'household.zone', zone: 'America/Denver' }), ev(SET, '2026-11-02T03:00:00Z')]);
    assert.deepEqual(bills(s), [{ envelope: 'util', key: 'example power billp', name: 'Example Power', byHand: false, date: { kind: 'due', per: 'month', day: 16 }, since: '2026-11-01' }]);
  });
  test('a date that does not change keeps its since; a new date moves it; cleared has none', () => {
    const at = (iso: string, date: BillDate | null) => ev({ ...SET, date }, iso);
    const d16: BillDate = { kind: 'due', per: 'month', day: 16 };
    const first = house([], [at('2026-11-02T18:00:00Z', d16)]);
    assert.equal(bills(first)[0]!.since, '2026-11-02');
    const same = apply(first, [at('2026-11-05T18:00:00Z', { ...d16 })]);
    assert.equal(bills(same)[0]!.since, '2026-11-02');
    const moved = apply(same, [at('2026-11-06T18:00:00Z', { kind: 'due', per: 'month', day: 17 })]);
    assert.equal(bills(moved)[0]!.since, '2026-11-06');
    const cleared = apply(moved, [at('2026-11-07T18:00:00Z', null)]);
    assert.equal(bills(cleared).length, 1);
    assert.deepEqual([bills(cleared)[0]!.date, bills(cleared)[0]!.since], [null, null]);
  });
  test('a bill named by hand stays so', () => {
    const s = house([], [ev({ ...SET, byHand: true }), ev(SET)]);
    assert.equal(bills(s)[0]!.byHand, true);
  });
  test('an append keeps every bill (thaw)', () => {
    const one = apply(house(), [ev(SET)]);
    const two = apply(one, [ev({ op: 'category.define', category: 'x', label: 'X' })]);
    assert.deepEqual(bills(two), bills(one));
    assert.equal(bills(two).length, 1);
  });
  test('the fold refuses', () => {
    const bad = (e: object, re: RegExp) => assert.throws(() => apply(house(), [ev(e as never)]), re);
    bad({ ...SET, budget: 'nope' }, /no such budget/);
    bad({ ...SET, envelope: 'nope' }, /no such envelope/);
    bad({ ...SET, bill: ' ' }, /a bill has a key/);
    bad({ ...SET, name: '' }, /a bill has a name/);
    bad({ ...SET, byHand: false }, /byHand is true or absent/);
    for (const date of [undefined, {}, { kind: 'soon', per: 'month', day: 1 }, { kind: 'due', per: 'week', day: 1 },
      { kind: 'due', per: 'month', day: 0 }, { kind: 'due', per: 'month', day: 32 }, { kind: 'due', per: 'month', day: 1.5 },
      { kind: 'due', per: 'month', on: '2026-11-01' }, { kind: 'due', per: 'year', on: '2026-13-01' }, { kind: 'due', per: 'year', day: 3 },
      { kind: 'due', per: 'month', day: 1, on: '2026-11-01' }]) bad({ ...SET, date }, /a bill's date is/);
  });
  test('bill.remove takes only a bill named by hand', () => {
    const hand = { ...SET, bill: 'example water', name: 'Example Water', byHand: true } as const;
    const gone = { op: 'bill.remove', budget: 'harbor', envelope: 'util', bill: 'example water', name: 'Example Water' } as const;
    assert.deepEqual(bills(house([], [ev(hand), ev(gone)])), []);
    assert.throws(() => house([], [ev(SET), ev({ ...gone, bill: SET.bill })]), /named by hand/);
    assert.throws(() => house([], [ev(gone)]), /no such bill/);
  });
  test('envelope.remove leaves its bills in the state', () => {
    const s = house([], [ev(SET), ev({ op: 'envelope.remove', budget: 'harbor', envelope: 'util', why: 'moved' })]);
    assert.equal(bills(s).length, 1);
  });
});

describe('the words for a date', () => {
  for (const [date, words] of [
    [{ kind: 'due', per: 'month', day: 16 }, 'due on the 16th, every month'],
    [{ kind: 'autopay', per: 'month', day: 1 }, 'Auto Pay on the 1st, every month'],
    [{ kind: 'payby', per: 'month', day: 22 }, 'pay by the 22nd, every month'],
    ...([[3, '3rd'], [11, '11th'], [13, '13th'], [31, '31st']] as const).map(([day, w]) => [{ kind: 'due', per: 'month', day }, `due on the ${w}, every month`] as const),
    [{ kind: 'due', per: 'quarter', on: '2026-02-14' }, 'due on 14 February, every quarter'],
    [{ kind: 'autopay', per: 'half-year', on: '2026-02-14' }, 'Auto Pay on 14 February, every six months'],
    [{ kind: 'payby', per: 'year', on: '2026-02-14' }, 'pay by 14 February, every year'],
  ] as const) test(words, () => assert.equal(billDateWords(date as BillDate), words));
});

describe('what the log says about a bill', () => {
  const said = (e: object, s: State) => describeEvent({ id: 'x', at: '2026-11-02T00:00:00Z', who: 'alice', ...e } as Event, s).what;
  test('set, cleared, removed', () => {
    const s = house();
    assert.equal(said(SET, s), 'set Example Power in Utilities to due on the 16th, every month');
    assert.equal(said({ ...SET, date: null }, s), 'cleared the date on Example Power in Utilities');
    assert.equal(said({ op: 'bill.remove', budget: 'harbor', envelope: 'util', bill: 'example water', name: 'Example Water' }, s), 'removed the bill Example Water from Utilities');
  });
  test('scope is budgets', () => {
    assert.equal(scopeOf({ op: 'bill.set' } as Event), 'budgets');
    assert.equal(scopeOf({ op: 'bill.remove' } as Event), 'budgets');
  });
});

describe('a backup holding bills', () => {
  test('the restore preview knows the ops, and a restore brings the bills', async () => {
    const hh = new Households(await mkdtemp(join(tmpdir(), 'bills-')));
    const { store } = await hh.create('alice', 'Home');
    const [, ...rest] = houseEvents([], [
      ev(SET),
      ev({ ...SET, bill: 'example water', name: 'Example Water', byHand: true }),
      ev({ op: 'bill.remove', budget: 'harbor', envelope: 'util', bill: 'example water', name: 'Example Water' }),
      ev({ ...SET, date: { kind: 'autopay', per: 'month', day: 3 } }),
    ]);
    await store.append('alice', rest.map(({ id, at, who, ...body }) => body) as never);
    const backup = parseBackup(await readFile(store.path, 'utf8'));
    assert.deepEqual([backup.unknown, backup.skipped, newerBackup(backup)], [[], [], null]);
    const { store: fresh } = await hh.create('bob', 'Fresh');
    const plan = planRestore(fresh.state, backup, ['facts', 'budgets']);
    assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);
    await fresh.adopt(eventsToApply(plan));
    assert.equal(bills(store.state).length, 1);
    assert.deepEqual([...fresh.state.budgets.get('harbor')!.bills.values()], [...store.state.budgets.get('harbor')!.bills.values()]);
  });
});

describe('billKey is frozen', () => {
  for (const [payee, key] of [
    ['EXAMPLE POWER BILLP 8842193', 'example power billp'], ['EXAMPLE MKTPL*1A2B3C4D5', 'example mktpl'],
    ['EXAMPLE WATER #4471', 'example water'], ['  Example   Power ', 'example power'],
    ['ACH 123-456 PAYMENT', 'ach payment'], ['STORE 12', 'store 12'],
    ['EXAMPLE MUTUAL INSURANCE AUTO PREMIUM', 'example mutual insurance'],
    ['EXAMPLE POWER COMPANY OF THE VALLEY', 'example power company of'],
    ['#12345', ''], ['1234', ''], ['', ''],
  ] as const) test(JSON.stringify(payee), () => assert.equal(billKey(payee), key));
  test('it does not call the general normaliser', () => {
    const src = readFileSync(new URL('../src/analytics.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function billKey'), src.indexOf('\n}\n', src.indexOf('export function billKey')));
    assert.equal(body.includes('normalisePayee'), false);
  });
});

const list = (s: State, envelope: string, opts?: Parameters<typeof billsOf>[2]) => billsOf(s, 'harbor', opts).get(envelope) ?? [];

describe("an envelope's bills", () => {
  test('a fixed charge that landed here is a bill', () => {
    const [b, ...rest] = list(house(POWER), 'util');
    assert.deepEqual(rest, []);
    assert.deepEqual([b!.key, b!.name, b!.byHand, b!.date, b!.since, b!.about, b!.lastPaid?.day, b!.receipts.length],
      ['example power billp', 'EXAMPLE POWER BILLP', false, null, null, 14600, '2026-10-14', 3]);
    assert.equal(fixedCharges(house(POWER))[0]!.lastDate, '2026-10-14');
  });
  test('every live envelope has an entry, one with nothing funded listing its bills', () => {
    const gas = ['2026-09-09', '2026-10-09'].map((d) => pay(`g${d}`, d, 'EXAMPLE GAS CO', '-50.00', 'gas'));
    const s = house(gas);
    assert.deepEqual([...billsOf(s, 'harbor').keys()].sort(), ['daily', 'heat', 'roof', 'util']);
    assert.equal(list(s, 'heat')[0]!.about, 5000);
  });
  test('an unknown budget gives an empty map', () => assert.equal(billsOf(house(POWER), 'nope').size, 0));
  test('dated first, then by name', () => {
    const s = house(POWER, [
      ev({ ...SET, bill: 'zed', name: 'Zed', byHand: true }),
      ev({ ...SET, bill: 'abel', name: 'Abel', byHand: true, date: null }),
      ev(SET),
    ]);
    const t = house(POWER, [ev({ ...SET, bill: 'zed', name: 'Zed', byHand: true }), ev({ ...SET, bill: 'abel', name: 'Abel', byHand: true, date: null })]);
    assert.deepEqual(list(t, 'util').map((b) => b.name), ['Zed', 'Abel', 'EXAMPLE POWER BILLP']);
  });
  test('a bill named by hand takes a payee that contains it; its name stays', () => {
    const water = ['2026-09-30', '2026-10-30'].map((d) => pay(`w${d}`, d, 'EXAMPLE WATER #4471', '-48.00', 'water'));
    const s = house(water, [ev({ ...SET, bill: 'water', name: 'The water', byHand: true })]);
    assert.deepEqual(list(s, 'util').map((b) => [b.key, b.name, b.about, b.receipts.length]), [['water', 'The water', 4800, 2]]);
  });
  test('seen once, it has a date and no figure', () => {
    const s = house([pay('o', '2026-10-02', 'EXAMPLE WATER', '-48.00', 'water')], [ev({ ...SET, bill: 'example water', name: 'EXAMPLE WATER' })]);
    assert.deepEqual(list(s, 'util').map((b) => [b.about, b.lastPaid?.day]), [[null, '2026-10-02']]);
  });
  test('two fixed charges of one payee in one envelope are one bill, charge by charge', () => {
    const s = house([...['2026-09-05', '2026-10-05'].map((d) => pay(`a${d}`, d, 'P2P PAYMENT', '-100.00', 'elec')),
                     ...['2026-09-12', '2026-10-12'].map((d) => pay(`b${d}`, d, 'P2P PAYMENT', '-60.00', 'water'))]);
    const [b, ...rest] = list(s, 'util');
    assert.deepEqual([rest.length, b!.about, b!.charges.map((c) => c.typical).sort()], [0, 16000, [10000, 6000].sort()]);
  });
  test('a refund lands but is no receipt', () => {
    const s = house([...POWER, pay('r', '2026-11-03', 'EXAMPLE POWER BILLP', '12.40', 'elec')]);
    const b = list(s, 'util')[0]!;
    assert.deepEqual([b.receipts.length, b.lastPaid?.day, b.charges[0]!.landed.has('2026-11')], [3, '2026-10-14', true]);
  });
  test('a split part is a receipt for its share', () => {
    const one = pay('sp', '2026-11-02', 'EXAMPLE POWER BILLP', '-146.00', 'elec');
    const cut = ev({ op: 'txn.split', txn: 'sp', parts: [{ category: 'elec', amount: parseDollars('-100.00') }, { category: 'groceries', amount: parseDollars('-46.00') }] });
    const b = list(house([...POWER, one], [cut]), 'util')[0]!;
    assert.deepEqual([b.receipts.length, b.lastPaid?.amount, b.charges[0]!.landed.has('2026-11')], [4, 10000, true]);
  });
  test('a receipt goes to the longest key it contains', () => {
    const rows = ['2026-09-30', '2026-10-30'].map((d) => pay(`w${d}`, d, 'EXAMPLE WATER #4471', '-48.00', 'water'));
    const d = { kind: 'due', per: 'month', day: 20 } as const;
    const s = house(rows, [ev({ ...SET, bill: 'example', name: 'Example', byHand: true, date: d }), ev({ ...SET, bill: 'example water', name: 'Example Water', byHand: true, date: d })]);
    assert.deepEqual(list(s, 'util').map((b) => [b.key, b.receipts.length]).sort((x, y) => (x[0]! < y[0]! ? -1 : 1)), [['example', 0], ['example water', 2]]);
  });
  test("an all-digit payee is nobody's bill", () => {
    const s = house(['2026-09-04', '2026-10-04'].map((d) => pay(`n${d}`, d, '1234', '-30.00', 'water')));
    assert.deepEqual(list(s, 'util'), []);
  });
  test('the same receipts are listed under each live budget, each with its own date', () => {
    const second = [
      ev({ op: 'budget.create', budget: 'other', label: 'Other' }),
      ev({ op: 'envelope.define', budget: 'other', envelope: 'power', label: 'Power', group: 'House', match: { categories: ['elec'] }, template: parseDollars('100.00'), rollover: false, order: 0 } as never),
      ev({ op: 'month.open', budget: 'other', month: '2026-11', income: parseDollars('1000.00') }),
    ];
    const s = house(POWER, [...second, ev(SET)]);
    const mine = list(s, 'util')[0]!;
    const theirs = billsOf(s, 'other').get('power')![0]!;
    assert.deepEqual([mine.key, theirs.key, mine.date, theirs.date, theirs.receipts.length], ['example power billp', 'example power billp', SET.date, null, 3]);
  });
});

describe('a date a member set is never orphaned', () => {
  const dated = () => [ev(SET)];
  const date = (s: State, env: string) => list(s, env).find((b) => b.key === 'example power billp')?.date;
  const sortAll = (cat: string) => POWER.map((t) => ev({ op: 'txn.categorize', txn: t.id, category: cat }));
  test('re-sorted to another category of its envelope, nothing changes', () => {
    assert.deepEqual(date(house(POWER, [...dated(), ...sortAll('water')]), 'util'), SET.date);
  });
  test('re-sorted into another envelope, it follows; back, it comes home', () => {
    const away = house(POWER, [...dated(), ...sortAll('groceries')]);
    assert.deepEqual([date(away, 'daily'), date(away, 'util')], [SET.date, undefined]);
    assert.deepEqual(date(house(POWER, [...dated(), ...sortAll('groceries'), ...sortAll('elec')]), 'util'), SET.date);
  });
  test('it stops following once a bill.set says so', () => {
    const s = house(POWER, [...dated(), ...sortAll('groceries'), ev({ ...SET, envelope: 'daily', date: null })]);
    assert.deepEqual([date(s, 'daily'), date(s, 'util')], [null, SET.date]);
  });
  test('it does not follow into a savings envelope', () => {
    const s = house(POWER, [...dated(), ...sortAll('roofing')]);
    assert.deepEqual([date(s, 'util'), date(s, 'roof')], [SET.date, null]);
  });
  test('whatever the general normaliser finds, the date still shows', () => {
    assert.deepEqual(list(house(POWER, dated()), 'util', { fixed: [] }).map((b) => [b.key, b.date, b.receipts.length]), [['example power billp', SET.date, 3]]);
  });
  test('an envelope removed takes its bill off the list; defined again, it is back', () => {
    const gone = ev({ op: 'envelope.remove', budget: 'harbor', envelope: 'util', why: 'moved' });
    assert.deepEqual(list(house(POWER, [...dated(), gone]), 'util'), []);
    const again = ev({ op: 'envelope.define', budget: 'harbor', envelope: 'util', label: 'Utilities', group: 'House', match: { categories: ['elec', 'water'] }, template: parseDollars('300.00'), rollover: false, order: 0 } as never);
    assert.deepEqual(date(house(POWER, [...dated(), gone, again]), 'util'), SET.date);
  });
});
