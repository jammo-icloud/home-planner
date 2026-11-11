import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { parseDollars, fmt } from '../src/money.ts';
import { toolByName, commit, ProposalStore, ToolError } from '../src/tools.ts';
import { monthView } from '../src/envelopes.ts';
import { toSort } from '../src/analytics.ts';
import { ReplayError } from '../src/replay.ts';

const TODAY = '2026-08-13';
const run = async (name: string, args: Record<string, unknown>, ctx: never) =>
  await toolByName.get(name)!.run(args, ctx) as { id: string; summary: string; effects: string[] };

async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-bud-')), 'events.jsonl');
  const store = new Store({ path });
  await store.load();
  await store.append('system', [
    { op: 'category.add', category: 'people', label: 'People' },
    { op: 'category.add', category: 'house', label: 'House' },
    { op: 'envelope.define', envelope: 'daily', label: 'Daily life', category: 'people', template: parseDollars('1000.00'), order: 0 },
    { op: 'envelope.define', envelope: 'util', label: 'Utilities', category: 'house', template: parseDollars('300.00'), order: 1 },
    { op: 'month.open', month: '2026-08', income: parseDollars('5000.00') },
    { op: 'txn.add', txns: [
      { id: 't1', date: '2026-08-02', payee: 'SAFEWAY', amount: parseDollars('-64.10'), dedupeKey: 't1', envelope: 'daily' },
      { id: 't2', date: '2026-08-03', payee: 'EXAMPLE POWER', amount: parseDollars('-120.00'), dedupeKey: 't2', envelope: 'util' },
    ] },
  ]);
  const ctx = { store, who: 'alice', today: TODAY, proposals: new ProposalStore(), sid: null } as never;
  return { store, ctx };
}

describe('an envelope with no figure yet', () => {
  const SOURCE = 'Zillow Observed Rent Index, ZIP 12345, 2026-06';
  const pets = (extra: Record<string, unknown> = {}) => ({
    op: 'envelope.define', envelope: 'pets', label: 'Pets', category: 'people', template: parseDollars('80.00'), order: 2, ...extra,
  }) as never;
  const withPets = async (extra: Record<string, unknown> = {}) => {
    const f = await fixture();
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
    assert.deepEqual(saved.sinking, { kind: 'every', estimate: null });
    assert.equal(saved.needsFigure, true);
    assert.equal(saved.source, SOURCE);
  });
});

describe('changing the shape of an envelope', () => {
  test('two envelopes cannot share a name, case and spaces ignored', async () => {
    const { ctx } = await fixture();
    await assert.rejects(() => run('define_envelope', {
      envelope: 'newone', label: ' daily LIFE ', category: 'people', templateCents: 10000,
    }, ctx), (e: unknown) => e instanceof ToolError && /There is already an envelope called Daily life\./.test(e.message));
  });

  test('a category that is not here is refused', async () => {
    const { ctx } = await fixture();
    await assert.rejects(() => run('define_envelope', {
      envelope: 'x', label: 'X', category: 'invented', templateCents: 1000,
    }, ctx), (e: unknown) => e instanceof ToolError && /no category invented/.test(e.message));
  });

  test('editing the template does not reach into a month already open', async () => {
    const { store, ctx } = await fixture();
    const before = monthView(store.state, '2026-08')!
      .envelopes.find((e) => e.envelope.id === 'util')!;
    assert.equal(fmt(before.planned), '$300');

    const p = await run('define_envelope', {
      envelope: 'util', label: 'Utilities', templateCents: parseDollars('615.00'),
    }, ctx);
    assert.ok(p.effects.some((e) => /keep the plan they opened with/.test(e)));
    await commit(p.id, ctx);

    const after = monthView(store.state, '2026-08')!
      .envelopes.find((e) => e.envelope.id === 'util')!;
    assert.equal(fmt(after.planned), '$300', 'the plan of record is still the plan of record');
    assert.equal(fmt(after.funded), '$300');
    assert.equal(store.state.envelopes.get('util')!.category, 'house', 'a change that names no category keeps its own');
  });

  test('removing an envelope says how many receipts go back to To sort', async () => {
    const { store, ctx } = await fixture();
    const p = await run('remove_envelope',
      { envelope: 'util', why: 'folding it into the house costs' }, ctx);
    assert.ok(p.effects.includes('Its 1 receipt from this month goes back to To sort.'), p.effects.join('|'));

    await commit(p.id, ctx);
    const view = monthView(store.state, '2026-08')!;
    assert.equal(view.envelopes.some((e) => e.envelope.id === 'util'), false);
    // The receipt is still a receipt, naming the envelope it was in; To sort holds it now.
    assert.equal(store.state.txns.get('t2')!.envelope, 'util');
    assert.deepEqual(toSort(store.state).txnIds, ['t2']);
  });

  test('a new envelope with no category is refused', async () => {
    const { ctx } = await fixture();
    await assert.rejects(() => run('define_envelope', {
      envelope: 'empty', label: 'Empty', templateCents: 1000,
    }, ctx), (e: unknown) => e instanceof ToolError && /a new envelope needs a category/.test(e.message));
  });
});
