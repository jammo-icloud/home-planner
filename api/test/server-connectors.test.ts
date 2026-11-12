// api/test/server-connectors.test.ts
//
// The deployment's connections, through the server. This file sets process.env
// at module scope (read once when src/ loads), so the suite depends on
// node --test running each test file in its own process.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';
import { fakeAnthropic } from './fake-anthropic.ts';

// A fake DSM on a free port with carol in the administrators group, and the
// app pointed at it with ADMIN_USER unset. DSM_URL and the paths are read when
// src/ loads, so everything from src/ is imported after they are set.
const dir = await mkdtemp(join(tmpdir(), 'pb-server-connectors-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: {
    alice: { password: 'correct-horse' }, bob: { password: 'battery-staple' }, carol: { password: 'c', admin: true },
  },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DSM_URL: `http://127.0.0.1:${nas.port}`,
  HOUSEHOLDS_DIR: join(dir, 'households'), SESSIONS_PATH: join(dir, 'sessions.json'),
  CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
// Claude's requests go to a fake; nothing about mail, booking, sign-in or pricing comes from the deployment.
const fake = await fakeAnthropic();
process.env['ANTHROPIC_BASE_URL'] = fake.url;
for (const name of ['ADMIN_USER', 'DEV_USER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'PLANNER_ROOT', 'CLAUDE_MATCH_MODEL',
  'DSM_PUBLIC_URL', 'ALLOWED_USERS', 'BOOK_URL', 'BOOK_HOUSEHOLD', 'COOKIE_INSECURE', 'CENSUS_API_KEY', 'EIA_API_KEY',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_PLAIN_AUTH']) {
  delete process.env[name];
}

const { start } = await import('../src/server.ts');
const { Households } = await import('../src/households.ts');
const { connectors, resolvedEnv } = await import('../src/connectors.ts');
const { connectorsView, needsAdmin } = await import('../src/connectors-view.ts');
type Mail = import('../src/mail.ts').Mail;
type ConnectorRow = import('../src/connectors-view.ts').ConnectorRow;

const households = new Households(process.env['HOUSEHOLDS_DIR']!);
/** What the server would have mailed; with failSend, the mail server refuses instead. */
const sent: Mail[] = [];
let failSend = false;
/** What the mail server says when it refuses. */
let refusal = 'the mail server said no';

let base = '';
let close: () => Promise<void> = async () => {};

async function call(cookie: string, method: string, path: string, body?: unknown):
  Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
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

let carol = '';
let alice = '';

before(async () => {
  const server = await start({
    send: async (_cfg, m) => {
      if (failSend) throw new Error(refusal);
      sent.push(m);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  carol = await signIn('carol', 'c');
  alice = await signIn('alice', 'correct-horse');
  // alice is in a household; carol, the admin, is in none.
  assert.equal((await call(alice, 'POST', '/api/households', { label: 'Home' })).status, 200);
});

after(async () => { await close(); await nas.close(); await fake.close(); });

const rowOf = (r: { json: any }, id: string): any => r.json.rows.find((x: any) => x.id === id);

describe('who is an admin', () => {
  test("an account in DSM's administrators group is one, at sign-in, and says so everywhere", async () => {
    const carol = await signIn('carol', 'c');
    assert.equal((await call(carol, 'GET', '/api/auth/check')).json.admin, true);
    assert.equal((await call(carol, 'GET', '/api/households')).json.admin, true);
    assert.equal((await call(carol, 'GET', '/api/admin/households')).status, 200);
    const alice = await signIn('alice', 'correct-horse');
    assert.equal((await call(alice, 'GET', '/api/auth/check')).json.admin, false);
    assert.equal((await call(alice, 'GET', '/api/admin/households')).status, 403);
  });
});

describe('Connectors', () => {
  test('seven rows, in order, each with its state, its source and one line', async () => {
    const r = await call(carol, 'GET', '/api/connectors');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.rows.map((x: any) => x.id), ['claude', 'drive', 'calendar', 'mail', 'booking', 'sign-in', 'pricing']);
    assert.ok(r.json.rows.every((x: any) => ['on', 'off', 'broken'].includes(x.state) && typeof x.line === 'string' && x.line));
    assert.ok(r.json.rows.every((x: any) => ['saved', 'off', 'from the deployment', 'default'].includes(x.source)));
    assert.equal(r.json.adminRule, 'group');
    assert.equal(rowOf(r, 'drive').line, 'Reachable; 0 of 1 households have chosen a folder');
    assert.deepEqual(rowOf(r, 'drive').form.households, [{ label: 'Home', owner: 'alice', folder: 'not chosen' }]);
  });

  test('no secret comes back, not on a GET, not in a POST answer, not in a household log', async () => {
    const answers = [
      await call(carol, 'POST', '/api/connectors/mail', { value: { host: 'mail.example.com', port: 587, user: 'robot', pass: 'S3cret-pass', from: 'h@example.com', plainAuth: false } }),
      await call(carol, 'POST', '/api/connectors/claude', { value: '  sk-ant-pasted\n' }),   // Review Focus 5
      await call(carol, 'POST', '/api/connectors/census', { value: 'census-k3y' }),
    ];
    assert.deepEqual(answers.map((a) => a.status), [200, 200, 200]);
    const got = await call(carol, 'GET', '/api/connectors');
    const text = JSON.stringify([got.json, ...answers.map((a) => a.json)]);
    for (const secret of ['S3cret-pass', 'sk-ant-pasted', 'census-k3y']) assert.ok(!text.includes(secret), secret);
    assert.equal(rowOf(got, 'mail').form.pass, 'set');
    assert.equal(rowOf(got, 'claude').form.key, 'set');
    assert.deepEqual([rowOf(got, 'pricing').form.census, rowOf(got, 'pricing').form.eia], ['set', 'not set']);
    assert.equal(rowOf(got, 'pricing').line, 'Census key set');
    const savedKey = connectors().claude;
    assert.equal(savedKey && 'value' in savedKey ? savedKey.value : null, 'sk-ant-pasted');
    const ids = await households.ids();
    assert.ok(ids.length > 0);
    for (const id of ids) assert.doesNotMatch(await readFile(households.path(id), 'utf8'), /S3cret|sk-ant|census-k3y/);
  });

  test('a mail save without the password keeps the saved one', async () => {
    const r = await call(carol, 'POST', '/api/connectors/mail', { value: { host: 'smtp.example.com', port: 465, user: 'robot', from: 'h@example.com', plainAuth: false } });
    assert.equal(r.status, 200);
    assert.equal(resolvedEnv()['SMTP_PASS'], 'S3cret-pass');
    assert.equal(resolvedEnv()['SMTP_HOST'], 'smtp.example.com');
    assert.equal(rowOf(r, 'mail').line, 'smtp.example.com:465, not tested yet');
  });

  test('the first mail save needs a password', async () => {
    assert.equal((await call(carol, 'POST', '/api/connectors/mail', { clear: true })).status, 200);
    const r = await call(carol, 'POST', '/api/connectors/mail', { value: { host: 'mail.example.com', port: 587, user: 'robot', from: 'h@example.com', plainAuth: false } });
    assert.deepEqual([r.status, r.json.error], [400, 'the password is needed the first time']);
    assert.equal(connectors().mail, undefined);
  });

  test('Send me a test mails the typed address, and a failure makes the row broken', async () => {
    await call(carol, 'POST', '/api/connectors/mail', { value: { host: 'mail.example.com', port: 587, user: 'robot', pass: 'S3cret-pass', from: 'h@example.com', plainAuth: false } });
    assert.equal((await call(carol, 'POST', '/api/connectors/mail/test', { to: 'not an address' })).status, 400);
    const ok = await call(carol, 'POST', '/api/connectors/mail/test', { to: 'carol@example.com' });
    assert.equal(ok.status, 200);
    assert.equal(sent.at(-1)!.to, 'carol@example.com');
    assert.equal(rowOf(ok, 'mail').state, 'on');
    assert.match(rowOf(ok, 'mail').line, /^mail\.example\.com:587, last test ok on /);
    assert.equal(rowOf(ok, 'mail').form.lastTo, 'carol@example.com');
    failSend = true;
    try {
      const bad = await call(carol, 'POST', '/api/connectors/mail/test', { to: 'carol@example.com' });
      assert.equal(rowOf(bad, 'mail').state, 'broken');
      assert.equal(rowOf(bad, 'mail').line, 'The last test failed: the mail server said no');
      assert.ok(needsAdmin(bad.json.rows).includes('mail'));
    } finally {
      failSend = false;
    }
    // Saved again after the failed test: that test counts nowhere now, and its address still prefills the next.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await call(carol, 'POST', '/api/connectors/mail', { value: { host: 'mail.example.com', port: 587, user: 'robot', from: 'h@example.com', plainAuth: false } });
    const row = rowOf(again, 'mail');
    assert.deepEqual([row.state, row.line, row.form.lastTo], ['on', 'mail.example.com:587, not tested yet', 'carol@example.com']);
    assert.ok(!needsAdmin(again.json.rows).includes('mail'));
  });

  test("a failed test keeps the mail server's words without the saved user or password", async () => {
    await call(carol, 'POST', '/api/connectors/mail', { value: { host: 'mail.example.com', port: 587, user: 'robot-account', pass: 'S3cret-pass', from: 'h@example.com', plainAuth: false } });
    failSend = true;
    refusal = 'Invalid login: 535 robot-account with S3cret-pass refused';
    try {
      const bad = await call(carol, 'POST', '/api/connectors/mail/test', { to: 'carol@example.com' });
      const line = rowOf(bad, 'mail').line as string;
      assert.equal(line, 'The last test failed: Invalid login: 535 … with … refused');
      const words = connectors().mailTest!.words;
      assert.equal(words, 'Invalid login: 535 … with … refused');
      assert.equal(JSON.parse(await readFile(process.env['CONNECTORS_PATH']!, 'utf8')).mailTest.words, words, 'as saved');
    } finally {
      failSend = false;
      refusal = 'the mail server said no';
    }
  });

  test('Claude: Test sends one minimal request, a 401 makes the row broken in words', async () => {
    await call(carol, 'POST', '/api/connectors/claude', { value: ' sk-ant-pasted \n' });
    fake.answer = 'ok';
    const good = await call(carol, 'POST', '/api/connectors/claude/test', {});
    assert.equal(fake.keys.at(-1), 'sk-ant-pasted');
    assert.equal(rowOf(good, 'claude').state, 'on');
    assert.match(rowOf(good, 'claude').line, /^Key set, last worked /);
    const worked = connectors().claudeTest!.worked;
    assert.equal(worked, connectors().claudeTest!.at);
    fake.answer = 401;
    const r = await call(carol, 'POST', '/api/connectors/claude/test', {});
    const row = rowOf(r, 'claude');
    assert.deepEqual([row.state, row.line], ['broken', 'The key has expired or been revoked']);
    assert.equal(connectors().claudeTest!.worked, worked, 'a failed test keeps when it last worked');
    // A new key is not the old one: saved, the row waits for its Test.
    fake.answer = 'ok';
    const saved = await call(carol, 'POST', '/api/connectors/claude', { value: 'sk-ant-new' });
    assert.deepEqual([rowOf(saved, 'claude').state, rowOf(saved, 'claude').line], ['on', 'Key set, not tested yet']);
  });

  test('a key with a space or a line break inside is refused, and a key that cannot be sent is never quoted', async () => {
    for (const value of ['sk-ant-a\nb', 'sk-ant-a b']) {
      const r = await call(carol, 'POST', '/api/connectors/claude', { value });
      assert.deepEqual([r.status, r.json.error], [400, 'a key is one line with no spaces']);
    }
    // One from the deployment, which no route checked: the request's headers refuse it before it leaves.
    assert.equal((await call(carol, 'POST', '/api/connectors/claude', { clear: true })).status, 200);
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-in side\nsecret';
    try {
      const tested = await call(carol, 'POST', '/api/connectors/claude/test', {});
      assert.equal(tested.status, 200);
      const row = rowOf(tested, 'claude');
      assert.deepEqual([row.state, row.line], ['broken', 'The last test failed: the key could not be sent']);
      const text = JSON.stringify([tested.json, (await call(carol, 'GET', '/api/connectors')).json]);
      assert.ok(!text.includes('secret') && !text.includes('in side'), 'no answer carries the key');
      assert.doesNotMatch(connectors().claudeTest!.words, /secret|in side/);
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  test('who may sign in: never off, never without the admin saving it, names made plain', async () => {   // Review Focus 2
    const off = await call(carol, 'POST', '/api/connectors/sign-in', { off: true });
    assert.deepEqual([off.status, off.json.error], [400, 'who may sign in cannot be off; clear it to let any DSM account sign in']);
    const left = await call(carol, 'POST', '/api/connectors/sign-in', { value: ['alice'] });
    assert.equal(left.status, 400);
    assert.match(left.json.error, /keep carol in the list/);
    assert.equal(left.json.error, 'keep carol in the list, or you would lock yourself out');
    const r = await call(carol, 'POST', '/api/connectors/sign-in', { value: [' Alice ', 'CAROL'] });
    assert.equal(r.status, 200);
    assert.deepEqual(rowOf(r, 'sign-in').form.names, ['alice', 'carol']);
    assert.equal(rowOf(r, 'sign-in').line, '2 accounts');
    await signIn('alice', 'correct-horse');
    const cleared = await call(carol, 'POST', '/api/connectors/sign-in', { clear: true });
    assert.equal(cleared.status, 200);
    assert.equal(rowOf(cleared, 'sign-in').line, 'Any DSM account');
  });

  test('the accounts the admin can list, members marked', async () => {
    const r = await call(carol, 'GET', '/api/connectors/accounts');
    assert.equal(r.status, 200);
    const byName = new Map(r.json.accounts.map((a: any) => [a.name, a.member]));
    assert.equal(byName.get('alice'), true);
    assert.equal(byName.get('carol'), false);
  });

  test('saved off beats the deployment, and says off', async () => {
    process.env['DSM_PUBLIC_URL'] = 'https://nas.example.com:5001';
    try {
      const before = rowOf(await call(carol, 'GET', '/api/connectors'), 'calendar');
      assert.deepEqual([before.state, before.source, before.line], ['on', 'from the deployment', 'https://nas.example.com:5001']);
      const r = await call(carol, 'POST', '/api/connectors/public-url', { off: true });
      const row = rowOf(r, 'calendar');
      assert.deepEqual([row.state, row.source, row.line], ['off', 'off', 'Off on purpose']);
      assert.ok(!needsAdmin(r.json.rows).includes('calendar'));
      const bad = await call(carol, 'POST', '/api/connectors/public-url', { value: 'https://nas.example.com:5001/webman' });
      assert.deepEqual([bad.status, bad.json.error], [400, 'an address such as https://nas.example.com:5001, with nothing after the port']);
      assert.equal((await call(carol, 'POST', '/api/connectors/public-url', { value: 'x', off: true })).json.error, 'send one of value, off or clear');
    } finally {
      await call(carol, 'POST', '/api/connectors/public-url', { clear: true });
      delete process.env['DSM_PUBLIC_URL'];
    }
  });

  test("the booking page's address is an https origin, as booking reads it", async () => {
    const plain = await call(carol, 'POST', '/api/connectors/book-url', { value: 'http://book.example.com' });
    assert.deepEqual([plain.status, plain.json.error], [400, 'Start it with https://, like https://planner.example.com']);
    // A path is refused in words that say what to type.
    const path = await call(carol, 'POST', '/api/connectors/book-url', { value: 'https://book.example.com/book' });
    assert.deepEqual([path.status, path.json.error], [400, 'Just the address, with no path: like https://planner.example.com']);
    const r = await call(carol, 'POST', '/api/connectors/book-url', { value: ' https://book.example.com/ ' });
    assert.equal(r.status, 200);
    const row = rowOf(r, 'booking');
    assert.deepEqual([row.state, row.source, row.form.address], ['off', 'saved', 'https://book.example.com']);
    // One line: off, and what is missing.
    assert.equal(row.line, 'Off: no household has turned booking on');
    await call(carol, 'POST', '/api/connectors/book-url', { clear: true });
  });

  test('a member who is not an admin is refused every route', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/connectors'], ['GET', '/api/connectors/accounts'],
      ...['public-url', 'sign-in', 'book-url', 'mail', 'mail/test', 'census', 'eia', 'claude', 'claude/test']
        .map((p): [string, string] => ['POST', `/api/connectors/${p}`]),
    ];
    for (const [method, path] of routes) {
      const r = await call(alice, method, path, method === 'POST' ? { clear: true } : undefined);
      assert.deepEqual([r.status, r.json.error], [403, 'not an administrator'], `${method} ${path}`);
    }
  });
});

describe("This NAS's Booking row", () => {
  test('one line: on, where and for which household; or off and what is missing', () => {
    const view = (booking: Parameters<typeof connectorsView>[0]['booking'], bookingLabel: string | null) =>
      connectorsView({ env: {}, households: [], driveReachable: null, booking, bookingLabel, adminRule: 'group' })
        .rows.find((r) => r.id === 'booking')!;
    const smtp = { host: 'h', port: 587, user: 'u', pass: 'p', from: 'house@example.com' };
    const on = view({ on: true, config: { url: 'https://planner.example.com', household: 'example', smtp } }, 'Example');
    assert.deepEqual([on.state, on.line], ['on', 'On at https://planner.example.com/book for Example']);
    assert.deepEqual([view({ on: false, why: 'BOOK_URL' }, null).line, view({ on: false, why: 'SMTP_HOST' }, null).line],
      ['Off: the booking address is not set', 'Off: mail is not set up']);
  });
});

describe("the admin's card", () => {
  const row = (id: ConnectorRow['id'], state: ConnectorRow['state'], source: ConnectorRow['source']): ConnectorRow =>
    ({ id, state, source, line: 'x', form: {} });

  test("names the admin's rows with nothing set, and any that is broken; never one saved off, Drive or Booking", () => {
    assert.deepEqual(needsAdmin([
      row('claude', 'off', 'default'), row('drive', 'broken', 'from the deployment'), row('calendar', 'off', 'default'),
      row('mail', 'off', 'default'), row('booking', 'off', 'default'), row('sign-in', 'on', 'default'), row('pricing', 'off', 'default'),
    ]), ['claude', 'calendar', 'mail', 'pricing']);
    assert.deepEqual(needsAdmin([
      row('claude', 'off', 'off'), row('calendar', 'broken', 'saved'), row('mail', 'on', 'from the deployment'), row('pricing', 'off', 'off'),
    ]), ['calendar']);
  });
});
