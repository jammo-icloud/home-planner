import './planner-root.ts';
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cents } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { replay, ReplayError } from '../src/replay.ts';
import { scopeOf } from '../src/restore.ts';
import { isChange } from '../src/activity.ts';
import { card } from '../src/plans.ts';
import { pageView } from '../src/plan-rules.ts';
import { updatePlan } from '../src/plan-edits.ts';
import type { DsmFetch } from '../src/synology.ts';
import {
  PAGE_BATCH, PAGE_NAME, PAGE_RETRY_MS, followOn, pageBehind, parsePlanPage, renderPlanPage, writePlanPage,
} from '../src/pages.ts';
import { renderFrontmatter } from '../src/frontmatter.ts';
import { describe as describeEvent, ProposalStore } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import type { Event } from '../src/types.ts';
import { fakeNas } from './fake-nas.ts';
import type { FakeNas } from './fake-nas.ts';
import { chooseFolderIn } from './folder.ts';

const NOW = '2026-10-29T09:00:00Z';
const DAY = '2026-10-29';
const DOC = { link: 'drive:link/gate', file_id: 'f-1', hash: 'sha256:abc', version_id: 'v-1', path: '/Planner/Plans/Fix the gate.md' };
const CAL = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };

/** A household with alice and bob, and one plan: Fix the gate, in House; its documents in Planner/h1 unless `folder` is false. */
async function fresh(o: { folder?: boolean } = {}): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-pages-')), 'events.jsonl');
  const s = new Store({ path, now: () => new Date(NOW) });
  await s.load();
  await s.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
    { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
  ]);
  if (o.folder !== false) await chooseFolderIn(s);
  return s;
}

const plan = (s: Store, id = 'gate') => s.state.plans.get(id)!;

/** A write the log must refuse as a ReplayError, leaving nothing behind. */
async function refused(s: Store, op: Record<string, unknown>, message: RegExp): Promise<void> {
  const before = (await s.since(null)).length;
  await assert.rejects(() => s.append('alice', op as never),
    (e: unknown) => e instanceof ReplayError && message.test(e.message), JSON.stringify(op));
  assert.equal((await s.since(null)).length, before, 'nothing was written');
}

