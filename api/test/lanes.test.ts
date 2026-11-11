import './planner-root.ts';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LANES, TOOL_LANES, cardLane, isLane, laneOf } from '../src/lanes.ts';
import { toolByName } from '../src/tools.ts';

const state = { pageDrifts: new Map([['pd1', {}]]) } as never;
const lane = (op: string, extra = {}) => laneOf({ op, ...extra } as never, state);

const WANT = {
  budget: ['assign', 'move', 'income.set', 'month.open', 'month.close', 'month.discard', 'txn.add', 'txn.categorize', 'txn.split', 'txn.remove', 'rule.add', 'rule.remove', 'envelope.define', 'envelope.remove', 'envelopes.model', 'bill.set', 'bill.remove', 'household.locate', 'category.define', 'category.archive', 'category.sinking', 'income.source.define', 'income.source.remove', 'account.balance', 'savings.account'],
  calendar: ['calendar.appointment', 'calendar.appointment.remove', 'calendar.appointment.change', 'calendar.household', 'calendar.household.rename', 'calendar.target', 'guest.allow', 'guest.revoke', 'guests.arrival', 'guests.booking', 'booking.block', 'booking.unblock', 'booking.confirm', 'booking.cancel', 'booking.suggest', 'booking.release'],
  plans: ['plan.create', 'plan.state', 'plan.remove', 'plan.due', 'plan.block', 'plan.unblock', 'plan.attach', 'plan.detach', 'plan.hand', 'areas.set', 'areas.rename', 'areas.add', 'areas.remove', 'goal.rename', 'goal.remove'],
  notes: ['household.claim', 'member.add', 'member.remove', 'household.zone', 'links.set', 'documents.folder', 'thread.note'],
  claude: ['thread.briefing', 'thread.ask'],
};
const NONE = ['briefing.read', 'prediction.record', 'flag.seen', 'scheme.set', 'calendar.conflicts', 'plan.doc', 'documents.moved', 'thread.answer', 'proposal.offer', 'proposal.decide', 'plan.set', 'plan.checklist', 'plan.contact.link', 'plan.contact.unlink', 'plan.calendar.link', 'plan.calendar.unlink', 'plan.calendar.etag', 'plan.page.drift', 'calendar.drift', 'plan.ask', 'plan.ask.accept', 'plan.ask.decline', 'plan.goal', 'areas.move', 'shelves.retire'];

describe('lanes', () => {
  for (const [name, ops] of Object.entries(WANT)) {
    test(`${name} ops`, () => {
      for (const op of ops) assert.equal(lane(op), name, op);
    });
  }

  test('ops that raise no entry of their own have no lane', () => {
    for (const op of NONE) assert.equal(lane(op), null, op);
  });

  test('a resolved drift follows what drifted', () => {
    assert.equal(lane('calendar.drift.resolve', { drift: 'd1' }), 'calendar');
    assert.equal(lane('calendar.drift.resolve', { drift: 'pd1' }), 'plans');
  });

  test('every write tool has a lane', () => {
    assert.deepEqual([...toolByName.values()].filter((t) => t.kind === 'write' && !(t.name in TOOL_LANES)).map((t) => t.name), []);
    assert.equal(TOOL_LANES['ask_to_take'], 'plans');
  });

  test('a card has the lane of its tool', () => {
    const o = (tool: string, events: unknown[] = [], ref: string | null = null) => ({ tool, events, prompt: { kind: 'member', ref } }) as never;
    assert.equal(cardLane(o('propose_event'), state), 'calendar');
    assert.equal(cardLane(o('resolve_drift', [], 'd1'), state), 'calendar');
    assert.equal(cardLane(o('resolve_drift', [], 'pd1'), state), 'plans');
    assert.equal(cardLane(o('move_money'), state), 'budget');
  });

  test('a tool only an old log knows falls back to its first event', () => {
    const o = (events: unknown[]) => ({ tool: 'gone_tool', events, prompt: { kind: 'member', ref: null } }) as never;
    assert.equal(cardLane(o([{ op: 'plan.state' }]), state), 'plans');
    assert.equal(cardLane(o([{ op: 'plan.set' }]), state), 'budget');
    assert.equal(cardLane(o([]), state), 'budget');
  });

  test('the five lanes in order', () => {
    assert.deepEqual([...LANES], ['budget', 'calendar', 'plans', 'claude', 'notes']);
    assert.equal(isLane('plans'), true);
    assert.equal(isLane('thread'), false);
    assert.equal(isLane(null), false);
  });
});
