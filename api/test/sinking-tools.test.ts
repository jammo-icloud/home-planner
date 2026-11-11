import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cents } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { CARD_ONLY, ProposalStore, ToolError, commit, toolByName } from '../src/tools.ts';
import type { Proposal, ToolContext } from '../src/tools.ts';
import { decide, raiseSavingsCard, waiting } from '../src/offers.ts';
import { monthView } from '../src/envelopes.ts';
import type { Event } from '../src/types.ts';

const NOW = '2026-11-03T09:00:00Z';
const TODAY = '2026-11-03';

/** Harbor in November: groceries, Auto maintenance and a Bahamas trip, the last two not yet saved in Savings. */
async function ctx(): Promise<ToolContext> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-sinking-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
    { op: 'category.add', category: 'people', label: 'People' },
    { op: 'category.add', category: 'future', label: 'Future' },
    { op: 'envelope.define', envelope: 'food', label: 'Groceries', category: 'people', template: cents(60000), order: 0 },
    { op: 'envelope.define', envelope: 'auto', label: 'Auto maintenance', category: 'future', template: cents(2000), rollover: false, order: 1 },
    { op: 'envelope.define', envelope: 'bahamas', label: 'Bahamas', category: 'future', template: cents(0), order: 2 },
    { op: 'income.source.define', source: 'pay', label: 'Pay', earner: 'alice',
      amount: cents(500000), frequency: 'monthly', anchor: '2026-10-01' },
    { op: 'month.open', month: '2026-11', income: cents(500000) },
  ]);
  return { store, who: 'alice', today: TODAY, proposals: new ProposalStore(), sid: null };
}

const propose = (name: string, args: Record<string, unknown>, c: ToolContext) =>
  toolByName.get(name)!.run(args, c) as Proposal;
const approve = async (name: string, args: Record<string, unknown>, c: ToolContext) =>
  (await commit(propose(name, args, c).id, c)).committed;

/** Tyres and a service together: $900 every year, its own estimate. */
const AUTO_EVERY = { envelope: 'auto', goal: 'every', estimate: { costCents: 90000, everyYears: 1 } };

describe('set_sinking_goal', () => {
  test('every so often: the envelope is marked with its own estimate, in one define', async () => {
    const c = await ctx();
    const p = propose('set_sinking_goal', AUTO_EVERY, c);
    assert.equal(p.summary, 'Save Auto maintenance in Savings');
    assert.deepEqual(p.events.map((e) => e.op), ['envelope.define']);
    assert.equal(p.effects[0], 'Auto maintenance is saved in Savings: $75.00 a month, toward $900.00 every year');
    await commit(p.id, c);
    const auto = c.store.state.envelopes.get('auto')!;
    assert.deepEqual([auto.sinking, auto.rollover, auto.template, auto.label],
      [{ kind: 'every', estimate: { cost: 90000, everyYears: 1 } }, true, 2000, 'Auto maintenance']);
  });

  test('an estimate is changed or cleared on the envelope; left out, it is kept', async () => {
    const c = await ctx();
    await approve('set_sinking_goal', AUTO_EVERY, c);
    assert.throws(() => propose('set_sinking_goal', { envelope: 'auto', goal: 'every' }, c), /nothing would change/);
    const p = propose('set_sinking_goal', { envelope: 'auto', goal: 'every', estimate: null }, c);
    assert.equal(p.summary, "Change Auto maintenance's goal");
    assert.deepEqual((p.events[0] as { sinking?: unknown }).sinking, { kind: 'every', estimate: null });
    assert.ok(p.effects.includes('Auto maintenance is saved in Savings, with no estimate yet, so nothing is set aside for it'), p.effects.join('|'));
    const q = propose('set_sinking_goal', { envelope: 'auto', goal: 'every', estimate: { costCents: 120000, everyYears: 4 } }, c);
    assert.equal(q.effects[0], 'Auto maintenance is saved in Savings: $25.00 a month, toward $1,200.00 every 4 years');
  });

  test('by a date: what is left over the months left, from this month', async () => {
    const c = await ctx();
    const p = propose('set_sinking_goal', { envelope: 'bahamas', goal: 'by', targetCents: 400000, by: '2027-03' }, c);
    assert.deepEqual(p.effects.slice(0, 2), ['Bahamas is saved in Savings: $4,000.00 by March 2027',
      '$800.00 a month, over 5 months from November 2026, worked out again each month']);
  });

  test('refuses a month gone by, an estimate on a goal by a date, and a change that changes nothing', async () => {
    const c = await ctx();
    assert.throws(() => propose('set_sinking_goal', { envelope: 'bahamas', goal: 'by', targetCents: 400000, by: '2026-10' }, c),
      /has already gone by/);
    assert.throws(() => propose('set_sinking_goal', { envelope: 'bahamas', goal: 'by', targetCents: 400000, by: '2027-03',
      estimate: { costCents: 100, everyYears: 1 } }, c), /an estimate is for a goal of 'every'/);
    assert.throws(() => propose('set_sinking_goal', { envelope: 'auto', goal: 'every', estimate: { costCents: 100, everyYears: 0 } }, c),
      /more than none and at most every 100 years/);
    assert.throws(() => propose('set_sinking_goal', { envelope: 'food', goal: 'none' }, c), ToolError);
  });

  test('none makes it ordinary again, and says what it holds stays', async () => {
    const c = await ctx();
    await approve('set_sinking_goal', AUTO_EVERY, c);
    const p = propose('set_sinking_goal', { envelope: 'auto', goal: 'none' }, c);
    assert.equal(p.summary, 'Stop saving Auto maintenance in Savings');
    await commit(p.id, c);
    assert.equal(c.store.state.envelopes.get('auto')!.sinking, undefined);
  });

  test('renaming the envelope keeps its estimate', async () => {
    const c = await ctx();
    await approve('set_sinking_goal', AUTO_EVERY, c);
    await approve('define_envelope', { envelope: 'auto', label: 'Car upkeep' }, c);
    const auto = c.store.state.envelopes.get('auto')!;
    assert.deepEqual([auto.label, auto.sinking], ['Car upkeep', { kind: 'every', estimate: { cost: 90000, everyYears: 1 } }]);
  });
});

