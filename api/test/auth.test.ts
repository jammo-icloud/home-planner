import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { parseDollars } from '../src/money.ts';
import {
  AuthError, OtpRequired, Sessions, checkWithDsm, readCookie, sessionCookie, clearedCookie, COOKIE,
} from '../src/auth.ts';
import { ReplayError } from '../src/replay.ts';

/** DSM, stubbed. Records what it was asked so the tests can check the request. */
const dsm = (reply: unknown, opts: { throws?: boolean } = {}) => {
  const calls: { url: string; body: string }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    if (opts.throws) throw new Error('ECONNREFUSED');
    return { json: async () => reply } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
};

const store = async (): Promise<Store> => {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-auth-')), 'events.jsonl');
  const s = new Store({ path });
  await s.load();
  return s;
};

describe('checking credentials against DSM', () => {
  test('the password is posted, never put in the URL', async () => {
    const d = dsm({ success: true, data: { sid: 'abc' } });
    await checkWithDsm('alice', 'hunter2', undefined, d.fn);

    const login = d.calls[0]!;
    assert.doesNotMatch(login.url, /hunter2/, 'a password in the URL lands in the NAS access log');
    assert.doesNotMatch(login.url, /passwd/);
    assert.match(login.body, /passwd=hunter2/);
    assert.match(login.body, /api=SYNO.API.Auth/);
  });

  test('the DSM session is kept, and sign-in asks for the Calendar session', async () => {
    const d = dsm({ success: true, data: { sid: 'abc' } });
    const got = await checkWithDsm('alice', 'pw', undefined, d.fn);
    await new Promise((r) => setImmediate(r));
    assert.equal(got.sid, 'abc');
    assert.equal(d.calls.length, 1, 'login only — no logout');
    assert.match(d.calls[0]!.body, /session=Calendar/);
  });

  test('a wrong password is refused', async () => {
    const d = dsm({ success: false, error: { code: 400 } });
    await assert.rejects(() => checkWithDsm('alice', 'wrong', undefined, d.fn), AuthError);
  });

  test('DSM error 403 means it wants the one-time code', async () => {
    const d = dsm({ success: false, error: { code: 403 } });
    await assert.rejects(() => checkWithDsm('alice', 'pw', undefined, d.fn), OtpRequired);
  });

  test('the code is passed on when supplied', async () => {
    const d = dsm({ success: true, data: { sid: 'abc' } });
    await checkWithDsm('alice', 'pw', '123456', d.fn);
    assert.match(d.calls[0]!.body, /otp_code=123456/);
  });

  test('a rejected certificate says so, instead of reading as a dead machine', async () => {
    // These fail identically from the outside and are fixed completely
    // differently. On a first deployment this is the likeliest thing to go
    // wrong, and "cannot reach the NAS" sends you looking at the wrong thing.
    const fn = (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
    }) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => checkWithDsm('alice', 'pw', undefined, fn),
      /SELF_SIGNED_CERT_IN_CHAIN.*certificate the container trusts/s);
  });

  test('a refused connection names the mapping that is usually missing', async () => {
    const fn = (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => checkWithDsm('alice', 'pw', undefined, fn), /host-gateway/);
  });

  test('an unrecognised failure still names what it saw', async () => {
    const fn = (async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ESOMETHINGNEW' } });
    }) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => checkWithDsm('alice', 'pw', undefined, fn), /ESOMETHINGNEW/);
  });

  test('an unreachable NAS refuses the sign-in rather than waving it through', async () => {
    // The comic reader accepts any credentials here when NODE_ENV is unset.
    // That is one missing variable away from an open door.
    const d = dsm(null, { throws: true });
    await assert.rejects(() => checkWithDsm('anyone', 'anything', undefined, d.fn),
      (e: AuthError) => e.status === 502);
  });

  test('something on the port that is not DSM says so, instead of a parse error', async () => {
    // What a laptop's port 5000 does: AirPlay answers 403 with an empty body.
    // DSM_URL on the wrong port of a NAS fails the same way.
    const fn = (async () => ({
      status: 403,
      headers: new Headers(),
      json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
    })) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => checkWithDsm('alice', 'pw', undefined, fn),
      (e: AuthError) => e instanceof AuthError && e.status === 502
        && /not DSM/.test(e.message) && /HTTP 403/.test(e.message) && /DSM_URL/.test(e.message));
  });

  test('JSON that is not shaped like DSM is not read as a wrong password', async () => {
    // A reply without DSM's success flag would otherwise fall through to
    // "that username or password is not right", sending you to retype it.
    const d = dsm({ hello: 'world' });
    await assert.rejects(() => checkWithDsm('alice', 'pw', undefined, d.fn),
      (e: AuthError) => e.status === 502 && /not DSM/.test(e.message));
  });
});

