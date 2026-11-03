import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseDollars, cents, ZERO } from '../src/money.ts';
import { replay, validate, checkParts } from '../src/replay.ts';
import { scopeOf } from '../src/restore.ts';
import { monthView } from '../src/envelopes.ts';
import { monthClock, pace } from '../src/analytics.ts';
import { describe as describeEvent } from '../src/tools.ts';
import { SPLIT, TRANSFER, INCOME, isSpend, isSplit, partsOf } from '../src/types.ts';
import type { Cents } from '../src/money.ts';
import type { Event, Txn } from '../src/types.ts';
import type { DistributiveOmit } from '../src/util-types.ts';

let seq = 0;
type EvInput = DistributiveOmit<Event, 'id' | 'at' | 'who'> & { id?: string; at?: string; who?: string };
const ev = (e: EvInput): Event =>
  ({ id: `e${++seq}`, at: `2026-03-01T00:00:0${seq % 10}Z`, who: 'alice', ...e }) as Event;

type TxnInput = Omit<Partial<Txn>, 'amount'> & { id: string; date: string; amount: number };
const txn = (o: TxnInput): Txn => ({
  payee: 'MERCHANT', dedupeKey: o.id, category: null, ...o,
  amount: cents(o.amount),
} as Txn);

function world(extra: Event[] = []) {
  return replay([
    ev({ op: 'category.define', category: 'groceries', label: 'Groceries' }),
    ev({ op: 'category.define', category: 'dining', label: 'Dining out' }),
    ev({ op: 'category.define', category: 'household', label: 'Household' }),
    ev({ op: 'budget.create', budget: 'harbor', label: 'Harbor' }),
    ev({ op: 'envelope.define', budget: 'harbor', envelope: 'food', label: 'Groceries',
         group: 'People', match: { categories: ['groceries'] }, template: parseDollars('1125.00'), order: 0 }),
    ev({ op: 'month.open', budget: 'harbor', month: '2026-03', income: parseDollars('9600.00') }),
    ...extra,
  ]);
}

const receipt = () => ev({ op: 'txn.add', txns: [txn({ id: 'c', date: '2026-03-02', amount: -16500, payee: 'BIGBOX WHSE #0100' })] });
const twoParts = [{ category: 'groceries', amount: cents(-12000) }, { category: 'dining', amount: cents(-4500) }];
const splitC = () => ev({ op: 'txn.split', txn: 'c', parts: twoParts });

