import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { replay, apply } from '../src/replay.ts';
import { monthView } from '../src/envelopes.ts';
import { goalFor } from '../src/sinking.ts';
import { figuresOf, readLog } from './household-figures.ts';

/**
 * One household's log in the 0.10.0 words, and every figure the budget gives
 * from it, frozen when it was written. Nothing in the tree regenerates the
 * frozen file: a later task that moves a figure here has changed what a
 * household sees, and says so, or is wrong.
 */
const FROZEN = JSON.parse(readFileSync(new URL('./fixtures/household-log.figures.json', import.meta.url), 'utf8'));
/** October's CORNER BISTRO, split between Dining and the Gym that was removed. */
const splitId = 't17';

describe('the household log reads the same figures', () => {
  test('every figure, every month, four days of each', () => assert.deepEqual(figuresOf(replay(readLog())), FROZEN));
  test('month by month, so a figure that moves names its month and day', () => {
    const now = figuresOf(replay(readLog()));
    assert.deepEqual(Object.keys(now.months), Object.keys(FROZEN.months));
    for (const key of Object.keys(FROZEN.months)) assert.deepEqual(now.months[key], FROZEN.months[key], key);
  });
  test('replayed one line at a time, the same', () => {
    let s = replay([]);
    for (const e of readLog()) s = apply(s, [e]);
    assert.deepEqual(figuresOf(s), FROZEN);
  });
  test('worked by hand', () => {
    const s = replay(readLog());
    assert.deepEqual(FROZEN.categories.map(([id]: string[]) => id), ['utilities', 'home', 'food', 'sinking', 'fun', 'kids']);
    assert.deepEqual(FROZEN.toSort.txnIds.length, 4, 'October and November gym, the October split, UNKNOWN SHOP');
    assert.deepEqual(new Map(FROZEN.toSort.missing).get(splitId), ['gym']);
    const view = (m: string, id: string) => monthView(s, m)!.envelopes.find((e) => e.envelope.id === id);
    assert.deepEqual([view('2026-08', 'gym')?.removed, view('2026-08', 'gym')?.activity], [true, 4000]);
    assert.equal(view('2026-10', 'dining')!.activity, 5000, "the split's live part still counts");
    assert.equal(view('2026-10', 'groceries')!.activity, 14015);
    assert.equal(view('2026-11', 'water')!.activity, 4800);
    assert.equal(view('2026-11', 'gym'), undefined);
    assert.equal(view('2026-11', 'gym-2')!.activity, 0, 'the old receipts are not pulled back');
    assert.equal(goalFor(s, s.envelopes.get('roof')!, '2026-11')?.monthly, 2500);
  });
});
