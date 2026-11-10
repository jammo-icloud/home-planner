import './planner-root.ts';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cents, parseDollars } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { replay, requireReason, ReplayError } from '../src/replay.ts';
import { parseBackup, scopeOf } from '../src/restore.ts';
import { board, card, goalsOf } from '../src/plans.ts';
import { everyEntry } from './every-entry.ts';
import { attach, attachmentPath, PLANNER_ROOT, readAttachment } from '../src/attachments.ts';
import { describe as describeEvent, ProposalStore, ToolError } from '../src/tools.ts';
import { SYSTEM, householdDay, householdZone } from '../src/types.ts';
import type { Event, NewEventShape, Op } from '../src/types.ts';
import { chooseFolderIn } from './folder.ts';

const NOW = '2026-10-29T09:00:00.000Z';

const logs = new WeakMap<Store, Event[]>();
const eventsOf = (s: Store): readonly Event[] => logs.get(s)!;

/** A household of alice (owner) and bob, on a clock the test can move. */
async function store(): Promise<{ s: Store; at: (iso: string) => void }> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-plans-')), 'events.jsonl');
  let now = NOW;
  const s = new Store({ path, now: () => new Date(now) });
  await s.load();
  // The log as it was written, for the reads that take it beside the state.
  const log: Event[] = [];
  logs.set(s, log);
  const append = s.append.bind(s);
  s.append = async (...args) => { const written = await append(...args); log.push(...written); return written; };
  await s.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
  ]);
  return { s, at: (iso: string) => { now = iso; } };
}

const refused = (re: RegExp) => (e: unknown) => e instanceof ReplayError && re.test(e.message);

const create = (plan: string, extra: Record<string, unknown> = {}): NewEventShape =>
  ({ op: 'plan.create', plan, title: `Plan ${plan}`, area: 'House', ...extra }) as NewEventShape;

/** The card that puts an ask in front of the member asked. */
const askCard = (plan: string): NewEventShape => ({
  op: 'proposal.offer', tool: 'answer_ask', args: { plan }, summary: `Take ${plan}?`, effects: [],
  events: [], budget: null, month: null, envelopes: [], fingerprint: '', prompt: { kind: 'member', ref: null },
});

