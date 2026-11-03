import './planner-root.ts';
import { test, describe, afterEach, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars, fmt } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { ProposalStore, toolByName, ToolError } from '../src/tools.ts';
import { snapshot, donors } from '../src/analytics.ts';
import { TRANSFER } from '../src/types.ts';
import type { Event } from '../src/types.ts';
import {
  brief, changesSinceSection, ensureSection, markRead, facts, scorePredictions,
  householdFacts, briefHousehold, ensureHousehold,
} from '../src/briefing.ts';
import { thread } from '../src/thread.ts';
import { validate } from '../src/replay.ts';
import { fakeDsm } from './fake-dsm-fetch.ts';
import { fakeNas } from './fake-nas.ts';
import type { FakeNas } from './fake-nas.ts';
import { chooseFolderIn } from './folder.ts';
import { offer, decide } from '../src/offers.ts';
import { setClaudeClient, METHOD_RULES, householdContext, anthropicTools, ask, ClaudeRefused } from '../src/claude.ts';

const NOW = '2026-08-13T09:00:00Z';
const TODAY = '2026-08-13';

import { FakeClaude, said, called, fake } from './fake-claude.ts';

async function fixture(): Promise<{ store: Store; ctx: any }> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-brief-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('system', [
    { op: 'category.define', category: 'groceries', label: 'Groceries' },
    { op: 'category.define', category: 'dining', label: 'Dining out' },
    { op: 'category.define', category: 'electricity', label: 'Electricity' },
    { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
    { op: 'envelope.define', budget: 'harbor', envelope: 'daily', label: 'Daily life', group: 'People',
      match: { categories: ['groceries', 'dining'] }, template: parseDollars('1525.00'), rollover: false, order: 0 },
    { op: 'envelope.define', budget: 'harbor', envelope: 'util', label: 'Utilities', group: 'House',
      match: { categories: ['electricity'] }, template: parseDollars('300.00'), rollover: false, order: 1 },
    { op: 'month.open', budget: 'harbor', month: '2026-08', income: parseDollars('9600.00') },
    { op: 'txn.add', txns: [
      { id: 'x1', date: '2026-08-03', payee: 'VALLEY MARKET #101', amount: parseDollars('-84.21'), dedupeKey: 'x1', category: 'groceries' },
      { id: 'x2', date: '2026-08-06', payee: 'CORNER BISTRO', amount: parseDollars('-1300.00'), dedupeKey: 'x2', category: 'dining' },
      { id: 'x3', date: '2026-08-08', payee: 'EXAMPLE POWER', amount: parseDollars('-120.00'), dedupeKey: 'x3', category: 'electricity' },
      { id: 'x4', date: '2026-08-09', payee: 'QUIKSTOP 10001', amount: parseDollars('-10.15'), dedupeKey: 'x4', category: null },
      { id: 'x5', date: '2026-08-10', payee: 'PAYMENT THANK YOU', amount: parseDollars('2400.50'), dedupeKey: 'x5', category: TRANSFER },
    ] },
  ]);
  return { store, ctx: { store, who: 'alice', today: TODAY, proposals: new ProposalStore(), sid: null } };
}

const draft = (over: Partial<Record<string, unknown>> = {}) => said(JSON.stringify({
  headline: 'Daily life is projected to finish over.',
  body: 'Nothing else needs you today.',
  decisions: [],
  ...over,
}));

afterEach(() => { setClaudeClient(null); });

describe('a budget with no open month', () => {
  test('is a state to act on, not a server fault', async () => {
    // It was a plain Error, so the server answered 500 for something as
    // ordinary as a budget whose month has not been opened yet.
    const { store } = await fixture();
    await store.append('alice', { op: 'budget.create', budget: 'cabin', label: 'Cabin' });
    await assert.rejects(() => brief(store, { who: 'alice', budget: 'cabin', today: TODAY }),
      (e: ToolError) => e instanceof ToolError && e.status === 409 && /no open month/.test(e.message));
  });
});

describe('a change list that has been cut short says so', () => {
  // A first briefing lists only the latest events, and Claude is shown at most
  // the latest forty. A starter set alone is twenty-five events, and Claude
  // counted a cut-off list as the whole: "seventeen categories were defined"
  // when twenty-two had been.
  const many = async () => {
    const { store } = await fixture();
    await store.append('alice', Array.from({ length: 30 }, (_, i) =>
      ({ op: 'category.define' as const, category: `c${i}`, label: `Category ${i}` })));
    return store;
  };

  test('the total is kept beside the events shown', async () => {
    const store = await many();
    const { shown, total } = await changesSinceSection(store, 'harbor', TODAY);
    assert.equal(shown.length, 25);
    assert.ok(total > shown.length, `${total} changes, ${shown.length} shown`);
  });

  test('Claude is told the list is partial, and not to count from it', async () => {
    const store = await many();
    const { shown, total } = await changesSinceSection(store, 'harbor', TODAY);
    const snap = snapshot(store.state, 'harbor', '2026-08', TODAY)!;
    const text = facts(snap, store.state, shown, [], TODAY, total);
    assert.match(text, new RegExp(`the latest 25 of ${total}`));
    assert.match(text, /do not count from this list/);
  });

  test('a list shown whole carries no such warning', async () => {
    const { store } = await fixture();
    const { shown, total } = await changesSinceSection(store, 'harbor', TODAY);
    const snap = snapshot(store.state, 'harbor', '2026-08', TODAY)!;
    assert.equal(shown.length, total);
    assert.doesNotMatch(facts(snap, store.state, shown, [], TODAY, total), /the latest \d+ of/);
  });

  test('the screen and the plain briefing give the real number', async () => {
    const store = await many();
    const { total } = await changesSinceSection(store, 'harbor', TODAY);
    setClaudeClient(null);
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });
      assert.equal(b.changes.length, 25);
      assert.equal(b.changesTotal, total);
      assert.match(b.body, new RegExp(`${total} changes since the last briefing`));
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });
});