describe('sessions', () => {
  test('tokens are long, random and unique', () => {
    const s = new Sessions();
    const a = s.issue('alice');
    const b = s.issue('alice');
    assert.notEqual(a, b);
    assert.equal(a.length, 64);
  });

  test('a session expires, and expiry is not a lookup that still works', () => {
    let now = 1_000_000;
    const s = new Sessions({ now: () => now });
    const token = s.issue('alice');
    assert.equal(s.get(token)?.who, 'alice');
    now += 8 * 24 * 60 * 60 * 1000;
    assert.equal(s.get(token), null);
    assert.equal(s.size, 0, 'and it is dropped, not merely hidden');
  });

  test('logging out invalidates the token immediately', () => {
    const s = new Sessions();
    const token = s.issue('bob');
    s.revoke(token);
    assert.equal(s.get(token), null);
  });

  test('a bypass session is marked as one, so it can be kept away from real data', () => {
    const s = new Sessions();
    assert.equal(s.get(s.issue('local', { local: true }))?.local, true);
    assert.equal(s.get(s.issue('alice'))?.local, false);
  });
});

describe('sessions across a restart', () => {
  const file = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), 'pb-sessions-')), 'sessions.json');

  test('a session survives a restart, so a deploy does not sign the phones out', async () => {
    const path = await file();
    const token = new Sessions({ path }).issue('alice', { household: 'home' });
    const after = new Sessions({ path }).get(token);
    assert.equal(after?.who, 'alice');
    assert.equal(after?.household, 'home');
    assert.equal(after?.local, false);
  });

  test('the file holds nothing that works as a cookie', async () => {
    // The reason sessions were in memory: a token on the volume would be a key
    // kept next to the thing it unlocks. What is written is its hash, and a
    // hash presented as a token opens nothing.
    const path = await file();
    const token = new Sessions({ path }).issue('alice');
    const text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, new RegExp(token));
    const written = (JSON.parse(text) as { sessions: { hash: string }[] }).sessions.map((x) => x.hash);
    assert.equal(written.length, 1);
    assert.equal(new Sessions({ path }).get(written[0]), null);
  });

  test('the sid lives in memory and never reaches the sessions file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pb-sess-'));
    const path = join(dir, 'sessions.json');
    const s = new Sessions({ path });
    const token = s.issue('alice', { sid: 'secret-sid' });
    assert.equal(s.get(token)?.sid, 'secret-sid');
    const onDisk = await readFile(path, 'utf8');
    assert.doesNotMatch(onDisk, /secret-sid/);
    const again = new Sessions({ path });
    assert.equal(again.get(token)?.sid, null, 'a session carried across a restart has no sid');
  });

  test('switching household survives a restart', async () => {
    const path = await file();
    const s = new Sessions({ path });
    const token = s.issue('alice', { household: 'home' });
    s.select(token, 'cabin');
    assert.equal(new Sessions({ path }).get(token)?.household, 'cabin');
  });

  test('logging out survives a restart', async () => {
    const path = await file();
    const s = new Sessions({ path });
    const token = s.issue('bob');
    s.revoke(token);
    assert.equal(new Sessions({ path }).get(token), null);
  });

  test('a restart does not bring an expired session back', async () => {
    const path = await file();
    let now = 1_000_000;
    const token = new Sessions({ path, now: () => now }).issue('alice');
    now += 8 * 24 * 60 * 60 * 1000;
    const after = new Sessions({ path, now: () => now });
    assert.equal(after.get(token), null);
    assert.equal(after.size, 0);
  });

  test('a bypass session is never written, because its sandbox does not survive either', async () => {
    const path = await file();
    const s = new Sessions({ path });
    const local = s.issue('local', { local: true, household: 'sandbox' });
    const real = s.issue('alice');
    const after = new Sessions({ path });
    assert.equal(after.get(local), null);
    assert.equal(after.get(real)?.who, 'alice');
  });

  test('a damaged file costs a sign-in, never the boot', async () => {
    const path = await file();
    await writeFile(path, '{"sessions": [ this is not json', 'utf8');
    const s = new Sessions({ path });
    assert.equal(s.size, 0);
    const token = s.issue('alice');
    assert.equal(new Sessions({ path }).get(token)?.who, 'alice', 'and the next write repairs it');
  });

  test('the file is readable by the server alone', async () => {
    const path = await file();
    new Sessions({ path }).issue('alice');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  test('with no path, nothing touches the disk', () => {
    const s = new Sessions();
    assert.equal(s.get(s.issue('alice'))?.who, 'alice');
  });
});

describe('cookies', () => {
  test('the session cookie is httpOnly, same-site and secure', () => {
    const c = sessionCookie('deadbeef');
    assert.match(c, /^budget-session=deadbeef/);
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Secure/);
  });

  test('plain-HTTP LAN use has to be asked for explicitly', () => {
    process.env['COOKIE_INSECURE'] = '1';
    try {
      assert.doesNotMatch(sessionCookie('x'), /Secure/);
    } finally {
      delete process.env['COOKIE_INSECURE'];
    }
  });

  test('logging out sends an expiry the browser will act on', () => {
    assert.match(clearedCookie(), /Max-Age=0/);
  });

  test('one cookie is found among many', () => {
    assert.equal(readCookie('a=1; budget-session=tok3n; b=2', COOKIE), 'tok3n');
    assert.equal(readCookie('other=1', COOKIE), undefined);
    assert.equal(readCookie(undefined, COOKIE), undefined);
  });
});

