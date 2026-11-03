// api/test/folders.test.ts
import './planner-root.ts';
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { ProposalStore } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { ToolError } from '../src/errors.ts';
import { makeFolder, writeFile } from '../src/drive.ts';
import { attach } from '../src/attachments.ts';
import { movePass } from '../src/moves.ts';
import {
  TAKEN, checkFolder, chooseFolder, cleanFolder, folderOf, pickerFolders, pickerTeams, rememberFolder, takenBy,
} from '../src/folders.ts';
import { fakeNas } from './fake-nas.ts';
import type { FakeNas } from './fake-nas.ts';

const NOW = '2026-11-02T09:00:00Z';
const TODAY = '2026-11-02';
/** Where `POST files` makes a folder. */
const MAKE = '/api/SynologyDrive/default/v2/files';

/** A household claimed by alice, with bob a member. */
async function household(): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-folders-')), 'events.jsonl');
  const s = new Store({ path, now: () => new Date(NOW) });
  await s.load();
  await s.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
  ]);
  return s;
}

type HouseholdContext = ToolContext & { readonly household: string };
const contextFor = (store: Store, who: string, sid: string, household: string): HouseholdContext =>
  ({ store, who, today: TODAY, proposals: new ProposalStore(), sid, household });

let nas: FakeNas;
let alice: string;
let ctx: HouseholdContext;

before(async () => {
  nas = await fakeNas({ teamFolders: ['Planner', 'Family'], readOnly: { alice: ['Family'] } });
  alice = await nas.signIn('alice');
  ctx = contextFor(await household(), 'alice', alice, 'h1');
});
after(async () => { await nas.close(); });

