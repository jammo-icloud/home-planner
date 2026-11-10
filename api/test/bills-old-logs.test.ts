import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { replay, apply } from '../src/replay.ts';
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
