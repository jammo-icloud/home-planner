import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Households, adoptSingleLog, isValidId, retireShelves, slugify } from '../src/households.ts';
import { apply } from '../src/replay.ts';
import { newerBackup, parseBackup, planRestore, eventsToApply, scopeOf } from '../src/restore.ts';
import { parseDollars } from '../src/money.ts';
import { Store } from '../src/store.ts';
import type { Event } from '../src/types.ts';

const dir = async () => join(await mkdtemp(join(tmpdir(), 'pb-hh-')), 'households');

/** A household of bob's that alice, who made the plans in the backup, is a member of. */
const fresh = async () => {
  const hh = new Households(await dir());
  const made = await hh.create('bob', 'Fresh');
  await made.store.append('bob', { op: 'member.add', member: 'alice', why: 'the plans are hers' });
  return made;
};

/** A household with facts, a budget and a month — one of each band. */
async function furnished(store: Awaited<ReturnType<Households['open']>>) {
  await store.append('alice', [
    { op: 'category.define', category: 'food', label: 'Groceries', kind: 'People' },
    { op: 'category.define', category: 'elec', label: 'Electricity', kind: 'House' },
    { op: 'rule.add', rule: 'r1', match: 'SAFEWAY', category: 'food' },
    { op: 'txn.add', txns: [
      { id: 't1', date: '2026-08-02', payee: 'SAFEWAY', amount: parseDollars('-64.10'), dedupeKey: 't1', category: 'food' },
    ] },
    { op: 'budget.create', budget: 'home', label: 'Home' },
    { op: 'envelope.define', budget: 'home', envelope: 'daily', label: 'Daily life', group: 'People',
      match: { categories: ['food'] }, template: parseDollars('1000.00'), order: 0 },
    { op: 'month.open', budget: 'home', month: '2026-08', income: parseDollars('5000.00') },
    { op: 'assign', budget: 'home', month: '2026-08', envelope: 'daily',
      to: parseDollars('1100.00'), why: 'topping up' },
  ]);
}

describe('many households on one server', () => {
  test('a household is claimed by whoever makes it, from its first event', async () => {
    // No window in which a directory exists that nobody can administer.
    const hh = new Households(await dir());
    const { id, store } = await hh.create('alice', 'Rivera');
    assert.equal(id, 'rivera');
    assert.equal(store.state.owner, 'alice');
    assert.ok(store.state.members.has('alice'));
  });

  test('listing reads membership without replaying anything', async () => {
    const hh = new Households(await dir());
    const a = await hh.create('alice', 'Rivera');
    await furnished(a.store);
    await a.store.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
    await hh.create('bob', "Mum's");

    const list = await hh.list();
    assert.deepEqual(list.map((h) => h.id).sort(), ['mums', 'rivera'].sort());
    const rivera = list.find((h) => h.id === 'rivera')!;
    assert.equal(rivera.owner, 'alice');
    assert.deepEqual([...rivera.members].sort(), ['alice', 'bob']);
    assert.ok(rivera.size > 0);
    assert.ok(rivera.lastActivity);
  });

  test('you only see the households you are in', async () => {
    const hh = new Households(await dir());
    const a = await hh.create('alice', 'Rivera');
    await a.store.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
    await hh.create('someone', 'Theirs');

    assert.deepEqual((await hh.forUser('bob')).map((h) => h.id), ['rivera']);
    assert.deepEqual((await hh.forUser('someone')).map((h) => h.id), ['theirs']);
    assert.deepEqual(await hh.forUser('a-stranger'), []);
  });

  test('removing a member takes their access away, in the log', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('alice', 'Rivera');
    await store.append('alice', { op: 'member.add', member: 'guest', why: 'helping' });
    assert.equal((await hh.forUser('guest')).length, 1);
    await store.append('alice', { op: 'member.remove', member: 'guest', why: 'finished' });
    assert.equal((await hh.forUser('guest')).length, 0);
  });

  test('two households keep entirely separate ledgers', async () => {
    const hh = new Households(await dir());
    const a = await hh.create('alice', 'Rivera');
    const b = await hh.create('bob', "Mum's");
    await furnished(a.store);

    assert.equal(a.store.state.txns.size, 1);
    assert.equal(b.store.state.txns.size, 0, 'nothing leaks between them');
    assert.notEqual(a.store.path, b.store.path);
  });

  test('a name already taken is refused', async () => {
    const hh = new Households(await dir());
    await hh.create('alice', 'Rivera');
    await assert.rejects(() => hh.create('someone', 'Rivera'), /already exists/);
  });

  test('ids are directory names, so they are checked like one', () => {
    assert.equal(isValidId('rivera'), true);
    assert.equal(isValidId('mum-and-dad'), true);
    assert.equal(isValidId('../etc'), false);
    assert.equal(isValidId('Rivera'), false);
    assert.equal(isValidId(''), false);
    assert.equal(slugify("Mum & Dad's"), 'mum-dads');
    assert.equal(slugify("Mum\u2019s"), 'mums', 'a curly apostrophe too');
    assert.ok(slugify('!!!').startsWith('household-'), 'a name with nothing usable still gets an id');
  });

  test('an opened household is cached, and forgetting it does not touch the file', async () => {
    const hh = new Households(await dir());
    const { id, store } = await hh.create('alice', 'Rivera');
    await furnished(store);
    assert.equal(await hh.open(id), store, 'same replay, not a second one');

    hh.forget(id);
    const again = await hh.open(id);
    assert.notEqual(again, store);
    assert.equal(again.state.txns.size, 1, 'the file was untouched');
  });
});

