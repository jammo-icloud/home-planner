// api/test/server-households.test.ts
//
// Removing a household for good, through the route: alex owns "Wren", bob is a
// member with it open, alice is in neither. Like the other server suites this
// sets process.env at module scope (DSM_URL, HOUSEHOLDS_DIR and the rest, read
// once when src/ loads), so it depends on node --test running each test file
// in its own process.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

// A real (fake) DSM on a free port, and the app pointed at it. Everything from
// src/ is imported after process.env is set, because it is read on load.
const dir = await mkdtemp(join(tmpdir(), 'pb-server-households-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: {
    alex: { password: 'correct-horse' }, bob: { password: 'battery-staple' }, alice: { password: 'tr0ub4dor' },
  },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DSM_URL: `http://127.0.0.1:${nas.port}`, DEV_USER: 'sandbox',
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
for (const v of ['ADMIN_USER', 'ALLOWED_USERS', 'BOOK_URL', 'BOOK_HOUSEHOLD', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
  'SMTP_FROM', 'SMTP_PLAIN_AUTH', 'DSM_PUBLIC_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'PROFILE_CERT_DIR',
  'COOKIE_INSECURE', 'TRUST_PROXY']) delete process.env[v];

const { start } = await import('../src/server.ts');
const { saveConnector } = await import('../src/connectors.ts');
type Mail = import('../src/mail.ts').Mail;

const ORIGIN = 'https://book.example.com';
const NO_ACCESS = 'you do not have access to that household';
const NONE_OPEN = 'no household is open — choose or create one';
/** What the server would have mailed. */
const sent: Mail[] = [];

let base = '';
let close: () => Promise<void> = async () => {};
let alex = '';
let bob = '';
let alice = '';

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

async function signIn(username: string, password: string): Promise<string> {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `${username} signs in`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.ok(cookie, `${username} has a cookie`);
  return cookie;
}

const listed = async (cookie: string): Promise<string[]> =>
  ((await call(cookie, 'GET', '/api/households')).json.households as { id: string }[]).map((h) => h.id);

before(async () => {
  const server = await start({ send: async (_cfg, m) => { sent.push(m); } });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  alex = await signIn('alex', 'correct-horse');
  bob = await signIn('bob', 'battery-staple');
  alice = await signIn('alice', 'tr0ub4dor');
  assert.equal((await call(alex, 'POST', '/api/households', { label: 'Wren' })).status, 200);
  assert.equal((await call(alex, 'POST', '/api/members', { member: 'bob' })).status, 200);
  assert.equal((await call(bob, 'POST', '/api/households/select', { household: 'wren' })).status, 200);
  // alice's own, with a name that differs from alex's only in case and a space.
  assert.equal((await call(alice, 'POST', '/api/households', { label: 'W ren' })).status, 200);
});

after(async () => { await close(); await nas.close(); await rm(dir, { recursive: true, force: true }); });

describe('the owner removes a household for good', () => {
  test('a member who is not the owner is refused', async () => {
    const r = await call(bob, 'POST', '/api/households/remove', { household: 'wren', label: 'Wren' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'only the owner can remove a household');
    assert.ok((await listed(alex)).includes('wren'));
  });

  test('a stranger learns nothing', async () => {
    const theirs = await call(alice, 'POST', '/api/households/remove', { household: 'wren', label: 'Wren' });
    assert.equal(theirs.status, 403);
    assert.equal(theirs.json.error, NO_ACCESS);
    const none = await call(alex, 'POST', '/api/households/remove', { household: 'nowhere', label: 'Nowhere' });
    assert.equal(none.status, 403);
    assert.equal(none.json.error, NO_ACCESS);
    // A path is not an id: the same answer, and nothing outside the households folder is reached.
    const path = await call(alex, 'POST', '/api/households/remove', { household: '../households', label: 'Wren' });
    assert.equal(path.status, 403);
    assert.equal(path.json.error, NO_ACCESS);
    assert.ok(existsSync(join(dir, 'households', 'wren', 'events.jsonl')));
  });

  test('the name must be typed exactly', async () => {
    for (const label of ['wren', 'Wren ', 'W ren', '']) {
      const r = await call(alex, 'POST', '/api/households/remove', { household: 'wren', label });
      assert.equal(r.status, 400, `"${label}"`);
      assert.equal(r.json.error, "type the household's name exactly to remove it");
    }
    // alice's "W ren" is hers: typing its name against her household is checked against her own label only.
    const wrong = await call(alice, 'POST', '/api/households/remove', { household: 'w-ren', label: 'Wren' });
    assert.equal(wrong.status, 400);
    assert.ok((await listed(alex)).includes('wren'));
    assert.ok((await listed(alice)).includes('w-ren'));
  });

  test('the owner removes it, and every session that had it open is cleared', async () => {
    assert.equal((await call(bob, 'GET', '/api/today')).status, 200, 'bob has it open');
    const r = await call(alex, 'POST', '/api/households/remove', { household: 'wren', label: 'Wren' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { removed: 'wren' });
    assert.equal(existsSync(join(dir, 'households', 'wren')), false);
    assert.ok(!(await listed(alex)).includes('wren'));
    assert.ok(!(await listed(bob)).includes('wren'));
    for (const who of [alex, bob]) {
      assert.equal((await call(who, 'GET', '/api/households')).json.current, null);
      const today = await call(who, 'GET', '/api/today');
      assert.equal(today.status, 409);
      assert.equal(today.json.error, NONE_OPEN);
    }
    assert.deepEqual(await listed(alice), ['w-ren'], 'the other household is untouched');
  });

  test('the same name again starts empty', async () => {
    const made = await call(alex, 'POST', '/api/households', { label: 'Wren' });
    assert.equal(made.status, 200);
    assert.equal(made.json.id, 'wren');
    const h = (await call(bob, 'GET', '/api/households')).json.households as { id: string }[];
    assert.ok(!h.some((x) => x.id === 'wren'), 'bob was in the old one, not this one');
    const budgets = await call(alex, 'GET', '/api/budgets');
    assert.equal(budgets.status, 200);
    assert.deepEqual(budgets.json.budgets ?? [], []);
  });

  test('a sandbox session has nothing to remove', async () => {
    const sandbox = await signIn('sandbox', 'anything');
    const r = await call(sandbox, 'POST', '/api/households/remove', { household: 'sandbox', label: 'Sandbox' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'the local sandbox has no household to remove');
  });
});

describe('the household friends book with', () => {
  test('removed, booking is off and the booking page still answers', async () => {
    await saveConnector('bookUrl', { value: ORIGIN }, 'alice');
    await saveConnector('mail', { value: { host: 'mail.example.com', port: 587, user: 'robot', pass: 'pw', from: 'house@example.com', plainAuth: false } }, 'alice');
    assert.equal((await call(alice, 'POST', '/api/calendars/household', {})).status, 200);
    const on = await call(alice, 'POST', '/api/settings/booking', { on: true });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.booking.on, true);

    const r = await call(alice, 'POST', '/api/households/remove', { household: 'w-ren', label: 'W ren' });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    assert.equal((await fetch(base + '/book')).status, 200);
    const before = sent.length;
    const asked = await call('', 'POST', '/book/start', { email: 'ann@example.com' });
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    assert.equal(sent.length, before, 'nothing was mailed for a household that is gone');
    assert.equal(existsSync(join(dir, 'households', 'w-ren')), false, 'asking did not bring it back');
  });
});
