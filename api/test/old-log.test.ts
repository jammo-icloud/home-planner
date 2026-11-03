import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { replay } from '../src/replay.ts';
import { monthView } from '../src/envelopes.ts';
import type { Event, State } from '../src/types.ts';

/**
 * A log written before sinking funds, replayed by today's code. The snapshot
 * beside it was taken from the code as it stood before any of their fields
 * existed, so a new optional field that changed an old answer fails here.
 */
const LOG = new URL('./fixtures/old-log.jsonl', import.meta.url);
const SNAPSHOT = new URL('./fixtures/old-log.state.json', import.meta.url);

const events = (): Event[] =>
  readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Event);

/** The state as plain JSON: maps as their entries in order, sets as lists. */
export const plain = (v: unknown): unknown => {
  if (v instanceof Map) return [...v.entries()].map(([k, x]) => [plain(k), plain(x)]);
  if (v instanceof Set) return [...v].map(plain);
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};

/** Fields added since the snapshot, each with the value an old log must replay to. */
const ADDED: Record<string, unknown> = {
  savings: { account: null, balances: [] },
  documents: { folder: null, previous: null, docs: [], waiting: [], relinked: [] },
};

describe('a log from before sinking funds', () => {
  test('replays to the state it always did', () => {
    const state = plain(replay(events())) as Record<string, unknown>;
    for (const [key, empty] of Object.entries(ADDED)) {
      assert.deepEqual(state[key], empty, `${key} starts empty for an old log`);
      delete state[key];
    }
    assert.deepEqual(state, JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
  });

  test('every month reads the same figures', () => {
    const state: State = replay(events());
    for (const month of ['2026-09', '2026-10']) {
      const view = monthView(state, 'harbor', month)!;
      const rows = view.envelopes.map((e) => [e.envelope.id, e.planned, e.funded, e.carried, e.activity, e.available]);
      assert.deepEqual(rows, month === '2026-09'
        ? [['food', 110000, 105000, 0, 8421, 96579], ['auto', 10000, 25000, 0, 40000, -15000], ['power', 15000, 15000, 0, 12000, 3000]]
        : [['food', 110000, 110000, 96579, 9150, 197429], ['auto', 10000, 10000, -15000, 60000, -65000], ['power', 15000, 15000, 0, 0, 15000]]);
    }
  });
});
