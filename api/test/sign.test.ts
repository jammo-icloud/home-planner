// api/test/sign.test.ts
//
// Signing the calendar profile with a certificate on disk. The certificates
// here are made fresh by the openssl CLI in a temp directory, self-signed for
// planner.example.com; when there is no openssl, every test is skipped and
// says why.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSigner, signProfile, signedOrPlain } from '../src/sign.ts';

const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n<key>PayloadDisplayName</key>\n<string>Home Planner</string>\n</dict>\n</plist>\n';
const DAY = 86_400_000;

const opensslMissing = ((): string | false => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return false;
  } catch {
    return 'openssl is not on this PATH';
  }
})();

let root = '';

/** A self-signed certificate and its key for planner.example.com, valid three days, in `dir`. */
function makeCert(dir: string): void {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'privkey.pem'), '-out', join(dir, 'cert.pem'),
    '-days', '3', '-subj', '/CN=planner.example.com', '-addext', 'subjectAltName=DNS:planner.example.com',
  ], { stdio: 'ignore' });
}

/** A fresh subdirectory of the temp root. */
async function subdir(name: string): Promise<string> {
  const d = join(root, name);
  await mkdir(d, { recursive: true });
  return d;
}

/** openssl's own reading of a signed profile: the content it wraps, line endings as written. */
function verify(der: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('openssl', ['smime', '-verify', '-noverify', '-inform', 'DER'], { encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
    child.stdin!.end(der);
  });
}

before(async () => {
  if (opensslMissing) return;
  root = await mkdtemp(join(tmpdir(), 'pb-sign-'));
  const good = await subdir('good');
  makeCert(good);
  await copyFile(join(good, 'cert.pem'), join(good, 'chain.pem'));
});

after(async () => {
  if (root) {
    // The unreadable key has to be readable again to be removed.
    await chmod(join(root, 'locked', 'privkey.pem'), 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('a directory with a certificate signs as its DNS name until its expiry', { skip: opensslMissing }, async () => {
  const { signer, status } = await loadSigner(join(root, 'good'));
  assert.equal(status.signed, true);
  assert.ok(status.signed);
  assert.equal(status.signedAs, 'planner.example.com');
  const until = Date.parse(status.validTo);
  assert.ok(Number.isFinite(until), status.validTo);
  assert.ok(until > Date.now() && until <= Date.now() + 3 * DAY + 60_000, status.validTo);
  assert.ok(signer);
  assert.equal(signer.cert, join(root, 'good', 'cert.pem'));
  assert.equal(signer.key, join(root, 'good', 'privkey.pem'));
  assert.equal(signer.chain, join(root, 'good', 'chain.pem'));
});

test('the signature wraps the exact profile and openssl can verify it', { skip: opensslMissing }, async () => {
  const { signer } = await loadSigner(join(root, 'good'));
  assert.ok(signer);
  const der = await signProfile(xml, signer);
  assert.equal(der[0], 0x30);
  assert.equal((await verify(der)).replace(/\r\n/g, '\n'), xml);
});

test('no directory, a missing certificate, an unreadable key, an expired certificate, a bad file', { skip: opensslMissing }, async (t) => {
  assert.deepEqual((await loadSigner(undefined)).status, { signed: false, reason: 'no-directory' });
  assert.deepEqual((await loadSigner('')).status, { signed: false, reason: 'no-directory' });
  assert.deepEqual((await loadSigner(join(root, 'nowhere'))).status, { signed: false, reason: 'no-directory' });
  assert.deepEqual((await loadSigner(await subdir('empty'))).status, { signed: false, reason: 'no-certificate' });

  const noKey = await subdir('no-key');
  await copyFile(join(root, 'good', 'cert.pem'), join(noKey, 'cert.pem'));
  assert.deepEqual((await loadSigner(noKey)).status, { signed: false, reason: 'no-certificate' });

  const expired = await loadSigner(join(root, 'good'), () => Date.now() + 10 * DAY);
  assert.deepEqual(expired.status, { signed: false, reason: 'expired' });
  assert.equal(expired.signer, null);

  const bad = await subdir('bad');
  await writeFile(join(bad, 'cert.pem'), 'not a certificate\n');
  await copyFile(join(root, 'good', 'privkey.pem'), join(bad, 'privkey.pem'));
  assert.deepEqual((await loadSigner(bad)).status, { signed: false, reason: 'invalid' });

  await t.test('an unreadable key', { skip: process.getuid?.() === 0 ? 'root reads any file' : false }, async () => {
    const locked = await subdir('locked');
    await copyFile(join(root, 'good', 'cert.pem'), join(locked, 'cert.pem'));
    await copyFile(join(root, 'good', 'privkey.pem'), join(locked, 'privkey.pem'));
    await chmod(join(locked, 'privkey.pem'), 0o000);
    assert.deepEqual((await loadSigner(locked)).status, { signed: false, reason: 'unreadable' });
  });
});

test('a directory with no chain still signs, with no chain', { skip: opensslMissing }, async () => {
  const lone = await subdir('lone');
  await copyFile(join(root, 'good', 'cert.pem'), join(lone, 'cert.pem'));
  await copyFile(join(root, 'good', 'privkey.pem'), join(lone, 'privkey.pem'));
  const { signer } = await loadSigner(lone);
  assert.ok(signer);
  assert.equal(signer.chain, null);
  assert.equal((await verify(await signProfile(xml, signer))).replace(/\r\n/g, '\n'), xml);
});

test('signedOrPlain signs when it can', { skip: opensslMissing }, async () => {
  const out = await signedOrPlain(xml, join(root, 'good'));
  assert.ok(Buffer.isBuffer(out));
  assert.equal(out[0], 0x30);
  assert.equal(await signedOrPlain(xml, undefined), xml);
});

test('signedOrPlain falls back to the XML when openssl cannot sign', { skip: opensslMissing }, async () => {
  // A key that looks right and belongs to another certificate: loadSigner
  // accepts the directory, and openssl refuses to sign with the pair.
  const other = await subdir('other');
  makeCert(other);
  const mismatched = await subdir('mismatched');
  await copyFile(join(root, 'good', 'cert.pem'), join(mismatched, 'cert.pem'));
  await copyFile(join(other, 'privkey.pem'), join(mismatched, 'privkey.pem'));
  assert.equal((await loadSigner(mismatched)).status.signed, true);

  const warn = mock.method(console, 'warn', () => {});
  try {
    const out = await signedOrPlain(xml, mismatched);
    assert.equal(out, xml);
    assert.equal(warn.mock.callCount(), 1);
    const said = warn.mock.calls[0]!.arguments.map(String).join(' ');
    assert.ok(said.includes('profile signing'), said);
    assert.ok(!said.includes('-----BEGIN'), said);
  } finally {
    warn.mock.restore();
  }
});
