import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars, fmt } from '../src/money.ts';
import { Store } from '../src/store.ts';
import {
  TOOLS, toolByName, toolSchemas, commit, ProposalStore, RESEARCH_WRITES, ToolError, runTool, describe as describeEvent, forClaude, researchMay, runEffect, touches,
} from '../src/tools.ts';
import { SEARCH_KINDS } from '../src/search.ts';
import { NotAllowed, SessionLost, SynologyError } from '../src/synology.ts';
import type { Proposal, ToolContext } from '../src/tools.ts';
import { monthView } from '../src/envelopes.ts';
import { TRANSFER, SPLIT } from '../src/types.ts';
import * as edits from '../src/plan-edits.ts';
import { RETIRED } from '../src/plan-rules.ts';

const NOW = '2026-08-13T09:00:00Z';
const TODAY = '2026-08-13';

async function ctx(): Promise<ToolContext> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-tools-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('system', [
    { op: 'category.define', category: 'groceries', label: 'Groceries' },
    { op: 'category.define', category: 'dining', label: 'Dining out' },
    { op: 'category.define', category: 'electricity', label: 'Electricity' },
    { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
    { op: 'budget.create', budget: 'ridge', label: 'Ridge' },
    { op: 'envelope.define', budget: 'harbor', envelope: 'daily', label: 'Daily life', group: 'People',
      match: { categories: ['groceries', 'dining'] }, template: parseDollars('1525.00'), rollover: false, order: 0 },
    { op: 'envelope.define', budget: 'harbor', envelope: 'util', label: 'Utilities', group: 'House',
      match: { categories: ['electricity'] }, template: parseDollars('300.00'), rollover: false, order: 1 },
    { op: 'envelope.define', budget: 'ridge', envelope: 'daily', label: 'Daily life', group: 'People',
      match: { categories: ['groceries', 'dining'] }, template: parseDollars('1910.00'), order: 0 },
    { op: 'envelope.define', budget: 'ridge', envelope: 'util', label: 'Utilities', group: 'House',
      match: { categories: ['electricity'] }, template: parseDollars('615.00'), order: 1 },
    { op: 'month.open', budget: 'harbor', month: '2026-08', income: parseDollars('9600.00') },
    { op: 'txn.add', txns: [
      { id: 'x1', date: '2026-08-03', payee: 'VALLEY MARKET #101', amount: parseDollars('-84.21'), dedupeKey: 'x1', category: 'groceries' },
      { id: 'x2', date: '2026-08-06', payee: 'CORNER BISTRO', amount: parseDollars('-1300.00'), dedupeKey: 'x2', category: 'dining' },
      { id: 'x3', date: '2026-08-08', payee: 'EXAMPLE POWER', amount: parseDollars('-120.00'), dedupeKey: 'x3', category: 'electricity' },
      { id: 'x4', date: '2026-08-09', payee: 'QUIKSTOP 10001', amount: parseDollars('-10.15'), dedupeKey: 'x4', category: null },
      { id: 'x5', date: '2026-08-10', payee: 'PAYMENT THANK YOU', amount: parseDollars('2400.50'), dedupeKey: 'x5', category: TRANSFER },
    ] },
  ]);
  return { store, who: 'alice', today: TODAY, proposals: new ProposalStore(), sid: null };
}

const call = (name: string, args: Record<string, unknown>, c: ToolContext) =>
  toolByName.get(name)!.run(args, c);

describe('the tool surface', () => {
  test('every tool is described for a reader, not just named', () => {
    for (const t of TOOLS) {
      assert.ok(t.description.length > 60, `${t.name} needs a real description`);
      assert.ok(t.input['type'] === 'object', `${t.name} needs an input schema`);
      assert.ok(t.kind === 'read' || t.kind === 'write');
    }
  });

  test('the schemas Claude gets are the same ones the UI drives', () => {
    const schemas = toolSchemas();
    assert.equal(schemas.length, TOOLS.length);
    for (const s of schemas) {
      assert.ok(s.name && s.description && s.input_schema);
    }
  });

  test('search is a read Claude has, in research too', () => {
    const t = toolByName.get('search')!;
    assert.ok(t, 'there is a search tool');
    assert.equal(t.kind, 'read');
    assert.ok(forClaude(t));
    assert.ok(researchMay(t));
    const input = t.input as { properties: Record<string, { type?: string; enum?: readonly string[] }>; required: string[] };
    assert.deepEqual(input.required, ['words']);
    assert.equal(input.properties['words']!.type, 'string');
    assert.deepEqual(input.properties['kind']!.enum, SEARCH_KINDS);
    assert.match(t.description, /plans, briefings, answers and files/);
    assert.match(t.description, /household/);
    assert.match(t.description, /not searched/);
  });
});

