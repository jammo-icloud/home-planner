// api/test/restore-people.test.ts
//
// What a restore promises, it does. In place with the people band, and as a
// household of its own, no restore says yes and then fails on a line the fold
// refuses: a line that cannot land here is named in words, or left out and
// counted.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Households } from '../src/households.ts';
import { parseBackup, planRestore, eventsToApply } from '../src/restore.ts';
import type { ParsedBackup, Scope } from '../src/restore.ts';
import { parseDollars } from '../src/money.ts';
import type { Store } from '../src/store.ts';
import type { Event } from '../src/types.ts';

const dir = async () => join(await mkdtemp(join(tmpdir(), 'pb-restore-people-')), 'households');
const backupOf = async (store: Store): Promise<ParsedBackup> => parseBackup(await readFile(store.path, 'utf8'));
const eventsOf = async (store: Store): Promise<Event[]> => [...(await backupOf(store)).events] as Event[];

/** alice's household, with bob and casey as members and a plan of bob's. */
async function alicesWithPeople(): Promise<Store> {
  const { store } = await new Households(await dir()).create('alice', 'Theirs');
  await store.append('alice', [
    { op: 'member.add', member: 'bob', why: 'he lives here' },
    { op: 'member.add', member: 'casey', why: 'she lives here' },
  ]);
  await store.append('bob', { op: 'plan.create', plan: 'p-bob', title: 'Fix the gate', area: 'House' });
  return store;
}

/** A household of alice's own, with nobody else in it. */
const alicesHere = async (): Promise<Store> => (await new Households(await dir()).create('alice', 'Here')).store;

describe('a restore in place, with the people band', () => {
  test("alice's own backup with a plan comes back clean, and the household keeps its own name and owner", async () => {
    // The scratchpad repro's case B.
    const { store: src } = await new Households(await dir()).create('alice', 'Theirs');
    await src.append('alice', { op: 'plan.create', plan: 'p1', title: 'Paint the fence', area: 'House' });
    const target = await alicesHere();
    const plan = planRestore(target.state, await backupOf(src), ['people', 'plans']);
    assert.deepEqual(plan.collisions, []);
    assert.deepEqual(plan.missingPrerequisites, []);
    assert.ok(!plan.take.some((e) => e.op === 'household.claim'), "the backup's claim is never taken");
    assert.ok(plan.summary.some((l) => /keeps its own name, Here, and its owner, alice/.test(l)), plan.summary.join(' | '));
    await target.adopt(eventsToApply(plan));
    assert.equal(target.state.plans.get('p1')?.title, 'Paint the fence');
    assert.deepEqual([target.state.label, target.state.owner], ['Here', 'alice']);
  });

  test('same owner: the members and their plans come back into a household that has none', async () => {
    const target = await alicesHere();
    const plan = planRestore(target.state, await backupOf(await alicesWithPeople()), ['people', 'plans']);
    assert.deepEqual(plan.collisions, []);
    assert.deepEqual(plan.missingPrerequisites, []);
    await target.adopt(eventsToApply(plan));
    assert.deepEqual([...target.state.members].sort(), ['alice', 'bob', 'casey']);
    assert.equal(target.state.plans.get('p-bob')?.owner, 'bob');
  });

  test('same owner, bob already a member here: still clean, and the add that is already true is not taken', async () => {
    const target = await alicesHere();
    await target.append('alice', { op: 'member.add', member: 'bob', why: 'already here' });
    const plan = planRestore(target.state, await backupOf(await alicesWithPeople()), ['people', 'plans']);
    assert.deepEqual(plan.collisions, []);
    assert.deepEqual(plan.take.filter((e) => e.op === 'member.add').map((e) => (e as { member: string }).member), ['casey']);
    await target.adopt(eventsToApply(plan));
    assert.deepEqual([...target.state.members].sort(), ['alice', 'bob', 'casey']);
  });

  test('a different owner: a member added by bob is a collision in words, and nothing is applied', async () => {
    const { store: src } = await new Households(await dir()).create('bob', 'Bobs');
    await src.append('bob', { op: 'member.add', member: 'casey', why: 'she lives here' });
    const target = await alicesHere();
    const plan = planRestore(target.state, await backupOf(src), ['people']);
    const owner = plan.collisions.filter((c) => c.kind === 'owner');
    assert.equal(owner.length, 1, JSON.stringify(plan.collisions));
    assert.match(owner[0]!.why, /bob/);
    assert.match(owner[0]!.why, /casey/);
    assert.match(owner[0]!.why, /only alice/);
    assert.throws(() => eventsToApply(plan));
  });

  test("a backup that removes this household's owner is a collision", async () => {
    const { store: src } = await new Households(await dir()).create('bob', 'Bobs');
    await src.append('bob', { op: 'member.add', member: 'alice', why: 'she lives here' });
    await src.append('bob', { op: 'member.remove', member: 'alice', why: 'she moved out' });
    const target = await alicesHere();
    const plan = planRestore(target.state, await backupOf(src), ['people']);
    const removing = plan.collisions.find((c) => c.kind === 'owner' && /removes alice/.test(c.why));
    assert.ok(removing, JSON.stringify(plan.collisions));
    assert.match(removing.why, /owns this household/);
    assert.throws(() => eventsToApply(plan));
  });

  test('add, remove and add again come out right against the members here', async () => {
    const { store: src } = await new Households(await dir()).create('alice', 'Theirs');
    await src.append('alice', { op: 'member.add', member: 'dana', why: 'staying' });
    await src.append('alice', { op: 'member.remove', member: 'dana', why: 'left' });
    await src.append('alice', { op: 'member.add', member: 'dana', why: 'back again' });
    await src.append('dana', { op: 'plan.create', plan: 'p-dana', title: 'Plant the beds', area: 'House' });
    const target = await alicesHere();
    await target.append('alice', { op: 'member.add', member: 'dana', why: 'here already' });
    const plan = planRestore(target.state, await backupOf(src), ['people', 'plans']);
    assert.deepEqual(plan.collisions, []);
    // The first add is already true and left out; the remove and the add again are taken.
    assert.deepEqual(plan.take.filter((e) => e.op.startsWith('member.')).map((e) => e.op), ['member.remove', 'member.add']);
    await target.adopt(eventsToApply(plan));
    assert.ok(target.state.members.has('dana'));
    assert.ok(target.state.plans.has('p-dana'));
  });

  test("the backup's claimer is not counted a member: bob's own backup brings plans of his that need him here", async () => {
    // Without the people band's claim counting, bob is a stranger here, and his plans say so.
    const { store: src } = await new Households(await dir()).create('bob', 'Bobs');
    await src.append('bob', { op: 'plan.create', plan: 'p-bob', title: 'Clean the gutters', area: 'House' });
    const target = await alicesHere();
    const plan = planRestore(target.state, await backupOf(src), ['people', 'plans']);
    assert.ok(plan.collisions.some((c) => c.kind === 'owner' && c.what === 'bob'), JSON.stringify(plan.collisions));
    assert.throws(() => eventsToApply(plan));
  });
});

