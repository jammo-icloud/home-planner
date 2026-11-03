// api/test/page-drift.test.ts
import './planner-root.ts';
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PAGES_FULL_EVERY_MS, checkPages, pageDriftWords } from '../src/drift.ts';
import { ToolError } from '../src/errors.ts';
import { decide } from '../src/offers.ts';
import { removePlan } from '../src/plan-edits.ts';
import { ensureHouseholdCalendar } from '../src/settings.ts';
import { setDsmFetch } from '../src/synology.ts';
import { lastPagesLook } from '../src/pages.ts';
import { cents } from '../src/money.ts';
import { pageView } from '../src/plan-rules.ts';
import {
  diffPage, followOn, normalizeNotes, pageAt, pageBehind, parsePlanPage, renderPlanPage, writePlanPage,
} from '../src/pages.ts';
import { Store } from '../src/store.ts';
import { zoneOf } from '../src/types.ts';
import { replay, ReplayError } from '../src/replay.ts';
import { scopeOf } from '../src/restore.ts';
import { describe as describeEvent, ProposalStore } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { thread } from '../src/thread.ts';
import type { ThreadEntry } from '../src/thread.ts';
import type { Event, EventId, PageChange, PageField, PageView } from '../src/types.ts';
import { fakeNas } from './fake-nas.ts';
import type { FakeNas } from './fake-nas.ts';
import { chooseFolderIn } from './folder.ts';

const NOW = '2026-11-02T09:00:00Z';
/** The last line of every page's card: what leaving both does next. */
const LEAVE = "Leave both: the next change to the plan writes the page again, and the version left stays in Drive's history";
const THEIRS = { link: 'drive:link/gate', file_id: 'f-1', hash: 'sha256:def', version_id: 'v-2', path: '/Planner/Plans/Fix the gate.md' };
const CHANGES = [
  { field: 'title', from: 'Fix the gate', to: 'Fix the side gate' },
  { field: 'checklist', from: [{ text: 'Buy hinges', done: false }], to: [{ text: 'Buy hinges', done: true }] },
] as const;

/** A household with alice and bob, and two plans: Fix the gate and Paint the fence. */
async function fresh(): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-page-drift-')), 'events.jsonl');
  const s = new Store({ path, now: () => new Date(NOW) });
  await s.load();
  await s.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
    { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
    { op: 'plan.create', plan: 'fence', title: 'Paint the fence', area: 'House' },
  ]);
  return s;
}

const pageDrift = (plan = 'gate', changes: readonly PageChange[] = CHANGES) =>
  ({ op: 'plan.page.drift', plan, theirs: THEIRS, changes }) as const;

/** The card that asks about a drift, as the app raises one. */
const driftCard = (drift: EventId) => ({
  op: 'proposal.offer', tool: 'resolve_drift', args: { drift, plan: 'gate', choice: 'plan' },
  summary: 'The page for Fix the gate was changed in Drive', effects: [], events: [],
  budget: null, month: null, envelopes: [], fingerprint: '', prompt: { kind: 'drift', ref: drift },
}) as const;

/** A write the log must refuse as a ReplayError (never a TypeError), leaving nothing behind. */
async function refused(s: Store, op: Record<string, unknown>, message: RegExp, who = 'alice'): Promise<void> {
  const before = (await s.since(null)).length;
  await assert.rejects(() => s.append(who, op as never),
    (e: unknown) => e instanceof ReplayError && message.test(e.message), JSON.stringify(op));
  assert.equal((await s.since(null)).length, before, 'nothing was written');
}

describe("a plan's page changed in Drive", () => {
  test('a page drift is recorded open, on a live plan', async () => {
    const s = await fresh();
    const pageEvent = s.state.plans.get('gate')!.pageEvent;
    const [d] = await s.append('alice', pageDrift());
    assert.deepEqual(s.state.pageDrifts.get(d!.id),
      { plan: 'gate', theirs: THEIRS, changes: CHANGES, unreadable: false, resolved: null });
    assert.equal(s.state.drifts.size, 0, "not one of the calendar's");
    assert.equal(s.state.plans.get('gate')!.pageEvent, pageEvent, 'what the page shows is unchanged');
    assert.equal(describeEvent(d!, s.state).what, 'noticed the page for Fix the gate was changed in Drive');
    // An incremental apply and a full replay agree; an empty log has none.
    assert.deepEqual([...replay(await s.since(null)).pageDrifts], [...s.state.pageDrifts]);
    assert.equal(replay([]).pageDrifts.size, 0);
    await refused(s, pageDrift('nope'), /no such plan/);
    await s.append('alice', { op: 'plan.remove', plan: 'fence', why: 'painted it last spring' });
    await refused(s, pageDrift('fence'), /has been removed/);
  });

  test('a newer one on the same plan settles the older as leave, and names itself', async () => {
    const s = await fresh();
    const [first] = await s.append('alice', pageDrift());
    const [card] = await s.append('alice', driftCard(first!.id));
    const [other] = await s.append('alice', pageDrift('fence'));
    const [second] = await s.append('alice', { ...pageDrift(), changes: [{ field: 'notes', from: '', to: 'Hinges from the yard' }] });
    assert.deepEqual(s.state.pageDrifts.get(first!.id),
      { plan: 'gate', theirs: THEIRS, changes: CHANGES, unreadable: false, resolved: 'leave', replacedBy: second!.id });
    assert.equal(s.state.thread.offers.get(card!.id)!.status, 'replaced', 'its card goes with it');
    assert.equal(s.state.thread.offers.get(card!.id)!.replacedBy, second!.id);
    assert.equal(s.state.pageDrifts.get(second!.id)!.resolved, null);
    assert.equal(s.state.pageDrifts.get(other!.id)!.resolved, null, 'a drift on another plan is left alone');
    await refused(s, { op: 'calendar.drift.resolve', drift: first!.id, choice: 'plan' }, /already settled/);
    assert.deepEqual([...replay(await s.since(null)).pageDrifts], [...s.state.pageDrifts]);
  });

  test('the drift resolve settles a page drift too; a second is refused', async () => {
    const s = await fresh();
    const [d] = await s.append('alice', pageDrift());
    const [card] = await s.append('alice', driftCard(d!.id));
    const [r] = await s.append('bob', { op: 'calendar.drift.resolve', drift: d!.id, choice: 'plan' });
    assert.equal(s.state.pageDrifts.get(d!.id)!.resolved, 'plan');
    assert.equal(s.state.thread.offers.get(card!.id)!.status, 'replaced', 'settled, its card has nothing left to ask');
    await refused(s, { op: 'calendar.drift.resolve', drift: d!.id, choice: 'leave' }, /already settled/);
    await refused(s, { op: 'calendar.drift.resolve', drift: 'nope', choice: 'leave' }, /no such drift/);
    assert.deepEqual([...replay(await s.since(null)).pageDrifts], [...s.state.pageDrifts]);
    // Each of the three choices names the plan whose page it settled.
    const said = (choice: string) => describeEvent({ ...r!, choice } as Event, s.state).what;
    assert.equal(said('plan'), 'took the change made in Drive to Fix the gate');
    assert.equal(said('calendar'), 'put the page for Fix the gate back as planned');
    assert.equal(said('leave'), 'left the page for Fix the gate as it was edited');
  });

  test('a change names a field of the page', async () => {
    const s = await fresh();
    await refused(s, { ...pageDrift(), changes: [{ field: 'colour', from: 'green', to: 'blue' }] }, /field/);
    await refused(s, { ...pageDrift(), changes: [{ from: 'a', to: 'b' }] }, /field/);
    await refused(s, pageDrift('gate', []), /change/);
    await refused(s, { ...pageDrift(), changes: undefined }, /change/);
    await refused(s, { ...pageDrift(), changes: [{ field: 'title', from: { text: 'x' }, to: 'b' }] }, /from and to/);
    await refused(s, { ...pageDrift(), unreadable: false }, /unreadable/);
    await refused(s, { ...pageDrift(), theirs: { ...THEIRS, hash: '' } }, /document/);
    await refused(s, { ...pageDrift(), plan: '' }, /names its plan/);
    // A page that could not be read says so, with nothing to list.
    const [d] = await s.append('alice', { ...pageDrift('gate', []), unreadable: true });
    assert.deepEqual(s.state.pageDrifts.get(d!.id), { plan: 'gate', theirs: THEIRS, changes: [], unreadable: true, resolved: null });
    // Every field of the page is one a change may name.
    const every: PageField[] = ['title', 'area', 'state', 'due', 'estimate', 'notes', 'checklist', 'parent', 'people', 'envelope', 'files'];
    await s.append('alice', pageDrift('fence', every.map((field) => ({ field, from: null, to: null }))));
  });

  test("it is the board's: scope plans, and not a line in the thread", async () => {
    const s = await fresh();
    const [d] = await s.append('alice', pageDrift());
    assert.equal(scopeOf(d!), 'plans');
    const [r] = await s.append('bob', { op: 'calendar.drift.resolve', drift: d!.id, choice: 'plan' });
    assert.equal(scopeOf(r!), 'plans');
    const { entries } = await thread(s, { who: 'alice', budget: null });
    const changes = entries.flatMap((e: ThreadEntry) => (e.kind === 'change' ? [e] : []));
    assert.ok(!changes.some((c) => c.id === d!.id), changes.map((c) => c.what).join(' | '));
    assert.ok(!changes.some((c) => /noticed the page/.test(c.what)), changes.map((c) => c.what).join(' | '));
  });
});

