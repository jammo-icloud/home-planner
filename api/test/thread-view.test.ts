import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { ProposalStore } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { offer, decide } from '../src/offers.ts';
import { build, ordered, authorOf } from '../src/thread.ts';
import { everyEntry } from './every-entry.ts';
import type { ThreadEntry } from '../src/thread.ts';
import type { Event } from '../src/types.ts';

const NOW = '2026-08-13T09:00:00.000Z';
const DOC = { link: 'f3c1', file_id: '881', hash: 'abc', version_id: '1', path: '/team-folders/Planner/h1/today/2026-08-13-household.md' };

async function ctx(clock = { now: NOW }): Promise<ToolContext> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-view-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(clock.now) });
  await store.load();
  await store.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
    { op: 'category.define', category: 'groceries', label: 'Groceries' },
    { op: 'category.define', category: 'travel', label: 'Travel' },
    { op: 'envelope.define', envelope: 'food', label: 'Food', group: 'People',
      match: { categories: ['groceries'] }, template: parseDollars('600.00'), order: 0 },
    { op: 'envelope.define', envelope: 'trip', label: 'Travel', group: 'Future',
      match: { categories: ['travel'] }, template: parseDollars('400.00'), order: 1 },
    { op: 'month.open', month: '2026-08', income: parseDollars('1000.00') },
  ]);
  return { store, who: 'alice', today: '2026-08-13', proposals: new ProposalStore(), sid: null };
}

const brief = (c: ToolContext, over: Record<string, unknown> = {}) =>
  c.store.append('claude', { op: 'thread.briefing', day: '2026-08-13', source: 'budget',
    headline: 'Food is running ahead', body: 'Longer account.', writtenBy: 'claude', ...over } as never)
    .then(([e]) => e!);

const entries = async (c: ToolContext, who = 'alice') => build(await c.store.since(null), c.store.state, who);
const kinds = (entries: readonly ThreadEntry[]) => entries.map((e) => e.kind);
const page = (c: ToolContext, o: { who?: string } = {}) => everyEntry(c.store, o.who ?? 'alice');

