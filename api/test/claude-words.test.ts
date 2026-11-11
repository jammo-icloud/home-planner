// What Claude reads speaks of one budget: envelopes a person sorts each receipt
// into, under categories that are only headings. Nothing names budgets as a
// choice, categorises a receipt, or plans a move to another place.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cents } from '../src/money.ts';
import { replay } from '../src/replay.ts';
import { snapshot } from '../src/analytics.ts';
import { METHOD_RULES } from '../src/claude.ts';
import { SYSTEM as SYSTEM_FOR_MATCH } from '../src/match.ts';
import { TOOLS } from '../src/tools.ts';
import { facts, plainMonth } from '../src/briefing.ts';
import type { Snapshot } from '../src/analytics.ts';
import type { Event, State } from '../src/types.ts';

const FORBIDDEN = /\bbudgets\b|categori[sz]|uncategor|two layers|interpretation|every budget|other budget|compare_budgets|create_budget|the other place|moved to|moving to|fed by/i;

test('nothing Claude reads names budgets as a choice, categorises a receipt or plans a move', () => {
  const texts = [METHOD_RULES, SYSTEM_FOR_MATCH, ...TOOLS.flatMap((t) => [t.description, JSON.stringify(t.input)])];
  assert.deepEqual(texts.filter((t) => FORBIDDEN.test(t)).map((t) => t.slice(0, 80)), []);
  assert.match(METHOD_RULES, /exactly one envelope/);
  assert.match(METHOD_RULES, /CATEGORIES?, which are only headings/);
  // What stays: the plan and its adjustments, transfers and income sorted as such, and the first sentence of the old paragraph.
  assert.match(METHOD_RULES, /opens with a PLAN[\s\S]*an ADJUSTMENT layered on top/);
  assert.match(METHOD_RULES, /sorted as a transfer, and income as income, and no envelope\s+counts either\./);
  assert.match(METHOD_RULES, /Assume they know the method and do not need it explained\.\n\n/);
  assert.doesNotMatch(METHOD_RULES, /habit|place-bound|transferable/);
});

let seq = 0;
const ev = (e: Record<string, unknown>): Event =>
  ({ id: `e${++seq}`, at: `2026-11-01T00:00:0${seq % 10}Z`, who: 'alice', ...e }) as Event;

/** A claimed household: Food over Groceries ($500), November opened at $500, and `n` receipts with no envelope. */
function withToSort(n: number): { snap: Snapshot; state: State } {
  const state = replay([
    ev({ op: 'household.claim', label: 'Home' }),
    ev({ op: 'category.add', category: 'food', label: 'Food' }),
    ev({ op: 'envelope.define', envelope: 'groceries', label: 'Groceries', category: 'food', template: cents(50000) }),
    ev({ op: 'month.open', month: '2026-11', income: cents(50000) }),
    ev({ op: 'txn.add', txns: Array.from({ length: n }, (_, i) => ({
      id: `u${i}`, date: `2026-11-0${i + 1}`, payee: 'UNKNOWN SHOP', amount: cents(-1000), dedupeKey: `u${i}`, envelope: null,
    })) }),
  ]);
  return { snap: snapshot(state, '2026-11', '2026-11-10')!, state };
}
const snapWithToSort = (n: number): Snapshot => withToSort(n).snap;
const briefingFacts = (n: number): string => { const { snap, state } = withToSort(n); return facts(snap, state, [], [], '2026-11-10'); };

test("the briefing's own words say To sort", () => {
  // the fallback briefing over a snapshot with 3 receipts in To sort
  assert.match(plainMonth(snapWithToSort(3), 0).headline, /^3 receipts to sort$/);
  assert.match(plainMonth(snapWithToSort(1), 0).headline, /^1 receipt to sort$/);
  assert.doesNotMatch(briefingFacts(3), /UNCATEGORISED|no envelope here/);
  assert.match(briefingFacts(3), /^TO SORT: 3 receipts — \$30 out, \$0 in, oldest 2026-11-01/m);
  assert.match(briefingFacts(1), /^TO SORT: 1 receipt — /m);
  assert.match(briefingFacts(3), /^BUDGET: 2026-11$/m);
});