test('a plan is created in planning, owned by its creator, in a known area', async () => {
  const { s } = await store();
  await s.append('bob', create('p1', { title: 'Fix the gate' }));
  const p = s.state.plans.get('p1')!;
  assert.equal(p.title, 'Fix the gate');
  assert.equal(p.area, 'House');
  assert.equal(p.parent, null);
  assert.equal(p.state, 'planning');
  assert.equal(p.stateAt, NOW);
  assert.equal(p.owner, 'bob');
  assert.equal(p.createdBy, 'bob');
  assert.equal(p.createdAt, NOW);
  assert.equal(p.asked, null);
  assert.equal(p.removed, false);
  assert.deepEqual([p.chips, p.checklist, p.attachments, p.contacts, p.blocks], [[], [], [], [], []]);
  assert.deepEqual([p.notes, p.estimate, p.envelope, p.due], ['', null, null, null]);

  await assert.rejects(s.append('alice', create('p2', { area: 'Garage' })),
    refused(/"Garage" is not one of this household's areas/));
  assert.ok(!s.state.plans.has('p2'));

  // Areas come from settings once they are set, not from the defaults.
  await s.append('alice', { op: 'areas.set', areas: ['House', 'Garage'] });
  await s.append('alice', create('p2', { area: 'Garage' }));
  assert.equal(s.state.plans.get('p2')!.area, 'Garage');

  // Claude proposes plans; it never writes one.
  assert.throws(() => replay([{ id: 'c1', at: NOW, who: 'claude', ...create('p3') } as Event]), refused(/claude cannot plan\.create/));
});

test('entering doing stamps stateAt; done leaves the board', async () => {
  const { s, at } = await store();
  await s.append('alice', create('p1'));
  at('2026-10-30T10:00:00.000Z');
  await s.append('alice', { op: 'plan.state', plan: 'p1', state: 'doing' });
  assert.equal(s.state.plans.get('p1')!.state, 'doing');
  assert.equal(s.state.plans.get('p1')!.stateAt, '2026-10-30T10:00:00.000Z');
  // Saying it again does not restart the clock.
  at('2026-10-31T10:00:00.000Z');
  await s.append('alice', { op: 'plan.state', plan: 'p1', state: 'doing' });
  assert.equal(s.state.plans.get('p1')!.stateAt, '2026-10-30T10:00:00.000Z');
  // Chips never move it.
  await s.append('alice', { op: 'plan.set', plan: 'p1', chips: ['waiting on quote'] });
  assert.equal(s.state.plans.get('p1')!.state, 'doing');
  at('2026-11-02T10:00:00.000Z');
  await s.append('alice', { op: 'plan.state', plan: 'p1', state: 'done' });
  const p = s.state.plans.get('p1')!;
  assert.equal(p.state, 'done');
  assert.equal(p.stateAt, '2026-11-02T10:00:00.000Z');
  assert.equal(p.removed, false, 'done is kept, not removed');
});

test('only the owner may ask, only the asked may answer', async () => {
  const { s } = await store();
  await s.append('alice', create('p1'));
  await assert.rejects(s.append('bob', { op: 'plan.ask', plan: 'p1', to: 'alice', why: 'yours really' }),
    refused(/only the owner/));
  await assert.rejects(s.append('alice', { op: 'plan.ask', plan: 'p1', to: 'carol', why: 'help' }),
    refused(/not in this household/));
  await s.append('alice', { op: 'plan.ask', plan: 'p1', to: 'bob', why: 'you know the gate' });
  assert.deepEqual(s.state.plans.get('p1')!.asked, { to: 'bob', at: NOW, why: 'you know the gate' });
  await assert.rejects(s.append('alice', { op: 'plan.ask.accept', plan: 'p1' }), refused(/only bob/));
  await s.append('bob', { op: 'plan.ask.accept', plan: 'p1' });
  const p = s.state.plans.get('p1')!;
  assert.equal(p.owner, 'bob');
  assert.equal(p.asked, null);
  await assert.rejects(s.append('bob', { op: 'plan.ask.accept', plan: 'p1' }), refused(/nobody has been asked/));
});

test('one open ask at a time', async () => {
  const { s } = await store();
  await s.append('alice', create('p1'));
  await s.append('alice', { op: 'plan.ask', plan: 'p1', to: 'bob', why: 'first' });
  await assert.rejects(s.append('alice', { op: 'plan.ask', plan: 'p1', to: 'bob', why: 'again' }),
    refused(/already asked/));
  assert.equal(s.state.plans.get('p1')!.asked?.why, 'first');
});

test('answering an ask retires its card', async () => {
  const { s } = await store();
  await s.append('alice', [create('p1'), create('p2')]);
  for (const [answer, who] of [['plan.ask.accept', 'bob'], ['plan.ask.decline', 'bob']] as const) {
    const plan = answer === 'plan.ask.accept' ? 'p1' : 'p2';
    await s.append('alice', { op: 'plan.ask', plan, to: 'bob', why: 'please' });
    const [mine] = await s.append('alice', askCard(plan));
    const [other] = await s.append('alice', askCard('elsewhere'));
    await s.append(who, answer === 'plan.ask.accept'
      ? { op: answer, plan }
      : { op: answer, plan, why: 'no time this month' });
    assert.equal(s.state.thread.offers.get(mine!.id)?.status, 'replaced', answer);
    assert.equal(s.state.thread.offers.get(other!.id)?.status, 'open', `${answer} leaves other cards alone`);
  }
});

test('declining returns it with the reason, owner unchanged', async () => {
  const { s } = await store();
  await s.append('alice', create('p1'));
  await s.append('alice', { op: 'plan.ask', plan: 'p1', to: 'bob', why: 'you know the gate' });
  await assert.rejects(s.append('bob', { op: 'plan.ask.decline', plan: 'p1', why: '' }), /requires a reason/);
  await assert.rejects(s.append('alice', { op: 'plan.ask.decline', plan: 'p1', why: 'mine' }), refused(/only bob/));
  const [declined] = await s.append('bob', { op: 'plan.ask.decline', plan: 'p1', why: 'away until December' });
  assert.equal((declined as { why?: string }).why, 'away until December');
  const p = s.state.plans.get('p1')!;
  assert.equal(p.owner, 'alice');
  assert.equal(p.asked, null);
  // And it can be asked again.
  await s.append('alice', { op: 'plan.ask', plan: 'p1', to: 'bob', why: 'after December then' });
  assert.equal(s.state.plans.get('p1')!.asked?.to, 'bob');
});

test('a removed plan is kept but marked, and cannot be edited', async () => {
  const { s } = await store();
  await s.append('alice', create('p1', { title: 'Fix the gate' }));
  await s.append('alice', { op: 'plan.remove', plan: 'p1', why: 'sold the house' });
  const p = s.state.plans.get('p1')!;
  assert.equal(p.removed, true);
  assert.equal(p.title, 'Fix the gate');
  await assert.rejects(s.append('alice', { op: 'plan.set', plan: 'p1', title: 'Fix it anyway' }), refused(/removed/));
  await assert.rejects(s.append('alice', { op: 'plan.state', plan: 'p1', state: 'doing' }), refused(/removed/));
  await assert.rejects(s.append('alice', create('p2', { parent: 'p1' })), refused(/removed/));
  await assert.rejects(s.append('alice', { op: 'plan.set', plan: 'nope', title: 'x' }), refused(/no such plan/));
});

test('checklist replaces whole; attachments, contacts, blocks accumulate by key', async () => {
  const { s, at } = await store();
  await s.append('alice', create('p1'));
  const plan = () => s.state.plans.get('p1')!;

  await s.append('alice', { op: 'plan.checklist', plan: 'p1', items: [
    { id: 'c1', text: 'measure', done: false }, { id: 'c2', text: 'buy hinge', done: false }] });
  await s.append('alice', { op: 'plan.checklist', plan: 'p1', items: [{ id: 'c1', text: 'measure', done: true }] });
  assert.deepEqual(plan().checklist, [{ id: 'c1', text: 'measure', done: true }]);

  await s.append('alice', { op: 'plan.attach', plan: 'p1', path: 'gate.png', name: 'gate.png', size: 10 });
  at('2026-10-30T10:00:00.000Z');
  await s.append('bob', { op: 'plan.attach', plan: 'p1', path: 'quote.pdf', name: 'quote.pdf', size: 20 });
  await s.append('bob', { op: 'plan.attach', plan: 'p1', path: 'gate.png', name: 'gate.png', size: 30 });
  assert.deepEqual(plan().attachments, [
    { path: 'gate.png', name: 'gate.png', size: 30, who: 'bob', at: '2026-10-30T10:00:00.000Z' },
    { path: 'quote.pdf', name: 'quote.pdf', size: 20, who: 'bob', at: '2026-10-30T10:00:00.000Z' },
  ]);
  await s.append('alice', { op: 'plan.detach', plan: 'p1', path: 'gate.png', why: 'old photo' });
  assert.deepEqual(plan().attachments.map((a) => a.path), ['quote.pdf']);
  await assert.rejects(s.append('alice', { op: 'plan.detach', plan: 'p1', path: 'gate.png', why: 'again' }),
    refused(/no attachment/));

  await s.append('alice', { op: 'plan.contact.link', plan: 'p1', contact_id: 7, addressbook_id: 1, display: 'Gatesmith' });
  await s.append('alice', { op: 'plan.contact.link', plan: 'p1', contact_id: 9, addressbook_id: 1, display: 'Plumber' });
  await s.append('alice', { op: 'plan.contact.link', plan: 'p1', contact_id: 7, addressbook_id: 1, display: 'Gatesmith & Co' });
  assert.deepEqual(plan().contacts, [
    { contact_id: 7, addressbook_id: 1, display: 'Gatesmith & Co' },
    { contact_id: 9, addressbook_id: 1, display: 'Plumber' },
  ]);
  await s.append('alice', { op: 'plan.contact.unlink', plan: 'p1', contact_id: 7 });
  assert.deepEqual(plan().contacts.map((c) => c.contact_id), [9]);

  await s.append('alice', { op: 'plan.block', plan: 'p1', block: 'b1', start: '2026-11-01T09:00:00Z', end: '2026-11-01T11:00:00Z' });
  await s.append('alice', { op: 'plan.block', plan: 'p1', block: 'b2', start: '2026-11-08T09:00:00Z', end: '2026-11-08T11:00:00Z' });
  await s.append('alice', { op: 'plan.block', plan: 'p1', block: 'b1', start: '2026-11-01T13:00:00Z', end: '2026-11-01T15:00:00Z' });
  assert.deepEqual(plan().blocks, [
    { id: 'b1', start: '2026-11-01T13:00:00Z', end: '2026-11-01T15:00:00Z' },
    { id: 'b2', start: '2026-11-08T09:00:00Z', end: '2026-11-08T11:00:00Z' },
  ]);
  await assert.rejects(s.append('alice', { op: 'plan.block', plan: 'p1', block: 'b3',
    start: '2026-11-01T15:00:00Z', end: '2026-11-01T13:00:00Z' }), refused(/end after it starts/));
  await s.append('alice', { op: 'plan.unblock', plan: 'p1', block: 'b2', why: 'rained off' });
  assert.deepEqual(plan().blocks.map((b) => b.id), ['b1']);

  await s.append('alice', { op: 'plan.due', plan: 'p1', due: '2026-11-15' });
  assert.equal(plan().due, '2026-11-15');
  await s.append('alice', { op: 'plan.due', plan: 'p1', due: null });
  assert.equal(plan().due, null);

  await s.append('alice', { op: 'plan.set', plan: 'p1', notes: 'north side', estimate: cents(25000),
    envelope: { budget: 'harbor', envelope: 'house' } });
  assert.deepEqual([plan().notes, plan().estimate, plan().envelope],
    ['north side', 25000, { budget: 'harbor', envelope: 'house' }]);
  await s.append('alice', { op: 'plan.set', plan: 'p1', estimate: null, envelope: null });
  assert.deepEqual([plan().notes, plan().estimate, plan().envelope], ['north side', null, null]);
  await assert.rejects(s.append('alice', { op: 'plan.set', plan: 'p1', area: 'Garage' }), refused(/areas/));
});

const PLAN_OPS: readonly Op[] = [
  'plan.create', 'plan.set', 'plan.state', 'plan.ask', 'plan.ask.accept', 'plan.ask.decline',
  'plan.checklist', 'plan.attach', 'plan.detach', 'plan.contact.link', 'plan.contact.unlink',
  'plan.due', 'plan.block', 'plan.unblock', 'plan.remove', 'plan.hand',
  'plan.goal', 'goal.rename', 'goal.remove',
];

test('every plan op is in the plans scope', () => {
  assert.equal(PLAN_OPS.length, 19);
  for (const op of PLAN_OPS) {
    assert.equal(scopeOf({ id: 'i', at: NOW, who: 'alice', op } as Event), 'plans', op);
  }
});

test('reasons are required where the design says', () => {
  const needs = ['plan.remove', 'plan.ask', 'plan.ask.decline', 'plan.detach', 'plan.unblock'];
  for (const op of PLAN_OPS) {
    const e = { id: 'i', at: NOW, who: 'alice', op, plan: 'p1' } as unknown as Event;
    if (needs.includes(op)) assert.throws(() => requireReason(e), /requires a reason/, op);
    else assert.doesNotThrow(() => requireReason(e), op);
  }
  assert.doesNotThrow(() => requireReason({ id: 'i', at: NOW, who: 'alice', op: 'plan.remove', plan: 'p1', why: 'done with it' }));
});

test('an ask lapses when its plan is removed', async () => {
  const { s } = await store();
  await s.append('alice', [create('p1'), create('p2')]);
  await s.append('alice', [
    { op: 'plan.ask', plan: 'p1', to: 'bob', why: 'please' },
    { op: 'plan.ask', plan: 'p2', to: 'bob', why: 'this too' },
  ]);
  const [card] = await s.append('alice', askCard('p1'));
  const [other] = await s.append('alice', askCard('p2'));
  await s.append('alice', { op: 'plan.remove', plan: 'p1', why: 'not needed after all' });
  const p = s.state.plans.get('p1')!;
  assert.equal(p.asked, null);
  assert.equal(p.owner, 'alice');
  assert.equal(s.state.thread.offers.get(card!.id)?.status, 'replaced');
  assert.equal(s.state.thread.offers.get(other!.id)?.status, 'open', 'other plans keep their ask');
  assert.equal(s.state.plans.get('p2')!.asked?.to, 'bob');
});

test('an ask lapses when the person asked leaves the household', async () => {
  const { s } = await store();
  await s.append('alice', { op: 'member.add', member: 'carol', why: 'lodger' });
  await s.append('alice', [create('p1'), create('p2')]);
  await s.append('alice', [
    { op: 'plan.ask', plan: 'p1', to: 'bob', why: 'please' },
    { op: 'plan.ask', plan: 'p2', to: 'carol', why: 'you have the van' },
  ]);
  const [bobs] = await s.append('alice', askCard('p1'));
  const [carols] = await s.append('alice', askCard('p2'));
  await s.append('alice', { op: 'member.remove', member: 'bob', why: 'moved out' });
  const p = s.state.plans.get('p1')!;
  assert.equal(p.asked, null);
  assert.equal(p.owner, 'alice');
  assert.equal(s.state.thread.offers.get(bobs!.id)?.status, 'replaced');
  assert.equal(s.state.plans.get('p2')!.asked?.to, 'carol', 'other members keep their asks');
  assert.equal(s.state.thread.offers.get(carols!.id)?.status, 'open');
  // The owner can ask again.
  await s.append('alice', { op: 'plan.ask', plan: 'p1', to: 'carol', why: 'bob has gone' });
  assert.equal(s.state.plans.get('p1')!.asked?.to, 'carol');
});

describe('the fold owns the plan rules', () => {
  /** Lines no route or tool would write, each with what the fold says about it. */
  const long = (n: number) => 'x'.repeat(n);
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ['a state not in the set', { op: 'plan.state', plan: 'p1', state: 'banana' }, /state is one of planning, doing, done/],
    ['a checklist with no items', { op: 'plan.checklist', plan: 'p1' }, /a checklist is a list/],
    ['a checklist item twice', { op: 'plan.checklist', plan: 'p1', items: [
      { id: 'a', text: 'one', done: false }, { id: 'a', text: 'two', done: false }] }, /each item appears once/],
    ['a checklist item with no text', { op: 'plan.checklist', plan: 'p1', items: [{ id: 'a', text: ' ', done: false }] },
      /an item cannot be empty/],
    ['a checklist item over 500', { op: 'plan.checklist', plan: 'p1', items: [{ id: 'a', text: long(501), done: false }] },
      /an item is longer than 500/],
    ['a title over 200', { op: 'plan.create', plan: 'p9', title: long(201), area: 'House' }, /a title is longer than 200/],
    ['a blank title', { op: 'plan.set', plan: 'p1', title: '  ' }, /a title cannot be empty/],
    ['chips that are not a list', { op: 'plan.set', plan: 'p1', chips: 'quote' }, /chips must be a list/],
    ['a blank chip', { op: 'plan.set', plan: 'p1', chips: ['quote', ''] }, /a chip cannot be empty/],
    ['a chip over 40', { op: 'plan.set', plan: 'p1', chips: [long(41)] }, /a chip is longer than 40/],
    ['notes over 20,000', { op: 'plan.set', plan: 'p1', notes: long(20_001) }, /notes are longer than 20,000/],
    ['notes that are not text', { op: 'plan.set', plan: 'p1', notes: 7 }, /notes are text/],
    ['an estimate in part cents', { op: 'plan.set', plan: 'p1', estimate: 1.5 }, /whole number/],
    ['a block that ends first', { op: 'plan.block', plan: 'p1', block: 'b', start: '2026-11-01T11:00:00Z',
      end: '2026-11-01T09:00:00Z' }, /a block must end after it starts/],
    ['a block with no times', { op: 'plan.block', plan: 'p1', block: 'b', start: 'Saturday', end: 7 },
      /start and end are dates and times/],
    ['a due date that is not a day', { op: 'plan.due', plan: 'p1', due: 'soon' }, /a due date is a day/],
    ['a line with no plan', { op: 'plan.state', state: 'doing' }, /names its plan/],
  ];

  test('a malformed plan line is refused by name through a real store, never as a TypeError', async () => {
    const { s } = await store();
    await s.append('alice', create('p1'));
    for (const [what, line, said] of bad) {
      await assert.rejects(s.append('alice', line as unknown as NewEventShape),
        (e: unknown) => e instanceof ReplayError && said.test(e.message), what);
    }
    assert.equal(s.state.plans.get('p1')!.state, 'planning', 'nothing was written');
  });

  test('a hand-edited log and a backup skip the same lines, with the same reasons', async () => {
    const { s } = await store();
    await s.append('alice', create('p1'));
    const lines = bad.map(([, line], i) => JSON.stringify({ id: `bad-${i}`, at: NOW, who: 'alice', ...line }));
    await appendFile(s.path, lines.join('\n') + '\n', 'utf8');

    const reloaded = new Store({ path: s.path });
    const report = await reloaded.load();
    assert.equal(report.skipped.length, bad.length);
    bad.forEach(([what, , said], i) => assert.match(report.skipped[i]!.reason, said, what));
    assert.equal(reloaded.state.plans.get('p1')!.state, 'planning');

    const backup = parseBackup([...eventsOf(s).map((e) => JSON.stringify(e)), ...lines].join('\n'));
    assert.equal(backup.skipped.length, bad.length);
    bad.forEach(([what, , said], i) => assert.match(backup.skipped[i]!, said, what));
  });

  test('only a member of the household writes on its board', async () => {
    const { s } = await store();
    await s.append('alice', create('p1'));
    const notMember = refused(/mallory is not a member of this household/);
    await assert.rejects(s.append('mallory', create('p2')), notMember);
    await assert.rejects(s.append('mallory', { op: 'plan.state', plan: 'p1', state: 'doing' }), notMember);
    await assert.rejects(s.append('mallory', { op: 'thread.note', text: 'hello', budget: null, plan: 'p1' }), notMember);
    await assert.rejects(s.append('mallory', { op: 'thread.ask', question: 'how much?', budget: null, plan: 'p1' }),
      notMember);
    assert.ok(!s.state.plans.has('p2'));
    // A member who has left is not one any more.
    await s.append('alice', { op: 'member.remove', member: 'bob', why: 'moved out' });
    await assert.rejects(s.append('bob', { op: 'plan.state', plan: 'p1', state: 'doing' }),
      refused(/bob is not a member of this household/));
    // Replaying a log does the same: a line from outside the household stops it.
    assert.throws(() => replay([...eventsOf(s), { id: 'g1', at: NOW, who: 'mallory', ...create('p3') } as Event]),
      notMember);
    // A guest is not a member either, and is refused as a guest before that.
    await assert.rejects(s.append('guest:mallory@example.com', create('p4')), refused(/a guest cannot plan\.create/));
  });

  test('removing a plan retires every card still waiting to change it', async () => {
    const { s } = await store();
    await s.append('alice', [create('p1'), create('p2')]);
    const card = (plan: string, events: NewEventShape[], extra: Record<string, unknown> = {}): NewEventShape => ({
      op: 'proposal.offer', tool: 'set_plan_due', args: { plan }, summary: 'x', effects: [], events,
      budget: null, month: null, envelopes: [], fingerprint: '', prompt: { kind: 'research', ref: null }, ...extra,
    }) as NewEventShape;
    const [due] = await s.append('claude', card('p1', [{ op: 'plan.due', plan: 'p1', due: '2026-12-01' }], { plan: 'p1' }));
    const [item] = await s.append('claude', { ...card('p1', [create('p1-a', { parent: 'p1' })]), tool: 'create_plan',
      args: { title: 'Plan p1-a', area: 'House', parent: 'p1' } } as NewEventShape);
    const [other] = await s.append('claude', card('p2', [{ op: 'plan.due', plan: 'p2', due: '2026-12-01' }], { plan: 'p2' }));
    const [removal] = await s.append('alice', { op: 'plan.remove', plan: 'p1', why: 'not needed' });
    assert.equal(s.state.thread.offers.get(due!.id)?.status, 'replaced');
    assert.equal(s.state.thread.offers.get(due!.id)?.replacedBy, removal!.id);
    assert.equal(s.state.thread.offers.get(item!.id)?.status, 'replaced', 'a new item for its shelf too');
    assert.equal(s.state.thread.offers.get(other!.id)?.status, 'open', 'cards on other plans are left alone');
  });
});

describe('shelves are retired', () => {
  test('old shelf lines still fold, and only a parent that is no live plan is refused', async () => {
    const { s } = await store();
    await s.append('alice', [{ op: 'areas.set', areas: ['House', 'Garden'] }, create('p1'), create('p2', { parent: 'p1' }),
      create('p3', { parent: 'p2' }), create('p4', { parent: 'p1', area: 'Garden' }), { op: 'plan.state', plan: 'p1', state: 'doing' },
      { op: 'plan.set', plan: 'p2', area: 'Garden' }, { op: 'plan.set', plan: 'p1', area: 'Garden' }]);
    assert.equal(s.state.plans.get('p3')!.area, 'Garden');                 // plans under a plan still move with it
    await s.append('alice', { op: 'plan.remove', plan: 'p1', why: 'done with it' });
    await assert.rejects(s.append('alice', create('p5', { parent: 'nope' })), refused(/no such plan: nope/));
  });
  test('one line from system turns each shelf into a goal on it and on its plans', async () => {
    const { s } = await store();
    const plan = (id: string) => s.state.plans.get(id)!;
    await s.append('alice', [create('kitchen', { title: 'Kitchen refresh' }), create('hinge', { parent: 'kitchen' }), create('tap', { parent: 'kitchen' }),
      create('gone', { parent: 'kitchen' }), { op: 'plan.remove', plan: 'gone', why: 'not needed' }, create('alone'),
      { op: 'plan.goal', plan: 'tap', goal: 'Summer trip' }, { op: 'plan.state', plan: 'hinge', state: 'doing' },
      create('long', { title: 'A'.repeat(70) }), create('long1', { parent: 'long' }),            // the label is cut to its first 60
      create('roof', { title: 'new  ROOF' }), create('roof1', { parent: 'roof' }), create('c'), { op: 'plan.goal', plan: 'c', goal: 'New roof' }]);
    await assert.rejects(s.append('alice', { op: 'shelves.retire' }), refused(/shelves\.retire is written by system/));
    const [retired] = await s.append(SYSTEM, { op: 'shelves.retire' });
    assert.deepEqual(['kitchen', 'hinge', 'tap', 'alone', 'long1', 'roof', 'roof1'].map((id) => plan(id).goal),
      ['Kitchen refresh', 'Kitchen refresh', 'Summer trip', null, 'A'.repeat(60), 'New roof', 'New roof']);   // a goal that matches gives its spelling
    assert.deepEqual([...s.state.plans.values()].filter((p) => !p.removed && p.parent !== null), []);
    assert.deepEqual([plan('hinge').state, plan('kitchen').owner, scopeOf(retired!)], ['doing', 'alice', 'plans']);
    assert.deepEqual([...s.state.plans.values()].filter((p) => p.pageEvent === retired!.id).map((p) => p.id).sort(), ['hinge', 'long1', 'roof1', 'tap']);
    // An emoji at the cut is left out whole, never halved; one that fits in the 60 is kept.
    await s.append('alice', [create('house', { title: `${'B'.repeat(59)}🏠 tail` }), create('house1', { parent: 'house' }),
      create('home', { title: `${'C'.repeat(58)}🏠X` }), create('home1', { parent: 'home' })]);
    await s.append(SYSTEM, { op: 'shelves.retire' });
    assert.deepEqual([plan('house1').goal, plan('home1').goal], ['B'.repeat(59), `${'C'.repeat(58)}🏠`]);
    await s.append('alice', { op: 'goal.remove', goal: `${'C'.repeat(58)}🏠` });             // a goal a later line can name
    await s.append('alice', { op: 'plan.state', plan: 'kitchen', state: 'doing' });         // an ordinary plan now
    await s.append('bob', { op: 'goal.rename', from: 'Kitchen refresh', to: 'Kitchen' });   // later goal lines win on every replay
    assert.equal(replay(eventsOf(s)).plans.get('hinge')!.goal, 'Kitchen');
    assert.ok(!(await everyEntry(s, 'bob')).entries.some((e) => e.id === retired!.id));
  });
});

describe('board and card', () => {
  const TODAY = '2026-10-29';
  const names = (cards: { id: string }[]) => cards.map((c) => c.id);
  const view = (s: Store, o: Partial<Parameters<typeof board>[2]> = {}) =>
    board(s.state, eventsOf(s), { who: 'everyone', today: TODAY, ...o }).rows;
  const row = (s: Store, area: string, o: Partial<Parameters<typeof board>[2]> = {}) =>
    view(s, o).find((r) => r.area === area)!;

  /** A household with a budget whose October is open, so a plan can point at an envelope. */
  async function withBudget() {
    const t = await store();
    await t.s.append('alice', [
      { op: 'category.define', category: 'repairs', label: 'Repairs' },
      { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
      { op: 'envelope.define', budget: 'harbor', envelope: 'house', label: 'House upkeep', group: 'House',
        match: { categories: ['repairs'] }, template: parseDollars('100.00'), rollover: false, order: 0 },
      { op: 'month.open', budget: 'harbor', month: '2026-10', income: parseDollars('1000.00') },
      { op: 'txn.add', txns: [
        { id: 'x1', date: '2026-10-05', payee: 'HARDWARE', amount: parseDollars('-35.50'), dedupeKey: 'x1', category: 'repairs' },
      ] },
    ]);
    return t;
  }

  test('one row per area, in the order the household set them', async () => {
    const { s } = await store();
    await s.append('alice', { op: 'areas.set', areas: ['Yard', 'House', 'Car'] });
    await s.append('alice', [create('p1', { area: 'House' }), create('p2', { area: 'Yard' })]);
    const rows = view(s);
    assert.deepEqual(rows.map((r) => r.area), ['Yard', 'House', 'Car']);
    assert.deepEqual(names(rows[0]!.plans), ['p2']);
    assert.deepEqual(names(rows[1]!.plans), ['p1']);
    assert.deepEqual([rows[2]!.plans, rows[2]!.done, rows[2]!.all], [[], [], { plans: 0, doing: 0, done: 0 }]);
  });

  test('areas with no plans are rows: a household with no plans at all still lists every area, empty', async () => {
    const { s } = await store();
    await s.append('alice', { op: 'areas.set', areas: ['House', 'Garden'] });
    assert.equal(s.state.plans.size, 0);
    for (const who of ['everyone', 'alice', 'casey']) {
      const rows = view(s, { who });
      assert.deepEqual(rows.map((r) => r.area), ['House', 'Garden'], `pressing ${who} lists every area`);
      for (const r of rows) assert.deepEqual([r.plans, r.done], [[], []]);
    }
  });

  test('only Doing has a clock: Planning and done carry no age, on the board or the card', async () => {
    const { s, at } = await store();
    await s.append('alice', [create('p1'), create('p2')]);
    at('2026-11-20T09:00:00.000Z');
    await s.append('alice', [{ op: 'plan.state', plan: 'p2', state: 'doing' }, { op: 'plan.state', plan: 'p2', state: 'done' }]);
    const later = '2026-12-31';
    assert.equal(row(s, 'House', { today: later }).plans[0]!.daysInState, null, 'weeks in Planning, and no age');
    assert.equal(card(s.state, eventsOf(s), 'p1', { who: 'alice', today: later }).daysInState, null);
    assert.equal(row(s, 'House', { today: later }).done[0]!.daysInState, null, 'done has stopped');
    assert.equal(card(s.state, eventsOf(s), 'p2', { who: 'alice', today: later }).daysInState, null);
  });

  test('daysInState is whole days since the plan entered Doing, and 0 on the day', async () => {
    const { s, at } = await store();
    await s.append('alice', create('p1'));
    at('2026-10-29T23:30:00.000Z');
    await s.append('alice', { op: 'plan.state', plan: 'p1', state: 'doing' });
    const days = (today: string) => row(s, 'House', { today }).plans[0]!.daysInState;
    assert.equal(days('2026-10-29'), 0);
    assert.equal(days('2026-11-01'), 3);
    assert.equal(days('2026-10-20'), 0, 'a clock behind the log never reads negative');
    // Saying the same state again does not restart it.
    at('2026-10-31T09:00:00.000Z');
    await s.append('alice', { op: 'plan.state', plan: 'p1', state: 'doing' });
    assert.equal(days('2026-11-01'), 3);
    // Month and year boundaries count calendar days.
    at('2026-12-30T09:00:00.000Z');
    await s.append('alice', { op: 'plan.state', plan: 'p1', state: 'planning' });
    await s.append('alice', { op: 'plan.state', plan: 'p1', state: 'doing' });
    assert.equal(days('2027-01-02'), 3);
  });

  test('the Doing clock counts the household\'s days, not UTC\'s', async () => {
    const { s, at } = await store();
    await s.append('alice', create('p1'));
    // 23:30 on the 28th in Denver, which is already the 29th in UTC.
    at('2026-10-29T05:30:00.000Z');
    await s.append('alice', { op: 'plan.state', plan: 'p1', state: 'doing' });
    const tz = 'America/Denver';
    assert.equal(row(s, 'House', { today: '2026-10-29', tz }).plans[0]!.daysInState, 1);
    assert.equal(card(s.state, eventsOf(s), 'p1', { who: 'alice', today: '2026-10-29', tz }).daysInState, 1);
    assert.equal(row(s, 'House', { today: '2026-10-28', tz }).plans[0]!.daysInState, 0, '0 on the local day');
  });

  test('one way to read a day: the zone given or the deployment\'s, trimmed, and UTC without either', () => {
    const at = '2026-10-29T05:30:00.000Z'; // 23:30 on the 28th in Denver
    assert.equal(householdDay('America/Denver', at), '2026-10-28');
    assert.equal(householdDay('  America/Denver ', at), '2026-10-28', 'spaces round a zone are not part of it');
    assert.equal(householdDay('UTC', new Date(at)), '2026-10-29');
    const was = process.env['TZ'];
    try {
      process.env['TZ'] = ' America/Denver ';
      assert.equal(householdZone(), 'America/Denver');
      assert.equal(householdDay(undefined, at), '2026-10-28');
      process.env['TZ'] = ' ';
      assert.equal(householdZone(), 'UTC', 'a blank TZ is no zone');
      assert.equal(householdDay(null, at), '2026-10-29');
    } finally {
      if (was === undefined) delete process.env['TZ']; else process.env['TZ'] = was;
    }
  });

  test('with no zone given, the clock reads the deployment\'s TZ, and UTC without one', async () => {
    const { s, at } = await store();
    await s.append('alice', create('p1'));
    at('2026-10-29T05:30:00.000Z');
    await s.append('alice', { op: 'plan.state', plan: 'p1', state: 'doing' });
    const days = () => [
      row(s, 'House', { today: '2026-10-29' }).plans[0]!.daysInState,
      card(s.state, eventsOf(s), 'p1', { who: 'alice', today: '2026-10-29' }).daysInState,
    ];
    const was = process.env['TZ'];
    try {
      process.env['TZ'] = 'America/Denver';
      assert.deepEqual(days(), [1, 1]);
      process.env['TZ'] = ' ';
      assert.deepEqual(days(), [0, 0], 'blank is no zone');
      delete process.env['TZ'];
      assert.deepEqual(days(), [0, 0]);
      process.env['TZ'] = 'America/Denver';
      assert.equal(row(s, 'House', { today: '2026-10-29', tz: 'UTC' }).plans[0]!.daysInState, 0, 'a zone given wins');
    } finally {
      if (was === undefined) delete process.env['TZ']; else process.env['TZ'] = was;
    }
  });

  test('a board card carries what the board shows', async () => {
    const { s } = await withBudget();
    await s.append('alice', create('p1', { title: 'Fix the gate' }));
    await s.append('alice', [
      { op: 'plan.set', plan: 'p1', chips: ['waiting on quote'], estimate: parseDollars('250.00'),
        envelope: { budget: 'harbor', envelope: 'house' } },
      { op: 'plan.due', plan: 'p1', due: '2026-11-15' },
      { op: 'plan.block', plan: 'p1', block: 'k1', start: '2026-11-14T09:00:00.000Z', end: '2026-11-14T11:00:00.000Z' },
      { op: 'plan.ask', plan: 'p1', to: 'bob', why: 'you know the gate' },
    ]);
    const c = row(s, 'House').plans[0]!;
    assert.deepEqual(c, {
      id: 'p1', title: 'Fix the gate', area: 'House', goal: null, state: 'planning', owner: 'alice',
      asked: { to: 'bob', at: NOW, why: 'you know the gate' },
      chips: ['waiting on quote'], due: '2026-11-15',
      blocks: [{ id: 'k1', start: '2026-11-14T09:00:00.000Z', end: '2026-11-14T11:00:00.000Z' }],
      envelope: { budget: 'harbor', envelope: 'house', label: 'House upkeep', left: '$65' },
      daysInState: null, hasResearch: false,
      // Its due date has no event: set here with no NAS behind it.
      notOnCalendar: true, doneAt: null,
    });
  });

  test('a card has an envelope only when the figures are there to show', async () => {
    const { s } = await withBudget();
    await s.append('alice', create('p1'));
    await s.append('alice', { op: 'plan.set', plan: 'p1', envelope: { budget: 'harbor', envelope: 'house' } });
    const left = (today: string) => row(s, 'House', { today }).plans[0]!.envelope;
    assert.equal(left('2026-10-29')?.left, '$65');
    assert.equal(left('2026-11-02'), null, 'November is not open, so nothing is made up for it');
    await s.append('alice', { op: 'plan.set', plan: 'p1', envelope: null });
    assert.equal(left('2026-10-29'), null);
  });

  test('hasResearch is true once an answer was given for the plan', async () => {
    const { s } = await store();
    await s.append('alice', [create('p1'), create('p2')]);
    const [q] = await s.append('alice', { op: 'thread.ask', question: 'What would a gate hinge cost?', budget: null, plan: 'p1' });
    const has = () => Object.fromEntries(row(s, 'House').plans.map((c) => [c.id, c.hasResearch]));
    assert.deepEqual(has(), { p1: false, p2: false }, 'a question is not research until it is answered');
    await s.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'About $40.', tools: [], model: 'm', plan: 'p1' });
    assert.deepEqual(has(), { p1: true, p2: false });
  });

  test("research on a card points to its page", async () => {
    const { s } = await store();
    await s.append('alice', create('p1'));
    const [q] = await s.append('alice', { op: 'thread.ask', question: 'What would a gate hinge cost?', budget: null, plan: 'p1' });
    const doc = { link: 'f3c1', file_id: '881', hash: 'abc', version_id: '1', path: '/team-folders/Planner/h1/answers/a-gate-hinge.md' };
    await s.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'About $40.', tools: [], model: 'm', plan: 'p1', doc });
    await s.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'A strap hinge.', tools: [], model: 'm', plan: 'p1' });
    const v = card(s.state, eventsOf(s), 'p1', { who: 'alice', today: TODAY });
    assert.equal(v.research[0]!.text, 'About $40.', 'the headline');
    assert.deepEqual(v.research[0]!.doc, { path: doc.path }, 'where the rest is, and nothing else of the document');
    assert.ok(!('doc' in v.research[1]!), 'an answer kept in the log names no page');
  });

  test("the card names its own page by where it is, and nothing else of it", async () => {
    const { s } = await store();
    await s.append('alice', create('p1'));
    assert.equal(card(s.state, eventsOf(s), 'p1', { who: 'alice', today: TODAY }).page, null, 'no page written yet');
    const doc = { link: 'f9e2', file_id: '882', hash: 'abc', version_id: '3', path: '/team-folders/Planner/h1/p1/plan.md' };
    await s.append('alice', { op: 'plan.doc', plan: 'p1', doc, event: s.state.plans.get('p1')!.pageEvent });
    const v = card(s.state, eventsOf(s), 'p1', { who: 'alice', today: TODAY });
    assert.deepEqual(v.page, { path: doc.path });
    assert.ok(!('pageEvent' in v), 'the page event is bookkeeping');
    for (const kept of [doc.link, doc.file_id, doc.version_id]) assert.ok(!JSON.stringify(v).includes(`"${kept}"`), kept);
  });

  test('card() resolves the envelope label and what is left, and how long the estimate takes to fund', async () => {
    const { s } = await withBudget();
    await s.append('alice', create('p1', { title: 'Fix the gate' }));
    let v = card(s.state, eventsOf(s), 'p1', { who: 'alice', today: TODAY });
    assert.equal(v.money, null, 'no envelope, no money');
    await s.append('alice', { op: 'plan.set', plan: 'p1', estimate: parseDollars('250.00'),
      envelope: { budget: 'harbor', envelope: 'house' } });
    v = card(s.state, eventsOf(s), 'p1', { who: 'alice', today: TODAY });
    assert.deepEqual(v.money, { label: 'House upkeep', left: '$65', estimate: '$250', monthsAtFunding: 3 });
    assert.equal(v.estimate, parseDollars('250.00'), 'the plan itself comes through whole');
    assert.equal(v.title, 'Fix the gate');

    await s.append('alice', { op: 'plan.set', plan: 'p1', estimate: null });
    v = card(s.state, eventsOf(s), 'p1', { who: 'alice', today: TODAY });
    assert.deepEqual(v.money, { label: 'House upkeep', left: '$65', estimate: null, monthsAtFunding: null });
    assert.equal(card(s.state, eventsOf(s), 'p1', { who: 'alice', today: '2026-11-02' }).money, null);
  });

  test('card() brings together the research, the notes between us, and the history', async () => {
    const { s, at } = await store();
    await s.append('alice', [create('p1', { title: 'Fix the gate' }), create('p2')]);
    at('2026-10-29T10:00:00.000Z');
    const [q] = await s.append('alice', { op: 'thread.ask', question: 'What hinge?', budget: null, plan: 'p1' });
    const [a1] = await s.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'A strap hinge.', tools: [], model: 'm', plan: 'p1' });
    const [a2] = await s.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'About $40.', tools: [], model: 'm' });
    const [o1] = await s.append('claude', ({ ...askCard('p1'), summary: 'Add hinge to the list', prompt: { kind: 'answer', ref: a1!.id } } as NewEventShape));
    await s.append('claude', ({ ...askCard('p1'), summary: 'Elsewhere', prompt: { kind: 'answer', ref: a2!.id } } as NewEventShape));
    at('2026-10-29T11:00:00.000Z');
    await s.append('bob', { op: 'thread.note', text: 'I can pick one up Saturday', budget: null, plan: 'p1' });
    await s.append('bob', { op: 'thread.note', text: 'About something else', budget: null, plan: 'p2' });
    await s.append('bob', { op: 'thread.note', text: 'No plan at all', budget: null });
    await s.append('alice', { op: 'plan.state', plan: 'p1', state: 'doing' });
    await s.append('alice', { op: 'plan.state', plan: 'p2', state: 'doing' });

    const v = card(s.state, eventsOf(s), 'p1', { who: 'alice', today: TODAY });
    assert.equal(v.research.length, 1, 'only an answer given for this plan');
    assert.equal(v.research[0]!.id, a1!.id);
    assert.equal(v.research[0]!.at, '2026-10-29T10:00:00.000Z');
    assert.equal(v.research[0]!.text, 'A strap hinge.');
    assert.deepEqual(v.research[0]!.suggestions.map((o) => [o.id, o.summary]), [[o1!.id, 'Add hinge to the list']]);
    assert.deepEqual(v.between.map((n) => [n.who, n.text, n.at]),
      [['bob', 'I can pick one up Saturday', '2026-10-29T11:00:00.000Z']]);
    assert.deepEqual(v.history.map((h) => [h.who, h.what]), [
      ['alice', 'made a plan: Fix the gate'],
      ['alice', 'asked: What hinge?'],
      ['claude', 'answered a question'],
      ['bob', 'left a note: I can pick one up Saturday'],
      ['alice', 'moved Fix the gate to doing'],
    ], 'oldest first, only this plan\'s events');
    assert.equal(v.history[0]!.at, NOW);
  });

  /** House and Money. alice: p1 (Planning), p2 (Doing), p5 (done), all toward New roof. bob: p3 (Doing), and p4 in Money toward New roof. casey: nothing. */
  async function roofBoard() {
    const { s } = await store();
    await s.append('alice', [{ op: 'member.add', member: 'casey', why: 'moved in' }, { op: 'areas.set', areas: ['House', 'Money'] },
      create('p1'), create('p2'), create('p3'), create('p4', { area: 'Money' }), create('p5'),
      ...['p1', 'p2', 'p4', 'p5'].map((plan): NewEventShape => ({ op: 'plan.goal', plan, goal: 'New roof' })),
      { op: 'plan.state', plan: 'p2', state: 'doing' }, { op: 'plan.state', plan: 'p3', state: 'doing' }, { op: 'plan.state', plan: 'p5', state: 'done' },
      { op: 'plan.hand', plan: 'p3', to: 'bob' }, { op: 'plan.hand', plan: 'p4', to: 'bob' }]);
    const see = (o: { who: string; goal?: string | null }) => board(s.state, eventsOf(s), { today: '2026-10-29', tz: 'UTC', ...o });
    return { s, see };
  }
  const ids = (cards: readonly { id: string }[]) => cards.map((c) => c.id);
  test("everyone: every area, open plans Doing first then in the log's order, done apart, the counts beside", async () => {
    const { see } = await roofBoard();
    const b = see({ who: 'everyone' });
    assert.deepEqual([b.who, b.goal, b.areas], ['everyone', null, ['House', 'Money']]);
    assert.deepEqual(b.rows.map((r) => [r.area, r.all, ids(r.plans), ids(r.done)]), [
      ['House', { plans: 3, doing: 2, done: 1 }, ['p2', 'p3', 'p1'], ['p5']], ['Money', { plans: 1, doing: 0, done: 0 }, ['p4'], []]]);
    assert.deepEqual(b.members, [{ member: 'alice', plans: 2 }, { member: 'bob', plans: 2 }]);
    assert.deepEqual(b.goals, [{ goal: 'New roof', plans: 4, done: 1 }]);
    const p5 = b.rows[0]!.done[0]!;
    assert.deepEqual([p5.goal, p5.doneAt, 'parent' in p5, b.rows[0]!.plans[0]!.doneAt], ['New roof', NOW, false, null]);
  });
  test('a member: strictly what they own, even when that is nothing; an old ask puts nothing in their view', async () => {
    const { s, see } = await roofBoard();
    const bob = see({ who: 'bob' });
    assert.deepEqual([bob.who, bob.rows.map((r) => ids(r.plans)), bob.rows[0]!.all], ['bob', [['p3'], ['p4']], { plans: 3, doing: 2, done: 1 }]);
    await s.append('alice', { op: 'plan.ask', plan: 'p1', to: 'casey', why: 'you offered' });
    const casey = see({ who: 'casey' });
    assert.deepEqual([casey.who, casey.rows.flatMap((r) => [...r.plans, ...r.done])], ['casey', []]);
    assert.deepEqual(casey.members, [{ member: 'alice', plans: 2 }, { member: 'bob', plans: 2 }]);    // the counts ignore who is pressed
    assert.equal(see({ who: 'everyone' }).rows[0]!.plans.find((c) => c.id === 'p1')!.asked!.to, 'casey');   // the briefing still reads it
  });
  test('a goal: its stored spelling, done plans counted, members with none left out; a goal nobody has filters nothing', async () => {
    const { see } = await roofBoard();
    const g = see({ who: 'everyone', goal: 'new roof' });
    assert.equal(g.goal, 'New roof');
    assert.deepEqual(g.rows.map((r) => [ids(r.plans), ids(r.done)]), [[['p2', 'p1'], ['p5']], [['p4'], []]]);
    assert.deepEqual(g.members, [{ member: 'alice', plans: 3 }, { member: 'bob', plans: 1 }]);
    assert.deepEqual(see({ who: 'bob', goal: 'New roof' }).rows.map((r) => ids(r.plans)), [[], ['p4']]);
    const none = see({ who: 'everyone', goal: 'Old roof' });
    assert.deepEqual([none.goal, none.rows[0]!.plans.length], [null, 3]);
  });
  test('done plans are listed newest first, and a removed plan is never shown or counted', async () => {
    const { s, at } = await store();
    await s.append('alice', [create('a'), create('b'), create('c')]);
    await s.append('alice', { op: 'plan.state', plan: 'a', state: 'done' });
    at('2026-10-30T09:00:00.000Z');
    await s.append('alice', [{ op: 'plan.state', plan: 'b', state: 'done' }, { op: 'plan.remove', plan: 'c', why: 'not needed' }]);
    const r = row(s, 'House');
    assert.deepEqual([ids(r.plans), ids(r.done), r.all], [[], ['b', 'a'], { plans: 0, doing: 0, done: 2 }]);
  });
  test('the card carries its owner fields and every goal, and no shelf', async () => {
    const { s } = await roofBoard();
    const v = card(s.state, eventsOf(s), 'p3', { who: 'alice', today: '2026-10-29', tz: 'UTC' });
    assert.deepEqual([v.owner, v.ownerFrom, v.ownerSince, v.createdBy, v.goal], ['bob', 'alice', NOW, 'alice', null]);
    assert.deepEqual([v.goals, v.shelf, v.children], [[{ goal: 'New roof', plans: 4, done: 1 }], null, []]);
    assert.ok(v.history.some((h) => h.what === 'handed Plan p3 to bob'));
  });

  test('an unknown plan is a 404, and so is a removed one', async () => {
    const { s } = await store();
    await s.append('alice', create('p1'));
    await s.append('alice', { op: 'plan.remove', plan: 'p1', why: 'x' });
    for (const id of ['nope', 'p1']) {
      assert.throws(() => card(s.state, eventsOf(s), id, { who: 'alice', today: TODAY }),
        (e: unknown) => e instanceof ToolError && e.status === 404, id);
    }
  });

  test('the plan ops read as sentences, with names rather than ids', async () => {
    const { s } = await withBudget();
    await s.append('alice', create('p1', { title: 'Fix the gate' }));
    const say = (o: Record<string, unknown>) =>
      describeEvent({ id: 'i', at: NOW, who: 'alice', ...o } as never, s.state).what;
    assert.equal(say({ op: 'plan.create', plan: 'p1', title: 'Fix the gate', area: 'House' }), 'made a plan: Fix the gate');
    assert.equal(say({ op: 'plan.create', plan: 'p3', title: 'Hinge', area: 'House', parent: 'p1' }), 'made a plan: Hinge');
    assert.equal(say({ op: 'plan.state', plan: 'p1', state: 'doing' }), 'moved Fix the gate to doing');
    assert.equal(say({ op: 'plan.ask', plan: 'p1', to: 'bob', why: 'w' }), 'asked bob to take Fix the gate');
    assert.equal(say({ op: 'plan.ask.accept', plan: 'p1' }), 'took on Fix the gate');
    assert.equal(say({ op: 'plan.ask.decline', plan: 'p1', why: 'w' }), 'declined Fix the gate');
    assert.equal(say({ op: 'plan.attach', plan: 'p1', path: 'plans/p1/gate.png', name: 'gate.png', size: 10 }), 'attached gate.png to Fix the gate');
    assert.equal(say({ op: 'plan.detach', plan: 'p1', path: 'plans/p1/gate.png', why: 'w' }), 'took gate.png off Fix the gate');
    assert.equal(say({ op: 'plan.due', plan: 'p1', due: '2026-11-15' }), 'set Fix the gate due 2026-11-15');
    assert.equal(say({ op: 'plan.due', plan: 'p1', due: null }), 'cleared the due date on Fix the gate');
    assert.equal(say({ op: 'plan.remove', plan: 'p1', why: 'w' }), 'removed Fix the gate');
    assert.equal(say({ op: 'plan.set', plan: 'p1', notes: 'n', estimate: null }), 'changed the notes and estimate on Fix the gate');
    // A plan the state does not know falls back to its id, never to nothing.
    assert.equal(say({ op: 'plan.state', plan: 'zz', state: 'done' }), 'moved zz to done');
  });
});

