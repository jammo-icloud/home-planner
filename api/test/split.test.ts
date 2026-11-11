import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseDollars, cents, ZERO } from '../src/money.ts';
import { replay, validate, checkParts } from '../src/replay.ts';
import { scopeOf } from '../src/restore.ts';
import { monthView } from '../src/envelopes.ts';
import { monthClock, pace, toSort } from '../src/analytics.ts';
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
  payee: 'MERCHANT', dedupeKey: o.id, envelope: null, ...o,
  amount: cents(o.amount),
} as Txn);

/** Under one category: Groceries (`food`), Dining out (`dine`) and Household (`household`); March open. */
function world(extra: Event[] = []) {
  return replay([
    ev({ op: 'category.add', category: 'people', label: 'People' }),
    ev({ op: 'envelope.define', envelope: 'food', label: 'Groceries', category: 'people', template: parseDollars('1125.00'), order: 0 }),
    ev({ op: 'envelope.define', envelope: 'dine', label: 'Dining out', category: 'people', template: parseDollars('325.00'), order: 1 }),
    ev({ op: 'envelope.define', envelope: 'household', label: 'Household', category: 'people', template: parseDollars('100.00'), order: 2 }),
    ev({ op: 'month.open', month: '2026-03', income: parseDollars('9600.00') }),
    ...extra,
  ]);
}

const receipt = () => ev({ op: 'txn.add', txns: [txn({ id: 'c', date: '2026-03-02', amount: -16500, payee: 'BIGBOX WHSE #0100' })] });
const twoParts = [{ envelope: 'food', amount: cents(-12000) }, { envelope: 'dine', amount: cents(-4500) }];
const splitC = () => ev({ op: 'txn.split', txn: 'c', parts: twoParts });

