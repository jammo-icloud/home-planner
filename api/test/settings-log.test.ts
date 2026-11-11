// api/test/settings-log.test.ts
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { replay } from '../src/replay.ts';
import { scopeOf } from '../src/restore.ts';
import { describe as describeEvent } from '../src/tools.ts';
import { everyEntry } from './every-entry.ts';
import { movesLeft, SYSTEM, zoneOf } from '../src/types.ts';
import type { Event, NewEventShape } from '../src/types.ts';

const NOW = '2026-11-02T09:00:00Z';

let s: Store;

/** A household claimed by alice, with bob a member. */
beforeEach(async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-settings-log-')), 'events.jsonl');
  s = new Store({ path, now: () => new Date(NOW) });
  await s.load();
  await s.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
  ]);
});

const line = (who: string, e: Record<string, unknown>, id: string): Event =>
  ({ id, at: NOW, who, ...e }) as unknown as Event;

describe("the household's choices", () => {
  test('the owner sets the zone, the model and booking; state holds them', async () => {
    await s.append('alice', [{ op: 'household.zone', zone: 'America/Denver' }, { op: 'envelopes.model', model: 'claude-sonnet-5-5' },
      { op: 'guests.booking', on: true }]);
    assert.equal(s.state.zone, 'America/Denver');
    assert.equal(zoneOf(s.state), 'America/Denver');
    assert.equal(s.state.settings.model, 'claude-sonnet-5-5');
    assert.deepEqual({ ...s.state.settings.booking, at: '' }, { on: true, by: 'alice', at: '', calendarGone: false });
  });

  test('before anyone chooses, state holds nothing', () => {
    assert.equal(s.state.zone, null);
    assert.equal(s.state.settings.model, null);
    assert.equal(s.state.settings.booking, null);
  });

  test('the model goes back to the default with null', async () => {
    await s.append('alice', [{ op: 'envelopes.model', model: 'claude-sonnet-5-5' }, { op: 'envelopes.model', model: null }]);
    assert.equal(s.state.settings.model, null);
  });

  test('a member is refused, in the log and not only at the route', async () => {
    await assert.rejects(() => s.append('bob', { op: 'household.zone', zone: 'Europe/London' }), /only the owner, alice/);
    await assert.rejects(() => s.append('bob', { op: 'guests.booking', on: true }), /only the owner, alice/);
    await assert.rejects(() => s.append('bob', { op: 'envelopes.model', model: null }), /only the owner, alice/);
    assert.equal(s.state.zone, null);
  });

  test('system may turn booking off, and nothing else of these', async () => {
    await s.append(SYSTEM, { op: 'guests.booking', on: false, calendarGone: true });
    assert.equal(s.state.settings.booking!.calendarGone, true);
    await assert.rejects(() => s.append(SYSTEM, { op: 'guests.booking', on: true }), /system cannot guests.booking/);
    await assert.rejects(() => s.append(SYSTEM, { op: 'household.zone', zone: 'UTC' }), /system cannot household.zone/);
    await assert.rejects(() => s.append(SYSTEM, { op: 'envelopes.model', model: null }), /system cannot envelopes.model/);
    await assert.rejects(() => s.append('alice', { op: 'guests.booking', on: false, calendarGone: true }), /calendarGone/);
  });

  test('calendarGone with booking on is refused, even from system', async () => {
    await assert.rejects(() => s.append(SYSTEM, { op: 'guests.booking', on: true, calendarGone: true }), /system cannot guests.booking/);
  });

  test('a calendar chosen again clears the calendar-gone mark', async () => {
    const cal = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' };
    await s.append('alice', { op: 'calendar.household', ...cal });
    await s.append(SYSTEM, { op: 'guests.booking', on: false, calendarGone: true });
    assert.equal(s.state.settings.booking!.calendarGone, true);
    await s.append('alice', { op: 'calendar.household', cal_id: '/alice/new/', original_cal_id: '/alice/new/', name: 'Household', replaces: cal.cal_id });
    assert.equal(s.state.settings.booking!.calendarGone, false);
    assert.equal(s.state.settings.booking!.on, false);
  });

  test("a seed's facts written as system still replay", () => {
    const seeded = replay([line('system', { op: 'category.define', category: 'groceries', label: 'Groceries' }, 'e1'),
      line('system', { op: 'envelope.define', envelope: 'groceries', label: 'Groceries', group: 'Food',
        match: { categories: ['groceries'] }, template: 0 }, 'e2')]);
    assert.equal(seeded.envelopes.size, 1);
  });

  test('a zone with a space, or empty, is refused by name', async () => {
    for (const zone of ['Mountain Time', '', 'x'.repeat(65)]) {
      await assert.rejects(() => s.append('alice', { op: 'household.zone', zone }), /a time zone is a name/);
    }
    await s.append('alice', { op: 'household.zone', zone: 'x'.repeat(64) });
  });

  test('a model is null or a name of at most 100 characters', async () => {
    for (const model of ['', '   ', 'm'.repeat(101)]) {
      await assert.rejects(() => s.append('alice', { op: 'envelopes.model', model }), /the model is a name/);
    }
    await s.append('alice', { op: 'envelopes.model', model: 'm'.repeat(100) });
  });

  test('booking is a boolean', async () => {
    await assert.rejects(() => s.append('alice', { op: 'guests.booking', on: 'yes' as unknown as boolean }), /on or off/);
  });

  test('all three are settings, for a restore', () => {
    for (const x of [{ op: 'household.zone', zone: 'UTC' }, { op: 'guests.booking', on: true }, { op: 'envelopes.model', model: null }]) {
      assert.equal(scopeOf(line('alice', x, 'x')), 'settings', x.op);
    }
  });

  test('each is described in plain words', () => {
    const d = (x: Record<string, unknown>) => describeEvent(line('alice', x, 'x'), s.state).what;
    assert.equal(d({ op: 'household.zone', zone: 'America/Denver' }), "set the household's time zone to America/Denver");
    assert.equal(d({ op: 'guests.booking', on: true }), 'turned booking on');
    assert.equal(d({ op: 'guests.booking', on: false }), 'turned booking off');
    assert.equal(d({ op: 'guests.booking', on: false, calendarGone: true }), 'turned booking off, because the Household calendar is gone');
    assert.equal(d({ op: 'envelopes.model', model: 'claude-sonnet-5-5' }), 'chose claude-sonnet-5-5 to suggest envelopes');
    assert.equal(d({ op: 'envelopes.model', model: null }), 'went back to the default model for envelopes');
  });
});

