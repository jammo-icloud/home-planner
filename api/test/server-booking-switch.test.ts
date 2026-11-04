// api/test/server-booking-switch.test.ts
//
// Booking as the owner's switch in Settings, for one household at a time:
// alice's "home" and bob's "cabin" against the fake NAS, with the booking
// page's address and the mail saved on This NAS and nothing in the
// deployment's environment. Like the other server suites this sets process.env
// at module scope, before src/ loads, so it relies on node --test giving each
// file its own process.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeNas } from './fake-nas.ts';

const dir = await mkdtemp(join(tmpdir(), 'pb-server-booking-switch-'));
const nas = await fakeNas();
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DSM_URL: `http://127.0.0.1:${nas.nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
// Booking's page and mail come from Connectors here, and no household is named by the deployment.
for (const v of ['BOOK_URL', 'BOOK_HOUSEHOLD', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_PLAIN_AUTH',
  'DEV_USER', 'ADMIN_USER', 'COOKIE_INSECURE', 'TRUST_PROXY']) delete process.env[v];

const { start } = await import('../src/server.ts');
const { Households } = await import('../src/households.ts');
const { saveConnector } = await import('../src/connectors.ts');
const { setDsmFetch } = await import('../src/synology.ts');
type Mail = import('../src/mail.ts').Mail;

const households = new Households(process.env['HOUSEHOLDS_DIR']!);
const ORIGIN = 'https://book.example.com';
/** What the server would have mailed. */
const sent: Mail[] = [];

let base = '';
let close: () => Promise<void> = async () => {};
let alice = '';
let bob = '';
/** A guest of home's, signed in while home books. */
let guestCookie = '';
/** Their request, waiting on home's Today. */
let requestId = '';

async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', cookie, ...(path.startsWith('/book') && method !== 'GET' ? { origin: ORIGIN } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function signIn(username: string): Promise<string> {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'pw' }),
  });
  assert.equal(res.status, 200, `${username} signs in`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

/** A guest on the list asks for a link and presses Continue on it: their cookie. */
async function guestIn(email: string): Promise<string> {
  assert.equal((await call('', 'POST', '/book/start', { email })).status, 200);
  const token = /\/book\/open\?token=([\w-]+)/.exec(sent.at(-1)?.text ?? '')?.[1];
  assert.ok(token, 'a link was mailed');
  const res = await fetch(base + '/book/open', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams({ token }).toString(),
  });
  assert.equal(res.status, 303);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

/** The Household calendar of the open household, made by its owner. */
const makeCalendar = async (cookie: string) => assert.equal((await call(cookie, 'POST', '/api/calendars/household', {})).status, 200);

before(async () => {
  const server = await start({ send: async (_cfg, m) => { sent.push(m); }, households });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  await saveConnector('bookUrl', { value: ORIGIN }, 'carol');
  await saveConnector('mail', { value: { host: 'mail.example.com', port: 587, user: 'robot', pass: 'pw', from: 'house@example.com', plainAuth: false } }, 'carol');
  alice = await signIn('alice');
  bob = await signIn('bob');
  assert.equal((await call(alice, 'POST', '/api/households', { label: 'Home' })).status, 200);
  assert.equal((await call(bob, 'POST', '/api/households', { label: 'Cabin' })).status, 200);
  await makeCalendar(alice);
});

after(async () => { await close(); await nas.close(); });

describe('booking, switched in Settings', () => {
  test('unavailable without a calendar, saying who can fix it', async () => {
    const r = await call(bob, 'POST', '/api/settings/booking', { on: true });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'Booking is off until bob chooses the Household calendar.');
    const s = (await call(bob, 'GET', '/api/settings')).json.booking;
    assert.equal(s.on, false);
    assert.equal(s.available, false);
    assert.equal(s.why, 'Booking is off until bob chooses the Household calendar.');
    // Home has its calendar, and the NAS's side is set: it could be turned on.
    const home = (await call(alice, 'GET', '/api/settings')).json.booking;
    assert.deepEqual([home.on, home.available, home.calendarGone, home.ahead], [false, true, false, { requests: 0, stays: 0 }]);
  });

  test('on for one household; refused off while a request waits, and refused to another owner, with counts', async () => {
    const on = await call(alice, 'POST', '/api/settings/booking', { on: true });
    assert.equal(on.status, 200);
    assert.equal(on.json.booking.on, true);
    assert.equal(on.json.guests.on, true, 'the guest list is home\'s now');
    const last = (await (await households.open('home')).since(null)).at(-1)!;
    assert.deepEqual([last.op, last.who, (last as any).on], ['guests.booking', 'alice', true]);

    // A guest asks to stay through /book/request.
    assert.equal((await call(alice, 'POST', '/api/guests', { email: 'ann@example.com', name: 'Ann', why: 'old friends' })).status, 200);
    guestCookie = await guestIn('ann@example.com');
    const asked = await call(guestCookie, 'POST', '/book/request', { arrive: '2099-03-02', depart: '2099-03-04', headcount: 2, note: '' });
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    requestId = asked.json.id;

    const off = await call(alice, 'POST', '/api/settings/booking', { on: false });
    assert.equal(off.status, 409);
    assert.equal(off.json.error, 'Booking stays on: 1 request waiting.');
    assert.deepEqual((await call(alice, 'GET', '/api/settings')).json.booking.ahead, { requests: 1, stays: 0 });

    await makeCalendar(bob);
    const theirs = await call(bob, 'POST', '/api/settings/booking', { on: true });
    assert.equal(theirs.status, 409);
    assert.equal(theirs.json.error, 'Home has 1 request waiting: booking stays with them until then.');
    assert.equal((await call(alice, 'GET', '/api/settings')).json.booking.on, true, 'still home\'s');
  });

  test("with nothing ahead, another owner's switch moves it: system turns it off in the old log and its guests are signed out", async () => {
    // The request declined; ann is on cabin's list too, so only being signed out keeps her out.
    const declined = await call(alice, 'POST', '/api/thread/decide', { offer: requestId, decision: 'declined', why: 'we are away' });
    assert.equal(declined.status, 200, JSON.stringify(declined.json));
    await (await households.open('cabin')).append('bob', { op: 'guest.allow', email: 'ann@example.com', name: 'Ann', why: 'old friends' });
    assert.equal((await fetch(base + '/book/me', { headers: { cookie: guestCookie } })).status, 200);

    const moved = await call(bob, 'POST', '/api/settings/booking', { on: true });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
    assert.equal(moved.json.booking.on, true);
    const last = (await (await households.open('home')).since(null)).at(-1)!;
    assert.deepEqual([last.op, last.who, (last as any).on], ['guests.booking', 'system', false]);
    assert.equal((await fetch(base + '/book/me', { headers: { cookie: guestCookie } })).status, 401);
    const home = (await call(alice, 'GET', '/api/settings')).json.booking;
    assert.equal(home.on, false);
    assert.equal(home.words, 'Booking is off here: friends book with another household on this server.');
  });

  test('a member cannot switch it', async () => {
    assert.equal((await call(alice, 'POST', '/api/members', { member: 'bob', why: 'a friend' })).status, 200);
    assert.equal((await call(bob, 'POST', '/api/households/select', { household: 'home' })).status, 200);
    try {
      for (const on of [true, false]) {
        const r = await call(bob, 'POST', '/api/settings/booking', { on });
        assert.equal(r.status, 403);
        assert.equal(r.json.error, 'only alice can change this');
      }
      assert.equal((await (await households.open('home')).since(null)).at(-1)!.op, 'member.add', 'nothing written');
    } finally {
      assert.equal((await call(bob, 'POST', '/api/households/select', { household: 'cabin' })).status, 200);
    }
  });

  test('an empty listing of calendars proves nothing: booking stays on', async () => {
    // Every account has its own default calendar: a list with nothing in it is an answer not understood.
    setDsmFetch((async (url: string | URL | Request, init?: RequestInit) => {
      if (/api=SYNO\.Cal\.Cal&/.test(String(init?.body ?? '')) && /method=list/.test(String(init?.body ?? ''))) {
        return Response.json({ success: true, data: [] });
      }
      return fetch(url, init);
    }) as typeof fetch);
    try {
      const r = await call(bob, 'GET', '/api/calendars');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.calendars, []);
    } finally {
      setDsmFetch(null);
    }
    const s = (await call(bob, 'GET', '/api/settings')).json.booking;
    assert.deepEqual([s.on, s.calendarGone], [true, false]);
    assert.equal((await (await households.open('cabin')).since(null)).at(-1)!.op, 'guests.booking', 'nothing written');
    assert.equal(((await (await households.open('cabin')).since(null)).at(-1) as any).on, true);
  });

  test('the calendar found gone turns booking off, and says so', async () => {
    // Cabin's maker deletes the Household calendar on the fake, then lists their calendars.
    const cal = (await call(bob, 'GET', '/api/settings')).json.calendar.household;
    const sid = await nas.signIn('bob');
    const deleted = await nas.via(`/webapi/entry.cgi`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api: 'SYNO.Cal.Cal', version: '5', method: 'delete', cal_id: cal.cal_id, _sid: sid }).toString(),
    });
    assert.equal(((await deleted.json()) as { success: boolean }).success, true);
    assert.equal((await call(bob, 'GET', '/api/calendars')).status, 200);

    const s = await call(bob, 'GET', '/api/settings');
    assert.equal(s.json.booking.calendarGone, true);
    assert.equal(s.json.booking.on, false);
    const last = (await (await households.open('cabin')).since(null)).at(-1)!;
    assert.deepEqual([last.op, last.who, (last as any).on, (last as any).calendarGone], ['guests.booking', 'system', false, true]);
    // Listed again, it is not turned off twice.
    await call(bob, 'GET', '/api/calendars');
    assert.equal((await (await households.open('cabin')).since(null)).at(-1)!.id, last.id);
    assert.equal((await call('', 'GET', '/book/me')).status, 404, 'no household books now');

    // It cannot be turned on again until a calendar is chosen, and says so in the same words.
    const gone = 'Booking is off: the household calendar is gone. Choose one, then turn booking on again.';
    assert.deepEqual([s.json.booking.available, s.json.booking.why], [false, gone]);
    const again = await call(bob, 'POST', '/api/settings/booking', { on: true });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, gone);
    // A new Household calendar in its place: available again.
    assert.equal((await call(bob, 'POST', '/api/calendars/household', { replace: true })).status, 200);
    const now = (await call(bob, 'GET', '/api/settings')).json.booking;
    assert.deepEqual([now.available, now.calendarGone, now.on], [true, false, false]);
    assert.equal((await call(bob, 'POST', '/api/settings/booking', { on: true })).status, 200);
  });

  test('a calendar found gone where booking is not is recorded too, so booking cannot be turned on against it', async () => {
    // Cabin books; home's maker deletes home's Household calendar, then lists their calendars.
    const cal = (await call(alice, 'GET', '/api/settings')).json.calendar.household;
    const sid = await nas.signIn('alice');
    const deleted = await nas.via(`/webapi/entry.cgi`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api: 'SYNO.Cal.Cal', version: '5', method: 'delete', cal_id: cal.cal_id, _sid: sid }).toString(),
    });
    assert.equal(((await deleted.json()) as { success: boolean }).success, true);
    assert.equal((await call(alice, 'GET', '/api/calendars')).status, 200);

    const last = (await (await households.open('home')).since(null)).at(-1)!;
    assert.deepEqual([last.op, last.who, (last as any).on, (last as any).calendarGone], ['guests.booking', 'system', false, true]);
    const gone = 'Booking is off: the household calendar is gone. Choose one, then turn booking on again.';
    const on = await call(alice, 'POST', '/api/settings/booking', { on: true });
    assert.deepEqual([on.status, on.json.error], [409, gone]);
    // Listed again, it is not written twice; cabin still books.
    await call(alice, 'GET', '/api/calendars');
    assert.equal((await (await households.open('home')).since(null)).at(-1)!.id, last.id);
    assert.equal((await call(bob, 'GET', '/api/settings')).json.booking.on, true);
  });
});
