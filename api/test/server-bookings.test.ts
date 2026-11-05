// api/test/server-bookings.test.ts
//
// The members' side of booking over HTTP: nights kept for the household
// (blocks), the guest list, what Settings says about both, and the guest page
// itself as a file. Like server-book.test.ts this sets process.env at module
// scope, before src/ loads, and relies on node --test giving each file its own
// process.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

const dir = await mkdtemp(join(tmpdir(), 'pb-server-bookings-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alice: { password: 'correct-horse' }, carol: { password: 'c' } },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DSM_URL: `http://127.0.0.1:${nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
  BOOK_URL: 'https://book.example.com', BOOK_HOUSEHOLD: 'home',
  SMTP_HOST: 'mail.example.com', SMTP_PORT: '587', SMTP_USER: 'robot', SMTP_PASS: 'pw', SMTP_FROM: 'house@example.com',
  TRUST_PROXY: '1',
});
delete process.env['DEV_USER'];
delete process.env['COOKIE_INSECURE'];

const { start } = await import('../src/server.ts');
const { Households } = await import('../src/households.ts');
const households = new Households(join(dir, 'households'));
type Mail = import('../src/mail.ts').Mail;

const sent: Mail[] = [];
let base = '';
let close: () => Promise<void> = async () => {};

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; ip?: string } = {}) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      // The booking page's own POSTs carry its origin, as a browser sends it.
      ...(method !== 'GET' && path.startsWith('/book') ? { origin: 'https://book.example.com' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const cookieOf = (h: Headers) => (h.get('set-cookie') ?? '').split(';')[0]!;
const tokenIn = (m: Mail) => /\/book\/open\?token=([\w-]+)/.exec(m.text)?.[1];

/** A guest on the list, signed in by their emailed link, as a browser would. */
let ips = 0;
async function guestIn(email: string): Promise<string> {
  await call('POST', '/book/start', { body: { email }, ip: `10.3.0.${++ips}` });
  const res = await fetch(base + '/book/open', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://book.example.com' },
    body: new URLSearchParams({ token: tokenIn(sent.at(-1)!)! }).toString(),
  });
  assert.equal(res.status, 303, `${email} signs in`);
  return cookieOf(res.headers);
}
async function memberIn(username: string, password: string): Promise<string> {
  const r = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(r.status, 200, `${username} signs in`);
  return cookieOf(r.headers);
}

const YEAR = '2097';
const day = (m: number, d: number) => `${YEAR}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

let alice = '';     // a member of the household friends book with
let carol = '';     // a member of another household only
let guest = '';     // a guest's cookie

before(async () => {
  // The household is there at boot, so booking is on from the start.
  const { store } = await households.create('alice', 'Home', { id: 'home' });
  await store.append('alice', [
    { op: 'guest.allow', email: 'ann@example.com', name: 'The Nguyens', why: 'old friends' },
    { op: 'booking.confirm', request: 'r-stay', email: 'ann@example.com', arrive: day(3, 10), depart: day(3, 14), headcount: 3,
      cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', evt_id: 7, ical_uid: 'uid-7', dav_etag: '"1"' },
  ]);
  await households.create('carol', 'Carol\'s');
  const server = await start({ send: async (_cfg, m) => { sent.push(m); }, households });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  alice = await memberIn('alice', 'correct-horse');
  carol = await memberIn('carol', 'c');
  guest = await guestIn('ann@example.com');
});

after(async () => { await close(); await nas.close(); });

describe('nights kept for the household', () => {
  test('a member blocks nights: a line by them, and a guest sees those nights taken, with no reason', async () => {
    const r = await call('POST', '/api/bookings/block', { cookie: alice, body: { from: day(4, 2), to: day(4, 5), why: 'family is here' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(typeof r.json.id, 'string');
    const block = (await households.open('home')).state.stayBlocks.get(r.json.id)!;
    assert.deepEqual({ from: block.from, to: block.to, why: block.why, by: block.by },
      { from: day(4, 2), to: day(4, 5), why: 'family is here', by: 'alice' });
    const nights = await call('GET', `/book/nights?month=${YEAR}-04`, { cookie: guest });
    assert.deepEqual(nights.json.nights.filter((n: any) => n.night >= day(4, 1) && n.night <= day(4, 5)), [
      { night: day(4, 1), status: 'open' }, { night: day(4, 2), status: 'taken' }, { night: day(4, 3), status: 'taken' },
      { night: day(4, 4), status: 'taken' }, { night: day(4, 5), status: 'open' },
    ]);
    assert.ok(!/family|alice/.test(nights.text), nights.text);
  });

  test('a block is refused unless it is days, at least a night, at most 90, with a short reason', async () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ from: '2097-02-30', to: day(5, 2), why: 'w' }, /day/],
      [{ from: day(5, 2), to: 'soon', why: 'w' }, /day/],
      [{ from: day(5, 2), to: day(5, 2), why: 'w' }, /after/],
      [{ from: day(5, 3), to: day(5, 2), why: 'w' }, /after/],
      [{ from: day(5, 1), to: day(8, 1), why: 'w' }, /90 nights/],
      [{ from: day(5, 1), to: day(5, 2) }, /why|reason/],
      [{ from: day(5, 1), to: day(5, 2), why: '  ' }, /why|reason/],
      [{ from: day(5, 1), to: day(5, 2), why: 'x'.repeat(201) }, /200/],
      [{ from: '2000-01-01', to: '2000-01-03', why: 'w' }, /passed/],
    ];
    for (const [body, re] of bad) {
      const r = await call('POST', '/api/bookings/block', { cookie: alice, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, re, JSON.stringify(body));
    }
    // Exactly 90 is fine.
    const ok = await call('POST', '/api/bookings/block', { cookie: alice, body: { from: day(9, 1), to: day(11, 30), why: 'away' } });
    assert.equal(ok.status, 200, ok.text);
  });

  test('over a confirmed stay: refused, naming the stay; over another block: refused, naming it', async () => {
    const r = await call('POST', '/api/bookings/block', { cookie: alice, body: { from: day(3, 12), to: day(3, 16), why: 'painting' } });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /^those nights are taken: The Nguyens is staying Mar 10–14, 2097$/);
    assert.ok(!/ann@/.test(r.text), 'no address in it');
    const again = await call('POST', '/api/bookings/block', { cookie: alice, body: { from: day(4, 4), to: day(4, 6), why: 'more' } });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /already kept.*family is here/);
  });

  test('over a request still waiting: allowed, and its card on Today says the nights are now blocked', async () => {
    const asked = await call('POST', '/book/request', { cookie: guest, body: { arrive: day(6, 10), depart: day(6, 13), headcount: 2, note: 'hi' } });
    assert.equal(asked.status, 200, asked.text);
    const before = await call('GET', '/api/thread', { cookie: alice });
    const card = (page: any) => page.json.entries.find((e: any) => e.kind === 'card' && e.offer.id === asked.json.id);
    assert.equal(card(before).blocked, undefined);
    const r = await call('POST', '/api/bookings/block', { cookie: alice, body: { from: day(6, 11), to: day(6, 12), why: 'the roof' } });
    assert.equal(r.status, 200, r.text);
    const after = await call('GET', '/api/thread', { cookie: alice });
    assert.match(card(after).blocked, /^Nights now blocked: Jun 11–12, 2097, “the roof”$/);
    assert.ok(!/ann@/.test(card(after).blocked));
    // Approving it is refused, and says why.
    const ok = await call('POST', '/api/thread/decide', { cookie: alice, body: { offer: asked.json.id, decision: 'approved' } });
    assert.equal(ok.status, 409);
    assert.match(ok.json.error, /kept for the household/);
  });

  test('unblocking takes a reason, and the nights are open again; an unknown block is 404', async () => {
    const r = await call('POST', '/api/bookings/block', { cookie: alice, body: { from: day(7, 1), to: day(7, 3), why: 'maybe' } });
    const id = r.json.id as string;
    assert.equal((await call('DELETE', `/api/bookings/block/${id}`, { cookie: alice, body: {} })).status, 400);
    const ok = await call('DELETE', `/api/bookings/block/${id}`, { cookie: alice, body: { why: 'plans changed' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await households.open('home')).state.stayBlocks.has(id), false);
    const nights = await call('GET', `/book/nights?month=${YEAR}-07`, { cookie: guest });
    assert.equal(nights.json.nights[0].status, 'open');
    const gone = await call('DELETE', `/api/bookings/block/${id}`, { cookie: alice, body: { why: 'again' } });
    assert.equal(gone.status, 404);
  });

  test('a guest\'s cookie or none: 401; a member of another household: 404, and nothing written', async () => {
    const body = { from: day(8, 1), to: day(8, 2), why: 'w' };
    assert.equal((await call('POST', '/api/bookings/block', { body })).status, 401);
    assert.equal((await call('POST', '/api/bookings/block', { cookie: guest, body })).status, 401);
    const count = (await households.open('home')).state.stayBlocks.size;
    const r = await call('POST', '/api/bookings/block', { cookie: carol, body });
    assert.equal(r.status, 404);
    assert.equal((await call('DELETE', '/api/bookings/block/anything', { cookie: carol, body: { why: 'w' } })).status, 404);
    assert.equal((await households.open('home')).state.stayBlocks.size, count);
  });
});

describe('the guest list', () => {
  test('a member lists, adds and removes guests, each with a reason, by name and address', async () => {
    const list = await call('GET', '/api/guests', { cookie: alice });
    assert.equal(list.status, 200, list.text);
    const ann = list.json.guests.find((g: any) => g.email === 'ann@example.com');
    assert.deepEqual(Object.keys(ann).sort(), ['allowedBy', 'at', 'email', 'name', 'why']);
    assert.equal(ann.name, 'The Nguyens');
    assert.equal(ann.why, 'old friends');
    assert.equal(ann.allowedBy, 'alice');

    const added = await call('POST', '/api/guests', { cookie: alice, body: { email: ' Ben@Example.com ', name: 'Ben and Jo', why: 'neighbours' } });
    assert.equal(added.status, 200, added.text);
    // Answered with the settings, as every Settings route is.
    assert.equal(added.json.guests.on, true);
    assert.ok(added.json.guests.list.some((g: any) => g.email === 'ben@example.com' && g.name === 'Ben and Jo'));
    const twice = await call('POST', '/api/guests', { cookie: alice, body: { email: 'ben@example.com', name: 'Ben', why: 'again' } });
    assert.equal(twice.status, 409);
    assert.match(twice.json.error, /already on the list/);

    for (const [body, re] of [
      [{ email: 'not an address', name: 'X', why: 'w' }, /email/],
      [{ email: 'x@example.com', name: ' ', why: 'w' }, /name/],
      [{ email: 'x@example.com', name: 'X' }, /why|reason|know/],
      [{ email: 'x@example.com', name: 'X'.repeat(101), why: 'w' }, /100/],
      [{ email: 'x@example.com', name: 'X', why: 'w'.repeat(201) }, /200/],
    ] as const) {
      const r = await call('POST', '/api/guests', { cookie: alice, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, re);
    }

    const removed = await call('DELETE', `/api/guests/${encodeURIComponent('ben@example.com')}`, { cookie: alice, body: { why: 'moved away' } });
    assert.equal(removed.status, 200, removed.text);
    assert.ok(!removed.json.guests.list.some((g: any) => g.email === 'ben@example.com'));
    assert.equal((await call('DELETE', '/api/guests/ben%40example.com', { cookie: alice, body: { why: 'again' } })).status, 404);
    assert.equal((await call('DELETE', '/api/guests/ann%40example.com', { cookie: alice, body: {} })).status, 400);
  });

  test('removing a guest ends their sessions, even if they are put back, and leaves their stays alone', async () => {
    await call('POST', '/api/guests', { cookie: alice, body: { email: 'dee@example.com', name: 'Dee', why: 'cousin' } });
    const home = await households.open('home');
    await home.append('alice', { op: 'booking.confirm', request: 'r-dee', email: 'dee@example.com', arrive: day(10, 1), depart: day(10, 3),
      headcount: 1, cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', evt_id: 8, ical_uid: 'uid-8', dav_etag: '"1"' });
    const dee = await guestIn('dee@example.com');
    assert.equal((await call('GET', '/book/me', { cookie: dee })).status, 200);
    const r = await call('DELETE', '/api/guests/DEE%40example.com', { cookie: alice, body: { why: 'not any more' } });
    assert.equal(r.status, 200, r.text);
    // Back on the list at once: the old session is still over.
    await call('POST', '/api/guests', { cookie: alice, body: { email: 'dee@example.com', name: 'Dee', why: 'after all' } });
    assert.equal((await call('GET', '/book/me', { cookie: dee })).status, 401);
    const stays = [...(await households.open('home')).state.stays.values()].filter((s) => s.email === 'dee@example.com');
    assert.equal(stays.length, 1);
    assert.equal(stays[0]!.cancelled, false);
    // Another guest's session is untouched.
    assert.equal((await call('GET', '/book/me', { cookie: guest })).status, 200);
  });

  test('a guest\'s cookie or none: 401; a member of another household: 404', async () => {
    assert.equal((await call('GET', '/api/guests')).status, 401);
    assert.equal((await call('GET', '/api/guests', { cookie: guest })).status, 401);
    // A guest's cookie opens no member route that writes, either.
    const before = (await households.open('home')).state;
    const added = await call('POST', '/api/guests', { cookie: guest, body: { email: 'mallory@example.com', name: 'M', why: 'w' } });
    assert.equal(added.status, 401);
    const removed = await call('DELETE', '/api/guests/ann%40example.com', { cookie: guest, body: { why: 'w' } });
    assert.equal(removed.status, 401);
    const blockId = [...before.stayBlocks.keys()][0];
    const unblocked = await call('DELETE', `/api/bookings/block/${blockId ?? 'any'}`, { cookie: guest, body: { why: 'w' } });
    assert.equal(unblocked.status, 401);
    const after = (await households.open('home')).state;
    assert.ok(!after.guests.has('mallory@example.com') && after.guests.has('ann@example.com'));
    assert.equal(after.stayBlocks.size, before.stayBlocks.size);
    for (const [method, path, body] of [['GET', '/api/guests', undefined], ['POST', '/api/guests', { email: 'z@example.com', name: 'Z', why: 'w' }],
      ['DELETE', '/api/guests/ann%40example.com', { why: 'w' }]] as const) {
      const r = await call(method, path, { cookie: carol, ...(body ? { body } : {}) });
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.ok(!/Nguyen|ann@/.test(r.text), r.text);
    }
    assert.ok((await households.open('home')).state.guests.has('ann@example.com'));
  });
});

describe('the arrival note', () => {
  test('a member keeps it from Settings, and Settings answers with it; at most 1000 characters', async () => {
    const r = await call('POST', '/api/guests/arrival', { cookie: alice, body: { text: '  12 Camino Real.\nGate code 4471.  ' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.guests.arrival, '12 Camino Real.\nGate code 4471.');
    assert.equal((await households.open('home')).state.settings.arrival, '12 Camino Real.\nGate code 4471.');
    const long = await call('POST', '/api/guests/arrival', { cookie: alice, body: { text: 'x'.repeat(1001) } });
    assert.equal(long.status, 400);
    assert.match(long.json.error, /1,000/);
    assert.equal((await call('POST', '/api/guests/arrival', { cookie: alice, body: { text: 5 } })).status, 400);
  });

  test('a guest\'s cookie or none: 401; a member of another household: 404, and nothing written', async () => {
    const body = { text: 'come round the back' };
    assert.equal((await call('POST', '/api/guests/arrival', { body })).status, 401);
    assert.equal((await call('POST', '/api/guests/arrival', { cookie: guest, body })).status, 401);
    assert.equal((await call('POST', '/api/guests/arrival', { cookie: carol, body })).status, 404);
    assert.equal((await households.open('home')).state.settings.arrival, '12 Camino Real.\nGate code 4471.');
  });
});

describe('what Settings says about guests', () => {
  test('in the household friends book with: on, where the page is, and the list', async () => {
    const st = (await call('GET', '/api/settings', { cookie: alice })).json;
    assert.equal(st.guests.on, true);
    assert.equal(st.guests.url, 'https://book.example.com/book');
    assert.ok(st.guests.list.some((g: any) => g.email === 'ann@example.com' && g.name === 'The Nguyens'));
  });

  test('in another household: off, and why, with nobody\'s guests in it', async () => {
    const r = await call('GET', '/api/settings', { cookie: carol });
    assert.deepEqual(r.json.guests, { on: false, why: 'friends book with another household on this server',
      words: 'Booking is off here: friends book with another household on this server.' });
    assert.ok(!/ann@|Nguyen/.test(r.text));
  });
});

describe('the guest page, as a file', () => {
  test('/book is the page, without a session, in its place and never a scheme, on the shared tokens under /book', async () => {
    const r = await call('GET', '/book');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(r.text, /<html[^>]*data-place="placitas"/);
    assert.ok(!/data-scheme/.test(r.text), 'no scheme');
    assert.ok(r.text.includes('href="/book/tokens.css"'));
    assert.ok(!/href="\/tokens\.css"/.test(r.text), 'not the path the proxy does not expose');
    // None of the member chrome, and no call to a member route.
    assert.ok(!/\/api\//.test(r.text), 'no member route');
    assert.ok(!/class="top"|hh-pill|household-pill/.test(r.text));
  });

  test('/book loads Satoshi exactly as the app does, and reads in the order a phone shows it, with no CSS reordering', async () => {
    const page = (await call('GET', '/book')).text;
    const app = (await call('GET', '/')).text;
    const font = '<link href="https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap" rel="stylesheet" />';
    assert.ok(app.includes(font), 'the app loads it this way');
    assert.ok(page.includes(font), 'the guest page loads it the same way');
    assert.doesNotMatch(page, /\border\s*:/, 'no CSS order: the document order is the order');
    const at = (id: string) => page.indexOf(`id="${id}"`);
    const order = ['s-month', 'fence', 's-ask', 's-mine', 's-know'].map((id) => [id, at(id)] as const);
    for (const [id, i] of order) assert.ok(i > 0, id);
    for (let i = 1; i < order.length; i++) assert.ok(order[i - 1]![1] < order[i]![1], `${order[i - 1]![0]} before ${order[i]![0]}`);
  });

  test('/book/tokens.css: without a session, the same file and headers as /tokens.css', async () => {
    const a = await call('GET', '/book/tokens.css');
    const b = await call('GET', '/tokens.css');
    assert.equal(a.status, 200);
    for (const h of ['content-type', 'cache-control', 'x-content-type-options', 'content-length']) {
      assert.equal(a.headers.get(h), b.headers.get(h), h);
    }
    assert.equal(a.text, b.text);
  });

  test('/book icons: without a session, the root files under the one path the proxy exposes', async () => {
    for (const [name, type] of [['favicon.ico', 'image/'], ['icon.svg', 'image/svg+xml'], ['icon-180.png', 'image/png']] as const) {
      const a = await call('GET', `/book/${name}`);
      const b = await call('GET', `/${name}`);
      assert.equal(a.status, 200, name);
      assert.ok((a.headers.get('content-type') ?? '').startsWith(type), `${name}: ${a.headers.get('content-type')}`);
      assert.equal(a.headers.get('content-type'), b.headers.get('content-type'), name);
      assert.equal(a.headers.get('content-length'), b.headers.get('content-length'), name);
    }
  });
});