/** A plan with every field of its page set, as the planner has it: the base for the three-way diffs. */
const BASE: PageView = {
  id: 'heater', title: 'Replace the water heater', area: 'House', state: 'doing', parent: null, due: '2026-11-20',
  people: ['contacts:4123'], envelope: 'house-repairs', estimate: cents(185_000),
  notes: 'Why: the old one is 14 years old.\n\nThe pan has rust.',
  checklist: [{ text: 'Get two quotes', done: true }, { text: 'Pick an installer', done: false }],
  files: ['quote-abc.pdf', 'quote-xyz.pdf'],
};

describe('what changed on a page, against what was written', () => {
  test('the page as written is the plan as it was at that event', async () => {
    const s = await fresh();
    const [due] = await s.append('alice', { op: 'plan.due', plan: 'gate', due: '2026-11-20' });
    await s.append('alice', { op: 'plan.due', plan: 'gate', due: '2026-11-25' });
    await s.append('alice', { op: 'plan.set', plan: 'gate', notes: 'The latch sticks.' });
    const events = await s.since(null);
    const mid = events.slice(0, events.findIndex((e) => e.id === due!.id) + 1);
    const seen = pageView(replay(mid).plans.get('gate')!);
    assert.equal(seen.due, '2026-11-20');
    assert.deepEqual(pageAt(events, 'gate', due!.id), seen);
    assert.notDeepEqual(pageAt(events, 'gate', due!.id), pageView(s.state.plans.get('gate')!), 'not the plan now');
    // The last event is the plan now.
    assert.deepEqual(pageAt(events, 'gate', events.at(-1)!.id), pageView(s.state.plans.get('gate')!));
    // Unknown: an event that is not in the log, a plan that is not, a plan not yet made at that event.
    assert.equal(pageAt(events, 'gate', 'nope'), null);
    assert.equal(pageAt(events, 'nope', due!.id), null);
    const created = events.find((e) => e.op === 'plan.create' && e.plan === 'fence')!;
    const before = events.find((e) => e.op === 'member.add')!;
    assert.notEqual(pageAt(events, 'fence', created.id), null);
    assert.equal(pageAt(events, 'fence', before.id), null, 'made after that event');
    assert.equal(pageAt([], 'gate', due!.id), null);
  });

  test("an editor's whitespace and key order are no change", async () => {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.set', plan: 'gate', notes: 'The latch sticks.\n\nThe post leans.', estimate: cents(12_500) },
      { op: 'plan.due', plan: 'gate', due: '2026-11-05' },
      { op: 'plan.checklist', plan: 'gate', items: [{ id: 'i1', text: 'Buy a latch', done: true }, { id: 'i2', text: 'Fit it', done: false }] },
      { op: 'plan.contact.link', plan: 'gate', contact_id: 4123, addressbook_id: 1, display: 'Sandoval Plumbing' },
    ]);
    const base = pageView(s.state.plans.get('gate')!);
    const page = renderPlanPage(s.state, 'gate');
    // The same page, the way an editor might leave it: keys reversed, trailing spaces, a loose blank line, CRLF.
    const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(page)!;
    const keys = front!.split('\n').reverse().join('\n');
    const loose = body!
      .replace('The latch sticks.', 'The latch sticks.   ')
      .replace('\n\nThe post leans.', '\n\n\n\nThe post leans.  \n')
      .replace('- [x] Buy a latch', '- [X] Buy a latch  ');
    const theirs = parsePlanPage(`---\n${keys}\n---\n${loose}`.replaceAll('\n', '\r\n'))!.view;
    assert.notEqual(theirs.notes, base.notes, 'the editor did change the bytes');
    assert.deepEqual(diffPage(base, theirs, base), []);
  });

  test("a due date changed in Drive is from the plan's date now to theirs", () => {
    const base = { ...BASE };
    assert.deepEqual(diffPage(base, { ...base, due: '2026-11-27' }, base), [{ field: 'due', from: '2026-11-20', to: '2026-11-27' }]);
    // A date taken away is a change too.
    assert.deepEqual(diffPage(base, { ...base, due: null }, base), [{ field: 'due', from: '2026-11-20', to: null }]);
  });

  test("a page behind the plan never offers to undo the app's own later changes", () => {
    const now = { ...BASE, due: '2026-11-25' };             // the app moved it after the page was written
    const theirs = { ...BASE, title: 'Replace the boiler' }; // the page still says 20 Nov; they changed the title only
    const changes = diffPage(BASE, theirs, now);
    assert.deepEqual(changes.map((c) => c.field), ['title']);
    assert.deepEqual(changes, [{ field: 'title', from: 'Replace the water heater', to: 'Replace the boiler' }]);
    // And the app's own change to the same field they changed is the plan's: from is the plan now.
    const both = diffPage(BASE, { ...BASE, due: '2026-11-27' }, now);
    assert.deepEqual(both, [{ field: 'due', from: '2026-11-25', to: '2026-11-27' }]);
  });

  test('both changed it the same way: no change', () => {
    const now = { ...BASE, due: '2026-11-27', notes: 'Hinges from the yard' };
    const theirs = { ...BASE, due: '2026-11-27', notes: 'Hinges from the yard  \n' };
    assert.notEqual(theirs.due, BASE.due);
    assert.deepEqual(diffPage(BASE, theirs, now), []);
  });

  test('a tick and a new line are a checklist change', () => {
    const items = [{ text: 'Get two quotes', done: true }, { text: 'Pick an installer', done: true }, { text: 'Book the day', done: false }];
    assert.deepEqual(diffPage(BASE, { ...BASE, checklist: items }, BASE), [{ field: 'checklist', from: BASE.checklist, to: items }]);
    // A tick alone, a new line alone, a reorder: each a change; the same items with stray spaces are not.
    const ticked = [BASE.checklist[0]!, { text: 'Pick an installer', done: true }];
    const longer = [...BASE.checklist, { text: 'Book the day', done: false }];
    const swapped = [BASE.checklist[1]!, BASE.checklist[0]!];
    for (const to of [ticked, longer, swapped]) {
      assert.deepEqual(diffPage(BASE, { ...BASE, checklist: to }, BASE).map((c) => c.field), ['checklist']);
    }
    const spaced = BASE.checklist.map((i) => ({ text: `  ${i.text} `, done: i.done }));
    assert.deepEqual(diffPage(BASE, { ...BASE, checklist: spaced }, BASE), []);
  });

  test('a field only the planner changes is still a change, to be said', () => {
    assert.deepEqual(diffPage(BASE, { ...BASE, people: ['contacts:4123', 'contacts:77'] }, BASE),
      [{ field: 'people', from: ['contacts:4123'], to: ['contacts:4123', 'contacts:77'] }]);
    const theirs: PageView = {
      ...BASE, parent: 'house', envelope: null, files: ['quote-xyz.pdf', 'quote-abc.pdf'], people: [],
      area: 'Garden', state: 'done', estimate: cents(200_000),
    };
    assert.deepEqual(diffPage(BASE, theirs, BASE).map((c) => c.field).sort(),
      ['area', 'envelope', 'estimate', 'files', 'parent', 'people', 'state']);
    assert.deepEqual(diffPage(BASE, theirs, BASE).find((c) => c.field === 'files'),
      { field: 'files', from: ['quote-abc.pdf', 'quote-xyz.pdf'], to: ['quote-xyz.pdf', 'quote-abc.pdf'] });
  });

  test('notes are normalized: trailing spaces off each line, three newlines to two, trimmed', () => {
    assert.equal(normalizeNotes('  Hinges  \nfrom the yard \n\n\n\nand a latch\n\n'), 'Hinges\nfrom the yard\n\nand a latch');
    assert.equal(normalizeNotes('\n\n'), '');
    assert.equal(normalizeNotes('a\n\nb'), 'a\n\nb');
  });
});

