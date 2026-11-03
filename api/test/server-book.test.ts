// api/test/server-book.test.ts
//
// The guest door over HTTP: /book and everything under it, against an
// in-process server. Like server-settings.test.ts this sets process.env at
// module scope, before src/ loads, and relies on node --test giving each file
// its own process.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';

const dir = await mkdtemp(join(tmpdir(), 'pb-server-book-'));
/** Every line the fake DSM logged: one per sign-in it was asked to check. */
const dsmSaid: string[] = [];
const nas = await startFakeDsm({
  port: 0, root: join(dir, 'nas'), log: (line: string) => { dsmSaid.push(line); },
  accounts: { alice: { password: 'correct-horse' } },
});
Object.assign(process.env, {
  PORT: '0', TZ: 'UTC', DSM_URL: `http://127.0.0.1:${nas.port}`,
  DEV_LOG_PATH: join(dir, 'dev.jsonl'), HOUSEHOLDS_DIR: join(dir, 'households'),
  SESSIONS_PATH: join(dir, 'sessions.json'), CONNECTORS_PATH: join(dir, 'connectors.json'), LOG_PATH: join(dir, 'none.jsonl'),
  // Everything booking needs; the household it names is made after boot.
  BOOK_URL: 'https://book.example.com', BOOK_HOUSEHOLD: 'home',
  SMTP_HOST: 'mail.example.com', SMTP_PORT: '587', SMTP_USER: 'robot', SMTP_PASS: 'pw', SMTP_FROM: 'house@example.com',
  // One proxy in front; each test speaks from an address of its own, so the
  // per-IP limit is one test's.
  TRUST_PROXY: '1',
});
delete process.env['DEV_USER'];
delete process.env['COOKIE_INSECURE'];

const { start, clientAddress, ipBucket, proxyMismatch } = await import('../src/server.ts');
const { Store } = await import('../src/store.ts');
const { Households } = await import('../src/households.ts');
const households = new Households(join(dir, 'households'));
type Mail = import('../src/mail.ts').Mail;

const ANSWER = { ok: true, message: 'If that address is one we know, a link is on its way.' };

/** What the server would have mailed. */
const sent: Mail[] = [];

let base = '';
let close: () => Promise<void> = async () => {};

/** The booking page's own origin: what a browser sends with every POST the page makes. */
const ORIGIN = 'https://book.example.com';