describe('friends staying are not money', () => {
  test('a guest allowed, a request withdrawn and nights kept are not among the changes, and no address reaches Claude', async () => {
    const { store } = await fixture();
    await store.append('alice', { op: 'household.claim', label: 'Home' });
    await store.append('alice', { op: 'guest.allow', email: 'linh@example.com', name: 'Linh', why: 'from school' });
    const [card] = await store.append('guest:linh@example.com', {
      op: 'proposal.offer', tool: 'approve_booking', summary: 'Linh would like to come', effects: [], events: [],
      args: { email: 'linh@example.com', name: 'Linh', arrive: '2026-09-01', depart: '2026-09-03', headcount: 1, note: '' },
      budget: null, month: null, envelopes: [], fingerprint: '', prompt: { kind: 'booking', ref: null },
    });
    await store.append('guest:linh@example.com', { op: 'booking.cancel', stay: card!.id, why: 'withdrawn by the guest' });
    await store.append('alice', { op: 'booking.block', from: '2026-09-10', to: '2026-09-12', why: 'family visiting' });
    await store.append('alice', { op: 'category.define', category: 'coffee', label: 'Coffee run' });
    const { shown, total } = await changesSinceSection(store, 'harbor', TODAY);
    assert.deepEqual(shown.filter((e) => e.op.startsWith('guest.') || e.op.startsWith('booking.')), []);
    assert.ok(shown.some((e) => e.op === 'category.define' && e.category === 'coffee'), 'the money change is still there');
    const text = facts(snapshot(store.state, 'harbor', '2026-08', TODAY)!, store.state, shown, [], TODAY, total);
    assert.doesNotMatch(text, /linh@example\.com|Linh|withdr|family visiting|guest/i);
  });
});

describe('what a section covers', () => {
  test('the first section does not replay the entire seed', async () => {
    const { store } = await fixture();
    const { shown } = await changesSinceSection(store, 'harbor', TODAY);
    assert.ok(shown.length <= 25, `first run showed ${shown.length} events`);
  });

  test('the next day lists only what changed since the previous section, for both of you', async () => {
    const { store } = await fixture();
    const f = fake([draft(), draft()]);
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    await store.append('bob', {
      op: 'move', budget: 'harbor', month: '2026-08',
      from: 'util', to: 'daily', amount: parseDollars('25.00'), why: 'coffee run',
    });
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: '2026-08-14' });
    const second = f.calls[1].messages[0].content as string;
    assert.match(second, /WHAT CHANGED SINCE THE LAST BRIEFING\n.*coffee run/s);
    assert.doesNotMatch(second, /imported 5 transactions/);
  });

  test('a read cursor is per person', async () => {
    const { store } = await fixture();
    const head = store.state.lastEventId;
    await markRead(store, 'alice', head);
    assert.equal(store.state.readCursor.get('alice'), head);
    assert.equal(store.state.readCursor.get('bob'), undefined);
  });

  test('the facts include notes left since the last section', async () => {
    const { store } = await fixture();
    const f = fake([draft()]);
    await store.append('bob', { op: 'thread.note', text: 'the trip is already paid for', budget: 'harbor' });
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    assert.match(f.calls[0].messages[0].content, /NOTES.*bob: "the trip is already paid for"/s);
  });

  test('a put-off card whose numbers moved is mentioned in the next section', async () => {
    const { store, ctx } = await fixture();
    const card = await offer(ctx, { tool: 'move_money', prompt: { kind: 'briefing', ref: null },
      args: { budget: 'harbor', month: '2026-08', from: 'util', to: 'daily', amountCents: 5000, why: 'x' } });
    await decide(ctx, card.id, 'snoozed');
    await store.append('alice', { op: 'txn.add', txns: [
      { id: 'x8', date: '2026-08-12', payee: 'VALLEY MARKET', amount: parseDollars('-20.00'), dedupeKey: 'x8', category: 'groceries' }] });
    const f = fake([draft()]);
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    assert.match(f.calls[0].messages[0].content, /PUT OFF.*Move \$50\.00 from Utilities to Daily life/s);
  });
});

describe('the facts Claude is given', () => {
  test('every figure is pre-formatted, so nothing invites a unit conversion', async () => {
    const { store } = await fixture();
    const snap = snapshot(store.state, 'harbor', '2026-08', TODAY)!;
    const text = facts(snap, store.state, [], [], TODAY);

    assert.match(text, /funded now: \$1,825\b/);
    assert.match(text, /spent: \$1,504\b/);
    // The raw cent counts must not appear anywhere — they are what a model
    // would mistake for dollars.
    assert.doesNotMatch(text, /\b182500\b/);
    assert.doesNotMatch(text, /\b150421\b/);
  });

  test('it carries the plan-vs-funded pair, not just the current number', async () => {
    const { store } = await fixture();
    await store.append('alice', {
      op: 'move', budget: 'harbor', month: '2026-08',
      from: 'util', to: 'daily', amount: parseDollars('100.00'), why: 'ate out twice',
    });
    const snap = snapshot(store.state, 'harbor', '2026-08', TODAY)!;
    const text = facts(snap, store.state, [], [], TODAY);
    assert.match(text, /Daily life \[daily\]: planned \$1,525, funded \$1,625\b/);
  });

  test('spending with no envelope is stated, never quietly dropped', async () => {
    const { store } = await fixture();
    await store.append('alice', {
      op: 'category.define', category: 'vet', label: 'Vet',
    });
    await store.append('alice', { op: 'txn.add', txns: [
      { id: 'x9', date: '2026-08-11', payee: 'LAKESIDE VET', amount: parseDollars('-240.00'), dedupeKey: 'x9', category: 'vet' },
    ] });
    const snap = snapshot(store.state, 'harbor', '2026-08', TODAY)!;
    assert.match(facts(snap, store.state, [], [], TODAY), /outside every envelope: \$240\b/);
  });

  test('the changes section quotes the note, because every edit has one', async () => {
    const { store } = await fixture();
    await markRead(store, 'alice', store.state.lastEventId);
    await store.append('bob', {
      op: 'move', budget: 'harbor', month: '2026-08',
      from: 'util', to: 'daily', amount: parseDollars('50.00'), why: 'birthday dinner for mum',
    });
    const snap = snapshot(store.state, 'harbor', '2026-08', TODAY)!;
    const text = facts(snap, store.state, (await changesSinceSection(store, 'harbor', TODAY)).shown, [], TODAY);
    assert.match(text, /bob: .*birthday dinner for mum/s);
  });
});