describe("a plan's page in the log", () => {
  test("a new plan's page event is its create, and it has no page yet", async () => {
    const s = await fresh();
    const create = (await s.since(null)).find((e) => e.op === 'plan.create')!;
    assert.equal(plan(s).pageEvent, create.id);
    assert.equal(plan(s).page, null);
  });

  test('a change to what the page shows moves it; an etag, a link or an ask does not', async () => {
    const s = await fresh();
    const [notes] = await s.append('alice', { op: 'plan.set', plan: 'gate', notes: 'The latch sticks.' });
    assert.equal(plan(s).pageEvent, notes!.id);

    await s.append('alice', { op: 'plan.calendar.link', plan: 'gate', kind: 'due', ...CAL, evt_id: 101, ical_uid: 'uid-101', dav_etag: 'E1' });
    assert.equal(plan(s).pageEvent, notes!.id, 'a calendar link is not on the page');
    await s.append('alice', { op: 'plan.calendar.etag', plan: 'gate', evt_id: 101, dav_etag: 'E2' });
    assert.equal(plan(s).pageEvent, notes!.id, 'an etag is not on the page');
    await s.append('alice', { op: 'plan.ask', plan: 'gate', to: 'bob', why: 'you have the tools' });
    assert.equal(plan(s).pageEvent, notes!.id, 'an ask is not on the page');

    // Saying the same thing again changes nothing the page shows.
    await s.append('alice', { op: 'plan.set', plan: 'gate', notes: 'The latch sticks.' });
    assert.equal(plan(s).pageEvent, notes!.id, 'the same notes again do not move it');

    const [due] = await s.append('alice', { op: 'plan.due', plan: 'gate', due: '2026-11-05' });
    assert.equal(plan(s).pageEvent, due!.id);
  });

  test('renaming an area moves the page event of every plan in it', async () => {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.create', plan: 'shed', title: 'Clear the shed', area: 'House' },
      { op: 'plan.create', plan: 'roof', title: 'Patch the roof', area: 'House', parent: 'shed' },
    ]);
    const [rename] = await s.append('alice', { op: 'areas.rename', from: 'House', to: 'Home' });
    for (const id of ['gate', 'shed', 'roof']) assert.equal(plan(s, id).pageEvent, rename!.id, id);

    // A shelf's move takes its items with it, and their pages move too.
    const areas = s.state.settings.areas;
    await s.append('alice', { op: 'areas.set', areas: [...areas, 'Garden'] });
    const [move] = await s.append('alice', { op: 'plan.set', plan: 'shed', area: 'Garden' });
    assert.equal(plan(s, 'shed').pageEvent, move!.id);
    assert.equal(plan(s, 'roof').pageEvent, move!.id);
    assert.equal(plan(s, 'gate').pageEvent, rename!.id, 'a plan the move did not touch keeps its event');
  });

  test('plan.doc records what was written and leaves the page event alone', async () => {
    const s = await fresh();
    const p = plan(s);
    const [d] = await s.append('alice', { op: 'plan.doc', plan: 'gate', doc: DOC, event: p.pageEvent });
    assert.deepEqual(plan(s).page, { doc: DOC, event: p.pageEvent });
    assert.equal(plan(s).pageEvent, p.pageEvent);
    assert.equal(scopeOf(d!), 'plans');
    assert.equal(describeEvent(d!, s.state).what, 'kept the page for Fix the gate in Drive up to date');
  });

  test('on a removed plan it is kept; on no plan, or with a bad doc, it is refused', async () => {
    const s = await fresh();
    const [removed] = await s.append('alice', { op: 'plan.remove', plan: 'gate', why: 'fixed it in passing' });
    assert.equal(plan(s).pageEvent, removed!.id, 'a removed plan says so on its page');
    await s.append('alice', { op: 'plan.doc', plan: 'gate', doc: DOC, event: removed!.id });
    assert.deepEqual(plan(s).page, { doc: DOC, event: removed!.id });

    await refused(s, { op: 'plan.doc', plan: 'nope', doc: DOC, event: removed!.id }, /no such plan: nope/);
    await refused(s, { op: 'plan.doc', plan: 'gate', doc: { ...DOC, hash: '' }, event: removed!.id },
      /a document is named by its link, file_id, hash, version_id and path/);
    await refused(s, { op: 'plan.doc', plan: 'gate', doc: 'drive:link/gate', event: removed!.id },
      /a document is named by its link, file_id, hash, version_id and path/);

    // Claude does not write pages into the log.
    assert.throws(() => replay([{ id: 'c1', at: NOW, who: 'claude', op: 'plan.doc', plan: 'gate', doc: DOC, event: 'x' } as Event]),
      (e: unknown) => e instanceof ReplayError && /claude cannot plan\.doc/.test(e.message));
  });

  test("it is not a change, and not on the card's history", async () => {
    const s = await fresh();
    const [docEvent] = await s.append('alice', { op: 'plan.doc', plan: 'gate', doc: DOC, event: plan(s).pageEvent });
    assert.equal(isChange(docEvent!), false);
    const history = card(s.state, await s.since(null), 'gate', { who: 'alice', today: DAY }).history;
    assert.ok(history.length > 0, 'the create is on it');
    assert.ok(!history.some((h) => /page/.test(h.what)));
  });

  test('pageView: people by contact id, files by name, a removed plan says so', async () => {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.set', plan: 'gate', notes: 'The latch sticks.', estimate: cents(12_500), chips: ['outside'],
        envelope: { budget: 'home', envelope: 'repairs' } },
      { op: 'plan.due', plan: 'gate', due: '2026-11-05' },
      { op: 'plan.contact.link', plan: 'gate', contact_id: 7, addressbook_id: 1, display: 'Sam the fixer' },
      { op: 'plan.contact.link', plan: 'gate', contact_id: 3, addressbook_id: 1, display: 'Neighbour' },
      { op: 'plan.attach', plan: 'gate', path: 'plans/gate/quote.pdf', name: 'quote.pdf', size: 1200 },
      { op: 'plan.attach', plan: 'gate', path: 'plans/gate/latch.jpg', name: 'latch.jpg', size: 3400 },
      { op: 'plan.checklist', plan: 'gate', items: [
        { id: 'i1', text: 'Buy a latch', done: true },
        { id: 'i2', text: 'Fit it', done: false },
      ] },
      { op: 'plan.state', plan: 'gate', state: 'doing' },
    ]);
    assert.deepEqual(pageView(plan(s)), {
      id: 'gate', title: 'Fix the gate', area: 'House', state: 'doing', parent: null, due: '2026-11-05',
      people: ['contacts:7', 'contacts:3'], envelope: 'repairs', estimate: 12_500, notes: 'The latch sticks.',
      checklist: [{ text: 'Buy a latch', done: true }, { text: 'Fit it', done: false }],
      files: ['quote.pdf', 'latch.jpg'],
    });

    await s.append('alice', { op: 'plan.remove', plan: 'gate', why: 'done another way' });
    assert.equal(pageView(plan(s)).state, 'removed');
  });
});

