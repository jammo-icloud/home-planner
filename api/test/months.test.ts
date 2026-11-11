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

async function fixture(opts: { spend?: boolean } = {}) {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-mon-')), 'events.jsonl');
  const store = new Store({ path });
  await store.load();
  await store.append('system', [
    { op: 'category.add', category: 'people', label: 'People' },
    { op: 'envelope.define', envelope: 'daily', label: 'Daily life', category: 'people', template: parseDollars('1000.00'), order: 0 },
    { op: 'month.open', month: '2026-08', income: parseDollars('5000.00') },
  ]);
  if (opts.spend) {
    await store.append('system', { op: 'txn.add', txns: [
      { id: 't1', date: '2026-08-02', payee: 'SAFEWAY', amount: parseDollars('-64.10'), dedupeKey: 't1', envelope: 'daily' },
    ] });
  }
  const ctx = { store, who: 'alice', today: TODAY, proposals: new ProposalStore(), sid: null } as never;
  return { store, ctx };
}

describe('closing a month', () => {
  test('a closed month takes no more money decisions', async () => {
    const { store, ctx } = await fixture({ spend: true });
    await commit((await run('close_month',
      { month: '2026-08', closed: true, why: 'month is over' }, ctx)).id, ctx);

    await assert.rejects(() => store.append('alice', {
      op: 'assign', month: '2026-08', envelope: 'daily',
      to: parseDollars('50.00'), why: 'one more',
    }), /closed/);
    await assert.rejects(() => store.append('alice', {
      op: 'income.set', month: '2026-08', amount: parseDollars('9.00'), why: 'nope',
    }), /closed/);
  });

  test('the rule lives in the replay, so a restored log means the same thing', async () => {
    // A rule in a route handler is true of one door. This one has to be true of
    // the log itself — any script, any backup, any tool meets the same answer.
    const { store, ctx } = await fixture({ spend: true });
    await commit((await run('close_month',
      { month: '2026-08', closed: true, why: 'done' }, ctx)).id, ctx);

    const reopened = new Store({ path: store.path });
    await reopened.load();
    assert.equal(reopened.loadReport.skipped.length, 0);
    assert.equal(reopened.state.months.get('2026-08')!.closed, true);
    await assert.rejects(() => reopened.append('alice', {
      op: 'move', month: '2026-08', from: 'daily', to: 'daily',
      amount: parseDollars('1.00'), why: 'x',
    }), ReplayError);
  });

  test('closed survives an ordinary write afterwards', async () => {
    // thaw() rebuilt each month field by hand and dropped `closed`, so the next
    // event of any kind quietly reopened it.
    const { store, ctx } = await fixture({ spend: true });
    await commit((await run('close_month',
      { month: '2026-08', closed: true, why: 'done' }, ctx)).id, ctx);
    await store.append('alice', { op: 'category.add', category: 'pets', label: 'Pets' });
    assert.equal(store.state.months.get('2026-08')!.closed, true);
  });

  test('what is left still carries into next month', async () => {
    const { store, ctx } = await fixture({ spend: true });
    await commit((await run('close_month',
      { month: '2026-08', closed: true, why: 'done' }, ctx)).id, ctx);
    await store.append('alice', { op: 'month.open', month: '2026-09', income: parseDollars('5000.00') });

    const sept = monthView(store.state, '2026-09')!;
    const daily = sept.envelopes.find((e) => e.envelope.id === 'daily')!;
    assert.equal(fmt(daily.carried), '$936', 'closing a month does not undo what it left behind');
  });

  test('it can be reopened, and then changed again', async () => {
    const { store, ctx } = await fixture({ spend: true });
    await commit((await run('close_month',
      { month: '2026-08', closed: true, why: 'done' }, ctx)).id, ctx);
    await commit((await run('close_month',
      { month: '2026-08', closed: false, why: 'a receipt arrived late' }, ctx)).id, ctx);

    assert.ok(!store.state.months.get('2026-08')!.closed);
    await store.append('alice', {
      op: 'assign', month: '2026-08', envelope: 'daily',
      to: parseDollars('1100.00'), why: 'the late receipt',
    });
    assert.equal(fmt(monthView(store.state, '2026-08')!.funded), '$1,100');
  });

  test('closing twice is refused rather than silently doing nothing', async () => {
    const { ctx } = await fixture();
    await commit((await run('close_month', { month: '2026-08', closed: true, why: 'done' }, ctx)).id, ctx);
    await assert.rejects(
      () => run('close_month', { month: '2026-08', closed: true, why: 'again' }, ctx), ToolError);
  });

  test('it says what is still unsorted before you close on it', async () => {
    const { store, ctx } = await fixture({ spend: true });
    await store.append('system', { op: 'txn.add', txns: [
      { id: 't9', date: '2026-08-09', payee: 'MYSTERY', amount: parseDollars('-9.00'), dedupeKey: 't9', envelope: null },
    ] });
    const p = await run('close_month', { month: '2026-08', closed: true, why: 'done' }, ctx);
    assert.ok(p.effects.some((e) => /1 receipts in it still have no envelope/.test(e)));
  });
});

