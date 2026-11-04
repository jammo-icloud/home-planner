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

describe('approving in the request that runs the tool', () => {
  test('first-run answers the step for the chosen budget', async () => {
    assert.equal((await call('GET', '/api/budget/first-run')).json.step, 'budget');
    assert.equal((await approve('create_budget', { label: 'Placitas' })).status, 200);
    const r = await call('GET', '/api/budget/first-run?budget=placitas');
    assert.equal(r.json.step, 'income');
    assert.equal(r.json.budget, 'placitas');
  });

  test('approve runs a named tool and writes it as the member, in one request', async () => {
    const r = await approve('create_budget', { label: 'Cabin' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.committed[0].op, 'budget.create');
    assert.equal(r.json.committed[0].who, 'alex');
    assert.equal(r.json.touches.budget, 'cabin');
    const list = await call('GET', '/api/budgets');
    assert.ok(list.json.budgets.some((b: any) => b.id === 'cabin'));
  });

  test('a tool outside the set is refused with approve and writes nothing', async () => {
    const last = (await approve('create_budget', { label: 'Mesa' })).json.lastEventId;
    const r = await approve('define_category', { category: 'pets', label: 'Pets' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not approved in one step/);
    const cats = await call('GET', '/api/categories');
    assert.ok(!cats.json.categories.some((c: any) => c.id === 'pets'));
    const next = (await approve('create_budget', { label: 'Vega' })).json.lastEventId;
    assert.equal(seq(next), seq(last) + 1, 'one write after the last one before the refusal');
  });

  test('a named tool that refuses writes nothing', async () => {
    const first = await approve('open_month', { budget: 'cabin', month: thisMonth, incomeCents: 0 });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const again = await approve('open_month', { budget: 'cabin', month: thisMonth, incomeCents: 0 });
    assert.ok(again.status >= 400 && again.status < 500, String(again.status));
    assert.match(again.json.error, /already open/);
    const next = await approve('create_budget', { label: 'Sandia' });
    assert.equal(seq(next.json.lastEventId), seq(first.json.lastEventId) + 1);
  });

  test('the walkthrough end to end', async () => {
    assert.equal((await approve('create_budget', { label: 'Taos' })).status, 200);
    const place = await approve('set_budget_location', { budget: 'taos', label: 'Placitas, NM', state: 'NM', why: 'where it is' });
    assert.equal(place.status, 200, JSON.stringify(place.json));
    const opened = await approve('open_month', { budget: 'taos', month: thisMonth, incomeCents: 640000 });
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    const made = await approve('make_starter_envelopes', { budget: 'taos', envelopes: starterRows });
    assert.equal(made.status, 200, JSON.stringify(made.json));

    const step = await call('GET', '/api/budget/first-run?budget=taos');
    assert.equal(step.json.step, null);
    assert.equal(step.json.location, 'Placitas, NM');
    const month = await call('POST', '/api/tools/get_month', { budget: 'taos', month: thisMonth });
    assert.equal(month.json.result.card.tone, 'warm');
    assert.equal(month.json.result.card.headline, '$6,400 still to assign');
  });

  test('Today carries the budget notices', async () => {
    const today = await call('GET', '/api/today');
    // Other budgets exist by now, so the notice names its budget.
    const mine = today.json.budget.find((n: any) => n.kind === 'figures' && /^Taos: /.test(n.text));
    assert.equal(mine.text, `Taos: ${starterRows.length} envelopes still need a figure`);
  });
});