/** Refused by the log, and nothing written. */
const refused = async (st: Store, who: string, e: Record<string, unknown>, re: RegExp): Promise<void> => {
  const before = st.state.eventCount;
  await assert.rejects(() => st.append(who, e as unknown as NewEventShape), re);
  assert.equal(st.state.eventCount, before);
};

describe('where documents live', () => {
  const DOC = { link: 'f3c1', file_id: '881', hash: 'abc', version_id: '1', path: '/team-folders/Planner/h1/today/2026-11-02-household.md' };
  const ANSWER = { link: 'a9e2', file_id: '882', hash: 'def', version_id: '1', path: '/team-folders/Planner/h1/answers/2026-11-02-food.md' };
  const EARLIER = { link: 'e0e0', file_id: '883', hash: 'ghi', version_id: '1', path: '/team-folders/Planner/h1/gate/plan.md' };
  const PAGE = { link: 'p7d4', file_id: '884', hash: 'jkl', version_id: '2', path: '/team-folders/Planner/h1/gate/plan.md' };
  const briefing = {
    op: 'thread.briefing', day: '2026-11-02', source: 'household', headline: 'Today', doc: DOC, writtenBy: 'fallback',
  } as const;

  /** The first folder, then every kind of file the log can name in it. */
  const files = async (): Promise<void> => {
    await s.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'owner' });
    const [first] = await s.append('claude', briefing);
    // Written again the same day, with the same link: one file, not two.
    await s.append('claude', { ...briefing, writtenBy: 'claude', replaces: first!.id });
    const [ask] = await s.append('bob', { op: 'thread.ask', question: 'How is food?' });
    await s.append('claude', { op: 'thread.answer', replyTo: ask!.id, text: 'Fine.', tools: [], model: 'm', doc: ANSWER });
    const [made] = await s.append('alice', [
      { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
      { op: 'plan.attach', plan: 'gate', path: '/Planner/h1/gate/quote.pdf', name: 'quote.pdf', size: 1200 },
      { op: 'plan.create', plan: 'old', title: 'Old shed', area: 'House' },
      { op: 'plan.attach', plan: 'old', path: '/Planner/h1/old/plans.pdf', name: 'plans.pdf', size: 900 },
      { op: 'plan.remove', plan: 'old', why: 'sold the shed' },
    ]);
    // A page written twice under different links: only the latest is the plan's.
    await s.append('alice', { op: 'plan.doc', plan: 'gate', doc: EARLIER, event: made!.id });
    await s.append('alice', { op: 'plan.doc', plan: 'gate', doc: PAGE, event: made!.id });
  };

  /** Mid-move: the files above, then a second folder. */
  const moving = async (): Promise<void> => {
    await files();
    await s.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'home/h1', source: 'owner' });
  };

  test('a first choice moves nothing', async () => {
    await s.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'owner' });
    assert.deepEqual({ team: s.state.documents.folder!.team, folder: s.state.documents.folder!.folder }, { team: 'Planner', folder: 'h1' });
    assert.equal(s.state.documents.folder!.source, 'owner');
    assert.equal(s.state.documents.folder!.by, 'alice');
    assert.equal(s.state.documents.previous, null);
    assert.equal(movesLeft(s.state), 0);
  });

  test('before any choice there is no folder and nothing waits', () => {
    assert.equal(s.state.documents.folder, null);
    assert.equal(s.state.documents.previous, null);
    assert.equal(movesLeft(s.state), 0);
  });

  test('the documents the log points to are tracked, a page by its latest link', async () => {
    await files();
    assert.deepEqual([...s.state.documents.docs.keys()].sort(), [`link:${ANSWER.link}`, `link:${DOC.link}`, `link:${PAGE.link}`].sort());
    assert.deepEqual(s.state.documents.docs.get(`link:${DOC.link}`), { kind: 'doc', link: DOC.link, parent: 'today', name: '2026-11-02-household.md' });
    assert.deepEqual(s.state.documents.docs.get(`link:${ANSWER.link}`), { kind: 'doc', link: ANSWER.link, parent: 'answers', name: '2026-11-02-food.md' });
    assert.deepEqual(s.state.documents.docs.get(`link:${PAGE.link}`), { kind: 'doc', link: PAGE.link, parent: 'gate', name: 'plan.md' });
  });

  test('a second choice waits on every file the log names in the old folder, as it stood', async () => {
    await moving();
    assert.deepEqual(s.state.documents.previous, { team: 'Planner', folder: 'h1' });
    assert.deepEqual({ team: s.state.documents.folder!.team, folder: s.state.documents.folder!.folder }, { team: 'Planner', folder: 'home/h1' });
    assert.deepEqual([...s.state.documents.waiting.keys()].sort(),
      ['card:gate/quote.pdf', `link:${ANSWER.link}`, `link:${DOC.link}`, `link:${PAGE.link}`].sort());
    assert.deepEqual(s.state.documents.waiting.get('card:gate/quote.pdf'), { kind: 'card', plan: 'gate', name: 'quote.pdf' });
    // A document written after the choice is in the new folder already: it does not wait.
    const [ask] = await s.append('bob', { op: 'thread.ask', question: 'And power?' });
    const LATER = { ...ANSWER, link: 'l8t3', path: '/team-folders/Planner/home/h1/answers/2026-11-02-power.md' };
    await s.append('claude', { op: 'thread.answer', replyTo: ask!.id, text: 'Fine.', tools: [], model: 'm', doc: LATER });
    assert.ok(s.state.documents.docs.has('link:l8t3'));
    assert.equal(movesLeft(s.state), 4);
  });

  test('a replay of the log gives the same list', async () => {
    await moving();
    const again = replay(await s.since(null));
    assert.deepEqual([...again.documents.waiting.entries()], [...s.state.documents.waiting.entries()]);
    assert.deepEqual(again.documents.previous, s.state.documents.previous);
  });

  test('the same folder again is refused', async () => {
    await s.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'owner' });
    await refused(s, 'alice', { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'owner' }, /documents already live in Planner\/h1/);
  });

  test('a third choice mid-move is refused, saying how many are left', async () => {
    await moving();
    await assert.rejects(() => s.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'x', source: 'owner' }),
      /Wait until the 4 documents have moved\./);
  });

  test('a member cannot choose the folder', async () => {
    await refused(s, 'bob', { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'owner' }, /only the owner, alice/);
  });

  test("system carries over the deployment's folder, and nothing else", async () => {
    await s.append(SYSTEM, { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'deployment' });
    assert.equal(s.state.documents.folder!.source, 'deployment');
    assert.equal(s.state.documents.folder!.by, SYSTEM);
    await refused(s, SYSTEM, { op: 'documents.folder', team: 'Planner', folder: 'h2', source: 'owner' }, /system cannot documents.folder/);
  });

  test("the deployment's folder is carried over only before a choice, so a carry-over never starts a move", async () => {
    const carry = { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'deployment' } as const;
    const gone = /the deployment's folder is carried over only before a choice/;
    await s.append(SYSTEM, carry);
    // Once, in any folder, the same or another: nothing waits to move because of it.
    await refused(s, SYSTEM, carry, gone);
    await refused(s, SYSTEM, { ...carry, folder: 'elsewhere' }, gone);
    assert.equal(movesLeft(s.state), 0);
    // After the owner's own choice it is refused too; the owner's own second choice still moves.
    await s.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'home/h1', source: 'owner' });
    await refused(s, SYSTEM, { ...carry, folder: 'third' }, gone);
    assert.equal(s.state.documents.folder!.folder, 'home/h1');
  });

  test('a moved document with a new link is followed: relinked, the page pointer replaced, the key moved', async () => {
    await moving();
    const shown = s.state.plans.get('gate')!.page!.event;
    const NEW = { ...PAGE, link: 'n3w', path: '/team-folders/Planner/home/h1/gate/plan.md' };
    await s.append('bob', { op: 'documents.moved', file: { link: PAGE.link, doc: NEW } });
    assert.deepEqual(s.state.documents.relinked.get(PAGE.link), NEW);
    assert.deepEqual(s.state.plans.get('gate')!.page, { doc: NEW, event: shown });
    assert.ok(s.state.documents.docs.has('link:n3w'));
    assert.ok(!s.state.documents.docs.has(`link:${PAGE.link}`));
    assert.deepEqual(s.state.documents.docs.get('link:n3w'), { kind: 'doc', link: 'n3w', parent: 'gate', name: 'plan.md' });
    assert.equal(movesLeft(s.state), 3);
  });

  test('a page written again mid-move keeps its new link when the old one is recorded moved', async () => {
    await moving();
    const AGAIN = { ...PAGE, link: 'r3w', path: '/team-folders/Planner/home/h1/gate/plan.md' };
    await s.append('alice', { op: 'plan.doc', plan: 'gate', doc: AGAIN, event: s.state.plans.get('gate')!.page!.event });
    await s.append('bob', { op: 'documents.moved', file: { link: PAGE.link, doc: { ...PAGE, link: 'n3w' } } });
    assert.equal(s.state.plans.get('gate')!.page!.doc.link, 'r3w');
    assert.ok(s.state.documents.docs.has('link:r3w'));
    assert.ok(!s.state.documents.docs.has('link:n3w'));
    assert.equal(s.state.documents.relinked.get(PAGE.link)!.link, 'n3w');
  });

  test('a document moved twice, across two changes of folder, is followed to where it is now', async () => {
    await moving();
    const MID = { ...DOC, link: 'm1d', path: '/team-folders/Planner/home/h1/today/2026-11-02-household.md' };
    await s.append('bob', [
      { op: 'documents.moved', file: { link: DOC.link, doc: MID } },
      { op: 'documents.moved', file: { link: ANSWER.link }, gone: true },
      { op: 'documents.moved', file: { link: PAGE.link }, gone: true },
      { op: 'documents.moved', file: { plan: 'gate', name: 'quote.pdf', path: '/Planner/home/h1/gate/quote.pdf' } },
    ]);
    assert.equal(movesLeft(s.state), 0);
    await s.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'h1b', source: 'owner' });
    assert.deepEqual([...s.state.documents.waiting.keys()].sort(), ['card:gate/quote.pdf', 'link:m1d']);
    const LAST = { ...MID, link: 'l45t', path: '/team-folders/Planner/h1b/today/2026-11-02-household.md' };
    await s.append('bob', { op: 'documents.moved', file: { link: MID.link, doc: LAST } });
    assert.deepEqual(s.state.documents.relinked.get(DOC.link), LAST);
    assert.deepEqual(s.state.documents.relinked.get(MID.link), LAST);
  });

  test('the same file twice is refused', async () => {   // Review Focus 4, in the log
    await moving();
    await s.append('bob', { op: 'documents.moved', file: { link: PAGE.link, doc: PAGE } });
    await assert.rejects(() => s.append('bob', { op: 'documents.moved', file: { link: PAGE.link, doc: PAGE } }), /not waiting to move/);
  });

  test('a file is refused when no move is pending at all', async () => {
    await files();
    await refused(s, 'bob', { op: 'documents.moved', file: { link: DOC.link }, gone: true }, /that file is not waiting to move/);
  });

  test('gone, and left alone, both count as done and drop the document', async () => {
    await moving();
    await s.append('bob', { op: 'documents.moved', file: { link: DOC.link }, gone: true });
    await s.append('alice', { op: 'documents.moved', file: { link: ANSWER.link } });
    for (const link of [DOC.link, ANSWER.link]) {
      assert.ok(!s.state.documents.waiting.has(`link:${link}`), link);
      assert.ok(!s.state.documents.docs.has(`link:${link}`), link);
      assert.ok(!s.state.documents.relinked.has(link), link);
    }
    assert.equal(movesLeft(s.state), 2);
  });

  test('a card file is recorded by plan and name, with where it landed, and the card points there', async () => {
    await moving();
    // Only in its plan's folder, in the household's folder.
    for (const path of ['/Planner/h1/gate/quote.pdf', '/Planner/home/h1/other/quote.pdf', '/Planner/home/h1/gate/q.pdf']) {
      await refused(s, 'bob', { op: 'documents.moved', file: { plan: 'gate', name: 'quote.pdf', path } }, /lands in its plan's folder/);
    }
    assert.equal(movesLeft(s.state), 4);
    await s.append('bob', { op: 'documents.moved', file: { plan: 'gate', name: 'quote.pdf', path: '/Planner/home/h1/gate/quote.pdf' } });
    assert.ok(!s.state.documents.waiting.has('card:gate/quote.pdf'));
    assert.equal(movesLeft(s.state), 3);
    // The card keeps its file, and its path is where the file is now.
    assert.deepEqual(s.state.plans.get('gate')!.attachments.map((a) => [a.name, a.path, a.size]),
      [['quote.pdf', '/Planner/home/h1/gate/quote.pdf', 1200]]);
    await refused(s, 'bob', { op: 'documents.moved', file: { plan: 'gate', name: 'quote.pdf' }, gone: true }, /not waiting to move/);
  });

  test("a card file that stays, or is gone, keeps the card's path as it was", async () => {
    await moving();
    await s.append('bob', { op: 'documents.moved', file: { plan: 'gate', name: 'quote.pdf' }, gone: true });
    assert.equal(s.state.plans.get('gate')!.attachments[0]!.path, '/Planner/h1/gate/quote.pdf');
  });

  test('the deployment is only for system; a folder must be segments', async () => {
    await refused(s, 'alice', { op: 'documents.folder', team: 'Planner', folder: 'x', source: 'deployment' }, /only by system/);
    for (const folder of ['', '../up', 'a/../b', 'a,b', '50%', 'a//b', '/a', 'a/', ' a', 'a /b', 'a\u0007b']) {
      await refused(s, 'alice', { op: 'documents.folder', team: 'Planner', folder, source: 'owner' }, /folder/);
    }
    for (const team of ['', 'a/b', '..', ' Planner']) {
      await refused(s, 'alice', { op: 'documents.folder', team, folder: 'h1', source: 'owner' }, /Team Folder/);
    }
    await refused(s, 'alice', { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'someone' }, /owner or deployment/);
    assert.equal(s.state.documents.folder, null);
  });

  test('a moved file is one of the two shapes', async () => {
    await moving();
    const bad: Record<string, unknown>[] = [
      { file: null }, { file: 'f3c1' }, { file: {} }, { file: { link: '' } },
      { file: { link: DOC.link, plan: 'gate', name: 'quote.pdf' } },
      { file: { link: DOC.link, doc: { link: 'x' } } },
      { file: { plan: 'gate' } }, { file: { plan: 'gate', name: 'quote.pdf', path: '' } },
      { file: { link: DOC.link, doc: DOC }, gone: true },
      { file: { link: DOC.link }, gone: false },
    ];
    for (const x of bad) await refused(s, 'bob', { op: 'documents.moved', ...x }, /moved file|a document is named|landed|gone/);
    assert.equal(movesLeft(s.state), 4);
  });

  test('a non-member cannot record a move', async () => {
    await moving();
    await refused(s, 'carol', { op: 'documents.moved', file: { link: DOC.link }, gone: true }, /carol is not a member of this household/);
    await refused(s, SYSTEM, { op: 'documents.moved', file: { link: DOC.link }, gone: true }, /system cannot documents.moved/);
  });

  test('a move is bookkeeping, not a line in the thread; the choice is one', async () => {
    await moving();
    await s.append('bob', { op: 'documents.moved', file: { link: DOC.link }, gone: true });
    const { entries } = await everyEntry(s, 'alice');
    const said = entries.flatMap((x) => (x.kind === 'change' ? [x.what] : []));
    assert.ok(said.includes("chose Planner/home/h1 for the household's documents"), said.join('; '));
    assert.ok(!said.some((w) => w.includes('nothing to move')), said.join('; '));
  });

  test('both are settings, for a restore', () => {
    for (const x of [{ op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'owner' },
      { op: 'documents.moved', file: { link: 'x' }, gone: true }]) {
      assert.equal(scopeOf(line('alice', x, 'x')), 'settings', x.op);
    }
  });

  test('each is described in plain words', () => {
    const d = (x: Record<string, unknown>) => describeEvent(line('alice', x, 'x'), s.state).what;
    assert.equal(d({ op: 'documents.folder', team: 'Planner', folder: 'home/h1', source: 'owner' }), "chose Planner/home/h1 for the household's documents");
    assert.equal(d({ op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'deployment' }),
      "chose Planner/h1 for the household's documents, carried over from the deployment");
    assert.equal(d({ op: 'documents.moved', file: { link: DOC.link, doc: { ...DOC, link: 'n3w' } } }),
      "moved 2026-11-02-household.md to the household's new folder");
    assert.equal(d({ op: 'documents.moved', file: { plan: 'gate', name: 'quote.pdf', path: '/Planner/home/h1/gate/quote.pdf' } }),
      "moved quote.pdf to the household's new folder");
    assert.equal(d({ op: 'documents.moved', file: { plan: 'gate', name: 'quote.pdf' }, gone: true }),
      'found quote.pdf gone, so there was nothing to move');
    assert.equal(d({ op: 'documents.moved', file: { link: DOC.link }, gone: true }), 'found a document gone, so there was nothing to move');
    assert.equal(d({ op: 'documents.moved', file: { link: DOC.link } }), 'left a document where Drive keeps it, outside the old folder');
  });
});

