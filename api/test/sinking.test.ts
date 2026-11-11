import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cents } from '../src/money.ts';
import { replay, ReplayError } from '../src/replay.ts';
import { monthView } from '../src/envelopes.ts';
import {
  STALE_AFTER_DAYS, balanceAsOf, byMonthly, everyMonthly, goalFor, monthsThrough, savingsCheck, sinkingPlan,
} from '../src/sinking.ts';
import type { Event, Txn } from '../src/types.ts';
import type { DistributiveOmit } from '../src/util-types.ts';

let seq = 0;
type EvInput = DistributiveOmit<Event, 'id' | 'at' | 'who'> & { id?: string; at?: string; who?: string };
const ev = (e: EvInput): Event => ({ id: `s${++seq}`, at: '2026-10-01T08:00:00Z', who: 'alice', ...e }) as Event;
const txn = (id: string, date: string, amount: number, category: string): Txn =>
  ({ id, date, payee: 'SHOP', amount: cents(amount), account: '1234', dedupeKey: id, category });

/**
 * Auto maintenance, saved every so often (tyres $1,200 every 4 years, a
 * service $600 every year), and the Bahamas, $4,000 by March 2027.
 */
const base = (): Event[] => [
  ev({ op: 'category.define', category: 'groceries', label: 'Groceries' }),
  ev({ op: 'category.define', category: 'tyres', label: 'Tyres', sinking: { cost: cents(120000), everyYears: 4 } }),
  ev({ op: 'category.define', category: 'service', label: 'Car service', sinking: { cost: cents(60000), everyYears: 1 } }),
  ev({ op: 'category.define', category: 'trips', label: 'Trips' }),
  ev({ op: 'envelope.define', envelope: 'food', label: 'Groceries', group: 'People',
       match: { categories: ['groceries'] }, template: cents(100000) }),
  ev({ op: 'envelope.define', envelope: 'auto', label: 'Auto maintenance', group: 'Future',
       match: { categories: ['tyres', 'service'] }, template: cents(0), rollover: false, sinking: { kind: 'every' } }),
  ev({ op: 'envelope.define', envelope: 'bahamas', label: 'Bahamas', group: 'Future',
       match: { categories: ['trips'] }, template: cents(0), sinking: { kind: 'by', target: cents(400000), by: '2027-03' } }),
];

describe('the monthly figure', () => {
  test('every so often spreads each cost over the months until it comes round', () => {
    // $1,200 over 48 months is $25; $600 over 12 is $50.
    assert.equal(everyMonthly([{ cost: cents(120000), everyYears: 4 }, { cost: cents(60000), everyYears: 1 }]), 7500);
  });

  test('every so often rounds up once, to the cent, so the goal is met', () => {
    assert.equal(everyMonthly([{ cost: cents(100000), everyYears: 3 }]), 2778, '$1,000 over 36 months is $27.777…');
    // Rounded each it would be 84 + 84; rounded once it is the 167 the two need.
    assert.equal(everyMonthly([{ cost: cents(1000), everyYears: 1 }, { cost: cents(1000), everyYears: 1 }]), 167);
    assert.equal(everyMonthly([]), 0);
  });

  test('months through a target count this month and the target month', () => {
    assert.equal(monthsThrough('2026-11', '2027-03'), 5);
    assert.equal(monthsThrough('2027-03', '2027-03'), 1);
    assert.equal(monthsThrough('2027-04', '2027-03'), 0);
  });

  test('by a date: what is left over the months left', () => {
    assert.deepEqual(byMonthly(cents(400000), cents(0), '2026-11', '2027-03'), { monthly: 80000, monthsLeft: 5, passed: false });
    assert.deepEqual(byMonthly(cents(400000), cents(100000), '2026-11', '2027-03'), { monthly: 60000, monthsLeft: 5, passed: false });
    // $1,000 over 3 months is $333.33…, rounded up so the last month is not short.
    assert.equal(byMonthly(cents(100000), cents(0), '2027-01', '2027-03').monthly, 33334);
  });

  test('by a date: in the target month it is all that is left, and once met it is nothing', () => {
    assert.equal(byMonthly(cents(400000), cents(350000), '2027-03', '2027-03').monthly, 50000);
    assert.equal(byMonthly(cents(400000), cents(410000), '2026-12', '2027-03').monthly, 0);
  });

  test('by a date that has passed plans nothing more, and says so', () => {
    assert.deepEqual(byMonthly(cents(400000), cents(100000), '2027-04', '2027-03'), { monthly: 0, monthsLeft: 0, passed: true });
  });

  test('a goal by a date is worked out again each month from what was saved', () => {
    const s = replay([...base(),
      ev({ op: 'month.open', month: '2026-11', income: cents(500000) }),
      // Funded less than the goal asked for: December asks a little more.
      ev({ op: 'assign', month: '2026-11', envelope: 'bahamas', to: cents(50000), why: 'a lean month' }),
    ]);
    const bahamas = s.envelopes.get('bahamas')!;
    assert.equal(goalFor(s, bahamas, '2026-11')!.monthly, 80000);
    assert.equal(goalFor(s, bahamas, '2026-12')!.monthly, 87500, '$3,500 left over 4 months');
  });

  test("every so often comes from its categories' estimates, and fills toward their costs together", () => {
    const s = replay(base());
    const g = goalFor(s, s.envelopes.get('auto')!, '2026-11')!;
    assert.equal(g.monthly, 7500);
    assert.equal(g.target, 180000);
    assert.deepEqual(g.estimates.map((e) => [e.category, e.cost, e.everyYears, e.monthly]),
      [['tyres', 120000, 4, 2500], ['service', 60000, 1, 5000]]);
    assert.equal(goalFor(s, s.envelopes.get('food')!, '2026-11'), null, 'an ordinary envelope has none');
  });

  test('a month opened with a plan for its sinking envelopes keeps it', () => {
    const s = replay([...base(),
      ev({ op: 'month.open', month: '2026-11', income: cents(500000),
           plan: Object.fromEntries(sinkingPlan(replay(base()), '2026-11')) }),
    ]);
    const v = monthView(s, '2026-11')!;
    assert.deepEqual(v.envelopes.map((e) => [e.envelope.id, e.planned]), [['food', 100000], ['auto', 7500], ['bahamas', 80000]]);
  });
});