describe('generation', () => {
  test('the stable house rules go first, with a cache breakpoint on them', async () => {
    const { store } = await fixture();
    const f = fake([draft()]);
    await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });

    const req = f.calls[0];
    assert.equal(req.model, 'claude-opus-5');
    assert.deepEqual(req.thinking, { type: 'adaptive' });
    assert.equal(req.system[0].cache_control.type, 'ephemeral');
    assert.ok(req.system[0].text.startsWith(METHOD_RULES.slice(0, 60)));
    // Nobody's name is in the cacheable half. The method is the application;
    // the household is data, and the same image has to run for anyone.
    assert.doesNotMatch(METHOD_RULES, /alice|bob|rivera|harbor|ridge|lakeside/i);
    assert.equal(req.output_config.format.type, 'json_schema');
    // The prior generation's shape: both are 400s on Opus 5.
    assert.equal(req.thinking.budget_tokens, undefined);
    assert.equal(req.temperature, undefined);
  });

  test('a section is written once per budget per day and shared by both members', async () => {
    const { store } = await fixture();
    const f = fake([draft({ headline: 'first' })]);
    const a = await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    const b = await ensureSection(store, { who: 'bob', budget: 'harbor', today: TODAY });
    assert.equal(f.calls.length, 1, 'the second look must not hit the API');
    assert.equal(b.event, a.event);
    const written = (await store.since(null)).filter((e) => e.op === 'thread.briefing');
    assert.equal(written.length, 1);
    assert.equal(written[0]!.who, 'claude');
  });

  test('two looks at once still write one section', async () => {
    const { store } = await fixture();
    const f = fake([draft(), draft()]);
    await Promise.all([
      ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY }),
      ensureSection(store, { who: 'bob', budget: 'harbor', today: TODAY }),
    ]);
    assert.equal(f.calls.length, 1);
  });

  test('a change later that day does not rewrite the section; the thread shows it instead', async () => {
    const { store } = await fixture();
    const f = fake([draft({ headline: 'first' }), draft({ headline: 'second' })]);
    const a = await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    await store.append('bob', {
      op: 'move', budget: 'harbor', month: '2026-08',
      from: 'util', to: 'daily', amount: parseDollars('25.00'), why: 'coffee run',
    });
    const b = await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    assert.equal(f.calls.length, 1);
    assert.equal(b.event, a.event);
  });

  test('the next day writes a new one', async () => {
    const { store } = await fixture();
    const f = fake([draft(), draft()]);
    const a = await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    const b = await ensureSection(store, { who: 'alice', budget: 'harbor', today: '2026-08-14' });
    assert.equal(f.calls.length, 2);
    assert.notEqual(b.event, a.event);
  });

  test('each runnable suggestion becomes a card raised by the section', async () => {
    const { store } = await fixture();
    fake([draft({ decisions: [{ title: 'Cover Daily life', detail: 'It is projected over.', envelope: 'daily', tool: 'move_money' }] })]);
    const s = await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    const cards = [...store.state.thread.offers.values()];
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0]!.prompt, { kind: 'briefing', ref: s.event });
    assert.equal(cards[0]!.who, 'claude');
    assert.equal(cards[0]!.status, 'open');
  });

  test('a suggested tool is a suggestion, not a write', async () => {
    const { store } = await fixture();
    const before = store.state.eventCount;
    fake([draft({ decisions: [{
      title: 'Cover Daily life', detail: 'It is projected over.',
      envelope: 'daily', tool: 'move_money',
    }] })]);
    const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });
    assert.equal(b.decisions[0]!.suggests!.tool, 'move_money');
    assert.equal(store.state.eventCount, before, 'nothing may be written by a briefing');
  });

  test('a suggestion carries every argument its tool needs', async () => {
    // A partial call leaves a button on screen that can only ever fail. The
    // real one did exactly that: "budget is required", on every card.
    const { store, ctx } = await fixture();
    fake([draft({ decisions: [{
      title: 'Cover Daily life', detail: 'over', envelope: 'daily', tool: 'move_money',
    }] })]);
    const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });

    const s = b.decisions[0]!.suggests!;
    const proposal = toolByName.get(s.tool)!.run(s.args as Record<string, unknown>, ctx) as
      { effects: string[] };
    assert.ok(proposal.effects.length > 0, 'the proposal must actually build');
  });

  test('a set_assignment suggestion runs too — it used the wrong argument name', async () => {
    // move_money takes amountCents and set_assignment takes toCents. Sending
    // the first name to the second failed only when someone pressed the button,
    // which no test did until the Budget screen tried it.
    const { store, ctx } = await fixture();
    fake([draft({ decisions: [{
      title: 'Raise the Daily life plan', detail: 'it keeps needing topping up',
      envelope: 'daily', tool: 'set_assignment',
    }] })]);
    const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });
    const s = b.decisions[0]!.suggests!;
    assert.equal(s.tool, 'set_assignment');
    const proposal = toolByName.get(s.tool)!.run(s.args as Record<string, unknown>, ctx) as
      { effects: string[] };
    assert.ok(proposal.effects.length > 0);
  });

  test('every figure in a suggestion comes from the engine, not from Claude', async () => {
    const { store } = await fixture();
    fake([draft({ decisions: [{
      title: 'Cover Daily life', detail: 'over', envelope: 'daily', tool: 'move_money',
    }] })]);
    const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });

    const args = b.decisions[0]!.suggests!.args as { from: string; to: string; amountCents: number };
    const snap = snapshot(store.state, 'harbor', '2026-08', TODAY)!;
    const p = snap.pace.find((x) => x.envelope === 'daily')!;
    const short = p.available < 0 ? -p.available : p.projectedOver;
    const best = donors(snap.view, snap.clock, 'daily', store.state)[0]!;

    assert.equal(args.to, 'daily');
    assert.equal(args.from, best.envelope, 'the source is the ranked top donor');
    assert.equal(args.amountCents, Math.min(short, best.spare),
      'never more than the source can spare');
  });

  test('no button is offered when a complete call cannot be built', async () => {
    const { store } = await fixture();
    fake([draft({ decisions: [{
      title: 'Look at Utilities', detail: 'it is fine', envelope: 'util', tool: 'move_money',
    }] })]);
    const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });
    // Utilities is not short of anything, so there is nothing to propose.
    assert.equal(b.decisions[0]!.suggests, undefined);
  });

  test('a refusal surfaces as a refusal, not as an empty briefing', async () => {
    const { store } = await fixture();
    fake([{ model: 'claude-opus-5', stop_reason: 'refusal', stop_details: { category: 'other' },
            content: [], usage: { input_tokens: 5, output_tokens: 0 } }]);
    await assert.rejects(
      () => brief(store, { who: 'alice', budget: 'harbor', today: TODAY }),
      ClaudeRefused);
  });

  test('without an API key the morning screen still says something true', async () => {
    const { store } = await fixture();
    setClaudeClient(null);
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });
      assert.match(b.body, /\$1,825\b/);
      assert.match(b.body, /without Claude/);
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  // What the API actually says when an account has run out of credit.
  const outOfCredit = () => Object.assign(
    new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'),
    { status: 400, error: { type: 'error', error: { type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } } },
  );

  test('when Claude cannot be reached, the morning screen falls back and says why', async () => {
    // A key that is present but refused — no credit, revoked, an outage — used
    // to replace the whole Today screen with the API's error.
    const { store } = await fixture();
    fake([outOfCredit()]);
    const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });
    assert.match(b.body, /\$1,825\b/, 'the same true figures as with no key at all');
    assert.match(b.body, /without Claude/);
    assert.match(b.body, /credit balance is too low/);
    assert.doesNotMatch(b.body, /no API key is configured/, 'a key is configured; that is not the reason');
  });

  test('the plain briefing names spending that is in no envelope yet', async () => {
    // Unsorted receipts count in no envelope, so "spent" leaves them out. Without
    // saying so, money that has gone reads as money that has not.
    const { store } = await fixture();
    setClaudeClient(null);
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });
      assert.match(b.body, /1 receipt \(\$10 out\) is not in an envelope yet/);
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  test('the plain briefing names spending that no envelope in this budget covers', async () => {
    // Sorted into a category, but this budget has no envelope for it — so it is
    // in neither "spent" nor the unsorted queue unless something says so.
    const { store } = await fixture();
    await store.append('alice', [
      { op: 'category.define', category: 'pets', label: 'Pets' },
      { op: 'txn.add', txns: [
        { id: 'x9', date: '2026-08-11', payee: 'HARBOR VET', amount: parseDollars('-45.00'), dedupeKey: 'x9', category: 'pets' },
      ] },
    ]);
    setClaudeClient(null);
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });
      assert.match(b.body, /\$45 was spent in categories with no envelope here/);
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  test('a fallback section is retried, and a Claude-written one replaces it that day', async () => {
    const { store } = await fixture();
    fake([outOfCredit(), draft()]);
    const first = await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    assert.equal(first.writtenBy, 'fallback');
    const again = await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY, retryEvery: 0 });
    assert.equal(again.writtenBy, 'claude');
    const latest = (await store.since(null)).filter((e) => e.op === 'thread.briefing').at(-1)!;
    assert.ok(latest.op === 'thread.briefing' && latest.replaces === first.event);
    assert.doesNotMatch(latest.op === 'thread.briefing' ? latest.body ?? '' : '', /without Claude/);
  });

  test('while Claude is down, looking again soon does not wait on it again', async () => {
    const { store } = await fixture();
    const f = fake([outOfCredit(), draft()]);
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    await ensureSection(store, { who: 'bob', budget: 'harbor', today: TODAY });
    assert.equal(f.calls.length, 1, 'retried at most every few minutes, not on every look');
  });

  test('while Claude stays unreachable, the fallback is not written twice', async () => {
    const { store } = await fixture();
    fake([outOfCredit(), outOfCredit()]);
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY, retryEvery: 0 });
    assert.equal((await store.since(null)).filter((e) => e.op === 'thread.briefing').length, 1);
  });
});