describe('discarding a month that should not have been opened', () => {
  test('an untouched month can be discarded', async () => {
    const { store, ctx } = await fixture();
    const p = await run('discard_month',
      { month: '2026-08', why: 'opened the wrong budget by mistake' }, ctx);
    await commit(p.id, ctx);
    assert.equal(store.state.months.has('2026-08'), false);
    assert.equal(monthView(store.state, '2026-08'), null);
  });

  test('receipts do not block a discard, because receipts are shared', async () => {
    // A month opened in a second budget instantly "has spending against it" —
    // the very same receipts the first budget reads. Blocking on that would make
    // a month opened in the wrong budget impossible to discard.
    const { store, ctx } = await fixture({ spend: true });
    await commit((await run('discard_month',
      { month: '2026-08', why: 'wrong budget' }, ctx)).id, ctx);
    assert.equal(store.state.months.has('2026-08'), false);
    assert.equal(store.state.txns.size, 1, 'the receipt is untouched');
  });

  test('a month that has been adjusted is not discardable', async () => {
    const { store, ctx } = await fixture();
    await store.append('alice', {
      op: 'assign', month: '2026-08', envelope: 'daily',
      to: parseDollars('1200.00'), why: 'topping up',
    });
    await assert.rejects(
      () => run('discard_month', { month: '2026-08', why: 'tidying' }, ctx),
      /close it instead/);
  });

  test('a month with later months after it is not discardable', async () => {
    // September may be carrying a balance out of August.
    const { store, ctx } = await fixture();
    await store.append('alice', { op: 'month.open', month: '2026-09', income: parseDollars('5000.00') });
    await assert.rejects(
      () => run('discard_month', { month: '2026-08', why: 'tidying' }, ctx),
      /come after it/);
  });

  test('the record that it happened stays in the log', async () => {
    const { store, ctx } = await fixture();
    await commit((await run('discard_month',
      { month: '2026-08', why: 'wrong budget' }, ctx)).id, ctx);
    const events = await store.since(null);
    assert.ok(events.some((e) => e.op === 'month.open'), 'the opening is still there');
    assert.ok(events.some((e) => e.op === 'month.discard' && (e as { why: string }).why === 'wrong budget'));
  });

  test('replaying a discard of a month that is not there is inert, not fatal', async () => {
    const { store, ctx } = await fixture();
    await commit((await run('discard_month', { month: '2026-08', why: 'x' }, ctx)).id, ctx);
    await store.append('alice', { op: 'month.discard', month: '2026-08', why: 'again' });
    const reopened = new Store({ path: store.path });
    await reopened.load();
    assert.equal(reopened.loadReport.skipped.length, 0);
  });
});