describe('a backup is the log', () => {
  const backupOf = async (): Promise<string> => {
    const hh = new Households(await dir());
    const { store } = await hh.create('alice', 'Rivera');
    await furnished(store);
    return readFile(store.path, 'utf8');
  };

  test('it parses back into events, counted by scope', async () => {
    const b = parseBackup(await backupOf());
    assert.equal(b.skipped.length, 0);
    assert.equal(b.label, 'Rivera');
    assert.equal(b.owner, 'alice');
    assert.ok(b.counts.facts >= 4);
    assert.ok(b.counts.budgets >= 2);
    assert.ok(b.counts.months >= 2);
    assert.equal(b.counts.people, 1, 'the claim');
  });

  test('every event lands in exactly one scope', async () => {
    const b = parseBackup(await backupOf());
    const total = b.counts.facts + b.counts.budgets + b.counts.months + b.counts.people;
    assert.equal(total, b.events.length);
  });

  test('a corrupted line is reported, never dropped in silence', () => {
    const b = parseBackup('{"not":"an event"}\nnot json at all\n');
    assert.equal(b.events.length, 0);
    assert.equal(b.skipped.length, 2);
  });

  test('restoring just the receipts brings no plan with them', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts']);

    assert.equal(plan.collisions.length, 0);
    assert.equal(plan.counts.budgets, 0);
    assert.equal(plan.counts.months, 0);
    assert.match(plan.summary[0]!, /1 receipts/);
    await store.append('bob', eventsToApply(plan) as never);
    assert.equal(store.state.txns.size, 1);
    assert.equal(store.state.budgets.size, 0, 'a full ledger and no plan is a sensible place to start');
  });

  test('restoring a budget without its categories is refused as nonsense, not attempted', async () => {
    // The dependency runs one way. An envelope feeding on a category that is not
    // there does not collide — it means nothing.
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['budgets']);
    assert.ok(plan.missingPrerequisites.some((m) => /category "food"/.test(m)));
    assert.throws(() => eventsToApply(plan), /missing prerequisite/);
  });

  test('months without their budget are refused the same way', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts', 'months']);
    assert.ok(plan.missingPrerequisites.some((m) => /need that budget/.test(m)));
  });

  test('all three together restore cleanly into an empty household', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts', 'budgets', 'months']);
    assert.deepEqual(plan.collisions, []);
    assert.deepEqual(plan.missingPrerequisites, []);

    await store.adopt(eventsToApply(plan));
    assert.equal(store.state.txns.size, 1);
    assert.equal(store.state.budgets.get('home')!.envelopes.size, 1);
    assert.ok(store.state.months.has('home:2026-08'));
    assert.equal(store.state.owner, 'bob', 'the restorer still owns it');
  });
});

describe('a split survives a restore', () => {
  test('a backup with a divided receipt restores under facts into an empty household, parts and all', async () => {
    const hh = new Households(await dir());
    const { store: from } = await hh.create('alice', 'Rivera');
    await from.append('alice', [
      { op: 'category.define', category: 'food', label: 'Groceries' },
      { op: 'category.define', category: 'elec', label: 'Electricity' },
      { op: 'txn.add', txns: [
        { id: 'c1', date: '2026-08-02', payee: 'BIGBOX', amount: parseDollars('-100.00'), dedupeKey: 'c1', category: null }] },
      { op: 'txn.split', txn: 'c1', parts: [
        { category: 'food', amount: parseDollars('-60.00') }, { category: 'elec', amount: parseDollars('-40.00') }] },
    ]);
    const backup = parseBackup(await readFile(from.path, 'utf8'));

    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, backup, ['facts']);
    assert.deepEqual(plan.collisions, []);
    await store.adopt(eventsToApply(plan));
    const t = store.state.txns.get('c1')!;
    assert.equal(t.category, '__split');
    assert.deepEqual(t.split, [
      { category: 'food', amount: parseDollars('-60.00') }, { category: 'elec', amount: parseDollars('-40.00') }]);
  });
});

describe('an envelope with no figure yet survives a restore', () => {
  test('the flag and the source come back with the budget', async () => {
    const hh = new Households(await dir());
    const { store: from } = await hh.create('alice', 'Rivera');
    await from.append('alice', [
      { op: 'category.define', category: 'rent', label: 'Rent' },
      { op: 'budget.create', budget: 'home', label: 'Home' },
      { op: 'envelope.define', budget: 'home', envelope: 'rent', label: 'Rent', group: 'House',
        match: { categories: ['rent'] }, template: parseDollars('1500.00'), order: 0,
        needsFigure: true, source: 'Rent index, Placitas, 2026-06' },
    ]);
    const backup = parseBackup(await readFile(from.path, 'utf8'));

    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, backup, ['facts', 'budgets']);
    assert.deepEqual(plan.collisions, []);
    await store.adopt(eventsToApply(plan));
    const env = store.state.budgets.get('home')!.envelopes.get('rent')!;
    assert.equal(env.needsFigure, true);
    assert.equal(env.source, 'Rent index, Placitas, 2026-06');
  });
});

describe('an edited split survives a restore', () => {
  /** A receipt divided in two, divided again in three, and optionally sorted whole at the end. */
  const chainBackup = async (wholeAtEnd: boolean) => {
    const hh = new Households(await dir());
    const { store: from } = await hh.create('alice', 'Rivera');
    await from.append('alice', [
      { op: 'category.define', category: 'food', label: 'Groceries' },
      { op: 'category.define', category: 'elec', label: 'Electricity' },
      { op: 'category.define', category: 'fun', label: 'Fun' },
      { op: 'txn.add', txns: [
        { id: 'c1', date: '2026-08-02', payee: 'BIGBOX', amount: parseDollars('-100.00'), dedupeKey: 'c1', category: null }] },
      { op: 'txn.split', txn: 'c1', parts: [
        { category: 'food', amount: parseDollars('-60.00') }, { category: 'elec', amount: parseDollars('-40.00') }] },
      { op: 'txn.split', txn: 'c1', parts: [
        { category: 'food', amount: parseDollars('-50.00') }, { category: 'elec', amount: parseDollars('-30.00') },
        { category: 'fun', amount: parseDollars('-20.00') }] },
      ...(wholeAtEnd ? [{ op: 'txn.categorize' as const, txn: 'c1', category: 'food', manual: true }] : []),
    ]);
    return parseBackup(await readFile(from.path, 'utf8'));
  };

  test('a second split replaces the first when restored under facts', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, await chainBackup(false), ['facts']);
    assert.deepEqual(plan.collisions, []);
    await store.adopt(eventsToApply(plan));
    assert.deepEqual(store.state.txns.get('c1')!.split, [
      { category: 'food', amount: parseDollars('-50.00') }, { category: 'elec', amount: parseDollars('-30.00') },
      { category: 'fun', amount: parseDollars('-20.00') }]);
  });

  test('a chain that ends in a categorize restores to a whole receipt', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, await chainBackup(true), ['facts']);
    await store.adopt(eventsToApply(plan));
    const t = store.state.txns.get('c1')!;
    assert.equal(t.category, 'food');
    assert.equal(t.split, undefined);
  });
});