describe('the thread', () => {
  describe('flat entries', () => {
    const MOVE = { month: '2026-08', from: 'trip', to: 'food', amountCents: 5000, why: 'x' };
    /** A card for a tool that needs the NAS to make, written as the log holds it. */
    const raw = async (c: ToolContext, tool: string, args: Record<string, unknown>, prompt: { kind: string; ref: string | null }, by = 'claude') => {
      const [o] = await c.store.append(by, { op: 'proposal.offer', tool, args, summary: 'Dinner', effects: [], events: [],
        month: null, envelopes: [], fingerprint: '', prompt } as never);
      return o!;
    };
    const card = (all: ThreadEntry[], id: string) => all.find((e) => e.id === id) as Extract<ThreadEntry, { kind: 'card' }>;

    test('a card is its own entry in its lane, raised by what raised it', async () => {
      const c = await ctx();
      const b = await brief(c);
      const o = await offer(c, { tool: 'move_money', prompt: { kind: 'briefing', ref: b.id }, args: MOVE });
      const [q] = await c.store.append('bob', { op: 'thread.ask', question: 'Dinner on Friday?' });
      const [a] = await c.store.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'Maybe.', tools: [], model: 'm' });
      const ev = await raw(c, 'propose_event', { summary: 'Dinner', on: 'household' }, { kind: 'answer', ref: a!.id });
      const all = await entries(c);
      const first = card(all, o.id);
      assert.equal(first.lane, 'budget');
      assert.deepEqual(first.raised, { how: 'briefing', entry: b.id, day: '2026-08-13', at: NOW, by: 'claude' });
      const second = card(all, ev.id);
      assert.equal(second.lane, 'calendar');
      assert.deepEqual([second.raised?.how, second.raised?.entry, second.raised?.by], ['answer', q!.id, 'bob']);
      assert.ok(!('cards' in all.find((e) => e.id === b.id)!));
    });

    test('a card raised by a briefing that was replaced names the newer one', async () => {
      const c = await ctx();
      const old = await brief(c, { writtenBy: 'fallback' });
      const o = await offer(c, { tool: 'move_money', prompt: { kind: 'briefing', ref: old.id }, args: MOVE });
      const newer = await brief(c, { replaces: old.id });
      assert.equal(card(await entries(c), o.id).raised?.entry, newer.id);
    });

    test('a day is the household\'s, not UTC\'s', async () => {
      const c = await ctx({ now: '2026-08-14T04:30:00Z' });
      await c.store.append('alice', { op: 'household.zone', zone: 'America/Denver' });
      const [n] = await c.store.append('bob', { op: 'thread.note', text: 'late' });
      assert.equal((await entries(c)).find((e) => e.id === n!.id)!.day, '2026-08-13');
    });

    test('a decision on a later day than its offer is an entry; on the same day it is not', async () => {
      const clock = { now: NOW };
      const c = await ctx(clock);
      const same = await offer(c, { tool: 'move_money', prompt: { kind: 'briefing', ref: null }, args: MOVE });
      await decide(c, same.id, 'approved');
      assert.ok(!(await entries(c)).some((e) => e.kind === 'decision'));
      const other = await offer(c, { tool: 'set_assignment', prompt: { kind: 'briefing', ref: null },
        args: { month: '2026-08', envelope: 'food', toCents: 65000, why: 'y' } });
      clock.now = '2026-08-15T09:00:00Z';
      await decide(c, other.id, 'declined', 'no');
      const d = (await entries(c)).find((e) => e.kind === 'decision') as Extract<ThreadEntry, { kind: 'decision' }>;
      assert.deepEqual([d.day, d.lane, d.decision, d.why, d.offer.day], ['2026-08-15', 'budget', 'declined', 'no', '2026-08-13']);
    });

    test('what an approval applied, and a drift let go by a plan\'s removal, are not change rows', async () => {
      const c = await ctx();
      const o = await offer(c, { tool: 'move_money', prompt: { kind: 'briefing', ref: null }, args: MOVE });
      await decide(c, o.id, 'approved', 'ok');
      assert.ok(!(await entries(c)).some((e) => e.kind === 'change' && /moved/.test(e.what)));
    });

    test('an appointment for someone\'s own calendar is absent for the others', async () => {
      const c = await ctx();
      const o = await raw(c, 'propose_event', { summary: 'Dentist', on: 'mine' }, { kind: 'briefing', ref: null }, 'alice');
      assert.ok((await entries(c, 'alice')).some((e) => e.id === o.id));
      assert.ok(!(await entries(c, 'bob')).some((e) => e.id === o.id));
    });

    test('a change says where it opens', async () => {
      const c = await ctx();
      await c.store.append('alice', { op: 'assign', month: '2026-08', envelope: 'food', to: parseDollars('650.00'), why: 'a' });
      await c.store.append('alice', { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' });
      await c.store.append('bob', { op: 'plan.state', plan: 'gate', state: 'doing' });
      await c.store.append('bob', { op: 'plan.create', plan: 'gone', title: 'Gone soon', area: 'House' });
      await c.store.append('bob', { op: 'plan.state', plan: 'gone', state: 'doing' });
      await c.store.append('bob', { op: 'plan.remove', plan: 'gone', why: 'x' });
      const all = await entries(c);
      const change = (re: RegExp) => all.find((e) => e.kind === 'change' && re.test(e.what)) as Extract<ThreadEntry, { kind: 'change' }>;
      assert.deepEqual(change(/650/).open, { envelope: 'food' });
      assert.deepEqual(change(/Fix the gate to doing/).open, { plan: 'gate' });
      assert.equal(change(/Gone soon to doing/).open, undefined);
    });

    test('an appointment says what it is, whose calendar it is on, and opens its day', async () => {
      const c = await ctx();
      const CAL = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };
      await c.store.append('alice', [
        { op: 'calendar.household', ...CAL, name: 'Home', by: 'alice' },
        { op: 'calendar.appointment', ...CAL, evt_id: 5, ical_uid: 'u5', dav_etag: 'E', summary: 'Dentist',
          start: '2026-08-20T15:00:00.000Z', end: '2026-08-20T16:00:00.000Z', allDay: false },
        { op: 'calendar.appointment.change', evt_id: 5, summary: 'Dentist, later', start: '2026-08-21T15:00:00.000Z',
          end: '2026-08-21T16:00:00.000Z', allDay: false, dav_etag: 'E2',
          was: { summary: 'Dentist', start: '2026-08-20T15:00:00.000Z', end: '2026-08-20T16:00:00.000Z', allDay: false } },
      ] as never);
      const all = (await entries(c)).filter((e) => e.kind === 'change' && e.event);
      const made = all[0] as Extract<ThreadEntry, { kind: 'change' }>;
      assert.equal(made.event?.on, 'household');
      assert.equal(made.event?.summary, 'Dentist');
      assert.deepEqual(made.open, { calendar: '2026-08-20', key: 5 });
      const moved = all[1] as Extract<ThreadEntry, { kind: 'change' }>;
      assert.equal(moved.event?.was?.summary, 'Dentist');
      assert.deepEqual(moved.open, { calendar: '2026-08-21', key: 5 });
    });

    test('an all-day appointment opens its own date, west of UTC too', async () => {
      const c = await ctx();
      await c.store.append('alice', { op: 'household.zone', zone: 'America/Denver' });
      await c.store.append('alice', { op: 'calendar.appointment', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', evt_id: 6,
        ical_uid: 'u6', dav_etag: 'E', summary: 'Holiday', start: '2026-11-12', end: '2026-11-13', allDay: true } as never);
      const e = (await entries(c)).find((x) => x.kind === 'change' && x.event?.summary === 'Holiday') as Extract<ThreadEntry, { kind: 'change' }>;
      assert.deepEqual(e.open, { calendar: '2026-11-12', key: 6 });
    });

    test('an all-day appointment stored as an instant opens the household day, east of UTC', async () => {
      const c = await ctx();
      await c.store.append('alice', { op: 'household.zone', zone: 'Australia/Sydney' });
      await c.store.append('alice', { op: 'calendar.appointment', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', evt_id: 7,
        ical_uid: 'u7', dav_etag: 'E', summary: 'Show day', start: '2026-11-11T13:00:00.000Z', end: '2026-11-12T13:00:00.000Z', allDay: true } as never);
      const e = (await entries(c)).find((x) => x.kind === 'change' && x.event?.summary === 'Show day') as Extract<ThreadEntry, { kind: 'change' }>;
      assert.deepEqual(e.open, { calendar: '2026-11-12', key: 7 });
    });

    test('a change row knows its appointment, and a drift resolve does not', async () => {
      const c = await ctx();
      const CAL = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };
      await c.store.append('alice', { op: 'household.zone', zone: 'America/Denver' });
      await c.store.append('alice', [
        { op: 'calendar.appointment', ...CAL, evt_id: 300, ical_uid: 'u300', dav_etag: 'E', summary: 'Plumber',
          start: '2026-11-12T16:00:00.000Z', end: '2026-11-12T17:00:00.000Z', allDay: false },
        { op: 'calendar.appointment.change', evt_id: 300, summary: 'Plumber, later', start: '2026-11-13T16:00:00.000Z',
          end: '2026-11-13T17:00:00.000Z', allDay: false, dav_etag: 'E2',
          was: { summary: 'Plumber', start: '2026-11-12T16:00:00.000Z', end: '2026-11-12T17:00:00.000Z', allDay: false } },
      ] as never);
      const rows = (await entries(c)).filter((x) => x.kind === 'change' && x.event?.summary?.startsWith('Plumber')) as Extract<ThreadEntry, { kind: 'change' }>[];
      assert.deepEqual(rows.map((r) => r.open), [{ calendar: '2026-11-12', key: 300 }, { calendar: '2026-11-13', key: 300 }]);

      await c.store.append('alice', [
        { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
        { op: 'plan.due', plan: 'gate', due: '2026-11-07' },
        { op: 'plan.calendar.link', plan: 'gate', kind: 'due', ...CAL, evt_id: 7, ical_uid: 'u7', dav_etag: 'E1' },
      ]);
      const [d] = await c.store.append('alice', { op: 'calendar.drift', plan: 'gate', evt_id: 7, theirs: null,
        ours: { dtstart: 1_794_009_600, dtend: 1_794_096_000, summary: 'Fix the gate' } });
      await c.store.append('alice', { op: 'calendar.drift.resolve', drift: d!.id, choice: 'plan' });
      const resolved = (await entries(c)).filter((x) => x.kind === 'change' && x.open && 'calendar' in x.open && !('key' in x.open));
      assert.equal(resolved.length, 1);
    });

    test('fresh is what others wrote after what I last read', async () => {
      const c = await ctx();
      await c.store.append('bob', { op: 'thread.note', text: 'before any cursor' });
      const all0 = await entries(c);
      assert.ok(!all0.some((e) => e.fresh), 'no cursor: nothing is fresh');
      const [read] = await c.store.append('bob', { op: 'thread.note', text: 'read one' });
      await c.store.append('alice', { op: 'briefing.read', upTo: read!.id });
      const [next] = await c.store.append('bob', { op: 'thread.note', text: 'next' });
      const [mine] = await c.store.append('alice', { op: 'thread.note', text: 'mine' });
      const all = await entries(c);
      const at = (id: string) => all.find((e) => e.id === id)!;
      assert.equal(at(next!.id).fresh, true);
      assert.ok(!at(mine!.id).fresh);
      assert.ok(!at(read!.id).fresh);
    });

    test('waits is what waits on me', async () => {
      const c = await ctx();
      const open = await offer(c, { tool: 'move_money', prompt: { kind: 'briefing', ref: null }, args: MOVE });
      // Another month, so it is a decision of its own rather than the same one asked again.
      const done = await offer(c, { tool: 'open_month', prompt: { kind: 'briefing', ref: null },
        args: { month: '2026-09', incomeCents: 75000 } });
      await decide(c, done.id, 'approved');
      await c.store.append('alice', { op: 'txn.add', txns: [
        { id: 't1', date: '2026-08-02', payee: 'A', amount: parseDollars('-1.00'), dedupeKey: 't1', category: null }] });
      await c.store.append('bob', { op: 'txn.remove', txn: 't1', why: 'dupe' });
      const all = await entries(c);
      assert.equal(card(all, open.id).waits, true);
      assert.ok(!card(all, done.id).waits);
      const removal = all.find((e) => e.kind === 'change' && e.flag) as Extract<ThreadEntry, { kind: 'change' }>;
      assert.equal(removal.waits, true);
    });

    test('a guest\'s booking card carries their name; savings and release cards are the app\'s with no author', async () => {
      const c = await ctx();
      await c.store.append('alice', { op: 'guest.allow', email: 'linh@example.com', name: 'Linh', why: 'school' } as never);
      const g = await raw(c, 'approve_booking', { email: 'linh@example.com', name: 'Linh', arrive: '2026-09-10', depart: '2026-09-12', people: 1 },
        { kind: 'booking', ref: null }, 'guest:linh@example.com');
      const s = await raw(c, 'savings_short', { account: 'a' }, { kind: 'savings', ref: null }, 'alice');
      const r = await raw(c, 'release_stay', { stay: 'zz' }, { kind: 'booking', ref: 'yy' }, 'alice');
      const all = await entries(c, 'bob');
      assert.equal(card(all, g.id).name, 'Linh');
      for (const id of [s.id, r.id]) {
        assert.equal(card(all, id).app, true);
        assert.equal(authorOf(card(all, id)), null);
      }
    });

    test('a move opens its destination envelope, a booking block its first day', async () => {
      const c = await ctx();
      const [mv] = await c.store.append('alice', { op: 'move', month: '2026-08', from: 'trip', to: 'food', amount: parseDollars('5.00'), why: 'x' } as never);
      await c.store.append('alice', { op: 'booking.block', from: '2026-09-01', to: '2026-09-03', why: 'us' } as never);
      await c.store.append('alice', { op: 'envelope.define', envelope: 'fun', label: 'Fun', group: 'People',
        match: { categories: ['groceries'] }, template: parseDollars('50.00'), order: 2 } as never);
      const all = await entries(c);
      const moved = all.find((e) => e.id === mv!.id) as Extract<ThreadEntry, { kind: 'change' }>;
      assert.deepEqual(moved.open, { envelope: 'food' });
      const opens = all.filter((e) => e.kind === 'change').map((e) => (e as Extract<ThreadEntry, { kind: 'change' }>).open);
      assert.ok(opens.some((o) => o && 'envelope' in o && o.envelope === 'fun'));
      assert.ok(opens.some((o) => o && 'calendar' in o && o.calendar === '2026-09-01'));
    });

    test('a drift card is the app\'s, with no author', async () => {
      const c = await ctx();
      const CAL = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };
      await c.store.append('alice', [
        { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
        { op: 'plan.due', plan: 'gate', due: '2026-11-07' },
        { op: 'plan.calendar.link', plan: 'gate', kind: 'due', ...CAL, evt_id: 7, ical_uid: 'u7', dav_etag: 'E1' },
      ]);
      const [d] = await c.store.append('alice', { op: 'calendar.drift', plan: 'gate', evt_id: 7, theirs: null,
        ours: { dtstart: 1_794_009_600, dtend: 1_794_096_000, summary: 'Fix the gate' } });
      const o = await offer(c, { tool: 'resolve_drift', args: { drift: d!.id, plan: 'gate', choice: 'plan' },
        prompt: { kind: 'drift', ref: d!.id }, by: 'alice' });
      const e = card(await entries(c), o.id);
      assert.equal(e.app, true);
      assert.equal(authorOf(e), null);
      assert.equal(e.lane, 'calendar');
    });

    test('an offer that removed a receipt, approved, is a card with the flag and no change', async () => {
      const c = await ctx();
      await c.store.append('alice', { op: 'txn.add', txns: [
        { id: 't1', date: '2026-08-02', payee: 'Corner Shop', amount: parseDollars('-1.00'), dedupeKey: 't1', category: null }] });
      const [o] = await c.store.append('claude', { op: 'proposal.offer', tool: 'move_money', args: {}, summary: 'Remove it',
        effects: [], events: [{ op: 'txn.remove', txn: 't1', why: 'dupe' }], month: null, envelopes: [],
        fingerprint: 'f', prompt: { kind: 'briefing', ref: null } } as never);
      const [, rm] = await c.store.append('alice', [{ op: 'proposal.decide', proposal: o!.id, decision: 'approved' },
        { op: 'txn.remove', txn: 't1', why: 'dupe' }] as never);
      const all = await entries(c, 'bob');
      assert.ok(!all.some((e) => e.kind === 'change' && e.flag), 'no change row for the removal');
      const e = card(all, o!.id);
      assert.equal(e.flags?.[0]?.event, rm!.id);
      assert.equal(e.flags?.[0]?.removed?.payee, 'Corner Shop');
      assert.equal(e.flags?.[0]?.seenByMe, false);
    });

    test('ordered: newest day first; in a day the briefing, then time, then the log', () => {
      const e = (id: string, day: string, at: string, kind: string) => ({ id, day, at, kind }) as unknown as ThreadEntry;
      const list = [e('a', '2026-08-12', '2026-08-12T10:00:00Z', 'note'), e('b', '2026-08-13', '2026-08-13T10:00:00Z', 'note'),
        e('b2', '2026-08-13', '2026-08-13T10:00:00Z', 'note'), e('c', '2026-08-13', '2026-08-13T11:00:00Z', 'note'),
        e('z', '2026-08-13', '2026-08-13T12:00:00Z', 'briefing')];
      assert.deepEqual(ordered(list).map((x) => x.id), ['z', 'b', 'b2', 'c', 'a']);
    });
  });

  test('answers attach to their question, and cards to what prompted them', async () => {
    const c = await ctx();
    const b = await brief(c);
    const card = await offer(c, { tool: 'move_money', prompt: { kind: 'briefing', ref: b.id },
      args: { month: '2026-08', from: 'trip', to: 'food', amountCents: 5000, why: 'x' } });
    const [q] = await c.store.append('bob', { op: 'thread.ask', question: 'Can we cover food?' });
    const [a] = await c.store.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'Yes, from Travel.',
      tools: [{ name: 'get_month', args: {} }], model: 'm' });
    const answerCard = await offer(c, { tool: 'set_assignment', prompt: { kind: 'answer', ref: a!.id },
      args: { month: '2026-08', envelope: 'food', toCents: 65000, why: 'y' } });

    const { entries } = await page(c);
    const tail = entries.filter((e) => e.kind !== 'change').slice(-4);
    assert.deepEqual(kinds(tail), ['briefing', 'card', 'ask', 'card']);
    const [, bc, qq, ac] = tail as [ThreadEntry, Extract<ThreadEntry, { kind: 'card' }>, Extract<ThreadEntry, { kind: 'ask' | 'note' }>, Extract<ThreadEntry, { kind: 'card' }>];
    // The second card replaced the first, since both touch Food in August.
    assert.deepEqual([bc.offer.id, bc.offer.status, bc.raised?.entry], [card.id, 'replaced', b.id]);
    assert.equal(qq.who, 'bob');
    assert.equal(qq.answer?.text, 'Yes, from Travel.');
    assert.deepEqual(qq.answer?.tools, ['get_month']);
    assert.deepEqual([ac.offer.id, ac.raised?.entry], [answerCard.id, q!.id]);
  });

  test('a member\'s adjusted card stands on its own in the thread', async () => {
    const c = await ctx();
    const { adjust } = await import('../src/offers.ts');
    const b = await brief(c);
    const card = await offer(c, { tool: 'move_money', prompt: { kind: 'briefing', ref: b.id },
      args: { month: '2026-08', from: 'trip', to: 'food', amountCents: 5000, why: 'x' } });
    const mine = await adjust({ ...c, who: 'bob' }, card.id, { amountCents: 2000 });
    const { entries } = await page(c);
    const last = entries.at(-1)!;
    assert.equal(last.kind, 'card');
    assert.ok(last.kind === 'card' && last.offer.id === mine.id && last.offer.who === 'bob');
  });

  test('a question, a note and a card on a plan say which plan, by name', async () => {
    const c = await ctx();
    await c.store.append('alice', { op: 'plan.create', plan: 'heater', title: 'Tankless water heater', area: 'House' });
    const [q] = await c.store.append('alice', { op: 'thread.ask', question: 'What would it cost?', plan: 'heater' });
    const [a] = await c.store.append('claude', { op: 'thread.answer', replyTo: q!.id, plan: 'heater', text: 'About $1,800.',
      tools: [], model: 'm' });
    await c.store.append('bob', { op: 'thread.note', text: 'Quote came in', plan: 'heater' });
    const { adjust } = await import('../src/offers.ts');
    const found = await offer(c, { tool: 'set_plan_due', args: { plan: 'heater', due: '2026-11-14' },
      prompt: { kind: 'research', ref: a!.id }, plan: 'heater' });
    const mine = await adjust({ ...c, who: 'bob' }, found.id, { due: '2026-11-21' });
    await c.store.append('alice', { op: 'thread.note', text: 'Not about a plan' });

    const { entries } = await page(c);
    const on = { id: 'heater', title: 'Tankless water heater' };
    const ask = entries.find((e) => e.id === q!.id) as Extract<ThreadEntry, { kind: 'ask' | 'note' }>;
    assert.deepEqual(ask.plan, on);
    const note = entries.find((e) => e.kind === 'note' && e.text === 'Quote came in') as Extract<ThreadEntry, { kind: 'ask' | 'note' }>;
    assert.deepEqual(note.plan, on);
    const card = entries.find((e) => e.id === mine.id) as Extract<ThreadEntry, { kind: 'card' }>;
    assert.deepEqual(card.plan, on);
    const plain = entries.find((e) => e.kind === 'note' && e.text === 'Not about a plan')!;
    assert.ok(!('plan' in plain), 'a line about no plan names none');
    // Renamed, the plan is called what it is called now.
    await c.store.append('alice', { op: 'plan.set', plan: 'heater', title: 'Heat pump water heater' });
    const again = (await page(c)).entries.find((e) => e.id === q!.id) as Extract<ThreadEntry, { kind: 'ask' | 'note' }>;
    assert.equal(again.plan?.title, 'Heat pump water heater');
  });

  test('a briefing kept in Drive is its headline, no body, and where it is', async () => {
    const c = await ctx();
    await brief(c, { doc: DOC, body: undefined });
    const [entry] = (await page(c)).entries.filter((e) => e.kind === 'briefing');
    assert.ok(entry && entry.kind === 'briefing');
    assert.equal(entry.headline, 'Food is running ahead');
    assert.equal(entry.body, null);
    assert.deepEqual(entry.doc, { path: DOC.path }, 'only where it is: never the link, the file id, the hash or the version');
  });

  test('an answer kept in Drive carries its headline and where the rest is', async () => {
    const c = await ctx();
    const [q] = await c.store.append('bob', { op: 'thread.ask', question: 'Why is food ahead?' });
    await c.store.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'Because.', tools: [], model: 'm', doc: DOC });
    await c.store.append('bob', { op: 'thread.ask', question: 'And travel?' });
    const entries = (await page(c)).entries;
    const ask = entries.find((e) => e.id === q!.id) as Extract<ThreadEntry, { kind: 'ask' | 'note' }>;
    assert.equal(ask.answer?.text, 'Because.');
    assert.deepEqual(ask.answer?.doc, { path: DOC.path });
    const bare = entries.find((e) => e.kind === 'ask' && e.text === 'And travel?') as Extract<ThreadEntry, { kind: 'ask' | 'note' }>;
    assert.ok(!bare.answer, 'unanswered');
  });

  test('a briefing and an answer kept in the log name no document', async () => {
    const c = await ctx();
    await brief(c);
    const [q] = await c.store.append('bob', { op: 'thread.ask', question: 'Why?' });
    await c.store.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'Because.', tools: [], model: 'm' });
    const entries = (await page(c)).entries;
    const b = entries.find((e) => e.kind === 'briefing')!;
    assert.ok(b.kind === 'briefing' && b.body === 'Longer account.' && !('doc' in b));
    const ask = entries.find((e) => e.id === q!.id) as Extract<ThreadEntry, { kind: 'ask' | 'note' }>;
    assert.ok(ask.answer && !('doc' in ask.answer));
  });

  test('a briefing replaced later that day shows only the newer one, with the older one\'s cards', async () => {
    const c = await ctx();
    const old = await brief(c, { writtenBy: 'fallback', headline: 'Plain summary' });
    const card = await offer(c, { tool: 'move_money', prompt: { kind: 'briefing', ref: old.id },
      args: { month: '2026-08', from: 'trip', to: 'food', amountCents: 5000, why: 'x' } });
    await brief(c, { replaces: old.id });
    const briefings = (await page(c)).entries.filter((e) => e.kind === 'briefing');
    assert.equal(briefings.length, 1);
    const only = briefings[0]!;
    assert.ok(only.kind === 'briefing' && only.writtenBy === 'claude' && !('cards' in only));
    const hung = (await page(c)).entries.find((e) => e.kind === 'card' && e.offer.id === card.id);
    assert.ok(hung && hung.kind === 'card' && hung.raised?.entry === only.id);
  });

  test('direct changes are change entries, collapsed as Activity collapsed them; removals never collapse', async () => {
    const c = await ctx();
    await c.store.append('alice', { op: 'txn.add', txns: [
      { id: 't1', date: '2026-08-02', payee: 'A', amount: parseDollars('-1.00'), dedupeKey: 't1', category: null },
      { id: 't2', date: '2026-08-02', payee: 'B', amount: parseDollars('-2.00'), dedupeKey: 't2', category: null },
    ] });
    await c.store.append('alice', [
      { op: 'txn.categorize', txn: 't1', category: 'groceries', manual: true },
      { op: 'txn.categorize', txn: 't2', category: 'groceries', manual: true },
    ]);
    await c.store.append('bob', [
      { op: 'txn.remove', txn: 't1', why: 'dupe' },
      { op: 'txn.remove', txn: 't2', why: 'dupe' },
    ]);
    const changes = (await page(c)).entries.filter((e) => e.kind === 'change').slice(-3);
    assert.ok(changes[0]!.kind === 'change' && changes[0]!.count === 2);
    assert.ok(changes.slice(1).every((e) => e.kind === 'change' && e.count === 1 && e.flag?.removed));
    // Bob removed them; Alice has not looked yet.
    assert.ok(changes.slice(1).every((e) => e.kind === 'change' && e.flag?.seenByMe === false));
  });

  test('bookkeeping never appears', async () => {
    const c = await ctx();
    const b = await brief(c);
    const card = await offer(c, { tool: 'move_money', prompt: { kind: 'briefing', ref: b.id },
      args: { month: '2026-08', from: 'trip', to: 'food', amountCents: 5000, why: 'x' } });
    await decide(c, card.id, 'declined');
    await c.store.append('alice', [{ op: 'briefing.read', upTo: b.id }, { op: 'flag.seen', event: 'zz' }]);
    const all = (await page(c)).entries;
    const after = all.filter((e) => e.kind !== 'change');
    assert.deepEqual(kinds(after), ['briefing', 'card'], 'a declined card stays, as the card');
  });

  test('the divider sits at what I last read', async () => {
    const c = await ctx();
    const b = await brief(c);
    await c.store.append('alice', { op: 'briefing.read', upTo: b.id });
    assert.equal(c.store.state.readCursor.get('alice'), b.id);
    assert.equal(c.store.state.readCursor.get('bob'), undefined);
  });

  test('what an approval applied is shown on its card, not again as a change', async () => {
    const c = await ctx();
    const b = await brief(c);
    const card = await offer(c, { tool: 'move_money', prompt: { kind: 'briefing', ref: b.id },
      args: { month: '2026-08', from: 'trip', to: 'food', amountCents: 5000, why: 'x' } });
    await decide(c, card.id, 'approved', 'trip is paid');
    await c.store.append('bob', { op: 'thread.note', text: 'after' });
    const all = (await page(c)).entries;
    const tail = all.filter((e) => e.kind !== 'change');
    assert.deepEqual(kinds(tail), ['briefing', 'card', 'note']);
  });

  describe('plans', () => {
    const lines = (entries: readonly ThreadEntry[]) =>
      entries.flatMap((e) => (e.kind === 'change' ? [e.what] : []));

    test('a plan\'s state change is a quiet line; its checklist is not', async () => {
      const c = await ctx();
      await c.store.append('alice', { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' });
      await c.store.append('bob', { op: 'plan.state', plan: 'gate', state: 'doing' });
      await c.store.append('bob', { op: 'plan.checklist', plan: 'gate', items: [{ id: 'i1', text: 'Buy hinges', done: false }] });
      await c.store.append('bob', { op: 'plan.set', plan: 'gate', notes: 'ask the neighbour', chips: ['urgent'] });
      const all = lines((await page(c)).entries);
      assert.deepEqual(all.slice(-2), ['made a plan: Fix the gate', 'moved Fix the gate to doing']);
      assert.ok(!all.some((w) => /checklist|notes/.test(w)));
      const last = (await page(c)).entries.at(-1)!;
      assert.ok(last.kind === 'change' && last.who === 'bob');
    });

    test('every plan op a member would want to see appears; the fine-grained ones do not', async () => {
      const c = await ctx();
      await c.store.append('alice', [
        { op: 'plan.create', plan: 'p', title: 'Paint', area: 'House' },
        { op: 'plan.due', plan: 'p', due: '2026-09-01' },
        { op: 'plan.block', plan: 'p', block: 'b1', start: '2026-08-20T09:00:00', end: '2026-08-20T11:00:00' },
        { op: 'plan.unblock', plan: 'p', block: 'b1', why: 'rain' },
        { op: 'plan.attach', plan: 'p', path: '/Planner/p/quote.pdf', name: 'quote.pdf', size: 10 },
        { op: 'plan.detach', plan: 'p', path: '/Planner/p/quote.pdf', why: 'old' },
        { op: 'plan.contact.link', plan: 'p', contact_id: 1, addressbook_id: 1, display: 'Sam' },
        { op: 'plan.contact.unlink', plan: 'p', contact_id: 1 },
        { op: 'plan.remove', plan: 'p', why: 'done differently' },
      ] as never);
      const shown = (await page(c)).entries.filter((e) => e.kind === 'change').map((e) => (e as { what: string }).what);
      for (const want of [/made a plan/, /due 2026-09-01/, /set aside time/, /let go of time/, /attached quote\.pdf/,
        /took quote\.pdf off/, /removed Paint/]) {
        assert.ok(shown.some((w) => want.test(w)), String(want));
      }
      assert.ok(!shown.some((w) => /linked|unlinked/.test(w)));
    });

    test('an ask to take a plan is one card, not a card and a line', async () => {
      const c = await ctx();
      await c.store.append('alice', { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' });
      const [asked] = await c.store.append('alice', { op: 'plan.ask', plan: 'gate', to: 'bob', why: 'you know the gate' });
      await offer(c, { tool: 'answer_ask', args: { plan: 'gate', answer: 'accept' }, prompt: { kind: 'ask', ref: asked!.id } });
      const { entries } = await page(c);
      assert.equal(entries.filter((e) => e.kind === 'card' && e.offer.prompt.kind === 'ask').length, 1);
      assert.ok(!lines(entries).some((w) => /asked bob/.test(w)), 'plan.ask is not also a quiet line');
    });

    test('accepting through the card shows on the card, not again as a line', async () => {
      const c = await ctx();
      await c.store.append('alice', { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' });
      const [asked] = await c.store.append('alice', { op: 'plan.ask', plan: 'gate', to: 'bob', why: 'you know the gate' });
      const card = await offer(c, { tool: 'answer_ask', args: { plan: 'gate', answer: 'accept' }, prompt: { kind: 'ask', ref: asked!.id } });
      await decide({ ...c, who: 'bob' }, card.id, 'approved');
      assert.ok(!lines((await page(c)).entries).some((w) => /took on/.test(w)));
    });

    test('an answer is said once, by the settled card, and never again as a quiet line', async () => {
      const c = await ctx();
      await c.store.append('alice', [
        { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
        { op: 'plan.create', plan: 'shed', title: 'Sort the shed', area: 'House' },
      ]);
      const { offer } = await import('../src/offers.ts');
      // Asks as 0.6.0 left them in a log: the ask, then the card naming it.
      for (const [plan, why] of [['gate', 'you know the gate'], ['shed', 'your tools']] as const) {
        const [asked] = await c.store.append('alice', { op: 'plan.ask', plan, to: 'bob', why });
        await offer(c, { tool: 'answer_ask', args: { plan, answer: 'accept' }, prompt: { kind: 'ask', ref: asked!.id }, by: 'alice' });
      }
      // Answered directly, as Take it and Decline do: no proposal.decide, only the plan line.
      await c.store.append('bob', { op: 'plan.ask.decline', plan: 'gate', why: 'no time' });
      await c.store.append('bob', { op: 'plan.ask.accept', plan: 'shed' });

      const { entries } = await page(c);
      const settled = (plan: string) => (entries.find((e) => e.kind === 'card' && e.plan?.id === plan) as
        Extract<ThreadEntry, { kind: 'card' }>).offer;
      const gate = settled('gate');
      assert.deepEqual([gate.status, gate.decidedBy, gate.why], ['declined', 'bob', 'no time']);
      const shed = settled('shed');
      assert.deepEqual([shed.status, shed.decidedBy], ['approved', 'bob']);
      assert.ok(!lines(entries).some((w) => /declined Fix the gate|took on Sort the shed/.test(w)),
        'no quiet line repeats the answer');
    });
      test('a drift card stands on its own, names its plan, and says how it was settled', async () => {
      const c = await ctx();
      const CAL = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };
      await c.store.append('alice', [
        { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
        { op: 'plan.due', plan: 'gate', due: '2026-11-07' },
        { op: 'plan.calendar.link', plan: 'gate', kind: 'due', ...CAL, evt_id: 7, ical_uid: 'u7', dav_etag: 'E1' },
      ]);
      const [d] = await c.store.append('alice', { op: 'calendar.drift', plan: 'gate', evt_id: 7,
        theirs: { dtstart: 1_794_096_000, dtend: 1_794_182_400, summary: 'Fix the gate' },
        ours: { dtstart: 1_794_009_600, dtend: 1_794_096_000, summary: 'Fix the gate' }, dav_etag: 'E2', changedBy: 'bob' });
      const card = await offer(c, { tool: 'resolve_drift', args: { drift: d!.id, plan: 'gate', choice: 'plan' },
        prompt: { kind: 'drift', ref: d!.id }, by: 'alice' });

      const entryOf = async () => (await page(c)).entries.find((e) => e.kind === 'card' && e.offer.id === card.id) as
        Extract<ThreadEntry, { kind: 'card' }>;
      let entry = await entryOf();
      assert.ok(entry, 'a card of its own');
      assert.deepEqual(entry.plan, { id: 'gate', title: 'Fix the gate' });
      assert.deepEqual(entry.drift, { on: 'calendar', resolved: null, deleted: false, replaced: false, unreadable: false });
      const waits = async (who: string) => (await page(c, { who })).entries.some((e) => e.id === card.id && e.waits === true);
      assert.ok(await waits('alice'), 'waiting for alice');
      assert.ok(await waits('bob'), 'waiting for bob');

      // Settled with Leave both: the card says so; the resolve is not said again as a line.
      await decide({ ...c, who: 'bob' }, card.id, 'approved', undefined, { choice: 'leave' });
      entry = await entryOf();
      assert.equal(entry.offer.status, 'approved');
      assert.equal(entry.offer.decidedBy, 'bob');
      assert.deepEqual(entry.drift, { on: 'calendar', resolved: 'leave', deleted: false, replaced: false, unreadable: false });
      assert.ok(!lines((await page(c)).entries).some((w) => /let the calendar be/.test(w)));
    });

    test('a drift settled by removing its plan is not said as a line of its own', async () => {
      const c = await ctx();
      const CAL = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };
      await c.store.append('alice', [
        { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
        { op: 'plan.calendar.link', plan: 'gate', kind: 'due', ...CAL, evt_id: 7, ical_uid: 'u7', dav_etag: 'E1' },
      ]);
      const [d] = await c.store.append('alice', { op: 'calendar.drift', plan: 'gate', evt_id: 7, theirs: null,
        ours: { dtstart: 1_794_009_600, dtend: 1_794_096_000, summary: 'Fix the gate' } });
      const card = await offer(c, { tool: 'resolve_drift', args: { drift: d!.id, plan: 'gate', choice: 'plan' },
        prompt: { kind: 'drift', ref: d!.id }, by: 'alice' });
      await c.store.append('bob', [
        { op: 'plan.calendar.unlink', plan: 'gate', kind: 'due' },
        { op: 'calendar.drift.resolve', drift: d!.id, choice: 'leave' },
        { op: 'plan.remove', plan: 'gate', why: 'fixed it ourselves' },
      ]);
      const { entries } = await page(c);
      const entry = entries.find((e) => e.kind === 'card' && e.offer.id === card.id) as Extract<ThreadEntry, { kind: 'card' }>;
      assert.equal(entry.offer.status, 'replaced');
      assert.deepEqual(entry.drift, { on: 'calendar', resolved: 'leave', deleted: true, replaced: false, unreadable: false });
      assert.ok(lines(entries).some((w) => /removed Fix the gate/.test(w)));
      assert.ok(!lines(entries).some((w) => /let the calendar be/.test(w)), 'the remove says it');
    });

    test("a page's card says it is about the page", async () => {
      const c = await ctx();
      await c.store.append('alice', { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' });
      const theirs = { ...DOC, path: '/team-folders/Planner/h1/gate/plan.md', hash: 'def' };
      const [d] = await c.store.append('alice', { op: 'plan.page.drift', plan: 'gate', theirs,
        changes: [{ field: 'title', from: 'Fix the gate', to: 'Fix the side gate' }] });
      const card = await offer(c, { tool: 'resolve_drift', args: { drift: d!.id, plan: 'gate', choice: 'plan' },
        prompt: { kind: 'drift', ref: d!.id }, by: 'alice' });
      assert.equal(card.summary, 'The page for Fix the gate was changed in Drive: title "Fix the gate" → "Fix the side gate"');

      const entryOf = async () => (await page(c)).entries.find((e) => e.kind === 'card' && e.offer.id === card.id) as
        Extract<ThreadEntry, { kind: 'card' }>;
      let entry = await entryOf();
      assert.ok(entry, 'a card of its own');
      assert.deepEqual(entry.plan, { id: 'gate', title: 'Fix the gate' });
      assert.deepEqual(entry.drift, { on: 'page', resolved: null, deleted: false, replaced: false, unreadable: false });

      // Left as edited, by bob: the version in Drive is the one the app knows.
      await decide({ ...c, who: 'bob' }, card.id, 'approved', undefined, { choice: 'leave' });
      entry = await entryOf();
      assert.equal(entry.offer.decidedBy, 'bob');
      assert.deepEqual(entry.drift, { on: 'page', resolved: 'leave', deleted: false, replaced: false, unreadable: false });
      assert.equal(c.store.state.plans.get('gate')!.page!.doc.hash, 'def');

      // A page that cannot be read says so, so the card offers nothing to take.
      const [u] = await c.store.append('alice', { op: 'plan.page.drift', plan: 'gate', theirs: { ...theirs, hash: 'ghi' },
        changes: [], unreadable: true });
      const unreadable = await offer(c, { tool: 'resolve_drift', args: { drift: u!.id, plan: 'gate', choice: 'plan' },
        prompt: { kind: 'drift', ref: u!.id }, by: 'alice' });
      const said = (await page(c)).entries.find((e) => e.kind === 'card' && e.offer.id === unreadable.id) as
        Extract<ThreadEntry, { kind: 'card' }>;
      assert.deepEqual(said.drift, { on: 'page', resolved: null, deleted: false, replaced: false, unreadable: true });
    });
  });
});
