import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { ProposalStore, ToolError, commit, runEffect, runTool, toolByName } from '../src/tools.ts';
import type { Proposal, Tool, ToolContext } from '../src/tools.ts';
import type { NewEvent } from '../src/store.ts';
import { SynologyError } from '../src/synology.ts';
import { offer, decide, refresh, adjust, waiting, fingerprint } from '../src/offers.ts';
import type { OfferPrompt } from '../src/types.ts';

const NOW = '2026-08-13T09:00:00Z';
const TODAY = '2026-08-13';
const BRIEFING: OfferPrompt = { kind: 'briefing', ref: null };

async function ctx(who = 'alice'): Promise<ToolContext> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-offers-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
    { op: 'category.define', category: 'groceries', label: 'Groceries' },
    { op: 'category.define', category: 'fun', label: 'Fun' },
    { op: 'category.define', category: 'travel', label: 'Travel' },
    { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
    { op: 'envelope.define', budget: 'harbor', envelope: 'food', label: 'Food', group: 'People',
      match: { categories: ['groceries'] }, template: parseDollars('600.00'), order: 0 },
    { op: 'envelope.define', budget: 'harbor', envelope: 'fun', label: 'Fun', group: 'People',
      match: { categories: ['fun'] }, template: parseDollars('300.00'), order: 1 },
    { op: 'envelope.define', budget: 'harbor', envelope: 'trip', label: 'Travel', group: 'Future',
      match: { categories: ['travel'] }, template: parseDollars('400.00'), order: 2 },
    { op: 'month.open', budget: 'harbor', month: '2026-08', income: parseDollars('1300.00') },
    { op: 'txn.add', txns: [
      { id: 'x1', date: '2026-08-03', payee: 'HILLTOP FOODS', amount: parseDollars('-580.00'), dedupeKey: 'x1', category: 'groceries' },
      { id: 'x2', date: '2026-08-04', payee: 'MYSTERY SHOP', amount: parseDollars('-10.00'), dedupeKey: 'x2', category: null },
    ] },
  ]);
  return { store, who, today: TODAY, proposals: new ProposalStore(), sid: null };
}

const as = (c: ToolContext, who: string): ToolContext => ({ ...c, who });
const moveArgs = (from: string, to: string, amountCents = 12000) =>
  ({ budget: 'harbor', month: '2026-08', from, to, amountCents, why: 'trip is paid for' });

async function spendOnFood(c: ToolContext, id: string) {
  await c.store.append('alice', { op: 'txn.add', txns: [
    { id, date: '2026-08-12', payee: 'SAFEWAY', amount: parseDollars('-15.00'), dedupeKey: id, category: 'groceries' },
  ] });
}

