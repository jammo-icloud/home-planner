import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cents } from '../src/money.ts';
import { replay, requireReason } from '../src/replay.ts';
import { monthView } from '../src/envelopes.ts';
import { firstRun } from '../src/first-run.ts';
import { APPROVE_IN_ONE, TOOLS } from '../src/tools.ts';
import { REQUIRES_WHY } from '../src/types.ts';
import type { Event } from '../src/types.ts';
import type { DistributiveOmit } from '../src/util-types.ts';

let seq = 0;
type EvInput = DistributiveOmit<Event, 'id' | 'at' | 'who'> & { id?: string; at?: string; who?: string };
const ev = (e: EvInput): Event =>
  ({ id: `e${++seq}`, at: `2026-11-01T00:00:0${seq % 10}Z`, who: 'alice', ...e }) as Event;
const claim = ev({ op: 'household.claim', label: 'Home' });
const pick = (f: { step: unknown; started: boolean }) => ({ step: f.step, started: f.started });

describe('one budget per household', () => {
  test('a household holds its envelopes, months and bills directly', () => {
    const s = replay([claim, ev({ op: 'category.define', category: 'groceries', label: 'Groceries' }),
      ev({ op: 'envelope.define', envelope: 'groc', label: 'Groceries', group: 'Food', match: { categories: ['groceries'] }, template: cents(60000) }),
      ev({ op: 'month.open', month: '2026-11', income: cents(500000) })]);
    assert.deepEqual([...s.envelopes.keys()], ['groc']);
    assert.equal(s.months.get('2026-11')?.income, 500000);
    assert.equal('budgets' in s, false);
    assert.equal(monthView(s, '2026-11')?.envelopes[0]?.envelope.id, 'groc');
  });
  for (const op of ['budget.create', 'budget.rename', 'budget.archive', 'budget.locate']) {
    test(`${op} is not an op`, () => assert.throws(() => replay([claim, ev({ op, budget: 'x', label: 'X' } as never)]), new RegExp(`unknown op: ${op.replace('.', '\\.')}`)));
  }
  test('household.locate says where the household is, and needs a reason', () => {
    const s = replay([claim, ev({ op: 'household.locate', location: { label: 'Springfield, IL', postal: '62701' }, why: 'where we live' })]);
    assert.deepEqual(s.location, { label: 'Springfield, IL', postal: '62701' });
    assert.throws(() => requireReason(ev({ op: 'household.locate', location: null } as never)));   // the store's append runs it
    assert.ok(REQUIRES_WHY.has('household.locate'));
  });
  test('no tool takes a budget, and the budget tools are gone', () => {
    for (const t of TOOLS) assert.equal(JSON.stringify(t.input).includes('"budget"'), false, t.name);
    assert.deepEqual(TOOLS.map((t) => t.name).filter((n) => ['create_budget', 'rename_budget', 'archive_budget', 'compare_budgets', 'set_budget_location'].includes(n)), []);
    assert.ok(APPROVE_IN_ONE.has('set_location'));
  });
  test('first run: where it is, then income, then envelopes', () => {
    const today = '2026-11-10';
    assert.deepEqual(pick(firstRun(replay([claim]), today)), { step: 'where', started: false });
    const located = replay([claim, ev({ op: 'household.locate', location: { label: 'Springfield, IL' }, why: 'w' })]);
    assert.deepEqual(pick(firstRun(located, today)), { step: 'income', started: true });
    // Where it is skipped and the month opened: the income step is done, so Envelopes, though nothing has started it.
    const skipped = replay([claim, ev({ op: 'month.open', month: '2026-11', income: cents(0) })]);
    assert.deepEqual(pick(firstRun(skipped, today)), { step: 'envelopes', started: false });
  });
});