describe('reads answer questions in one call', () => {
  test("get_month answers each envelope's flag, source and hint, the card and the groups in order", async () => {
    const c = await ctx();
    await c.store.append('system', [
      { op: 'category.define', category: 'upkeep', label: 'Repairs & upkeep' },
      { op: 'category.define', category: 'rent', label: 'Rent or mortgage' },
      { op: 'envelope.define', budget: 'harbor', envelope: 'upkeep', label: 'Repairs', group: 'Food',
        match: { categories: ['upkeep'] }, template: parseDollars('0.00'), rollover: true, order: 2, needsFigure: true },
      { op: 'envelope.define', budget: 'harbor', envelope: 'rent', label: 'Rent', group: 'Home',
        match: { categories: ['rent'] }, template: parseDollars('900.00'), rollover: true, order: 3,
        source: 'Public data for Harbor' },
    ]);
    const r = call('get_month', { budget: 'harbor' }, c) as Record<string, any>;
    const by = (id: string) => r.envelopes.find((e: any) => e.id === id);
    assert.equal(by('upkeep').needsFigure, true);
    assert.equal(by('upkeep').source, null);
    assert.deepEqual(by('upkeep').hint, { text: "A common rule is 1% of the home's value a year." });
    assert.equal(by('rent').needsFigure, false);
    assert.equal(by('rent').source, 'Public data for Harbor');
    assert.equal(by('rent').hint, null);
    assert.equal(r.card.tone, 'warm');
    assert.equal(r.card.headline, '$7,775 still to assign');
    assert.equal(r.card.next, 'upkeep');
    assert.deepEqual(r.groups, ['Home', 'Food', 'House', 'People']);
  });

  test('get_month answers basis as exact dollars and hint for every envelope with categories', async () => {
    const c = await ctx();
    await c.store.append('system', [
      { op: 'envelope.define', budget: 'harbor', envelope: 'util', label: 'Utilities', group: 'House',
        match: { categories: ['electricity'] }, template: parseDollars('100.00'), rollover: false, order: 1,
        basis: { amount: parseDollars('1200.00'), per: 'year' } },
      { op: 'txn.add', txns: [
        { id: 'j1', date: '2026-07-05', payee: 'VALLEY MARKET #101', amount: parseDollars('-600.00'), dedupeKey: 'j1', category: 'groceries' },
      ] },
    ]);
    const r = call('get_month', { budget: 'harbor' }, c) as Record<string, any>;
    const by = (id: string) => r.envelopes.find((e: any) => e.id === id);
    assert.deepEqual(by('util').basis, { amount: '1,200.00', per: 'year' });
    assert.equal(by('util').templateExact, '$100.00');
    assert.equal(by('daily').templateExact, '$1,525.00');
    assert.equal(by('daily').basis, null);
    // Daily life has a figure and no flag, and is still offered its receipts' averages.
    assert.equal(by('daily').needsFigure, false);
    assert.deepEqual(by('daily').hint, {
      text: 'Your receipts average $600 a month over the last 3 months',
      use: { cents: 60000, label: 'Use $600 (3-month average)', exact: '$600.00' },
      averages: [{ months: 1, cents: 60000 }, { months: 3, cents: 60000 }, { months: 6, cents: 60000 }],
    });
    // Utilities' receipts are all this month's: nothing to average yet.
    assert.equal(by('util').hint, null);
  });

  test('get_month covers "how are we doing"', async () => {
    const c = await ctx();
    const r = call('get_month', { budget: 'harbor' }, c) as Record<string, any>;
    assert.equal(r['month'], '2026-08');
    assert.equal(r['dayOfMonth'], 13);
    assert.equal(r['income'], '$9,600');
    assert.equal(r['spent'], '$1,504');       // 84.21 + 1300 + 120, transfer excluded
    assert.equal(r['balanced'], false);
    assert.equal(r['unsorted'].count, 1);
    // $1,384 of $1,525 by day 13 is not over yet — it is heading there, and the
    // distinction is the whole point: one is a fact, the other is a warning.
    const daily = r['pace'].find((p: any) => p.envelope === 'daily');
    assert.equal(daily.status, 'projected-over');
    assert.equal(daily.projectedToSpend, '$3,301');
    assert.equal(daily.projectedOverBy, '$1,776');
  });

  test('explain_envelope has everything needed to answer "why is it empty?"', async () => {
    const c = await ctx();
    const r = call('explain_envelope', { budget: 'harbor', envelope: 'daily' }, c) as Record<string, any>;
    assert.equal(r['planned'], '$1,525');
    assert.equal(r['spent'], '$1,384');
    assert.equal(r['left'], '$141');
    assert.equal(r['transactions'].length, 2, 'the actual spending is included');
    assert.equal(r['transactions'][0].payee, 'CORNER BISTRO');
    assert.ok(r['pacing'].projectedToSpend, 'and a projection to explain the trajectory');
    assert.deepEqual(r['feedsFrom'].categories, ['groceries', 'dining']);
  });

  // x4 (-10.15) split groceries -6.15 / dining -4.00; both feed Harbor's daily.
  const splitX4 = (c: ToolContext) => c.store.append('alice', { op: 'txn.split', txn: 'x4', parts: [
    { category: 'groceries', amount: parseDollars('-6.15') }, { category: 'dining', amount: parseDollars('-4.00') }] });

  test('list_transactions shows the parts, and a category filter finds a part', async () => {
    const c = await ctx();
    await splitX4(c);
    const dining = call('list_transactions', { category: 'dining' }, c) as Record<string, any>;
    const row = dining['transactions'].find((t: any) => t.id === 'x4');
    assert.ok(row, 'a part in dining finds the receipt');
    assert.equal(row.category, SPLIT);
    assert.equal(row.parts.length, 2);
    assert.deepEqual(row.parts, [{ category: 'groceries', amount: '-$6.15' }, { category: 'dining', amount: '-$4.00' }]);
    assert.equal(row.amount, '-$10.15');
    const all = call('list_transactions', {}, c) as Record<string, any>;
    assert.equal(all['transactions'].find((t: any) => t.id === 'x1').parts, null);
    assert.equal((call('list_transactions', { category: 'electricity' }, c) as Record<string, any>)['matched'], 1, 'a plain receipt still filters');
    assert.equal((call('list_transactions', { uncategorizedOnly: true }, c) as Record<string, any>)['matched'], 0, 'a split is sorted');
  });

  test('under a category filter the totals count only the matching parts, and the marker lists the splits', async () => {
    const c = await ctx();
    await splitX4(c);
    const money = (category: string) => call('list_transactions', { category }, c) as Record<string, any>;
    assert.equal(money('groceries')['moneyOut'], '$90.36', '84.21 + 6.15, not the whole $10.15 receipt');
    assert.equal(money('groceries')['total'], '$90');
    assert.equal(money('dining')['moneyOut'], '$1,304.00', '1300.00 + 4.00');
    assert.equal(money('dining')['moneyIn'], '$0.00');
    assert.equal(money('dining')['transactions'].find((t: any) => t.id === 'x4').amount, '-$10.15', 'the row keeps the whole receipt');
    const marker = money(SPLIT);
    assert.deepEqual(marker['transactions'].map((t: any) => t.id), ['x4']);
    assert.equal(marker['moneyOut'], '$10.15');
  });

  test('explain_envelope shows the share and the whole', async () => {
    const c = await ctx();
    await splitX4(c);
    const r = call('explain_envelope', { budget: 'harbor', envelope: 'daily' }, c) as Record<string, any>;
    const quik = r['transactions'].filter((t: any) => t.payee === 'QUIKSTOP 10001');
    assert.equal(quik.length, 2);
    assert.deepEqual(quik.map((t: any) => [t.category, t.amount, t.of]),
      [['groceries', '-$6.15', '-$10.15'], ['dining', '-$4.00', '-$10.15']]);
    const plain = r['transactions'].find((t: any) => t.payee === 'CORNER BISTRO');
    assert.equal(plain.of, undefined);
    assert.equal(plain.amount, '-$1,300.00');
    assert.equal(r['spentExact'], '$1,394.36'); // 84.21 + 1300 + 6.15 + 4.00
  });

  test('explain_envelope entries carry the receipt id, its whole amount and its parts', async () => {
    const c = await ctx();
    await splitX4(c);
    const r = call('explain_envelope', { budget: 'harbor', envelope: 'daily' }, c) as Record<string, any>;
    const quik = r['transactions'].filter((t: any) => t.payee === 'QUIKSTOP 10001');
    for (const e of quik) {
      assert.equal(e.txn, 'x4');
      assert.equal(e.amountCents, c.store.state.txns.get('x4')!.amount);
      assert.deepEqual(e.parts, [{ category: 'groceries', amountCents: -615 }, { category: 'dining', amountCents: -400 }]);
    }
    const plain = r['transactions'].find((t: any) => t.payee === 'CORNER BISTRO');
    assert.equal(plain.txn, 'x2');
    assert.equal(plain.amountCents, -130000);
    assert.equal(plain.parts, null);
  });

  test('removing an envelope and archiving a category count a split part as held', async () => {
    const c = await ctx();
    await splitX4(c);
    const rm = call('remove_envelope', { budget: 'harbor', envelope: 'daily', why: 'test' }, c) as Record<string, any>;
    // x1, x2 and x4 (once, though both its parts are in daily)
    assert.ok(rm['effects'].some((e: string) => e.startsWith('3 receipts totalling $1,394.36')), rm['effects'].join('|'));
    const ar = call('archive_category', { category: 'dining', archived: true, why: 'test' }, c) as Record<string, any>;
    assert.ok(ar['effects'].some((e: string) => e.startsWith('2 receipts stay in it')), ar['effects'].join('|'));
  });

  test('find_donors will not offer an envelope that still needs its money', async () => {
    const c = await ctx();
    const r = call('find_donors', { budget: 'harbor', forEnvelope: 'daily' }, c) as Record<string, any>;
    // utilities: $300 funded, $120 spent by day 13 -> projects to ~$286, so barely spare
    const util = r['donors'].find((d: any) => d.envelope === 'util');
    assert.ok(!util || util.couldSpare !== undefined);
    assert.ok(!r['donors'].some((d: any) => d.envelope === 'daily'), 'never itself');
  });

  test('the unsorted list keeps money out and money in apart', async () => {
    // The queue on Budget is fed from this, month or no month. Summing both
    // directions would report an unsorted paycheque as spending.
    const c = await ctx();
    await c.store.append('alice', { op: 'txn.add', txns: [
      { id: 'x6', date: '2026-08-11', payee: 'ACME DEPOSIT', amount: parseDollars('250.00'), dedupeKey: 'x6', category: null },
    ] });
    const r = call('list_transactions', { uncategorizedOnly: true }, c) as Record<string, any>;
    assert.equal(r.matched, 2);
    assert.equal(r.moneyOut, '$10.15');
    assert.equal(r.moneyIn, '$250.00');
  });

  test('list_transactions filters the shared ledger', async () => {
    const c = await ctx();
    const all = call('list_transactions', {}, c) as Record<string, any>;
    assert.equal(all['matched'], 5);
    const unsorted = call('list_transactions', { uncategorizedOnly: true }, c) as Record<string, any>;
    assert.equal(unsorted['matched'], 1);
    assert.equal(unsorted['transactions'][0].payee, 'QUIKSTOP 10001');
    const byPayee = call('list_transactions', { payeeContains: 'valley' }, c) as Record<string, any>;
    assert.equal(byPayee['matched'], 1);
  });

  test('compare_budgets flags an envelope that exists in only one of them', async () => {
    // A cost that appears or disappears entirely is a bigger finding than one
    // whose number moved, and reads differently on the page.
    const c = await ctx();
    await c.store.append('alice', {
      op: 'envelope.define', budget: 'ridge', envelope: 'pool', label: 'Pool & spa',
      group: 'House', match: { categories: ['electricity'] }, template: parseDollars('215.00'), order: 5,
    });
    const r = call('compare_budgets', { a: 'harbor', b: 'ridge' }, c) as Record<string, any>;
    assert.equal(r['byEnvelope'].find((x: any) => x.envelope === 'pool').onlyIn, 'ridge');
    assert.equal(r['byEnvelope'].find((x: any) => x.envelope === 'daily').onlyIn, null);
  });

  test('compare_budgets measures affordability against the leanest month', async () => {
    // A plan that only works in a three-paycheque month does not work.
    const c = await ctx();
    await c.store.append('alice', {
      op: 'income.source.define', source: 'i1', budget: 'harbor', label: 'Salary',
      earner: 'alice', amount: parseDollars('1000.00'), frequency: 'biweekly', anchor: '2026-01-02',
    });
    const r = call('compare_budgets', { a: 'harbor', b: 'ridge' }, c) as Record<string, any>;
    assert.equal(r['affordability']['harbor'].income, '$2,000',
      'two paydays, never the three-payday month');
    assert.equal(r['affordability']['ridge'].income, null, 'no income recorded for the other');
  });

  test('compare_budgets prices the move', async () => {
    const c = await ctx();
    const r = call('compare_budgets', { a: 'harbor', b: 'ridge' }, c) as Record<string, any>;
    assert.equal(r['monthlyDifference'], '$700');   // (1910-1525) + (615-300)
    assert.equal(r['annualDifference'], '$8,400');
    const util = r['byEnvelope'].find((x: any) => x.envelope === 'util');
    assert.equal(util.difference, '$315');
  });

  test('get_activity reads as sentences, not as records', async () => {
    const c = await ctx();
    const r = await call('get_activity', {}, c) as Record<string, any>;
    assert.ok(r['events'].length > 0);
    for (const e of r['events']) {
      assert.ok(typeof e.what === 'string' && e.what.length > 0);
      assert.ok(e.who && e.at && e.id);
    }
    assert.ok(r['events'].some((e: any) => /imported 5 transactions/.test(e.what)));
  });

  test('describe covers every op so the log never renders raw', () => {
    const ops = [
      { op: 'assign', budget: 'b', month: '2026-08', envelope: 'e', to: parseDollars('10.00'), why: 'w' },
      { op: 'move', budget: 'b', month: '2026-08', from: 'a', to: 'z', amount: parseDollars('5.00'), why: 'w' },
      { op: 'month.open', budget: 'b', month: '2026-08', income: parseDollars('1.00') },
      { op: 'rule.add', rule: 'r', match: 'X', category: 'c' },
    ];
    for (const o of ops) {
      const line = describeEvent({ id: 'i', at: NOW, who: 'alice', ...o } as never);
      assert.ok(line.what.length > 0 && !line.what.includes('undefined'), JSON.stringify(o));
    }
  });
});