describe('the household: who owns it, who is in it', () => {
  test('the first person to sign in claims it, and is a member of it', async () => {
    const s = await store();
    await s.append('alice', { op: 'household.claim', label: 'Rivera' });
    assert.equal(s.state.owner, 'alice');
    assert.equal(s.state.label, 'Rivera');
    assert.ok(s.state.members.has('alice'));
  });

  test('it cannot be claimed twice', async () => {
    const s = await store();
    await s.append('alice', { op: 'household.claim', label: 'Rivera' });
    await assert.rejects(
      () => s.append('mallory', { op: 'household.claim', label: 'Mine now' }), ReplayError);
    assert.equal(s.state.owner, 'alice');
  });

  test('the owner shares it, and then both see the same state', async () => {
    const s = await store();
    await s.append('alice', { op: 'household.claim', label: 'Rivera' });
    await s.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
    assert.deepEqual([...s.state.members].sort(), ['alice', 'bob']);
  });

  test('a member cannot add other members', async () => {
    const s = await store();
    await s.append('alice', { op: 'household.claim', label: 'Rivera' });
    await s.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
    await assert.rejects(
      () => s.append('bob', { op: 'member.add', member: 'friend', why: 'why not' }), ReplayError);
  });

  test('a stranger cannot add themselves', async () => {
    const s = await store();
    await s.append('alice', { op: 'household.claim', label: 'Rivera' });
    await assert.rejects(
      () => s.append('mallory', { op: 'member.add', member: 'mallory', why: 'let me in' }), ReplayError);
    assert.equal(s.state.members.has('mallory'), false);
  });

  test('the owner cannot be removed, so the household always has an administrator', async () => {
    const s = await store();
    await s.append('alice', { op: 'household.claim', label: 'Rivera' });
    await assert.rejects(
      () => s.append('alice', { op: 'member.remove', member: 'alice', why: 'oops' }), ReplayError);
  });

  test('sharing needs a reason, the same as moving money does', async () => {
    const s = await store();
    await s.append('alice', { op: 'household.claim', label: 'Rivera' });
    await assert.rejects(
      () => s.append('alice', { op: 'member.add', member: 'bob', why: '  ' }), ReplayError);
  });

  test('access can be withdrawn, and the log says who did it and why', async () => {
    const s = await store();
    await s.append('alice', { op: 'household.claim', label: 'Rivera' });
    await s.append('alice', { op: 'member.add', member: 'guest', why: 'helping with the move' });
    await s.append('alice', { op: 'member.remove', member: 'guest', why: 'move finished' });
    assert.equal(s.state.members.has('guest'), false);

    const removal = (await s.since(null)).at(-1)!;
    assert.equal(removal.op, 'member.remove');
    assert.equal(removal.who, 'alice');
    assert.equal((removal as { why: string }).why, 'move finished');
  });

  test('membership survives a restart, because it is in the log like everything else', async () => {
    const s = await store();
    await s.append('alice', { op: 'household.claim', label: 'Rivera' });
    await s.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
    await s.append('alice', { op: 'category.add', category: 'food', label: 'Groceries' });

    const reopened = new Store({ path: s.path });
    await reopened.load();
    assert.equal(reopened.state.owner, 'alice');
    assert.deepEqual([...reopened.state.members].sort(), ['alice', 'bob']);
  });

  test('the shared state really is one state, not a copy each', async () => {
    const s = await store();
    await s.append('alice', { op: 'household.claim', label: 'Rivera' });
    await s.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
    await s.append('alice', [
      { op: 'category.add', category: 'food', label: 'Groceries' },
      { op: 'envelope.define', envelope: 'daily', label: 'Daily life', category: 'food', template: parseDollars('1000.00'), order: 0 },
      { op: 'month.open', month: '2026-08', income: parseDollars('9600.00') },
    ]);
    await s.append('bob', {
      op: 'move', month: '2026-08', from: 'daily', to: 'daily',
      amount: parseDollars('1.00'), why: 'x',
    }).catch(() => undefined); // same envelope is rejected; the point is the next line

    // Whatever either of them does lands in one log, so there is no version of
    // this where the two of them are looking at different numbers.
    assert.equal(s.state.envelopes.size, 1);
    assert.equal(s.state.owner, 'alice');
  });
});

test('the admin flag is kept in memory and never in the sessions file', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-admin-')), 'sessions.json');
  const s = new Sessions({ path });
  const token = s.issue('carol', { sid: 'S', admin: true });
  assert.equal(s.get(token)!.admin, true);
  assert.doesNotMatch(await readFile(path, 'utf8'), /admin/);
  assert.equal(new Sessions({ path }).get(token)!.admin, false, 'after a restart, sign in again for Connectors');
});
