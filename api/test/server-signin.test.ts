import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';
import { chooseFolderIn } from './folder.ts';

// 0.10.3: a session that cannot reach the NAS is a signed-out session. alice
// signs in through a fake DSM; bob is the local sandbox (DEV_USER), which never
// has a DSM sign-in. SESSIONS_PATH is set as 0.10.2 read it, so a build that
// still kept sessions on disk would carry alice's over a restart; 0.10.3 reads
// nothing there, and a stale file left in the data folder is ignored.
const dir = await mkdtemp(join(tmpdir(), 'pb-signin-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alice: { password: 'correct-horse' } },
});
const sessionsFile = join(dir, 'sessions.json');
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DSM_URL: `http://127.0.0.1:${nas.port}`, PLANNER_ROOT: '/Planner', ADMIN_USER: 'alice',
  DEV_USER: 'bob', DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: sessionsFile, CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];
for (const v of ['BOOK_URL', 'BOOK_HOUSEHOLD', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[v];

const { Households } = await import('../src/households.ts');
const { COOKIE } = await import('../src/auth.ts');
const { SessionLost, setDsmFetch } = await import('../src/synology.ts');
const { runEffect } = await import('../src/tools.ts');
const { pagesIdle } = await import('../src/pages.ts');
const { start } = await import('../src/server.ts');

const households = new Households(process.env['HOUSEHOLDS_DIR']!);
let homePath = '';

/**
 * The NAS as the app reaches it after sign-in. While `forgotten`, every call
 * is answered as DSM answers a sid it no longer knows (119), as after the NAS
 * restarts or the DSM session times out; signing in itself goes to the fake
 * DSM directly and is never refused.
 */
let forgotten = false;
let refused = 0;
setDsmFetch((async (url: string | URL | Request, init?: RequestInit) => {
  if (!forgotten) return fetch(url, init);
  refused++;
  return Response.json({ success: false, error: { code: 119 } });
}) as typeof globalThis.fetch);

type Server = Awaited<ReturnType<typeof start>>;
let server: Server;
let base = '';

const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try { return await run(); } finally { Object.assign(console, { log, warn }); }
};
const boot = async (): Promise<void> => {
  server = await quietly(() => start({ households }));
  base = `http://127.0.0.1:${server.port}`;
};

async function signIn(username: string, password: string): Promise<string> {
  const was = forgotten;
  forgotten = false;
  try {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  } finally { forgotten = was; }
}

async function call(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie') };
}
const check = async (cookie: string) => (await call(cookie, 'GET', '/api/auth/check')).json;
/** This week, as the Calendar screen asks for it. */
const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const WEEK = `/api/calendar?start=${day(0)}&end=${day(7)}`;

before(async () => {
  const home = await households.create('alice', 'Home', { id: 'home' });
  await chooseFolderIn(home.store);
  homePath = home.store.path;
  await boot();
});

after(async () => { setDsmFetch(null); await server.close(); await nas.close(); });

describe('a restart signs everyone out', () => {
  test('after a restart the old cookie is nobody: check says signed out and the gate says please sign in', async () => {
    const alice = await signIn('alice', 'correct-horse');
    assert.equal((await check(alice)).authenticated, true);
    await server.close();
    await boot();
    assert.deepEqual(await check(alice), { authenticated: false });
    const r = await call(alice, 'GET', '/api/households');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'please sign in');
  });

  test('nothing about a session is written to the data folder', async () => {
    await signIn('alice', 'correct-horse');
    await assert.rejects(access(sessionsFile), { code: 'ENOENT' });
  });

  test('a sessions.json left from 0.10.2 is ignored: the session it names is nobody after a restart', async () => {
    const alice = await signIn('alice', 'correct-horse');
    const token = alice.slice(`${COOKIE}=`.length);
    const hash = createHash('sha256').update(token).digest('hex');
    await writeFile(sessionsFile, JSON.stringify({
      sessions: [{ hash, who: 'alice', expiresAt: Date.now() + 86_400_000, household: 'home' }],
    }) + '\n');
    await server.close();
    await boot();
    assert.deepEqual(await check(alice), { authenticated: false });
    // And signing in again is the way back.
    assert.equal((await check(await signIn('alice', 'correct-horse'))).authenticated, true);
  });
});