/** The spec's water heater, every field set. */
async function heater(): Promise<Store> {
  const s = await fresh();
  await s.append('alice', [
    { op: 'plan.create', plan: 'heater', title: 'Replace the water heater', area: 'House' },
    { op: 'plan.state', plan: 'heater', state: 'doing' },
    { op: 'plan.due', plan: 'heater', due: '2026-11-20' },
    { op: 'plan.contact.link', plan: 'heater', contact_id: 4123, addressbook_id: 1, display: 'Sandoval Plumbing' },
    { op: 'plan.set', plan: 'heater', envelope: { budget: 'home', envelope: 'house-repairs' }, estimate: cents(185_000),
      notes: 'Why: the old one is 14 years old and the pan has rust.' },
    { op: 'plan.checklist', plan: 'heater', items: [
      { id: 'i1', text: 'Get two quotes', done: true },
      { id: 'i2', text: 'Pick an installer', done: false },
      { id: 'i3', text: 'Book the day', done: false },
    ] },
    { op: 'plan.attach', plan: 'heater', path: '/Planner/home/heater/quote-abc.pdf', name: 'quote-abc.pdf', size: 10 },
    { op: 'plan.attach', plan: 'heater', path: '/Planner/home/heater/quote-xyz.pdf', name: 'quote-xyz.pdf', size: 20 },
  ]);
  return s;
}

