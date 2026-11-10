import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

// The New event form's routes, against the fake DSM, with no Claude key: a
// member's Save is the decision, so nothing here is a proposal. alice owns the
// Home household and has added bob; both are signed in through the fake DSM.
// carol is signed in with no NAS behind her session, as a restart leaves one.
const dir = await mkdtemp(join(tmpdir(), 'pb-calendar-events-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alice: { password: 'correct-horse' }, bob: { password: 'battery-staple' } },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DSM_URL: `http://127.0.0.1:${nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
delete process.env['DEV_USER'];
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];
delete process.env['DSM_PUBLIC_URL'];
for (const v of ['BOOK_URL', 'BOOK_HOUSEHOLD', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[v];

const { Households } = await import('../src/households.ts');
const { COOKIE, Sessions } = await import('../src/auth.ts');
const { getEvent, listCalendars, listEvents } = await import('../src/synology.ts');
const { checkWithDsm } = await import('../src/auth.ts');
const { changeEvent } = await import('../src/appointment-edits.ts');
const { ProposalStore } = await import('../src/tools.ts');

let base = '';
let close: () => Promise<void> = async () => {};
const cookies: Record<string, string> = {};

async function call(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie: cookies[who]! },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').startsWith('application/json');
  return { status: res.status, json: isJson ? JSON.parse(text) : text };
}

/** The log as alice can download it. */
const log = async (): Promise<any[]> =>
  ((await call('alice', 'GET', '/api/backup')).json as string).trim().split('\n').map((l) => JSON.parse(l));

/** A day this many days from today, where the household is (UTC here). */
const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const households = new Households(process.env['HOUSEHOLDS_DIR']!);
let home: Awaited<ReturnType<typeof households.create>>;
let aliceSid = '';
let bobSid = '';

/** Sign in through the fake DSM as `who`: the cookie keeps its NAS session. */
async function signIn(who: string, password: string): Promise<string> {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: who, password }),
  });
  assert.equal(res.status, 200);
  cookies[who] = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  return (await checkWithDsm(who, password, undefined)).sid;
}

before(async () => {
  home = await households.create('alice', 'Home', { id: 'home' });
  await home.store.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
  await home.store.append('alice', [
    { op: 'plan.create', plan: 'dentist', title: 'Get teeth checked', area: 'House' },
    { op: 'plan.create', plan: 'gone', title: 'Already gone', area: 'House' },
    { op: 'plan.remove', plan: 'gone', why: 'not needed' },
  ]);
  await households.create('carol', 'Elsewhere', { id: 'elsewhere' });
  const sessions = new Sessions({ path: process.env['SESSIONS_PATH']! });
  cookies['carol'] = `${COOKIE}=${sessions.issue('carol', { household: 'home' })}`;

  const { start } = await import('../src/server.ts');
  const { log: said, warn } = console;
  console.log = console.warn = () => {};
  let server: Awaited<ReturnType<typeof start>>;
  try { server = await start({ households }); } finally { Object.assign(console, { log: said, warn }); }
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  aliceSid = await signIn('alice', 'correct-horse');
  bobSid = await signIn('bob', 'battery-staple');
});

after(async () => { await close(); await nas.close(); });

/** What the form posts for a timed event tomorrow at 10:00. */
const form = (extra: Record<string, unknown> = {}) => ({
  summary: 'Dentist', start: `${day(1)}T10:00`, end: `${day(1)}T11:00`, allDay: false, on: 'household', ...extra,
});

