// api/test/server-carry.test.ts
//
// A deployment that already has files under PLANNER_ROOT keeps working the
// morning this version boots: the folder is carried over once, at boot, for
// every household whose log names a file the app wrote under it. The fake
// NAS has one Team Folder, Planner, so PLANNER_ROOT=/Shared is a plain shared
// folder. This file sets process.env at module scope (read once when src/
// loads), so it depends on node --test running each test file in its own process.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

const dir = await mkdtemp(join(tmpdir(), 'pb-server-carry-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alice: { password: 'correct-horse' }, carol: { password: 'c' } },
});
await mkdir(join(nas.root, 'Shared/h-files/gate'), { recursive: true });
await writeFile(join(nas.root, 'Shared/h-files/gate/quote.pdf'), 'the quote');
Object.assign(process.env, {
  PORT: '0', PLANNER_ROOT: '/Shared', ADMIN_USER: 'carol', DSM_URL: `http://127.0.0.1:${nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
delete process.env['DEV_USER'];
delete process.env['TZ'];
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];

const { start } = await import('../src/server.ts');
const { Households } = await import('../src/households.ts');
const { carriedFolder, folderOf, namesAFile } = await import('../src/folders.ts');

const households = new Households(process.env['HOUSEHOLDS_DIR']!);

/** A page the app wrote into a household's folder, as the log remembers it. */
const page = (folder: string, name: string) =>
  ({ link: `l-${name}`, file_id: '1', hash: 'h', version_id: '1', path: `/team-folders/Shared/${folder}/today/${name}.md` });

/** A household claimed by alice, then the given events. */
async function seed(id: string, events: object[]): Promise<void> {
  const { store } = await households.create('alice', id, { id });
  for (const e of events) await store.append('alice', e as never);
}

const briefingWith = (doc: object) =>
  ({ op: 'thread.briefing', day: '2026-10-30', source: 'household', budget: null, headline: 'Quiet', writtenBy: 'fallback', doc });
const attachment = (folder: string) =>
  [{ op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
    { op: 'plan.attach', plan: 'gate', path: `/Shared/${folder}/gate/quote.pdf`, name: 'quote.pdf', size: 9 }];

await seed('h-doc', [briefingWith(page('h-doc', '2026-10-30-household'))]);
await seed('h-files', attachment('h-files'));
await seed('h-none', []);
await seed('h-chosen', [{ op: 'documents.folder', team: 'Planner', folder: 'chosen', source: 'owner' }]);
// A household restored as a copy keeps the original's pointers: they are not its own evidence.
await seed('h-copy', [briefingWith(page('h-doc', '2026-10-29-household')), ...attachment('h-doc')]);
// Two logs that would both be carried over to Shared/h-taken; one is chosen there already, by its owner.
await seed('h-holder', [{ op: 'documents.folder', team: 'Shared', folder: 'h-taken', source: 'owner' }]);
await seed('h-taken', [briefingWith(page('h-taken', '2026-10-30-household'))]);
// A household whose log cannot be read (here a directory where the file should be): passed over, not the end of boot.
await mkdir(join(process.env['HOUSEHOLDS_DIR']!, 'a-broken', 'events.jsonl'), { recursive: true });

const logged: string[] = [];
let server: Awaited<ReturnType<typeof start>>;
let base = '';

async function boot(): Promise<void> {
  const [log, warn] = [console.log, console.warn];
  console.log = console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    server = await start({ households });
  } finally {
    console.log = log; console.warn = warn;
  }
  base = `http://127.0.0.1:${server.port}`;
}

async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}

