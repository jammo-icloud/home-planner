import './planner-root.ts';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { daysOf, thread, threadDay } from '../src/thread.ts';
import type { DayWindow, ThreadEntry } from '../src/thread.ts';
import type { Event, NewEventShape, State } from '../src/types.ts';
import { everyEntry } from './every-entry.ts';

const D = '2026-11-10';
const state = { members: new Set(['alice', 'bob', 'casey']) } as unknown as State;
const W: Pick<DayWindow, 'from' | 'to'> = { from: '2026-11-01', to: '2026-11-30' };
const lit = (e: Record<string, unknown>): ThreadEntry => e as unknown as ThreadEntry;
const note = (id: string, day: string, who: string, over: Record<string, unknown> = {}): ThreadEntry =>
  lit({ kind: 'note', id, at: `${day}T10:00:00.000Z`, who, text: 'x', budget: null, lane: 'notes', day, ...over });
const brief = (id: string, day: string, over: Record<string, unknown> = {}): ThreadEntry =>
  lit({ kind: 'briefing', id, at: `${day}T08:00:00.000Z`, source: 'household', budget: null, day, headline: 'h', body: null,
    writtenBy: 'claude', lane: 'claude', ...over });
const card = (id: string, day: string, who: string, over: Record<string, unknown> = {}): ThreadEntry =>
  lit({ kind: 'card', id, at: `${day}T11:00:00.000Z`, who, offer: {}, lane: 'budget', day, ...over });
const pick = (rows: ReturnType<typeof daysOf>) => rows.map((r) => [r.day, r.count, r.total]);

describe('daysOf', () => {
  test('a kind narrows count, never total', () => {
    const es = [note('a', D, 'alice'), note('b', D, 'alice', { lane: 'budget' }), brief('c', D)];
    assert.deepEqual(pick(daysOf(es, state, 'alice', W)), [[D, 3, 3]]);
    assert.deepEqual(pick(daysOf(es, state, 'alice', { ...W, lane: 'budget' })), [[D, 1, 3]]);
  });

  test('under a pressed person the briefing is shown, not counted', () => {
    const es = [note('a', D, 'bob'), brief('c', D)];
    assert.deepEqual(pick(daysOf(es, state, 'alice', { ...W, who: 'bob' })), [[D, 1, 2]]);
  });

  test('a card a person\'s question raised adds to waiting and fresh, not to count', () => {
    const es = [
      note('q', D, 'bob', { lane: 'claude', kind: 'ask' }),
      card('c', D, 'claude', { raised: { how: 'answer', entry: 'q', day: D, at: D, by: 'bob' }, waits: true, fresh: true }),
    ];
    const [r] = daysOf(es, state, 'alice', { ...W, who: 'bob' });
    assert.deepEqual([r!.count, r!.waiting, r!.fresh], [1, 1, 1]);
  });

  test('by is the viewer, members in order, Claude, then guests by name', () => {
    const es = [
      note('g', D, 'guest:d@example.com', { name: 'Dana' }), note('cl', D, 'claude'), note('c', D, 'casey'),
      note('b', D, 'bob'), note('a', D, 'alice'),
    ];
    const [r] = daysOf(es, state, 'alice', { ...W, who: 'bob' });
    assert.deepEqual(r!.by.map((b) => b.name ?? b.who), ['alice', 'bob', 'casey', 'claude', 'Dana']);
  });

  test('an app card and a fallback briefing leave by empty', () => {
    const es = [card('c', D, 'bob', { app: true }), brief('f', D, { writtenBy: 'fallback' })];
    assert.deepEqual(daysOf(es, state, 'alice', W)[0]!.by, []);
  });

  test('newest first, inside the window, no row for a day with no entry', () => {
    const es = [note('a', '2026-11-03', 'alice'), note('b', '2026-11-09', 'alice'), note('c', '2026-10-31', 'alice')];
    assert.deepEqual(daysOf(es, state, 'alice', W).map((r) => r.day), ['2026-11-09', '2026-11-03']);
  });

  test('only keeps the words of a search', () => {
    const es = [note('a', D, 'alice'), note('b', D, 'alice')];
    assert.deepEqual(pick(daysOf(es, state, 'alice', { ...W, only: new Set(['a']) })), [[D, 1, 2]]);
  });
});

const NOW = '2026-11-10T17:00:00.000Z';

