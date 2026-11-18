// api/test/server-guest-ask.test.ts
//
// 0.11.0, over HTTP: POST /book/ask, the one way onto the guest list from the
// booking page, and POST /api/guests/asks, a member's answer. /book/ask says
// the same thing whoever asks, so the page never tells a stranger who is on
// the list; it writes a request only for an address that is new. Like
// server-book.test.ts this sets process.env at module scope, before src/
// loads, and relies on node --test giving each file its own process.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

const dir = await mkdtemp(join(tmpdir(), 'pb-server-guest-ask-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'),
  accounts: { alice: { password: 'correct-horse' }, bob: { password: 'battery-staple' } },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DSM_URL: `http://127.0.0.1:${nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
  BOOK_URL: 'https://planner.example.com', BOOK_HOUSEHOLD: 'home',
  SMTP_HOST: 'mail.example.com', SMTP_PORT: '587', SMTP_USER: 'robot', SMTP_PASS: 'pw', SMTP_FROM: 'house@example.com',
  TRUST_PROXY: '1',
});
delete process.env['DEV_USER'];
delete process.env['COOKIE_INSECURE'];

const { start } = await import('../src/server.ts');
const { Store } = await import('../src/store.ts');
const { Households } = await import('../src/households.ts');
const { MailError } = await import('../src/mail.ts');
const { asksSettled } = await import('../src/booking.ts');
const households = new Households(join(dir, 'households'));
type Mail = import('../src/mail.ts').Mail;

const ORIGIN = 'https://planner.example.com';
/** What the server would have mailed. */
const sent: Mail[] = [];
/** Set, the next mails fail as a mail server refusing them would. */
let failing = false;

let base = '';
let close: () => Promise<void> = async () => {};

async function call(method: string, path: string,
                    opts: { body?: unknown; cookie?: string; ip?: string; headers?: Record<string, string>; origin?: string | null } = {}) {
  const origin = opts.origin === undefined ? (method !== 'GET' && path.startsWith('/book') ? ORIGIN : null) : opts.origin;
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.ip ? { 'x-forwarded-for': `203.0.113.99, ${opts.ip}` } : {}),
      ...opts.headers,
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const cookieOf = (h: Headers) => (h.get('set-cookie') ?? '').split(';')[0]!;

let ipSeq = 0;
const SAM = { name: 'Sam Rivera', email: 'sam@example.com', how: "Alex's college roommate" };
/** Ask from the booking page, then wait for the line it may write: the answer does not wait for it. */
async function askFor(body: Record<string, unknown>, ip = `10.9.0.${++ipSeq}`) {
  const r = await call('POST', '/book/ask', { body, ip });
  await asksSettled();
  return r;
}
const asksIn = async () => (await (await households.open('home')).since(null)).filter((e) => e.op === 'guest.ask');

before(async () => {
  const server = await start({
    send: async (_cfg, m) => {
      if (failing) throw new MailError('451 try again later');
      sent.push(m);
    },
    households,
  });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
});

after(async () => { await close(); await nas.close(); });

describe('with booking off, asking is not available, as nothing under /book is', () => {
  test('404, "not available", and nothing is written or sent', async () => {
    const r = await askFor(SAM);
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'not available' });
    assert.equal(sent.length, 0);
  });
});

describe('with booking on', () => {
  let alice = '';
  let bob = '';

  before(async () => {
    await mkdir(join(dir, 'households', 'home'), { recursive: true });
    const s = new Store({ path: join(dir, 'households', 'home', 'events.jsonl') });
    await s.load();
    await s.append('alice', [
      { op: 'household.claim', label: 'Home' },
      { op: 'member.add', member: 'bob', why: 'my partner' },
      { op: 'guest.allow', email: 'on@example.com', name: 'On the list', why: 'friends' },
    ]);
    const a = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'correct-horse' } });
    alice = cookieOf(a.headers);
    assert.equal((await call('POST', '/api/households/select', { body: { household: 'home' }, cookie: alice })).status, 200);
    const b = await call('POST', '/api/auth/login', { body: { username: 'bob', password: 'battery-staple' } });
    bob = cookieOf(b.headers);
    assert.equal((await call('POST', '/api/households/select', { body: { household: 'home' }, cookie: bob })).status, 200);
  });

  test('new, already on the list, already asked, declined before: the same answer each time, and no mail', async () => {
    const answers = [];
    answers.push(await askFor(SAM));
    assert.equal((await asksIn()).length, 1, 'new: one request');
    answers.push(await askFor({ ...SAM, email: 'on@example.com' }));
    answers.push(await askFor(SAM));
    assert.equal((await asksIn()).length, 1, 'on the list, or asked already: nothing written');
    const no = await call('POST', '/api/guests/asks', { cookie: alice, body: { email: SAM.email, answer: 'decline' } });
    assert.equal(no.status, 200, no.text);
    answers.push(await askFor(SAM));
    assert.equal((await asksIn()).length, 2, 'declined before: a new request waits');
    for (const r of answers) {
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
      assert.equal(r.text, answers[0]!.text, 'byte for byte the same');
      assert.equal(r.headers.get('set-cookie'), null);
    }
    assert.equal(sent.length, 0, 'asking and declining send nothing');
    assert.equal((await asksIn())[0]!.who, 'system');
  });

  test('only from the page itself, and only JSON', async () => {
    const elsewhere = await call('POST', '/book/ask', { body: SAM, origin: 'https://evil.example.net', ip: '10.9.1.1' });
    assert.equal(elsewhere.status, 403);
    const none = await call('POST', '/book/ask', { body: SAM, origin: null, ip: '10.9.1.2' });
    assert.equal(none.status, 403);
    const plain = await call('POST', '/book/ask', { body: SAM, headers: { 'content-type': 'text/plain' }, ip: '10.9.1.3' });
    assert.equal(plain.status, 415);
  });

  test('a field that is wrong is said in plain words, what was sent kept by the page', async () => {
    for (const [body, words] of [
      [{ ...SAM, email: 'not an address' }, 'that is not an email address'],
      [{ ...SAM, name: '' }, 'give your name'],
      [{ ...SAM, how: '' }, 'say how you know them'],
    ] as const) {
      const r = await askFor(body);
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { error: words });
    }
  });

  test('five an hour from one place', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await askFor({ ...SAM, email: `p${i}@example.com` }, '10.9.2.1')).status, 200);
    const r = await askFor({ ...SAM, email: 'p5@example.com' }, '10.9.2.1');
    assert.equal(r.status, 429);
    assert.match(r.json.error, /too many requests from here/);
  });

  test("a member sees it on Today and in Settings; Add puts them on the list and sends one plain email", async () => {
    await askFor({ name: 'Casey Rivera', email: 'casey@example.com', how: 'Neighbours' });
    const page = await call('GET', '/api/thread?quiet=1', { cookie: bob });
    assert.equal(page.status, 200, page.text);
    const w = page.json.waiting.find((x: any) => x.kind === 'guest' && x.ask.email === 'casey@example.com');
    assert.ok(w, JSON.stringify(page.json.waiting));
    assert.equal(w.title, 'Casey Rivera asks to be a guest');
    assert.equal(w.ask.how, 'Neighbours');
    const st = await call('GET', '/api/settings', { cookie: bob });
    assert.ok(st.json.guests.asks.some((a: any) => a.email === 'casey@example.com' && a.name === 'Casey Rivera'));

    const before = sent.length;
    const r = await call('POST', '/api/guests/asks', { cookie: bob, body: { email: 'casey@example.com', answer: 'add' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.answered, { answer: 'added', email: 'casey@example.com', name: 'Casey Rivera', mailed: true });
    assert.ok(r.json.guests.list.some((g: any) => g.email === 'casey@example.com' && g.allowedBy === 'bob'));
    assert.ok(!r.json.guests.asks.some((a: any) => a.email === 'casey@example.com'));
    assert.equal(sent.length, before + 1);
    const m = sent.at(-1)!;
    assert.equal(m.to, 'casey@example.com');
    assert.equal(m.subject, "You're on the list");
    assert.deepEqual(m.text.match(/https?:\/\/\S+/g), ['https://planner.example.com/book']);
    assert.doesNotMatch(m.text, /\/book\/open|token|\d{6}/);
    // They sign in as every guest does: the address is on the list now.
    const link = await call('POST', '/book/start', { body: { email: 'casey@example.com' }, ip: '10.9.3.1' });
    assert.equal(link.status, 200);
    assert.equal(sent.length, before + 2);
    assert.match(sent.at(-1)!.text, /\/book\/open\?token=/);
  });

  test('two members answering at once: one settles it, the other is told who did', async () => {
    await askFor({ name: 'Alex Rivera', email: 'alex@example.com', how: 'From work' });
    const before = sent.length;
    const [a, b] = await Promise.all([
      call('POST', '/api/guests/asks', { cookie: alice, body: { email: 'alex@example.com', answer: 'add' } }),
      call('POST', '/api/guests/asks', { cookie: bob, body: { email: 'alex@example.com', answer: 'decline' } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const lost = a.status === 409 ? a : b;
    const won = a.status === 200 ? 'alice' : 'bob';
    assert.deepEqual(lost.json, { error: `already answered by ${won}` });
    assert.equal(sent.length - before, won === 'alice' ? 1 : 0);
  });

  test('a mail that fails: still on the list, and the answer says the email did not go', async () => {
    await askFor({ name: 'Dana Rivera', email: 'dana@example.com', how: 'Book club' });
    failing = true;
    let r;
    const warn = console.warn;
    console.warn = () => {};
    try {
      r = await call('POST', '/api/guests/asks', { cookie: alice, body: { email: 'dana@example.com', answer: 'add' } });
    } finally { failing = false; console.warn = warn; }
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.answered.mailed, false);
    assert.ok(r.json.guests.list.some((g: any) => g.email === 'dana@example.com'));
    assert.doesNotMatch(r.text, /451|mail\.example\.com|SMTP/);
  });

  test('an answer that is neither, or no such request', async () => {
    assert.equal((await call('POST', '/api/guests/asks', { cookie: alice, body: { email: 'nobody@example.com', answer: 'add' } })).status, 404);
    assert.equal((await call('POST', '/api/guests/asks', { cookie: alice, body: { email: SAM.email, answer: 'later' } })).status, 400);
  });

  test("with booking off, a request is neither on Today nor answerable; it is all there again once booking is back on", async () => {
    await askFor({ name: 'Sam Rivera Jr.', email: 'junior@example.com', how: 'Family' });
    const home = await households.open('home');
    await home.append('alice', { op: 'guests.booking', on: false });
    try {
      const page = await call('GET', '/api/thread?quiet=1', { cookie: alice });
      assert.equal(page.status, 200, page.text);
      assert.equal(page.json.waiting.some((x: any) => x.kind === 'guest'), false);
      const r = await call('POST', '/api/guests/asks', { cookie: alice, body: { email: 'junior@example.com', answer: 'add' } });
      assert.equal(r.status, 404);
      assert.deepEqual(r.json, { error: 'not available' });
      assert.equal(home.state.guests.has('junior@example.com'), false);
    } finally {
      await home.append('alice', { op: 'guests.booking', on: true });
    }
    const back = await call('GET', '/api/thread?quiet=1', { cookie: alice });
    assert.ok(back.json.waiting.some((x: any) => x.kind === 'guest' && x.ask.email === 'junior@example.com'));
  });
});
