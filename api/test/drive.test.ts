// api/test/drive.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDsm } from './fake-dsm-fetch.ts';
import {
  getFile, writeFile, search, listChanges, listTeamFolders, teamFolderPath, teamFolderName, isNoSuchFile,
  teamFolders, teamFolderMembers, listFolders, makeFolder, moveFile, isNameTaken,
} from '../src/drive.ts';
import { SessionLost, SynologyError } from '../src/synology.ts';

const FILE = { file_id: '881', permanent_link: 'f3c1', name: 'a.md', path: '/team-folders/Planner/h1/today/a.md',
  display_path: '/team-folders/Planner/h1/today/a.md', type: 'file', hash: 'abc', version_id: 7,
  change_id: 12, max_id: 12, modified_time: 1762000000, removed: false };

describe('Drive: one file', () => {
  test('getFile asks by path, with the sid as the id cookie and never in the URL', async () => {
    const d = fakeDsm({ success: true, data: FILE });
    const got = await getFile('S3CRET', 'link:f3c1', d.fn);
    assert.equal(d.calls[0]!.method, 'GET');
    assert.match(d.calls[0]!.url, /\/api\/SynologyDrive\/default\/v2\/files\?path=link%3Af3c1$/);
    assert.equal(d.calls[0]!.headers.get('cookie'), 'id=S3CRET');
    assert.doesNotMatch(d.calls[0]!.url, /S3CRET/);
    assert.equal(got.version_id, '7');
    assert.equal(got.content_snippet, '');
  });
  test('writeFile is the multipart upload with conflict_action version, the file part last', async () => {
    const d = fakeDsm({ success: true, data: FILE });
    await writeFile('S3CRET', '/team-folders/Planner/h1/today/a.md', '# Hello\n', d.fn);
    const c = d.calls[0]!;
    assert.equal(c.method, 'PUT');
    assert.match(c.url, /\/files\/upload$/);
    assert.match(c.headers.get('content-type') ?? '', /^multipart\/form-data; boundary=/);
    assert.match(c.body, /name="path"\r\n\r\n\/team-folders\/Planner\/h1\/today\/a\.md\r\n/);
    assert.match(c.body, /name="conflict_action"\r\n\r\nversion\r\n/);
    assert.ok(c.body.lastIndexOf('name="file"') > c.body.lastIndexOf('name="conflict_action"'));
    assert.match(c.body, /filename="a\.md"/);
    assert.match(c.body, /# Hello/);
    assert.doesNotMatch(c.body, /S3CRET/, 'the sid is the cookie, not a part');
  });
  test('a refusal at HTTP 200 is a SynologyError with its code', async () => {
    const d = fakeDsm({ success: false, error: { code: 1002 } });
    await assert.rejects(() => getFile('S', '/team-folders/Planner/x', d.fn),
      (e: unknown) => e instanceof SynologyError && e.code === 1002 && e.api === 'SYNO.SynologyDrive.Files');
  });
  test('a session that ended is SessionLost', async () => {
    const d = fakeDsm({ success: false, error: { code: 119 } });
    await assert.rejects(() => writeFile('S', '/team-folders/Planner/x.md', 'x', d.fn), SessionLost);
  });
});

describe('Drive: folders and moves', () => {
  test('a folder is made with POST files, type folder, stop on a taken name', async () => {
    const d = fakeDsm({ success: true, data: { ...FILE, type: 'dir' } });
    const made = await makeFolder('S', '/team-folders/Planner/home', d.fn);
    assert.equal(made.type, 'dir');
    assert.equal(d.calls[0]!.method, 'POST');
    assert.match(d.calls[0]!.url, /\/files\?path=%2Fteam-folders%2FPlanner%2Fhome&type=folder&conflict_action=stop$/);
    assert.equal(d.calls[0]!.body, '{}');
    assert.equal(d.calls[0]!.headers.get('cookie'), 'id=S');
  });
  test('a move is by link, to a parent, and never overwrites', async () => {
    const d = fakeDsm({ success: true, data: { async_task_id: 'task-12' } });
    assert.equal(await moveFile('S', 'link:f3c1', '/team-folders/Planner/home/today', d.fn), 'task-12');
    assert.equal(d.calls[0]!.method, 'POST');
    assert.match(d.calls[0]!.url, /\/files\/move$/);
    assert.deepEqual(JSON.parse(d.calls[0]!.body), { files: ['link:f3c1'], to_parent_folder: '/team-folders/Planner/home/today', conflict_action: 'stop' });
  });
  test('a name already taken is a refusal Drive gives at once', async () => {
    const d = fakeDsm({ success: false, error: { code: 1003 } });
    await assert.rejects(() => moveFile('S', 'link:f3c1', '/team-folders/Planner/h2', d.fn), isNameTaken);
  });
});

describe('Drive: many files', () => {
  test('search sends the words, the location and asks for the passage', async () => {
    const d = fakeDsm({ success: true, data: { total: 1, items: [{ ...FILE, content_snippet: 'the <b>water heater</b>' }] } });
    const hits = await search('S', { keyword: 'water heater', location: '/team-folders/Planner/h1', limit: 20 }, d.fn);
    assert.equal(d.calls[0]!.method, 'POST');
    assert.match(d.calls[0]!.url, /\/files\/search\?limit=20$/);
    assert.deepEqual(JSON.parse(d.calls[0]!.body), { keyword: 'water heater', location: '/team-folders/Planner/h1', content_snippet: true });
    assert.equal(hits[0]!.content_snippet, 'the <b>water heater</b>');
  });
  test('listChanges reads the folder for its cursor, then lists it', async () => {
    let n = 0;
    const replies = [{ success: true, data: { ...FILE, type: 'dir', change_id: 12, max_id: 40 } },
                     { success: true, data: { total: 1, items: [FILE] } }];
    const fn = (async (url: string, init?: RequestInit) => fakeDsm(replies[n++]).fn(url, init)) as typeof fetch;
    const got = await listChanges('S', '/team-folders/Planner/h1', fn);
    assert.equal(got.cursor, '12.40');
    assert.equal(got.files.length, 1);
  });
  test('Team Folders are listed by name', async () => {
    const d = fakeDsm({ success: true, data: { total: 1, items: [{ name: 'Planner', file_id: '1', team_id: 't' }] } });
    assert.deepEqual(await listTeamFolders('S', d.fn), ['Planner']);
    assert.match(d.calls[0]!.url, /\/team-folder$/);
  });
  test('Team Folders come with whether you can write; folders are listed by the dir filter', async () => {
    const t = fakeDsm({ success: true, data: { total: 2, items: [
      { name: 'Planner', file_id: '1', team_id: '4', capabilities: { can_read: true, can_write: true } },
      { name: 'Family', file_id: '2', team_id: '5', capabilities: { can_read: true, can_write: false } },
      { name: 'Bare', file_id: '3', team_id: '6' },
    ] } });
    assert.deepEqual(await teamFolders('S', t.fn), [
      { name: 'Planner', team_id: '4', canWrite: true },
      { name: 'Family', team_id: '5', canWrite: false },
      { name: 'Bare', team_id: '6', canWrite: false },
    ]);
    assert.equal(t.calls[0]!.method, 'GET');
    assert.match(t.calls[0]!.url, /\/team-folder$/);
    assert.equal(t.calls[0]!.headers.get('cookie'), 'id=S');
    assert.deepEqual(await listTeamFolders('S', fakeDsm({ success: true, data: { items: [{ name: 'A' }, { name: 'B' }] } }).fn), ['A', 'B']);

    const l = fakeDsm({ success: true, data: { total: 2, items: [{ ...FILE, name: 'home', type: 'dir' }, { ...FILE, name: 'shared', type: 'dir' }] } });
    assert.deepEqual(await listFolders('S', '/team-folders/Planner', l.fn), ['home', 'shared']);
    assert.equal(l.calls[0]!.method, 'POST');
    assert.match(l.calls[0]!.url, /\/files\/list\?path=%2Fteam-folders%2FPlanner$/);
    assert.deepEqual(JSON.parse(l.calls[0]!.body), { filter: { type: ['dir'] } });
  });
  test('the members of a Team Folder are asked for by its team_id', async () => {
    const d = fakeDsm({ success: true, data: { total: 2, items: [
      { name: 'alice', uid: 1026, display_name: 'Alice', role: 'organizer' }, { name: 'bob', uid: 1027, display_name: 'Bob', role: 'viewer' }] } });
    assert.deepEqual(await teamFolderMembers('S', '4', d.fn), [{ name: 'alice', role: 'organizer' }, { name: 'bob', role: 'viewer' }]);
    assert.equal(d.calls[0]!.method, 'GET');
    assert.match(d.calls[0]!.url, /\/team-folder\/members\?team_id=%224%22$/, 'the spec types team_id double-quoted-string');
  });
  test('a taken name is the code Drive gives for it, and no other', () => {
    assert.equal(isNameTaken(new SynologyError('x', 'SYNO.SynologyDrive.Files', 1003)), true);
    assert.equal(isNameTaken(new SynologyError('x', 'SYNO.SynologyDrive.Files', 1002)), false);
    assert.equal(isNameTaken(new Error('1003')), false);
  });
  test('the share as Drive addresses it', () => {
    assert.equal(teamFolderPath('/Planner'), '/team-folders/Planner');
    assert.equal(teamFolderPath('/Planner/home/'), '/team-folders/Planner/home');
    assert.equal(teamFolderName('/Planner/home'), 'Planner');
  });
  test('no such file is named as such', () => {
    assert.equal(isNoSuchFile(new SynologyError('x', 'SYNO.SynologyDrive.Files', 1002)), true);
    assert.equal(isNoSuchFile(new SynologyError('x', 'SYNO.SynologyDrive.Files', 1003)), false);
  });
});
