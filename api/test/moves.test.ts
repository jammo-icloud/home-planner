import './planner-root.ts';
import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Store } from '../src/store.ts';
import { attach, detach, readAttachment } from '../src/attachments.ts';
import type { FileContext } from '../src/attachments.ts';
import { briefingFile, currentDoc, readDoc, renderAnswerPage, renderBriefingPage, toDocRef, writeDoc } from '../src/docs.ts';
import { byLink, getFile, moveFile } from '../src/drive.ts';
import { chooseFolder, rememberFolder, takenBy } from '../src/folders.ts';
import type { DsmFetch } from '../src/synology.ts';
import { MOVE_WAIT_MS, moveFailures, moveFirst, movePass } from '../src/moves.ts';
import { followOn } from '../src/pages.ts';
import { ProposalStore } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { CLAUDE, movesLeft } from '../src/types.ts';
import type { Event } from '../src/types.ts';
import { fakeNas } from './fake-nas.ts';
import type { FakeNas } from './fake-nas.ts';
import { chooseFolderIn } from './folder.ts';

const NOW = '2026-11-02T09:00:00Z';
const DAY = '2026-11-02';
const BRIEFING = briefingFile(DAY, 'household', null);
const MOVE = '/api/SynologyDrive/default/v2/files/move';
/** File Station's move of a card's file. */
const NAS_MOVE = 'entry.cgi:SYNO.FileStation.CopyMove.start';

let nas: FakeNas;
let s: Store;
let ctx: ToolContext;
let fileCtx: FileContext;
let askId: string;
let briefingLink: string;

afterEach(async () => { await nas?.close(); });

const moved = (out: readonly Event[]) => out.filter((e): e is Extract<Event, { op: 'documents.moved' }> => e.op === 'documents.moved');

/**
 * A household h1 whose documents were in Planner/h1: a briefing, an answer and
 * gate's page written there, then its folder changed to Planner/home/h1.
 * `outside`: one more briefing whose document Drive keeps in Planner/other.
 * `cards`: quote.pdf (5 bytes) on gate's card, and old.pdf put on it and taken off.
 */
async function setup(o: { outside?: boolean; cards?: boolean } = {}): Promise<{ outsideLink?: string }> {
  nas = await fakeNas();
  s = new Store({ path: join(await mkdtemp(join(tmpdir(), 'pb-moves-')), 'events.jsonl'), now: () => new Date(NOW) });
  await s.load();
  await s.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
    { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
  ]);
  await chooseFolderIn(s);
  ctx = { store: s, who: 'alice', today: DAY, proposals: new ProposalStore(), sid: await nas.signIn('alice'), household: 'h1' };
  fileCtx = { ...ctx, household: 'h1' };
  // Laid out on disk, so a folder another test's NAS made (and writeDoc remembers) is here too.
  for (const dir of ['today', 'answers', 'gate']) await mkdir(join(nas.nas.root, 'Planner/h1', dir), { recursive: true });

  const brief = await writeDoc(ctx, ['today', BRIEFING], renderBriefingPage({
    day: DAY, source: 'household', budget: null, writtenBy: 'fallback', headline: 'Quiet day', body: 'Nothing is due.',
  }), nas.via);
  assert.ok(brief, 'the briefing was written');
  briefingLink = brief.link;
  await s.append(CLAUDE, { op: 'thread.briefing', day: DAY, source: 'household', budget: null, headline: 'Quiet day', doc: brief, writtenBy: 'fallback' });

  const [q] = await s.append('alice', { op: 'thread.ask', question: 'Can we afford it?', budget: null });
  askId = q!.id;
  const answer = await writeDoc(ctx, ['answers', `${askId}.md`], renderAnswerPage({
    replyTo: askId, plan: null, model: 'm', question: 'Can we afford it?', text: 'Yes.', tools: [],
  }), nas.via);
  assert.ok(answer, 'the answer was written');
  await s.append(CLAUDE, { op: 'thread.answer', replyTo: askId, text: 'Yes.', doc: answer, tools: [], model: 'm' });

  if (o.cards) {
    await attach(fileCtx, 'gate', { name: 'quote.pdf', bytes: new Uint8Array(5) }, nas.via);
    await attach(fileCtx, 'gate', { name: 'old.pdf', bytes: new Uint8Array(3) }, nas.via);
    await detach(ctx, 'gate', 'old.pdf', 'the wrong quote');
  }

  assert.equal((await followOn(ctx, nas.via)).length, 1, "gate's page was written");

  let outsideLink: string | undefined;
  if (o.outside) {
    await mkdir(join(nas.nas.root, 'Planner/other'), { recursive: true });
    await writeFile(join(nas.nas.root, 'Planner/other/x.md'), 'kept elsewhere');
    const there = toDocRef(await getFile(ctx.sid!, '/team-folders/Planner/other/x.md', nas.via));
    outsideLink = there.link;
    await s.append(CLAUDE, { op: 'thread.briefing', day: '2026-11-01', source: 'household', budget: null, headline: 'Old', doc: there, writtenBy: 'fallback' });
  }

  await chooseFolderIn(s, { team: 'Planner', folder: 'home/h1' });
  return outsideLink === undefined ? {} : { outsideLink };
}

