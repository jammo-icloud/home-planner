import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { parseDollars } from '../src/money.ts';
import { removedTxn } from '../src/activity.ts';
import { everyEntry } from './every-entry.ts';
import type { ThreadEntry } from '../src/thread.ts';
import { toolByName, commit, ProposalStore, ToolError } from '../src/tools.ts';
import { ReplayError } from '../src/replay.ts';

const TODAY = '2026-08-13';

const receipt = (id: string, payee: string, amount: string, envelope: string | null = null) =>
  ({ id, date: '2026-08-04', payee, amount: parseDollars(amount), dedupeKey: id, envelope });

async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-act-')), 'events.jsonl');
  const store = new Store({ path });
  await store.load();
  await store.append('system', [
    { op: 'category.add', category: 'people', label: 'People' },
    { op: 'envelope.define', envelope: 'daily', label: 'Daily life', category: 'people', template: parseDollars('1000.00'), order: 0 },
    { op: 'month.open', month: '2026-08', income: parseDollars('5000.00') },
    { op: 'txn.add', txns: [
      receipt('r1', 'SAFEWAY', '-64.10', 'daily'),
      receipt('r2', 'A MYSTERY CHARGE', '-31.00'),
    ] },
  ]);
  const ctx = { store, who: 'alice' as const, today: TODAY, proposals: new ProposalStore(), sid: null };
  return { store, ctx };
}

type Change = Extract<ThreadEntry, { kind: 'change' }>;

/** What the thread shows as direct changes, newest first, as read by `who`. */
async function activity(store: Store, o: { who?: string } = {}) {
  const page = await everyEntry(store, o.who ?? 'bob');
  const entries = page.entries.filter((e): e is Change => e.kind === 'change').reverse();
  return { entries, flags: page.waiting.filter((w) => w.kind === 'flag').length };
}

describe('deleting a receipt leaves a record', () => {
  test('it cannot be done silently', async () => {
    const { store } = await fixture();
    await assert.rejects(
      () => store.append('alice', { op: 'txn.remove', txn: 'r2', why: '  ' } as never),
      ReplayError, 'a deletion without a reason must be refused, like a move without one');
  });

  test('the reason is carried on the entry', async () => {
    const { store } = await fixture();
    await store.append('alice', { op: 'txn.remove', txn: 'r2', why: 'duplicate of the card charge' });
    const { entries } = await activity(store);
    assert.equal(entries[0]!.who, 'alice');
    assert.equal(entries[0]!.why, 'duplicate of the card charge');
    assert.ok(entries[0]!.flag);
  });

  test('what was deleted is shown, so nobody has to go looking for it', async () => {
    // The whole point: Bob reads that a receipt is gone and can see which
    // one, without opening a bank statement to work out what is missing.
    const { store } = await fixture();
    await store.append('alice', { op: 'txn.remove', txn: 'r2', why: 'not ours' });
    const r = (await activity(store)).entries[0]!.flag!.removed!;
    assert.equal(r.payee, 'A MYSTERY CHARGE');
    assert.equal(r.amount, '-$31.00');
    assert.equal(r.date, '2026-08-04');
    assert.equal(r.stillGone, true);
  });

  test('the log still holds it after replay from scratch', async () => {
    const { store } = await fixture();
    await store.append('alice', { op: 'txn.remove', txn: 'r1', why: 'wrong account' });
    const reopened = new Store({ path: store.path });
    await reopened.load();
    assert.equal(reopened.state.txns.has('r1'), false, 'gone from state');
    assert.equal((await removedTxn(reopened, 'r1'))?.payee, 'SAFEWAY', 'but never gone from the log');
  });

  test('a deletion made before reasons were required still replays, and is flagged', async () => {
    // Requiring a reason is a rule about today. Enforcing it over history made
    // five real deletions unloadable and silently resurrected the receipts they
    // had removed — the log has to stay replayable whatever the rules become.
    const { store } = await fixture();
    await store.append('alice', { op: 'txn.remove', txn: 'r2', why: 'x' });
    const raw = (await store.since(null)).map((e) => {
      if (e.op !== 'txn.remove') return JSON.stringify(e);
      const { why, ...rest } = e as unknown as Record<string, unknown>;
      return JSON.stringify(rest);
    });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(store.path, raw.join('\n') + '\n', 'utf8');

    const reopened = new Store({ path: store.path });
    await reopened.load();
    assert.equal(reopened.loadReport.skipped.length, 0, 'history must still load');
    assert.equal(reopened.state.txns.has('r2'), false, 'and still mean what it meant');

    const entry = (await activity(reopened)).entries.find((x) => x.flag)!;
    assert.equal(entry.why, null, 'shown as made without a reason, not given one');
  });

  test('but a new deletion without a reason is refused at the point of writing', async () => {
    const { store } = await fixture();
    await assert.rejects(
      () => store.append('alice', { op: 'txn.remove', txn: 'r1' } as never), ReplayError);
  });
});

