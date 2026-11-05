// api/test/server-phone-setup.test.ts
//
// This file sets process.env at module scope (DSM_URL, HOUSEHOLDS_DIR and the
// rest, read once when src/ loads), so the suite depends on node --test
// running each test file in its own process.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';
import { parsePlist } from './plist.ts';

// A real (fake) DSM on a free port, and the app pointed at it. Everything from
// src/ is imported after process.env is set, because it is read on load.
const dir = await mkdtemp(join(tmpdir(), 'pb-server-phone-setup-'));
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
delete process.env['PROFILE_CERT_DIR'];

const { start } = await import('../src/server.ts');
const { saveConnector } = await import('../src/connectors.ts');
const { createPhoneCodes } = await import('../src/phone-setup.ts');

const origin = 'https://planner.example.com';
const ADDRESS_WORDS = "the NAS's address is not set: a DSM administrator sets it under Settings › This NAS › Where phones reach the NAS";

let clock = Date.parse('2026-11-04T12:00:00Z');
let base = '';
let close: () => Promise<void> = async () => {};
let alex = '';
let bob = '';

async function call(cookie: string, method: string, path: string, body?: unknown):
  Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

async function signIn(username: string, password: string): Promise<string> {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `${username} signs in`);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.ok(cookie, `${username} has a cookie`);
  return cookie;
}

/** A code for alex, asked for the way the sheet asks. */
async function issue() {
  const r = await call(alex, 'POST', '/api/phone-setup/code', { origin });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as { code: string; url: string; expiresAt: string; qr: string };
}

