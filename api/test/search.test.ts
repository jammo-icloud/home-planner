import './planner-root.ts';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { ProposalStore } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { build } from '../src/thread.ts';
import { followOn } from '../src/pages.ts';
import { briefingFile, renderAnswerPage, renderBriefingPage, writeDoc } from '../src/docs.ts';
import { offer } from '../src/offers.ts';
import { uploadFile } from '../src/synology.ts';
import type { DsmFetch } from '../src/synology.ts';
import { RECORD_MAX, SEARCH_KINDS, SEARCH_MAX, searchHousehold, searchRecord } from '../src/search.ts';
import type { SearchHit } from '../src/search.ts';
import { fakeNas } from './fake-nas.ts';
import type { FakeNas } from './fake-nas.ts';
import { chooseFolderIn } from './folder.ts';

const NOW = '2026-10-29T09:00:00Z';
const DAY = '2026-10-29';

/** A household with alice and bob, and one plan: Fix the gate, in House; its documents in Planner/h1 unless `folder` is false. */
async function fresh(o: { folder?: boolean } = {}): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-search-')), 'events.jsonl');
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

const kinds = (hits: readonly SearchHit[]) => hits.map((h) => h.kind);
const isSearch = (_m: string, p: string): boolean => p.endsWith('/files/search');

