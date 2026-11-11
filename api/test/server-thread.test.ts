import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

// The server reads its configuration when it loads, so this is set first and
// the module imported after. The sandbox account signs in without DSM and only
// ever reaches its own file. alice signs in through a fake DSM on a free port,
// for Today's drift cards; bob moves her events as a phone would.
const dir = await mkdtemp(join(tmpdir(), 'pb-server-'));
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: () => {},
  accounts: { alice: { password: 'correct-horse' }, bob: { password: 'battery-staple' } },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DEV_USER: 'tester', DSM_URL: `http://127.0.0.1:${nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
});
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];

// Imported after: DSM_URL is read when auth.ts loads, and offers.ts reaches it.
const { parseDollars } = await import('../src/money.ts');
const { Store } = await import('../src/store.ts');
const { ProposalStore } = await import('../src/tools.ts');
const { offer } = await import('../src/offers.ts');
const { setDsmFetch, getEvent, createCalendar, createEvent, shareCalendar } = await import('../src/synology.ts');
const { checkWithDsm } = await import('../src/auth.ts');
const { fake, called, said } = await import('./fake-claude.ts');
const { setClaudeClient } = await import('../src/claude.ts');

const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
let cardId = '';
let docId = '';
const DOC = { link: 'f3c1', file_id: '881', hash: 'abc', version_id: '1', path: '/team-folders/Planner/h1/today/2026-01-01-household.md' };
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

before(async () => {
  const seed = new Store({ path: process.env['DEV_LOG_PATH']! });
  await seed.load();
  await seed.append('tester', [
    { op: 'household.claim', label: 'Sandbox' },
    { op: 'category.define', category: 'groceries', label: 'Groceries' },
    { op: 'category.define', category: 'travel', label: 'Travel' },
    { op: 'budget.create', budget: 'harbor', label: 'Harbor' },
    { op: 'envelope.define', budget: 'harbor', envelope: 'food', label: 'Food', group: 'People',
      match: { categories: ['groceries'] }, template: parseDollars('600.00'), order: 0 },
    { op: 'envelope.define', budget: 'harbor', envelope: 'trip', label: 'Travel', group: 'Future',
      match: { categories: ['travel'] }, template: parseDollars('400.00'), order: 1 },
    { op: 'month.open', budget: 'harbor', month, income: parseDollars('1000.00') },
    { op: 'budget.create', budget: 'cabin', label: 'Cabin' },
    { op: 'budget.create', budget: 'attic', label: 'Attic' },
    { op: 'budget.archive', budget: 'attic', archived: true, why: 'closed' },
    { op: 'rule.add', rule: 'r-bigbox', match: 'BIGBOX', category: '__split' },
  ]);
  const [kept] = await seed.append('claude', { op: 'thread.briefing', day: '2026-01-01', source: 'household', budget: null,
    headline: 'Kept in Drive', doc: DOC, writtenBy: 'claude' });
  docId = kept!.id;
  const card = await offer({ store: seed, who: 'tester', today, proposals: new ProposalStore(), sid: null }, {
    tool: 'move_money', prompt: { kind: 'briefing', ref: null },
    args: { budget: 'harbor', month, from: 'trip', to: 'food', amountCents: 5000, why: 'trip is paid' },
  });
  cardId = card.id;

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

after(async () => { await close(); await nas.close(); });

describe('the thread routes', () => {
  test('GET /api/thread writes today\'s section and returns the page', async () => {
    const r = await call('GET', '/api/thread?budget=harbor');
    assert.equal(r.status, 200);
    assert.ok(r.json.entries.some((e: any) => e.kind === 'briefing' && e.writtenBy === 'fallback'));
    assert.ok(r.json.waiting.some((w: any) => w.kind === 'offer' && w.offer.id === cardId));
  });

  test('the route refuses a word it does not know, whole', async () => {
    const refused = async (q: string, re: RegExp) => {
      const r = await call('GET', `/api/thread?${q}`);
      assert.equal(r.status, 400, q);
      assert.match(r.json.error, re, q);
    };
    await refused('lane=money', /lane must be budget, calendar, plans, claude or notes/);
    await refused('who=nobody', /who must be a member/);
    await refused('day=2026-13-45', /day must be a date/);
    await refused('through=2026-1', /through must be a month/);
    await refused('open=nope', /open must be dates/);
    assert.equal((await call('GET', '/api/thread?at=none')).status, 404);
  });

  test('the old words change nothing', async () => {
    const plain = (await call('GET', '/api/thread')).json;
    const old = (await call('GET', '/api/thread?filter=mine&all=1&limit=1&before=e1')).json;
    assert.deepEqual(old.entries.map((e: any) => e.id), plain.entries.map((e: any) => e.id));
  });

  test('opening a day reads the record and writes no briefing', async () => {
    await call('GET', '/api/thread');
    const count = async () => (await readFile(join(dir, 'dev.jsonl'), 'utf8')).split('\n').filter((l) => l.includes('"thread.briefing"')).length;
    const before = await count();
    const r = await call('GET', `/api/thread?quiet=1&day=${today}`);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['days', 'entries', 'today']);
    assert.equal(await count(), before);
  });

  test('the day\'s briefing is the household\'s, one for every budget in view', async () => {
    const harbor = (await call('GET', '/api/thread?budget=harbor')).json;
    const cabin = (await call('GET', '/api/thread?budget=cabin')).json;
    const today = (page: any) => page.entries.filter((e: any) => e.kind === 'briefing' && e.day === new Date().toISOString().slice(0, 10));
    assert.equal(today(harbor).length, 1);
    const [b] = today(harbor);
    assert.equal(b.source, 'household');
    assert.equal(b.budget, null);
    assert.deepEqual(today(cabin).map((e: any) => e.id), [b.id], 'the same briefing, whichever budget is in view');
    // The sandbox has no Household calendar, and no NAS session to read one with.
    assert.match(b.body, /no Household calendar yet/);
  });

  test('a document needs the NAS to read; an event that is not one is 404', async () => {
    assert.equal((await call('GET', `/api/docs/${docId}`)).status, 409, 'no NAS session behind the sandbox');
    assert.equal((await call('GET', `/api/docs/${cardId}`)).status, 404, 'a card is not a document');
    const none = await call('GET', '/api/docs/nope');
    assert.equal(none.status, 404);
    assert.equal(none.json.error, 'no such document');
  });

  test('the thread names where a document is, and nothing else of it', async () => {
    const r = await call('GET', '/api/thread?day=2026-01-01');
    const kept = r.json.entries.find((e: any) => e.id === docId);
    assert.equal(kept.body, null);
    assert.deepEqual(kept.doc, { path: DOC.path });
    assert.ok(!JSON.stringify(r.json).includes(DOC.link), 'no link, id, hash or version leaves the server');
  });

  test('settings say where briefings and answers are kept', async () => {
    const r = await call('GET', '/api/settings');
    assert.equal(r.status, 200);
    assert.equal(r.json.documents.on, false);
    assert.ok(r.json.documents.why);
  });

  test('a note is recorded and shows in the thread', async () => {
    const r = await call('POST', '/api/thread/note', { text: 'trip is paid for', budget: 'harbor' });
    assert.equal(r.status, 200);
    assert.equal(r.json.event.op, 'thread.note');
    const page = await call('GET', '/api/thread?budget=harbor');
    assert.ok(page.json.entries.some((e: any) => e.kind === 'note' && e.text === 'trip is paid for'));
  });

  test('asking with no key configured says so', async () => {
    const r = await call('POST', '/api/thread/ask', { question: 'How is food?', budget: 'harbor' });
    assert.equal(r.status, 503);
  });

  test('adjust makes a new card; refresh works it out again; approve applies it once', async () => {
    const adj = await call('POST', '/api/thread/adjust', { offer: cardId, args: { amountCents: 2500 } });
    assert.equal(adj.status, 200);
    const mine = adj.json.offer.id;
    const ref = await call('POST', '/api/thread/refresh', { offer: mine });
    assert.equal(ref.status, 200);
    const fresh = ref.json.offer.id;
    const ok = await call('POST', '/api/thread/decide', { offer: fresh, decision: 'approved', why: 'trip is paid for' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.committed.map((e: any) => e.op), ['proposal.decide', 'move']);
    const again = await call('POST', '/api/thread/decide', { offer: fresh, decision: 'approved', why: 'again' });
    assert.equal(again.status, 409);
  });

  test('a flag can be marked seen', async () => {
    const r = await call('POST', '/api/thread/seen', { event: 'some-event' });
    assert.equal(r.status, 200);
  });

  test('a decision that is not one of the three is refused', async () => {
    const r = await call('POST', '/api/thread/decide', { offer: cardId, decision: 'maybe' });
    assert.equal(r.status, 400);
  });

  test('the old activity and briefing routes are gone', async () => {
    assert.equal((await call('GET', '/api/activity')).status, 404);
    assert.equal((await call('POST', '/api/briefing', {})).status, 404);
  });

  test('the import preview offers envelopes, and a commit keeps who suggested what', async () => {
    const csv = 'Date,Payee,Amount\n' + `${month}-02,HILLTOP FOODS,-42.10\n` + `${month}-03,MYSTERY SHOP,-5.00\n`;
    const p = await call('POST', '/api/import/preview', { filename: 'x.csv', content: csv, budget: 'harbor' });
    assert.equal(p.status, 200);
    assert.ok(p.json.options.some((o: any) => o.value === 'groceries' && o.label === 'Food' && o.group === 'People'));
    // No key here, so nothing is suggested and nothing says it failed.
    assert.ok(p.json.rows.every((r: any) => r.suggested === undefined));
    assert.equal(p.json.suggestError, undefined);

    const king = p.json.rows.find((r: any) => r.payee === 'HILLTOP FOODS');
    const c = await call('POST', '/api/import/commit', { source: 'x.csv', rows: [
      { ...king, category: 'groceries', suggestedBy: 'claude' },
    ] });
    assert.equal(c.status, 200);
    const page = await call('GET', '/api/thread?budget=harbor');
    assert.ok(page.json.entries.some((e: any) => e.kind === 'change' && /imported 1/.test(e.what)));
  });

  test('/api/match answers with no suggestions when no key is set', async () => {
    const r = await call('POST', '/api/match', { budget: 'harbor', txnIds: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.suggestions, {});
    assert.deepEqual(r.json.toDivide, []);
    assert.ok(Array.isArray(r.json.options));
  });

  test('the import preview marks rows a split rule caught as to-divide, not ruled', async () => {
    const csv = 'Date,Payee,Amount\n' + `${month}-02,BIGBOX WHSE #0100,-165.00\n` + `${month}-03,HILLTOP FOODS #12,-42.10\n`;
    const p = await call('POST', '/api/import/preview', { filename: 'y.csv', content: csv, budget: 'harbor' });
    assert.equal(p.status, 200);
    const bigbox = p.json.rows.find((r: any) => /BIGBOX/.test(r.payee));
    const king = p.json.rows.find((r: any) => /HILLTOP/.test(r.payee));
    assert.equal(bigbox.category, '__split');
    assert.equal(king.category, null);
    assert.equal(p.json.toDivide, 1);
    assert.equal(p.json.ruled, 0);
    assert.equal(p.json.needsSorting, 2);
    assert.ok(p.json.options.some((o: any) => o.value === '__split'));
  });

  // The log is the only place a refused row could have left a trace, so the import tests read it back.
  const logged = async () => {
    const text = await (await fetch(base + '/api/backup', { headers: { cookie } })).text();
    return text.trim().split('\n').map((l) => JSON.parse(l));
  };

  test('a split row is imported as a receipt and its split, in one batch', async () => {
    const csv = 'Date,Payee,Amount\n' + `${month}-04,BIGBOX WHSE #0999,-165.00\n`;
    const p = await call('POST', '/api/import/preview', { filename: 's.csv', content: csv, budget: 'harbor' });
    const bigbox = p.json.rows[0];
    assert.equal(bigbox.category, '__split');
    assert.equal(bigbox.amountCents, -16500);

    const c = await call('POST', '/api/import/commit', { source: 's.csv', rows: [
      { ...bigbox, split: [{ category: 'groceries', amountCents: -12000 }, { category: 'travel', amountCents: -4500 }] },
    ] });
    assert.equal(c.status, 200);
    assert.equal(c.json.added, 1);
    assert.equal(c.json.divided, 1);
    assert.equal(c.json.sorted, 1, 'a divided receipt is sorted');

    const log = await logged();
    const at = log.findIndex((e) => e.op === 'txn.add' && e.txns.some((t: any) => t.id === bigbox.id));
    assert.ok(at >= 0, 'the receipt landed');
    const added = log[at].txns.find((t: any) => t.id === bigbox.id);
    assert.equal(added.category, null, 'it arrives undivided, then the split divides it');
    assert.equal(added.suggestedBy, undefined);
    assert.equal(log[at + 1].op, 'txn.split');
    assert.equal(log[at + 1].txn, bigbox.id);
    assert.deepEqual(log[at + 1].parts, [{ category: 'groceries', amount: -12000 }, { category: 'travel', amount: -4500 }]);

    // Replay has it as a split receipt: the same file is now all duplicates.
    const again = await call('POST', '/api/import/preview', { filename: 's.csv', content: csv, budget: 'harbor' });
    assert.equal(again.json.duplicates, 1);
    assert.equal(again.json.rows.length, 0);
  });

  test('a split row that is not divided, or not balanced, is refused and nothing lands', async () => {
    const csv = 'Date,Payee,Amount\n' + `${month}-05,BIGBOX WHSE #0888,-165.00\n` + `${month}-06,HILLTOP FOODS #55,-20.00\n`;
    const p = await call('POST', '/api/import/preview', { filename: 'r.csv', content: csv, budget: 'harbor' });
    const bigbox = p.json.rows.find((r: any) => /BIGBOX/.test(r.payee));
    const king = p.json.rows.find((r: any) => /HILLTOP/.test(r.payee));
    const before = (await logged()).length;
    const refused = async (rows: any[], re: RegExp) => {
      const r = await call('POST', '/api/import/commit', { source: 'r.csv', rows });
      assert.equal(r.status, 400);
      assert.match(r.json.error, re);
    };

    // Marked to divide but sent with no parts, or with an empty list.
    await refused([{ ...king, category: 'groceries' }, { ...bigbox }], /BIGBOX WHSE #0888 is marked to divide but is not divided/);
    await refused([{ ...bigbox, split: [] }], /not divided/);
    // Parts that do not add up, a single part, a stray fraction, an unknown envelope.
    await refused([{ ...bigbox, split: [{ category: 'groceries', amountCents: -12000 }, { category: 'travel', amountCents: -4000 }] }], /add up/);
    await refused([{ ...bigbox, split: [{ category: 'groceries', amountCents: -16500 }] }], /at least two/);
    await refused([{ ...bigbox, split: [{ category: 'groceries', amountCents: -12000.5 }, { category: 'travel', amountCents: -4499.5 }] }], /whole number of cents/);
    await refused([{ ...bigbox, split: [{ category: 'groceries', amountCents: -12000 }, { category: 'nowhere', amountCents: -4500 }] }], /no category nowhere/);

    // Only the real non-spend markers stand in for an envelope; any other __ name is not a category.
    await refused([{ ...bigbox, split: [{ category: 'groceries', amountCents: -12000 }, { category: '__bogus', amountCents: -4500 }] }], /no category __bogus/);
    // A plain row is held to the same rule: only the real markers stand in for an envelope.
    await refused([{ ...bigbox, category: '__bogus' }], /no category __bogus/);
    // A malformed part is a client fault, not a crash.
    await refused([{ ...bigbox, split: [null, { category: 'travel', amountCents: -4500 }] }], /part with no category or amount/);
    await refused([{ ...bigbox, split: [{ category: 7, amountCents: -12000 }, { category: 'travel', amountCents: -4500 }] }], /part with no category or amount/);

    // Nothing was appended, so neither receipt exists: both still preview as new.
    const log = await logged();
    assert.equal(log.length, before);
    assert.ok(!log.some((e) => e.op === 'txn.add' && e.txns.some((t: any) => t.id === bigbox.id || t.id === king.id)));
    const after = await call('POST', '/api/import/preview', { filename: 'r.csv', content: csv, budget: 'harbor' });
    assert.equal(after.json.duplicates, 0);
    assert.equal(after.json.rows.length, 2);
  });

  test('the import preview carries a suggestion\'s rule and parts beside it', async () => {
    const f = fake([said(JSON.stringify({ matches: [
      { payee: 'TARGET #77', choice: '__split', confidence: 0.9, rule: 'target', parts: ['groceries', 'travel'] },
    ] }))]);
    try {
      const csv = 'Date,Payee,Amount\n' + `${month}-02,TARGET #77,-65.00\n` + `${month}-03,BIGBOX WHSE #0100,-165.00\n`;
      const p = await call('POST', '/api/import/preview', { filename: 'z.csv', content: csv, budget: 'harbor' });
      const row = p.json.rows.find((r: any) => /TARGET/.test(r.payee));
      assert.equal(row.suggested, '__split');
      assert.equal(row.rule, 'target');
      assert.deepEqual(row.parts, ['groceries', 'travel']);
      assert.doesNotMatch(JSON.stringify(f.calls[0].messages), /BIGBOX/);
    } finally { setClaudeClient(null); }
  });

  test('/api/match returns a suggestion object with its rule, and the rows a split rule covers', async () => {
    const csv = 'Date,Payee,Amount\n' + `${month}-02,HILLTOP FOODS #12 SPRINGFIELD,-42.10\n` + `${month}-03,BIGBOX WHSE #0100,-165.00\n`;
    const p = await call('POST', '/api/import/preview', { filename: 'q.csv', content: csv, budget: 'harbor' });
    // Committed unsorted on purpose: the ledger holds an open Bigbox receipt that only a rule marks as a split.
    const rows = p.json.rows.map((r: any) => ({ ...r, category: null }));
    assert.equal((await call('POST', '/api/import/commit', { source: 'q.csv', rows })).status, 200);
    const king = rows.find((r: any) => /HILLTOP/.test(r.payee)).id;
    const bigbox = rows.find((r: any) => /BIGBOX/.test(r.payee)).id;

    const f = fake([said(JSON.stringify({ matches: [
      { payee: 'HILLTOP FOODS #12 SPRINGFIELD', choice: 'groceries', confidence: 0.95, rule: 'hilltop foods' },
    ] }))]);
    try {
      const r = await call('POST', '/api/match', { budget: 'harbor', txnIds: [king, bigbox] });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.suggestions[king], { choice: 'groceries', rule: 'hilltop foods' });
      assert.equal(r.json.suggestions[bigbox], undefined);
      assert.deepEqual(r.json.toDivide, [bigbox]);
      assert.doesNotMatch(JSON.stringify(f.calls[0].messages), /BIGBOX/);
    } finally { setClaudeClient(null); }
  });

  test('/api/match with no ids still lists every open receipt a split rule covers, and asks Claude nothing', async () => {
    const csv = 'Date,Payee,Amount\n' + `${month}-04,BIGBOX WHSE #0999,-55.00\n`;
    const p = await call('POST', '/api/import/preview', { filename: 'n.csv', content: csv, budget: 'harbor' });
    const rows = p.json.rows.map((r: any) => ({ ...r, category: null }));
    assert.equal((await call('POST', '/api/import/commit', { source: 'n.csv', rows })).status, 200);
    const id = rows[0].id;

    const f = fake([]);
    try {
      const r = await call('POST', '/api/match', { budget: 'harbor', txnIds: [] });
      assert.equal(r.status, 200);
      assert.ok(r.json.toDivide.includes(id), 'the unsorted Bigbox receipt is to divide');
      assert.equal(new Set(r.json.toDivide).size, r.json.toDivide.length, 'each id once');
      assert.deepEqual(r.json.suggestions, {});
      assert.equal(f.calls.length, 0);
    } finally { setClaudeClient(null); }
  });

  test('a budget with no month open still shows its thread, and says so', async () => {
    const r = await call('GET', '/api/thread?budget=cabin');
    assert.equal(r.status, 200);
    assert.equal(r.json.noOpenMonth, true);
    assert.equal((await call('GET', '/api/thread?budget=harbor')).json.noOpenMonth, undefined);
  });

  test('whoami says whether Claude is set up', async () => {
    assert.equal((await call('GET', '/api/whoami')).json.claude, false);
  });

  test('Today\'s rails for a sandbox session: plans and money, and the calendar asks to sign in again', async () => {
    const r = await call('GET', '/api/today?budget=harbor');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.calendar.today, []);
    assert.deepEqual(r.json.calendar.tomorrow, []);
    assert.match(r.json.calendar.unavailable, /sign in again/);
    assert.ok(Array.isArray(r.json.plans));
    assert.equal(r.json.money.budget, 'harbor');
    assert.equal(typeof r.json.money.toAssign, 'string');
    assert.match(r.json.money.toAssign, /\$/, 'text the engine wrote, not cents');
    assert.ok(Array.isArray(r.json.money.low) && r.json.money.low.length <= 5);
    for (const l of r.json.money.low) {
      assert.equal(typeof l.envelope, 'string');
      assert.equal(typeof l.label, 'string');
      assert.match(l.left, /\$/);
      assert.ok(l.over === null || /^\$/.test(l.over), 'how far over, in words the engine wrote, or null');
    }
  });

  test('a bypass session cannot reach the NAS', async () => {
    const r = await call('GET', '/api/calendars');
    assert.equal(r.status, 409);
    assert.match(r.json.error, /sign in again/);
  });

  test('the search box asks for two letters, and finds a plan by its title', async () => {
    for (const q of ['a', ' a ', '']) {
      const short = await call('GET', `/api/search?q=${encodeURIComponent(q)}`);
      assert.equal(short.status, 400, q);
      assert.equal(short.json.error, 'search for at least two letters');
    }
    const thread = await call('GET', '/api/search?q=gate&kind=thread');
    assert.equal(thread.status, 200, JSON.stringify(thread.json));
    for (const bad of ['lane=money', 'who=nobody']) {
      const r = await call('GET', `/api/search?q=gate&${bad}`);
      assert.equal(r.status, 400, bad);
    }

    const made = await call('POST', '/api/plans', { title: 'Mend the garden gate', area: 'House' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const r = await call('GET', '/api/search?q=gate');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.elsewhere[0].kind, 'plan');
    assert.equal(r.json.elsewhere[0].open.plan, made.json.plan.id);
    assert.equal(r.json.elsewhere[0].title, 'Mend the garden gate');
    // The sandbox has no NAS session: the documents were not looked in.
    assert.equal(r.json.documents, 'not searched');
    assert.equal(r.json.who, 'everyone');
    assert.equal(r.json.capped, false);
    assert.ok(Array.isArray(r.json.days) && Array.isArray(r.json.entries));
  });
});