describe('cards', () => {
  test('offer runs the write tool and records what approval would append', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    assert.equal(o.who, 'claude');
    assert.equal(o.events[0]?.op, 'move');
    assert.deepEqual([...o.envelopes].sort(), ['food', 'trip']);
    assert.equal(o.budget, 'harbor');
    assert.equal(o.month, '2026-08');
    assert.equal(o.status, 'open');
    assert.match(o.summary, /Move \$120\.00 from Travel to Food/);
  });

  test('a read tool cannot be offered', async () => {
    const c = await ctx();
    await assert.rejects(offer(c, { tool: 'get_month', args: { budget: 'harbor' }, prompt: BRIEFING }), ToolError);
  });

  test('approving appends the decision and its effect in one write, by whoever approved', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    const written = await decide(as(c, 'bob'), o.id, 'approved', 'trip is paid for');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'move']);
    assert.ok(written.every((e) => e.who === 'bob' && e.at === written[0]!.at));
    assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'approved');
  });

  test('the reason given on approval is the reason the move carries', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    const written = await decide(c, o.id, 'approved', 'groceries ran high this month');
    assert.equal((written[1] as { why?: string }).why, 'groceries ran high this month');
  });

  test('a new offer touching the same envelope in the same month replaces the waiting one', async () => {
    const c = await ctx();
    const first = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    const second = await offer(c, { tool: 'move_money', args: moveArgs('fun', 'food', 5000), prompt: BRIEFING });
    assert.equal(c.store.state.thread.offers.get(first.id)?.status, 'replaced');
    assert.equal(c.store.state.thread.offers.get(first.id)?.replacedBy, second.id);
    await assert.rejects(decide(c, first.id, 'approved', 'ok'), /already decided/);
  });

  test('an offer on other envelopes leaves the first alone', async () => {
    const c = await ctx();
    const first = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    await offer(c, { tool: 'set_assignment', args: { budget: 'harbor', month: '2026-08', envelope: 'fun', toCents: 25000, why: 'less fun' }, prompt: BRIEFING });
    assert.equal(c.store.state.thread.offers.get(first.id)?.status, 'open');
  });

  test('approving after the numbers moved is refused, and nothing is written', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    await spendOnFood(c, 'x9');
    const before = c.store.state.eventCount;
    await assert.rejects(decide(c, o.id, 'approved', 'ok'),
      (e: ToolError) => e instanceof ToolError && e.status === 409 && /numbers have moved/.test(e.message));
    assert.equal(c.store.state.eventCount, before);
  });

  test('two approvals at once: one applies, the other is told it was already decided', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    const [a, b] = await Promise.allSettled([
      decide(c, o.id, 'approved', 'mine'),
      decide(as(c, 'bob'), o.id, 'approved', 'theirs'),
    ]);
    assert.equal([a, b].filter((x) => x.status === 'fulfilled').length, 1);
    const lost = [a, b].find((x) => x.status === 'rejected') as PromiseRejectedResult;
    assert.ok(lost.reason instanceof ToolError, `a ${lost.reason?.name}, not a ToolError`);
    assert.equal(lost.reason.status, 409);
    assert.match(lost.reason.message, /already decided/);
    assert.equal((await c.store.since(null)).filter((e) => e.op === 'move').length, 1);
  });

  test('declining is allowed whatever the numbers did', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    await spendOnFood(c, 'x9');
    const written = await decide(c, o.id, 'declined');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide']);
  });

  test('refresh re-runs the stored tool and replaces the card', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    await spendOnFood(c, 'x9');
    const fresh = await refresh(c, o.id);
    assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'replaced');
    assert.equal(fresh.who, 'claude');
    assert.equal(fresh.fingerprint, fingerprint(c.store.state, 'harbor', '2026-08', ['trip', 'food']));
    await decide(c, fresh.id, 'approved', 'ok');
  });

  test('adjust makes a member\'s offer that replaces the original', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    const mine = await adjust(as(c, 'bob'), o.id, { amountCents: 5000 });
    assert.equal(mine.who, 'bob');
    assert.deepEqual(mine.prompt, { kind: 'member', ref: o.id });
    assert.equal((mine.events[0] as { amount: number }).amount, 5000);
    assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'replaced');
  });

  test('an offer for a budget that has gone can only be declined', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    await c.store.append('alice', { op: 'budget.archive', budget: 'harbor', archived: true, why: 'moved' });
    await assert.rejects(decide(c, o.id, 'approved', 'ok'), (e: ToolError) => e.status === 409);
    await decide(c, o.id, 'declined');
  });
});

