import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars } from '../src/money.ts';
import { calendarMoney } from '../src/calendar-money.ts';
import type { MoneyRow } from '../src/calendar-money.ts';
import { monthView } from '../src/envelopes.ts';
import type { Cents } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { replay, apply } from '../src/replay.ts';
import { billDateWords, billDatesIn, billKey, billLine, billOccurrences, billsExpected, billsOf, fixedCharges } from '../src/analytics.ts';
import { describe as describeEvent, APPROVE_IN_ONE, ProposalStore, commit, toolByName, toolSchemas } from '../src/tools.ts';
import type { Proposal, ToolContext } from '../src/tools.ts';
import { newerBackup, parseBackup, planRestore, eventsToApply, scopeOf } from '../src/restore.ts';
import { Households } from '../src/households.ts';
import { changes } from '../src/activity.ts';
import type { Bill, BillPaid } from '../src/analytics.ts';
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

describe('the dates a bill falls on', () => {
  const month = (day: number) => ({ kind: 'due', per: 'month', day }) as BillDate;
  const every = (per: 'quarter' | 'half-year' | 'year', on: string) => ({ kind: 'due', per, on }) as BillDate;
  test('held to the last day of a short month', () =>
    assert.deepEqual(billDatesIn(month(31), '2026-02-01', '2026-04-30'), ['2026-02-28', '2026-03-31', '2026-04-30']));
  test('a quarter either side, the holding never carried forward', () =>
    assert.deepEqual(billDatesIn(every('quarter', '2026-01-31'), '2025-10-01', '2026-10-31'), ['2025-10-31', '2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']));
  test('six months, a year, 29 February', () => {
    assert.deepEqual(billDatesIn(every('half-year', '2026-02-14'), '2025-08-01', '2026-08-31'), ['2025-08-14', '2026-02-14', '2026-08-14']);
    assert.deepEqual(billDatesIn(every('year', '2024-02-29'), '2026-01-01', '2028-12-31'), ['2026-02-28', '2027-02-28', '2028-02-29']);
  });
});

describe('what pays a date', () => {
  const dated = (date: BillDate, txns: Txn[]) => list(house(txns, [ev({ ...SET, date })]), 'util')[0]!;
  const monthly = (day: number) => ({ kind: 'due', per: 'month', day }) as BillDate;
  const at = (id: string, day: string) => pay(id, day, 'EXAMPLE POWER BILLP', '-146.00', 'elec');
  const paidBy = (b: Bill, from: string, to: string) => billOccurrences(b, from, to).map((o) => [o.day, o.paid?.day ?? null]);

  test('the nearest date, across the edge of a month', () =>
    assert.deepEqual(paidBy(dated(monthly(1), [at('a', '2026-10-31')]), '2026-10-01', '2026-11-30'), [['2026-10-01', null], ['2026-11-01', '2026-10-31']]));
  test('the earlier on a tie', () =>
    assert.deepEqual(paidBy(dated(monthly(1), [at('a', '2026-11-16')]), '2026-11-01', '2026-12-01'), [['2026-11-01', '2026-11-16'], ['2026-12-01', null]]));
  test('the first to do so is the payment; a second does not pay the next', () =>
    assert.deepEqual(paidBy(dated(monthly(16), [at('a', '2026-11-10'), at('b', '2026-11-20')]), '2026-11-01', '2026-12-31'), [['2026-11-16', '2026-11-10'], ['2026-12-16', null]]));
  test('a window holding only the receipt finds the occurrence it paid', () =>
    assert.deepEqual(paidBy(dated(monthly(1), [at('a', '2026-10-31')]), '2026-10-31', '2026-10-31'), [['2026-11-01', '2026-10-31']]));
  test('a refund pays nothing', () =>
    assert.deepEqual(paidBy(dated(monthly(16), [pay('r', '2026-11-15', 'EXAMPLE POWER BILLP', '12.40', 'elec')]), '2026-11-01', '2026-11-30'), [['2026-11-16', null]]));
  test('a quarterly date has nothing between its dates', () => {
    const b = dated({ kind: 'due', per: 'quarter', on: '2026-08-14' }, POWER);
    assert.deepEqual(billOccurrences(b, '2026-11-01', '2026-11-30').map((o) => o.day), ['2026-11-14']);
    assert.deepEqual(billOccurrences(b, '2026-12-01', '2026-12-31'), []);
  });
  test("undated: a receipt in the month pays it; unpaid sits on the last receipt's day, held to the month", () => {
    const b = list(house([...POWER, at('n', '2026-11-30')]), 'util')[0]!;
    assert.deepEqual(billOccurrences(b, '2026-11-01', '2027-02-28').map((o) => [o.month, o.dated, o.day, o.paid?.day ?? null, o.about]),
      [['2026-11', false, '2026-11-30', '2026-11-30', null], ['2026-12', false, '2026-12-30', null, 14600],
       ['2027-01', false, '2027-01-30', null, 14600], ['2027-02', false, '2027-02-28', null, 14600]]);
  });
  test('undated: the first receipt of the month is the payment', () => {
    const b = list(house([at('n', '2026-11-20'), at('m', '2026-11-21')], [ev({ ...SET, date: null })]), 'util')[0]!;
    assert.deepEqual(billOccurrences(b, '2026-11-01', '2026-11-30').map((o) => [o.day, o.paid?.day]), [['2026-11-21', '2026-11-20']]);
  });
  test('undated with charges partly landed is not paid, and expects the rest', () => {
    const p2p = (d: string, cat: string, amt: string) => pay(`${cat}${d}`, d, 'EXAMPLE P2P', amt, cat);
    const txns = ['2026-08-05', '2026-09-05', '2026-10-05'].flatMap((d) => [p2p(d, 'elec', '-100.00'), p2p(d, 'water', '-60.00')]);
    const b = list(house([...txns, p2p('2026-11-05', 'elec', '-100.00')]), 'util')[0]!;
    assert.equal(b.charges.length, 2);
    const [o, ...rest] = billOccurrences(b, '2026-11-01', '2026-11-30');
    assert.deepEqual(rest, []);
    assert.deepEqual([o!.paid, o!.about], [null, 6000]);
  });
  test('undated with only a refund this month: no occurrence', () => {
    assert.deepEqual(billOccurrences(list(house([...POWER, pay('r', '2026-11-03', 'EXAMPLE POWER BILLP', '12.40', 'elec')]), 'util')[0]!, '2026-11-01', '2026-11-30'), []);
  });
});

