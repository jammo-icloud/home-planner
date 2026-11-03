// api/test/server-settings.test.ts
//
// This file sets process.env at module scope (DSM_URL, HOUSEHOLDS_DIR and the
// rest, read once when src/ loads), so the suite depends on node --test
// running each test file in its own process. Run in one shared process, the
// files that do this would see each other's settings.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';
import { fakeDsm } from './fake-dsm-fetch.ts';

// A real (fake) DSM on a free port, and the app pointed at it. DSM_URL is read
// when auth.ts loads, so it is set here and everything from src/ is imported
// after. Signing in goes through the fake; the sign-out tests swap in a
// recording fetch with setDsmFetch.
const dir = await mkdtemp(join(tmpdir(), 'pb-server-settings-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: {
    alice: { password: 'correct-horse' }, bob: { password: 'battery-staple' }, carol: { password: 'c' },
    dave: { password: 'd' }, erin: { password: 'e' }, frank: { password: 'f' }, hal: { password: 'h' },
  },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DEV_USER: 'tester', ADMIN_USER: 'alice', DSM_URL: `http://127.0.0.1:${nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
  // Everything booking needs, naming a household this server does not have.
  BOOK_URL: 'https://book.example.com', BOOK_HOUSEHOLD: 'elsewhere',
  SMTP_HOST: 'mail.example.com', SMTP_PORT: '587', SMTP_USER: 'robot', SMTP_PASS: 'pw', SMTP_FROM: 'house@example.com',
});
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];
// No attachment root: the deployment has not chosen a shared folder.
delete process.env['PLANNER_ROOT'];

const { start } = await import('../src/server.ts');
const { setDsmFetch, shareCalendar } = await import('../src/synology.ts');
const { saveConnector } = await import('../src/connectors.ts');
const { checkWithDsm } = await import('../src/auth.ts');
const { DEFAULT_AREAS, householdDay } = await import('../src/types.ts');

/** The form body of every DSM call the app makes while `run` runs; each is still answered by the fake. */
async function dsmCallsDuring(run: () => Promise<void>): Promise<string[]> {
  const bodies: string[] = [];
  setDsmFetch((async (url: string | URL | Request, init?: RequestInit) => {
    bodies.push(decodeURIComponent(String(init?.body ?? '')));
    return fetch(url, init);
  }) as typeof fetch);
  try {
    await run();
  } finally {
    setDsmFetch(null);
  }
  return bodies;
}
const sharingSets = (bodies: readonly string[]) =>
  bodies.filter((b) => /api=SYNO\.Cal\.Sharing&/.test(b) && /method=set/.test(b));

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

async function signIn(username: string, password: string, at = base): Promise<string> {
  const res = await fetch(at + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `${username} signs in`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.ok(cookie, `${username} has a cookie`);
  return cookie;
}

let tester = '';
let alice = '';

/** What the server warned about as it started. */
const warnings: string[] = [];

before(async () => {
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  let server: Awaited<ReturnType<typeof start>>;
  try { server = await start(); } finally { console.warn = warn; }
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  tester = await signIn('tester', 'anything');
  alice = await signIn('alice', 'correct-horse');
  const made = await call(alice, 'POST', '/api/households', { label: 'Home' });
  assert.equal(made.status, 200);
});

after(async () => { setDsmFetch(null); await close(); await nas.close(); });

describe('who is an admin, with ADMIN_USER set', () => {
  test('ADMIN_USER names the admin, whatever the group says', async () => {
    assert.equal((await call(alice, 'GET', '/api/auth/check')).json.admin, true);
    const bob = await signIn('bob', 'battery-staple');
    assert.equal((await call(bob, 'GET', '/api/auth/check')).json.admin, false);
  });
});

describe('settings on the sandbox, with no DSM behind it', () => {
  test('starts with the default areas and no appearance', async () => {
    const r = await call(tester, 'GET', '/api/settings');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.areas, DEFAULT_AREAS);
    assert.deepEqual(r.json.links, []);
    assert.equal(r.json.appearance, null);
    assert.deepEqual(r.json.calendar, { household: null, target: null, conflicts: [] });
    assert.deepEqual(r.json.members, ['tester']);
  });

  test('appearance is saved for the member who chose it', async () => {
    const r = await call(tester, 'POST', '/api/settings/appearance', { scheme: 'lapis', mode: 'dark' });
    assert.equal(r.status, 200);
    assert.deepEqual((await call(tester, 'GET', '/api/settings')).json.appearance, { scheme: 'lapis', mode: 'dark' });
  });

  test('a scheme or mode outside the choices is refused', async () => {
    assert.equal((await call(tester, 'POST', '/api/settings/appearance', { scheme: 'amber' })).status, 400);
    assert.equal((await call(tester, 'POST', '/api/settings/appearance', { scheme: 'lapis', mode: 'dim' })).status, 400);
    assert.deepEqual((await call(tester, 'GET', '/api/settings')).json.appearance, { scheme: 'lapis', mode: 'dark' });
  });

  test('areas are replaced whole, and never emptied', async () => {
    assert.equal((await call(tester, 'POST', '/api/settings/areas', [])).status, 400);
    assert.equal((await call(tester, 'POST', '/api/settings/areas', { areas: [] })).status, 400);
    assert.equal((await call(tester, 'POST', '/api/settings/areas', { areas: ['House', ' '] })).status, 400);
    const r = await call(tester, 'POST', '/api/settings/areas', { areas: ['House', 'Garden'] });
    assert.equal(r.status, 200);
    assert.deepEqual((await call(tester, 'GET', '/api/settings')).json.areas, ['House', 'Garden']);
  });

  test('an area is renamed with its plans, by name', async () => {
    const made = await call(tester, 'POST', '/api/plans', { title: 'Weed the beds', area: 'Garden' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const r = await call(tester, 'POST', '/api/settings/areas/rename', { from: 'Garden', to: ' Yard ' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.areas, ['House', 'Yard'], 'answers with the settings view');
    const board = await call(tester, 'GET', '/api/plans');
    const yard = board.json.rows.find((row: any) => row.area === 'Yard');
    assert.ok(yard.planning.some((c: any) => c.id === made.json.plan.id), 'the plan moved with its area');
  });

  test('a rename to a used name, from a missing one, or to nothing is a 400 that says why', async () => {
    const used = await call(tester, 'POST', '/api/settings/areas/rename', { from: 'Yard', to: 'house' });
    assert.equal(used.status, 400);
    assert.match(used.json.error, /already an area/);
    assert.doesNotMatch(used.json.error, /event/, 'said without the log\'s event id');
    assert.equal((await call(tester, 'POST', '/api/settings/areas/rename', { from: 'Moon', to: 'Mars' })).status, 400);
    assert.equal((await call(tester, 'POST', '/api/settings/areas/rename', { from: 'Yard', to: ' ' })).status, 400);
    assert.equal((await call(tester, 'POST', '/api/settings/areas/rename', { from: 'Yard' })).status, 400);
    assert.deepEqual((await call(tester, 'GET', '/api/settings')).json.areas, ['House', 'Yard']);
  });

  test('links are replaced whole, and only web addresses are links', async () => {
    const bad = await call(tester, 'POST', '/api/settings/links',
      { links: [{ label: 'Oops', url: 'javascript:alert(1)' }] });
    assert.equal(bad.status, 400);
    assert.equal((await call(tester, 'POST', '/api/settings/links', { links: [{ label: '', url: 'https://x.example' }] })).status, 400);
    const r = await call(tester, 'POST', '/api/settings/links', { links: [{ label: 'Bank', url: 'https://bank.example' }] });
    assert.equal(r.status, 200);
    assert.deepEqual((await call(tester, 'GET', '/api/settings')).json.links, [{ label: 'Bank', url: 'https://bank.example' }]);
  });

  test('booking is off when BOOK_HOUSEHOLD names no household here, and the boot log says so', async () => {
    assert.ok(warnings.includes('[budget] BOOK_HOUSEHOLD=elsewhere is not a household here; booking is off'), warnings.join('\n'));
    const r = await call(tester, 'GET', '/api/settings');
    assert.deepEqual(r.json.guests, { on: false, why: 'BOOK_HOUSEHOLD is not a household here',
      words: 'Booking is off: BOOK_HOUSEHOLD is not a household here.' });
    // The switch itself could not be turned on here: there is no Household calendar, and it says whose that is.
    assert.deepEqual([r.json.booking.on, r.json.booking.available, r.json.booking.why],
      [false, false, 'Booking is off until tester chooses the Household calendar.']);
    assert.ok(!JSON.stringify(r.json).includes('pw'), 'no mail password reaches the browser');
    assert.equal((await call('', 'GET', '/api/settings')).status, 401, 'members only');
  });

  test('booking is on only in the household friends book with', async () => {
    // Made after boot, BOOK_HOUSEHOLD is found when the settings are asked for.
    const made = await call(alice, 'POST', '/api/households', { label: 'Elsewhere' });
    assert.equal(made.json.id, 'elsewhere');
    const there = (await call(alice, 'GET', '/api/settings')).json;
    assert.deepEqual([there.booking.on, there.guests.on], [true, true]);
    const other = { on: false, why: 'friends book with another household on this server',
      words: 'Booking is off here: friends book with another household on this server.' };
    assert.equal((await call(alice, 'POST', '/api/households/select', { household: 'home' })).status, 200);
    const home = (await call(alice, 'GET', '/api/settings')).json;
    assert.deepEqual(home.guests, other);
    assert.equal(home.booking.on, false);
    const sandbox = (await call(tester, 'GET', '/api/settings')).json;
    assert.deepEqual(sandbox.guests, other, 'nor the sandbox');
    assert.equal(sandbox.booking.on, false);
  });

  test('every calendar route needs DSM', async () => {
    for (const [method, path] of [['GET', '/api/calendars'], ['POST', '/api/calendars/household'],
      ['POST', '/api/calendars/target'], ['POST', '/api/calendars/conflicts'],
      ['POST', '/api/calendars/household/name']] as const) {
      const r = await call(tester, method, path, method === 'POST' ? {} : undefined);
      assert.equal(r.status, 409, `${method} ${path}`);
      assert.match(r.json.error, /sign in again/);
    }
  });
});

describe('calendars, through the fake DSM', () => {
  test('lists event calendars, not task lists', async () => {
    const r = await call(alice, 'GET', '/api/calendars');
    assert.equal(r.status, 200);
    assert.equal(r.json.household, null);
    assert.equal(r.json.target, null);
    assert.ok(r.json.calendars.length >= 1);
    assert.ok(r.json.calendars.every((c: any) => typeof c.cal_id === 'string' && typeof c.name === 'string'));
    assert.ok(r.json.calendars.some((c: any) => c.isDefault));
    assert.ok(!r.json.calendars.some((c: any) => c.name === 'My Tasks'), 'the fake\'s task list is left out');
    assert.ok(!JSON.stringify(r.json).includes('sid'), 'nothing about the DSM session reaches the browser');
  });

  test('makes the Household calendar once, and the settings show it', async () => {
    const r = await call(alice, 'POST', '/api/calendars/household', {});
    assert.equal(r.status, 200);
    const again = await call(alice, 'POST', '/api/calendars/household', {});
    assert.equal(again.status, 200);
    assert.equal(again.json.calendar.household.cal_id, r.json.calendar.household.cal_id, 'the same one, not a second');
    const s = await call(alice, 'GET', '/api/settings');
    assert.equal(s.json.calendar.household.name, 'Household');
    const list = await call(alice, 'GET', '/api/calendars');
    assert.equal(list.json.calendars.filter((c: any) => c.name === 'Household').length, 1);
    assert.equal(list.json.household.cal_id, r.json.calendar.household.cal_id);
  });

  test('a member added by the calendar\'s maker is shared in at once, and sees it as theirs to write', async () => {
    const calls = await dsmCallsDuring(async () => {
      assert.equal((await call(alice, 'POST', '/api/members', { member: 'bob', why: 'we live here' })).status, 200);
    });
    const sets = sharingSets(calls);
    assert.equal(sets.length, 1);
    assert.match(sets[0]!, /"DSM_USER":\[\{"ug_name":"bob","cal_privilege":"RW"\}\]/);
    assert.equal((await call(alice, 'POST', '/api/calendars/household', {})).status, 200);
    const bob = await signIn('bob', 'battery-staple');
    const list = await call(bob, 'GET', '/api/calendars');
    assert.equal(list.status, 200);
    const hh = list.json.calendars.find((c: any) => c.cal_id === list.json.household.cal_id);
    assert.ok(hh, 'bob sees the Household calendar');
    assert.equal(hh.privilege, 'RW');
    assert.equal(hh.isHousehold, true);
    assert.equal(list.json.calendars.filter((c: any) => c.isHousehold).length, 1);
  });

  test('a member removed by the calendar\'s maker is unshared at once, and their stale household lists as none', async () => {
    const hhId = (await call(alice, 'GET', '/api/settings')).json.calendar.household.cal_id;
    const added = sharingSets(await dsmCallsDuring(async () => {
      assert.equal((await call(alice, 'POST', '/api/members', { member: 'dave', why: 'lodger' })).status, 200);
    }));
    assert.equal(added.length, 1);
    assert.match(added[0]!, /"ug_name":"dave","cal_privilege":"RW"/);
    const dave = await signIn('dave', 'd');
    assert.ok((await call(dave, 'GET', '/api/calendars')).json.calendars.some((c: any) => c.cal_id === hhId));

    const removed = sharingSets(await dsmCallsDuring(async () => {
      assert.equal((await call(alice, 'DELETE', '/api/members', { member: 'dave', why: 'moved out' })).status, 200);
    }));
    assert.equal(removed.length, 1);
    assert.match(removed[0]!, /"DSM_USER":\[\{"ug_name":"bob","cal_privilege":"RW"\}\]/);
    assert.doesNotMatch(removed[0]!, /dave/);

    // dave's session still names the household he was removed from.
    const list = await call(dave, 'GET', '/api/calendars');
    assert.equal(list.status, 200);
    assert.equal(list.json.household, null);
    assert.equal(list.json.target, null);
    assert.ok(list.json.calendars.some((c: any) => c.isDefault), 'his own calendars, still');
    assert.ok(!list.json.calendars.some((c: any) => c.cal_id === hhId), 'and not the Household one');
  });

  test('where plans go: a calendar I own and have shared read-write with every other member', async () => {
    const mine = (await call(alice, 'GET', '/api/calendars')).json.calendars as any[];
    const personal = mine.find((c) => c.isDefault)!;
    const ref = { cal_id: personal.cal_id, original_cal_id: personal.original_cal_id };
    const unshared = await call(alice, 'POST', '/api/calendars/target', ref);
    assert.equal(unshared.status, 400);
    assert.equal(unshared.json.error, 'share it with bob first');
    // Shared by alice herself, as she would in Synology Calendar. Read-only is not enough.
    const { sid } = await checkWithDsm('alice', 'correct-horse', undefined);
    await shareCalendar(sid, personal.cal_id, { users: [{ name: 'bob', privilege: 'RO' }] });
    const readOnly = await call(alice, 'POST', '/api/calendars/target', ref);
    assert.equal(readOnly.status, 400);
    assert.equal(readOnly.json.error, 'share it with bob first');
    await shareCalendar(sid, personal.cal_id, { users: [{ name: 'bob', privilege: 'RW' }] });
    const r = await call(alice, 'POST', '/api/calendars/target', ref);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.calendar.target, { cal_id: personal.cal_id, original_cal_id: personal.original_cal_id });
    assert.deepEqual((await call(alice, 'GET', '/api/calendars')).json.target,
      { cal_id: personal.cal_id, original_cal_id: personal.original_cal_id });
    const missing = await call(alice, 'POST', '/api/calendars/target', { cal_id: '/nobody/', original_cal_id: '/nobody/' });
    assert.equal(missing.status, 400);
  });

  test('the owner cannot make someone else\'s calendar the household\'s, but may choose the Household one', async () => {
    const bob = await signIn('bob', 'battery-staple');
    const bobs = ((await call(bob, 'GET', '/api/calendars')).json.calendars as any[]).find((c) => c.isDefault)!;
    const { sid } = await checkWithDsm('bob', 'battery-staple', undefined);
    await shareCalendar(sid, bobs.cal_id, { users: [{ name: 'alice', privilege: 'RW' }] });
    const theirs = (await call(alice, 'GET', '/api/calendars')).json.calendars as any[];
    const bobsForAlice = theirs.find((c) => c.cal_id === bobs.cal_id);
    assert.equal(bobsForAlice?.privilege, 'RW', 'bob shared it with alice read-write above');
    const notOwner = await call(alice, 'POST', '/api/calendars/target',
      { cal_id: bobsForAlice.cal_id, original_cal_id: bobsForAlice.original_cal_id });
    assert.equal(notOwner.status, 400);
    assert.equal(notOwner.json.error, 'only the calendar\'s owner can make it the household\'s');
    const hh = theirs.find((c) => c.isHousehold);
    const ok = await call(alice, 'POST', '/api/calendars/target', { cal_id: hh.cal_id, original_cal_id: hh.original_cal_id });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.calendar.target, { cal_id: hh.cal_id, original_cal_id: hh.original_cal_id });
  });

  test('a Household calendar that is gone is replaced by the owner, and plans follow it', async () => {
    const before = (await call(alice, 'GET', '/api/settings')).json.calendar;
    assert.deepEqual(before.target, { cal_id: before.household.cal_id, original_cal_id: before.household.original_cal_id },
      'alice chose the Household calendar above');
    const r = await call(alice, 'POST', '/api/calendars/household', { replace: true });
    assert.equal(r.status, 200);
    const after = r.json.calendar;
    assert.notEqual(after.household.cal_id, before.household.cal_id);
    assert.equal(after.household.by, 'alice');
    assert.equal(after.target, null, 'plans go on the new Household calendar');
    // Shared by its new maker with bob, and not made twice.
    const bob = await signIn('bob', 'battery-staple');
    const his = (await call(bob, 'GET', '/api/calendars')).json.calendars as any[];
    assert.equal(his.find((c) => c.isHousehold)?.cal_id, after.household.cal_id);
    assert.equal(his.find((c) => c.isHousehold)?.privilege, 'RW');
    const again = await call(alice, 'POST', '/api/calendars/household', {});
    assert.equal(again.json.calendar.household.cal_id, after.household.cal_id);
  });

  test("only the owner chooses the household's calendar", async () => {
    const bob = await signIn('bob', 'battery-staple');
    const mine = ((await call(bob, 'GET', '/api/calendars')).json.calendars as any[]).find((c) => c.isDefault)!;
    const ref = { cal_id: mine.cal_id, original_cal_id: mine.original_cal_id };
    const before = (await call(alice, 'GET', '/api/settings')).json.calendar;
    assert.equal((await call(bob, 'POST', '/api/calendars/household', { replace: true })).status, 403);
    assert.equal((await call(bob, 'POST', '/api/calendars/household', {})).status, 403);
    assert.equal((await call(bob, 'POST', '/api/calendars/target', ref)).json.error, "only alice can choose the household's calendar");
    assert.deepEqual((await call(alice, 'GET', '/api/settings')).json.calendar, before, 'nothing changed');
  });

  test('the Household calendar is renamed on the NAS, then in the log, by the member who made it', async () => {
    const before = (await call(alice, 'GET', '/api/settings')).json.calendar.household;
    assert.equal(before.by, 'alice', 'alice made the replacement above');
    const calls = await dsmCallsDuring(async () => {
      const r = await call(alice, 'POST', '/api/calendars/household/name', { name: '  Rivera home ' });
      assert.equal(r.status, 200);
      assert.equal(r.json.calendar.household.name, 'Rivera home', 'trimmed, and the view redraws from it');
      assert.equal(r.json.calendar.household.cal_id, before.cal_id, 'the same calendar, renamed');
    });
    const set = calls.filter((b) => /api=SYNO\.Cal\.Cal&/.test(b) && /method=set/.test(b));
    assert.equal(set.length, 1);
    assert.match(set[0]!, /cal_displayname=Rivera\+home/);
    assert.ok(set[0]!.includes(`cal_id=${before.cal_id}`));
    const listed = (await call(alice, 'GET', '/api/calendars')).json.calendars as any[];
    assert.equal(listed.find((c) => c.isHousehold)?.name, 'Rivera home', 'the NAS has the new name');
    assert.equal((await call(alice, 'GET', '/api/settings')).json.calendar.household.name, 'Rivera home', 'and so does the log');
    assert.ok(JSON.stringify((await call(alice, 'GET', '/api/thread?all=1')).json).includes('renamed the Household calendar to Rivera home'), 'the history says so');
  });

  test('renaming to the name it has already writes nothing to the log', async () => {
    const count = async () => JSON.stringify((await call(alice, 'GET', '/api/thread?all=1')).json).split('renamed the Household calendar').length;
    const n = await count();
    assert.equal((await call(alice, 'POST', '/api/calendars/household/name', { name: 'Rivera home' })).status, 200);
    assert.equal(await count(), n);
  });

  test('a rename the NAS refuses says who can do it, and the log keeps the old name', async () => {
    const bob = await signIn('bob', 'battery-staple');
    const r = await call(bob, 'POST', '/api/calendars/household/name', { name: 'Ours' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'only alice, who made the Household calendar, can rename it');
    assert.equal((await call(alice, 'GET', '/api/settings')).json.calendar.household.name, 'Rivera home');
  });

  test("a refusal that is not about who may rename it is said as the NAS said it, even to its maker", async () => {
    setDsmFetch((async (url: string | URL | Request, init?: RequestInit) => {
      const body = decodeURIComponent(String(init?.body ?? ''));
      if (/api=SYNO\.Cal\.Cal&/.test(body) && /method=set/.test(body)) {
        return new Response(JSON.stringify({ success: false, error: { code: 9017 } }), { headers: { 'content-type': 'application/json' } });
      }
      return fetch(url, init);
    }) as typeof fetch);
    try {
      const r = await call(alice, 'POST', '/api/calendars/household/name', { name: 'Ours' });
      assert.equal(r.status, 502);
      assert.doesNotMatch(r.json.error, /who made the Household calendar/);
      assert.match(r.json.error, /9017/);
    } finally {
      setDsmFetch(null);
    }
    assert.equal((await call(alice, 'GET', '/api/settings')).json.calendar.household.name, 'Rivera home');
  });

  test('a rename needs a name, and a Household calendar to rename', async () => {
    assert.equal((await call(alice, 'POST', '/api/calendars/household/name', { name: '   ' })).status, 400);
    assert.equal((await call(alice, 'POST', '/api/calendars/household/name', {})).status, 400);
    assert.equal((await call(alice, 'POST', '/api/calendars/household/name', { name: 'x'.repeat(101) })).status, 400);
    const hal = await signIn('hal', 'h');
    assert.equal((await call(hal, 'POST', '/api/households', { label: 'Cabin' })).status, 200);
    const none = await call(hal, 'POST', '/api/calendars/household/name', { name: 'Cabin' });
    assert.equal(none.status, 400);
    assert.equal(none.json.error, 'there is no Household calendar to rename yet');
  });

  test("a member's first event does not make the Household calendar; the owner's choice does, and then it lands", async () => {
    const erin = await signIn('erin', 'e');
    assert.equal((await call(erin, 'POST', '/api/households', { label: 'Flat' })).status, 200);
    assert.equal((await call(erin, 'POST', '/api/members', { member: 'frank', why: 'flatmate' })).status, 200);
    const frank = await signIn('frank', 'f');
    assert.equal((await call(frank, 'POST', '/api/calendars/household', {})).status, 403);
    // Neither the route nor a member's first event makes the calendar: it is the owner's choice.
    const day = householdDay('UTC', new Date(Date.now() + 2 * 86_400_000));
    const bin = { summary: 'Bin day', start: day, end: day, allDay: true, on: 'household' };
    const calls = await dsmCallsDuring(async () => {
      const refused = await call(frank, 'POST', '/api/calendar/events', bin);
      assert.equal(refused.status, 403);
      assert.equal(refused.json.error, "only erin can choose the household's calendar");
    });
    assert.deepEqual(calls.filter((b) => /api=SYNO\.Cal\.Cal&/.test(b) && /method=create/.test(b)), [], 'no calendar was made');
    assert.equal((await call(frank, 'GET', '/api/settings')).json.calendar.household, null);
    // Once the owner has made it, a member's event lands on it.
    assert.equal((await call(erin, 'POST', '/api/calendars/household', {})).status, 200);
    const landed = await call(frank, 'POST', '/api/calendar/events', bin);
    assert.equal(landed.status, 200, JSON.stringify(landed.json));
    assert.equal((await call(frank, 'GET', '/api/settings')).json.calendar.household.by, 'erin');
  });

  test('the calendars checked for conflicts are mine alone', async () => {
    const mine = (await call(alice, 'GET', '/api/calendars')).json.calendars as any[];
    const personal = mine.find((c) => c.isDefault)!;
    const r = await call(alice, 'POST', '/api/calendars/conflicts',
      { calendars: [{ cal_id: personal.cal_id, original_cal_id: personal.original_cal_id }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.calendar.conflicts,
      [{ cal_id: personal.cal_id, original_cal_id: personal.original_cal_id, label: personal.name }]);
    const bob = await signIn('bob', 'battery-staple');
    assert.deepEqual((await call(bob, 'GET', '/api/settings')).json.calendar.conflicts, []);
    assert.equal((await call(alice, 'POST', '/api/calendars/conflicts', { calendars: 'all' })).status, 400);
    assert.equal((await call(alice, 'POST', '/api/calendars/conflicts',
      { calendars: [{ cal_id: '/nobody/', original_cal_id: '/nobody/' }] })).status, 400);
  });

  test('a session restored after a restart has no DSM: sign in again, before any household question', async () => {
    // carol has no household, so a route that asked about one first would say
    // "no household is open" (also a 409) instead.
    const carol = await signIn('carol', 'c');
    // A second server reading the same sessions file is the restart: the
    // sessions carry over, their sids do not.
    const restarted = await start();
    const at = `http://127.0.0.1:${restarted.port}`;
    try {
      const check = await fetch(`${at}/api/auth/check`, { headers: { cookie: carol } });
      assert.equal((await check.json() as any).authenticated, true, 'carol carried over');
      for (const [method, path] of [['GET', '/api/calendars'], ['POST', '/api/calendars/household'],
        ['POST', '/api/calendars/target'], ['POST', '/api/calendars/conflicts']] as const) {
        const res = await fetch(at + path, { method, headers: { cookie: carol, 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: '{}' } : {}) });
        assert.equal(res.status, 409, `${method} ${path}`);
        assert.match((await res.json() as any).error, /sign in again/);
      }
      // Settings are the household's, so there the household question comes first.
      const s = await fetch(`${at}/api/settings`, { headers: { cookie: carol } });
      assert.equal(s.status, 409);
      assert.match((await s.json() as any).error, /no household is open/);
    } finally {
      await restarted.close();
    }
  });
});

