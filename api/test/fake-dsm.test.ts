// api/test/fake-dsm.test.ts
//
// The fake DSM against the app's own clients: every method src/synology.ts
// calls, answered in the shape the client expects. This proves the two agree,
// not that DSM does; tools/synology-check is for that.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAccounts, start as startFakeDsm } from '../tools/fake-dsm/server.ts';
import { fakeNas } from './fake-nas.ts';

const dir = await mkdtemp(join(tmpdir(), 'pb-fake-dsm-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alice: { password: 'pw' }, bob: { password: 'pw2' }, otto: { password: 'pw3', otp: '123456' } },
});
// DSM_URL is read when auth.ts loads, so src/ is imported after it is set.
process.env['DSM_URL'] = `http://127.0.0.1:${nas.port}`;
const { checkWithDsm, AuthError, OtpRequired } = await import('../src/auth.ts');
const syno = await import('../src/synology.ts');
const drive = await import('../src/drive.ts');
const { isAdministrator, listAccounts } = await import('../src/accounts.ts');
const { SessionLost, SynologyError, EtagMismatch } = syno;

let alice = '';
let bob = '';
before(async () => {
  ({ sid: alice } = await checkWithDsm('alice', 'pw', undefined));
  ({ sid: bob } = await checkWithDsm('bob', 'pw2', undefined));
});
after(async () => { await nas.close(); });

