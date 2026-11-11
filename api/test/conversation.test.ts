import './planner-root.ts';
import { test, describe, afterEach, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { ProposalStore, ToolError } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { setClaudeClient, ClaudeRefused } from '../src/claude.ts';
import { note, askInThread, nowContext, dayContext, readDayDocs } from '../src/conversation.ts';
import type { DocRef, EventId } from '../src/types.ts';
import { fake, said, called } from './fake-claude.ts';
import { everyEntry } from './every-entry.ts';
import { card } from '../src/plans.ts';
import { refresh } from '../src/offers.ts';
import { answerHeadline, renderAnswerPage, renderBriefingPage, writeDoc } from '../src/docs.ts';
import { setDsmFetch } from '../src/synology.ts';
import { fakeNas } from './fake-nas.ts';
import type { FakeNas } from './fake-nas.ts';
import { chooseFolderIn } from './folder.ts';

const NOW = '2026-08-13T09:00:00Z';
const TODAY = '2026-08-13';

async function ctx(): Promise<ToolContext> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-talk-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
    { op: 'category.add', category: 'people', label: 'People' },
    { op: 'envelope.define', envelope: 'food', label: 'Food', category: 'people', template: parseDollars('600.00'), order: 0 },
    { op: 'envelope.define', envelope: 'trip', label: 'Travel', category: 'people', template: parseDollars('400.00'), order: 1 },
    { op: 'month.open', month: '2026-08', income: parseDollars('1000.00') },
  ]);
  return { store, who: 'bob', today: TODAY, proposals: new ProposalStore(), sid: null };
}

/** Everything Claude was sent in the first user turn, as one string. */
const sentText = (call: any): string =>
  (call.messages[0].content as { text: string }[]).map((b) => b.text).join('\n');