describe('predictions', () => {
  test('Claude picks the envelope; the number comes from the projection', async () => {
    const { store } = await fixture();
    fake([draft({ predictEnvelope: 'daily', predictWhy: 'eating out has been steady' })]);
    const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });

    const projected = snapshot(store.state, 'harbor', '2026-08', TODAY)!
      .pace.find((p) => p.envelope === 'daily')!.projected;
    assert.equal(b.prediction!.expected, projected);

    const recorded = store.state.predictions.at(-1)!;
    assert.equal(recorded.expected, projected);
    assert.equal(recorded.envelope, 'daily');
  });

  test('an envelope Claude invented records nothing', async () => {
    const { store } = await fixture();
    fake([draft({ predictEnvelope: 'holidays' })]);
    const b = await brief(store, { who: 'alice', budget: 'harbor', today: TODAY });
    assert.equal(b.prediction, null);
    assert.equal(store.state.predictions.length, 0);
  });

  test('a forecast is Claude\'s, and recording it does not cost a second section', async () => {
    const { store } = await fixture();
    const f = fake([draft({ predictEnvelope: 'daily', predictWhy: 'steady' })]);
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    assert.equal(f.calls.length, 1);
    assert.equal(store.state.predictions.at(-1)!.who, 'claude');
  });

  test('a closed month is scored against what was actually spent', async () => {
    const { store } = await fixture();
    await store.append('system', [
      { op: 'month.open', budget: 'harbor', month: '2026-07', income: parseDollars('9600.00') },
      { op: 'txn.add', txns: [
        { id: 'j1', date: '2026-07-14', payee: 'VALLEY MARKET #101', amount: parseDollars('-1000.00'), dedupeKey: 'j1', category: 'groceries' },
      ] },
    ]);
    await store.append('system', {
      op: 'prediction.record', prediction: 'harbor:2026-07:daily',
      budget: 'harbor', month: '2026-07', envelope: 'daily',
      expected: parseDollars('1050.00'), why: 'steady',
    });

    const [scored] = scorePredictions(store.state, TODAY);
    assert.equal(fmt(scored!.actual), '$1,000');
    assert.equal(fmt(scored!.off), '$50');
    assert.equal(scored!.within10, true);
  });

  test('a still-running month is not scored', async () => {
    const { store } = await fixture();
    await store.append('system', {
      op: 'prediction.record', prediction: 'harbor:2026-08:daily',
      budget: 'harbor', month: '2026-08', envelope: 'daily',
      expected: parseDollars('1500.00'), why: 'steady',
    });
    assert.deepEqual(scorePredictions(store.state, TODAY), []);
  });
});

describe('the tool loop', () => {
  test('write tools come back as proposals and are never applied', async () => {
    const { store, ctx } = await fixture();
    const before = store.state.eventCount;
    fake([
      called('move_money', { budget: 'harbor', month: '2026-08', from: 'util', to: 'daily',
                             amountCents: 9600, why: 'covering the overspend' }),
      said('Moving $96.00 from Utilities would cover it. Approve below.'),
    ]);

    const answer = await ask('Why is Daily life almost empty?', ctx);
    assert.equal(answer.proposals.length, 1);
    assert.equal(store.state.eventCount, before, 'the loop must not write');
    assert.deepEqual(answer.toolsUsed, ['move_money']);
  });

  test('a failing tool is handed back rather than aborting the answer', async () => {
    const { store, ctx } = await fixture();
    const f = fake([
      called('explain_envelope', { budget: 'harbor', month: '2026-08', envelope: 'nope' }),
      said('There is no envelope by that name.'),
    ]);
    const answer = await ask('How is nope doing?', ctx);
    assert.match(answer.text, /no envelope/i);

    const followUp = f.calls[1].messages.at(-1).content[0];
    assert.equal(followUp.type, 'tool_result');
    assert.equal(followUp.is_error, true);
    assert.equal(store.state.eventCount, store.state.eventCount);
  });

  test('every tool_use gets a matching tool_result, or the next call is rejected', async () => {
    const { ctx } = await fixture();
    const f = fake([
      { model: 'claude-opus-5', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'tool_use', id: 'a', name: 'get_month', input: { budget: 'harbor', month: '2026-08' } },
          { type: 'tool_use', id: 'b', name: 'list_transactions', input: { month: '2026-08' } },
        ] },
      said('done'),
    ]);
    await ask('what is going on', ctx);
    const ids = f.calls[1].messages.at(-1).content.map((c: any) => c.tool_use_id);
    assert.deepEqual(ids.sort(), ['a', 'b']);
  });

  test('the tool surface handed to Claude is the one the UI uses', async () => {
    const names = anthropicTools().map((t) => t.name).sort();
    assert.ok(names.includes('get_month'));
    assert.ok(names.includes('find_donors'));
    assert.ok(names.includes('move_money'));
    for (const t of anthropicTools()) {
      assert.equal((t.input_schema as { type: string }).type, 'object', `${t.name} has no object schema`);
      assert.ok(t.description.length > 20, `${t.name} needs a description Claude can act on`);
    }
  });
});