describe('every op reads as a sentence', () => {
  // These fell through to the raw op name, so the activity list and the
  // briefing's change list showed "household.claim" and "budget.locate". The
  // switch in describe() is now exhaustive, so a new op without a sentence
  // fails to typecheck; this checks the sentences themselves.
  const ops = [
    { op: 'budget.rename', budget: 'b', label: 'Cabin', why: 'w' },
    { op: 'budget.locate', budget: 'b', location: { label: 'Springfield, IL' }, why: 'w' },
    { op: 'budget.locate', budget: 'b', location: null, why: 'w' },
    { op: 'budget.archive', budget: 'b', archived: true, why: 'w' },
    { op: 'category.archive', category: 'c', archived: false, why: 'w' },
    { op: 'month.close', budget: 'b', month: '2026-08', closed: true, why: 'w' },
    { op: 'month.discard', budget: 'b', month: '2026-08', why: 'w' },
    { op: 'income.source.define', source: 's', budget: 'b', label: 'Salary', amount: parseDollars('1.00') },
    { op: 'income.source.remove', source: 's', why: 'w' },
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'w' },
    { op: 'member.remove', member: 'bob', why: 'w' },
    { op: 'briefing.read', upTo: 'e1' },
    { op: 'prediction.record', prediction: 'p', budget: 'b', month: '2026-08', envelope: 'e', expected: parseDollars('1.00'), why: 'w' },
    { op: 'areas.set', areas: ['House'] },
    { op: 'calendar.household', cal_id: '/a/h/', original_cal_id: '/a/h/', name: 'Household' },
    { op: 'links.set', links: [] },
    { op: 'calendar.target', cal_id: '/a/h/', original_cal_id: '/a/h/' },
    { op: 'calendar.conflicts', calendars: [] },
    { op: 'scheme.set', scheme: 'lapis', mode: 'match' },
    { op: 'plan.create', plan: 'p1', title: 'Fix the gate', area: 'House' },
    { op: 'plan.create', plan: 'p2', title: 'Hinge', area: 'House', parent: 'p1' },
    { op: 'plan.set', plan: 'p1', title: 'Mend the gate', area: 'Yard', chips: ['quote'], notes: 'n', estimate: parseDollars('25.00'),
      envelope: { budget: 'b', envelope: 'e' } },
    { op: 'plan.set', plan: 'p1', estimate: null, envelope: null },
    { op: 'plan.set', plan: 'p1' },
    { op: 'plan.state', plan: 'p1', state: 'doing' },
    { op: 'plan.ask', plan: 'p1', to: 'bob', why: 'w' },
    { op: 'plan.ask.accept', plan: 'p1' },
    { op: 'plan.ask.decline', plan: 'p1', why: 'w' },
    { op: 'plan.checklist', plan: 'p1', items: [{ id: 'c1', text: 'measure', done: false }] },
    { op: 'plan.attach', plan: 'p1', path: 'plans/p1/gate.png', name: 'gate.png', size: 10 },
    { op: 'plan.detach', plan: 'p1', path: 'plans/p1/gate.png', why: 'w' },
    { op: 'plan.contact.link', plan: 'p1', contact_id: 7, addressbook_id: 1, display: 'Sam the fencer' },
    { op: 'plan.contact.unlink', plan: 'p1', contact_id: 7 },
    { op: 'plan.due', plan: 'p1', due: '2026-11-15' },
    { op: 'plan.due', plan: 'p1', due: null },
    { op: 'plan.block', plan: 'p1', block: 'k1', start: '2026-11-14T09:00:00.000Z', end: '2026-11-14T11:00:00.000Z' },
    { op: 'plan.unblock', plan: 'p1', block: 'k1', why: 'w' },
    { op: 'plan.remove', plan: 'p1', why: 'w' },
  ];
  for (const o of ops) {
    test(`${o.op}${'location' in o && !o.location ? ' (cleared)' : ''}`, () => {
      const line = describeEvent({ id: 'i', at: NOW, who: 'alice', ...o } as never);
      assert.notEqual(line.what, o.op, 'the raw op name is not a sentence');
      assert.doesNotMatch(line.what, /undefined|null|\[object/);
    });
  }
});

