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
    { op: 'envelope.define', envelope: 'daily', label: 'Daily life', group: 'People',
      match: { categories: ['food', 'dine'] }, template: parseDollars('1000.00'), order: 0 },
    { op: 'envelope.define', envelope: 'util', label: 'Utilities', group: 'House',
      match: { categories: ['elec'] }, template: parseDollars('300.00'), order: 1 },
    { op: 'month.open', month: '2026-08', income: parseDollars('5000.00') },
    { op: 'txn.add', txns: [
      { id: 't1', date: '2026-08-02', payee: 'SAFEWAY', amount: parseDollars('-64.10'), dedupeKey: 't1', category: 'food' },
      { id: 't2', date: '2026-08-03', payee: 'EXAMPLE POWER', amount: parseDollars('-120.00'), dedupeKey: 't2', category: 'elec' },
    ] },
  ]);
  const ctx = { store, who: 'alice', today: TODAY, proposals: new ProposalStore(), sid: null } as never;
  return { store, ctx };
}

describe('an envelope with no figure yet', () => {
  const SOURCE = 'Zillow Observed Rent Index, ZIP 12345, 2026-06';
  const pets = (extra: Record<string, unknown> = {}) => ({
    op: 'envelope.define', envelope: 'pets', label: 'Pets', group: 'People',
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
    const env = store.state.envelopes.get('pets')!;
    assert.equal(env.needsFigure, true);
    assert.equal(env.source, SOURCE);
  });

  test('a later define without them clears both', async () => {
    const { store } = await withPets({ needsFigure: true, source: SOURCE });
    await store.append('system', pets());
    const env = store.state.envelopes.get('pets')!;
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

  test('saving it in Savings carries the flag and the source', async () => {
    const { store, ctx } = await withPets({ needsFigure: true, source: SOURCE });
    await commit((await run('set_sinking_goal', { envelope: 'pets', goal: 'every' }, ctx)).id, ctx);
    const saved = store.state.envelopes.get('pets')!;
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
      envelope: 'newone', label: 'Another', group: 'People',
      categories: ['food'], templateCents: 10000,
    }, ctx), ToolError);
  });

  test('a category that does not exist is refused — categories are shared facts', async () => {
    const { ctx } = await fixture();
    await assert.rejects(() => run('define_envelope', {
      envelope: 'x', label: 'X', group: 'People',
      categories: ['invented'], templateCents: 1000,
    }, ctx), ToolError);
  });

  test('editing the template does not reach into a month already open', async () => {
    const { store, ctx } = await fixture();
    const before = monthView(store.state, '2026-08')!
      .envelopes.find((e) => e.envelope.id === 'util')!;
    assert.equal(fmt(before.planned), '$300');

    const p = await run('define_envelope', {
      envelope: 'util', label: 'Utilities', group: 'House',
      categories: ['elec'], templateCents: parseDollars('615.00'),
    }, ctx);
    assert.match(p.effects[2]!, /keep the plan they opened with/);
    await commit(p.id, ctx);

    const after = monthView(store.state, '2026-08')!
      .envelopes.find((e) => e.envelope.id === 'util')!;
    assert.equal(fmt(after.planned), '$300', 'the plan of record is still the plan of record');
    assert.equal(fmt(after.funded), '$300');
  });

  test('removing an envelope says how much stops being accounted for', async () => {
    const { store, ctx } = await fixture();
    const p = await run('remove_envelope',
      { envelope: 'util', why: 'folding it into the house costs' }, ctx);
    assert.match(p.effects[1]!, /1 receipts totalling \$120/);

    await commit(p.id, ctx);
    const view = monthView(store.state, '2026-08')!;
    assert.equal(view.envelopes.some((e) => e.envelope.id === 'util'), false);
    // The receipt is still a receipt. It just is not in any envelope now, which
    // is exactly what the proposal warned about.
    assert.equal(store.state.txns.get('t2')!.category, 'elec');
    assert.equal(view.outside.total, parseDollars('120.00'));
  });

  test('an envelope with no categories is refused', async () => {
    const { ctx } = await fixture();
    await assert.rejects(() => run('define_envelope', {
      envelope: 'empty', label: 'Empty', group: 'People',
      categories: [], templateCents: 1000,
    }, ctx), ToolError);
  });
});