// ─── one briefing for the household ──────────────────────────────────────────

describe('one briefing for the household', () => {
  const HOUSEHOLD_CAL = { cal_id: '/alice/home/', original_cal_id: 'home' };
  const MINE = { cal_id: '/alice/home-alice/', original_cal_id: 'alice-default' };

  /** The briefing fixture, plus two members, a few plans and (if asked) a Household calendar. */
  async function household(o: { calendar?: boolean } = {}) {
    let now = NOW;
    const path = join(await mkdtemp(join(tmpdir(), 'pb-house-')), 'events.jsonl');
    const store = new Store({ path, now: () => new Date(now) });
    await store.load();
    const at = (iso: string) => { now = iso; };
    // The log runs forward in time: a plan thought about since June, never
    // nagged for it, and one in Doing since 20 July (24 days by the 13th).
    at('2026-06-01T09:00:00Z');
    await store.append('alice', [
      { op: 'household.claim', label: 'Home' },
      { op: 'member.add', member: 'bob', why: 'my partner' },
    ]);
    await store.append('bob', [
      { op: 'plan.create', plan: 'deck', title: 'Rebuild the deck', area: 'House' },
      { op: 'plan.due', plan: 'deck', due: '2026-08-17' },
    ]);
    at('2026-07-20T09:00:00Z');
    await store.append('alice', [
      { op: 'plan.create', plan: 'shed', title: 'Sort the shed', area: 'House' },
      { op: 'plan.state', plan: 'shed', state: 'doing' },
    ]);
    at(NOW);
    await store.append('alice', [
      { op: 'category.define', category: 'groceries', label: 'Groceries' },
      { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
      { op: 'envelope.define', budget: 'harbor', envelope: 'daily', label: 'Daily life', group: 'People',
        match: { categories: ['groceries'] }, template: parseDollars('600.00'), rollover: false, order: 0 },
      { op: 'month.open', budget: 'harbor', month: '2026-08', income: parseDollars('1000.00') },
      { op: 'txn.add', txns: [
        { id: 'h1', date: '2026-08-03', payee: 'VALLEY MARKET', amount: parseDollars('-84.21'), dedupeKey: 'h1', category: 'groceries' }] },
      ...(o.calendar ? [{ op: 'calendar.household' as const, ...HOUSEHOLD_CAL, name: 'Household' }] : []),
      { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
      { op: 'plan.due', plan: 'gate', due: '2026-08-10' },
      { op: 'plan.create', plan: 'gift', title: 'Gift for mum', area: 'People' },
      { op: 'plan.ask', plan: 'gift', to: 'bob', why: 'you know what she likes' },
      // Due well after the week: not mentioned as due.
      { op: 'plan.create', plan: 'trip', title: 'Book the coast trip', area: 'Trips' },
      { op: 'plan.due', plan: 'trip', due: '2026-09-30' },
    ]);
    return { store };
  }

  const opts = (over: Record<string, unknown> = {}) =>
    ({ who: 'alice', today: TODAY, sid: 'sid-1', tz: 'UTC', ...over }) as any;

  const listed = (rows: unknown[]) => ({ success: true, data: rows });
  /**
   * The NAS as alice's account sees it: the Household calendar listed under the
   * ids the log has, and `rows` on it. Every call about the calendar first asks
   * which calendars the looker's account lists (calendar.ts, listingFor).
   */
  const nas = (rows: unknown[]) => {
    const calls: { url: string; body: string }[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      calls.push({ url: String(url), body });
      const data = new URLSearchParams(body).get('api') === 'SYNO.Cal.Cal'
        ? [{ ...HOUSEHOLD_CAL, cal_displayname: 'Household', cal_color: '', cal_privilege: 'RW', cal_type: 'event', default_calendar: false }]
        : rows;
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
               json: async () => ({ success: true, data }) } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fn, calls, events: () => calls.filter((c) => new URLSearchParams(c.body).get('api') === 'SYNO.Cal.Event') };
  };
  const row = (evt_id: number, summary: string, dtstart: number, dtend: number, allDay = false) => ({
    ...HOUSEHOLD_CAL, evt_id, ical_uid: `u${evt_id}`, dav_etag: `e${evt_id}`, summary, description: '',
    is_all_day: allDay, dtstart, dtend, tz_id: 'UTC', color: '',
  });
  const epoch = (iso: string) => Date.parse(iso) / 1000;

  const noKey = async <T>(run: () => Promise<T>): Promise<T> => {
    setClaudeClient(null);
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try { return await run(); } finally { if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved; }
  };

  test('the facts are three blocks: this month, plans, and the Household calendar', async () => {
    const { store } = await household({ calendar: true });
    const dsm = nas([
      row(7, 'Bins out', epoch('2026-08-14T00:00:00Z'), epoch('2026-08-15T00:00:00Z'), true),
      row(8, 'Plumber', epoch('2026-08-15T14:00:00Z'), epoch('2026-08-15T15:00:00Z')),
    ]);
    const f = await householdFacts(store, opts({ f: dsm.fn }));
    assert.match(f.text, /THIS MONTH/);
    assert.match(f.text, /\nPLANS\n/);
    assert.match(f.text, /HOUSEHOLD CALENDAR/);
    assert.deepEqual([...f.sources].sort(), ['budget', 'calendar', 'plans']);
    assert.deepEqual(f.missing, []);
    // The calendar block, short and in the household's zone.
    assert.match(f.text, /Bins out/);
    assert.match(f.text, /Plumber/);
    assert.match(f.text, /14:00/);
  });

  test('the plans block names what is due, overdue, long in Doing, and waiting on an ask', async () => {
    const { store } = await household();
    const { text } = await householdFacts(store, opts({ sid: null }));
    const plans = text.slice(text.indexOf('\nPLANS\n'), text.indexOf('HOUSEHOLD CALENDAR'));
    assert.match(plans, /overdue.*Fix the gate.*2026-08-10/is);
    assert.match(plans, /Rebuild the deck.*2026-08-17/s);
    assert.match(plans, /Sort the shed.*24 days/s);
    assert.match(plans, /waiting on bob.*Gift for mum/s);
    assert.doesNotMatch(plans, /coast trip/, 'due after the week is not news');
  });

  test('a plan still being thought about is never given an age', async () => {
    const { store } = await household();
    const { text } = await householdFacts(store, opts({ sid: null }));
    for (const l of text.split('\n').filter((x) => /Rebuild the deck|Fix the gate|Gift for mum/.test(x))) {
      assert.doesNotMatch(l, /\bdays?\b/, `a Planning item carries no age: ${l}`);
    }
  });

  test('a household with no Household calendar says so, and asks the NAS nothing', async () => {
    const { store } = await household();
    const dsm = nas([]);
    const f = await householdFacts(store, opts({ f: dsm.fn }));
    assert.match(f.text, /HOUSEHOLD CALENDAR\n.*no Household calendar yet/);
    assert.equal(dsm.calls.length, 0);
    assert.deepEqual(f.missing, []);
  });

  test('only the Household calendar is read, never anyone\'s own', async () => {
    const { store } = await household({ calendar: true });
    await store.append('alice', [
      { op: 'calendar.target', ...MINE },
      { op: 'calendar.conflicts', calendars: [{ ...MINE, label: 'Mine' }] },
    ]);
    const dsm = nas([]);
    await householdFacts(store, opts({ f: dsm.fn }));
    assert.equal(dsm.events().length, 1);
    const body = new URLSearchParams(dsm.events()[0]!.body);
    assert.equal(body.get('method'), 'list');
    assert.deepEqual(JSON.parse(body.get('cal_id_list')!), [HOUSEHOLD_CAL.cal_id]);
    // Today through the seventh day after it, where the household is.
    assert.equal(Number(body.get('start')), epoch('2026-08-13T00:00:00Z'));
    assert.equal(Number(body.get('end')), epoch('2026-08-21T00:00:00Z'));
  });

  test('a partner reads the Household calendar under the id their own account lists it by', async () => {
    const { store } = await household({ calendar: true });
    const asBob = { ...HOUSEHOLD_CAL, cal_id: '/bob/shared-home/' };
    const calls: URLSearchParams[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      calls.push(body);
      const data = body.get('api') === 'SYNO.Cal.Cal'
        ? [{ cal_id: '/bob/home/', original_cal_id: 'bob-default', cal_displayname: 'Bob', cal_color: '', cal_privilege: 'RW',
             cal_type: 'event', default_calendar: true },
           { ...asBob, cal_displayname: 'Household', cal_color: '', cal_privilege: 'RW', cal_type: 'event', default_calendar: false }]
        : [];
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
               json: async () => ({ success: true, data }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await householdFacts(store, opts({ who: 'bob', f }));
    assert.deepEqual(r.missing, []);
    const list = calls.find((b) => b.get('api') === 'SYNO.Cal.Event')!;
    assert.deepEqual(JSON.parse(list.get('cal_id_list')!), [asBob.cal_id]);
  });

  test('a calendar that cannot be read is said, and the rest is still written', async () => {
    const { store } = await household({ calendar: true });
    const dsm = fakeDsm({ success: false, error: { code: 400 } });
    const f = await householdFacts(store, opts({ f: dsm.fn }));
    assert.equal(f.missing.length, 1);
    assert.match(f.missing[0]!, /^calendar: /);
    assert.match(f.text, /The Household calendar was not read for this briefing\./);
    assert.deepEqual([...f.sources].sort(), ['budget', 'plans']);

    const fc = fake([draft()]);
    const b = await briefHousehold(store, opts({ f: dsm.fn }));
    assert.equal(fc.calls.length, 1);
    assert.equal(b.writtenBy, 'claude');
    assert.match(b.body, /The Household calendar was not read for this briefing\./);
    // Refused with a session: there is nothing a later look would read differently.
    assert.equal(b.calendarUnread, undefined);
  });

  test('without a NAS session the calendar is said to be unread, not an error', async () => {
    const { store } = await household({ calendar: true });
    const dsm = nas([]);
    const f = await householdFacts(store, opts({ sid: null, f: dsm.fn }));
    assert.equal(dsm.calls.length, 0);
    assert.match(f.missing[0]!, /^calendar: /);
    // Said of the briefing, never of whoever happened to look first.
    assert.match(f.text, /The Household calendar was not read for this briefing\./);
    assert.doesNotMatch(f.text, /sign-in|session/);
  });

  test('written without a NAS session, it is replaced the first time someone with one looks', async () => {
    const { store } = await household({ calendar: true });
    const dsm = nas([row(8, 'Plumber', epoch('2026-08-15T14:00:00Z'), epoch('2026-08-15T15:00:00Z'))]);
    const fc = fake([draft({ body: 'The gate is overdue.' }), draft({ body: 'The plumber comes Saturday.' })]);
    const first = await ensureHousehold(store, opts({ sid: null, f: dsm.fn }));
    const unread = (await store.since(null)).find((e) => e.id === first.event)!;
    assert.ok(unread.op === 'thread.briefing' && unread.calendarUnread === true);
    assert.match(unread.op === 'thread.briefing' ? unread.body ?? '' : '', /The Household calendar was not read for this briefing\./);

    // Bob has no session either: nothing to read it with, so nothing is written again.
    await ensureHousehold(store, opts({ who: 'bob', sid: null, f: dsm.fn }));
    assert.equal(fc.calls.length, 1);

    // Alice looks with one: the day's briefing is written again, with the calendar, in its place.
    const second = await ensureHousehold(store, opts({ f: dsm.fn }));
    assert.equal(fc.calls.length, 2);
    assert.notEqual(second.event, first.event);
    const replaced = (await store.since(null)).find((e) => e.id === second.event)!;
    assert.ok(replaced.op === 'thread.briefing' && replaced.replaces === first.event);
    assert.ok(replaced.op === 'thread.briefing' && replaced.calendarUnread === undefined);
    assert.match(fc.calls[1].messages[0].content as string, /Plumber/);
    assert.doesNotMatch(replaced.op === 'thread.briefing' ? replaced.body ?? '' : '', /not read/);

    // And once only: the next look, with a session or without, finds it written.
    await ensureHousehold(store, opts({ f: dsm.fn }));
    await ensureHousehold(store, opts({ who: 'bob', sid: null, f: dsm.fn }));
    assert.equal(fc.calls.length, 2);
    const { entries } = await thread(store, { who: 'alice', budget: 'harbor' });
    assert.deepEqual(entries.filter((e) => e.kind === 'briefing').map((e) => e.id), [second.event]);
  });

  test('the calendar left unread is said once, even when Claude says it too', async () => {
    const { store } = await household({ calendar: true });
    fake([draft({ body: 'The gate is overdue. The Household calendar was not read for this briefing.' })]);
    const a = await briefHousehold(store, opts({ sid: null }));
    assert.equal(a.body.match(/not read/g)?.length, 1);

    fake([draft({ body: 'The gate is overdue, and the calendar could not be read today.' })]);
    const b = await briefHousehold(store, opts({ sid: null }));
    assert.equal(b.body.match(/not read|could not be read/g)?.length, 1);

    // A contraction says it too.
    for (const said of ["The calendar couldn't be read today.", "The Household calendar wasn't read for this briefing.", 'The calendar couldn\u2019t be read.']) {
      fake([draft({ body: `The gate is overdue. ${said}` })]);
      const c = await briefHousehold(store, opts({ sid: null }));
      assert.equal(c.body, `The gate is overdue. ${said}`, said);
    }
  });

  test('a refusal writes the plain briefing once, rather than asking Claude again on every look', async () => {
    const { store } = await household();
    const refusal = { model: 'claude-opus-5', stop_reason: 'refusal', stop_details: { category: 'other' },
                      content: [], usage: { input_tokens: 5, output_tokens: 0 } };
    const fc = fake([refusal, refusal, refusal]);
    const s = await ensureHousehold(store, opts({ sid: null }));
    assert.equal(s.writtenBy, 'fallback');
    await ensureHousehold(store, opts({ sid: null }));
    await ensureHousehold(store, opts({ who: 'bob', sid: null }));
    assert.equal(fc.calls.length, 1);
    const written = (await store.since(null)).filter((e) => e.op === 'thread.briefing');
    assert.equal(written.length, 1);
    assert.match(written[0]!.op === 'thread.briefing' ? written[0]!.body ?? '' : '', /declined/);
  });

  test('one Claude call, given all three blocks, writes one household briefing', async () => {
    const { store } = await household({ calendar: true });
    const dsm = nas([]);
    const fc = fake([draft({ headline: 'The gate is overdue.' })]);
    const s = await ensureHousehold(store, opts({ f: dsm.fn }));
    assert.equal(fc.calls.length, 1);
    const sent = fc.calls[0].messages[0].content as string;
    for (const h of ['THIS MONTH', 'PLANS', 'HOUSEHOLD CALENDAR']) assert.ok(sent.includes(h), h);
    assert.equal(fc.calls[0].tools, undefined, 'it composes; it is given no tools');
    const written = (await store.since(null)).filter((e) => e.op === 'thread.briefing');
    assert.equal(written.length, 1);
    const e = written[0]! as Extract<typeof written[0], { op: 'thread.briefing' }>;
    assert.equal(e.source, 'household');
    assert.equal(e.budget, null);
    assert.equal(e.headline, 'The gate is overdue.');
    assert.equal(e.who, 'claude');
    assert.equal(s.event, e.id);
    assert.equal(s.writtenBy, 'claude');
  });

  test('a second look the same day writes nothing, and two at once write one', async () => {
    const { store } = await household();
    const fc = fake([draft(), draft()]);
    const [a, b] = await Promise.all([
      ensureHousehold(store, opts({ sid: null })),
      ensureHousehold(store, opts({ who: 'bob', sid: null })),
    ]);
    const c = await ensureHousehold(store, opts({ sid: null }));
    assert.equal(fc.calls.length, 1);
    assert.equal(a.event, b.event);
    assert.equal(c.event, a.event);
    assert.equal((await store.since(null)).filter((e) => e.op === 'thread.briefing').length, 1);
  });

  test('without Claude the briefing stitches the three blocks plainly', async () => {
    const { store } = await household({ calendar: true });
    const dsm = nas([row(8, 'Plumber', epoch('2026-08-15T14:00:00Z'), epoch('2026-08-15T15:00:00Z'))]);
    const b = await noKey(() => briefHousehold(store, opts({ f: dsm.fn })));
    assert.equal(b.writtenBy, 'fallback');
    assert.match(b.body, /Funded \$600\b/, 'the month');
    assert.match(b.body, /Fix the gate/, 'the plans');
    assert.match(b.body, /Plumber/, 'the calendar');
    assert.match(b.body, /without Claude/);
    assert.doesNotMatch(b.body, /Rebuild the deck[^.]*\bdays?\b/);
  });

  test('a fallback is retried, and a Claude-written one replaces it that day', async () => {
    const { store } = await household();
    const out = Object.assign(new Error('503 overloaded'), { status: 503 });
    fake([out, draft()]);
    const first = await ensureHousehold(store, opts({ sid: null }));
    assert.equal(first.writtenBy, 'fallback');
    const again = await ensureHousehold(store, opts({ sid: null, retryEvery: 0 }));
    assert.equal(again.writtenBy, 'claude');
    const latest = (await store.since(null)).filter((e) => e.op === 'thread.briefing').at(-1)!;
    assert.ok(latest.op === 'thread.briefing' && latest.replaces === first.event && latest.source === 'household');
  });

  test('with no budget open it still briefs on plans and the calendar', async () => {
    const { store } = await household();
    const f = await householdFacts(store, opts({ sid: null, today: '2026-09-02' }));
    assert.match(f.text, /THIS MONTH\n.*no budget open/);
    assert.ok(!f.sources.includes('budget'));
    const b = await noKey(() => briefHousehold(store, opts({ sid: null, today: '2026-09-02' })));
    assert.equal(b.writtenBy, 'fallback');
    assert.match(b.body, /No budget is open/);
  });

  test('the household briefing opens the day, and the budget\'s own section stands aside', async () => {
    const { store } = await household();
    // A section written for the budget earlier that day, before the household one existed.
    fake([draft({ headline: 'budget only' }), draft({ headline: 'for the household' })]);
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    const s = await ensureHousehold(store, opts({ sid: null }));
    const { entries } = await thread(store, { who: 'alice', budget: 'harbor' });
    const firstToday = entries.find((e) => e.at.slice(0, 10) === TODAY)!;
    assert.equal(firstToday.kind, 'briefing');
    assert.equal(firstToday.id, s.event);
    const briefings = entries.filter((e) => e.kind === 'briefing');
    assert.deepEqual(briefings.map((e) => e.kind === 'briefing' && e.headline), ['for the household']);
  });

  test('the log accepts the briefing sources and refuses any other', () => {
    const base = { id: 'e1', at: NOW, who: 'claude', op: 'thread.briefing', day: TODAY, budget: null,
      headline: 'h', body: 'b', writtenBy: 'claude' } as const;
    for (const source of ['budget', 'plans', 'calendar', 'household']) {
      assert.doesNotThrow(() => validate({ ...base, source } as never));
    }
    assert.throws(() => validate({ ...base, source: 'gossip' } as never), /source/);
  });

  test('Claude is told it works for the household, not only its budget', () => {
    assert.match(METHOD_RULES.split('\n')[0]!, /household/);
    assert.match(METHOD_RULES.split('\n').slice(0, 2).join(' '), /plans|calendar/);
  });

  test('the household\'s briefing is no one budget\'s, and the log refuses one that names a budget', () => {
    const base = { id: 'e1', at: NOW, who: 'claude', op: 'thread.briefing', day: TODAY,
      headline: 'h', body: 'b', writtenBy: 'claude', source: 'household' } as const;
    assert.doesNotThrow(() => validate({ ...base, budget: null } as never));
    assert.throws(() => validate({ ...base, budget: 'harbor' } as never), /household's briefing/);
  });

  test('the fallback names each event on the calendar without a double colon', async () => {
    const { store } = await household({ calendar: true });
    const dsm = nas([row(8, 'Plumber', epoch('2026-08-15T14:00:00Z'), epoch('2026-08-15T15:00:00Z'))]);
    const b = await noKey(() => briefHousehold(store, opts({ f: dsm.fn })));
    assert.match(b.body, /This week on the Household calendar: Plumber \(Sat 15 Aug 14:00–15:00\)\./);
    assert.doesNotMatch(b.body, /15:00: Plumber/);
  });
});

// ─── the household's briefing as a page in Drive ─────────────────────────────

describe("the household's briefing as a page in Drive", () => {
  let nas: FakeNas;
  before(async () => { nas = await fakeNas(); });
  after(async () => { await nas.close(); });

  const opts = (over: Record<string, unknown> = {}) =>
    ({ who: 'alice', today: TODAY, sid: null, tz: 'UTC', ...over }) as any;
  type Briefing = Extract<Event, { op: 'thread.briefing' }>;
  const briefings = async (store: Store) =>
    (await store.since(null)).filter((e): e is Briefing => e.op === 'thread.briefing');
  /** The fixture, claimed by alice, its documents in Planner/h1. */
  const homed = async () => {
    const f = await fixture();
    await f.store.append('alice', { op: 'household.claim', label: 'Home' });
    await chooseFolderIn(f.store);
    return f;
  };

  test("the household's briefing goes to Drive; the log keeps the pointer and the headline", async () => {
    const { store } = await homed();
    fake([draft()]);
    await ensureHousehold(store, opts({ sid: await nas.signIn('alice'), household: 'h1', f: nas.via }));
    const e = (await briefings(store))[0]!;
    assert.equal(e.body, undefined);
    assert.match(e.doc!.path, /\/team-folders\/Planner\/h1\/today\/\d{4}-\d{2}-\d{2}-household\.md$/);
    const page = await readFile(join(nas.nas.root, 'Planner/h1/today', e.doc!.path.split('/').pop()!), 'utf8');
    assert.match(page, /^---\nplanner: 1\nkind: briefing\n/);
    assert.match(page, new RegExp(`# ${e.headline}`));
    assert.match(page, /Nothing else needs you today\./);
  });

  test('written again that day, the same file gets a new version; the replaced event keeps its own', async () => {
    const { store } = await homed();
    const sid = await nas.signIn('alice');
    const day = { today: '2026-08-14', sid, household: 'h1', f: nas.via };
    const out = Object.assign(new Error('503 overloaded'), { status: 503 });
    fake([out, draft({ headline: 'Claude, second time' })]);
    const warn = mock.method(console, 'warn', () => {});
    let one, two;
    try {
      one = await ensureHousehold(store, opts(day));
      two = await ensureHousehold(store, opts({ ...day, retryEvery: 0 }));
    } finally {
      warn.mock.restore();
    }
    assert.equal(one.writtenBy, 'fallback');
    assert.equal(two.writtenBy, 'claude');
    const [first, second] = await briefings(store);
    assert.equal(second!.replaces, first!.id);
    assert.equal(second!.doc!.link, first!.doc!.link);
    assert.equal(first!.doc!.version_id, '1');
    assert.equal(second!.doc!.version_id, '2');
    const page = await readFile(join(nas.nas.root, 'Planner/h1/today/2026-08-14-household.md'), 'utf8');
    assert.match(page, /# Claude, second time/);
  });

  test('without a session the body is in the log, as before', async () => {
    const { store } = await fixture();
    fake([draft()]);
    const calls = nas.calls.length;
    await ensureHousehold(store, opts({ sid: null, household: 'h1', f: nas.via }));
    const e = (await briefings(store))[0]!;
    assert.equal(typeof e.body, 'string');
    assert.equal(e.doc, undefined);
    assert.equal(nas.calls.length, calls, 'Drive was not called');
  });

  test('when Drive refuses, the body is in the log and nothing is said', async () => {
    const { store } = await homed();
    const warn = mock.method(console, 'warn', () => {});
    const sid = await nas.signIn('alice');
    nas.fail((m, p) => m === 'PUT' && p.endsWith('/files/upload'), 1003);
    fake([draft()]);
    try {
      await ensureHousehold(store, opts({ today: '2026-08-15', sid, household: 'h1', f: nas.via }));
      const e = (await briefings(store))[0]!;
      assert.equal(typeof e.body, 'string');
      assert.equal(e.doc, undefined);
      assert.doesNotMatch(e.body!, /Drive|refus|error|could not/i);
      assert.ok(warn.mock.calls.every((c) => !String(c.arguments[0]).includes(sid)), 'the sid is not logged');
    } finally {
      nas.ok();
      warn.mock.restore();
    }
  });

  test("without a folder, the household's briefing is inline even with a session", async () => {
    const { store } = await fixture();
    await store.append('alice', { op: 'household.claim', label: 'Home' });
    fake([draft()]);
    const calls = nas.calls.length;
    await ensureHousehold(store, opts({ sid: await nas.signIn('alice'), household: 'h1', f: nas.via }));
    const e = (await briefings(store))[0]!;
    assert.equal(typeof e.body, 'string');
    assert.equal(e.doc, undefined);
    assert.equal(nas.calls.slice(calls).filter((c) => c.method === 'PUT').length, 0, 'nothing was uploaded');
  });

  test("a budget's own section stays in the log", async () => {
    const { store } = await fixture();
    fake([draft()]);
    await ensureSection(store, { who: 'alice', budget: 'harbor', today: TODAY });
    const e = (await briefings(store))[0]!;
    assert.equal(typeof e.body, 'string');
    assert.equal(e.doc, undefined);
  });
});