describe('the fake DSM signs in', () => {
  test('a wrong password, and a missing or wrong one-time code, as DSM does', async () => {
    await assert.rejects(() => checkWithDsm('alice', 'nope', undefined), AuthError);
    await assert.rejects(() => checkWithDsm('otto', 'pw3', undefined), OtpRequired);
    await assert.rejects(() => checkWithDsm('otto', 'pw3', '000000'), AuthError);
    assert.ok((await checkWithDsm('otto', 'pw3', '123456')).sid);
  });

  test('an unknown sid is 119, which the client reads as "sign in again"', async () => {
    await assert.rejects(() => syno.listCalendars('not-a-sid'),
      (e: unknown) => e instanceof SessionLost && e.code === 119);
  });

  test('a sid that has signed out no longer works', async () => {
    const { sid } = await checkWithDsm('alice', 'pw', undefined);
    await syno.dsm({ api: 'SYNO.API.Auth', version: 6, method: 'logout', sid });
    await assert.rejects(() => syno.listCalendars(sid), SessionLost);
  });

  test('a sid in the URL is refused', async () => {
    const res = await fetch(`http://127.0.0.1:${nas.port}/webapi/entry.cgi?_sid=${alice}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'api=SYNO.Cal.Cal&version=5&method=list',
    });
    assert.deepEqual(await res.json(), { success: false, error: { code: 119 } });
  });
});

describe('calendars and sharing', () => {
  test('a calendar list with no parameters is refused 9009, as the real NAS refused it', async () => {
    await assert.rejects(() => syno.dsm({ api: 'SYNO.Cal.Cal', version: 5, method: 'list', sid: alice }),
      (e: unknown) => e instanceof syno.SynologyError && e.code === 9009);
    const data = await syno.dsm<{ list: unknown[] }>({
      api: 'SYNO.Cal.Cal', version: 5, method: 'list', sid: alice, params: { ...syno.CALENDAR_LIST_PARAMS } });
    assert.ok(Array.isArray(data.list));
  });

  test('each account has its own calendar; a task list is not an event calendar', async () => {
    const mine = await syno.listCalendars(alice);
    assert.deepEqual(mine.map((c) => [c.cal_id, c.isDefault, c.privilege]), [['/alice/home/', true, 'RW']]);
  });

  test('a calendar made and shared is listed for the person it is shared with', async () => {
    const made = await syno.createCalendar(alice, { displayname: 'Household', color: '#3F6F8C' });
    assert.equal(made.displayname, 'Household');
    assert.equal(made.cal_id, made.original_cal_id);
    assert.deepEqual(await syno.sharingOf(alice, made.cal_id), { users: [], groups: [] });
    await syno.shareCalendar(alice, made.cal_id, { users: [{ name: 'bob', privilege: 'RW' }] });
    assert.deepEqual(await syno.sharingOf(alice, made.cal_id), { users: [{ name: 'bob', privilege: 'RW' }], groups: [] });
    const theirs = (await syno.listCalendars(bob)).find((c) => c.cal_id === made.cal_id);
    assert.equal(theirs?.privilege, 'RW');
    assert.equal(theirs?.isDefault, false);
    // A whole-list replace: sharing with nobody unshares bob.
    await syno.shareCalendar(alice, made.cal_id, { users: [] });
    assert.equal((await syno.listCalendars(bob)).some((c) => c.cal_id === made.cal_id), false);
  });

  test('a group share set on the calendar is kept, and read back as it was set', async () => {
    const made = await syno.createCalendar(alice, { displayname: 'Grouped', color: '#000000' });
    const groups = [{ ug_name: 'family', cal_privilege: 'RO' }];
    await syno.shareCalendar(alice, made.cal_id, { users: [{ name: 'bob', privilege: 'RW' }], groups });
    assert.deepEqual((await syno.sharingOf(alice, made.cal_id)).groups, groups);
  });

  test('another account\'s calendar cannot be shared or read', async () => {
    await assert.rejects(() => syno.sharingOf(bob, '/alice/home/'),
      (e: unknown) => e instanceof SynologyError && e.code === 9009);
  });
});

describe('events, and nothing changes without its etag', () => {
  const at = Date.UTC(2026, 10, 2, 9) / 1000;
  const ref = { cal_id: '/alice/home/', original_cal_id: '/alice/home/' };

  test('create, get, list, set with a new etag, a stale etag refused, delete', async () => {
    const made = await syno.createEvent(alice, {
      ...ref, summary: 'Dentist', description: '', is_all_day: false, dtstart: at, dtend: at + 3600, tz_id: 'UTC',
    });
    assert.ok(made.evt_id > 0 && made.dav_etag && made.ical_uid);
    assert.equal((await syno.getEvent(alice, made)).summary, 'Dentist');

    const listed = await syno.listEvents(alice, { calendars: [ref], start: at - 86400, end: at + 86400 });
    assert.deepEqual(listed.map((e) => e.evt_id), [made.evt_id]);
    assert.equal(listed[0]!.cal_id, ref.cal_id);
    assert.deepEqual(await syno.listEvents(alice, { calendars: [ref], start: at + 7200, end: at + 86400 }), []);

    const moved = await syno.setEvent(alice, made, { summary: 'Dentist, moved', dtstart: at + 3600, dtend: at + 7200 });
    assert.notEqual(moved.dav_etag, made.dav_etag, 'every change changes the etag');
    assert.equal(moved.summary, 'Dentist, moved');

    await assert.rejects(() => syno.setEvent(alice, made, { summary: 'from a stale copy' }),
      (e: unknown) => e instanceof EtagMismatch && e.current?.summary === 'Dentist, moved');

    await syno.deleteEvent(alice, moved);
    await assert.rejects(() => syno.getEvent(alice, moved), SynologyError);
  });

  test('bob cannot add to alice\'s own calendar', async () => {
    await assert.rejects(() => syno.createEvent(bob, {
      ...ref, summary: 'x', description: '', is_all_day: true, dtstart: at, dtend: at + 86400, tz_id: 'UTC',
    }), (e: unknown) => e instanceof SynologyError && e.code === 9009);
  });
});

describe('contacts: one address book', () => {
  test('create, get, list and search', async () => {
    const [book] = await syno.listAddressbooks(alice);
    assert.ok(book);
    const made = await syno.createContact(alice, {
      addressbook_id: book.id, full_name: 'Pat Plumber', phones: ['555-0100'], emails: ['pat@example.com'], org: 'Pipes',
    });
    assert.deepEqual({ ...made, id: 0 }, {
      id: 0, addressbook_id: book.id, full_name: 'Pat Plumber', phones: ['555-0100'], emails: ['pat@example.com'], org: 'Pipes',
    });
    assert.equal((await syno.getContact(alice, made.id)).full_name, 'Pat Plumber');
    assert.equal((await syno.listContacts(alice, { addressbook_id: book.id })).length, 1);
    assert.deepEqual((await syno.searchContacts(alice, 'plumb')).map((c) => c.id), [made.id]);
    assert.deepEqual(await syno.searchContacts(alice, 'electric'), []);
  });
});

describe('File Station, on a temporary directory', () => {
  test('a folder, an upload, a listing and the bytes back', async () => {
    await syno.createFolder(alice, '/home/Planner', 'plan-1');
    const bytes = new Uint8Array(4096).map((_, i) => i % 251);
    await syno.uploadFile(alice, { folder: '/home/Planner/plan-1', name: 'quote "final".pdf', bytes });
    const listed = await syno.listFolder(alice, '/home/Planner/plan-1');
    assert.deepEqual(listed, [{ name: 'quote "final".pdf', size: 4096, isdir: false }]);
    const back = await syno.downloadFile(alice, '/home/Planner/plan-1/quote "final".pdf');
    assert.deepEqual(back.bytes, bytes);
  });

  test('list_share needs no path, and names the top-level folders, as the check reads it', async () => {
    const data = await syno.dsm<{ shares: { name: string; path: string }[] }>(
      { api: 'SYNO.FileStation.List', version: syno.FILE_STATION_VERSION, method: 'list_share', sid: alice });
    assert.ok(data.shares.some((s) => s.name === 'home' && s.path === '/home'));
  });

  test('an existing file is not overwritten unless asked', async () => {
    const one = new TextEncoder().encode('one');
    await syno.uploadFile(alice, { folder: '/home/Planner/plan-2', name: 'a.txt', bytes: one });
    await assert.rejects(() => syno.uploadFile(alice, { folder: '/home/Planner/plan-2', name: 'a.txt', bytes: one }),
      (e: unknown) => e instanceof SynologyError && e.code === 414);
    await syno.uploadFile(alice, { folder: '/home/Planner/plan-2', name: 'a.txt', bytes: new TextEncoder().encode('two'), overwrite: true });
    assert.equal(new TextDecoder().decode((await syno.downloadFile(alice, '/home/Planner/plan-2/a.txt')).bytes), 'two');
  });

  test('overwrite as the guide has it: left out refuses, false skips and says success, true replaces', async () => {
    const upload = (overwrite: string | undefined, text: string) => {
      const boundary = 'fake-dsm-test';
      const parts: [string, string][] = [['api', 'SYNO.FileStation.Upload'], ['version', '2'], ['method', 'upload'],
        ['path', '/home/Planner/plan-3'], ['create_parents', 'true'],
        ...(overwrite === undefined ? [] : [['overwrite', overwrite] as [string, string]]), ['_sid', alice]];
      const body = parts.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('')
        + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.txt"\r\n`
        + `Content-Type: application/octet-stream\r\n\r\n${text}\r\n--${boundary}--\r\n`;
      return fetch(`${process.env['DSM_URL']}/webapi/entry.cgi`, {
        method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body,
      }).then((r) => r.json() as Promise<{ success: boolean; error?: { code: number } }>);
    };
    const read = async () => new TextDecoder().decode((await syno.downloadFile(alice, '/home/Planner/plan-3/b.txt')).bytes);
    assert.deepEqual(await upload(undefined, 'first'), { success: true, data: {} });
    assert.deepEqual(await upload(undefined, 'second'), { success: false, error: { code: 414 } }, 'left out: refused');
    assert.equal(await read(), 'first');
    assert.equal((await upload('false', 'third')).success, true, 'false: success…');
    assert.equal(await read(), 'first', '…and nothing changed');
    assert.equal((await upload('true', 'fourth')).success, true);
    assert.equal(await read(), 'fourth', 'true: replaced');
  });

  test('a missing file or folder is 408, and an unknown sid 119, on the byte routes too', async () => {
    await assert.rejects(() => syno.downloadFile(alice, '/home/nothing.pdf'),
      (e: unknown) => e instanceof SynologyError && e.code === 408);
    await assert.rejects(() => syno.listFolder(alice, '/home/nowhere'),
      (e: unknown) => e instanceof SynologyError && e.code === 408);
    await assert.rejects(() => syno.downloadFile('not-a-sid', '/home/Planner/plan-2/a.txt'), SessionLost);
    await assert.rejects(() => syno.uploadFile('not-a-sid', { folder: '/x', name: 'y', bytes: new Uint8Array(1) }), SessionLost);
  });

  test('a path cannot climb out of the directory', async () => {
    await assert.rejects(() => syno.downloadFile(alice, '/../../etc/hosts'),
      (e: unknown) => e instanceof SynologyError && e.code === 408);
  });
});