async function household() {
  const clock = { now: '2026-07-01T17:00:00.000Z' };
  const path = join(await mkdtemp(join(tmpdir(), 'pb-days-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(clock.now) });
  await store.load();
  await store.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'household.zone', zone: 'America/Denver' },
    { op: 'member.add', member: 'bob', why: 'x' },
    { op: 'member.add', member: 'casey', why: 'x' },
    { op: 'category.define', category: 'groceries', label: 'Groceries' },
    { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
    { op: 'envelope.define', budget: 'harbor', envelope: 'food', label: 'Food', group: 'People',
      match: { categories: ['groceries'] }, template: parseDollars('600.00'), order: 0 },
    { op: 'month.open', budget: 'harbor', month: '2026-11', income: parseDollars('1000.00') },
  ]);
  clock.now = NOW;
  return { store, clock };
}

const offerRaw = (summary: string, prompt: { kind: string; ref: string | null } = { kind: 'briefing', ref: null }, over: Record<string, unknown> = {}): NewEventShape =>
  ({ op: 'proposal.offer', tool: 'move_money', args: { budget: 'harbor', month: '2026-11', from: 'food', to: 'food', amountCents: 5000, why: 'x' },
    summary, effects: [], events: [], budget: 'harbor', month: '2026-11', envelopes: [], fingerprint: '', prompt, ...over }) as NewEventShape;

describe('thread()', () => {
  test('the first load covers today\'s month; through adds more; today is always a row; entries hold today and open days', async () => {
    const { store, clock } = await household();
    clock.now = '2026-10-20T17:00:00.000Z';
    await store.append('bob', { op: 'thread.note', text: 'october', budget: null });
    clock.now = '2026-11-03T17:00:00.000Z';
    await store.append('bob', { op: 'thread.note', text: 'early', budget: null });
    clock.now = NOW;
    const first = await thread(store, { who: 'alice', today: D });
    assert.deepEqual(first.days.map((d) => d.day), [D, '2026-11-03']);
    assert.deepEqual(first.days[0]!.total, 0);
    assert.deepEqual(first.entries.map((e) => e.day), []);
    const wider = await thread(store, { who: 'alice', today: D, through: '2026-10', open: ['2026-11-03'] });
    assert.deepEqual(wider.days.map((d) => d.day), [D, '2026-11-03', '2026-10-20']);
    assert.deepEqual(wider.entries.map((e) => e.day), ['2026-11-03']);
  });

  test('before is the next month back with a day in view under the kind', async () => {
    const { store, clock } = await household();
    clock.now = '2026-08-20T17:00:00.000Z';
    await store.append('bob', { op: 'thread.note', text: 'august', budget: null });
    clock.now = '2026-09-20T17:00:00.000Z';
    await store.append('alice', { op: 'thread.ask', question: 'september?', budget: null });
    clock.now = NOW;
    assert.equal((await thread(store, { who: 'alice', today: D })).before, '2026-09');
    assert.equal((await thread(store, { who: 'alice', today: D, lane: 'notes' })).before, '2026-08');
    assert.equal((await thread(store, { who: 'alice', today: D, through: '2026-07' })).before, null);
  });

  test('a person with nothing in view answers everyone', async () => {
    const { store } = await household();
    await store.append('bob', { op: 'thread.note', text: 'hi', budget: null });
    const none = await thread(store, { who: 'alice', today: D, person: 'casey' });
    assert.equal(none.who, 'everyone');
    assert.equal(none.entries.length, 1);
    assert.equal((await thread(store, { who: 'alice', today: D, person: 'bob' })).who, 'bob');
  });

  test('waiting is every item whatever is pressed, with what a row needs', async () => {
    const { store, clock } = await household();
    await store.append('alice', { op: 'txn.add', txns: [
      { id: 'u1', date: '2026-11-04', payee: 'A', amount: parseDollars('-1.00'), dedupeKey: 'u1', category: null }] });
    await store.append('bob', { op: 'txn.add', txns: [
      { id: 'r1', date: '2026-11-04', payee: 'Corner Shop', amount: parseDollars('-12.40'), dedupeKey: 'r1', category: 'groceries' }] });
    clock.now = '2026-11-10T17:30:00.000Z';
    const [o] = await store.append('claude', offerRaw('Move $50 to food'));
    clock.now = '2026-11-10T18:00:00.000Z';
    await store.append('bob', { op: 'txn.remove', txn: 'r1', why: 'dupe' });
    const mine = await thread(store, { who: 'alice', today: D, lane: 'notes' });
    assert.equal(mine.waiting.length, 3, 'every item, though a kind narrows the page');
    assert.ok(mine.waiting.every((w) => !w.inView));
    const offerItem = mine.waiting.find((w) => w.kind === 'offer' && w.offer.id === o!.id)!;
    assert.deepEqual([offerItem.lane, offerItem.by, offerItem.title, offerItem.entry, offerItem.inView, offerItem.day],
      ['budget', 'claude', 'Move $50 to food', o!.id, false, D]);
    const last = mine.waiting.at(-1)!;
    assert.equal(last.kind, 'unsorted');
    assert.equal(last.title, '1 receipt to sort');
    assert.equal(last.entry, undefined);
    assert.equal(last.day, undefined);
    const all = await thread(store, { who: 'alice', today: D });
    assert.equal(all.waiting.find((w) => w.kind === 'unsorted')!.inView, true);
    const flag = all.waiting.find((w) => w.kind === 'flag')!;
    assert.equal(flag.title, 'A receipt was removed: Corner Shop, $12.40');
    assert.equal(flag.by, 'bob');
  });

  test('an old ask is titled by its plan', async () => {
    const { store } = await household();
    await store.append('alice', { op: 'plan.create', plan: 'p1', title: 'Fix the gate', area: 'House' } as NewEventShape);
    const [ask] = await store.append('alice', { op: 'plan.ask', plan: 'p1', to: 'bob', why: 'you know it' });
    await store.append('alice', offerRaw('Take p1?', { kind: 'ask', ref: ask!.id }, { tool: 'answer_ask', args: { plan: 'p1' }, budget: null, month: null }));
    const item = (await thread(store, { who: 'bob', today: D })).waiting.find((w) => w.kind === 'offer')!;
    assert.equal(item.title, 'Fix the gate');
  });

  test('a guest\'s item carries the name', async () => {
    const { store } = await household();
    await store.append('alice', { op: 'guest.allow', email: 'dana@example.com', name: 'Dana', why: 'old friends' } as NewEventShape);
    await store.append('guest:dana@example.com', {
      op: 'proposal.offer', tool: 'approve_booking',
      args: { email: 'dana@example.com', name: 'Dana', arrive: '2026-12-12', depart: '2026-12-15', headcount: 2, note: 'hi' },
      summary: 'Dana would like to come', effects: [], events: [], budget: null, month: null, envelopes: [],
      fingerprint: '', prompt: { kind: 'booking', ref: null } } as NewEventShape);
    const item = (await thread(store, { who: 'alice', today: D })).waiting.find((w) => w.kind === 'offer' && w.offer.who.startsWith('guest:'));
    assert.equal(item?.name, 'Dana');
  });

  test('adopted lines older than the day\'s first read in time order and are fresh', async () => {
    const { store } = await household();
    const [a] = await store.append('alice', { op: 'thread.note', text: 'mine', budget: null });
    await store.append('alice', { op: 'briefing.read', upTo: a!.id });
    const old = { id: `${(Date.now() + 90_000).toString(36)}-910001`, at: '2026-11-10T07:00:00.000Z', who: 'bob',
      op: 'thread.note', text: 'earlier', budget: null } as unknown as Event;
    await store.adopt([old]);
    const page = await thread(store, { who: 'alice', today: D });
    const texts = page.entries.map((e) => (e.kind === 'note' ? e.text : e.kind));
    assert.deepEqual(texts, ['earlier', 'mine']);
    assert.equal(page.entries.find((e) => e.id === old.id)!.fresh, true);
    assert.equal(page.last, old.id);
    assert.equal(page.newSince, a!.id);
  });

  test('threadDay finds a day by its date or by an id it holds', async () => {
    const { store, clock } = await household();
    clock.now = '2026-11-03T17:00:00.000Z';
    const [q] = await store.append('bob', { op: 'thread.ask', question: 'hm?', budget: null });
    const [ans] = await store.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'yes', tools: [], model: 'm' });
    clock.now = NOW;
    const byDay = await threadDay(store, { who: 'alice', today: D, day: '2026-11-03' });
    assert.equal(byDay!.days.length, 1);
    assert.deepEqual(byDay!.entries.map((e) => e.id), [q!.id]);
    assert.equal((await threadDay(store, { who: 'alice', today: D, at: ans!.id }))!.days[0]!.day, '2026-11-03');
    assert.equal((await threadDay(store, { who: 'alice', today: D, at: 'nope' })), null);
  });

  test('threadDay finds the day of an offer, a drift and a question by their ids', async () => {
    const { store, clock } = await household();
    clock.now = '2026-11-03T17:00:00.000Z';
    const [q] = await store.append('bob', { op: 'thread.ask', question: 'hm?', budget: null });
    clock.now = '2026-11-04T17:00:00.000Z';
    const [o] = await store.append('claude', offerRaw('Move $50 to food'));
    clock.now = '2026-11-05T17:00:00.000Z';
    const [d] = await store.append('claude', offerRaw('Drifted', { kind: 'drift', ref: 'drift-ref-1' }));
    clock.now = NOW;
    const dayOf = async (at: string) => (await threadDay(store, { who: 'alice', today: D, at }))?.days[0]?.day;
    assert.equal(await dayOf(q!.id), '2026-11-03');
    assert.equal(await dayOf(o!.id), '2026-11-04');
    assert.equal(await dayOf(d!.id), '2026-11-05');
    assert.equal(await dayOf('drift-ref-1'), '2026-11-05');
    assert.equal(await dayOf('other-ref'), undefined);
  });

  test('everyEntry gives the whole record, newest day first', async () => {
    const { store } = await household();
    await store.append('bob', { op: 'thread.note', text: 'hi', budget: null });
    const { entries } = await everyEntry(store, 'alice');
    assert.ok(entries.some((e) => e.kind === 'note'));
  });
});
