// api/test/server-setup.test.ts
//
// Setup in Settings and the Drive picker's routes, against the fake DSM. This
// file sets process.env at module scope (read once when src/ loads), so it
// depends on node --test running each test file in its own process.
import './planner-root.ts';
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

const dir = await mkdtemp(join(tmpdir(), 'pb-server-setup-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alice: { password: 'correct-horse' }, bob: { password: 'battery-staple' }, carol: { password: 'c' } },
});
Object.assign(process.env, {
  PORT: '0', DEV_USER: 'tester', ADMIN_USER: 'alice', DSM_URL: `http://127.0.0.1:${nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
delete process.env['TZ'];
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];
delete process.env['CLAUDE_MATCH_MODEL'];

const { start } = await import('../src/server.ts');
const { TAKEN } = await import('../src/folders.ts');
const { Households } = await import('../src/households.ts');
const { MOVE_WAIT_MS } = await import('../src/moves.ts');
const { pagesIdle } = await import('../src/pages.ts');
const { setDsmFetch } = await import('../src/synology.ts');
type DsmFetch = import('../src/synology.ts').DsmFetch;

/** The server's own households, so a restart reads the same stores. */
const households = new Households(process.env['HOUSEHOLDS_DIR']!);

let base = '';
let server: { port: number; close: () => Promise<void> } | null = null;

async function call(cookie: string, method: string, path: string, body?: unknown):
  Promise<{ status: number; json: any }> {
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

let tester = '';
let alice = '';
let bob = '';
let carol = '';

before(async () => {
  server = await start({ households });
  base = `http://127.0.0.1:${server.port}`;
  tester = await signIn('tester', 'anything');
  alice = await signIn('alice', 'correct-horse');
  carol = await signIn('carol', 'c');
  assert.equal((await call(alice, 'POST', '/api/households', { label: 'Home' })).status, 200);
  assert.equal((await call(alice, 'POST', '/api/members', { member: 'bob', why: 'my partner' })).status, 200);
  bob = await signIn('bob', 'battery-staple');
  assert.equal((await call(carol, 'POST', '/api/households', { label: 'Carols' })).status, 200);
});

after(async () => { await server?.close(); await nas.close(); });

describe('Setup on Today', () => {
  test("Today's setup is computed per load and written nowhere", async () => {
    const store = await households.open('home');
    const before = (await store.since(null)).length;
    const t = await call(alice, 'GET', '/api/today');
    assert.ok(Array.isArray(t.json.setup));
    assert.equal((await store.since(null)).length, before);
  });

  test("the owner who is an admin sees the household's card, then the NAS's; a member the ask; the sandbox none", async () => {
    const mine = (await call(alice, 'GET', '/api/today')).json.setup;
    assert.deepEqual(mine.map((n: any) => n.kind), ['folder', 'connectors']);
    assert.deepEqual(mine[0].action, { label: 'Choose a folder', open: 'settings', step: 'folder' });
    // Nothing is saved on Connectors here and the deployment sets none of these.
    assert.equal(mine[1].text, 'Set up the NAS: Claude, Calendar on phones, Mail and Pricing sources.');
    assert.deepEqual(mine[1].action, { label: 'Open Connectors', open: 'connectors', row: 'claude' });
    assert.deepEqual((await call(bob, 'GET', '/api/today')).json.setup,
      [{ kind: 'folder', text: 'Documents are not in Drive yet. Ask alice to choose a folder.' }]);
    assert.deepEqual((await call(tester, 'GET', '/api/today')).json.setup, []);
  });
});

