// api/test/calendar.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { replay, ReplayError } from '../src/replay.ts';
import { scopeOf } from '../src/restore.ts';
import { describe as describeEvent } from '../src/tools.ts';
import { thread } from '../src/thread.ts';
import type { ThreadEntry } from '../src/thread.ts';
import type { Event, Plan } from '../src/types.ts';
import { before, after } from 'node:test';
import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';
import type { FakeDsm } from '../tools/fake-dsm/server.ts';
import {
  NeedsDsm, SynologyError, createCalendar, createEvent, deleteEvent, getContact, getEvent, listAddressbooks, listEvents, setDsmFetch, setEvent,
  shareCalendar,
} from '../src/synology.ts';
import type { DsmFetch } from '../src/synology.ts';
import { markClashes } from '../src/calendar-view.ts';
import { checkDrift, checkDriftNowAndThen, eventFor, todayEvents, freeSlotsNear, syncBlock, syncDue, unsyncAll, unsyncBlock, weekEvents, wellFormed } from '../src/calendar.ts';
import { addBlock, removePlan, setDue, updatePlan } from '../src/plan-edits.ts';
import { notOnCalendar, toPlace } from '../src/plan-rules.ts';
import { ProposalStore, RESEARCH_WRITES, ToolError, commit, researchMay, runTool, toolByName } from '../src/tools.ts';
import { board, card as planCard } from '../src/plans.ts';
import type { Proposal, ToolContext } from '../src/tools.ts';
import type { NewEvent } from '../src/store.ts';
import { adjust, decide, offer, refresh } from '../src/offers.ts';

const NOW = '2026-10-29T09:00:00Z';

/** A household with alice and bob, and one plan: Fix the gate. */
async function fresh(): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-calendar-')), 'events.jsonl');
  const s = new Store({ path, now: () => new Date(NOW) });
  await s.load();
  await s.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
    { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
  ]);
  return s;
}

const CAL = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };
const due = (evt_id = 101, dav_etag = 'E1') =>
  ({ op: 'plan.calendar.link', plan: 'gate', kind: 'due', ...CAL, evt_id, ical_uid: `uid-${evt_id}`, dav_etag }) as const;
const block = (b: string, evt_id: number) =>
  ({ op: 'plan.calendar.link', plan: 'gate', kind: 'block', block: b, ...CAL, evt_id, ical_uid: `uid-${evt_id}`, dav_etag: 'B1' }) as const;
const OURS = { dtstart: 1_793_404_800, dtend: 1_793_491_200, summary: 'Fix the gate' };
const THEIRS = { dtstart: 1_793_491_200, dtend: 1_793_577_600, summary: 'Fix the gate' };
const drift = (theirs: typeof THEIRS | null = THEIRS, evt_id = 101) =>
  ({ op: 'calendar.drift', plan: 'gate', evt_id, theirs, ours: OURS }) as const;
const appointment = (evt_id = 300) => ({
  op: 'calendar.appointment', evt_id, ...CAL, ical_uid: `uid-${evt_id}`, dav_etag: 'A1',
  summary: 'Dentist', start: '2026-11-03T15:00:00Z', end: '2026-11-03T16:00:00Z', allDay: false,
}) as const;

/** A write the log must refuse as a ReplayError (never a TypeError), leaving nothing behind. */
async function refused(s: Store, op: Record<string, unknown>, message: RegExp, who = 'alice'): Promise<void> {
  const before = (await s.since(null)).length;
  await assert.rejects(() => s.append(who, op as never),
    (e: unknown) => e instanceof ReplayError && message.test(e.message), JSON.stringify(op));
  assert.equal((await s.since(null)).length, before, 'nothing was written');
}

const plan = (s: Store) => s.state.plans.get('gate')!;

describe('a plan remembers its calendar events', () => {
  test('a new plan has no links', async () => {
    const s = await fresh();
    assert.deepEqual(plan(s).links, []);
  });

  test('a link is recorded on the plan', async () => {
    const s = await fresh();
    await s.append('alice', due());
    assert.deepEqual(plan(s).links, [{ kind: 'due', ...CAL, evt_id: 101, ical_uid: 'uid-101', dav_etag: 'E1' }]);
  });

  test('linking the same kind again replaces it; blocks are kept apart by their id', async () => {
    const s = await fresh();
    await s.append('alice', [due(101), block('b1', 201), block('b2', 202)]);
    await s.append('alice', [due(102, 'E9'), block('b1', 203)]);
    const links = plan(s).links;
    assert.equal(links.length, 3);
    assert.deepEqual(links.map((l) => [l.kind, l.block ?? null, l.evt_id]),
      [['due', null, 102], ['block', 'b1', 203], ['block', 'b2', 202]]);
    assert.equal(links[0]!.dav_etag, 'E9');
  });

  test('an etag updates the link with that event, and only that one', async () => {
    const s = await fresh();
    await s.append('alice', [due(101), block('b1', 201)]);
    await s.append('alice', { op: 'plan.calendar.etag', plan: 'gate', evt_id: 101, dav_etag: 'E2' });
    assert.deepEqual(plan(s).links.map((l) => l.dav_etag), ['E2', 'B1']);
    await refused(s, { op: 'plan.calendar.etag', plan: 'gate', evt_id: 999, dav_etag: 'E3' }, /not on the calendar|no calendar event/);
  });

  test('unlink removes by kind and block', async () => {
    const s = await fresh();
    await s.append('alice', [due(101), block('b1', 201), block('b2', 202)]);
    await s.append('alice', { op: 'plan.calendar.unlink', plan: 'gate', kind: 'block', block: 'b1' });
    assert.deepEqual(plan(s).links.map((l) => l.evt_id), [101, 202]);
    await s.append('alice', { op: 'plan.calendar.unlink', plan: 'gate', kind: 'due' });
    assert.deepEqual(plan(s).links.map((l) => l.evt_id), [202]);
    await refused(s, { op: 'plan.calendar.unlink', plan: 'gate', kind: 'due' }, /not on the calendar/);
  });

  test('a link on a plan that is gone is refused', async () => {
    const s = await fresh();
    await refused(s, { ...due(), plan: 'nope' }, /no such plan/);
    await s.append('alice', { op: 'plan.remove', plan: 'gate', why: 'done another way' });
    await refused(s, due(), /has been removed/);
  });
});

describe('drift', () => {
  test('a drift is recorded open, and resolving it settles it once', async () => {
    const s = await fresh();
    await s.append('alice', due());
    const [d] = await s.append('alice', drift());
    assert.deepEqual(s.state.drifts.get(d!.id), { plan: 'gate', evt_id: 101, theirs: THEIRS, ours: OURS, resolved: null, slot: 'due' });
    await s.append('bob', { op: 'calendar.drift.resolve', drift: d!.id, choice: 'plan' });
    assert.equal(s.state.drifts.get(d!.id)!.resolved, 'plan');
    await refused(s, { op: 'calendar.drift.resolve', drift: d!.id, choice: 'leave' }, /already settled/);
    await refused(s, { op: 'calendar.drift.resolve', drift: 'nope', choice: 'leave' }, /no such drift/);
  });

  test('a deleted event is a drift whose theirs is null', async () => {
    const s = await fresh();
    await s.append('alice', due());
    const [d] = await s.append('alice', drift(null));
    assert.equal(s.state.drifts.get(d!.id)!.theirs, null);
  });

  test('a second open drift for the same event replaces the first', async () => {
    const s = await fresh();
    await s.append('alice', [due(101), block('b1', 201)]);
    const [first] = await s.append('alice', drift());
    const [other] = await s.append('alice', drift(THEIRS, 201));
    const [second] = await s.append('alice', drift(null));
    assert.deepEqual(s.state.drifts.get(first!.id),
      { plan: 'gate', evt_id: 101, theirs: THEIRS, ours: OURS, resolved: 'leave', replacedBy: second!.id, slot: 'due' });
    assert.equal(s.state.drifts.get(second!.id)!.resolved, null);
    assert.equal(s.state.drifts.get(other!.id)!.resolved, null, 'a drift on another event is left alone');
    await refused(s, { op: 'calendar.drift.resolve', drift: first!.id, choice: 'plan' }, /already settled/);
  });

  test('an event deleted and left that way keeps its date on the plan, off the calendar by choice, until set again', async () => {
    const s = await fresh();
    await s.append('alice', [{ op: 'plan.due', plan: 'gate', due: '2026-11-07' }, due()]);
    const [d] = await s.append('alice', drift(null));
    await s.append('alice', [{ op: 'plan.calendar.unlink', plan: 'gate', kind: 'due' },
      { op: 'calendar.drift.resolve', drift: d!.id, choice: 'leave' }]);
    const gate = s.state.plans.get('gate')!;
    assert.deepEqual(gate.letGo, ['due']);
    assert.deepEqual(toPlace(gate), { due: false, blocks: [] }, 'a look leaves it off');
    assert.deepEqual(notOnCalendar(gate), { due: true, blocks: [] }, 'and the card still says it is not there');
    await s.append('alice', { op: 'plan.due', plan: 'gate', due: '2026-11-09' });
    assert.deepEqual(s.state.plans.get('gate')!.letGo, [], 'set again, it is one to put there');
  });

  test('a drift names an event the plan is linked to', async () => {
    const s = await fresh();
    await refused(s, drift(), /not on the calendar/);
  });
});

describe('appointments', () => {
  test('an appointment is kept by its event id', async () => {
    const s = await fresh();
    await s.append('alice', { ...appointment(), plan: 'gate', contact: { contact_id: 4, addressbook_id: 1, display: 'Dr. Lee' } });
    const a = s.state.appointments.get(300);
    assert.ok(a);
    assert.equal(a.summary, 'Dentist');
    assert.equal(a.plan, 'gate');
    assert.deepEqual(a.contact, { contact_id: 4, addressbook_id: 1, display: 'Dr. Lee' });
    assert.equal(a.who, 'alice');
    await refused(s, appointment(), /already/);
  });

  test('an appointment on a plan that is not there is refused', async () => {
    const s = await fresh();
    await refused(s, { ...appointment(), plan: 'nope' }, /no such plan/);
  });
});

describe('an appointment taken back', () => {
  const remove = (evt_id = 300) => ({ op: 'calendar.appointment.remove', evt_id, summary: 'Dentist' }) as const;

  test('is forgotten by its event id, and may be recorded again only as a new event', async () => {
    const s = await fresh();
    await s.append('alice', appointment());
    await s.append('bob', remove());
    assert.equal(s.state.appointments.has(300), false);
    await refused(s, remove(), /not recorded|no appointment/);
    await refused(s, remove(301), /not recorded|no appointment/);
  });

  test('is checked like the line that made it, and only members write it', async () => {
    const s = await fresh();
    await s.append('alice', appointment());
    await refused(s, { ...remove(), evt_id: 1.5 }, /evt_id/);
    await refused(s, { ...remove(), summary: ' ' }, /summary|name/);
    await refused(s, remove(), /not a member/, 'mallory');
    await refused(s, remove(), /claude cannot/, 'claude');
  });

  test('restores with the plans, reads as words, and is a quiet line in the thread', async () => {
    const s = await fresh();
    await s.append('alice', appointment());
    const [r] = await s.append('bob', remove());
    assert.equal(scopeOf(r!), 'plans');
    assert.equal(describeEvent(r!, s.state).what, 'took an appointment off the calendar: Dentist');
    const { entries } = await thread(s, { who: 'alice', budget: null });
    const lines = entries.flatMap((e: ThreadEntry) => (e.kind === 'change' ? [e.what] : []));
    assert.ok(lines.includes('took an appointment off the calendar: Dentist'), lines.join(' | '));
  });

  test('an old log replays the same, and a whole replay agrees with an incremental one', async () => {
    const s = await fresh();
    await s.append('alice', [appointment(300), appointment(301)]);
    await s.append('bob', remove(300));
    const whole = replay(await s.since(null));
    assert.deepEqual([...whole.appointments], [...s.state.appointments]);
    assert.deepEqual([...whole.appointments.keys()], [301]);
  });
});

describe('the log refuses calendar lines of the wrong shape', () => {
  test('as a ReplayError naming what is wrong, never a TypeError', async () => {
    const s = await fresh();
    await s.append('alice', due());
    await refused(s, { ...due(), kind: 'later' }, /kind/);
    await refused(s, { ...due(), evt_id: Number.NaN }, /evt_id/);
    await refused(s, { ...due(), evt_id: Number.POSITIVE_INFINITY }, /evt_id/);
    await refused(s, { ...due(), evt_id: '101' }, /evt_id/);
    await refused(s, { ...due(), cal_id: '' }, /cal_id/);
    await refused(s, { ...due(), original_cal_id: undefined }, /cal_id/);
    await refused(s, { ...due(), ical_uid: '' }, /ical_uid/);
    await refused(s, { ...due(), dav_etag: 7 }, /etag/);
    await refused(s, { ...due(), kind: 'block' }, /block/);
    await refused(s, { ...due(), block: 'b1' }, /block/);
    await refused(s, { op: 'plan.calendar.unlink', plan: 'gate', kind: 'block' }, /block/);
    await refused(s, { op: 'plan.calendar.unlink', plan: 'gate' }, /kind/);
    await refused(s, { op: 'plan.calendar.etag', plan: 'gate', evt_id: 101 }, /etag/);
    await refused(s, { op: 'plan.calendar.etag', plan: 'gate', evt_id: -1, dav_etag: 'E' }, /evt_id/);
    await refused(s, { ...drift(), plan: '' }, /names its plan/);
    await refused(s, { ...drift(), evt_id: null }, /evt_id/);
    await refused(s, { ...drift(), ours: null }, /ours/);
    await refused(s, { ...drift(), theirs: { dtstart: 'soon', dtend: 1, summary: 'x' } }, /theirs/);
    await refused(s, { ...drift(), ours: { dtstart: 1, dtend: Number.NaN, summary: 'x' } }, /ours/);
    await refused(s, { ...drift(), ours: { dtstart: 1, dtend: 2 } }, /ours/);
    await refused(s, { op: 'calendar.drift.resolve', drift: '', choice: 'plan' }, /drift/);
    await refused(s, { op: 'calendar.drift.resolve', drift: 'x', choice: 'both' }, /choice/);
    await refused(s, { ...appointment(), summary: ' ' }, /summary|name/);
    await refused(s, { ...appointment(), start: 'whenever' }, /start/);
    await refused(s, { ...appointment(), end: '2026-11-03T14:00:00Z' }, /end/);
    await refused(s, { ...appointment(), allDay: 'no' }, /all day|allDay/);
    await refused(s, { ...appointment(), evt_id: 1.5 }, /evt_id/);
    await refused(s, { ...appointment(), plan: '' }, /plan/);
    await refused(s, { ...appointment(), contact: { contact_id: 'x', addressbook_id: 1, display: 'Sam' } }, /contact_id/);
    await refused(s, { ...appointment(), contact: { contact_id: 1, addressbook_id: 1, display: '' } }, /name/);
  });

  test('only members write them, and Claude never does', async () => {
    const s = await fresh();
    await s.append('alice', due());
    const [d] = await s.append('alice', drift());
    for (const op of [due(), { op: 'plan.calendar.unlink', plan: 'gate', kind: 'due' },
      { op: 'plan.calendar.etag', plan: 'gate', evt_id: 101, dav_etag: 'E2' }, drift(),
      { op: 'calendar.drift.resolve', drift: d!.id, choice: 'leave' }, appointment()]) {
      await refused(s, op, /not a member/, 'mallory');
      await refused(s, op, /claude cannot/, 'claude');
    }
  });
});

