import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { parseDollars, fmt } from '../src/money.ts';
import { toolByName, commit, ProposalStore, ToolError } from '../src/tools.ts';
import { monthView } from '../src/envelopes.ts';
import { ReplayError } from '../src/replay.ts';

const TODAY = '2026-08-13';
const run = async (name: string, args: Record<string, unknown>, ctx: never) =>
  await toolByName.get(name)!.run(args, ctx) as { id: string; summary: string; effects: string[] };

async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-bud-')), 'events.jsonl');
  const store = new Store({ path });
  await store.load();
  await store.append('system', [
    { op: 'category.define', category: 'food', label: 'Groceries' },
    { op: 'category.define', category: 'dine', label: 'Dining out' },
    { op: 'category.define', category: 'elec', label: 'Electricity' },
    { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
    { op: 'envelope.define', budget: 'harbor', envelope: 'daily', label: 'Daily life', group: 'People',
      match: { categories: ['food', 'dine'] }, template: parseDollars('1000.00'), order: 0 },
    { op: 'envelope.define', budget: 'harbor', envelope: 'util', label: 'Utilities', group: 'House',
      match: { categories: ['elec'] }, template: parseDollars('300.00'), order: 1 },
    { op: 'month.open', budget: 'harbor', month: '2026-08', income: parseDollars('5000.00') },
    { op: 'txn.add', txns: [
      { id: 't1', date: '2026-08-02', payee: 'SAFEWAY', amount: parseDollars('-64.10'), dedupeKey: 't1', category: 'food' },
      { id: 't2', date: '2026-08-03', payee: 'EXAMPLE POWER', amount: parseDollars('-120.00'), dedupeKey: 't2', category: 'elec' },
    ] },
  ]);
  const ctx = { store, who: 'alice', today: TODAY, proposals: new ProposalStore(), sid: null } as never;
  return { store, ctx };
}

describe('more than one budget over one ledger', () => {
  test('a new budget can start from an existing one and then be priced differently', async () => {
    const { store, ctx } = await fixture();
    const p = await run('create_budget', { label: 'Ridge', copyFrom: 'harbor' }, ctx);
    await commit(p.id, ctx);

    const ridgeView = store.state.budgets.get('ridge')!;
    assert.equal(ridgeView.label, 'Ridge');
    assert.equal(ridgeView.envelopes.size, 2, 'the shape came across');

    // Price the new one for where it is. The categories are the same facts.
    const edit = await run('define_envelope', {
      budget: 'ridge', envelope: 'util', label: 'Utilities', group: 'House',
      categories: ['elec'], templateCents: parseDollars('615.00'),
    }, ctx);
    await commit(edit.id, ctx);

    assert.equal(fmt(store.state.budgets.get('ridge')!.envelopes.get('util')!.template), '$615');
    assert.equal(fmt(store.state.budgets.get('harbor')!.envelopes.get('util')!.template), '$300',
      'and Harbor is untouched');
  });

  test('the same receipt lands in both budgets without being categorised twice', async () => {
    const { store, ctx } = await fixture();
    const p = await run('create_budget', { label: 'Ridge', copyFrom: 'harbor' }, ctx);
    await commit(p.id, ctx);
    await store.append('alice', { op: 'month.open', budget: 'ridge', month: '2026-08', income: parseDollars('5000.00') });

    const harborView = monthView(store.state, 'harbor', '2026-08')!;
    const ridgeView = monthView(store.state, 'ridge', '2026-08')!;
    assert.equal(harborView.envelopes.find((e) => e.envelope.id === 'util')!.activity, parseDollars('120.00'));
    assert.equal(ridgeView.envelopes.find((e) => e.envelope.id === 'util')!.activity, parseDollars('120.00'));
    assert.equal(harborView.outside.total, 0);
    assert.equal(ridgeView.outside.total, 0);
  });

  test('a name that is already taken is refused', async () => {
    const { ctx } = await fixture();
    await assert.rejects(() => run('create_budget', { label: 'Harbor' }, ctx), ToolError);
  });

  test('renaming keeps the id, so nothing in the log stops resolving', async () => {
    const { store, ctx } = await fixture();
    const p = await run('rename_budget', { budget: 'harbor', label: 'Lakeside' }, ctx);
    await commit(p.id, ctx);
    assert.equal(store.state.budgets.get('harbor')!.label, 'Lakeside');
    assert.ok(monthView(store.state, 'harbor', '2026-08'), 'its months still resolve');
  });
});