describe('the promise holds: a clean plan always applies', () => {
  type Build = () => Promise<Store>;
  const backups: [string, Build][] = [
    ["alice's own, with people and a plan of bob's", alicesWithPeople],
    ["bob's, with a member he added", async () => {
      const { store } = await new Households(await dir()).create('bob', 'Bobs');
      await store.append('bob', { op: 'member.add', member: 'casey', why: 'she lives here' });
      await store.append('casey', { op: 'plan.create', plan: 'p-casey', title: 'Paint the shed', area: 'House' });
      return store;
    }],
    ["bob's, removing alice", async () => {
      const { store } = await new Households(await dir()).create('bob', 'Bobs');
      await store.append('bob', { op: 'member.add', member: 'alice', why: 'she lives here' });
      await store.append('alice', { op: 'plan.create', plan: 'p-alice', title: 'Book the plumber', area: 'House' });
      await store.append('bob', { op: 'member.remove', member: 'alice', why: 'she moved out' });
      return store;
    }],
    ["alice's, adding, removing and adding dana, who asks bob", async () => {
      const store = await alicesWithPeople();
      await store.append('alice', [{ op: 'member.add', member: 'dana', why: 'staying' }]);
      await store.append('dana', { op: 'plan.create', plan: 'p-dana', title: 'Plant the beds', area: 'House' });
      await store.append('dana', { op: 'plan.ask', plan: 'p-dana', to: 'bob', why: 'you have the tools' });
      await store.append('alice', [{ op: 'member.remove', member: 'dana', why: 'left' }]);
      await store.append('alice', [{ op: 'member.add', member: 'dana', why: 'back' }]);
      await store.append('bob', { op: 'briefing.read', upTo: 'x' } as never);
      return store;
    }],
    ["bob's, with a time zone and money", async () => {
      const { store } = await new Households(await dir()).create('bob', 'Bobs');
      await store.append('bob', [{ op: 'household.zone', zone: 'America/Denver' },
        { op: 'category.define', category: 'food', label: 'Groceries', kind: 'People' },
        { op: 'txn.add', txns: [{ id: 't-inv', date: '2026-08-02', payee: 'MARKET', amount: parseDollars('-12.00'), dedupeKey: 't-inv', category: 'food' }] }]);
      await store.append('bob', { op: 'guest.allow', email: 'dana@example.com', name: 'Dana', why: 'a friend' });
      return store;
    }],
  ];
  const targets: [string, () => Promise<Store>][] = [
    ['alice alone', alicesHere],
    ['alice with bob', async () => {
      const t = await alicesHere();
      await t.append('alice', { op: 'member.add', member: 'bob', why: 'already here' });
      return t;
    }],
    ["bob's, with alice", async () => {
      const { store } = await new Households(await dir()).create('bob', 'Bobs here');
      await store.append('bob', { op: 'member.add', member: 'alice', why: 'she lives here' });
      return store;
    }],
  ];
  const scopeSets: Scope[][] = [['people'], ['plans'], ['people', 'plans'], ['settings'], ['bookings'],
    ['people', 'plans', 'thread', 'bookings', 'settings'],
    ['facts', 'budgets', 'months', 'people', 'thread', 'settings', 'plans', 'bookings']];

  test('whenever planRestore finds no collision and nothing missing, adopting what it takes succeeds', async () => {
    let clean = 0;
    let refused = 0;
    for (const [bname, build] of backups) {
      for (const [tname, makeTarget] of targets) {
        for (const scopes of scopeSets) {
          const backup = await backupOf(await build());
          const target = await makeTarget();
          const plan = planRestore(target.state, backup, scopes);
          const what = `${bname} into ${tname}, ${scopes.join('+')}`;
          if (plan.collisions.length || plan.missingPrerequisites.length) {
            refused++;
            assert.throws(() => eventsToApply(plan), what);
            continue;
          }
          clean++;
          await assert.doesNotReject(() => target.adopt(eventsToApply(plan)), what);
        }
      }
    }
    // Both kinds are exercised, or the invariant says nothing.
    assert.ok(clean > 10, `clean ${clean}`);
    assert.ok(refused > 10, `refused ${refused}`);
  });
});