describe('signing out', () => {
  test('answers at once, then closes the DSM session in the background', async () => {
    const cookie = await signIn('alice', 'correct-horse');
    const nasStub = fakeDsm({ success: true });
    setDsmFetch(nasStub.fn);
    try {
      const r = await call(cookie, 'POST', '/api/auth/logout');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('set-cookie') ?? '', /Max-Age=0/);
      for (let i = 0; i < 50 && nasStub.calls.length === 0; i++) await new Promise((ok) => setTimeout(ok, 5));
      assert.equal(nasStub.calls.length, 1);
      const body = decodeURIComponent(nasStub.calls[0]!.body);
      assert.match(body, /api=SYNO\.API\.Auth/);
      assert.match(body, /method=logout/);
      assert.match(body, /_sid=\w+/);
      assert.equal((await call(cookie, 'GET', '/api/auth/check')).json.authenticated, false);
    } finally {
      setDsmFetch(null);
    }
  });

  test('a NAS that fails, or never answers, does not keep anyone signed in', async () => {
    for (const nasFetch of [
      (async () => { throw new Error('down'); }) as unknown as typeof fetch,
      (() => new Promise(() => {})) as unknown as typeof fetch,
    ]) {
      const cookie = await signIn('alice', 'correct-horse');
      setDsmFetch(nasFetch);
      try {
        const r = await call(cookie, 'POST', '/api/auth/logout');
        assert.equal(r.status, 200);
        assert.equal((await call(cookie, 'GET', '/api/auth/check')).json.authenticated, false);
      } finally {
        setDsmFetch(null);
      }
    }
  });
});

