// api/test/server-old-logs.test.ts
//
// Logs written before 0.10.0 on an upgraded NAS: the old install's single log is still on the volume when every
// household has been removed, and a household's folder may still hold an old log. The server starts all the same,
// and an old household is answered in one plain sentence. Sets process.env at module scope, as the other server
// suites do, so it depends on node --test running each file in its own process.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

const dir = await mkdtemp(join(tmpdir(), 'pb-server-old-logs-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alex: { password: 'correct-horse' } },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DSM_URL: `http://127.0.0.1:${nas.port}`, DEV_USER: 'sandbox',
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'events.jsonl'),
});
for (const v of ['ADMIN_USER', 'ALLOWED_USERS', 'BOOK_URL', 'BOOK_HOUSEHOLD', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
  'SMTP_FROM', 'SMTP_PLAIN_AUTH', 'DSM_PUBLIC_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'PROFILE_CERT_DIR',
  'COOKIE_INSECURE', 'TRUST_PROXY']) delete process.env[v];

/** A log as 0.9.x wrote it: claimed by alex, with a budget in it. */
const oldLog = (label: string) => [
  { id: 'x0', at: '2026-10-01T00:00:00Z', who: 'alex', op: 'household.claim', label },
  { id: 'x1', at: '2026-10-01T00:00:01Z', who: 'alex', op: 'budget.create', budget: 'home', label: 'Home' },
].map((e) => JSON.stringify(e)).join('\n') + '\n';

// The old install's single log is there and no household is.
await writeFile(join(dir, 'events.jsonl'), oldLog('Rivera'));

const { start } = await import('../src/server.ts');
const { SAVED_BEFORE_010 } = await import('../src/households.ts');

let base = '';
let close: () => Promise<void> = async () => {};
let alex = '';

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie: alex },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}

before(async () => {
  const server = await start({ send: async () => {} });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alex', password: 'correct-horse' }),
  });
  assert.equal(res.status, 200);
  alex = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
});

after(async () => { await close(); await nas.close(); await rm(dir, { recursive: true, force: true }); });

describe('logs written before 0.10.0', () => {
  test('an old single log on the volume, with no household, is not adopted and the server starts', async () => {
    assert.ok(base, 'the server is listening');
    assert.deepEqual((await call('GET', '/api/households')).json.households, []);
  });

  test('a household saved before 0.10.0 is answered in one plain sentence, never a 500', async () => {
    await mkdir(join(dir, 'households', 'the-house'), { recursive: true });
    await writeFile(join(dir, 'households', 'the-house', 'events.jsonl'), oldLog('The house'));
    const listed = (await call('GET', '/api/households')).json.households as { id: string }[];
    assert.deepEqual(listed.map((h) => h.id), ['the-house'], 'it is still listed, so it can be chosen');
    assert.equal((await call('POST', '/api/households/select', { household: 'the-house' })).status, 200);
    const who = await call('GET', '/api/whoami');
    assert.deepEqual([who.status, who.json?.error], [409, SAVED_BEFORE_010]);
    assert.match(SAVED_BEFORE_010, /before Home Planner 0\.10\.0/);
  });
});
