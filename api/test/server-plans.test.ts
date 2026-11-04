import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';
import { chooseFolderIn } from './folder.ts';

// The server reads its configuration when it loads, so this is set first and
// the modules from src/ imported after. Three real accounts: alice owns the
// Home household and has added bob; carol has a household of her own and a
// session pointed at alice's, which she is not in. Their sessions are issued
// without DSM, as a restart leaves them; alice also signs in through a fake
// DSM, on a free port, for the routes that reach the NAS (files, contacts).
const dir = await mkdtemp(join(tmpdir(), 'pb-plans-server-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alice: { password: 'correct-horse' }, bob: { password: 'battery-staple' } },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DSM_URL: `http://127.0.0.1:${nas.port}`, PLANNER_ROOT: '/Planner',
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
delete process.env['DEV_USER'];
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];
// Booking is off here, for want of everything it needs.
for (const v of ['BOOK_URL', 'BOOK_HOUSEHOLD', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[v];

/** What the server said as it booted. */
const booted: string[] = [];

const { Households } = await import('../src/households.ts');
const { COOKIE, Sessions, checkWithDsm } = await import('../src/auth.ts');
const { createContact, getEvent, listAddressbooks, listEvents, setDsmFetch } = await import('../src/synology.ts');
const { ATTACH_MAX_BYTES } = await import('../src/attachments.ts');
const { pagesIdle } = await import('../src/pages.ts');

let base = '';
let close: () => Promise<void> = async () => {};
const cookies: Record<string, string> = {};

async function call(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie: cookies[who]! },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').startsWith('application/json');
  return { status: res.status, json: isJson ? JSON.parse(text) : text };
}

const make = async (title: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await call('alice', 'POST', '/api/plans', { title, area: 'House', ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.plan.id;
};

/** The log as alice can download it, for the ids the routes do not return. */
const log = async (): Promise<any[]> =>
  ((await call('alice', 'GET', '/api/backup')).json as string).trim().split('\n').map((l) => JSON.parse(l));

/** The server's own households, so a test can write to the stores it reads. */
const households = new Households(process.env['HOUSEHOLDS_DIR']!);

before(async () => {
  const home = await households.create('alice', 'Home', { id: 'home' });
  await home.store.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
  await chooseFolderIn(home.store);
  // A file attached when the cap was larger, or by hand: its stored size is over today's cap.
  await home.store.append('alice', [
    { op: 'plan.create', plan: 'big-file', title: 'The video', area: 'House' },
    { op: 'plan.attach', plan: 'big-file', path: '/Planner/home/big-file/walkthrough.mov', name: 'walkthrough.mov',
      size: ATTACH_MAX_BYTES + 1 },
  ]);
  await households.create('carol', 'Elsewhere', { id: 'elsewhere' });

  // Issued before the server starts, so it carries them over from the file.
  const sessions = new Sessions({ path: process.env['SESSIONS_PATH']! });
  for (const who of ['alice', 'bob', 'carol']) {
    cookies[who] = `${COOKIE}=${sessions.issue(who, { household: 'home' })}`;
  }

  const { start } = await import('../src/server.ts');
  const { log: said, warn } = console;
  console.log = console.warn = (...a: unknown[]) => { booted.push(a.map(String).join(' ')); };
  let server: Awaited<ReturnType<typeof start>>;
  try { server = await start({ households }); } finally { Object.assign(console, { log: said, warn }); }
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;

  // Signed in through the fake DSM: the one session here with a NAS behind it.
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'correct-horse' }),
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).household, 'home');
  cookies['aliceDsm'] = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
});

after(async () => { await close(); await nas.close(); });