/** A path fetched with no session, as a phone fetches it. */
async function open(path: string, method = 'GET') {
  const res = await fetch(base + path, { method });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

type Plist = { PayloadOrganization: string; PayloadContent: Record<string, unknown>[] };
const payload = (p: Plist, type: string) => p.PayloadContent.find((x) => x['PayloadType'] === type)!;
const types = (p: Plist) => p.PayloadContent.map((x) => x['PayloadType']);

function assertProfileHeaders(h: Headers): void {
  assert.equal(h.get('content-type'), 'application/x-apple-aspen-config');
  assert.equal(h.get('content-disposition'), 'attachment; filename="home-planner.mobileconfig"');
  assert.equal(h.get('cache-control'), 'no-store');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
}

before(async () => {
  const server = await start({ phoneCodes: createPhoneCodes(() => clock) });
  base = `http://127.0.0.1:${server.port}`;
  close = server.close;
  // After start(), which loads the saved connections from CONNECTORS_PATH.
  await saveConnector('publicUrl', { value: 'https://nas.example.com:5001' }, 'alex');
  alex = await signIn('alex', 'correct-horse');
  bob = await signIn('bob', 'battery-staple');
  const made = await call(alex, 'POST', '/api/households', { label: 'Larkspur House' });
  assert.equal(made.status, 200);
});

// The temp directory holds a generated private key, so it does not outlive the run.
after(async () => { await close(); await nas.close(); await rm(dir, { recursive: true, force: true }); });

describe('a phone is set up from a one-time link', () => {
  test('a code answers its link, its expiry and the QR as SVG', async () => {
    const r = await issue();
    assert.equal(r.url, `${origin}/setup/${r.code}`);
    assert.equal(Date.parse(r.expiresAt) - clock, 600_000);
    assert.ok(r.qr.startsWith('<svg'), r.qr.slice(0, 40));
  });

  test('the link serves the profile once, then the expired page', async () => {
    const { code } = await issue();
    const first = await open(`/setup/${code}`);
    assert.equal(first.status, 200);
    assertProfileHeaders(first.headers);
    const plist = parsePlist(first.text) as Plist;
    const caldav = payload(plist, 'com.apple.caldav.account');
    assert.equal(caldav['CalDAVHostName'], 'nas.example.com');
    assert.equal(caldav['CalDAVPort'], 5001);
    assert.equal(caldav['CalDAVUsername'], 'alex');
    assert.equal(caldav['CalDAVPrincipalURL'], '/caldav/alex/');

    const second = await open(`/setup/${code}`);
    assert.equal(second.status, 404);
    assert.match(second.headers.get('content-type') ?? '', /^text\/html/);
    assert.ok(second.text.includes('This code has expired'));
    assert.ok(!second.text.includes('Larkspur'));
  });

  test('after ten minutes the link is spent', async () => {
    const { code } = await issue();
    clock += 600_000;
    assert.equal((await open(`/setup/${code}`)).status, 404);
  });

  test('a HEAD does not spend the code', async () => {
    const { code } = await issue();
    const head = await open(`/setup/${code}`, 'HEAD');
    assert.equal(head.status, 200);
    assertProfileHeaders(head.headers);
    assert.equal(head.text, '');
    assert.equal((await open(`/setup/${code}`)).status, 200);
  });

  test('any other method is the expired page, and leaves the code alone', async () => {
    const { code } = await issue();
    const post = await open(`/setup/${code}`, 'POST');
    assert.equal(post.status, 404);
    assert.ok(post.text.includes('This code has expired'));
    assert.equal((await open(`/setup/${code}`)).status, 200);
  });

  test('an unknown code is the expired page, and never the shell', async () => {
    const r = await open('/setup/not-a-code');
    assert.equal(r.status, 404);
    assert.ok(r.text.includes('This code has expired'));
    assert.ok(!r.text.includes('Larkspur'));
  });

  test('a code\'s profile and the Mac download hold the calendar only, whatever home says', async () => {
    const r = await call(alex, 'POST', '/api/phone-setup/code', { home: true, origin });
    assert.equal(r.status, 200);
    assert.deepEqual(types(parsePlist((await open(`/setup/${r.json.code}`)).text) as Plist), ['com.apple.caldav.account']);
    const res = await fetch(`${base}/api/phone-setup/profile?home=1&origin=${encodeURIComponent(origin)}`, { headers: { cookie: alex } });
    assert.deepEqual(types(parsePlist(await res.text()) as Plist), ['com.apple.caldav.account']);
  });

  test('the Home Screen QR is the page\'s address with the marker, and spends no code', async () => {
    const { code } = await issue();
    const r = await call(alex, 'GET', '/api/phone-setup/home?origin=http%3A%2F%2Fplanner.example.com%3A8088');
    assert.equal(r.status, 200);
    assert.equal(r.json.url, 'http://planner.example.com:8088/?add=home');
    assert.ok(r.json.qr.startsWith('<svg'), r.json.qr.slice(0, 40));
    assert.equal((await open(`/setup/${code}`)).status, 200);
  });

  test('a refused origin gets no Home Screen QR', async () => {
    for (const o of ['https://planner.example.com/app', 'ftp://planner.example.com', '']) {
      assert.equal((await call(alex, 'GET', `/api/phone-setup/home?origin=${encodeURIComponent(o)}`)).status, 400, o);
    }
    assert.equal((await call(alex, 'GET', '/api/phone-setup/home')).status, 400);
  });

  test('a bad origin is refused 400 and makes no code', async () => {
    const r = await call(alex, 'POST', '/api/phone-setup/code', { origin: 'http://planner.example.com:8088' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'a phone can be set up only from a page opened over https (or over http on this computer)');
    assert.ok(!('code' in r.json));
  });

  test('with no address there is no code, and the Home Screen QR still works', async () => {
    await saveConnector('publicUrl', { off: true }, 'alex');
    try {
      const r = await call(alex, 'POST', '/api/phone-setup/code', { origin });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, ADDRESS_WORDS);
      const home = await call(alex, 'GET', `/api/phone-setup/home?origin=${encodeURIComponent(origin)}`);
      assert.equal(home.status, 200);
    } finally {
      await saveConnector('publicUrl', { clear: true }, 'alex');
      await saveConnector('publicUrl', { value: 'https://nas.example.com:5001' }, 'alex');
    }
  });

  test('the address is the one the code was made with', async () => {
    const { code } = await issue();
    await saveConnector('publicUrl', { value: 'https://other.example.com' }, 'alex');
    try {
      const plist = parsePlist((await open(`/setup/${code}`)).text) as Plist;
      assert.equal(payload(plist, 'com.apple.caldav.account')['CalDAVHostName'], 'nas.example.com');
    } finally {
      await saveConnector('publicUrl', { value: 'https://nas.example.com:5001' }, 'alex');
    }
  });

  test('a second code replaces the first', async () => {
    const a = await issue();
    const b = await issue();
    assert.equal((await open(`/setup/${a.code}`)).status, 404);
    assert.equal((await open(`/setup/${b.code}`)).status, 200);
  });

  test('no session, no code and no profile', async () => {
    assert.equal((await call('', 'POST', '/api/phone-setup/code', { origin })).status, 401);
    assert.equal((await call('', 'GET', '/api/phone-setup/profile')).status, 401);
  });

  test('no session, no Home Screen QR', async () => {
    assert.equal((await call('', 'GET', `/api/phone-setup/home?origin=${encodeURIComponent(origin)}`)).status, 401);
  });

  test('a code needs an open household', async () => {
    const r = await call(bob, 'POST', '/api/phone-setup/code', { origin });
    assert.equal(r.status, 409);
  });

  test('the Mac download is the calendar profile for the signed-in member', async () => {
    const res = await fetch(`${base}/api/phone-setup/profile`, { headers: { cookie: alex } });
    assert.equal(res.status, 200);
    assertProfileHeaders(res.headers);
    const plist = parsePlist(await res.text()) as Plist;
    assert.deepEqual(types(plist), ['com.apple.caldav.account']);
    assert.equal(payload(plist, 'com.apple.caldav.account')['CalDAVUsername'], 'alex');
    assert.equal(plist.PayloadOrganization, 'Larkspur House');
  });

  test('settings say where phones reach the NAS and whom to ask', async () => {
    assert.deepEqual((await call(alex, 'GET', '/api/settings')).json.phoneSetup,
      { caldav: 'https://nas.example.com:5001/caldav/alex/', nasAdmin: 'alex' });
    await saveConnector('publicUrl', { off: true }, 'alex');
    try {
      assert.equal((await call(alex, 'GET', '/api/settings')).json.phoneSetup.caldav, null);
    } finally {
      await saveConnector('publicUrl', { clear: true }, 'alex');
      await saveConnector('publicUrl', { value: 'https://nas.example.com:5001' }, 'alex');
    }
  });
});

// The signed profile needs the openssl CLI both to make a certificate and to
// read the signature back; without it these are skipped and say why.
const opensslMissing = ((): string | false => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return false;
  } catch {
    return 'openssl is not on this PATH';
  }
})();