const withoutKey = async (fn: () => Promise<void>) => {
  setClaudeClient(null);
  const saved = process.env['ANTHROPIC_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];
  try { await fn(); } finally { if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved; }
};

afterEach(() => { setClaudeClient(null); });

describe('notes', () => {
  test('a note is recorded and costs no call', async () => {
    const c = await ctx();
    const f = fake([]);
    const e = await note(c, 'the trip is already paid for');
    assert.equal(e.op, 'thread.note');
    assert.equal(e.who, 'bob');
    assert.equal(f.calls.length, 0);
  });

  test('a note works with no key configured', async () => {
    await withoutKey(async () => {
      const c = await ctx();
      await note(c, 'hello');
    });
  });

  test('text over 2,000 characters is refused before anything is written', async () => {
    const c = await ctx();
    const before = c.store.state.eventCount;
    await assert.rejects(note(c, 'x'.repeat(2001)), (e: ToolError) => e instanceof ToolError && e.status === 400);
    await assert.rejects(askInThread(c, 'x'.repeat(2001)), (e: ToolError) => e instanceof ToolError && e.status === 400);
    assert.equal(c.store.state.eventCount, before);
  });
});

describe('asking Claude', () => {
  test('a question and its answer are both recorded; the answer is by claude and lists its tools', async () => {
    const c = await ctx();
    fake([called('get_month', {}), said('Food has $600.00 left.')]);
    const r = await askInThread(c, 'How is food?');
    assert.equal(r.question.op, 'thread.ask');
    assert.equal(r.question.who, 'bob');
    assert.ok(r.answer && r.answer.op === 'thread.answer');
    assert.equal(r.answer.who, 'claude');
    assert.equal(r.answer.replyTo, r.question.id);
    assert.equal(r.answer.text, 'Food has $600.00 left.');
    assert.deepEqual(r.answer.tools.map((t) => t.name), ['get_month']);
  });

  test('Claude sees today\'s briefing, notes and earlier questions', async () => {
    const c = await ctx();
    await c.store.append('claude', { op: 'thread.briefing', day: TODAY, source: 'budget',
      headline: 'Food is running ahead of plan', body: 'Longer.', writtenBy: 'claude' });
    await c.store.append('alice', { op: 'thread.note', text: 'the trip is already paid for' });
    const [q] = await c.store.append('alice', { op: 'thread.ask', question: 'Can travel spare anything?' });
    await c.store.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'It can spare $120.00.', tools: [], model: 'm' });
    const f = fake([said('Yes.')]);
    await askInThread(c, 'Then should we move it?');
    const text = sentText(f.calls[0]);
    assert.match(text, /Food is running ahead of plan/);
    assert.match(text, /alice.*the trip is already paid for/);
    assert.match(text, /Can travel spare anything\?/);
    assert.match(text, /It can spare \$120\.00\./);
    assert.match(text, /You are speaking to bob/);
    // The day by name, the time, and where: "Thursday" needs the weekday, "this evening" the hour.
    assert.match(text, /Today is Thursday 13 August 2026; it is \d{2}:\d{2} in [A-Za-z_/]+\./);
  });

  test('the day, the time and the zone are the household\'s', () => {
    // 02:14 UTC on the 30th is still the evening of Thursday the 29th in Denver.
    const at = new Date('2026-10-30T02:14:00Z');
    assert.equal(nowContext('2026-10-29', 'America/Denver', at), 'Today is Thursday 29 October 2026; it is 20:14 in America/Denver.');
    assert.equal(nowContext('2026-10-30', 'UTC', at), 'Today is Friday 30 October 2026; it is 02:14 in UTC.');
  });

  test('a write Claude proposes becomes a card raised by the answer', async () => {
    const c = await ctx();
    fake([
      called('move_money', { month: '2026-08', from: 'trip', to: 'food', amountCents: 12000, why: 'trip is paid for' }),
      said('I have suggested moving $120.00 from Travel to Food.'),
    ]);
    const r = await askInThread(c, 'Move what we can to food');
    assert.equal(r.offers.length, 1);
    assert.deepEqual(r.offers[0]!.prompt, { kind: 'answer', ref: r.answer!.id });
    assert.equal(r.offers[0]!.who, 'claude');
    assert.equal(c.store.state.eventCount, c.store.state.eventCount); // nothing moved
    assert.ok(![...await c.store.since(null)].some((e) => e.op === 'move'));
  });

  test('when Claude fails, the question stays and no answer is written', async () => {
    const c = await ctx();
    fake([Object.assign(new Error('529 overloaded'), { status: 529 })]);
    const r = await askInThread(c, 'How is food?');
    assert.equal(r.answer, null);
    assert.ok(r.error);
    const ops = (await c.store.since(null)).map((e) => e.op);
    assert.equal(ops.filter((o) => o === 'thread.ask').length, 1);
    assert.equal(ops.filter((o) => o === 'thread.answer').length, 0);
  });

  test('a refusal is recorded as asked, then surfaces as a refusal', async () => {
    const c = await ctx();
    fake([{ model: 'm', stop_reason: 'refusal', stop_details: { category: 'x', explanation: 'no' }, content: [], usage: { input_tokens: 1, output_tokens: 1 } }]);
    await assert.rejects(askInThread(c, 'Something odd'), ClaudeRefused);
    assert.ok((await c.store.since(null)).some((e) => e.op === 'thread.ask'));
  });

  test('with no key, asking is refused before anything is written', async () => {
    await withoutKey(async () => {
      const c = await ctx();
      const before = c.store.state.eventCount;
      await assert.rejects(askInThread(c, 'How is food?'), (e: ToolError) => e.status === 503);
      assert.equal(c.store.state.eventCount, before);
    });
  });
});