describe('rulings', () => {
  test('moving a shelf to another area takes its live plans with it', async () => {
    const { s } = await store();
    await s.append('alice', [create('shelf'), create('a', { parent: 'shelf' }), create('b', { parent: 'shelf' }),
      create('gone', { parent: 'shelf' }), create('elsewhere')]);
    await s.append('alice', { op: 'plan.remove', plan: 'gone', why: 'not needed' });
    await s.append('alice', { op: 'plan.set', plan: 'shelf', area: 'Trips' });
    const area = (id: string) => s.state.plans.get(id)!.area;
    assert.deepEqual([area('shelf'), area('a'), area('b')], ['Trips', 'Trips', 'Trips']);
    assert.equal(area('gone'), 'House', 'a removed plan is history and stays where it was');
    assert.equal(area('elsewhere'), 'House');
  });

  test('a removed member\'s plans pass to the member who removed them', async () => {
    const { s } = await store();
    await s.append('bob', [create('mine'), create('done')]);
    await s.append('bob', { op: 'plan.state', plan: 'done', state: 'done' });
    await s.append('bob', create('offered'));
    await s.append('bob', { op: 'plan.ask', plan: 'offered', to: 'alice', why: 'you said you would' });
    const [offeredCard] = await s.append('bob', askCard('offered'));
    await s.append('bob', create('gone'));
    await s.append('bob', { op: 'plan.remove', plan: 'gone', why: 'dropped it' });
    await s.append('alice', create('hers'));
    await s.append('alice', { op: 'plan.ask', plan: 'hers', to: 'bob', why: 'please' });
    await s.append('alice', { op: 'member.remove', member: 'bob', why: 'moved out' });
    const owner = (id: string) => s.state.plans.get(id)!.owner;
    assert.equal(owner('mine'), 'alice');
    assert.equal(owner('done'), 'alice');
    assert.equal(owner('gone'), 'bob', 'a removed plan is history, and keeps its owner');
    assert.equal(owner('hers'), 'alice');
    assert.equal(s.state.plans.get('hers')!.asked, null, 'the ask to bob still lapses');
    // Bob's ask to alice answers itself when the plan becomes hers.
    assert.equal(owner('offered'), 'alice');
    assert.equal(s.state.plans.get('offered')!.asked, null);
    assert.equal(s.state.thread.offers.get(offeredCard!.id)?.status, 'replaced');
    // Now hers to hand on.
    await s.append('alice', { op: 'plan.state', plan: 'mine', state: 'doing' });
  });

  test('a plan that passes to the remover comes with no open ask', async () => {
    const { s } = await store();
    await s.append('alice', { op: 'member.add', member: 'carol', why: 'lodger' });
    await s.append('bob', create('van'));
    await s.append('bob', { op: 'plan.ask', plan: 'van', to: 'carol', why: 'you have the van' });
    const [card] = await s.append('bob', askCard('van'));
    await s.append('alice', { op: 'member.remove', member: 'bob', why: 'moved out' });
    const p = s.state.plans.get('van')!;
    assert.equal(p.owner, 'alice');
    assert.equal(p.asked, null, 'bob asked; bob is gone, so the ask goes with him');
    assert.equal(s.state.thread.offers.get(card!.id)?.status, 'replaced');
    // The new owner starts clean and may ask again.
    await s.append('alice', { op: 'plan.ask', plan: 'van', to: 'carol', why: 'still yours if you want it' });
    assert.equal(s.state.plans.get('van')!.asked?.to, 'carol');
  });

  test('an area that live plans still use cannot be dropped', async () => {
    const { s } = await store();
    await s.append('alice', [create('p1', { area: 'Trips' }), create('p2', { area: 'People' }), create('p3', { area: 'Money' })]);
    await s.append('alice', { op: 'plan.remove', plan: 'p3', why: 'never mind' });
    await assert.rejects(s.append('alice', { op: 'areas.set', areas: ['House'] }),
      refused(/^"People" still has plans in it/));
    await assert.rejects(s.append('alice', { op: 'areas.set', areas: ['House', 'People'] }),
      refused(/^"Trips" still has plans in it/));
    assert.deepEqual(s.state.settings.areas, ['House', 'Money', 'People', 'Trips']);
    // A removed plan does not hold an area; nor does a done one once it is removed.
    await s.append('alice', { op: 'areas.set', areas: ['House', 'People', 'Trips'] });
    assert.deepEqual(s.state.settings.areas, ['House', 'People', 'Trips']);
  });
});

