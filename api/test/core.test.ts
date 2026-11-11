import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseDollars, fmt, split, sum, cents, ZERO } from '../src/money.ts';
import { replay, apply, validate, requireReason, fundedFor, plannedFor, plannedTotal, fundedTotal, byRule, ReplayError } from '../src/replay.ts';
import { monthView } from '../src/envelopes.ts';
import { toSort } from '../src/analytics.ts';
import { TRANSFER, INCOME } from '../src/types.ts';
import type { Event, Txn } from '../src/types.ts';
import type { DistributiveOmit } from '../src/util-types.ts';

let seq = 0;
type EvInput = DistributiveOmit<Event, 'id' | 'at' | 'who'> & { id?: string; at?: string; who?: string };
const ev = (e: EvInput): Event =>
  ({ id: `e${++seq}`, at: `2026-03-01T00:00:0${seq % 10}Z`, who: 'alice', ...e }) as Event;

type TxnInput = Omit<Partial<Txn>, 'amount'> & { id: string; date: string; amount: number };
const txn = (o: TxnInput): Txn => ({
  payee: 'MERCHANT', dedupeKey: o.id, envelope: null, ...o,
  amount: cents(o.amount),
} as Txn);

// A small but complete world: one budget, two envelopes, one month.
function world(extra: Event[] = []) {
  return replay([
    ev({ op: 'category.add', category: 'people', label: 'People' }),
    ev({ op: 'envelope.define', envelope: 'food', label: 'Groceries', category: 'people', template: parseDollars('1125.00'), order: 0 }),
    ev({ op: 'envelope.define', envelope: 'dine', label: 'Dining out', category: 'people', template: parseDollars('325.00'), order: 1 }),
    ev({ op: 'month.open', month: '2026-03', income: parseDollars('9600.00') }),
    ...extra,
  ]);
}

describe('money', () => {
  test('parses the shapes real bank exports use', () => {
    assert.equal(parseDollars('84.21'), 8421);
    assert.equal(parseDollars('-268.40'), -26840);
    assert.equal(parseDollars('$1,234.56'), 123456);
    assert.equal(parseDollars('(45.00)'), -4500);   // accounting negative
    assert.equal(parseDollars('2400.50'), 240050);
    assert.equal(parseDollars(-31.9), -3190);
    assert.equal(parseDollars('0'), 0);
  });

  test('avoids the float error that would break a zero-based budget', () => {
    // 0.1 + 0.2 !== 0.3 in floats; in cents it is exact
    assert.equal(sum([parseDollars('0.10'), parseDollars('0.20')]), parseDollars('0.30'));
    // a made-up month's figures must still sum exactly
    const real = ['84.21', '132.50', '24.99', '268.40', '142.30', '96.40'].map(parseDollars);
    assert.equal(sum(real), parseDollars('748.80'));
  });

  test('rejects nonsense rather than silently producing NaN', () => {
    assert.throws(() => parseDollars('abc'), SyntaxError);
    assert.throws(() => parseDollars(''), SyntaxError);
    assert.throws(() => parseDollars(Infinity), RangeError);
  });

  test('split never loses or invents a cent', () => {
    for (const [total, ways] of [[1000, 3], [1, 4], [-1000, 3], [240050, 7]] as const) {
      const parts = split(cents(total), ways);
      assert.equal(parts.length, ways);
      assert.equal(sum(parts), total, `${total} split ${ways} ways`);
    }
  });

  test('formats whole dollars for envelopes', () => {
    assert.equal(fmt(parseDollars('1234.56')), '$1,235');
    assert.equal(fmt(parseDollars('-96.00')), '-$96');
  });
});