async function signIn(username: string, password: string): Promise<string> {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `${username} signs in`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

const folderEvents = async (id: string) => (await (await households.open(id)).since(null)).filter((e) => e.op === 'documents.folder');

let alice = '';
let carol = '';

before(async () => {
  await boot();
  alice = await signIn('alice', 'correct-horse');
  carol = await signIn('carol', 'c');
});

after(async () => { await server.close(); await nas.close(); });

describe('carried over at boot', () => {
  test('a log that names a file gets the deployment folder, by system; one that names none chooses from scratch', async () => {
    const doc = (await households.open('h-doc')).state.documents.folder!;
    assert.deepEqual([doc.team, doc.folder, doc.source, doc.by], ['Shared', 'h-doc', 'deployment', 'system']);
    const files = (await households.open('h-files')).state.documents.folder!;
    assert.deepEqual([files.team, files.folder, files.source, files.by], ['Shared', 'h-files', 'deployment', 'system']);
    assert.equal((await households.open('h-none')).state.documents.folder, null);
    const chosen = (await households.open('h-chosen')).state.documents.folder!;
    assert.deepEqual([chosen.team, chosen.folder, chosen.source], ['Planner', 'chosen', 'owner']);
    assert.equal((await folderEvents('h-chosen')).length, 1, 'a household that chose is left alone');
  });

  test("pointers under another household's folder are not evidence: a copy chooses from scratch", async () => {
    const copy = await households.open('h-copy');
    assert.equal(copy.state.documents.folder, null);
    assert.equal(folderOf('h-copy'), null);
    assert.equal(namesAFile(await copy.since(null), carriedFolder('/Shared', 'h-copy')), false);
    assert.equal(namesAFile(await copy.since(null), carriedFolder('/Shared', 'h-doc')), true, "they are the original household's");
  });

  test('a folder another household holds is not carried over, and one warning says so', async () => {
    assert.equal((await households.open('h-taken')).state.documents.folder, null);
    assert.equal((await folderEvents('h-taken')).length, 0);
    assert.deepEqual(folderOf('h-holder'), { team: 'Shared', folder: 'h-taken' });
    const warned = logged.filter((l) => /h-taken: .*taken/.test(l));
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, /the owner chooses in Settings/);
  });

  test('a household that cannot be opened is passed over with a warning, and the rest are carried', () => {
    assert.ok(logged.some((l) => /a-broken: .*could not be opened/.test(l)), logged.join('\n'));
    assert.deepEqual(folderOf('h-doc'), carriedFolder('/Shared', 'h-doc'));
  });

  test('the registry knows every household folder, carried or chosen', () => {
    assert.deepEqual(folderOf('h-doc'), { team: 'Shared', folder: 'h-doc' });
    assert.deepEqual(folderOf('h-chosen'), { team: 'Planner', folder: 'chosen' });
    assert.equal(folderOf('h-none'), null);
  });

  test('a plain shared folder: files on cards keep working, documents stay inline, and Settings says why', async () => {
    assert.equal((await call(alice, 'POST', '/api/households/select', { household: 'h-files' })).status, 200);
    const file = await fetch(`${base}/api/plans/gate/files/quote.pdf`, { headers: { cookie: alice } });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'the quote');
    const s = await call(alice, 'GET', '/api/settings');
    assert.match(s.json.documents.why, /Shared is not a Team Folder/);
    assert.equal(s.json.attachments.on, true);
    assert.equal((await call(alice, 'GET', '/api/today')).status, 200);
    assert.equal((await call(alice, 'GET', '/api/thread')).status, 200);
    const briefings = (await (await households.open('h-files')).since(null)).filter((e) => e.op === 'thread.briefing');
    assert.ok(briefings.length > 0, "today's briefing was written");
    for (const b of briefings) assert.ok(b.op === 'thread.briefing' && b.body !== undefined && b.doc === undefined, 'in the log, not in Drive');
  });

  test('the boot log names each folder and where the Claude key comes from, never a key', () => {
    assert.ok(logged.some((l) => /h-doc: folder Shared\/h-doc \(from the deployment\)/.test(l)), logged.join('\n'));
    assert.ok(logged.some((l) => /h-none: none chosen; zone UTC \(default\)/.test(l)));
    assert.ok(logged.some((l) => /h-chosen: folder Planner\/chosen \(chosen\)/.test(l)));
    assert.ok(logged.some((l) => /Claude: off/.test(l)));
    assert.equal(logged.filter((l) => /^\[budget\] {3}h-doc:/.test(l)).length, 1, 'one line per household');
  });

  test("an admin sees each household's folder, and nothing in it", async () => {
    const r = await call(carol, 'GET', '/api/admin/households');
    assert.equal(r.status, 200);
    const folders = Object.fromEntries(r.json.households.map((h: any) => [h.id, h.folder]));
    assert.equal(folders['h-doc'], 'Shared/h-doc');
    assert.equal(folders['h-chosen'], 'Planner/chosen');
    assert.equal(folders['h-none'], null);
    assert.equal(folders['h-holder'], 'Shared/h-taken');
    assert.deepEqual(Object.keys(r.json.households[0]).sort(),
      ['folder', 'id', 'label', 'lastActivity', 'memberCount', 'owner', 'size', 'yours']);
    assert.equal((await call(alice, 'GET', '/api/admin/households')).status, 403);
  });

  test('running every boot is running once', async () => {
    await server.close();
    await boot();
    for (const id of ['h-doc', 'h-files']) assert.equal((await folderEvents(id)).length, 1, id);
    assert.equal((await folderEvents('h-taken')).length, 0);
  });
});