describe('with the household at hand, a sentence uses names', () => {
  // The activity list read "opened 2026-10 for harbor": an id and a month
  // key. Given the state, describe() says what a person would.
  test('budgets, envelopes, categories and months by name', async () => {
    const c = await ctx();
    const at = (o: Record<string, unknown>) =>
      describeEvent({ id: 'i', at: NOW, who: 'alice', ...o } as never, c.store.state).what;
    assert.equal(at({ op: 'month.open', budget: 'harbor', month: '2026-08', income: parseDollars('1.00') }), 'opened August 2026 for Harbor');
    assert.equal(at({ op: 'move', budget: 'harbor', month: '2026-08', from: 'util', to: 'daily', amount: parseDollars('5.00'), why: 'w' }),
      'moved $5 from Utilities to Daily life');
    assert.equal(at({ op: 'assign', budget: 'harbor', month: '2026-08', envelope: 'daily', to: parseDollars('10.00'), why: 'w' }),
      'set Daily life to $10');
    assert.equal(at({ op: 'txn.categorize', txn: 'x4', category: 'groceries' }), 'categorized a transaction as Groceries');
    assert.equal(at({ op: 'txn.categorize', txn: 'x4', category: TRANSFER }), 'categorized a transaction as a transfer');
  });

  test('a flagged envelope is not short on the Budget screen either', async () => {
    const c = await ctx();
    await c.store.append('system', [
      { op: 'category.define', category: 'upkeep', label: 'Repairs & upkeep' },
      { op: 'envelope.define', budget: 'harbor', envelope: 'upkeep', label: 'Repairs', group: 'House',
        match: { categories: ['upkeep'] }, template: parseDollars('0.00'), rollover: true, order: 2, needsFigure: true },
      { op: 'txn.add', txns: [{ id: 'x8', date: '2026-08-12', payee: 'VALLEY MARKET #101', amount: parseDollars('-50.00'), dedupeKey: 'x8', category: 'upkeep' }] },
    ]);
    const r = call('get_month', { budget: 'harbor' }, c) as Record<string, any>;
    const upkeep = r.envelopes.find((e: any) => e.id === 'upkeep');
    assert.equal(upkeep.left, '-$50');
    assert.equal(upkeep.short, null);
    // One with a figure is short, with its cover in cents and exact dollars.
    await c.store.append('system', [
      { op: 'txn.add', txns: [{ id: 'x7', date: '2026-08-12', payee: 'EXAMPLE POWER', amount: parseDollars('-250.00'), dedupeKey: 'x7', category: 'electricity' }] },
    ]);
    const again = call('get_month', { budget: 'harbor' }, c) as Record<string, any>;
    const util = again.envelopes.find((e: any) => e.id === 'util');
    assert.equal(util.short.amount, parseDollars('70.00'));
    assert.equal(util.short.amountExact, '$70.00');
  });

  test('without it, ids as before, so nothing that cannot reach the state breaks', () => {
    const line = describeEvent({ id: 'i', at: NOW, who: 'alice', op: 'month.open', budget: 'harbor', month: '2026-08', income: 100 } as never);
    assert.equal(line.what, 'opened 2026-08 for harbor');
  });

  test('a name since removed falls back to the id rather than to nothing', async () => {
    const c = await ctx();
    const line = describeEvent({ id: 'i', at: NOW, who: 'alice', op: 'envelope.remove', budget: 'gone', envelope: 'old', why: 'w' } as never, c.store.state);
    assert.equal(line.what, 'removed envelope old');
  });
});