describe('asking from a plan', () => {
  /** A plan of alice's with everything a card can say about itself. */
  async function withPlan(): Promise<ToolContext> {
    const c = await ctx();
    await c.store.append('alice', [
      { op: 'plan.create', plan: 'heater', title: 'Tankless water heater', area: 'House' },
      { op: 'plan.set', plan: 'heater', notes: 'The old tank is 14 years old.', chips: ['researching', 'someday'],
        estimate: parseDollars('1800.00'), envelope: 'food' },
      { op: 'plan.checklist', plan: 'heater', items: [
        { id: 'a', text: 'Measure the closet', done: true }, { id: 'b', text: 'Get two quotes', done: false }] },
    ]);
    return c;
  }

  test('Claude is handed the card first: title, area, state, notes, checklist, chips and money', async () => {
    const c = await withPlan();
    const f = fake([said('Two installers nearby do tankless.')]);
    await askInThread(c, 'Who installs these nearby?', 'heater');
    const context = f.calls[0].messages[0].content[0].text as string;
    assert.ok(context.startsWith('PLAN: Tankless water heater (House, planning)'), context);
    assert.match(context, /The old tank is 14 years old\./);
    assert.match(context, /\[x\] Measure the closet/);
    assert.match(context, /\[ \] Get two quotes/);
    assert.match(context, /researching, someday/);
    assert.match(context, /Food.*\$600 left/);
    assert.match(context, /\$1,800\b/);
    assert.match(context, /heater/, 'the id, so a suggestion can name it');
    assert.match(sentText(f.calls[0]), /You are speaking to bob/, 'the usual context follows');
  });

  test('the question and its answer carry the plan', async () => {
    const c = await withPlan();
    fake([said('Two installers nearby do tankless.')]);
    const r = await askInThread(c, 'Who installs these nearby?', 'heater');
    assert.equal(r.question.plan, 'heater');
    assert.equal(r.answer!.plan, 'heater');
    // And without a plan, neither does.
    fake([said('Fine.')]);
    const plain = await askInThread(c, 'How is food?');
    assert.ok(!('plan' in plain.question) && !('plan' in plain.answer!));
  });

  test('an unknown plan is refused before anything is written', async () => {
    const c = await withPlan();
    const f = fake([]);
    const before = c.store.state.eventCount;
    await assert.rejects(askInThread(c, 'Anything?', 'nope'), (e: ToolError) => e instanceof ToolError && e.status === 404);
    assert.equal(c.store.state.eventCount, before);
    assert.equal(f.calls.length, 0);
  });

  test('research is never handed a tool that moves money, and one it reaches for anyway is refused', async () => {
    const c = await withPlan();
    const f = fake([
      called('move_money', { month: '2026-08', from: 'trip', to: 'food', amountCents: 50000, why: 'heater' }),
      said('I cannot move money from here; that is for the budget.'),
    ]);
    const r = await askInThread(c, 'Can we fund this from travel?', 'heater');
    const offered = (f.calls[0].tools as { name: string }[]).map((t) => t.name);
    for (const name of ['move_money', 'set_assignment', 'open_month', 'set_location', 'add_envelope', 'change_envelope', 'add_rule']) {
      assert.ok(!offered.includes(name), `${name} is not offered to research`);
    }
    for (const name of ['get_month', 'get_plan', 'list_plans', 'set_plan_due', 'create_plan', 'update_plan']) {
      assert.ok(offered.includes(name), `${name} is offered to research`);
    }
    const result = f.calls[1].messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.equal(result.content, 'move_money is not available here');
    assert.deepEqual(r.offers, []);
    assert.ok(!(await c.store.since(null)).some((e) => e.op === 'proposal.offer' || e.op === 'move'));
    // Asked without a plan, the whole surface is there as before.
    const g = fake([said('Fine.')]);
    await askInThread(c, 'How is food?');
    assert.ok((g.calls[0].tools as { name: string }[]).some((t) => t.name === 'move_money'));
  });

  test('research may suggest adding someone to Contacts: a research card on the answer, nothing made until approved', async () => {
    const c = { ...(await withPlan()), sid: 'S' };
    const f = fake([
      called('create_contact', { full_name: 'Sandoval Plumbing', phones: ['505-555-0142'], plan: 'heater' }),
      said('Sandoval Plumbing installs tankless heaters; I suggested adding them.'),
    ]);
    const r = await askInThread(c, 'Who installs these nearby?', 'heater');
    assert.ok((f.calls[0].tools as { name: string }[]).some((t) => t.name === 'create_contact'), 'offered to research');
    assert.equal(r.offers.length, 1);
    const o = r.offers[0]!;
    assert.equal(o.tool, 'create_contact');
    assert.equal(o.summary, 'Add Sandoval Plumbing to Contacts');
    assert.deepEqual(o.prompt, { kind: 'research', ref: r.answer!.id });
    assert.equal(o.plan, 'heater');
    assert.deepEqual(c.store.state.plans.get('heater')!.contacts, []);
    const view = card(c.store.state, await c.store.since(null), 'heater', { who: 'alice', today: TODAY });
    assert.deepEqual(view.research.map((x) => x.suggestions.map((y) => y.id)), [[o.id]]);
  });

  test('research belongs to its card: a plan write is for the researched plan, whatever plan Claude named or left out', async () => {
    const c = { ...(await withPlan()), sid: 'S' };
    await c.store.append('alice', { op: 'plan.create', plan: 'fence', title: 'Fence', area: 'House' });
    const ask = async (calls: unknown[], plan?: string) => {
      fake([...calls, said('Done.')]);
      return askInThread(c, 'Who should we call?', plan);
    };
    const contact = { full_name: 'Sandoval Plumbing', phones: ['505-555-0142'] };

    // Another plan's id is replaced, not refused.
    let r = await ask([called('create_contact', { ...contact, plan: 'fence' })], 'heater');
    assert.equal(r.offers.length, 1);
    assert.equal(r.offers[0]!.args['plan'], 'heater');
    assert.deepEqual(r.offers[0]!.effects, ['A new contact in the household address book', 'Linked to Tankless water heater']);
    // And so is none at all, filled in.
    r = await ask([called('create_contact', contact)], 'heater');
    assert.equal(r.offers[0]!.args['plan'], 'heater');
    assert.match(r.offers[0]!.effects.join('\n'), /Linked to Tankless water heater/);
    // The answer records the args it was run with.
    assert.equal((r.answer!.tools[0]!.args as { plan: string }).plan, 'heater');

    r = await ask([called('link_contact', { plan: 'fence', contact_id: 3, addressbook_id: 1, display: 'Sandoval Plumbing' })], 'heater');
    assert.equal(r.offers[0]!.args['plan'], 'heater');
    assert.equal((r.offers[0]!.events[0] as { plan: string }).plan, 'heater');
    r = await ask([called('update_plan', { plan: 'fence', notes: 'Call Sandoval.' })], 'heater');
    assert.equal(r.offers[0]!.args['plan'], 'heater');
    assert.equal((r.offers[0]!.events[0] as { plan: string }).plan, 'heater');

    // A plan that has no field for a plan keeps what it was given.
    r = await ask([called('create_plan', { title: 'Hinge', area: 'House' })], 'heater');
    assert.deepEqual([r.offers[0]!.args['title'], r.offers[0]!.args['plan']], ['Hinge', undefined]);

    // Asked without a plan, nothing is bound.
    r = await ask([called('create_contact', { ...contact, plan: 'fence' })]);
    assert.equal(r.offers[0]!.args['plan'], 'fence');
    assert.match(r.offers[0]!.effects.join('\n'), /Linked to Fence/);
  });

  test('what research suggests is a research card on the answer, for that plan', async () => {
    const c = await withPlan();
    fake([
      called('set_plan_due', { plan: 'heater', due: '2026-09-15', why: 'before the cold' }),
      said('I suggested a due date before the cold sets in.'),
    ]);
    const r = await askInThread(c, 'When should this be done by?', 'heater');
    assert.equal(r.offers.length, 1);
    const o = r.offers[0]!;
    assert.deepEqual(o.prompt, { kind: 'research', ref: r.answer!.id });
    assert.equal(o.args['plan'], 'heater');
    assert.equal(o.fingerprint, '', 'a plan card has no figures to move');
    const offered = (await c.store.since(null)).find((e) => e.op === 'proposal.offer')!;
    assert.equal((offered as { plan?: string }).plan, 'heater');
    assert.equal(c.store.state.plans.get('heater')!.due, null, 'nothing changed until someone approves it');

    // The card is its own entry, raised by the answer to the question.
    const page = await everyEntry(c.store, 'alice');
    const asked = page.entries.find((e) => e.id === r.question.id);
    assert.ok(asked && asked.kind === 'ask');
    const hung = page.entries.filter((e) => e.kind === 'card');
    assert.deepEqual(hung.map((e) => e.kind === 'card' && [e.offer.id, e.raised?.entry]), [[o.id, r.question.id]]);

    // And the plan's card shows it as a suggestion on that research.
    const view = card(c.store.state, await c.store.since(null), 'heater', { who: 'alice', today: TODAY });
    assert.deepEqual(view.research.map((x) => [x.id, x.suggestions.map((y) => y.id)]), [[r.answer!.id, [o.id]]]);

    // Worked out again, it is still the plan's research card.
    const again = await refresh(c, o.id);
    assert.equal(again.plan, 'heater');
    assert.deepEqual(again.prompt, o.prompt);
  });
});