describe('the immutable plan', () => {
  test('opening a month snapshots the templates as the plan of record', () => {
    const s = world();
    const m = s.months.get('2026-03')!;
    assert.equal(plannedFor(m, 'food'), parseDollars('1125.00'));
    assert.equal(plannedTotal(m), parseDollars('1450.00'));
  });

  test('an in-month move never changes what was planned', () => {
    const s = world([
      ev({ op: 'move', month: '2026-03', from: 'food', to: 'dine',
           amount: parseDollars('96.00'), why: 'Nguyen dinner' }),
    ]);
    const m = s.months.get('2026-03')!;
    // this is the requirement: the original survives
    assert.equal(plannedFor(m, 'dine'), parseDollars('325.00'), 'planned must not move');
    assert.equal(fundedFor(m, 'dine'), parseDollars('421.00'), 'funded reflects the move');
    assert.equal(plannedFor(m, 'food'), parseDollars('1125.00'));
    assert.equal(fundedFor(m, 'food'), parseDollars('1029.00'));
  });

  test('moves are zero-sum; assignments are not', () => {
    const moved = world([
      ev({ op: 'move', month: '2026-03', from: 'food', to: 'dine',
           amount: parseDollars('96.00'), why: 'dinner' }),
    ]);
    const mm = moved.months.get('2026-03')!;
    assert.equal(fundedTotal(mm), plannedTotal(mm), 'a move must not change the total');

    const assigned = world([
      ev({ op: 'assign', month: '2026-03', envelope: 'dine',
           to: parseDollars('400.00'), why: 'raising the plan' }),
    ]);
    const am = assigned.months.get('2026-03')!;
    assert.equal(fundedTotal(am), parseDollars('1525.00'), 'an assignment does change the total');
  });

  test('the trail records who, why and how much, in order', () => {
    const s = world([
      ev({ op: 'move', month: '2026-03', from: 'food', to: 'dine',
           amount: parseDollars('96.00'), why: 'Nguyen dinner', who: 'bob' }),
    ]);
    const m = s.months.get('2026-03')!;
    const trail = m.adjustments.filter((a) => a.envelope === 'dine');
    assert.equal(trail.length, 1);
    assert.equal(trail[0]!.who, 'bob');
    assert.equal(trail[0]!.why, 'Nguyen dinner');
    assert.equal(trail[0]!.counterpart, 'food');
  });

  test('re-opening a month is inert — it can never silently re-plan', () => {
    const s = world([
      ev({ op: 'move', month: '2026-03', from: 'food', to: 'dine',
           amount: parseDollars('96.00'), why: 'dinner' }),
      ev({ op: 'month.open', month: '2026-03', income: parseDollars('99.00') }),
    ]);
    const m = s.months.get('2026-03')!;
    assert.equal(m.income, parseDollars('9600.00'));
    assert.equal(fundedFor(m, 'dine'), parseDollars('421.00'), 'adjustments survive');
  });
});

describe('required reasons', () => {
  for (const op of ['assign', 'move', 'income.set'] as const) {
    test(`${op} without a reason is refused when written`, () => {
      const base: Record<string, unknown> = {
        assign: { op, month: '2026-03', envelope: 'dine', to: cents(100) },
        move: { op, month: '2026-03', from: 'food', to: 'dine', amount: cents(100) },
        'income.set': { op, month: '2026-03', amount: cents(100) },
      }[op] as Record<string, unknown>;
      // Checked on the way in, not on the way back. Replaying an old event
      // must never fail because the rules have since got stricter.
      assert.throws(() => requireReason(ev(base as never)), /requires a reason/);
      assert.throws(() => requireReason(ev({ ...base, why: '  ' } as never)), /requires a reason/);
      assert.doesNotThrow(() => requireReason(ev({ ...base, why: 'because' } as never)));
      assert.doesNotThrow(() => validate(ev(base as never)), 'history still replays');
    });
  }

  test('a move to the same envelope is rejected', () => {
    assert.throws(() => validate(ev({ op: 'move', month: '2026-03',
      from: 'food', to: 'food', amount: cents(100), why: 'x' })), /same envelope/);
  });
});

describe('a receipt counts in its envelope', () => {
  test('transfers and income never reach an envelope', () => {
    const s = world([
      ev({ op: 'txn.add', txns: [
        txn({ id: 't1', date: '2026-03-04', amount: -240050, payee: 'EXAMPLE BANK CARD PAYMENT', envelope: TRANSFER }),
        txn({ id: 't2', date: '2026-03-15', amount: 410000, payee: 'ACH Deposit ACME CORP', envelope: INCOME }),
        txn({ id: 't3', date: '2026-03-06', amount: -8421, payee: 'VALLEY', envelope: 'food' }),
      ] }),
    ]);
    const v = monthView(s, '2026-03')!;
    assert.equal(v.activity, parseDollars('84.21'), 'only real spending counts');
    const food = v.envelopes.find((e) => e.envelope.id === 'food')!;
    assert.equal(food.activity, parseDollars('84.21'));
  });

  test('a refund nets against its envelope', () => {
    const s = world([
      ev({ op: 'txn.add', txns: [
        txn({ id: 'a', date: '2026-03-03', amount: -8421, envelope: 'food' }),
        txn({ id: 'b', date: '2026-03-18', amount: 2200, envelope: 'food' }),
      ] }),
    ]);
    const food = monthView(s, '2026-03')!.envelopes.find((e) => e.envelope.id === 'food')!;
    assert.equal(food.activity, parseDollars('62.21'));
  });

  test('a receipt naming an envelope that is not here is To sort instead of vanishing', () => {
    const s = world([
      ev({ op: 'txn.add', txns: [
        txn({ id: 'p', date: '2026-03-09', amount: -34200, payee: 'POOL SUPPLY', envelope: 'electricity' }),
      ] }),
    ]);
    const v = monthView(s, '2026-03')!;
    assert.deepEqual(toSort(s).txnIds, ['p']);
    assert.equal(toSort(s).outflow, parseDollars('342.00'));
    assert.equal(v.activity, ZERO, 'and it is not counted as envelope activity');
  });

});