describe('attachments, with no folder chosen', () => {
  test('the settings say they are off and who turns them on, and an upload is refused before anything reaches the NAS', async () => {
    const st = (await call(alice, 'GET', '/api/settings')).json;
    assert.deepEqual(st.attachments, { on: false, why: 'Files on cards are off until alice chooses where documents live, in Settings.' });
    // Booking is not this household's (the household it names was made above), and the guest list says so in the same words.
    assert.deepEqual(st.guests, { on: false, why: 'friends book with another household on this server',
      words: 'Booking is off here: friends book with another household on this server.' });
    assert.deepEqual(st.guests, { on: st.booking.on, why: st.booking.why, words: st.booking.words });
    // The zone the server reads its days in, for the screens to draw theirs in.
    assert.equal(st.tz, 'UTC');
    const made = await call(alice, 'POST', '/api/plans', { title: 'Fix the gate', area: 'House' });
    assert.equal(made.status, 200);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(2048)]), 'gate.png');
    const bodies = await dsmCallsDuring(async () => {
      const res = await fetch(`${base}/api/plans/${made.json.plan.id}/attach`, { method: 'POST', headers: { cookie: alice }, body: form });
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as any).error, 'Files on cards are off until alice chooses where documents live, in Settings.');
    });
    assert.deepEqual(bodies, []);
    // The sandbox hears the same: off is off, whoever asks.
    const sandbox = await call(tester, 'POST', '/api/plans', { title: 'Fix the gate', area: 'House' });
    const res = await fetch(`${base}/api/plans/${sandbox.json.plan.id}/attach`, { method: 'POST', headers: { cookie: tester }, body: form });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as any).error, /^Files on cards are off until .+ chooses where documents live, in Settings\.$/);
  });
});