describe('what is waiting', () => {
  const kinds = (c: ToolContext, who: string) => c.store.since(null).then((ev) => waiting(c.store.state, who, ev));

  test('an open card is waiting, and says whether its numbers have moved', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    let w = await kinds(c, 'alice');
    assert.deepEqual(w.filter((x) => x.kind === 'offer').map((x) => x.kind === 'offer' && [x.offer.id, x.moved]), [[o.id, false]]);
    await spendOnFood(c, 'x9');
    w = await kinds(c, 'alice');
    assert.deepEqual(w.filter((x) => x.kind === 'offer').map((x) => x.kind === 'offer' && x.moved), [true]);
  });

  test('a snoozed card is waiting again only once its numbers change', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    await decide(c, o.id, 'snoozed');
    assert.equal((await kinds(c, 'alice')).filter((x) => x.kind === 'offer').length, 0);
    await spendOnFood(c, 'x9');
    const back = (await kinds(c, 'alice')).filter((x) => x.kind === 'offer');
    assert.equal(back.length, 1);
    assert.ok(back[0]!.kind === 'offer' && back[0]!.moved);
  });

  test('putting off a card that already moved waits for its numbers to move again', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    await decide(c, o.id, 'snoozed');
    await spendOnFood(c, 'x9');
    assert.equal((await kinds(c, 'alice')).filter((x) => x.kind === 'offer').length, 1);
    await decide(c, o.id, 'snoozed');
    assert.equal((await kinds(c, 'alice')).filter((x) => x.kind === 'offer').length, 0, 'put off again');
    await spendOnFood(c, 'x10');
    const back = (await kinds(c, 'alice')).filter((x) => x.kind === 'offer');
    assert.equal(back.length, 1);
    // Still not approvable as it stands: it was worked out from the first numbers.
    await assert.rejects(decide(c, o.id, 'approved', 'ok'), /numbers have moved/);
  });

  test('a card whose month has closed is not waiting', async () => {
    const c = await ctx();
    await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    await c.store.append('alice', { op: 'month.close', budget: 'harbor', month: '2026-08', closed: true, why: 'done' });
    assert.equal((await kinds(c, 'alice')).filter((x) => x.kind === 'offer').length, 0);
  });

  test('a removed receipt waits for the other member, not the one who removed it, until they have seen it', async () => {
    const c = await ctx();
    await c.store.append('claude', { op: 'thread.briefing', day: TODAY, source: 'budget', budget: 'harbor',
      headline: 'h', body: 'b', writtenBy: 'fallback' });
    const [removal] = await c.store.append('alice', { op: 'txn.remove', txn: 'x1', why: 'duplicate' });
    assert.equal((await kinds(c, 'alice')).filter((x) => x.kind === 'flag').length, 0);
    assert.deepEqual((await kinds(c, 'bob')).filter((x) => x.kind === 'flag'), [{ kind: 'flag', event: removal!.id }]);
    await c.store.append('bob', { op: 'flag.seen', event: removal!.id });
    assert.equal((await kinds(c, 'bob')).filter((x) => x.kind === 'flag').length, 0);
  });

  test('removals from before the thread existed are history, not waiting', async () => {
    const c = await ctx();
    await c.store.append('alice', { op: 'txn.remove', txn: 'x1', why: 'old' });
    assert.equal((await kinds(c, 'bob')).filter((x) => x.kind === 'flag').length, 0, 'an upgraded log opens quiet');
    await c.store.append('claude', { op: 'thread.briefing', day: TODAY, source: 'budget', budget: 'harbor',
      headline: 'h', body: 'b', writtenBy: 'fallback' });
    const [later] = await c.store.append('alice', { op: 'txn.remove', txn: 'x2', why: 'new' });
    assert.deepEqual((await kinds(c, 'bob')).filter((x) => x.kind === 'flag'), [{ kind: 'flag', event: later!.id }]);
  });

  test('a removed receipt that has been put back is not waiting', async () => {
    const c = await ctx();
    await c.store.append('claude', { op: 'thread.briefing', day: TODAY, source: 'budget', budget: 'harbor',
      headline: 'h', body: 'b', writtenBy: 'fallback' });
    const [removal] = await c.store.append('alice', { op: 'txn.remove', txn: 'x2', why: 'duplicate' });
    await c.store.append('alice', { op: 'txn.add', txns: [
      { id: 'x2', date: '2026-08-04', payee: 'MYSTERY SHOP', amount: parseDollars('-10.00'), dedupeKey: 'x2', category: null },
    ] });
    assert.ok(!(await kinds(c, 'bob')).some((x) => x.kind === 'flag' && x.event === removal!.id));
  });

  test('unsorted receipts wait as one item with a count', async () => {
    const c = await ctx();
    assert.deepEqual((await kinds(c, 'alice')).filter((x) => x.kind === 'unsorted'), [{ kind: 'unsorted', count: 1 }]);
  });
});

