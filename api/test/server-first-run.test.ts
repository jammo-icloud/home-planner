// api/test/server-first-run.test.ts
//
// This file sets process.env at module scope (DSM_URL, HOUSEHOLDS_DIR and the
// rest, read once when src/ loads), so the suite depends on node --test
// running each test file in its own process.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

const dir = await mkdtemp(join(tmpdir(), 'pb-server-first-run-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alex: { password: 'correct-horse' }, bob: { password: 'battery-staple' } },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', ADMIN_USER: 'alex', DSM_URL: `http://127.0.0.1:${nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
delete process.env['DEV_USER'];
delete process.env['DSM_PUBLIC_URL'];
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];

const { start } = await import('../src/server.ts');
const { STARTER_GROUPS } = await import('../src/starter.ts');

let base = '';
let close: () => Promise<void> = async () => {};
let alex = '';

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie: alex },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}
// An event id is a clock stamp and a count; the count says how many writes there have been.
const seq = (id: string): number => Number(id.split('-')[1]);
const approve = (tool: string, args: unknown) => call('POST', `/api/tools/${tool}?approve=1`, args);

before(async () => {
  const server = await start();
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alex', password: 'correct-horse' }),
  });
  assert.equal(login.status, 200);
  alex = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.equal((await call('POST', '/api/households', { label: 'Rivera household' })).status, 200);
});

after(async () => { await close(); await nas.close(); });

// The server reads today from the clock, so the month to open is whatever this month is.
const thisMonth = new Date().toISOString().slice(0, 7);
const starterRows = STARTER_GROUPS.flatMap((g) => g.envelopes.map((e) => ({ label: e.label, group: g.name, category: e.id })));

/** A household of its own, opened: each test that needs a budget not started makes one. */
const fresh = async (label: string) => assert.equal((await call('POST', '/api/households', { label })).status, 200);
const where = (label: string) => approve('set_location', { label, why: 'where we live' });

describe('one budget, begun by saying where it is', () => {
  test('a fresh household: the budget is not started, and the thread says so until it is', async () => {
    await fresh('Fresh start');
    const budget = await call('GET', '/api/budget');
    assert.equal(budget.status, 200);
    assert.deepEqual(budget.json, { thisMonth, lastIncomeExact: null, location: null, envelopes: 0, months: [], started: false });
    assert.equal((await call('GET', '/api/thread')).json.notStarted, true);
    assert.equal((await where('Springfield, IL')).status, 200);
    assert.equal((await call('GET', '/api/thread')).json.notStarted, undefined);
    const after = await call('GET', '/api/budget');
    assert.deepEqual([after.json.location, after.json.started], [{ label: 'Springfield, IL' }, true]);
  });

  test('a note sent with a budget is written with none', async () => {
    const r = await call('POST', '/api/thread/note', { text: 'the roof man comes Thursday', budget: 'harbor' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.event.op, 'thread.note');
    assert.equal('budget' in r.json.event, false);
  });
});

describe('approving in the request that runs the tool', () => {
  test('first-run answers the step, with no budget to ask about', async () => {
    await fresh('Placitas');
    assert.equal((await call('GET', '/api/budget/first-run')).json.step, 'where');
    assert.equal((await where('Placitas, NM')).status, 200);
    const r = await call('GET', '/api/budget/first-run');
    assert.equal(r.json.step, 'income');
    assert.equal(r.json.location, 'Placitas, NM');
  });

  test('approve runs a named tool and writes it as the member, in one request', async () => {
    const r = await where('Cabin, NM');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.committed[0].op, 'household.locate');
    assert.equal(r.json.committed[0].who, 'alex');
    assert.deepEqual(r.json.touches, { month: null, envelopes: [] });
    assert.equal((await call('GET', '/api/budget')).json.location.label, 'Cabin, NM');
  });

  test('a tool outside the set is refused with approve and writes nothing', async () => {
    const last = (await where('Mesa, NM')).json.lastEventId;
    const r = await approve('define_category', { category: 'pets', label: 'Pets' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not approved in one step/);
    const cats = await call('GET', '/api/categories');
    assert.ok(!cats.json.categories.some((c: any) => c.id === 'pets'));
    const next = (await where('Vega, NM')).json.lastEventId;
    assert.equal(seq(next), seq(last) + 1, 'one write after the last one before the refusal');
  });

  test('a named tool that refuses writes nothing', async () => {
    const first = await approve('open_month', { month: thisMonth, incomeCents: 0 });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const again = await approve('open_month', { month: thisMonth, incomeCents: 0 });
    assert.ok(again.status >= 400 && again.status < 500, String(again.status));
    assert.match(again.json.error, /already open/);
    const next = await where('Sandia, NM');
    assert.equal(seq(next.json.lastEventId), seq(first.json.lastEventId) + 1);
  });

  test('the walkthrough end to end', async () => {
    await fresh('Taos');
    const place = await approve('set_location', { label: 'Placitas, NM', state: 'NM', why: 'where it is' });
    assert.equal(place.status, 200, JSON.stringify(place.json));
    const opened = await approve('open_month', { month: thisMonth, incomeCents: 640000 });
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    const made = await approve('make_starter_envelopes', { envelopes: starterRows });
    assert.equal(made.status, 200, JSON.stringify(made.json));

    const step = await call('GET', '/api/budget/first-run');
    assert.equal(step.json.step, null);
    assert.equal(step.json.location, 'Placitas, NM');
    const month = await call('POST', '/api/tools/get_month', { month: thisMonth });
    assert.equal(month.json.result.card.tone, 'warm');
    assert.equal(month.json.result.card.headline, '$6,400 still to assign');
  });

  test('two Move taps at once on a short envelope move the money once', async () => {
    await fresh('Galisteo');
    assert.equal((await approve('open_month', { month: thisMonth, incomeCents: 0 })).status, 200);
    assert.equal((await approve('make_starter_envelopes', { envelopes: starterRows })).status, 200);
    // Groceries is made short by moving out of it what it does not have.
    const out = await approve('move_money', {
      month: thisMonth, from: 'groceries', to: 'dining', amountCents: 5000, why: 'make it short',
    });
    assert.equal(out.status, 200, JSON.stringify(out.json));

    const cover = () => approve('move_money', {
      month: thisMonth, from: 'fun', to: 'groceries', amountCents: 5000,
      why: 'covered the shortfall in Groceries', onlyWhileShort: true,
    });
    // Two taps alone do not always land in the gap before the write reaches the log; five at once do.
    const taps = await Promise.all([cover(), cover(), cover(), cover(), cover()]);
    assert.deepEqual(taps.map((r) => r.status).sort(), [200, 409, 409, 409, 409], JSON.stringify(taps.map((r) => r.json.error)));
    for (const r of taps.filter((t) => t.status === 409)) assert.match(r.json.error, /Groceries is no longer short/);

    const month = await call('POST', '/api/tools/get_month', { month: thisMonth });
    const fun = month.json.result.envelopes.find((e: any) => e.id === 'fun');
    assert.equal(fun.leftExact, '-$50.00', 'Fun paid for the cover once');
    const winner = taps.find((r) => r.status === 200)!;
    assert.equal(seq(winner.json.lastEventId), seq(out.json.lastEventId) + 1, 'one write after the move out');
  });

  test('Today carries the budget notices', async () => {
    const today = await call('GET', '/api/today');
    const mine = today.json.budget.find((n: any) => n.kind === 'figures');
    assert.equal(mine.text, `${starterRows.length} envelopes still need a figure`);
  });
});
