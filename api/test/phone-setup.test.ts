import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedOrigin, createPhoneCodes } from '../src/phone-setup.ts';
import type { SetupEntry } from '../src/phone-setup.ts';

const ask = {
  member: 'alex', household: 'Larkspur House', flags: { calendar: true, home: true },
  origin: 'https://planner.example.com', dsmPublicUrl: 'https://nas.example.com:5001',
};

test('a code is 32 random bytes as base64url, with its link and expiry', () => {
  const t = 1_000_000;
  const codes = createPhoneCodes(() => t);
  const { code, url, expiresAt } = codes.issue(ask);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url, `https://planner.example.com/setup/${code}`);
  assert.equal(expiresAt, t + 600_000);
  assert.notEqual(codes.issue({ ...ask, member: 'bob' }).code, code);
});

test('a code is redeemed once', () => {
  const codes = createPhoneCodes(() => 1_000_000);
  const { code, expiresAt } = codes.issue(ask);
  const expected: SetupEntry = { ...ask, expiresAt };
  assert.deepEqual(codes.redeem(code), expected);
  assert.equal(codes.redeem(code), null);
});

test('peek does not spend it', () => {
  const codes = createPhoneCodes(() => 1_000_000);
  const { code } = codes.issue(ask);
  assert.ok(codes.peek(code));
  assert.ok(codes.peek(code));
  assert.ok(codes.redeem(code));
});

test('ten minutes and it is gone', () => {
  let t = 1_000_000;
  const codes = createPhoneCodes(() => t);
  const { code } = codes.issue(ask);
  t += 599_999;
  assert.ok(codes.peek(code));
  t += 1;
  assert.equal(codes.redeem(code), null);
});

test('one live code per member, others untouched', () => {
  const codes = createPhoneCodes(() => 1_000_000);
  const a = codes.issue(ask).code;
  const bob = codes.issue({ ...ask, member: 'bob' }).code;
  const b = codes.issue(ask).code;
  assert.equal(codes.redeem(a), null);
  assert.ok(codes.redeem(b));
  assert.ok(codes.redeem(bob));
});

test('unknown and malformed codes are null', () => {
  const codes = createPhoneCodes(() => 1_000_000);
  for (const c of ['', 'x', 'A'.repeat(43), 42 as any]) assert.equal(codes.redeem(c), null);
});

test('acceptedOrigin takes https anywhere and http only on loopback', () => {
  for (const [raw, want] of [
    ['https://planner.example.com', 'https://planner.example.com'],
    ['https://planner.example.com:8443', 'https://planner.example.com:8443'],
    ['http://localhost:5577', 'http://localhost:5577'],
    ['http://127.0.0.1:5577', 'http://127.0.0.1:5577'],
    ['http://[::1]:5577', 'http://[::1]:5577'],
    ['https://planner.example.com/', 'https://planner.example.com'],
  ] as const) assert.equal(acceptedOrigin(raw), want);
  for (const raw of [
    'http://planner.example.com:8088', 'https://planner.example.com/app',
    'https://u:p@planner.example.com', 'ftp://planner.example.com', '', null, 42,
  ]) assert.equal(acceptedOrigin(raw), null);
});