describe('a restore carries history rather than re-making it', () => {
  /** A log with a deletion nobody gave a reason for — as old logs have. */
  const backupOf = async (): Promise<string> => {
    const hh = new Households(await dir());
    const { store } = await hh.create('alice', 'Rivera');
    await store.append('alice', [
      { op: 'category.define', category: 'food', label: 'Groceries', kind: 'People' },
      { op: 'txn.add', txns: [
        { id: 't1', date: '2026-03-04', payee: 'SAFEWAY', amount: parseDollars('-64.10'), dedupeKey: 't1', category: 'food' },
        { id: 't2', date: '2026-03-05', payee: 'DUPLICATE', amount: parseDollars('-10.00'), dedupeKey: 't2', category: 'food' },
      ] },
    ]);
    // Written straight to the file, as a log from before reasons were required.
    const path = hh.path('rivera');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path, JSON.stringify({
      id: 'old-000099', at: '2026-03-06T01:02:03.000Z', who: 'alice', op: 'txn.remove', txn: 't2',
    }) + '\n', 'utf8');
    return readFile(path, 'utf8');
  };

  test('a reasonless deletion restores, because a reason cannot be invented later', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts']);
    await store.adopt(eventsToApply(plan));
    assert.equal(store.state.txns.size, 1, 'the deletion took effect');
    assert.ok(!store.state.txns.has('t2'));
  });

  test('the same events written as new would be refused', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts']);
    const asNew = eventsToApply(plan).map(({ id, at, who, ...rest }) => rest);
    await assert.rejects(() => store.append('bob', asNew as never), /requires a reason/);
  });

  test('dates and actors survive: the restorer is not who spent the money', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts']);
    await store.adopt(eventsToApply(plan));

    const lines = (await readFile(store.path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Event);
    const removal = lines.find((e) => e.op === 'txn.remove')!;
    assert.equal(removal.id, 'old-000099', 'kept its identity');
    assert.equal(removal.at, '2026-03-06T01:02:03.000Z', 'kept its date');
    assert.equal(removal.who, 'alice', 'kept its author, who is not bob');
  });

  test('the same backup twice is refused on identity, not merged', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const backup = await backupOf();
    await store.adopt(eventsToApply(planRestore(store.state, parseBackup(backup), ['facts'])));

    // The plan itself catches this first; adopt is the last line of defence for
    // a caller that skipped the plan.
    const second = parseBackup(backup).events.filter((e) => e.op === 'category.define');
    await assert.rejects(() => store.adopt([...second]), /already in this log/);
  });

  test('an adopted id cannot be handed out again to a new event', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    await store.adopt(eventsToApply(planRestore(store.state, parseBackup(await backupOf()), ['facts'])));

    const [made] = await store.append('bob', {
      op: 'category.define', category: 'fuel', label: 'Fuel', kind: 'House',
    });
    const seen = new Set((await readFile(store.path, 'utf8')).trim().split('\n')
      .map((l) => (JSON.parse(l) as Event).id));
    assert.equal(seen.size, store.state.eventCount, 'every id in the log is distinct');
    assert.ok(made, 'the new event was written');
  });
});

describe('a collision refuses, and says what it was', () => {
  const backupOf = async (): Promise<string> => {
    const hh = new Households(await dir());
    const { store } = await hh.create('alice', 'Rivera');
    await furnished(store);
    return readFile(store.path, 'utf8');
  };

  test('the same category id meaning something else', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    await store.append('bob', { op: 'category.define', category: 'food', label: 'Eating out', kind: 'People' });

    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts']);
    const c = plan.collisions.find((x) => x.kind === 'category')!;
    assert.equal(c.what, 'food');
    assert.match(c.why, /already calls "food" Eating out/);
    assert.throws(() => eventsToApply(plan), /nothing was restored/);
  });

  test('a category with the same id and the same meaning is not a collision', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    await store.append('bob', { op: 'category.define', category: 'food', label: 'Groceries', kind: 'People' });
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts']);
    assert.equal(plan.collisions.filter((c) => c.kind === 'category').length, 0);
  });

  test('a receipt already in the ledger', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    await store.append('bob', [
      { op: 'category.define', category: 'food', label: 'Groceries', kind: 'People' },
      { op: 'txn.add', txns: [
        { id: 't1', date: '2026-08-02', payee: 'SAFEWAY', amount: parseDollars('-64.10'), dedupeKey: 't1', category: 'food' },
      ] },
    ]);
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts']);
    assert.ok(plan.collisions.some((c) => c.kind === 'transaction'));
  });

  test('an incoming envelope claiming a category something here already feeds on', async () => {
    // Two envelopes over one category makes a receipt land in whichever was
    // defined last — silently, and differently after every replay.
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    await store.append('bob', [
      { op: 'category.define', category: 'food', label: 'Groceries', kind: 'People' },
      { op: 'budget.create', budget: 'home', label: 'Home' },
      { op: 'envelope.define', budget: 'home', envelope: 'other', label: 'Something else',
        group: 'People', match: { categories: ['food'] }, template: parseDollars('50.00'), order: 0 },
    ]);
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts', 'budgets']);
    const c = plan.collisions.find((x) => x.kind === 'envelope-category')!;
    assert.match(c.why, /food already feeds Something else/);
    assert.throws(() => eventsToApply(plan), /collision/);
  });

  test('nothing is written when a plan is refused', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    await store.append('bob', { op: 'budget.create', budget: 'home', label: 'Home' });
    const before = store.state.eventCount;

    const plan = planRestore(store.state, parseBackup(await backupOf()), ['facts', 'budgets']);
    assert.ok(plan.collisions.length > 0);
    assert.throws(() => eventsToApply(plan));
    assert.equal(store.state.eventCount, before, 'planning never writes');
  });
});

describe('restoring a whole household from a file', () => {
  test('it becomes a household of its own, owned by whoever restored it', async () => {
    // A backup from another machine names people who may not exist here. A
    // household nobody present can administer is worse than one with a new owner.
    const source = new Households(await dir());
    const a = await source.create('someone-else', 'Theirs');
    await furnished(a.store);
    const text = await readFile(a.store.path, 'utf8');

    const hh = new Households(await dir());
    const { id, store } = await hh.createFromLog('alice', 'Restored',
      parseBackup(text).events as Event[]);

    assert.equal(id, 'restored');
    assert.equal(store.state.txns.size, 1, 'the money came with it');
    assert.equal(store.state.owner, 'alice', 'and the person holding the file owns it');
    assert.equal(store.state.members.has('someone-else'), false,
      'the other machine\'s accounts are left behind — they may not exist here');
  });

  test('it refuses to land on top of a household that exists', async () => {
    const hh = new Households(await dir());
    await hh.create('alice', 'Rivera');
    await assert.rejects(
      () => hh.createFromLog('alice', 'Rivera', []), /already exists/);
  });
});