describe('areas, one at a time', () => {
  const areas = () => [...s.state.settings.areas];
  test('add, move and remove change the list, and nothing when it is already so', async () => {
    await s.append('alice', { op: 'areas.set', areas: ['House', 'Money', 'Trips'] });
    await s.append('bob', { op: 'areas.add', area: 'Garden' });
    assert.deepEqual(areas(), ['House', 'Money', 'Trips', 'Garden']);
    await s.append('bob', [{ op: 'areas.add', area: 'garden' }, { op: 'areas.remove', area: 'Attic' }, { op: 'areas.move', area: 'Garden', to: 99 }]);
    assert.deepEqual(areas(), ['House', 'Money', 'Trips', 'Garden']);
    await s.append('bob', { op: 'areas.move', area: 'Garden', to: 0 });
    assert.deepEqual(areas(), ['Garden', 'House', 'Money', 'Trips']);
    await s.append('bob', { op: 'areas.remove', area: 'Garden' });
    assert.deepEqual(areas(), ['House', 'Money', 'Trips']);
  });
  test('the fold refuses an area that holds a plan in any state, the last area, a bad name and a move of nothing', async () => {
    await s.append('alice', [{ op: 'areas.set', areas: ['House', 'Money'] },
      { op: 'plan.create', plan: 'p1', title: 'Paint', area: 'House' }, { op: 'plan.state', plan: 'p1', state: 'done' }]);
    const refuses = (e: NewEventShape, re: RegExp) => assert.rejects(() => s.append('alice', e), re);
    await refuses({ op: 'areas.remove', area: 'House' }, /"House" still has plans in it/);
    await s.append('alice', [{ op: 'areas.remove', area: 'Money' }, { op: 'plan.remove', plan: 'p1', why: 'painted' }]);
    await refuses({ op: 'areas.remove', area: 'House' }, /keep at least one area/);
    await refuses({ op: 'areas.add', area: ' Garden' }, /an area needs a name, with no spaces around it/);
    await refuses({ op: 'areas.add', area: 'x'.repeat(61) }, /an area's name is at most 60 characters/);
    await refuses({ op: 'areas.move', area: 'Attic', to: 0 }, /there is no area called Attic/);
    await refuses({ op: 'areas.move', area: 'House', to: -1 }, /must be a whole number/);
  });
  test('all three find an area ignoring case, and keep the household\'s spelling', async () => {
    await s.append('alice', [{ op: 'areas.set', areas: ['House', 'garden', 'Trips'] }, { op: 'areas.move', area: 'GARDEN', to: 0 }]);
    assert.deepEqual(areas(), ['garden', 'House', 'Trips']);
    await s.append('alice', { op: 'areas.remove', area: 'Garden' });
    assert.deepEqual(areas(), ['House', 'Trips']);
  });
  test('a move says the place it reached, not the index asked for', async () => {
    await s.append('alice', { op: 'areas.set', areas: ['House', 'Money', 'Trips', 'Garden'] });
    const [e] = await s.append('alice', { op: 'areas.move', area: 'House', to: 99 });
    assert.deepEqual(areas(), ['Money', 'Trips', 'Garden', 'House']);
    assert.equal(describeEvent(e!, s.state).what, 'moved the area House to place 4');
  });
  test('they are settings; an add and a remove are lines in Today, a move is not', async () => {
    const written = await s.append('alice', [{ op: 'areas.add', area: 'Garden' }, { op: 'areas.move', area: 'Garden', to: 0 }, { op: 'areas.remove', area: 'Garden' }]);
    for (const e of written) assert.equal(scopeOf(e), 'settings');
    assert.equal(describeEvent(written[1]!, s.state).what, 'moved the area Garden to place 1');
    const lines = (await everyEntry(s, 'bob')).entries.flatMap((e) => (e.kind === 'change' ? [e.what] : []));
    assert.deepEqual(lines.filter((w) => /Garden/.test(w)), ['added the area Garden', 'removed the area Garden']);
  });
});