describe('the picker', () => {
  test("the deployment's Team Folder comes first and is marked; a read-only one is listed, not writable", async () => {
    assert.deepEqual(await pickerTeams(alice, nas.via), [
      { name: 'Planner', canWrite: true, fromDeployment: true }, { name: 'Family', canWrite: false, fromDeployment: false }]);
  });

  test('folders in it, and a name suggested from the label that is not taken', async () => {
    await makeFolder(alice, '/team-folders/Planner/the-riveras', nas.via);
    assert.deepEqual(await pickerFolders(alice, 'Planner', "The Rivera's", nas.via), { folders: ['the-riveras'], suggested: 'the-riveras-2' });
  });

  test('what is typed is made clean, or refused in words, before the NAS is asked', () => {   // Review Focus 3
    assert.deepEqual(cleanFolder({ team: ' Planner ', folder: '/home//riveras/ ' }), { team: 'Planner', folder: 'home/riveras' });
    for (const folder of ['', '/', 'a/../b', 'a,b', '100%']) assert.ok('problem' in cleanFolder({ team: 'Planner', folder }), folder);
    assert.ok('problem' in cleanFolder({ team: 'a/b', folder: 'x' }));
    assert.deepEqual(cleanFolder({ team: ' ', folder: 'x' }), { problem: 'choose a Team Folder' });
    assert.deepEqual(cleanFolder({ folder: 'x' }), { problem: 'choose a Team Folder' });
    assert.deepEqual(cleanFolder({ team: 'Planner', folder: ' / ' }), { problem: 'name a folder in it' });
    assert.deepEqual(cleanFolder({ team: 'Planner', folder: 'a/../b' }), { problem: 'the folder cannot be . or contain ..' });
  });

  test("checks: a folder in a Team Folder you can write, with no other household's in the way", async () => {
    const ok = await checkFolder(alice, { team: 'Planner', folder: 'h1' }, { household: 'h1', members: ['alice', 'bob'] }, nas.via);
    assert.deepEqual([ok.teamFolder, ok.writable, ok.indexed, ok.problems], [true, true, null, []]);
    const ro = await checkFolder(alice, { team: 'Family', folder: 'h1' }, { household: 'h1', members: ['alice'] }, nas.via);
    assert.match(ro.problems.join(' '), /You cannot write to Family/);
    const plain = await checkFolder(alice, { team: 'Shared', folder: 'h1' }, { household: 'h1', members: ['alice'] }, nas.via);
    assert.match(plain.problems.join(' '), /Shared is not a Team Folder\. A shared folder not listed here/);
  });

  test('the index is known once a page is there', async () => {
    await makeFolder(alice, '/team-folders/Planner/indexed', nas.via);
    await writeFile(alice, '/team-folders/Planner/indexed/page.md', '---\nplanner: 1\n---\n# A page\n', nas.via);
    const r = await checkFolder(alice, { team: 'Planner', folder: 'indexed' }, { household: 'h1', members: ['alice'] }, nas.via);
    assert.equal(r.indexed, true);
    // A hit by its name only, with no words to show: names only.
    await makeFolder(alice, '/team-folders/Planner/names', nas.via);
    await writeFile(alice, '/team-folders/Planner/names/planner.md', 'nothing to see\n', nas.via);
    const n = await checkFolder(alice, { team: 'Planner', folder: 'names' }, { household: 'h1', members: ['alice'] }, nas.via);
    assert.equal(n.indexed, false);
  });

  test('a member who cannot write there is named, and does not block', async () => {
    const other = await fakeNas({ teamFolders: ['Planner'], readOnly: { bob: ['Planner'] } });
    try {
      const sid = await other.signIn('alice');
      const r = await checkFolder(sid, { team: 'Planner', folder: 'h1' }, { household: 'h1', members: ['alice', 'bob'] }, other.via);
      assert.deepEqual(r.cannotWrite, ['bob']);
      assert.equal(r.membersKnown, true);
      assert.deepEqual(r.problems, []);
    } finally {
      await other.close();
    }
  });

  test('a members list or a search the NAS refuses is not known, and does not block', async () => {
    nas.fail((method, path) => path === `${MAKE}/search` || path === `${MAKE.replace(/files$/, '')}team-folder/members`, 1001);
    try {
      // A folder with a page in it, so the search is really asked.
      const r = await checkFolder(alice, { team: 'Planner', folder: 'indexed' }, { household: 'h7', members: ['alice', 'bob'] }, nas.via);
      assert.deepEqual([r.problems, r.membersKnown, r.indexed, r.cannotWrite], [[], false, null, []]);
      const chosen = contextFor(await household(), 'alice', alice, 'h7');
      const [e] = await chooseFolder(chosen, { team: 'Planner', folder: 'advisory/h7' }, nas.via);
      assert.equal(e!.op, 'documents.folder');
      assert.deepEqual(folderOf('h7'), { team: 'Planner', folder: 'advisory/h7' });
    } finally {
      nas.ok();
    }
  });

  test("another household's folder, one inside it, or one around it, is refused without naming it", async () => {
    rememberFolder('h2', { team: 'Planner', folder: 'home/h2' });
    for (const folder of ['home/h2', 'home/h2/sub', 'home', 'HOME/H2']) {
      assert.equal(takenBy({ team: 'Planner', folder }, 'h1'), 'h2', folder);
    }
    assert.equal(takenBy({ team: 'Planner', folder: 'home/h22' }, 'h1'), null);
    assert.equal(takenBy({ team: 'Family', folder: 'home/h2' }, 'h1'), null);
    assert.equal(takenBy({ team: 'Planner', folder: 'home/h2' }, 'h2'), null, "a household's own folder is not taken from it");
    const r = await checkFolder(alice, { team: 'Planner', folder: 'home' }, { household: 'h1', members: ['alice'] }, nas.via);
    assert.deepEqual(r.problems, [TAKEN]);
    rememberFolder('h2', null);
    assert.equal(folderOf('h2'), null);
    assert.equal(takenBy({ team: 'Planner', folder: 'home' }, 'h1'), null);
  });

  test('choosing makes the folder, segment by segment, logs it as the owner, and remembers it', async () => {
    const from = nas.calls.length;
    const [e] = await chooseFolder(ctx, { team: 'Planner', folder: 'homes/h1' }, nas.via);
    assert.deepEqual([e!.op, e!.who], ['documents.folder', 'alice']);
    assert.equal(nas.calls.slice(from).filter((c) => c.method === 'POST' && c.path === MAKE).length, 2, 'homes, then homes/h1');
    assert.ok(existsSync(join(nas.nas.root, 'Planner/homes/h1')));
    assert.deepEqual(folderOf('h1'), { team: 'Planner', folder: 'homes/h1' });
    assert.deepEqual([ctx.store.state.documents.folder?.team, ctx.store.state.documents.folder?.folder], ['Planner', 'homes/h1']);
  });

  test('a choice the log refuses leaves the registry as it was', async () => {
    rememberFolder('h6', { team: 'Planner', folder: 'old6' });
    // h6 had a folder, h8 none: each is left as it was.
    for (const [id, before] of [['h6', { team: 'Planner', folder: 'old6' }], ['h8', null]] as const) {
      const store = await household();
      mock.method(store, 'append', async () => { throw new Error('the disk is full'); });
      const failing = contextFor(store, 'alice', alice, id);
      await assert.rejects(() => chooseFolder(failing, { team: 'Planner', folder: `new-${id}` }, nas.via), /the disk is full/);
      assert.deepEqual(folderOf(id), before, id);
    }
    rememberFolder('h6', null);
  });

  test('two households racing for nested folders: exactly one wins', async () => {
    const [a, b] = [contextFor(await household(), 'alice', alice, 'h9'), contextFor(await household(), 'alice', alice, 'h10')];
    // The shared parent is there already, so the race is for the registry, not for one mkdir.
    await makeFolder(alice, '/team-folders/Planner/race', nas.via);
    const results = await Promise.allSettled([
      chooseFolder(a, { team: 'Planner', folder: 'race' }, nas.via),
      chooseFolder(b, { team: 'Planner', folder: 'race/inner' }, nas.via),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(won.length, 1);
    assert.ok(lost[0]!.reason instanceof ToolError && lost[0]!.reason.status === 409 && lost[0]!.reason.message === TAKEN);
    const registered = [folderOf('h9'), folderOf('h10')].filter((x) => x !== null);
    assert.equal(registered.length, 1);
    assert.equal([a, b].filter((c) => c.store.state.documents.folder !== null).length, 1);
  });

  test('choosing a refused folder makes nothing and logs nothing', async () => {
    const store = await household();
    const refused = contextFor(store, 'alice', alice, 'h3');
    const from = nas.calls.length;
    // Typed with a step up: refused in words before the NAS is asked anything.
    await assert.rejects(() => chooseFolder(refused, { team: 'Planner', folder: 'a/../b' }, nas.via),
      (err: unknown) => err instanceof ToolError && err.status === 400);
    assert.equal(nas.calls.length, from);
    await assert.rejects(() => chooseFolder(refused, { team: 'Family', folder: 'h3' }, nas.via),
      (err: unknown) => err instanceof ToolError && err.status === 409 && /You cannot write to Family/.test(err.message));
    assert.equal(existsSync(join(nas.nas.root, 'Family/h3')), false);
    // Not the owner: refused before the NAS is asked.
    const bob = contextFor(store, 'bob', await nas.signIn('bob'), 'h3');
    await assert.rejects(() => chooseFolder(bob, { team: 'Planner', folder: 'bobs' }, nas.via),
      (err: unknown) => err instanceof ToolError && err.status === 403 && err.message === 'only alice can change this');
    assert.equal(existsSync(join(nas.nas.root, 'Planner/bobs')), false);
    assert.equal(nas.calls.slice(from).filter((c) => c.method === 'POST' && c.path === MAKE).length, 0);
    assert.equal(store.state.documents.folder, null);
    assert.equal(folderOf('h3'), null);
  });

  test('while files wait to move, the folder being left stays taken; the last move lets it go', async () => {
    const store = await household();
    await store.append('alice', { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' });
    const owner = contextFor(store, 'alice', alice, 'h11');
    await chooseFolder(owner, { team: 'Planner', folder: 'leaving11' }, nas.via);
    await attach(owner, 'gate', { name: 'quote.pdf', bytes: new Uint8Array(5) }, nas.via);
    await chooseFolder(owner, { team: 'Planner', folder: 'staying11' }, nas.via);
    assert.equal(store.state.documents.waiting.size, 1);
    assert.deepEqual(folderOf('h11'), { team: 'Planner', folder: 'staying11' });
    for (const folder of ['leaving11', 'leaving11/sub', 'staying11']) {
      assert.equal(takenBy({ team: 'Planner', folder }, 'h12'), 'h11', folder);
    }
    const r = await checkFolder(alice, { team: 'Planner', folder: 'leaving11' }, { household: 'h12', members: ['alice'] }, nas.via);
    assert.deepEqual(r.problems, [TAKEN]);
    await movePass(owner, nas.via);
    assert.equal(store.state.documents.waiting.size, 0);
    assert.equal(takenBy({ team: 'Planner', folder: 'leaving11' }, 'h12'), null, 'let go');
    assert.equal(takenBy({ team: 'Planner', folder: 'staying11' }, 'h12'), 'h11');
    rememberFolder('h11', null);
  });

  test('a change with nothing to move holds only the new folder', async () => {
    const owner = contextFor(await household(), 'alice', alice, 'h13');
    await chooseFolder(owner, { team: 'Planner', folder: 'first13' }, nas.via);
    await chooseFolder(owner, { team: 'Planner', folder: 'second13' }, nas.via);
    assert.equal(takenBy({ team: 'Planner', folder: 'first13' }, 'h12'), null);
    rememberFolder('h13', null);
  });
});