describe('restoring a whole household keeps its zone and model, and chooses its own folder', () => {
  test('zone and model are written again by the new owner; folder, moves and booking are dropped, and it says so', async () => {
    const source = new Households(await dir());
    const a = await source.create('someone-else', 'Theirs');
    await a.store.append('someone-else', [{ op: 'household.zone', zone: 'America/Denver' },
      { op: 'envelopes.model', model: 'claude-sonnet-5-5' }, { op: 'guests.booking', on: true },
      { op: 'documents.folder', team: 'Planner', folder: 'theirs', source: 'owner' }]);
    const hh = new Households(await dir());
    const { store, summary } = await hh.createFromLog('alice', 'Restored', parseBackup(await readFile(a.store.path, 'utf8')).events as Event[]);
    assert.equal(store.state.zone, 'America/Denver');
    assert.equal(store.state.settings.model, 'claude-sonnet-5-5');
    assert.equal(store.state.documents.folder, null);
    assert.equal(store.state.settings.booking, null);
    const last = (await store.since(null)).slice(-2);
    assert.deepEqual(last.map((e) => [e.op, e.who]), [['household.zone', 'alice'], ['envelopes.model', 'alice']]);
    assert.match(summary.join(' '), /chooses its own folder/);
    assert.ok(summary.includes('kept the time zone, America/Denver'));
    assert.ok(summary.includes('kept the envelope model, claude-sonnet-5-5'));
  });

  test('the latest zone wins, a model of the default is kept as the default, and a backup without choices says nothing', async () => {
    const source = new Households(await dir());
    const a = await source.create('someone-else', 'Theirs');
    await a.store.append('someone-else', [{ op: 'household.zone', zone: 'America/Denver' },
      { op: 'household.zone', zone: 'Europe/London' }, { op: 'envelopes.model', model: null }]);
    const hh = new Households(await dir());
    const kept = await hh.createFromLog('alice', 'Restored', parseBackup(await readFile(a.store.path, 'utf8')).events as Event[]);
    assert.equal(kept.store.state.zone, 'Europe/London');
    assert.deepEqual(kept.summary, ['kept the time zone, Europe/London', 'kept the envelope model, the default']);

    const plain = await source.create('someone-else', 'Plain');
    const bare = await hh.createFromLog('alice', 'Bare', parseBackup(await readFile(plain.store.path, 'utf8')).events as Event[]);
    assert.deepEqual(bare.summary, []);
    assert.equal(bare.store.state.zone, null);
  });

  test('restoring settings in place from another owner is still refused, and writes nothing', async () => {
    const source = new Households(await dir());
    const a = await source.create('someone-else', 'Theirs');
    await a.store.append('someone-else', { op: 'household.zone', zone: 'America/Denver' });
    const backup = parseBackup(await readFile(a.store.path, 'utf8'));

    const target = await new Households(await dir()).create('alice', 'Mine');
    const before = target.store.state.eventCount;
    const events = eventsToApply(planRestore(target.store.state, backup, ['settings']));
    assert.equal(events.length, 1);
    await assert.rejects(() => target.store.adopt(events), /owner/);
    assert.equal(target.store.state.eventCount, before);
    assert.equal(target.store.state.zone, null);
  });

  test("restoring settings in place leaves the folder alone: the backup's choice and moves are not taken, and it says so", async () => {
    const hh = new Households(await dir());
    const a = await hh.create('alice', 'Before');
    await a.store.append('alice', [{ op: 'household.zone', zone: 'America/Denver' },
      { op: 'documents.folder', team: 'Planner', folder: 'before', source: 'owner' }]);
    const backup = parseBackup(await readFile(a.store.path, 'utf8'));

    const target = await hh.create('alice', 'Mine');
    await target.store.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'mine', source: 'owner' });
    const plan = planRestore(target.store.state, backup, ['settings']);
    assert.deepEqual(plan.take.map((e) => e.op), ['household.zone'], 'no documents.folder and no documents.moved');
    assert.equal(plan.counts.settings, 1);
    assert.ok(plan.summary.includes('This household keeps its own folder for documents: no two households share a folder.'));
    await target.store.adopt(eventsToApply(plan));
    assert.equal(target.store.state.zone, 'America/Denver');
    const { team, folder } = target.store.state.documents.folder!;
    assert.deepEqual({ team, folder }, { team: 'Planner', folder: 'mine' });
    assert.equal(target.store.state.documents.previous, null, 'no move started');

    // A backup with no folder in it says nothing of one.
    const plain = await hh.create('alice', 'Plain');
    await plain.store.append('alice', { op: 'household.zone', zone: 'Europe/London' });
    const quiet = planRestore(target.store.state, parseBackup(await readFile(plain.store.path, 'utf8')), ['settings']);
    assert.ok(!quiet.summary.some((l) => /own folder/.test(l)));
  });
});

describe('the scope of every event is decided, not guessed', () => {
  test('one band each, across the whole vocabulary', () => {
    const samples: [Event['op'], string][] = [
      ['txn.add', 'facts'], ['category.define', 'facts'], ['rule.add', 'facts'],
      ['budget.create', 'budgets'], ['envelope.define', 'budgets'], ['income.source.define', 'budgets'],
      ['month.open', 'months'], ['assign', 'months'], ['move', 'months'],
      ['household.claim', 'people'], ['member.add', 'people'], ['briefing.read', 'people'],
      ['areas.set', 'settings'], ['areas.add', 'settings'], ['areas.remove', 'settings'], ['areas.move', 'settings'],
      ['calendar.household', 'settings'], ['calendar.household.rename', 'settings'],
    ];
    for (const [op, expected] of samples) {
      assert.equal(scopeOf({ op } as Event), expected, `${op} should be ${expected}`);
    }
  });
});