describe('moving the documents', () => {
  test('each file goes to the parent its kind says, and is recorded with the DocRef Drive gives back', async () => {
    await setup();
    const out = await movePass(ctx, nas.via);
    assert.equal(moved(out).length, 3);
    for (const rel of [`today/${BRIEFING}`, `answers/${askId}.md`, 'gate/plan.md']) {
      assert.ok(existsSync(join(nas.nas.root, 'Planner/home/h1', rel)), rel);
      assert.ok(!existsSync(join(nas.nas.root, 'Planner/h1', rel)), `${rel} left the old folder`);
    }
    for (const e of moved(out)) {
      assert.ok('link' in e.file && e.file.doc, 'a Drive document, with where it is now');
      const there = await getFile(ctx.sid!, e.file.doc.path, nas.via);
      assert.deepEqual(e.file.doc, toDocRef(there), 'the DocRef Drive gives for the new path');
    }
    assert.equal(movesLeft(s.state), 0);
  });

  test('a move Drive finishes late is seen on the next pass, not counted a failure', async () => {
    await setup();
    const late = MOVE_WAIT_MS + 500;
    nas.nas.moves.delayMs = late;
    assert.equal((await movePass(ctx, nas.via)).length, 0);
    assert.deepEqual(moveFailures(s.path), []);
    assert.equal(movesLeft(s.state), 3);
    nas.nas.moves.delayMs = 0;
    // The last file's move was asked for MOVE_WAIT_MS before the pass ended; it lands `late` after it was asked.
    await sleep(late - MOVE_WAIT_MS + 100);
    assert.equal((await movePass(ctx, nas.via)).length, 3);
    assert.equal(movesLeft(s.state), 0);
  });

  test('one file that fails waits, and the rest go on', async () => {
    await setup();
    nas.nas.moves.refuse.add('plan.md');
    const warn = mock.method(console, 'warn', () => {});
    try {
      assert.equal(moved(await movePass(ctx, nas.via)).length, 2);
    } finally {
      warn.mock.restore();
    }
    const said = warn.mock.calls.map((c) => String(c.arguments[0]));
    assert.deepEqual(said, [`[moves] plan.md: ${moveFailures(s.path)[0]!.words}`]);
    assert.ok(!said[0]!.includes(ctx.sid!), 'never the sid');
    assert.equal(movesLeft(s.state), 1);
    assert.equal(moveFailures(s.path)[0]!.name, 'plan.md');
    assert.ok(moveFailures(s.path)[0]!.words);
    const asked = nas.calls.filter((c) => c.path === MOVE).length;
    assert.equal((await movePass(ctx, nas.via)).length, 0, 'not asked again before PAGE_RETRY_MS');
    assert.equal(nas.calls.filter((c) => c.path === MOVE).length, asked, 'Drive was not asked to move it');
  });

  test('a name already taken in the new folder fails in words a person can act on', async () => {
    await setup();
    nas.fail((method, path) => method === 'POST' && path === MOVE, 1003);
    const warn = mock.method(console, 'warn', () => {});
    try {
      assert.deepEqual(await movePass(ctx, nas.via), []);
    } finally {
      warn.mock.restore();
    }
    assert.equal(movesLeft(s.state), 3);
    const plan = moveFailures(s.path).find((x) => x.name === 'plan.md')!;
    assert.equal(plan.words, 'a file called plan.md is already in Planner/home/h1/gate: move or rename it there');
  });

  test('a file that is gone is recorded gone, so the move can finish', async () => {
    await setup();
    await rm(join(nas.nas.root, 'Planner/h1/answers', `${askId}.md`));
    const out = moved(await movePass(ctx, nas.via));
    assert.equal(out.length, 3);
    const gone = out.filter((e) => e.gone);
    assert.equal(gone.length, 1);
    assert.ok(!('doc' in gone[0]!.file), 'nothing to point at');
    assert.equal(movesLeft(s.state), 0);
    assert.ok(!existsSync(join(nas.nas.root, 'Planner/home/h1/answers', `${askId}.md`)));
  });

  test('a changed link is replaced in every pointer: the thread, the card, the docs route', async () => {
    await setup();
    nas.nas.moves.changeLink = true;
    await movePass(ctx, nas.via);
    const b = (await s.since(null)).find((e) => e.op === 'thread.briefing')!;
    assert.equal(b.op, 'thread.briefing');
    if (b.op !== 'thread.briefing') return;
    const now = currentDoc(s.state, b.doc!);
    assert.notEqual(now.link, b.doc!.link);
    assert.equal(await readDoc({ ...ctx }, now, nas.via), await readFile(join(nas.nas.root, 'Planner/home/h1/today', BRIEFING), 'utf8'));
    assert.equal(s.state.plans.get('gate')!.page!.doc.path, '/team-folders/Planner/home/h1/gate/plan.md');
  });

  test('a file the NAS moved whose record was lost is found at its new path and recorded', async () => {
    await setup();
    await mkdir(join(nas.nas.root, 'Planner/home/h1/today'), { recursive: true });
    await rename(join(nas.nas.root, 'Planner/h1/today', BRIEFING), join(nas.nas.root, 'Planner/home/h1/today', BRIEFING));
    const out = moved(await movePass(ctx, nas.via));
    assert.equal(out.length, 3);
    assert.equal(nas.calls.filter((c) => c.path === MOVE).length, 2, 'the briefing was not asked to move again');
    const b = out.find((e) => 'link' in e.file && e.file.link === briefingLink)!;
    assert.ok('link' in b.file);
    assert.equal(b.file.doc!.path, `/team-folders/Planner/home/h1/today/${BRIEFING}`);
    assert.equal(movesLeft(s.state), 0);
  });

  test('a link Drive keeps outside the old folder is left alone, and done', async () => {
    const { outsideLink } = await setup({ outside: true });
    assert.equal(movesLeft(s.state), 4);
    const out = moved(await movePass(ctx, nas.via));
    assert.equal(out.length, 4);
    const kept = out.find((e) => 'link' in e.file && e.file.link === outsideLink)!;
    assert.deepEqual(kept.file, { link: outsideLink });
    assert.equal(kept.gone, undefined);
    assert.equal(await readFile(join(nas.nas.root, 'Planner/other/x.md'), 'utf8'), 'kept elsewhere');
    assert.ok(!existsSync(join(nas.nas.root, 'Planner/home/h1/today/x.md')));
    assert.equal(movesLeft(s.state), 0);
  });

  test('a briefing written again mid-move moves first, then writes, and the page waits', async () => {
    await setup();
    await moveFirst(ctx, ['today', BRIEFING], nas.via);
    assert.ok(!s.state.documents.waiting.has(`link:${briefingLink}`));
    assert.ok(existsSync(join(nas.nas.root, 'Planner/home/h1/today', BRIEFING)));
    assert.equal(movesLeft(s.state), 2, 'only that file moved');
    // Behind the plan now, so only its waiting keeps the follow-on from writing it.
    await s.append('alice', { op: 'plan.set', plan: 'gate', notes: 'The latch sticks.' });
    assert.deepEqual(await followOn(ctx, nas.via), [], "gate's page has not moved, so it is not written");
  });

  test('a move that lands with a new link between the two looks is found where it went, not called gone', async () => {
    await setup();
    nas.nas.moves.changeLink = true;
    nas.nas.moves.delayMs = 200;
    await mkdir(join(nas.nas.root, 'Planner/home/h1/today'), { recursive: true });
    // A move asked by an earlier pass, still under way when this one looks where the briefing goes.
    await moveFile(ctx.sid!, byLink(briefingLink), '/team-folders/Planner/home/h1/today', nas.via);
    // The look by its old link is held until the move has landed, which takes that link away.
    const slow: DsmFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://nas');
      if (url.pathname.endsWith('/files') && url.searchParams.get('path') === byLink(briefingLink)) await sleep(400);
      return nas.via(input, init);
    }) as DsmFetch;
    nas.nas.moves.delayMs = 0;
    const b = moved(await movePass(ctx, slow)).find((e) => 'link' in e.file && e.file.link === briefingLink)!;
    assert.equal(b.gone, undefined, 'not recorded gone');
    assert.ok('link' in b.file);
    assert.equal(b.file.doc!.path, `/team-folders/Planner/home/h1/today/${BRIEFING}`);
    assert.notEqual(b.file.doc!.link, briefingLink);
  });

  test("a failure's words never carry the sid", async () => {
    await setup();
    const sid = ctx.sid!;
    // A NAS that does not answer the move, in words that hold the session.
    const leaky: DsmFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input), 'http://nas').pathname === MOVE) throw new Error(`socket closed for id=${sid}`);
      return nas.via(input, init);
    }) as DsmFetch;
    const warn = mock.method(console, 'warn', () => {});
    try {
      await movePass(ctx, leaky);
    } finally {
      warn.mock.restore();
    }
    assert.equal(moveFailures(s.path).length, 3);
    for (const f of moveFailures(s.path)) {
      assert.ok(!f.words.includes(sid), f.words);
      assert.match(f.words, /id=…/);
    }
    for (const c of warn.mock.calls) assert.ok(!String(c.arguments[0]).includes(sid));
  });
});