describe('writes propose, they never execute', () => {
  test('move_money changes nothing until committed', async () => {
    const c = await ctx();
    const before = c.store.state.eventCount;
    const beforeFile = await readFile(c.store.path, 'utf8');

    const p = call('move_money', {
      budget: 'harbor', from: 'util', to: 'daily',
      amountCents: 9600, why: 'covering the Nguyen dinner',
    }, c) as Proposal;

    assert.match(p.summary, /Move \$96\.00 from Utilities to Daily life/, 'the approval shows the cents it writes');
    assert.ok(p.effects.some((e) => /planned at \$1,525/.test(e)), 'the preview names the untouched plan');
    assert.equal(c.store.state.eventCount, before, 'nothing was applied');
    assert.equal(await readFile(c.store.path, 'utf8'), beforeFile, 'and nothing was written');

    const done = await commit(p.id, c);
    assert.equal(done.committed.length, 1);
    const v = monthView(c.store.state, 'harbor', '2026-08')!;
    const daily = v.envelopes.find((e) => e.envelope.id === 'daily')!;
    assert.equal(daily.planned, parseDollars('1525.00'), 'plan of record still untouched');
    assert.equal(daily.funded, parseDollars('1621.00'));
  });

  test('a cover move is refused once the envelope is no longer short', async () => {
    const c = await ctx();
    // Utilities carries $300; $320 spent leaves it $20 short.
    await c.store.append('system', [
      { op: 'txn.add', txns: [{ id: 'x9', date: '2026-08-11', payee: 'EXAMPLE POWER', amount: parseDollars('-200.00'), dedupeKey: 'x9', category: 'electricity' }] },
    ]);
    const short = monthView(c.store.state, 'harbor', '2026-08')!.envelopes.find((e) => e.envelope.id === 'util')!;
    assert.equal(short.available, parseDollars('-20.00'));
    const cover = { budget: 'harbor', from: 'daily', to: 'util', amountCents: 2000, why: 'cover', onlyWhileShort: true };
    const p = call('move_money', cover, c) as Proposal;
    await commit(p.id, c);
    assert.throws(() => call('move_money', cover, c), (e: unknown) =>
      e instanceof ToolError && e.status === 409 && /Utilities is no longer short/.test(e.message));
    // Without the flag the move is proposed as before.
    assert.ok(call('move_money', { ...cover, onlyWhileShort: undefined }, c));
  });

  test('a proposal can only be approved once', async () => {
    const c = await ctx();
    const p = call('move_money', {
      budget: 'harbor', from: 'util', to: 'daily', amountCents: 1000, why: 'x',
    }, c) as Proposal;
    await commit(p.id, c);
    await assert.rejects(commit(p.id, c), /expired or was already approved/);
  });

  test('the committed event carries who approved it', async () => {
    const c = await ctx();
    const p = call('move_money', {
      budget: 'harbor', from: 'util', to: 'daily', amountCents: 1000, why: 'groceries ran long',
    }, { ...c, who: 'claude' }) as Proposal;
    const done = await commit(p.id, { ...c, who: 'bob' });
    assert.equal(done.committed[0]!.who, 'bob', 'the approver owns the event, not the proposer');
    assert.equal((done.committed[0] as { why?: string }).why, 'groceries ran long');
  });

  test('a move with no reason is refused at the tool boundary', async () => {
    const c = await ctx();
    assert.throws(() => call('move_money', {
      budget: 'harbor', from: 'util', to: 'daily', amountCents: 1000,
    }, c), /why is required/);
  });

  test('set_assignment warns when it would stop the month balancing', async () => {
    const c = await ctx();
    const p = call('set_assignment', {
      budget: 'harbor', envelope: 'daily', toCents: 500000, why: 'testing',
    }, c) as Proposal;
    assert.ok(p.effects.some((e) => /stop balancing|more than the income/.test(e)));
    assert.ok(p.effects.some((e) => /Planned stays \$1,525/.test(e)));
  });

  test('categorizing proposes a rule and says how much it would cover', async () => {
    const c = await ctx();
    const p = call('categorize_transactions', {
      assignments: [{ txnId: 'x4', category: 'groceries', alsoAddRuleMatching: 'QUIKSTOP' }],
    }, c) as Proposal;
    assert.equal(p.events.length, 2, 'the categorization and the rule');
    assert.ok(p.effects.some((e) => /would cover 1 transaction\b/.test(e)));

    await commit(p.id, c);
    assert.equal(c.store.state.txns.get('x4')!.category, 'groceries');
    assert.equal(c.store.state.rules.at(-1)!.match, 'QUIKSTOP');
  });

  test('an unknown category is refused — the taxonomy is fixed', async () => {
    const c = await ctx();
    assert.throws(
      () => call('categorize_transactions', { assignments: [{ txnId: 'x4', category: 'invented' }] }, c),
      /categories are fixed/,
    );
  });

  // x4 already divided groceries -6.15 / dining -4.00, as a first save would leave it.
  const splitX4 = (c: ToolContext) => c.store.append('alice', { op: 'txn.split', txn: 'x4', parts: [
    { category: 'groceries', amount: parseDollars('-6.15') }, { category: 'dining', amount: parseDollars('-4.00') }] });
  const split = (parts: unknown, extra: Record<string, unknown> = {}) =>
    ({ assignments: [{ txnId: 'x4', category: SPLIT, parts, ...extra }] });

  test('a split entry proposes txn.split and says each part', async () => {
    const c = await ctx();
    const p = call('categorize_transactions', split([
      { category: 'groceries', amount: -615 }, { category: 'dining', amount: -400 }]), c) as Proposal;
    assert.equal(p.events.length, 1);
    assert.equal(p.events[0]!.op, 'txn.split');
    assert.ok(p.effects.some((e) => /2026-08-09 QUIKSTOP 10001 .*is split: Groceries \$6\.15, Dining out \$4\.00/.test(e)), p.effects.join('|'));
    await commit(p.id, c);
    const t = c.store.state.txns.get('x4')!;
    assert.equal(t.category, SPLIT);
    assert.deepEqual(t.split, [{ category: 'groceries', amount: -615 }, { category: 'dining', amount: -400 }]);
  });

  test('a receipt already split can be divided again: one replacement event, said as such', async () => {
    const c = await ctx();
    await splitX4(c);
    const p = call('categorize_transactions', split([
      { category: 'groceries', amount: -515 }, { category: 'dining', amount: -300 }, { category: 'electricity', amount: -200 }]), c) as Proposal;
    assert.equal(p.events.length, 1);
    assert.equal(p.events[0]!.op, 'txn.split');
    assert.equal((p.events[0] as { parts: readonly unknown[] }).parts.length, 3);
    assert.ok(p.effects.some((e) => /2026-08-09 QUIKSTOP 10001 .*is divided again: Groceries \$5\.15, Dining out \$3\.00, Electricity \$2\.00/.test(e)), p.effects.join('|'));
    await commit(p.id, c);
    assert.equal(c.store.state.txns.get('x4')!.split!.length, 3);
  });

  test('sorting a split receipt whole clears the parts and says so', async () => {
    const c = await ctx();
    await splitX4(c);
    const p = call('categorize_transactions', { assignments: [{ txnId: 'x4', category: 'groceries' }] }, c) as Proposal;
    assert.equal(p.events.length, 1);
    assert.equal(p.events[0]!.op, 'txn.categorize');
    assert.ok(p.effects.some((e) => /is no longer split; becomes groceries/.test(e)), p.effects.join('|'));
    await commit(p.id, c);
    const t = c.store.state.txns.get('x4')!;
    assert.equal(t.category, 'groceries');
    assert.equal(t.split, undefined);
  });

  test('a re-split whose parts no longer add up is refused and proposes nothing', async () => {
    const c = await ctx();
    await splitX4(c);
    assert.throws(() => call('categorize_transactions', split([
      { category: 'groceries', amount: -515 }, { category: 'dining', amount: -300 }]), c),
      /the parts of a split must add up to the receipt/);
    assert.equal(c.store.state.txns.get('x4')!.split!.length, 2, 'the existing split stands');
  });

  test('a split that does not add up, has one part, or names a missing category is refused', async () => {
    const c = await ctx();
    assert.throws(() => call('categorize_transactions', split([
      { category: 'groceries', amount: -615 }, { category: 'dining', amount: -300 }]), c), /add up/);
    assert.throws(() => call('categorize_transactions', split([
      { category: 'groceries', amount: -1015 }]), c), /at least two/);
    assert.throws(() => call('categorize_transactions', split([
      { category: 'groceries', amount: -615 }, { category: 'invented', amount: -400 }]), c), /categories are fixed/);
    assert.throws(() => call('categorize_transactions', split([
      { category: 'groceries', amount: -515.5 }, { category: 'dining', amount: -499.5 }]), c), /whole number of cents/);
    assert.throws(() => call('categorize_transactions', split([
      { category: 'groceries', amount: -515 }, { category: 'groceries', amount: -500 }]), c), /appears twice/);
    assert.throws(() => call('categorize_transactions', split(undefined), c), /parts/);
    assert.equal(c.store.state.txns.get('x4')!.category, null, 'nothing was written');
  });

  test('a split can take transfer and income parts', async () => {
    const c = await ctx();
    const p = call('categorize_transactions', split([
      { category: 'groceries', amount: -615 }, { category: TRANSFER, amount: -400 }]), c) as Proposal;
    assert.ok(p.effects.some((e) => /Groceries \$6\.15, a transfer \$4\.00/.test(e)), p.effects.join('|'));
  });

  test('a split cannot be credited to Claude', async () => {
    const c = await ctx();
    assert.throws(() => call('categorize_transactions', split([
      { category: 'groceries', amount: -615 }, { category: 'dining', amount: -400 }], { suggestedBy: 'claude' }), c), /suggestedBy/);
  });

  test('a rule can target split, and says it will ask a person', async () => {
    const c = await ctx();
    const p = call('categorize_transactions', split([
      { category: 'groceries', amount: -615 }, { category: 'dining', amount: -400 }],
      { alsoAddRuleMatching: 'QUIK' }), c) as Proposal;
    assert.equal(p.events.length, 2);
    assert.equal(p.events[1]!.op, 'rule.add');
    assert.equal((p.events[1] as { category: string }).category, SPLIT);
    assert.ok(p.effects.some((e) => /Rule "QUIK" would ask a person to divide 1 receipt from now on/.test(e)), p.effects.join('|'));
    assert.equal(describeEvent({ id: 'i', at: NOW, who: 'alice', ...p.events[1]! } as never, c.store.state).what, 'added rule "QUIK" to a split');
    await commit(p.id, c);
    assert.equal(c.store.state.rules.at(-1)!.category, SPLIT);
  });

  test('a rule that targets split pluralises its count, and a blank rule is no rule', async () => {
    const c = await ctx();
    await c.store.append('system', [{ op: 'txn.add', txns: [
      { id: 'x6', date: '2026-08-11', payee: 'QUIKSTOP 20002', amount: parseDollars('-5.00'), dedupeKey: 'x6', category: null }] }]);
    const parts = [{ category: 'groceries', amount: -615 }, { category: 'dining', amount: -400 }];
    const p = call('categorize_transactions', split(parts, { alsoAddRuleMatching: 'QUIK' }), c) as Proposal;
    assert.ok(p.effects.some((e) => /ask a person to divide 2 receipts from now on/.test(e)), p.effects.join('|'));
    const r = call('categorize_transactions', split(parts, { alsoAddRuleMatching: ' ' }), c) as Proposal;
    assert.equal(r.events.length, 1);
  });

  test('a two-letter rule is refused; a rule that contradicts history warns on the card', async () => {
    const c = await ctx();
    assert.throws(() => call('categorize_transactions', {
      assignments: [{ txnId: 'x4', category: 'dining', alsoAddRuleMatching: 'AL' }] }, c), /at least 3 characters/);
    assert.throws(() => call('categorize_transactions', {
      assignments: [{ txnId: 'x4', category: 'dining', alsoAddRuleMatching: 'S' }] }, c), /at least 3 characters/);
    assert.throws(() => call('categorize_transactions', split([
      { category: 'groceries', amount: -615 }, { category: 'dining', amount: -400 }],
      { alsoAddRuleMatching: 'AL' }), c), /at least 3 characters/);

    // x1 is VALLEY MARKET, filed under Groceries; the tool warns but still proposes.
    const p = call('categorize_transactions', {
      assignments: [{ txnId: 'x4', category: 'dining', alsoAddRuleMatching: 'VALLEY' }] }, c) as Proposal;
    assert.equal(p.events.length, 2);
    assert.ok(p.effects.some((e) => /Rule "VALLEY" also matches 1 receipt filed elsewhere \(Groceries\)/.test(e)), p.effects.join('|'));
    assert.ok(p.effects.some((e) => /Rule "VALLEY" would cover 1 transaction\b/.test(e)), 'the existing coverage line stays');
  });

  test('re-using a rule\'s match still warns about history, and says what it replaces', async () => {
    const c = await ctx();
    await c.store.append('system', { op: 'rule.add', rule: 'r-valley', match: 'VALLEY', category: 'groceries' });
    const p = call('categorize_transactions', {
      assignments: [{ txnId: 'x4', category: 'dining', alsoAddRuleMatching: 'valley' }] }, c) as Proposal;
    assert.ok(p.effects.some((e) => /Replaces the rule "VALLEY" → Groceries/.test(e)), p.effects.join('|'));
    assert.ok(p.effects.some((e) => /also matches 1 receipt filed elsewhere \(Groceries\)/.test(e)), p.effects.join('|'));
  });

  test('a rule that is not in this receipt is still proposed', async () => {
    const c = await ctx();
    const p = call('categorize_transactions', {
      assignments: [{ txnId: 'x4', category: 'dining', alsoAddRuleMatching: 'RESTAURANT' }] }, c) as Proposal;
    assert.equal(p.events.length, 2, 'a person may type a broader rule');
  });

  test('open_month previews the plan before writing it', async () => {
    const c = await ctx();
    const p = call('open_month', {
      budget: 'ridge', month: '2026-09', incomeCents: 960000,
    }, c) as Proposal;
    assert.ok(p.effects.some((e) => /2 envelopes seeded/.test(e)));
    assert.ok(p.effects.some((e) => /Planned \$2,525/.test(e)));
    assert.ok(p.effects.some((e) => /To assign would be \$7,075/.test(e)));

    await commit(p.id, c);
    const v = monthView(c.store.state, 'ridge', '2026-09')!;
    assert.equal(v.planned, parseDollars('2525.00'));
  });

  test('opening a month twice is refused rather than silently re-planning', async () => {
    const c = await ctx();
    assert.throws(() => call('open_month', {
      budget: 'harbor', month: '2026-08', incomeCents: 100,
    }, c), /already open/);
  });

  test('a bad envelope is a 404, not a zero', async () => {
    const c = await ctx();
    try {
      call('explain_envelope', { budget: 'harbor', envelope: 'nope' }, c);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ToolError);
      assert.equal(err.status, 404);
    }
  });
});