describe('an old single-log install is brought forward, not stranded', () => {
  /** A log as a pre-many-households server left it: claimed by a local name. */
  const oldLog = async (owner = 'dana'): Promise<string> => {
    const path = join(await mkdtemp(join(tmpdir(), 'pb-old-')), 'events.jsonl');
    const store = new Store({ path });
    await store.load();
    await store.append(owner, { op: 'household.claim', label: 'Rivera' });
    await store.append(owner, [
      { op: 'category.define', category: 'food', label: 'Groceries', kind: 'People' },
      { op: 'txn.add', txns: [
        { id: 't1', date: '2026-03-04', payee: 'SAFEWAY', amount: parseDollars('-64.10'), dedupeKey: 't1', category: 'food' },
      ] },
    ]);
    return path;
  };

  test('the admin can open a household claimed by a name that cannot sign in', async () => {
    const hh = new Households(await dir());
    const report = await adoptSingleLog(hh, await oldLog(), 'alice');

    assert.ok(report, 'the log was adopted');
    assert.equal(report.id, 'rivera');
    assert.equal(report.owner, 'dana', 'the claim is untouched — dana still claimed it');
    assert.equal(report.addedAdmin, 'alice');

    const mine = await hh.forUser('alice');
    assert.equal(mine.length, 1, 'alice can see it');
    const store = await hh.open('rivera');
    assert.equal(store.state.txns.size, 1, 'and the money came with it');
  });

  test('the addition says why, so it does not read as a stranger appearing', async () => {
    const hh = new Households(await dir());
    await adoptSingleLog(hh, await oldLog(), 'alice');
    const lines = (await readFile(hh.path('rivera'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Event);
    const added = lines.find((e) => e.op === 'member.add')!;
    assert.equal(added.who, 'dana', 'authored by the owner, because only an owner may add a member');
    assert.match((added as { why: string }).why, /adopted as a household/);
  });

  test('an owner who can already sign in is left entirely alone', async () => {
    const hh = new Households(await dir());
    const report = await adoptSingleLog(hh, await oldLog('alice'), 'alice');
    assert.equal(report!.addedAdmin, null, 'no membership event was needed');
    const lines = (await readFile(hh.path('rivera'), 'utf8')).trim().split('\n');
    assert.ok(!lines.some((l) => l.includes('member.add')), 'nothing was appended');
  });

  test('with no admin configured, it says nobody may be able to open it', async () => {
    const hh = new Households(await dir());
    const report = await adoptSingleLog(hh, await oldLog(), null);
    assert.equal(report!.ownerless, true);
    assert.equal(report!.addedAdmin, null);
  });

  test('adoption happens once — a second boot does not clone the money', async () => {
    const hh = new Households(await dir());
    const path = await oldLog();
    await adoptSingleLog(hh, path, 'alice');
    const again = await adoptSingleLog(hh, path, 'alice');
    assert.equal(again, null, 'the second call declines');
    assert.deepEqual((await hh.ids()), ['rivera'], 'still one household');
  });

  test('a log nobody ever claimed is not adopted', async () => {
    const hh = new Households(await dir());
    const path = join(await mkdtemp(join(tmpdir(), 'pb-old-')), 'events.jsonl');
    const store = new Store({ path });
    await store.load();
    await store.append('dana', { op: 'category.define', category: 'food', label: 'Groceries', kind: 'People' });
    assert.equal(await adoptSingleLog(hh, path, 'alice'), null);
  });

  test('no log at all is not an error — a fresh install just has none', async () => {
    const hh = new Households(await dir());
    assert.equal(await adoptSingleLog(hh, join(tmpdir(), 'pb-nope', 'events.jsonl'), 'alice'), null);
  });
});

describe('plans and settings in a backup', () => {
  describe('areas one at a time in a backup are found as the fold finds them', () => {
    /** The backup's text of a household that ran `ops`, without the lines whose op is in `drop`. */
    const backupOfOps = async (ops: Parameters<Store['append']>[1], drop: readonly string[] = []) => {
      const source = await new Households(await dir()).create('alice', 'Rivera');
      await source.store.append('alice', ops);
      const text = await readFile(source.store.path, 'utf8');
      return parseBackup(text.split('\n').filter((l) => !drop.some((op) => l.includes(`"op":"${op}"`))).join('\n'));
    };
    const target = async (areas: string[]) => {
      const { store } = await fresh();
      await store.append('bob', { op: 'areas.set', areas });
      return store;
    };

    test('a move of an area the household spells differently moves the household\'s own', async () => {
      const backup = await backupOfOps([{ op: 'areas.add', area: 'Garden' }, { op: 'areas.move', area: 'Garden', to: 0 }]);
      const store = await target(['House', 'garden']);
      const plan = planRestore(store.state, backup, ['settings']);
      assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);
      await store.adopt(eventsToApply(plan));
      assert.deepEqual([...store.state.settings.areas], ['garden', 'House']);
    });

    test('a remove of an area the household spells differently removes the household\'s own', async () => {
      const backup = await backupOfOps([{ op: 'areas.add', area: 'Garden' }, { op: 'areas.remove', area: 'Garden' }]);
      const store = await target(['House', 'garden']);
      const plan = planRestore(store.state, backup, ['settings']);
      assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);
      await store.adopt(eventsToApply(plan));
      assert.deepEqual([...store.state.settings.areas], ['House']);
    });

    test('a move of an area that is not there, a remove under plans and a remove of the last area are named, and adopt would refuse each', async () => {
      const moveOnly = await backupOfOps([{ op: 'areas.add', area: 'Garden' }, { op: 'areas.move', area: 'Garden', to: 0 }], ['areas.add']);
      const a = await target(['House', 'Money']);
      const moved = planRestore(a.state, moveOnly, ['settings']);
      assert.deepEqual(moved.missingPrerequisites, ['the area "Garden" cannot be moved: it does not exist here at that point']);
      assert.throws(() => eventsToApply(moved), /nothing was restored/);

      const removal = await backupOfOps([{ op: 'areas.add', area: 'Garden' }, { op: 'areas.remove', area: 'Garden' }], ['areas.add']);
      const b = await target(['House', 'Garden']);
      await b.append('bob', [{ op: 'plan.create', plan: 'beds', title: 'Dig the beds', area: 'Garden' },
        { op: 'plan.state', plan: 'beds', state: 'done' }]);
      const held = planRestore(b.state, removal, ['settings']);
      assert.deepEqual(held.missingPrerequisites, ['the area "Garden" cannot be removed: plans are still in it']);
      assert.throws(() => eventsToApply(held), /nothing was restored/);

      const last = await target(['Garden']);
      const lone = planRestore(last.state, removal, ['settings']);
      assert.deepEqual(lone.missingPrerequisites, ['the area "Garden" cannot be removed: it would leave no area']);
      assert.throws(() => eventsToApply(lone), /nothing was restored/);
    });

    test('an area emptied by the same restore may then be removed', async () => {
      const backup = await backupOfOps([{ op: 'areas.add', area: 'Garden' },
        { op: 'plan.create', plan: 'beds', title: 'Dig the beds', area: 'Garden' }, { op: 'plan.remove', plan: 'beds', why: 'done elsewhere' },
        { op: 'areas.remove', area: 'Garden' }]);
      const store = await target(['House']);
      const plan = planRestore(store.state, backup, ['settings', 'plans']);
      assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);
      await store.adopt(eventsToApply(plan));
      assert.deepEqual([...store.state.settings.areas], ['House']);
    });
  });

  test('a plan in an area that areas.add made needs Settings taken with it, and then restores', async () => {
    const source = await new Households(await dir()).create('alice', 'Rivera');
    await source.store.append('alice', [{ op: 'areas.add', area: 'Garden' }, { op: 'areas.move', area: 'Garden', to: 0 },
      { op: 'plan.create', plan: 'beds', title: 'Dig the beds', area: 'Garden' }]);
    const backup = parseBackup(await readFile(source.store.path, 'utf8'));
    const { store } = await fresh();
    assert.match(planRestore(store.state, backup, ['plans']).missingPrerequisites.join('\n'), /"Garden" need that area, which is in the backup but not selected/);
    const plan = planRestore(store.state, backup, ['settings', 'plans']);
    assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);
    await store.adopt(eventsToApply(plan));
    assert.deepEqual([store.state.settings.areas[0], store.state.plans.get('beds')!.area], ['Garden', 'Garden']);
  });

  /** A household with a board (in a custom area), a checklist, and a Household calendar. */
  const backupOf = async (): Promise<string> => {
    const hh = new Households(await dir());
    const { store } = await hh.create('alice', 'Rivera');
    await store.append('alice', [
      { op: 'areas.set', areas: ['House', 'Garden'] },
      { op: 'calendar.household', cal_id: 'cal-1', original_cal_id: 'orig-1', name: 'Household' },
      { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'Garden' },
      { op: 'plan.state', plan: 'gate', state: 'doing' },
    ]);
    return readFile(store.path, 'utf8');
  };

  test('a plan handed to someone who is not a member here is named, and nothing is restored', async () => {
    const hh = new Households(await dir());
    const source = await hh.create('alice', 'Rivera');
    await source.store.append('alice', [{ op: 'member.add', member: 'carol', why: 'sister' },
      { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' }, { op: 'plan.hand', plan: 'gate', to: 'carol' }]);
    const { store } = await fresh();
    const plan = planRestore(store.state, parseBackup(await readFile(source.store.path, 'utf8')), ['plans']);
    assert.deepEqual(plan.collisions.map((c) => [c.kind, c.what]), [['owner', 'carol']]);
    assert.match(plan.collisions[0]!.why, /plans handed to them: add carol as a member first/);
  });

  test('plans restore into an empty household whose areas they need', async () => {
    const { store } = await fresh();
    await store.append('bob', { op: 'areas.set', areas: ['House', 'Garden'] });
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['plans']);
    assert.deepEqual(plan.collisions, []);
    assert.deepEqual(plan.missingPrerequisites, []);
    assert.match(plan.summary.join('\n'), /1 plan and everything/);

    await store.adopt(eventsToApply(plan));
    assert.equal(store.state.plans.get('gate')!.state, 'doing');
  });

  test('a second restore collides on the plan id, and says so in the preview', async () => {
    const { store } = await fresh();
    await store.append('bob', { op: 'areas.set', areas: ['House', 'Garden'] });
    const backup = parseBackup(await backupOf());
    await store.adopt(eventsToApply(planRestore(store.state, backup, ['plans'])));

    const again = planRestore(store.state, backup, ['plans']);
    const c = again.collisions.find((x) => x.kind === 'plan')!;
    assert.equal(c.what, 'Fix the gate');
    assert.match(c.why, /already a plan "gate"/);
    assert.throws(() => eventsToApply(again), /nothing was restored/);
  });

  test('plans made by, or asked of, someone who is not a member here are named, and nothing is restored', async () => {
    const hh = new Households(await dir());
    const source = await hh.create('alice', 'Rivera');
    await source.store.append('alice', [
      { op: 'member.add', member: 'carol', why: 'sister' },
      { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
      { op: 'plan.ask', plan: 'gate', to: 'carol', why: 'you have the drill' },
    ]);
    const backup = parseBackup(await readFile(source.store.path, 'utf8'));

    const { store } = await hh.create('bob', 'Fresh');
    const plan = planRestore(store.state, backup, ['plans']);
    assert.deepEqual(plan.collisions.map((c) => [c.kind, c.what]), [['owner', 'alice'], ['owner', 'carol']]);
    assert.match(plan.collisions[0]!.why, /alice is not a member of this household, and the backup has plans of theirs/);
    assert.match(plan.collisions[1]!.why, /plans asked of them: add carol as a member first/);
    assert.throws(() => eventsToApply(plan), /2 collision\(s\) — nothing was restored/);

    // With both added, the same restore goes through.
    await store.append('bob', [
      { op: 'member.add', member: 'alice', why: 'the plans are hers' },
      { op: 'member.add', member: 'carol', why: 'asked of her' },
    ]);
    const now = planRestore(store.state, backup, ['plans']);
    assert.deepEqual(now.collisions, []);
    await store.adopt(eventsToApply(now));
    assert.equal(store.state.plans.get('gate')!.asked?.to, 'carol');
  });

  test('plans into a household lacking their area report the missing prerequisite', async () => {
    const { store } = await fresh();
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['plans']);
    assert.equal(plan.missingPrerequisites.length, 1);
    assert.match(plan.missingPrerequisites[0]!, /"Garden".*in the backup but not selected/);
    assert.throws(() => eventsToApply(plan), /missing prerequisite/);
  });

  test('an area nobody has, in the backup or here, is said to be missing', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    const events = parseBackup(await backupOf()).events.filter((e) => e.op !== 'areas.set' && e.op !== 'calendar.household');
    const plan = planRestore(store.state, { ...parseBackup(''), events }, ['plans']);
    assert.match(plan.missingPrerequisites[0]!, /"Garden".*does not exist here/);
  });

  test('taking settings with the plans brings the areas the plans need', async () => {
    const { store } = await fresh();
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['settings', 'plans']);
    assert.deepEqual(plan.missingPrerequisites, []);
    assert.deepEqual(plan.collisions, []);
    await store.adopt(eventsToApply(plan));
    assert.equal(store.state.plans.get('gate')!.area, 'Garden');
    assert.equal(store.state.calendar.household!.cal_id, 'cal-1');
  });

  test('a settings restore collides on a Household calendar already set', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('bob', 'Fresh');
    await store.append('bob', { op: 'calendar.household', cal_id: 'mine', original_cal_id: 'm', name: 'Ours' });
    const plan = planRestore(store.state, parseBackup(await backupOf()), ['settings']);
    const c = plan.collisions.find((x) => x.kind === 'calendar')!;
    assert.equal(c.what, 'Household');
    assert.match(c.why, /already has a Household calendar, Ours/);
    assert.throws(() => eventsToApply(plan), /nothing was restored/);
  });

  test('a calendar restore is not a collision where none is set, and a replacement is not asked about twice', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('alice', 'Source');
    await store.append('alice', [
      { op: 'calendar.household', cal_id: 'cal-1', original_cal_id: 'o1', name: 'Household' },
      { op: 'calendar.household', cal_id: 'cal-2', original_cal_id: 'o2', name: 'Household 2', replaces: 'cal-1' },
    ]);
    const backup = parseBackup(await readFile(store.path, 'utf8'));
    const empty = await hh.create('bob', 'Fresh');
    const plan = planRestore(empty.store.state, backup, ['settings']);
    assert.deepEqual(plan.collisions, []);
    await empty.store.adopt(eventsToApply(plan));
    assert.equal(empty.store.state.calendar.household!.cal_id, 'cal-2');
  });
});

