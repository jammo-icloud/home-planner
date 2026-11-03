import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars, fmt, ZERO } from '../src/money.ts';
import { replay, apply } from '../src/replay.ts';
import { monthView } from '../src/envelopes.ts';
import { monthClock, pace, fixedCharges, drift, recurring, unsorted, donors, snapshot, normalisePayee, lowEnvelopes } from '../src/analytics.ts';
import type { Pace } from '../src/analytics.ts';
import { Store } from '../src/store.ts';
import { TRANSFER, INCOME } from '../src/types.ts';
import type { Event, State, Txn } from '../src/types.ts';
import type { DistributiveOmit } from '../src/util-types.ts';

let n = 0;
const ev = (b: DistributiveOmit<Event, 'id' | 'at' | 'who'>, who = 'alice', at = '2026-08-01T00:00:00Z'): Event =>
  ({ id: `e${++n}`, at, who, ...b }) as Event;

const base = (months: string[] = ['2026-08']) => replay([
  ev({ op: 'category.define', category: 'groceries', label: 'Groceries' }),
  ev({ op: 'category.define', category: 'dining', label: 'Dining out' }),
  ev({ op: 'category.define', category: 'subs', label: 'Subscriptions' }),
  ev({ op: 'budget.create', budget: 'harbor', label: 'Harbor' }),
  ev({ op: 'envelope.define', budget: 'harbor', envelope: 'food', label: 'Groceries', group: 'People',
       match: { categories: ['groceries'] }, template: parseDollars('1200.00'), rollover: false, order: 0 }),
  ev({ op: 'envelope.define', budget: 'harbor', envelope: 'dine', label: 'Dining out', group: 'People',
       match: { categories: ['dining'] }, template: parseDollars('325.00'), rollover: false, order: 1 }),
  ev({ op: 'envelope.define', budget: 'harbor', envelope: 'subs', label: 'Subscriptions', group: 'People',
       match: { categories: ['subs'] }, template: parseDollars('200.00'), rollover: false, order: 2 }),
  ...months.map((m) => ev({ op: 'month.open', budget: 'harbor', month: m, income: parseDollars('9600.00') })),
]);

describe('the month clock', () => {
  test('elapsed drives every projection', () => {
    const c = monthClock('2026-08', '2026-08-13');
    assert.equal(c.daysInMonth, 31);
    assert.equal(c.dayOfMonth, 13);
    assert.ok(Math.abs(c.elapsed - 13 / 31) < 1e-9);
    assert.equal(c.complete, false);
  });

  test('February and past months are handled', () => {
    assert.equal(monthClock('2026-02', '2026-02-28').daysInMonth, 28);
    const past = monthClock('2026-07', '2026-08-13');
    assert.ok(past.complete);
    assert.equal(past.elapsed, 1);
  });
});

describe('pace', () => {
  const spent = (amount: string, day: string, category: string) =>
    ({ id: `t${amount}${day}`, date: `2026-08-${day}`, payee: 'X', amount: parseDollars(amount),
       dedupeKey: `k${amount}${day}`, category });

  test('projects to month end at the current rate', () => {
    const s = apply(base(), [ev({ op: 'txn.add', txns: [spent('-600.00', '10', 'groceries')] })]);
    const v = monthView(s, 'harbor', '2026-08')!;
    const p = pace(v, monthClock('2026-08', '2026-08-10'), s).find((x) => x.envelope === 'food')!;
    // $600 in 10 of 31 days projects to $1,860 against $1,200 funded
    assert.equal(p.projected, parseDollars('1860.00'));
    assert.equal(p.projectedOver, parseDollars('660.00'));
    assert.equal(p.status, 'projected-over');
  });

  test('already-overspent outranks merely projected-over', () => {
    const s = apply(base(), [ev({ op: 'txn.add', txns: [
      spent('-421.00', '05', 'dining'),      // over its $325 already
      spent('-600.00', '05', 'groceries'),   // only projected over
    ] })]);
    const ranked = pace(monthView(s, 'harbor', '2026-08')!, monthClock('2026-08', '2026-08-05'), s);
    assert.equal(ranked[0]!.envelope, 'dine');
    assert.equal(ranked[0]!.status, 'over');
    assert.equal(ranked[1]!.status, 'projected-over');
  });

  test('untouched, unfunded envelopes are left out as noise', () => {
    const s = base();
    const ids = pace(monthView(s, 'harbor', '2026-08')!, monthClock('2026-08', '2026-08-13'), s).map((p) => p.envelope);
    assert.deepEqual(ids.sort(), ['dine', 'food', 'subs'], 'funded envelopes still appear');

    const empty = replay([
      ev({ op: 'budget.create', budget: 'b', label: 'B' }),
      ev({ op: 'category.define', category: 'c', label: 'C' }),
      ev({ op: 'envelope.define', budget: 'b', envelope: 'e', label: 'E', group: 'g',
           match: { categories: ['c'] }, template: ZERO }),
      ev({ op: 'month.open', budget: 'b', month: '2026-08', income: ZERO }),
    ]);
    assert.equal(pace(monthView(empty, 'b', '2026-08')!, monthClock('2026-08', '2026-08-13'), empty).length, 0);
  });

  test('a finished month reports actuals, not a projection', () => {
    const s = apply(base(['2026-07']), [ev({ op: 'txn.add', txns: [
      { id: 'j', date: '2026-07-15', payee: 'X', amount: parseDollars('-900.00'), dedupeKey: 'j', category: 'groceries' },
    ] })]);
    const p = pace(monthView(s, 'harbor', '2026-07')!, monthClock('2026-07', '2026-08-13'), s).find((x) => x.envelope === 'food')!;
    assert.equal(p.projected, parseDollars('900.00'));
  });
});