describe('what a month still expects', () => {
  const month = '2026-11';
  const b = (s: State) => list(s, 'util');
  const with_ = (date: BillDate, txns = POWER) => b(house(txns, [ev({ ...SET, date })]));
  test('undated: every month, as now', () => assert.equal(billsExpected(b(house(POWER)), month), 14600));
  test('undated, landed: nothing', () => assert.equal(billsExpected(b(house([...POWER, pay('n', '2026-11-03', 'EXAMPLE POWER BILLP', '-146.00', 'elec')])), month), 0));
  test('dated monthly and unpaid: its typical', () => assert.equal(billsExpected(with_({ kind: 'due', per: 'month', day: 16 }), month), 14600));
  test('dated, paid by a receipt last month: nothing, then the next', () => {
    const edge = ['2026-08-31', '2026-09-30', '2026-10-31'].map((d) => pay(`x${d}`, d, 'EXAMPLE POWER BILLP', '-146.00', 'elec'));
    const d = with_({ kind: 'due', per: 'month', day: 1 }, edge);
    assert.deepEqual([billsExpected(d, '2026-11'), billsExpected(d, '2026-12')], [0, 14600]);
  });
  test('a quarterly date counts only in a month one falls in', () => {
    const q = with_({ kind: 'due', per: 'quarter', on: '2026-08-20' }, POWER.slice(0, 2));
    assert.deepEqual([billsExpected(q, '2026-11'), billsExpected(q, '2026-12')], [14600, 0]);
  });
  test('a date with no typical amount adds nothing', () => {
    assert.equal(billsExpected(b(house([pay('o', '2026-10-02', 'EXAMPLE WATER', '-48.00', 'water')], [ev({ ...SET, bill: 'example water', name: 'X' })])), month), 0);
  });
  test('several bills add up', () => {
    const water = ['2026-09-30', '2026-10-30'].map((d) => pay(`w${d}`, d, 'EXAMPLE WATER #4471', '-48.00', 'water'));
    assert.equal(billsExpected(b(house([...POWER, ...water])), month), 14600 + 4800);
  });
});

async function ctx(txns: readonly Txn[] = POWER, more: readonly Event[] = []): Promise<ToolContext> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-bills-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date('2026-11-12T18:00:00Z') });
  await store.load();
  await store.adopt(houseEvents(txns, more));
  return { store, who: 'alice', today: '2026-11-12', proposals: new ProposalStore(), sid: null };
}
const run = (args: Record<string, unknown>, c: ToolContext) =>
  toolByName.get('set_bill')!.run({ budget: 'harbor', envelope: 'util', ...args }, c);