describe('a split receipt', () => {
  test('partsOf: one line for an envelope, the parts for a split, nothing when unsorted', () => {
    assert.deepEqual(partsOf(txn({ id: 'a', date: '2026-03-01', amount: -16500, envelope: 'food' })),
      [{ envelope: 'food', amount: cents(-16500) }]);
    assert.deepEqual(partsOf(txn({ id: 'b', date: '2026-03-01', amount: -16500, envelope: null })), []);
    assert.deepEqual(partsOf({ envelope: SPLIT, amount: cents(-16500), split: twoParts }), twoParts);
  });

  test('isSplit is true only for the split marker, and a split is not spending', () => {
    assert.equal(isSplit({ envelope: SPLIT }), true);
    assert.equal(isSplit({ envelope: 'food' }), false);
    assert.equal(isSplit({ envelope: null }), false);
    assert.equal(isSpend(SPLIT), false);
    assert.equal(isSpend('food'), true);
    assert.equal(isSpend(TRANSFER), false);
    assert.equal(isSpend(INCOME), false);
  });

  test('txn.split files the receipt as a split, by hand', () => {
    const s = world([receipt(), splitC()]);
    const t = s.txns.get('c')!;
    assert.equal(t.envelope, SPLIT); assert.equal(t.manual, true); assert.equal(t.split!.length, 2);
    assert.deepEqual(t.split, twoParts);
    assert.equal(isSpend(t.envelope), false);
  });

  test('splitting a suggested receipt drops where the suggestion came from', () => {
    const s = world([receipt(),
      ev({ op: 'txn.sort', txn: 'c', envelope: 'food', suggestedBy: 'claude' }), splitC()]);
    assert.equal(s.txns.get('c')!.suggestedBy, undefined);
  });

  test('parts that do not add up are refused, and nothing changes', () => {
    const bad = ev({ op: 'txn.split', txn: 'c', parts: [{ envelope: 'food', amount: cents(-12000) }, { envelope: 'dine', amount: cents(-4499) }] });
    assert.throws(() => world([receipt(), bad]), /add up to the receipt/);
    // The same refusal on a log that stops short of it leaves the receipt unsorted.
    const s = world([receipt()]);
    assert.equal(s.txns.get('c')!.envelope, null);
    assert.equal(s.txns.get('c')!.split, undefined);
  });

  test('validate refuses one part, a zero part, a duplicate envelope, a nested split, and a split via txn.sort', () => {
    const split = (parts: { envelope: string; amount: number }[]) =>
      ev({ op: 'txn.split', txn: 'c', parts: parts.map((p) => ({ envelope: p.envelope, amount: p.amount as Cents })) });
    assert.throws(() => validate(split([{ envelope: 'food', amount: -16500 }])), /at least two parts/);
    assert.throws(() => validate(split([])), /at least two parts/);
    assert.throws(() => validate(split([{ envelope: 'food', amount: -16500 }, { envelope: 'dine', amount: 0 }])),
      /whole number of cents, not zero/);
    assert.throws(() => validate(split([{ envelope: 'food', amount: -16500.5 }, { envelope: 'dine', amount: 0.5 }])),
      /whole number of cents, not zero/);
    assert.throws(() => validate(split([{ envelope: 'food', amount: -10000 }, { envelope: 'food', amount: -6500 }])),
      /an envelope appears twice/);
    assert.throws(() => validate(split([{ envelope: SPLIT, amount: -10000 }, { envelope: 'dine', amount: -6500 }])),
      /cannot itself be split/);
    assert.doesNotThrow(() => validate(split([{ envelope: 'food', amount: -10000 }, { envelope: 'dine', amount: -6500 }])));
    assert.throws(() => validate(ev({ op: 'txn.sort', txn: 'c', envelope: SPLIT as never })), /written with txn\.split/);
    assert.throws(() => validate(ev({ op: 'txn.add', txns: [txn({ id: 'x', date: '2026-03-02', amount: -100, envelope: SPLIT })] })),
      /cannot arrive already split/);
    assert.throws(() => validate(ev({ op: 'txn.add', txns: [{ ...txn({ id: 'x', date: '2026-03-02', amount: -100 }), split: twoParts }] })),
      /cannot arrive already split/);
    assert.doesNotThrow(() => validate(ev({ op: 'txn.add', txns: [txn({ id: 'x', date: '2026-03-02', amount: -100, envelope: 'food' })] })));
  });

  test('checkParts names the first problem, or nothing', () => {
    assert.equal(checkParts(twoParts), null);
    assert.equal(checkParts([twoParts[0]!]), 'a split has at least two parts');
    assert.equal(checkParts(undefined as never), 'a split needs a list of parts');
    assert.equal(checkParts('ab' as never), 'a split needs a list of parts');
    assert.equal(checkParts([twoParts[0]!, null as never]), 'a part names its envelope');
    assert.equal(checkParts([twoParts[0]!, { amount: cents(-5) } as never]), 'a part names its envelope');
    assert.equal(checkParts([twoParts[0]!, { envelope: 7, amount: cents(-5) } as never]), 'a part names its envelope');
    assert.equal(checkParts([twoParts[0]!, { category: 'dine', amount: cents(-5) } as never]), 'a part names its envelope');
    assert.equal(checkParts([twoParts[0]!, { envelope: 'dine', amount: cents(0) }]), 'a part is a whole number of cents, not zero');
    assert.equal(checkParts([twoParts[0]!, twoParts[0]!]), 'an envelope appears twice in the split');
    assert.equal(checkParts([twoParts[0]!, { envelope: SPLIT as never, amount: cents(-1) }]), 'a part of a split cannot itself be split');
  });

  test('a split for a removed receipt is inert', () => {
    const s = world([receipt(), ev({ op: 'txn.remove', txn: 'c', why: 'duplicate' }), splitC()]);
    assert.equal(s.txns.has('c'), false);
  });

  test('sorting a split receipt whole drops the parts', () => {
    const s = world([receipt(), splitC(), ev({ op: 'txn.sort', txn: 'c', envelope: 'food' })]);
    const t = s.txns.get('c')!;
    assert.equal(t.split, undefined);
    assert.equal(t.envelope, 'food');
  });

  test('splitting again replaces the parts', () => {
    const again = [{ envelope: 'household', amount: cents(-6500) }, { envelope: 'food', amount: cents(-10000) }];
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
      { envelope: 'food', amount: cents(-10000) },
      { envelope: 'dine', amount: cents(-4500) },
      { envelope: 'household', amount: cents(-2000) },
    ] }), world(base));
    assert.equal(three.what, 'split a receipt across Groceries $100.00, Dining out $45.00 and Household $20.00');
  });
});