describe('the new state replays the same whichever way it is built', () => {
  test('an incremental apply and a full replay agree on links, drifts and appointments', async () => {
    const s = await fresh();
    await s.append('alice', [due(101), block('b1', 201)]);
    const [first] = await s.append('alice', drift());
    await s.append('alice', drift(null));
    await s.append('alice', { op: 'plan.calendar.etag', plan: 'gate', evt_id: 201, dav_etag: 'B2' });
    await s.append('alice', appointment());
    await s.append('bob', { op: 'calendar.drift.resolve', drift: [...s.state.drifts.keys()][1]!, choice: 'calendar' });
    const whole = replay(await s.since(null));
    assert.deepEqual(whole.plans.get('gate')!.links, plan(s).links);
    assert.deepEqual([...whole.drifts], [...s.state.drifts]);
    assert.deepEqual([...whole.appointments], [...s.state.appointments]);
    assert.equal(whole.drifts.get(first!.id)!.resolved, 'leave');
    assert.equal(replay([]).drifts.size, 0);
    assert.equal(replay([]).appointments.size, 0);
  });
});

describe('where the lines go, and how they read', () => {
  const ops = (driftId: string) => [
    due(), { op: 'plan.calendar.unlink', plan: 'gate', kind: 'due' },
    { op: 'plan.calendar.etag', plan: 'gate', evt_id: 101, dav_etag: 'E2' }, drift(),
    { op: 'calendar.drift.resolve', drift: driftId, choice: 'leave' }, appointment(),
  ].map((o, i) => ({ id: `x${i}`, at: NOW, who: 'alice', ...o }) as unknown as Event);

  test('every one restores with the plans', () => {
    for (const e of ops('d')) assert.equal(scopeOf(e), 'plans', e.op);
  });

  test('every one has a sentence', async () => {
    const s = await fresh();
    await s.append('alice', due());
    const [d] = await s.append('alice', drift());
    for (const e of ops(d!.id)) {
      assert.ok(describeEvent(e, s.state).what.trim(), e.op);
      assert.notEqual(describeEvent(e, s.state).what, e.op, `${e.op} reads as words`);
    }
    const said = ops(d!.id).map((e) => describeEvent(e, s.state).what);
    assert.equal(said[0], 'put Fix the gate on the calendar');
    assert.equal(said[1], 'took Fix the gate off the calendar');
    assert.equal(said[3], 'noted the calendar moved Fix the gate');
    assert.equal(said[4], 'kept Fix the gate as planned and let the calendar be');
    assert.equal(said[5], 'made an appointment: Dentist');
    // Each of the three choices names the plan it settled.
    const resolve = ops(d!.id)[4]!;
    assert.equal(describeEvent({ ...resolve, choice: 'plan' } as Event, s.state).what, 'moved Fix the gate to match the calendar');
    assert.equal(describeEvent({ ...resolve, choice: 'calendar' } as Event, s.state).what, 'put Fix the gate back on the calendar as planned');
    assert.match(describeEvent({ ...ops(d!.id)[3]!, theirs: null } as Event, s.state).what, /deleted/);
  });

  test('a settled drift and an appointment are quiet lines; links, etags and the drift itself are not', async () => {
    const s = await fresh();
    await s.append('alice', [due(), block('b1', 201)]);
    await s.append('alice', { op: 'plan.calendar.etag', plan: 'gate', evt_id: 101, dav_etag: 'E2' });
    await s.append('alice', { op: 'plan.calendar.unlink', plan: 'gate', kind: 'block', block: 'b1' });
    const [d] = await s.append('alice', drift());
    await s.append('bob', { op: 'calendar.drift.resolve', drift: d!.id, choice: 'leave' });
    await s.append('alice', appointment());
    const { entries } = await thread(s, { who: 'alice', budget: null });
    const lines = entries.flatMap((e: ThreadEntry) => (e.kind === 'change' ? [e.what] : []));
    assert.ok(lines.includes('kept Fix the gate as planned and let the calendar be'), lines.join(' | '));
    assert.ok(lines.includes('made an appointment: Dentist'), lines.join(' | '));
    assert.ok(!lines.some((w) => /on the calendar|off the calendar|in step|noted the calendar/.test(w)), lines.join(' | '));
  });
});

// ─── due dates and blocks on the NAS ────────────────────────────────────────
//
// Against the fake DSM (tools/fake-dsm), which keeps events and changes their
// etag on every change, reached through a fetch that rewrites DSM_URL to it and
// records each call. The household's zone is Denver, where 1 November 2026 is
// the day the clocks go back.