describe('Synology Drive', () => {
  const P = '/team-folders/Planner/h1/today';
  before(async () => { await syno.createFolder(alice, '/Planner/h1', 'today'); });
  test('a write is a new version of the same file, and its hash follows its content', async () => {
    const one = await drive.writeFile(alice, `${P}/a.md`, 'first');
    const two = await drive.writeFile(alice, `${P}/a.md`, 'second');
    const three = await drive.writeFile(bob, `${P}/a.md`, 'second');
    assert.equal(two.permanent_link, one.permanent_link);
    assert.deepEqual([one.version_id, two.version_id, three.version_id], ['1', '2', '3']);
    assert.notEqual(one.hash, two.hash);
    assert.equal(two.hash, three.hash);
  });
  test('a file is read back by its link', async () => {
    const w = await drive.writeFile(alice, `${P}/b.md`, 'hello, drive');
    assert.equal(await drive.readFile(bob, drive.byLink(w.permanent_link)), 'hello, drive');
  });
  test('an edit made outside Drive changes the hash, and the folder cursor', async () => {
    const w = await drive.writeFile(alice, `${P}/c.md`, 'as written');
    const before = (await drive.listChanges(alice, '/team-folders/Planner/h1')).cursor;
    await writeFile(join(nas.root, 'Planner/h1/today/c.md'), 'edited over SMB');
    assert.notEqual((await drive.getFile(alice, drive.byLink(w.permanent_link))).hash, w.hash);
    assert.notEqual((await drive.listChanges(alice, '/team-folders/Planner/h1')).cursor, before);
  });
  test('a missing file, a missing folder and a share that is not a Team Folder are no such file', async () => {
    for (const p of [`${P}/nope.md`, '/team-folders/Planner/h1/nofolder/x.md', '/team-folders/Other/x.md',
      // A file that is there on the share, reached by climbing out of the Team Folder.
      '/team-folders/Planner/../home/Planner/plan-2/a.txt', '/team-folders/Planner/../../home/Planner/plan-2/a.txt']) {
      await assert.rejects(() => drive.getFile(alice, p), drive.isNoSuchFile);
    }
    await assert.rejects(() => drive.writeFile(alice, '/team-folders/Planner/h1/nofolder/x.md', 'x'), drive.isNoSuchFile);
    assert.deepEqual(await drive.listTeamFolders(alice), ['Planner']);
  });
  test('search finds words under the location only, with the passage; any finds both', async () => {
    await syno.createFolder(alice, '/Planner/h2', 'today');
    await drive.writeFile(alice, `${P}/d.md`, 'the old water heater has rust');
    await drive.writeFile(alice, '/team-folders/Planner/h2/today/e.md', 'their water heater');
    const mine = await drive.search(alice, { keyword: 'Water Heater', location: '/team-folders/Planner/h1' });
    assert.deepEqual(mine.map((h) => h.name), ['d.md']);
    assert.match(mine[0]!.content_snippet, /water heater/);
    assert.equal((await drive.search(alice, { keyword: 'water heater', location: 'any' })).length, 2);
  });
  test('Drive and File Station share one disk, read either way', async () => {
    await drive.writeFile(alice, `${P}/f.md`, 'by Drive');
    assert.equal(await readFile(join(nas.root, 'Planner/h1/today/f.md'), 'utf8'), 'by Drive');
    assert.equal(new TextDecoder().decode((await syno.downloadFile(alice, '/Planner/h1/today/f.md')).bytes), 'by Drive');
    await syno.uploadFile(alice, { folder: '/Planner/h1/today', name: 'g.md', bytes: new TextEncoder().encode('by File Station') });
    assert.equal(await drive.readFile(alice, `${P}/g.md`), 'by File Station');
  });
  test('readFile: a missing path or link is no such file, and a file over the cap is refused', async () => {
    await assert.rejects(() => drive.readFile(alice, `${P}/nope.md`), drive.isNoSuchFile);
    await assert.rejects(() => drive.readFile(alice, drive.byLink('00000000-0000-0000-0000-000000000000')), drive.isNoSuchFile);
    await writeFile(join(nas.root, 'Planner/h1/big.md'), 'x'.repeat(drive.DOC_MAX_BYTES + 1));
    await assert.rejects(() => drive.readFile(alice, '/team-folders/Planner/h1/big.md'),
      (e: unknown) => e instanceof SynologyError && e.status === 413);
  });
  test('a file deleted behind Drive\'s back moves its folder\'s cursor, and is no longer there by its link', async () => {
    const w = await drive.writeFile(alice, `${P}/gone.md`, 'here for now');
    const before = (await drive.listChanges(alice, '/team-folders/Planner/h1')).cursor;
    await rm(join(nas.root, 'Planner/h1/today/gone.md'));
    assert.notEqual((await drive.listChanges(alice, '/team-folders/Planner/h1')).cursor, before);
    await assert.rejects(() => drive.getFile(alice, drive.byLink(w.permanent_link)), drive.isNoSuchFile);
  });
  test('the Team Folders are the ones it is started with', async () => {
    const other = await fakeNas({ teamFolders: ['Other'] });
    try {
      const sid = await other.signIn('carol');
      assert.deepEqual(await drive.listTeamFolders(sid, other.via), ['Other']);
      await assert.rejects(() => drive.getFile(sid, '/team-folders/Planner', other.via), drive.isNoSuchFile);
      assert.equal((await drive.getFile(sid, '/team-folders/Other', other.via)).type, 'dir');
    } finally {
      await other.close();
    }
  });
  test('Drive takes the sid as the id cookie, never in the URL', async () => {
    const res = await fetch(`${process.env['DSM_URL']}/api/SynologyDrive/default/v2/team-folder?_sid=${alice}`);
    assert.deepEqual(await res.json(), { success: false, error: { code: 119 } });
  });
});