describe('the local sandbox has no DSM sign-in, and is still a session', () => {
  test('bob signs in without DSM and the app is open to him', async () => {
    const bob = await signIn('bob', 'anything');
    const seen = await check(bob);
    assert.equal(seen.authenticated, true);
    assert.equal(seen.local, true);
    assert.equal((await call(bob, 'GET', '/api/whoami')).status, 200);
    // The calendar is the NAS's, so the sandbox is still told so in place, not signed out.
    const week = await call(bob, 'GET', WEEK);
    assert.equal(week.status, 200);
    assert.equal(week.json.unavailable, 'sign in again to see your calendars');
    assert.equal((await check(bob)).authenticated, true);
  });
});

describe('a lost DSM sign-in ends the session', () => {
  /** A request made while the NAS has forgotten alice's sid: what it answers, and whether her session is left. */
  const whenForgotten = async (method: string, path: string, body?: unknown) => {
    const alice = await signIn('alice', 'correct-horse');
    forgotten = true;
    try {
      const r = await call(alice, method, path, body);
      return { ...r, after: await check(alice) };
    } finally { forgotten = false; }
  };
  const signedOut = (r: Awaited<ReturnType<typeof whenForgotten>>, what: string) => {
    assert.equal(r.status, 401, `${what}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error, 'please sign in', what);
    assert.match(r.cookie ?? '', new RegExp(`^${COOKIE}=;.*Max-Age=0`), `${what}: the cookie is cleared`);
    assert.deepEqual(r.after, { authenticated: false }, `${what}: the session is gone`);
  };

  test('Calendar, which read the week softly before, now signs her out', async () => {
    signedOut(await whenForgotten('GET', WEEK), 'GET /api/calendar');
  });
  test("Today's rail and documents line sign her out", async () => {
    signedOut(await whenForgotten('GET', '/api/today'), 'GET /api/today');
  });
  test('a route that already passed the loss on (contacts) answers 401, not 409', async () => {
    signedOut(await whenForgotten('GET', '/api/contacts?q=sand'), 'GET /api/contacts');
  });
  test("the New event form's clash check, which turned the loss into a 502, signs her out", async () => {
    const tomorrow = day(1);
    signedOut(await whenForgotten('POST', '/api/calendar/conflicts',
      { start: `${tomorrow}T10:00`, end: `${tomorrow}T11:00`, allDay: false, on: 'household' }), 'POST /api/calendar/conflicts');
  });
  test("This NAS, which read a lost session as Drive not answering, signs the administrator out", async () => {
    signedOut(await whenForgotten('GET', '/api/connectors'), 'GET /api/connectors');
  });
  test("an approval's effect hands the loss on as itself, not as a 409 in words", async () => {
    const tool = { name: 'x', kind: 'write', effect: async () => { throw new SessionLost('SYNO.Cal.Event', 119); } } as any;
    await assert.rejects(runEffect(tool, {}, {} as any), (e: unknown) => e instanceof SessionLost);
  });
  test('the guest page is not a member route: its 401s are its own and a member cookie there is left alone', async () => {
    const alice = await signIn('alice', 'correct-horse');
    forgotten = true;
    try {
      await call(alice, 'GET', '/book/home');
    } finally { forgotten = false; }
    assert.equal((await check(alice)).authenticated, true);
  });
});

describe('background work that meets a lost sign-in leaves the session alone', () => {
  test("a plan's page written after the answer is sent is refused softly; the briefing and the drift look too", async () => {
    const alice = await signIn('alice', 'correct-horse');
    forgotten = true;
    try {
      refused = 0;
      // Nothing in the request itself reaches the NAS; the page follows once the answer is sent.
      const made = await call(alice, 'POST', '/api/plans', { title: 'Fix the gate', area: 'House' });
      assert.equal(made.status, 200, JSON.stringify(made.json));
      await quietly(async () => { await new Promise((r) => setTimeout(r, 20)); await pagesIdle(homePath); });
      assert.ok(refused > 0, 'the page lane did reach the NAS and was refused');
      assert.equal((await check(alice)).authenticated, true, 'the page lane did not end the session');
      // Today's thread writes the briefing and looks for drift: both keep their soft handling.
      const thread = await quietly(() => call(alice, 'GET', '/api/thread'));
      assert.equal(thread.status, 200, JSON.stringify(thread.json));
      assert.equal((await check(alice)).authenticated, true, 'the briefing and the drift look did not end it either');
    } finally { forgotten = false; }
  });
});