describe('fixed monthly charges are not extrapolated', () => {
  /**
   * June and July are history, August is the month under test. A charge needs
   * to have billed once in each of two prior months before it counts as fixed,
   * and the envelopes have to exist before a month opens or the plan snapshots
   * as zero.
   */
  const house = (august: Txn[]) => replay([
    ev({ op: 'category.define', category: 'groceries', label: 'Groceries' }),
    ev({ op: 'category.define', category: 'rent', label: 'Rent' }),
    ev({ op: 'category.define', category: 'elec', label: 'Electricity' }),
    ev({ op: 'budget.create', budget: 'harbor', label: 'Harbor' }),
    ev({ op: 'envelope.define', budget: 'harbor', envelope: 'food', label: 'Groceries', group: 'People',
         match: { categories: ['groceries'] }, template: parseDollars('1200.00'), rollover: false, order: 0 }),
    ev({ op: 'envelope.define', budget: 'harbor', envelope: 'carry', label: 'Home carrying', group: 'House',
         match: { categories: ['rent'] }, template: parseDollars('2500.00'), rollover: false, order: 1 }),
    ev({ op: 'envelope.define', budget: 'harbor', envelope: 'util', label: 'Utilities', group: 'House',
         match: { categories: ['elec'] }, template: parseDollars('300.00'), rollover: false, order: 2 }),
    ...['2026-06', '2026-07', '2026-08'].map((m) =>
      ev({ op: 'month.open', budget: 'harbor', month: m, income: parseDollars('9600.00') })),
    ev({ op: 'txn.add', txns: [
      { id: 'r6', date: '2026-06-05', payee: 'P2P PAYMENT', amount: parseDollars('-2500.00'), dedupeKey: 'r6', category: 'rent' },
      { id: 'r7', date: '2026-07-05', payee: 'P2P PAYMENT', amount: parseDollars('-2500.00'), dedupeKey: 'r7', category: 'rent' },
      { id: 'e6', date: '2026-06-02', payee: 'EXAMPLE POWER BILLP', amount: parseDollars('-200.00'), dedupeKey: 'e6', category: 'elec' },
      { id: 'e7', date: '2026-07-02', payee: 'EXAMPLE POWER BILLP', amount: parseDollars('-200.00'), dedupeKey: 'e7', category: 'elec' },
      ...august,
    ] }),
  ]);

  const AUG_RENT: Txn = { id: 'r8', date: '2026-08-02', payee: 'P2P PAYMENT',
    amount: parseDollars('-2500.00'), dedupeKey: 'r8', category: 'rent' };
  const at = (s: State, day: string, envelope: string) =>
    pace(monthView(s, 'harbor', '2026-08')!, monthClock('2026-08', day), s).find((x) => x.envelope === envelope)!;

  test('rent paid on the 2nd does not project fifteen months of rent', () => {
    const p = at(house([AUG_RENT]), '2026-08-12', 'carry');
    // The straight line said $38,750 by month end. It is $2,500, because rent
    // is rent — paying it early does not mean paying it again.
    assert.equal(p.projected, parseDollars('2500.00'));
    assert.equal(p.committed, parseDollars('2500.00'));
    assert.equal(p.discretionary, ZERO);
    assert.equal(p.status, 'ok');
  });

  test('a bill that has not arrived yet is counted anyway', () => {
    // Nothing has hit Utilities this month. The old projection said $0 and
    // called it fine, right up until the bill landed on the 25th.
    const p = at(house([AUG_RENT]), '2026-08-12', 'util');
    assert.equal(p.spent, ZERO);
    assert.equal(p.stillExpected, parseDollars('200.00'));
    assert.equal(p.projected, parseDollars('200.00'));
  });

  test('the bill stops being expected once it lands', () => {
    const p = at(house([AUG_RENT, { id: 'e8', date: '2026-08-03', payee: 'EXAMPLE POWER BILLP',
      amount: parseDollars('-245.00'), dedupeKey: 'e8', category: 'elec' }]), '2026-08-12', 'util');
    assert.equal(p.stillExpected, ZERO, 'a bill must never be counted twice');
    assert.equal(p.projected, parseDollars('245.00'));
  });

  test('an unpaid bill still counts on the last day of the month', () => {
    const p = at(house([AUG_RENT]), '2026-08-31', 'util');
    assert.equal(p.stillExpected, ZERO, 'the month is over — nothing more is coming');
    assert.equal(p.projected, ZERO);
  });

  test('groceries still extrapolate, because groceries genuinely vary', () => {
    const p = at(house([
      { id: 'g1', date: '2026-08-03', payee: 'VALLEY MARKET', amount: parseDollars('-300.00'), dedupeKey: 'g1', category: 'groceries' },
      { id: 'g2', date: '2026-08-07', payee: 'HILLSIDE FARM', amount: parseDollars('-300.00'), dedupeKey: 'g2', category: 'groceries' },
    ]), '2026-08-10', 'food');
    assert.equal(p.committed, ZERO);
    assert.equal(p.discretionary, parseDollars('600.00'));
    assert.equal(p.projected, parseDollars('1860.00'), '$600 in 10 of 31 days');
  });

  test('a bill only counts against the envelope that actually gets it', () => {
    const s = house([AUG_RENT]);
    assert.equal(at(s, '2026-08-12', 'food').stillExpected, ZERO);
    assert.equal(at(s, '2026-08-12', 'carry').stillExpected, ZERO, 'rent already landed');
    assert.equal(at(s, '2026-08-12', 'util').stillExpected, parseDollars('200.00'));
  });

  test('a payee that bills twice in a month is not treated as fixed', () => {
    // Two charges in one month disqualifies it: a merchant that can bill twice
    // tells you nothing certain about the month's total, so the straight line
    // is the honest answer. Wrongly trusting one would suppress a real warning.
    const s = house([
      { id: 'c6', date: '2026-06-04', payee: 'BIGBOX WHOLESALE', amount: parseDollars('-200.00'), dedupeKey: 'c6', category: 'groceries' },
      { id: 'c6b', date: '2026-06-19', payee: 'BIGBOX WHOLESALE', amount: parseDollars('-200.00'), dedupeKey: 'c6b', category: 'groceries' },
      { id: 'c7', date: '2026-07-04', payee: 'BIGBOX WHOLESALE', amount: parseDollars('-200.00'), dedupeKey: 'c7', category: 'groceries' },
      { id: 'c8', date: '2026-08-04', payee: 'BIGBOX WHOLESALE', amount: parseDollars('-200.00'), dedupeKey: 'c8', category: 'groceries' },
    ]);
    assert.equal(fixedCharges(s).some((f) => f.payee.includes('BIGBOX')), false);
    const p = at(s, '2026-08-08', 'food');
    assert.equal(p.discretionary, parseDollars('200.00'));
    assert.equal(p.projected, parseDollars('775.00'), '$200 in 8 of 31 days');
  });

  test('an envelope of nothing but fixed bills is never put on watch', () => {
    // It sits at exactly 100% of plan the moment rent clears, every month.
    // Warning about that would train them to ignore the warning.
    const p = at(house([AUG_RENT]), '2026-08-12', 'carry');
    assert.equal(p.spent, p.funded, 'fully spent');
    assert.equal(p.status, 'ok');
  });

  test('an envelope that varies is still put on watch', () => {
    const p = at(house([
      { id: 'g1', date: '2026-08-02', payee: 'VALLEY MARKET', amount: parseDollars('-400.00'), dedupeKey: 'g1', category: 'groceries' },
    ]), '2026-08-12', 'food');
    assert.equal(p.status, 'watch', '$400 by day 12 projects $1,033 against $1,200');
    assert.ok(p.projectedOver < 0, 'not over yet — that is what watch means');
  });

  test('money earmarked for a bill that has not arrived is not offered as spare', () => {
    // Utilities has $300 funded and nothing spent, so it used to look like $300
    // of free money — right up to the power bill landing on the 25th.
    const s = house([AUG_RENT]);
    const list = donors(monthView(s, 'harbor', '2026-08')!, monthClock('2026-08', '2026-08-12'), 'food', s);
    const util = list.find((d) => d.envelope === 'util')!;
    assert.equal(util.available, parseDollars('300.00'));
    assert.equal(util.spare, parseDollars('100.00'), 'only what is left after the expected bill');
  });

  test('a descriptor the bank reuses for two things is still two things', () => {
    // Rent and a small Zelle payment both arrive as "P2P PAYMENT". Keyed on the
    // descriptor alone, the second one makes July look double-billed and rent
    // starts extrapolating again — as it would in any made-up month the moment
    // that $60 is categorised.
    const s = house([AUG_RENT,
      { id: 'z7', date: '2026-07-12', payee: 'P2P PAYMENT', amount: parseDollars('-60.00'), dedupeKey: 'z7', category: 'groceries' },
    ]);
    assert.equal(fixedCharges(s).some((f) => f.payee === 'P2P PAYMENT' && f.category === 'rent'), true);
    assert.equal(at(s, '2026-08-12', 'carry').projected, parseDollars('2500.00'));
  });

  test('a lumpy sinking cost is not extrapolated from one bill', () => {
    // Tyres arrive as a set, not a twelfth of a set a month. Straight-lining a
    // $900 bill paid on the 3rd projects $9,300 of tyres and cries wolf on the
    // one envelope that is deliberately saving up for exactly this.
    const s = apply(house([AUG_RENT]), [
      ev({ op: 'category.define', category: 'vupkeep', label: 'Tolls, registration & upkeep', kind: 'People',
           sinking: { cost: parseDollars('3000.00'), everyYears: 1 } }),
      ev({ op: 'envelope.define', budget: 'harbor', envelope: 'veh', label: 'Vehicles', group: 'People',
           match: { categories: ['vupkeep'] }, template: parseDollars('250.00'), order: 5 }),
      ev({ op: 'month.open', budget: 'harbor', month: '2026-09', income: parseDollars('9600.00') }),
      ev({ op: 'txn.add', txns: [
        { id: 'v1', date: '2026-09-03', payee: 'MAIN ST TIRE', amount: parseDollars('-900.00'), dedupeKey: 'v1', category: 'vupkeep' },
      ] }),
    ]);
    const p = pace(monthView(s, 'harbor', '2026-09')!, monthClock('2026-09', '2026-09-09'), s)
      .find((x) => x.envelope === 'veh')!;

    assert.equal(p.committed, parseDollars('900.00'));
    assert.equal(p.discretionary, ZERO);
    assert.equal(p.projected, parseDollars('900.00'), 'the bill, not thirty of them');
  });

  test('rent and the power bill are what a fixed charge means', () => {
    assert.deepEqual(
      fixedCharges(house([AUG_RENT])).map((f) => [f.payee, f.category, fmt(f.typical)]),
      [['P2P PAYMENT', 'rent', '$2,500'], ['EXAMPLE POWER BILLP', 'elec', '$200']],
    );
  });
});

