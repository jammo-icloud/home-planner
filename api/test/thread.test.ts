import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import type { NewEvent } from '../src/store.ts';
import { scopeOf, parseBackup, planRestore } from '../src/restore.ts';
import { readFile } from 'node:fs/promises';
import type { Event } from '../src/types.ts';

const NOW = '2026-10-28T09:00:00Z';

async function household(seed: NewEvent[] = []): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-thread-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('alice', [{ op: 'household.claim', label: 'Home' }, ...seed]);
  await store.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
  return store;
}

const anOffer = (over: Partial<Extract<NewEvent, { op: 'proposal.offer' }>> = {}): NewEvent => ({
  op: 'proposal.offer', tool: 'move_money',
  args: { from: 'fun', to: 'food', amountCents: 12000, why: 'trip paid' },
  summary: 'Move $120 from Fun to Food', effects: ['Food goes to $120'],
  events: [], month: '2026-10', envelopes: ['fun', 'food'],
  fingerprint: 'fp', prompt: { kind: 'briefing', ref: null }, ...over,
});

async function offered(store: Store, over = {}): Promise<Event> {
  const [e] = await store.append('claude', anOffer(over));
  return e!;
}

describe('the thread in the log', () => {
  test('an offer folds into state as open, and a decision closes it', async () => {
    const s = await household();
    const o = await offered(s);
    assert.equal(s.state.thread.offers.get(o.id)?.status, 'open');
    await s.append('alice', { op: 'proposal.decide', proposal: o.id, decision: 'approved', why: 'trip paid' });
    const after = s.state.thread.offers.get(o.id)!;
    assert.equal(after.status, 'approved');
    assert.equal(after.decidedBy, 'alice');
    assert.equal(after.why, 'trip paid');
  });

  test('a second decision on the same card is refused', async () => {
    const s = await household();
    const o = await offered(s);
    await s.append('alice', { op: 'proposal.decide', proposal: o.id, decision: 'approved', why: 'ok' });
    await assert.rejects(
      s.append('bob', { op: 'proposal.decide', proposal: o.id, decision: 'approved', why: 'ok' }),
      /already decided/);
    assert.equal(s.state.thread.offers.get(o.id)?.decidedBy, 'alice');
  });

  test('an offer that replaces another marks the old one replaced, and it can no longer be decided', async () => {
    const s = await household();
    const old = await offered(s);
    const next = await offered(s, { replaces: old.id });
    const was = s.state.thread.offers.get(old.id)!;
    assert.equal(was.status, 'replaced');
    assert.equal(was.replacedBy, next.id);
    await assert.rejects(
      s.append('alice', { op: 'proposal.decide', proposal: old.id, decision: 'approved', why: 'ok' }),
      /already decided/);
  });

  test('a snoozed offer can still be approved', async () => {
    const s = await household();
    const o = await offered(s);
    await s.append('bob', { op: 'proposal.decide', proposal: o.id, decision: 'snoozed' });
    assert.equal(s.state.thread.offers.get(o.id)?.status, 'snoozed');
    await s.append('alice', { op: 'proposal.decide', proposal: o.id, decision: 'approved', why: 'ok' });
    assert.equal(s.state.thread.offers.get(o.id)?.status, 'approved');
  });

  test('deciding a card that was never offered is refused', async () => {
    const s = await household();
    await assert.rejects(
      s.append('alice', { op: 'proposal.decide', proposal: 'nope', decision: 'declined' }),
      /already decided|no such card/);
  });

  test('claude may only offer, answer and brief', async () => {
    const s = await household([
    ]);
    await assert.rejects(s.append('claude', { op: 'category.add', category: 'mine', label: 'Mine now' }), /claude cannot/);
    await assert.rejects(s.append('claude', { op: 'thread.note', text: 'hello' }), /claude cannot/);
    await s.append('claude', { op: 'thread.answer', replyTo: 'q1', text: 'Here is why.', tools: [], model: 'm' });
    await s.append('claude', {
      op: 'thread.briefing', day: '2026-10-28', source: 'budget',
      headline: 'Quiet day', body: '', writtenBy: 'fallback',
    });
  });

  test('a question or note must say something, and not too much', async () => {
    const s = await household();
    await assert.rejects(s.append('alice', { op: 'thread.note', text: '   ' }), /empty/);
    await assert.rejects(s.append('alice', { op: 'thread.ask', question: 'x'.repeat(2001) }), /2,000/);
    await s.append('alice', { op: 'thread.note', text: 'x'.repeat(2000) });
  });

  test('flag.seen is per member', async () => {
    const s = await household();
    await s.append('alice', { op: 'flag.seen', event: 'e1' });
    assert.ok(s.state.thread.seen.get('alice')?.has('e1'));
    assert.equal(s.state.thread.seen.get('bob'), undefined);
  });

  test('an accepted suggestion records that Claude suggested it', async () => {
    const s = await household([{ op: 'category.add', category: 'food', label: 'Food' }]);
    await s.append('alice', { op: 'txn.add', txns: [{
      id: 't1', date: '2026-10-02', payee: 'HILLTOP FOODS', amount: -4200 as never,
      dedupeKey: 't1', envelope: 'food', suggestedBy: 'claude',
    }] });
    assert.equal(s.state.txns.get('t1')?.suggestedBy, 'claude');
    await s.append('alice', { op: 'txn.add', txns: [{
      id: 't2', date: '2026-10-02', payee: 'SAFEWAY', amount: -100 as never, dedupeKey: 't2', envelope: null,
    }] });
    await s.append('alice', { op: 'txn.sort', txn: 't2', envelope: 'food', suggestedBy: 'claude' });
    assert.equal(s.state.txns.get('t2')?.suggestedBy, 'claude');
    // Confirming the same envelope (as remembering a rule does) keeps where it came from…
    await s.append('alice', { op: 'txn.sort', txn: 't2', envelope: 'food', manual: true });
    assert.equal(s.state.txns.get('t2')?.suggestedBy, 'claude');
    // …and choosing a different one is a person's choice, not Claude's.
    await s.append('alice', { op: 'category.add', category: 'fun', label: 'Fun' });
    await s.append('alice', { op: 'txn.sort', txn: 't2', envelope: 'fun', manual: true });
    assert.equal(s.state.txns.get('t2')?.suggestedBy, undefined);
  });

  test('thread ops restore as their own scope', () => {
    const base = { id: 'x', at: NOW, who: 'alice' };
    for (const op of ['thread.briefing', 'thread.ask', 'thread.note', 'thread.answer',
                      'proposal.offer', 'proposal.decide', 'flag.seen'] as const) {
      assert.equal(scopeOf({ ...base, op } as unknown as Event), 'thread', op);
    }
  });

  test('the thread survives a reload from disk', async () => {
    const s = await household();
    const o = await offered(s);
    await s.append('bob', { op: 'proposal.decide', proposal: o.id, decision: 'snoozed' });
    const again = new Store({ path: s.path, now: () => new Date(NOW) });
    await again.load();
    assert.equal(again.state.thread.offers.get(o.id)?.status, 'snoozed');
  });

  test('a restore can take the conversation without the money, and says so', async () => {
    const s = await household([{ op: 'category.add', category: 'food', label: 'Food' }]);
    await s.append('alice', { op: 'thread.note', text: 'trip is paid for' });
    await offered(s);
    const backup = parseBackup(await readFile(s.path, 'utf8'));
    const plan = planRestore((await household()).state, backup, ['thread']);
    assert.deepEqual(plan.take.map((e) => e.op), ['thread.note', 'proposal.offer']);
    assert.ok(plan.summary.some((l) => /2 messages and suggestions/.test(l)), plan.summary.join('|'));
  });
});
