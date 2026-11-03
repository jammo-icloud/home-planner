// api/test/docs.test.ts
import './planner-root.ts';
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { ReplayError } from '../src/replay.ts';
import { CLAUDE } from '../src/types.ts';
import {
  ANSWER_HEADLINE_MAX, DocGone, answerHeadline, answerTextFrom, briefingBodyFrom, briefingFile, documentsStatus,
  householdFolder, inHousehold, readDoc, renderAnswerPage, renderBriefingPage, teamFolderKnown, writeDoc,
} from '../src/docs.ts';
import type { DriveFile } from '../src/drive.ts';
import { NeedsDsm } from '../src/synology.ts';
import { fakeNas } from './fake-nas.ts';
import type { FakeNas } from './fake-nas.ts';
import { chooseFolderIn } from './folder.ts';

const NOW = '2026-11-02T09:00:00Z';

/** A household claimed by alice. */
async function household(): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-docs-')), 'events.jsonl');
  const s = new Store({ path, now: () => new Date(NOW) });
  await s.load();
  await s.append('alice', { op: 'household.claim', label: 'Home' });
  return s;
}

/** A write the log must refuse as a ReplayError (never a TypeError), leaving nothing behind. */
async function refused(s: Store, op: Record<string, unknown>, message: RegExp, who: string = CLAUDE): Promise<void> {
  const before = (await s.since(null)).length;
  await assert.rejects(() => s.append(who, op as never),
    (e: unknown) => e instanceof ReplayError && message.test(e.message), JSON.stringify(op));
  assert.equal((await s.since(null)).length, before, 'nothing was written');
}

const DOC = { link: 'f3c1', file_id: '881', hash: 'abc', version_id: '1', path: '/team-folders/Planner/h1/today/2026-11-02-household.md' };
const brief = (x: Record<string, unknown>) => ({ op: 'thread.briefing', day: '2026-11-02', source: 'household', budget: null,
  headline: 'Quiet day', writtenBy: 'fallback', ...x });

describe('the doc pointer', () => {
  test('a briefing with a doc and no body replays, and an old one with its body still does', async () => {
    const s = await household();
    await s.append(CLAUDE, [brief({ body: 'Inline, as before.' }), brief({ doc: DOC })] as never);
    await s.load();
    assert.equal(s.loadReport.skipped.length, 0);
    const briefings = (await s.since(null)).filter((e) => e.op === 'thread.briefing');
    assert.equal(briefings.length, 2);
  });
  test('a briefing with neither, or both, is refused', async () => {
    const s = await household();
    await refused(s, brief({}), /one or the other/);
    await refused(s, brief({ body: 'x', doc: DOC }), /one or the other/);
  });
  test('a doc names its link, file id, hash, version and path', async () => {
    const s = await household();
    await refused(s, brief({ doc: { ...DOC, link: '' } }), /a document is named by/);
    await refused(s, brief({ doc: { ...DOC, version_id: 1 } }), /a document is named by/);
    await refused(s, brief({ doc: 'f3c1' }), /a document is named by/);
  });
  test('an answer may carry a doc beside its headline, and a bad one is refused', async () => {
    const s = await household();
    const [q] = await s.append('alice', { op: 'thread.ask', question: 'Why?', budget: null });
    const answer = { op: 'thread.answer', replyTo: q!.id, text: 'Because.', tools: [], model: 'm' };
    await s.append(CLAUDE, { ...answer, doc: DOC } as never);
    await refused(s, { ...answer, doc: { ...DOC, hash: '' } }, /a document is named by/);
  });
});