describe('the month plan', () => {
  test('a new month proposes each sinking envelope at what its goal needs, and the rest at their templates', async () => {
    const c = await ctx();
    await approve('set_sinking_goal', AUTO_EVERY, c);
    await approve('set_sinking_goal', { envelope: 'bahamas', goal: 'by', targetCents: 400000, by: '2027-03' }, c);
    // November funds the Bahamas at $1,000, more than asked: December asks for less.
    await approve('set_assignment', { month: '2026-11', envelope: 'bahamas', toCents: 100000, why: 'a good month' }, c);
    const p = propose('open_month', { month: '2026-12' }, c);
    assert.deepEqual((p.events[0] as Extract<Event, { op: 'month.open' }>).plan, { auto: 7500, bahamas: 75000 });
    assert.ok(p.effects.includes('Bahamas planned at $750.00, what its goal needs this month'));
    assert.ok(p.effects.includes('Planned $1,425.00 against income $5,000.00'));
    await commit(p.id, c);
    const v = monthView(c.store.state, '2026-12')!;
    assert.deepEqual(v.envelopes.map((e) => [e.envelope.id, e.planned, e.carried]), [['food', 60000, 60000], ['auto', 7500, 2000], ['bahamas', 75000, 100000]]);
  });

  test('without a sinking envelope the month opens as it always did', async () => {
    const c = await ctx();
    const p = propose('open_month', { month: '2026-12' }, c);
    assert.deepEqual(p.events, [{ op: 'month.open', month: '2026-12', income: 500000 }]);
  });
});

describe('get_month', () => {
  test('a sinking envelope says what is saved, its goal and its monthly figure; the month says how Savings compares', async () => {
    const c = await ctx();
    await approve('set_sinking_goal', AUTO_EVERY, c);
    await c.store.append('alice', [
      { op: 'savings.account', account: '7' },
      { op: 'account.balance', account: '7', cents: cents(3000), asOf: '2026-11-02', source: 'typed' },
    ]);
    const r = toolByName.get('get_month')!.run({}, c) as {
      envelopes: { id: string; sinking: Record<string, unknown> | null }[]; savings: Record<string, unknown>;
    };
    const auto = r.envelopes.find((e) => e.id === 'auto')!.sinking!;
    assert.deepEqual([auto['kind'], auto['savedExact'], auto['goalExact'], auto['monthlyExact']], ['every', '$20.00', '$900.00', '$75.00']);
    assert.deepEqual(auto['estimate'], { cost: '$900.00', everyYears: 1 });
    assert.equal(r.envelopes.find((e) => e.id === 'food')!.sinking, null);
    assert.equal(r.savings['status'], 'over');
    assert.equal((r.savings['words'] as { verdict: string }).verdict, "$10 in Savings isn't in any fund.");
  });
});

describe('the Today card for a shortfall', () => {
  const short = async () => {
    const c = await ctx();
    await approve('set_sinking_goal', AUTO_EVERY, c);
    await c.store.append('alice', { op: 'savings.account', account: '7' });
    return c;
  };
  const record = (c: ToolContext, amount: number, asOf = '2026-11-02') =>
    c.store.append('bob', { op: 'account.balance', account: '7', cents: cents(amount), asOf, source: 'statement' });

  test('a balance short of the funds raises one card, from whoever recorded it, with no Claude in it', async () => {
    const c = await short();
    const written = await record(c, 500);
    const o = (await raiseSavingsCard(c, written))!;
    assert.deepEqual([o.who, o.tool, o.prompt, o.events.length], ['bob', 'savings_short', { kind: 'savings', ref: written[0]!.id }, 0]);
    assert.equal(o.summary, 'Savings is $15 short of the sinking funds');
    assert.ok(waiting(c.store.state, 'alice', []).some((w) => w.kind === 'offer' && w.offer.id === o.id));
    assert.equal(await raiseSavingsCard(c, written), null, 'once per balance');
    assert.ok(CARD_ONLY.has('savings_short'));
  });

  test('a balance that covers the funds raises nothing', async () => {
    const c = await short();
    assert.equal(await raiseSavingsCard(c, await record(c, 2000)), null);
  });

  test('a newer balance retires the last card, and approving one only says it was seen', async () => {
    const c = await short();
    const first = (await raiseSavingsCard(c, await record(c, 500)))!;
    const next = await record(c, 900, '2026-11-03');
    assert.equal(c.store.state.thread.offers.get(first.id)!.status, 'replaced');
    const second = (await raiseSavingsCard(c, next))!;
    const before = c.store.state.eventCount;
    const written = await decide(c, second.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide']);
    assert.equal(c.store.state.eventCount, before + 1);
  });
});