describe("a plan's page, rendered and read back", () => {
  test('the page is called plan.md', () => assert.equal(PAGE_NAME, 'plan.md'));

  test("the spec's water heater, exactly", async () => {
    const s = await heater();
    const p = plan(s, 'heater');
    assert.equal(renderPlanPage(s.state, 'heater'), [
      '---', 'planner: 1', 'kind: plan', 'id: heater', 'title: Replace the water heater', 'area: House', 'state: doing',
      'parent: null', 'due: 2026-11-20', 'people: [contacts:4123]', 'envelope: house-repairs',
      'estimate: 185000  # cents, as everywhere', `event: ${p.pageEvent}  # the last log event this page reflects`, '---', '',
      '# Replace the water heater', '', 'Why: the old one is 14 years old and the pan has rust.', '',
      '## Checklist', '- [x] Get two quotes', '- [ ] Pick an installer', '- [ ] Book the day', '',
      '## Files', '- quote-abc.pdf', '- quote-xyz.pdf', ''].join('\n'));
  });

  test('the same state renders the same bytes', async () => {
    const s = await heater();
    assert.equal(renderPlanPage(s.state, 'heater'), renderPlanPage(s.state, 'heater'));
    // The same log, replayed into a second state.
    const again = replay(await s.since(null));
    assert.equal(renderPlanPage(again, 'heater'), renderPlanPage(s.state, 'heater'));
  });

  test('read back, a page is the view it was rendered from', async () => {
    const s = await heater();
    await s.append('alice', { op: 'plan.create', plan: 'bare', title: 'Bare', area: 'House' });
    for (const id of ['heater', 'bare', 'gate']) {
      const parsed = parsePlanPage(renderPlanPage(s.state, id));
      assert.ok(parsed, id);
      assert.deepEqual(parsed.view, pageView(plan(s, id)), id);
      assert.equal(parsed.event, plan(s, id).pageEvent, id);
    }
    // A bare plan: nothing set, nothing listed.
    assert.deepEqual(parsePlanPage(renderPlanPage(s.state, 'bare'))!.view, {
      id: 'bare', title: 'Bare', area: 'House', state: 'planning', parent: null, due: null, people: [],
      envelope: null, estimate: null, notes: '', checklist: [], files: [],
    });
  });

  test('a shelf item, several people and a removed plan read back too', async () => {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.create', plan: 'roof', title: 'Patch the roof: "soon"', area: 'House', parent: 'gate' },
      { op: 'plan.contact.link', plan: 'roof', contact_id: 7, addressbook_id: 1, display: 'Sam' },
      { op: 'plan.contact.link', plan: 'roof', contact_id: 3, addressbook_id: 1, display: 'Kim' },
      { op: 'plan.remove', plan: 'roof', why: 'not needed' },
    ]);
    const parsed = parsePlanPage(renderPlanPage(s.state, 'roof'))!;
    assert.deepEqual(parsed.view, pageView(plan(s, 'roof')));
    assert.equal(parsed.view.state, 'removed');
    assert.equal(parsed.view.parent, 'gate');
    assert.deepEqual(parsed.view.people, ['contacts:7', 'contacts:3']);
  });

  test('notes with a "## Checklist" line of their own read back whole', async () => {
    const s = await fresh();
    const notes = 'First line.\n\n## Checklist\n- [x] not really\n\nMore after it.';
    await s.append('alice', [
      { op: 'plan.set', plan: 'gate', notes },
      { op: 'plan.checklist', plan: 'gate', items: [{ id: 'i1', text: 'Buy a latch', done: true }] },
    ]);
    const parsed = parsePlanPage(renderPlanPage(s.state, 'gate'))!;
    assert.equal(parsed.view.notes, notes);
    assert.deepEqual(parsed.view.checklist, [{ text: 'Buy a latch', done: true }]);
    assert.deepEqual(parsed.view, pageView(plan(s)));
  });

  test('blank notes leave no gap, and the checklist accepts - or *, x or X', () => {
    const fm = renderFrontmatter('plan', {
      planner: 1, kind: 'plan', id: 'p', title: 'P', area: 'House', state: 'planning', parent: null, due: null,
      people: [], envelope: null, estimate: null, event: 'e1',
    });
    const parsed = parsePlanPage(`${fm}# P\n\n## Checklist\n* [X] one\n- [x] two\n* [ ] three\n\n## Files\n- a.pdf\n`)!;
    assert.equal(parsed.view.notes, '');
    assert.deepEqual(parsed.view.checklist, [
      { text: 'one', done: true }, { text: 'two', done: true }, { text: 'three', done: false }]);
    assert.deepEqual(parsed.view.files, ['a.pdf']);
  });

  test('an editor who empties a nullable key gets null; an emptied people is no one', () => {
    const text = [
      '---', 'planner: 1', 'kind: plan', 'id: p', 'title: P', 'area: House', 'state: doing', 'parent:', 'due:',
      'people:', 'envelope:', 'estimate:', 'event: e9', '---', '', '# P', '', '## Checklist', '', '## Files', ''].join('\n');
    const parsed = parsePlanPage(text)!;
    assert.equal(parsed.view.parent, null);
    assert.equal(parsed.view.due, null);
    assert.equal(parsed.view.envelope, null);
    assert.equal(parsed.view.estimate, null);
    assert.deepEqual(parsed.view.people, []);
    assert.deepEqual(parsed.view.checklist, []);
    assert.deepEqual(parsed.view.files, []);
    assert.equal(parsed.event, 'e9');
    assert.deepEqual(parsePlanPage(text.replace('people:', 'people: []'))!.view.people, []);
  });

  test('a page saved with Windows line endings reads as the same page', async () => {
    const s = await heater();
    const lf = renderPlanPage(s.state, 'heater');
    const crlf = lf.replaceAll('\n', '\r\n');
    assert.notEqual(crlf, lf);
    const parsed = parsePlanPage(crlf)!;
    assert.deepEqual(parsed, parsePlanPage(lf));
    assert.deepEqual(parsed.view, pageView(plan(s, 'heater')));
    assert.equal(parsed.view.notes, 'Why: the old one is 14 years old and the pan has rust.');
  });

  test('a page with a heading gone is unreadable, not emptied; trailing spaces on a heading are fine', async () => {
    const s = await heater();
    const page = renderPlanPage(s.state, 'heater');
    assert.equal(parsePlanPage(page.replace('## Checklist\n', '')), null, 'no Checklist heading');
    assert.equal(parsePlanPage(page.replace('## Files\n', '')), null, 'no Files heading');
    assert.equal(parsePlanPage(page.replace('\n## Files\n- quote-abc.pdf\n- quote-xyz.pdf\n', '')), null, 'no Files section');
    const spaced = parsePlanPage(page.replace('## Checklist\n', '## Checklist   \n').replace('## Files\n', '## Files \t\n'))!;
    assert.deepEqual(spaced, parsePlanPage(page));
    assert.deepEqual(spaced.view, pageView(plan(s, 'heater')));
  });

  test('not a plan page is null', () => {
    const briefing = renderFrontmatter('briefing', {
      planner: 1, kind: 'briefing', day: '2026-10-29', source: 'x', budget: 'home', writtenBy: 'claude' }) + 'Morning.\n';
    assert.equal(parsePlanPage(briefing), null);
    assert.equal(parsePlanPage('# Just markdown\n\nno fence here\n'), null);
    assert.equal(parsePlanPage(''), null);
    const page = (planner: number) => [
      '---', `planner: ${planner}`, 'kind: plan', 'id: p', 'title: P', 'area: House', 'state: doing', 'parent: null',
      'due: null', 'people: []', 'envelope: null', 'estimate: null', 'event: e1', '---', '', '# P', '', '## Checklist', '', '## Files', ''].join('\n');
    assert.ok(parsePlanPage(page(1)));
    assert.equal(parsePlanPage(page(2)), null);
  });
});