describe('Setup in Settings', () => {
  test('a new household starts at the folder, and a member reads who can change it', async () => {
    const s = await call(alice, 'GET', '/api/settings');
    assert.deepEqual(s.json.setup.steps.map((x: any) => [x.id, x.done]),
      [['folder', false], ['zone', false], ['calendar', false], ['booking', true], ['model', true]]);
    assert.equal(s.json.setup.first, 'folder');
    assert.equal(s.json.setup.owner, 'alice');
    assert.equal(s.json.setup.youOwn, true);
    assert.equal(s.json.setup.why, null);
    assert.deepEqual(s.json.setup.zone, { zone: 'UTC', source: 'default' });
    assert.deepEqual(s.json.setup.documents, { folder: null, source: null, left: 0, indexed: null, moving: null });
    assert.match(s.json.documents.why, /until alice chooses where documents live/);
    const member =(await call(bob, 'GET', '/api/settings')).json.setup;
    assert.equal(member.why, 'Only alice can change these.');
    assert.equal(member.youOwn, false);
  });

  test("the picker's three steps, with the owner's own session", async () => {
    const teams = await call(alice, 'GET', '/api/drive/team-folders');
    assert.deepEqual(teams.json.teams[0], { name: 'Planner', canWrite: true, fromDeployment: true });
    const inside = await call(alice, 'GET', '/api/drive/folders?team=Planner');
    assert.equal(inside.json.suggested, 'home');
    assert.deepEqual(inside.json.folders, []);
    const checks = await call(alice, 'POST', '/api/drive/folder-check', { team: 'Planner', folder: 'home' });
    assert.deepEqual(checks.json.problems, []);
    assert.equal(existsSync(join(nas.root, 'Planner/home')), false, 'checking makes nothing');
    assert.equal((await call(bob, 'GET', '/api/drive/team-folders')).status, 200, 'a member may look');
  });

  test('a folders list is asked for a Team Folder by name', async () => {
    assert.equal((await call(alice, 'GET', '/api/drive/folders')).status, 400);
    assert.equal((await call(alice, 'GET', '/api/drive/folders?team=')).status, 400);
  });

  test('a member who posts nothing usable is told it is not theirs to change, before the body is read', async () => {
    for (const body of [{}, { team: 5, folder: [] }, { folder: '../etc' }]) {
      const r = await call(bob, 'POST', '/api/settings/documents', body);
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.equal(r.json.error, 'only alice can change this');
    }
    const raw = await fetch(base + '/api/settings/documents', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: bob }, body: '{not json',
    });
    assert.equal(raw.status, 403);
    for (const path of ['/api/calendars/household', '/api/calendars/target']) {
      const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: bob }, body: '{not json' });
      assert.equal(r.status, 403, path);
      assert.equal(((await r.json()) as { error: string }).error, "only alice can choose the household's calendar");
    }
  });

  test('a member may look, not choose', async () => {
    const r = await call(bob, 'POST', '/api/settings/documents', { team: 'Planner', folder: 'x' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'only alice can change this');
    assert.equal(existsSync(join(nas.root, 'Planner/x')), false);
  });

  test('"Use this folder" makes it, logs it, and Settings shows it chosen', async () => {
    const r = await call(alice, 'POST', '/api/settings/documents', { team: 'Planner', folder: 'home' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.setup.documents,
      { folder: { team: 'Planner', folder: 'home' }, source: 'saved', left: 0, indexed: null, moving: null });
    assert.equal(r.json.setup.first, 'zone');
    assert.equal(existsSync(join(nas.root, 'Planner/home')), true);
    const again = (await call(bob, 'GET', '/api/settings')).json.setup;
    assert.deepEqual(again.documents.folder, { team: 'Planner', folder: 'home' });
    assert.equal(again.steps[0].done, true);
    assert.equal(again.steps[0].source, 'saved');
  });

  test('the index is asked again on each GET until it says it is read', async () => {
    assert.equal((await call(alice, 'GET', '/api/settings')).json.setup.documents.indexed, null, 'nothing there to find yet');
    await mkdir(join(nas.root, 'Planner/home'), { recursive: true });
    await writeFile(join(nas.root, 'Planner/home/page.md'), '---\nplanner: 1\n---\n# A page\n');
    assert.equal((await call(alice, 'GET', '/api/settings')).json.setup.documents.indexed, true);
    assert.equal((await call(bob, 'GET', '/api/settings')).json.setup.documents.indexed, true, 'kept for the household');
  });

  test('the zone and the calendar finish their steps; the zone says whose choice it is', async () => {
    const zone = await call(alice, 'POST', '/api/settings/zone', { zone: 'America/Denver' });
    assert.deepEqual(zone.json.setup.zone, { zone: 'America/Denver', source: 'saved' });
    assert.equal(zone.json.setup.first, 'calendar');
    const made = await call(alice, 'POST', '/api/calendars/household', {});
    assert.equal(made.status, 200);
    assert.equal(made.json.setup.first, null);
    assert.ok(made.json.setup.steps.every((x: any) => x.done));
  });

  test("another household's folder is refused in words that do not name it", async () => {
    const mine = await call(carol, 'POST', '/api/settings/documents', { team: 'Planner', folder: 'carols' });
    assert.equal(mine.status, 200);
    const nested = await call(alice, 'POST', '/api/settings/documents', { team: 'Planner', folder: 'carols/sub' });
    assert.equal(nested.status, 409);
    assert.equal(nested.json.error, TAKEN);
    assert.doesNotMatch(nested.json.error, /carol/i);
    const check = await call(alice, 'POST', '/api/drive/folder-check', { team: 'Planner', folder: 'carols' });
    assert.deepEqual(check.json.problems, [TAKEN]);
  });

  test('a typed folder that cannot be one is a 400 before the NAS is asked', async () => {
    for (const folder of ['../etc', 'a%b', 'a,b', ' / ']) {
      const r = await call(alice, 'POST', '/api/drive/folder-check', { team: 'Planner', folder });
      assert.equal(r.status, 400, folder);
      assert.equal((await call(alice, 'POST', '/api/settings/documents', { team: 'Planner', folder })).status, 400, folder);
    }
    assert.equal(existsSync(join(nas.root, 'etc')), false);
  });

  test('without a NAS session the picker says sign in again', async () => {
    for (const [method, path, body] of [
      ['GET', '/api/drive/team-folders'], ['GET', '/api/drive/folders?team=Planner'],
      ['POST', '/api/drive/folder-check', { team: 'Planner', folder: 'x' }],
      ['POST', '/api/settings/documents', { team: 'Planner', folder: 'x' }],
    ] as const) {
      const r = await call(tester, method, path, body);
      assert.equal(r.status, 409, `${method} ${path}`);
      assert.equal(r.json.error, 'sign in again to use this');
    }
  });
});