describe('a split receipt', () => {
  test('partsOf: one line for a category, the parts for a split, nothing when unsorted', () => {
    assert.deepEqual(partsOf(txn({ id: 'a', date: '2026-03-01', amount: -16500, category: 'groceries' })),
      [{ category: 'groceries', amount: cents(-16500) }]);
    assert.deepEqual(partsOf(txn({ id: 'b', date: '2026-03-01', amount: -16500, category: null })), []);
    const parts = [{ category: 'groceries', amount: cents(-12000) }, { category: 'dining', amount: cents(-4500) }];
    assert.deepEqual(partsOf({ category: SPLIT, amount: cents(-16500), split: parts }), parts);
  });

  test('isSplit is true only for the split marker, and a split is not spending', () => {
    assert.equal(isSplit({ category: SPLIT }), true);
    assert.equal(isSplit({ category: 'groceries' }), false);
    assert.equal(isSplit({ category: null }), false);
    assert.equal(isSpend(SPLIT), false);
    assert.equal(isSpend('groceries'), true);
    assert.equal(isSpend(TRANSFER), false);
    assert.equal(isSpend(INCOME), false);
  });

  test('txn.split files the receipt as a split, by hand', () => {
    const s = world([receipt(), splitC()]);
    const t = s.txns.get('c')!;
    assert.equal(t.category, SPLIT); assert.equal(t.manual, true); assert.equal(t.split!.length, 2);
    assert.deepEqual(t.split, twoParts);
    assert.equal(isSpend(t.category), false);
  });

  test('splitting a suggested receipt drops where the suggestion came from', () => {
    const s = world([receipt(),
      ev({ op: 'txn.categorize', txn: 'c', category: 'groceries', suggestedBy: 'claude' }), splitC()]);
    assert.equal(s.txns.get('c')!.suggestedBy, undefined);
  });

  test('parts that do not add up are refused, and nothing changes', () => {
    const bad = ev({ op: 'txn.split', txn: 'c', parts: [{ category: 'groceries', amount: cents(-12000) }, { category: 'dining', amount: cents(-4499) }] });
    assert.throws(() => world([receipt(), bad]), /add up to the receipt/);
    // The same refusal on a log that stops short of it leaves the receipt unsorted.
    const s = world([receipt()]);
    assert.equal(s.txns.get('c')!.category, null);
    assert.equal(s.txns.get('c')!.split, undefined);
  });

  test('validate refuses one part, a zero part, a duplicate category, a nested split, and a split via categorize', () => {
    const split = (parts: { category: string; amount: number }[]) =>
      ev({ op: 'txn.split', txn: 'c', parts: parts.map((p) => ({ category: p.category, amount: p.amount as Cents })) });
    assert.throws(() => validate(split([{ category: 'groceries', amount: -16500 }])), /at least two parts/);
    assert.throws(() => validate(split([])), /at least two parts/);
    assert.throws(() => validate(split([{ category: 'groceries', amount: -16500 }, { category: 'dining', amount: 0 }])),
      /whole number of cents, not zero/);
    assert.throws(() => validate(split([{ category: 'groceries', amount: -16500.5 }, { category: 'dining', amount: 0.5 }])),
      /whole number of cents, not zero/);
    assert.throws(() => validate(split([{ category: 'groceries', amount: -10000 }, { category: 'groceries', amount: -6500 }])),
      /appears twice/);
    assert.throws(() => validate(split([{ category: SPLIT, amount: -10000 }, { category: 'dining', amount: -6500 }])),
      /cannot itself be split/);
    assert.doesNotThrow(() => validate(split([{ category: 'groceries', amount: -10000 }, { category: 'dining', amount: -6500 }])));
    assert.throws(() => validate(ev({ op: 'txn.categorize', txn: 'c', category: SPLIT })), /written with txn\.split/);
    assert.throws(() => validate(ev({ op: 'txn.add', txns: [txn({ id: 'x', date: '2026-03-02', amount: -100, category: SPLIT })] })),
      /cannot arrive already split/);
    assert.throws(() => validate(ev({ op: 'txn.add', txns: [{ ...txn({ id: 'x', date: '2026-03-02', amount: -100 }), split: twoParts }] })),
      /cannot arrive already split/);
    assert.doesNotThrow(() => validate(ev({ op: 'txn.add', txns: [txn({ id: 'x', date: '2026-03-02', amount: -100, category: 'groceries' })] })));
  });

  test('checkParts names the first problem, or nothing', () => {
    assert.equal(checkParts(twoParts), null);
    assert.equal(checkParts([twoParts[0]!]), 'a split has at least two parts');
    assert.equal(checkParts(undefined as never), 'a split needs a list of parts');
    assert.equal(checkParts('ab' as never), 'a split needs a list of parts');
    assert.equal(checkParts([twoParts[0]!, null as never]), 'a part names its category');
    assert.equal(checkParts([twoParts[0]!, { amount: cents(-5) } as never]), 'a part names its category');
    assert.equal(checkParts([twoParts[0]!, { category: 7, amount: cents(-5) } as never]), 'a part names its category');
    assert.equal(checkParts([twoParts[0]!, { category: 'dining', amount: cents(0) }]), 'a part is a whole number of cents, not zero');
    assert.equal(checkParts([twoParts[0]!, twoParts[0]!]), 'a category appears twice in the split');
    assert.equal(checkParts([twoParts[0]!, { category: SPLIT, amount: cents(-1) }]), 'a part of a split cannot itself be split');
  });

  test('a split for a removed receipt is inert', () => {
    const s = world([receipt(), ev({ op: 'txn.remove', txn: 'c', why: 'duplicate' }), splitC()]);
    assert.equal(s.txns.has('c'), false);
  });

  test('categorizing a split receipt again drops the parts', () => {
    const s = world([receipt(), splitC(), ev({ op: 'txn.categorize', txn: 'c', category: 'groceries' })]);
    const t = s.txns.get('c')!;
    assert.equal(t.split, undefined);
    assert.equal(t.category, 'groceries');
  });

  test('splitting again replaces the parts', () => {
    const again = [{ category: 'household', amount: cents(-6500) }, { category: 'groceries', amount: cents(-10000) }];
    const s = world([receipt(), splitC(), ev({ op: 'txn.split', txn: 'c', parts: again })]);
    assert.deepEqual(s.txns.get('c')!.split, again);
  });

  test('scopeOf puts a split with the facts', () => {
    assert.equal(scopeOf(splitC()), 'facts');
  });

  test('the Activity line names each part', () => {
    const base = [receipt()];
    const two = describeEvent(splitC(), world(base));
    assert.equal(two.what, 'split a receipt across Groceries $120.00 and Dining out $45.00');
    const three = describeEvent(ev({ op: 'txn.split', txn: 'c', parts: [
      { category: 'groceries', amount: cents(-10000) },
      { category: 'dining', amount: cents(-4500) },
      { category: 'household', amount: cents(-2000) },
    ] }), world(base));
    assert.equal(three.what, 'split a receipt across Groceries $100.00, Dining out $45.00 and Household $20.00');
  });
});