describe('the pages', () => {
  const B = { day: '2026-11-02', source: 'household', budget: null, writtenBy: 'claude', headline: 'Quiet day', body: 'Nothing moved.' } as const;
  const A = { replyTo: 'mvsyzlo0-000260', plan: null, model: 'claude-x', question: 'Why is the gate stuck?', text: 'Because it sagged.', tools: [] as string[] };

  test('a briefing page, exactly', () => {
    assert.equal(renderBriefingPage(B),
      '---\nplanner: 1\nkind: briefing\nday: 2026-11-02\nsource: household\nbudget: null\nwrittenBy: claude\n---\n\n# Quiet day\n\nNothing moved.\n');
  });
  test('a briefing page is the same bytes every time', () => {
    assert.equal(renderBriefingPage(B), renderBriefingPage({ ...B }));
  });
  test('the body reads back from the page', () => {
    const bodies = ['Nothing moved.', 'Intro\n\n# A heading of its own\n\nMore.', '# Starts with one', 'Two\n\nparagraphs\n', '', '\nleading blank'];
    for (const body of bodies) {
      assert.equal(briefingBodyFrom(renderBriefingPage({ ...B, body })), body, JSON.stringify(body));
    }
    assert.equal(briefingBodyFrom(renderBriefingPage({ ...B, budget: 'nm', source: 'budget', headline: '2026', body: 'x' })), 'x');
  });
  test('an answer page ends with the tools it used, and reads back whole', () => {
    const page = renderAnswerPage({ ...A, plan: 'gate-1', tools: ['get_month', 'get_plan', 'get_month'] });
    assert.ok(page.startsWith('---\nplanner: 1\nkind: answer\nreplyTo: mvsyzlo0-000260\nplan: gate-1\nmodel: claude-x\n---\n\n# Why is the gate stuck?\n\nBecause it sagged.\n'));
    assert.ok(page.endsWith('\n## Tools\n- get_month\n- get_plan\n'), page);
    assert.equal(page.split('- get_month').length, 2, 'a tool is listed once');
    assert.equal(answerTextFrom(page), 'Because it sagged.');
    const bare = renderAnswerPage(A);
    assert.ok(!bare.includes('## Tools'));
    assert.equal(answerTextFrom(bare), 'Because it sagged.');
    const rich = 'Para one.\n\n# Not a title\n\n## Other section\n- item';
    assert.equal(answerTextFrom(renderAnswerPage({ ...A, text: rich, tools: ['get_month'] })), rich);
  });
  test("an answer's own Tools heading is not mistaken for the page's", () => {
    const own = 'Before.\n\n## Tools\nnot a list\n';
    assert.equal(answerTextFrom(renderAnswerPage({ ...A, text: own, tools: [] })), own, 'no tools: whole');
    assert.equal(answerTextFrom(renderAnswerPage({ ...A, text: 'Before.\n\n## Tools\nnot a list', tools: [] })), 'Before.\n\n## Tools\nnot a list');
    const withTools = 'Before.\n\n## Tools\n- looks like one\n\nAfter.';
    assert.equal(answerTextFrom(renderAnswerPage({ ...A, text: withTools, tools: ['get_month'] })), withTools, 'tools: real section removed');
    assert.equal(answerTextFrom(renderAnswerPage({ ...A, text: own, tools: ['get_month', 'get_plan'] })), own);
  });
  test("an answer's headline is its first paragraph, cut at a word past 280", () => {
    assert.equal(ANSWER_HEADLINE_MAX, 280);
    assert.equal(answerHeadline('One.\n\nTwo.'), 'One.');
    assert.equal(answerHeadline('  Short.  '), 'Short.');
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const h = answerHeadline(long);
    assert.ok(h.length <= ANSWER_HEADLINE_MAX + 1, String(h.length));
    assert.ok(h.endsWith('…'));
    assert.ok(long.startsWith(h.slice(0, -1)));
    assert.match(long.slice(h.length - 1), /^ /, 'cut at a word boundary');
    const exact = 'x'.repeat(280);
    assert.equal(answerHeadline(exact), exact);
    assert.equal(answerHeadline('y'.repeat(400)), 'y'.repeat(280) + '…');
  });
  test('file names', () => {
    assert.equal(briefingFile('2026-11-02', 'household', null), '2026-11-02-household.md');
    assert.equal(briefingFile('2026-11-02', 'budget', 'nm'), '2026-11-02-budget-nm.md');
  });
});