describe('archiving rather than deleting', () => {
  test('an archived budget keeps every answer it could give', async () => {
    const { store, ctx } = await fixture();
    const created = await run('create_budget', { label: 'Ridge' }, ctx);
    await commit(created.id, ctx);

    const p = await run('archive_budget', { budget: 'harbor', archived: true, why: 'we moved' }, ctx);
    assert.match(p.effects[1]!, /history stay in the log/);
    await commit(p.id, ctx);

    assert.equal(store.state.budgets.get('harbor')!.archived, true);
    assert.ok(monthView(store.state, 'harbor', '2026-08'), 'August still reads');
  });

  test('it survives a replay from disk, archived and intact', async () => {
    const { store, ctx } = await fixture();
    await commit((await run('create_budget', { label: 'Ridge' }, ctx)).id, ctx);
    await commit((await run('archive_budget', { budget: 'harbor', archived: true, why: 'we moved' }, ctx)).id, ctx);

    const reopened = new Store({ path: store.path });
    await reopened.load();
    assert.equal(reopened.loadReport.skipped.length, 0);
    assert.equal(reopened.state.budgets.get('harbor')!.archived, true);
    assert.equal(reopened.state.budgets.get('harbor')!.envelopes.size, 2);
  });

  test('it can be brought back', async () => {
    const { store, ctx } = await fixture();
    await commit((await run('create_budget', { label: 'Ridge' }, ctx)).id, ctx);
    await commit((await run('archive_budget', { budget: 'harbor', archived: true, why: 'we moved' }, ctx)).id, ctx);
    await commit((await run('archive_budget', { budget: 'harbor', archived: false, why: 'not yet' }, ctx)).id, ctx);
    // Absent, not false: a budget is archived or it simply is not.
    assert.ok(!store.state.budgets.get('harbor')!.archived);
  });

  test('the last budget cannot be archived — there would be nothing to look at', async () => {
    const { ctx } = await fixture();
    await assert.rejects(
      () => run('archive_budget', { budget: 'harbor', archived: true, why: 'why not' }, ctx), ToolError);
  });

  test('archiving needs a reason, like every other decision that hides something', async () => {
    const { store } = await fixture();
    await assert.rejects(
      () => store.append('alice', { op: 'budget.archive', budget: 'harbor', archived: true } as never),
      ReplayError);
  });
});

describe('an envelope with no figure yet', () => {
  const SOURCE = 'Zillow Observed Rent Index, ZIP 12345, 2026-06';
  const pets = (extra: Record<string, unknown> = {}) => ({
    op: 'envelope.define', budget: 'harbor', envelope: 'pets', label: 'Pets', group: 'People',
    match: { categories: ['pets'] }, template: parseDollars('80.00'), order: 2, ...extra,
  }) as never;
  const withPets = async (extra: Record<string, unknown> = {}) => {
    const f = await fixture();
    await f.store.append('system', { op: 'category.define', category: 'pets', label: 'Pets' });
    await f.store.append('system', pets(extra));
    return f;
  };

  test('the flag and the source are kept from the define that carries them', async () => {
    const { store } = await withPets({ needsFigure: true, source: SOURCE });
    const env = store.state.budgets.get('harbor')!.envelopes.get('pets')!;
    assert.equal(env.needsFigure, true);
    assert.equal(env.source, SOURCE);
  });

  test('a later define without them clears both', async () => {
    const { store } = await withPets({ needsFigure: true, source: SOURCE });
    await store.append('system', pets());
    const env = store.state.budgets.get('harbor')!.envelopes.get('pets')!;
    assert.ok(!('needsFigure' in env));
    assert.ok(!('source' in env));
  });

  test('a flag that is not true, or a source that is empty or too long, is refused', async () => {
    const { store } = await fixture();
    await store.append('system', { op: 'category.define', category: 'pets', label: 'Pets' });
    await assert.rejects(() => store.append('system', pets({ needsFigure: false })), (e: unknown) =>
      e instanceof ReplayError && /needsFigure/.test(e.message));
    await assert.rejects(() => store.append('system', pets({ source: '' })), (e: unknown) =>
      e instanceof ReplayError && /source/.test(e.message));
    await assert.rejects(() => store.append('system', pets({ source: 'x'.repeat(201) })), (e: unknown) =>
      e instanceof ReplayError && /source/.test(e.message));
  });

  test('copying a budget and saving it in Savings carry the flag and the source', async () => {
    const { store, ctx } = await withPets({ needsFigure: true, source: SOURCE });
    await commit((await run('create_budget', { label: 'Ridge', copyFrom: 'harbor' }, ctx)).id, ctx);
    const copy = store.state.budgets.get('ridge')!.envelopes.get('pets')!;
    assert.equal(copy.needsFigure, true);
    assert.equal(copy.source, SOURCE);

    await commit((await run('set_sinking_goal', { budget: 'ridge', envelope: 'pets', goal: 'every' }, ctx)).id, ctx);
    const saved = store.state.budgets.get('ridge')!.envelopes.get('pets')!;
    assert.deepEqual(saved.sinking, { kind: 'every' });
    assert.equal(saved.needsFigure, true);
    assert.equal(saved.source, SOURCE);
  });
});