describe('POST /api/calendar/events: a member saves a new event', () => {
  test('someone who is not in the household is refused, and nothing is written', async () => {
    const before = (await log()).length;
    const r = await call('carol', 'POST', '/api/calendar/events', form());
    assert.equal(r.status, 403);
    assert.equal((await log()).length, before);
  });

  test('refuses what is missing or wrong, in words, and writes nothing', async () => {
    const before = (await log()).length;
    const bad = async (extra: Record<string, unknown>, re: RegExp, status = 400) => {
      const r = await call('alice', 'POST', '/api/calendar/events', form(extra));
      assert.equal(r.status, status, JSON.stringify(r.json));
      assert.match(r.json.error, re);
    };
    await bad({ summary: '   ' }, /summary is required/);
    await bad({ summary: 'x'.repeat(201) }, /longer than 200/);
    await bad({ on: 'partner' }, /'mine' or 'household'/);
    await bad({ on: undefined }, /'mine' or 'household'/);
    await bad({ end: `${day(1)}T09:00` }, /must end after it starts/);
    await bad({ start: `${day(1)}T10:00`, end: 'tomorrow' }, /end is a date and time/);
    await bad({ start: `${day(-1)}T10:00`, end: `${day(-1)}T11:00` }, /already gone/);
    await bad({ start: day(1), end: day(1), allDay: false }, /need a time/);
    await bad({ plan: 'nothing-like-it' }, /no such plan/, 404);
    await bad({ plan: 'gone' }, /no such plan/, 404);
    await bad({ notes: 'x'.repeat(2001) }, /notes are at most 2000/);
    await bad({ notes: 7 }, /notes are text/);
    assert.equal((await log()).length, before, 'nothing was written to the log');
  });

  test('on the Household calendar: made on the NAS and logged as the member\'s own appointment, with no proposal', async () => {
    const r = await call('alice', 'POST', '/api/calendar/events', form({ summary: 'Plumber', notes: 'Bring the key' }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const lines = await log();
    const made = lines.find((e) => e.op === 'calendar.appointment' && e.summary === 'Plumber');
    assert.ok(made, 'a calendar.appointment is logged');
    assert.equal(made.who, 'alice');
    assert.equal(made.allDay, false);
    assert.equal(made.start, `${day(1)}T10:00:00.000Z`);
    assert.equal(r.json.appointment.evt_id, made.evt_id);
    assert.ok(!lines.some((e) => e.op === 'proposal.offer' && e.tool === 'propose_event'), 'no proposal was made');
    const household = lines.find((e) => e.op === 'calendar.household');
    const ev = await getEvent(aliceSid, { cal_id: household.cal_id, original_cal_id: household.original_cal_id, evt_id: made.evt_id });
    assert.equal(ev.summary, 'Plumber');
    assert.match(ev.description, /^From Home Planner/);
    assert.match(ev.description, /Bring the key$/);
    // The other member sees it, and as the app's: the Calendar says what kind it is.
    const week = await call('bob', 'GET', `/api/calendar?start=${day(0)}&end=${day(7)}`);
    const seen = week.json.events.find((e: any) => e.evt_id === made.evt_id);
    assert.equal(seen.kind, 'appointment');
    assert.equal(seen.calendar, 'household');
  });

  test('on My calendar: it goes on the member\'s own default calendar, which the household does not see', async () => {
    const r = await call('alice', 'POST', '/api/calendar/events', form({ summary: 'Therapy', on: 'mine' }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [mine] = (await listCalendars(aliceSid)).filter((c) => c.isDefault);
    const there = await listEvents(aliceSid, { calendars: [mine!], start: 0, end: 4_000_000_000 });
    assert.ok(there.some((e) => e.summary === 'Therapy'));
    const bobSees = await call('bob', 'GET', `/api/calendar?start=${day(0)}&end=${day(7)}`);
    assert.ok(!bobSees.json.events.some((e: any) => e.summary === 'Therapy'));
  });

  test('an all-day event runs midnight to midnight', async () => {
    const r = await call('alice', 'POST', '/api/calendar/events', { summary: 'Bin day', start: day(2), end: day(2), allDay: true, on: 'household' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const made = (await log()).find((e) => e.op === 'calendar.appointment' && e.summary === 'Bin day');
    assert.equal(made.allDay, true);
    assert.equal(made.start, `${day(2)}T00:00:00.000Z`);
    assert.equal(made.end, `${day(3)}T00:00:00.000Z`);
  });

  test('for a plan they have: linked to it, the way an approved card links', async () => {
    const r = await call('alice', 'POST', '/api/calendar/events', form({ summary: 'Check-up', plan: 'dentist' }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const lines = (await log()).filter((e) => e.evt_id === r.json.appointment.evt_id);
    assert.deepEqual(lines.map((e) => e.op), ['calendar.appointment', 'plan.calendar.link']);
    assert.equal(lines[0].plan, 'dentist');
    assert.equal(lines[1].kind, 'appointment');
    const household = (await log()).find((e) => e.op === 'calendar.household');
    const ev = await getEvent(aliceSid, { cal_id: household.cal_id, original_cal_id: household.original_cal_id, evt_id: lines[0].evt_id });
    assert.match(ev.description, /Plan › House › Get teeth checked/);
  });

  test('a clash does not stop it: the form only tells', async () => {
    const a = await call('alice', 'POST', '/api/calendar/events', form({ summary: 'Clash one', start: `${day(4)}T09:00`, end: `${day(4)}T10:00` }));
    const b = await call('bob', 'POST', '/api/calendar/events', form({ summary: 'Clash two', start: `${day(4)}T09:30`, end: `${day(4)}T10:30` }));
    assert.equal(a.status, 200);
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal((await log()).filter((e) => e.op === 'calendar.appointment' && e.who === 'bob').length, 1);
  });

  test('a member\'s My calendar is theirs: bob\'s lands on bob\'s, never alice\'s', async () => {
    const r = await call('bob', 'POST', '/api/calendar/events', form({ summary: 'Bob only', on: 'mine' }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [bobs] = (await listCalendars(bobSid)).filter((c) => c.isDefault);
    assert.equal(bobs!.cal_id.startsWith('/bob/'), true);
    const there = await listEvents(bobSid, { calendars: [bobs!], start: 0, end: 4_000_000_000 });
    assert.ok(there.some((e) => e.summary === 'Bob only'));
    const alicesWeek = await call('alice', 'GET', `/api/calendar?start=${day(0)}&end=${day(7)}`);
    assert.ok(!alicesWeek.json.events.some((e: any) => e.summary === 'Bob only'));
  });
});

describe('POST /api/calendar/events/:id: a member changes one the app made', () => {
  const make = async (who: string, extra: Record<string, unknown> = {}): Promise<number> => {
    const r = await call(who, 'POST', '/api/calendar/events', form(extra));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.appointment.evt_id;
  };
  const onNas = async (who: 'alice' | 'bob', id: number, where: 'household' | 'mine' = 'household') => {
    const sid = who === 'alice' ? aliceSid : bobSid;
    const ref = where === 'household' ? (await log()).find((e) => e.op === 'calendar.household')
      : (await listCalendars(sid)).find((c) => c.isDefault)!;
    return getEvent(sid, { cal_id: ref.cal_id, original_cal_id: ref.original_cal_id, evt_id: id });
  };

  test('saves the new name, time and notes on the NAS, keeping the line that says it is from Home Planner', async () => {
    const id = await make('alice', { summary: 'Haircut', notes: 'old note' });
    const r = await call('alice', 'POST', `/api/calendar/events/${id}`,
      { summary: 'Haircut (long)', start: `${day(2)}T14:00`, end: `${day(2)}T15:30`, allDay: false, notes: 'new note' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ev = await onNas('alice', id);
    assert.equal(ev.summary, 'Haircut (long)');
    assert.equal(ev.dtstart, Date.parse(`${day(2)}T14:00:00Z`) / 1000);
    assert.equal(ev.dtend, Date.parse(`${day(2)}T15:30:00Z`) / 1000);
    assert.match(ev.description, /^From Home Planner/);
    assert.match(ev.description, /new note$/);
    assert.doesNotMatch(ev.description, /old note/);
  });

  test('either member may change one on the Household calendar', async () => {
    const id = await make('alice', { summary: 'Shared thing' });
    const r = await call('bob', 'POST', `/api/calendar/events/${id}`, form({ summary: 'Shared thing, moved', start: `${day(3)}T10:00`, end: `${day(3)}T11:00` }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await onNas('bob', id)).summary, 'Shared thing, moved');
  });

  test('one linked to a plan keeps the link\'s etag in step, with the event ops drift already uses', async () => {
    const id = await make('alice', { summary: 'Linked', plan: 'dentist' });
    const before = (await log()).length;
    const r = await call('alice', 'POST', `/api/calendar/events/${id}`, form({ summary: 'Linked, renamed', plan: 'dentist' }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const added = (await log()).slice(before);
    assert.deepEqual(added.map((e) => e.op), ['calendar.appointment.change', 'plan.calendar.etag']);
    assert.equal(added[1].evt_id, id);
    assert.equal(added[1].dav_etag, (await onNas('alice', id)).dav_etag);
  });

  test('a move writes one line, with what it was as the NAS had it', async () => {
    const id = await make('alice', { summary: 'Swim', start: `${day(2)}T16:00`, end: `${day(2)}T17:00` });
    const r = await call('alice', 'POST', `/api/calendar/events/${id}`, form({ summary: 'Swim', start: `${day(2)}T16:30`, end: `${day(2)}T17:30` }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const line = (await log()).findLast((e) => e.op === 'calendar.appointment.change');
    assert.equal(line.evt_id, id);
    assert.equal(line.start, new Date(`${day(2)}T16:30:00Z`).toISOString());
    assert.equal(line.end, new Date(`${day(2)}T17:30:00Z`).toISOString());
    assert.deepEqual(line.was, {
      summary: 'Swim', start: new Date(`${day(2)}T16:00:00Z`).toISOString(), end: new Date(`${day(2)}T17:00:00Z`).toISOString(), allDay: false,
    });
    assert.ok(line.dav_etag);
  });

  test('a rename writes one line; a save of the notes alone writes none', async () => {
    const id = await make('alice', { summary: 'Swim', start: `${day(2)}T16:00`, end: `${day(2)}T17:00` });
    const same = { summary: 'Swim', start: `${day(2)}T16:00`, end: `${day(2)}T17:00`, allDay: false };
    const before = (await log()).length;
    let r = await call('alice', 'POST', `/api/calendar/events/${id}`, { ...same, notes: 'bring a towel' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await log()).length, before);
    r = await call('alice', 'POST', `/api/calendar/events/${id}`, { ...same, summary: 'Swim practice' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const line = (await log()).findLast((e) => e.op === 'calendar.appointment.change');
    assert.deepEqual([line.was.summary, line.summary], ['Swim', 'Swim practice']);
    assert.equal((await log()).length, before + 1);
  });

  test('with a plan linked, the change and the etag are one write', async () => {
    const id = await make('alice', { summary: 'Linked again', plan: 'dentist' });
    const r = await call('alice', 'POST', `/api/calendar/events/${id}`, form({ summary: 'Linked again, renamed', plan: 'dentist' }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const last = (await log()).slice(-2);
    assert.deepEqual(last.map((e) => e.op), ['calendar.appointment.change', 'plan.calendar.etag']);
    assert.equal(last[0].at, last[1].at);
  });

  describe('the log refusing', () => {
    const ctxFor = () => ({ store: home.store, who: 'alice', today: day(0), proposals: new ProposalStore(), sid: aliceSid });
    const refusing = async (run: () => Promise<unknown>) => {
      const real = home.store.append;
      home.store.append = (async () => { throw new Error('the log would not take it'); }) as typeof real;
      try { return await run(); } finally { home.store.append = real; }
    };

    test('puts the event back as it was read', async () => {
      const id = await make('alice', { summary: 'Swim', start: `${day(2)}T16:00`, end: `${day(2)}T17:00` });
      const before = await onNas('alice', id);
      const body = { summary: 'Swim practice', start: `${day(2)}T16:30`, end: `${day(2)}T17:30`, allDay: false };
      await refusing(() => assert.rejects(changeEvent(ctxFor(), id, body), /would not take it/));
      const ev = await onNas('alice', id);
      assert.equal(ev.summary, 'Swim');
      assert.equal(ev.dtstart, before.dtstart);
      assert.equal(ev.dtend, before.dtend);
    });

    test('and the undo failing says so', async () => {
      const id = await make('alice', { summary: 'Swim', start: `${day(2)}T16:00`, end: `${day(2)}T17:00` });
      let sets = 0;
      const f = (async (url: string | URL | Request, init?: RequestInit) => {
        const params = new URLSearchParams(String(init?.body ?? ''));
        if (params.get('api') === 'SYNO.Cal.Event' && params.get('method') === 'set' && ++sets === 2) {
          return new Response(JSON.stringify({ success: false, error: { code: 100 } }), { headers: { 'content-type': 'application/json' } });
        }
        return fetch(url, init);
      }) as typeof fetch;
      const body = { summary: 'Swim practice', start: `${day(2)}T16:30`, end: `${day(2)}T17:30`, allDay: false };
      await refusing(() => assert.rejects(changeEvent(ctxFor(), id, body, f), /could not be put back/));
    });
  });

  test('a partner\'s own calendar is refused: bob cannot change what alice put on hers', async () => {
    const id = await make('alice', { summary: 'Alice only', on: 'mine' });
    const r = await call('bob', 'POST', `/api/calendar/events/${id}`, form({ summary: 'Hijacked', on: 'mine' }));
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match(r.json.error, /only Alice/);
    assert.equal((await onNas('alice', id, 'mine')).summary, 'Alice only');
  });

  test('refuses a bad time or name, and an event the app did not make', async () => {
    const id = await make('alice', { summary: 'Fussy' });
    let r = await call('alice', 'POST', `/api/calendar/events/${id}`, form({ summary: '', start: `${day(1)}T10:00`, end: `${day(1)}T11:00` }));
    assert.equal(r.status, 400);
    r = await call('alice', 'POST', `/api/calendar/events/${id}`, form({ end: `${day(1)}T09:00` }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /must end after it starts/);
    assert.equal((await onNas('alice', id)).summary, 'Fussy');
    // Made some other way (here, straight on the NAS): not the app's to change.
    const { createEvent } = await import('../src/synology.ts');
    const household = (await log()).find((e) => e.op === 'calendar.household');
    const theirs = await createEvent(aliceSid, {
      cal_id: household.cal_id, original_cal_id: household.original_cal_id, summary: 'From a phone', description: '',
      is_all_day: false, dtstart: Date.parse(`${day(5)}T10:00:00Z`) / 1000, dtend: Date.parse(`${day(5)}T11:00:00Z`) / 1000, tz_id: 'UTC',
    });
    r = await call('alice', 'POST', `/api/calendar/events/${theirs.evt_id}`, form());
    assert.equal(r.status, 404);
    assert.match(r.json.error, /not made by Home Planner/);
    r = await call('alice', 'POST', '/api/calendar/events/not-a-number', form());
    assert.equal(r.status, 404);
  });

  test('one that is no longer on the calendar says so', async () => {
    const id = await make('alice', { summary: 'Vanishing' });
    const household = (await log()).find((e) => e.op === 'calendar.household');
    const { deleteEvent } = await import('../src/synology.ts');
    await deleteEvent(aliceSid, { cal_id: household.cal_id, original_cal_id: household.original_cal_id, evt_id: id });
    const r = await call('alice', 'POST', `/api/calendar/events/${id}`, form({ summary: 'Too late' }));
    assert.equal(r.status, 404);
    assert.match(r.json.error, /no longer on the calendar/);
  });

  test('an event already in the past can be renamed without moving it, but not moved', async () => {
    // Made yesterday, say: put on the NAS and in the log by hand, since the form will not make one.
    const { createEvent } = await import('../src/synology.ts');
    const h = (await log()).find((e) => e.op === 'calendar.household');
    const [start, end] = [Date.parse(`${day(-2)}T10:00:00Z`) / 1000, Date.parse(`${day(-2)}T11:00:00Z`) / 1000];
    const old = await createEvent(aliceSid, { cal_id: h.cal_id, original_cal_id: h.original_cal_id, summary: 'Long ago',
      description: 'From Home Planner', is_all_day: false, dtstart: start, dtend: end, tz_id: 'UTC' });
    await home.store.append('alice', { op: 'calendar.appointment', evt_id: old.evt_id, cal_id: old.cal_id, original_cal_id: old.original_cal_id,
      ical_uid: old.ical_uid, dav_etag: old.dav_etag, summary: 'Long ago', start: new Date(start * 1000).toISOString(),
      end: new Date(end * 1000).toISOString(), allDay: false });
    const same = { start: `${day(-2)}T10:00`, end: `${day(-2)}T11:00`, allDay: false };
    let r = await call('alice', 'POST', `/api/calendar/events/${old.evt_id}`, { summary: 'Long ago, renamed', ...same });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call('alice', 'POST', `/api/calendar/events/${old.evt_id}`, { summary: 'Long ago, renamed', ...same, end: `${day(-2)}T12:00` });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /already gone/);
  });
});

describe('DELETE /api/calendar/events/:id', () => {
  const make = async (who: string, extra: Record<string, unknown> = {}): Promise<number> => {
    const r = await call(who, 'POST', '/api/calendar/events', form(extra));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.appointment.evt_id;
  };
  const household = async () => (await log()).find((e) => e.op === 'calendar.household');

  test('takes it off the NAS and logs it, as the member who did', async () => {
    const id = await make('alice', { summary: 'Cancelled' });
    const r = await call('bob', 'DELETE', `/api/calendar/events/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const h = await household();
    await assert.rejects(getEvent(aliceSid, { cal_id: h.cal_id, original_cal_id: h.original_cal_id, evt_id: id }));
    const line = (await log()).find((e) => e.op === 'calendar.appointment.remove' && e.evt_id === id);
    assert.ok(line, 'the removal is in the log');
    assert.equal(line.who, 'bob');
    assert.equal(line.summary, 'Cancelled');
    const week = await call('alice', 'GET', `/api/calendar?start=${day(0)}&end=${day(7)}`);
    assert.ok(!week.json.events.some((e: any) => e.evt_id === id));
  });

  test('one linked to a plan is unlinked first, so the plan is left clean', async () => {
    const id = await make('alice', { summary: 'Linked cancelled', plan: 'dentist' });
    const before = (await log()).length;
    const r = await call('alice', 'DELETE', `/api/calendar/events/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual((await log()).slice(before).map((e) => e.op), ['plan.calendar.unlink', 'calendar.appointment.remove']);
    const plan = await call('alice', 'GET', '/api/plans/dentist');
    assert.ok(!plan.json.links?.some((l: any) => l.evt_id === id));
  });

  test('a partner\'s own calendar is refused, and nothing changes', async () => {
    const id = await make('alice', { summary: 'Mine, not yours', on: 'mine' });
    const before = (await log()).length;
    const r = await call('bob', 'DELETE', `/api/calendar/events/${id}`);
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.match(r.json.error, /only Alice/);
    assert.equal((await log()).length, before);
    const [mine] = (await listCalendars(aliceSid)).filter((c) => c.isDefault);
    assert.ok((await listEvents(aliceSid, { calendars: [mine!], start: 0, end: 4_000_000_000 })).some((e) => e.evt_id === id));
  });

  test('one already gone from the NAS is still taken off the app\'s books', async () => {
    const id = await make('alice', { summary: 'Deleted on a phone' });
    const h = await household();
    const { deleteEvent } = await import('../src/synology.ts');
    await deleteEvent(aliceSid, { cal_id: h.cal_id, original_cal_id: h.original_cal_id, evt_id: id });
    const r = await call('alice', 'DELETE', `/api/calendar/events/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok((await log()).some((e) => e.op === 'calendar.appointment.remove' && e.evt_id === id));
  });

  test('one the app did not make, or already removed, is a 404', async () => {
    const id = await make('alice', { summary: 'Twice' });
    assert.equal((await call('alice', 'DELETE', `/api/calendar/events/${id}`)).status, 200);
    const again = await call('alice', 'DELETE', `/api/calendar/events/${id}`);
    assert.equal(again.status, 404);
    assert.equal((await call('alice', 'DELETE', '/api/calendar/events/999999')).status, 404);
  });
});

describe('POST /api/calendar/conflicts: what the form shows under the times', () => {
  test('names what clashes and offers free times of the same length, and changes nothing', async () => {
    const mk = await call('alice', 'POST', '/api/calendar/events', form({ summary: 'Busy', start: `${day(6)}T10:00`, end: `${day(6)}T11:00` }));
    assert.equal(mk.status, 200);
    const before = (await log()).length;
    const r = await call('bob', 'POST', '/api/calendar/conflicts', { start: `${day(6)}T10:30`, end: `${day(6)}T11:30`, allDay: false, on: 'household' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.clashes.map((c: any) => c.summary), ['Busy']);
    assert.equal(r.json.clashes[0].label, 'Household');
    assert.ok(r.json.slots.length >= 1 && r.json.slots.length <= 3);
    for (const s of r.json.slots) assert.equal(s.end - s.start, 3600);
    assert.ok(!r.json.slots.some((s: any) => s.start < Date.parse(`${day(6)}T11:00:00Z`) / 1000 && s.end > Date.parse(`${day(6)}T10:00:00Z`) / 1000),
      'no offered time overlaps the clash');
    assert.equal((await log()).length, before, 'the calendars you check are not rewritten by looking');
  });

  test('nothing clashing is an empty list and no slots', async () => {
    const r = await call('alice', 'POST', '/api/calendar/conflicts', { start: `${day(20)}T10:00`, end: `${day(20)}T11:00`, allDay: false, on: 'mine' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.clashes, []);
    assert.deepEqual(r.json.slots, []);
  });

  test('an event being changed does not clash with itself', async () => {
    const mk = await call('alice', 'POST', '/api/calendar/events', form({ summary: 'Me again', start: `${day(8)}T10:00`, end: `${day(8)}T11:00` }));
    const id = mk.json.appointment.evt_id;
    const q = { start: `${day(8)}T10:00`, end: `${day(8)}T11:00`, allDay: false, on: 'household' };
    assert.equal((await call('alice', 'POST', '/api/calendar/conflicts', q)).json.clashes.length, 1);
    assert.equal((await call('alice', 'POST', '/api/calendar/conflicts', { ...q, except: id })).json.clashes.length, 0);
  });

  test('a time that cannot be read is a 400, and a session with no NAS behind it says to sign in again', async () => {
    const bad = await call('alice', 'POST', '/api/calendar/conflicts', { start: 'soon', end: 'later', allDay: false, on: 'mine' });
    assert.equal(bad.status, 400);
    const bare = await call('carol', 'POST', '/api/calendar/conflicts', { start: `${day(1)}T10:00`, end: `${day(1)}T11:00`, allDay: false, on: 'mine' });
    assert.ok(bare.status === 403 || bare.status === 409);
  });
});

describe('the settings carry DSM_PUBLIC_URL for the Calendar header and Settings', () => {
  test('unset: null', async () => {
    const r = await call('alice', 'GET', '/api/settings');
    assert.equal(r.status, 200);
    assert.equal(r.json.dsmPublicUrl, null);
  });
});