describe('plan drift', () => {
  test('catches an envelope topped up month after month', () => {
    // three months, each planned at $325 and each topped up
    const s = apply(base(['2026-06', '2026-07', '2026-08']), [
      ev({ op: 'move', budget: 'harbor', month: '2026-06', from: 'food', to: 'dine',
           amount: parseDollars('96.00'), why: 'dinner out' }),
      ev({ op: 'move', budget: 'harbor', month: '2026-07', from: 'food', to: 'dine',
           amount: parseDollars('65.00'), why: 'birthday' }),
      ev({ op: 'move', budget: 'harbor', month: '2026-08', from: 'food', to: 'dine',
           amount: parseDollars('83.00'), why: 'Nguyen' }),
    ]);
    const d = drift(s, 'harbor', '2026-08', 3);
    const dine = d.find((x) => x.envelope === 'dine')!;

    assert.equal(dine.toppedUp, 3, 'three months running');
    assert.equal(dine.averagePlanned, parseDollars('325.00'), 'the plan never moved');
    // (421 + 390 + 408) / 3
    assert.equal(dine.averageFunded, parseDollars('406.33'));
    assert.equal(d[0]!.envelope, 'dine', 'and it sorts to the top');
  });

  test('an untouched envelope shows no drift', () => {
    const d = drift(base(['2026-07', '2026-08']), 'harbor', '2026-08', 3);
    assert.ok(d.every((x) => x.toppedUp === 0));
  });

  test('only looks back over months that were actually opened', () => {
    const d = drift(base(['2026-08']), 'harbor', '2026-08', 6);
    assert.equal(d[0]!.months.length, 1);
  });
});