describe("a plan's page, kept in Drive", () => {
  let nas: FakeNas;
  let sid = '';
  before(async () => { nas = await fakeNas(); sid = await nas.signIn('alice'); });
  after(async () => { await nas.close(); });

  const member = (s: Store, o: { sid?: string | null; household?: string | null } = {}): ToolContext => {
    const household = o.household === undefined ? 'h1' : o.household;
    return {
      store: s, who: 'alice', today: DAY, proposals: new ProposalStore(), sid: o.sid === undefined ? sid : o.sid,
      ...(household === null ? {} : { household }),
    };
  };
  const isUpload = (m: string, p: string): boolean => m === 'PUT' && p.endsWith('/files/upload');
  const uploads = (): number => nas.calls.filter((c) => isUpload(c.method, c.path)).length;

  test("a page is written beside the plan's files, and plan.doc names it", async () => {
    const s = await fresh();
    const ctx = member(s);
    assert.ok(pageBehind(plan(s)), 'a new plan has no page yet');
    const [d] = await writePlanPage(ctx, 'gate', nas.via);
    assert.equal(d!.op, 'plan.doc');
    assert.equal(d!.who, 'alice');
    assert.equal(plan(s).page!.event, plan(s).pageEvent);
    assert.equal(plan(s).page!.doc.path, '/team-folders/Planner/h1/gate/plan.md');
    assert.ok(!pageBehind(plan(s)));
    assert.equal(await readFile(join(nas.nas.root, 'Planner/h1/gate/plan.md'), 'utf8'), renderPlanPage(s.state, 'gate'));
    // Not behind: nothing is written, and Drive is not asked.
    const before = nas.calls.length;
    assert.deepEqual(await writePlanPage(ctx, 'gate', nas.via), []);
    assert.equal(nas.calls.length, before);
  });

  test('only pages that are behind are written, oldest first', async () => {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.create', plan: 'shed', title: 'Clear the shed', area: 'House' },
      { op: 'plan.create', plan: 'roof', title: 'Patch the roof', area: 'House' },
    ]);
    const ctx = member(s);
    const first = uploads();
    const docs = await followOn(ctx, nas.via);
    assert.deepEqual(docs.map((e) => e.op === 'plan.doc' && e.plan), ['gate', 'shed', 'roof']);
    assert.equal(uploads() - first, 3);
    assert.ok(![...s.state.plans.values()].some(pageBehind));

    const again = uploads();
    assert.deepEqual(await followOn(ctx, nas.via), []);
    assert.equal(uploads(), again, 'nothing behind, nothing written');

    // A change to one page: that one is behind, and only it is written.
    await s.append('bob', { op: 'plan.set', plan: 'shed', notes: 'The mower is in the way.' });
    assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['shed']);
    assert.match(await readFile(join(nas.nas.root, 'Planner/h1/shed/plan.md'), 'utf8'), /The mower is in the way\./);
    // Just one plan, when asked for one.
    await s.append('bob', [
      { op: 'plan.set', plan: 'gate', notes: 'Latch.' },
      { op: 'plan.set', plan: 'roof', notes: 'Tiles.' },
    ]);
    assert.deepEqual((await followOn(ctx, nas.via, 'roof')).map((e) => e.op === 'plan.doc' && e.plan), ['roof']);
    assert.ok(pageBehind(plan(s, 'gate')));
  });

  test('a plan edit never waits for its page to upload, and the page it overtook is written again', async () => {
    const s = await fresh();
    const ctx = member(s);
    // The upload is held until it is let go; everything else goes straight through.
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    let reached!: () => void;
    const uploading = new Promise<void>((resolve) => { reached = resolve; });
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(input instanceof Request ? input.url : input).includes('/files/upload')) {
        reached();
        await held;
      }
      return nas.via(input, init);
    }) as DsmFetch;

    const writing = writePlanPage(ctx, 'gate', slow);
    await uploading;
    let settled = false;
    const edit = updatePlan(ctx, 'gate', { notes: 'The latch sticks.' }).then((p) => { settled = true; return p; });
    // Neither waits on the other long: the edit must settle while the upload is still held.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([edit.then(() => 'edit'), new Promise((r) => { timer = setTimeout(() => r('timeout'), 1000); })]);
    clearTimeout(timer);
    if (first !== 'edit') letGo();
    assert.equal(first, 'edit', 'the edit settled while the upload was in flight');
    assert.ok(settled);
    assert.equal(plan(s).notes, 'The latch sticks.');

    letGo();
    const [d] = await writing;
    assert.equal(d!.op, 'plan.doc');
    // The page written shows the plan from before the edit, and the log says so: it is still behind.
    assert.notEqual(plan(s).page!.event, plan(s).pageEvent);
    assert.ok(pageBehind(plan(s)));
    assert.doesNotMatch(await readFile(join(nas.nas.root, 'Planner/h1/gate/plan.md'), 'utf8'), /The latch sticks/);

    assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['gate']);
    assert.ok(!pageBehind(plan(s)));
    assert.match(await readFile(join(nas.nas.root, 'Planner/h1/gate/plan.md'), 'utf8'), /The latch sticks/);
  });

  test(`at most ${PAGE_BATCH} pages at a time`, async () => {
    assert.equal(PAGE_BATCH, 25);
    const s = await fresh();
    await s.append('alice', Array.from({ length: PAGE_BATCH }, (_, i) =>
      ({ op: 'plan.create' as const, plan: `p${i}`, title: `Plan ${i}`, area: 'House' })));
    const ctx = member(s);
    assert.equal((await followOn(ctx, nas.via)).length, PAGE_BATCH);
    assert.deepEqual([...s.state.plans.values()].filter(pageBehind).map((p) => p.id), ['p24'], 'the newest waits');
    assert.equal((await followOn(ctx, nas.via)).length, 1);
  });

  test('a refused write leaves the page behind, and Drive is not asked again for a while', async () => {
    assert.equal(PAGE_RETRY_MS, 10 * 60 * 1000);
    const warn = mock.method(console, 'warn', () => {});
    const s = await fresh();
    await s.append('alice', { op: 'plan.create', plan: 'shed', title: 'Clear the shed', area: 'House' });
    const ctx = member(s);
    nas.fail(isUpload, 1003);
    try {
      const first = uploads();
      assert.deepEqual(await followOn(ctx, nas.via), []);
      assert.equal(uploads() - first, 1, 'a refusal stops the batch');
      const before = nas.calls.length;
      assert.deepEqual(await followOn(ctx, nas.via), []);
      assert.equal(nas.calls.length, before, 'backed off');
      assert.ok(pageBehind(plan(s)));
      assert.ok(!(await s.since(null)).some((e) => e.op === 'plan.doc'), 'a page Drive did not take is not recorded');
      for (const c of warn.mock.calls) assert.ok(!String(c.arguments[0]).includes(sid), 'the sid is in no log line');

      // Past the wait, Drive is asked again.
      nas.ok();
      mock.timers.enable({ apis: ['Date'], now: Date.now() + PAGE_RETRY_MS + 1 });
      assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['gate', 'shed']);
    } finally {
      mock.timers.reset();
      nas.ok();
      warn.mock.restore();
    }
  });

  test("a member's session that ended stops the batch, and backs no one else off", async () => {
    const warn = mock.method(console, 'warn', () => {});
    const s = await fresh();
    await s.append('alice', { op: 'plan.create', plan: 'shed', title: 'Clear the shed', area: 'House' });
    const ctx = member(s);
    nas.fail(isUpload, 119);
    try {
      const first = uploads();
      assert.deepEqual(await followOn(ctx, nas.via), []);
      assert.equal(uploads() - first, 1, 'the batch stops: the rest would end the same way');
      assert.ok(pageBehind(plan(s)));
      assert.ok(!(await s.since(null)).some((e) => e.op === 'plan.doc'), 'nothing recorded');
      for (const c of warn.mock.calls) assert.ok(!String(c.arguments[0]).includes(sid), 'the sid is in no log line');
      // Not Drive refusing: the next member with a session is not made to wait ten minutes.
      nas.ok();
      assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['gate', 'shed']);
    } finally {
      nas.ok();
      warn.mock.restore();
    }
  });

  test('a plan removed before it ever had a page gets none', async () => {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.create', plan: 'shed', title: 'Clear the shed', area: 'House' },
      { op: 'plan.remove', plan: 'shed', why: 'cleared it in passing' },
    ]);
    const before = uploads();
    assert.deepEqual((await followOn(member(s), nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['gate']);
    assert.equal(uploads() - before, 1, 'the live plan only');
    assert.deepEqual(await writePlanPage(member(s), 'shed', nas.via), []);
    assert.equal(plan(s, 'shed').page, null);
    assert.deepEqual(await followOn(member(s), nas.via), [], 'and it is never behind for it');
  });

  test('no session, no household: nothing is asked', async () => {
    const s = await fresh();
    const before = nas.calls.length;
    for (const ctx of [member(s, { sid: null }), member(s, { household: null })]) {
      assert.deepEqual(await followOn(ctx, nas.via), []);
      assert.deepEqual(await writePlanPage(ctx, 'gate', nas.via), []);
    }
    assert.equal(nas.calls.length, before);
    assert.ok(pageBehind(plan(s)));
    // Not a refusal: with a session, the page is written straight away.
    assert.equal((await followOn(member(s), nas.via)).length, 1);
  });

  test('no folder, no page: the follow-on asks nothing', async () => {
    const s = await fresh({ folder: false });
    const before = nas.calls.length;
    assert.deepEqual(await followOn(member(s), nas.via), []);
    assert.deepEqual(await writePlanPage(member(s), 'gate', nas.via), []);
    assert.equal(nas.calls.slice(before).filter((c) => isUpload(c.method, c.path)).length, 0, 'no upload');
    assert.equal(nas.calls.length, before, 'nothing is asked of Drive');
    assert.ok(pageBehind(plan(s)));
  });

  test('an attachment already named plan.md is never written over', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const s = await fresh();
      await s.append('alice', [
        { op: 'plan.create', plan: 'shed', title: 'Clear the shed', area: 'House' },
        { op: 'plan.attach', plan: 'gate', path: '/Planner/h1/gate/Plan.MD', name: 'Plan.MD', size: 12 },
      ]);
      const folder = join(nas.nas.root, 'Planner/h1/gate');
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'plan.md'), 'my own notes');
      const ctx = member(s);
      assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['shed']);
      assert.deepEqual(await writePlanPage(ctx, 'gate', nas.via), []);
      assert.deepEqual(await followOn(ctx, nas.via), []);
      assert.equal(await readFile(join(folder, 'plan.md'), 'utf8'), 'my own notes');
      assert.ok(pageBehind(plan(s)));
      const said = warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith('[pages]'));
      assert.equal(said.length, 1, 'said once');
      assert.match(said[0]!, /gate/);
      assert.ok(!said[0]!.includes(sid));
    } finally {
      warn.mock.restore();
    }
  });
});