describe('opening a month at what actually comes in', () => {
  const withIncome = async (frequency: string, anchor: string, amount: string) => {
    const { store, ctx } = await fixture();
    await commit((await run('discard_month', { month: '2026-08', why: 'starting clean' }, ctx)).id, ctx);
    await store.append('alice', {
      op: 'income.source.define', source: 'i1', label: 'Salary',
      earner: 'alice', amount: parseDollars(amount), frequency, anchor,
    } as never);
    return { store, ctx };
  };

  test('the income is counted from the sources, not asked for', async () => {
    const { store, ctx } = await withIncome('semimonthly', '2026-01-15', '4800.00');
    await commit((await run('open_month', { month: '2026-08' }, ctx)).id, ctx);
    assert.equal(fmt(store.state.months.get('2026-08')!.income), '$9,600');
  });

  test('a three-paycheque month opens at three paycheques', async () => {
    // The whole reason this is derived. Carrying last month's figure forward
    // opens this one short by an entire payment, twice a year, quietly.
    const { store, ctx } = await withIncome('biweekly', '2026-01-02', '2000.00');
    const p = await run('open_month', { month: '2026-01' }, ctx);
    assert.ok(p.effects.some((e) => /3 × \$2,000/.test(e)));
    assert.ok(p.effects.some((e) => /extra payday/.test(e)));
    await commit(p.id, ctx);
    assert.equal(fmt(store.state.months.get('2026-01')!.income), '$6,000');
  });

  test('an ordinary month opens at two', async () => {
    const { store, ctx } = await withIncome('biweekly', '2026-01-02', '2000.00');
    await commit((await run('open_month', { month: '2026-02' }, ctx)).id, ctx);
    assert.equal(fmt(store.state.months.get('2026-02')!.income), '$4,000');
  });

  test('an explicit figure still wins, and says that it did', async () => {
    const { store, ctx } = await withIncome('semimonthly', '2026-01-15', '4800.00');
    const p = await run('open_month',
      { month: '2026-08', incomeCents: parseDollars('12000.00') }, ctx);
    assert.ok(p.effects.some((e) => /rather than the \$9,600/.test(e)));
    await commit(p.id, ctx);
    assert.equal(fmt(store.state.months.get('2026-08')!.income), '$12,000');
  });

  test('with no income recorded it refuses rather than opening at zero', async () => {
    // Opening at nothing would look like a plan that cannot be afforded, when
    // the truth is that nobody has said what comes in.
    const { ctx } = await fixture();
    await commit((await run('discard_month', { month: '2026-08', why: 'clean' }, ctx)).id, ctx);
    await assert.rejects(
      () => run('open_month', { month: '2026-08' }, ctx), /No income is recorded/);
  });

  test('but a figure can still be given when nothing is recorded', async () => {
    const { store, ctx } = await fixture();
    await commit((await run('discard_month', { month: '2026-08', why: 'clean' }, ctx)).id, ctx);
    const p = await run('open_month',
      { month: '2026-08', incomeCents: parseDollars('5000.00') }, ctx);
    assert.ok(p.effects.some((e) => /for this month only/.test(e)));
    await commit(p.id, ctx);
    assert.equal(fmt(store.state.months.get('2026-08')!.income), '$5,000');
  });

  test('an income that has not started yet does not open the month at zero by surprise', async () => {
    const { ctx } = await withIncome('monthly', '2026-10-01', '5000.00');
    const p = await run('open_month', { month: '2026-08' }, ctx);
    // It opens at nothing, but the effects say so plainly rather than listing
    // paydays that do not exist.
    assert.ok(p.effects.some((e) => /income \$0/.test(e)));
  });
});

describe('categories are headings', () => {
  test('a new one can be added and then an envelope put under it', async () => {
    const { store, ctx } = await fixture();
    await commit((await run('add_category', { label: 'Pets' }, ctx)).id, ctx);
    assert.equal(store.state.categories.get('pets')!.label, 'Pets');

    await commit((await run('add_envelope', { label: 'Vet', category: 'pets' }, ctx)).id, ctx);
    assert.equal(store.state.envelopes.get('vet')!.category, 'pets');
  });

  test('renaming changes the name everywhere and moves no money', async () => {
    const { store } = await fixture({ spend: true });
    const before = monthView(store.state, '2026-08')!.activity;
    await store.append('alice', { op: 'category.rename', category: 'people', label: 'Everyday' });

    assert.equal(store.state.categories.get('people')!.label, 'Everyday');
    assert.equal(store.state.envelopes.get('daily')!.category, 'people', 'the envelope still sits under the same heading');
    assert.equal(store.state.txns.get('t1')!.envelope, 'daily', 'the receipt is where it was');
    assert.equal(monthView(store.state, '2026-08')!.activity, before);
  });

  test('a duplicate name is refused', async () => {
    const { store } = await fixture();
    await assert.rejects(
      () => store.append('alice', { op: 'category.add', category: 'newone', label: 'people ' }), /There is already a category called People\./);
  });
});