describe('a restore as a household of its own', () => {
  test("alice's own backup with a plan comes back whole", async () => {
    // The scratchpad repro's case A.
    const { store: src } = await new Households(await dir()).create('alice', 'Theirs');
    await src.append('alice', { op: 'plan.create', plan: 'p1', title: 'Paint the fence', area: 'House' });
    const r = await new Households(await dir()).createFromLog('alice', 'Restored', await eventsOf(src));
    assert.equal(r.store.state.plans.get('p1')?.title, 'Paint the fence');
  });

  test('the backup of her own household: every member and every plan comes back, under the new label', async () => {
    const src = await alicesWithPeople();
    await src.append('alice', { op: 'plan.create', plan: 'p-alice', title: 'Book the plumber', area: 'House' });
    await src.append('alice', [{ op: 'household.zone', zone: 'America/Denver' },
      { op: 'envelopes.model', model: 'claude-sonnet-5-5' }, { op: 'guests.booking', on: true },
      { op: 'documents.folder', team: 'Planner', folder: 'theirs', source: 'owner' }]);
    const events = await eventsOf(src);
    const hh = new Households(await dir());
    const { store, summary } = await hh.createFromLog('alice', 'Restored', events);

    assert.equal(store.state.owner, 'alice');
    assert.equal(store.state.label, 'Restored');
    assert.deepEqual([...store.state.members].sort(), ['alice', 'bob', 'casey']);
    assert.deepEqual([...store.state.plans.keys()].sort(), ['p-alice', 'p-bob']);
    // The claim stays where it was, the same line, carrying the new label.
    const [first] = await store.since(null);
    assert.deepEqual([first!.op, first!.id, (first as { label?: string }).label], ['household.claim', events[0]!.id, 'Restored']);
    assert.deepEqual(summary, ['kept the time zone, America/Denver', 'kept the envelope model, claude-sonnet-5-5',
      'The copy chooses its own folder for documents and starts with booking off: '
        + 'no two households share a folder, and friends book with one household at a time.']);
    assert.equal(store.state.documents.folder, null);
    assert.equal(store.state.settings.booking, null);
    assert.equal(store.state.zone, 'America/Denver');
    assert.deepEqual((await hh.list()).map((h) => [h.label, h.owner, [...h.members].sort()]),
      [['Restored', 'alice', ['alice', 'bob', 'casey']]]);
  });

  test("someone else's backup: the money comes, bob's plan lines stay behind and are counted, and alice is the only member", async () => {
    const { store: src } = await new Households(await dir()).create('bob', 'Bobs');
    await src.append('bob', { op: 'member.add', member: 'alice', why: 'she lives here' });
    await src.append('bob', [
      { op: 'category.define', category: 'food', label: 'Groceries', kind: 'People' },
      { op: 'txn.add', txns: [{ id: 't1', date: '2026-08-02', payee: 'MARKET', amount: parseDollars('-64.10'), dedupeKey: 't1', category: 'food' }] },
      { op: 'budget.create', budget: 'home', label: 'Home' },
    ]);
    await src.append('bob', { op: 'plan.create', plan: 'p-bob', title: 'Clean the gutters', area: 'House' });
    await src.append('bob', { op: 'plan.set', plan: 'p-bob', title: 'Clean all the gutters' });
    await src.append('bob', { op: 'plan.create', plan: 'p-bob2', title: 'Fix the gate', area: 'House' });
    await src.append('alice', { op: 'plan.create', plan: 'p-alice', title: 'Book the plumber', area: 'House' });
    const events = await eventsOf(src);

    const { store, summary } = await new Households(await dir()).createFromLog('alice', 'Restored', events);
    assert.equal(store.state.txns.size, 1);
    assert.equal(store.state.categories.size, 1);
    assert.ok(store.state.budgets.has('home'));
    assert.deepEqual([...store.state.plans.keys()], ['p-alice']);
    assert.deepEqual([...store.state.members], ['alice']);
    assert.equal(store.state.owner, 'alice');
    assert.ok(summary.includes('Left out 3 plan lines written by bob, who is not a member here.'), summary.join(' | '));
    // The new owner's claim is the first line, and nobody's `who` was rewritten.
    const written = await store.since(null);
    assert.deepEqual([written[0]!.op, written[0]!.who], ['household.claim', 'alice']);
    assert.ok(written.filter((e) => e.op === 'txn.add').every((e) => e.who === 'bob'));
  });

  test("someone else's backup: a line of alice's on bob's plan cannot stand without it, and is counted too", async () => {
    const { store: src } = await new Households(await dir()).create('bob', 'Bobs');
    await src.append('bob', { op: 'member.add', member: 'alice', why: 'she lives here' });
    await src.append('bob', { op: 'plan.create', plan: 'p-bob', title: 'Clean the gutters', area: 'House' });
    await src.append('alice', { op: 'plan.set', plan: 'p-bob', notes: 'the ladder is in the shed' });
    await src.append('alice', { op: 'plan.create', plan: 'p-alice', title: 'Book the plumber', area: 'House' });
    await src.append('alice', { op: 'plan.ask', plan: 'p-alice', to: 'bob', why: 'you know the plumber' });
    const { store, summary } = await new Households(await dir()).createFromLog('alice', 'Restored', await eventsOf(src));
    assert.deepEqual([...store.state.plans.keys()], ['p-alice']);
    assert.equal(store.state.plans.get('p-alice')!.asked ?? null, null);
    assert.ok(summary.includes('Left out 1 plan line written by bob, who is not a member here.'), summary.join(' | '));
    assert.ok(summary.includes('Left out 1 plan line asking or handing a plan to bob, who is not a member here.'), summary.join(' | '));
    assert.ok(summary.includes('Left out 1 more line that needed one of those.'), summary.join(' | '));
  });

  test('a broken backup still fails, and leaves no household behind', async () => {
    const { store: src } = await new Households(await dir()).create('alice', 'Theirs');
    const events = await eventsOf(src);
    // A month for a budget that never existed: no membership to blame, so the restore fails.
    const broken = { id: 'zz-000001', at: new Date().toISOString(), who: 'alice', op: 'month.open', budget: 'nowhere', month: '2026-08', income: 0 } as Event;
    const hh = new Households(await dir());
    await assert.rejects(() => hh.createFromLog('alice', 'Restored', [...events, broken]), /nowhere/);
    assert.deepEqual(await hh.ids(), []);
  });
});