describe('the log', () => {
  test('a sinking envelope always rolls over, and keeps its goal when redefined without one', () => {
    const s = replay([...base(),
      ev({ op: 'envelope.define', envelope: 'auto', label: 'Car', group: 'Future',
           match: { categories: ['tyres', 'service'] }, template: cents(0), rollover: false }),
    ]);
    const auto = s.envelopes.get('auto')!;
    assert.equal(auto.rollover, true, 'asked not to, and rolls over all the same');
    assert.deepEqual(auto.sinking, { kind: 'every' });
    assert.equal(auto.label, 'Car');
  });

  test('null makes it an ordinary envelope again', () => {
    const s = replay([...base(),
      ev({ op: 'envelope.define', envelope: 'auto', label: 'Auto', group: 'Future',
           match: { categories: ['tyres', 'service'] }, template: cents(0), sinking: null }),
    ]);
    assert.equal('sinking' in s.envelopes.get('auto')!, false);
  });

  test("an estimate is set and cleared on its own, leaving the category's name and archive alone", () => {
    const s = replay([...base(),
      ev({ op: 'category.archive', category: 'tyres', archived: true, why: 'sold the car' }),
      ev({ op: 'category.sinking', category: 'tyres', sinking: { cost: cents(90000), everyYears: 3 } }),
      ev({ op: 'category.sinking', category: 'service', sinking: null }),
    ]);
    assert.deepEqual(s.categories.get('tyres'), { id: 'tyres', label: 'Tyres', archived: true, sinking: { cost: 90000, everyYears: 3 } });
    assert.deepEqual(s.categories.get('service'), { id: 'service', label: 'Car service' });
  });

  test('lines of the wrong shape are refused by name', () => {
    const refused = (e: EvInput) => assert.throws(() => replay([...base(), ev(e)]), ReplayError);
    refused({ op: 'category.sinking', category: 'nope', sinking: null });
    refused({ op: 'category.sinking', category: 'tyres', sinking: { cost: cents(0), everyYears: 2 } });
    refused({ op: 'category.sinking', category: 'tyres', sinking: { cost: cents(100), everyYears: 0 } });
    refused({ op: 'envelope.define', envelope: 'x', label: 'X', group: 'F', match: { categories: ['trips'] },
              template: cents(0), sinking: { kind: 'by', target: cents(100), by: '2027-13' } });
    refused({ op: 'envelope.define', envelope: 'x', label: 'X', group: 'F', match: { categories: ['trips'] },
              template: cents(0), sinking: { kind: 'someday' } as never });
    refused({ op: 'month.open', month: '2026-11', income: cents(0), plan: { auto: -1 as never } });
    refused({ op: 'account.balance', account: '7', cents: cents(100), asOf: '2026-02-30', source: 'statement' });
    refused({ op: 'account.balance', account: '7', cents: 1.5 as never, asOf: '2026-02-03', source: 'typed' });
    refused({ op: 'savings.account', account: '  ' });
  });

  test("an account's balance is its latest day's, and an older statement imported late does not replace it", () => {
    const s = replay([
      ev({ op: 'account.balance', account: '7', cents: cents(100), asOf: '2026-10-31', source: 'statement' }),
      ev({ op: 'account.balance', account: '7', cents: cents(200), asOf: '2026-09-30', source: 'statement' }),
      ev({ op: 'account.balance', account: '7', cents: cents(300), asOf: '2026-10-31', source: 'typed' }),
    ]);
    const b = s.savings.balances.get('7')!;
    assert.deepEqual([b.cents, b.asOf, b.source], [300, '2026-10-31', 'typed']);
  });
});