describe('writing and reading documents', () => {
  let nas: FakeNas;
  /** alice's household, its documents in Planner/h1. */
  let home: Store;
  before(async () => {
    nas = await fakeNas();
    home = await household();
    await chooseFolderIn(home);
  });
  after(async () => { await nas.close(); });

  test('without a folder nothing is asked of Drive, and the words stay in the log', async () => {
    const s = await household();
    const before = nas.calls.length;
    assert.equal(await writeDoc({ sid: await nas.signIn('alice'), household: 'h1', store: s }, ['today', 'x.md'], 'x', nas.via), null);
    assert.equal(nas.calls.length, before);
    assert.match((await documentsStatus({ sid: 'S', household: 'h1', store: s }, nas.via)).why!, /until alice chooses where documents live/);
  });
  test('the home is the chosen folder, wherever PLANNER_ROOT points', async () => {
    const s = await household();
    await chooseFolderIn(s, { team: 'Planner', folder: 'homes/riveras' });
    const doc = await writeDoc({ sid: await nas.signIn('alice'), household: 'h1', store: s }, ['today', 'x.md'], 'x', nas.via);
    assert.equal(doc!.path, '/team-folders/Planner/homes/riveras/today/x.md');
  });
  test("a document goes under the household's folder, a new version each time", async () => {
    const a = { sid: await nas.signIn('alice'), household: 'h1', store: home };
    const one = await writeDoc(a, ['today', 'x.md'], 'one', nas.via);
    const two = await writeDoc(a, ['today', 'x.md'], 'two', nas.via);
    assert.equal(one!.path, '/team-folders/Planner/h1/today/x.md');
    assert.equal(two!.link, one!.link);
    assert.deepEqual([one!.version_id, two!.version_id], ['1', '2']);
    assert.equal(await readFile(join(nas.nas.root, 'Planner/h1/today/x.md'), 'utf8'), 'two');
  });
  test('no session or no household writes nothing, and says so with null', async () => {
    const before = nas.calls.length;
    assert.equal(await writeDoc({ sid: null, household: 'h1', store: home }, ['today', 'x.md'], 'x', nas.via), null);
    assert.equal(await writeDoc({ sid: 'S', store: home }, ['today', 'x.md'], 'x', nas.via), null);
    assert.equal(nas.calls.length, before);
  });
  test('a refusal from Drive is null, not an error', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const sid = await nas.signIn('alice');
    nas.fail((m, p) => m === 'PUT' && p.endsWith('/files/upload'), 1000);
    try {
      assert.equal(await writeDoc({ sid, household: 'h1', store: home }, ['today', 'y.md'], 'y', nas.via), null);
      const said = String(warn.mock.calls[0]?.arguments[0]);
      assert.match(said, /^\[docs\] kept in the log: \/team-folders\/Planner\/h1\/today\/y\.md \(/);
      assert.ok(!said.includes(sid), 'the sid is not in the log line');
    } finally {
      nas.ok();
      warn.mock.restore();
    }
  });
  test('a folder deleted on the NAS is made again on the next write, not left unwritable until a restart', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const a = { sid: await nas.signIn('alice'), household: 'h1', store: home };
      assert.ok(await writeDoc(a, ['shed', 'plan.md'], 'one', nas.via));
      await rm(join(nas.nas.root, 'Planner/h1/shed'), { recursive: true });
      // This process made the folder once, so it writes straight to it: Drive says no such folder.
      assert.equal(await writeDoc(a, ['shed', 'plan.md'], 'two', nas.via), null);
      const again = await writeDoc(a, ['shed', 'plan.md'], 'three', nas.via);
      assert.ok(again, 'the folder is made again');
      assert.equal(await readFile(join(nas.nas.root, 'Planner/h1/shed/plan.md'), 'utf8'), 'three');
      assert.equal(warn.mock.calls.length, 1);
    } finally {
      warn.mock.restore();
    }
  });
  test('read by link; a file that is gone is DocGone, in words for a person', async () => {
    const a = { sid: await nas.signIn('bob'), household: 'h1', store: home };
    const ref = (await writeDoc(a, ['answers', 'q1.md'], 'the answer', nas.via))!;
    assert.equal(await readDoc(a, ref, nas.via), 'the answer');
    await assert.rejects(() => readDoc(a, { ...ref, link: 'not-there' }, nas.via),
      (e: unknown) => e instanceof DocGone && e.status === 404 && /old NAS/.test(e.message));
    await assert.rejects(() => readDoc({ sid: null, household: 'h1', store: home }, ref, nas.via), NeedsDsm);
  });
  test('the status says why documents are in the log', async () => {
    assert.match((await documentsStatus({ sid: null, household: 'h1', store: home }, nas.via)).why!, /Sign in again/);
    const sid = await nas.signIn('alice');
    assert.deepEqual(await documentsStatus({ sid, household: 'h1', store: home }, nas.via), { on: true, why: null });
    assert.equal(teamFolderKnown(sid, 'Planner'), true);
    const bare = await fakeNas({ teamFolders: [] });
    const bareSid = await bare.signIn('alice');
    assert.match((await documentsStatus({ sid: bareSid, household: 'h1', store: home }, bare.via)).why!, /not a Team Folder/);
    await bare.close();
    assert.equal(teamFolderKnown(bareSid, 'Planner'), false, 'kept for the session that was told');
    assert.equal(teamFolderKnown(sid, 'Planner'), true, 'and for no other');
  });

  test('a session that ended is a sign-in, not Drive not answering', async () => {
    const isTeamFolders = (_m: string, p: string): boolean => p.endsWith('/team-folder');
    try {
      nas.fail(isTeamFolders, 119);
      const ended = await documentsStatus({ sid: await nas.signIn('bob'), household: 'h1', store: home }, nas.via);
      assert.equal(ended.on, false);
      assert.match(ended.why!, /^Sign in again/);
      nas.ok();
      nas.fail(isTeamFolders, 1000);
      const down = await documentsStatus({ sid: await nas.signIn('carol'), household: 'h1', store: home }, nas.via);
      assert.match(down.why!, /^Synology Drive did not answer/);
    } finally {
      nas.ok();
    }
  });
});