describe('answers in Drive', () => {
  const FULL = `Food has $600.00 left, so the trip fits.\n\nThe rest of the month is quiet: nothing else is due before the 20th.`;
  let nas: FakeNas;
  before(async () => { nas = await fakeNas(); setDsmFetch(nas.via); });
  after(async () => { setDsmFetch(null); await nas.close(); });

  const asking = async (sid: string | null) => {
    fake([called('get_month', {}), said(FULL)]);
    const c = await ctx();
    await chooseFolderIn(c.store);
    return { ...c, sid, household: 'h1' };
  };

  test("an answer is a page named for its question; the log keeps its headline", async () => {
    const c = await asking(await nas.signIn('alice'));
    const r = await askInThread(c, 'Can we afford it?');
    assert.equal(r.answer!.text, answerHeadline(FULL));
    assert.notEqual(r.answer!.text, FULL);
    assert.equal(r.answer!.doc!.path, `/team-folders/Planner/h1/answers/${r.question.id}.md`);
    const page = await readFile(join(nas.nas.root, `Planner/h1/answers/${r.question.id}.md`), 'utf8');
    assert.match(page, /\n# Can we afford it\?\n/);
    assert.ok(page.includes(FULL));
    assert.match(page, /\n## Tools\n- get_month\n$/);
    assert.ok(!page.includes(c.sid!), 'the sid is not in the page');
  });
  test('without a session the whole answer is in the log', async () => {
    const c = await asking(null);
    const before = nas.calls.length;
    const r = await askInThread(c, 'Can we afford it?');
    assert.equal(r.answer!.text, FULL);
    assert.equal(r.answer!.doc, undefined);
    assert.equal(nas.calls.length, before, 'nothing was sent to Drive');
  });
  test('a refused write keeps the whole answer in the log', async () => {
    const c = await asking(await nas.signIn('alice'));
    const warn = mock.method(console, 'warn', () => {});
    nas.fail((m, p) => m === 'PUT' && p.endsWith('/files/upload'), 1000);
    try {
      const r = await askInThread(c, 'Can we afford it?');
      assert.equal(r.answer!.text, FULL);
      assert.equal(r.answer!.doc, undefined);
      assert.ok(!warn.mock.calls.some((w) => String(w.arguments[0]).includes(c.sid!)), 'the sid is not logged');
    } finally {
      nas.ok();
      warn.mock.restore();
    }
  });
});

describe("Claude reads the day's documents", () => {
  // Not h1: folders already made are remembered per household, and this NAS is a new one.
  const HOUSEHOLD = 'h2';
  const STUB = { link: 'https://nas/d/x', file_id: '1', hash: 'h', version_id: '1', path: '/team-folders/Planner/h1/today/x.md' };
  const BODY = 'The full body.\n\nWith a second paragraph.';
  const FULL = 'Food has $600.00 left.\n\nNothing else is due before the 20th.';
  let nas: FakeNas;
  before(async () => { nas = await fakeNas(); setDsmFetch(nas.via); });
  after(async () => { setDsmFetch(null); await nas.close(); });

  /** A day with a briefing, a question and an answer, the briefing and answer kept as documents. */
  const dayWithDocs = async (c: ToolContext, docs: { briefing: DocRef; answer: DocRef }) => {
    await c.store.append('claude', { op: 'thread.briefing', day: TODAY, source: 'budget',
      headline: 'Quiet day', doc: docs.briefing, writtenBy: 'claude' });
    const [q] = await c.store.append('alice', { op: 'thread.ask', question: 'Can we afford it?' });
    await c.store.append('claude', { op: 'thread.answer', replyTo: q!.id, text: 'Food has $600.00 left.', doc: docs.answer, tools: [], model: 'm' });
    return c.store.since(null);
  };

  test('documents are read whole when their bodies are handed in', async () => {
    const c = await ctx();
    const events = await dayWithDocs(c, { briefing: STUB, answer: STUB });
    const briefing = events.find((e) => e.op === 'thread.briefing')!;
    const answer = events.find((e) => e.op === 'thread.answer')!;
    const text = dayContext(events, TODAY, new Map([[briefing.id, BODY], [answer.id, FULL]]));
    assert.match(text, /The full body\.\n\nWith a second paragraph\./);
    assert.match(text, /Nothing else is due before the 20th\./);
    assert.doesNotMatch(text, /could not be read/);
    assert.doesNotMatch(text, /only the headline was read/);
  });

  test('without them, the headlines and one line saying the texts were not read', async () => {
    const c = await ctx();
    const events = await dayWithDocs(c, { briefing: STUB, answer: STUB });
    const text = dayContext(events, TODAY);
    assert.match(text, /\[briefing\] Quiet day \(only the headline was read\)/);
    assert.match(text, /you answered \(only its headline was read\): "Food has \$600\.00 left\."/);
    assert.ok(text.endsWith("Some of today's earlier texts could not be read from the NAS, only their headlines: "
      + 'if an answer leans on them, say so rather than guessing.'));
    assert.equal(text.match(/could not be read/g)!.length, 1, 'said once');
  });

  test('a thread with no documents never mentions unread ones', async () => {
    const c = await ctx();
    await c.store.append('claude', { op: 'thread.briefing', day: TODAY, source: 'budget',
      headline: 'Quiet day', body: 'All in the log.', writtenBy: 'claude' });
    const text = dayContext(await c.store.since(null), TODAY);
    assert.match(text, /All in the log\./);
    assert.doesNotMatch(text, /could not be read/);
  });

  test('a briefing another took the place of is not read twice', async () => {
    const c = await ctx();
    const [first] = await c.store.append('claude', { op: 'thread.briefing', day: TODAY, source: 'household',
      headline: 'Quiet day', body: 'Written without the calendar.', writtenBy: 'fallback', calendarUnread: true });
    await c.store.append('claude', { op: 'thread.briefing', day: TODAY, source: 'household',
      headline: 'Quiet day', body: 'The bins go out tonight.', writtenBy: 'claude', replaces: first!.id });
    const text = dayContext(await c.store.since(null), TODAY);
    assert.match(text, /The bins go out tonight\./);
    assert.doesNotMatch(text, /Written without the calendar/);
    assert.equal(text.match(/\[briefing\]/g)!.length, 1);
  });

  test("readDayDocs reads the day's briefing and earlier answers, and nothing without a session", async () => {
    const sid = await nas.signIn('alice');
    const c = { ...(await ctx()), sid, household: HOUSEHOLD };
    await chooseFolderIn(c.store, { team: 'Planner', folder: HOUSEHOLD });
    const briefing = await writeDoc(c, ['today', `${TODAY}-budget.md`], renderBriefingPage({
      day: TODAY, source: 'budget', writtenBy: 'claude', headline: 'Quiet day', body: BODY }));
    const answer = await writeDoc(c, ['answers', 'e-1.md'], renderAnswerPage({
      replyTo: 'e-1' as EventId, plan: null, model: 'm', question: 'Can we afford it?', text: FULL, tools: ['get_month'] }));
    const events = await dayWithDocs(c, { briefing: briefing!, answer: answer! });

    const bodies = await readDayDocs(c, events, TODAY);
    assert.equal(bodies.size, 2);
    assert.equal(bodies.get(events.find((e) => e.op === 'thread.briefing')!.id), BODY);
    assert.equal(bodies.get(events.find((e) => e.op === 'thread.answer')!.id), FULL);

    const calls = nas.calls.length;
    const none = await readDayDocs({ ...c, sid: null }, events, TODAY);
    assert.equal(none.size, 0);
    assert.equal(nas.calls.length, calls, 'nothing was sent to Drive');
  });

  test('a file that cannot be read is left out, not thrown', async () => {
    const sid = await nas.signIn('alice');
    const c = { ...(await ctx()), sid, household: HOUSEHOLD };
    await chooseFolderIn(c.store, { team: 'Planner', folder: HOUSEHOLD });
    const events = await dayWithDocs(c, { briefing: STUB, answer: STUB });
    nas.fail(() => true, 1000);
    try {
      const bodies = await readDayDocs(c, events, TODAY);
      assert.equal(bodies.size, 0);
    } finally { nas.ok(); }
  });

  test('asking in the thread hands Claude the full briefing from Drive', async () => {
    const sid = await nas.signIn('alice');
    const c = { ...(await ctx()), sid, household: HOUSEHOLD };
    await chooseFolderIn(c.store, { team: 'Planner', folder: HOUSEHOLD });
    const doc = await writeDoc(c, ['today', `${TODAY}-ask.md`], renderBriefingPage({
      day: TODAY, source: 'budget', writtenBy: 'claude', headline: 'Quiet day', body: BODY }));
    assert.ok(doc, 'the briefing is in Drive');
    await c.store.append('claude', { op: 'thread.briefing', day: TODAY, source: 'budget',
      headline: 'Quiet day', doc: doc!, writtenBy: 'claude' });
    const f = fake([said('Yes.')]);
    await askInThread(c, 'Anything due?');
    const text = sentText(f.calls[0]);
    assert.match(text, /Quiet day\nThe full body\.\n\nWith a second paragraph\./);
    assert.doesNotMatch(text, /could not be read/);
    assert.ok(!text.includes(sid), 'the sid is not sent to Claude');
  });
});