describe('a split rolls up by part', () => {
  // Groceries and Dining out are envelopes here; `electricity` is not.
  const roll = (extra: Event[]) => replay([
    ev({ op: 'category.add', category: 'people', label: 'People' }),
    ev({ op: 'envelope.define', envelope: 'food', label: 'Groceries', category: 'people', template: parseDollars('1125.00'), rollover: true, order: 0 }),
    ev({ op: 'envelope.define', envelope: 'dine', label: 'Dining out', category: 'people', template: parseDollars('325.00'), rollover: false, order: 1 }),
    ev({ op: 'month.open', month: '2026-03', income: parseDollars('9600.00') }),
    ev({ op: 'month.open', month: '2026-04', income: parseDollars('9600.00') }),
    ...extra,
  ]);
  const bigbox = [
    ev({ op: 'txn.add', txns: [txn({ id: 'c', date: '2026-03-02', amount: -16500, payee: 'BIGBOX WHSE #0100' })] }),
    ev({ op: 'txn.split', txn: 'c', parts: [
      { envelope: 'food', amount: cents(-12000) }, { envelope: 'dine', amount: cents(-3000) },
      { envelope: 'electricity', amount: cents(-1500) }] }),
  ];

  test('each part lands in its envelope; a part in an envelope not here counts nowhere, and To sort holds the receipt', () => {
    const s = roll(bigbox);
    const v = monthView(s, '2026-03')!;
    const food = v.envelopes.find((e) => e.envelope.id === 'food')!;
    assert.equal(food.activity, parseDollars('120.00'));
    assert.deepEqual(food.lines, [{ txnId: 'c', amount: parseDollars('120.00'), split: true }]);
    assert.deepEqual(food.txnIds, ['c']);
    assert.equal(v.envelopes.find((e) => e.envelope.id === 'dine')!.activity, parseDollars('30.00'));
    assert.equal(v.activity, parseDollars('150.00'));
    assert.deepEqual(toSort(s).txnIds, ['c']);
    assert.deepEqual(toSort(s).missing.get('c'), ['electricity']);
  });

  test('a plain receipt is one line, not marked split', () => {
    const s = roll([ev({ op: 'txn.add', txns: [txn({ id: 'p', date: '2026-03-03', amount: -4200, envelope: 'food' })] })]);
    const food = monthView(s, '2026-03')!.envelopes.find((e) => e.envelope.id === 'food')!;
    assert.equal(food.lines.length, 1);
    assert.deepEqual(food.lines[0], { txnId: 'p', amount: parseDollars('42.00'), split: false });
    assert.equal(food.activity, parseDollars('42.00'));
    assert.deepEqual(food.txnIds, ['p']);
  });

  test('two parts in envelopes not here: To sort lists the receipt once, missing both', () => {
    const s = roll([
      ev({ op: 'txn.add', txns: [txn({ id: 'd', date: '2026-03-04', amount: -10000 })] }),
      ev({ op: 'txn.split', txn: 'd', parts: [
        { envelope: 'food', amount: cents(-6000) }, { envelope: 'dine', amount: cents(-2000) },
        { envelope: 'electricity', amount: cents(-1000) }, { envelope: 'household', amount: cents(-1000) }] }),
    ]);
    assert.equal(monthView(s, '2026-03')!.activity, parseDollars('80.00'));
    assert.deepEqual(toSort(s).txnIds, ['d']);
    assert.deepEqual(toSort(s).missing.get('d'), ['electricity', 'household']);
  });

  test('a split part carries over like any spending', () => {
    const apr = monthView(roll(bigbox), '2026-04')!.envelopes.find((e) => e.envelope.id === 'food')!;
    assert.equal(apr.carried, parseDollars('1005.00')); // 1125 funded - 120 spent, not 165
  });

  test('a split is not spending in a month it does not belong to', () => {
    const v = monthView(roll(bigbox), '2026-04')!;
    assert.equal(v.activity, ZERO);
  });

  test('pace counts the part, not the whole receipt', () => {
    const s = roll(bigbox);
    const v = monthView(s, '2026-03')!;
    const food = pace(v, monthClock('2026-03', '2026-03-10'), s).find((p) => p.envelope === 'food')!;
    assert.equal(food.spent, parseDollars('120.00'));
    // 120.00 discretionary spread over 10 of 31 days, not 165.00 and not 150.00
    assert.equal(food.discretionary, parseDollars('120.00'));
  });
});