describe('balances as of a day', () => {
  const lived = (): Event[] => [...base(),
    ev({ op: 'month.open', month: '2026-10', income: cents(500000),
         plan: { auto: cents(7500), bahamas: cents(80000) } }),
    ev({ op: 'month.open', month: '2026-11', income: cents(500000),
         plan: { auto: cents(7500), bahamas: cents(80000) } }),
    ev({ op: 'txn.add', txns: [
      txn('t1', '2026-10-10', -2000, 'service'),
      txn('t2', '2026-10-25', -3000, 'service'),
      txn('t3', '2026-11-05', -1000, 'tyres'),
    ] }),
  ];

  test('spending after the day is not counted, funding that month is', () => {
    const s = replay(lived());
    assert.equal(balanceAsOf(s, 'auto', '2026-10-15'), 7500 - 2000);
    assert.equal(balanceAsOf(s, 'auto', '2026-10-31'), 7500 - 5000);
    assert.equal(balanceAsOf(s, 'auto', '2026-11-04'), 2500 + 7500, 'carried in, and November funded');
    assert.equal(balanceAsOf(s, 'auto', '2026-11-30'), 2500 + 7500 - 1000);
  });

  test('a day past the last open month reads its end, and one before any month reads nothing', () => {
    const s = replay(lived());
    assert.equal(balanceAsOf(s, 'auto', '2027-01-10'), 9000);
    assert.equal(balanceAsOf(s, 'auto', '2026-09-30'), 0);
  });
});

describe('the check against Savings', () => {
  // Funds held $825 on Oct 31: Auto $75 less $50 spent, plus Bahamas $800.
  // November puts nothing more in, and spends $100 on the 2nd.
  const world = (extra: EvInput[] = []) => replay([...base(),
    ev({ op: 'month.open', month: '2026-10', income: cents(500000),
         plan: { auto: cents(7500), bahamas: cents(80000) } }),
    ev({ op: 'month.open', month: '2026-11', income: cents(500000),
         plan: { auto: cents(0), bahamas: cents(0) } }),
    ev({ op: 'txn.add', txns: [txn('t1', '2026-10-10', -5000, 'service'), txn('t2', '2026-11-02', -10000, 'service')] }),
    ev({ op: 'savings.account', account: '7' }),
    ...extra.map(ev),
  ]);
  const balance = (c: number, asOf = '2026-10-31'): EvInput =>
    ({ op: 'account.balance', account: '7', cents: cents(c), asOf, source: 'statement' });

  test('at: every dollar in Savings is in a fund', () => {
    const c = savingsCheck(world([balance(82500)]), '2026-11-03')!;
    assert.equal(c.status, 'even');
    assert.equal(c.held, 82500);
    assert.equal(c.words.held, 'Sinking funds held $825 on Oct 31.');
    assert.equal(c.words.showed, 'Savings showed $825 on Oct 31.');
  });

  test("over: the rest of Savings isn't in any fund", () => {
    const c = savingsCheck(world([balance(127500)]), '2026-11-03')!;
    assert.deepEqual([c.status, c.difference], ['over', 45000]);
    assert.equal(c.words.verdict, "$450 in Savings isn't in any fund.");
  });

  test('under: Savings is short of the sinking funds', () => {
    const c = savingsCheck(world([balance(52500)]), '2026-11-03')!;
    assert.deepEqual([c.status, c.difference], ['short', -30000]);
    assert.equal(c.words.verdict, 'Savings is $300 short of the sinking funds.');
  });

  test("compared as of the balance's day: spending since is not held against it", () => {
    // The $100 spent on Nov 2 came after the statement, so it plays no part.
    assert.equal(savingsCheck(world([balance(82500)]), '2026-11-03')!.status, 'even');
    // A balance typed today meets today's funds, $100 lower.
    const today = savingsCheck(world([balance(72500, '2026-11-03')]), '2026-11-03')!;
    assert.equal(today.status, 'even');
    assert.equal(today.words.held, 'Sinking funds hold $725.');
  });

  test('a difference under a dollar is said to the cent', () => {
    assert.equal(savingsCheck(world([balance(82460)]), '2026-11-03')!.words.verdict,
      'Savings is $0.40 short of the sinking funds.');
  });

  test(`a balance older than ${STALE_AFTER_DAYS} days is said to be old, not compared`, () => {
    const fresh = savingsCheck(world([balance(52500)]), '2026-12-05')!;
    assert.equal(fresh.status, 'short', '35 days on, still compared');
    const old = savingsCheck(world([balance(52500)]), '2026-12-06')!;
    assert.equal(old.status, 'stale');
    assert.equal(old.daysOld, 36);
    assert.match(old.words.verdict, /36 days ago, too long ago to compare/);
  });

  test('without an account or a balance it says what is missing, and without sinking envelopes there is no check', () => {
    assert.equal(savingsCheck(replay([...base(), ev({ op: 'month.open', month: '2026-10', income: cents(0) })]),
      '2026-10-10')!.status, 'no-account');
    assert.equal(savingsCheck(world(), '2026-11-03')!.status, 'no-balance');
    const plain = replay(base().filter((e) => !(e.op === 'envelope.define' && e.sinking)));
    assert.equal(savingsCheck(plain, '2026-11-03'), null);
  });
});