describe("a plan's page, looked at in Drive", () => {
  let nas: FakeNas;
  let sid = '';
  before(async () => { nas = await fakeNas(); sid = await nas.signIn('alice'); });
  after(async () => { await nas.close(); });

  const isUpload = (m: string, p: string): boolean => m === 'PUT' && p.endsWith('/files/upload');
  const count = (when: (m: string, p: string) => boolean): number => nas.calls.filter((c) => when(c.method, c.path)).length;
  /** Metadata asked for: the household's folder (one per look), and each page asked about. */
  const gets = (): number => count((m, p) => m === 'GET' && p.endsWith('/files'));
  const reads = (): number => count((_m, p) => p.endsWith('/files/download'));
  const uploads = (): number => count(isUpload);
  const plan = (s: Store, id = 'gate') => s.state.plans.get(id)!;
  let households = 0;

  /**
   * Fix the gate (due 20 Nov, with a note) and Paint the fence, their pages
   * written by the follow-on, in a household folder of its own so that no test
   * sees another's pages. `editOnDisk` changes a page's bytes where Drive keeps
   * them, the way an editor over SMB or Drive's own app does.
   */
  async function withPages() {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.due', plan: 'gate', due: '2026-11-20' },
      { op: 'plan.set', plan: 'gate', notes: 'The latch sticks.' },
    ]);
    const household = `look${++households}`;
    await chooseFolderIn(s, { team: 'Planner', folder: household });
    const ctx: ToolContext = { store: s, who: 'alice', today: NOW.slice(0, 10), proposals: new ProposalStore(), sid, household };
    assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan).sort(), ['fence', 'gate']);
    const file = (id: string): string => join(nas.nas.root, 'Planner', household, id, 'plan.md');
    const editOnDisk = async (id: string, edit: (text: string) => string): Promise<void> => {
      const was = await readFile(file(id), 'utf8');
      const now = edit(was);
      assert.notEqual(now, was, 'the edit changed the page');
      await writeFile(file(id), now);
    };
    return { s, ctx, file, editOnDisk };
  }

  /** `fn`, with the clock moved on past the full look's hour. */
  async function anHourLater<T>(fn: () => Promise<T>): Promise<T> {
    mock.timers.enable({ apis: ['Date'], now: Date.now() + PAGES_FULL_EVERY_MS + 1 });
    try { return await fn(); } finally { mock.timers.reset(); }
  }

  test('an edit in Drive becomes a page drift, and a card in front of everyone', async () => {
    const { s, ctx, editOnDisk } = await withPages();
    const written = plan(s).page!;
    await editOnDisk('gate', (t) => t.replace('due: 2026-11-20', 'due: 2026-11-27'));
    const out = await checkPages(ctx, nas.via);
    const d = out.find((e) => e.op === 'plan.page.drift')!;
    assert.ok(d && d.op === 'plan.page.drift', out.map((e) => e.op).join(', '));
    assert.equal(d.plan, 'gate');
    assert.equal(d.who, 'alice', 'noticed by the member looking');
    assert.deepEqual(d.changes, [{ field: 'due', from: '2026-11-20', to: '2026-11-27' }]);
    assert.equal(d.theirs.link, written.doc.link, 'the same file');
    assert.notEqual(d.theirs.hash, written.doc.hash, 'as found, not as written');
    assert.equal(d.unreadable, undefined);
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, null);
    // Only noticed: the plan keeps its date, and what was written is still what was written.
    assert.equal(plan(s).due, '2026-11-20');
    assert.deepEqual(plan(s).page, written);

    const card = [...s.state.thread.offers.values()].find((o) => o.prompt.kind === 'drift' && o.prompt.ref === d.id)!;
    assert.equal(card.tool, 'resolve_drift');
    assert.deepEqual(card.args, { drift: d.id, plan: 'gate', choice: 'plan' });
    assert.equal(card.status, 'open');
    assert.equal(card.who, 'alice');
    assert.match(card.summary, /^The page for Fix the gate was changed in Drive/);
    assert.ok(out.some((e) => e.id === card.id), 'the card is among what was written');
    const { entries } = await thread(s, { who: 'bob', budget: null });
    assert.ok(entries.some((e: ThreadEntry) => e.kind === 'card' && e.id === card.id), 'bob sees it too');

    // Not asked about again: an hour on, a full look finds the page as the drift found it.
    const before = gets();
    const read = reads();
    assert.deepEqual(await anHourLater(() => checkPages(ctx, nas.via)), []);
    assert.equal(gets() - before, 3, 'the pages were asked about');
    assert.equal(reads(), read, 'and not read again');
    assert.equal(s.state.pageDrifts.size, 1);
  });

  test("an editor's whitespace is no edit: its hash is recorded, and nothing is asked", async () => {
    const { s, ctx, file, editOnDisk } = await withPages();
    const written = plan(s).page!;
    await editOnDisk('gate', (t) => t.replace('The latch sticks.', 'The latch sticks.   ').replace('## Checklist', '## Checklist  '));
    const out = await checkPages(ctx, nas.via);
    assert.deepEqual(out.map((e) => e.op), ['plan.doc']);
    const doc = out[0]!;
    assert.ok(doc.op === 'plan.doc');
    assert.equal(doc.plan, 'gate');
    assert.equal(doc.who, 'alice');
    assert.equal(doc.event, written.event, 'still showing what it showed');
    assert.equal(doc.doc.link, written.doc.link);
    assert.notEqual(doc.doc.hash, written.doc.hash, 'their hash');
    assert.deepEqual(plan(s).page, { doc: doc.doc, event: written.event });
    assert.equal(s.state.pageDrifts.size, 0);
    assert.ok(![...s.state.thread.offers.values()].some((o) => o.prompt.kind === 'drift'), 'no card');
    assert.ok(!pageBehind(plan(s)), 'nothing to write over their spaces');
    // Known now: an hour on, it is not read again, and their spaces stay.
    const read = reads();
    assert.deepEqual(await anHourLater(() => checkPages(ctx, nas.via)), []);
    assert.equal(reads(), read);
    assert.deepEqual(await followOn(ctx, nas.via), []);
    assert.match(await readFile(file('gate'), 'utf8'), /The latch sticks\. {3}/);
  });

  test('an unmoved folder cursor reads no page', async () => {
    const { ctx, editOnDisk } = await withPages();
    // The first look asks about the folder, and each page.
    let before = gets();
    const read = reads();
    assert.deepEqual(await checkPages(ctx, nas.via), []);
    assert.equal(gets() - before, 3, 'the folder, the gate and the fence');
    // Nothing moved under the folder: only the folder is asked about.
    before = gets();
    assert.deepEqual(await checkPages(ctx, nas.via), []);
    assert.equal(gets() - before, 1, 'the folder only');
    // The safety net: an hour on, every page is asked about whatever the cursor says.
    before = gets();
    assert.deepEqual(await anHourLater(() => checkPages(ctx, nas.via)), []);
    assert.equal(gets() - before, 3);
    assert.equal(reads(), read, 'no page read: every hash was as written');
    // An edit moves the cursor: every page is asked about, and only the edited one is read.
    await editOnDisk('fence', (t) => t.replace('title: Paint the fence', 'title: Paint the back fence'));
    before = gets();
    const drifts = (await checkPages(ctx, nas.via)).filter((e) => e.op === 'plan.page.drift');
    assert.equal(gets() - before, 3);
    assert.equal(reads() - read, 1, 'the fence only');
    assert.deepEqual(drifts.map((e) => e.op === 'plan.page.drift' && e.plan), ['fence']);
  });

  test('a page deleted in Drive is rebuilt, not asked about', async () => {
    const { s, ctx, file } = await withPages();
    await rm(file('gate'));
    const warn = mock.method(console, 'warn', () => {});
    try {
      assert.deepEqual(await checkPages(ctx, nas.via), []);
      for (const c of warn.mock.calls) assert.ok(!String(c.arguments[0]).includes(sid), 'the sid is in no log line');
    } finally {
      warn.mock.restore();
    }
    assert.equal(s.state.pageDrifts.size, 0, 'a page holds no decision: nothing to ask');
    assert.ok(!pageBehind(plan(s)), 'the plan has not changed');
    // The follow-on writes it again by its path, and plan.doc names the file now there.
    const docs = await followOn(ctx, nas.via);
    assert.deepEqual(docs.map((e) => e.op === 'plan.doc' && e.plan), ['gate']);
    const doc = docs[0]!;
    assert.ok(doc.op === 'plan.doc');
    assert.deepEqual(plan(s).page!.doc, doc.doc);
    assert.equal(plan(s).page!.doc.path, `/team-folders/Planner/${ctx.household}/gate/plan.md`);
    assert.equal(await readFile(file('gate'), 'utf8'), renderPlanPage(s.state, 'gate'));
    // Rebuilt once: it is neither behind nor gone any more.
    assert.deepEqual(await followOn(ctx, nas.via), []);
    assert.deepEqual(await checkPages(ctx, nas.via), []);
  });

  /**
   * The same log as a household restored under another id on the same NAS, its documents in a folder of its own
   * (Planner/<id>): its links still name the original's files. Its store is the original's, seen with that folder.
   */
  const restoredAs = (ctx: ToolContext, household: string): ToolContext => {
    const original = ctx.store;
    const state = (): Store['state'] => ({
      ...original.state,
      documents: { ...original.state.documents, folder: { ...original.state.documents.folder!, folder: household } },
    });
    const store = new Proxy(original, {
      get: (target, key) => {
        if (key === 'state') return state();
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { ...ctx, household, store };
  };
  const pageIn = (household: string, id: string): string => join(nas.nas.root, 'Planner', household, id, 'plan.md');

  test("a link into another household's folder is not this household's page: written again here, never read", async () => {
    const { s, ctx, editOnDisk } = await withPages();
    const links = new Map(['gate', 'fence'].map((id) => [id, plan(s, id).page!.doc.link]));
    const copy = `${ctx.household}-copy`;
    await mkdir(join(nas.nas.root, 'Planner', copy), { recursive: true });
    const there = restoredAs(ctx, copy);
    // The original household edits its page: the copy neither reads it nor asks about it.
    await editOnDisk('gate', (t) => t.replace('due: 2026-11-20', 'due: 2026-11-27'));
    const read = reads();
    assert.deepEqual(await checkPages(there, nas.via), []);
    assert.equal(reads(), read, "another household's page is not read");
    assert.equal(s.state.pageDrifts.size, 0, 'nothing is asked');

    // Marked to be written again: by path, in the copy's own folder, and plan.doc names the new file.
    assert.deepEqual((await followOn(there, nas.via)).map((e) => e.op === 'plan.doc' && e.plan).sort(), ['fence', 'gate']);
    for (const id of ['fence', 'gate']) {
      const doc = plan(s, id).page!.doc;
      assert.equal(doc.path, `/team-folders/Planner/${copy}/${id}/plan.md`);
      assert.notEqual(doc.link, links.get(id), 'a file of its own');
      assert.equal(await readFile(pageIn(copy, id), 'utf8'), renderPlanPage(s.state, id));
    }
    assert.match(await readFile(pageIn(ctx.household!, 'gate'), 'utf8'), /due: 2026-11-27/, "the original's page is left as it is");
  });

  test("the write's own look does not stop on another household's edited page", async () => {
    const { s, ctx, editOnDisk } = await withPages();
    const copy = `${ctx.household}-copy`;
    await mkdir(join(nas.nas.root, 'Planner', copy), { recursive: true });
    await editOnDisk('gate', (t) => t.replace('due: 2026-11-20', 'due: 2026-11-27'));
    // A change in the copy, and its follow-on, with no look at the pages first.
    await s.append('alice', { op: 'plan.set', plan: 'gate', notes: 'Hinges from the yard.' });
    assert.deepEqual((await followOn(restoredAs(ctx, copy), nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['gate']);
    assert.equal(plan(s).page!.doc.path, `/team-folders/Planner/${copy}/gate/plan.md`);
    assert.equal(await readFile(pageIn(copy, 'gate'), 'utf8'), renderPlanPage(s.state, 'gate'));
    assert.match(await readFile(pageIn(ctx.household!, 'gate'), 'utf8'), /due: 2026-11-27/);
  });

  test("a household whose folder is not on this NAS has every page written again, in its own", async () => {
    const { s, ctx } = await withPages();
    await s.append('alice', [
      { op: 'plan.create', plan: 'shed', title: 'Clear the shed', area: 'House' },
      { op: 'plan.remove', plan: 'shed', why: 'cleared it in passing' },
    ]);
    const elsewhere = `${ctx.household}-elsewhere`;
    const there = restoredAs(ctx, elsewhere);
    assert.deepEqual(await checkPages(there, nas.via), []);
    assert.equal(s.state.pageDrifts.size, 0);
    assert.deepEqual((await followOn(there, nas.via)).map((e) => e.op === 'plan.doc' && e.plan).sort(), ['fence', 'gate']);
    for (const id of ['fence', 'gate']) {
      assert.equal(plan(s, id).page!.doc.path, `/team-folders/Planner/${elsewhere}/${id}/plan.md`);
      assert.equal(await readFile(pageIn(elsewhere, id), 'utf8'), renderPlanPage(s.state, id));
    }
    assert.equal(plan(s, 'shed').page, null, 'a plan removed before it had a page gets none');
  });

  test('the page is not rewritten while its card waits', async () => {
    const { s, ctx, file, editOnDisk } = await withPages();
    await editOnDisk('gate', (t) => t.replace('due: 2026-11-20', 'due: 2026-11-27'));
    const d = (await checkPages(ctx, nas.via)).find((e) => e.op === 'plan.page.drift')!;
    assert.ok(d);
    await s.append('bob', [
      { op: 'plan.set', plan: 'gate', notes: 'Hinges from the yard.' },
      { op: 'plan.set', plan: 'fence', notes: 'Green, this time.' },
    ]);
    assert.ok(pageBehind(plan(s)));
    const before = uploads();
    assert.deepEqual(await writePlanPage(ctx, 'gate', nas.via), []);
    assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['fence'], 'the other page is written');
    assert.equal(uploads() - before, 1, 'the fence only');
    assert.match(await readFile(file('gate'), 'utf8'), /due: 2026-11-27/, 'their edit stands');
    assert.ok(pageBehind(plan(s)), 'still behind, waiting');
    // Settled, with the version in Drive the one the app knows, it is written again.
    await s.append('bob', [
      { op: 'plan.doc', plan: 'gate', doc: d.theirs, event: plan(s).page!.event },
      { op: 'calendar.drift.resolve', drift: d.id, choice: 'leave' },
    ]);
    assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['gate']);
    assert.match(await readFile(file('gate'), 'utf8'), /Hinges from the yard\./);
  });

  test('an unreadable page is a drift with nothing to take', async () => {
    const { s, ctx, editOnDisk } = await withPages();
    await editOnDisk('gate', (t) => t.replace(/^---\n/, ''));
    const out = await checkPages(ctx, nas.via);
    const d = out.find((e) => e.op === 'plan.page.drift')!;
    assert.ok(d && d.op === 'plan.page.drift', out.map((e) => e.op).join(', '));
    assert.equal(d.unreadable, true);
    assert.deepEqual(d.changes, []);
    assert.deepEqual(s.state.pageDrifts.get(d.id), {
      plan: 'gate', theirs: d.theirs, changes: [], unreadable: true, resolved: null,
    });
    assert.ok([...s.state.thread.offers.values()].some((o) => o.prompt.kind === 'drift' && o.prompt.ref === d.id), 'asked about');
  });

  test("a page behind the plan and edited in Drive asks only about Drive's edit", async () => {
    const { s, ctx, file, editOnDisk } = await withPages();
    const warn = mock.method(console, 'warn', () => {});
    nas.fail(isUpload, 1003);
    try {
      // The plan moves to 25 Nov while Drive will not take the page: the page still says 20 Nov.
      await s.append('alice', { op: 'plan.due', plan: 'gate', due: '2026-11-25' });
      assert.deepEqual(await followOn(ctx, nas.via), []);
    } finally {
      nas.ok();
      warn.mock.restore();
    }
    assert.ok(pageBehind(plan(s)));
    assert.match(await readFile(file('gate'), 'utf8'), /due: 2026-11-20/);
    // Someone renames it in Drive, on the page that is behind.
    await editOnDisk('gate', (t) => t.replace('title: Fix the gate', 'title: Fix the side gate'));
    const out = await checkPages(ctx, nas.via);
    const d = out.find((e) => e.op === 'plan.page.drift')!;
    assert.ok(d && d.op === 'plan.page.drift', out.map((e) => e.op).join(', '));
    // The page's 20 Nov is the app's own date from before, never Drive's edit: only the title is asked about.
    assert.deepEqual(d.changes, [{ field: 'title', from: 'Fix the gate', to: 'Fix the side gate' }]);
    assert.equal(plan(s).due, '2026-11-25');
  });

  test('a page behind the plan, written at an event the log cannot replay to, is rebuilt, not asked about', async () => {
    const { s, ctx, file, editOnDisk } = await withPages();
    await s.append('alice', { op: 'plan.doc', plan: 'gate', doc: plan(s).page!.doc, event: 'not-in-the-log' });
    assert.ok(pageBehind(plan(s)));
    await editOnDisk('gate', (t) => t.replace('title: Fix the gate', 'title: Fix the side gate'));
    const before = (await s.since(null)).length;
    assert.deepEqual(await checkPages(ctx, nas.via), []);
    assert.equal((await s.since(null)).length, before, 'nothing appended for it');
    assert.equal(s.state.pageDrifts.size, 0);
    // The follow-on writes it again by its path, over what cannot be told from the app's own older page.
    assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['gate']);
    assert.equal(await readFile(file('gate'), 'utf8'), renderPlanPage(s.state, 'gate'));
    assert.ok(!pageBehind(plan(s)));
  });

  test('a page not behind, when the log cannot say what was written, is diffed against the plan now', async () => {
    const { s, ctx, editOnDisk } = await withPages();
    assert.ok(!pageBehind(plan(s)));
    await editOnDisk('gate', (t) => t.replace('due: 2026-11-20', 'due: 2026-11-27'));
    const since = mock.method(s, 'since', async () => []);
    let out: Event[];
    try {
      out = await checkPages(ctx, nas.via);
    } finally {
      since.mock.restore();
    }
    assert.ok(since.mock.callCount() > 0, 'the log was asked');
    const d = out.find((e) => e.op === 'plan.page.drift')!;
    assert.ok(d && d.op === 'plan.page.drift', out.map((e) => e.op).join(', '));
    assert.deepEqual(d.changes, [{ field: 'due', from: '2026-11-20', to: '2026-11-27' }]);
  });

  test("a page's drift with no card asking about it gets one on the next look", async () => {
    const { s, ctx } = await withPages();
    const [d] = await s.append('alice', pageDrift());
    assert.ok(![...s.state.thread.offers.values()].some((o) => o.prompt.kind === 'drift'));
    const out = await checkPages(ctx, nas.via);
    const cards = [...s.state.thread.offers.values()].filter((o) => o.prompt.kind === 'drift' && o.prompt.ref === d!.id);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.tool, 'resolve_drift');
    assert.deepEqual(cards[0]!.args, { drift: d!.id, plan: 'gate', choice: 'plan' });
    assert.ok(out.some((e) => e.id === cards[0]!.id));
    // Asked about once: the next look raises no second card.
    assert.deepEqual(await checkPages(ctx, nas.via), []);
    assert.equal([...s.state.thread.offers.values()].filter((o) => o.prompt.kind === 'drift').length, 1);
  });

  test('a page is never written over an edit the app has not seen', async () => {
    const { s, ctx, file, editOnDisk } = await withPages();
    assert.deepEqual(await checkPages(ctx, nas.via), []);
    assert.ok(lastPagesLook(s.path), 'the look remembered the cursor');
    await editOnDisk('gate', (t) => t.replace('due: 2026-11-20', 'due: 2026-11-27'));
    const edited = await readFile(file('gate'), 'utf8');
    // An app change to the plan: the page is behind, but Drive's file is not the one written.
    await s.append('bob', { op: 'plan.set', plan: 'gate', notes: 'Hinges from the yard.' });
    assert.ok(pageBehind(plan(s)));
    const before = uploads();
    assert.deepEqual(await followOn(ctx, nas.via), []);
    assert.equal(uploads(), before, 'no upload for it');
    assert.equal(await readFile(file('gate'), 'utf8'), edited, 'their edit untouched');
    assert.equal(lastPagesLook(s.path), undefined, 'the next look reads every page');
    // Not a refusal: the follow-on is not backed off, and the fence is written when it is behind.
    await s.append('bob', { op: 'plan.set', plan: 'fence', notes: 'Green, this time.' });
    assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['fence']);
    // The next look asks about it.
    const d = (await checkPages(ctx, nas.via)).find((e) => e.op === 'plan.page.drift')!;
    assert.ok(d && d.op === 'plan.page.drift');
    assert.equal(d.plan, 'gate');
    assert.deepEqual(d.changes, [{ field: 'due', from: '2026-11-20', to: '2026-11-27' }]);
  });
});