describe('plan tools', () => {
  /** The same household, claimed by alice with bob in it: a shelf p1 holding p2, and a plan p3. */
  async function planCtx(): Promise<ToolContext> {
    const c = await ctx();
    await c.store.append('alice', [
      { op: 'household.claim', label: 'Home' },
      { op: 'member.add', member: 'bob', why: 'my partner' },
      { op: 'plan.create', plan: 'p1', title: 'Kitchen', area: 'House' },
      { op: 'plan.create', plan: 'p2', title: 'Hinge', area: 'House', parent: 'p1' },
      { op: 'plan.create', plan: 'p3', title: 'Water heater', area: 'House' },
    ]);
    return c;
  }

  /** A context whose proposal store counts what it was handed. */
  const counting = (c: ToolContext) => {
    let puts = 0;
    const proposals = new ProposalStore();
    const put = proposals.put.bind(proposals);
    proposals.put = (...a) => { puts += 1; return put(...a); };
    return { c: { ...c, proposals }, puts: () => puts };
  };

  test('every plan tool is there, in the shape later tasks rely on', () => {
    const writes: Record<string, string[]> = {
      create_plan: ['title', 'area'], update_plan: ['plan'], set_plan_state: ['plan', 'state'],
      hand_plan: ['plan', 'to'], set_plan_goal: ['plan', 'goal'], answer_ask: ['plan', 'answer'], set_checklist: ['plan', 'items'],
      set_plan_due: ['plan', 'due'], block_plan_time: ['plan', 'start', 'end'], remove_plan: ['plan', 'why'],
      link_contact: ['plan', 'contact_id', 'addressbook_id', 'display'],
    };
    for (const [name, required] of Object.entries(writes)) {
      const t = toolByName.get(name);
      assert.ok(t, `${name} is missing`);
      assert.equal(t.kind, 'write', name);
      assert.deepEqual(t.input['required'], required, name);
    }
    const props = (name: string) => Object.keys(toolByName.get(name)!.input['properties'] as object);
    assert.deepEqual(props('create_plan'), ['title', 'area']);
    assert.deepEqual(props('update_plan'), ['plan', 'title', 'area', 'chips', 'notes', 'estimateCents', 'envelope']);
    assert.deepEqual(props('answer_ask'), ['plan', 'answer', 'why']);
    assert.equal(toolByName.get('list_plans')?.kind, 'read');
    assert.deepEqual(props('list_plans'), ['who', 'goal']);
    assert.equal(toolByName.get('get_plan')?.kind, 'read');
    assert.deepEqual(toolByName.get('get_plan')!.input['required'], ['plan']);
  });

  test('create_contact is a write with an effect, and its proposal needs a name and a NAS session', async () => {
    const t = toolByName.get('create_contact');
    assert.ok(t, 'create_contact is missing');
    assert.equal(t.kind, 'write');
    assert.deepEqual(t.input['required'], ['full_name']);
    assert.deepEqual(Object.keys(t.input['properties'] as object), ['full_name', 'phones', 'emails', 'org', 'plan']);
    assert.equal(typeof t.effect, 'function');
    const base = await planCtx();
    const { c, puts } = counting({ ...base, sid: 'S' });
    await assert.rejects(async () => t.run({ plan: 'p3' }, c), (e: unknown) => e instanceof ToolError && e.status === 400);
    assert.equal(puts(), 0);
    const p = await t.run({ full_name: 'Sandoval Plumbing', plan: 'p3' }, c) as Proposal;
    assert.equal(puts(), 1);
    assert.equal(p.summary, 'Add Sandoval Plumbing to Contacts');
    assert.deepEqual(p.events, []);
  });

  test('create_plan proposes a plan and writes nothing; whoever approves it owns it', async () => {
    const c = await planCtx();
    const before = c.store.state.eventCount;
    const p = call('create_plan', { title: 'Gutters', area: 'House' }, c) as Proposal;
    assert.equal(c.store.state.eventCount, before);
    const [e] = p.events as { op: string; plan: string; title: string; area: string }[];
    assert.equal(e!.op, 'plan.create');
    assert.ok(e!.plan && !c.store.state.plans.has(e!.plan), 'a fresh id');
    assert.deepEqual(p.events, [{ op: 'plan.create', plan: e!.plan, title: 'Gutters', area: 'House' }]);
    assert.throws(() => call('create_plan', { title: 'X', area: 'Garage' }, c), /not one of this household's areas/);
    await commit(p.id, { ...c, who: 'bob' });
    assert.equal(c.store.state.plans.get(e!.plan)!.owner, 'bob');
  });

  test('hand_plan names both ends in its summary; set_plan_goal takes an existing spelling; shelves and asks are closed', async () => {
    const c = await planCtx();
    const run = (name: string, args: Record<string, unknown>) => runTool(toolByName.get(name)!, args, c) as Promise<Proposal>;
    const hand = await run('hand_plan', { plan: 'p3', to: 'bob', why: 'you know a plumber' });
    assert.deepEqual([hand.summary, hand.events], ['Hand Water heater from alice to bob', [{ op: 'plan.hand', plan: 'p3', to: 'bob', why: 'you know a plumber' }]]);
    await assert.rejects(run('hand_plan', { plan: 'p3', to: 'alice' }), /Water heater is already alice's/);
    await c.store.append('alice', { op: 'plan.goal', plan: 'p1', goal: 'New kitchen' });
    const goal = await run('set_plan_goal', { plan: 'p3', goal: ' new  kitchen ' });
    assert.deepEqual([goal.summary, goal.events], ['Set Water heater toward New kitchen', [{ op: 'plan.goal', plan: 'p3', goal: 'New kitchen' }]]);
    assert.equal((await run('set_plan_goal', { plan: 'p1', goal: null })).summary, 'Take Kitchen off New kitchen');
    await assert.rejects(run('create_plan', { title: 'Hinge', area: 'House', parent: 'p1' }), /Plans no longer sit on shelves\. Give it a goal instead\./);
    assert.ok(!toolByName.has('ask_to_take') && toolByName.has('answer_ask'));
    assert.ok(RESEARCH_WRITES.has('hand_plan') && RESEARCH_WRITES.has('set_plan_goal'));
    await run('set_plan_state', { plan: 'p1', state: 'doing' });            // a former shelf has a state like any plan
  });

  test('a member who does not own the plan approves a hand_plan card and the plan changes hands', async () => {
    const c = await planCtx();
    const p = await runTool(toolByName.get('hand_plan')!, { plan: 'p3', to: 'bob' }, { ...c, who: 'bob' }) as Proposal;
    await commit(p.id, { ...c, who: 'bob' });     // alice owns p3; bob approves handing it to himself
    assert.equal(c.store.state.plans.get('p3')!.owner, 'bob');
  });

  test('hand_plan and set_plan_goal refuse before any proposal exists, and a blank reason is no reason', async () => {
    const { c, puts } = counting(await planCtx());
    const run = (name: string, args: Record<string, unknown>) => runTool(toolByName.get(name)!, args, c);
    await assert.rejects(run('hand_plan', { plan: 'p3', to: 'carol' }), /carol is not in this household/);
    await assert.rejects(run('hand_plan', { plan: 'p3', to: 'bob', why: 'x'.repeat(301) }), /300/);
    await assert.rejects(run('set_plan_goal', { plan: 'p3', goal: null }), /Water heater has no goal/);
    assert.equal(puts(), 0);
    const blank = await run('hand_plan', { plan: 'p3', to: 'bob', why: '   ' }) as Proposal;
    assert.deepEqual(blank.events, [{ op: 'plan.hand', plan: 'p3', to: 'bob' }]);
    await c.store.append('alice', { op: 'plan.goal', plan: 'p3', goal: 'Warm house' });
    await assert.rejects(run('set_plan_goal', { plan: 'p3', goal: 'warm HOUSE' }), /Water heater is already toward Warm house/);
    assert.equal(puts(), 1);
  });

  test('each plan tool proposes exactly the ops the fold knows, and touches no money', async () => {
    const c = await planCtx();
    await c.store.append('alice', { op: 'plan.ask', plan: 'p3', to: 'bob', why: 'you know boilers' });
    const events = (name: string, args: Record<string, unknown>) => (call(name, args, c) as Proposal).events;
    const cases: [string, Record<string, unknown>, unknown[]][] = [
      ['update_plan', { plan: 'p3', title: 'Tankless heater', chips: ['researching'], notes: 'quotes', estimateCents: 180000,
        envelope: { budget: 'harbor', envelope: 'util' } },
       [{ op: 'plan.set', plan: 'p3', title: 'Tankless heater', chips: ['researching'], notes: 'quotes', estimate: 180000,
          envelope: { budget: 'harbor', envelope: 'util' } }]],
      ['update_plan', { plan: 'p3', estimateCents: null, envelope: null },
       [{ op: 'plan.set', plan: 'p3', estimate: null, envelope: null }]],
      ['set_plan_state', { plan: 'p3', state: 'doing' }, [{ op: 'plan.state', plan: 'p3', state: 'doing' }]],
      ['answer_ask', { plan: 'p3', answer: 'accept' }, [{ op: 'plan.ask.accept', plan: 'p3' }]],
      ['answer_ask', { plan: 'p3', answer: 'decline', why: 'no time' }, [{ op: 'plan.ask.decline', plan: 'p3', why: 'no time' }]],
      ['set_plan_due', { plan: 'p3', due: '2026-09-01' }, [{ op: 'plan.due', plan: 'p3', due: '2026-09-01' }]],
      ['set_plan_due', { plan: 'p3', due: null }, [{ op: 'plan.due', plan: 'p3', due: null }]],
      ['remove_plan', { plan: 'p3', why: 'bought a house with one' }, [{ op: 'plan.remove', plan: 'p3', why: 'bought a house with one' }]],
      ['link_contact', { plan: 'p3', contact_id: 7, addressbook_id: 2, display: 'Ace Plumbing' },
       [{ op: 'plan.contact.link', plan: 'p3', contact_id: 7, addressbook_id: 2, display: 'Ace Plumbing' }]],
    ];
    for (const [name, args, expected] of cases) {
      const got = events(name, args);
      assert.deepEqual(got, expected, name);
      assert.deepEqual(touches(got), { budget: null, month: null, envelopes: [] }, `${name} touches no money`);
    }

    const checklist = events('set_checklist', { plan: 'p3', items: [{ text: 'Measure the closet', done: true }, { id: 'keep', text: 'Two quotes' }] });
    const items = (checklist[0] as unknown as { items: { id: string; text: string; done: boolean }[] }).items;
    assert.equal(checklist[0]!.op, 'plan.checklist');
    assert.deepEqual(items.map((i) => [i.text, i.done]), [['Measure the closet', true], ['Two quotes', false]]);
    assert.equal(items[1]!.id, 'keep', 'an item keeps its id');
    assert.ok(items[0]!.id && items[0]!.id !== 'keep', 'a new item gets one');

    const block = events('block_plan_time', { plan: 'p3', start: '2026-08-20T09:00:00Z', end: '2026-08-20T12:00:00Z' });
    assert.deepEqual(block, [{ op: 'plan.block', plan: 'p3', block: (block[0] as { block: string }).block,
      start: '2026-08-20T09:00:00Z', end: '2026-08-20T12:00:00Z' }]);
    assert.ok((block[0] as { block: string }).block);
    assert.equal(c.store.state.plans.get('p3')!.title, 'Water heater', 'nothing was written');
  });

  test('plan tools refuse what the fold would refuse, before anything is offered', async () => {
    const c = await planCtx();
    assert.throws(() => call('set_plan_state', { plan: 'p3', state: 'started' }, c), /state/);
    assert.throws(() => call('remove_plan', { plan: 'p3' }, c), /why is required/);
    assert.throws(() => call('answer_ask', { plan: 'p3', answer: 'accept' }, c), /nobody has been asked/);
    assert.throws(() => call('set_plan_due', { plan: 'p3', due: 'next week' }, c), /YYYY-MM-DD/);
    assert.throws(() => call('block_plan_time', { plan: 'p3', start: '2026-08-20T12:00:00Z', end: '2026-08-20T09:00:00Z' }, c), /end after it starts/);
    assert.throws(() => call('update_plan', { plan: 'p3', envelope: { budget: 'harbor', envelope: 'nope' } }, c), /no envelope/);
    assert.throws(() => call('update_plan', { plan: 'p3' }, c), /nothing to change/);
    await assert.rejects(async () => call('get_plan', { plan: 'nope' }, c), (e: unknown) => e instanceof ToolError && e.status === 404);
    await c.store.append('alice', { op: 'plan.ask', plan: 'p3', to: 'bob', why: 'please' });
    assert.throws(() => call('answer_ask', { plan: 'p3', answer: 'decline' }, c), /why is required/);
  });

  test('a tool and a member\'s own edit read the same request the same way', async () => {
    const c = await planCtx();
    // Blank chips are dropped by both, not refused by one and kept by the other.
    const chips = (call('update_plan', { plan: 'p3', chips: [' quote ', '', '  '] }, c) as Proposal).events[0] as { chips?: string[] };
    assert.deepEqual(chips.chips, ['quote']);
    assert.deepEqual((await edits.updatePlan(c, 'p3', { chips: [' quote ', '', '  '] })).chips, ['quote']);
    // Any parent, even an empty one, is a shelf, and refused by both in the same words.
    const noShelf = (e: unknown) => e instanceof ToolError && e.status === 400 && e.message === RETIRED.shelf;
    assert.throws(() => call('create_plan', { title: 'Gate', area: 'House', parent: '' }, c), noShelf);
    await assert.rejects(edits.createPlan(c, { title: 'Gate', area: 'House', parent: '' }), noShelf);
    // An envelope that is not there is a 404 from both.
    const missing = (e: unknown) => e instanceof ToolError && e.status === 404 && /no budget nope/.test(e.message);
    assert.throws(() => call('update_plan', { plan: 'p3', envelope: { budget: 'nope', envelope: 'x' } }, c), missing);
    await assert.rejects(edits.updatePlan(c, 'p3', { envelope: { budget: 'nope', envelope: 'x' } }), missing);
    // An estimate sent as text is refused by both, never read as a number.
    const notCents = (e: unknown) => e instanceof ToolError && e.status === 400 && /whole number/.test(e.message);
    assert.throws(() => call('update_plan', { plan: 'p3', estimateCents: '180000' }, c), notCents);
    await assert.rejects(edits.updatePlan(c, 'p3', { estimate: '180000' as never }), notCents);
    // An item listed twice is refused by both.
    const twice = [{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }];
    assert.throws(() => call('set_checklist', { plan: 'p3', items: twice }, c), /each item appears once/);
    await assert.rejects(edits.setChecklist(c, 'p3', twice), /each item appears once/);
  });

  test('list_plans reads the board and get_plan the card', async () => {
    const c = await planCtx();
    type Seen = { who: string; goal: string | null; rows: { area: string; plans: { id: string; daysInState: number | null }[] }[] };
    const all = await call('list_plans', {}, c) as Seen;
    const house = all.rows.find((r) => r.area === 'House')!;
    // The only clock is Doing's, and Claude is told so: nothing in Planning has an age to bring up.
    assert.deepEqual(house.plans.map((p) => p.daysInState), [null, null, null]);
    assert.match(toolByName.get('list_plans')!.description, /for a plan in Doing only/);
    assert.match(toolByName.get('list_plans')!.description, /daysInState is null/);
    assert.deepEqual(house.plans.map((p) => p.id), ['p1', 'p2', 'p3']);
    assert.equal(all.who, 'everyone');
    await c.store.append('alice', [{ op: 'member.add', member: 'casey', why: 'moved in' }, { op: 'plan.hand', plan: 'p3', to: 'bob' }]);
    const bob = await call('list_plans', { who: 'bob' }, c) as Seen;
    assert.equal(bob.who, 'bob');
    assert.deepEqual(bob.rows.flatMap((r) => r.plans.map((p) => p.id)), ['p3']);
    const casey = await call('list_plans', { who: 'casey' }, c) as Seen;
    assert.deepEqual(casey.rows.flatMap((r) => r.plans), [], 'strict: a member with nothing gets nothing');
    const card = await call('get_plan', { plan: 'p1' }, c) as { title: string; shelf: null; children: unknown[]; goals: unknown[] };
    assert.deepEqual([card.title, card.shelf, card.children, card.goals], ['Kitchen', null, [], []]);
    for (const name of ['list_plans', 'get_plan']) assert.doesNotMatch(toolByName.get(name)!.description, /shelf|shelves|asked to take/i, name);
  });
});

describe('an effect the NAS refuses', () => {
  const failing = (err: Error) => ({ ...toolByName.get('set_plan_due')!, effect: async () => { throw err; } });
  const ctx = {} as ToolContext;

  test('keeps the status the refusal carries: a session that ended is a 409 that says sign in again', async () => {
    await assert.rejects(runEffect(failing(new SessionLost('SYNO.Cal.Event', 119)), {}, ctx),
      (e: unknown) => e instanceof ToolError && e.status === 409 && /sign in again/.test(e.message));
    await assert.rejects(runEffect(failing(new NotAllowed('SYNO.Cal.Event', 105)), {}, ctx),
      (e: unknown) => e instanceof ToolError && e.status === 403);
    await assert.rejects(runEffect(failing(new SynologyError('the NAS refused it', 'SYNO.Cal.Event', 9017)), {}, ctx),
      (e: unknown) => e instanceof ToolError && e.status === 502);
  });
});
