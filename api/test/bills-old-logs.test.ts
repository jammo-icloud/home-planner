import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { replay, apply } from '../src/replay.ts';
import { billsOf } from '../src/analytics.ts';
import type { BillDate, Event } from '../src/types.ts';
import { figuresOf, readLog } from './bill-figures.ts';

/**
 * Two real-shaped logs and every figure the budget gives from them, taken from
 * the code before bills existed. The golden is never regenerated: a date a
 * member sets is the only thing that may move a figure, and these logs have none.
 */
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/bills-old-log.pace.json', import.meta.url), 'utf8'));
const row = (log: string, at: string, envelope: string) =>
  GOLDEN[log].months[at].pace.find((r: unknown[]) => r[0] === envelope);

describe('an old log reads the same figures', () => {
  for (const log of ['old-log', 'bills-old-log'] as const) {
    test(`${log}: every figure, every month, four days of each`, () => {
      assert.deepEqual(figuresOf(replay(readLog(log))), GOLDEN[log]);
    });
    test(`${log}: replayed one line at a time, the same`, () => {
      let s = replay([]);
      for (const e of readLog(log)) s = apply(s, [e]);
      assert.deepEqual(figuresOf(s), GOLDEN[log]);
    });
  }
  test('the traps are in the fixture, worked by hand', () => {
    const at = 'harbor/2026-11/2026-11-12';
    assert.equal(row('bills-old-log', at, 'home')[5], 6000, 'rent landed, the cleaner has not: charge by charge');
    assert.equal(row('bills-old-log', at, 'util')[5], 3000, 'power has only a refund and that counts as landed; trash has not come');
    assert.equal(row('bills-old-log', at, 'oldpower')[5], 7500);
    assert.equal(row('bills-old-log', at, 'subs')[5], 2200, 'STREAM PLUS has not come; STREAMCO is not fixed');
    assert.equal(row('bills-old-log', at, 'cover')[5], 31000, 'an undated quarterly charge is expected every month, as now');
    assert.equal(row('bills-old-log', 'harbor/2026-09/2026-09-12', 'subs')[5], 0, "September's STREAM PLUS landed as a split part");
    assert.equal(row('bills-old-log', 'harbor/2026-11/2026-11-30', 'home')[5], 0, 'the last day: nothing more is coming');
    assert.equal(row('bills-old-log', at, 'spare'), undefined, 'pace leaves out an envelope with nothing funded and nothing spent');
  });
});

describe('a date set on an old log', () => {
  const at = 'harbor/2026-11/2026-11-12';
  const COVER = { op: 'bill.set', budget: 'harbor', envelope: 'cover', bill: 'example mutual insurance', name: 'Example Mutual',
                  date: { kind: 'due', per: 'quarter', on: '2026-09-21' } } as const;
  const later = (date = COVER.date as BillDate | null, more: Event[] = []) =>
    figuresOf(apply(replay(readLog('bills-old-log')), [{ id: 'z1', at: '2026-11-02T18:00:00Z', who: 'alice', ...COVER, date } as Event, ...more]));

  test('moves that envelope, in that month, and nothing else', () => {
    const was = GOLDEN['bills-old-log'].months;
    const now = later().months;
    const moved: string[] = [];
    for (const key of Object.keys(was)) {
      const a = was[key].pace.filter((r: unknown[]) => r[0] !== 'cover');
      const b = now[key].pace.filter((r: unknown[]) => r[0] !== 'cover');
      assert.deepEqual(a.map((r: unknown[]) => [r[0]]).sort(), b.map((r: unknown[]) => [r[0]]).sort(), key);
      for (const r of a) assert.deepEqual(r, b.find((x: unknown[]) => x[0] === r[0]), `${key} ${r[0]}`);
      if (JSON.stringify(was[key].pace) !== JSON.stringify(now[key].pace)) moved.push(key);
    }
    assert.ok(moved.length > 0);
    assert.equal(now[at].pace.find((r: unknown[]) => r[0] === 'cover')[5], 0, 'no date of a quarterly falls in November');
  });
  test('cleared, every figure is back', () => {
    const f = later(COVER.date, [{ id: 'z2', at: '2026-11-03T18:00:00Z', who: 'alice', ...COVER, date: null } as Event]);
    assert.deepEqual(f, GOLDEN['bills-old-log']);
  });
  test('a date on one bill of two charges: paid is one payment', () => {
    const f = figuresOf(apply(replay(readLog('bills-old-log')), [{ id: 'z3', at: '2026-11-02T18:00:00Z', who: 'alice', op: 'bill.set', budget: 'harbor',
      envelope: 'home', bill: 'p2p payment', name: 'P2P', date: { kind: 'due', per: 'month', day: 5 } } as Event]));
    assert.equal(f.months[at]!.pace.find((r: unknown[]) => r[0] === 'home')[5], 0, "November's rent paid the date");
  });
  test('reading the bills writes nothing', () => {
    const s = replay(readLog('bills-old-log'));
    const n = s.eventCount;
    billsOf(s, 'harbor');
    assert.equal(s.eventCount, n);
    assert.equal(s.budgets.get('harbor')!.bills.size, 0);
  });
});