describe("settling a page's card", () => {
  let nas: FakeNas;
  let aliceSid = '';
  let bobSid = '';
  before(async () => {
    nas = await fakeNas();
    aliceSid = await nas.signIn('alice');
    bobSid = await nas.signIn('bob');
    // decide() takes no fetch of its own: the effect reaches the fake through the default.
    setDsmFetch(nas.via);
  });
  after(async () => { setDsmFetch(null); await nas.close(); });

  const isUpload = (m: string, p: string): boolean => m === 'PUT' && p.endsWith('/files/upload');
  const plan = (s: Store, id = 'gate') => s.state.plans.get(id)!;
  let households = 0;

  /**
   * Fix the gate (due 20 Nov, a note, a checklist) and Paint the fence, their
   * pages written, then the gate's edited on disk by `edit` and noticed by
   * alice: the drift, and the card asking about it.
   */
  async function edited(edit: (text: string) => string) {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.due', plan: 'gate', due: '2026-11-20' },
      { op: 'plan.set', plan: 'gate', notes: 'The latch sticks.' },
      { op: 'plan.checklist', plan: 'gate', items: [{ id: 'i1', text: 'Buy a latch', done: false }, { id: 'i2', text: 'Fit it', done: false }] },
    ]);
    const household = `settle${++households}`;
    await chooseFolderIn(s, { team: 'Planner', folder: household });
    const alice: ToolContext = { store: s, who: 'alice', today: NOW.slice(0, 10), proposals: new ProposalStore(), sid: aliceSid, household };
    const bob: ToolContext = { ...alice, who: 'bob', sid: bobSid };
    assert.deepEqual((await followOn(alice, nas.via)).map((e) => e.op === 'plan.doc' && e.plan).sort(), ['fence', 'gate']);
    const file = (id: string): string => join(nas.nas.root, 'Planner', household, id, 'plan.md');
    const was = await readFile(file('gate'), 'utf8');
    const now = edit(was);
    assert.notEqual(now, was, 'the edit changed the page');
    await writeFile(file('gate'), now);
    const out = await checkPages(alice, nas.via);
    const d = out.find((e) => e.op === 'plan.page.drift');
    assert.ok(d && d.op === 'plan.page.drift', out.map((e) => e.op).join(', '));
    const card = [...s.state.thread.offers.values()].find((o) => o.prompt.kind === 'drift' && o.prompt.ref === d.id)!;
    assert.ok(card, 'the card asks about it');
    return { s, alice, bob, file, d, card };
  }
  const dueEdit = (t: string): string => t.replace('due: 2026-11-20', 'due: 2026-11-27');

  /** `fn`, with the clock moved on past the full look's hour. */
  async function anHourLater<T>(fn: () => Promise<T>): Promise<T> {
    mock.timers.enable({ apis: ['Date'], now: Date.now() + PAGES_FULL_EVERY_MS + 1 });
    try { return await fn(); } finally { mock.timers.reset(); }
  }

  test("the card says what changed, in the page's words", async () => {
    const { card } = await edited(dueEdit);
    assert.equal(card.summary, 'The page for Fix the gate was changed in Drive: due date Fri 20 Nov → Fri 27 Nov');
    assert.deepEqual(card.effects, ['Due date Fri 20 Nov → Fri 27 Nov', LEAVE]);
  });

  test('Take the change: the plan takes the page\'s date, by the member who took it, for "edited in Drive"', async () => {
    const { s, alice, bob, file, d, card } = await edited(dueEdit);
    await ensureHouseholdCalendar(alice, ['alice', 'bob'], nas.via); // the owner's: a member's date does not make it
    const written = plan(s).page!;
    await decide(bob, card.id, 'approved', undefined, { choice: 'plan' });
    const e = (await s.since(null)).findLast((x) => x.op === 'plan.due')!;
    assert.equal(e.who, 'bob');
    assert.equal(e.why, 'edited in Drive');
    assert.equal(plan(s).due, '2026-11-27');
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, 'plan');
    assert.equal(s.state.thread.offers.get(card.id)!.decidedBy, 'bob');
    // On the calendar too, as a member's own date is.
    assert.ok(plan(s).links.some((l) => l.kind === 'due'), 'the due date has its event');
    // The version in Drive is the one on record, at the event the page showed: behind, so the follow-on writes it.
    assert.equal(plan(s).page!.doc.hash, d.theirs.hash);
    assert.equal(plan(s).page!.event, written.event);
    assert.ok(pageBehind(plan(s)));
    assert.deepEqual((await followOn(alice, nas.via)).map((x) => x.op === 'plan.doc' && x.plan), ['gate']);
    assert.equal(await readFile(file('gate'), 'utf8'), renderPlanPage(s.state, 'gate'));
    // Not asked about again.
    assert.deepEqual((await anHourLater(() => checkPages(alice, nas.via))).filter((x) => x.op === 'plan.page.drift'), []);
  });

  test('notes and the checklist are taken as written; items keep their ids by text', async () => {
    const { s, bob, card } = await edited((t) => t
      .replace('The latch sticks.', 'The latch sticks.   \n\n\n\nHinges from the yard.  ')
      .replace('- [ ] Buy a latch', '- [x] Buy a latch')
      .replace('- [ ] Fit it\n', '- [ ] Oil the hinge\n- [ ] Fit it\n'));
    assert.equal(card.summary, 'The page for Fix the gate was changed in Drive: notes changed');
    assert.deepEqual(card.effects, ['Notes changed', 'Checklist changed (1 ticked, 1 new)', LEAVE]);
    await decide(bob, card.id, 'approved', undefined, { choice: 'plan' });
    assert.equal(plan(s).notes, 'The latch sticks.\n\nHinges from the yard.', 'normalized, as it is compared');
    const items = plan(s).checklist;
    assert.deepEqual(items.map((i) => [i.text, i.done]), [['Buy a latch', true], ['Oil the hinge', false], ['Fit it', false]]);
    assert.equal(items[0]!.id, 'i1');
    assert.equal(items[2]!.id, 'i2');
    assert.ok(!['i1', 'i2'].includes(items[1]!.id), 'a new item, a new id');
    const log = await s.since(null);
    for (const op of ['plan.set', 'plan.checklist'] as const) {
      const e = log.findLast((x) => x.op === op)!;
      assert.deepEqual([e.who, e.why], ['bob', 'edited in Drive'], op);
    }
  });

  test("a title taken from the page renames the plan, as a member's own edit does", async () => {
    const { s, bob, card } = await edited((t) => t.replace('title: Fix the gate', 'title: Fix the side gate'));
    assert.equal(card.summary, 'The page for Fix the gate was changed in Drive: title "Fix the gate" → "Fix the side gate"');
    await decide(bob, card.id, 'approved', undefined, { choice: 'plan' });
    assert.equal(plan(s).title, 'Fix the side gate');
    const e = (await s.since(null)).findLast((x) => x.op === 'plan.set')!;
    assert.deepEqual([e.who, e.why], ['bob', 'edited in Drive']);
  });

  test('Put the page back: rewritten from the plan, and plan.doc names the new version', async () => {
    const { s, bob, file, d, card } = await edited(dueEdit);
    await decide(bob, card.id, 'approved', undefined, { choice: 'calendar' });
    assert.equal(await readFile(file('gate'), 'utf8'), renderPlanPage(s.state, 'gate'));
    assert.match(await readFile(file('gate'), 'utf8'), /due: 2026-11-20/);
    assert.equal(plan(s).due, '2026-11-20', 'the plan keeps its date');
    const doc = (await s.since(null)).findLast((x) => x.op === 'plan.doc')!;
    assert.ok(doc.op === 'plan.doc');
    assert.equal(doc.who, 'bob');
    assert.equal(doc.event, plan(s).pageEvent);
    assert.equal(doc.doc.link, d.theirs.link, 'the same file');
    assert.notEqual(doc.doc.hash, d.theirs.hash);
    assert.ok(Number(doc.doc.version_id) > Number(d.theirs.version_id), `${doc.doc.version_id} after ${d.theirs.version_id}`);
    assert.deepEqual(plan(s).page, { doc: doc.doc, event: plan(s).pageEvent });
    assert.ok(!pageBehind(plan(s)));
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, 'calendar');
  });

  test('Put the page back, refused by Drive: a 502, and nothing is written', async () => {
    const { s, bob, d, card } = await edited(dueEdit);
    const before = (await s.since(null)).length;
    const warn = mock.method(console, 'warn', () => {});
    nas.fail(isUpload, 1003);
    try {
      await assert.rejects(decide(bob, card.id, 'approved', undefined, { choice: 'calendar' }),
        (e: unknown) => e instanceof ToolError && e.status === 502 && e.message === 'Drive did not take the page; try again');
    } finally {
      nas.ok();
      warn.mock.restore();
    }
    assert.equal((await s.since(null)).length, before);
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, null);
    assert.equal(s.state.thread.offers.get(card.id)!.status, 'open');
  });

  test('Leave both: the version in Drive is the one the app knows, and it is not asked about again', async () => {
    const { s, alice, bob, file, d, card } = await edited(dueEdit);
    await decide(bob, card.id, 'approved', undefined, { choice: 'leave' });
    assert.equal(plan(s).page!.doc.hash, d.theirs.hash);
    assert.equal(plan(s).page!.event, plan(s).pageEvent);
    assert.equal(plan(s).due, '2026-11-20');
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, 'leave');
    assert.deepEqual(await anHourLater(() => checkPages(alice, nas.via)), []);
    assert.equal(s.state.pageDrifts.size, 1);
    assert.deepEqual(await followOn(alice, nas.via), []);
    assert.match(await readFile(file('gate'), 'utf8'), /due: 2026-11-27/, 'their edit stands');
  });

  test('Leave both after the plan changed while the card waited: the page is written again, and a later edit asks only about itself', async () => {
    const { s, alice, bob, file, d, card } = await edited(dueEdit);
    const shown = plan(s).page!.event;
    await s.append('bob', { op: 'plan.set', plan: 'gate', notes: 'Hinges from the yard.' });
    await decide(bob, card.id, 'approved', undefined, { choice: 'leave' });
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, 'leave');
    // Recorded at the event the page showed, not the plan now: it stays behind.
    assert.equal(plan(s).page!.doc.hash, d.theirs.hash);
    assert.equal(plan(s).page!.event, shown);
    assert.ok(pageBehind(plan(s)));
    assert.deepEqual((await followOn(alice, nas.via)).map((x) => x.op === 'plan.doc' && x.plan), ['gate']);
    assert.equal(await readFile(file('gate'), 'utf8'), renderPlanPage(s.state, 'gate'));
    assert.match(await readFile(file('gate'), 'utf8'), /Hinges from the yard\./);
    // A second edit in Drive is asked about alone: nothing of the first, nor of the app's own change.
    await writeFile(file('gate'), (await readFile(file('gate'), 'utf8')).replace('title: Fix the gate', 'title: Fix the side gate'));
    const second = (await anHourLater(() => checkPages(alice, nas.via))).find((x) => x.op === 'plan.page.drift');
    assert.ok(second && second.op === 'plan.page.drift');
    assert.deepEqual(second.changes, [{ field: 'title', from: 'Fix the gate', to: 'Fix the side gate' }]);
  });

  test('an unreadable page cannot be taken', async () => {
    const { s, bob, d, card } = await edited((t) => t.replace(/^---\n/, ''));
    assert.equal(card.summary, 'The page for Fix the gate was changed in Drive and can no longer be read');
    await assert.rejects(decide(bob, card.id, 'approved', undefined, { choice: 'plan' }),
      (e: unknown) => e instanceof ToolError && e.status === 409
        && /nothing on it can be taken: put the page back, or leave both/.test(e.message));
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, null);
  });

  test('an area the household has not is refused in words', async () => {
    const { s, bob, d, card } = await edited((t) => t.replace('area: House', 'area: Moon'));
    await assert.rejects(decide(bob, card.id, 'approved', undefined, { choice: 'plan' }),
      (e: unknown) => e instanceof ToolError && e.status === 400 && e.message === '"Moon" is not one of this household\'s areas');
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, null);
    assert.equal(plan(s).area, 'House');
  });

  test('Take the change when the page is gone from Drive: settled, and the page written again', async () => {
    const { s, alice, bob, file, d, card } = await edited(dueEdit);
    await ensureHouseholdCalendar(alice, ['alice', 'bob'], nas.via);
    await rm(file('gate'));
    await decide(bob, card.id, 'approved', undefined, { choice: 'plan' });
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, 'plan');
    assert.equal(plan(s).due, '2026-11-27');
    assert.deepEqual((await followOn(alice, nas.via)).map((x) => x.op === 'plan.doc' && x.plan), ['gate']);
    assert.equal(await readFile(file('gate'), 'utf8'), renderPlanPage(s.state, 'gate'));
    assert.ok(!pageBehind(plan(s)));
  });

  test('Leave both when the page is gone from Drive: settled, and the page written again', async () => {
    const { s, alice, bob, file, d, card } = await edited(dueEdit);
    await rm(file('gate'));
    await decide(bob, card.id, 'approved', undefined, { choice: 'leave' });
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, 'leave');
    assert.deepEqual((await followOn(alice, nas.via)).map((x) => x.op === 'plan.doc' && x.plan), ['gate']);
    assert.equal(await readFile(file('gate'), 'utf8'), renderPlanPage(s.state, 'gate'));
  });

  test("removing the plan settles its page's card as left, and its last page says so", async () => {
    const { s, alice, file, d, card } = await edited(dueEdit);
    await removePlan(alice, 'gate', 'fixed it ourselves');
    assert.equal(s.state.pageDrifts.get(d.id)!.resolved, 'leave');
    assert.notEqual(s.state.thread.offers.get(card.id)!.status, 'open');
    assert.ok(plan(s).removed);
    assert.deepEqual((await followOn(alice, nas.via)).map((x) => x.op === 'plan.doc' && x.plan), ['gate']);
    assert.match(await readFile(file('gate'), 'utf8'), /state: removed/);
  });
});