describe('attachmentPath', () => {
  const refused = (name: string) => (e: unknown) => e instanceof ToolError && e.status === 400 && e.message.length > 0;

  /** A household whose documents live in Planner/rivera. */
  const rivera = async (): Promise<Store> => {
    const { s } = await store();
    await chooseFolderIn(s, { team: 'Planner', folder: 'rivera' });
    return s;
  };

  test("a card's file is under the chosen folder; with none, files are off, naming the owner", async () => {
    const { s } = await store();
    assert.throws(() => attachmentPath(s.state, 'p1', 'gate.png'),
      (e: unknown) => e instanceof ToolError && e.status === 409 && e.message === 'Files on cards are off until alice chooses where documents live, in Settings.');
    await chooseFolderIn(s, { team: 'Planner', folder: 'rivera' });
    assert.equal(attachmentPath(s.state, 'p1', 'gate.png'), '/Planner/rivera/p1/gate.png');
    assert.equal(attachmentPath(s.state, 'p1', 'Quote from Sandoval (v2).pdf'), '/Planner/rivera/p1/Quote from Sandoval (v2).pdf');
  });

  test('with no folder, a file already on a card is not read either, and the NAS is not asked', async () => {
    const { s } = await store();
    await s.append('alice', [create('gate'), { op: 'plan.attach', plan: 'gate', path: '/Planner/h1/gate/quote.pdf', name: 'quote.pdf', size: 1 }]);
    const fileCtx = { store: s, who: 'alice', today: '2026-10-29', proposals: new ProposalStore(), sid: 'S', household: 'h1' };
    const nas = (() => { throw new Error('the NAS was asked'); }) as never;
    await assert.rejects(() => readAttachment(fileCtx, 'gate', 'quote.pdf', nas),
      (e: unknown) => e instanceof ToolError && e.status === 409 && e.message === 'Files on cards are off until alice chooses where documents live, in Settings.');
  });

  test('PLANNER_ROOT is not where a file goes, only the chosen folder', async () => {
    assert.equal(PLANNER_ROOT, '/Planner');
    const s = await rivera();
    await chooseFolderIn(s, { team: 'Shared', folder: 'homes/rivera' });
    assert.equal(attachmentPath(s.state, 'p1', 'gate.png'), '/Shared/homes/rivera/p1/gate.png');
  });

  test('a name that could leave the folder, or that File Station cannot read back, is a plain 400', async () => {
    const s = await rivera();
    for (const name of ['../etc', '..', '.', 'a/b.png', 'a\\b.png', 'tab\there', 'nul\u0000', 'bell\u007f',
      'a,b.png', 'x'.repeat(201), '', '   ', '%2e%2e', '50%.png']) {
      assert.throws(() => attachmentPath(s.state, 'p1', name), refused(name), JSON.stringify(name));
    }
    assert.doesNotThrow(() => attachmentPath(s.state, 'p1', 'x'.repeat(200)));
  });

  test('the plan is held to the same rules', async () => {
    const s = await rivera();
    assert.throws(() => attachmentPath(s.state, '../p2', 'gate.png'), refused('plan'));
    assert.throws(() => attachmentPath(s.state, 'a,b', 'gate.png'), refused('plan'));
    assert.throws(() => attachmentPath(s.state, '%2e%2e', 'gate.png'), /the plan cannot contain %/);
  });
});