describe('a log with shelves is retired when it is opened', () => {
  const shelved = async () => {
    const hh = new Households(await dir());
    const made = await hh.create('alice', 'Rivera');
    await made.store.append('alice', [{ op: 'plan.create', plan: 'kitchen', title: 'Kitchen refresh', area: 'House' },
      { op: 'plan.create', plan: 'hinge', title: 'Fix the hinge', area: 'House', parent: 'kitchen' }]);
    return { hh, ...made, before: await readFile(made.store.path, 'utf8') };
  };
  const linesOf = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  test('the first open copies the log beside itself and appends one line from system; the next does neither', async () => {
    const { hh, id, store, before } = await shelved();
    const opened = await new Households(hh.dir).open(id);              // another process
    assert.equal(await readFile(`${store.path}.before-0.7.0`, 'utf8'), before);
    const lines = await linesOf(store.path);
    assert.deepEqual([lines.length, lines.at(-1).op, lines.at(-1).who], [before.trim().split('\n').length + 1, 'shelves.retire', 'system']);
    assert.equal(opened.state.plans.get('hinge')!.goal, 'Kitchen refresh');
    await new Households(hh.dir).open(id);
    assert.equal((await linesOf(store.path)).length, lines.length);
    assert.equal(await readFile(`${store.path}.before-0.7.0`, 'utf8'), before);   // never overwritten
  });
  test('a copy that cannot be made fails loudly and appends nothing; a copy already there stands; no shelf, no line and no copy', async () => {
    const { hh, store, before } = await shelved();
    const failing = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };
    const kept = `${store.path}.before-0.7.0`;
    await assert.rejects(retireShelves(store, failing('EACCES')), /EACCES/);
    assert.equal(await readFile(store.path, 'utf8'), before);
    for (const path of [kept, `${kept}.partial`]) await assert.rejects(readFile(path), /ENOENT/);
    await writeFile(kept, 'an earlier copy\n', 'utf8');                       // a copy already there stands, never overwritten
    assert.deepEqual([await retireShelves(store), await retireShelves(store)], [true, false]);
    assert.equal(await readFile(kept, 'utf8'), 'an earlier copy\n');
    await assert.rejects(readFile(`${kept}.partial`), /ENOENT/);
    const plain = (await hh.create('alice', 'Elsewhere')).store;
    await plain.append('alice', { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' });
    assert.equal(await retireShelves(plain), false);
    await assert.rejects(readFile(`${plain.path}.before-0.7.0`), /ENOENT/);
  });
  test('a copy cut short by a crash is never taken for the copy: the next open writes it whole and clears the leftover', async () => {
    const { hh, id, store, before } = await shelved();
    const kept = `${store.path}.before-0.7.0`;
    await writeFile(`${kept}.partial`, before.slice(0, 40), 'utf8');          // what a crash mid-copy left behind
    await new Households(hh.dir).open(id);
    assert.equal(await readFile(kept, 'utf8'), before);
    await assert.rejects(readFile(`${kept}.partial`), /ENOENT/);
    assert.equal((await readFile(store.path, 'utf8')).trim().split('\n').at(-1)!.includes('"op":"shelves.retire"'), true);
  });
});

describe('a backup made by 0.7.0', () => {
  test('restores into a fresh household, and reads cleanly against its own', async () => {
    const source = await new Households(await dir()).create('alice', 'Rivera');
    await source.store.append('alice', [{ op: 'member.add', member: 'bob', why: 'my partner' }, { op: 'areas.add', area: 'Garden' },
      { op: 'plan.create', plan: 'beds', title: 'Dig the beds', area: 'Garden' }, { op: 'plan.hand', plan: 'beds', to: 'bob', why: 'your spade' },
      { op: 'plan.goal', plan: 'beds', goal: 'New garden' }, { op: 'plan.create', plan: 'kitchen', title: 'Kitchen refresh', area: 'House' },
      { op: 'plan.create', plan: 'hinge', title: 'Fix the hinge', area: 'House', parent: 'kitchen' }]);
    assert.equal(await retireShelves(source.store), true);
    await source.store.append('bob', { op: 'goal.rename', from: 'Kitchen refresh', to: 'Kitchen' });
    const backup = parseBackup(await readFile(source.store.path, 'utf8'));
    assert.deepEqual([backup.skipped, backup.unknown], [[], []]);
    const { store } = await fresh();                                               // bob's, with alice a member
    const plan = planRestore(store.state, backup, ['settings', 'plans']);
    assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);       // system is no outsider
    await store.adopt(eventsToApply(plan));
    const beds = store.state.plans.get('beds')!;
    assert.deepEqual([beds.owner, beds.ownerFrom, beds.goal, store.state.plans.get('hinge')!.goal, store.state.hands.size], ['bob', 'alice', 'New garden', 'Kitchen', 1]);
    const own = planRestore(source.store.state, backup, ['settings']);
    assert.deepEqual([own.collisions, own.missingPrerequisites], [[], []]);
    assert.doesNotThrow(() => apply(source.store.state, own.take));                 // an area already there changes nothing
  });
  describe('goal lines in a backup are found as the fold finds them', () => {
    /** alice's backup of a household that ran `ops`, without the lines whose op is in `drop`. */
    const backupOfOps = async (ops: Parameters<Store['append']>[1], drop: readonly string[] = []) => {
      const source = await new Households(await dir()).create('alice', 'Rivera');
      await source.store.append('alice', ops);
      const text = await readFile(source.store.path, 'utf8');
      return parseBackup(text.split('\n').filter((l) => !drop.some((op) => l.includes(`"op":"${op}"`))).join('\n'));
    };
    /** bob's household, alice a member, with one plan of his toward each goal given. */
    const target = async (goals: string[]) => {
      const { store } = await fresh();
      for (const [i, goal] of goals.entries()) {
        await store.append('bob', [{ op: 'plan.create', plan: `own${i}`, title: `Own ${i}`, area: 'House' }, { op: 'plan.goal', plan: `own${i}`, goal }]);
      }
      return store;
    };
    const gate = { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' } as const;
    /** Named in the preview, refused by the restore, and refused by the fold too: the preview spoke for it. */
    const named = async (store: Store, backup: ReturnType<typeof parseBackup>, said: string, fold: RegExp) => {
      const plan = planRestore(store.state, backup, ['plans']);
      assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], [said]]);
      const before = await readFile(store.path, 'utf8');
      assert.throws(() => eventsToApply(plan), /1 missing prerequisite\(s\) — nothing was restored/);
      await assert.rejects(store.adopt([...plan.take]), fold);
      assert.equal(await readFile(store.path, 'utf8'), before, 'nothing was written');
    };

    test('a rename onto a goal this household already has is named, and nothing is restored', async () => {
      const backup = await backupOfOps([gate, { op: 'plan.goal', plan: 'gate', goal: 'Summer trip' }, { op: 'goal.rename', from: 'Summer trip', to: 'Garden' }]);
      await named(await target(['Garden']), backup,
        'the goal "Summer trip" cannot be renamed to "Garden": "Garden" is already a goal here', /"Garden" is already a goal/);
    });

    test('a rename or a remove of a goal no plan carries at that point is named, and nothing is restored', async () => {
      const ops = [gate, { op: 'plan.goal', plan: 'gate', goal: 'Summer trip' }] as const;
      const renamed = await backupOfOps([...ops, { op: 'goal.rename', from: 'Summer trip', to: 'Holiday' }], ['plan.goal']);
      await named(await target([]), renamed, 'the goal "Summer trip" cannot be renamed: no plan carries it here at that point',
        /there is no goal called Summer trip/);
      const removed = await backupOfOps([...ops, { op: 'goal.remove', goal: 'Summer trip' }], ['plan.goal']);
      await named(await target([]), removed, 'the goal "Summer trip" cannot be removed: no plan carries it here at that point',
        /there is no goal called Summer trip/);
    });

    test('a rename to the spelling this household already gives the goal is named, and nothing is restored', async () => {
      const backup = await backupOfOps([gate, { op: 'plan.goal', plan: 'gate', goal: 'summer trip' }, { op: 'goal.rename', from: 'summer trip', to: 'Summer Trip' }]);
      await named(await target(['Summer Trip']), backup,
        'the goal "Summer Trip" cannot be renamed to "Summer Trip": that is already its name', /Summer Trip is already its name/);
    });

    test('a rename with no clash here previews clean and restores, onto this household\'s plans carrying it too', async () => {
      const backup = await backupOfOps([gate, { op: 'plan.goal', plan: 'gate', goal: 'Summer trip' }, { op: 'goal.rename', from: 'Summer trip', to: 'Holiday' }]);
      const store = await target(['summer trip', 'Garden']);
      const plan = planRestore(store.state, backup, ['plans']);
      assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);
      await store.adopt(eventsToApply(plan));
      assert.deepEqual(['gate', 'own0', 'own1'].map((id) => store.state.plans.get(id)!.goal), ['Holiday', 'Holiday', 'Garden']);
    });
  });

  test('a backup holding an op this build does not know is refused whole, never read as if the line were absent', () => {
    const line = (e: object) => JSON.stringify({ at: '2026-12-01T09:00:00.000Z', who: 'alice', ...e });
    const claim = line({ id: 'x1', op: 'household.claim', label: 'Home' });
    const backup = parseBackup([claim, line({ id: 'x2', op: 'bill.set', budget: 'b' }), line({ id: 'x3', op: 'bill.set', budget: 'b' }),
      line({ id: 'x4', op: 'bill.remove', budget: 'b' })].join('\n'));
    assert.deepEqual(backup.skipped.slice(0, 2), ['line 2: unknown op bill.set', 'line 3: unknown op bill.set']);
    assert.deepEqual(backup.unknown, ['bill.set', 'bill.remove']);
    assert.equal(newerBackup(backup), 'This backup was made by a newer Home Planner. It holds bill.set and bill.remove, which this version cannot read.');
    assert.equal(newerBackup(parseBackup(claim)), null);
  });
});