/** openssl's reading of a signed profile: the plist it wraps. */
function unwrap(der: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('openssl', ['smime', '-verify', '-noverify', '-inform', 'DER'], { encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
    child.stdin!.end(der);
  });
}

describe('the profile is signed when a copy of the certificate is there', { skip: opensslMissing }, () => {
  const certDir = join(dir, 'cert');

  before(async () => {
    await mkdir(certDir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'privkey.pem'), '-out', join(certDir, 'cert.pem'),
      '-days', '3', '-subj', '/CN=planner.example.com', '-addext', 'subjectAltName=DNS:planner.example.com',
    ], { stdio: 'ignore' });
    await copyFile(join(certDir, 'cert.pem'), join(certDir, 'chain.pem'));
  });

  after(() => { delete process.env['PROFILE_CERT_DIR']; });

  test('the Mac download is signed, and openssl reads the profile back out of it', async () => {
    process.env['PROFILE_CERT_DIR'] = certDir;
    const res = await fetch(`${base}/api/phone-setup/profile`, { headers: { cookie: alex } });
    assert.equal(res.status, 200);
    assertProfileHeaders(res.headers);
    const der = Buffer.from(await res.arrayBuffer());
    assert.equal(der[0], 0x30);
    const plist = parsePlist(await unwrap(der)) as Plist & { PayloadDisplayName: string };
    assert.equal(plist.PayloadDisplayName, 'Home Planner');
  });

  test('a code\'s link is signed too, and a HEAD still answers headers and no body', async () => {
    process.env['PROFILE_CERT_DIR'] = certDir;
    const { code } = await issue();
    const head = await open(`/setup/${code}`, 'HEAD');
    assert.equal(head.status, 200);
    assertProfileHeaders(head.headers);
    assert.equal(head.text, '');
    const res = await fetch(`${base}/setup/${code}`);
    assert.equal(res.status, 200);
    const der = Buffer.from(await res.arrayBuffer());
    assert.equal(der[0], 0x30);
    assert.equal((parsePlist(await unwrap(der)) as Plist & { PayloadDisplayName: string }).PayloadDisplayName, 'Home Planner');
  });

  test('with no directory set the profile is the XML as before', async () => {
    delete process.env['PROFILE_CERT_DIR'];
    const res = await fetch(`${base}/api/phone-setup/profile`, { headers: { cookie: alex } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.startsWith('<?xml'), text.slice(0, 40));
    assert.equal((parsePlist(text) as Plist & { PayloadDisplayName: string }).PayloadDisplayName, 'Home Planner');
  });

  test('an empty directory setting is unset, and the profile is the XML', async () => {
    process.env['PROFILE_CERT_DIR'] = '';
    const res = await fetch(`${base}/api/phone-setup/profile`, { headers: { cookie: alex } });
    assert.ok((await res.text()).startsWith('<?xml'));
  });
});