describe('the plan routes', () => {
  test('a member makes a plan directly: it is in planning, and theirs', async () => {
    const r = await call('alice', 'POST', '/api/plans', { title: 'Fix the gate', area: 'House' });
    assert.equal(r.status, 200);
    assert.equal(r.json.plan.state, 'planning');
    assert.equal(r.json.plan.owner, 'alice');
    assert.equal(r.json.plan.title, 'Fix the gate');
    // Written, not proposed: it is on the board straight away.
    const b = await call('bob', 'GET', '/api/plans');
    assert.equal(b.status, 200);
    assert.ok(b.json.areas.includes('House'));
    const house = b.json.rows.find((row: any) => row.area === 'House');
    assert.ok(house.planning.some((c: any) => c.id === r.json.plan.id));
  });

  test('a plan under an item is refused as a 400, with the fold\'s reason and no event id', async () => {
    const shelf = await make('Kitchen');
    const item = await make('Cabinets', { parent: shelf });
    const r = await call('alice', 'POST', '/api/plans', { title: 'Hinges', area: 'House', parent: item });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /two levels/);
    assert.doesNotMatch(r.json.error, /\(event /);
  });

  test('creating needs a title and an area', async () => {
    assert.equal((await call('alice', 'POST', '/api/plans', { area: 'House' })).status, 400);
    assert.equal((await call('alice', 'POST', '/api/plans', { title: '  ', area: 'House' })).status, 400);
    assert.equal((await call('alice', 'POST', '/api/plans', { title: 'x' })).status, 400);
    assert.equal((await call('alice', 'POST', '/api/plans', { title: 'x', area: 'Moon' })).status, 400);
    assert.equal((await call('alice', 'POST', '/api/plans', { title: 'x', area: 'House', parent: 7 })).status, 400);
  });

  test('only the owner asks someone to take it', async () => {
    const id = await make('Clean the gutters');
    const r = await call('bob', 'POST', `/api/plans/${id}/ask-to-take`, { to: 'alice', why: 'you have the ladder' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /only the owner/);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/ask-to-take`, { to: 'bob' })).status, 400, 'a reason is required');
  });

  test('an ask is a card for the member asked; declining clears it, keeps the owner, and settles the card', async () => {
    const id = await make('Paint the fence');
    const asked = await call('alice', 'POST', `/api/plans/${id}/ask-to-take`, { to: 'bob', why: 'you like painting' });
    assert.equal(asked.status, 200);
    assert.equal(asked.json.plan.asked.to, 'bob');

    const askEvent = (await log()).find((e) => e.op === 'plan.ask' && e.plan === id);
    const waiting = await call('bob', 'GET', '/api/thread?filter=waiting');
    assert.equal(waiting.status, 200);
    const card = waiting.json.entries.find((e: any) => e.kind === 'card' && e.offer.tool === 'answer_ask'
      && e.offer.args.plan === id);
    assert.ok(card, 'the asked member sees the card');
    assert.deepEqual(card.offer.prompt, { kind: 'ask', ref: askEvent.id });
    assert.deepEqual(card.offer.args, { plan: id, answer: 'accept' });
    assert.equal(card.offer.who, 'alice');
    assert.deepEqual(card.ask, { by: 'alice', to: 'bob', why: 'you like painting' }, 'who asked whom, and why');
    assert.deepEqual(card.plan, { id, title: 'Paint the fence' });
    // It waits on bob, and only on bob: alice is waiting on him, not on her own ask.
    const hers = await call('alice', 'GET', '/api/thread?filter=waiting');
    assert.ok(!hers.json.waiting.some((w: any) => w.kind === 'offer' && w.offer.id === card.offer.id));
    assert.ok(!hers.json.entries.some((e: any) => e.kind === 'card' && e.offer.id === card.offer.id));
    // She cannot put it off or turn it down for him: the fold says whose it is.
    for (const decision of ['snoozed', 'declined', 'approved']) {
      const r = await call('alice', 'POST', '/api/thread/decide', { offer: card.offer.id, decision, why: 'x' });
      assert.equal(r.status, 409, decision);
      assert.equal(r.json.error, 'only bob can answer that ask', decision);
    }

    assert.equal((await call('bob', 'POST', `/api/plans/${id}/answer`, { answer: 'decline' })).status, 400,
      'declining needs a reason');
    assert.equal((await call('bob', 'POST', `/api/plans/${id}/answer`, { answer: 'maybe' })).status, 400);
    const stranger = await call('alice', 'POST', `/api/plans/${id}/answer`, { answer: 'accept' });
    assert.equal(stranger.status, 400, 'only the member asked can answer');

    const r = await call('bob', 'POST', `/api/plans/${id}/answer`, { answer: 'decline', why: 'no time' });
    assert.equal(r.status, 200);
    assert.equal(r.json.plan.asked, null);
    assert.equal(r.json.plan.owner, 'alice');
    const decline = (await log()).find((e) => e.op === 'plan.ask.decline' && e.plan === id);
    assert.equal(decline.why, 'no time');
    assert.equal(decline.who, 'bob');

    // The card settles into what happened, read from bob's answer: declined by him, with his reason.
    const all = await call('bob', 'GET', '/api/thread');
    const after = all.json.entries.find((e: any) => e.kind === 'card' && e.offer.id === card.offer.id);
    assert.equal(after.offer.status, 'declined');
    assert.equal(after.offer.decidedBy, 'bob');
    assert.equal(after.offer.why, 'no time');
    const still = await call('bob', 'GET', '/api/thread?filter=waiting');
    assert.ok(!still.json.entries.some((e: any) => e.kind === 'card' && e.offer.id === card.offer.id));
  });

  test('the card\'s generic Approve takes it on, and only for the member asked', async () => {
    const id = await make('Sort the shed');
    await call('alice', 'POST', `/api/plans/${id}/ask-to-take`, { to: 'bob', why: 'your tools are in there' });
    const card = (await call('bob', 'GET', '/api/thread?filter=waiting')).json.entries
      .find((e: any) => e.kind === 'card' && e.offer.args.plan === id);
    const mine = await call('alice', 'POST', '/api/thread/decide', { offer: card.offer.id, decision: 'approved' });
    assert.equal(mine.status, 409, 'the asker cannot answer her own ask');
    const ok = await call('bob', 'POST', '/api/thread/decide', { offer: card.offer.id, decision: 'approved' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.committed.map((e: any) => e.op), ['proposal.decide', 'plan.ask.accept']);
    const v = await call('bob', 'GET', `/api/plans/${id}`);
    assert.equal(v.json.owner, 'bob');
    assert.equal(v.json.asked, null);
    const settled = (await call('alice', 'GET', '/api/thread')).json.entries.find((e: any) => e.offer?.id === card.offer.id);
    assert.equal(settled.offer.status, 'approved');
    assert.equal(settled.offer.decidedBy, 'bob');
  });

  test('the card\'s generic Decline, by the member asked, declines the ask with the reason', async () => {
    const id = await make('Mow the verge');
    await call('alice', 'POST', `/api/plans/${id}/ask-to-take`, { to: 'bob', why: 'you have the mower' });
    const card = (await call('bob', 'GET', '/api/thread?filter=waiting')).json.entries
      .find((e: any) => e.kind === 'card' && e.offer.args.plan === id);
    const bare = await call('bob', 'POST', '/api/thread/decide', { offer: card.offer.id, decision: 'declined' });
    assert.equal(bare.status, 400, 'declining needs a reason');
    const later = await call('bob', 'POST', '/api/thread/decide', { offer: card.offer.id, decision: 'snoozed' });
    assert.equal(later.status, 409);
    assert.equal(later.json.error, 'an ask is answered, not put off');
    const ok = await call('bob', 'POST', '/api/thread/decide', { offer: card.offer.id, decision: 'declined', why: 'mower is broken' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.committed.map((e: any) => e.op), ['proposal.decide', 'plan.ask.decline']);
    const v = await call('alice', 'GET', `/api/plans/${id}`);
    assert.equal(v.json.asked, null, 'the plan is no longer asked');
    assert.equal(v.json.owner, 'alice');
    // And it can be asked again, which an ask still open would refuse.
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/ask-to-take`, { to: 'bob', why: 'fixed it' })).status, 200);
  });

  test('an ask_to_take committed from the conversation raises the same card for the member asked', async () => {
    const id = await make('Paint the shed');
    const proposed = await call('alice', 'POST', '/api/tools/ask_to_take', { plan: id, to: 'bob', why: 'you chose the colour' });
    assert.equal(proposed.status, 200);
    // The route records the call's args on the proposal, whichever tool it is.
    assert.deepEqual(proposed.json.proposal.args, { plan: id, to: 'bob', why: 'you chose the colour' });
    const done = await call('alice', 'POST', '/api/commit', { proposalId: proposed.json.proposal.id });
    assert.equal(done.status, 200);
    const askEvent = (await log()).find((e) => e.op === 'plan.ask' && e.plan === id);
    const cards = (await call('bob', 'GET', '/api/thread?filter=waiting')).json.entries
      .filter((e: any) => e.kind === 'card' && e.offer.args.plan === id);
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0].offer.prompt, { kind: 'ask', ref: askEvent.id });
    assert.equal(cards[0].offer.who, 'alice');
    const r = await call('bob', 'POST', `/api/plans/${id}/answer`, { answer: 'accept' });
    assert.equal(r.json.plan.owner, 'bob');
    const settled = (await call('bob', 'GET', '/api/thread')).json.entries.find((e: any) => e.offer?.id === cards[0].offer.id);
    assert.equal(settled.offer.status, 'approved');
  });

  test('every edit is written directly, and the card reads it back', async () => {
    const id = await make('Replace the water heater');

    let r = await call('alice', 'POST', `/api/plans/${id}`, {
      title: 'Replace the heater', chips: ['waiting on quote'], notes: 'the 2009 one', estimateCents: 180000,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.plan.title, 'Replace the heater');
    assert.deepEqual(r.json.plan.chips, ['waiting on quote']);
    assert.equal(r.json.plan.estimate, 180000);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}`, {})).status, 400, 'nothing to change');
    assert.equal((await call('alice', 'POST', `/api/plans/${id}`, { chips: 'x' })).status, 400);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}`, { estimateCents: -5 })).status, 400);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}`, { estimateCents: 1.5 })).status, 400);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}`, { envelope: { budget: 'nope', envelope: 'x' } })).status, 404,
      'an envelope that is not there is a 404, as the tool answers');

    r = await call('bob', 'POST', `/api/plans/${id}/state`, { state: 'doing' });
    assert.equal(r.status, 200);
    assert.equal(r.json.plan.state, 'doing');
    assert.equal((await call('bob', 'POST', `/api/plans/${id}/state`, { state: 'started' })).status, 400);

    r = await call('alice', 'POST', `/api/plans/${id}/checklist`, { items: [
      { text: 'Get two quotes' }, { text: 'Pick one', done: true },
    ] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.plan.checklist.map((i: any) => [i.text, i.done]), [['Get two quotes', false], ['Pick one', true]]);
    assert.ok(r.json.plan.checklist.every((i: any) => typeof i.id === 'string' && i.id));
    const kept = r.json.plan.checklist[0];
    r = await call('alice', 'POST', `/api/plans/${id}/checklist`, { items: [{ ...kept, done: true }] });
    assert.deepEqual(r.json.plan.checklist, [{ ...kept, done: true }]);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/checklist`, { items: [{ text: '' }] })).status, 400);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/checklist`, { items: 'x' })).status, 400);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/checklist`, { items: [{ text: 'a', done: 'yes' }] })).status, 400);

    r = await call('alice', 'POST', `/api/plans/${id}/due`, { due: '2026-12-01' });
    assert.equal(r.json.plan.due, '2026-12-01');
    r = await call('alice', 'POST', `/api/plans/${id}/due`, { due: null });
    assert.equal(r.json.plan.due, null);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/due`, { due: 'next week' })).status, 400);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/due`, {})).status, 400);

    r = await call('alice', 'POST', `/api/plans/${id}/block`,
      { start: '2026-11-07T09:00:00.000Z', end: '2026-11-07T12:00:00.000Z' });
    assert.equal(r.status, 200);
    const block = r.json.plan.blocks[0].id;
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/block`,
      { start: '2026-11-07T12:00:00.000Z', end: '2026-11-07T09:00:00.000Z' })).status, 400);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/block`, { start: 'soon', end: 'later' })).status, 400);
    assert.equal((await call('alice', 'DELETE', `/api/plans/${id}/block/${block}`, {})).status, 400, 'a reason is required');
    r = await call('alice', 'DELETE', `/api/plans/${id}/block/${block}`, { why: 'plans changed' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.plan.blocks, []);
    assert.equal((await call('alice', 'DELETE', `/api/plans/${id}/block/${block}`, { why: 'again' })).status, 400);

    r = await call('alice', 'POST', `/api/plans/${id}/contact`, { contact_id: 12, addressbook_id: 3, display: 'Sandy Plumbing' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.plan.contacts, [{ contact_id: 12, addressbook_id: 3, display: 'Sandy Plumbing' }]);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/contact`, { contact_id: '12', addressbook_id: 3, display: 'x' })).status, 400);
    r = await call('alice', 'DELETE', `/api/plans/${id}/contact/12`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.plan.contacts, []);
    assert.equal((await call('alice', 'DELETE', `/api/plans/${id}/contact/abc`)).status, 400);

    r = await call('bob', 'POST', `/api/plans/${id}/note`, { text: 'the plumber can do Tuesday' });
    assert.equal(r.status, 200);
    assert.equal(r.json.event.op, 'thread.note');
    assert.equal(r.json.event.plan, id);
    assert.equal((await call('bob', 'POST', `/api/plans/nope/note`, { text: 'hello' })).status, 404);

    const v = await call('alice', 'GET', `/api/plans/${id}`);
    assert.equal(v.status, 200);
    assert.equal(v.json.title, 'Replace the heater');
    assert.equal(v.json.daysInState, 0);
    assert.deepEqual(v.json.between.map((n: any) => n.text), ['the plumber can do Tuesday']);
    assert.ok(v.json.history.some((h: any) => /moved Replace the heater to doing/.test(h.what)));
  });

  test('asking Claude from a card goes to the thread, and says so with no key', async () => {
    const id = await make('Find a roofer');
    const r = await call('alice', 'POST', `/api/plans/${id}/ask`, { question: 'Who does slate roofs?' });
    assert.equal(r.status, 503);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/ask`, {})).status, 400);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/ask`,
      { to: 'bob', why: 'y' })).status, 400, 'asking a person is its own route');
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/ask`,
      { question: 'x', to: 'bob', why: 'y' })).status, 400);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/ask-to-take`,
      { question: 'Who does slate roofs?' })).status, 400, 'asking Claude is its own route');
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/ask-to-take`,
      { question: 'x', to: 'bob', why: 'y' })).status, 400);
    assert.equal((await call('alice', 'GET', `/api/plans/${id}`)).json.asked, null, 'nothing was asked');
  });

  test('the board filters, and refuses a filter it does not know', async () => {
    const r = await call('bob', 'GET', '/api/plans?filter=mine&showDone=1');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.rows));
    assert.equal((await call('bob', 'GET', '/api/plans?filter=everyone')).status, 400);
  });

  test('removing needs a reason; a removed plan is gone from the card route', async () => {
    const id = await make('Old idea');
    const r = await call('alice', 'DELETE', `/api/plans/${id}`, {});
    assert.equal(r.status, 400);
    assert.equal((await call('alice', 'DELETE', `/api/plans/${id}`, { why: '  ' })).status, 400);
    assert.equal((await call('alice', 'DELETE', `/api/plans/${id}`, { why: 'not needed' })).status, 200);
    assert.equal((await call('alice', 'GET', `/api/plans/${id}`)).status, 404);
    assert.equal((await call('alice', 'POST', `/api/plans/${id}/state`, { state: 'doing' })).status, 404);
  });

  test('an unknown plan is a 404 on every plan route', async () => {
    assert.equal((await call('alice', 'GET', '/api/plans/nope')).status, 404);
    assert.equal((await call('alice', 'POST', '/api/plans/nope', { title: 'x' })).status, 404);
    assert.equal((await call('alice', 'POST', '/api/plans/nope/due', { due: null })).status, 404);
  });

  test('a session for an account that is not a member of the open household gets 403 from every /api/plans route', async () => {
    const id = await make('Private plan');
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/plans'],
      ['GET', `/api/plans/${id}`],
      ['POST', '/api/plans', { title: 'Mine now', area: 'House' }],
      ['POST', `/api/plans/${id}`, { title: 'x' }],
      ['POST', `/api/plans/${id}/state`, { state: 'doing' }],
      ['POST', `/api/plans/${id}/ask-to-take`, { to: 'carol', why: 'x' }],
      ['POST', `/api/plans/${id}/ask`, { question: 'x' }],
      ['POST', `/api/plans/${id}/answer`, { answer: 'accept' }],
      ['POST', `/api/plans/${id}/checklist`, { items: [] }],
      ['POST', `/api/plans/${id}/due`, { due: null }],
      ['POST', `/api/plans/${id}/block`, { start: '2026-11-07T09:00:00Z', end: '2026-11-07T10:00:00Z' }],
      ['DELETE', `/api/plans/${id}/block/b1`, { why: 'x' }],
      ['POST', `/api/plans/${id}/contact`, { contact_id: 1, addressbook_id: 1, display: 'x' }],
      ['DELETE', `/api/plans/${id}/contact/1`],
      ['POST', `/api/plans/${id}/note`, { text: 'x' }],
      ['DELETE', `/api/plans/${id}`, { why: 'x' }],
    ];
    for (const [method, path, body] of routes) {
      const r = await call('carol', method, path, body);
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    // And nothing she sent landed.
    const v = await call('alice', 'GET', `/api/plans/${id}`);
    assert.equal(v.json.title, 'Private plan');
    assert.equal(v.json.removed, false);
  });
});

describe('dates on the Household calendar', () => {
  /** The plan's calendar lines in the log, in order. */
  const calendarLines = async (id: string) =>
    (await log()).filter((e) => e.plan === id && (e.op.startsWith('plan.calendar.') || e.op === 'plan.due'
      || e.op === 'plan.block' || e.op === 'plan.unblock' || e.op === 'plan.remove'));
  const sid = async () => (await checkWithDsm('alice', 'correct-horse', undefined)).sid;

  test('a member signed in through DSM sets a due date: it is written with its link, and the event is on the NAS', async () => {
    const id = await make('Clean the gutters');
    let r = await call('aliceDsm', 'POST', `/api/plans/${id}/due`, { due: '2026-11-07' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.plan.due, '2026-11-07');
    assert.equal(r.json.calendar, undefined);
    let lines = await calendarLines(id);
    assert.deepEqual(lines.map((e) => e.op), ['plan.due', 'plan.calendar.link']);
    assert.equal(lines[0].at, lines[1].at, 'one write');
    const link = lines[1];
    assert.equal(link.kind, 'due');
    const ev = await getEvent(await sid(), link);
    assert.equal(ev.is_all_day, true);
    assert.equal(ev.summary, 'Clean the gutters');
    assert.equal(ev.description, 'From Home Planner · Plan › House › Clean the gutters');

    r = await call('aliceDsm', 'POST', `/api/plans/${id}/due`, { due: '2026-11-09' });
    lines = await calendarLines(id);
    assert.deepEqual(lines.slice(2).map((e) => e.op), ['plan.due', 'plan.calendar.etag']);

    // Cleared: the event is deleted and the link removed.
    r = await call('aliceDsm', 'POST', `/api/plans/${id}/due`, { due: null });
    assert.equal(r.status, 200);
    lines = await calendarLines(id);
    assert.deepEqual(lines.slice(4).map((e) => e.op), ['plan.due', 'plan.calendar.unlink']);
    await assert.rejects(getEvent(await sid(), link));
  });

  test('a block goes on as timed, and comes off when it is let go', async () => {
    const id = await make('Hang the shelves');
    let r = await call('aliceDsm', 'POST', `/api/plans/${id}/block`,
      { start: '2026-11-07T16:00:00.000Z', end: '2026-11-07T19:00:00.000Z' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const block = r.json.plan.blocks[0].id;
    let lines = await calendarLines(id);
    assert.deepEqual(lines.map((e) => [e.op, e.block]), [['plan.block', block], ['plan.calendar.link', block]]);
    assert.equal((await getEvent(await sid(), lines[1])).is_all_day, false);
    r = await call('aliceDsm', 'DELETE', `/api/plans/${id}/block/${block}`, { why: 'plans changed' });
    assert.equal(r.status, 200);
    lines = await calendarLines(id);
    assert.deepEqual(lines.slice(2).map((e) => e.op), ['plan.unblock', 'plan.calendar.unlink']);
  });

  test('removing a plan takes its events off first: the unlinks are written before the remove', async () => {
    const id = await make('Paint the fence');
    await call('aliceDsm', 'POST', `/api/plans/${id}/due`, { due: '2026-11-07' });
    const link = (await calendarLines(id))[1];
    const r = await call('aliceDsm', 'DELETE', `/api/plans/${id}`, { why: 'the landlord will' });
    assert.equal(r.status, 200);
    const lines = await calendarLines(id);
    assert.deepEqual(lines.slice(2).map((e) => e.op), ['plan.calendar.unlink', 'plan.remove']);
    assert.equal(lines[2].at, lines[3].at, 'one write');
    await assert.rejects(getEvent(await sid(), link));
  });

  test('without a NAS session a date is still set, with no event, and the answer says to sign in again', async () => {
    const id = await make('Sweep the chimney');
    let r = await call('alice', 'POST', `/api/plans/${id}/due`, { due: '2026-11-07' });
    assert.equal(r.status, 200);
    assert.equal(r.json.plan.due, '2026-11-07');
    assert.equal(r.json.calendar, 'sign in again');
    r = await call('alice', 'POST', `/api/plans/${id}/block`, { start: '2026-11-07T16:00:00.000Z', end: '2026-11-07T17:00:00.000Z' });
    assert.equal(r.json.calendar, 'sign in again');
    assert.deepEqual((await calendarLines(id)).map((e) => e.op), ['plan.due', 'plan.block']);
    // The card reads it from the plan, so it says so after any reload.
    const card = await call('alice', 'GET', `/api/plans/${id}`);
    assert.equal(card.json.notOnCalendar.due, true);
    assert.equal(card.json.notOnCalendar.blocks.length, 1);

    // "Put it on the calendar" needs the NAS; with it, both go there.
    r = await call('alice', 'POST', `/api/plans/${id}/calendar`, {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /sign in again/);
    r = await call('aliceDsm', 'POST', `/api/plans/${id}/calendar`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.plan.notOnCalendar ?? null, null, 'the route answers with the plan as stored');
    assert.deepEqual(r.json.plan.links.map((l: any) => l.kind).sort(), ['block', 'due']);
    const after = await call('alice', 'GET', `/api/plans/${id}`);
    assert.deepEqual(after.json.notOnCalendar, { due: false, blocks: [] });
  });

  test('two members setting a due date on the same plan at once leave one event and one link', async () => {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'battery-staple' }),
    });
    assert.equal(res.status, 200);
    cookies['bobDsm'] = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const id = await make('Clear the drains');
    const [a, b] = await Promise.all([
      call('aliceDsm', 'POST', `/api/plans/${id}/due`, { due: '2026-11-12' }),
      call('bobDsm', 'POST', `/api/plans/${id}/due`, { due: '2026-11-13' }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(b.status, 200, JSON.stringify(b.json));
    const links = (await calendarLines(id)).filter((e) => e.op === 'plan.calendar.link');
    assert.equal(links.length, 1, 'one link');
    const household = (await log()).find((e) => e.op === 'calendar.household');
    const onNas = (await listEvents(await sid(), {
      calendars: [{ cal_id: household.cal_id, original_cal_id: household.original_cal_id }],
      start: Date.parse('2026-11-01T00:00:00Z') / 1000, end: Date.parse('2026-11-30T00:00:00Z') / 1000,
    })).filter((e) => e.summary === 'Clear the drains');
    assert.equal(onNas.length, 1, 'one event on the NAS');
    assert.equal(onNas[0]!.evt_id, links[0].evt_id);
  });

  test('without a NAS session an event already on the calendar is not left behind: sign in again, and nothing changes', async () => {
    const id = await make('Service the boiler');
    await call('aliceDsm', 'POST', `/api/plans/${id}/due`, { due: '2026-11-07' });
    const before = (await calendarLines(id)).length;
    for (const [method, path, body] of [
      ['POST', `/api/plans/${id}/due`, { due: null }],
      ['DELETE', `/api/plans/${id}`, { why: 'sold the house' }],
    ] as const) {
      const r = await call('alice', method, path, body);
      assert.equal(r.status, 409, `${method} ${path}`);
      assert.match(r.json.error, /sign in again/);
    }
    assert.equal((await calendarLines(id)).length, before);
  });
});

/** One file, as a browser's form sends it. */
async function upload(who: string, id: string, name: string, bytes: Uint8Array): Promise<{ status: number; json: any }> {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  const res = await fetch(`${base}/api/plans/${id}/attach`, { method: 'POST', headers: { cookie: cookies[who]! }, body: form });
  return { status: res.status, json: await res.json() };
}

describe('attachments, kept on the NAS through File Station', () => {
  const png = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 251));

  test('the settings say attachments are on, where files go and how large one may be; guests are off, and say why booking is', async () => {
    const r = await call('alice', 'GET', '/api/settings');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.attachments, { on: true, root: '/Planner/home', cap: ATTACH_MAX_BYTES });
    const off = { on: false, why: 'BOOK_URL', words: "Booking is off until BOOK_URL is set in Home Planner's deployment." };
    assert.deepEqual(r.json.guests, off);
    // The switch could not be turned on either, and says who sets the page's address.
    const why = "Booking is off until the NAS's administrator sets the booking address under Settings › This NAS.";
    assert.deepEqual([r.json.booking.on, r.json.booking.available, r.json.booking.why, r.json.booking.words], [false, false, why, why]);
  });

  test('booking off: the boot log says which variable, in the words Settings uses, once', () => {
    const lines = booted.filter((l) => /Booking is off/.test(l));
    assert.deepEqual(lines, ["[budget] Booking is off until BOOK_URL is set in Home Planner's deployment."]);
  });

  test('booking off: a guest\'s waiting card can be declined, but there is no mail server, so it is a 502 that says so', async () => {
    const home = await households.open('home');
    await home.append('alice', { op: 'guest.allow', email: 'linh@example.com', name: 'Linh', why: 'from school' });
    const [card] = await home.append('guest:linh@example.com', {
      op: 'proposal.offer', tool: 'approve_booking', summary: 'Linh would like to come', effects: [], events: [],
      args: { email: 'linh@example.com', name: 'Linh', arrive: '2099-05-01', depart: '2099-05-03', headcount: 1, note: '' },
      budget: null, month: null, envelopes: [], fingerprint: '', prompt: { kind: 'booking', ref: null },
    });
    const no = await call('alice', 'POST', '/api/thread/decide', { offer: card!.id, decision: 'declined', why: 'away' });
    assert.equal(no.status, 502, JSON.stringify(no.json));
    assert.match(no.json.error, /no mail server is set/);
    const yes = await call('alice', 'POST', '/api/thread/decide', { offer: card!.id, decision: 'approved' });
    assert.equal(yes.status, 409, JSON.stringify(yes.json));
    assert.match(yes.json.error, /booking is off/i);
    assert.equal(home.state.thread.offers.get(card!.id)!.status, 'open');
  });

  test('an upload goes to <root>/<household>/<plan>/ on the NAS, and the log keeps its path and size', async () => {
    const id = await make('Fix the back gate');
    const r = await upload('aliceDsm', id, 'gate.png', png);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const path = `/Planner/home/${id}/gate.png`;
    assert.deepEqual(r.json.plan.attachments.map((a: any) => [a.path, a.name, a.size, a.who]), [[path, 'gate.png', png.length, 'alice']]);
    const attach = (await log()).filter((e) => e.op === 'plan.attach' && e.plan === id);
    assert.equal(attach.length, 1);
    assert.deepEqual([attach[0].path, attach[0].name, attach[0].size], [path, 'gate.png', png.length]);
    assert.deepEqual(new Uint8Array(await readFile(join(nas.root, path))), png);
    // The card shows it, to either member.
    const v = await call('bob', 'GET', `/api/plans/${id}`);
    assert.equal(v.json.attachments[0].name, 'gate.png');
    assert.ok(v.json.history.some((h: any) => /attached gate\.png/.test(h.what)));
  });

  test('a download is proxied through the member\'s own DSM session, with a type from its name', async () => {
    const id = await make('Paint the fence');
    assert.equal((await upload('aliceDsm', id, 'colour chart.png', png)).status, 200);
    const res = await fetch(`${base}/api/plans/${id}/files/${encodeURIComponent('colour chart.png')}`, { headers: { cookie: cookies['aliceDsm']! } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition') ?? '', /^inline; filename\*=UTF-8''colour%20chart\.png$/);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), png);
    // A file not on this card is not served, whatever is on the NAS.
    assert.equal((await call('aliceDsm', 'GET', `/api/plans/${id}/files/gate.png`)).status, 404);
  });

  test('the same name again is refused, never written over, on the card or left in its folder', async () => {
    const id = await make('Quotes');
    assert.equal((await upload('aliceDsm', id, 'quote.png', png)).status, 200);
    const again = await upload('aliceDsm', id, 'quote.png', new Uint8Array([1, 2, 3]));
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'a file with that name is already on this card');
    assert.deepEqual(new Uint8Array(await readFile(join(nas.root, `/Planner/home/${id}/quote.png`))), png, 'the first is untouched');
    assert.equal((await log()).filter((e) => e.op === 'plan.attach' && e.plan === id).length, 1);

    // Taken off the card, it stays on the NAS; a new one of that name is refused there too.
    assert.equal((await call('alice', 'DELETE', `/api/plans/${id}/files/quote.png`, { why: 'old quote' })).status, 200);
    const back = await upload('aliceDsm', id, 'quote.png', new Uint8Array([4, 5, 6]));
    assert.equal(back.status, 409);
    assert.match(back.json.error, /already in this card's folder on the NAS/);
    assert.deepEqual(new Uint8Array(await readFile(join(nas.root, `/Planner/home/${id}/quote.png`))), png);
  });

  test('a PDF is handed over as a download too; only images and text are shown in place', async () => {
    const id = await make('Warranty');
    assert.equal((await upload('aliceDsm', id, 'warranty.pdf', png)).status, 200);
    const res = await fetch(`${base}/api/plans/${id}/files/warranty.pdf`, { headers: { cookie: cookies['aliceDsm']! } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''warranty\.pdf$/);
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  });

  test('a page or a script is handed over as a download, never shown on the app\'s own origin', async () => {
    const id = await make('Read the manual');
    const page = new TextEncoder().encode('<script>alert(1)</script>'.padEnd(2048, ' '));
    assert.equal((await upload('aliceDsm', id, 'manual.html', page)).status, 200);
    const res = await fetch(`${base}/api/plans/${id}/files/manual.html`, { headers: { cookie: cookies['aliceDsm']! } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  });

  test('a session with no DSM behind it is told to sign in again, before the body is read', async () => {
    const id = await make('Measure the closet');
    const up = await upload('alice', id, 'closet.png', png);
    assert.equal(up.status, 409);
    assert.match(up.json.error, /sign in again/);
    assert.equal((await call('alice', 'GET', `/api/plans/${id}`)).json.attachments.length, 0);
  });

  test('a name that could leave the plan\'s folder, or that File Station cannot read back, is refused', async () => {
    const id = await make('Odd names');
    for (const name of ['..', 'a,b.png', 'tab\there.png', 'x'.repeat(201) + '.png', '50%2e.png', '%2F.png']) {
      const r = await upload('aliceDsm', id, name, png);
      assert.equal(r.status, 400, name);
    }
    assert.equal((await call('alice', 'GET', `/api/plans/${id}`)).json.attachments.length, 0);
  });

  test('a body over the cap is refused with 413 from its content-length, before it is read', async () => {
    const id = await make('Big upload');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/plans/${id}/attach`, {
        method: 'POST',
        headers: {
          cookie: cookies['aliceDsm']!, 'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(ATTACH_MAX_BYTES * 2),
        },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      // Nothing more is sent: the answer cannot have waited for the body.
      req.write('--x\r\n');
    });
    assert.equal(status, 413);
  });

  test('a file whose stored size is over the cap is not proxied', async () => {
    const r = await call('aliceDsm', 'GET', '/api/plans/big-file/files/walkthrough.mov');
    assert.equal(r.status, 413);
  });

  test('taking a file off the card needs a reason, and leaves it on the NAS', async () => {
    const id = await make('Quote');
    assert.equal((await upload('aliceDsm', id, 'quote.pdf', png)).status, 200);
    assert.equal((await call('bob', 'DELETE', `/api/plans/${id}/files/quote.pdf`, {})).status, 400);
    assert.equal((await call('bob', 'DELETE', `/api/plans/${id}/files/nope.pdf`, { why: 'x' })).status, 404);
    const r = await call('bob', 'DELETE', `/api/plans/${id}/files/quote.pdf`, { why: 'the wrong quote' });
    assert.equal(r.status, 200);
    assert.equal(r.json.plan.attachments.length, 0);
    const detach = (await log()).filter((e) => e.op === 'plan.detach' && e.plan === id);
    assert.deepEqual([detach[0].path, detach[0].why], [`/Planner/home/${id}/quote.pdf`, 'the wrong quote']);
    assert.deepEqual(new Uint8Array(await readFile(join(nas.root, `/Planner/home/${id}/quote.pdf`))), png);
  });

  test('every file route is a 404 for an unknown plan and a 403 for a stranger', async () => {
    assert.equal((await upload('aliceDsm', 'nope', 'a.png', png)).status, 404);
    assert.equal((await call('aliceDsm', 'GET', '/api/plans/nope/files/a.png')).status, 404);
    const id = await make('Private file');
    assert.equal((await upload('carol', id, 'a.png', png)).status, 403);
    assert.equal((await call('carol', 'GET', `/api/plans/${id}/files/a.png`)).status, 403);
    assert.equal((await call('carol', 'DELETE', `/api/plans/${id}/files/a.png`, { why: 'x' })).status, 403);
  });
});