describe('a split rolls up by part', () => {
  // Groceries and dining have envelopes; electricity has none in this budget.
  const roll = (extra: Event[]) => replay([
    ev({ op: 'category.define', category: 'groceries', label: 'Groceries' }),
    ev({ op: 'category.define', category: 'dining', label: 'Dining out' }),
    ev({ op: 'category.define', category: 'electricity', label: 'Electricity' }),
    ev({ op: 'budget.create', budget: 'harbor', label: 'Harbor' }),
    ev({ op: 'envelope.define', budget: 'harbor', envelope: 'food', label: 'Groceries', group: 'People',
         match: { categories: ['groceries'] }, template: parseDollars('1125.00'), rollover: true, order: 0 }),
    ev({ op: 'envelope.define', budget: 'harbor', envelope: 'dine', label: 'Dining out', group: 'People',
         match: { categories: ['dining'] }, template: parseDollars('325.00'), rollover: false, order: 1 }),
    ev({ op: 'month.open', budget: 'harbor', month: '2026-03', income: parseDollars('9600.00') }),
    ev({ op: 'month.open', budget: 'harbor', month: '2026-04', income: parseDollars('9600.00') }),
    ...extra,
  ]);
  const bigbox = [
    ev({ op: 'txn.add', txns: [txn({ id: 'c', date: '2026-03-02', amount: -16500, payee: 'BIGBOX WHSE #0100' })] }),
    ev({ op: 'txn.split', txn: 'c', parts: [
      { category: 'groceries', amount: cents(-12000) }, { category: 'dining', amount: cents(-3000) },
      { category: 'electricity', amount: cents(-1500) }] }),
  ];

  test('each part lands in its envelope; a part with no envelope here is outside', () => {
    const v = monthView(roll(bigbox), 'harbor', '2026-03')!;
    const food = v.envelopes.find((e) => e.envelope.id === 'food')!;
    assert.equal(food.activity, parseDollars('120.00'));
    assert.deepEqual(food.lines, [{ txnId: 'c', category: 'groceries', amount: parseDollars('120.00'), split: true }]);
    assert.deepEqual(food.txnIds, ['c']);
    assert.equal(v.envelopes.find((e) => e.envelope.id === 'dine')!.activity, parseDollars('30.00'));
    assert.equal(v.outside.total, parseDollars('15.00'));
    assert.deepEqual(v.outside.txnIds, ['c']);
    assert.equal(v.activity, parseDollars('150.00'));
  });

  test('a plain receipt is one line, not marked split', () => {
    const s = roll([ev({ op: 'txn.add', txns: [txn({ id: 'p', date: '2026-03-03', amount: -4200, category: 'groceries' })] })]);
    const food = monthView(s, 'harbor', '2026-03')!.envelopes.find((e) => e.envelope.id === 'food')!;
    assert.equal(food.lines.length, 1);
    assert.deepEqual(food.lines[0], { txnId: 'p', category: 'groceries', amount: parseDollars('42.00'), split: false });
    assert.equal(food.activity, parseDollars('42.00'));
    assert.deepEqual(food.txnIds, ['p']);
  });

  test('two parts in one envelope are two lines and one id; outside lists the id once', () => {
    const s = roll([
      ev({ op: 'txn.add', txns: [txn({ id: 'd', date: '2026-03-04', amount: -10000 })] }),
      ev({ op: 'txn.split', txn: 'd', parts: [
        { category: 'groceries', amount: cents(-6000) }, { category: 'dining', amount: cents(-2000) },
        { category: 'electricity', amount: cents(-1000) }, { category: 'household', amount: cents(-1000) }] }),
    ]);
    const v = monthView(s, 'harbor', '2026-03')!;
    assert.equal(v.outside.total, parseDollars('20.00'));
    assert.deepEqual(v.outside.txnIds, ['d']);
    // one envelope that takes both food parts
    const both = replay([
      ev({ op: 'category.define', category: 'groceries', label: 'Groceries' }),
      ev({ op: 'category.define', category: 'dining', label: 'Dining out' }),
      ev({ op: 'budget.create', budget: 'b', label: 'B' }),
      ev({ op: 'envelope.define', budget: 'b', envelope: 'daily', label: 'Daily', group: 'People',
           match: { categories: ['groceries', 'dining'] }, template: parseDollars('500.00') }),
      ev({ op: 'month.open', budget: 'b', month: '2026-03', income: parseDollars('1000.00') }),
      ev({ op: 'txn.add', txns: [txn({ id: 'd', date: '2026-03-04', amount: -1015 })] }),
      ev({ op: 'txn.split', txn: 'd', parts: [
        { category: 'groceries', amount: cents(-615) }, { category: 'dining', amount: cents(-400) }] }),
    ]);
    const daily = monthView(both, 'b', '2026-03')!.envelopes[0]!;
    assert.equal(daily.activity, parseDollars('10.15'));
    assert.deepEqual(daily.lines.map((l) => [l.txnId, l.category, l.amount]),
      [['d', 'groceries', parseDollars('6.15')], ['d', 'dining', parseDollars('4.00')]]);
    assert.deepEqual(daily.txnIds, ['d']);
  });

  test('a split part carries over like any spending', () => {
    const apr = monthView(roll(bigbox), 'harbor', '2026-04')!.envelopes.find((e) => e.envelope.id === 'food')!;
    assert.equal(apr.carried, parseDollars('1005.00')); // 1125 funded - 120 spent, not 165
  });

  test('a split is not spending in a month it does not belong to', () => {
    const v = monthView(roll(bigbox), 'harbor', '2026-04')!;
    assert.equal(v.activity, ZERO);
    assert.equal(v.outside.total, ZERO);
  });

  test('pace counts the part, not the whole receipt', () => {
    const s = roll(bigbox);
    const v = monthView(s, 'harbor', '2026-03')!;
    const food = pace(v, monthClock('2026-03', '2026-03-10'), s).find((p) => p.envelope === 'food')!;
    assert.equal(food.spent, parseDollars('120.00'));
    // 120.00 discretionary spread over 10 of 31 days, not 165.00 and not 150.00
    assert.equal(food.discretionary, parseDollars('120.00'));
  });
});