describe('the overlap month', () => {
  // Two electricity bills in one month, for two houses: two envelopes, each bill sorted into its own.
  const moving = () => replay([
    ev({ op: 'category.add', category: 'house', label: 'House' }),
    ev({ op: 'envelope.define', envelope: 'util_old', label: 'Utilities - old house', category: 'house', template: parseDollars('300.00'), order: 0 }),
    ev({ op: 'envelope.define', envelope: 'util_new', label: 'Utilities - new house', category: 'house', template: parseDollars('295.00'), order: 1 }),
    ev({ op: 'month.open', month: '2026-03', income: parseDollars('9600.00') }),
    ev({ op: 'txn.add', txns: [
      txn({ id: 'oldbill', date: '2026-03-14', amount: -30000, payee: 'EXAMPLE POWER BILLPAY', envelope: 'util_old' }),
      txn({ id: 'newbill', date: '2026-03-20', amount: -12100, payee: 'EXAMPLE ELECTRIC ONLINE PMT', envelope: 'util_new' }),
    ] }),
  ]);

  test('each bill counts in its own envelope, and nothing is double counted', () => {
    const v = monthView(moving(), '2026-03')!;
    assert.equal(v.envelopes.find((e) => e.envelope.id === 'util_old')!.activity, parseDollars('300.00'));
    assert.equal(v.envelopes.find((e) => e.envelope.id === 'util_new')!.activity, parseDollars('121.00'));
    assert.equal(sum(v.envelopes.map((e) => e.activity)), v.activity);
    assert.equal(v.activity, parseDollars('421.00'));
  });
});

describe('rollover', () => {
  const twoMonths = (rollover: boolean) => replay([
    ev({ op: 'category.add', category: 'people', label: 'People' }),
    ev({ op: 'envelope.define', envelope: 'food', label: 'Groceries', category: 'people', template: parseDollars('1125.00'), rollover }),
    ev({ op: 'month.open', month: '2026-02', income: parseDollars('9600.00') }),
    ev({ op: 'month.open', month: '2026-03', income: parseDollars('9600.00') }),
    ev({ op: 'txn.add', txns: [
      txn({ id: 'f', date: '2026-02-10', amount: -19471, envelope: 'food' }),
      txn({ id: 'g', date: '2026-03-05', amount: -9900, envelope: 'food' }),
    ] }),
  ]);

  test('leftovers carry into the next month', () => {
    const feb = monthView(twoMonths(true), '2026-02')!.envelopes[0]!;
    assert.equal(feb.available, parseDollars('930.29'));
    const mar = monthView(twoMonths(true), '2026-03')!.envelopes[0]!;
    assert.equal(mar.carried, parseDollars('930.29'));
    assert.equal(mar.available, parseDollars('1956.29'));
  });

  test('rollover off starts each month clean', () => {
    const mar = monthView(twoMonths(false), '2026-03')!.envelopes[0]!;
    assert.equal(mar.carried, ZERO);
    assert.equal(mar.available, parseDollars('1026.00'));
  });
});

describe('replay is pure', () => {
  const log: Event[] = [
    ev({ op: 'category.add', category: 'people', label: 'People' }),
    ev({ op: 'envelope.define', envelope: 'food', label: 'Groceries', category: 'people', template: parseDollars('1125.00') }),
    ev({ op: 'month.open', month: '2026-03', income: parseDollars('9600.00') }),
    ev({ op: 'move', month: '2026-03', from: 'food', to: 'food2', amount: cents(1), why: 'x' }),
  ].slice(0, 4);

  test('same log, same state, every time', () => {
    const a = monthView(replay(log), '2026-03')!;
    const b = monthView(replay(log), '2026-03')!;
    assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
  });

  test('incremental apply equals a full replay', () => {
    const extra = ev({ op: 'assign', month: '2026-03', envelope: 'food',
                       to: parseDollars('1200.00'), why: 'bulk shop' });
    const incremental = apply(replay(log), [extra]);
    const full = replay([...log, extra]);
    assert.equal(
      JSON.stringify(monthView(incremental, '2026-03')),
      JSON.stringify(monthView(full, '2026-03')),
    );
  });

  test('money put in a month not open is a loud failure, not a silent zero', () => {
    assert.throws(() => replay([ev({ op: 'assign', month: '2026-03', envelope: 'food', to: ZERO, why: 'w' })]),
      ReplayError);
  });
});

describe('rules', () => {
  test('last match wins, so a later rule can narrow an earlier one', () => {
    const rules = [
      { id: '1', match: 'AMAZON', envelope: 'subs' },
      { id: '2', match: 'AMAZON MKTPL', envelope: 'food' },
    ];
    assert.equal(byRule(rules, { payee: 'AMAZON RETA* 3X9QZ' }), 'subs');
    assert.equal(byRule(rules, { payee: 'AMAZON MKTPL*1A2B3C4D5' }), 'food');
    assert.equal(byRule(rules, { payee: 'VALLEY MARKET' }), null);
  });

  test('memo is searched as well as payee', () => {
    const rules = [{ id: '1', match: 'SUBSCRIPTION', envelope: 'subs' }];
    assert.equal(byRule(rules, { payee: 'NETFLIX.COM', memo: 'SUBSCRIPTION' }), 'subs');
  });
});