describe('drift on Today', () => {
  let aliceDsm = '';

  async function as(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', cookie: who },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: (res.headers.get('content-type') ?? '').startsWith('application/json') ? JSON.parse(text) : text };
  }
  /** The DSM calls the app makes while `run` runs, each still answered by the fake. */
  async function dsmCallsDuring(run: () => Promise<void>): Promise<string[]> {
    const bodies: string[] = [];
    setDsmFetch((async (url: string | URL | Request, init?: RequestInit) => {
      bodies.push(decodeURIComponent(String(init?.body ?? '')));
      return fetch(url, init);
    }) as typeof fetch);
    try { await run(); } finally { setDsmFetch(null); }
    return bodies;
  }
  /** A household of alice's own, open in her DSM session: each test has one, so each starts unchecked. */
  async function household(label: string): Promise<void> {
    const r = await as(aliceDsm, 'POST', '/api/households', { label });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  async function plannedOn(title: string, due: string): Promise<{ id: string; evt_id: number }> {
    const made = await as(aliceDsm, 'POST', '/api/plans', { title, area: 'House' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const id = made.json.plan.id;
    const r = await as(aliceDsm, 'POST', `/api/plans/${id}/due`, { due });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const log = ((await as(aliceDsm, 'GET', '/api/backup')).json as string).trim().split('\n').map((l) => JSON.parse(l));
    const link = log.filter((e: any) => e.op === 'plan.calendar.link' && e.plan === id).at(-1);
    return { id, evt_id: link.evt_id };
  }
  /** Bob, on his phone: the fake's own door for changing an event as one of its accounts. */
  async function bobMoves(evt_id: number, by: { days?: number; delete?: boolean }): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${nas.port}/fake/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ evt_id, by: 'bob', ...(by.delete ? { delete: true } : { shift: (by.days ?? 1) * 86_400 }) }),
    });
    assert.equal(res.status, 200, await res.text());
  }
  const driftCards = (page: any) => page.entries.filter((e: any) => e.kind === 'card' && e.offer.prompt.kind === 'drift');

  before(async () => {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct-horse' }),
    });
    assert.equal(res.status, 200);
    aliceDsm = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  });

  test('an event moved on a phone is a card on Today, waiting for either of you; the next load asks the NAS nothing', async () => {
    await household('Drift one');
    const gate = await plannedOn('Fix the gate', '2026-11-07');
    await bobMoves(gate.evt_id, { days: 1 });
    const r = await as(aliceDsm, 'GET', '/api/thread');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [card] = driftCards(r.json);
    assert.ok(card, 'a drift card');
    assert.equal(card.offer.tool, 'resolve_drift');
    assert.equal(card.offer.summary, 'Bob moved Fix the gate to Sun 8 Nov on their phone');
    assert.deepEqual(card.offer.effects, ['The plan says Sat 7 Nov', 'The calendar says Sun 8 Nov']);
    assert.deepEqual(card.plan, { id: gate.id, title: 'Fix the gate' });
    assert.deepEqual(card.drift, { on: 'calendar', resolved: null, deleted: false, replaced: false, unreadable: false });
    assert.ok(r.json.waiting.some((w: any) => w.kind === 'offer' && w.offer.id === card.offer.id));

    // Within ten minutes, Today is read again without a call to the NAS.
    const calls = await dsmCallsDuring(async () => {
      const again = await as(aliceDsm, 'GET', '/api/thread');
      assert.equal(again.status, 200);
      assert.equal(driftCards(again.json).length, 1, 'still the one card');
    });
    assert.deepEqual(calls, []);
  });

  test('a sandbox session reads Today without a call to the NAS, and cannot ask for a check', async () => {
    const calls = await dsmCallsDuring(async () => {
      assert.equal((await call('GET', '/api/thread?budget=harbor')).status, 200);
    });
    assert.deepEqual(calls, []);
    const r = await call('POST', '/api/calendar/check');
    assert.equal(r.status, 409);
    assert.match(r.json.error, /sign in again/);
  });

  test('a drift is answered from its card, never through the tools route', async () => {
    const r = await as(aliceDsm, 'POST', '/api/tools/resolve_drift', { drift: 'x', plan: 'y', choice: 'leave' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /answer it from its card/);
  });

  test('a household restored where its documents are not: a document is 404, and the full text is on the old NAS', async () => {
    // A briefing kept in Drive on the old NAS, restored as a household of its own here.
    const id = `${(Date.now() + 60_000).toString(36)}-900001`;
    const kept = { id, at: new Date().toISOString(), who: 'claude', op: 'thread.briefing', day: today, source: 'household',
      budget: null, headline: 'Kept on the old NAS', doc: DOC, writtenBy: 'claude' };
    const restored = await as(aliceDsm, 'POST', '/api/restore', { content: `${JSON.stringify(kept)}\n`, asNewHousehold: 'Docs elsewhere' });
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    const r = await as(aliceDsm, 'GET', `/api/docs/${id}`);
    assert.equal(r.status, 404, JSON.stringify(r.json));
    assert.match(r.json.error, /the full text is on the old NAS/);
  });

  test('a restore as a new household answers what it kept and what it left to the copy', async () => {
    const stamp = (n: number) => ({ id: `${(Date.now() + 70_000).toString(36)}-90001${n}`, at: new Date().toISOString(), who: 'someone-else' });
    const lines = [
      { ...stamp(1), op: 'household.zone', zone: 'America/Denver' },
      { ...stamp(2), op: 'guests.booking', on: true },
    ].map((e) => JSON.stringify(e)).join('\n');
    const restored = await as(aliceDsm, 'POST', '/api/restore', { content: `${lines}\n`, asNewHousehold: 'Kept zone' });
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
    assert.equal(restored.json.mode, 'new household');
    assert.equal(restored.json.summary[0], 'kept the time zone, America/Denver');
    assert.match(restored.json.summary[1], /chooses its own folder/);
  });

  test('a restore the preview says yes to is done: 200, never 500, with the people band', async () => {
    /** A backup made elsewhere: `owner` claims it, then `then` writes into it. */
    const backup = async (owner: string, then: (s: InstanceType<typeof Store>) => Promise<unknown>) => {
      const s = new Store({ path: join(await mkdtemp(join(tmpdir(), 'pb-restore-people-')), 'events.jsonl') });
      await s.load();
      await s.append(owner, { op: 'household.claim', label: 'Elsewhere' });
      await then(s);
      return readFile(s.path, 'utf8');
    };
    const cases: [string, string, boolean][] = [
      ["alice's own, with a plan", await backup('alice', (s) => s.append('alice', { op: 'plan.create', plan: 'srv-p1', title: 'Paint the fence', area: 'House' })), true],
      ["alice's own, with bob and casey and a plan of bob's", await backup('alice', async (s) => {
        await s.append('alice', [{ op: 'member.add', member: 'bob', why: 'he lives here' }, { op: 'member.add', member: 'casey', why: 'she lives here' }]);
        await s.append('bob', { op: 'plan.create', plan: 'srv-p2', title: 'Fix the gate', area: 'House' });
      }), true],
      ["bob's, with a member he added", await backup('bob', (s) => s.append('bob', { op: 'member.add', member: 'casey', why: 'she lives here' })), false],
    ];
    let n = 0;
    for (const [what, content, clean] of cases) {
      await household(`People back ${++n}`);
      const scopes = ['people', 'plans'];
      const preview = await as(aliceDsm, 'POST', '/api/restore/preview', { content, scopes });
      assert.equal(preview.status, 200, JSON.stringify(preview.json));
      assert.equal(preview.json.canApply, clean, `${what}: ${JSON.stringify(preview.json.collisions)}`);
      if (!preview.json.canApply) {
        assert.ok(preview.json.collisions.some((c: any) => c.kind === 'owner'), what);
        continue;
      }
      const r = await as(aliceDsm, 'POST', '/api/restore', { content, scopes });
      assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.json)}`);
    }
    const log = ((await as(aliceDsm, 'GET', '/api/backup')).json as string).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(log.filter((e: any) => e.op === 'household.claim').map((e: any) => e.who), ['alice'], 'one claim, this household\'s own');
  });

  test("alice's own backup with a plan restores as a household of its own", async () => {
    const s = new Store({ path: join(await mkdtemp(join(tmpdir(), 'pb-restore-own-')), 'events.jsonl') });
    await s.load();
    await s.append('alice', { op: 'household.claim', label: 'Elsewhere' });
    await s.append('alice', { op: 'member.add', member: 'bob', why: 'he lives here' });
    await s.append('bob', { op: 'plan.create', plan: 'srv-own', title: 'Clean the gutters', area: 'House' });
    const r = await as(aliceDsm, 'POST', '/api/restore', { content: await readFile(s.path, 'utf8'), asNewHousehold: 'Own again' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const log = ((await as(aliceDsm, 'GET', '/api/backup')).json as string).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(log.some((e: any) => e.op === 'plan.create' && e.plan === 'srv-own'));
    assert.ok(log.some((e: any) => e.op === 'member.add' && e.member === 'bob'));
  });

  test('a deleted event\'s card says so', async () => {
    await household('Drift deleted');
    const gate = await plannedOn('Fix the gate', '2026-11-07');
    await bobMoves(gate.evt_id, { delete: true });
    const r = await as(aliceDsm, 'GET', '/api/thread');
    const [card] = driftCards(r.json);
    assert.equal(card.offer.summary, 'Fix the gate was deleted from the calendar');
    assert.deepEqual(card.drift, { on: 'calendar', resolved: null, deleted: true, replaced: false, unreadable: false });
  });

  test("a change of zone does not make the app's own events look changed", async () => {
    // A plan due 2026-11-20 put on the calendar while the household is UTC, as the deployment says.
    await household('Zone moved');
    const gate = await plannedOn('Fix the gate', '2026-11-20');
    const zoned = await as(aliceDsm, 'POST', '/api/settings/zone', { zone: 'America/Denver' });
    assert.equal(zoned.status, 200, JSON.stringify(zoned.json));
    // Touched on a phone without moving it (a note, a colour): its etag moves, its times do not.
    const res = await fetch(`http://127.0.0.1:${nas.port}/fake/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ evt_id: gate.evt_id, by: 'alice', shift: 0 }),
    });
    assert.equal(res.status, 200, await res.text());
    const checked = await as(aliceDsm, 'POST', '/api/calendar/check', {});
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
    assert.deepEqual(checked.json.drifts, []);
    const log = ((await as(aliceDsm, 'GET', '/api/backup')).json as string).trim().split('\n').map((l) => JSON.parse(l));
    const since = log.slice(log.findIndex((e: any) => e.op === 'household.zone'));
    assert.ok(!since.some((e: any) => e.op === 'calendar.drift'), 'nothing is asked');
    assert.ok(since.some((e: any) => e.op === 'plan.calendar.etag' && e.plan === gate.id), 'its new etag is recorded');
  });

  test("after a change of zone, a plan edit over a note-only touch is no drift, and the event takes the new date where the household is", async () => {
    await household('Zone then edit');
    const gate = await plannedOn('Fix the gate', '2026-11-20');
    assert.equal((await as(aliceDsm, 'POST', '/api/settings/zone', { zone: 'America/Denver' })).status, 200);
    // A note on a phone: the etag moves, the times (still UTC midnights) do not.
    const res = await fetch(`http://127.0.0.1:${nas.port}/fake/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ evt_id: gate.evt_id, by: 'alice', shift: 0 }),
    });
    assert.equal(res.status, 200, await res.text());
    const r = await as(aliceDsm, 'POST', `/api/plans/${gate.id}/due`, { due: '2026-11-21' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const log = ((await as(aliceDsm, 'GET', '/api/backup')).json as string).trim().split('\n').map((l) => JSON.parse(l));
    const since = log.slice(log.findIndex((e: any) => e.op === 'household.zone'));
    assert.ok(!since.some((e: any) => e.op === 'calendar.drift'), 'the app\'s own event is not asked about');
    assert.ok(since.some((e: any) => e.op === 'plan.calendar.etag' && e.plan === gate.id), 'changed, and its new etag recorded');
    const { sid } = await checkWithDsm('alice', 'correct-horse', undefined);
    const now = await getEvent(sid, { evt_id: gate.evt_id, cal_id: '', original_cal_id: '' });
    assert.equal(now.dtstart, Date.parse('2026-11-21T07:00:00Z') / 1000, 'midnight in Denver');
    assert.equal(now.tz_id, 'America/Denver');
  });

  test('after a change of zone, an event moved on a phone is still drift when the plan is edited', async () => {
    await household('Zone then moved');
    const gate = await plannedOn('Fix the gate', '2026-11-20');
    assert.equal((await as(aliceDsm, 'POST', '/api/settings/zone', { zone: 'America/Denver' })).status, 200);
    await bobMoves(gate.evt_id, { days: 1 });
    const r = await as(aliceDsm, 'POST', `/api/plans/${gate.id}/due`, { due: '2026-11-22' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const log = ((await as(aliceDsm, 'GET', '/api/backup')).json as string).trim().split('\n').map((l) => JSON.parse(l));
    const since = log.slice(log.findIndex((e: any) => e.op === 'household.zone'));
    assert.equal(since.filter((e: any) => e.op === 'calendar.drift' && e.plan === gate.id).length, 1);
  });

  test('a check asked for always looks; the three choices go through the decide route', async () => {
    await household('Drift three ways');
    assert.equal((await as(aliceDsm, 'GET', '/api/thread')).status, 200, 'the ten minutes start now');
    const a = await plannedOn('Fix the gate', '2026-11-07');
    const b = await plannedOn('Clean the gutters', '2026-11-07');
    const c = await plannedOn('Sweep the chimney', '2026-11-07');
    for (const p of [a, b, c]) await bobMoves(p.evt_id, { days: 1 });

    const checked = await as(aliceDsm, 'POST', '/api/calendar/check');
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
    assert.equal(checked.json.drifts.length, 3);

    const cards = driftCards((await as(aliceDsm, 'GET', '/api/thread')).json);
    const cardOf = (p: { id: string }) => cards.find((x: any) => x.plan.id === p.id).offer.id;
    const choose = (p: { id: string }, choice: string) =>
      as(aliceDsm, 'POST', '/api/thread/decide', { offer: cardOf(p), decision: 'approved', args: { choice } });
    // A choice must be given as one of the three, by name.
    assert.equal((await as(aliceDsm, 'POST', '/api/thread/decide',
      { offer: cardOf(a), decision: 'approved', args: 'plan' })).status, 400);
    assert.equal((await choose(a, 'both')).status, 400);
    assert.equal((await choose(a, 'plan')).status, 200);
    assert.equal((await choose(b, 'calendar')).status, 200);
    assert.equal((await choose(c, 'leave')).status, 200);

    const dueOf = async (p: { id: string }) => (await as(aliceDsm, 'GET', `/api/plans/${p.id}`)).json.due;
    assert.equal(await dueOf(a), '2026-11-08', 'the plan moved too');
    assert.equal(await dueOf(b), '2026-11-07');
    assert.equal(await dueOf(c), '2026-11-07');
    const { sid } = await checkWithDsm('alice', 'correct-horse', undefined);
    const day = async (p: { evt_id: number }) =>
      new Date((await getEvent(sid, { evt_id: p.evt_id, cal_id: '', original_cal_id: '' })).dtstart * 1000).toISOString().slice(0, 10);
    assert.equal(await day(a), '2026-11-08');
    assert.equal(await day(b), '2026-11-07', 'the calendar was put back');
    assert.equal(await day(c), '2026-11-08', 'both were left');

    const settled = driftCards((await as(aliceDsm, 'GET', '/api/thread')).json);
    assert.deepEqual(settled.map((x: any) => [x.plan.title, x.offer.status, x.drift.resolved]), [
      ['Fix the gate', 'approved', 'plan'], ['Clean the gutters', 'approved', 'calendar'], ['Sweep the chimney', 'approved', 'leave'],
    ]);
  });

  test('a NAS that does not answer never fails Today, nor the check', async () => {
    await household('Drift offline');
    const gate = await plannedOn('Fix the gate', '2026-11-07');
    await bobMoves(gate.evt_id, { days: 1 });
    setDsmFetch((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    try {
      const r = await as(aliceDsm, 'GET', '/api/thread');
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(driftCards(r.json).length, 0);
      const checked = await as(aliceDsm, 'POST', '/api/calendar/check');
      assert.equal(checked.status, 200, JSON.stringify(checked.json));
      assert.deepEqual(checked.json.drifts, []);
    } finally {
      setDsmFetch(null);
    }
  });
});

describe('Today\'s rails, from the NAS', () => {
  let aliceDsm = '';
  const DAY = 86_400;
  const tomorrow = new Date(Date.now() + DAY * 1000).toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * DAY * 1000).toISOString().slice(0, 10);
  /** Epoch seconds at hh:mm on `day`, UTC being where the household is in these tests. */
  const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00Z`) / 1000;

  async function as(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', cookie: aliceDsm },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await res.json() };
  }
  async function plan(title: string): Promise<string> {
    const made = await as('POST', '/api/plans', { title, area: 'House' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    return made.json.plan.id;
  }
  const event = (cal_id: string, summary: string, dtstart: number, dtend: number) => ({
    cal_id, original_cal_id: cal_id, summary, description: '', is_all_day: false, dtstart, dtend, tz_id: 'UTC',
  });

  before(async () => {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct-horse' }),
    });
    assert.equal(res.status, 200);
    aliceDsm = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  });

  test('each event says whose calendar it is on, and a plan\'s says which plan; nothing else is read', async () => {
    assert.equal((await as('POST', '/api/households', { label: 'Rails' })).status, 200);
    // A block of time on a plan: the Household calendar is made for it, and the event linked.
    const gate = await plan('Fix the gate');
    const blocked = await as('POST', `/api/plans/${gate}/block`,
      { start: `${tomorrow}T14:00:00Z`, end: `${tomorrow}T15:00:00Z` });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.json));

    const alice = (await checkWithDsm('alice', 'correct-horse', undefined)).sid;
    const bob = (await checkWithDsm('bob', 'battery-staple', undefined)).sid;
    await createEvent(alice, event('/alice/home/', 'Gym', at(tomorrow, '07:30'), at(tomorrow, '08:30')));
    // Bob's own calendar, shared with alice and checked by her for clashes.
    await shareCalendar(bob, '/bob/home/', { users: [{ name: 'alice', privilege: 'RO' }] });
    await createEvent(bob, event('/bob/home/', 'Choir', at(tomorrow, '18:30'), at(tomorrow, '20:00')));
    const checked = await as('POST', '/api/calendars/conflicts', { calendars: [{ cal_id: '/bob/home/', original_cal_id: '/bob/home/' }] });
    assert.equal(checked.status, 200, JSON.stringify(checked.json));
    // A calendar of alice's she did not choose: never read for Today.
    const other = await createCalendar(alice, { displayname: 'Work', color: '#000000' });
    await createEvent(alice, event(other.cal_id, 'Standup', at(tomorrow, '09:00'), at(tomorrow, '09:15')));

    const r = await as('GET', '/api/today');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.calendar.unavailable, undefined);
    const all = [...r.json.calendar.today, ...r.json.calendar.tomorrow];
    const named = (summary: string) => all.find((e: any) => e.summary === summary);
    assert.equal(named('Gym')?.calendar, 'mine');
    assert.equal(named('Choir')?.calendar, 'partner');
    assert.equal(named('Fix the gate')?.calendar, 'household');
    assert.deepEqual(named('Fix the gate')?.plan, { id: gate, title: 'Fix the gate', state: 'planning', owner: 'alice', goal: null, area: 'House' });
    assert.equal(named('Gym')?.plan, undefined);
    assert.equal(named('Standup'), undefined, 'a calendar not chosen is not read');
    assert.ok(r.json.calendar.tomorrow.some((e: any) => e.summary === 'Gym'), 'tomorrow is tomorrow');
    const starts = r.json.calendar.tomorrow.map((e: any) => e.dtstart);
    assert.deepEqual(starts, [...starts].sort((a: number, b: number) => a - b), 'in time order');
    assert.equal(r.json.money, null, 'no budget, no money rail');
  });

  test('plans due this week, or in Doing, are the plans rail; one due in twenty days is not', async () => {
    assert.equal((await as('POST', '/api/households', { label: 'Rails plans' })).status, 200);
    const soon = await plan('Renew the registration');
    const later = await plan('Service the boiler');
    const doing = await plan('Paint the fence');
    assert.equal((await as('POST', `/api/plans/${soon}/due`, { due: inDays(3) })).status, 200);
    assert.equal((await as('POST', `/api/plans/${later}/due`, { due: inDays(20) })).status, 200);
    assert.equal((await as('POST', `/api/plans/${doing}/state`, { state: 'doing' })).status, 200);
    const r = await as('GET', '/api/today');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ids = r.json.plans.map((p: any) => p.id);
    assert.ok(ids.includes(soon), 'due in three days');
    assert.ok(ids.includes(doing), 'in Doing');
    assert.ok(!ids.includes(later), 'due in twenty days');
    assert.equal(ids[0], soon, 'a due date first');
    assert.ok(Array.isArray(r.json.plans[0].chips), 'each a board card, with its chips');
  });

  test('a NAS that does not answer leaves the calendar rail saying so, never a 500', async () => {
    setDsmFetch((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    try {
      const r = await as('GET', '/api/today');
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual([r.json.calendar.today, r.json.calendar.tomorrow], [[], []]);
      assert.equal(typeof r.json.calendar.unavailable, 'string');
    } finally {
      setDsmFetch(null);
    }
  });

  test('asked to schedule something, Claude\'s propose_event is a card in the thread', async () => {
    assert.equal((await as('POST', '/api/households', { label: 'Rails ask' })).status, 200);
    fake([
      called('propose_event', { summary: 'Dentist', start: `${tomorrow}T10:00`, end: `${tomorrow}T11:00`, on: 'mine' }),
      said('Tomorrow at 10:00 is clear on your calendar.'),
    ]);
    try {
      const r = await as('POST', '/api/thread/ask', { question: 'Schedule my dentist at 10 tomorrow', budget: null });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.offers.length, 1);
    } finally {
      setClaudeClient(null);
    }
    const page = await as('GET', '/api/thread');
    // The card rides on Claude's answer to the question that asked for it.
    const asked = page.json.entries.find((e: any) => e.kind === 'ask' && /dentist/.test(e.text));
    const cards = page.json.entries.filter((e: any) => e.kind === 'card' && e.offer.tool === 'propose_event' && e.raised?.entry === asked.id);
    assert.equal(cards.length, 1, JSON.stringify(asked));
    assert.match(cards[0].offer.summary, /^Dentist · /);
  });
});

