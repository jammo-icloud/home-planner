// api/test/envelope-tools.test.ts
//
// Adding, renaming and moving envelopes and categories, and sorting a receipt,
// each by one press: the tools the page approves in the request that runs them.
//
// This file sets process.env at module scope (DSM_URL, HOUSEHOLDS_DIR and the
// rest, read once when src/ loads), so the suite depends on node --test
// running each test file in its own process.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

const dir = await mkdtemp(join(tmpdir(), 'pb-envelope-tools-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alice: { password: 'correct-horse' } },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', ADMIN_USER: 'alice', DSM_URL: `http://127.0.0.1:${nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
delete process.env['DEV_USER'];
delete process.env['DSM_PUBLIC_URL'];
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];

const { start } = await import('../src/server.ts');
const { Store } = await import('../src/store.ts');
const { replay } = await import('../src/replay.ts');
const { monthView } = await import('../src/envelopes.ts');
const { APPROVE_IN_ONE, TOOLS } = await import('../src/tools.ts');
const { cents } = await import('../src/money.ts');
type State = import('../src/types.ts').State;
type Event = import('../src/types.ts').Event;

let base = '';
let close: () => Promise<void> = async () => {};
let cookie = '';
let household = '';
let made = 0;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}

/** The answer's body, with the status it came with as `httpStatus`. */
const approve = async (name: string, args: unknown): Promise<any> => {
  const r = await call('POST', `/api/tools/${name}?approve=1`, args);
  return Object.assign(r.json, { httpStatus: r.status });
};
const propose = async (name: string, args: unknown): Promise<any> => {
  const r = await call('POST', `/api/tools/${name}`, args);
  return Object.assign(r.json, { httpStatus: r.status });
};
/** The household's state as its log on disk has it now. */
const state = (): State => replay(readFileSync(join(dir, 'households', household, 'events.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Event));
const refusedWith = async (p: Promise<any>, words: string) => {
  const r = await p;
  assert.ok(r.httpStatus >= 400 && r.httpStatus < 500, `${r.httpStatus}: ${JSON.stringify(r)}`);
  assert.equal(r.error, words);
};

before(async () => {
  const server = await start();
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'correct-horse' }),
  });
  assert.equal(login.status, 200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
});

after(async () => { await close(); await nas.close(); });

/**
 * Task 2's house, as a household of its own for every test: Food (Groceries $600, Dining $200) and
 * Fun (Gym $40, with the rule EXAMPLE GYM); September, October and November open, September closed.
 * November holds EXAMPLE MARKET $50 in Groceries (g1) and EXAMPLE MARKET $120 in no envelope (m1).
 */
beforeEach(async () => {
  household = `house-${++made}`;
  await mkdir(join(dir, 'households', household), { recursive: true });
  const seed = new Store({ path: join(dir, 'households', household, 'events.jsonl') });
  await seed.load();
  await seed.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'category.add', category: 'food', label: 'Food' },
    { op: 'category.add', category: 'fun', label: 'Fun' },
    { op: 'envelope.define', envelope: 'groceries', label: 'Groceries', category: 'food', template: cents(60000), order: 0 },
    { op: 'envelope.define', envelope: 'dining', label: 'Dining', category: 'food', template: cents(20000), order: 1 },
    { op: 'envelope.define', envelope: 'gym', label: 'Gym', category: 'fun', template: cents(4000), order: 2 },
    { op: 'rule.add', rule: 'r-example-gym', match: 'EXAMPLE GYM', envelope: 'gym' },
    { op: 'month.open', month: '2026-09', income: cents(500000) },
    { op: 'month.open', month: '2026-10', income: cents(500000) },
    { op: 'month.open', month: '2026-11', income: cents(500000) },
    { op: 'month.close', month: '2026-09', closed: true, why: 'done' },
    { op: 'txn.add', txns: [
      { id: 'g1', date: '2026-11-02', payee: 'EXAMPLE MARKET', amount: cents(-5000), dedupeKey: 'g1', envelope: 'groceries' },
      { id: 'm1', date: '2026-11-03', payee: 'EXAMPLE MARKET', amount: cents(-12000), dedupeKey: 'm1', envelope: null },
    ] },
  ]);
  seed.close();
  assert.equal((await call('POST', '/api/households/select', { household })).status, 200);
});

describe('adding by a press', () => {
  test('an envelope lands at $0 planned and $0 funded, unflagged, at the end of its category', async () => {
    const r = await approve('add_envelope', { label: 'Pets', category: 'fun' });
    const e = state().envelopes.get('pets')!;
    assert.deepEqual([e.category, e.template, e.needsFigure, r.touches.envelope], ['fun', 0, undefined, 'pets']);
    const v = monthView(state(), '2026-11')!.envelopes.find((x) => x.envelope.id === 'pets')!;
    assert.deepEqual([v.planned, v.funded], [0, 0]);
    assert.equal(r.summary, 'Add Pets under Fun');
    assert.equal(e.rollover, true);
    assert.deepEqual(monthView(state(), '2026-11')!.envelopes.map((x) => x.envelope.id), ['groceries', 'dining', 'gym', 'pets']);
    // At the end of its category, not of the list.
    await approve('add_envelope', { label: 'Takeaway', category: 'food' });
    assert.deepEqual(monthView(state(), '2026-11')!.envelopes.map((x) => x.envelope.id), ['groceries', 'dining', 'takeaway', 'gym', 'pets']);
  });
  test('a new category and its first envelope are one append', async () => {
    const before = state().eventCount;
    const r = await approve('add_envelope', { label: 'Daycare', newCategory: 'Children' });
    assert.equal(state().eventCount - before, 2);
    assert.equal(state().envelopes.get('daycare')!.category, 'children');
    assert.deepEqual(r.committed.map((e: any) => e.op), ['category.add', 'envelope.define']);
    assert.equal(r.summary, 'Add Daycare under Children');
    assert.deepEqual([...state().categories.keys()], ['food', 'fun', 'children']);
  });
  test('names are refused with words', async () => {
    await refusedWith(approve('add_envelope', { label: 'groceries ', category: 'food' }), 'There is already an envelope called Groceries.');
    await refusedWith(approve('add_envelope', { label: 'Treats', newCategory: 'food' }), 'There is already a category called Food. Choose it from the list.');
    await refusedWith(approve('add_category', { label: ' FUN' }), 'There is already a category called Fun.');
    await refusedWith(approve('change_envelope', { envelope: 'dining', label: 'GROCERIES' }), 'There is already an envelope called Groceries.');
    await refusedWith(approve('rename_category', { category: 'fun', label: 'food' }), 'There is already a category called Food.');
    await refusedWith(approve('change_envelope', { envelope: 'dining', newCategory: ' Fun ' }), 'There is already a category called Fun. Choose it from the list.');
  });
  test('a name used by a removed envelope takes a fresh id', async () => {
    const p = await propose('remove_envelope', { envelope: 'gym', why: 'cancelled the membership' });
    assert.deepEqual(p.proposal.events.map((e: any) => e.op), ['rule.remove', 'envelope.remove']);
    assert.equal((await call('POST', '/api/commit', { proposalId: p.proposal.id })).status, 200);
    const r = await approve('add_envelope', { label: 'Gym', category: 'fun' });
    assert.equal(r.touches.envelope, 'gym-2');
    assert.equal(state().envelopes.get('gym-2')!.label, 'Gym');
    assert.equal(state().envelopes.has('gym'), false);
  });
  test('a category is added by itself as an empty heading, at the end', async () => {
    const r = await approve('add_category', { label: 'Children' });
    assert.equal(r.summary, 'Add the category Children');
    assert.deepEqual([...state().categories.values()].map((c) => c.label), ['Food', 'Fun', 'Children']);
    assert.deepEqual(r.committed.map((e: any) => e.op), ['category.add']);
  });
  test('a press needs a name, and one place to put it', async () => {
    await refusedWith(approve('add_envelope', { label: ' ', category: 'food' }), 'label is required');
    await refusedWith(approve('add_envelope', { label: 'Pets' }), 'Choose a category, or name a new one.');
    await refusedWith(approve('add_envelope', { label: 'Pets', category: 'fun', newCategory: 'Animals' }), 'Choose a category, or name a new one.');
  });
});

describe('changing an envelope and the headings', () => {
  test('rename and change its category keep its figure, goal and receipts', async () => {
    const before = state().envelopes.get('groceries')!;
    const r = await approve('change_envelope', { envelope: 'groceries', label: 'Market', category: 'fun' });
    assert.equal(r.summary, 'Rename Groceries to Market and move it under Fun');
    const e = state().envelopes.get('groceries')!;
    assert.deepEqual([e.label, e.category, e.template, e.rollover, e.order], ['Market', 'fun', before.template, before.rollover, before.order]);
    assert.equal(state().txns.get('g1')!.envelope, 'groceries');
    const v = monthView(state(), '2026-11')!.envelopes.find((x) => x.envelope.id === 'groceries')!;
    assert.deepEqual([v.funded, v.activity], [60000, 5000]);
  });
  test('a rename alone and a move alone say which', async () => {
    assert.equal((await approve('change_envelope', { envelope: 'groceries', label: 'Market' })).summary, 'Rename Groceries to Market');
    assert.equal((await approve('change_envelope', { envelope: 'dining', category: 'fun' })).summary, 'Move Dining under Fun');
    const r = await approve('change_envelope', { envelope: 'dining', newCategory: 'Eating out' });
    assert.equal(r.summary, 'Move Dining under Eating out');
    assert.deepEqual(r.committed.map((e: any) => e.op), ['category.add', 'envelope.define']);
    assert.equal(state().envelopes.get('dining')!.category, 'eating-out');
    await refusedWith(approve('change_envelope', { envelope: 'dining', label: 'Dining', category: 'eating-out' }), 'nothing would change');
  });
  test('a rename keeps a savings goal, the flag and the figure as they are', async () => {
    const goal = { kind: 'every' as const, estimate: { cost: cents(120000), everyYears: 4 } };
    const s = new Store({ path: join(dir, 'households', household, 'events.jsonl') });
    await s.load();
    // Written before the server opens this household, so it reads it.
    await s.append('alice', [{ op: 'envelope.define', envelope: 'roof', label: 'Roof', category: 'fun', template: cents(2500), order: 3, sinking: goal, needsFigure: true, source: 'a quote' }]);
    s.close();
    await approve('change_envelope', { envelope: 'roof', label: 'House roof' });
    const e = state().envelopes.get('roof')!;
    assert.deepEqual([e.label, e.sinking, e.needsFigure, e.source, e.template], ['House roof', goal, true, 'a quote', 2500]);
  });
  test('move up and down, refused at the ends', async () => {
    const r = await approve('move_category', { category: 'fun', direction: 'up' });
    assert.equal(r.summary, 'Move Fun up');
    assert.deepEqual([...state().categories.keys()], ['fun', 'food']);
    await refusedWith(approve('move_category', { category: 'fun', direction: 'up' }), 'Fun is already first.');
    await refusedWith(approve('move_category', { category: 'food', direction: 'down' }), 'Food is already last.');
    assert.equal((await approve('move_category', { category: 'fun', direction: 'down' })).summary, 'Move Fun down');
    assert.deepEqual([...state().categories.keys()], ['food', 'fun']);
    await refusedWith(approve('move_category', { category: 'fun', direction: 'sideways' }), "direction is 'up' or 'down'");
  });
  test('a category is renamed in place', async () => {
    const r = await approve('rename_category', { category: 'food', label: 'Food and drink' });
    assert.equal(r.summary, 'Rename Food to Food and drink');
    assert.equal(state().categories.get('food')!.label, 'Food and drink');
    assert.equal(state().envelopes.get('groceries')!.category, 'food');
    // Its own name in another case is a change, not a clash.
    assert.equal((await approve('rename_category', { category: 'food', label: 'food and drink' })).httpStatus, 200);
    await refusedWith(approve('rename_category', { category: 'food', label: 'food and drink' }), 'nothing would change');
  });
  test('a category is removed only when empty', async () => {
    await refusedWith(approve('remove_category', { category: 'food' }), 'Food still has envelopes. Move them first.');
    await approve('add_category', { label: 'Pets' });
    const r = await approve('remove_category', { category: 'pets' });
    assert.equal(r.summary, 'Remove the category Pets');
    assert.equal(state().categories.has('pets'), false);
  });
  test('a heading or envelope that went meanwhile is said, not guessed', async () => {
    await refusedWith(approve('add_envelope', { label: 'X', category: 'gone' }), 'That category is not here: it may have just been removed.');
    await refusedWith(approve('change_envelope', { envelope: 'gone', label: 'X' }), 'no envelope gone');
    for (const [name, args] of [['rename_category', { category: 'gone', label: 'X' }], ['move_category', { category: 'gone', direction: 'up' }],
      ['remove_category', { category: 'gone' }], ['change_envelope', { envelope: 'dining', category: 'gone' }]] as const) {
      const r = await approve(name, args);
      assert.deepEqual([r.httpStatus, r.error], [404, 'That category is not here: it may have just been removed.'], name);
    }
    assert.equal((await approve('change_envelope', { envelope: 'gone', label: 'X' })).httpStatus, 404);
  });
});

describe('sorting by a press', () => {
  test('sort_receipts writes at once', async () => {
    const r = await approve('sort_receipts', { assignments: [{ txnId: 'm1', envelope: 'groceries' }] });
    assert.deepEqual(r.committed.map((e: any) => e.op), ['txn.sort']);
    assert.equal(state().txns.get('m1')!.envelope, 'groceries');
    assert.equal(state().txns.get('m1')!.manual, true);
  });
  test('but never with a rule', async () => {
    const before = state().eventCount;
    await refusedWith(approve('sort_receipts', { assignments: [{ txnId: 'm1', envelope: 'groceries', alsoAddRuleMatching: 'EXAMPLE MARKET' }] }), 'A rule is shown before it is added.');
    assert.equal(state().eventCount, before);
    assert.equal(state().txns.get('m1')!.envelope, null);
    // Claude's cards keep their rule: proposed, the same call carries it.
    const p = await propose('sort_receipts', { assignments: [{ txnId: 'm1', envelope: 'groceries', alsoAddRuleMatching: 'EXAMPLE MARKET' }] });
    assert.deepEqual(p.proposal.events.map((e: any) => e.op), ['txn.sort', 'rule.add']);
  });
  test('add_rule is a proposal that says what it would cover', async () => {
    const p = await propose('add_rule', { match: 'EXAMPLE MARKET', envelope: 'groceries', txnId: 'm1' });
    assert.equal(p.httpStatus, 200, JSON.stringify(p));
    assert.deepEqual(p.proposal.events, [{ op: 'rule.add', rule: 'r-example-market', match: 'EXAMPLE MARKET', envelope: 'groceries' }]);
    assert.equal(p.proposal.summary, 'Remember "EXAMPLE MARKET" for Groceries');
    assert.ok(p.proposal.effects.some((x: string) => x.includes('Groceries')), p.proposal.effects.join('|'));
    assert.equal(state().rules.length, 1, 'nothing written until it is approved');
    assert.equal((await call('POST', '/api/commit', { proposalId: p.proposal.id })).status, 200);
    assert.deepEqual(state().rules.at(-1), { id: 'r-example-market', match: 'EXAMPLE MARKET', envelope: 'groceries' });
    // ruleProblem's refusals, said in a sentence a person reads under the rule's field.
    await refusedWith(propose('add_rule', { match: 'EX', envelope: 'groceries' }), 'A rule needs at least 3 characters to match.');
    await refusedWith(propose('add_rule', { match: 'GYM', envelope: 'groceries', txnId: 'm1' }), 'This receipt\'s payee does not contain "GYM".');
    await refusedWith(propose('add_rule', { match: 'example gym', envelope: 'gym' }), 'There is already a rule for "example gym".');
    await refusedWith(propose('add_rule', { match: 'MARKET', envelope: 'dining' }),
      'Receipts matching "MARKET" are already sorted into Groceries, so a rule for Dining would disagree with them.');
    await refusedWith(propose('add_rule', { match: 'CORNER', envelope: 'nowhere' }), 'no envelope nowhere');
    await refusedWith(propose('add_rule', { match: 'CORNER', envelope: 'dining', txnId: 'zz' }), 'no transaction zz');
    // A press never adds a rule without showing it.
    await refusedWith(approve('add_rule', { match: 'CORNER', envelope: 'dining' }), 'add_rule is not approved in one step; approve its proposal');
  });
  test('a rule for a Gym added again is offered, though the old Gym\'s receipts wait in To sort', async () => {
    const s = new Store({ path: join(dir, 'households', household, 'events.jsonl') });
    await s.load();
    // Written before the server opens this household, so it reads it.
    await s.append('alice', [{ op: 'txn.add', txns: [
      { id: 'y1', date: '2026-11-04', payee: 'EXAMPLE GYM', amount: cents(-4000), dedupeKey: 'y1', envelope: 'gym' },
      { id: 'y2', date: '2026-11-05', payee: 'EXAMPLE GYM', amount: cents(-4000), dedupeKey: 'y2', envelope: 'gym' },
    ] }]);
    s.close();
    const p = await propose('remove_envelope', { envelope: 'gym', why: 'cancelled the membership' });
    assert.equal((await call('POST', '/api/commit', { proposalId: p.proposal.id })).status, 200);
    assert.equal((await approve('add_envelope', { label: 'Gym', category: 'fun' })).touches.envelope, 'gym-2');
    assert.equal((await approve('sort_receipts', { assignments: [{ txnId: 'y1', envelope: 'gym-2' }] })).httpStatus, 200);
    const r = await propose('add_rule', { match: 'EXAMPLE GYM', envelope: 'gym-2', txnId: 'y1' });
    assert.equal(r.httpStatus, 200, JSON.stringify(r));
    assert.equal(r.proposal.summary, 'Remember "EXAMPLE GYM" for Gym');
    // y2 still names the removed Gym, and stays in To sort until a person sorts it.
    assert.equal(state().txns.get('y2')!.envelope, 'gym');
  });
  test('nothing the page calls at once is a proposal tool, and define_envelope is gone', () => {
    for (const n of ['sort_receipts', 'add_envelope', 'change_envelope', 'add_category', 'rename_category', 'move_category', 'remove_category']) assert.ok(APPROVE_IN_ONE.has(n), n);
    assert.equal(APPROVE_IN_ONE.has('add_rule'), false);
    assert.equal(TOOLS.some((t) => t.name === 'define_envelope'), false);
  });
});