describe("moving a card's files", () => {
  test("a card's file moves through File Station, and the card reads it from wherever it is", async () => {
    await setup({ cards: true });
    assert.equal(movesLeft(s.state), 4, 'three documents and the file on the card');
    assert.equal((await readAttachment(fileCtx, 'gate', 'quote.pdf', nas.via)).bytes.length, 5, 'read from the old folder while it waits');
    await movePass(ctx, nas.via);
    const e = (await s.since(null)).findLast((x) => x.op === 'documents.moved')!;
    assert.equal(e.op, 'documents.moved');
    if (e.op !== 'documents.moved') return;
    assert.deepEqual(e.file, { plan: 'gate', name: 'quote.pdf', path: '/Planner/home/h1/gate/quote.pdf' });
    assert.ok(existsSync(join(nas.nas.root, 'Planner/home/h1/gate/quote.pdf')));
    assert.ok(!existsSync(join(nas.nas.root, 'Planner/h1/gate/quote.pdf')));
    assert.equal(nas.calls.filter((c) => c.path === NAS_MOVE).length, 1);
    assert.equal((await readAttachment(fileCtx, 'gate', 'quote.pdf', nas.via)).bytes.length, 5);
    assert.equal(movesLeft(s.state), 0);
  });

  test('a file taken off its card stays behind', async () => {
    await setup({ cards: true });
    await movePass(ctx, nas.via);
    assert.equal(movesLeft(s.state), 0);
    assert.ok(existsSync(join(nas.nas.root, 'Planner/h1/gate/old.pdf')), 'detached old.pdf is still under Planner/h1/gate');
    assert.ok(!existsSync(join(nas.nas.root, 'Planner/home/h1/gate/old.pdf')));
  });

  test('a file taken off its card mid-move stays behind, and the move finishes', async () => {
    await setup({ cards: true });
    await detach(ctx, 'gate', 'quote.pdf', 'paid');
    const card = moved(await movePass(ctx, nas.via)).find((e) => !('link' in e.file))!;
    assert.deepEqual(card.file, { plan: 'gate', name: 'quote.pdf' });
    assert.equal(card.gone, undefined);
    assert.ok(existsSync(join(nas.nas.root, 'Planner/h1/gate/quote.pdf')));
    assert.ok(!existsSync(join(nas.nas.root, 'Planner/home/h1/gate/quote.pdf')));
    assert.equal(nas.calls.filter((c) => c.path === NAS_MOVE).length, 0, 'File Station was not asked to move it');
    assert.equal(movesLeft(s.state), 0);
  });

  test("a card's file that is gone is recorded gone", async () => {
    await setup({ cards: true });
    await rm(join(nas.nas.root, 'Planner/h1/gate/quote.pdf'));
    const card = moved(await movePass(ctx, nas.via)).find((e) => !('link' in e.file))!;
    assert.deepEqual(card.file, { plan: 'gate', name: 'quote.pdf' });
    assert.equal(card.gone, true);
    assert.equal(movesLeft(s.state), 0);
  });

  test("another file by that name in the card's new folder fails in words, as a taken Drive name does", async () => {
    await setup({ cards: true });
    await mkdir(join(nas.nas.root, 'Planner/home/h1/gate'), { recursive: true });
    await writeFile(join(nas.nas.root, 'Planner/home/h1/gate/quote.pdf'), 'no');
    const warn = mock.method(console, 'warn', () => {});
    try {
      assert.equal(moved(await movePass(ctx, nas.via)).length, 3, 'the documents');
    } finally {
      warn.mock.restore();
    }
    assert.equal(movesLeft(s.state), 1);
    assert.deepEqual(moveFailures(s.path).map((f) => [f.name, f.words]),
      [['quote.pdf', 'a file called quote.pdf is already in Planner/home/h1/gate: move or rename it there']]);
    assert.equal(await readFile(join(nas.nas.root, 'Planner/home/h1/gate/quote.pdf'), 'utf8'), 'no', 'nothing written over');
    assert.ok(existsSync(join(nas.nas.root, 'Planner/h1/gate/quote.pdf')));
    // File Station was asked, skipped the file and still said finished: the move is not recorded on that word alone.
    assert.equal(nas.calls.filter((c) => c.path === NAS_MOVE).length, 1);
    assert.equal(s.state.plans.get('gate')!.attachments.find((a) => a.name === 'quote.pdf')!.path, '/Planner/h1/gate/quote.pdf');
    assert.equal((await readAttachment(fileCtx, 'gate', 'quote.pdf', nas.via)).bytes.length, 5, "the card's own file, not the other");
  });

  test('going back to a folder used before takes the card file back, and lets the other folder go only then', async () => {
    nas = await fakeNas();
    s = new Store({ path: join(await mkdtemp(join(tmpdir(), 'pb-moves-')), 'events.jsonl'), now: () => new Date(NOW) });
    await s.load();
    await s.append('alice', [
      { op: 'household.claim', label: 'Home' },
      { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
    ]);
    const back: FileContext = { store: s, who: 'alice', today: DAY, proposals: new ProposalStore(), sid: await nas.signIn('alice'), household: 'h-back' };
    const card = () => s.state.plans.get('gate')!.attachments[0]!;
    try {
      await chooseFolder(back, { team: 'Planner', folder: 'aaa' }, nas.via);
      await attach(back, 'gate', { name: 'q.pdf', bytes: new Uint8Array(5) }, nas.via);
      await chooseFolder(back, { team: 'Planner', folder: 'bbb' }, nas.via);
      await movePass(back, nas.via);
      assert.equal(card().path, '/Planner/bbb/gate/q.pdf');
      assert.equal(takenBy({ team: 'Planner', folder: 'aaa' }, 'h-other'), null, 'aaa let go');

      await chooseFolder(back, { team: 'Planner', folder: 'aaa' }, nas.via);
      assert.equal(movesLeft(s.state), 1);
      assert.equal(takenBy({ team: 'Planner', folder: 'bbb' }, 'h-other'), 'h-back', 'bbb is held while the file is in it');
      assert.equal((await readAttachment(back, 'gate', 'q.pdf', nas.via)).bytes.length, 5, 'read from bbb while it waits');
      const out = moved(await movePass(back, nas.via));
      assert.deepEqual(out.map((e) => e.file), [{ plan: 'gate', name: 'q.pdf', path: '/Planner/aaa/gate/q.pdf' }]);
      assert.ok(existsSync(join(nas.nas.root, 'Planner/aaa/gate/q.pdf')));
      assert.ok(!existsSync(join(nas.nas.root, 'Planner/bbb/gate/q.pdf')));
      assert.equal(card().path, '/Planner/aaa/gate/q.pdf');
      assert.equal((await readAttachment(back, 'gate', 'q.pdf', nas.via)).bytes.length, 5);
      assert.equal(takenBy({ team: 'Planner', folder: 'bbb' }, 'h-other'), null, 'bbb let go once the file left it');
    } finally {
      rememberFolder('h-back', null);
    }
  });

  test('a card file File Station moved whose record was lost is found by its list and recorded', async () => {
    await setup({ cards: true });
    await mkdir(join(nas.nas.root, 'Planner/home/h1/gate'), { recursive: true });
    await rename(join(nas.nas.root, 'Planner/h1/gate/quote.pdf'), join(nas.nas.root, 'Planner/home/h1/gate/quote.pdf'));
    const card = moved(await movePass(ctx, nas.via)).find((e) => !('link' in e.file))!;
    assert.deepEqual(card.file, { plan: 'gate', name: 'quote.pdf', path: '/Planner/home/h1/gate/quote.pdf' });
    assert.equal(nas.calls.filter((c) => c.path === NAS_MOVE).length, 0, 'not asked to move again');
  });

  test('two members looking at once move each file once', async () => {   // Review Focus 4
    await setup({ cards: true });
    const ctxAlice = ctx;
    const ctxBob: ToolContext = { ...ctx, who: 'bob', sid: await nas.signIn('bob') };
    const results = await Promise.allSettled([movePass(ctxAlice, nas.via), movePass(ctxBob, nas.via)]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'], 'neither pass was refused by the fold');
    const records = (await s.since(null)).filter((e) => e.op === 'documents.moved');
    assert.equal(records.length, 4);
    assert.equal(new Set(records.map((e) => JSON.stringify(e.file))).size, records.length);
    assert.equal(nas.calls.filter((c) => c.path === MOVE).length, 3, 'Drive was asked to move each document once');
    assert.equal(nas.calls.filter((c) => c.path === NAS_MOVE).length, 1, 'File Station was asked to move the file once');
    assert.equal(movesLeft(s.state), 0);
  });
});