describe('Synology Drive: folders and moves', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("a read-only Team Folder is greyed for that account only, and its members say who can write", async () => {
    const nas = await fakeNas({ teamFolders: ['Planner', 'Family'], readOnly: { alice: ['Family'] } });
    try {
      const a = await nas.signIn('alice');
      const b = await nas.signIn('bob');
      assert.deepEqual((await drive.teamFolders(a, nas.via)).map((t) => [t.name, t.canWrite]), [['Family', false], ['Planner', true]]);
      assert.deepEqual((await drive.teamFolders(b, nas.via)).map((t) => [t.name, t.canWrite]), [['Family', true], ['Planner', true]]);
      assert.deepEqual(await drive.listTeamFolders(a, nas.via), ['Family', 'Planner']);
      const members = await drive.teamFolderMembers(a, 'Family', nas.via);
      assert.equal(members.find((m) => m.name === 'alice')?.role, 'viewer');
      assert.equal(members.find((m) => m.name === 'bob')?.role, 'organizer');
      assert.equal((await drive.teamFolderMembers(a, 'Planner', nas.via)).find((m) => m.name === 'alice')?.role, 'organizer');
      // The quoted form is what the client sends; the plain form is taken too, so a probe can compare.
      assert.ok(nas.calls.some((c) => c.path.endsWith('/team-folder/members')));
      const plain = await nas.via(`${process.env['DSM_URL']}/api/SynologyDrive/default/v2/team-folder/members?team_id=Family`, { headers: { cookie: `id=${a}` } });
      assert.equal(((await plain.json()) as { data: { items: unknown[] } }).data.items.length, 3);
      await assert.rejects(() => drive.makeFolder(a, '/team-folders/Family/x', nas.via),
        (e: unknown) => e instanceof SynologyError && e.code === 105);
      await assert.rejects(() => drive.writeFile(a, '/team-folders/Family/x.md', 'x', nas.via),
        (e: unknown) => e instanceof SynologyError && e.code === 105);
      assert.equal((await drive.makeFolder(b, '/team-folders/Family/x', nas.via)).type, 'dir');
    } finally {
      await nas.close();
    }
  });

  test('a folder is made under an existing parent, once; the dir filter leaves files out', async () => {
    const nas = await fakeNas();
    try {
      const a = await nas.signIn('alice');
      const made = await drive.makeFolder(a, '/team-folders/Planner/h1', nas.via);
      assert.deepEqual([made.type, made.name, made.path, made.display_path], ['dir', 'h1', '/h1', '/team-folders/Planner/h1']);
      await drive.makeFolder(a, '/team-folders/Planner/h1/today', nas.via);
      await drive.writeFile(a, '/team-folders/Planner/h1/note.md', 'a file', nas.via);
      await assert.rejects(() => drive.makeFolder(a, '/team-folders/Planner/h1', nas.via), drive.isNameTaken);
      await assert.rejects(() => drive.makeFolder(a, '/team-folders/Planner/nope/deeper', nas.via), drive.isNoSuchFile);
      assert.deepEqual(await drive.listFolders(a, '/team-folders/Planner/h1', nas.via), ['today']);
      assert.deepEqual(await drive.listFolders(a, '/team-folders/Planner', nas.via), ['h1']);
      await assert.rejects(() => drive.listFolders(a, '/team-folders/Planner/nope', nas.via), drive.isNoSuchFile);
      // listChanges asks for a listing with no body at all, and still gets every child.
      assert.equal((await drive.listChanges(a, '/team-folders/Planner/h1', nas.via)).files.length, 2);
    } finally {
      await nas.close();
    }
  });

  test('a move is asynchronous: the file is at its new path after the delay, with its link kept', async () => {
    const nas = await fakeNas();
    try {
      const a = await nas.signIn('alice');
      nas.nas.moves.delayMs = 200;
      for (const p of ['h1', 'h1/today', 'h2', 'h2/today']) await drive.makeFolder(a, `/team-folders/Planner/${p}`, nas.via);
      const one = await drive.writeFile(a, '/team-folders/Planner/h1/today/a.md', 'kept link', nas.via);
      const task = await drive.moveFile(a, drive.byLink(one.permanent_link), '/team-folders/Planner/h2/today', nas.via);
      assert.ok(task);
      await assert.rejects(() => drive.getFile(a, '/team-folders/Planner/h2/today/a.md', nas.via), drive.isNoSuchFile);
      assert.equal(await drive.readFile(a, '/team-folders/Planner/h1/today/a.md', nas.via), 'kept link', 'still where it was');
      await sleep(500);
      const moved = await drive.getFile(a, '/team-folders/Planner/h2/today/a.md', nas.via);
      assert.equal(moved.permanent_link, one.permanent_link);
      assert.equal(moved.hash, one.hash);
      assert.equal(moved.version_id, one.version_id);
      assert.equal(await drive.readFile(a, drive.byLink(one.permanent_link), nas.via), 'kept link');
      await assert.rejects(() => drive.getFile(a, '/team-folders/Planner/h1/today/a.md', nas.via), drive.isNoSuchFile);

      // Onto a taken name: accepted like any move, and nothing changes (the real NAS, 2026-11-03).
      nas.nas.moves.delayMs = 0;
      const two = await drive.writeFile(a, '/team-folders/Planner/h1/today/b.md', 'the source', nas.via);
      const there = await drive.writeFile(a, '/team-folders/Planner/h2/today/b.md', 'already there', nas.via);
      assert.ok(await drive.moveFile(a, drive.byLink(two.permanent_link), '/team-folders/Planner/h2/today', nas.via));
      assert.equal(await drive.readFile(a, '/team-folders/Planner/h2/today/b.md', nas.via), 'already there');
      assert.equal((await drive.getFile(a, '/team-folders/Planner/h2/today/b.md', nas.via)).permanent_link, there.permanent_link);
      assert.equal(await drive.readFile(a, '/team-folders/Planner/h1/today/b.md', nas.via), 'the source');
    } finally {
      await nas.close();
    }
  });

  test('a move moves the cursor of the folder it leaves and the folder it enters', async () => {
    const nas = await fakeNas();
    try {
      const a = await nas.signIn('alice');
      for (const p of ['h1', 'h2']) await drive.makeFolder(a, `/team-folders/Planner/${p}`, nas.via);
      const w = await drive.writeFile(a, '/team-folders/Planner/h1/a.md', 'x', nas.via);
      const cursors = async () => [(await drive.listChanges(a, '/team-folders/Planner/h1', nas.via)).cursor,
        (await drive.listChanges(a, '/team-folders/Planner/h2', nas.via)).cursor];
      const before = await cursors();
      await drive.moveFile(a, '/team-folders/Planner/h1/a.md', '/team-folders/Planner/h2', nas.via);
      const now = await cursors();
      assert.notEqual(now[0], before[0]);
      assert.notEqual(now[1], before[1]);
      assert.equal((await drive.getFile(a, drive.byLink(w.permanent_link), nas.via)).display_path, '/team-folders/Planner/h2/a.md');
    } finally {
      await nas.close();
    }
  });

  test('a taken name at the destination is accepted and changes nothing, as on the real NAS; a name told to fail fails', async () => {
    const nas = await fakeNas({ teamFolders: ['Planner', 'Family'], readOnly: { alice: ['Family'] } });
    try {
      const a = await nas.signIn('alice');
      nas.nas.moves.delayMs = 200;
      for (const p of ['h1', 'h2']) await drive.makeFolder(a, `/team-folders/Planner/${p}`, nas.via);
      const x = await drive.writeFile(a, '/team-folders/Planner/h1/x.md', 'mine', nas.via);
      await drive.writeFile(a, '/team-folders/Planner/h2/x.md', 'theirs', nas.via);
      assert.ok(await drive.moveFile(a, drive.byLink(x.permanent_link), '/team-folders/Planner/h2', nas.via), 'a task id, like any move');
      await sleep(350);
      assert.equal(await drive.readFile(a, '/team-folders/Planner/h2/x.md', nas.via), 'theirs', 'never overwritten');
      assert.equal(await drive.readFile(a, '/team-folders/Planner/h1/x.md', nas.via), 'mine');

      const y = await drive.writeFile(a, '/team-folders/Planner/h1/y.md', 'why', nas.via);
      nas.nas.moves.refuse.add('y.md');
      await assert.rejects(() => drive.moveFile(a, drive.byLink(y.permanent_link), '/team-folders/Planner/h2', nas.via),
        (e: unknown) => e instanceof SynologyError && e.code === 1001);
      await assert.rejects(() => drive.moveFile(a, '/team-folders/Planner/h1/nope.md', '/team-folders/Planner/h2', nas.via), drive.isNoSuchFile);
      await assert.rejects(() => drive.moveFile(a, drive.byLink(x.permanent_link), '/team-folders/Planner/nofolder', nas.via), drive.isNoSuchFile);
      await assert.rejects(() => drive.moveFile(a, drive.byLink(x.permanent_link), '/team-folders/Family', nas.via),
        (e: unknown) => e instanceof SynologyError && e.code === 105);
    } finally {
      await nas.close();
    }
  });

  test("File Station's move takes a card's file to its new folder; a file not there is 408", async () => {
    const nas = await fakeNas();
    try {
      const a = await nas.signIn('alice');
      const bytes = new Uint8Array(2048).map((_, i) => i % 199);
      await syno.uploadFile(a, { folder: '/Planner/h1/gate', name: 'quote.pdf', bytes }, nas.via);
      await syno.createFolder(a, '/Planner/h2', 'gate', nas.via);
      assert.equal(await syno.moveOnNas(a, '/Planner/h1/gate/quote.pdf', '/Planner/h2/gate', nas.via), true);
      assert.deepEqual((await syno.downloadFile(a, '/Planner/h2/gate/quote.pdf', nas.via)).bytes, bytes);
      assert.deepEqual(await syno.listFolder(a, '/Planner/h1/gate', nas.via), []);
      await assert.rejects(() => syno.moveOnNas(a, '/Planner/h1/gate/quote.pdf', '/Planner/h2/gate', nas.via),
        (e: unknown) => e instanceof SynologyError && e.code === 408);
      // The name is taken at the destination: with overwrite=false, as the app asks, the file is
      // skipped and the task still finishes with skipstatus "all" (the real NAS), which moveOnNas
      // says as 414; nothing is overwritten and the source stays.
      await syno.uploadFile(a, { folder: '/Planner/h1/gate', name: 'quote.pdf', bytes: new Uint8Array([1]) }, nas.via);
      await assert.rejects(() => syno.moveOnNas(a, '/Planner/h1/gate/quote.pdf', '/Planner/h2/gate', nas.via),
        (e: unknown) => e instanceof SynologyError && e.code === 414);
      const { taskid } = await syno.dsm<{ taskid: string }>({
        api: 'SYNO.FileStation.CopyMove', version: syno.COPY_MOVE_VERSION, method: 'start', sid: a,
        params: { path: ['/Planner/h1/gate/quote.pdf'], dest_folder_path: '/Planner/h2/gate', overwrite: false, remove_src: true },
      }, nas.via);
      assert.deepEqual(await syno.dsm({ api: 'SYNO.FileStation.CopyMove', version: syno.COPY_MOVE_VERSION, method: 'status', sid: a, params: { taskid } }, nas.via),
        { finished: true, found_file_num: 0, total: 0, path: '', progress: 1, taskid, skipstatus: { status: 'all' } });
      assert.deepEqual((await syno.downloadFile(a, '/Planner/h2/gate/quote.pdf', nas.via)).bytes, bytes);
      assert.deepEqual(await syno.listFolder(a, '/Planner/h1/gate', nas.via), [{ name: 'quote.pdf', size: 1, isdir: false }]);
      // With overwrite left out: 414.
      await assert.rejects(() => syno.dsm({
        api: 'SYNO.FileStation.CopyMove', version: syno.COPY_MOVE_VERSION, method: 'start', sid: a,
        params: { path: ['/Planner/h1/gate/quote.pdf'], dest_folder_path: '/Planner/h2/gate', remove_src: true },
      }, nas.via), (e: unknown) => e instanceof SynologyError && e.code === 414);
      // CopyMove is among the APIs the NAS offers, at the version the client asks for.
      const info = await syno.dsm<Record<string, { minVersion: number; maxVersion: number }>>(
        { api: 'SYNO.API.Info', version: 1, method: 'query', sid: a }, nas.via);
      assert.deepEqual(info['SYNO.FileStation.CopyMove'], { path: 'entry.cgi', minVersion: 1, maxVersion: syno.COPY_MOVE_VERSION });
    } finally {
      await nas.close();
    }
  });
});