describe('search across the household', () => {
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

  test('no folder chosen: Drive is not asked, and the log still is', async () => {
    const s = await fresh({ folder: false });
    const before = nas.calls.length;
    const r = await searchHousehold(member(s), 'gate', undefined, nas.via);
    assert.equal(r.documents, 'not searched');
    assert.deepEqual(kinds(r.hits), ['plan']);
    assert.equal(nas.calls.length, before, 'Drive was not asked');
  });

  test('what may be asked for, and how many come back', () => {
    assert.deepEqual(SEARCH_KINDS, ['plan', 'briefing', 'answer', 'file']);
    assert.equal(SEARCH_MAX, 8);
  });

  test('a plan is found by words on its page, once, with the passage', async () => {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.set', plan: 'gate', notes: 'Why: the old one is 14 years old and the pan has rust.' },
      { op: 'plan.create', plan: 'shed', title: 'Clear the shed', area: 'House' },
      { op: 'plan.set', plan: 'shed', notes: 'There is rust on the mower.' },
    ]);
    const ctx = member(s);
    assert.deepEqual((await followOn(ctx, nas.via)).map((e) => e.op === 'plan.doc' && e.plan), ['gate', 'shed']);
    // A removed plan's page is still in Drive, and still says rust: it is not a hit.
    await s.append('alice', { op: 'plan.remove', plan: 'shed', why: 'cleared it in passing' });

    const r = await searchHousehold(ctx, 'rust', undefined, nas.via);
    assert.deepEqual(r.hits.map((h) => [h.kind, h.open.plan]), [['plan', 'gate']]);
    assert.equal(r.hits[0]!.title, 'Fix the gate');
    assert.match(r.hits[0]!.passage, /rust/);
    assert.ok(r.hits[0]!.passage.length <= 240);
    assert.equal(r.documents, 'searched');
  });

  test("Drive's passage is text: its tags are taken out, and it is cut to 240", async () => {
    const s = await fresh();
    const ctx = member(s);
    await followOn(ctx, nas.via);
    const long = `<b>ga</b>te ${'and more <i>words</i> '.repeat(40)}<span class="x`;
    const tagged = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await nas.via(input, init);
      if (!String(input instanceof Request ? input.url : input).includes('/files/search')) return res;
      const body = await res.json() as { data: { items: { display_path: string; content_snippet: string }[] } };
      for (const i of body.data.items) if (i.display_path === '/team-folders/Planner/h1/gate/plan.md') i.content_snippet = long;
      return Response.json(body);
    }) as DsmFetch;
    const r = await searchHousehold(ctx, 'Fix the gate', undefined, tagged);
    const [hit] = r.hits.filter((h) => h.open.plan === 'gate');
    assert.ok(hit);
    assert.doesNotMatch(hit.passage, /[<>]/);
    assert.ok(hit.passage.startsWith('gate and more words'), hit.passage);
    assert.ok(hit.passage.length <= 240, String(hit.passage.length));
  });

  test('without a session a plan is still found by its title, and says documents were not searched', async () => {
    const s = await fresh();
    const [noted] = await s.append('bob', { op: 'thread.note', text: 'The gate squeaks again, by the way.' });
    const [asked] = await s.append('alice', { op: 'thread.ask', question: 'What would a new gate latch cost?' });
    const card = await offer(member(s, { sid: null }), {
      tool: 'create_plan', args: { title: 'Oil the gate hinge', area: 'House' }, prompt: { kind: 'member', ref: null },
    });

    const before = nas.calls.length;
    for (const ctx of [member(s, { sid: null }), member(s, { household: null })]) {
      const r = await searchHousehold(ctx, 'GATE', undefined, nas.via);
      assert.equal(r.documents, 'not searched');
      assert.deepEqual(r.hits.map((h) => [h.kind, h.open.plan ?? h.open.event]), [
        ['plan', 'gate'], ['thread', asked!.id], ['thread', noted!.id], ['thread', card.id],
      ]);
      assert.equal(r.hits[0]!.title, 'Fix the gate');
      assert.match(r.hits[1]!.passage, /gate latch/);
      assert.match(r.hits[3]!.passage, /Oil the gate hinge/);
    }
    assert.equal(nas.calls.length, before, 'Drive was not asked');

    // Drive refusing is the same: the log is still searched, and nothing is thrown.
    nas.fail(isSearch, 1000);
    try {
      const r = await searchHousehold(member(s), 'gate', undefined, nas.via);
      assert.equal(r.documents, 'not searched');
      assert.deepEqual(kinds(r.hits), ['plan', 'thread', 'thread', 'thread']);
    } finally {
      nas.ok();
    }
  });

  test('briefings and answers are found, with where to open them', async () => {
    const s = await fresh();
    const ctx = member(s);
    const briefing = await writeDoc(ctx, ['today', briefingFile(DAY, 'household')], renderBriefingPage({
      day: DAY, source: 'household', writtenBy: 'claude', headline: 'Cold this week',
      body: 'Bleed the radiators before Thursday.',
    }), nas.via);
    assert.ok(briefing);
    const [b] = await s.append('claude', {
      op: 'thread.briefing', day: DAY, source: 'household', headline: 'Cold this week', doc: briefing, writtenBy: 'claude',
    });

    const question = 'When does the sweep come?';
    const [asked] = await s.append('alice', { op: 'thread.ask', question });
    const answer = await writeDoc(ctx, ['answers', `${asked!.id}.md`], renderAnswerPage({
      replyTo: asked!.id, plan: null, model: 'claude-test', question,
      text: 'The chimney sweep comes on Friday morning.', tools: ['list_plans'],
    }), nas.via);
    assert.ok(answer);
    const [a] = await s.append('claude', {
      op: 'thread.answer', replyTo: asked!.id, text: 'The chimney sweep comes on Friday morning.',
      tools: [{ name: 'list_plans', args: {} }], model: 'claude-test', doc: answer,
    });

    const radiators = await searchHousehold(ctx, 'radiators', undefined, nas.via);
    assert.deepEqual(radiators.hits.map((h) => [h.kind, h.open]), [['briefing', { day: DAY, event: b!.id }]]);
    assert.equal(radiators.hits[0]!.title, 'Cold this week');
    assert.match(radiators.hits[0]!.passage, /radiators/);

    const friday = await searchHousehold(ctx, 'friday', undefined, nas.via);
    assert.deepEqual(friday.hits.map((h) => [h.kind, h.open]), [['answer', { event: a!.id }]]);
    assert.equal(friday.hits[0]!.title, question);

    // The question is in the log too: the answer from Drive first, then the question.
    const sweep = await searchHousehold(ctx, 'sweep', undefined, nas.via);
    assert.deepEqual(sweep.hits.map((h) => [h.kind, h.open.event]), [['answer', a!.id], ['thread', asked!.id]]);
  });

  test('briefings and answers kept in the log are found there, without a session', async () => {
    const s = await fresh();
    const [old] = await s.append('claude', {
      op: 'thread.briefing', day: DAY, source: 'household', headline: 'A quiet week',
      body: 'Nothing on the calendar; the radiators were bled last week.', writtenBy: 'fallback',
    });
    const [b] = await s.append('claude', {
      op: 'thread.briefing', day: DAY, source: 'household', headline: 'Cold this week',
      body: 'Bleed the radiators before Thursday, and check the boiler pressure.', writtenBy: 'claude', replaces: old!.id,
    });
    const question = 'When does the sweep come?';
    const [asked] = await s.append('alice', { op: 'thread.ask', question });
    const [a] = await s.append('claude', {
      op: 'thread.answer', replyTo: asked!.id, text: 'The chimney sweep comes on Friday morning.',
      tools: [], model: 'claude-test',
    });

    const ctx = member(s, { sid: null });
    const radiators = await searchHousehold(ctx, 'radiators', undefined, nas.via);
    assert.equal(radiators.documents, 'not searched');
    // Only the briefing that stands: the one it took the place of is not read twice.
    assert.deepEqual(radiators.hits.map((h) => [h.kind, h.open]), [['briefing', { day: DAY, event: b!.id }]]);
    assert.equal(radiators.hits[0]!.title, 'Cold this week');
    assert.match(radiators.hits[0]!.passage, /Bleed the radiators/);
    assert.ok(radiators.hits[0]!.passage.length <= 122);

    const friday = await searchHousehold(ctx, 'friday', undefined, nas.via);
    assert.deepEqual(friday.hits.map((h) => [h.kind, h.open]), [['answer', { event: a!.id }]]);
    assert.equal(friday.hits[0]!.title, question);
    assert.match(friday.hits[0]!.passage, /Friday morning/);
    assert.deepEqual((await searchHousehold(ctx, 'boiler', 'briefing', nas.via)).hits.map((h) => h.open.event), [b!.id]);
    assert.deepEqual((await searchHousehold(ctx, 'chimney', 'answer', nas.via)).hits.map((h) => h.open.event), [a!.id]);
  });

  test('a file on a card is a file hit', async () => {
    const s = await fresh();
    const ctx = member(s);
    await followOn(ctx, nas.via);
    const bytes = (t: string) => new TextEncoder().encode(t);
    await uploadFile(sid, { folder: '/Planner/h1/gate', name: 'quote.pdf', bytes: bytes('Boiler service and a new gate latch: $180') }, nas.via);
    // In the plan's folder, but not on its card: not a hit.
    await uploadFile(sid, { folder: '/Planner/h1/gate', name: 'stray.txt', bytes: bytes('boiler notes, never attached') }, nas.via);
    await s.append('alice', { op: 'plan.attach', plan: 'gate', path: '/Planner/h1/gate/quote.pdf', name: 'quote.pdf', size: 41 });

    const r = await searchHousehold(ctx, 'boiler', undefined, nas.via);
    assert.deepEqual(r.hits.map((h) => [h.kind, h.open]), [['file', { file: { plan: 'gate', name: 'quote.pdf' } }]]);
    assert.equal(r.hits[0]!.title, 'quote.pdf');
    assert.match(r.hits[0]!.passage, /Boiler service/);

    // Off the plan, or the plan gone: no longer a hit.
    await s.append('alice', { op: 'plan.detach', plan: 'gate', path: '/Planner/h1/gate/quote.pdf', why: 'paid' });
    assert.deepEqual((await searchHousehold(ctx, 'boiler', undefined, nas.via)).hits, []);
  });

  test("never another household's", async () => {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.create', plan: 'heater', title: 'Replace the water heater', area: 'House' },
      // A plan of h1's with the same id as the one in h2's folder.
      { op: 'plan.create', plan: 'x', title: 'Paint the fence', area: 'House' },
    ]);
    const ctx = member(s);
    await followOn(ctx, nas.via);

    // Drive that ignores `location`: h1's real answer, and other households' files beside it.
    const leakyCalls: { url: string; body: string }[] = [];
    const strays = [
      '/team-folders/Planner/h2/x/plan.md',
      '/team-folders/Planner/h10/x/plan.md',
      `/team-folders/Planner/h2/today/${DAY}-household.md`,
      '/team-folders/Planner/h1',
      '/team-folders/Elsewhere/h1/x/plan.md',
    ];
    const leaky = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes('/files/search')) return nas.via(input, init);
      leakyCalls.push({ url, body: String(init?.body) });
      const res = await nas.via(input, init);
      const body = await res.json() as { data: { items: Record<string, unknown>[] } };
      for (const path of strays) {
        body.data.items.push({
          file_id: '9', permanent_link: `stray-${path}`, name: path.slice(path.lastIndexOf('/') + 1), path, display_path: path,
          type: 'file', hash: 'h', version_id: 1, change_id: 1, max_id: 1, modified_time: 0, removed: false,
          content_snippet: 'the water heater in the other house',
        });
      }
      return Response.json(body);
    }) as DsmFetch;

    const r = await searchHousehold(ctx, 'heater', undefined, leaky);
    assert.ok(r.hits.every((h) => h.open.plan !== 'x'));
    assert.deepEqual(r.hits.map((h) => [h.kind, h.open.plan]), [['plan', 'heater']]);
    assert.equal(leakyCalls.length, 1);
    const sent = JSON.parse(leakyCalls[0]!.body) as { keyword: string; location: string };
    assert.equal(sent.location, '/team-folders/Planner/h1');
    assert.equal(sent.keyword, 'heater');
    assert.match(leakyCalls[0]!.url, /[?&]limit=50\b/);
    assert.ok(!leakyCalls[0]!.url.includes(sid) && !leakyCalls[0]!.body.includes(sid), 'the sid is in no URL or body');
  });

  test('kind narrows, and no more than SEARCH_MAX come back', async () => {
    const s = await fresh();
    await s.append('alice', [
      { op: 'plan.create', plan: 'p0', title: 'Clear the gutters', area: 'House' },
      { op: 'plan.create', plan: 'p1', title: 'Fix the downpipe', area: 'House' },
      { op: 'plan.set', plan: 'p1', notes: 'It runs into the gutter on the left.' },
    ]);
    const ctx = member(s);
    await followOn(ctx, nas.via);
    await uploadFile(sid, { folder: '/Planner/h1/p0', name: 'gutter-quote.txt', bytes: new TextEncoder().encode('Gutter guards, $90') }, nas.via);
    await s.append('alice', { op: 'plan.attach', plan: 'p0', path: '/Planner/h1/p0/gutter-quote.txt', name: 'gutter-quote.txt', size: 18 });
    const [noted] = await s.append('bob', { op: 'thread.note', text: 'The gutter is full of leaves.' });

    const all = await searchHousehold(ctx, 'gutter', undefined, nas.via);
    assert.deepEqual(all.hits.map((h) => [h.kind, h.open.plan ?? h.open.file?.plan ?? h.open.event]), [
      ['file', 'p0'], ['plan', 'p0'], ['plan', 'p1'], ['thread', noted!.id],
    ]);
    const files = await searchHousehold(ctx, 'gutter', 'file', nas.via);
    assert.deepEqual(files.hits.map((h) => [h.kind, h.open.file]), [['file', { plan: 'p0', name: 'gutter-quote.txt' }]]);
    const plans = await searchHousehold(ctx, 'gutter', 'plan', nas.via);
    assert.deepEqual(plans.hits.map((h) => [h.kind, h.open.plan]), [['plan', 'p0'], ['plan', 'p1']]);
    assert.deepEqual((await searchHousehold(ctx, 'gutter', 'answer', nas.via)).hits, []);

    await s.append('alice', Array.from({ length: 10 }, (_, i) =>
      ({ op: 'plan.create' as const, plan: `q${i}`, title: `Gutter run ${i}`, area: 'House' })));
    await followOn(ctx, nas.via);
    const many = await searchHousehold(ctx, 'gutter', undefined, nas.via);
    assert.equal(many.hits.length, SEARCH_MAX);
    const manyPlans = await searchHousehold(ctx, 'gutter', 'plan', nas.via);
    assert.equal(manyPlans.hits.length, SEARCH_MAX);
    assert.ok(manyPlans.hits.every((h) => h.kind === 'plan'));
    // Each plan once, however many ways it was found.
    assert.equal(new Set(manyPlans.hits.map((h) => h.open.plan)).size, SEARCH_MAX);
  });

  test('two letters at least, and only a kind there is', async () => {
    const ctx = member(await fresh(), { sid: null });
    await assert.rejects(() => searchHousehold(ctx, ' a ', undefined, nas.via), /search for at least two letters/);
    await assert.rejects(() => searchHousehold(ctx, 'gate', 'thread' as never, nas.via), /kind/);
  });

  // The record's search, on the same fake NAS: its folders are made once.
  const recordMember = (s: Store, o: { sid?: string | null; who?: string } = {}): ToolContext => ({
    store: s, who: o.who ?? 'alice', today: DAY, proposals: new ProposalStore(), sid: o.sid === undefined ? sid : o.sid, household: 'h1',
  });
  const ids = (r: { entries: { id: string }[] }): string[] => r.entries.map((e) => e.id);
  const raw = async (s: Store, by: string, args: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const [o] = await s.append(by, { op: 'proposal.offer', tool: 'move_money', args, summary: 'Dinner', effects: [], events: [],
      month: null, envelopes: [], fingerprint: '', prompt: { kind: 'member', ref: null }, ...over } as never);
    return o!;
  };

  test('each of a note, question, answer, briefing, change, removed payee and a card is found', async () => {
    const s = await fresh({ folder: false });
    await s.append('alice', [
      { op: 'category.add', category: 'groceries', label: 'Groceries' },
      { op: 'txn.add', txns: [{ id: 't1', date: DAY, payee: 'Quokka Market', amount: parseDollars('-1.00'), dedupeKey: 't1', envelope: null }] },
    ]);
    const [note] = await s.append('bob', { op: 'thread.note', text: 'Wombat is on the list.' });
    const [ask] = await s.append('alice', { op: 'thread.ask', question: 'Is the numbat fed?' });
    await s.append('claude', { op: 'thread.answer', replyTo: ask!.id, text: 'Yes, the numbat ate.', tools: [], model: 'm' });
    const [brief] = await s.append('claude', { op: 'thread.briefing', day: DAY, source: 'household',
      headline: 'Bilby week', body: 'Quiet.', writtenBy: 'claude' });
    const [change] = await s.append('alice', { op: 'plan.create', plan: 'wallaby', title: 'Wallaby fence', area: 'House' });
    await s.append('bob', { op: 'txn.remove', txn: 't1', why: 'dupe' });
    const card = await raw(s, 'bob', {}, { summary: 'Move to the dingo fund', effects: ['Kookaburra goes up'] });
    const ctx = recordMember(s, { sid: null });
    const find = async (w: string) => (await searchRecord(ctx, w, {}, nas.via)).entries;
    assert.deepEqual((await find('wombat')).map((e) => e.id), [note!.id]);
    assert.deepEqual((await find('numbat')).map((e) => e.id), [ask!.id]);
    assert.deepEqual((await find('bilby')).map((e) => e.id), [brief!.id]);
    assert.ok((await find('wallaby')).some((e) => e.id === change!.id));
    assert.deepEqual((await find('quokka')).map((e) => e.kind), ['change']);
    assert.deepEqual((await find('dingo')).map((e) => e.id), [card.id]);
    assert.deepEqual((await find('kookaburra')).map((e) => e.id), [card.id]);
  });

  test('a day of three entries, two matching, says so', async () => {
    const s = await fresh({ folder: false });
    await s.append('alice', { op: 'thread.note', text: 'Platypus one' });
    await s.append('bob', { op: 'thread.note', text: 'Platypus two' });
    await s.append('bob', { op: 'thread.note', text: 'Something else' });
    const r = await searchRecord(recordMember(s, { sid: null }), 'platypus', {}, nas.via);
    assert.equal(r.days.length, 1);
    assert.equal(r.days[0]!.count, 2);
    const sameDay = build(await s.since(null), s.state, 'alice').filter((e) => e.day === DAY).length;
    assert.equal(r.days[0]!.total, sameDay);
    assert.ok(sameDay >= 3);
    assert.equal(r.entries.length, 2);
    assert.equal(r.capped, false);
    assert.equal(r.documents, 'not searched');
  });

  test('a question found in its answer shows the match; found in the question, the answer opens', async () => {
    const s = await fresh({ folder: false });
    const [ask] = await s.append('alice', { op: 'thread.ask', question: 'When does the sweep come?' });
    await s.append('claude', { op: 'thread.answer', replyTo: ask!.id, text: 'The chimney sweep comes on Friday morning, early.', tools: [], model: 'm' });
    const ctx = recordMember(s, { sid: null });
    const inAnswer = await searchRecord(ctx, 'friday', {}, nas.via);
    assert.match(inAnswer.entries[0]!.passage ?? '', /Friday morning/);
    const inQuestion = await searchRecord(ctx, 'when does', {}, nas.via);
    assert.match(inQuestion.entries[0]!.passage ?? '', /^The chimney sweep/);
  });

  test('a briefing and an answer kept only in Drive are joined, with its passage; a replaced briefing is dropped', async () => {
    const s = await fresh();
    const ctx = recordMember(s);
    const old = await writeDoc(ctx, ['today', briefingFile(DAY, 'household')], renderBriefingPage({
      day: DAY, source: 'household', writtenBy: 'claude', headline: 'Old week', body: 'Bleed the radiators.',
    }), nas.via);
    const [o] = await s.append('claude', { op: 'thread.briefing', day: DAY, source: 'household', headline: 'Old week', doc: old!, writtenBy: 'claude' });
    const doc = await writeDoc(ctx, ['today', briefingFile(DAY, 'budget')], renderBriefingPage({
      day: DAY, source: 'budget', writtenBy: 'claude', headline: 'Cold week', body: 'Bleed the radiators before Thursday.',
    }), nas.via);
    const [b] = await s.append('claude', { op: 'thread.briefing', day: DAY, source: 'budget', headline: 'Cold week', doc: doc!, writtenBy: 'claude', replaces: o!.id });
    const question = 'When does the sweep come?';
    const [asked] = await s.append('alice', { op: 'thread.ask', question });
    const answer = await writeDoc(ctx, ['answers', `${asked!.id}.md`], renderAnswerPage({
      replyTo: asked!.id, plan: null, model: 'm', question, text: 'The chimney sweep comes on Friday morning.', tools: [],
    }), nas.via);
    await s.append('claude', { op: 'thread.answer', replyTo: asked!.id, text: 'Sweep: Friday', tools: [], model: 'm', doc: answer! });

    const r = await searchRecord(ctx, 'radiators', {}, nas.via);
    assert.equal(r.documents, 'searched');
    assert.deepEqual(ids(r), [b!.id]);
    assert.match(r.entries[0]!.passage ?? '', /radiators/);
    const f = await searchRecord(ctx, 'friday', {}, nas.via);
    assert.deepEqual(ids(f), [asked!.id]);
    assert.match(f.entries[0]!.passage ?? '', /Friday/);
  });

  test('a hundred and one notes cap at a hundred; Drive filling its answer caps too', async () => {
    const s = await fresh({ folder: false });
    await s.append('alice', Array.from({ length: 101 }, (_, i) => ({ op: 'thread.note' as const, text: `Zebra ${i}` })));
    const r = await searchRecord(recordMember(s, { sid: null }), 'zebra', {}, nas.via);
    assert.equal(RECORD_MAX, 100);
    assert.equal(r.entries.length, 100);
    assert.equal(r.capped, true);
    assert.equal(r.days[0]!.count, 100);
    assert.ok(r.entries.some((e) => e.kind === 'note' && e.text === 'Zebra 100'), 'the newest are kept');
    assert.ok(!r.entries.some((e) => e.kind === 'note' && e.text === 'Zebra 0'));

    const s2 = await fresh();
    const full = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await nas.via(input, init);
      if (!String(input instanceof Request ? input.url : input).includes('/files/search')) return res;
      const body = await res.json() as { data: { items: Record<string, unknown>[] } };
      const one = { file_id: '9', permanent_link: 'x', name: 'x', path: '/x', display_path: '/elsewhere/x', type: 'file', hash: 'h',
        version_id: 1, change_id: 1, max_id: 1, modified_time: 0, removed: false, content_snippet: '' };
      body.data.items = Array.from({ length: 50 }, () => one);
      return Response.json(body);
    }) as DsmFetch;
    await s2.append('alice', { op: 'thread.note', text: 'Zebra' });
    assert.equal((await searchRecord(recordMember(s2), 'zebra', {}, full)).capped, true);
    assert.equal((await searchRecord(recordMember(s2), 'zebra', {}, nas.via)).capped, false);
  });

  test('elsewhere is plans and files, eight at most, a file on its plan', async () => {
    const s = await fresh();
    await s.append('alice', Array.from({ length: 10 }, (_, i) => ({ op: 'plan.create' as const, plan: `q${i}`, title: `Gutter run ${i}`, area: 'House' })));
    const ctx = recordMember(s);
    await followOn(ctx, nas.via);
    await uploadFile(sid, { folder: '/Planner/h1/q0', name: 'gutter-quote.txt', bytes: new TextEncoder().encode('Gutter guards, $90') }, nas.via);
    await s.append('alice', { op: 'plan.attach', plan: 'q0', path: '/Planner/h1/q0/gutter-quote.txt', name: 'gutter-quote.txt', size: 18 });
    const r = await searchRecord(ctx, 'gutter', {}, nas.via);
    assert.equal(r.elsewhere.length, SEARCH_MAX);
    assert.ok(r.elsewhere.every((h) => h.kind === 'plan' || h.kind === 'file'));
    const file = r.elsewhere.find((h) => h.kind === 'file');
    assert.equal(file?.on, 'Gutter run 0');
    assert.equal(file?.open.file?.plan, 'q0');
  });

  test('a kind narrows; elsewhere goes under Budget and stays under Plans; a person keeps their rows', async () => {
    const s = await fresh({ folder: false });
    await s.append('alice', { op: 'thread.note', text: 'Gate note from alice' });
    const [bob] = await s.append('bob', { op: 'thread.note', text: 'Gate note from bob' });
    const ctx = recordMember(s, { sid: null });
    assert.equal((await searchRecord(ctx, 'gate', {}, nas.via)).elsewhere.length, 1);
    const budget = await searchRecord(ctx, 'gate', { lane: 'budget' }, nas.via);
    assert.deepEqual(budget.elsewhere, []);
    assert.deepEqual(budget.entries, []);
    assert.equal((await searchRecord(ctx, 'gate', { lane: 'plans' }, nas.via)).elsewhere.length, 1);
    const notes = await searchRecord(ctx, 'gate', { lane: 'notes' }, nas.via);
    assert.equal(notes.entries.length, 2);
    const only = await searchRecord(ctx, 'gate', { person: 'bob' }, nas.via);
    assert.equal(only.who, 'bob');
    assert.deepEqual(ids(only), [bob!.id]);
    const none = await searchRecord(ctx, 'gate', { person: 'casey' }, nas.via);
    assert.equal(none.who, 'everyone');
    assert.equal(none.entries.length, 3);
  });

  test("a card on someone's own calendar is found by nobody else", async () => {
    const s = await fresh({ folder: false });
    const mine = await raw(s, 'alice', { on: 'mine', for: 'alice' }, { tool: 'propose_event', summary: 'Dentist, Thursday' });
    const alice = await searchRecord(recordMember(s, { sid: null }), 'dentist', {}, nas.via);
    assert.deepEqual(ids(alice), [mine.id]);
    const bob = await searchRecord(recordMember(s, { sid: null, who: 'bob' }), 'dentist', {}, nas.via);
    assert.deepEqual(bob.entries, []);
  });
});