describe('event ids across households', () => {
  test('two stores writing in the same millisecond never hand out the same id', async () => {
    // A backup taken from one household and restored into another is checked
    // for colliding ids; two fresh logs must not share one by chance.
    const at = new Date('2026-10-29T12:00:00Z');
    const base = await dir();
    const a = new Store({ path: join(base, 'a', 'events.jsonl'), now: () => at });
    const b = new Store({ path: join(base, 'b', 'events.jsonl'), now: () => at });
    const [ea] = await a.append('alice', { op: 'areas.set', areas: ['House'] });
    const [eb] = await b.append('bob', { op: 'areas.set', areas: ['House'] });
    assert.notEqual(ea!.id, eb!.id);
    // The format stays: base-36 milliseconds, then a six-digit sequence.
    assert.match(ea!.id, /^[0-9a-z]+-\d{6}$/);
    assert.match(eb!.id, /^[0-9a-z]+-\d{6}$/);
  });
});

describe('removing a household', () => {
  test('removing a household deletes its directory and forgets its replay', async () => {
    const hh = new Households(await dir());
    await hh.create('alex', 'Wren');
    await hh.open('wren');
    await hh.remove('wren');
    assert.ok(!(await hh.ids()).includes('wren'));
    assert.equal(existsSync(join(hh.dir, 'wren')), false);
    // Not served from the cache: opened again, there is nobody's claim in it.
    const again = await hh.open('wren');
    assert.equal(again.state.owner, null);
    assert.deepEqual(await hh.ids(), [], 'opening it did not bring it back');
  });

  test('a household made again under the same name starts empty', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('alex', 'Wren');
    await store.append('alex', { op: 'budget.create', budget: 'home', label: 'Home' });
    assert.equal(store.state.budgets.size, 1);
    await hh.remove('wren');
    const made = await hh.create('alex', 'Wren');
    assert.equal(made.id, 'wren');
    assert.equal(made.store.state.budgets.size, 0);
    assert.equal(made.store.state.owner, 'alex');
    assert.equal((await hh.open('wren')).state.budgets.size, 0);
  });

  test('an id that is not a directory name is refused before anything is touched', async () => {
    const hh = new Households(await dir());
    await hh.create('alex', 'Wren');
    await assert.rejects(hh.remove('../x'));
    await assert.rejects(hh.remove('A B'));
    await assert.rejects(hh.remove('..'));
    await assert.rejects(hh.remove(''));
    assert.deepEqual(await hh.ids(), ['wren']);
  });

  test('a store held across the removal cannot write the directory back', async () => {
    const hh = new Households(await dir());
    const { store } = await hh.create('alex', 'Wren');
    await hh.remove('wren');
    await assert.rejects(
      store.append('alex', { op: 'budget.create', budget: 'home', label: 'Home' }),
      (err: Error & { status?: number }) => err.message === 'this household was removed' && err.status === 409,
    );
    assert.equal(existsSync(join(hh.dir, 'wren')), false);
    const made = await hh.create('alex', 'Wren');
    assert.equal(made.store.state.budgets.size, 0);
    assert.equal(made.store.state.owner, 'alex');
  });

  test('an open that was loading when the household was removed is not cached', async () => {
    const d = await dir();
    await new Households(d).create('alex', 'Wren');
    // A fresh instance, so nothing is cached and open() really loads.
    const hh = new Households(d);
    const loading = hh.open('wren');   // runs up to its load, then waits on the disk
    await hh.remove('wren');           // counted before that load finishes
    const late = await loading;
    assert.equal(late.closed, true);
    await assert.rejects(late.append('alex', { op: 'budget.create', budget: 'home', label: 'Home' }));
    assert.equal(existsSync(join(d, 'wren')), false);
    const fresh = await hh.open('wren');
    assert.notEqual(fresh, late, 'the late load was never cached');
    assert.equal(fresh.state.owner, null);
  });
});