describe('recurring merchants', () => {
  const sub = (month: string, amount: string, payee = 'STREAMCO SUBSCRI 4829') =>
    ({ id: `${payee}${month}`, date: `${month}-14`, payee, amount: parseDollars(amount),
       dedupeKey: `${payee}${month}`, category: null });

  test('finds a steady charge across three months with no rule', () => {
    const s = apply(base(), [ev({ op: 'txn.add', txns: [
      sub('2026-06', '-25.10'), sub('2026-07', '-25.10'), sub('2026-08', '-25.10'),
    ] })]);
    const r = recurring(s);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.months.length, 3);
    assert.equal(r[0]!.typical, parseDollars('25.10'));
    assert.ok(r[0]!.unruled, 'and it is flagged as uncovered');
  });

  test('a merchant already covered by a rule is not flagged', () => {
    const s = apply(base(), [
      ev({ op: 'rule.add', rule: 'r1', match: 'STREAMCO', category: 'subs' }),
      ev({ op: 'txn.add', txns: [sub('2026-06', '-25.10'), sub('2026-07', '-25.10'), sub('2026-08', '-25.10')] }),
    ]);
    assert.equal(recurring(s)[0]!.unruled, false);
  });

  test('wildly varying amounts are not a subscription', () => {
    const s = apply(base(), [ev({ op: 'txn.add', txns: [
      sub('2026-06', '-25.00', 'SAFEWAY 0100'), sub('2026-07', '-180.00', 'SAFEWAY 0100'), sub('2026-08', '-62.50', 'SAFEWAY 0100'),
    ] })]);
    assert.equal(recurring(s).length, 0);
  });

  test('reference tails are stripped so the same merchant groups', () => {
    assert.equal(normalisePayee('AMAZON MKTPL*1A2B3C4D5'), normalisePayee('AMAZON MKTPL*9Z8Y7X6W5'));
    assert.equal(normalisePayee('SAFEWAY FUEL0100 LAKESIDE OH'), normalisePayee('SAFEWAY FUEL0100 LAKESIDE OH'));
  });

  test('income is never mistaken for a subscription', () => {
    const s = apply(base(), [ev({ op: 'txn.add', txns: [
      sub('2026-06', '4100.00', 'ACH Deposit ACME CORP'),
      sub('2026-07', '4100.00', 'ACH Deposit ACME CORP'),
      sub('2026-08', '4100.00', 'ACH Deposit ACME CORP'),
    ] })]);
    assert.equal(recurring(s).length, 0);
  });
});