describe('changing the shape of an envelope', () => {
  test('two envelopes cannot both claim a category', async () => {
    // A receipt would land in whichever was defined last, silently, and the
    // reconciliation would be right about a number nobody could predict.
    const { ctx } = await fixture();
    await assert.rejects(() => run('define_envelope', {
      budget: 'harbor', envelope: 'newone', label: 'Another', group: 'People',
      categories: ['food'], templateCents: 10000,
    }, ctx), ToolError);
  });

  test('a category that does not exist is refused — categories are shared facts', async () => {
    const { ctx } = await fixture();
    await assert.rejects(() => run('define_envelope', {
      budget: 'harbor', envelope: 'x', label: 'X', group: 'People',
      categories: ['invented'], templateCents: 1000,
    }, ctx), ToolError);
  });

  test('editing the template does not reach into a month already open', async () => {
    const { store, ctx } = await fixture();
    const before = monthView(store.state, 'harbor', '2026-08')!
      .envelopes.find((e) => e.envelope.id === 'util')!;
    assert.equal(fmt(before.planned), '$300');

    const p = await run('define_envelope', {
      budget: 'harbor', envelope: 'util', label: 'Utilities', group: 'House',
      categories: ['elec'], templateCents: parseDollars('615.00'),
    }, ctx);
    assert.match(p.effects[2]!, /keep the plan they opened with/);
    await commit(p.id, ctx);

    const after = monthView(store.state, 'harbor', '2026-08')!
      .envelopes.find((e) => e.envelope.id === 'util')!;
    assert.equal(fmt(after.planned), '$300', 'the plan of record is still the plan of record');
    assert.equal(fmt(after.funded), '$300');
  });

  test('removing an envelope says how much stops being accounted for', async () => {
    const { store, ctx } = await fixture();
    const p = await run('remove_envelope',
      { budget: 'harbor', envelope: 'util', why: 'folding it into the house costs' }, ctx);
    assert.match(p.effects[1]!, /1 receipts totalling \$120/);

    await commit(p.id, ctx);
    const view = monthView(store.state, 'harbor', '2026-08')!;
    assert.equal(view.envelopes.some((e) => e.envelope.id === 'util'), false);
    // The receipt is still a receipt. It just is not in any envelope now, which
    // is exactly what the proposal warned about.
    assert.equal(store.state.txns.get('t2')!.category, 'elec');
    assert.equal(view.outside.total, parseDollars('120.00'));
  });

  test('removing from one budget leaves the other alone', async () => {
    const { store, ctx } = await fixture();
    await commit((await run('create_budget', { label: 'Ridge', copyFrom: 'harbor' }, ctx)).id, ctx);
    await store.append('alice', { op: 'month.open', budget: 'ridge', month: '2026-08', income: parseDollars('5000.00') });
    await commit((await run('remove_envelope',
      { budget: 'harbor', envelope: 'util', why: 'not how we think about it here' }, ctx)).id, ctx);

    assert.equal(monthView(store.state, 'harbor', '2026-08')!.outside.total, parseDollars('120.00'));
    assert.equal(monthView(store.state, 'ridge', '2026-08')!.outside.total, 0,
      'the other reading of the same ledger is untouched');
  });

  test('an envelope with no categories is refused', async () => {
    const { ctx } = await fixture();
    await assert.rejects(() => run('define_envelope', {
      budget: 'harbor', envelope: 'empty', label: 'Empty', group: 'People',
      categories: [], templateCents: 1000,
    }, ctx), ToolError);
  });
});