describe('settings moved off .env are read when used', () => {
  test("the NAS's public address: saved beats the deployment, and off hides it, without a restart", async () => {
    process.env['DSM_PUBLIC_URL'] = 'https://env.example.com:5001';
    assert.equal((await call(alice, 'GET', '/api/settings')).json.dsmPublicUrl, 'https://env.example.com:5001');
    await saveConnector('publicUrl', { value: 'https://nas.example.com:5001' }, 'carol');
    assert.equal((await call(alice, 'GET', '/api/settings')).json.dsmPublicUrl, 'https://nas.example.com:5001');
    await saveConnector('publicUrl', { off: true }, 'carol');
    assert.equal((await call(alice, 'GET', '/api/settings')).json.dsmPublicUrl, null);
    await saveConnector('publicUrl', { clear: true }, 'carol');
    delete process.env['DSM_PUBLIC_URL'];
  });
  test('who may sign in is the saved list once there is one', async () => {
    await saveConnector('signIn', { value: ['alice', 'bob'] }, 'carol');
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'c' }) });
    assert.equal(res.status, 401);
    await signIn('bob', 'battery-staple');
    await saveConnector('signIn', { clear: true }, 'carol');
  });
});

describe('booking is worked out again on every answer', () => {
  test('a settings change answers with the same booking and guests as the next GET, after booking turns on', async () => {
    assert.equal((await call(alice, 'POST', '/api/households/select', { household: 'home' })).status, 200);
    const before = await call(alice, 'GET', '/api/settings');
    assert.equal(before.json.booking.on, false);
    // The household friends book with is named after boot: booking is on from the next call, with no restart.
    process.env['BOOK_HOUSEHOLD'] = 'home';
    try {
      const got = await call(alice, 'GET', '/api/settings');
      assert.equal(got.json.booking.on, true);
      const posted = await call(alice, 'POST', '/api/settings/areas', { areas: ['House', 'Garden'] });
      assert.equal(posted.status, 200);
      assert.deepEqual(posted.json.booking, got.json.booking);
      assert.deepEqual(posted.json.guests, got.json.guests);
      // and the same when it turns off again
      process.env['BOOK_HOUSEHOLD'] = 'elsewhere';
      const off = await call(alice, 'POST', '/api/settings/areas', { areas: ['House', 'Garden'] });
      assert.deepEqual(off.json.booking, before.json.booking);
      assert.deepEqual(off.json.guests, before.json.guests);
    } finally {
      process.env['BOOK_HOUSEHOLD'] = 'elsewhere';
    }
  });
});