describe('where to pull money from', () => {
  test('ranks by what is genuinely spare, not just what has a balance', () => {
    const s = apply(base(), [ev({ op: 'txn.add', txns: [
      // subs barely touched: nearly all of it is spare
      { id: 'a', date: '2026-08-02', payee: 'NETFLIX', amount: parseDollars('-25.00'), dedupeKey: 'a', category: 'subs' },
      // groceries burning fast: balance looks healthy but it will need the money
      { id: 'b', date: '2026-08-02', payee: 'VALLEY', amount: parseDollars('-500.00'), dedupeKey: 'b', category: 'groceries' },
    ] })]);
    const v = monthView(s, 'harbor', '2026-08')!;
    const list = donors(v, monthClock('2026-08', '2026-08-05'), 'dine', s);

    const subs = list.find((d) => d.envelope === 'subs')!;
    const food = list.find((d) => d.envelope === 'food');
    assert.ok(subs.spare > 0);
    // groceries has $700 available but projects to $3,100 spend, so nothing spare
    assert.equal(food, undefined, 'a fast-burning envelope is not offered as a donor');
    assert.equal(list[0]!.envelope, 'subs');
  });

  test('the target envelope is never offered as its own donor', () => {
    const st = base();
    const v = monthView(st, 'harbor', '2026-08')!;
    assert.ok(!donors(v, monthClock('2026-08', '2026-08-05'), 'food', st).some((d) => d.envelope === 'food'));
  });
});