describe("the household's folder", () => {
  const file = (path: string): DriveFile => ({ path, display_path: path }) as DriveFile;

  test('inHousehold: under the chosen folder; while files wait to move, under the folder being left too', async () => {
    const s = await household();
    assert.equal(householdFolder(s.state), null);
    assert.ok(!inHousehold(file('/team-folders/Planner/h1/today/x.md'), s.state), 'no folder, no home');
    await chooseFolderIn(s, { team: 'Planner', folder: 'old' });
    assert.equal(householdFolder(s.state), '/team-folders/Planner/old');
    const kept = { ...DOC, path: '/team-folders/Planner/old/today/2026-11-02-household.md' };
    await s.append(CLAUDE, brief({ doc: kept }) as never);
    await chooseFolderIn(s, { team: 'Planner', folder: 'new' });
    assert.equal(householdFolder(s.state), '/team-folders/Planner/new');
    assert.equal(s.state.documents.waiting.size, 1);
    assert.ok(inHousehold(file('/team-folders/Planner/new/today/y.md'), s.state));
    assert.ok(inHousehold(file(kept.path), s.state), "not moved yet, so still this household's");
    assert.ok(!inHousehold(file('/team-folders/Planner/older/today/y.md'), s.state), 'a folder whose name begins the same is not it');
    assert.ok(!inHousehold(file('/team-folders/Planner/new'), s.state), 'the folder itself is not a file in it');
    await s.append('alice', { op: 'documents.moved', file: { link: kept.link, doc: { ...kept, path: '/team-folders/Planner/new/today/2026-11-02-household.md' } } });
    assert.equal(s.state.documents.waiting.size, 0);
    assert.ok(!inHousehold(file(kept.path), s.state), 'once everything has moved, the old folder is not home');
  });

  test("one member's no does not turn Drive off for another, who has not asked", async () => {
    // Drive lists the Team Folders the person asking can see: alice sees Shelf, bob (on a NAS that lists none) does not.
    const sees = await fakeNas({ teamFolders: ['Shelf'] });
    const blind = await fakeNas({ teamFolders: [] });
    try {
      const s = await household();
      await chooseFolderIn(s, { team: 'Shelf', folder: 'h1' });
      const alice = { sid: await sees.signIn('alice'), household: 'h1', store: s };
      const bob = { sid: await blind.signIn('bob'), household: 'h1', store: s };
      assert.match((await documentsStatus(bob, blind.via)).why!, /^Shelf is not a Team Folder/);
      assert.equal(teamFolderKnown(bob.sid, 'Shelf'), false);
      assert.equal(teamFolderKnown(alice.sid, 'Shelf'), null, 'alice was never told anything');

      // alice has not asked about the Team Folder: her write goes to Drive, as it did before there was any answer.
      const asked = sees.calls.length;
      const doc = await writeDoc(alice, ['today', 'x.md'], 'x', sees.via);
      assert.equal(doc!.path, '/team-folders/Shelf/h1/today/x.md', 'alice writes');
      assert.ok(sees.calls.length > asked, 'and Drive was asked');
      const before = blind.calls.length;
      assert.equal(await writeDoc(bob, ['today', 'y.md'], 'y', blind.via), null);
      assert.equal(blind.calls.length, before, "bob's write does not ask Drive");
    } finally {
      await sees.close();
      await blind.close();
    }
  });

  test("documentsStatus asks about the chosen folder's Team Folder, not PLANNER_ROOT's, and a no is not asked of Drive again", async () => {
    const nas = await fakeNas({ teamFolders: ['Planner'] });
    try {
      const s = await household();
      await chooseFolderIn(s, { team: 'Plain', folder: 'h1' });
      const a = { sid: await nas.signIn('alice'), household: 'h1', store: s };
      assert.equal(teamFolderKnown(a.sid, 'Plain'), null, 'not asked yet');
      assert.deepEqual(await documentsStatus(a, nas.via), { on: false,
        why: 'Plain is not a Team Folder in Synology Drive, so briefings and answers are kept in the log (DEPLOY.md, Documents in Synology Drive).' });
      assert.equal(teamFolderKnown(a.sid, 'Plain'), false);
      const before = nas.calls.length;
      assert.equal(await writeDoc(a, ['today', 'x.md'], 'x', nas.via), null);
      assert.equal(nas.calls.length, before, 'Drive is not asked');

      const team = await household();
      await chooseFolderIn(team);
      assert.deepEqual(await documentsStatus({ ...a, store: team }, nas.via), { on: true, why: null });
      assert.equal(teamFolderKnown(a.sid, 'Planner'), true);
      assert.equal(teamFolderKnown(a.sid, 'Plain'), false, 'kept per Team Folder');
    } finally {
      await nas.close();
    }
  });
});
