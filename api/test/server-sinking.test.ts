import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server reads its configuration when it loads, so this is set first and
// the module imported after. The sandbox account signs in without DSM.
const dir = await mkdtemp(join(tmpdir(), 'pb-server-sinking-'));
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DEV_USER: 'tester', DSM_URL: 'http://127.0.0.1:9',
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];

const { cents } = await import('../src/money.ts');
const { Store } = await import('../src/store.ts');

const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const compact = today.replaceAll('-', '');
let base = '';
let cookie = '';
let close: () => Promise<void> = async () => {};

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json() };
}

/** Savings (5550001) with this month's statement, showing $50: the Auto envelope holds $75. */
const QFX = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><ACCTID>5550001</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>${compact}<TRNAMT>50.00<FITID>s1<NAME>Transfer from checking</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>50.00<DTASOF>${compact}</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

before(async () => {
  const seed = new Store({ path: process.env['DEV_LOG_PATH']! });
  await seed.load();
  await seed.append('tester', [
    { op: 'household.claim', label: 'Sandbox' },
    { op: 'category.define', category: 'service', label: 'Car service', sinking: { cost: cents(90000), everyYears: 1 } },
    { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
    { op: 'envelope.define', budget: 'harbor', envelope: 'auto', label: 'Auto', group: 'Future',
      match: { categories: ['service'] }, template: cents(7500), order: 0, sinking: { kind: 'every' } },
    { op: 'month.open', budget: 'harbor', month, income: cents(100000) },
  ]);
  const { start } = await import('../src/server.ts');
  const server = await start();
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'anything' }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.ok(cookie, 'signed in');
});

after(async () => { await close(); });

describe('sinking funds through the routes', () => {
  test('before any import there is no account to choose, and none can be named', async () => {
    const st = await call('GET', '/api/settings');
    assert.deepEqual(st.json.savings, { account: null, accounts: [], balance: null });
    assert.equal((await call('POST', '/api/settings/savings', { account: '5550001' })).status, 400);
    assert.equal((await call('POST', '/api/settings/savings/balance', { cents: 100 })).status, 409);
  });

  test("an OFX preview reads the statement's balance, and the commit records it with the receipts", async () => {
    const p = await call('POST', '/api/import/preview', { filename: 'savings.qfx', content: QFX, budget: 'harbor' });
    assert.equal(p.status, 200);
    assert.deepEqual(p.json.balances, [{ account: '5550001', cents: 5000, exact: '$50.00', asOf: today }]);
    assert.equal(p.json.askSavings, false);
    const c = await call('POST', '/api/import/commit', { source: 'savings.qfx', budget: 'harbor', rows: p.json.rows, balances: p.json.balances });
    assert.equal(c.status, 200);
    assert.deepEqual([c.json.added, c.json.balances], [1, 1]);
    // The same file again: nothing new, said once.
    const again = await call('POST', '/api/import/commit', { source: 'savings.qfx', budget: 'harbor', rows: [], balances: p.json.balances });
    assert.equal(again.status, 400);
  });

  test('the account is chosen from those seen, and Budget then checks the funds against it', async () => {
    const st = await call('POST', '/api/settings/savings', { account: '5550001' });
    assert.equal(st.status, 200);
    assert.equal(st.json.savings.account, '5550001');
    assert.deepEqual(st.json.savings.balance, { exact: '$50.00', asOf: today, source: 'statement', who: 'tester' });
    assert.deepEqual(st.json.savings.accounts.map((a: any) => [a.account, a.receipts]), [['5550001', 1]]);
    const m = await call('POST', '/api/tools/get_month', { budget: 'harbor' });
    assert.equal(m.json.result.savings.status, 'short');
    assert.equal(m.json.result.savings.words.verdict, 'Savings is $25 short of the sinking funds.');
    assert.equal(m.json.result.envelopes[0].sinking.monthlyExact, '$75.00');
  });

  test('a typed balance that is short raises one card on Today, which needs no Claude', async () => {
    const st = await call('POST', '/api/settings/savings/balance', { cents: 6000, budget: 'harbor' });
    assert.equal(st.status, 200);
    assert.deepEqual([st.json.savings.balance.exact, st.json.savings.balance.source], ['$60.00', 'typed']);
    const page = await call('GET', '/api/thread?budget=harbor');
    const cards = page.json.entries.filter((e: any) => e.kind === 'card' && e.offer.tool === 'savings_short');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].offer.summary, 'Savings is $15 short of the sinking funds');
    assert.ok(page.json.waiting.some((w: any) => w.kind === 'offer' && w.offer.id === cards[0].offer.id));
    assert.equal((await call('POST', '/api/tools/savings_short', { budget: 'harbor', account: '5550001' })).status, 400, 'raised only by the app');
  });

  test('a CSV asks what Savings shows today, and the answer is recorded as typed', async () => {
    const csv = 'Date,Payee,Amount\n' + `${today},GARAGE,-10.00\n`;
    const p = await call('POST', '/api/import/preview', { filename: 'checking.csv', content: csv, budget: 'harbor' });
    assert.deepEqual([p.json.askSavings, p.json.balances], [true, []]);
    const c = await call('POST', '/api/import/commit', { source: 'checking.csv', budget: 'harbor', rows: p.json.rows, savingsToday: 7500 });
    assert.deepEqual([c.json.added, c.json.balances], [1, 1]);
    const st = await call('GET', '/api/settings');
    assert.deepEqual([st.json.savings.balance.exact, st.json.savings.balance.source], ['$75.00', 'typed']);
  });

  test('a balance in the future, or not in cents, is refused', async () => {
    assert.equal((await call('POST', '/api/settings/savings/balance', { cents: 1.5 })).status, 400);
    assert.equal((await call('POST', '/api/settings/savings/balance', { cents: 100, asOf: '2999-01-01' })).status, 400);
  });
});