describe('who is an administrator, on the fake', () => {
  test('the fourth field makes an admin', () => {
    assert.deepEqual(parseAccounts('alice:correct-horse::admin,bob:b')['alice'], { password: 'correct-horse', otp: null, admin: true });
    assert.equal(parseAccounts('bob:b')['bob']!.admin, false);
  });

  test('the administrators group answers an admin, and refuses anyone else', async () => {
    const other = await fakeNas({ admins: ['carol'] });
    try {
      assert.equal(await isAdministrator(await other.signIn('carol'), 'carol', other.via), true);
      assert.equal(await isAdministrator(await other.signIn('alice'), 'alice', other.via), false);
      assert.deepEqual((await listAccounts(await other.signIn('carol'), other.via)).sort(), ['alice', 'bob', 'carol']);
      const plain = await other.signIn('alice');
      await assert.rejects(() => listAccounts(plain, other.via), SynologyError);
    } finally {
      await other.close();
    }
  });

  /** What `run` warned, one string per call. */
  const warned = async (run: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try { await run(); } finally { console.warn = warn; }
    return lines;
  };

  test('a plain refusal (105) is silent, any other failure is false with one warning that names the account and the code', async () => {
    const other = await fakeNas({ admins: ['carol'] });
    try {
      const carol = await other.signIn('carol');
      const alice = await other.signIn('alice');
      assert.deepEqual(await warned(async () => {
        assert.equal(await isAdministrator(alice, 'alice', other.via), false);
      }), [], 'a member who is not an administrator is the normal case');

      other.fail((_method, path) => path === 'entry.cgi:SYNO.Core.Group.Member.list', 3000);
      const lines = await warned(async () => {
        assert.equal(await isAdministrator(carol, 'carol', other.via), false);
      });
      assert.deepEqual(lines, ['[budget] could not ask DSM whether carol is an administrator: code 3000']);
      assert.ok(!lines.join('\n').includes(carol), 'the sid is never in the warning');
      other.ok();

      const down = (async () => { throw new TypeError('boom'); }) as unknown as typeof fetch;
      const unreachable = await warned(async () => {
        assert.equal(await isAdministrator(carol, 'carol', down), false);
      });
      assert.deepEqual(unreachable, ['[budget] could not ask DSM whether carol is an administrator: code 0']);
      assert.ok(!unreachable.join('\n').includes(carol));
    } finally {
      await other.close();
    }
  });
});
