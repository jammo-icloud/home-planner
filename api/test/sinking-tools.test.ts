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
    { op: 'category.define', category: 'groceries', label: 'Groceries' },
    { op: 'category.define', category: 'tyres', label: 'Tyres' },
    { op: 'category.define', category: 'service', label: 'Car service' },
    { op: 'category.define', category: 'trips', label: 'Trips' },
    { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
    { op: 'envelope.define', budget: 'harbor', envelope: 'food', label: 'Groceries', group: 'People',
      match: { categories: ['groceries'] }, template: cents(60000), order: 0 },
    { op: 'envelope.define', budget: 'harbor', envelope: 'auto', label: 'Auto maintenance', group: 'Future',
      match: { categories: ['tyres', 'service'] }, template: cents(2000), rollover: false, order: 1 },
    { op: 'envelope.define', budget: 'harbor', envelope: 'bahamas', label: 'Bahamas', group: 'Future',
      match: { categories: ['trips'] }, template: cents(0), order: 2 },
    { op: 'income.source.define', source: 'pay', budget: 'harbor', label: 'Pay', earner: 'alice',
      amount: cents(500000), frequency: 'monthly', anchor: '2026-10-01' },
    { op: 'month.open', budget: 'harbor', month: '2026-11', income: cents(500000) },
  ]);
  return { store, who: 'alice', today: TODAY, proposals: new ProposalStore(), sid: null };
}

const propose = (name: string, args: Record<string, unknown>, c: ToolContext) =>
  toolByName.get(name)!.run(args, c) as Proposal;
const approve = async (name: string, args: Record<string, unknown>, c: ToolContext) =>
  (await commit(propose(name, args, c).id, c)).committed;

const AUTO_EVERY = {
  budget: 'harbor', envelope: 'auto', goal: 'every',
  estimates: [{ category: 'tyres', costCents: 120000, everyYears: 4 }, { category: 'service', costCents: 60000, everyYears: 1 }],
};

describe('set_sinking_goal', () => {
  test('every so often: the envelope is marked and the estimates go on its categories, in one proposal', async () => {
    const c = await ctx();
    const p = propose('set_sinking_goal', AUTO_EVERY, c);
    assert.equal(p.summary, 'Save Auto maintenance in Savings');
    assert.deepEqual(p.events.map((e) => e.op), ['envelope.define', 'category.sinking', 'category.sinking']);
    assert.equal(p.effects[0], 'Auto maintenance is saved in Savings: $75.00 a month, toward $1,800.00 of estimates');
    assert.ok(p.effects.includes('Tyres: $1,200.00 every 4 years, $25.00 a month'));
    await commit(p.id, c);
    const state = c.store.state;
    const auto = state.budgets.get('harbor')!.envelopes.get('auto')!;
    assert.deepEqual([auto.sinking, auto.rollover, auto.template, auto.label], [{ kind: 'every' }, true, 2000, 'Auto maintenance']);
    assert.deepEqual(state.categories.get('tyres')!.sinking, { cost: 120000, everyYears: 4 });
  });

  test('an estimate is changed from the envelope without touching the goal', async () => {
    const c = await ctx();
    await approve('set_sinking_goal', AUTO_EVERY, c);
    const p = propose('set_sinking_goal', { budget: 'harbor', envelope: 'auto', goal: 'every',
      estimates: [{ category: 'service', costCents: null }] }, c);
    assert.equal(p.summary, "Change Auto maintenance's goal");
    assert.deepEqual(p.events, [{ op: 'category.sinking', category: 'service', sinking: null }]);
    assert.ok(p.effects.includes('Car service: no estimate, so nothing is set aside for it'));
  });

  test('by a date: what is left over the months left, from this month', async () => {
    const c = await ctx();
    const p = propose('set_sinking_goal', { budget: 'harbor', envelope: 'bahamas', goal: 'by', targetCents: 400000, by: '2027-03' }, c);
    assert.deepEqual(p.effects.slice(0, 2), ['Bahamas is saved in Savings: $4,000.00 by March 2027',
      '$800.00 a month, over 5 months from November 2026, worked out again each month']);
  });

  test('refuses a month gone by, a category that does not feed it, and a change that changes nothing', async () => {
    const c = await ctx();
    assert.throws(() => propose('set_sinking_goal', { budget: 'harbor', envelope: 'bahamas', goal: 'by', targetCents: 400000, by: '2026-10' }, c),
      /has already gone by/);
    assert.throws(() => propose('set_sinking_goal', { budget: 'harbor', envelope: 'auto', goal: 'every',
      estimates: [{ category: 'trips', costCents: 100, everyYears: 1 }] }, c), /does not feed Auto maintenance/);
    assert.throws(() => propose('set_sinking_goal', { budget: 'harbor', envelope: 'food', goal: 'none' }, c), ToolError);
  });

  test('none makes it ordinary again, and says what it holds stays', async () => {
    const c = await ctx();
    await approve('set_sinking_goal', AUTO_EVERY, c);
    const p = propose('set_sinking_goal', { budget: 'harbor', envelope: 'auto', goal: 'none' }, c);
    assert.equal(p.summary, 'Stop saving Auto maintenance in Savings');
    await commit(p.id, c);
    assert.equal(c.store.state.budgets.get('harbor')!.envelopes.get('auto')!.sinking, undefined);
  });

  test('renaming a category keeps its estimate', async () => {
    const c = await ctx();
    await approve('set_sinking_goal', AUTO_EVERY, c);
    await approve('define_category', { category: 'tyres', label: 'Tires' }, c);
    assert.deepEqual(c.store.state.categories.get('tyres'), { id: 'tyres', label: 'Tires', kind: 'People', sinking: { cost: 120000, everyYears: 4 } });
  });
});