describe('the line a bill reads', () => {
  const b = (over: Partial<Bill>): Bill => ({ envelope: 'util', home: null, key: 'k', name: 'N', byHand: false, date: null, since: null, about: null, charges: [], receipts: [], lastPaid: null, ...over });
  const paid = { txnId: 't', day: '2026-10-14', amount: 14600, payee: 'X' } as BillPaid;
  test('what the receipts know, then its date', () => {
    assert.equal(billLine(b({ about: 14600 as Cents, lastPaid: paid, date: { kind: 'due', per: 'month', day: 16 } })), 'about $146 · last paid 14 Oct · Due on the 16th, every month');
    assert.equal(billLine(b({ lastPaid: paid, date: { kind: 'payby', per: 'year', on: '2026-02-14' } })), 'last paid 14 Oct · Pay by 14 February, every year');
    assert.equal(billLine(b({ date: { kind: 'autopay', per: 'month', day: 1 } })), 'no receipts yet · Auto Pay on the 1st, every month');
    assert.equal(billLine(b({ about: 14600 as Cents, lastPaid: paid })), 'about $146 · last paid 14 Oct');
  });
  test('a day read from a receipt is never a date word', () => {
    assert.doesNotMatch(billLine(b({ about: 14600 as Cents, lastPaid: paid })), /due|auto pay|pay by/i);
  });
});