describe('an ask to take a plan', () => {
  const askCards = (c: ToolContext, plan: string) =>
    [...c.store.state.thread.offers.values()].filter((o) => o.prompt.kind === 'ask' && o.args['plan'] === plan);
  const waitingAsks = async (c: ToolContext, who: string) =>
    waiting(c.store.state, who, await c.store.since(null)).filter((w) => w.kind === 'offer' && w.offer.prompt.kind === 'ask');

  /** An ask as 0.6.0 left one in a log: the ask, then the card for the member asked, naming it. */
  const seedAsk = async (c: ToolContext, plan: string, to: string, why: string) => {
    const [asked] = await c.store.append('alice', { op: 'plan.ask', plan, to, why });
    await offer(c, { tool: 'answer_ask', args: { plan, answer: 'accept' }, prompt: { kind: 'ask', ref: asked!.id }, by: 'alice' });
  };

  test('an ask left in the log still waits on the member asked, and nobody else', async () => {
    const c = await ctx();
    await c.store.append('alice', { op: 'plan.create', plan: 'fence', title: 'Paint the fence', area: 'House' });
    await seedAsk(c, 'fence', 'bob', 'you like painting');
    const [card] = askCards(c, 'fence');
    assert.ok(card, 'the member asked has a card');
    assert.equal(card.who, 'alice');
    assert.deepEqual((await waitingAsks(c, 'bob')).map((w) => w.kind === 'offer' && w.offer.id), [card.id]);
    assert.deepEqual(await waitingAsks(c, 'alice'), [], 'the asker is not waiting on her own ask');
    // An old ask is still answered: its card is not closed.
    const done = await decide(as(c, 'bob'), card.id, 'approved');
    assert.deepEqual(done.map((e) => e.op), ['proposal.decide', 'plan.ask.accept']);
  });

  test('the asker cannot put the card off or decide it; the member asked answers it, and it settles', async () => {
    const c = await ctx();
    await c.store.append('alice', { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' });
    await seedAsk(c, 'gate', 'bob', 'you have the tools');
    const [card] = askCards(c, 'gate');
    for (const d of ['snoozed', 'declined', 'approved'] as const) {
      await assert.rejects(decide(c, card!.id, d, 'x'),
        (e: unknown) => e instanceof ToolError && e.status === 409 && e.message === 'only bob can answer that ask', d);
    }
    assert.equal(c.store.state.thread.offers.get(card!.id)?.status, 'open');
    await assert.rejects(decide(as(c, 'bob'), card!.id, 'snoozed'), /an ask is answered, not put off/);

    await c.store.append('bob', { op: 'plan.ask.decline', plan: 'gate', why: 'no time' });
    const settled = c.store.state.thread.offers.get(card!.id)!;
    assert.deepEqual([settled.status, settled.decidedBy, settled.why], ['declined', 'bob', 'no time']);
    assert.equal(c.store.state.plans.get('gate')!.asked, null);
    assert.deepEqual(await waitingAsks(c, 'bob'), []);
  });

  test('a card from before 0.7.0 that would ask, or put a plan on a shelf, can only be declined', async () => {
    const c = await ctx();
    await c.store.append('alice', { op: 'plan.create', plan: 'p1', title: 'Kitchen', area: 'House' });
    const card = (tool: string, events: NewEvent[]): NewEvent => ({ op: 'proposal.offer', tool, args: { plan: 'p1' }, summary: 's', effects: [],
      events, budget: null, month: null, envelopes: [], fingerprint: '', prompt: BRIEFING } as NewEvent);
    const [ask, shelf] = await c.store.append('claude', [card('ask_to_take', [{ op: 'plan.ask', plan: 'p1', to: 'bob', why: 'w' }]),
      card('create_plan', [{ op: 'plan.create', plan: 'p2', title: 'Hinge', area: 'House', parent: 'p1' }])]);
    const closed = (message: string) => (e: unknown) => e instanceof ToolError && e.status === 409 && e.message === message;
    await assert.rejects(decide(c, ask!.id, 'approved'), closed('Nobody is asked to take a plan any more. Hand it from its card.'));
    await assert.rejects(refresh(c, ask!.id), closed('Nobody is asked to take a plan any more. Hand it from its card.'));
    await assert.rejects(adjust(c, ask!.id, { why: 'x' }), closed('Nobody is asked to take a plan any more. Hand it from its card.'));
    await assert.rejects(decide(c, ask!.id, 'snoozed'), closed('Nobody is asked to take a plan any more. Hand it from its card.'));
    await assert.rejects(decide(c, shelf!.id, 'approved'), closed('Plans no longer sit on shelves. Give it a goal instead.'));
    await decide(c, ask!.id, 'declined', 'not needed');
    assert.equal(c.store.state.thread.offers.get(ask!.id)!.status, 'declined');
  });
});

describe('an effect stage', () => {
  const note: NewEvent = { op: 'thread.note', text: 'effect ran', budget: null };
  const stored: NewEvent = { op: 'category.define', category: 'gifts', label: 'Gifts' };

  /** A write tool that proposes one stored event and runs `effect` at decision time. */
  const effectTool = (name: string, effect: NonNullable<Tool['effect']>): Tool => ({
    name, description: 'test only', kind: 'write', input: {},
    // No args here: the call sites record them (runTool, offer), so no tool can forget.
    run: (_args, c) => c.proposals.put({
      tool: name, who: c.who, summary: 'gift category', effects: [], events: [stored],
    }, NOW),
    effect,
  });
  const withTool = async (t: Tool, body: () => Promise<void>) => {
    toolByName.set(t.name, t);
    try { await body(); } finally { toolByName.delete(t.name); }
  };
  const open = async (c: ToolContext, name: string) =>
    offer(c, { tool: name, args: { x: 1 }, prompt: BRIEFING });

  test('an approval appends the decision, the stored events and the effect\'s events in one write', async () => {
    const c = await ctx();
    const seen: unknown[] = [];
    await withTool(effectTool('t_effect_ok', async (args) => { seen.push(args); return [note]; }), async () => {
      const o = await open(c, 't_effect_ok');
      const written = await decide(c, o.id, 'approved');
      assert.deepEqual(seen, [{ x: 1 }]);
      assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'category.define', 'thread.note']);
      const tail = (await c.store.since(null)).slice(-3);
      assert.deepEqual(tail.map((e) => e.op), ['proposal.decide', 'category.define', 'thread.note']);
      assert.equal(new Set(tail.map((e) => e.at)).size, 1);
      assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'approved');
    });
  });

  test('a tool with no effect is decided exactly as before', async () => {
    const c = await ctx();
    const o = await offer(c, { tool: 'move_money', args: moveArgs('trip', 'food'), prompt: BRIEFING });
    const written = await decide(c, o.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'move']);
    assert.deepEqual(await runEffect(toolByName.get('move_money')!, {}, c), []);
  });

  test('declining or putting off never runs the effect', async () => {
    const c = await ctx();
    let ran = 0;
    await withTool(effectTool('t_effect_decline', async () => { ran++; return [note]; }), async () => {
      await decide(c, (await open(c, 't_effect_decline')).id, 'declined');
      await decide(c, (await open(c, 't_effect_decline')).id, 'snoozed');
      assert.equal(ran, 0);
    });
  });

  test('an effect that throws leaves the card open and the log untouched', async () => {
    const c = await ctx();
    await withTool(effectTool('t_effect_no', async () => { throw new ToolError('nas said no', 502); }), async () => {
      const o = await open(c, 't_effect_no');
      const before = (await c.store.since(null)).length;
      await assert.rejects(decide(c, o.id, 'approved'),
        (e: unknown) => e instanceof ToolError && e.status === 502 && e.message === 'nas said no');
      assert.equal((await c.store.since(null)).length, before);
      assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'open');
    });
  });

  test('a DSM error from an effect is a 502 ToolError with its message', async () => {
    const c = await ctx();
    await withTool(effectTool('t_effect_dsm', async () => {
      throw new SynologyError('the NAS is asleep', 'SYNO.Test', 119);
    }), async () => {
      const o = await open(c, 't_effect_dsm');
      const before = (await c.store.since(null)).length;
      await assert.rejects(decide(c, o.id, 'approved'),
        (e: unknown) => e instanceof ToolError && !(e instanceof SynologyError)
          && e.status === 502 && e.message === 'the NAS is asleep');
      assert.equal((await c.store.since(null)).length, before);
      assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'open');
    });
  });

  test('commit appends the stored events and the effect\'s events in one write', async () => {
    const c = await ctx();
    await withTool(effectTool('t_effect_commit', async () => [note]), async () => {
      const p = await runTool(toolByName.get('t_effect_commit')!, { x: 1 }, c) as Proposal;
      const { committed } = await commit(p.id, c);
      assert.deepEqual(committed.map((e) => e.op), ['category.define', 'thread.note']);
      assert.equal(new Set(committed.map((e) => e.at)).size, 1);
    });
  });

  test('commit with an effect that throws appends nothing', async () => {
    const c = await ctx();
    await withTool(effectTool('t_effect_commit_no', async () => { throw new ToolError('nas said no', 502); }), async () => {
      const p = await runTool(toolByName.get('t_effect_commit_no')!, { x: 1 }, c) as Proposal;
      const before = (await c.store.since(null)).length;
      await assert.rejects(commit(p.id, c),
        (e: unknown) => e instanceof ToolError && e.status === 502 && e.message === 'nas said no');
      assert.equal((await c.store.since(null)).length, before);
    });
  });

  test('commit maps a DSM error to a 502 ToolError', async () => {
    const c = await ctx();
    await withTool(effectTool('t_effect_commit_dsm', async () => {
      throw new SynologyError('the NAS is asleep', 'SYNO.Test', 119);
    }), async () => {
      const p = await runTool(toolByName.get('t_effect_commit_dsm')!, { x: 1 }, c) as Proposal;
      const before = (await c.store.since(null)).length;
      await assert.rejects(commit(p.id, c),
        (e: unknown) => e instanceof ToolError && e.status === 502 && e.message === 'the NAS is asleep');
      assert.equal((await c.store.since(null)).length, before);
    });
  });
  test('a proposal made through runTool carries the args it was made with, and commit hands them to the effect', async () => {
    const c = await ctx();
    const seen: unknown[] = [];
    await withTool(effectTool('t_effect_args', async (args) => { seen.push(args); return []; }), async () => {
      const p = await runTool(toolByName.get('t_effect_args')!, { x: 7 }, c) as Proposal;
      assert.deepEqual(p.args, { x: 7 });
      await commit(p.id, c);
      assert.deepEqual(seen, [{ x: 7 }]);
    });
    // A read is answered as it always was.
    const read = await runTool(toolByName.get('list_plans')!, {}, c) as { args?: unknown };
    assert.equal(read.args, undefined);
  });

  test('the effect is handed the stored events, and a tool may put its own events first', async () => {
    const c = await ctx();
    const handed: unknown[] = [];
    const first: Tool = { ...effectTool('t_effect_first', async (_a, _c, events) => { handed.push(events); return [note]; }), effectFirst: true };
    await withTool(first, async () => {
      const written = await decide(c, (await open(c, 't_effect_first')).id, 'approved');
      assert.deepEqual(handed, [[stored]]);
      assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'thread.note', 'category.define']);
      const c2 = await ctx();
      const { committed } = await commit((await runTool(first, { x: 1 }, c2) as Proposal).id, c2);
      assert.deepEqual(committed.map((e) => e.op), ['thread.note', 'category.define']);
    });
  });

  // An event the fold refuses, standing for a write that lost a race after the NAS was called.
  const refused: NewEvent = { op: 'plan.calendar.unlink', plan: 'no-such-plan', kind: 'due' };

  test('when the append is refused after the effect ran, the tool compensates and the refusal is the answer', async () => {
    const c = await ctx();
    const undone: unknown[] = [];
    const t: Tool = {
      ...effectTool('t_effect_comp', async () => [refused]),
      compensate: async (args, _c, extra) => { undone.push([args, extra]); },
    };
    await withTool(t, async () => {
      const o = await open(c, 't_effect_comp');
      const before = (await c.store.since(null)).length;
      await assert.rejects(decide(c, o.id, 'approved'), (e: unknown) => e instanceof ToolError && e.status === 409);
      assert.deepEqual(undone, [[{ x: 1 }, [refused]]]);
      assert.equal((await c.store.since(null)).length, before);
      assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'open');

      const p = await runTool(t, { x: 2 }, c) as Proposal;
      await assert.rejects(commit(p.id, c));
      assert.deepEqual(undone[1], [{ x: 2 }, [refused]]);
      assert.equal((await c.store.since(null)).length, before);
    });
  });

  test('a compensation that fails is swallowed: the refused append is still the answer', async () => {
    const c = await ctx();
    const t: Tool = {
      ...effectTool('t_effect_comp_fails', async () => [refused]),
      compensate: async () => { throw new SynologyError('the NAS is asleep', 'SYNO.Test', 0); },
    };
    await withTool(t, async () => {
      const o = await open(c, 't_effect_comp_fails');
      await assert.rejects(decide(c, o.id, 'approved'),
        (e: unknown) => e instanceof ToolError && !(e instanceof SynologyError) && e.status === 409);
      const p = await runTool(t, { x: 1 }, c) as Proposal;
      await assert.rejects(commit(p.id, c), (e: unknown) => !(e instanceof SynologyError));
    });
  });

  test('no compensation when the effect itself failed', async () => {
    const c = await ctx();
    let undone = 0;
    const t: Tool = {
      ...effectTool('t_effect_comp_none', async () => { throw new ToolError('nas said no', 502); }),
      compensate: async () => { undone++; },
    };
    await withTool(t, async () => {
      await assert.rejects(decide(c, (await open(c, 't_effect_comp_none')).id, 'approved'));
      assert.equal(undone, 0);
    });
  });

  test('a second approval while the first is still at the NAS is refused before any effect runs', async () => {
    const c = await ctx();
    let ran = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await withTool(effectTool('t_effect_twice', async () => { ran++; await gate; return [note]; }), async () => {
      const o = await open(c, 't_effect_twice');
      const first = decide(c, o.id, 'approved');
      await assert.rejects(decide(as(c, 'bob'), o.id, 'approved'),
        (e: unknown) => e instanceof ToolError && e.status === 409 && e.message === 'that card is being decided');
      release();
      await first;
      assert.equal(ran, 1);
      assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'approved');
      // The entry is gone once it settled: what answers now is the fold's own word.
      await assert.rejects(decide(c, o.id, 'approved'),
        (e: unknown) => e instanceof ToolError && e.message === 'that suggestion was already decided');
    });
  });

  test('a failed effect lets the card be approved again', async () => {
    const c = await ctx();
    let fail = true;
    await withTool(effectTool('t_effect_retry', async () => {
      if (fail) throw new ToolError('nas said no', 502);
      return [note];
    }), async () => {
      const o = await open(c, 't_effect_retry');
      await assert.rejects(decide(c, o.id, 'approved'));
      fail = false;
      await decide(c, o.id, 'approved');
      assert.equal(c.store.state.thread.offers.get(o.id)?.status, 'approved');
    });
  });
});