describe('due dates and blocks become events', () => {
  const ZONE = 'America/Denver';
  let nas: FakeDsm;
  const calls: { api: string; method: string; params: URLSearchParams }[] = [];
  /** Run on each event create, after the NAS made it and before the app hears back. */
  let onCreate: (() => Promise<void>) | null = null;
  /** Rewrites what the NAS answers a create with, to stand for a sharee's view of the ids. */
  let createReply: ((data: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Rewrites the calendars the NAS lists, to stand for an account with none of its own. */
  let calendarsReply: ((rows: Record<string, unknown>[]) => Record<string, unknown>[]) | null = null;
  /** A calendar whose events the NAS refuses to list, to stand for one that cannot be read just now. */
  let listFails: string | null = null;
  const via: DsmFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ api: params.get('api') ?? '', method: params.get('method') ?? '', params });
    const res = await fetch(`http://127.0.0.1:${nas.port}/webapi/entry.cgi`, init);
    if (params.get('api') === 'SYNO.Cal.Event' && params.get('method') === 'create') {
      const body = await res.json() as { success: boolean; data: Record<string, unknown> };
      if (onCreate) await onCreate();
      const data = createReply && body.success ? createReply(body.data) : body.data;
      return new Response(JSON.stringify({ ...body, data }), { headers: { 'content-type': 'application/json' } });
    }
    if (listFails && params.get('api') === 'SYNO.Cal.Event' && params.get('method') === 'list'
        && (JSON.parse(params.get('cal_id_list') ?? '[]') as string[]).includes(listFails)) {
      return new Response(JSON.stringify({ success: false, error: { code: 9017 } }), { headers: { 'content-type': 'application/json' } });
    }
    if (calendarsReply && params.get('api') === 'SYNO.Cal.Cal' && params.get('method') === 'list') {
      const body = await res.json() as { success: boolean; data: { list: Record<string, unknown>[] } };
      return new Response(JSON.stringify({ ...body, data: { list: calendarsReply(body.data.list) } }), { headers: { 'content-type': 'application/json' } });
    }
    return res;
  }) as DsmFetch;
  const zoneBefore = process.env['TZ'];

  before(async () => {
    nas = await startFakeDsm({ port: 0, log: () => {}, accounts: { alice: { password: 'pw-a' }, bob: { password: 'pw-b' } } });
    process.env['TZ'] = ZONE;
    setDsmFetch(via);
  });
  after(async () => {
    setDsmFetch(null);
    if (zoneBefore === undefined) delete process.env['TZ']; else process.env['TZ'] = zoneBefore;
    await nas.close();
  });

  async function signIn(account: string, passwd: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${nas.port}/webapi/entry.cgi`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api: 'SYNO.API.Auth', version: '6', method: 'login', account, passwd }).toString(),
    });
    return ((await res.json()) as { data: { sid: string } }).data.sid;
  }

  /** A household with the gate plan, alice signed in to the fake NAS, and the call record cleared. */
  async function setup(who = 'alice'): Promise<ToolContext> {
    const store = await fresh();
    const sid = who === 'bob' ? await signIn('bob', 'pw-b') : await signIn('alice', 'pw-a');
    calls.length = 0;
    onCreate = null;
    createReply = null;
    calendarsReply = null;
    listFails = null;
    return { store, who, today: '2026-10-29', proposals: new ProposalStore(), sid };
  }
  const gate = (c: ToolContext) => c.store.state.plans.get('gate')!;
  const made = (method: string) => calls.filter((x) => x.api === 'SYNO.Cal.Event' && x.method === method);
  /** The event as it stands on the NAS now. */
  const onNas = (c: ToolContext, evt_id: number) =>
    getEvent(c.sid!, { evt_id, cal_id: '', original_cal_id: '' }, via);
  const at = (iso: string) => Date.parse(iso) / 1000;

  test('eventFor: a due date is all day, midnight to midnight where the household is', () => {
    const p = { id: 'gate', title: 'Fix the gate', area: 'House', due: '2026-11-07' } as Plan;
    const cal = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };
    assert.deepEqual(eventFor(p, 'due', null, ZONE, cal), {
      ...cal, summary: 'Fix the gate', description: 'From Home Planner · Plan › House › Fix the gate',
      is_all_day: true, dtstart: at('2026-11-07T07:00:00Z'), dtend: at('2026-11-08T07:00:00Z'), tz_id: ZONE,
    });
    // The day the clocks go back is 25 hours long, and each end is still midnight.
    const back = eventFor({ ...p, due: '2026-11-01' }, 'due', null, ZONE, cal);
    assert.equal(back.dtstart, at('2026-11-01T06:00:00Z'));
    assert.equal(back.dtend, at('2026-11-02T07:00:00Z'));
  });

  test('eventFor: a block is the time it sets aside', () => {
    const p = { id: 'gate', title: 'Fix the gate', area: 'House', due: null } as unknown as Plan;
    const cal = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };
    const e = eventFor(p, 'block', { id: 'b1', start: '2026-11-07T16:00:00Z', end: '2026-11-07T19:00:00Z' }, ZONE, cal);
    assert.equal(e.is_all_day, false);
    assert.equal(e.dtstart, at('2026-11-07T16:00:00Z'));
    assert.equal(e.dtend, at('2026-11-07T19:00:00Z'));
    assert.equal(e.tz_id, ZONE);
  });

  test('the first due date makes the Household calendar, then an all-day event on it, and links it', async () => {
    const c = await setup();
    assert.equal(c.store.state.calendar.household, null);
    const out = await syncDue(c, gate(c), '2026-11-07');
    const household = c.store.state.calendar.household!;
    assert.ok(household, 'the Household calendar was made inside the sync');
    assert.equal(household.by, 'alice');
    const order = calls.map((x) => `${x.api} ${x.method}`);
    assert.ok(order.indexOf('SYNO.Cal.Cal create') < order.indexOf('SYNO.Cal.Event create'));
    assert.ok(order.includes('SYNO.Cal.Sharing set'), 'shared with bob');

    const [create] = made('create');
    assert.equal(create!.params.get('is_all_day'), 'true');
    assert.equal(create!.params.get('dtstart'), String(at('2026-11-07T07:00:00Z')));
    assert.equal(create!.params.get('dtend'), String(at('2026-11-08T07:00:00Z')));
    assert.equal(create!.params.get('tz_id'), ZONE);
    assert.equal(create!.params.get('summary'), 'Fix the gate');
    assert.equal(create!.params.get('description'), 'From Home Planner · Plan › House › Fix the gate');
    assert.equal(create!.params.get('cal_id'), household.cal_id);

    assert.equal(out.length, 1);
    const link = out[0] as Extract<NewEvent, { op: 'plan.calendar.link' }>;
    assert.equal(link.op, 'plan.calendar.link');
    assert.equal(link.kind, 'due');
    assert.equal(link.cal_id, household.cal_id);
    const ev = await onNas(c, link.evt_id);
    assert.equal(link.dav_etag, ev.dav_etag);
    assert.equal(link.ical_uid, ev.ical_uid);
    // The caller writes it with the date, and the plan has its link.
    await c.store.append('alice', [{ op: 'plan.due', plan: 'gate', due: '2026-11-07' }, ...out]);
    assert.equal(gate(c).links.length, 1);

    // The next one finds the calendar in the log and makes no other.
    calls.length = 0;
    await syncDue(c, gate(c), '2026-11-09');
    assert.equal(calls.filter((x) => x.api === 'SYNO.Cal.Cal' && x.method === 'create').length, 0);
  });

  /** The gate plan due on the 7th, its event made and linked. */
  async function dueOn7th(c: ToolContext) {
    const out = await syncDue(c, gate(c), '2026-11-07');
    await c.store.append(c.who, [{ op: 'plan.due', plan: 'gate', due: '2026-11-07' }, ...out]);
    calls.length = 0;
    return gate(c).links[0]!;
  }

  test('an event changed on a phone only in its note is no disagreement: the new date goes on, and the note stays', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    const bobSid = await signIn('bob', 'pw-b');
    await setEvent(bobSid, await onNas(c, link.evt_id), { description: 'gate code 1234' }, via);
    calls.length = 0;
    const out = await syncDue(c, gate(c), '2026-11-09');
    assert.deepEqual(out.map((e) => e.op), ['plan.calendar.etag'], 'no drift');
    assert.equal(made('set').length, 2, 'refused once on the old etag, then set on the one it has now');
    const ev = await onNas(c, link.evt_id);
    assert.equal(ev.dtstart, at('2026-11-09T07:00:00Z'));
    assert.equal(ev.description, 'gate code 1234', 'their note is left as they wrote it');
    assert.equal((out[0] as Extract<NewEvent, { op: 'plan.calendar.etag' }>).dav_etag, ev.dav_etag);
    // Moved on a phone instead, it is the drift it always was.
    await setEvent(bobSid, ev, { dtstart: at('2026-11-10T07:00:00Z'), dtend: at('2026-11-11T07:00:00Z') }, via);
    await c.store.append('alice', [{ op: 'plan.due', plan: 'gate', due: '2026-11-09' }, ...out]);
    const again = await syncDue(c, gate(c), '2026-11-12');
    assert.deepEqual(again.map((e) => e.op), ['calendar.drift']);
  });

  test('a new due date moves the event, carrying the stored etag, and keeps the new one', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    const out = await syncDue(c, gate(c), '2026-11-09');
    assert.equal(made('create').length, 0);
    const [set] = made('set');
    assert.equal(set!.params.get('dav_etag'), link.dav_etag);
    assert.equal(set!.params.get('evt_id'), String(link.evt_id));
    assert.equal(set!.params.get('dtstart'), String(at('2026-11-09T07:00:00Z')));
    // Nothing undefined reaches the NAS as the word.
    for (const x of calls) assert.ok(![...x.params.values()].includes('undefined'), `${x.method} sent "undefined"`);
    const ev = await onNas(c, link.evt_id);
    assert.deepEqual(out, [{ op: 'plan.calendar.etag', plan: 'gate', evt_id: link.evt_id, dav_etag: ev.dav_etag }]);
    assert.notEqual(ev.dav_etag, link.dav_etag);
    assert.equal(ev.dtstart, at('2026-11-09T07:00:00Z'));
    await c.store.append('alice', [{ op: 'plan.due', plan: 'gate', due: '2026-11-09' }, ...out]);
    assert.equal(gate(c).links[0]!.dav_etag, ev.dav_etag);
  });

  test('clearing the due date deletes the event and unlinks it', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    const out = await syncDue(c, gate(c), null);
    assert.deepEqual(out, [{ op: 'plan.calendar.unlink', plan: 'gate', kind: 'due' }]);
    assert.equal(made('delete').length, 1);
    await assert.rejects(onNas(c, link.evt_id), 'gone from the NAS');
    await c.store.append('alice', [{ op: 'plan.due', plan: 'gate', due: null }, ...out]);
    assert.deepEqual(gate(c).links, []);
  });

  test('an event changed on a phone is drift: theirs from the NAS, ours as meant, and no write', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    // Bob moves it on his phone: a set with the etag he read.
    const bobSid = await signIn('bob', 'pw-b');
    const before = await onNas(c, link.evt_id);
    const moved = await setEvent(bobSid, before, { dtstart: at('2026-11-08T07:00:00Z'), dtend: at('2026-11-09T07:00:00Z') }, via);
    calls.length = 0;

    const out = await syncDue(c, gate(c), '2026-11-10');
    assert.deepEqual(out, [{
      op: 'calendar.drift', plan: 'gate', evt_id: link.evt_id,
      theirs: { dtstart: moved.dtstart, dtend: moved.dtend, summary: 'Fix the gate' },
      ours: { dtstart: at('2026-11-10T07:00:00Z'), dtend: at('2026-11-11T07:00:00Z'), summary: 'Fix the gate' },
      // The etag their version has, and who changed it, as the NAS says.
      dav_etag: moved.dav_etag, changedBy: 'bob',
    }]);
    // The refused set was the only write: never retried.
    assert.equal(made('set').length, 1);
    const after = await onNas(c, link.evt_id);
    assert.equal(after.dav_etag, moved.dav_etag);
    assert.equal(after.dtstart, moved.dtstart);
    await c.store.append('alice', [{ op: 'plan.due', plan: 'gate', due: '2026-11-10' }, ...out]);
    assert.equal([...c.store.state.drifts.values()].filter((d) => d.resolved === null).length, 1);

    // Clearing it now is drift too: their event is not deleted from under them.
    calls.length = 0;
    const cleared = await syncDue(c, gate(c), null);
    assert.equal(cleared[0]!.op, 'calendar.drift');
    assert.equal(made('delete').length, 0);
    await onNas(c, link.evt_id);
  });

  test('an event deleted on the NAS is drift with nothing on their side', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    await deleteEvent(c.sid!, link, via);
    const out = await syncDue(c, gate(c), '2026-11-10');
    assert.equal(out.length, 1);
    assert.equal(out[0]!.op, 'calendar.drift');
    assert.equal((out[0] as Extract<NewEvent, { op: 'calendar.drift' }>).theirs, null);
    // Cleared after it was deleted there: nothing left to delete, so it is simply unlinked.
    assert.deepEqual(await syncDue(c, gate(c), null), [{ op: 'plan.calendar.unlink', plan: 'gate', kind: 'due' }]);
  });

  test('the link keeps the ids the NAS answered the create with; later writes address it as the account lists it', async () => {
    const c = await setup();
    createReply = (d) => ({ ...d, cal_id: '/as-alice-sees-it/' });
    const link = await dueOn7th(c);
    const household = c.store.state.calendar.household!;
    assert.equal(link.cal_id, '/as-alice-sees-it/');
    assert.equal(link.original_cal_id, household.original_cal_id);
    // Same calendar by its original id: set where it is, not made again, by the id her account lists it under.
    createReply = null;
    const out = await syncDue(c, gate(c), '2026-11-09');
    assert.equal(made('create').length, 0);
    assert.equal(made('set')[0]!.params.get('cal_id'), household.cal_id);
    assert.equal(out[0]!.op, 'plan.calendar.etag');
  });

  test('a member who sees the Household calendar under an id of their own changes, checks and clears its events by it', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    const household = c.store.state.calendar.household!;
    // Bob's account lists the Household calendar as his own id; the log keeps alice's.
    nas.alias('bob', household.cal_id, '/bob/shared-household/');
    const bob = { ...c, who: 'bob', sid: await signIn('bob', 'pw-b') };
    calls.length = 0;

    // A new date: set where it is, addressed as bob's account knows it, not read as deleted.
    const out = await syncDue(bob, gate(c), '2026-11-09');
    assert.deepEqual(out.map((e) => e.op), ['plan.calendar.etag']);
    assert.equal(made('set')[0]!.params.get('cal_id'), '/bob/shared-household/');
    await c.store.append('bob', [{ op: 'plan.due', plan: 'gate', due: '2026-11-09' }, ...out]);

    // His look finds it as the app left it: no drift, and nothing said deleted.
    assert.deepEqual(await checkDrift(bob), []);
    assert.equal(made('get').at(-1)!.params.get('cal_id'), '/bob/shared-household/');

    // By alice's ids his account knows nothing: the NAS says 9009, which is not "deleted".
    await assert.rejects(getEvent(bob.sid!, link, via), (e: unknown) => e instanceof SynologyError && e.code === 9009);

    // Cleared: taken off the calendar by his id, and unlinked.
    const off = await syncDue(bob, gate(c), null);
    assert.deepEqual(off.map((e) => e.op), ['plan.calendar.unlink']);
    assert.equal(made('delete')[0]!.params.get('cal_id'), '/bob/shared-household/');
    await assert.rejects(onNas(c, link.evt_id));
  });

  test("a link on a calendar the looker's account does not list is skipped, never read as deleted", async () => {
    const c = await setup();
    // Alice's own calendar is where plans go; bob's account does not list it.
    await c.store.append('alice', { op: 'calendar.target', cal_id: '/alice/home/', original_cal_id: '/alice/home/' });
    const link = await dueOn7th(c);
    assert.equal(link.cal_id, '/alice/home/');
    const bob = { ...c, who: 'bob', sid: await signIn('bob', 'pw-b') };
    calls.length = 0;
    assert.deepEqual(await checkDrift(bob), []);
    assert.equal(made('get').length, 0, 'not asked about at all');
    assert.equal(openDrifts(c).length, 0);
    // And a change to it from bob is refused in words, not taken for an event gone.
    await assert.rejects(syncDue(bob, gate(c), null), (e: unknown) => e instanceof ToolError && e.status === 409);
    assert.deepEqual(gate(c).links.map((l) => l.evt_id), [link.evt_id]);
  });

  test("a date to place on a calendar the looker's account does not list is left for later: the look still finishes, and is not repeated", async (t) => {
    const c = await setup();
    const link = await dueOn7th(c); // on the Household calendar, which bob's account lists
    // Plans go to alice's own calendar now, which bob's account does not list; the fence has a date kept without a session.
    await c.store.append('alice', [
      { op: 'calendar.target', cal_id: '/alice/home/', original_cal_id: '/alice/home/' },
      { op: 'plan.create', plan: 'fence', title: 'Mend the fence', area: 'House' },
    ]);
    await setDue({ ...c, sid: null }, 'fence', '2026-11-09');
    assert.deepEqual(notOnCalendar(c.store.state.plans.get('fence')!), { due: true, blocks: [] });
    const logged: string[] = [];
    t.mock.method(console, 'warn', (...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    const bob = { ...c, who: 'bob', sid: await signIn('bob', 'pw-b') };
    calls.length = 0;

    assert.deepEqual(await checkDrift(bob), [], 'no throw, and nothing to report');
    assert.equal(made('get').length, 1, 'the linked event was still checked');
    assert.equal(made('create').length, 0, 'nothing was placed');
    assert.deepEqual(c.store.state.plans.get('fence')!.links, []);
    assert.deepEqual(gate(c).links.map((l) => l.evt_id), [link.evt_id]);
    assert.ok(logged.some((l) => /fence/.test(l) && /not shared with bob/.test(l)), 'it says so in the log');

    // The look went through, so the next load within ten minutes asks the NAS nothing.
    calls.length = 0;
    assert.deepEqual(await checkDriftNowAndThen(bob), []);
    assert.equal(calls.length, 0);
  });

  test('when the household has since chosen another calendar for plans, the event moves to it', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    // Alice's own calendar stands for the one chosen (the route checks it is shared with everyone).
    await c.store.append('alice', { op: 'calendar.target', cal_id: '/alice/home/', original_cal_id: '/alice/home/' });
    const out = await syncDue(c, gate(c), '2026-11-09');
    const relinked = out[0] as Extract<NewEvent, { op: 'plan.calendar.link' }>;
    assert.equal(relinked.op, 'plan.calendar.link');
    assert.equal(relinked.cal_id, '/alice/home/');
    assert.notEqual(relinked.evt_id, link.evt_id);
    await assert.rejects(onNas(c, link.evt_id), 'off the old one');
    assert.equal((await onNas(c, relinked.evt_id)).dtstart, at('2026-11-09T07:00:00Z'));
  });

  test('an event the NAS answers for without its ids is malformed, and never kept', () => {
    const row = { evt_id: 4, ical_uid: 'u', dav_etag: 'e', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };
    assert.equal(wellFormed(row), true);
    assert.equal(wellFormed({ ...row, cal_id: '' }), false, 'a listed row with no cal_id');
    assert.equal(wellFormed({ ...row, original_cal_id: undefined as never }), false);
    assert.equal(wellFormed({ ...row, evt_id: undefined as never }), false);
    assert.equal(wellFormed({ ...row, dav_etag: '' }), false);
  });

  test('a bypass sign-in has no NAS to call: sign in again, before anything is made', async () => {
    const c = { ...(await setup()), sid: null };
    await assert.rejects(syncDue(c, gate(c), '2026-11-07'), NeedsDsm);
    assert.equal(calls.length, 0);
    assert.equal(c.store.state.calendar.household, null);
    // Nothing on the calendar to change: nothing to ask the NAS, so no sid needed.
    assert.deepEqual(await syncDue(c, gate(c), null), []);
    assert.deepEqual(await unsyncAll(c, gate(c)), []);
  });

  test('a block is a timed event, linked by its id; letting it go deletes it', async () => {
    const c = await setup();
    const b = { id: 'block-1', start: '2026-11-07T16:00:00Z', end: '2026-11-07T19:00:00Z' };
    const out = await syncBlock(c, gate(c), b);
    const [create] = made('create');
    assert.equal(create!.params.get('is_all_day'), 'false');
    assert.equal(create!.params.get('dtstart'), String(at(b.start)));
    assert.equal(create!.params.get('dtend'), String(at(b.end)));
    const link = out[0] as Extract<NewEvent, { op: 'plan.calendar.link' }>;
    assert.equal(link.kind, 'block');
    assert.equal(link.block, 'block-1');
    await c.store.append('alice', [{ op: 'plan.block', plan: 'gate', block: b.id, start: b.start, end: b.end }, ...out]);

    // A second block is an event of its own.
    const b2 = { id: 'block-2', start: '2026-11-08T16:00:00Z', end: '2026-11-08T17:00:00Z' };
    await c.store.append('alice', [{ op: 'plan.block', plan: 'gate', block: b2.id, start: b2.start, end: b2.end },
      ...await syncBlock(c, gate(c), b2)]);
    assert.equal(gate(c).links.length, 2);

    calls.length = 0;
    const gone = await unsyncBlock(c, gate(c), 'block-1');
    assert.deepEqual(gone, [{ op: 'plan.calendar.unlink', plan: 'gate', kind: 'block', block: 'block-1' }]);
    assert.equal(made('delete').length, 1);
    await assert.rejects(onNas(c, link.evt_id));
    assert.deepEqual(await unsyncBlock(c, gate(c), 'no-such-block'), []);
  });

  test('unsyncAll takes every due and block event off the calendar, and leaves a removed plan alone', async () => {
    const c = await setup();
    const due = await dueOn7th(c);
    const b = { id: 'block-1', start: '2026-11-07T16:00:00Z', end: '2026-11-07T19:00:00Z' };
    await c.store.append('alice', [{ op: 'plan.block', plan: 'gate', block: b.id, start: b.start, end: b.end },
      ...await syncBlock(c, gate(c), b)]);
    const blockLink = gate(c).links.find((l) => l.kind === 'block')!;
    // Bob moves the block on his phone: it is his now, unlinked and left where he put it.
    const bobSid = await signIn('bob', 'pw-b');
    await setEvent(bobSid, await onNas(c, blockLink.evt_id), { summary: 'Gate, with Dad' }, via);
    calls.length = 0;

    const out = await unsyncAll(c, gate(c));
    assert.deepEqual(out, [
      { op: 'plan.calendar.unlink', plan: 'gate', kind: 'due' },
      { op: 'plan.calendar.unlink', plan: 'gate', kind: 'block', block: 'block-1' },
    ]);
    assert.equal(made('delete').length, 1, 'only the event nobody changed');
    await assert.rejects(onNas(c, due.evt_id));
    assert.equal((await onNas(c, blockLink.evt_id)).summary, 'Gate, with Dad');
    // Unlinks go before the remove, in one write.
    await c.store.append('alice', [...out, { op: 'plan.remove', plan: 'gate', why: 'fixed it ourselves' }]);
    assert.deepEqual(gate(c).links, []);
    assert.deepEqual(await unsyncAll(c, gate(c)), []);
  });

  test('compensating deletes only the event the effect made', async () => {
    const c = await setup();
    const out = await syncDue(c, gate(c), '2026-11-07');
    const link = out[0] as Extract<NewEvent, { op: 'plan.calendar.link' }>;
    await toolByName.get('set_plan_due')!.compensate!({ plan: 'gate', due: '2026-11-07' }, c, out);
    await assert.rejects(onNas(c, link.evt_id));
    // An etag or an unlink names nothing new: nothing to undo.
    calls.length = 0;
    await toolByName.get('block_plan_time')!.compensate!({}, c, [{ op: 'plan.calendar.etag', plan: 'gate', evt_id: 1, dav_etag: 'x' }]);
    assert.equal(calls.length, 0);
  });

  // ── the same, through the tools and their cards ──────────────────────────

  const card = (c: ToolContext, tool: string, args: Record<string, unknown>) =>
    offer(c, { tool, args, prompt: { kind: 'briefing', ref: null } });

  test('two cards setting the same plan\'s due date, approved at once, leave one event and one link', async () => {
    const c = await setup();
    const one = await card(c, 'set_plan_due', { plan: 'gate', due: '2026-11-07' });
    const two = await card(c, 'set_plan_due', { plan: 'gate', due: '2026-11-08' });
    const bob = { ...c, who: 'bob', sid: await signIn('bob', 'pw-b') };
    calls.length = 0;
    const settled = await Promise.allSettled([decide(c, one.id, 'approved'), decide(bob, two.id, 'approved')]);
    assert.ok(settled.every((r) => r.status === 'fulfilled'), JSON.stringify(settled));
    assert.equal(made('create').length, 1, 'one event made');
    assert.equal(gate(c).links.filter((l) => l.kind === 'due').length, 1, 'one link');
  });

  test('approving a due date writes the decision, the date and the link in one write', async () => {
    const c = await setup();
    const o = await card(c, 'set_plan_due', { plan: 'gate', due: '2026-11-07' });
    const written = await decide(c, o.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.due', 'plan.calendar.link']);
    assert.equal(new Set(written.map((e) => e.at)).size, 1);
    assert.equal(gate(c).due, '2026-11-07');
    assert.ok(c.store.state.calendar.household, 'the Household calendar was made on the way');
    await onNas(c, gate(c).links[0]!.evt_id);

    // Cleared from a card: the event goes, and the link with it.
    const clear = await card(c, 'set_plan_due', { plan: 'gate', due: null });
    const cleared = await decide(c, clear.id, 'approved');
    assert.deepEqual(cleared.map((e) => e.op), ['proposal.decide', 'plan.due', 'plan.calendar.unlink']);
    assert.deepEqual(gate(c).links, []);
  });

  test('committing a block from the conversation links the block the proposal named', async () => {
    const c = await setup();
    const p = await runTool(toolByName.get('block_plan_time')!,
      { plan: 'gate', start: '2026-11-07T16:00:00Z', end: '2026-11-07T19:00:00Z' }, c) as Proposal;
    const { committed } = await commit(p.id, c);
    assert.deepEqual(committed.map((e) => e.op), ['plan.block', 'plan.calendar.link']);
    const blockId = (committed[0] as Extract<Event, { op: 'plan.block' }>).block;
    assert.equal(gate(c).links[0]!.block, blockId);
  });

  test('removing a plan unlinks its events before it is removed, in the same write', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    const o = await card(c, 'remove_plan', { plan: 'gate', why: 'fixed it ourselves' });
    const written = await decide(c, o.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.calendar.unlink', 'plan.remove']);
    assert.equal(gate(c).removed, true);
    await assert.rejects(onNas(c, link.evt_id));
  });

  test('a card approved without a NAS session is refused before anything is written', async () => {
    const c = await setup();
    const o = await card(c, 'set_plan_due', { plan: 'gate', due: '2026-11-07' });
    const before = (await c.store.since(null)).length;
    await assert.rejects(decide({ ...c, sid: null }, o.id, 'approved'), NeedsDsm);
    assert.equal((await c.store.since(null)).length, before);
    assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'open');
  });

  test('when the write after the NAS is refused, the event it made is deleted again', async () => {
    const c = await setup();
    const o = await card(c, 'set_plan_due', { plan: 'gate', due: '2026-11-07' });
    // While the NAS makes the event, bob removes the plan: the link the effect returns is then refused.
    onCreate = async () => { await c.store.append('bob', { op: 'plan.remove', plan: 'gate', why: 'never mind' }); };
    const before = (await c.store.since(null)).length;
    await assert.rejects(decide(c, o.id, 'approved'), (e: unknown) => e instanceof ToolError && e.status === 409);
    onCreate = null;
    // The Household calendar made on the way stands; of the approval, nothing.
    assert.deepEqual((await c.store.since(null)).slice(before).map((e) => e.op), ['calendar.household', 'plan.remove']);
    assert.equal(made('create').length, 1);
    assert.equal(made('delete').length, 1, 'the event was taken back off the calendar');
    const deleted = Number(made('delete')[0]!.params.get('evt_id'));
    await assert.rejects(onNas(c, deleted));
  });
  // ── drift becomes a card ─────────────────────────────────────────────────

  /** Bob changes the event on his phone: a set with the etag he read, as any other client does. */
  async function bobChanges(c: ToolContext, evt_id: number, changes: Partial<{ dtstart: number; dtend: number; summary: string }>) {
    const bobSid = await signIn('bob', 'pw-b');
    const moved = await setEvent(bobSid, await onNas(c, evt_id), changes, via);
    calls.length = 0;
    return moved;
  }
  const openDrifts = (c: ToolContext) => [...c.store.state.drifts.entries()].filter(([, d]) => d.resolved === null);
  const driftCards = (c: ToolContext, status = 'open') =>
    [...c.store.state.thread.offers.values()].filter((o) => o.tool === 'resolve_drift' && o.status === status);
  const NOV8 = { dtstart: at('2026-11-08T07:00:00Z'), dtend: at('2026-11-09T07:00:00Z') };
  const writes = () => made('set').length + made('create').length + made('delete').length;
  /** The gate's due date on the 7th, moved by bob to the 8th, and the card checkDrift raised for it. */
  async function movedAndAsked(c: ToolContext) {
    const link = await dueOn7th(c);
    const moved = await bobChanges(c, link.evt_id, NOV8);
    await checkDrift(c);
    const [card] = driftCards(c);
    assert.ok(card, 'a card was raised');
    calls.length = 0;
    return { link, moved, card: card!, drift: String(card!.args['drift']) };
  }

  test('a date kept without a NAS session is said to be off the calendar, and the next look with one puts it there', async () => {
    const c = await setup();
    const out = await setDue({ ...c, sid: null }, 'gate', '2026-11-07');
    assert.equal(out.calendar, 'sign in again');
    const b = await addBlock({ ...c, sid: null }, 'gate', '2026-11-07T16:00:00Z', '2026-11-07T17:00:00Z');
    const blockId = b.plan.blocks[0]!.id;
    assert.deepEqual(gate(c).links, []);
    assert.deepEqual(notOnCalendar(gate(c)), { due: true, blocks: [blockId] });
    const view = planCard(c.store.state, await c.store.since(null), 'gate', { who: 'alice', today: '2026-10-29', tz: ZONE });
    assert.deepEqual(view.notOnCalendar, { due: true, blocks: [blockId] });
    const rail = board(c.store.state, await c.store.since(null), { who: 'alice', filter: 'mine', today: '2026-10-29', tz: ZONE })
      .flatMap((r) => [...r.planning, ...r.doing]).find((x) => x.id === 'gate')!;
    assert.equal(rail.notOnCalendar, true);

    calls.length = 0;
    const found = await checkDrift(c);
    assert.deepEqual(found.map((e) => e.op).sort(), ['plan.calendar.link', 'plan.calendar.link']);
    assert.equal(made('create').length, 2);
    assert.deepEqual(gate(c).links.map((l) => l.kind).sort(), ['block', 'due']);
    assert.deepEqual(notOnCalendar(gate(c)), { due: false, blocks: [] });
    const due = gate(c).links.find((l) => l.kind === 'due')!;
    assert.equal((await onNas(c, due.evt_id)).dtstart, at('2026-11-07T07:00:00Z'));
    // Placed once: the next look has nothing to put there.
    calls.length = 0;
    await checkDrift(c);
    assert.equal(made('create').length, 0);
  });

  test("Today's ten minutes start from a look that went through: one that stopped looks again on the next load", async () => {
    const c = await setup();
    await dueOn7th(c);
    // A session the NAS no longer knows: the look stops at its first call.
    assert.deepEqual(await checkDriftNowAndThen({ ...c, sid: 'ended-long-ago' }), []);
    calls.length = 0;
    await checkDriftNowAndThen(c);
    assert.ok(made('get').length > 0, 'looked again, with a session that works');
    // That one went through: the next load within ten minutes asks the NAS nothing.
    calls.length = 0;
    await checkDriftNowAndThen(c);
    assert.equal(calls.length, 0);
  });

  test('checkDrift: an event moved on a phone is one drift and one card asking what to do, asked once', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    const moved = await bobChanges(c, link.evt_id, NOV8);
    const out = await checkDrift(c);
    assert.deepEqual(out.map((e) => e.op), ['calendar.drift', 'proposal.offer']);
    const [[id, d]] = openDrifts(c) as [[string, any]];
    assert.deepEqual(d.theirs, { ...NOV8, summary: 'Fix the gate' });
    assert.deepEqual(d.ours, { dtstart: at('2026-11-07T07:00:00Z'), dtend: at('2026-11-08T07:00:00Z'), summary: 'Fix the gate' });
    assert.equal(d.dav_etag, moved.dav_etag);
    assert.equal(d.changedBy, 'bob');
    const [card] = driftCards(c);
    assert.deepEqual(card!.prompt, { kind: 'drift', ref: id });
    assert.deepEqual(card!.args, { drift: id, plan: 'gate', choice: 'plan' });
    assert.equal(card!.summary, 'Bob moved Fix the gate to Sun 8 Nov on their phone');
    assert.deepEqual(card!.effects, ['The plan says Sat 7 Nov', 'The calendar says Sun 8 Nov']);
    assert.equal(card!.fingerprint, '');
    assert.equal(writes(), 0, 'looking changes nothing on the NAS');
    // Asked once: checking again finds the drift already open.
    assert.deepEqual(await checkDrift(c), []);
    assert.equal(driftCards(c).length, 1);
    assert.equal(openDrifts(c).length, 1);
  });

  test('Move the plan too: the plan takes the calendar\'s date and the etag it saw, with the decision, in one write', async () => {
    const c = await setup();
    const { moved, card, drift } = await movedAndAsked(c);
    const written = await decide(c, card.id, 'approved', undefined, { choice: 'plan' });
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.due', 'plan.calendar.etag', 'calendar.drift.resolve']);
    assert.equal(new Set(written.map((e) => e.at)).size, 1);
    assert.equal(gate(c).due, '2026-11-08');
    assert.equal(gate(c).links[0]!.dav_etag, moved.dav_etag);
    assert.equal(c.store.state.drifts.get(drift)!.resolved, 'plan');
    assert.equal(writes(), 0, 'the calendar is left where they put it');
    assert.deepEqual(await checkDrift(c), [], 'and nothing is asked again');
  });

  test('Put the calendar back: the event returns to the plan\'s date, changed with the etag it has now', async () => {
    const c = await setup();
    const { link, moved, card, drift } = await movedAndAsked(c);
    const written = await decide(c, card.id, 'approved', undefined, { choice: 'calendar' });
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.calendar.etag', 'calendar.drift.resolve']);
    assert.equal(made('set').length, 1);
    assert.equal(made('set')[0]!.params.get('dav_etag'), moved.dav_etag, 'changed with the etag it has now');
    const ev = await onNas(c, link.evt_id);
    assert.equal(ev.dtstart, at('2026-11-07T07:00:00Z'));
    assert.equal(ev.dtend, at('2026-11-08T07:00:00Z'));
    assert.equal(gate(c).links[0]!.dav_etag, ev.dav_etag);
    assert.equal(gate(c).due, '2026-11-07');
    assert.equal(c.store.state.drifts.get(drift)!.resolved, 'calendar');
    assert.deepEqual(await checkDrift(c), []);
  });

  test('Leave both: nothing moves, and the version on the calendar is the one the app now knows', async () => {
    const c = await setup();
    const { link, moved, card, drift } = await movedAndAsked(c);
    const written = await decide(c, card.id, 'approved', undefined, { choice: 'leave' });
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.calendar.etag', 'calendar.drift.resolve']);
    assert.equal(writes(), 0);
    assert.equal(gate(c).due, '2026-11-07');
    assert.equal((await onNas(c, link.evt_id)).dtstart, NOV8.dtstart);
    assert.equal(gate(c).links[0]!.dav_etag, moved.dav_etag);
    assert.equal(c.store.state.drifts.get(drift)!.resolved, 'leave');
    assert.deepEqual(await checkDrift(c), [], 'left is left: not asked again');
  });

  test('an event deleted from the calendar: the card says so, and only moving the plan or leaving both is offered', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    await deleteEvent(c.sid!, link, via);
    await checkDrift(c);
    const [[, d]] = openDrifts(c) as [[string, any]];
    assert.equal(d.theirs, null);
    const [card] = driftCards(c);
    assert.match(card!.summary, /deleted/);
    assert.equal(card!.summary, 'Fix the gate was deleted from the calendar');
    assert.deepEqual(card!.effects, ['The plan says Sat 7 Nov', 'The calendar has nothing: it was deleted']);
    // There is no event to put back.
    const before = (await c.store.since(null)).length;
    await assert.rejects(decide(c, card!.id, 'approved', undefined, { choice: 'calendar' }),
      (e: unknown) => e instanceof ToolError && e.status === 409 && /deleted/.test(e.message));
    assert.equal((await c.store.since(null)).length, before, 'nothing written');
    // Moving the plan too clears its date, and lets the event go.
    const written = await decide(c, card!.id, 'approved', undefined, { choice: 'plan' });
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.calendar.unlink', 'plan.due', 'calendar.drift.resolve']);
    assert.equal(gate(c).due, null);
    assert.deepEqual(gate(c).links, []);
    assert.deepEqual(await checkDrift(c), []);
  });

  test('leaving both on a deleted event keeps the date and lets the event go', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    await deleteEvent(c.sid!, link, via);
    await checkDrift(c);
    const [card] = driftCards(c);
    const written = await decide(c, card!.id, 'approved', undefined, { choice: 'leave' });
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.calendar.unlink', 'calendar.drift.resolve']);
    assert.equal(gate(c).due, '2026-11-07');
    assert.deepEqual(gate(c).links, []);
    assert.deepEqual(await checkDrift(c), [], 'an event no longer linked is not asked about');
  });

  test('a moved block: the card gives the times where the household is, and moving the plan too moves the block', async () => {
    const c = await setup();
    const b = { id: 'block-1', start: '2026-11-07T16:00:00Z', end: '2026-11-07T19:00:00Z' };
    await c.store.append('alice', [{ op: 'plan.block', plan: 'gate', block: b.id, start: b.start, end: b.end },
      ...await syncBlock(c, gate(c), b)]);
    const link = gate(c).links[0]!;
    await bobChanges(c, link.evt_id, { dtstart: at('2026-11-08T17:00:00Z'), dtend: at('2026-11-08T20:00:00Z') });
    await checkDrift(c);
    const [card] = driftCards(c);
    assert.equal(card!.summary, 'Bob moved Fix the gate to Sun 8 Nov, 10:00 on their phone');
    assert.deepEqual(card!.effects, ['The plan says Sat 7 Nov, 9:00–12:00', 'The calendar says Sun 8 Nov, 10:00–13:00']);
    const written = await decide(c, card!.id, 'approved', undefined, { choice: 'plan' });
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.block', 'plan.calendar.etag', 'calendar.drift.resolve']);
    assert.deepEqual(gate(c).blocks, [{ id: 'block-1', start: '2026-11-08T17:00:00.000Z', end: '2026-11-08T20:00:00.000Z' }]);
    assert.deepEqual(await checkDrift(c), []);
  });

  test('a renamed event is a drift too: the card says so, and moving the plan too takes the new name', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    const renamed = await bobChanges(c, link.evt_id, { summary: 'Gate (bring the hinges)' });
    const out = await checkDrift(c);
    assert.deepEqual(out.map((e) => e.op), ['calendar.drift', 'proposal.offer']);
    const [card] = driftCards(c);
    assert.equal(card!.summary, 'Bob renamed Fix the gate to "Gate (bring the hinges)" on their phone');
    assert.deepEqual(card!.effects, ['The plan calls it Fix the gate', 'The calendar calls it Gate (bring the hinges)']);
    const written = await decide(c, card!.id, 'approved', undefined, { choice: 'plan' });
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.set', 'plan.calendar.etag', 'calendar.drift.resolve']);
    assert.equal(gate(c).title, 'Gate (bring the hinges)');
    assert.equal(gate(c).due, '2026-11-07');
    assert.equal(gate(c).links[0]!.dav_etag, renamed.dav_etag);
    assert.deepEqual(await checkDrift(c), []);
  });

  test('a change on the calendar that keeps the plan\'s times and name is no drift: the new etag is kept, and nothing asked', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    const noted = await bobChanges(c, link.evt_id, { description: 'Bring the long screwdriver' } as never);
    const out = await checkDrift(c);
    assert.deepEqual(out.map((e) => e.op), ['plan.calendar.etag']);
    assert.equal(gate(c).links[0]!.dav_etag, noted.dav_etag);
    assert.equal(openDrifts(c).length, 0);
    assert.equal(driftCards(c).length, 0);
  });

  test('one link the NAS refuses does not hide the rest: it is logged, and the next is still looked at', async (t) => {
    const c = await setup();
    const due = await dueOn7th(c);
    const b = { id: 'block-1', start: '2026-11-07T16:00:00Z', end: '2026-11-07T19:00:00Z' };
    await c.store.append('alice', [{ op: 'plan.block', plan: 'gate', block: b.id, start: b.start, end: b.end },
      ...await syncBlock(c, gate(c), b)]);
    const blockLink = gate(c).links.find((l) => l.kind === 'block')!;
    await bobChanges(c, blockLink.evt_id, { dtstart: at('2026-11-08T17:00:00Z'), dtend: at('2026-11-08T20:00:00Z') });
    const logged: string[] = [];
    t.mock.method(console, 'warn', (...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    // The due date's event answers "no permission" (105); every other call goes through.
    const refusing = (async (url: string | URL | Request, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      if (params.get('method') === 'get' && params.get('evt_id') === String(due.evt_id)) {
        return new Response(JSON.stringify({ success: false, error: { code: 105 } }), { headers: { 'content-type': 'application/json' } });
      }
      return via(url, init);
    }) as DsmFetch;
    const out = await checkDrift(c, refusing);
    assert.deepEqual(out.map((e) => e.op), ['calendar.drift', 'proposal.offer']);
    const [card] = driftCards(c);
    assert.equal(card!.summary, 'Bob moved Fix the gate to Sun 8 Nov, 10:00 on their phone');
    assert.equal(logged.length, 1, 'the refusal is in the log');
    assert.ok(!logged[0]!.includes(c.sid!), 'never the sid');
  });

  test('putting the calendar back does not overwrite a later change on the phone: it asks to look again', async () => {
    const c = await setup();
    const { link, card } = await movedAndAsked(c);
    const later = await bobChanges(c, link.evt_id, { dtstart: at('2026-11-09T07:00:00Z'), dtend: at('2026-11-10T07:00:00Z') });
    const before = (await c.store.since(null)).length;
    await assert.rejects(decide(c, card.id, 'approved', undefined, { choice: 'calendar' }),
      (e: unknown) => e instanceof ToolError && e.status === 409 && /changed again on the calendar; look at it again/.test(e.message));
    assert.equal((await c.store.since(null)).length, before, 'nothing written');
    assert.equal(made('set').length, 0, 'nothing changed on the NAS');
    assert.equal((await onNas(c, link.evt_id)).dav_etag, later.dav_etag);
  });

  test('checkDrift never throws for the NAS: the failure is logged without the sid, and what was done is returned', async (t) => {
    const c = await setup();
    const link = await dueOn7th(c);
    await bobChanges(c, link.evt_id, NOV8);
    const logged: string[] = [];
    t.mock.method(console, 'warn', (...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as DsmFetch;
    assert.deepEqual(await checkDrift(c, down), []);
    assert.equal(openDrifts(c).length, 0);
    assert.ok(logged.length >= 1, 'it says so in the log');
    assert.ok(logged.every((l) => !l.includes(c.sid!)), 'never the sid');
  });

  test('a sign-in with no NAS session checks nothing, and says nothing', async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    await bobChanges(c, link.evt_id, NOV8);
    assert.deepEqual(await checkDrift({ ...c, sid: null }), []);
    assert.equal(calls.length, 0);
  });

  test('removing a plan settles its open drift as left and retires its card, in the same write', async () => {
    const c = await setup();
    const { card, drift } = await movedAndAsked(c);
    const o = await offer(c, { tool: 'remove_plan', args: { plan: 'gate', why: 'fixed it ourselves' }, prompt: { kind: 'briefing', ref: null } });
    const written = await decide(c, o.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.calendar.unlink', 'calendar.drift.resolve', 'plan.remove']);
    assert.equal(c.store.state.drifts.get(drift)!.resolved, 'leave');
    assert.equal(c.store.state.thread.offers.get(card.id)!.status, 'replaced');
    assert.equal(writes(), 0, 'their event is left where they put it');
  });

  test('a member removing the plan directly settles its drift the same way', async () => {
    const c = await setup();
    const { card, drift } = await movedAndAsked(c);
    const before = (await c.store.since(null)).length;
    await removePlan(c, 'gate', 'fixed it ourselves');
    assert.deepEqual((await c.store.since(null)).slice(before).map((e) => e.op),
      ['plan.calendar.unlink', 'calendar.drift.resolve', 'plan.remove']);
    assert.equal(c.store.state.drifts.get(drift)!.resolved, 'leave');
    assert.equal(c.store.state.thread.offers.get(card.id)!.status, 'replaced');
  });

  test('a drift found while changing the plan is asked about at once, and its card replaces the one it supersedes', async () => {
    const c = await setup();
    const { card } = await movedAndAsked(c);
    await setDue(c, 'gate', '2026-11-10');
    assert.equal(c.store.state.thread.offers.get(card.id)!.status, 'replaced');
    const open = driftCards(c);
    assert.equal(open.length, 1);
    assert.equal(openDrifts(c).length, 1);
    assert.equal(open[0]!.args['drift'], openDrifts(c)[0]![0]);
    assert.deepEqual(open[0]!.effects, ['The plan says Tue 10 Nov', 'The calendar says Sun 8 Nov']);
  });

  test('a drift card is settled by one of its three choices: never declined, put off, or chosen outside them', async () => {
    const c = await setup();
    const { card } = await movedAndAsked(c);
    const due = await offer(c, { tool: 'set_plan_due', args: { plan: 'gate', due: '2026-11-20' }, prompt: { kind: 'briefing', ref: null } });
    const before = (await c.store.since(null)).length;
    const refused400 = (e: unknown) => e instanceof ToolError && e.status === 400;
    await assert.rejects(decide(c, card.id, 'declined'), refused400);
    await assert.rejects(decide(c, card.id, 'snoozed'), refused400);
    await assert.rejects(decide(c, card.id, 'approved', undefined, { choice: 'both' }), refused400);
    await assert.rejects(decide(c, card.id, 'approved', undefined, { plan: 'elsewhere' }), refused400);
    // Nor can any other card's arguments be changed as it is approved.
    await assert.rejects(decide(c, due.id, 'approved', undefined, { due: '2026-12-25' }), refused400);
    assert.equal((await c.store.since(null)).length, before, 'nothing written');
  });

  // ── "Schedule my dentist at 10 on Thursday" ──────────────────────────────

  /** Today is Thursday 29 October; "Thursday" is the 5th, after the clocks went back (UTC-7). */
  const THU = (hhmm: string) => `2026-11-05T${hhmm}`;
  const dentist = (more: Record<string, unknown> = {}) =>
    ({ summary: 'Dentist', start: THU('10:00'), end: THU('11:00'), on: 'mine', ...more });
  const propose = (c: ToolContext, args: Record<string, unknown>) =>
    runTool(toolByName.get('propose_event')!, args, c) as Promise<Proposal>;

  /** The NAS outlives each test: a calendar's Thursday starts empty. */
  async function clearThursday(sid: string, cal_id: string) {
    const day = { calendars: [{ cal_id, original_cal_id: cal_id }], start: at('2026-11-05T07:00:00Z'), end: at('2026-11-06T07:00:00Z') };
    for (const e of await listEvents(sid, day, via)) await deleteEvent(sid, { ...e, cal_id }, via);
  }

  /** Bob's own calendar shared with alice and checked by her as "Bob", with his PT on it. */
  async function bobHasPT(c: ToolContext, from: string, to: string) {
    const bobSid = await signIn('bob', 'pw-b');
    await shareCalendar(bobSid, '/bob/home/', { users: [{ name: 'alice', privilege: 'RO' }] }, via);
    await clearThursday(bobSid, '/bob/home/');
    await clearThursday(c.sid!, '/alice/home/');
    await createEvent(bobSid, {
      cal_id: '/bob/home/', original_cal_id: '/bob/home/', summary: 'PT', description: '',
      is_all_day: false, dtstart: at(`${THU(from)}:00-07:00`), dtend: at(`${THU(to)}:00-07:00`), tz_id: ZONE,
    }, via);
    await c.store.append('alice', { op: 'calendar.conflicts', calendars: [{ cal_id: '/bob/home/', original_cal_id: '/bob/home/', label: 'Bob' }] });
    calls.length = 0;
  }

  test('propose_event refuses an end before its start, or a time already gone, before any proposal or call', async () => {
    const c = await setup();
    await assert.rejects(propose(c, dentist({ end: THU('09:00') })), (e: unknown) => e instanceof ToolError && /end after it starts/.test(e.message));
    await assert.rejects(propose(c, dentist({ end: THU('10:00') })), ToolError, 'no time at all is no appointment');
    await assert.rejects(propose(c, dentist({ start: '2026-10-28T10:00', end: '2026-10-28T11:00' })),
      (e: unknown) => e instanceof ToolError && /already gone/.test(e.message));
    const hourAgo = new Date(Date.now() - 3_600_000);
    const local = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: ZONE, dateStyle: 'short', timeStyle: 'short' }).format(d).replace(' ', 'T');
    await assert.rejects(propose({ ...c, today: new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date()) },
      dentist({ start: local(hourAgo), end: local(new Date(hourAgo.getTime() + 1_800_000)) })), ToolError, 'earlier today has gone too');
    await assert.rejects(propose(c, dentist({ start: '2026-11-05', end: THU('11:00') })), ToolError, 'a time, unless all day');
    await assert.rejects(propose(c, dentist({ on: 'theirs' })), ToolError);
    assert.equal(calls.length, 0, 'nothing asked of the NAS');
  });

  test('a bypass sign-in cannot be offered an appointment: there is no calendar to check it against', async () => {
    const c = { ...(await setup()), sid: null };
    await assert.rejects(propose(c, dentist()), NeedsDsm);
    assert.equal(calls.length, 0);
  });

  test('a clash leads the card, by calendar and time, then three free times; the time asked is kept', async () => {
    const c = await setup();
    await bobHasPT(c, '10:30', '11:30');
    const p = await propose(c, dentist());
    assert.equal(p.summary, "Dentist · Thu 5 Nov, 10:00–11:00 · on Alice's calendar");
    assert.deepEqual(p.effects.slice(0, 4), [
      'Clashes with Bob · PT 10:30',
      'Free instead: Thu 9:30–10:30',
      'Free instead: Thu 8:30–9:30',
      'Free instead: Thu 11:30–12:30',
    ]);
    assert.deepEqual(p.events, []);
    assert.deepEqual(p.args, { ...dentist(), for: 'alice' }, 'the card is for the time asked, whatever else it offers');
    // Read from alice's own calendar and Bob's, and nothing else.
    const listed = made('list').map((x) => JSON.parse(x.params.get('cal_id_list')!) as string[]).flat();
    assert.deepEqual(new Set(listed), new Set(['/alice/home/', '/bob/home/']));
    assert.equal(made('create').length, 0, 'nothing made until it is approved');
  });

  test('no clash: the first line says where it was looked for, then what is near but not in the way', async () => {
    const c = await setup();
    await bobHasPT(c, '11:00', '12:00');
    const p = await propose(c, dentist({ on: 'household' }));
    assert.equal(p.summary, 'Dentist · Thu 5 Nov, 10:00–11:00 · on the Household calendar');
    // A card the household sees names what is on someone's own calendars by calendar and time, never by title.
    assert.deepEqual(p.effects, [
      "Nothing at that time on Alice's calendar or Bob",
      'Bob is busy 11:00–12:00 the same morning — not a clash',
    ]);
    // On her own card, which only she sees, Bob's PT is named as Bob shared it with her.
    assert.ok((await propose(c, dentist())).effects.includes('Bob has PT at 11:00 the same morning — not a clash'));
  });

  test('freeSlotsNear: the same length, the same day, 07:00 to 21:00, clear of everything, nearest first', () => {
    const h = (hhmm: string) => at(`${THU(hhmm)}:00-07:00`);
    const busy = [{ dtstart: h('07:00'), dtend: h('11:30'), is_all_day: false }, { dtstart: h('12:00'), dtend: h('20:00'), is_all_day: false }];
    const slots = freeSlotsNear(busy, h('10:00'), h('11:00'), ZONE, 0);
    assert.deepEqual(slots, [{ start: h('20:00'), end: h('21:00') }], 'the one free hour; 11:30 is only half one');
    // An all-day event is in nobody's way.
    assert.equal(freeSlotsNear([{ dtstart: h('00:00'), dtend: h('00:00') + 86_400, is_all_day: true }], h('10:00'), h('11:00'), ZONE, 0).length, 3);
  });

  test('approved on the Household calendar, it is made there and recorded as the NAS answered', async () => {
    const c = await setup();
    const out = await toolByName.get('propose_event')!.effect!(dentist({ on: 'household' }), c, []);
    const household = c.store.state.calendar.household!;
    assert.ok(household, 'made on the way, as a due date would');
    assert.equal(out.length, 1);
    const a = out[0] as Extract<NewEvent, { op: 'calendar.appointment' }>;
    assert.equal(a.op, 'calendar.appointment');
    const ev = await onNas(c, a.evt_id);
    assert.equal(ev.cal_id, household.cal_id);
    assert.deepEqual(a, {
      op: 'calendar.appointment', evt_id: ev.evt_id, cal_id: ev.cal_id, original_cal_id: ev.original_cal_id,
      ical_uid: ev.ical_uid, dav_etag: ev.dav_etag, summary: 'Dentist',
      start: '2026-11-05T17:00:00.000Z', end: '2026-11-05T18:00:00.000Z', allDay: false,
    });
    assert.equal(ev.dtstart, at('2026-11-05T17:00:00Z'));
    assert.equal(ev.tz_id, ZONE);
    await c.store.append('alice', out);
    assert.equal(c.store.state.appointments.get(a.evt_id)!.who, 'alice');
  });

  test("approved as mine, it goes on the approver's own default calendar", async () => {
    const c = await setup();
    const out = await toolByName.get('propose_event')!.effect!(dentist(), c, []);
    const a = out[0] as Extract<NewEvent, { op: 'calendar.appointment' }>;
    assert.equal(a.cal_id, '/alice/home/');
    assert.equal((await onNas(c, a.evt_id)).cal_id, '/alice/home/');
    assert.equal(c.store.state.calendar.household, null, 'no Household calendar needed for one of your own');
  });

  test('an all-day appointment runs midnight to midnight where the household is', async () => {
    const c = await setup();
    const p = await propose(c, dentist({ start: '2026-11-05', end: '2026-11-05', allDay: true }));
    assert.equal(p.summary, "Dentist · Thu 5 Nov, all day · on Alice's calendar");
    const out = await toolByName.get('propose_event')!.effect!(dentist({ start: '2026-11-05', end: '2026-11-05', allDay: true }), c, []);
    const ev = await onNas(c, (out[0] as Extract<NewEvent, { op: 'calendar.appointment' }>).evt_id);
    assert.equal(ev.is_all_day, true);
    assert.equal(ev.dtstart, at('2026-11-05T07:00:00Z'));
    assert.equal(ev.dtend, at('2026-11-06T07:00:00Z'));
  });

  test('with makePlan, approving writes the plan, the appointment and its link in one write', async () => {
    const c = await setup();
    const o = await card(c, 'propose_event', dentist({ makePlan: { area: 'People' } }));
    assert.ok(o.effects.includes('A new plan in People: Dentist'));
    const written = await decide(c, o.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.create', 'calendar.appointment', 'plan.calendar.link']);
    assert.equal(new Set(written.map((e) => e.at)).size, 1);
    const made = written[1] as Extract<Event, { op: 'plan.create' }>;
    const plan = c.store.state.plans.get(made.plan)!;
    assert.equal(plan.title, 'Dentist');
    assert.equal(plan.area, 'People');
    const a = written[2] as Extract<Event, { op: 'calendar.appointment' }>;
    assert.equal(a.plan, made.plan);
    assert.deepEqual(plan.links.map((l) => [l.kind, l.evt_id]), [['appointment', a.evt_id]]);
  });

  test('when the write after the NAS is refused, the appointment is deleted again and nothing is written', async () => {
    const c = await setup();
    const o = await card(c, 'propose_event', dentist({ plan: 'gate' }));
    onCreate = async () => { await c.store.append('bob', { op: 'plan.remove', plan: 'gate', why: 'never mind' }); };
    const before = (await c.store.since(null)).length;
    await assert.rejects(decide(c, o.id, 'approved'), (e: unknown) => e instanceof ToolError && e.status === 409);
    onCreate = null;
    assert.deepEqual((await c.store.since(null)).slice(before).map((e) => e.op), ['plan.remove']);
    assert.equal(made('create').length, 1);
    assert.equal(made('delete').length, 1);
    await assert.rejects(onNas(c, Number(made('delete')[0]!.params.get('evt_id'))));
  });

  test('compensating an appointment made for a new plan deletes its event once', async () => {
    const c = await setup();
    const tool = toolByName.get('propose_event')!;
    const out = await tool.effect!(dentist({ makePlan: { area: 'People' } }), c, []);
    assert.deepEqual(out.map((e) => e.op), ['plan.create', 'calendar.appointment', 'plan.calendar.link']);
    calls.length = 0;
    await tool.compensate!({}, c, out);
    assert.equal(made('delete').length, 1);
    await assert.rejects(onNas(c, (out[1] as Extract<NewEvent, { op: 'calendar.appointment' }>).evt_id));
  });

  // ── whose calendar, which calendars, and a plan renamed ─────────────────

  test("one for the asker's own calendar names them, and only they can approve it", async () => {
    const c = await setup();
    // Whatever Claude sent as `for`, the card is the asker's.
    const o = await card(c, 'propose_event', dentist({ for: 'bob' }));
    assert.equal(o.args['for'], 'alice');
    assert.equal(o.summary, "Dentist · Thu 5 Nov, 10:00–11:00 · on Alice's calendar");
    const bob = { ...c, who: 'bob', sid: await signIn('bob', 'pw-b') };
    calls.length = 0;
    const before = (await c.store.since(null)).length;
    await assert.rejects(decide(bob, o.id, 'approved'),
      (e: unknown) => e instanceof ToolError && e.status === 409 && /only Alice can put this on their own calendar/.test(e.message));
    assert.equal(calls.length, 0, 'nothing asked of the NAS, nothing made');
    assert.equal((await c.store.since(null)).length, before);
    assert.equal(c.store.state.thread.offers.get(o.id)!.status, 'open');
    const written = await decide(c, o.id, 'approved');
    const a = written.find((e) => e.op === 'calendar.appointment') as Extract<Event, { op: 'calendar.appointment' }>;
    assert.equal(a.cal_id, '/alice/home/');
    assert.equal((await onNas(c, a.evt_id)).cal_id, '/alice/home/');
    // One for the Household calendar is anyone's to approve, and names nobody.
    const h = await card(c, 'propose_event', dentist({ on: 'household', start: THU('14:00'), end: THU('15:00') }));
    assert.equal(h.args['for'], undefined);
  });

  test('one for the Household calendar is checked against the calendar plans go to as well, when that is another', async () => {
    const c = await setup();
    const family = await createCalendar(c.sid!, { displayname: 'Family', color: '#000000' }, via);
    await createEvent(c.sid!, {
      cal_id: family.cal_id, original_cal_id: family.original_cal_id, summary: 'Swim', description: '',
      is_all_day: false, dtstart: at(`${THU('10:30')}:00-07:00`), dtend: at(`${THU('11:30')}:00-07:00`), tz_id: ZONE,
    }, via);
    await c.store.append('alice', { op: 'calendar.target', cal_id: family.cal_id, original_cal_id: family.original_cal_id });
    await clearThursday(c.sid!, '/alice/home/');
    calls.length = 0;
    const p = await propose(c, dentist({ on: 'household' }));
    assert.equal(p.effects[0], 'Clashes with Family · Swim 10:30');
    // The card names the calendar it will be made on.
    assert.equal(p.summary, 'Dentist · Thu 5 Nov, 10:00–11:00 · on the Family calendar');
    // On her own calendar, the calendar plans go to is not hers to check.
    const mine = await propose(c, dentist());
    assert.ok(!mine.effects.some((e) => /Family|Swim/.test(e)));
  });

  test('one for a plan they have is linked to it, in the same write', async () => {
    const c = await setup();
    const o = await card(c, 'propose_event', dentist({ plan: 'gate', summary: 'Gate fitter' }));
    assert.ok(o.effects.includes('For Fix the gate'));
    const written = await decide(c, o.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'calendar.appointment', 'plan.calendar.link']);
    const a = written[1] as Extract<Event, { op: 'calendar.appointment' }>;
    assert.equal(a.plan, 'gate');
    assert.deepEqual(gate(c).links.map((l) => [l.kind, l.evt_id]), [['appointment', a.evt_id]]);
  });

  test("a plan renamed renames its events, with the stored etag; one changed on a phone is a drift", async () => {
    const c = await setup();
    const link = await dueOn7th(c);
    const before = (await c.store.since(null)).length;
    await updatePlan(c, 'gate', { title: 'Mend the gate' });
    const [set] = made('set');
    assert.equal(made('set').length, 1);
    assert.equal(set!.params.get('dav_etag'), link.dav_etag);
    assert.equal(set!.params.get('summary'), 'Mend the gate');
    assert.equal(set!.params.get('description'), 'From Home Planner · Plan › House › Mend the gate');
    const ev = await onNas(c, link.evt_id);
    assert.equal(ev.summary, 'Mend the gate');
    const written = (await c.store.since(null)).slice(before);
    assert.deepEqual(written.map((e) => e.op), ['plan.set', 'plan.calendar.etag']);
    assert.equal(new Set(written.map((e) => e.at)).size, 1, 'one write');
    assert.equal(gate(c).links[0]!.dav_etag, ev.dav_etag);

    // Bob changes it on his phone; renaming again meets a 9006 and is a drift, never retried.
    await bobChanges(c, link.evt_id, { summary: 'Gate (Dad)' });
    const out = await toolByName.get('update_plan')!.effect!({ plan: 'gate' }, c,
      [{ op: 'plan.set', plan: 'gate', title: 'Fix the gate at last' }]);
    assert.equal(made('set').length, 1);
    assert.deepEqual(out.map((e) => e.op), ['calendar.drift']);
    // Nothing to rename (chips only) asks nothing of the NAS, even signed in without a session.
    calls.length = 0;
    assert.deepEqual(await toolByName.get('update_plan')!.effect!({ plan: 'gate' }, { ...c, sid: null },
      [{ op: 'plan.set', plan: 'gate', chips: ['soon'] }]), []);
    assert.equal(calls.length, 0);
  });

  test('a rename approved from a card writes the title and the new etag together', async () => {
    const c = await setup();
    await dueOn7th(c);
    const o = await card(c, 'update_plan', { plan: 'gate', area: 'People' });
    const written = await decide(c, o.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.set', 'plan.calendar.etag']);
    assert.equal(made('set')[0]!.params.get('description'), 'From Home Planner · Plan › People › Fix the gate');
  });

  // ── review: a card stays its asker's; what the card says ──────────────────

  test("someone else working out a card for the asker's own calendar again leaves it the asker's", async () => {
    const c = await setup();
    const o = await card(c, 'propose_event', dentist());
    const bob = { ...c, who: 'bob', sid: await signIn('bob', 'pw-b') };
    const again = await refresh(bob, o.id);
    assert.equal(again.args['for'], 'alice');
    assert.equal(again.summary, "Dentist · Thu 5 Nov, 10:00–11:00 · on Alice's calendar");
    const adjusted = await adjust(bob, again.id, { for: 'bob', start: THU('14:00'), end: THU('15:00') });
    assert.equal(adjusted.args['for'], 'alice', 'nor can an adjustment hand it to someone else');
    calls.length = 0;
    await assert.rejects(decide(bob, adjusted.id, 'approved'), (e: unknown) => e instanceof ToolError && e.status === 409);
    assert.equal(made('create').length, 0);
    const written = await decide(c, adjusted.id, 'approved');
    const a = written.find((e) => e.op === 'calendar.appointment') as Extract<Event, { op: 'calendar.appointment' }>;
    assert.equal(a.cal_id, '/alice/home/');
  });

  test("a household card's clash with alice's own event carries no title; an event from another day says its day", async () => {
    const c = await setup();
    await clearThursday(c.sid!, '/alice/home/');
    const own = (summary: string, from: string, to: string) => createEvent(c.sid!, {
      cal_id: '/alice/home/', original_cal_id: '/alice/home/', summary, description: '',
      is_all_day: false, dtstart: at(from), dtend: at(to), tz_id: ZONE,
    }, via);
    await own('Gym', `${THU('11:00')}:00-07:00`, `${THU('12:00')}:00-07:00`);
    await own('Night shift', '2026-11-04T22:00:00-07:00', `${THU('10:30')}:00-07:00`);
    calls.length = 0;
    const p = await propose(c, dentist({ on: 'household' }));
    assert.deepEqual(p.effects.filter((e) => !e.startsWith('Free instead')), [
      'Clashes: Alice is busy Wed 4 Nov, 22:00–10:30',
      'Alice is busy 11:00–12:00 the same morning — not a clash',
    ]);
    assert.ok(!p.effects.some((e) => /Night shift|Gym/.test(e)), 'no title of hers on a card bob sees');
    // On her own card it is hers to read, and reads as hers.
    const mine = await propose(c, dentist());
    assert.deepEqual(mine.effects.filter((e) => !e.startsWith('Free instead')), [
      "Clashes with Alice's calendar · Night shift Wed 4 Nov, 22:00",
      'You have Gym at 11:00 the same morning — not a clash',
    ]);
    await clearThursday(c.sid!, '/alice/home/');
  });

  test("another member's card for their own calendar is not in bob's thread, tray, plan card or week", async () => {
    const c = await setup();
    await c.store.append('alice', { op: 'thread.ask', question: 'Schedule my dentist at 10 on Thursday', budget: null });
    const asked = c.store.state.lastEventId!;
    await c.store.append('claude', { op: 'thread.answer', replyTo: asked, text: 'Here it is.', tools: [], model: 'm' });
    const answer = c.store.state.lastEventId!;
    const o = await offer(c, { tool: 'propose_event', args: dentist({ plan: 'gate' }), prompt: { kind: 'answer', ref: answer } });
    // Her own version of it stands alone in the thread: that one is hers too.
    const own = await adjust(c, o.id, { start: THU('12:00'), end: THU('13:00') });
    const household = await offer(c, { tool: 'propose_event', args: dentist({ on: 'household', start: THU('15:00'), end: THU('16:00') }),
      prompt: { kind: 'answer', ref: answer } });

    const ids = (page: Awaited<ReturnType<typeof thread>>) => new Set(page.entries.flatMap((e: ThreadEntry) =>
      e.kind === 'card' ? [e.offer.id] : e.kind === 'ask' ? (e.answer?.cards ?? []).map((x) => x.id) : []));
    const waits = (page: Awaited<ReturnType<typeof thread>>) =>
      new Set(page.waiting.flatMap((w) => (w.kind === 'offer' ? [w.offer.id] : [])));

    const hers = await thread(c.store, { who: 'alice', budget: null });
    assert.ok(ids(hers).has(own.id) && waits(hers).has(own.id), 'alice sees her own');
    const his = await thread(c.store, { who: 'bob', budget: null });
    assert.ok(!ids(his).has(own.id) && !ids(his).has(o.id), "not in bob's thread");
    assert.ok(!waits(his).has(own.id), "not in bob's tray");
    assert.ok(ids(his).has(household.id) && waits(his).has(household.id), 'one for the household is everyone\'s');
    for (const f of ['waiting', 'theirs'] as const) {
      const filtered = await thread(c.store, { who: 'bob', budget: null, filter: f });
      assert.ok(!ids(filtered).has(own.id), f);
    }

    // Nor on the plan's card, where research would have hung it.
    const events = await c.store.since(null);
    const bobCard = planCard(c.store.state, events, 'gate', { who: 'bob', today: '2026-10-29', tz: ZONE });
    assert.ok(!JSON.stringify(bobCard).includes('Dentist · Thu 5 Nov, 12:00'));
    const week = await weekEvents({ ...c, who: 'bob', sid: null }, { start: '2026-11-02', end: '2026-11-09' });
    assert.ok(!week.events.some((e) => e.proposed === own.id));
  });

  test('a clash is two timed events at once: back to back is not one, nor one event seen on two calendars', () => {
    const ev = (summary: string, from: number, to: number, evt_id?: number) =>
      ({ summary, dtstart: from, dtend: to, is_all_day: false, calendar: 'mine', label: 'Mine', kind: 'other',
         ...(evt_id !== undefined ? { evt_id } : {}) }) as never;
    const marked = markClashes([
      ev('a', 0, 60), ev('b', 60, 120), ev('c', 90, 100), ev('d', 200, 300, 7), ev('e', 250, 260, 7),
      { ...(ev('day', 0, 1000) as object), is_all_day: true } as never, ev('f', 400, 500), ev('g', 450, 460), ev('h', 455, 470),
    ]) as { summary: string; clash?: true }[];
    assert.deepEqual(marked.filter((e) => e.clash).map((e) => e.summary).sort(), ['b', 'c', 'f', 'g', 'h']);
  });

  test("Today's rail: a calendar you own that you check is yours, and one that cannot be read is left out, not the rail", async () => {
    const c = await setup();
    const work = await createCalendar(c.sid!, { displayname: 'Work', color: '#000000' }, via);
    const today = (hhmm: string) => at(`2026-10-29T${hhmm}:00-06:00`);
    await createEvent(c.sid!, { cal_id: work.cal_id, original_cal_id: work.original_cal_id, summary: 'Standup', description: '',
      is_all_day: false, dtstart: today('15:00'), dtend: today('15:30'), tz_id: ZONE }, via);
    await bobHasPT(c, '10:00', '11:00');
    await c.store.append('alice', { op: 'calendar.conflicts', calendars: [
      { cal_id: '/bob/home/', original_cal_id: '/bob/home/', label: 'Bob' },
      { cal_id: work.cal_id, original_cal_id: work.original_cal_id, label: 'Work' },
    ] });
    const day = await todayEvents(c);
    const standup = day.today.find((e) => e.summary === 'Standup')!;
    assert.equal(standup.calendar, 'mine', 'her own calendar, though she checks it as one of the others');
    assert.equal(standup.label, 'Work');

    // Bob's cannot be read just now: the rest is still shown, and the rail says which was missed.
    listFails = '/bob/home/';
    const without = await todayEvents(c);
    assert.equal(without.unavailable, undefined);
    assert.deepEqual(without.missed, ['Bob']);
    assert.ok(without.today.some((e) => e.summary === 'Standup'));
    const week = await weekEvents(c, { start: '2026-11-02', end: '2026-11-09' });
    assert.equal(week.unavailable, undefined);
    assert.deepEqual(week.missed, ['Bob']);
  });

  test("a partner's calendar is the partner's, though your account lists it under an id of your own", async () => {
    const c = await setup();
    await bobHasPT(c, '10:00', '11:00');
    // Alice's account lists Bob's calendar as a sharee's alias that begins with her own name; the original id stays Bob's.
    nas.alias('alice', '/bob/home/', '/alice/bobs-home/');
    const week = await weekEvents(c, { start: '2026-11-02', end: '2026-11-09' });
    assert.equal(week.unavailable, undefined);
    assert.deepEqual(week.missed ?? [], []);
    const pt = week.events.find((e) => e.summary === 'PT')!;
    assert.ok(pt, 'read by the id her account lists it under');
    assert.equal(pt.calendar, 'partner', "Bob's, not read from the alias as hers");
    assert.equal(pt.label, 'Bob');
  });

  test('an account with no calendar of its own is told so before any event is read', async () => {
    const c = await setup();
    calendarsReply = (rows) => rows.map((r) => ({ ...r, default_calendar: false }));
    // A calendar she checks against, so there would be events to read.
    await c.store.append('alice', { op: 'calendar.conflicts', calendars: [{ cal_id: '/alice/home/', original_cal_id: '/alice/home/', label: 'Home' }] });
    await assert.rejects(propose(c, dentist()),
      (e: unknown) => e instanceof ToolError && e.status === 409 && /no calendar of its own/.test(e.message));
    assert.equal(made('list').length, 0, 'no events read');
    // The Household calendar is still there for it.
    assert.match((await propose(c, dentist({ on: 'household' }))).summary, /on the Household calendar$/);
  });

  test('a time that is not one is refused; one with its own offset is that instant', async () => {
    const c = await setup();
    for (const start of ['2026-02-30T10:00', 'Thursday at 10', '2026-11-05T25:00', '2026-11-05T10:61', '']) {
      await assert.rejects(propose(c, dentist({ start })), ToolError, start);
    }
    assert.equal(calls.length, 0);
    const offset = dentist({ start: '2026-11-05T12:00:00-05:00', end: '2026-11-05T18:00:00Z' });
    assert.match((await propose(c, offset)).summary, /Thu 5 Nov, 10:00–11:00/);
    const out = await toolByName.get('propose_event')!.effect!(offset, c, []);
    const ev = await onNas(c, (out[0] as Extract<NewEvent, { op: 'calendar.appointment' }>).evt_id);
    assert.equal(ev.dtstart, at('2026-11-05T17:00:00Z'));
    assert.equal(ev.dtend, at('2026-11-05T18:00:00Z'));
    await deleteEvent(c.sid!, ev, via);
  });

  test('an update_plan card says when it renames events on the calendar', async () => {
    const c = await setup();
    const plain = await card(c, 'update_plan', { plan: 'gate', title: 'Mend the gate' });
    assert.ok(!plain.effects.includes('Renames its calendar events too'), 'nothing on the calendar yet');
    await dueOn7th(c);
    const renamed = await card(c, 'update_plan', { plan: 'gate', title: 'Mend the gate' });
    assert.ok(renamed.effects.includes('Renames its calendar events too'));
    const chips = await card(c, 'update_plan', { plan: 'gate', chips: ['soon'] });
    assert.ok(!chips.effects.includes('Renames its calendar events too'));
  });
  // ── a contact Claude found becomes one you keep ──────────────────────────

  test('the week holds nights: a confirmed stay as the guest staying, a block by its reason, and a cancelled stay not at all', async () => {
    const c = await setup();
    await syncDue(c, gate(c), '2026-11-07');
    const hh = c.store.state.calendar.household!;
    // The stay's event, as approval writes it: all day, arrival to departure.
    const ev = await createEvent(c.sid!, { cal_id: hh.cal_id, original_cal_id: hh.original_cal_id, summary: 'Nguyen family staying',
      description: '', is_all_day: true, dtstart: at('2026-11-04T07:00:00Z'), dtend: at('2026-11-06T07:00:00Z'), tz_id: ZONE }, via);
    // A cancelled stay whose event is still on the calendar, waiting on its release card.
    const gone = await createEvent(c.sid!, { cal_id: hh.cal_id, original_cal_id: hh.original_cal_id, summary: 'Nguyen family staying',
      description: '', is_all_day: true, dtstart: at('2026-11-02T07:00:00Z'), dtend: at('2026-11-03T07:00:00Z'), tz_id: ZONE }, via);
    await c.store.append('alice', [
      { op: 'guest.allow', email: 'ann@example.com', name: 'Nguyen family', why: 'friends' },
      { op: 'booking.confirm', request: 'r1', email: 'ann@example.com', arrive: '2026-11-04', depart: '2026-11-06', headcount: 3,
        cal_id: hh.cal_id, original_cal_id: hh.original_cal_id, evt_id: ev.evt_id, ical_uid: ev.ical_uid, dav_etag: ev.dav_etag },
      { op: 'booking.confirm', request: 'r2', email: 'ann@example.com', arrive: '2026-11-02', depart: '2026-11-03', headcount: 1,
        cal_id: hh.cal_id, original_cal_id: hh.original_cal_id, evt_id: gone.evt_id, ical_uid: gone.ical_uid, dav_etag: gone.dav_etag },
      { op: 'booking.block', from: '2026-11-07', to: '2026-11-09', why: 'family is here' },
    ]);
    const cancelled = [...c.store.state.stays].find(([, st]) => st.request === 'r2')![0];
    await c.store.append('alice', { op: 'booking.cancel', stay: cancelled, why: 'cannot come' });
    const stayId = [...c.store.state.stays].find(([, st]) => st.request === 'r1')![0];
    const blockId = [...c.store.state.stayBlocks.keys()][0]!;

    for (const ctx of [c, { ...c, sid: null }]) {
      const week = await weekEvents(ctx, { start: '2026-11-02', end: '2026-11-09' });
      const held = week.events.filter((e) => e.held);
      assert.deepEqual(held.map((e) => [e.summary, e.held, e.is_all_day, e.dtstart, e.dtend]), [
        ['Nguyen family staying (3)', { kind: 'stay', id: stayId }, true, at('2026-11-04T07:00:00Z'), at('2026-11-06T07:00:00Z')],
        ['family is here', { kind: 'block', id: blockId, by: 'alice' }, true, at('2026-11-07T07:00:00Z'), at('2026-11-09T07:00:00Z')],
      ]);
      // The stay's own event is not drawn a second time beside it, a cancelled one's not at all (its
      // card on Today takes it off), and nothing has the guest's address.
      assert.equal(week.events.filter((e) => /staying/.test(e.summary)).length, 1);
      assert.ok(!JSON.stringify(week).includes('ann@example.com'));
    }
  });

  test('a cancelled stay whose release card was declined ("left on the calendar"): its event is an ordinary Household event', async () => {
    const c = await setup();
    await syncDue(c, gate(c), '2026-11-07');
    const hh = c.store.state.calendar.household!;
    const kept = await createEvent(c.sid!, { cal_id: hh.cal_id, original_cal_id: hh.original_cal_id, summary: 'Nguyen family staying (1)',
      description: '', is_all_day: true, dtstart: at('2026-11-02T07:00:00Z'), dtend: at('2026-11-03T07:00:00Z'), tz_id: ZONE }, via);
    await c.store.append('alice', [
      { op: 'guest.allow', email: 'ann@example.com', name: 'Nguyen family', why: 'friends' },
      { op: 'booking.confirm', request: 'r2', email: 'ann@example.com', arrive: '2026-11-02', depart: '2026-11-03', headcount: 1,
        cal_id: hh.cal_id, original_cal_id: hh.original_cal_id, evt_id: kept.evt_id, ical_uid: kept.ical_uid, dav_etag: kept.dav_etag },
    ]);
    const stay = [...c.store.state.stays.keys()][0]!;
    const [cancel] = await c.store.append('alice', { op: 'booking.cancel', stay, why: 'cannot come' });
    const [card] = await c.store.append('alice', {
      op: 'proposal.offer', tool: 'release_stay', args: { stay }, summary: 'Nguyen family cancelled Nov 2–3', effects: [], events: [],
      budget: null, month: null, envelopes: [], fingerprint: '', prompt: { kind: 'booking', ref: cancel!.id },
    });
    const drawn = async () => (await weekEvents(c, { start: '2026-11-02', end: '2026-11-09' })).events.filter((e) => /staying/.test(e.summary));
    // Waiting on its card: not drawn.
    assert.deepEqual(await drawn(), []);
    await c.store.append('bob', { op: 'proposal.decide', proposal: card!.id, decision: 'declined', why: 'leave it, we will tidy it up' });
    const left = await drawn();
    assert.equal(left.length, 1);
    assert.equal(left[0]!.evt_id, kept.evt_id);
    assert.equal(left[0]!.calendar, 'household');
    assert.equal(left[0]!.held, undefined, 'an ordinary event, not held nights');
  });

  describe('creating a contact from a suggestion', () => {
    const TOOL = () => toolByName.get('create_contact')!;
    const suggest = (c: ToolContext, args: Record<string, unknown>) =>
      runTool(TOOL(), args, c) as Promise<Proposal>;
    const contactCalls = (method: string) => calls.filter((x) => x.api === 'SYNO.Contacts.Contact' && x.method === method);
    /** A card from research on the gate plan, the way the conversation raises one. */
    const researchCard = (c: ToolContext, args: Record<string, unknown>) =>
      offer(c, { tool: 'create_contact', args, prompt: { kind: 'research', ref: null }, plan: 'gate' });
    /** The NAS as it answers while `fn` runs, rewritten by `rewrite` (a Response to answer with, or null to pass on). */
    async function asNas<T>(rewrite: (params: URLSearchParams) => Response | null, fn: () => Promise<T>): Promise<T> {
      setDsmFetch((async (url: string | URL | Request, init?: RequestInit) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        return rewrite(params) ?? via(url, init);
      }) as DsmFetch);
      try { return await fn(); } finally { setDsmFetch(via); }
    }
    const answer = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    test('run needs a name, and says what it will do: a proposal with no events of its own', async () => {
      const c = await setup();
      for (const bad of [{}, { full_name: '' }, { full_name: '   ' }, { full_name: 7 }]) {
        await assert.rejects(suggest(c, bad), (e: unknown) => e instanceof ToolError && e.status === 400 && /full_name/.test(e.message), JSON.stringify(bad));
      }
      const p = await suggest(c, { full_name: '  Sandoval Plumbing ' });
      assert.equal(p.summary, 'Add Sandoval Plumbing to Contacts');
      assert.deepEqual(p.effects, ['A new contact in the household address book']);
      assert.deepEqual(p.events, []);
      const linked = await suggest(c, { full_name: 'Sandoval Plumbing', plan: 'gate' });
      assert.deepEqual(linked.effects, ['A new contact in the household address book', 'Linked to Fix the gate']);
      assert.deepEqual(linked.events, []);
      assert.equal(calls.length, 0, 'proposing asks nothing of the NAS');
    });

    test('run refuses a plan that is not there or is gone, and a phone or email that is not a short list of words', async () => {
      const c = await setup();
      await assert.rejects(suggest(c, { full_name: 'Sandoval', plan: 'nope' }), (e: unknown) => e instanceof ToolError && e.status === 404);
      await c.store.append('alice', { op: 'plan.remove', plan: 'gate', why: 'done' });
      await assert.rejects(suggest(c, { full_name: 'Sandoval', plan: 'gate' }), (e: unknown) => e instanceof ToolError && e.status === 404);
      const d = await setup();
      for (const bad of [
        { phones: '505-555-0142' }, { phones: [505] }, { phones: [''] }, { phones: ['  '] }, { emails: [null] },
        { emails: 'a@b.c' }, { phones: ['1', '2', '3', '4', '5', '6'] }, { emails: ['a@b.c', 'c@d.e', 'f@g.h', 'i@j.k', 'l@m.n', 'o@p.q'] },
        { org: 7 },
      ]) {
        await assert.rejects(suggest(d, { full_name: 'Sandoval', ...bad }), (e: unknown) => e instanceof ToolError && e.status === 400, JSON.stringify(bad));
      }
      await suggest(d, { full_name: 'Sandoval', phones: ['1', '2', '3', '4', '5'], emails: ['a@b.c'], org: 'Sandoval LLC' });
    });

    test('a bypass sign-in has no address book to add to: sign in again, before any card exists', async () => {
      const c = { ...(await setup()), sid: null };
      await assert.rejects(suggest(c, { full_name: 'Sandoval Plumbing' }), NeedsDsm);
      assert.equal(calls.length, 0);
    });

    test('the effect adds them to the first address book, and with a plan returns the link to it', async () => {
      const c = await setup();
      const [first] = await listAddressbooks(c.sid!, via);
      calls.length = 0;
      const args = { full_name: 'Sandoval Plumbing', phones: ['505-555-0142'], emails: ['office@sandoval.example'], org: 'Sandoval Plumbing LLC', plan: 'gate' };
      const out = await TOOL().effect!(args, c, []);
      const [create] = contactCalls('create');
      assert.equal(contactCalls('create').length, 1);
      assert.equal(create!.params.get('addressbook_id'), String(first!.id));
      assert.equal(create!.params.get('full_name'), 'Sandoval Plumbing');
      assert.equal(out.length, 1);
      const link = out[0] as Extract<NewEvent, { op: 'plan.contact.link' }>;
      assert.equal(link.op, 'plan.contact.link');
      assert.equal(link.plan, 'gate');
      assert.equal(link.addressbook_id, first!.id);
      assert.equal(link.display, 'Sandoval Plumbing');
      const there = await getContact(c.sid!, link.contact_id, via);
      assert.deepEqual([there.full_name, there.phones, there.emails, there.org, there.addressbook_id],
        ['Sandoval Plumbing', ['505-555-0142'], ['office@sandoval.example'], 'Sandoval Plumbing LLC', first!.id]);

      // Without a plan they are only added: nothing to link.
      const plain = await TOOL().effect!({ full_name: 'Example Mechanical' }, c, []);
      assert.deepEqual(plain, []);
      assert.equal(contactCalls('create').length, 2);
    });

    test('approving a card from research adds them and lands the link on the plan, in one write', async () => {
      const c = await setup();
      const o = await researchCard(c, { full_name: 'Gate & Fence Co', phones: ['505-555-0100'], plan: 'gate' });
      assert.deepEqual(o.prompt, { kind: 'research', ref: null });
      assert.equal(o.summary, 'Add Gate & Fence Co to Contacts');
      assert.deepEqual(gate(c).contacts, []);
      const before = (await c.store.since(null)).length;
      const written = await decide(c, o.id, 'approved');
      assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'plan.contact.link']);
      assert.equal(new Set(written.map((e) => e.at)).size, 1);
      assert.equal((await c.store.since(null)).length, before + 2);
      const [link] = gate(c).contacts;
      assert.equal(link!.display, 'Gate & Fence Co');
      assert.equal((await getContact(c.sid!, link!.contact_id, via)).full_name, 'Gate & Fence Co');
      assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'approved');
      // And the card's People section has them the next time it is loaded.
      const view = planCard(c.store.state, await c.store.since(null), 'gate', { who: 'alice', today: '2026-10-29' });
      assert.deepEqual(view.contacts.map((x) => x.display), ['Gate & Fence Co']);
    });

    test('approving one with no plan only adds them: nothing is linked', async () => {
      const c = await setup();
      const o = await offer(c, { tool: 'create_contact', args: { full_name: 'Example Mechanical' }, prompt: { kind: 'briefing', ref: null } });
      assert.deepEqual(o.effects, ['A new contact in the household address book']);
      const written = await decide(c, o.id, 'approved');
      assert.deepEqual(written.map((e) => e.op), ['proposal.decide']);
      assert.equal(contactCalls('create').length, 1);
    });

    test('approved from the conversation, the same proposal does the same', async () => {
      const c = await setup();
      const p = await suggest(c, { full_name: 'Gate Hinge Supply', plan: 'gate' });
      const { committed } = await commit(p.id, c);
      assert.deepEqual(committed.map((e) => e.op), ['plan.contact.link']);
      assert.equal(gate(c).contacts[0]!.display, 'Gate Hinge Supply');
    });

    test('a card approved without a NAS session is refused, and stays', async () => {
      const c = await setup();
      const o = await researchCard(c, { full_name: 'Gate & Fence Co', plan: 'gate' });
      const before = (await c.store.since(null)).length;
      await assert.rejects(decide({ ...c, sid: null }, o.id, 'approved'), NeedsDsm);
      assert.equal((await c.store.since(null)).length, before);
      assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'open');
      assert.equal(contactCalls('create').length, 0);
    });

    test('when the NAS refuses, nothing is appended, the card stays, and what it says leaves out the session', async () => {
      const c = await setup();
      const o = await researchCard(c, { full_name: 'Gate & Fence Co', plan: 'gate' });
      const before = (await c.store.since(null)).length;
      const refused = () => answer({ success: false, error: { code: 3000 } });
      await asNas((p) => p.get('api') === 'SYNO.Contacts.Contact' && p.get('method') === 'create' ? refused() : null, async () => {
        await assert.rejects(decide(c, o.id, 'approved'), (e: unknown) =>
          e instanceof ToolError && e.status === 502 && !String((e as Error).message).includes(c.sid!));
      });
      assert.equal((await c.store.since(null)).length, before, 'nothing appended');
      assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'open', 'the card stays');
      assert.deepEqual(gate(c).contacts, []);
      // Approved again once the NAS answers, it goes through.
      assert.deepEqual((await decide(c, o.id, 'approved')).map((e) => e.op), ['proposal.decide', 'plan.contact.link']);
    });

    test('with no address book on the NAS, it says so and makes nothing', async () => {
      const c = await setup();
      const o = await researchCard(c, { full_name: 'Gate & Fence Co', plan: 'gate' });
      const before = (await c.store.since(null)).length;
      await asNas((p) => p.get('api') === 'SYNO.Contacts.Addressbook' ? answer({ success: true, data: { addressbooks: [] } }) : null, async () => {
        await assert.rejects(decide(c, o.id, 'approved'), (e: unknown) =>
          e instanceof ToolError && e.status === 502 && e.message === 'the NAS has no address book');
      });
      assert.equal(contactCalls('create').length, 0);
      assert.equal((await c.store.since(null)).length, before);
      assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'open');
    });

    test('a plan removed since the card was made takes the card with it, and the effect would add no one for it', async () => {
      const c = await setup();
      const o = await researchCard(c, { full_name: 'Gate & Fence Co', plan: 'gate' });
      await c.store.append('bob', { op: 'plan.remove', plan: 'gate', why: 'never mind' });
      calls.length = 0;
      await assert.rejects(decide(c, o.id, 'approved'), (e: unknown) => e instanceof ToolError && e.status === 409);
      await assert.rejects(TOOL().effect!({ full_name: 'Gate & Fence Co', plan: 'gate' }, c, []),
        (e: unknown) => e instanceof ToolError && e.status === 404);
      assert.equal(calls.length, 0, 'the NAS was not asked');
    });

    test('compensating is a no-op: the Contacts API has no documented delete', async () => {
      const c = await setup();
      const out = await TOOL().effect!({ full_name: 'Gate & Fence Co', plan: 'gate' }, c, []);
      calls.length = 0;
      await TOOL().compensate!({ full_name: 'Gate & Fence Co', plan: 'gate' }, c, out);
      assert.equal(calls.length, 0);
    });

    test('research may suggest one, and the description steers it to a person worth keeping', () => {
      assert.ok(RESEARCH_WRITES.has('create_contact'));
      assert.ok(researchMay(TOOL()));
      assert.match(TOOL().description, /plausibly contact again/);
      assert.match(TOOL().description, /link_contact/);
    });
  });
});