describe('set_bill', () => {
  const d16 = { kind: 'due', per: 'month', day: 16 };
  test('from the page and from Claude: a date on a bill the receipts show', async () => {
    const c = await ctx();
    const p = run({ bill: 'example power billp', ...d16 }, c) as Proposal;
    assert.equal(p.tool, 'set_bill');
    assert.equal(p.summary, 'EXAMPLE POWER BILLP: due on the 16th, every month');
    assert.deepEqual(p.effects, ["Shows due on the 16th, every month on Utilities's page", 'No money moves']);
    assert.deepEqual(p.events, [{ op: 'bill.set', budget: 'harbor', envelope: 'util', bill: 'example power billp', name: 'EXAMPLE POWER BILLP', date: d16 }]);
    assert.equal(APPROVE_IN_ONE.has('set_bill'), true);
    assert.equal(c.store.state.budgets.get('harbor')!.bills.size, 0, 'a proposal writes nothing');
    await commit(p.id, c);
    assert.equal(c.store.state.budgets.get('harbor')!.bills.size, 1);
  });
  test('a change row reads rightly where the household reads it', async () => {
    const c = await ctx();
    await commit((run({ bill: 'example power billp', ...d16 }, c) as Proposal).id, c);
    const rows = changes(await c.store.since(null), c.store.state).filter((r) => r.events.some((e) => e.op === 'bill.set'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.what, 'set EXAMPLE POWER BILLP in Utilities to due on the 16th, every month');
  });
  test('Claude is offered it', () => assert.ok(toolSchemas().some((t) => t.name === 'set_bill')));
  test('a longer period sends on', async () => {
    const p = run({ bill: 'example power billp', kind: 'autopay', per: 'quarter', on: '2026-11-20' }, await ctx()) as Proposal;
    assert.deepEqual((p.events[0] as { date: unknown }).date, { kind: 'autopay', per: 'quarter', on: '2026-11-20' });
    assert.equal(p.summary, 'EXAMPLE POWER BILLP: Auto Pay on 20 November, every quarter');
  });
  test('a new name makes a bill by hand', async () => {
    const p = run({ name: 'Example Water ', kind: 'payby', per: 'month', day: 3 }, await ctx()) as Proposal;
    assert.deepEqual(p.events, [{ op: 'bill.set', budget: 'harbor', envelope: 'util', bill: 'example water', name: 'Example Water', byHand: true, date: { kind: 'payby', per: 'month', day: 3 } }]);
  });
  test('a name finds the bill it means', async () => {
    const p = run({ name: 'power', ...d16 }, await ctx()) as Proposal;
    assert.equal((p.events[0] as { bill: string }).bill, 'example power billp');
  });
  test('an exact key beats a looser match', async () => {
    const hand = ev({ op: 'bill.set', budget: 'harbor', envelope: 'util', bill: 'example power billp gas', name: 'Example Power Billp Gas', byHand: true, date: null });
    const p = run({ name: 'EXAMPLE POWER BILLP', ...d16 }, await ctx(POWER, [hand])) as Proposal;
    assert.equal((p.events[0] as { bill: string }).bill, 'example power billp');
  });
  test('clear and remove', async () => {
    const c = await ctx();
    await commit((run({ bill: 'example power billp', ...d16 }, c) as Proposal).id, c);
    const off = run({ bill: 'example power billp', clear: true }, c) as Proposal;
    assert.deepEqual([off.summary, off.effects], ['EXAMPLE POWER BILLP: date cleared', ['Its day comes from its last receipt again', 'No money moves']]);
    await commit((run({ name: 'Example Water', kind: 'due', per: 'month', day: 3 }, c) as Proposal).id, c);
    const gone = run({ bill: 'example water', remove: true }, c) as Proposal;
    assert.deepEqual([gone.summary, gone.effects, gone.events], ['Remove the bill Example Water', ["It leaves Utilities's page", 'No money moves'],
      [{ op: 'bill.remove', budget: 'harbor', envelope: 'util', bill: 'example water', name: 'Example Water' }]]);
  });
  test('a followed bill is written to its own record, never a second one', async () => {
    const move = POWER.map((t) => ev({ op: 'txn.categorize', txn: t.id, category: 'groceries' }));
    const c = await ctx(POWER, [ev(SET), ...move]);
    const off = run({ envelope: 'daily', bill: 'example power billp', clear: true }, c) as Proposal;
    assert.equal((off.events[0] as { envelope: string }).envelope, 'util');
    await commit(off.id, c);
    const after = billsOf(c.store.state, 'harbor');
    assert.deepEqual(after.get('util')!.map((x) => x.key), [], 'nothing left behind at home');
    assert.deepEqual(after.get('daily')!.map((x) => [x.key, x.date]), [['example power billp', null]]);
    const set = run({ envelope: 'daily', bill: 'example power billp', kind: 'due', per: 'month', day: 20 }, c) as Proposal;
    await commit(set.id, c);
    const again = billsOf(c.store.state, 'harbor');
    assert.deepEqual([again.get('util')!.length, again.get('daily')![0]!.date], [0, { kind: 'due', per: 'month', day: 20 }]);
    assert.equal(c.store.state.budgets.get('harbor')!.bills.size, 1);
  });
  test('a new name that another envelope\'s receipts hold is refused, not lost', async () => {
    const gas = ['2026-09-09', '2026-10-09'].map((d) => pay(`g${d}`, d, 'EXAMPLE GAS CO', '-50.00', 'gas'));
    const c = await ctx([...POWER, ...gas]);
    assert.throws(() => run({ name: 'Example Gas', kind: 'due', per: 'month', day: 3 }, c), /Example Gas is already a bill in Heating: set its date there/);
    assert.ok(run({ envelope: 'heat', name: 'Example Gas', kind: 'due', per: 'month', day: 3 }, c));
  });
  test('refused, each in its own words', async () => {
    const c = await ctx();
    const no = (args: Record<string, unknown>, re: RegExp) => assert.throws(() => run(args, c), re);
    no({ envelope: 'roof', name: 'Roof', ...d16 }, /a savings envelope has no bills/);
    no({ envelope: 'nope', name: 'X', ...d16 }, /no envelope nope/);
    no({ ...d16 }, /say which bill, or name a new one/);
    no({ bill: 'example power billp', kind: 'due', per: 'month' }, /a date needs its kind/);
    no({ bill: 'example power billp', kind: 'due', day: 3 }, /a date needs its kind/);
    no({ bill: 'example power billp', per: 'month', day: 3 }, /a date needs its kind/);
    no({ bill: 'example power billp', kind: 'due', per: 'quarter', day: 3 }, /a date needs its kind/);
    no({ bill: 'example power billp', kind: 'due', per: 'month', on: '2026-11-20' }, /a date needs its kind/);
    no({ bill: 'example power billp', kind: 'soon', per: 'month', day: 3 }, /a date needs its kind/);
    no({ bill: 'example power billp', kind: 'due', per: 'year', on: 'tomorrow' }, /a date needs its kind/);
    no({ bill: 'example power billp', kind: 'due', per: 'month', day: 32 }, /a day of the month is from 1 to 31/);
    no({ name: 'x'.repeat(61), ...d16 }, /60 characters at most/);
    no({ name: '1234', ...d16 }, /say the bill's name in letters/);
    no({ bill: 'no such', ...d16 }, /no bill no such in Utilities/);
    no({ bill: 'example power billp', clear: true }, /that bill has no date to clear/);
    no({ bill: 'example power billp', remove: true }, /that bill comes from the receipts: clear its date instead/);
  });
  test('a name two bills match', async () => {
    const paper = ['2026-09-20', '2026-10-20'].map((d) => pay(`pp${d}`, d, 'EXAMPLE PAPER', '-20.00', 'water'));
    const c = await ctx([...POWER, ...paper]);
    assert.throws(() => run({ name: 'example', kind: 'due', per: 'month', day: 3 }, c), /two bills match that name: say more of it/);
  });
  test('a hand-named bill the receipts have since found is not removed', async () => {
    const gas = ['2026-09-09', '2026-10-09'].map((d) => pay(`g${d}`, d, 'EXAMPLE GAS CO', '-50.00', 'elec'));
    const hand = ev({ op: 'bill.set', budget: 'harbor', envelope: 'util', bill: 'example gas', name: 'Example Gas', byHand: true, date: null });
    const c = await ctx([...POWER, ...gas], [hand]);
    assert.throws(() => run({ bill: 'example gas', remove: true }, c), /that bill comes from the receipts: clear its date instead/);
  });
});

describe("get_month's bills", () => {
  const gm = async (c: ToolContext, month = '2026-11') => toolByName.get('get_month')!.run({ budget: 'harbor', month }, c) as any;
  test('each envelope lists its bills in the words of the page', async () => {
    const out = await gm(await ctx());
    const util = out.envelopes.find((e: any) => e.id === 'util');
    assert.deepEqual(util.bills, [{ key: 'example power billp', name: 'EXAMPLE POWER BILLP', byHand: false, about: '$146', lastPaid: '2026-10-14', line: 'about $146 · last paid 14 Oct' }]);
  });
  test('a savings envelope has none, and one with nothing funded lists its own', async () => {
    const gas = ['2026-09-09', '2026-10-09'].map((d) => pay(`g${d}`, d, 'EXAMPLE GAS CO', '-50.00', 'gas'));
    const out = await gm(await ctx([...POWER, ...gas]));
    assert.deepEqual(out.envelopes.find((e: any) => e.id === 'roof').bills, []);
    assert.deepEqual(out.envelopes.find((e: any) => e.id === 'heat').bills.map((b: any) => b.line), ['about $50 · last paid 9 Oct']);
    assert.equal(out.pace.some((p: any) => p.envelope === 'heat'), false);
  });
  test('a bill with no receipts sends no about or lastPaid', async () => {
    const hand = ev({ op: 'bill.set', budget: 'harbor', envelope: 'util', bill: 'example water', name: 'Example Water', byHand: true, date: { kind: 'due', per: 'month', day: 3 } });
    const out = await gm(await ctx([], [hand]));
    const [b] = out.envelopes.find((e: any) => e.id === 'util').bills;
    assert.deepEqual(Object.keys(b).sort(), ['byHand', 'date', 'key', 'line', 'name']);
    assert.equal(b.line, 'no receipts yet · Due on the 3rd, every month');
  });
  test('a closed month lists them too', async () => {
    const out = await gm(await ctx(POWER, [ev({ op: 'month.close', budget: 'harbor', month: '2026-10', closed: true, why: 'done' })]), '2026-10');
    assert.equal(out.closed, true);
    assert.equal(out.envelopes.find((e: any) => e.id === 'util').bills.length, 1);
  });
});

describe('a bill on the calendar', () => {
  const rows = (s: State, from: string, to: string, today = '2026-11-02') => calendarMoney(s, 'harbor', { from, to, today });
  const NOV = ['2026-11-01', '2026-11-30'] as const;
  test('an undated bill sits on the day of its last receipt, in later months too, never in a month gone by unpaid', () => {
    const [r, ...rest] = rows(house(POWER), ...NOV);
    assert.deepEqual(rest, []);
    assert.deepEqual([r!.day, r!.kind, r!.label, r!.name, r!.about, r!.short], ['2026-11-14', 'bill', 'Utilities', 'EXAMPLE POWER BILLP', '$146', false]);
    assert.deepEqual(rows(house(POWER), '2026-12-01', '2026-12-31').map((x) => [x.day, x.kind]), [['2026-12-14', 'bill']]);
    assert.deepEqual(rows(house(POWER), '2026-10-01', '2026-10-31').map((x) => [x.day, x.kind, x.amount]), [['2026-10-14', 'paid', '$146.00']]);
  });
  test('a date a member set reads its kind, and says no receipt once its day has gone', () => {
    const s = house(POWER, [ev(SET)]);
    assert.deepEqual(rows(s, ...NOV).map((r) => [r.day, r.kind, r.about, r.noReceipt]), [['2026-11-16', 'due', '$146', undefined]]);
    assert.deepEqual(rows(s, ...NOV, '2026-11-20').map((r) => [r.day, r.kind, r.noReceipt]), [['2026-11-16', 'due', true]]);
  });
  test('an Auto Pay or Pay by date keeps its own kind on the calendar, never collapsed to due (0.9.2)', () => {
    for (const kind of ['autopay', 'payby'] as const) {
      const s = house(POWER, [ev({ ...SET, date: { kind, per: 'month', day: 16 } })]);
      assert.deepEqual(rows(s, ...NOV).map((r) => [r.day, r.kind, r.about]), [['2026-11-16', kind, '$146']]);
    }
  });
  test('a receipt takes the row to its own day', () => {
    const s = house([...POWER, pay('n', '2026-11-15', 'EXAMPLE POWER BILLP', '-143.20', 'elec')], [ev(SET)]);
    assert.deepEqual(rows(s, ...NOV).map((r) => [r.day, r.kind, r.amount]), [['2026-11-15', 'paid', '$143.20']]);
  });
  test('an unpaid date before it was set, in a month gone by, is not drawn', () => assert.deepEqual(rows(house([], [ev(SET)]), '2026-10-01', '2026-10-31'), []));
  test('a savings envelope has no row', () => {
    const roofing = ['2026-09-20', '2026-10-20'].map((d) => pay(`r${d}`, d, 'EXAMPLE ROOFING', '-80.00', 'roofing'));
    assert.deepEqual(rows(house(roofing), ...NOV), []);
  });
  describe('less left than its bills', () => {
    const room = (s: State) => monthView(s, 'harbor', '2026-11')!.envelopes.find((e) => e.envelope.id === 'util')!.available;
    const leaving = (cents: number) => house([...POWER, pay('w', '2026-11-01', 'EXAMPLE WATER ONE OFF', `-${((room(house(POWER)) - cents) / 100).toFixed(2)}`, 'water')]);
    test('util is funded for these tests', () => assert.ok(room(house(POWER)) >= 14600));
    test('a short row on today, first, and on the bill it is about', () => {
      const got = rows(leaving(1400), ...NOV);
      const s = got[0]!;
      assert.deepEqual([s.kind, s.day, s.left, s.over, s.about, s.bills, s.billDay, s.billKind, s.name, s.short], ['short', '2026-11-02', '$14', undefined, '$146', 1, '2026-11-14', 'bill', 'EXAMPLE POWER BILLP', true]);
      const b = got.find((r) => r.kind === 'bill')!;
      assert.deepEqual([b.short, b.left], [true, '$14']);
    });
    const anyShort = (r: readonly MoneyRow[]) => r.some((x) => x.kind === 'short');
    test('over reads over; enough left, none; no window without today; no month not open', () => {
      assert.equal(rows(leaving(-2000), ...NOV)[0]!.over, '$20');
      assert.equal(rows(leaving(0), ...NOV)[0]!.left, '$0');
      assert.equal(anyShort(rows(house(POWER), ...NOV)), false);
      assert.equal(anyShort(rows(leaving(1400), '2026-11-08', '2026-11-30')), false);
      assert.equal(anyShort(rows(leaving(1400), '2026-12-01', '2026-12-31', '2026-12-05')), false);
    });
    test('one still without a figure is never short', () => {
      const gas = ['2026-09-09', '2026-10-09'].map((d) => pay(`g${d}`, d, 'EXAMPLE GAS CO', '-50.00', 'gas'));
      // houseEvents defines heat with no needsFigure; defined again here with it, so no other test's figures move.
      const noFigure = house(gas, [envelope('heat', 'Heating', ['gas'], '0.00', 2, { needsFigure: true })]);
      assert.equal(monthView(noFigure, 'harbor', '2026-11')!.envelopes.find((e) => e.envelope.id === 'heat')!.envelope.needsFigure, true, 'heat has no figure yet');
      assert.equal(anyShort(rows(noFigure, ...NOV)), false);
    });
  });
});