describe("the household's calendar is the owner's", () => {
  test('a member neither makes, replaces nor chooses it', async () => {
    const replace = await call(bob, 'POST', '/api/calendars/household', { replace: true });
    assert.equal(replace.status, 403);
    assert.equal(replace.json.error, "only alice can choose the household's calendar");
    assert.equal((await call(bob, 'POST', '/api/calendars/household', {})).status, 403);
    const mine = (await call(bob, 'GET', '/api/calendars')).json.calendars as any[];
    const personal = mine.find((c) => c.isDefault)!;
    const target = await call(bob, 'POST', '/api/calendars/target',
      { cal_id: personal.cal_id, original_cal_id: personal.original_cal_id });
    assert.equal(target.status, 403);
    assert.equal(target.json.error, "only alice can choose the household's calendar");
  });

  test('a member still keeps their own conflict calendars', async () => {
    const mine = (await call(bob, 'GET', '/api/calendars')).json.calendars as any[];
    const personal = mine.find((c) => c.isDefault)!;
    const r = await call(bob, 'POST', '/api/calendars/conflicts',
      { calendars: [{ cal_id: personal.cal_id, original_cal_id: personal.original_cal_id }] });
    assert.equal(r.status, 200);
  });
});

describe('changing the folder', () => {
  let storePath = '';
  let plan = '';

  test('moves after the answer, shows progress, and refuses another change until done', async () => {
    storePath = (await households.open('home')).path;
    // A plan whose page is in Drive, with a file on its card and one taken off it.
    const made = await call(alice, 'POST', '/api/plans', { title: 'Fix the gate', area: 'House' });
    assert.equal(made.status, 200);
    plan = made.json.plan.id;
    for (const name of ['quote.pdf', 'old.pdf']) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(5)]), name);
      const up = await fetch(`${base}/api/plans/${plan}/attach`, { method: 'POST', headers: { cookie: alice }, body: form });
      assert.equal(up.status, 200, name);
    }
    assert.equal((await call(alice, 'DELETE', `/api/plans/${plan}/files/old.pdf`, { why: 'the wrong quote' })).status, 200);
    await pagesIdle(storePath);
    assert.ok(existsSync(join(nas.root, 'Planner/home', plan, 'plan.md')), "the plan's page is in Drive");

    // Longer than every pass before the restart: nothing Drive moves is seen until then.
    nas.moves.delayMs = MOVE_WAIT_MS * 10;
    const r = await call(alice, 'POST', '/api/settings/documents', { team: 'Planner', folder: 'elsewhere' });
    assert.equal(r.status, 200);
    assert.ok(r.json.setup.documents.moving.left > 0);
    assert.deepEqual(r.json.setup.documents.moving, { left: 2, to: 'Planner/elsewhere', failed: [], behind: 1 });

    const asked: string[] = [];
    setDsmFetch(((input: string | URL | Request, init?: RequestInit) => {
      asked.push(`${String(input)} ${typeof init?.body === 'string' ? init.body : ''}`);
      return fetch(input, init);
    }) as DsmFetch);
    try {
      const again = await call(alice, 'POST', '/api/settings/documents', { team: 'Planner', folder: 'third' });
      assert.equal(again.status, 409);
      assert.match(again.json.error, /^Wait until the \d+ documents have moved\.$/);
      assert.equal(again.json.error, 'Wait until the 2 documents have moved.');
    } finally {
      setDsmFetch(null);
    }
    // Only the move under way asks anything: the picker's checks and the folder refused are not asked about.
    assert.deepEqual(asked.filter((x) => /\/v2\/team-folder|third/.test(x)), []);
    assert.equal(existsSync(join(nas.root, 'Planner/third')), false);

    await pagesIdle(storePath);
    const moving = (await call(alice, 'GET', '/api/settings')).json.setup.documents.moving;
    assert.deepEqual([moving.left, moving.behind], [1, 1], "the card's file moved; the page waits on Drive");
    assert.ok(existsSync(join(nas.root, 'Planner/elsewhere', plan, 'quote.pdf')));
    assert.ok(existsSync(join(nas.root, 'Planner/home', plan, 'old.pdf')), 'the file taken off the card stays behind');
    const file = await fetch(`${base}/api/plans/${plan}/files/quote.pdf`, { headers: { cookie: alice } });
    assert.equal(file.status, 200, 'the card reads its file where it is now');
    // The folder being left is still this household's.
    assert.deepEqual((await call(carol, 'POST', '/api/drive/folder-check', { team: 'Planner', folder: 'home' })).json.problems, [TAKEN]);
  });

  test('a restart mid-move resumes on the first request with a NAS session', async () => {
    const said = mock.method(console, 'log', () => {});
    const warned = mock.method(console, 'warn', () => {});
    try {
      await server!.close();
      server = await start({ households });
    } finally {
      said.mock.restore();
      warned.mock.restore();
    }
    base = `http://127.0.0.1:${server.port}`;
    assert.ok(said.mock.calls.some((c) => / 1 files left to move$/.test(String(c.arguments[0]))), 'boot says what is left');
    // Filled at boot: the folder being left is still taken.
    const carolAgain = await signIn('carol', 'c');
    assert.deepEqual((await call(carolAgain, 'POST', '/api/drive/folder-check', { team: 'Planner', folder: 'home' })).json.problems, [TAKEN]);
    nas.moves.delayMs = 0;
    const bobAgain = await signIn('bob', 'battery-staple');
    // Not Today, which brought the pages up to date before this: Settings writes nothing of its own.
    assert.equal((await call(bobAgain, 'GET', '/api/settings')).status, 200);
    await pagesIdle(storePath);
    assert.equal((await call(alice, 'GET', '/api/settings')).json.setup.documents.moving, null);
    assert.ok(existsSync(join(nas.root, 'Planner/elsewhere', plan, 'plan.md')));
    assert.deepEqual((await call(carolAgain, 'POST', '/api/drive/folder-check', { team: 'Planner', folder: 'home' })).json.problems, [], 'let go');
  });
});