describe('people on a card, from Synology Contacts', () => {
  let sandoval: { id: number; addressbook_id: number };

  before(async () => {
    // The address book is filled the way a member would, in Synology Contacts itself.
    const { sid } = await checkWithDsm('alice', 'correct-horse', undefined);
    const [book] = await listAddressbooks(sid);
    const made = await createContact(sid, { addressbook_id: book!.id, full_name: 'Sandoval Plumbing', phones: ['505-555-0142'], org: 'Sandoval Plumbing LLC' });
    await createContact(sid, { addressbook_id: book!.id, full_name: 'Example Mechanical', phones: ['505-555-0199'] });
    sandoval = { id: made.id, addressbook_id: made.addressbook_id };
  });

  test('a search reads the address book with the member\'s own session, and filters by name', async () => {
    const r = await call('aliceDsm', 'GET', '/api/contacts?q=sand');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.contacts.map((c: any) => [c.full_name, c.phones[0], c.addressbook_id]),
      [['Sandoval Plumbing', '505-555-0142', sandoval.addressbook_id]]);
    // No query lists them all, for "list and filter here".
    assert.equal((await call('aliceDsm', 'GET', '/api/contacts')).json.contacts.length, 2);
    // One person, for the phone number on a card.
    const one = await call('aliceDsm', 'GET', `/api/contacts/${sandoval.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.contact.full_name, 'Sandoval Plumbing');
    assert.equal((await call('aliceDsm', 'GET', '/api/contacts/abc')).status, 400);
  });

  test('a session with no DSM behind it is told to sign in again', async () => {
    const r = await call('alice', 'GET', '/api/contacts?q=sand');
    assert.equal(r.status, 409);
    assert.match(r.json.error, /sign in again/);
    assert.equal((await call('alice', 'GET', `/api/contacts/${sandoval.id}`)).status, 409);
  });

  test('a contact found is linked to a card, and the card shows it; unlinking takes it off', async () => {
    const id = await make('Tankless water heater');
    const found = (await call('aliceDsm', 'GET', '/api/contacts?q=sand')).json.contacts[0];
    const r = await call('aliceDsm', 'POST', `/api/plans/${id}/contact`,
      { contact_id: found.id, addressbook_id: found.addressbook_id, display: found.full_name });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const v = await call('bob', 'GET', `/api/plans/${id}`);
    assert.equal(v.json.contacts[0].display, 'Sandoval Plumbing');
    assert.deepEqual(v.json.contacts[0], { contact_id: sandoval.id, addressbook_id: sandoval.addressbook_id, display: 'Sandoval Plumbing' });
    assert.ok(v.json.history.some((h: any) => /linked Sandoval Plumbing/.test(h.what)));
    const off = await call('bob', 'DELETE', `/api/plans/${id}/contact/${sandoval.id}`);
    assert.equal(off.status, 200);
    assert.deepEqual(off.json.plan.contacts, []);
  });

  test('making a contact is a proposal, never a write: nothing is in the address book until it is approved', async () => {
    const before = (await call('aliceDsm', 'GET', '/api/contacts')).json.contacts.length;
    const r = await call('aliceDsm', 'POST', '/api/contacts', { full_name: 'Example Gas' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.proposal.summary, 'Add Example Gas to Contacts');
    assert.deepEqual(r.json.proposal.events, []);
    assert.equal((await call('aliceDsm', 'GET', '/api/contacts')).json.contacts.length, before);
    // With no DSM session behind the sign-in there is no address book to add to.
    const bypass = await call('alice', 'POST', '/api/contacts', { full_name: 'Example Gas' });
    assert.equal(bypass.status, 409);
    assert.match(bypass.json.error, /sign in again/);
    assert.equal((await call('aliceDsm', 'POST', '/api/contacts', {})).status, 400);
  });

  test('a stranger to the household reaches no contacts route', async () => {
    assert.equal((await call('carol', 'GET', '/api/contacts?q=sand')).status, 403);
    assert.equal((await call('carol', 'GET', `/api/contacts/${sandoval.id}`)).status, 403);
    assert.equal((await call('carol', 'POST', '/api/contacts', { full_name: 'x' })).status, 403);
  });
});

// Last in the file: a refused page holds the household's pages back for ten minutes.
describe("a plan's page in Drive follows every change", () => {
  test('a plan edit answers first; its page follows', async () => {
    const id = await make('Replace the water heater');
    const storePath = (await households.open('home')).path;
    const r = await call('aliceDsm', 'POST', `/api/plans/${id}`, { notes: 'rust on the pan' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await pagesIdle(storePath);
    assert.match(await readFile(join(nas.root, `Planner/home/${id}/plan.md`), 'utf8'), /rust on the pan/);
    const home = await households.open('home');
    const p = home.state.plans.get(id)!;
    assert.equal(p.page?.event, p.pageEvent, 'the log says the page shows the latest change');
    const doc = (await log()).filter((e) => e.op === 'plan.doc' && e.plan === id).at(-1);
    assert.equal(doc.who, 'alice');
    assert.equal(doc.doc.path, `/team-folders/Planner/home/${id}/plan.md`);
  });

  test("opening a plan's card writes its page when it is behind", async () => {
    // Written by a session with no NAS behind it: nothing is asked of Drive then.
    const id = await make('Oil the hinges');
    const storePath = (await households.open('home')).path;
    assert.equal((await call('alice', 'POST', `/api/plans/${id}`, { notes: 'the squeak' })).status, 200);
    await pagesIdle(storePath);
    assert.equal((await households.open('home')).state.plans.get(id)!.page, null, 'no session, no page');
    assert.equal((await call('aliceDsm', 'GET', `/api/plans/${id}`)).status, 200);
    await pagesIdle(storePath);
    assert.match(await readFile(join(nas.root, `Planner/home/${id}/plan.md`), 'utf8'), /the squeak/);
  });

  test('a Drive that refuses never fails a plan edit', async () => {
    const id = await make('Clear the drain');
    const storePath = (await households.open('home')).path;
    await call('aliceDsm', 'GET', `/api/plans/${id}`);
    await pagesIdle(storePath);
    const warn = mock.method(console, 'warn', () => {});
    setDsmFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if ((init?.method ?? 'GET') === 'PUT' && url.pathname.endsWith('/files/upload')) {
        return Response.json({ success: false, error: { code: 1000 } });
      }
      return fetch(input, init);
    }) as typeof fetch);
    try {
      const r = await call('aliceDsm', 'POST', `/api/plans/${id}`, { notes: 'roots in the pipe' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      await pagesIdle(storePath);
      const p = (await households.open('home')).state.plans.get(id)!;
      assert.equal(p.notes, 'roots in the pipe');
      assert.notEqual(p.page?.event, p.pageEvent, 'the page is behind');
      assert.doesNotMatch(await readFile(join(nas.root, `Planner/home/${id}/plan.md`), 'utf8'), /roots in the pipe/);
      assert.ok(warn.mock.calls.some((c) => /^\[docs\] kept in the log: /.test(String(c.arguments[0]))));
      // And the card still opens.
      assert.equal((await call('aliceDsm', 'GET', `/api/plans/${id}`)).json.notes, 'roots in the pipe');
      await pagesIdle(storePath);
    } finally {
      setDsmFetch(null);
      warn.mock.restore();
    }
  });
});