describe("a page's card, in words", () => {
  test('the card says what changed, and which fields only the planner changes', async () => {
    const s = await fresh();
    const p = s.state.plans.get('gate')!;
    const tz = zoneOf(s.state);
    const words = pageDriftWords(p, {
      plan: 'gate', theirs: THEIRS, unreadable: false, resolved: null,
      changes: [
        { field: 'due', from: '2026-11-20', to: '2026-11-27' },
        { field: 'notes', from: 'a', to: 'b' },
        { field: 'checklist', from: [{ text: 'Buy hinges', done: false }, { text: 'Fit them', done: false }],
          to: [{ text: 'Buy hinges', done: true }, { text: 'Fit them ', done: true }, { text: 'Oil them', done: false }] },
        { field: 'estimate', from: null, to: 12_500 },
        { field: 'people', from: [], to: ['contacts:77'] },
        { field: 'envelope', from: null, to: 'house-repairs' },
      ],
    }, tz);
    assert.equal(words.summary, 'The page for Fix the gate was changed in Drive: due date Fri 20 Nov → Fri 27 Nov');
    assert.deepEqual(words.effects, [
      'Due date Fri 20 Nov → Fri 27 Nov',
      'Notes changed',
      'Checklist changed (2 ticked, 1 new)',
      'Estimate none → $125.00',
      'People: only the planner changes this, so taking the change leaves it',
      'Envelope: only the planner changes this, so taking the change leaves it',
      LEAVE,
    ]);
    assert.ok(!words.effects.some((w) => /alice|bob|someone/i.test(w)), 'Drive does not say who');
    const gone = pageDriftWords(p, { plan: 'gate', theirs: THEIRS, unreadable: true, resolved: null, changes: [] }, tz);
    assert.equal(gone.summary, 'The page for Fix the gate was changed in Drive and can no longer be read');
    assert.deepEqual(gone.effects, ['Nothing on it can be taken: put the page back, or leave both', LEAVE]);
    // A date taken away, and a checklist only reordered.
    const more = pageDriftWords(p, { plan: 'gate', theirs: THEIRS, unreadable: false, resolved: null, changes: [
      { field: 'due', from: '2026-11-20', to: null },
      { field: 'checklist', from: [{ text: 'a', done: false }, { text: 'b', done: false }], to: [{ text: 'b', done: false }, { text: 'a', done: false }] },
    ] }, tz);
    assert.deepEqual(more.effects, ['Due date Fri 20 Nov → no date', 'Checklist changed', LEAVE]);
  });
});