describe('a restore in place', () => {
  test("a backup's folder is not taken: the registry, the folder and the moves stay as they are, and the summary says so", async () => {
    const { Store } = await import('../src/store.ts');
    // alice's own backup from elsewhere, holding a folder no check here ever saw.
    const other = new Store({ path: join(await mkdtemp(join(tmpdir(), 'pb-restore-in-place-')), 'events.jsonl') });
    await other.load();
    await other.append('alice', [{ op: 'household.claim', label: 'Home' },
      { op: 'household.zone', zone: 'Europe/London' },
      { op: 'documents.folder', team: 'Planner', folder: 'restored', source: 'owner' }]);
    const content = await readFile(other.path, 'utf8');

    const before = (await call(alice, 'GET', '/api/settings')).json.setup.documents;
    assert.deepEqual([before.folder, before.moving], [{ team: 'Planner', folder: 'elsewhere' }, null]);
    const r = await call(alice, 'POST', '/api/restore', { content, scopes: ['settings'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.restored, 1, 'the zone only');
    assert.ok(r.json.summary.includes('This household keeps its own folder for documents: no two households share a folder.'));

    const after = (await call(alice, 'GET', '/api/settings')).json.setup;
    assert.equal(after.zone.zone, 'Europe/London');
    assert.deepEqual([after.documents.folder, after.documents.moving], [{ team: 'Planner', folder: 'elsewhere' }, null]);
    const kept = (await households.open('home')).state.documents.folder!;
    assert.deepEqual([kept.team, kept.folder], ['Planner', 'elsewhere']);
    // The registry still holds home's own folder, and nothing of the backup's (carol's session, with the NAS, since the restart).
    const carolNow = await signIn('carol', 'c');
    assert.deepEqual((await call(carolNow, 'POST', '/api/drive/folder-check', { team: 'Planner', folder: 'elsewhere' })).json.problems, [TAKEN]);
    assert.deepEqual((await call(carolNow, 'POST', '/api/drive/folder-check', { team: 'Planner', folder: 'restored' })).json.problems, []);
  });
});