describe('the unsorted queue', () => {
  test('counts, totals and dates the backlog', () => {
    const s = apply(base(), [ev({ op: 'txn.add', txns: [
      { id: 'u1', date: '2026-08-09', payee: 'QUIKSTOP', amount: parseDollars('-10.15'), dedupeKey: 'u1', category: null },
      { id: 'u2', date: '2026-08-04', payee: 'EXAMPLE FINANCE', amount: parseDollars('-320.22'), dedupeKey: 'u2', category: null },
      { id: 'c1', date: '2026-08-05', payee: 'VALLEY', amount: parseDollars('-84.21'), dedupeKey: 'c1', category: 'groceries' },
      { id: 'x1', date: '2026-08-06', payee: 'PAYMENT', amount: parseDollars('-2400.50'), dedupeKey: 'x1', category: TRANSFER },
    ] })]);
    const u = unsorted(s);
    assert.equal(u.count, 2, 'categorized and transfers are not in the queue');
    assert.equal(u.outflow, parseDollars('330.37'));
    assert.equal(u.inflow, parseDollars('0'), 'an unsorted paycheque must never read as spending');
    assert.equal(u.oldest, '2026-08-04');
  });
});

describe('the briefing bundle', () => {
  test('one call answers "how are we doing"', () => {
    const s = apply(base(['2026-07', '2026-08']), [
      ev({ op: 'txn.add', txns: [
        { id: 'q', date: '2026-08-08', payee: 'VALLEY', amount: parseDollars('-900.00'), dedupeKey: 'q', category: 'groceries' },
        { id: 'z', date: '2026-08-09', payee: 'MYSTERY', amount: parseDollars('-40.00'), dedupeKey: 'z', category: null },
      ] }),
    ]);
    const snap = snapshot(s, 'harbor', '2026-08', '2026-08-13')!;
    assert.equal(snap.month, '2026-08');
    assert.equal(snap.clock.dayOfMonth, 13);
    assert.ok(snap.pace.length > 0);
    assert.equal(snap.unsorted.count, 1);
    assert.equal(snap.view.income, parseDollars('9600.00'));
    assert.equal(snap.balanced, false, 'this fixture does not balance, and says so');
  });

  test('an unopened month returns nothing rather than zeroes', () => {
    assert.equal(snapshot(base(), 'harbor', '2026-12', '2026-12-01'), null);
  });
});