describe('the calendar on screen', () => {
  let aliceDsm = '';
  const DAY = 86_400;
  const inDays = (n: number) => new Date(Date.now() + n * DAY * 1000).toISOString().slice(0, 10);
  const tomorrow = inDays(1);
  /** Epoch seconds at hh:mm on `day`, UTC being where the household is in these tests. */
  const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00Z`) / 1000;

  async function as(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', cookie: who },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: (res.headers.get('content-type') ?? '').startsWith('application/json') ? JSON.parse(text) : text };
  }
  async function plan(who: string, title: string): Promise<string> {
    const made = await as(who, 'POST', '/api/plans', { title, area: 'House' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    return made.json.plan.id;
  }
  async function linked(id: string, kind: string): Promise<number> {
    const log = ((await as(aliceDsm, 'GET', '/api/backup')).json as string).trim().split('\n').map((l) => JSON.parse(l));
    return log.filter((e: any) => e.op === 'plan.calendar.link' && e.plan === id && e.kind === kind).at(-1).evt_id;
  }

  before(async () => {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'correct-horse' }),
    });
    assert.equal(res.status, 200);
    aliceDsm = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  });

  test('a week: each event says what kind it is, which plan, and whether it moved, clashes or is only proposed', async () => {
    assert.equal((await as(aliceDsm, 'POST', '/api/households', { label: 'Week' })).status, 200);
    const gate = await plan(aliceDsm, 'Fix the gate');
    const gutters = await plan(aliceDsm, 'Clean the gutters');
    assert.equal((await as(aliceDsm, 'POST', `/api/plans/${gate}/block`,
      { start: `${tomorrow}T14:00:00Z`, end: `${tomorrow}T15:00:00Z` })).status, 200);
    assert.equal((await as(aliceDsm, 'POST', `/api/plans/${gate}/due`, { due: inDays(2) })).status, 200);
    assert.equal((await as(aliceDsm, 'POST', `/api/plans/${gutters}/due`, { due: inDays(3) })).status, 200);

    // On her own calendar, at the same time as the block: a clash.
    const alice = (await checkWithDsm('alice', 'correct-horse', undefined)).sid;
    await createEvent(alice, { cal_id: '/alice/home/', original_cal_id: '/alice/home/', summary: 'Pilates', description: '',
      is_all_day: false, dtstart: at(tomorrow, '14:30'), dtend: at(tomorrow, '15:30'), tz_id: 'UTC' });

    // Two appointments asked for: one approved (for the gate), one left waiting.
    fake([
      called('propose_event', { summary: 'Locksmith', start: `${tomorrow}T10:00`, end: `${tomorrow}T11:00`, on: 'household', plan: gate }),
      called('propose_event', { summary: 'Haircut', start: `${tomorrow}T17:00`, end: `${tomorrow}T18:00`, on: 'mine' }),
      said('Both are on cards.'),
    ]);
    let offers: any[];
    try {
      const r = await as(aliceDsm, 'POST', '/api/thread/ask', { question: 'Book the locksmith and my haircut tomorrow', budget: null });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      offers = r.json.offers;
      assert.equal(offers.length, 2);
    } finally {
      setClaudeClient(null);
    }
    const locksmith = offers.find((o: any) => /^Locksmith/.test(o.summary));
    const haircut = offers.find((o: any) => /^Haircut/.test(o.summary));
    assert.equal((await as(aliceDsm, 'POST', '/api/thread/decide', { offer: locksmith.id, decision: 'approved' })).status, 200);

    // Bob moves the gutters' due date on his phone; the check notes the drift.
    const guttersDue = await linked(gutters, 'due');
    const moved = await fetch(`http://127.0.0.1:${nas.port}/fake/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ evt_id: guttersDue, by: 'bob', shift: DAY }),
    });
    assert.equal(moved.status, 200, await moved.text());
    const checked = await as(aliceDsm, 'POST', '/api/calendar/check');
    assert.equal(checked.json.drifts.length, 1, JSON.stringify(checked.json));

    const r = await as(aliceDsm, 'GET', `/api/calendar?start=${inDays(0)}&end=${inDays(7)}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.unavailable, undefined);
    const named = (summary: string, kind?: string) =>
      r.json.events.filter((e: any) => e.summary === summary && (!kind || e.kind === kind));

    const [block] = named('Fix the gate', 'block');
    assert.ok(block, JSON.stringify(r.json.events));
    assert.deepEqual(block.plan, { id: gate, title: 'Fix the gate', state: 'planning', owner: 'alice', goal: null, area: 'House' });
    assert.equal(block.calendar, 'household');
    assert.equal(block.is_all_day, false);
    assert.equal(block.clash, true, 'the block and Pilates overlap');

    const pilates = named('Pilates')[0];
    assert.equal(pilates.kind, 'other');
    assert.equal(pilates.calendar, 'mine');
    assert.equal(pilates.clash, true);

    const due = named('Fix the gate', 'due');
    assert.equal(due.length, 1, 'one marker for one due date');
    assert.equal(due[0].is_all_day, true);
    assert.equal(due[0].dtstart, at(inDays(2), '00:00'));
    assert.equal(due[0].clash, undefined, 'a day is no clash');

    const [appt] = named('Locksmith');
    assert.equal(appt.kind, 'appointment');
    assert.deepEqual(appt.plan, { id: gate, title: 'Fix the gate', state: 'planning', owner: 'alice', goal: null, area: 'House' });
    assert.equal(appt.proposed, undefined);

    const [hair] = named('Haircut');
    assert.ok(hair, 'a proposed event is on the week');
    assert.equal(hair.proposed, haircut.id);
    assert.equal(hair.calendar, 'mine');
    assert.equal(hair.dtstart, at(tomorrow, '17:00'));
    assert.equal(hair.dtend, at(tomorrow, '18:00'));

    const gut = named('Clean the gutters', 'due');
    assert.equal(gut.length, 1, 'the moved event, and no second marker for the plan\'s date');
    assert.equal(gut[0].dtstart, at(inDays(4), '00:00'), 'where the calendar has it');
    assert.equal(gut[0].drift, checked.json.drifts[0]);

    assert.deepEqual(r.json.events.filter((e: any) => e.clash).map((e: any) => e.summary).sort(), ['Fix the gate', 'Pilates']);
  });

  test('a session without the NAS is asked to sign in again, and still sees its due dates', async () => {
    const id = await plan(cookie, 'Book the chimney sweep');
    assert.equal((await as(cookie, 'POST', `/api/plans/${id}/due`, { due: inDays(2) })).status, 200);
    const r = await as(cookie, 'GET', `/api/calendar?start=${inDays(0)}&end=${inDays(7)}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.unavailable, /sign in again/);
    const due = r.json.events.filter((e: any) => e.plan?.id === id);
    assert.equal(due.length, 1);
    assert.equal(due[0].kind, 'due');
    assert.equal(due[0].is_all_day, true);
    assert.equal(due[0].calendar, 'household');
    assert.equal(due[0].summary, 'Book the chimney sweep');
    // Set without a NAS session, it has no event yet: drawn as not on the calendar.
    assert.equal(due[0].offCalendar, true);
    const block = await as(cookie, 'POST', `/api/plans/${id}/block`,
      { start: `${inDays(3)}T16:00:00.000Z`, end: `${inDays(3)}T17:00:00.000Z` });
    assert.equal(block.status, 200);
    const again = await as(cookie, 'GET', `/api/calendar?start=${inDays(0)}&end=${inDays(7)}`);
    const blocks = again.json.events.filter((e: any) => e.plan?.id === id && e.kind === 'block');
    assert.equal(blocks.length, 1, 'a block kept on the plan is drawn too');
    assert.equal(blocks[0].offCalendar, true);
    assert.equal(blocks[0].is_all_day, false);
  });

  test('a window is whole days, at most forty-two of them', async () => {
    assert.equal((await as(cookie, 'GET', `/api/calendar?start=${inDays(0)}&end=${inDays(43)}`)).status, 400);
    assert.equal((await as(cookie, 'GET', `/api/calendar?start=${inDays(0)}&end=${inDays(42)}`)).status, 200);
    assert.equal((await as(cookie, 'GET', `/api/calendar?start=${inDays(3)}&end=${inDays(3)}`)).status, 400);
    assert.equal((await as(cookie, 'GET', '/api/calendar?start=2026-02-30&end=2026-03-02')).status, 400);
    assert.equal((await as(cookie, 'GET', '/api/calendar')).status, 400);
  });

  test('money: null with no budget, an array with one, the default for a budget it does not know, null for an archived one', async () => {
    const q = `start=${inDays(0)}&end=${inDays(7)}`;
    const mine = await as(cookie, 'GET', `/api/calendar?${q}`);
    assert.equal(mine.status, 200, JSON.stringify(mine.json));
    assert.ok(Array.isArray(mine.json.money));
    const named = await as(cookie, 'GET', `/api/calendar?${q}&budget=harbor`);
    const unknown = await as(cookie, 'GET', `/api/calendar?${q}&budget=nope`);
    assert.deepEqual(unknown.json.money, named.json.money, 'an unknown budget reads the default one');
    assert.equal((await as(cookie, 'GET', `/api/calendar?${q}&budget=attic`)).json.money, null, 'an archived budget is no live budget');
    assert.equal((await as(aliceDsm, 'POST', '/api/households', { label: 'No budget' })).status, 200);
    assert.equal((await as(aliceDsm, 'GET', `/api/calendar?${q}`)).json.money, null);
  });
});