test("plan.md is the plan's page: a file by that name is refused", async () => {
  const { s } = await store();
  await chooseFolderIn(s);
  await s.append('alice', create('gate'));
  // No sid: the refusal has to come before the NAS session is asked for.
  const fileCtx = { store: s, who: 'alice', today: '2026-10-29', proposals: new ProposalStore(), sid: null, household: 'home' };
  for (const name of ['plan.md', 'Plan.MD', 'PLAN.md']) {
    await assert.rejects(() => attach(fileCtx, 'gate', { name, bytes: new Uint8Array(1) }),
      (e: unknown) => e instanceof ToolError && e.status === 409
        && e.message === "plan.md is the plan's own page in Drive; give this file another name", name);
  }
  assert.equal(s.state.plans.get('gate')!.attachments.length, 0);
});

describe('handing a plan on', () => {
  const gate = create('gate', { title: 'Fix the fence gate' });
  const LATER = '2026-11-09T10:00:00.000Z';
  const owned = (s: Store, id = 'gate') => { const p = s.state.plans.get(id)!; return [p.owner, p.ownerSince, p.ownerFrom]; };
  test('any member gives one away, takes one, or moves one between two others', async () => {
    const { s, at } = await store();
    await s.append('alice', [{ op: 'member.add', member: 'casey', why: 'moved in' }, gate, { op: 'plan.state', plan: 'gate', state: 'doing' }]);
    assert.deepEqual([...owned(s), s.state.plans.get('gate')!.goal], ['alice', NOW, null, null]);
    at(LATER);
    const [gave] = await s.append('alice', { op: 'plan.hand', plan: 'gate', to: 'bob', why: 'you have the drill' });
    assert.deepEqual(owned(s), ['bob', LATER, 'alice']);
    assert.deepEqual([s.state.plans.get('gate')!.state, s.state.plans.get('gate')!.stateAt], ['doing', NOW]);   // the Doing clock is untouched
    const [took] = await s.append('alice', { op: 'plan.hand', plan: 'gate', to: 'alice' });
    const [moved] = await s.append('casey', { op: 'plan.hand', plan: 'gate', to: 'bob' });
    assert.deepEqual([gave, took, moved].map((e) => s.state.hands.get(e!.id)), [
      { plan: 'gate', from: 'alice', to: 'bob' }, { plan: 'gate', from: 'bob', to: 'alice' }, { plan: 'gate', from: 'alice', to: 'bob' }]);
    assert.deepEqual([gave, took, moved].map((e) => describeEvent(e!, s.state).what), [
      'handed Fix the fence gate to bob', 'took Fix the fence gate from bob', 'handed Fix the fence gate from alice to bob']);
    assert.deepEqual([describeEvent(gave!, s.state).why, scopeOf(gave!)], ['you have the drill', 'plans']);
  });
  test('the fold refuses a hand that moves nothing, an outsider at either end, a long word and a removed plan', async () => {
    const { s } = await store();
    await s.append('alice', gate);
    const hand = (who: string, extra: Record<string, unknown>) => s.append(who, { op: 'plan.hand', plan: 'gate', to: 'bob', ...extra } as NewEventShape);
    await assert.rejects(hand('bob', { to: 'alice' }), refused(/Fix the fence gate is already alice's/));
    await assert.rejects(hand('alice', { to: 'casey' }), refused(/casey is not in this household/));
    await assert.rejects(hand('carol', {}), refused(/carol is not a member of this household/));
    await assert.rejects(hand('alice', { why: 'x'.repeat(301) }), refused(/a reason is longer than 300 characters/));
    await s.append('alice', { op: 'plan.remove', plan: 'gate', why: 'sold the house' });
    await assert.rejects(hand('alice', {}), refused(/has been removed/));
  });
  test('a hand settles an open ask, and is still there after another write and after a reload', async () => {
    const { s } = await store();
    await s.append('alice', [gate, { op: 'plan.ask', plan: 'gate', to: 'bob', why: 'you have the drill' }]);
    await s.append('alice', askCard('gate'));
    const [hand] = await s.append('bob', { op: 'plan.hand', plan: 'gate', to: 'bob' });
    assert.deepEqual([s.state.plans.get('gate')!.asked, [...s.state.thread.offers.values()][0]!.status], [null, 'replaced']);
    await s.append('alice', { op: 'plan.set', plan: 'gate', chips: ['fence'] });      // a thaw and a freeze
    for (const state of [s.state, replay(eventsOf(s))]) assert.deepEqual(state.hands.get(hand!.id), { plan: 'gate', from: 'alice', to: 'bob' });
  });
  test('a third member handing a plan to someone else closes an open ask on it', async () => {
    const { s } = await store();
    await s.append('alice', [{ op: 'member.add', member: 'casey', why: 'moved in' }, gate, { op: 'plan.ask', plan: 'gate', to: 'bob', why: 'you have the drill' }]);
    await s.append('alice', askCard('gate'));
    await s.append('casey', { op: 'plan.hand', plan: 'gate', to: 'bob' });
    assert.deepEqual([...owned(s), s.state.plans.get('gate')!.asked, [...s.state.thread.offers.values()][0]!.status], ['bob', NOW, 'alice', null, 'replaced']);
  });
  test('taking an ask, and losing a member, stamp the owner fields too', async () => {
    const { s, at } = await store();
    await s.append('alice', [gate, create('shed'), { op: 'plan.ask', plan: 'gate', to: 'bob', why: 'yours?' }]);
    at(LATER);
    await s.append('bob', { op: 'plan.ask.accept', plan: 'gate' });
    assert.deepEqual(owned(s), ['bob', LATER, 'alice']);
    const REMOVED = '2026-11-09T11:00:00.000Z';
    at(REMOVED);
    await s.append('alice', { op: 'member.remove', member: 'bob', why: 'moved out' });
    assert.deepEqual([owned(s), owned(s, 'shed')], [['alice', REMOVED, 'bob'], ['alice', NOW, null]]);
  });
  test('Today says a hand in one line that names both ends, with the word as its reason', async () => {
    const { s } = await store();
    await s.append('alice', gate);
    const [hand] = await s.append('alice', { op: 'plan.hand', plan: 'gate', to: 'bob', why: 'you have the drill' });
    const e = (await everyEntry(s, 'bob')).entries.find((x) => x.id === hand!.id)!;
    assert.ok(e.kind === 'change');
    assert.deepEqual([e.what, e.why, e.hand], ['handed Fix the fence gate to bob', 'you have the drill',
      { plan: { id: 'gate', title: 'Fix the fence gate' }, from: 'alice', to: 'bob' }]);
  });
});

describe('goals', () => {
  const toward = (plan: string, goal: string | null): NewEventShape => ({ op: 'plan.goal', plan, goal });
  const goalOf = (s: Store, ...ids: string[]) => ids.map((id) => s.state.plans.get(id)!.goal);
  test('a goal begins when a plan carries it, keeps its first spelling, and is allowed in any state', async () => {
    const { s } = await store();
    await s.append('alice', [create('p1'), create('p2'), toward('p1', 'New roof'), toward('p2', 'new ROOF')]);
    assert.deepEqual(goalOf(s, 'p1', 'p2'), ['New roof', 'New roof']);
    const was = s.state.plans.get('p1');
    await s.append('alice', [toward('p1', 'New roof'), create('p3'), toward('p3', null)]);   // the same again, and none off none
    assert.equal(s.state.plans.get('p1'), was);
    await s.append('bob', [{ op: 'plan.state', plan: 'p2', state: 'done' }, toward('p2', null), toward('p2', 'New roof')]);
    assert.deepEqual(goalsOf(s.state), [{ goal: 'New roof', plans: 2, done: 1 }]);
    for (const bad of [' New roof', 'New  roof', '', 'x'.repeat(61)]) {
      await assert.rejects(s.append('alice', toward('p3', bad)), refused(/a goal is 1 to 60 characters, with single spaces and none around it/));
    }
    await s.append('alice', { op: 'plan.remove', plan: 'p1', why: 'sold the house' });
    await assert.rejects(s.append('alice', toward('p1', null)), refused(/has been removed/));
    assert.deepEqual(goalsOf(s.state), [{ goal: 'New roof', plans: 1, done: 1 }]);     // a removed plan's goal counts for nothing
  });
  test('a goal is renamed and removed on every plan that carries it, and never merged', async () => {
    const { s } = await store();
    await s.append('alice', [create('p1'), create('p2'), create('p3'), toward('p1', 'New roof'), toward('p2', 'New roof'), toward('p3', 'Summer trip')]);
    const rename = (who: string, from: string, to: string) => s.append(who, { op: 'goal.rename', from, to });
    await assert.rejects(rename('alice', 'Old roof', 'Roof'), refused(/there is no goal called Old roof/));
    await assert.rejects(rename('alice', 'New roof', 'summer trip'), refused(/"Summer trip" is already a goal/));
    await assert.rejects(rename('alice', 'new roof', 'New roof'), refused(/New roof is already its name/));
    await assert.rejects(rename('carol', 'New roof', 'Roof'), refused(/carol is not a member of this household/));
    // Every goal op is a member's alone: removing a goal and setting one on a plan are refused to a non-member too.
    await assert.rejects(s.append('carol', { op: 'goal.remove', goal: 'New roof' }), refused(/carol is not a member of this household/));
    await assert.rejects(s.append('carol', toward('p3', 'New roof')), refused(/carol is not a member of this household/));
    assert.deepEqual(goalOf(s, 'p1', 'p2', 'p3'), ['New roof', 'New roof', 'Summer trip'], 'nothing was written');
    const [renamed] = await rename('bob', 'new roof', 'NEW ROOF');                       // a change of case alone is a rename
    assert.deepEqual(goalsOf(s.state), [{ goal: 'NEW ROOF', plans: 2, done: 0 }, { goal: 'Summer trip', plans: 1, done: 0 }]);
    const [removed] = await s.append('bob', { op: 'goal.remove', goal: 'new roof' });
    assert.deepEqual(goalOf(s, 'p1', 'p2', 'p3'), [null, null, 'Summer trip']);
    await assert.rejects(s.append('bob', { op: 'goal.remove', goal: 'New roof' }), refused(/there is no goal called New roof/));
    const said = ['renamed the goal new roof to NEW ROOF', 'removed the goal new roof'];
    assert.deepEqual([renamed, removed].map((e) => describeEvent(e!, s.state).what), said);
    const lines = (await everyEntry(s, 'alice')).entries.flatMap((e) => (e.kind === 'change' ? [e.what] : []));
    assert.deepEqual(lines.filter((w) => /goal/.test(w)), said);                          // and setting one on a plan is no line
  });
});