describe("a household's zone", () => {
  test('decides its today, whatever the other households say', async () => {
    assert.equal((await call(alice, 'POST', '/api/households/select', { household: 'home' })).status, 200);
    const set = await call(alice, 'POST', '/api/settings/zone', { zone: 'Pacific/Kiritimati' });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    assert.equal(set.json.tz, 'Pacific/Kiritimati', 'the answer is the settings, in the new zone');
    const here = await call(alice, 'GET', '/api/whoami');
    assert.equal(here.json.timeZone, 'Pacific/Kiritimati');
    assert.equal(here.json.today, householdDay('Pacific/Kiritimati'));
    assert.equal((await call(alice, 'GET', '/api/settings')).json.tz, 'Pacific/Kiritimati');

    // A household of bob's own, 25 hours behind: its today is never alice's.
    const bob = await signIn('bob', 'battery-staple');
    assert.equal((await call(bob, 'POST', '/api/households', { label: 'Away' })).status, 200);
    assert.equal((await call(bob, 'POST', '/api/settings/zone', { zone: 'Pacific/Pago_Pago' })).status, 200);
    const there = await call(bob, 'GET', '/api/whoami');
    assert.equal(there.json.timeZone, 'Pacific/Pago_Pago');
    assert.equal(there.json.today, householdDay('Pacific/Pago_Pago'));
    assert.notEqual(there.json.today, (await call(alice, 'GET', '/api/whoami')).json.today);
    assert.equal((await call(alice, 'GET', '/api/whoami')).json.timeZone, 'Pacific/Kiritimati', "bob's choice is his household's alone");
  });

  test('only the owner sets it, and only to a zone this server knows', async () => {
    // A member of alice's household, whatever the tests before this one did.
    assert.equal((await call(alice, 'POST', '/api/members', { member: 'hal', why: 'staying a while' })).status, 200);
    const hal = await signIn('hal', 'h');
    assert.equal((await call(hal, 'POST', '/api/households/select', { household: 'home' })).status, 200);
    const member = await call(hal, 'POST', '/api/settings/zone', { zone: 'Europe/London' });
    assert.equal(member.status, 403);
    assert.equal(member.json.error, 'only alice can change this');
    const r = await call(alice, 'POST', '/api/settings/zone', { zone: 'Mars/Olympus' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'Mars/Olympus is not a time zone this server knows');
    assert.equal((await call(alice, 'GET', '/api/whoami')).json.timeZone, 'Pacific/Kiritimati', 'nothing was written');
  });
});

describe("a household's envelope model", () => {
  test('the owner chooses from the list, and Settings says where it came from', async () => {
    assert.equal((await call(alice, 'POST', '/api/households/select', { household: 'home' })).status, 200);
    assert.equal((await call(alice, 'POST', '/api/members', { member: 'hal', why: 'staying a while' })).status, 200);
    const hal = await signIn('hal', 'h');
    assert.equal((await call(hal, 'POST', '/api/households/select', { household: 'home' })).status, 200);

    const first = await call(alice, 'GET', '/api/settings');
    assert.deepEqual([first.json.model.chosen, first.json.model.source], ['claude-haiku-5-5', 'default']);
    assert.deepEqual(first.json.model.choices.map((c: any) => c.id), ['claude-haiku-5-5', 'claude-sonnet-5-5']);

    assert.equal((await call(alice, 'POST', '/api/settings/model', { model: 'gpt-4' })).status, 400);
    assert.equal((await call(alice, 'POST', '/api/settings/model', { model: 'gpt-4' })).json.error, 'choose one of the models offered');
    const member = await call(hal, 'POST', '/api/settings/model', { model: 'claude-sonnet-5-5' });
    assert.equal(member.status, 403);
    assert.equal(member.json.error, 'only alice can change this');
    assert.equal((await call(alice, 'GET', '/api/settings')).json.model.source, 'default', 'nothing was written');

    const r = await call(alice, 'POST', '/api/settings/model', { model: 'claude-sonnet-5-5' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.model.chosen, r.json.model.source], ['claude-sonnet-5-5', 'saved']);
    assert.equal(r.json.model.claudeOff, true, 'this run has no key');
    assert.equal((await call(hal, 'GET', '/api/settings')).json.model.chosen, 'claude-sonnet-5-5', 'every member sees it');

    const back = await call(alice, 'POST', '/api/settings/model', { model: null });
    assert.deepEqual([back.json.model.chosen, back.json.model.source], ['claude-haiku-5-5', 'default']);
  });

  test('the deployment model is offered, marked, and is what applies until the household chooses', async () => {
    assert.equal((await call(alice, 'POST', '/api/households/select', { household: 'home' })).status, 200);
    process.env['CLAUDE_MATCH_MODEL'] = 'claude-opus-5-5';
    try {
      const view = (await call(alice, 'GET', '/api/settings')).json.model;
      assert.deepEqual([view.chosen, view.source], ['claude-opus-5-5', 'from the deployment']);
      assert.deepEqual(view.choices.at(-1), { id: 'claude-opus-5-5', label: 'claude-opus-5-5', fromDeployment: true });
      const set = await call(alice, 'POST', '/api/settings/model', { model: 'claude-opus-5-5' });
      assert.equal(set.status, 200, 'the deployment model is among those offered');
      assert.equal(set.json.model.source, 'saved');
      assert.equal((await call(alice, 'POST', '/api/settings/model', { model: null })).json.model.source, 'from the deployment');
    } finally {
      delete process.env['CLAUDE_MATCH_MODEL'];
    }
  });
});