describe('the month plan', () => {
  test('a new month proposes each sinking envelope at what its goal needs, and the rest at their templates', async () => {
    const c = await ctx();
    await approve('set_sinking_goal', AUTO_EVERY, c);
    await approve('set_sinking_goal', { budget: 'harbor', envelope: 'bahamas', goal: 'by', targetCents: 400000, by: '2027-03' }, c);
    // November funds the Bahamas at $1,000, more than asked: December asks for less.
    await approve('set_assignment', { budget: 'harbor', month: '2026-11', envelope: 'bahamas', toCents: 100000, why: 'a good month' }, c);
    const p = propose('open_month', { budget: 'harbor', month: '2026-12' }, c);
    assert.deepEqual((p.events[0] as Extract<Event, { op: 'month.open' }>).plan, { auto: 7500, bahamas: 75000 });
    assert.ok(p.effects.includes('Bahamas planned at $750.00, what its goal needs this month'));
    assert.ok(p.effects.includes('Planned $1,425.00 against income $5,000.00'));
    await commit(p.id, c);
    const v = monthView(c.store.state, 'harbor', '2026-12')!;
    assert.deepEqual(v.envelopes.map((e) => [e.envelope.id, e.planned, e.carried]), [['food', 60000, 60000], ['auto', 7500, 2000], ['bahamas', 75000, 100000]]);
  });

  test('without a sinking envelope the month opens as it always did', async () => {
    const c = await ctx();
    const p = propose('open_month', { budget: 'harbor', month: '2026-12' }, c);
    assert.deepEqual(p.events, [{ op: 'month.open', budget: 'harbor', month: '2026-12', income: 500000 }]);
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
    const r = toolByName.get('get_month')!.run({ budget: 'harbor' }, c) as {
      envelopes: { id: string; sinking: Record<string, unknown> | null }[]; savings: Record<string, unknown>;
    };
    const auto = r.envelopes.find((e) => e.id === 'auto')!.sinking!;
    assert.deepEqual([auto['kind'], auto['savedExact'], auto['goalExact'], auto['monthlyExact']], ['every', '$20.00', '$1,800.00', '$75.00']);
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
    const o = (await raiseSavingsCard(c, 'harbor', written))!;
    assert.deepEqual([o.who, o.tool, o.prompt, o.events.length], ['bob', 'savings_short', { kind: 'savings', ref: written[0]!.id }, 0]);
    assert.equal(o.summary, 'Savings is $15 short of the sinking funds');
    assert.ok(waiting(c.store.state, 'alice', []).some((w) => w.kind === 'offer' && w.offer.id === o.id));
    assert.equal(await raiseSavingsCard(c, 'harbor', written), null, 'once per balance');
    assert.ok(CARD_ONLY.has('savings_short'));
  });

  test('a balance that covers the funds raises nothing', async () => {
    const c = await short();
    assert.equal(await raiseSavingsCard(c, 'harbor', await record(c, 2000)), null);
  });

  test('a newer balance retires the last card, and approving one only says it was seen', async () => {
    const c = await short();
    const first = (await raiseSavingsCard(c, 'harbor', await record(c, 500)))!;
    const next = await record(c, 900, '2026-11-03');
    assert.equal(c.store.state.thread.offers.get(first.id)!.status, 'replaced');
    const second = (await raiseSavingsCard(c, 'harbor', next))!;
    const before = c.store.state.eventCount;
    const written = await decide(c, second.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide']);
    assert.equal(c.store.state.eventCount, before + 1);
  });
});