describe('putting it back', () => {
  test('a deleted receipt can be restored, with an envelope this time', async () => {
    const { store, ctx } = await fixture();
    await store.append('alice', { op: 'txn.remove', txn: 'r2', why: 'thought it was a duplicate' });

    const p = await toolByName.get('restore_transaction')!.run(
      { txnId: 'r2', envelope: 'daily', why: 'it was ours after all — a restaurant' }, ctx) as
      { id: string; effects: string[] };
    assert.match(p.effects[0]!, /A MYSTERY CHARGE/);
    assert.match(p.effects[1]!, /It lands in Daily life/);

    // Nothing changed until approval, same as every other write.
    assert.equal(store.state.txns.has('r2'), false);
    await commit(p.id, ctx);
    assert.equal(store.state.txns.get('r2')!.envelope, 'daily');
  });

  test('a restore cannot ask for the split marker; the receipt comes back first', async () => {
    const { store, ctx } = await fixture();
    await store.append('alice', { op: 'txn.remove', txn: 'r1', why: 'oops' });
    await assert.rejects(
      () => toolByName.get('restore_transaction')!.run({ txnId: 'r1', envelope: '__split', why: 'divide it' }, ctx) as Promise<unknown>,
      /restore it first, then split it/);
  });

  test('a restore given no envelope (null) lands in To sort, not back where it was', async () => {
    const { store, ctx } = await fixture();
    await store.append('alice', { op: 'txn.remove', txn: 'r1', why: 'oops' });
    const p = await toolByName.get('restore_transaction')!.run(
      { txnId: 'r1', envelope: null, why: 'ours, but not daily life' }, ctx) as { id: string; effects: string[] };
    assert.match(p.effects[1]!, /no envelope until someone sorts it/);
    await commit(p.id, ctx);
    assert.equal(store.state.txns.get('r1')!.envelope, null);
  });

  test('a restore with the envelope left out goes back where it was', async () => {
    const { store, ctx } = await fixture();
    await store.append('alice', { op: 'txn.remove', txn: 'r1', why: 'oops' });
    const p = await toolByName.get('restore_transaction')!.run({ txnId: 'r1', why: 'a mistake' }, ctx) as { id: string };
    await commit(p.id, ctx);
    assert.equal(store.state.txns.get('r1')!.envelope, 'daily');
  });

  test('restoring keeps the same id, so it cannot become a second copy', async () => {
    const { store, ctx } = await fixture();
    const before = store.state.txns.size;
    await store.append('alice', { op: 'txn.remove', txn: 'r1', why: 'oops' });
    const p = await toolByName.get('restore_transaction')!.run(
      { txnId: 'r1', why: 'that was a mistake' }, ctx) as { id: string };
    await commit(p.id, ctx);
    assert.equal(store.state.txns.size, before);
  });

  test('a receipt already in the ledger cannot be restored again', async () => {
    const { ctx } = await fixture();
    await assert.rejects(
      () => toolByName.get('restore_transaction')!.run({ txnId: 'r1', why: 'why not' }, ctx) as Promise<unknown>,
      ToolError);
  });

  test('once restored, the entry stops asking to be reviewed', async () => {
    const { store, ctx } = await fixture();
    await store.append('alice', { op: 'txn.remove', txn: 'r2', why: 'thought it was a duplicate' });
    assert.equal((await activity(store)).entries.find((e) => e.flag)!.flag!.removed!.stillGone, true);

    const p = await toolByName.get('restore_transaction')!.run(
      { txnId: 'r2', envelope: 'daily', why: 'it was ours' }, ctx) as { id: string };
    await commit(p.id, ctx);

    const after = await activity(store);
    assert.equal(after.entries.find((e) => e.flag)!.flag!.removed!.stillGone, false, 'the record stays');
    assert.equal(after.flags, 0, 'and it stops waiting on anyone');
  });
});

describe('reading it without drowning', () => {
  test('a bulk sort is one line, not thirty-three', async () => {
    const { store } = await fixture();
    await store.append('alice', Array.from({ length: 33 }, (_, i) => ({
      op: 'txn.sort' as const, txn: 'r1', envelope: 'daily', manual: true,
      ...(i === 0 ? {} : {}),
    })));
    const { entries } = await activity(store);
    const sorted = entries.find((e) => e.what.includes('sorted a receipt'))!;
    assert.equal(sorted.count, 33);
    assert.match(sorted.what, /33 times/);
  });

  test('opening the app is not an activity', async () => {
    const { store } = await fixture();
    await store.append('bob', { op: 'briefing.read', upTo: store.state.lastEventId! });
    const { entries } = await activity(store);
    assert.equal(entries.some((e) => e.what.includes('briefing')), false);
    assert.equal(entries.some((e) => e.what.includes('read')), false);
  });

  test('a personal preference is not an activity', async () => {
    const { store } = await fixture();
    await store.append('bob', { op: 'scheme.set', scheme: 'lapis', mode: 'dark' });
    await store.append('bob', { op: 'calendar.conflicts', calendars: [] });
    const { entries } = await activity(store);
    assert.equal(entries.some((e) => /scheme|conflicts/.test(e.what)), false);
  });

  test('"waiting" holds the decisions that took money out, for the one who did not make them', async () => {
    const { store } = await fixture();
    await store.append('alice', { op: 'thread.note', text: 'the thread has started' });
    await store.append('alice', { op: 'txn.remove', txn: 'r1', why: 'gone' });
    const forBob = await activity(store, { who: 'bob' });
    const waits = forBob.entries.filter((e) => e.waits);
    assert.equal(waits.length, 1);
    assert.equal(forBob.flags, 1);
    assert.ok(waits[0]!.flag);
    assert.equal((await activity(store, { who: 'alice' })).entries.filter((e) => e.waits).length, 0);
  });

  test('newest first — the question is what changed lately', async () => {
    const { store } = await fixture();
    await store.append('alice', { op: 'txn.remove', txn: 'r1', why: 'first' });
    await store.append('alice', { op: 'txn.remove', txn: 'r2', why: 'second' });
    assert.equal((await activity(store)).entries[0]!.why, 'second');
  });
});