async function call(method: string, path: string,
                    opts: { body?: unknown; cookie?: string; ip?: string; headers?: Record<string, string>; origin?: string | null } = {}) {
  // The page's own calls carry its origin; a test of a call from elsewhere says otherwise.
  const origin = opts.origin === undefined ? (method !== 'GET' && path.startsWith('/book') ? ORIGIN : null) : opts.origin;
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      // What the client wrote, then what the one proxy appended: only the latter counts.
      ...(opts.ip ? { 'x-forwarded-for': `203.0.113.99, ${opts.ip}` } : {}),
      ...opts.headers,
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

const ask = (email: string, ip: string, headers?: Record<string, string>) =>
  call('POST', '/book/start', { body: { email }, ip, ...(headers ? { headers } : {}) });
const tokenIn = (m: Mail) => /\/book\/open\?token=([\w-]+)/.exec(m.text)?.[1];
const codeIn = (m: Mail) => /^\s*(\d{6})\s*$/m.exec(m.text)?.[1];
const cookieOf = (h: Headers) => (h.get('set-cookie') ?? '').split(';')[0]!;

/** Pressing Continue on the link's page: a same-origin form POST, as a browser sends it. */
async function press(token: string, origin: string | null = 'https://book.example.com') {
  const res = await fetch(base + '/book/open', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
    body: new URLSearchParams({ token }).toString(),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/** Everything the server warned about, from boot on. */
const warned: string[] = [];
const { warn } = console;

before(async () => {
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
  const server = await start({ send: async (_cfg, m) => { sent.push(m); }, households });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
});

after(async () => { console.warn = warn; await close(); await nas.close(); });

describe('before the household exists, booking is off and nothing says why', () => {
  test('the page is still served', async () => {
    const r = await call('GET', '/book');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
  });

  test('its first call answers 404, "not available"', async () => {
    const r = await call('GET', '/book/me');
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'not available' });
  });

  test('asking, looking at your own, cancelling and changing: 404 too', async () => {
    for (const [method, path] of [['POST', '/book/request'], ['GET', '/book/mine'], ['POST', '/book/cancel'], ['POST', '/book/change'],
      ['POST', '/book/accept-suggestion']] as const) {
      const r = await call(method, path, method === 'POST' ? { body: {} } : {});
      assert.equal(r.status, 404, path);
      assert.deepEqual(r.json, { error: 'not available' }, path);
    }
  });

  test('the emailed link shows a small page that says only that, not JSON', async () => {
    for (const r of [await call('GET', '/book/open?token=abc'), await press('abc')]) {
      assert.equal(r.status, 404);
      assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
      assert.ok(r.text.includes("This page isn't available right now."), r.text);
      assert.ok(!/BOOK_|household|SMTP|configur/i.test(r.text), r.text);
      assert.equal(r.headers.get('set-cookie'), null);
    }
  });

  test('asking for a link gets the same answer, and nothing is sent', async () => {
    const r = await ask('guests@example.com', '10.2.0.1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, ANSWER);
    assert.equal(sent.length, 0);
  });
});

describe('once the household is there, without a restart', () => {
  before(async () => {
    // Made behind the server's back, as a restore or another process would:
    // the server learns of it the next time /book is asked.
    await mkdir(join(dir, 'households', 'home'), { recursive: true });
    const s = new Store({ path: join(dir, 'households', 'home', 'events.jsonl') });
    await s.load();
    await s.append('alice', { op: 'household.claim', label: 'Home' });
    for (const email of ['guests@example.com', 'code@example.com', 'limit@example.com', 'out@example.com', 'gone@example.com']) {
      await s.append('alice', { op: 'guest.allow', email, name: 'Friends', why: 'old friends' });
    }
  });

  test('booking is on: /book/me now wants a guest session', async () => {
    const r = await call('GET', '/book/me');
    assert.equal(r.status, 401);
  });

  test('the shared tokens are served under /book, as /tokens.css is', async () => {
    const r = await call('GET', '/book/tokens.css');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/css; charset=utf-8');
    const plain = await call('GET', '/tokens.css');
    assert.equal(r.headers.get('cache-control'), plain.headers.get('cache-control'));
    assert.equal(r.text, plain.text);
  });

  test('an address not on the list: 200, the same words, no mail', async () => {
    const r = await ask('stranger@example.com', '10.2.1.1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, ANSWER);
    assert.equal(sent.length, 0);
  });

  test('an address on the list: the same words, and one mail with a code and a link on BOOK_URL, whatever the Host says', async () => {
    const before = sent.length;
    const r = await ask('Guests@Example.com', '10.2.2.1', { 'x-forwarded-host': 'evil.example.net' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, ANSWER);
    assert.equal(sent.length, before + 1);
    const m = sent.at(-1)!;
    assert.equal(m.to, 'guests@example.com');
    assert.match(codeIn(m) ?? '', /^\d{6}$/);
    assert.ok(m.text.includes('https://book.example.com/book/open?token='), m.text);
    assert.ok(!m.text.includes('evil'), m.text);
    // Neither the code nor the link is in what the page was told.
    assert.ok(!r.text.includes(codeIn(m)!) && !r.text.includes(tokenIn(m)!));
  });

  test('looking at the link spends nothing: a page with one button, and no cookie', async () => {
    const token = tokenIn(sent.find((x) => x.to === 'guests@example.com')!)!;
    for (let i = 0; i < 2; i++) {
      const r = await call('GET', `/book/open?token=${token}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('set-cookie'), null);
      assert.match(r.text, /<html lang="en" data-place="placitas">/);
      assert.ok(r.text.includes('href="/book/tokens.css"'));
      assert.match(r.text, /<form method="post" action="\/book\/open">/);
      assert.ok(r.text.includes(`name="token" value="${token}"`));
      assert.match(r.text, />Continue</);
      assert.ok(!/<script/i.test(r.text), 'nothing submits itself');
    }
  });

  test('the small pages load Satoshi as the app does, and their button is the booking page\'s: token controls, no raw pill', async () => {
    const token = tokenIn(sent.find((x) => x.to === 'guests@example.com')!)!;
    const pages = [(await call('GET', `/book/open?token=${token}`)).text, (await press('nope')).text, (await press(token, null)).text];
    for (const html of pages) {
      assert.ok(html.includes('<link href="https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap" rel="stylesheet" />'), html);
      assert.doesNotMatch(html, /999px|border-radius:\s*\d+px/, 'no raw pill');
    }
    const cont = pages[0]!;
    assert.match(cont, /<button class="btn primary" type="submit">Continue<\/button>/);
    assert.match(cont, /min-height:\s*var\(--tap\)/);
    assert.match(cont, /border-radius:\s*var\(--r-control\)/);
  });

  test('a button pressed from another origin, or none: 403, and the link is still good', async () => {
    const token = tokenIn(sent.find((x) => x.to === 'guests@example.com')!)!;
    for (const origin of ['https://evil.example.net', 'null', null]) {
      const r = await press(token, origin);
      assert.equal(r.status, 403, String(origin));
      assert.equal(r.headers.get('set-cookie'), null);
    }
  });

  test('pressing Continue: a guest cookie, on /book only, and back to the page; pressing it again: 401', async () => {
    const token = tokenIn(sent.find((x) => x.to === 'guests@example.com')!)!;
    const r = await press(token);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/book');
    const set = r.headers.get('set-cookie') ?? '';
    assert.match(set, /^book-guest=[0-9a-f]{64};/);
    const attrs = set.split(';').map((a) => a.trim());
    for (const a of ['HttpOnly', 'SameSite=Lax', 'Path=/book', 'Secure', 'Max-Age=2592000']) {
      assert.ok(attrs.includes(a), `${a} in ${set}`);
    }
    assert.ok(!set.includes(token), 'the session is not the link');

    const me = await call('GET', '/book/me', { cookie: cookieOf(r.headers) });
    assert.equal(me.status, 200);
    assert.deepEqual(me.json, { email: 'guests@example.com', household: 'Home', tz: 'UTC', arrival: false });

    const again = await press(token);
    assert.equal(again.status, 401);
    assert.match(again.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(again.text, /ask for a new one/i);
    assert.equal(again.headers.get('set-cookie'), null);
  });

  test('a guest cookie opens nothing under /api', async () => {
    const m = sent.find((x) => x.to === 'guests@example.com')!;
    // A fresh sign-in, so this test has a live guest session of its own.
    const r = await ask('guests@example.com', '10.2.3.1');
    assert.equal(r.status, 200);
    const link = sent.at(-1)!;
    assert.notEqual(link, m);
    const cookie = cookieOf((await press(tokenIn(link)!)).headers);
    const guestToken = cookie.split('=')[1]!;
    assert.equal((await call('GET', '/book/me', { cookie })).status, 200);
    assert.equal((await call('GET', '/api/whoami', { cookie })).status, 401);
    // Not under the member cookie's name either: the two are different sessions.
    assert.equal((await call('GET', '/api/whoami', { cookie: `budget-session=${guestToken}` })).status, 401);
  });

  test('the code, typed in: a guest cookie, once', async () => {
    await ask('code@example.com', '10.2.4.1');
    const m = sent.at(-1)!;
    assert.equal(m.to, 'code@example.com');
    const r = await call('POST', '/book/code', { body: { email: 'code@example.com', code: codeIn(m) } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie') ?? '', /^book-guest=[0-9a-f]{64}; .*Path=\/book/);
    const me = (await call('GET', '/book/me', { cookie: cookieOf(r.headers) })).json;
    assert.deepEqual(me, { email: 'code@example.com', household: 'Home', tz: 'UTC', arrival: false });
    // With an arrival note kept: that there is one, and never what it says.
    const home = await households.open('home');
    await home.append('alice', { op: 'guests.arrival', text: 'Gate code 4471' });
    const now = await call('GET', '/book/me', { cookie: cookieOf(r.headers) });
    assert.equal(now.json.arrival, true);
    assert.ok(!now.text.includes('4471'), now.text);
    await home.append('alice', { op: 'guests.arrival', text: '' });
    const again = await call('POST', '/book/code', { body: { email: 'code@example.com', code: codeIn(m) } });
    assert.equal(again.status, 401);
    assert.deepEqual(again.json, { error: 'that link or code is not right' });
  });

  test('the sixth request for an address in an hour: the same words, nothing sent', async () => {
    const before = sent.length;
    for (let i = 0; i < 6; i++) {
      const r = await ask('limit@example.com', `10.2.5.${i}`);
      assert.deepEqual(r.json, ANSWER);
    }
    assert.equal(sent.length, before + 5);
  });

  test('signing out clears the cookie and ends the session', async () => {
    await ask('out@example.com', '10.2.6.1');
    const cookie = cookieOf((await press(tokenIn(sent.at(-1)!)!)).headers);
    const r = await call('POST', '/book/signout', { cookie });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie') ?? '', /^book-guest=; .*Path=\/book; Max-Age=0/);
    assert.equal((await call('GET', '/book/me', { cookie })).status, 401);
  });

  test('a guest taken off the list is signed out, and their unused link no longer opens', async () => {
    await ask('gone@example.com', '10.2.7.1');
    const cookie = cookieOf((await press(tokenIn(sent.at(-1)!)!)).headers);
    assert.equal((await call('GET', '/book/me', { cookie })).status, 200);
    await ask('gone@example.com', '10.2.7.1');
    const unused = tokenIn(sent.at(-1)!)!;
    // Through the server's own store, as the guest list in Settings will.
    await (await households.open('home')).append('alice', { op: 'guest.revoke', email: 'gone@example.com', why: 'moved away' });
    assert.equal((await call('GET', '/book/me', { cookie })).status, 401);
    const r = await press(unused);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
  });

  test('anything else under /book is not found', async () => {
    assert.equal((await call('GET', '/book/nothing-here')).status, 404);
  });
});

describe('the guest door takes a POST only from its own page', () => {
  const JSON_POSTS = ['/book/start', '/book/code', '/book/signout', '/book/request', '/book/cancel', '/book/change', '/book/accept-suggestion'];

  test('a text/plain body from another site, or with no Origin: 403, the page that says it did not work, and nothing happens', async () => {
    const before = sent.length;
    for (const path of JSON_POSTS) {
      for (const origin of ['https://evil.example.net', 'null', 'http://book.example.com', 'https://book.example.com:8443', null]) {
        const r = await call('POST', path, {
          origin, headers: { 'content-type': 'text/plain' }, ip: '10.2.9.1',
          body: { email: 'guests@example.com', code: '123456', id: 'x' },
        });
        assert.equal(r.status, 403, `${path} from ${origin}`);
        assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
        assert.match(r.text, /That did not work/);
        assert.equal(r.headers.get('set-cookie'), null, path);
      }
    }
    assert.equal(sent.length, before, 'no sign-in mail went');
  });

  test('from the page\'s own origin but not JSON: 415', async () => {
    for (const path of JSON_POSTS) {
      for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const r = await call('POST', path, { headers: { 'content-type': type }, body: { email: 'guests@example.com' }, ip: '10.2.9.2' });
        assert.equal(r.status, 415, `${path} as ${type}`);
      }
    }
    // JSON with a charset is JSON.
    const ok = await call('POST', '/book/start', { headers: { 'content-type': 'application/json; charset=utf-8' },
      body: { email: 'stranger@example.com' }, ip: '10.2.9.3' });
    assert.equal(ok.status, 200);
  });

  test('a body over 8 KB is refused (413); an address over 254 characters is no address, and nothing is sent', async () => {
    const big = await call('POST', '/book/start', { body: { email: 'guests@example.com', pad: 'x'.repeat(9000) }, ip: '10.2.9.4' });
    assert.equal(big.status, 413);
    const before = sent.length;
    const long = await call('POST', '/book/start', { body: { email: `${'g'.repeat(250)}@example.com` }, ip: '10.2.9.5' });
    assert.equal(long.status, 200);
    assert.deepEqual(long.json, ANSWER);
    const code = await call('POST', '/book/code', { body: { email: `${'g'.repeat(250)}@example.com`, code: '123456' }, ip: '10.2.9.5' });
    assert.equal(code.status, 401);
    assert.equal(sent.length, before);
  });

  test('ten wrong codes for an address in a day: its right code is refused after, fresh email or not; the link still works', async () => {
    await (await households.open('home')).append('alice', { op: 'guest.allow', email: 'budget@example.com', name: 'Budget', why: 'old friends' });
    for (let round = 0; round < 2; round++) {
      await ask('budget@example.com', `10.2.10.${round}`);
      const wrong = codeIn(sent.at(-1)!) === '123456' ? '654321' : '123456';
      for (let i = 0; i < 5; i++) {
        const r = await call('POST', '/book/code', { body: { email: 'budget@example.com', code: wrong }, ip: `10.2.10.${round}` });
        assert.equal(r.status, 401);
      }
    }
    await ask('budget@example.com', '10.2.10.7');
    const m = sent.at(-1)!;
    assert.equal(m.to, 'budget@example.com');
    const r = await call('POST', '/book/code', { body: { email: 'budget@example.com', code: codeIn(m) }, ip: '10.2.10.7' });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'that link or code is not right' });
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal((await press(tokenIn(m)!)).status, 303);
  });

  test('thirty codes an hour from one address: the thirty-first is 429, and another address is still heard', async () => {
    for (let i = 0; i < 30; i++) {
      const r = await call('POST', '/book/code', { body: { email: `nobody-${i}@example.com`, code: '000000' }, ip: '10.2.11.1' });
      assert.equal(r.status, 401, String(i));
    }
    const over = await call('POST', '/book/code', { body: { email: 'nobody@example.com', code: '000000' }, ip: '10.2.11.1' });
    assert.equal(over.status, 429);
    const other = await call('POST', '/book/code', { body: { email: 'nobody@example.com', code: '000000' }, ip: '10.2.11.2' });
    assert.equal(other.status, 401);
  });

  test('IPv6 is counted by its /64: twenty asks from one network, and the twenty-first from a neighbour sends nothing', async () => {
    await (await households.open('home')).append('alice', { op: 'guest.allow', email: 'six@example.com', name: 'Six', why: 'old friends' });
    for (let i = 0; i < 20; i++) await ask(`nobody-${i}@example.com`, `2001:db8:1:2::${(i + 1).toString(16)}`);
    const before = sent.length;
    await ask('six@example.com', '2001:db8:1:2:ffff:ffff:ffff:fffe');
    assert.equal(sent.length, before, 'the same /64');
    await ask('six@example.com', '2001:db8:1:3::1');
    assert.equal(sent.length, before + 1, 'the next /64 is another bucket');
  });

  test('a member\'s password: ten tries a minute from one address, then 429 in plain words; another address is heard', async () => {
    const login = (ip: string) => call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' }, ip });
    for (let i = 0; i < 10; i++) assert.equal((await login('10.2.12.1')).status, 401, String(i));
    const over = await login('10.2.12.1');
    assert.equal(over.status, 429);
    assert.match(over.json.error, /too many/i);
    // Even the right password waits it out.
    const right = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'correct-horse' }, ip: '10.2.12.1' });
    assert.equal(right.status, 429);
    assert.equal((await login('10.2.12.2')).status, 401);
  });

  test('twenty wrong passwords at once from one address: at most ten reach DSM, the rest are 429', async () => {
    const asked = () => dsmSaid.filter((l) => /login "alice"/.test(l)).length;
    const before = asked();
    const all = await Promise.all(Array.from({ length: 20 }, () =>
      call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' }, ip: '10.2.14.1' })));
    const statuses = all.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 10, statuses.join(','));
    assert.equal(statuses.filter((s) => s === 429).length, 10, statuses.join(','));
    assert.equal(asked() - before, 10, 'only ten were put to DSM');
  });

  test('a right password takes no place in the count: after it, ten wrong ones are still heard', async () => {
    const ok = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'correct-horse' }, ip: '10.2.15.1' });
    assert.equal(ok.status, 200);
    for (let i = 0; i < 10; i++) {
      assert.equal((await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' }, ip: '10.2.15.1' })).status, 401, String(i));
    }
    assert.equal((await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' }, ip: '10.2.15.1' })).status, 429);
  });

  test('a guest\'s cancel takes no words from them: the reason is the app\'s own', async () => {
    await ask('guests@example.com', '10.2.13.1');
    const cookie = cookieOf((await press(tokenIn(sent.at(-1)!)!)).headers);
    const o = await call('POST', '/book/request', { cookie, body: { arrive: '2099-03-02', depart: '2099-03-04', headcount: 1, note: '' } });
    assert.equal(o.status, 200);
    const c = await call('POST', '/book/cancel', { cookie, body: { id: o.json.id, why: 'Call me on 555-0100, I am the household now' } });
    assert.equal(c.status, 200);
    const line = (await (await households.open('home')).since(null)).find((e) => e.id === c.json.id) as { why: string };
    assert.equal(line.why, 'withdrawn by the guest');
  });
});

describe('which nights are open, over HTTP', () => {
  const MONTH = '2099-12';
  const day = (d: number) => `${MONTH}-${String(d).padStart(2, '0')}`;
  let mine = '';       // a guest's cookie
  let theirs = '';     // another guest's
  let alice = '';      // a member's

  async function guestIn(email: string, ip: string): Promise<string> {
    await ask(email, ip);
    return cookieOf((await press(tokenIn(sent.at(-1)!)!)).headers);
  }

  before(async () => {
    const home = await households.open('home');
    await home.append('alice', [
      { op: 'guest.allow', email: 'nights@example.com', name: 'Nights family', why: 'friends' },
      { op: 'guest.allow', email: 'nights2@example.com', name: 'Second family', why: 'friends' },
      { op: 'booking.confirm', request: 'r-nights', email: 'nights@example.com', arrive: day(12), depart: day(15), headcount: 3,
        cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', evt_id: 7, ical_uid: 'uid-7', dav_etag: '"1"' },
      { op: 'booking.block', from: day(24), to: day(26), why: 'family is here' },
    ]);
    await home.append('guest:nights2@example.com', {
      op: 'proposal.offer', tool: 'approve_booking',
      args: { email: 'nights2@example.com', name: 'Second family', arrive: day(20), depart: day(22), headcount: 2, note: 'private note' },
      summary: 'Second family would like to come', effects: [], events: [], budget: null, month: null, envelopes: [],
      fingerprint: '', prompt: { kind: 'booking', ref: null },
    } as never);
    mine = await guestIn('nights@example.com', '10.2.8.1');
    theirs = await guestIn('nights2@example.com', '10.2.8.2');
    const login = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'correct-horse' } });
    assert.equal(login.status, 200);
    alice = cookieOf(login.headers);
  });

  const rowOf = (rows: { night: string }[], d: number) => rows.find((r) => r.night === day(d)) as Record<string, unknown>;

  test('a guest is shown the month: stay mine, request another\'s taken, block taken, the rest open', async () => {
    const r = await call('GET', `/book/nights?month=${MONTH}`, { cookie: mine });
    assert.equal(r.status, 200);
    const rows = r.json.nights as { night: string; status: string }[];
    assert.equal(rows.length, 31);
    assert.deepEqual([11, 12, 14, 15, 20, 21, 22, 24, 25, 26].map((d) => rowOf(rows, d)['status']),
      ['open', 'mine-approved', 'mine-approved', 'open', 'taken', 'taken', 'open', 'taken', 'taken', 'open']);
    const other = await call('GET', `/book/nights?month=${MONTH}`, { cookie: theirs });
    const orows = other.json.nights as { night: string; status: string }[];
    assert.deepEqual([12, 14, 15, 20, 21, 22].map((d) => rowOf(orows, d)['status']),
      ['taken', 'taken', 'open', 'mine-pending', 'mine-pending', 'open']);
  });

  test('a guest\'s answer has a night and a status for each row and nothing else', async () => {
    for (const cookie of [mine, theirs]) {
      const r = await call('GET', `/book/nights?month=${MONTH}`, { cookie });
      assert.deepEqual(Object.keys(r.json).sort(), ['month', 'nights']);
      for (const row of r.json.nights) assert.deepEqual(Object.keys(row).sort(), ['night', 'status']);
      for (const secret of ['Nights family', 'Second family', 'family is here', 'private note', 'alice', 'example.com', 'r-nights', 'uid-7']) {
        if (cookie === theirs && secret === 'example.com') continue;
        assert.ok(!r.text.includes(secret), `${secret} in ${r.text}`);
      }
    }
  });

  test('without a guest session, 401; with a member\'s cookie in the guest\'s place, 401', async () => {
    assert.equal((await call('GET', `/book/nights?month=${MONTH}`)).status, 401);
    assert.equal((await call('GET', `/book/nights?month=${MONTH}`, { cookie: alice })).status, 401);
    assert.equal((await call('GET', `/book/nights?month=${MONTH}`, { cookie: 'book-guest=' + '0'.repeat(64) })).status, 401);
  });

  test('a month that is not YYYY-MM, or none: 400', async () => {
    for (const q of ['', '?month=', '?month=2099-13', '?month=2099-1', '?month=december', '?month=2099-12-01', '?month=2099-12&month=2099-11']) {
      const r = await call('GET', `/book/nights${q}`, { cookie: mine });
      assert.equal(r.status, 400, q);
    }
  });

  test('past nights are taken: a whole month back, and this month up to today', async () => {
    const long = await call('GET', '/book/nights?month=2000-01', { cookie: mine });
    assert.equal(long.status, 200);
    assert.ok(long.json.nights.every((r: { status: string }) => r.status === 'taken'));
    const today = new Date().toISOString().slice(0, 10);   // TZ=UTC for this process
    const now = await call('GET', `/book/nights?month=${today.slice(0, 7)}`, { cookie: mine });
    for (const r of now.json.nights as { night: string; status: string }[]) {
      assert.equal(r.status, r.night < today ? 'taken' : 'open', r.night);
    }
  });

  test('a guest taken off the list is told 401 here too', async () => {
    const gone = await guestIn('nights2@example.com', '10.2.8.3');
    assert.equal((await call('GET', `/book/nights?month=${MONTH}`, { cookie: gone })).status, 200);
    const home = await households.open('home');
    await home.append('alice', { op: 'guest.allow', email: 'late@example.com', name: 'Late', why: 'friends' });
    await ask('late@example.com', '10.2.8.4');
    const late = cookieOf((await press(tokenIn(sent.at(-1)!)!)).headers);
    await home.append('alice', { op: 'guest.revoke', email: 'late@example.com', why: 'moved' });
    assert.equal((await call('GET', `/book/nights?month=${MONTH}`, { cookie: late })).status, 401);
  });

  test('a member sees why: who, which kind, and the reason a night was kept', async () => {
    const r = await call('GET', `/api/bookings/nights?month=${MONTH}`, { cookie: alice });
    assert.equal(r.status, 200);
    const rows = r.json.nights as { night: string }[];
    assert.deepEqual(rowOf(rows, 12), { night: day(12), status: 'taken', kind: 'stay', by: 'Nights family' });
    assert.deepEqual(rowOf(rows, 21), { night: day(21), status: 'taken', kind: 'pending', by: 'Second family' });
    assert.deepEqual(rowOf(rows, 25), { night: day(25), status: 'taken', kind: 'block', by: 'alice', why: 'family is here' });
    assert.deepEqual(rowOf(rows, 15), { night: day(15), status: 'open' });
    const past = await call('GET', '/api/bookings/nights?month=2000-01', { cookie: alice });
    assert.deepEqual(past.json.nights[0], { night: '2000-01-01', status: 'taken', kind: 'past' });
  });

  test('a member: a bad month is 400; no session is 401; a guest\'s cookie is 401', async () => {
    assert.equal((await call('GET', '/api/bookings/nights?month=nope', { cookie: alice })).status, 400);
    assert.equal((await call('GET', '/api/bookings/nights')).status, 401);
    assert.equal((await call('GET', `/api/bookings/nights?month=${MONTH}`, { cookie: mine })).status, 401);
  });

  test('a member of another household is told 404', async () => {
    const elsewhere = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'correct-horse' } });
    const cookie = cookieOf(elsewhere.headers);
    const made = await call('POST', '/api/households', { body: { label: 'Elsewhere' }, cookie });
    assert.equal(made.status, 200);
    const r = await call('GET', `/api/bookings/nights?month=${MONTH}`, { cookie });
    assert.equal(r.status, 404);
    assert.ok(!/Nights|family|alice/.test(r.text), r.text);
    // Back in the booking household it answers.
    await call('POST', '/api/households/select', { body: { household: 'home' }, cookie });
    assert.equal((await call('GET', `/api/bookings/nights?month=${MONTH}`, { cookie })).status, 200);
  });
});

describe('a request is a card, over HTTP', () => {
  const MONTH = '2099-11';
  const day = (d: number) => `${MONTH}-${String(d).padStart(2, '0')}`;
  const stay = (from: number, to: number, extra: Record<string, unknown> = {}) =>
    ({ arrive: day(from), depart: day(to), headcount: 3, note: "We'd love to see the house!", ...extra });
  let ann = '';       // a guest's cookie
  let ben = '';       // another guest's
  let alice = '';     // a member's

  async function guestIn(email: string, ip: string): Promise<string> {
    await ask(email, ip);
    return cookieOf((await press(tokenIn(sent.at(-1)!)!)).headers);
  }

  before(async () => {
    const home = await households.open('home');
    await home.append('alice', [
      { op: 'guest.allow', email: 'ann@example.com', name: 'The Nguyens', why: 'friends' },
      { op: 'guest.allow', email: 'ben@example.com', name: 'Ben and Jo', why: 'friends' },
    ]);
    ann = await guestIn('ann@example.com', '10.2.9.1');
    ben = await guestIn('ben@example.com', '10.2.9.2');
    const login = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'correct-horse' } });
    alice = cookieOf(login.headers);
    // alice has two households by now (the nights tests made another): open the one friends book with.
    assert.equal((await call('POST', '/api/households/select', { body: { household: 'home' }, cookie: alice })).status, 200);
  });

  test('a guest asks: an open card, authored by them, and its nights are theirs', async () => {
    const r = await call('POST', '/book/request', { cookie: ann, body: { ...stay(12, 15), name: 'Mallory', email: 'm@example.com' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json), ['id']);
    const o = (await households.open('home')).state.thread.offers.get(r.json.id)!;
    assert.equal(o.who, 'guest:ann@example.com');
    assert.equal(o.status, 'open');
    assert.deepEqual(o.args, { email: 'ann@example.com', name: 'The Nguyens', ...stay(12, 15) });
    const nights = await call('GET', `/book/nights?month=${MONTH}`, { cookie: ann });
    assert.equal(nights.json.nights[12].status, 'mine-pending');
  });

  test('the same guest over their own nights: "you already have"; another guest: "taken", and no more', async () => {
    const again = await call('POST', '/book/request', { cookie: ann, body: stay(14, 17) });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /already/);
    const other = await call('POST', '/book/request', { cookie: ben, body: stay(13, 14) });
    assert.equal(other.status, 409);
    assert.match(other.json.error, /taken/);
    assert.ok(!/Nguyen|ann@|love/.test(other.text), other.text);
    const bad = await call('POST', '/book/request', { cookie: ben, body: stay(20, 19) });
    assert.equal(bad.status, 400);
    const notJson = await call('POST', '/book/request', { cookie: ben, body: [1, 2] });
    assert.equal(notJson.status, 400);
  });

  test('the card waits for the members on Today, in the guest\'s name and not their address', async () => {
    const r = await call('GET', '/api/thread?filter=waiting', { cookie: alice });
    assert.equal(r.status, 200, r.text);
    const card = r.json.entries.find((e: any) => e.kind === 'card' && e.offer.tool === 'approve_booking' && e.offer.who === 'guest:ann@example.com');
    assert.ok(card, JSON.stringify(r.json.entries.map((e: any) => e.kind)));
    assert.equal(card.offer.summary, 'The Nguyens would like to come Nov 12–15, 2099, 3 people: “We\'d love to see the house!”');
    assert.ok(!card.offer.summary.includes('@'));
    assert.ok(r.json.waiting.some((w: any) => w.kind === 'offer' && w.offer.id === card.offer.id));
  });

  test('without a guest session, or with a member\'s cookie, every request route is 401', async () => {
    for (const [method, path] of [['POST', '/book/request'], ['GET', '/book/mine'], ['POST', '/book/cancel'], ['POST', '/book/change']] as const) {
      for (const cookie of [undefined, alice]) {
        const r = await call(method, path, { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { body: stay(1, 2) } : {}) });
        assert.equal(r.status, 401, `${path} ${cookie ? 'member' : 'none'}`);
      }
    }
  });

  test('a member cannot run approve_booking as a tool: it is answered on its card', async () => {
    const r = await call('POST', '/api/tools/approve_booking', { cookie: alice, body: { email: 'ann@example.com', name: 'x', ...stay(1, 2) } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /card/);
    const tools = await call('GET', '/api/tools', { cookie: alice });
    assert.ok(!tools.text.includes('approve_booking'));
  });

  test('/book/mine is the guest\'s own and nobody else\'s; a decline brings its reason', async () => {
    const b = await call('POST', '/book/request', { cookie: ben, body: stay(20, 22, { note: 'ben note' }) });
    assert.equal(b.status, 200, b.text);
    const declined = await call('POST', '/api/thread/decide', { cookie: alice, body: { offer: b.json.id, decision: 'declined', why: 'we are away' } });
    assert.equal(declined.status, 200, declined.text);
    const mineA = await call('GET', '/book/mine', { cookie: ann });
    assert.equal(mineA.status, 200);
    assert.deepEqual(mineA.json.requests.map((x: any) => [x.arrive, x.status]), [[day(12), 'pending']]);
    assert.ok(!/ben|Ben|we are away/.test(mineA.text), mineA.text);
    const mineB = await call('GET', '/book/mine', { cookie: ben });
    assert.deepEqual(mineB.json.requests, [
      { id: b.json.id, arrive: day(20), depart: day(22), headcount: 3, note: 'ben note', status: 'declined', why: 'we are away' },
    ]);
    assert.ok(!/ann|Nguyen|love/.test(mineB.text), mineB.text);
  });

  test('a guest changes or cancels their own: the line lands, by them; anyone else\'s is not found', async () => {
    const home = await households.open('home');
    const id = (await call('GET', '/book/mine', { cookie: ann })).json.requests[0].id;
    // Someone else's id, and one that does not exist: the same 404.
    for (const body of [{ id }, { id: 'nope' }]) {
      const r = await call('POST', '/book/cancel', { cookie: ben, body });
      assert.equal(r.status, 404, JSON.stringify(body));
    }
    assert.equal((await call('POST', '/book/change', { cookie: ben, body: { id, ...stay(1, 2) } })).status, 404);
    const badChange = await call('POST', '/book/change', { cookie: ann, body: { id, ...stay(5, 4) } });
    assert.equal(badChange.status, 400);

    // A change is the old one withdrawn and a new request, by them, saying what it was.
    const changed = await call('POST', '/book/change', { cookie: ann, body: { id, ...stay(13, 16, { headcount: 2, note: 'a day later' }) } });
    assert.equal(changed.status, 200, changed.text);
    assert.deepEqual(Object.keys(changed.json), ['id']);
    const fresh = home.state.thread.offers.get(changed.json.id)!;
    assert.equal(fresh.who, 'guest:ann@example.com');
    assert.equal(fresh.status, 'open');
    assert.deepEqual(fresh.args, { email: 'ann@example.com', name: 'The Nguyens', ...stay(13, 16, { headcount: 2, note: 'a day later' }), changedFrom: { arrive: day(12), depart: day(15) } });
    assert.match(fresh.summary, /^Changed from Nov 12–15, 2099: The Nguyens would like to come Nov 13–16, 2099, 2 people/);
    assert.equal(home.state.thread.offers.get(id)!.status, 'replaced');
    const both = await call('GET', '/book/mine', { cookie: ann });
    assert.deepEqual(both.json.requests.map((r: any) => [r.arrive, r.status]), [[day(12), 'cancelled'], [day(13), 'pending']]);

    const cancelled = await call('POST', '/book/cancel', { cookie: ann, body: { id: fresh.id } });
    assert.equal(cancelled.status, 200, cancelled.text);
    const c = (await home.since(null)).find((e) => e.id === cancelled.json.id) as any;
    assert.equal(c.op, 'booking.cancel');
    assert.equal(c.who, 'guest:ann@example.com');
    assert.equal(c.stay, fresh.id);
    assert.ok(c.why.trim());
    const after = await call('GET', '/book/mine', { cookie: ann });
    assert.deepEqual(after.json.requests.map((r: any) => r.status), ['cancelled', 'cancelled']);
    // On Today the line names them as the list does, never by their address.
    const today = await call('GET', '/api/thread', { cookie: alice });
    const line = today.json.entries.find((e: any) => e.id === cancelled.json.id);
    assert.equal(line.kind, 'change');
    assert.equal(line.name, 'The Nguyens');
    // A reason of their own is not taken: the line says the app's words.
    const again = await call('POST', '/book/request', { cookie: ann, body: stay(25, 27) });
    const why = await call('POST', '/book/cancel', { cookie: ann, body: { id: again.json.id, why: 'flights fell through' } });
    assert.equal((await home.since(null)).find((e) => e.id === why.json.id)!.why, 'withdrawn by the guest');
  });
});

describe('approve, decline and suggest, over HTTP', () => {
  const MONTH = '2098-12';
  const day = (d: number) => `${MONTH}-${String(d).padStart(2, '0')}`;
  const stay = (from: number, to: number, extra: Record<string, unknown> = {}) =>
    ({ arrive: day(from), depart: day(to), headcount: 2, note: 'see you', ...extra });
  let cat = '';
  let dan = '';
  let alice = '';

  async function guestIn(email: string, ip: string): Promise<string> {
    await ask(email, ip);
    return cookieOf((await press(tokenIn(sent.at(-1)!)!)).headers);
  }

  before(async () => {
    const home = await households.open('home');
    await home.append('alice', [
      { op: 'guest.allow', email: 'cat@example.com', name: 'Cat', why: 'friends' },
      { op: 'guest.allow', email: 'dan@example.com', name: 'Dan and Eve', why: 'friends' },
    ]);
    cat = await guestIn('cat@example.com', '10.2.10.1');
    dan = await guestIn('dan@example.com', '10.2.10.2');
    const login = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'correct-horse' } });
    alice = cookieOf(login.headers);
    assert.equal((await call('POST', '/api/households/select', { body: { household: 'home' }, cookie: alice })).status, 200);
  });

  test('a member approves: the stay is the guest\'s, and they are mailed', async () => {
    const r = await call('POST', '/book/request', { cookie: cat, body: stay(1, 4) });
    assert.equal(r.status, 200, r.text);
    const before = sent.length;
    const ok = await call('POST', '/api/thread/decide', { cookie: alice, body: { offer: r.json.id, decision: 'approved' } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json.committed.map((e: any) => e.op), ['proposal.decide', 'booking.confirm']);
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1)!.to, 'cat@example.com');
    assert.match(sent.at(-1)!.text, /Dec 1–4, 2098/);
    const mine = await call('GET', '/book/mine', { cookie: cat });
    assert.equal(mine.json.requests[0].status, 'approved');
    const nights = await call('GET', `/book/nights?month=${MONTH}`, { cookie: cat });
    assert.equal(nights.json.nights[1].status, 'mine-approved');
  });

  test('a member suggests other dates: two mails, and the guest sees them; accepting asks again, once', async () => {
    const r = await call('POST', '/book/request', { cookie: dan, body: stay(10, 12) });
    assert.equal(r.status, 200, r.text);
    const before = sent.length;
    const s = await call('POST', '/api/bookings/suggest', { cookie: alice, body: { offer: r.json.id, arrive: day(20), depart: day(22), why: 'we are full that week' } });
    assert.equal(s.status, 200, s.text);
    assert.deepEqual(Object.keys(s.json), ['id']);
    assert.equal(sent.length, before + 2);
    assert.ok(sent.slice(before).every((m) => m.to === 'dan@example.com'));
    assert.ok(sent.at(-1)!.text.includes(`https://book.example.com/book?suggest=${s.json.id}`));
    const mine = await call('GET', '/book/mine', { cookie: dan });
    assert.deepEqual(mine.json.requests.map((x: any) => [x.status, x.why, x.suggested]),
      [['suggested', 'we are full that week', { id: s.json.id, arrive: day(20), depart: day(22) }]]);
    // Someone else's suggestion is as unknown as none.
    assert.equal((await call('POST', '/book/accept-suggestion', { cookie: cat, body: { id: s.json.id } })).status, 404);
    const a = await call('POST', '/book/accept-suggestion', { cookie: dan, body: { id: s.json.id } });
    assert.equal(a.status, 200, a.text);
    const home = await households.open('home');
    assert.match(home.state.thread.offers.get(a.json.id)!.summary, /^You suggested these: Dan and Eve would like to come Dec 20–22, 2098/);
    const twice = await call('POST', '/book/accept-suggestion', { cookie: dan, body: { id: s.json.id } });
    assert.equal(twice.status, 409);
    // Taken up, the suggestion says so, and the fresh request is there beside it.
    const after = await call('GET', '/book/mine', { cookie: dan });
    assert.deepEqual(after.json.requests.map((x: any) => [x.status, x.suggested]), [
      ['suggested', { id: s.json.id, arrive: day(20), depart: day(22), asked: true }],
      ['pending', undefined],
    ]);
  });

  test('suggesting: a bad date is 400, an unknown card 404, a guest or nobody 401', async () => {
    const r = await call('POST', '/book/request', { cookie: cat, body: stay(26, 28) });
    assert.equal(r.status, 200, r.text);
    const bad = await call('POST', '/api/bookings/suggest', { cookie: alice, body: { offer: r.json.id, arrive: day(5), depart: day(3), why: 'w' } });
    assert.equal(bad.status, 400);
    const none = await call('POST', '/api/bookings/suggest', { cookie: alice, body: { offer: 'nope', arrive: day(5), depart: day(7), why: 'w' } });
    assert.equal(none.status, 404);
    for (const cookie of [undefined, cat]) {
      const r2 = await call('POST', '/api/bookings/suggest', { ...(cookie ? { cookie } : {}), body: { offer: r.json.id, arrive: day(5), depart: day(7), why: 'w' } });
      assert.equal(r2.status, 401);
    }
  });

  test('a change onto another guest\'s nights is "taken", and the stay stands', async () => {
    const home = await households.open('home');
    const id = (await call('GET', '/book/mine', { cookie: cat })).json.requests[0].id;
    const n = (await home.since(null)).length;
    const r = await call('POST', '/book/change', { cookie: cat, body: { id, ...stay(19, 21) } });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error, /taken/);
    assert.ok(!/Dan|dan@/.test(r.text), r.text);
    assert.equal((await home.since(null)).length, n);
    assert.equal((await call('GET', '/book/mine', { cookie: cat })).json.requests[0].status, 'approved');
  });

  test('a change to a confirmed stay: the stay stays approved, the change waits saying what it replaces; declined, the stay stands', async () => {
    const id = (await call('GET', '/book/mine', { cookie: cat })).json.requests[0].id;
    const r = await call('POST', '/book/change', { cookie: cat, body: { id, ...stay(2, 6) } });
    assert.equal(r.status, 200, r.text);
    const rows = (await call('GET', '/book/mine', { cookie: cat })).json.requests;
    const stayRow = rows.find((x: any) => x.id === id);
    const change = rows.find((x: any) => x.id === r.json.id);
    assert.equal(stayRow.status, 'approved');
    assert.equal(change.status, 'pending');
    const home = await households.open('home');
    const stayId = [...home.state.stays].find(([, s]) => s.request === id)![0];
    assert.equal(change.replaces, stayId);
    // Its nights stay the guest's, as confirmed, while the change waits.
    const nights = await call('GET', `/book/nights?month=${MONTH}`, { cookie: cat });
    assert.equal(nights.json.nights[0].status, 'mine-approved');
    assert.equal(nights.json.nights[4].status, 'mine-pending');
    const before = sent.length;
    const no = await call('POST', '/api/thread/decide', { cookie: alice, body: { offer: r.json.id, decision: 'declined', why: 'the 5th is taken by family' } });
    assert.equal(no.status, 200, no.text);
    assert.equal(sent.length, before + 1);
    assert.match(sent.at(-1)!.text, /Your stay on Dec 1–4, 2098 stands/);
    const after = (await call('GET', '/book/mine', { cookie: cat })).json.requests;
    assert.equal(after.find((x: any) => x.id === id).status, 'approved');
    assert.equal(after.find((x: any) => x.id === r.json.id).status, 'declined');
  });
});

describe('the client address behind proxies', () => {
  test('n proxies: the entry n from the right, whatever the client wrote before it', () => {
    assert.equal(clientAddress('6.6.6.6, 198.51.100.7', '172.17.0.1', 1), '198.51.100.7');
    assert.equal(clientAddress('198.51.100.7', '172.17.0.1', 1), '198.51.100.7');
    assert.equal(clientAddress('6.6.6.6, 198.51.100.7, 10.0.0.2', '172.17.0.1', 2), '198.51.100.7');
    assert.equal(clientAddress(['6.6.6.6', '198.51.100.7'], '172.17.0.1', 1), '198.51.100.7');
  });

  test('no proxy trusted, no header, or one too short: the socket', () => {
    assert.equal(clientAddress('198.51.100.7', '172.17.0.1', 0), '172.17.0.1');
    assert.equal(clientAddress(undefined, '172.17.0.1', 1), '172.17.0.1');
    assert.equal(clientAddress(' , ', '172.17.0.1', 1), '172.17.0.1');
    assert.equal(clientAddress('198.51.100.7', '172.17.0.1', 2), '172.17.0.1');
  });
});

describe('IPv6 by its /64, and a proxy that does not match TRUST_PROXY', () => {
  test('an IPv6 address is its /64; IPv4 and IPv4-mapped are themselves; anything else as it came', () => {
    assert.equal(ipBucket('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
    assert.equal(ipBucket('2001:db8:1:2::9'), '2001:db8:1:2::/64');
    assert.equal(ipBucket('2001:0db8:0001:0002::'), '2001:db8:1:2::/64');
    assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(ipBucket('::1'), '0:0:0:0::/64');
    assert.equal(ipBucket('fe80::1%en0'), 'fe80:0:0:0::/64');
    assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
    assert.equal(ipBucket('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(ipBucket('unknown'), 'unknown');
  });

  test('a proxy trusted but no X-Forwarded-For, or one sent with no proxy trusted: a warning that names it; else nothing', () => {
    assert.match(proxyMismatch(1, undefined) ?? '', /TRUST_PROXY.*X-Forwarded-For/);
    assert.match(proxyMismatch(0, '203.0.113.7') ?? '', /X-Forwarded-For.*TRUST_PROXY/);
    assert.equal(proxyMismatch(1, '203.0.113.7'), null);
    assert.equal(proxyMismatch(0, undefined), null);
    assert.equal(proxyMismatch(0, ''), null);
  });

  test('this server, with TRUST_PROXY=1, was asked under /book with no X-Forwarded-For: it said so once, and only once', () => {
    const said = warned.filter((w) => /X-Forwarded-For/.test(w));
    assert.equal(said.length, 1, said.join('\n'));
    assert.match(said[0]!, /TRUST_PROXY/);
  });
});