describe('the append-only store', () => {
  const tmp = async () => join(await mkdtemp(join(tmpdir(), 'pb-')), 'events.jsonl');
  const clock = (iso: string) => () => new Date(iso);

  test('appends, replays, and survives a restart', async () => {
    const path = await tmp();
    const a = new Store({ path, now: clock('2026-08-13T09:00:00Z') });
    await a.load();
    await a.append('alice', [
      { op: 'category.define', category: 'groceries', label: 'Groceries' },
      { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
      { op: 'envelope.define', budget: 'harbor', envelope: 'food', label: 'Groceries', group: 'People',
        match: { categories: ['groceries'] }, template: parseDollars('1200.00') },
      { op: 'month.open', budget: 'harbor', month: '2026-08', income: parseDollars('9600.00') },
    ]);
    assert.equal(a.state.budgets.get('harbor')!.envelopes.size, 1);

    // a fresh process reading the same file must land in the same place
    const b = new Store({ path });
    const report = await b.load();
    assert.equal(report.events, 4);
    assert.equal(report.skipped.length, 0);
    assert.equal(monthView(b.state, 'harbor', '2026-08')!.planned, parseDollars('1200.00'));
  });

  test('a rejected batch touches neither disk nor memory', async () => {
    const path = await tmp();
    const s = new Store({ path, now: clock('2026-08-13T09:00:00Z') });
    await s.load();
    await s.append('alice', [
      { op: 'category.define', category: 'g', label: 'G' },
      { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
      { op: 'envelope.define', budget: 'harbor', envelope: 'food', label: 'F', group: 'P',
        match: { categories: ['g'] }, template: parseDollars('100.00') },
      { op: 'month.open', budget: 'harbor', month: '2026-08', income: parseDollars('100.00') },
    ]);
    const before = await readFile(path, 'utf8');

    // a move with no reason must be refused outright
    await assert.rejects(
      s.append('bob', [{ op: 'move', budget: 'harbor', month: '2026-08', from: 'food', to: 'food2',
                             amount: parseDollars('10.00') } as never]),
      /requires a reason/,
    );
    assert.equal(await readFile(path, 'utf8'), before, 'the log is unchanged');
    assert.equal(s.state.eventCount, 4, 'and so is memory');
  });

  test('a corrupt final line is skipped, not fatal', async () => {
    const path = await tmp();
    const s = new Store({ path, now: clock('2026-08-13T09:00:00Z') });
    await s.load();
    await s.append('alice', [{ op: 'category.define', category: 'g', label: 'G' }]);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, '{"op":"category.define","cat', 'utf8'); // half-written crash

    const reopened = new Store({ path });
    const report = await reopened.load();
    assert.equal(report.events, 1, 'the good event still loads');
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0]!.reason, /unparseable/);
  });

  test('concurrent appends serialise rather than interleave', async () => {
    const path = await tmp();
    const s = new Store({ path, now: clock('2026-08-13T09:00:00Z') });
    await s.load();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.append(i % 2 ? 'alice' : 'bob', [{ op: 'category.define', category: `c${i}`, label: `C${i}` }])),
    );
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 20);
    const ids = lines.map((l) => (JSON.parse(l) as Event).id);
    assert.equal(new Set(ids).size, 20, 'every event got a unique id');
    assert.equal(s.state.categories.size, 20);
  });

  test('"since" answers what changed while you were away', async () => {
    const path = await tmp();
    const s = new Store({ path, now: clock('2026-08-13T09:00:00Z') });
    await s.load();
    const [first] = await s.append('alice', [{ op: 'category.define', category: 'a', label: 'A' }]);
    await s.append('bob', [{ op: 'category.define', category: 'b', label: 'B' }]);
    await s.append('bob', [{ op: 'category.define', category: 'c', label: 'C' }]);

    const since = await s.since(first!.id);
    assert.equal(since.length, 2);
    assert.deepEqual(since.map((e) => e.who), ['bob', 'bob']);
    assert.equal((await s.since(null)).length, 3, 'a first-ever login sees everything');
  });

  test('seeding refuses to overwrite an existing log', async () => {
    const path = await tmp();
    const s = new Store({ path, now: clock('2026-08-13T09:00:00Z') });
    await s.load();
    await s.append('alice', [{ op: 'category.define', category: 'a', label: 'A' }]);
    await assert.rejects(s.seed([]), /refusing to seed/);
  });
});

describe("Today's money rail reads the briefing's own pace", () => {
  const p = (envelope: string, status: Pace['status'], available: number, funded: number) =>
    ({ envelope, label: envelope.toUpperCase(), status, available, funded }) as unknown as Pace;

  test('over and projected-over first, then least left; nothing used is not low', () => {
    const low = lowEnvelopes([
      p('a', 'ok', 5000, 10000),
      p('b', 'projected-over', 30000, 40000),
      p('c', 'over', -2000, 10000),
      p('d', 'watch', 1000, 20000),
      p('e', 'ok', 10000, 10000),
      p('f', 'ok', 0, 0),
    ], 5);
    assert.deepEqual(low.map((l) => l.envelope), ['c', 'b', 'd', 'a']);
    // The amounts are words the engine wrote: what is left, or by how much it is over. The page parses nothing.
    assert.deepEqual(low[0], { envelope: 'c', label: 'C', status: 'over', left: fmt(0 as never), over: fmt(2000 as never) });
    assert.deepEqual(low[1], { envelope: 'b', label: 'B', status: 'projected-over', left: fmt(30000 as never), over: null });
    assert.equal(lowEnvelopes([p('c', 'over', -1, 1), p('d', 'over', -2, 1)], 1).length, 1);
  });
});
