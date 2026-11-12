// api/test/booking.test.ts
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptSuggestion, aheadOf, aheadWords, availability, bookingAvailability, bookingConfig, bookingHousehold, bookingMissing, bookingNeeds,
  bookingOffWords, bookingStatus,
  cancelStay, changeStay, confirmedMail, finishSignIn,
  memberNights, mine,
  request as ask,
  raiseReleaseCards, SIGN_IN_MESSAGE, startSignIn, suggest,
} from '../src/booking.ts';
import type { BookingConfig } from '../src/booking.ts';
import { GuestSessions } from '../src/auth.ts';
import { currentTest, recordTest, resetConnectors, resolvedEnv, saveConnector } from '../src/connectors.ts';
import { MailError, sendMail } from '../src/mail.ts';
import type { Mail, SmtpConfig } from '../src/mail.ts';
import { ToolError } from '../src/errors.ts';
import { Store } from '../src/store.ts';
import { replay, ReplayError } from '../src/replay.ts';
import { eventsToApply, parseBackup, planRestore, scopeOf } from '../src/restore.ts';
import { CARD_ONLY, describe as describeEvent, forClaude, ProposalStore, toolByName, toolSchemas } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { adjust, decide, refresh } from '../src/offers.ts';
import { isEmail, REQUIRES_WHY } from '../src/types.ts';
import type { Event, NewEventShape } from '../src/types.ts';
import { ensureHouseholdCalendar } from '../src/settings.ts';
import { getEvent, setDsmFetch } from '../src/synology.ts';
import type { DsmFetch } from '../src/synology.ts';
import { start as startFakeDsm } from '../tools/fake-dsm/server.ts';
import type { FakeDsm } from '../tools/fake-dsm/server.ts';

const NOW = '2026-10-29T09:00:00.000Z';

/** Every variable booking needs, set to something usable. */
const ENV = {
  BOOK_URL: 'https://book.example.com',
  BOOK_HOUSEHOLD: 'home',
  SMTP_HOST: 'mail.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'robot',
  SMTP_PASS: ' secret with spaces ',
  SMTP_FROM: 'house@example.com',
} as const;
/** What the configuration itself needs: the household friends book with comes from the logs. */
const VARS = (Object.keys(ENV) as (keyof typeof ENV)[]).filter((v) => v !== 'BOOK_HOUSEHOLD');
const SMTP: SmtpConfig = { host: 'mail.example.com', port: 587, user: 'robot', pass: 'pw', from: 'house@example.com' };

/** A household of alice (owner) and bob. */
async function fresh(): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-booking-')), 'events.jsonl');
  const s = new Store({ path, now: () => new Date(NOW) });
  await s.load();
  await s.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
  ]);
  return s;
}

const refused = (re: RegExp) => (e: unknown) => e instanceof ReplayError && re.test(e.message);

const ev = (who: string, e: Record<string, unknown>, id = `e${Math.random()}`): Event =>
  ({ id, at: NOW, who, ...e }) as unknown as Event;

const allow = (email: string, name = 'Nguyen family'): NewEventShape =>
  ({ op: 'guest.allow', email, name, why: 'old friends' });

const confirm = (request: string, extra: Record<string, unknown> = {}): NewEventShape => ({
  op: 'booking.confirm', request, email: 'guests@example.com', arrive: '2026-12-12', depart: '2026-12-15',
  headcount: 3, cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', evt_id: 41, ical_uid: 'uid-41', dav_etag: '"1"',
  ...extra,
}) as NewEventShape;

/** A guest's request, as the booking page will raise it. */
/** What the guest's request card asks for. */
const ARGS = { email: 'guests@example.com', name: 'Nguyen family', arrive: '2026-12-12', depart: '2026-12-15', headcount: 3, note: 'hi' };
const request = (extra: Record<string, unknown> = {}): NewEventShape => ({
  op: 'proposal.offer', tool: 'approve_booking',
  args: ARGS,
  summary: 'Nguyen family would like to come', effects: [], events: [], month: null, envelopes: [],
  fingerprint: '', prompt: { kind: 'booking', ref: null }, ...extra,
}) as NewEventShape;

// ─── configuration ────────────────────────────────────────────────────────────

describe('booking is off until everything it needs is set', () => {
  test('nothing set: off, and it names BOOK_URL first', () => {
    assert.deepEqual(bookingConfig({}), { off: 'BOOK_URL' });
  });

  test('with BOOK_URL missing, it says BOOK_URL', () => {
    const { BOOK_URL, ...rest } = ENV;
    assert.deepEqual(bookingConfig(rest), { off: 'BOOK_URL' });
  });

  test('each missing or blank variable is named, in order', () => {
    for (const v of VARS) {
      assert.deepEqual(bookingConfig({ ...ENV, [v]: undefined }), { off: v }, `${v} missing`);
      assert.deepEqual(bookingConfig({ ...ENV, [v]: '   ' }), { off: v }, `${v} blank`);
    }
  });

  test('everything set: the configuration, read and trimmed', () => {
    assert.deepEqual(bookingConfig({ ...ENV, BOOK_URL: ' https://book.example.com/ ', SMTP_HOST: ' mail.example.com ' }), {
      url: 'https://book.example.com',
      smtp: { host: 'mail.example.com', port: 587, user: 'robot', pass: ' secret with spaces ', from: 'house@example.com' },
    });
    // A plain-HTTP origin is the owner's call (a LAN test), and only with COOKIE_INSECURE=1; a port is kept.
    const lan = bookingConfig({ ...ENV, BOOK_URL: 'http://nas.local:8090', COOKIE_INSECURE: '1' });
    assert.ok(!('off' in lan));
    assert.equal(lan.url, 'http://nas.local:8090');
  });

  test('BOOK_URL is https, unless COOKIE_INSECURE=1 says this is plain HTTP on the LAN; the words say so', () => {
    const why = 'BOOK_URL must be https:// (http:// only with COOKIE_INSECURE=1)';
    for (const insecure of [undefined, '', '0', 'yes']) {
      assert.deepEqual(bookingConfig({ ...ENV, BOOK_URL: 'http://book.example.com', COOKIE_INSECURE: insecure }), { off: why }, String(insecure));
    }
    assert.equal(bookingOffWords(why), `Booking is off: ${why}.`);
  });

  test('why booking is off, in the words Settings and the boot log both use', () => {
    assert.equal(bookingOffWords('SMTP_HOST'), "Booking is off until SMTP_HOST is set in Home Planner's deployment.");
    assert.equal(bookingOffWords('SMTP_PORT is not usable'), 'Booking is off: SMTP_PORT is not usable.');
    assert.equal(bookingOffWords('friends book with another household on this server'),
      'Booking is off here: friends book with another household on this server.');
  });

  test('BOOK_URL is an http or https origin, nothing more', () => {
    for (const url of ['book.example.com', 'ftp://book.example.com', 'https://book.example.com/book',
      'https://book.example.com/?x=1', 'https://book.example.com/#top', 'https://me:pw@book.example.com', 'javascript:alert(1)']) {
      assert.deepEqual(bookingConfig({ ...ENV, BOOK_URL: url }), { off: 'BOOK_URL is not usable' }, url);
    }
  });

  test('SMTP_PORT is a whole number from 1 to 65535', () => {
    for (const port of ['smtp', '0', '65536', '25.5', '-1', '5e2']) {
      assert.deepEqual(bookingConfig({ ...ENV, SMTP_PORT: port }), { off: 'SMTP_PORT is not usable' }, port);
    }
    const ok = bookingConfig({ ...ENV, SMTP_PORT: '465' });
    assert.ok(!('off' in ok) && ok.smtp.port === 465);
  });

  test('SMTP_PLAIN_AUTH=1, and only that, lets the password go without TLS', () => {
    const plain = bookingConfig({ ...ENV, SMTP_PLAIN_AUTH: '1' });
    assert.ok(!('off' in plain) && plain.smtp.allowPlainAuth === true);
    for (const v of [undefined, '', '0', 'yes', 'true']) {
      const c = bookingConfig({ ...ENV, SMTP_PLAIN_AUTH: v });
      assert.ok(!('off' in c) && !('allowPlainAuth' in c.smtp), String(v));
    }
  });

  test('SMTP_FROM is an email address', () => {
    for (const from of ['house', 'House <house@example.com>', 'house@example', 'a b@example.com']) {
      assert.deepEqual(bookingConfig({ ...ENV, SMTP_FROM: from }), { off: 'SMTP_FROM is not usable' }, from);
    }
  });

  test('booking is on for the household the logs name, once everything it needs is set', () => {
    assert.deepEqual(bookingStatus(ENV, null), { on: false, why: 'no household has booking on' });
    assert.deepEqual(bookingStatus({}, 'home'), { on: false, why: 'BOOK_URL' });
    assert.deepEqual(bookingStatus({ ...ENV, SMTP_PORT: 'x' }, 'home'), { on: false, why: 'SMTP_PORT is not usable' });
    const on = bookingStatus(ENV, 'home');
    assert.ok(on.on && on.config.household === 'home');
    // BOOK_HOUSEHOLD is not needed: the household is whichever the logs say.
    const { BOOK_HOUSEHOLD: _named, ...rest } = ENV;
    const cabin = bookingStatus(rest, 'cabin');
    assert.ok(cabin.on && cabin.config.household === 'cabin');
  });
});

describe('one household at a time', () => {
  test('the booking household: the first to turn it on keeps it; BOOK_HOUSEHOLD only when no log says', () => {
    const on = (at: string) => ({ on: true, by: 'x', at, calendarGone: false });
    assert.equal(bookingHousehold([{ id: 'a', booking: on('2026-11-02') }, { id: 'b', booking: on('2026-11-01') }], {}), 'b');
    assert.equal(bookingHousehold([{ id: 'a', booking: null }], { BOOK_HOUSEHOLD: 'a' }), 'a');
    assert.equal(bookingHousehold([{ id: 'a', booking: { ...on('x'), on: false } }], { BOOK_HOUSEHOLD: 'a' }), null);
    // One turned on beats the deployment's; a BOOK_HOUSEHOLD this server does not have is no household.
    assert.equal(bookingHousehold([{ id: 'a', booking: null }, { id: 'b', booking: on('2026-11-01') }], { BOOK_HOUSEHOLD: 'a' }), 'b');
    assert.equal(bookingHousehold([{ id: 'a', booking: null }], { BOOK_HOUSEHOLD: ' elsewhere ' }), null);
    assert.equal(bookingHousehold([{ id: 'a', booking: null }], { BOOK_HOUSEHOLD: ' a ' }), 'a');
    assert.equal(bookingHousehold([{ id: 'a', booking: null }], {}), null);
  });

  test('what is ahead is counted in words', () => {
    assert.equal(aheadWords({ requests: 2, stays: 1 }), '2 requests waiting and 1 stay ahead');
    assert.equal(aheadWords({ requests: 0, stays: 3 }), '3 stays ahead');
    assert.equal(aheadWords({ requests: 1, stays: 0 }), '1 request waiting');
  });

  test('ahead: requests still waiting, and confirmed stays not yet over', async () => {
    const s = await fresh();
    await s.append('alice', [allow('guests@example.com'), allow('other@example.com', 'Other')]);
    assert.deepEqual(aheadOf(s.state, '2026-11-01'), { requests: 0, stays: 0 });
    const [a] = await s.append('guest:guests@example.com', request());
    const [b] = await s.append('guest:other@example.com', request({ args: { ...ARGS, email: 'other@example.com', arrive: '2026-12-20', depart: '2026-12-22' } }));
    assert.deepEqual(aheadOf(s.state, '2026-11-01'), { requests: 2, stays: 0 });
    // One approved is a stay ahead until its last night is gone; one declined is nothing.
    await s.append('alice', [{ op: 'proposal.decide', proposal: a!.id, decision: 'approved' }, confirm(a!.id)]);
    await s.append('alice', { op: 'proposal.decide', proposal: b!.id, decision: 'declined', why: 'away' });
    assert.deepEqual(aheadOf(s.state, '2026-12-14'), { requests: 0, stays: 1 });
    assert.deepEqual(aheadOf(s.state, '2026-12-15'), { requests: 0, stays: 0 });
  });

  test('available only with a Household calendar, a booking page and working mail, naming who can fix it', async () => {
    resetConnectors();
    try {
      const s = await fresh();
      const env = { ...ENV };
      assert.deepEqual(bookingAvailability(s.state, { env, adminUser: null }),
        { available: false, why: 'Booking is off until alice chooses the Household calendar.' });
      await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
      assert.deepEqual(bookingAvailability(s.state, { env, adminUser: null }), { available: true });
      // Who can fix the NAS's side: ADMIN_USER, else the last to save on This NAS, else the NAS's administrator.
      const { BOOK_URL: _url, ...noPage } = env;
      assert.deepEqual(bookingAvailability(s.state, { env: noPage, adminUser: null }),
        { available: false, why: "Booking is off until the NAS's administrator sets the booking address." });
      assert.deepEqual(bookingAvailability(s.state, { env: { ...env, BOOK_URL: 'http://book.example.com' }, adminUser: 'root' }),
        { available: false, why: 'Booking is off until root sets the booking address.' });
      await saveConnector('census', { value: 'k' }, 'carol');
      assert.deepEqual(bookingAvailability(s.state, { env: { ...env, SMTP_HOST: '' }, adminUser: null }),
        { available: false, why: 'Booking is off until carol sets up mail under Settings › This NAS.' });
      // Mail that the last test could not send through is not working mail.
      await recordTest('mailTest', { at: NOW, to: 'me@example.com', ok: false, words: 'refused' });
      assert.deepEqual(bookingAvailability(s.state, { env, adminUser: 'root' }),
        { available: false, why: 'Booking is off until root sets up mail under Settings › This NAS.' });
      await recordTest('mailTest', { at: NOW, to: 'me@example.com', ok: true, words: 'sent' });
      assert.deepEqual(bookingAvailability(s.state, { env, adminUser: 'root' }), { available: true });
      // A calendar the app found gone is no calendar, said first, until one is chosen again.
      await s.append('system', { op: 'guests.booking', on: false, calendarGone: true });
      const gone = 'Booking is off: the household calendar is gone. Choose one, then turn booking on again.';
      assert.deepEqual(bookingAvailability(s.state, { env: {}, adminUser: 'root' }), { available: false, why: gone });
      await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh2/', original_cal_id: '/alice/hh2/', name: 'Household', replaces: '/alice/hh/' });
      assert.deepEqual(bookingAvailability(s.state, { env, adminUser: 'root' }), { available: true });
    } finally {
      resetConnectors();
    }
  });

  test('says "you" to the one who must act: the owner for the calendar, an administrator for the address and mail', async () => {
    resetConnectors();
    try {
      const s = await fresh();
      const env = { ...ENV };
      const alice = { who: 'alice', admin: false };
      const bob = { who: 'bob', admin: false };
      const carol = { who: 'bob', admin: true };
      assert.equal((bookingAvailability(s.state, { env, adminUser: null, viewer: alice }) as { why: string }).why,
        'Booking is off until you choose the Household calendar.');
      assert.equal((bookingAvailability(s.state, { env, adminUser: null, viewer: bob }) as { why: string }).why,
        'Booking is off until alice chooses the Household calendar.');
      await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
      const { BOOK_URL: _url, ...noPage } = env;
      assert.equal((bookingAvailability(s.state, { env: noPage, adminUser: 'root', viewer: carol }) as { why: string }).why,
        'Booking is off until you set the booking address.');
      assert.equal((bookingAvailability(s.state, { env: noPage, adminUser: 'root', viewer: alice }) as { why: string }).why,
        'Booking is off until root sets the booking address.');
      assert.equal((bookingAvailability(s.state, { env: { ...env, SMTP_HOST: '' }, adminUser: 'root', viewer: carol }) as { why: string }).why,
        'Booking is off until you set up mail under Settings › This NAS.');
      assert.equal((bookingAvailability(s.state, { env: { ...env, SMTP_HOST: '' }, adminUser: 'root', viewer: alice }) as { why: string }).why,
        'Booking is off until root sets up mail under Settings › This NAS.');
    } finally {
      resetConnectors();
    }
  });

  test('what booking needs: each of the calendar, the address and mail, done or what is missing, and who sets it', async () => {
    resetConnectors();
    try {
      const s = await fresh();
      const owner = { who: 'alice', admin: false };
      const member = { who: 'bob', admin: false };
      const admin = { who: 'bob', admin: true };
      const lines = (env: NodeJS.ProcessEnv, viewer: { who: string; admin: boolean }) =>
        bookingNeeds(s.state, { env, viewer }).map((n) => [n.id, n.done, n.line]);
      const { BOOK_URL: _url, SMTP_HOST: _host, ...bare } = ENV;
      assert.deepEqual(lines(bare, owner), [
        ['calendar', false, 'Not chosen yet.'], ['address', false, 'An administrator sets this.'], ['mail', false, 'An administrator sets this.'],
      ]);
      assert.deepEqual(lines(bare, member), [
        ['calendar', false, 'alice chooses this.'], ['address', false, 'An administrator sets this.'], ['mail', false, 'An administrator sets this.'],
      ]);
      assert.deepEqual(lines(bare, admin), [
        ['calendar', false, 'alice chooses this.'], ['address', false, 'Not set yet.'], ['mail', false, 'Not set up yet.'],
      ]);
      // An address that cannot be used, said to the one who sets it in what to type.
      assert.equal(lines({ ...bare, BOOK_URL: 'https://planner.example.com/book' }, admin)[1]![2],
        'The address set cannot be used. Just the address, with no path: like https://planner.example.com.');
      assert.equal(lines({ ...bare, BOOK_URL: 'http://planner.example.com' }, admin)[1]![2],
        'The address set starts http://. It needs https://.');
      await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
      assert.deepEqual(lines({ ...ENV }, member), [
        ['calendar', true, 'Household'], ['address', true, 'https://book.example.com'], ['mail', true, 'Set up'],
      ]);
      // Mail whose last test failed is not done, and the one who sets it reads why.
      await recordTest('mailTest', { at: NOW, to: 'me@example.com', ok: false, words: 'refused' });
      assert.deepEqual(lines({ ...ENV }, admin)[2], ['mail', false, 'The last test failed: refused']);
      assert.deepEqual(lines({ ...ENV }, member)[2], ['mail', false, 'An administrator sets this.']);
      // A calendar the app found gone is not done, until one is chosen again.
      await s.append('system', { op: 'guests.booking', on: false, calendarGone: true });
      assert.deepEqual(lines({ ...ENV }, owner)[0], ['calendar', false, 'The Household calendar is gone. Choose another.']);
      assert.deepEqual(lines({ ...ENV }, member)[0], ['calendar', false, 'alice chooses this.']);
    } finally {
      resetConnectors();
    }
  });

  test("what is missing, in This NAS's Booking row's words", () => {
    assert.equal(bookingMissing('BOOK_URL'), 'the booking address is not set');
    assert.equal(bookingMissing('BOOK_URL is not usable'), 'the booking address cannot be used');
    assert.equal(bookingMissing('BOOK_URL must be https:// (http:// only with COOKIE_INSECURE=1)'), 'the booking address must start https://');
    assert.equal(bookingMissing('SMTP_HOST'), 'mail is not set up');
    assert.equal(bookingMissing('SMTP_PORT is not usable'), 'mail is not set up');
    assert.equal(bookingMissing('no household has booking on'), 'no household has turned booking on');
    assert.equal(bookingMissing('BOOK_HOUSEHOLD is not a household here'), 'BOOK_HOUSEHOLD is not a household here');
  });

  test('a failed mail test before the mail server was saved again counts nowhere, and booking can be on', async () => {
    resetConnectors();
    try {
      const s = await fresh();
      await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
      await recordTest('mailTest', { at: NOW, to: 'me@example.com', ok: false, words: 'refused' });
      assert.deepEqual(bookingAvailability(s.state, { env: { ...ENV }, adminUser: 'root' }),
        { available: false, why: 'Booking is off until root sets up mail under Settings › This NAS.' });
      await saveConnector('mail', {
        value: { host: 'smtp.example.com', port: 465, user: 'robot', pass: 'new', from: 'house@example.com', plainAuth: false },
      }, 'carol', new Date(Date.parse(NOW) + 60_000));
      assert.equal(currentTest('mailTest'), null);
      assert.deepEqual(bookingAvailability(s.state, { env: resolvedEnv({ ...ENV }), adminUser: 'root' }), { available: true });
      // A test made after the save counts again.
      await recordTest('mailTest', { at: new Date(Date.parse(NOW) + 120_000).toISOString(), to: 'me@example.com', ok: false, words: 'refused' });
      assert.equal(currentTest('mailTest')?.words, 'refused');
      assert.equal(bookingAvailability(s.state, { env: resolvedEnv({ ...ENV }), adminUser: 'root' }).available, false);
    } finally {
      resetConnectors();
    }
  });
});

// ─── the guest list ───────────────────────────────────────────────────────────

describe('the guest list is kept in the log', () => {
  test('allow then revoke leaves the guest absent; the email is lowercased and trimmed', async () => {
    const s = await fresh();
    await s.append('alice', allow('  Guests@Example.COM '));
    const g = s.state.guests.get('guests@example.com');
    assert.deepEqual(g, { name: 'Nguyen family', why: 'old friends', allowedBy: 'alice', at: NOW });
    await s.append('bob', { op: 'guest.revoke', email: 'GUESTS@example.com', why: 'moved away' });
    assert.equal(s.state.guests.has('guests@example.com'), false);
    assert.equal(s.state.guests.size, 0);
    // A re-allow after a revoke is fine.
    await s.append('alice', allow('guests@example.com', 'The Nguyens'));
    assert.equal(s.state.guests.get('guests@example.com')!.name, 'The Nguyens');
  });

  test('an entry may link a Synology contact', async () => {
    const s = await fresh();
    await s.append('alice', { ...allow('g@example.com'), contact: { contact_id: 7, addressbook_id: 1, display: 'Linh Nguyen' } } as NewEventShape);
    assert.deepEqual(s.state.guests.get('g@example.com')!.contact, { contact_id: 7, addressbook_id: 1, display: 'Linh Nguyen' });
    await assert.rejects(s.append('alice', { ...allow('h@example.com'), contact: { contact_id: 'x' } } as unknown as NewEventShape),
      refused(/contact_id/));
  });

  test('guest.allow with an invalid email is refused in replay', () => {
    for (const email of ['nope', 'a@b', 'a b@c.de', 'a@@b.cd', '@b.cd', 'a@b.', 'a@.b', '', 42, null]) {
      assert.throws(() => replay([ev('alice', { op: 'household.claim', label: 'Home' }), ev('alice', { op: 'guest.allow', email, name: 'X', why: 'w' })]),
        refused(/email/), String(email));
    }
  });

  test('an address the mailer would refuse is no address on the list either: one rule for both', async () => {
    const strange = ['a<b@example.com', 'a>b@example.com', '"a"@example.com', 'a,b@example.com', 'a;b@example.com',
      'a(b)@example.com', 'a\\b@example.com', `${'a'.repeat(243)}@example.com`];
    for (const email of strange) {
      assert.equal(isEmail(email), false, email);
      assert.throws(() => replay([ev('alice', { op: 'household.claim', label: 'Home' }), ev('alice', { op: 'guest.allow', email, name: 'X', why: 'w' })]),
        refused(/email/), email);
      await assert.rejects(sendMail(SMTP, { to: email, subject: 's', text: 't' }, 'Home', { connect: async () => { throw new Error('never dialled'); } }),
        (e: unknown) => e instanceof MailError, email);
    }
    // 254 characters is still an address.
    assert.equal(isEmail(`${'a'.repeat(242)}@example.com`), true);
  });

  test('a guest.allow line with no reason, met on replay, is refused by name, never a TypeError', () => {
    assert.throws(() => replay([ev('alice', { op: 'household.claim', label: 'Home' }), ev('alice', { op: 'guest.allow', email: 'g@example.com', name: 'G' })]),
      refused(/reason/));
  });

  test('guest.allow needs a name and a reason', async () => {
    const s = await fresh();
    await assert.rejects(s.append('alice', { ...allow('g@example.com'), name: ' ' } as NewEventShape), refused(/name/));
    await assert.rejects(s.append('alice', { op: 'guest.allow', email: 'g@example.com', name: 'G' } as NewEventShape), refused(/reason/));
    await assert.rejects(s.append('alice', { op: 'guest.revoke', email: 'g@example.com', why: '' } as NewEventShape), refused(/reason/));
  });

  test('revoking an email that is not on the list is refused', async () => {
    const s = await fresh();
    await assert.rejects(s.append('alice', { op: 'guest.revoke', email: 'Who@example.com', why: 'w' }),
      refused(/who@example\.com is not on the list/));
  });

  test('only members keep the list', async () => {
    const s = await fresh();
    await assert.rejects(s.append('mallory', allow('m@example.com')), refused(/mallory is not a member/));
    await assert.rejects(s.append('claude', allow('m@example.com')), refused(/claude cannot guest\.allow/));
  });
});

// ─── blocks and stays ─────────────────────────────────────────────────────────

describe('nights kept, stays confirmed', () => {
  test('a block runs from (inclusive) to (exclusive), and is removed by naming it', async () => {
    const s = await fresh();
    await assert.rejects(s.append('alice', { op: 'booking.block', from: '2026-12-15', to: '2026-12-15', why: 'w' }), refused(/after/));
    await assert.rejects(s.append('alice', { op: 'booking.block', from: '2026-12-15', to: '2026-12-12', why: 'w' }), refused(/after/));
    await assert.rejects(s.append('alice', { op: 'booking.block', from: '2026-12-32', to: '2027-01-02', why: 'w' }), refused(/day/));
    const [b] = await s.append('alice', { op: 'booking.block', from: '2026-12-12', to: '2026-12-15', why: 'family here' });
    assert.deepEqual(s.state.stayBlocks.get(b!.id), { from: '2026-12-12', to: '2026-12-15', why: 'family here', by: 'alice', at: NOW });
    await assert.rejects(s.append('bob', { op: 'booking.unblock', block: 'nope', why: 'w' }), refused(/no such block/));
    await s.append('bob', { op: 'booking.unblock', block: b!.id, why: 'they cancelled' });
    assert.equal(s.state.stayBlocks.size, 0);
  });

  test('a confirmed stay carries the request, the dates, the people and the calendar event', async () => {
    const s = await fresh();
    await s.append('alice', allow('guests@example.com'));
    const [c] = await s.append('bob', confirm('req1', { email: ' Guests@Example.com ' }));
    assert.deepEqual(s.state.stays.get(c!.id), {
      request: 'req1', email: 'guests@example.com', name: 'Nguyen family',
      arrive: '2026-12-12', depart: '2026-12-15', headcount: 3,
      cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', evt_id: 41, ical_uid: 'uid-41', dav_etag: '"1"',
      cancelled: false, confirmedBy: 'bob', at: NOW,
    });
  });

  test('a stay has at least one person and leaves after it arrives', async () => {
    const s = await fresh();
    for (const [extra, re] of [
      [{ headcount: 0 }, /headcount/], [{ headcount: 2.5 }, /headcount/], [{ headcount: '3' }, /headcount/],
      [{ depart: '2026-12-12' }, /after/], [{ depart: '2026-12-10' }, /after/], [{ arrive: 'soon' }, /day/],
      [{ email: 'nope' }, /email/], [{ evt_id: -1 }, /evt_id/], [{ cal_id: '' }, /cal_id/], [{ request: '' }, /request/],
      [{ dav_etag: ' ' }, /etag/], [{ ical_uid: 3 }, /ical_uid/],
    ] as const) {
      await assert.rejects(s.append('alice', confirm('r', extra)), refused(re), JSON.stringify(extra));
    }
    assert.equal(s.state.stays.size, 0);
  });

  test('nights are one party\'s at a time', async () => {
    const s = await fresh();
    await s.append('alice', confirm('r1'));
    await assert.rejects(s.append('alice', confirm('r2', { email: 'other@example.com', arrive: '2026-12-14', depart: '2026-12-18' })),
      refused(/taken/));
    // Departure day is the next party's arrival day.
    await s.append('alice', confirm('r3', { email: 'other@example.com', arrive: '2026-12-15', depart: '2026-12-18' }));
    assert.equal(s.state.stays.size, 2);
  });

  test('cancelling a confirmed stay marks it, once; an unknown stay is refused', async () => {
    const s = await fresh();
    const [c] = await s.append('alice', confirm('r1'));
    await assert.rejects(s.append('alice', { op: 'booking.cancel', stay: 'nope', why: 'w' }), refused(/no such stay/));
    await assert.rejects(s.append('alice', { op: 'booking.cancel', stay: c!.id } as NewEventShape), refused(/reason/));
    await s.append('alice', { op: 'booking.cancel', stay: c!.id, why: 'the roof' });
    assert.equal(s.state.stays.get(c!.id)!.cancelled, true);
    await assert.rejects(s.append('alice', { op: 'booking.cancel', stay: c!.id, why: 'w' }), refused(/already cancelled/));
    // Its nights are free again.
    await s.append('alice', confirm('r2', { email: 'other@example.com' }));
  });

  test('a stay confirmed for a card with no args takes its name from the list', () => {
    const lines = [
      ev('alice', { op: 'household.claim', label: 'Home' }),
      ev('alice', allow('guests@example.com') as never),
      ev('alice', { ...request(), args: undefined } as never, 'req'),
      ev('alice', confirm('req') as never, 'c1'),
    ];
    assert.equal(replay(lines).stays.get('c1')!.name, 'Nguyen family');
  });

  test('a stay may be cancelled by its request too', async () => {
    const s = await fresh();
    const [c] = await s.append('alice', confirm('r1'));
    await s.append('alice', { op: 'booking.cancel', stay: 'r1', why: 'w' });
    assert.equal(s.state.stays.get(c!.id)!.cancelled, true);
  });

  test('there is no booking.change line: a change is a cancel and a request, or a request that replaces a stay', async () => {
    const s = await fresh();
    await s.append('alice', allow('guests@example.com'));
    const [c] = await s.append('alice', confirm('r1'));
    const change = { op: 'booking.change', stay: c!.id, arrive: '2026-12-12', depart: '2026-12-14', headcount: 2, note: '' } as unknown as NewEventShape;
    await assert.rejects(s.append('alice', change), refused(/unknown op: booking\.change/));
    await assert.rejects(s.append('guest:guests@example.com', change), refused(/a guest cannot booking\.change/));
  });

  test('suggest is dated as a stay is', async () => {
    const s = await fresh();
    await assert.rejects(s.append('alice', { op: 'booking.suggest', request: 'r9', email: 'guests@example.com', arrive: '2027-01-03', depart: '2027-01-03', why: 'w' }),
      refused(/after/));
    await assert.rejects(s.append('alice', { op: 'booking.suggest', request: 'r9', email: 'x', arrive: '2027-01-03', depart: '2027-01-05', why: 'w' }),
      refused(/email/));
    await assert.rejects(s.append('alice', { op: 'booking.suggest', request: 'r9', email: 'guests@example.com', arrive: '2027-01-03', depart: '2027-01-05' } as NewEventShape),
      refused(/reason/));
    await s.append('alice', { op: 'booking.suggest', request: 'r9', email: 'guests@example.com', arrive: '2027-01-03', depart: '2027-01-05', why: 'full' });
  });

  test('replaying the log and appending to it agree', async () => {
    const s = await fresh();
    await s.append('alice', [allow('guests@example.com'), allow('gone@example.com')]);
    await s.append('alice', { op: 'guest.revoke', email: 'gone@example.com', why: 'w' });
    const [b] = await s.append('alice', { op: 'booking.block', from: '2026-12-01', to: '2026-12-03', why: 'w' });
    await s.append('alice', { op: 'booking.block', from: '2026-12-05', to: '2026-12-06', why: 'w' });
    await s.append('alice', { op: 'booking.unblock', block: b!.id, why: 'w' });
    const [c] = await s.append('alice', confirm('r1'));
    await s.append('alice', confirm('r2', { arrive: '2027-01-01', depart: '2027-01-04' }));
    await s.append('alice', { op: 'booking.cancel', stay: c!.id, why: 'w' });
    const again = replay(await s.since(null));
    assert.deepEqual(again.guests, s.state.guests);
    assert.deepEqual(again.stays, s.state.stays);
    assert.deepEqual(again.stayBlocks, s.state.stayBlocks);
    assert.deepEqual([again.guests.size, again.stays.size, again.stayBlocks.size], [1, 2, 1]);
  });

  test('a malformed line is refused by name, never a TypeError', () => {
    const claim = ev('alice', { op: 'household.claim', label: 'Home' });
    for (const line of [
      { op: 'guest.allow', email: 'g@example.com', name: 7, why: 'w' },
      { op: 'guest.revoke', email: 7, why: 'w' },
      { op: 'booking.block', from: null, to: '2026-12-12', why: 'w' },
      { op: 'booking.block', from: '2026-12-12', to: '2026-12-14', why: 3 },
      { op: 'booking.unblock', block: 9, why: 'w' },
      { op: 'booking.confirm', request: 'r' },
      { op: 'booking.cancel', stay: { id: 1 }, why: 'w' },

      { op: 'booking.suggest', request: 'r', email: 'g@example.com', arrive: 20261212, depart: '2026-12-14', why: 'w' },
    ]) {
      assert.throws(() => replay([claim, ev('alice', line)]), (e: unknown) => e instanceof ReplayError, JSON.stringify(line));
    }
  });
});

// ─── the guest actor ──────────────────────────────────────────────────────────

describe('a guest may ask, cancel and change, and nothing else', () => {
  async function withGuest(): Promise<Store> {
    const s = await fresh();
    await s.append('alice', [allow('guests@example.com'), allow('other@example.com', 'Other')]);
    return s;
  }

  test('a guest on the list raises a booking card', async () => {
    const s = await withGuest();
    const [o] = await s.append('guest:guests@example.com', request());
    assert.equal(s.state.thread.offers.get(o!.id)!.who, 'guest:guests@example.com');
  });

  test('a guest offer of any other kind is refused', async () => {
    const s = await withGuest();
    await assert.rejects(s.append('guest:guests@example.com', request({ prompt: { kind: 'member', ref: null } })), refused(/booking/));
  });

  test('a guest\'s card carries nothing a member would execute', async () => {
    const s = await withGuest();
    const field = (extra: Record<string, unknown>, re: RegExp) =>
      assert.rejects(s.append('guest:guests@example.com', request(extra)), refused(re), JSON.stringify(extra));
    await field({ tool: 'move_money' }, /\(tool\)/);
    await field({ events: [{ op: 'member.add', member: 'mallory', why: 'w' }] }, /events/);
    await field({ events: 'none' }, /events/);
    await field({ replaces: 'e1' }, /\(replaces\)/);
    await field({ plan: 'p1' }, /\(plan\)/);
    await field({ prompt: { kind: 'booking', ref: 'e1' } }, /prompt\.ref/);
    await field({ prompt: { kind: 'member', ref: null } }, /prompt\.kind/);
    // Nothing for decide or a newer card to act on: no month, envelopes or figures.
    await field({ month: '2026-12' }, /\(month\)/);
    await field({ envelopes: ['food'] }, /\(envelopes\)/);
    await field({ envelopes: 'food' }, /\(envelopes\)/);
    await field({ fingerprint: '["x"]' }, /\(fingerprint\)/);
    assert.equal(s.state.thread.offers.size, 0);
    // Events left out are the same as none.
    const { events, ...bare } = request() as Record<string, unknown>;
    const [o] = await s.append('guest:guests@example.com', bare as NewEventShape);
    assert.deepEqual(s.state.thread.offers.get(o!.id)!.events, []);
    // A member's card is not held to this.
    await s.append('alice', request({ tool: 'move_money', prompt: { kind: 'member', ref: null } }));
  });

  test('a guest\'s request is for themselves: args.email is the author\'s own address, in any case', async () => {
    const s = await withGuest();
    await assert.rejects(s.append('guest:guests@example.com', request({ args: { ...ARGS, email: 'other@example.com' } })),
      refused(/args\.email/));
    const { email: _gone, ...noEmail } = ARGS;
    await assert.rejects(s.append('guest:guests@example.com', request({ args: noEmail })), refused(/args\.email/));
    await s.append('guest:guests@example.com', request({ args: { ...ARGS, email: ' Guests@Example.com ' } }));
    await s.append('guest:guests@example.com', request());
    assert.equal(s.state.thread.offers.size, 2);
  });

  test('an author that is not a string is refused by name', () => {
    for (const who of [42, null, { name: 'x' }, ['guest:a@b.cd']]) {
      assert.throws(() => replay([ev(who as never, { op: 'household.claim', label: 'Home' })]), refused(/no actor/), JSON.stringify(who));
    }
  });

  test('a guest withdraws a request; a member cancels one', async () => {
    const s = await withGuest();
    const [mine] = await s.append('guest:guests@example.com', request());
    const [w] = await s.append('guest:guests@example.com', { op: 'booking.cancel', stay: mine!.id, why: 'cannot come' });
    assert.equal(describeEvent(w!, s.state).what, 'withdrew a request');
    const [theirs] = await s.append('guest:other@example.com', request({ args: { email: 'other@example.com' } }));
    const [m] = await s.append('alice', { op: 'booking.cancel', stay: theirs!.id, why: 'away' });
    assert.equal(describeEvent(m!, s.state).what, 'cancelled a request');
  });

  test('a guest who is not on the list, or no longer, writes nothing', async () => {
    const s = await withGuest();
    await assert.rejects(s.append('guest:stranger@example.com', request({ args: { ...ARGS, email: 'stranger@example.com' } })), refused(/not on the list/));
    await s.append('alice', { op: 'guest.revoke', email: 'guests@example.com', why: 'w' });
    await assert.rejects(s.append('guest:guests@example.com', request()), refused(/not on the list/));
  });

  test('a guest is refused everything else', async () => {
    const s = await withGuest();
    const lines: NewEventShape[] = [
      { op: 'plan.create', plan: 'p1', title: 'x', area: 'House' },
      { op: 'thread.note', text: 'hello' },
      { op: 'thread.ask', question: 'who else is coming?' },
      { op: 'flag.seen', event: 'x' },
      { op: 'briefing.read', upTo: 'x' },
      allow('friend@example.com'),
      { op: 'guest.revoke', email: 'other@example.com', why: 'w' },
      { op: 'booking.block', from: '2026-12-01', to: '2026-12-03', why: 'w' },
      confirm('r1'),
      { op: 'booking.suggest', request: 'r', email: 'guests@example.com', arrive: '2027-01-03', depart: '2027-01-05', why: 'w' },
      { op: 'booking.release', stay: 's1' },
      { op: 'member.add', member: 'guest:guests@example.com', why: 'w' },
    ];
    for (const line of lines) {
      await assert.rejects(s.append('guest:guests@example.com', line), refused(/a guest cannot/), line.op);
    }
    const [o] = await s.append('guest:guests@example.com', request());
    await assert.rejects(s.append('guest:guests@example.com', { op: 'proposal.decide', proposal: o!.id, decision: 'approved' }),
      refused(/a guest cannot proposal\.decide/));
  });

  test('a guest cancels their own stay or request, and no one else\'s', async () => {
    const s = await withGuest();
    const [mine] = await s.append('guest:guests@example.com', request());
    const [theirs] = await s.append('guest:other@example.com', request({ args: { ...ARGS, email: 'other@example.com' } }));
    const [stay] = await s.append('alice', confirm('r1', { arrive: '2027-02-01', depart: '2027-02-03' }));
    const [other] = await s.append('alice', confirm('r2', { email: 'other@example.com', arrive: '2027-03-01', depart: '2027-03-03' }));

    await assert.rejects(s.append('guest:guests@example.com', { op: 'booking.cancel', stay: theirs!.id, why: 'w' }), refused(/not yours/));
    await assert.rejects(s.append('guest:guests@example.com', { op: 'booking.cancel', stay: other!.id, why: 'w' }), refused(/not yours/));
    await s.append('guest:guests@example.com', { op: 'booking.cancel', stay: mine!.id, why: 'cannot come' });
    await s.append('guest:guests@example.com', { op: 'booking.cancel', stay: stay!.id, why: 'cannot come' });
    assert.equal(s.state.stays.get(stay!.id)!.cancelled, true);
    // A member may cancel anyone's.
    await s.append('bob', { op: 'booking.cancel', stay: theirs!.id, why: 'w' });
  });

  test('a request that is no longer waiting cannot be cancelled', async () => {
    const s = await withGuest();
    const [o] = await s.append('guest:guests@example.com', request());
    await s.append('alice', { op: 'proposal.decide', proposal: o!.id, decision: 'declined', why: 'away' });
    await assert.rejects(s.append('guest:guests@example.com', { op: 'booking.cancel', stay: o!.id, why: 'w' }), refused(/no longer waiting/));
  });

  test('a removed member is refused like any outsider', async () => {
    const s = await fresh();
    await s.append('alice', { op: 'member.remove', member: 'bob', why: 'w' });
    await assert.rejects(s.append('bob', allow('g@example.com')), refused(/bob is not a member/));
    await assert.rejects(s.append('bob', { op: 'booking.block', from: '2026-12-01', to: '2026-12-03', why: 'w' }), refused(/bob is not a member/));
  });
});

// ─── reasons, scope, sentences ────────────────────────────────────────────────

const SAMPLES: NewEventShape[] = [
  allow('guests@example.com'),
  { op: 'guest.revoke', email: 'guests@example.com', why: 'w' },
  { op: 'booking.block', from: '2026-12-12', to: '2026-12-15', why: 'w' },
  { op: 'booking.unblock', block: 'b1', why: 'w' },
  confirm('r1'),
  { op: 'booking.cancel', stay: 's1', why: 'w' },
  { op: 'booking.suggest', request: 'r1', email: 'guests@example.com', arrive: '2027-01-03', depart: '2027-01-05', why: 'w' },
  { op: 'booking.release', stay: 's1' },
];

describe('reasons, scope and sentences', () => {
  test('the ops that need a reason', () => {
    for (const op of ['guest.allow', 'guest.revoke', 'booking.block', 'booking.unblock', 'booking.cancel', 'booking.suggest'] as const) {
      assert.ok(REQUIRES_WHY.has(op), op);
    }
    for (const op of ['booking.confirm', 'booking.release'] as const) assert.ok(!REQUIRES_WHY.has(op), op);
  });

  test('every op is in scope bookings', () => {
    assert.equal(SAMPLES.length, 8);
    for (const e of SAMPLES) assert.equal(scopeOf({ id: 'i', at: NOW, who: 'alice', ...e } as Event), 'bookings', e.op);
  });

  test('a backup counts them', () => {
    const lines = [ev('alice', { op: 'household.claim', label: 'Home' }), ev('alice', allow('g@example.com') as never)];
    const parsed = parseBackup(lines.map((l) => JSON.stringify(l)).join('\n'));
    assert.equal(parsed.counts.bookings, 1);
  });

  test('describe covers each', () => {
    for (const e of SAMPLES) {
      const line = describeEvent({ id: 'i', at: NOW, who: 'alice', ...e } as Event);
      assert.notEqual(line.what, e.op, 'the raw op name is not a sentence');
      assert.doesNotMatch(line.what, /undefined|null|\[object|NaN/, e.op);
    }
  });

  test('in the app\'s words, with names when the household is at hand', async () => {
    const s = await fresh();
    const say = (e: Event) => describeEvent(e, s.state).what;
    const [a] = await s.append('alice', allow('guests@example.com'));
    assert.equal(say(a!), 'allowed guest Nguyen family (guests@example.com)');
    const [b] = await s.append('alice', { op: 'booking.block', from: '2026-12-12', to: '2026-12-15', why: 'w' });
    assert.equal(say(b!), 'kept 12–15 Dec for the household');
    const [c] = await s.append('alice', confirm('r1'));
    assert.equal(say(c!), 'confirmed Nguyen family for 12–15 Dec, 3 people');
    const [one] = await s.append('alice', confirm('r2', { email: 'solo@example.com', arrive: '2026-12-30', depart: '2027-01-02', headcount: 1 }));
    assert.equal(say(one!), 'confirmed solo@example.com for 30 Dec – 2 Jan, 1 person');
    const [x] = await s.append('alice', { op: 'booking.cancel', stay: c!.id, why: 'w' });
    assert.match(say(x!), /^cancelled a stay/);
    const before = s.state;
    const [u] = await s.append('alice', { op: 'booking.unblock', block: b!.id, why: 'w' });
    assert.equal(describeEvent(u!, before).what, 'opened 12–15 Dec to guests again');
    // Gone from the state once unblocked, so the activity list says it plainly.
    assert.equal(say(u!), 'opened nights kept for the household to guests again');
    const [r] = await s.append('alice', { op: 'guest.revoke', email: 'guests@example.com', why: 'w' });
    assert.match(say(r!), /took .* off the guest list/);
  });
});

// ─── the arrival note ─────────────────────────────────────────────────────────

describe('the arrival note: how to get in, for the confirmation', () => {
  test('any member keeps it, in the settings; empty clears it; at most 1000 characters', async () => {
    const s = await fresh();
    assert.equal(s.state.settings.arrival, '');
    await s.append('bob', { op: 'guests.arrival', text: '12 Camino Real. The gate code is 4471.' });
    assert.equal(s.state.settings.arrival, '12 Camino Real. The gate code is 4471.');
    await s.append('alice', { op: 'guests.arrival', text: '' });
    assert.equal(s.state.settings.arrival, '');
    await assert.rejects(s.append('alice', { op: 'guests.arrival', text: 'x'.repeat(1001) }), refused(/1,000/));
    await s.append('alice', { op: 'guests.arrival', text: 'x'.repeat(1000) });
  });

  test('a line of the wrong shape is refused by name; a guest and Claude may not write it', async () => {
    const claim = ev('alice', { op: 'household.claim', label: 'Home' });
    for (const text of [undefined, 5, null, ['a']]) {
      assert.throws(() => replay([claim, ev('alice', { op: 'guests.arrival', text })]), refused(/arrival note is text/), String(text));
    }
    const s = await fresh();
    await s.append('alice', allow('guests@example.com'));
    await assert.rejects(s.append('guest:guests@example.com', { op: 'guests.arrival', text: 'come in' }), refused(/a guest cannot guests\.arrival/));
    await assert.rejects(s.append('claude', { op: 'guests.arrival', text: 'come in' }), refused(/claude cannot guests\.arrival/));
  });

  test('scope settings; Activity says it was updated, never what it says', async () => {
    const e = ev('alice', { op: 'guests.arrival', text: 'The key is under the pot.' });
    assert.equal(scopeOf(e), 'settings');
    assert.equal(describeEvent(e).what, 'updated the arrival note');
    assert.doesNotMatch(JSON.stringify(describeEvent(e)), /key|pot/);
    assert.equal(describeEvent(ev('alice', { op: 'guests.arrival', text: '' })).what, 'cleared the arrival note');
  });

  test('the confirmation carries it after the dates when there is one, and nothing about it when there is not', () => {
    const base = { label: 'Home', name: 'Linh', arrive: '2026-12-12', depart: '2026-12-15', headcount: 2, note: '', url: 'https://book.example.com', today: '2026-10-29' };
    const withNote = confirmedMail({ ...base, arrival: '12 Camino Real.\nThe gate code is 4471.' }).text;
    const dates = withNote.indexOf('Dec 12–15');
    const note = withNote.indexOf('12 Camino Real.');
    assert.ok(dates >= 0 && note > dates, withNote);
    assert.ok(withNote.includes('The gate code is 4471.'));
    assert.match(withNote, /How to get here/);
    const without = confirmedMail(base).text;
    assert.doesNotMatch(without, /How to get here/);
    assert.doesNotMatch(confirmedMail({ ...base, arrival: '   ' }).text, /How to get here/);
  });
});

// ─── the guest door ───────────────────────────────────────────────────────────
//
// Sign-ins and the rate limits are kept in memory for the whole process, so
// each test below uses addresses (and an IP) of its own.

describe('signing a guest in', () => {
  const cfg: BookingConfig = { ...(bookingConfig(ENV) as Omit<BookingConfig, 'household'>), household: 'home' };
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const T0 = Date.parse(NOW);

  /** A household whose list has these addresses on it. */
  async function listed(...emails: string[]): Promise<Store> {
    const s = await fresh();
    for (const e of emails) await s.append('alice', allow(e, `Guest ${e}`));
    return s;
  }

  /** A send that records what would have gone out, and the name it would go out under. */
  function recorder() {
    const sent: (Mail & { name: string })[] = [];
    const send = async (_cfg: SmtpConfig, m: Mail, name: string) => { sent.push({ ...m, name }); };
    return { sent, send };
  }

  /** Start a sign-in and, as the route does once it has answered, let its mail go. */
  const begin = async (...a: Parameters<typeof startSignIn>) => (await startSignIn(...a))();

  const codeIn = (m: Mail) => /^\s*(\d{6})\s*$/m.exec(m.text)?.[1];
  const tokenIn = (m: Mail) => /\/book\/open\?token=([\w-]+)/.exec(m.text)?.[1];
  const notRight = (e: unknown) => e instanceof ToolError && e.status === 401 && e.message === 'that link or code is not right';

  test('the answer is one sentence, whoever asks', () => {
    assert.equal(SIGN_IN_MESSAGE, 'If that address is one we know, a link is on its way.');
  });

  test('an address not on the list: nothing is sent', async () => {
    const store = await listed('known-1@example.com');
    const { sent, send } = recorder();
    await begin({ store, cfg, now: () => T0, ip: '10.1.0.1' }, 'stranger-1@example.com', send);
    assert.equal(sent.length, 0);
  });

  test('an address on the list: one email, with a six-digit code and a link built on BOOK_URL', async () => {
    const store = await listed('known-2@example.com');
    const { sent, send } = recorder();
    await begin({ store, cfg, now: () => T0, ip: '10.1.0.2' }, '  Known-2@Example.COM ', send);
    assert.equal(sent.length, 1);
    const m = sent[0]!;
    assert.equal(m.to, 'known-2@example.com');
    assert.equal(m.subject, 'Your link to book a stay with Home');
    assert.equal(m.name, 'Home');
    assert.match(codeIn(m) ?? '', /^\d{6}$/);
    assert.ok(m.text.includes(`${ENV.BOOK_URL}/book/open?token=`), m.text);
    assert.ok(m.text.includes("If you didn't ask for this, ignore it."), m.text);
  });

  test('the sixth request for one address in an hour sends nothing; an hour on, it sends again', async () => {
    const store = await listed('known-3@example.com');
    const { sent, send } = recorder();
    let now = T0;
    for (let i = 0; i < 6; i++) {
      await begin({ store, cfg, now: () => now, ip: `10.1.3.${i}` }, 'known-3@example.com', send);
      now += MIN;
    }
    assert.equal(sent.length, 5);
    now = T0 + HOUR + 1;
    await begin({ store, cfg, now: () => now, ip: '10.1.3.9' }, 'known-3@example.com', send);
    assert.equal(sent.length, 6);
  });

  test('the twenty-first request from one IP in an hour sends nothing, whatever the address', async () => {
    const store = await listed('known-4@example.com');
    const { sent, send } = recorder();
    for (let i = 0; i < 20; i++) {
      await begin({ store, cfg, now: () => T0, ip: '10.1.4.1' }, `nobody-${i}@example.com`, send);
    }
    await begin({ store, cfg, now: () => T0, ip: '10.1.4.1' }, 'known-4@example.com', send);
    assert.equal(sent.length, 0);
    await begin({ store, cfg, now: () => T0, ip: '10.1.4.2' }, 'known-4@example.com', send);
    assert.equal(sent.length, 1);
  });

  test('the link works once, and then never again', async () => {
    const store = await listed('known-5@example.com');
    const { sent, send } = recorder();
    await begin({ store, cfg, now: () => T0, ip: '10.1.5.1' }, 'known-5@example.com', send);
    const token = tokenIn(sent[0]!)!;
    assert.equal(finishSignIn({ token, now: () => T0 + MIN }), 'known-5@example.com');
    assert.throws(() => finishSignIn({ token, now: () => T0 + 2 * MIN }), notRight);
  });

  test('the link lasts a day; the code ten minutes', async () => {
    const store = await listed('known-6@example.com', 'known-7@example.com');
    const { sent, send } = recorder();
    await begin({ store, cfg, now: () => T0, ip: '10.1.6.1' }, 'known-6@example.com', send);
    await begin({ store, cfg, now: () => T0, ip: '10.1.6.1' }, 'known-7@example.com', send);
    const [six, seven] = sent;
    assert.throws(() => finishSignIn({ email: 'known-6@example.com', code: codeIn(six!)!, now: () => T0 + 11 * MIN }), notRight);
    // The code has gone stale, but its link has not.
    assert.equal(finishSignIn({ token: tokenIn(six!)!, now: () => T0 + 11 * MIN }), 'known-6@example.com');
    assert.throws(() => finishSignIn({ token: tokenIn(seven!)!, now: () => T0 + 25 * HOUR }), notRight);
  });

  test('the code works once, typed in any case, and spends the link with it', async () => {
    const store = await listed('known-8@example.com');
    const { sent, send } = recorder();
    await begin({ store, cfg, now: () => T0, ip: '10.1.8.1' }, 'known-8@example.com', send);
    const code = codeIn(sent[0]!)!;
    assert.equal(finishSignIn({ email: ' Known-8@example.com', code, now: () => T0 + 9 * MIN }), 'known-8@example.com');
    assert.throws(() => finishSignIn({ email: 'known-8@example.com', code, now: () => T0 + 9 * MIN }), notRight);
    assert.throws(() => finishSignIn({ token: tokenIn(sent[0]!)!, now: () => T0 + 9 * MIN }), notRight);
  });

  test('an older link is dead once the guest has signed in another way', async () => {
    const store = await listed('known-9@example.com');
    const { sent, send } = recorder();
    await begin({ store, cfg, now: () => T0, ip: '10.1.9.1' }, 'known-9@example.com', send);
    await begin({ store, cfg, now: () => T0 + MIN, ip: '10.1.9.1' }, 'known-9@example.com', send);
    assert.equal(finishSignIn({ token: tokenIn(sent[1]!)!, now: () => T0 + 2 * MIN }), 'known-9@example.com');
    assert.throws(() => finishSignIn({ token: tokenIn(sent[0]!)!, now: () => T0 + 3 * MIN }), notRight);
  });

  test('a wrong code, an unknown token, or nothing at all: the same refusal', () => {
    assert.throws(() => finishSignIn({ email: 'known-10@example.com', code: '000000', now: () => T0 }), notRight);
    assert.throws(() => finishSignIn({ token: 'not-a-token', now: () => T0 }), notRight);
    assert.throws(() => finishSignIn({ now: () => T0 }), notRight);
  });

  test('five wrong codes and the right one no longer works: six digits are not a password', async () => {
    const store = await listed('known-11@example.com');
    const { sent, send } = recorder();
    await begin({ store, cfg, now: () => T0, ip: '10.1.11.1' }, 'known-11@example.com', send);
    const code = codeIn(sent[0]!)!;
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) {
      assert.throws(() => finishSignIn({ email: 'known-11@example.com', code: wrong, now: () => T0 }), notRight);
    }
    assert.throws(() => finishSignIn({ email: 'known-11@example.com', code, now: () => T0 }), notRight);
    // The link in the same email is 32 random bytes, and still good.
    assert.equal(finishSignIn({ token: tokenIn(sent[0]!)!, now: () => T0 }), 'known-11@example.com');
  });

  test('a mail server that refuses: the guest is told nothing different, and the log has no address, code or link', async () => {
    const store = await listed('known-12@example.com');
    const said: string[] = [];
    const { log, warn, error } = console;
    console.log = console.warn = console.error = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
    let text = '';
    try {
      await begin({ store, cfg, now: () => T0, ip: '10.1.12.1' }, 'known-12@example.com', async (_c, m) => {
        text = m.text;
        throw new MailError('550 5.1.1 <known-12@example.com>: Recipient address rejected');
      });
      // The send is not awaited by the answer; let its refusal land.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      Object.assign(console, { log, warn, error });
    }
    const code = /^\s*(\d{6})\s*$/m.exec(text)![1]!;
    const token = /token=([\w-]+)/.exec(text)![1]!;
    assert.ok(said.length > 0, 'the failure is logged');
    for (const line of said) {
      assert.ok(!line.includes('known-12'), line);
      assert.ok(!line.includes(code), line);
      assert.ok(!line.includes(token), line);
    }
  });

  test('the mail goes after the answer: nothing is handed to the mail server until the caller says it has answered', async () => {
    const store = await listed('known-14@example.com');
    const { sent, send } = recorder();
    const after = await startSignIn({ store, cfg, now: () => T0, ip: '10.1.14.1' }, 'known-14@example.com', send);
    assert.equal(sent.length, 0, 'nothing sent before the answer is written');
    after();
    assert.equal(sent.length, 1);
    // An address not on the list: there is nothing to send afterwards either.
    const none = await startSignIn({ store, cfg, now: () => T0, ip: '10.1.14.1' }, 'stranger-14@example.com', send);
    none();
    assert.equal(sent.length, 1);
  });

  test('ten wrong codes in a day for one address, across fresh emails: every code for it is refused, even the right one, until the day is out', async () => {
    const store = await listed('known-15@example.com');
    const { sent, send } = recorder();
    const wrongFor = (m: Mail) => (codeIn(m) === '123456' ? '654321' : '123456');
    // Two emails, five wrong codes each: each code locks after five, and the address has spent its ten.
    for (const at of [T0, T0 + 20 * MIN]) {
      await begin({ store, cfg, now: () => at, ip: '10.1.15.1' }, 'known-15@example.com', send);
      const wrong = wrongFor(sent.at(-1)!);
      for (let i = 0; i < 5; i++) {
        assert.throws(() => finishSignIn({ email: 'known-15@example.com', code: wrong, now: () => at }), notRight);
      }
    }
    // A fresh email does not reset it: its own right code is the same 401.
    await begin({ store, cfg, now: () => T0 + 40 * MIN, ip: '10.1.15.1' }, 'known-15@example.com', send);
    assert.equal(sent.length, 3);
    const fresh = sent.at(-1)!;
    assert.throws(() => finishSignIn({ email: 'known-15@example.com', code: codeIn(fresh)!, now: () => T0 + 41 * MIN }), notRight);
    // The link in it is 32 random bytes and is not a code: it still signs in.
    assert.equal(finishSignIn({ token: tokenIn(fresh)!, now: () => T0 + 42 * MIN }), 'known-15@example.com');
    // A day after the first wrong code, the address may type codes again.
    await begin({ store, cfg, now: () => T0 + 25 * HOUR, ip: '10.1.15.2' }, 'known-15@example.com', send);
    assert.equal(finishSignIn({ email: 'known-15@example.com', code: codeIn(sent.at(-1)!)!, now: () => T0 + 25 * HOUR }),
      'known-15@example.com');
  });

  test('another address\'s wrong codes spend nothing of this one\'s', async () => {
    const store = await listed('known-16@example.com');
    const { sent, send } = recorder();
    for (let i = 0; i < 12; i++) {
      assert.throws(() => finishSignIn({ email: 'stranger-16@example.com', code: '000000', now: () => T0 }), notRight);
    }
    await begin({ store, cfg, now: () => T0, ip: '10.1.16.1' }, 'known-16@example.com', send);
    assert.equal(finishSignIn({ email: 'known-16@example.com', code: codeIn(sent[0]!)!, now: () => T0 }), 'known-16@example.com');
  });

  test('thirty codes an hour from one IP; the thirty-first is refused (429) whatever it is, and another IP is not', async () => {
    const store = await listed('known-17@example.com');
    const { sent, send } = recorder();
    await begin({ store, cfg, now: () => T0, ip: '10.1.17.1' }, 'known-17@example.com', send);
    const code = codeIn(sent[0]!)!;
    for (let i = 0; i < 30; i++) {
      assert.throws(() => finishSignIn({ email: `nobody-${i}@example.com`, code: '000000', now: () => T0, ip: '10.1.17.9' }), notRight);
    }
    const tooMany = (e: unknown) => e instanceof ToolError && e.status === 429;
    assert.throws(() => finishSignIn({ email: 'known-17@example.com', code, now: () => T0, ip: '10.1.17.9' }), tooMany);
    assert.equal(finishSignIn({ email: 'known-17@example.com', code, now: () => T0, ip: '10.1.17.8' }), 'known-17@example.com');
  });

  test('an address longer than 254 characters is no address: nothing is sent, and its code is the one refusal', async () => {
    const long = `${'a'.repeat(250)}@example.com`;
    const store = await listed('known-18@example.com');
    const { sent, send } = recorder();
    await begin({ store, cfg, now: () => T0, ip: '10.1.18.1' }, long, send);
    assert.equal(sent.length, 0);
    assert.throws(() => finishSignIn({ email: long, code: '000000', now: () => T0 }), notRight);
  });

  test('the answer takes as long whether or not anything is sent', async () => {
    const store = await listed('known-13@example.com');
    const { send } = recorder();
    const time = async (email: string, ip: string) => {
      const t = performance.now();
      await begin({ store, cfg, now: () => T0, ip }, email, send);
      return performance.now() - t;
    };
    const known = await time('known-13@example.com', '10.1.13.1');
    const unknown = await time('stranger-13@example.com', '10.1.13.2');
    // The floor is what matters: both wait it out. The band around it is wide,
    // for a loaded machine; the known path's own work is well under a millisecond.
    assert.ok(known >= 95 && unknown >= 95, `${known} ${unknown}`);
    assert.ok(Math.abs(known - unknown) < 250, `${known} ${unknown}`);
  });
});

describe('guest sessions', () => {
  test('issued, found, and gone after thirty days', () => {
    let now = Date.parse(NOW);
    const g = new GuestSessions({ now: () => now });
    const token = g.issue('guests@example.com');
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.deepEqual(g.get(token), { email: 'guests@example.com', expiresAt: now + 30 * 24 * 3600_000 });
    now += 30 * 24 * 3600_000 - 1;
    assert.ok(g.get(token));
    now += 2;
    assert.equal(g.get(token), null);
  });

  test('revoked, and nothing for no token or a stranger\'s', () => {
    const g = new GuestSessions();
    const token = g.issue('guests@example.com');
    assert.equal(g.get(undefined), null);
    assert.equal(g.get('ab'.repeat(32)), null);
    g.revoke(token);
    assert.equal(g.get(token), null);
  });

  test('every session of one address ends together, whatever its case, and no one else\'s', () => {
    const g = new GuestSessions();
    const a = g.issue('guests@example.com');
    const b = g.issue('Guests@Example.com');
    const other = g.issue('other@example.com');
    g.revokeEmail(' GUESTS@example.com');
    assert.equal(g.get(a), null);
    assert.equal(g.get(b), null);
    assert.ok(g.get(other));
  });
});

// ─── which nights are open ────────────────────────────────────────────────────

describe('which nights are open', () => {
  const GUEST = 'guest:guests@example.com';
  const OTHER = 'guest:other@example.com';
  const TODAY = '2026-10-29';

  async function house(): Promise<Store> {
    const s = await fresh();
    await s.append('alice', [allow('guests@example.com'), allow('other@example.com', 'Other family')]);
    return s;
  }
  const dec = (s: Store, forEmail?: string, today = TODAY) =>
    availability(s.state, { month: '2026-12', today, ...(forEmail ? { forEmail } : {}) });
  const on = (rows: { night: string; status: string }[], ...days: number[]) =>
    days.map((d) => rows.find((r) => r.night === `2026-12-${String(d).padStart(2, '0')}`)!.status);

  test('a month is every night in it, in order, all open when nothing is kept', async () => {
    const s = await house();
    for (const [month, n] of [['2026-12', 31], ['2026-11', 30], ['2027-02', 28], ['2028-02', 29]] as const) {
      const rows = availability(s.state, { month, today: TODAY });
      assert.equal(rows.length, n, month);
      assert.equal(rows[0]!.night, `${month}-01`);
      assert.equal(rows.at(-1)!.night, `${month}-${n}`);
      assert.ok(rows.every((r) => r.status === 'open'), month);
    }
    const rows = dec(await house());
    assert.deepEqual(rows.map((r) => r.night), [...rows.map((r) => r.night)].sort());
  });

  test('a month that is not YYYY-MM is a 400, and so is anything that is not a string', async () => {
    const s = await house();
    for (const month of ['2026-13', '2026-00', '2026-1', '26-12', '2026-12-01', '2026/12', ' 2026-12', '', undefined, null, 202612]) {
      assert.throws(() => availability(s.state, { month: month as never, today: TODAY }),
        (e: unknown) => e instanceof ToolError && e.status === 400, String(month));
    }
  });

  test('a confirmed stay takes its nights and not the day it leaves', async () => {
    const s = await house();
    await s.append('bob', confirm('r1'));
    assert.deepEqual(on(dec(s), 11, 12, 13, 14, 15, 16), ['open', 'taken', 'taken', 'taken', 'open', 'open']);
    // The guest who is staying sees them as theirs; everyone else, as taken.
    assert.deepEqual(on(dec(s, 'guests@example.com'), 11, 12, 14, 15), ['open', 'mine-approved', 'mine-approved', 'open']);
    assert.deepEqual(on(dec(s, 'other@example.com'), 11, 12, 14, 15), ['open', 'taken', 'taken', 'open']);
    assert.deepEqual(on(dec(s, ' Guests@Example.com '), 12), ['mine-approved']);
  });

  test("another guest's request takes the nights; the same guest's is theirs, pending", async () => {
    const s = await house();
    await s.append(GUEST, request());
    assert.deepEqual(on(dec(s, 'other@example.com'), 11, 12, 14, 15), ['open', 'taken', 'taken', 'open']);
    assert.deepEqual(on(dec(s, 'guests@example.com'), 11, 12, 14, 15), ['open', 'mine-pending', 'mine-pending', 'open']);
    // A card put off for later still holds its nights.
    const [o] = await s.append(OTHER, request({ args: { email: 'other@example.com', name: 'Other family', arrive: '2026-12-20', depart: '2026-12-22', headcount: 2, note: '' } }));
    await s.append('alice', { op: 'proposal.decide', proposal: o!.id, decision: 'snoozed', fingerprint: '' });
    assert.equal(s.state.thread.offers.get(o!.id)!.status, 'snoozed');
    assert.equal(on(dec(s, 'guests@example.com'), 20)[0], 'taken');
  });

  test('a request declined, approved or replaced no longer holds its nights; an approved one is the stay', async () => {
    const s = await house();
    const [o] = await s.append(GUEST, request());
    await s.append('alice', { op: 'proposal.decide', proposal: o!.id, decision: 'declined', why: 'away that week' });
    assert.deepEqual(on(dec(s, 'other@example.com'), 12, 13), ['open', 'open']);
    assert.deepEqual(on(dec(s, 'guests@example.com'), 12, 13), ['open', 'open']);

    // Approved: the card holds nothing itself; the nights are the stay's.
    const [a] = await s.append(GUEST, request());
    await s.append('alice', { op: 'proposal.decide', proposal: a!.id, decision: 'approved' });
    assert.equal(s.state.thread.offers.get(a!.id)!.status, 'approved');
    assert.deepEqual(on(dec(s, 'other@example.com'), 12, 13, 14), ['open', 'open', 'open']);
    await s.append('alice', confirm(a!.id));
    assert.deepEqual(on(dec(s, 'other@example.com'), 12, 13, 14, 15), ['taken', 'taken', 'taken', 'open']);
    assert.deepEqual(on(dec(s, 'guests@example.com'), 12, 14), ['mine-approved', 'mine-approved']);

    // Replaced: the newer card (a member's) is not a guest's request, and holds nothing either.
    const later = { email: 'guests@example.com', name: 'Nguyen family', arrive: '2026-12-20', depart: '2026-12-22', headcount: 2, note: '' };
    const [r] = await s.append(GUEST, request({ args: later }));
    assert.deepEqual(on(dec(s, 'other@example.com'), 20, 21), ['taken', 'taken']);
    await s.append('alice', request({ args: later, prompt: { kind: 'member', ref: r!.id }, replaces: r!.id }));
    assert.equal(s.state.thread.offers.get(r!.id)!.status, 'replaced');
    assert.deepEqual(on(dec(s, 'other@example.com'), 20, 21), ['open', 'open']);
    assert.deepEqual(on(dec(s, 'guests@example.com'), 20, 21), ['open', 'open']);
  });

  test('a block takes its nights (to excluded), whoever asks, and unblocking frees them', async () => {
    const s = await house();
    const [b] = await s.append('alice', { op: 'booking.block', from: '2026-12-24', to: '2026-12-27', why: 'family here' });
    for (const email of [undefined, 'guests@example.com']) {
      assert.deepEqual(on(dec(s, email), 23, 24, 25, 26, 27), ['open', 'taken', 'taken', 'taken', 'open']);
    }
    await s.append('bob', { op: 'booking.unblock', block: b!.id, why: 'plans changed' });
    assert.deepEqual(on(dec(s), 24, 25, 26), ['open', 'open', 'open']);
  });

  test('a stay or block that starts before the month, or runs past it, takes only what is in it', async () => {
    const s = await house();
    await s.append('alice', { op: 'booking.block', from: '2026-11-28', to: '2026-12-03', why: 'w' });
    await s.append('alice', { op: 'booking.block', from: '2026-12-30', to: '2027-01-03', why: 'w' });
    assert.deepEqual(on(dec(s), 1, 2, 3, 29, 30, 31), ['taken', 'taken', 'open', 'open', 'taken', 'taken']);
    const jan = availability(s.state, { month: '2027-01', today: TODAY });
    assert.deepEqual(jan.slice(0, 3).map((r) => r.status), ['taken', 'taken', 'open']);
    const nov = availability(s.state, { month: '2026-11', today: TODAY });
    assert.deepEqual(nov.slice(-3).map((r) => r.status), ['taken', 'taken', 'taken']);
    assert.equal(nov[26]!.status, 'open');
  });

  test('a cancelled stay frees its nights', async () => {
    const s = await house();
    const [c] = await s.append('bob', confirm('r1'));
    await s.append('alice', { op: 'booking.cancel', stay: c!.id, why: 'plans changed' });
    assert.deepEqual(on(dec(s), 12, 13, 14), ['open', 'open', 'open']);
    assert.deepEqual(on(dec(s, 'guests@example.com'), 12, 13, 14), ['open', 'open', 'open']);
  });

  test('nights before the household\'s today are taken for a guest: nobody books the past', async () => {
    const s = await house();
    const rows = availability(s.state, { month: '2026-10', today: TODAY, forEmail: 'guests@example.com' });
    assert.equal(rows.filter((r) => r.status === 'taken').length, 28);
    assert.equal(rows[27]!.status, 'taken');   // 28 Oct, last night before today
    assert.equal(rows[28]!.status, 'open');    // 29 Oct, tonight
    const whole = availability(s.state, { month: '2026-09', today: TODAY, forEmail: 'guests@example.com' });
    assert.ok(whole.every((r) => r.status === 'taken'));
  });

  test("a guest's row carries a night and a status and nothing else", async () => {
    const s = await house();
    await s.append('bob', confirm('r1'));
    await s.append(OTHER, request({ args: { email: 'other@example.com', name: 'Other family', arrive: '2026-12-20', depart: '2026-12-22', headcount: 2, note: 'x' } }));
    await s.append('alice', { op: 'booking.block', from: '2026-12-24', to: '2026-12-26', why: 'secret reason' });
    for (const email of [undefined, 'guests@example.com', 'other@example.com']) {
      const rows = dec(s, email);
      for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['night', 'status']);
      const text = JSON.stringify(rows);
      for (const secret of ['Other family', 'Nguyen', 'secret reason', 'alice', 'bob', 'guests@', 'other@']) {
        assert.ok(!text.includes(secret), `${secret} in ${text}`);
      }
    }
  });

  test('a request with unusable dates holds nothing, rather than breaking the calendar', async () => {
    const s = await house();
    await s.append(GUEST, request({ args: { email: 'guests@example.com', name: 'N', arrive: 'soon', depart: 5, headcount: 1, note: '' } }));
    await s.append(GUEST, request({ args: { email: 'guests@example.com', name: 'N', arrive: '2026-12-15', depart: '2026-12-12', headcount: 1, note: '' } }));
    assert.ok(dec(s, 'other@example.com').every((r) => r.status === 'open'));
  });

  test('a request with a date that looks right but is not one holds nothing, and the month still answers', async () => {
    const s = await house();
    for (const [arrive, depart] of [['2026-13-45', '2026-12-20'], ['2026-12-10', '2026-12-32'], ['2026-02-30', '2026-12-03'], ['0000-00-00', '9999-99-99']]) {
      await s.append(GUEST, request({ args: { email: 'guests@example.com', name: 'N', arrive, depart, headcount: 1, note: '' } }));
    }
    for (const email of [undefined, 'guests@example.com', 'other@example.com']) {
      assert.ok(dec(s, email).every((r) => r.status === 'open'), String(email));
    }
    assert.ok(memberNights(s.state, { month: '2026-12', today: TODAY }).every((r) => r.status === 'open'));
  });

  test('members see why: who, what kind, and the reason for a block; open nights say nothing', async () => {
    const s = await house();
    await s.append('bob', confirm('r1'));
    await s.append(OTHER, request({ args: { email: 'other@example.com', name: 'Other family', arrive: '2026-12-20', depart: '2026-12-22', headcount: 2, note: '' } }));
    await s.append('alice', { op: 'booking.block', from: '2026-12-24', to: '2026-12-26', why: 'family here' });
    const rows = memberNights(s.state, { month: '2026-12', today: TODAY });
    const at = (d: number) => rows.find((r) => r.night === `2026-12-${String(d).padStart(2, '0')}`)!;
    assert.deepEqual(at(12), { night: '2026-12-12', status: 'taken', kind: 'stay', by: 'Nguyen family' });
    assert.deepEqual(at(21), { night: '2026-12-21', status: 'taken', kind: 'pending', by: 'Other family' });
    assert.deepEqual(at(25), { night: '2026-12-25', status: 'taken', kind: 'block', by: 'alice', why: 'family here' });
    assert.deepEqual(at(15), { night: '2026-12-15', status: 'open' });
    const oct = memberNights(s.state, { month: '2026-10', today: TODAY });
    assert.deepEqual(oct[0], { night: '2026-10-01', status: 'taken', kind: 'past' });
    assert.deepEqual(oct[28], { night: '2026-10-29', status: 'open' });
  });
});

// ─── a request is a card ──────────────────────────────────────────────────────

describe('a request is a card', () => {
  const GUEST = 'guest:guests@example.com';
  const OTHER = 'guest:other@example.com';
  const TODAY = '2026-10-29';
  const DEC = { arrive: '2026-12-12', depart: '2026-12-15', headcount: 3, note: "We'd love to see the house!" };

  async function house(): Promise<Store> {
    const s = await fresh();
    await s.append('alice', [allow('guests@example.com'), allow('other@example.com', 'Other family')]);
    return s;
  }
  const asGuest = (s: Store, o: Record<string, unknown>, who = GUEST) => ask({ store: s, who, today: TODAY }, o);
  const member = (s: Store, who = 'alice'): ToolContext => ({ store: s, who, today: TODAY, proposals: new ProposalStore(), sid: null });
  const status = (n: number) => (e: unknown) => e instanceof ToolError && e.status === n;
  const says = (re: RegExp, n?: number) => (e: unknown) =>
    e instanceof ToolError && re.test(e.message) && (n === undefined || e.status === n);

  test('a valid request is an open card by the guest, named from the list, in the card\'s words', async () => {
    const s = await house();
    const o = await asGuest(s, DEC);
    assert.equal(o.who, GUEST);
    assert.equal(o.status, 'open');
    assert.equal(o.tool, 'approve_booking');
    assert.deepEqual(o.prompt, { kind: 'booking', ref: null });
    assert.deepEqual(o.args, { email: 'guests@example.com', name: 'Nguyen family', ...DEC });
    assert.equal(o.summary, 'Nguyen family would like to come Dec 12–15, 3 people: “We\'d love to see the house!”');
    assert.deepEqual(o.effects, ['An all-day event on the Household calendar, Dec 12–15', 'A confirmation email to Nguyen family']);
    assert.ok(!o.summary.includes('@') && !o.effects.some((x) => x.includes('@')));
    // Its nights are held from here.
    const rows = availability(s.state, { month: '2026-12', today: TODAY, forEmail: 'other@example.com' });
    assert.equal(rows.find((r) => r.night === '2026-12-13')!.status, 'taken');
  });

  test('one person, no note, across a month end, a year on: the sentence says so', async () => {
    const s = await house();
    const o = await asGuest(s, { arrive: '2027-12-30', depart: '2028-01-02', headcount: 1, note: '  ' });
    assert.equal(o.summary, 'Nguyen family would like to come Dec 30–Jan 2, 2027, 1 person');
    assert.equal(o.args['note'], '');
  });

  test('three requests waiting at once, at most: the fourth is refused in the guest\'s voice; one decided or withdrawn frees a place', async () => {
    const s = await house();
    const at = (m: string) => ({ arrive: `2027-${m}-01`, depart: `2027-${m}-03`, headcount: 2, note: '' });
    const [one] = [await asGuest(s, at('01')), await asGuest(s, at('02')), await asGuest(s, at('03'))];
    await assert.rejects(asGuest(s, at('04')), (e: unknown) => e instanceof ToolError && e.status === 409
      && e.message === 'you already have three requests waiting: wait for an answer, or withdraw one');
    assert.equal([...s.state.thread.offers.values()].filter((o) => o.status === 'open').length, 3);
    // Another guest is not counted against them.
    await asGuest(s, at('05'), OTHER);
    await cancelStay({ store: s, who: GUEST, today: TODAY }, one!.id, 'withdrawn by the guest');
    await asGuest(s, at('04'));
  });

  test('sixty nights waiting at once, at most', async () => {
    const s = await house();
    await asGuest(s, { arrive: '2027-01-01', depart: '2027-01-31', headcount: 2, note: '' });   // 30 nights
    await asGuest(s, { arrive: '2027-03-01', depart: '2027-03-29', headcount: 2, note: '' });   // 28 nights
    await assert.rejects(asGuest(s, { arrive: '2027-05-01', depart: '2027-05-04', headcount: 2, note: '' }),
      (e: unknown) => e instanceof ToolError && e.status === 409 && /58 nights waiting.*at most 60/.test(e.message));
    await asGuest(s, { arrive: '2027-05-01', depart: '2027-05-03', headcount: 2, note: '' });   // 60 exactly
  });

  test('the name and email come from the session and the list, never the body', async () => {
    const s = await house();
    const o = await asGuest(s, { ...DEC, name: 'Mallory', email: 'mallory@example.com', who: 'alice' });
    assert.deepEqual(o.args, { email: 'guests@example.com', name: 'Nguyen family', ...DEC });
    assert.ok(!o.summary.includes('Mallory'));
  });

  test('the stored card carries no events, month, envelopes or figures', async () => {
    const s = await house();
    const o = await asGuest(s, DEC);
    const line = (await s.since(null)).find((e) => e.id === o.id) as unknown as Record<string, unknown>;
    assert.equal(line['op'], 'proposal.offer');
    assert.deepEqual(line['events'], []);
    assert.equal(line['month'], null);
    assert.deepEqual(line['envelopes'], []);
    assert.equal(line['fingerprint'], '');
    assert.equal(line['replaces'], undefined);
    assert.equal(line['plan'], undefined);
  });

  test('a stay is real days, arriving today or later, leaving after, at most 30 nights', async () => {
    const s = await house();
    const bad: Record<string, unknown>[] = [
      { ...DEC, arrive: '2026-13-45' }, { ...DEC, depart: '2026-12-32' }, { ...DEC, arrive: 'soon' }, { ...DEC, arrive: undefined },
      { ...DEC, depart: '2026-12-12' }, { ...DEC, depart: '2026-12-11' },
      { ...DEC, arrive: '2026-10-28', depart: '2026-10-30' },
      { ...DEC, arrive: '2026-12-01', depart: '2027-01-01' },
      { ...DEC, headcount: 0 }, { ...DEC, headcount: -1 }, { ...DEC, headcount: 1.5 }, { ...DEC, headcount: 21 },
      { ...DEC, headcount: '3' }, { ...DEC, headcount: undefined },
      { ...DEC, note: 'x'.repeat(501) }, { ...DEC, note: 42 },
    ];
    for (const o of bad) await assert.rejects(asGuest(s, o), status(400), JSON.stringify(o));
    assert.equal(s.state.thread.offers.size, 0);
    // The edges that are fine: tonight, 30 nights, 20 people, 500 characters, no note at all.
    await asGuest(s, { arrive: TODAY, depart: '2026-11-28', headcount: 20, note: 'x'.repeat(500) });
    await asGuest(s, { arrive: '2027-03-01', depart: '2027-03-02', headcount: 1 });
  });

  test('a second request over the same guest\'s own nights: "you already have"', async () => {
    const s = await house();
    await asGuest(s, DEC);
    await assert.rejects(asGuest(s, { ...DEC, arrive: '2026-12-14', depart: '2026-12-18' }), says(/^you already have a request waiting for Dec 12–15$/, 409));
    // The day they leave is the next arrival day.
    await asGuest(s, { ...DEC, arrive: '2026-12-15', depart: '2026-12-17' });
    // And over a confirmed stay of theirs.
    await s.append('bob', confirm('r1', { arrive: '2027-02-01', depart: '2027-02-04' }));
    await assert.rejects(asGuest(s, { ...DEC, arrive: '2027-01-30', depart: '2027-02-02' }), says(/^you already have a stay booked for Feb 1–4, 2027$/, 409));
  });

  test('over another guest\'s waiting nights, or a block: taken, and nothing about whose', async () => {
    const s = await house();
    await asGuest(s, { ...DEC, note: 'other note' }, OTHER);
    const err = await asGuest(s, { ...DEC, arrive: '2026-12-14', depart: '2026-12-16' }).catch((e: unknown) => e);
    assert.ok(says(/taken/, 409)(err), String(err));
    assert.equal((err as Error).message, 'the night of Dec 14 is taken');
    await s.append('alice', { op: 'booking.block', from: '2026-12-31', to: '2027-01-02', why: 'family is here' });
    const err2 = await asGuest(s, { ...DEC, arrive: '2026-12-29', depart: '2027-01-03' }).catch((e: unknown) => e);
    assert.equal((err2 as Error).message, 'the nights of Dec 31 and Jan 1 are taken');
    for (const e of [err, err2]) assert.ok(!/Other|other@|family is here|alice/.test((e as Error).message));
    assert.equal(s.state.thread.offers.size, 1);
  });

  test('only a guest on the list asks', async () => {
    const s = await house();
    await assert.rejects(asGuest(s, DEC, 'guest:stranger@example.com'), status(401));
    await assert.rejects(asGuest(s, DEC, 'alice'), status(403));
    await s.append('alice', { op: 'guest.revoke', email: 'guests@example.com', why: 'moved' });
    await assert.rejects(asGuest(s, DEC), status(401));
  });

  test('a guest still writes nothing else: plan.create is refused by the fold', async () => {
    const s = await house();
    await asGuest(s, DEC);
    await assert.rejects(s.append(GUEST, { op: 'plan.create', plan: 'p1', title: 'x', area: 'House' }), refused(/a guest cannot plan\.create/));
  });

  test('what a guest sees of their own: requests and stays, with a decline\'s reason and suggested dates', async () => {
    const s = await house();
    const a = await asGuest(s, DEC);
    const b = await asGuest(s, { arrive: '2027-01-10', depart: '2027-01-12', headcount: 2, note: 'b' });
    const c = await asGuest(s, { arrive: '2027-02-10', depart: '2027-02-12', headcount: 2, note: 'c' });
    // Three waiting at most: b is answered before d is asked.
    await s.append('alice', { op: 'proposal.decide', proposal: b.id, decision: 'declined', why: 'we are away' });
    const d = await asGuest(s, { arrive: '2027-03-10', depart: '2027-03-12', headcount: 2, note: 'd' });
    const theirs = await asGuest(s, { arrive: '2027-04-10', depart: '2027-04-12', headcount: 2, note: 'secret' }, OTHER);
    const [, sg] = await s.append('bob', [
      { op: 'proposal.decide', proposal: c.id, decision: 'declined', why: 'not that week' },
      { op: 'booking.suggest', request: c.id, email: 'guests@example.com', arrive: '2027-02-20', depart: '2027-02-22', why: 'how about later?' },
    ]);
    await s.append(GUEST, { op: 'booking.cancel', stay: d.id, why: 'cannot come' });
    const rows = mine(s.state, await s.since(null), 'Guests@Example.com ', TODAY);
    assert.deepEqual(rows, [
      { id: a.id, arrive: '2026-12-12', depart: '2026-12-15', headcount: 3, note: DEC.note, status: 'pending' },
      { id: b.id, arrive: '2027-01-10', depart: '2027-01-12', headcount: 2, note: 'b', status: 'declined', why: 'we are away' },
      { id: c.id, arrive: '2027-02-10', depart: '2027-02-12', headcount: 2, note: 'c', status: 'suggested', why: 'how about later?',
        suggested: { id: sg!.id, arrive: '2027-02-20', depart: '2027-02-22' } },
      { id: d.id, arrive: '2027-03-10', depart: '2027-03-12', headcount: 2, note: 'd', status: 'cancelled' },
    ]);
    assert.ok(!JSON.stringify(rows).includes(theirs.id) && !JSON.stringify(rows).includes('secret'));
    // Approved and confirmed: the stay's dates; cancelled afterwards, cancelled.
    await s.append('alice', [{ op: 'proposal.decide', proposal: a.id, decision: 'approved' }, confirm(a.id)]);
    const stay = [...s.state.stays.keys()][0]!;
    assert.equal(mine(s.state, await s.since(null), 'guests@example.com', TODAY)[0]!.status, 'approved');
    await s.append(GUEST, { op: 'booking.cancel', stay, why: 'sorry' });
    assert.equal(mine(s.state, await s.since(null), 'guests@example.com', TODAY)[0]!.status, 'cancelled');
    assert.deepEqual(mine(s.state, await s.since(null), 'other@example.com', TODAY).map((r) => r.id), [theirs.id]);
  });
});

describe('approve_booking', () => {
  const GUEST = 'guest:guests@example.com';
  const TODAY = '2026-10-29';
  const DEC = { arrive: '2026-12-12', depart: '2026-12-15', headcount: 3, note: 'hi' };
  async function house(): Promise<Store> {
    const s = await fresh();
    await s.append('alice', [allow('guests@example.com'), allow('other@example.com', 'Other family')]);
    return s;
  }
  const member = (s: Store, who = 'alice', today = TODAY): ToolContext => ({ store: s, who, today, proposals: new ProposalStore(), sid: null });
  const tool = toolByName.get('approve_booking')!;

  test('Claude never sees it; the app runs it for a guest\'s card', () => {
    assert.ok(tool);
    assert.equal(tool.kind, 'write');
    assert.equal(forClaude(tool), false);
    assert.ok(!toolSchemas().some((t) => t.name === 'approve_booking'));
  });

  test('run, at decision time, passes the request\'s own nights and says what approving does', async () => {
    const s = await house();
    const o = await ask({ store: s, who: GUEST, today: TODAY }, DEC);
    const p = await tool.run(o.args, member(s)) as { summary: string; effects: string[]; events: unknown[] };
    assert.equal(p.summary, 'Nguyen family would like to come Dec 12–15, 3 people: “hi”');
    assert.deepEqual(p.effects, ['An all-day event on the Household calendar, Dec 12–15', 'A confirmation email to Nguyen family']);
    assert.deepEqual(p.events, []);
  });

  test('run refuses nights taken in between, and names what took them', async () => {
    const s = await house();
    const o = await ask({ store: s, who: GUEST, today: TODAY }, DEC);
    await s.append('alice', { op: 'booking.block', from: '2026-12-14', to: '2026-12-16', why: 'family is here' });
    assert.throws(() => tool.run(o.args, member(s)), (e: unknown) =>
      e instanceof ToolError && e.status === 409 && /taken/.test(e.message) && /family is here/.test(e.message), 'block');
    const t = await (async () => { const x = await house(); return x; })();
    const o2 = await ask({ store: t, who: GUEST, today: TODAY }, DEC);
    await t.append('bob', confirm('elsewhere', { email: 'other@example.com', arrive: '2026-12-10', depart: '2026-12-13' }));
    assert.throws(() => tool.run(o2.args, member(t)), (e: unknown) =>
      e instanceof ToolError && /taken/.test(e.message) && /Other family/.test(e.message), 'stay');
    // A date that has passed while the card waited.
    assert.throws(() => tool.run(o2.args, member(t, 'alice', '2026-12-13')), /passed/);
  });

  test('run refuses a guest no longer on the list, and a card in a bad shape', async () => {
    const s = await house();
    const o = await ask({ store: s, who: GUEST, today: TODAY }, DEC);
    for (const args of [{ ...o.args, headcount: 0 }, { ...o.args, arrive: '2026-13-45' }, { ...o.args, name: '' }, { ...o.args, email: 'nope' }]) {
      assert.throws(() => tool.run(args, member(s)), (e: unknown) => e instanceof ToolError && e.status === 400, JSON.stringify(args));
    }
    // Run as a guest, it is for their own email only.
    assert.throws(() => tool.run(o.args, { ...member(s), who: 'guest:other@example.com' }), (e: unknown) => e instanceof ToolError && e.status === 403);
    await s.append('alice', { op: 'guest.revoke', email: 'guests@example.com', why: 'moved' });
    assert.throws(() => tool.run(o.args, member(s)), /no longer on the guest list/);
  });

  test('declining needs a reason the guest will read; adjusting or working it out again is refused', async () => {
    const s = await house();
    const o = await ask({ store: s, who: GUEST, today: TODAY }, DEC);
    await assert.rejects(decide(member(s), o.id, 'declined'), /reason/);
    await assert.rejects(refresh(member(s), o.id), (e: unknown) => e instanceof ToolError);
    await assert.rejects(adjust(member(s), o.id, { headcount: 9 }), (e: unknown) => e instanceof ToolError);
    const cfg = { url: 'https://book.example.com', household: 'home', smtp: { host: 'h', port: 587, user: 'u', pass: 'p', from: 'house@example.com' } };
    await decide({ ...member(s), mail: { smtp: cfg.smtp, url: cfg.url, send: async () => {} } }, o.id, 'declined', 'we are away');
    assert.equal(s.state.thread.offers.get(o.id)!.why, 'we are away');
    assert.equal(s.state.thread.offers.size, 1);
  });
});

// ─── approve, decline, suggest: the mail goes first ───────────────────────────
//
// Against the fake DSM, through a fetch that records each call, and a mailbox
// standing in for SMTP that records what would have gone out, or refuses as
// the server named in `fail` would. `order` interleaves the two, so "the
// calendar, then the mail, then the log" is something a test can read.

describe('approve, decline, suggest: the mail goes first', () => {
  const GUEST = 'guest:guests@example.com';
  const OTHER = 'guest:other@example.com';
  const TODAY = '2026-10-29';
  const DEC = { arrive: '2026-12-12', depart: '2026-12-15', headcount: 3, note: 'hi' };
  const CFG: BookingConfig = {
    url: 'https://book.example.com', household: 'home',
    smtp: { host: 'mail.example.com', port: 587, user: 'robot', pass: 'pw', from: 'house@example.com' },
  };
  let nas: FakeDsm;
  const calls: { api: string; method: string }[] = [];
  const order: string[] = [];
  /** When set, the NAS refuses every event delete, as a NAS that has stopped answering well would, with this code. */
  let failDelete = false;
  let deleteCode = 117;
  const via: DsmFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ api: params.get('api') ?? '', method: params.get('method') ?? '' });
    if (params.get('api') === 'SYNO.Cal.Event') order.push(`dsm:${params.get('method')}`);
    if (failDelete && params.get('api') === 'SYNO.Cal.Event' && params.get('method') === 'delete') {
      return new Response(JSON.stringify({ success: false, error: { code: deleteCode } }), { headers: { 'content-type': 'application/json' } });
    }
    return fetch(`http://127.0.0.1:${nas.port}/webapi/entry.cgi`, init);
  }) as DsmFetch;

  before(async () => {
    nas = await startFakeDsm({ port: 0, log: () => {}, accounts: { alice: { password: 'pw-a' }, bob: { password: 'pw-b' } } });
    setDsmFetch(via);
  });
  after(async () => { setDsmFetch(null); await nas.close(); });

  async function signIn(account: string, passwd: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${nas.port}/webapi/entry.cgi`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api: 'SYNO.API.Auth', version: '6', method: 'login', account, passwd }).toString(),
    });
    return ((await res.json()) as { data: { sid: string } }).data.sid;
  }

  interface Sent extends Mail { name: string }
  function mailbox() {
    const box = {
      sent: [] as Sent[],
      fail: null as string | null,
      /** Run as each mail is handed over, before it is recorded. */
      onSend: null as (() => void) | null,
      /** While set, a mail waits here before it goes: a slow mail server. */
      gate: null as Promise<void> | null,
      send: async (_cfg: SmtpConfig, m: Mail, name: string) => {
        box.onSend?.();
        if (box.gate) await box.gate;
        order.push('mail');
        if (box.fail) throw new MailError(box.fail);
        box.sent.push({ ...m, name });
      },
    };
    return box;
  }

  /** The household with two guests, its Household calendar already made, alice signed in, and the records cleared. */
  async function setup(who = 'alice') {
    const s = await fresh();
    await s.append('alice', [allow('guests@example.com'), allow('other@example.com', 'Other family')]);
    const box = mailbox();
    const sid = await signIn(who, who === 'bob' ? 'pw-b' : 'pw-a');
    const ctx: ToolContext = { store: s, who, today: TODAY, proposals: new ProposalStore(), sid, mail: { smtp: CFG.smtp, url: CFG.url, send: box.send } };
    await ensureHouseholdCalendar({ ...ctx, who: 'alice', sid: await signIn('alice', 'pw-a') }, ['alice', 'bob']);
    calls.length = 0;
    order.length = 0;
    failDelete = false;
    deleteCode = 117;
    return { s, ctx, box };
  }
  const event = (method: string) => calls.filter((c) => c.api === 'SYNO.Cal.Event' && c.method === method);
  const asGuest = (s: Store, who = GUEST) => ({ store: s, who, today: TODAY });
  const count = async (s: Store) => (await s.since(null)).length;
  const says = (re: RegExp, n?: number) => (e: unknown) =>
    e instanceof ToolError && re.test(e.message) && (n === undefined || e.status === n);

  test('approve: the event on the Household calendar, then one mail, then the decision and the stay in one write', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    let atMail: string | undefined;
    box.onSend = () => { atMail = s.state.thread.offers.get(o.id)!.status; };
    const written = await decide(ctx, o.id, 'approved');

    assert.deepEqual(order, ['dsm:create', 'mail']);
    assert.equal(atMail, 'open', 'the mail goes before anything is written');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'booking.confirm']);
    assert.equal(written[0]!.at, written[1]!.at);
    assert.equal(written[0]!.who, 'alice');
    const c = written[1] as Extract<Event, { op: 'booking.confirm' }>;
    assert.equal(c.request, o.id);
    assert.equal(c.email, 'guests@example.com');
    assert.deepEqual([c.arrive, c.depart, c.headcount], ['2026-12-12', '2026-12-15', 3]);
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'approved');
    const stay = s.state.stays.get(c.id)!;
    assert.equal(stay.name, 'Nguyen family');
    assert.equal(stay.cancelled, false);

    // On the NAS: all day, in the list's name, how many.
    const onNas = await getEvent(ctx.sid!, { evt_id: c.evt_id, cal_id: c.cal_id, original_cal_id: c.original_cal_id }, via);
    assert.equal(onNas.summary, 'Nguyen family staying (3)');
    assert.equal(onNas.is_all_day, true);
    assert.equal(c.cal_id, s.state.calendar.household!.cal_id);

    // One mail, to the guest, from the household by name: the dates, how many, the note, the way back.
    assert.equal(box.sent.length, 1);
    const m = box.sent[0]!;
    assert.equal(m.to, 'guests@example.com');
    assert.equal(m.name, 'Home');
    assert.match(m.subject, /Dec 12–15/);
    for (const part of ['Nguyen family', 'Dec 12–15', '3 people', 'hi', 'https://book.example.com/book']) assert.ok(m.text.includes(part), part);
    assert.ok(!/alice|bob|other@|Other family|house@/.test(m.text + m.subject), m.text);
    // The nights are the guest's now, and taken for everyone else.
    const other = availability(s.state, { month: '2026-12', today: TODAY, forEmail: 'other@example.com' });
    assert.equal(other.find((r) => r.night === '2026-12-13')!.status, 'taken');
  });

  test('SMTP answers 550: the event is taken back off, nothing is written, the card stays open and says why; a second try runs', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    box.fail = '550 5.1.1 <guests@example.com>: Recipient address rejected';
    const n = await count(s);
    await assert.rejects(decide(ctx, o.id, 'approved'), says(/550 5\.1\.1/, 502));
    assert.deepEqual(order, ['dsm:create', 'mail', 'dsm:delete']);
    assert.equal(event('create').length, 1);
    assert.equal(event('delete').length, 1);
    assert.equal(await count(s), n, 'nothing appended');
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'open');
    assert.equal(s.state.stays.size, 0);
    // The card is not left marked as being decided: the next approval runs.
    box.fail = null;
    calls.length = 0;
    await decide(ctx, o.id, 'approved');
    assert.equal(event('create').length, 1);
    assert.equal(box.sent.length, 1);
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'approved');
  });

  test('nights taken in between: refused with "taken", nothing called, no mail', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    await s.append('bob', { op: 'booking.block', from: '2026-12-14', to: '2026-12-16', why: 'family is here' });
    await assert.rejects(decide(ctx, o.id, 'approved'), says(/taken/, 409));
    assert.equal(event('create').length, 0);
    assert.equal(box.sent.length, 0);
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'open');
  });

  test('only this card\'s own nights are passed: another waiting request of the same guest over them is a clash', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    // Written straight to the log (the page would have said "you already have"): the fold does not check nights.
    await s.append(GUEST, request({ args: { ...o.args, arrive: '2026-12-14', depart: '2026-12-16' } }));
    await assert.rejects(decide(ctx, o.id, 'approved'), says(/taken/, 409));
    assert.equal(event('create').length, 0);
    assert.equal(box.sent.length, 0);
  });

  test('with booking off, a card may still be declined (its mail goes, without a link if there is no page) but never approved', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    const off = { ...ctx, mail: { smtp: CFG.smtp, url: null, send: box.send, off: 'Booking is off until BOOK_URL is set in Home Planner\'s deployment.' } };
    await assert.rejects(decide(off, o.id, 'approved'), says(/booking is off.*BOOK_URL.*declined, not approved/i, 409));
    assert.equal(calls.length, 0);
    assert.equal(box.sent.length, 0);
    await decide(off, o.id, 'declined', 'we are away then');
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'declined');
    assert.equal(box.sent.length, 1);
    assert.match(box.sent[0]!.text, /we are away then/);
    assert.doesNotMatch(box.sent[0]!.text, /booking page|null|undefined/);
  });

  test('with booking off and no mail server set, a decline is a 502 that says the guest cannot be told, and the card stays', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    const off = { ...ctx, mail: { smtp: null, url: null, send: box.send, off: 'Booking is off until SMTP_HOST is set in Home Planner\'s deployment.' } };
    await assert.rejects(decide(off, o.id, 'declined', 'away'), says(/no mail server is set.*SMTP_HOST.*Nguyen family cannot be told.*not declined/, 502));
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'open');
    assert.equal(box.sent.length, 0);
  });

  test('with booking\'s mail not set up, approving and declining are refused before anything is called', async () => {
    const { s, ctx } = await setup();
    const o = await ask(asGuest(s), DEC);
    const { mail: _none, ...bare } = ctx;
    await assert.rejects(decide(bare, o.id, 'approved'), says(/mail/, 409));
    await assert.rejects(decide(bare, o.id, 'declined', 'away'), says(/mail/, 409));
    assert.equal(calls.length, 0);
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'open');
  });

  test('a mail server silent once it had the confirmation: the member is told it may not have gone, and nothing is approved', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    box.send = async () => { throw new MailError('mail.example.com:587 did not answer once it had the message, so it may not have gone', true); };
    ctx.mail!.send = box.send;
    await assert.rejects(decide(ctx, o.id, 'approved'), says(/^the confirmation to Nguyen family may not have gone, so it is not approved/, 502));
    await assert.rejects(decide(ctx, o.id, 'declined', 'away'), says(/^the email to Nguyen family may not have gone, so it is not declined yet/, 502));
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'open');
  });

  test('approve with an arrival note set: the confirmation carries it', async () => {
    const { s, ctx, box } = await setup();
    await s.append('bob', { op: 'guests.arrival', text: 'The gate code is 4471.' });
    const o = await ask(asGuest(s), DEC);
    await decide(ctx, o.id, 'approved');
    assert.match(box.sent[0]!.text, /The gate code is 4471\./);
  });

  test('the write refused after the confirmation went: the event comes off, and the member and the log are told the guest holds a confirmation', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    // While the mail goes, someone declines the card behind the approval's back.
    box.onSend = () => { box.gate = s.append('bob', { op: 'proposal.decide', proposal: o.id, decision: 'declined', why: 'away' }).then(() => {}); };
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')); };
    let err: unknown;
    try { await decide(ctx, o.id, 'approved'); } catch (e) { err = e; } finally { console.warn = warn; }
    assert.ok(err instanceof ToolError && err.status === 409, String(err));
    assert.match((err as Error).message, /Nguyen family already holds a confirmation for Dec 12–15/);
    assert.equal(event('delete').length, 1, 'the event comes back off');
    assert.equal(box.sent.length, 1);
    const lines = warned.filter((l) => /holds a confirmation/.test(l));
    assert.equal(lines.length, 1, warned.join('\n'));
    assert.match(lines[0]!, /Nguyen family already holds a confirmation for Dec 12–15/);
    assert.doesNotMatch(lines[0]!, /guests@example\.com/);
  });

  test('a suggestion whose arrival has passed has lapsed: shown so, with nothing to accept', async () => {
    const { s, ctx } = await setup();
    const p = await ask(asGuest(s), { ...DEC, arrive: '2026-11-01', depart: '2026-11-03' });
    await suggest(ctx, p.id, { arrive: '2026-11-10', depart: '2026-11-12', why: 'how about later?' });
    const before = mine(s.state, await s.since(null), 'guests@example.com', '2026-11-09');
    assert.equal(before[0]!.status, 'suggested');
    const after = mine(s.state, await s.since(null), 'guests@example.com', '2026-11-10');
    assert.equal(after[0]!.status, 'suggested', 'arriving today is still in time');
    const lapsed = mine(s.state, await s.since(null), 'guests@example.com', '2026-11-11');
    assert.equal(lapsed[0]!.status, 'lapsed');
    assert.deepEqual([lapsed[0]!.suggested?.arrive, lapsed[0]!.why], ['2026-11-10', 'how about later?']);
  });

  test('decline: one mail with the reason, then the decision', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    let atMail: string | undefined;
    box.onSend = () => { atMail = s.state.thread.offers.get(o.id)!.status; };
    await decide(ctx, o.id, 'declined', 'we are away that week');
    assert.equal(atMail, 'open');
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'declined');
    assert.equal(box.sent.length, 1);
    const m = box.sent[0]!;
    assert.equal(m.to, 'guests@example.com');
    assert.equal(m.name, 'Home');
    for (const part of ['Dec 12–15', 'we are away that week']) assert.ok(m.text.includes(part), part);
    assert.ok(!/alice|bob|other@|house@/.test(m.text + m.subject), m.text);
    assert.equal(calls.length, 0, 'a decline touches no calendar');
  });

  test('a decline that could not be mailed is not a decline: 502, the card stays open, and it can be tried again', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    box.fail = '451 4.3.0 try again later';
    const n = await count(s);
    await assert.rejects(decide(ctx, o.id, 'declined', 'away'), says(/451 4\.3\.0/, 502));
    assert.equal(await count(s), n);
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'open');
    box.fail = null;
    await decide(ctx, o.id, 'declined', 'away');
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'declined');
  });

  test('suggest: the request is declined, the dates recorded, and two mails, the second with a link on BOOK_URL', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    const e = await suggest(ctx, o.id, { arrive: '2027-01-03', depart: '2027-01-06', why: 'December is full' });
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'declined');
    assert.equal(s.state.thread.offers.get(o.id)!.why, 'December is full');
    const lines = (await s.since(null)).filter((x) => x.op === 'booking.suggest');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.id, e.id);
    assert.deepEqual({ ...lines[0], id: undefined, at: undefined },
      { id: undefined, at: undefined, who: 'alice', op: 'booking.suggest', request: o.id, email: 'guests@example.com',
        arrive: '2027-01-03', depart: '2027-01-06', why: 'December is full' });
    assert.equal(box.sent.length, 2);
    const [declined, suggested] = box.sent;
    assert.ok(declined!.text.includes('December is full'));
    for (const part of ['Jan 3–6, 2027', 'December is full', `https://book.example.com/book?suggest=${e.id}`]) {
      assert.ok(suggested!.text.includes(part), part);
    }
    assert.equal(suggested!.to, 'guests@example.com');
    assert.ok(!/alice|bob|other@|house@/.test(suggested!.text + suggested!.subject), suggested!.text);
    // Not held: the other guest may take them.
    const other = availability(s.state, { month: '2027-01', today: TODAY, forEmail: 'other@example.com' });
    assert.equal(other.find((r) => r.night === '2027-01-04')!.status, 'open');
    // The guest sees it, with the dates.
    const row = mine(s.state, await s.since(null), 'guests@example.com', TODAY)[0]!;
    assert.equal(row.status, 'suggested');
    assert.deepEqual(row.suggested, { id: e.id, arrive: '2027-01-03', depart: '2027-01-06' });
  });

  test('suggest checks the dates as a request would, and wants a reason', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    for (const bad of [{ arrive: '2027-01-06', depart: '2027-01-03', why: 'w' }, { arrive: 'soon', depart: '2027-01-03', why: 'w' },
      { arrive: '2026-10-01', depart: '2026-10-03', why: 'w' }, { arrive: '2027-01-03', depart: '2027-01-06', why: '  ' }]) {
      await assert.rejects(suggest(ctx, o.id, bad), (e: unknown) => e instanceof ToolError && e.status === 400, JSON.stringify(bad));
    }
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'open');
    assert.equal(box.sent.length, 0);
  });

  test('accepting a suggestion asks again for those dates, as "you suggested these", once', async () => {
    const { s, ctx } = await setup();
    const o = await ask(asGuest(s), DEC);
    const e = await suggest(ctx, o.id, { arrive: '2027-01-03', depart: '2027-01-06', why: 'December is full' });
    // Another guest cannot take up a suggestion made to someone else.
    await assert.rejects(acceptSuggestion(asGuest(s, OTHER), e.id), says(/no such/, 404));
    const fresh = await acceptSuggestion(asGuest(s), e.id);
    assert.equal(fresh.status, 'open');
    assert.equal(fresh.who, GUEST);
    assert.match(fresh.summary, /^You suggested these: Nguyen family would like to come Jan 3–6, 2027, 3 people/);
    assert.equal(fresh.args['arrive'], '2027-01-03');
    assert.equal(fresh.args['depart'], '2027-01-06');
    await assert.rejects(acceptSuggestion(asGuest(s), e.id), says(/already/, 409));
    assert.equal([...s.state.thread.offers.values()].filter((x) => x.status === 'open').length, 1);
    // And a member approves it with one click.
    await decide(ctx, fresh.id, 'approved');
    assert.equal(s.state.stays.size, 1);
  });

  test('cancel of a request still waiting: withdrawn, its nights open, and the guest sees it cancelled', async () => {
    const { s } = await setup();
    const o = await ask(asGuest(s), DEC);
    await cancelStay(asGuest(s), o.id, 'cannot come');
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'replaced');
    const other = availability(s.state, { month: '2026-12', today: TODAY, forEmail: 'other@example.com' });
    assert.equal(other.find((r) => r.night === '2026-12-13')!.status, 'open');
    assert.equal(mine(s.state, await s.since(null), 'guests@example.com', TODAY)[0]!.status, 'cancelled');
    // Nothing waits on Today for it.
    assert.equal([...s.state.thread.offers.values()].filter((x) => x.status === 'open').length, 0);
  });

  test('cancel of an approved stay: the nights are open at once, and a card waits to take it off the calendar', async () => {
    const { s, ctx } = await setup();
    const o = await ask(asGuest(s), DEC);
    const [, c] = await decide(ctx, o.id, 'approved');
    calls.length = 0;
    await cancelStay(asGuest(s), o.id, 'flights fell through');
    const stay = s.state.stays.get(c!.id)!;
    assert.equal(stay.cancelled, true);
    const other = availability(s.state, { month: '2026-12', today: TODAY, forEmail: 'other@example.com' });
    assert.equal(other.find((r) => r.night === '2026-12-13')!.status, 'open');
    const card = [...s.state.thread.offers.values()].find((x) => x.tool === 'release_stay')!;
    assert.ok(card, 'a release_stay card');
    assert.equal(card.status, 'open');
    assert.equal(card.prompt.kind, 'booking');
    assert.deepEqual(card.args, { stay: c!.id });
    assert.equal(card.who, GUEST, 'raised in the name of who cancelled');
    assert.match(card.summary, /Nguyen family cancelled Dec 12–15/);
    assert.equal(calls.length, 0, 'nothing is deleted until a member says so');
    const written = await decide(ctx, card.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'booking.release']);
    assert.equal(event('delete').length, 1);
    assert.equal(s.state.stays.get(c!.id)!.released, true);
  });

  test('a cancel whose card Today raised first (between the cancel and its own card) is still a cancel, not an error', async () => {
    const { s, ctx } = await setup();
    const o = await ask(asGuest(s), DEC);
    const [, c] = await decide(ctx, o.id, 'approved');
    // Today loads in the gap: the cancel is written, and the member's page asks about it before the guest's card is raised.
    const append = s.append.bind(s);
    let raced = false;
    (s as unknown as { append: typeof s.append }).append = (async (who: string, events: unknown) => {
      const out = await append(who, events as never);
      const list = (Array.isArray(events) ? events : [events]) as { op: string }[];
      if (!raced && list.some((e) => e.op === 'booking.cancel')) { raced = true; await raiseReleaseCards(ctx); }
      return out;
    }) as typeof s.append;
    const e = await cancelStay(asGuest(s), o.id, 'flights fell through');
    assert.ok(raced, 'Today asked first');
    assert.equal(e.op, 'booking.cancel');
    assert.equal(s.state.stays.get(c!.id)!.cancelled, true);
    const releases = [...s.state.thread.offers.values()].filter((x) => x.tool === 'release_stay');
    assert.equal(releases.length, 1, 'one card for the stay');
    assert.equal(releases[0]!.who, GUEST, 'raised in the name of who cancelled');
  });

  test('release_stay from a guest: only as the answer to their own cancel of that stay; never for Claude', async () => {
    const { s, ctx } = await setup();
    const tool = toolByName.get('release_stay')!;
    assert.ok(tool);
    assert.equal(forClaude(tool), false);
    assert.ok(CARD_ONLY.has('release_stay'));
    const o = await ask(asGuest(s), DEC);
    const [, c] = await decide(ctx, o.id, 'approved');
    const stay = c!.id;
    const card = (extra: Record<string, unknown>) => request({ tool: 'release_stay', args: { stay }, ...extra });
    // Before any cancel, with no cancel named, or naming someone else's: refused.
    await assert.rejects(s.append(GUEST, card({})), refused(/prompt\.ref/));
    await assert.rejects(s.append(GUEST, card({ prompt: { kind: 'booking', ref: 'made-up' } })), refused(/a stay they cancelled/));
    const [cancel] = await s.append(GUEST, { op: 'booking.cancel', stay, why: 'cannot come' });
    await assert.rejects(s.append(GUEST, card({ prompt: { kind: 'booking', ref: 'made-up' } })), refused(/a stay they cancelled/));
    await assert.rejects(s.append(OTHER, card({ prompt: { kind: 'booking', ref: cancel!.id } })), refused(/a stay they cancelled/));
    await assert.rejects(s.append(GUEST, card({ prompt: { kind: 'booking', ref: cancel!.id }, args: {} })), refused(/args\.stay/));
    await assert.rejects(s.append(GUEST, card({ prompt: { kind: 'booking', ref: cancel!.id }, events: [{ op: 'member.add', member: 'm', why: 'w' }] })),
      refused(/events/));
    // Answering their own cancel of that stay: admitted, and in their name.
    const [ok] = await s.append(GUEST, card({ prompt: { kind: 'booking', ref: cancel!.id } }));
    assert.equal(s.state.thread.offers.get(ok!.id)!.who, GUEST);
    // One card per stay, from anyone.
    await assert.rejects(s.append('alice', card({ prompt: { kind: 'booking', ref: cancel!.id } })), refused(/already has a card/));
  });

  test('booking.release: a stay that was cancelled, once', async () => {
    const { s } = await setup();
    const [st] = await s.append('alice', confirm('r1'));
    await assert.rejects(s.append('alice', { op: 'booking.release', stay: st!.id }), refused(/not cancelled/));
    await s.append('alice', { op: 'booking.cancel', stay: st!.id, why: 'w' });
    await s.append('alice', { op: 'booking.release', stay: st!.id });
    await assert.rejects(s.append('alice', { op: 'booking.release', stay: st!.id }), refused(/already/));
    await assert.rejects(s.append('alice', { op: 'booking.release', stay: 'nope' }), refused(/no such stay/));
  });

  test('a cancel whose card never landed is asked about as Today loads, once', async () => {
    const { s, ctx } = await setup();
    const o = await ask(asGuest(s), DEC);
    const [, c] = await decide(ctx, o.id, 'approved');
    // Written by hand: the cancel, and no card.
    await s.append(GUEST, { op: 'booking.cancel', stay: c!.id, why: 'cannot come' });
    const releases = () => [...s.state.thread.offers.values()].filter((x) => x.tool === 'release_stay');
    assert.equal(releases().length, 0);
    await raiseReleaseCards(ctx);
    assert.equal(releases().length, 1);
    assert.equal(releases()[0]!.who, GUEST, 'in the name of who cancelled');
    await raiseReleaseCards(ctx);
    assert.equal(releases().length, 1);
    // Decided, it is not asked again either.
    await decide(ctx, releases()[0]!.id, 'declined', 'leave it there');
    await raiseReleaseCards(ctx);
    assert.equal(releases().length, 1);
    // A guest since taken off the list: the member looking raises it.
    const p = await ask(asGuest(s), { ...DEC, arrive: '2027-03-01', depart: '2027-03-03' });
    const [, c2] = await decide(ctx, p.id, 'approved');
    await s.append(GUEST, { op: 'booking.cancel', stay: c2!.id, why: 'w' });
    await s.append('alice', { op: 'guest.revoke', email: 'guests@example.com', why: 'moved away' });
    await raiseReleaseCards(ctx);
    const second = releases().find((x) => x.args['stay'] === c2!.id)!;
    assert.equal(second.who, 'alice');
  });

  test('change: the old one cancelled, a new request open, "Changed from" the old dates', async () => {
    const { s } = await setup();
    const o = await ask(asGuest(s), DEC);
    // Overlapping its own nights is fine: they are the ones being given up.
    const fresh = await changeStay(asGuest(s), o.id, { arrive: '2026-12-13', depart: '2026-12-17', headcount: 2, note: 'a day later' });
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'replaced');
    assert.equal(fresh.status, 'open');
    assert.match(fresh.summary, /^Changed from Dec 12–15: Nguyen family would like to come Dec 13–17, 2 people: “a day later”/);
    const rows = mine(s.state, await s.since(null), 'guests@example.com', TODAY);
    assert.deepEqual(rows.map((r) => [r.arrive, r.status]), [['2026-12-12', 'cancelled'], ['2026-12-13', 'pending']]);
  });

  test('change onto another guest\'s nights: taken, and nothing is cancelled', async () => {
    const { s } = await setup();
    const o = await ask(asGuest(s), DEC);
    await ask(asGuest(s, OTHER), { ...DEC, arrive: '2027-01-10', depart: '2027-01-12' });
    const n = await count(s);
    await assert.rejects(changeStay(asGuest(s), o.id, { ...DEC, arrive: '2027-01-11', depart: '2027-01-13' }), says(/taken/, 409));
    assert.equal(await count(s), n);
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'open');
  });

  /** A confirmed stay of the guest's, Dec 12–15, and its booking.confirm. */
  async function stayed(s: Store, ctx: ToolContext) {
    const o = await ask(asGuest(s), DEC);
    const [, c] = await decide(ctx, o.id, 'approved');
    calls.length = 0;
    order.length = 0;
    return { o, c: c as Extract<Event, { op: 'booking.confirm' }> };
  }
  const LATER = { arrive: '2026-12-14', depart: '2026-12-18', headcount: 3, note: '' };

  test('change of an approved stay: the stay stands and holds its nights; a card that replaces it waits, "Changed from"', async () => {
    const { s, ctx } = await setup();
    const { o, c } = await stayed(s, ctx);
    const n = await count(s);
    const fresh = await changeStay(asGuest(s), c.id, LATER);
    assert.equal(await count(s), n + 1, 'one line: the card');
    const st = s.state.stays.get(c.id)!;
    assert.equal(st.cancelled, false);
    assert.equal(fresh.status, 'open');
    assert.equal(fresh.args['replacesStay'], c.id);
    assert.match(fresh.summary, /^Changed from Dec 12–15: Nguyen family would like to come Dec 14–18, 3 people/);
    assert.ok(fresh.effects.some((x) => /Dec 12–15 comes off the Household calendar/.test(x)), fresh.effects.join('; '));
    assert.ok(![...s.state.thread.offers.values()].some((x) => x.tool === 'release_stay'), 'nothing to release: the stay stands');
    assert.equal(calls.length, 0, 'nothing on the NAS until a member decides');
    // Another guest finds both the old nights and the new ones taken.
    const other = availability(s.state, { month: '2026-12', today: TODAY, forEmail: 'other@example.com' });
    for (const night of ['2026-12-12', '2026-12-13', '2026-12-16', '2026-12-17']) {
      assert.equal(other.find((r) => r.night === night)!.status, 'taken', night);
    }
    await assert.rejects(ask(asGuest(s, OTHER), { ...DEC, arrive: '2026-12-12', depart: '2026-12-13' }), says(/taken/, 409));
    // The guest's page: the stay approved, the change waiting, saying what it replaces.
    const rows = mine(s.state, await s.since(null), 'guests@example.com', TODAY);
    assert.deepEqual(rows.map((r) => [r.id, r.status, r.replaces]), [[o.id, 'approved', undefined], [fresh.id, 'pending', c.id]]);
    // One change at a time.
    await assert.rejects(changeStay(asGuest(s), c.id, { ...LATER, arrive: '2026-12-20', depart: '2026-12-22' }),
      says(/already asked to change/, 409));
  });

  test('approving the change: one event made, one mail saying the old dates are replaced, one write, then the old event off', async () => {
    const { s, ctx, box } = await setup();
    const { c } = await stayed(s, ctx);
    const fresh = await changeStay(asGuest(s), c.id, LATER);
    box.sent.length = 0;
    const n = await count(s);
    let atDelete = -1;
    box.onSend = () => { atDelete = event('delete').length; };
    const written = await decide(ctx, fresh.id, 'approved');
    assert.deepEqual(order, ['dsm:create', 'mail', 'dsm:delete']);
    assert.equal(atDelete, 0, 'the old event is still there when the mail goes');
    assert.equal(event('create').length, 1);
    assert.equal(event('delete').length, 1);
    assert.equal(box.sent.length, 1);
    assert.equal(await count(s), n + 2, 'one write: the decision and the stay');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'booking.confirm']);
    const conf = written[1] as Extract<Event, { op: 'booking.confirm' }>;
    assert.equal(conf.replaces, c.id);
    assert.deepEqual([conf.arrive, conf.depart], ['2026-12-14', '2026-12-18']);
    const old = s.state.stays.get(c.id)!;
    assert.equal(old.replacedBy, conf.id);
    assert.equal(old.cancelled, true, 'it holds no nights');
    assert.equal(s.state.stays.get(conf.id)!.cancelled, false);
    const m = box.sent[0]!;
    assert.match(m.subject, /Dec 14–18/);
    assert.match(m.text, /replaces your stay on Dec 12–15/);
    // The old event is off the NAS; the new one is there.
    await assert.rejects(getEvent(ctx.sid!, { evt_id: c.evt_id, cal_id: c.cal_id, original_cal_id: c.original_cal_id }, via));
    assert.equal((await getEvent(ctx.sid!, { evt_id: conf.evt_id, cal_id: conf.cal_id, original_cal_id: conf.original_cal_id }, via)).summary,
      'Nguyen family staying (3)');
    // Nights the old stay alone had are open again; nothing is left for a member to release.
    const other = availability(s.state, { month: '2026-12', today: TODAY, forEmail: 'other@example.com' });
    assert.equal(other.find((r) => r.night === '2026-12-12')!.status, 'open');
    assert.equal(other.find((r) => r.night === '2026-12-15')!.status, 'taken');
    assert.deepEqual(await raiseReleaseCards(ctx), []);
    // The guest sees one stay, the new one.
    const rows = mine(s.state, await s.since(null), 'guests@example.com', TODAY);
    assert.deepEqual(rows.map((r) => [r.arrive, r.status]), [['2026-12-14', 'approved']]);
  });

  test('the old event already gone (9009) is what was wanted: the change is approved, quietly', async () => {
    const { s, ctx } = await setup();
    const { c } = await stayed(s, ctx);
    const fresh = await changeStay(asGuest(s), c.id, LATER);
    failDelete = true;
    deleteCode = 9009;
    const written = await decide(ctx, fresh.id, 'approved');
    assert.deepEqual(written.map((e) => e.op), ['proposal.decide', 'booking.confirm']);
    assert.ok(s.state.stays.get(c.id)!.replacedBy);
  });

  test('an old event that will not come off is named, in the log and to the member, and the change stands', async () => {
    const { s, ctx } = await setup();
    const { c } = await stayed(s, ctx);
    const fresh = await changeStay(asGuest(s), c.id, LATER);
    failDelete = true;
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')); };
    let err: unknown;
    try { await decide(ctx, fresh.id, 'approved'); } catch (e) { err = e; } finally { console.warn = warn; }
    assert.ok(err instanceof ToolError && err.status === 502, String(err));
    assert.match((err as Error).message, /approved, and Nguyen family is told/);
    assert.match((err as Error).message, /"Nguyen family staying \(3\)" \(Dec 12–15\), could not be taken off the Household calendar: delete it there by hand/);
    const lines = warned.filter((l) => l.startsWith('[booking]'));
    assert.equal(lines.length, 1, warned.join('\n'));
    assert.match(lines[0]!, new RegExp(`evt_id ${c.evt_id} on /alice/`));
    // The decision is written: the new stay is the guest's, the old one replaced.
    assert.equal(s.state.thread.offers.get(fresh.id)!.status, 'approved');
    assert.equal(s.state.stays.get(c.id)!.replacedBy !== undefined, true);
  });

  test('declining the change: the old stay stands, its event stays, and the guest is told it stands', async () => {
    const { s, ctx, box } = await setup();
    const { c } = await stayed(s, ctx);
    const fresh = await changeStay(asGuest(s), c.id, LATER);
    box.sent.length = 0;
    await decide(ctx, fresh.id, 'declined', 'we have family then');
    assert.equal(calls.length, 0);
    assert.equal(s.state.stays.get(c.id)!.cancelled, false);
    assert.equal(s.state.thread.offers.get(fresh.id)!.status, 'declined');
    assert.equal(box.sent.length, 1);
    assert.match(box.sent[0]!.text, /your stay on Dec 12–15 stands/i);
    assert.match(box.sent[0]!.text, /we have family then/);
    const rows = mine(s.state, await s.since(null), 'guests@example.com', TODAY);
    assert.deepEqual(rows.map((r) => r.status), ['approved', 'declined']);
  });

  test('a change onto nights another guest holds: taken, and nothing is written', async () => {
    const { s, ctx } = await setup();
    const { c } = await stayed(s, ctx);
    await ask(asGuest(s, OTHER), { ...DEC, arrive: '2027-01-10', depart: '2027-01-12' });
    const n = await count(s);
    await assert.rejects(changeStay(asGuest(s), c.id, { ...DEC, arrive: '2027-01-11', depart: '2027-01-13' }), says(/taken/, 409));
    assert.equal(await count(s), n);
    assert.equal(s.state.stays.get(c.id)!.cancelled, false);
  });

  test('cancelling the stay while its change waits takes the change with it', async () => {
    const { s, ctx } = await setup();
    const { c } = await stayed(s, ctx);
    const fresh = await changeStay(asGuest(s), c.id, LATER);
    await cancelStay(asGuest(s), c.id, 'withdrawn by the guest');
    assert.equal(s.state.stays.get(c.id)!.cancelled, true);
    assert.equal(s.state.thread.offers.get(fresh.id)!.status, 'replaced');
    // Withdrawing only the change leaves the stay, in another household of events.
    const again = await setup();
    const st = await stayed(again.s, again.ctx);
    const ch = await changeStay(asGuest(again.s), st.c.id, LATER);
    await cancelStay(asGuest(again.s), ch.id, 'withdrawn by the guest');
    assert.equal(again.s.state.stays.get(st.c.id)!.cancelled, false);
    assert.equal(again.s.state.thread.offers.get(ch.id)!.status, 'replaced');
  });

  test('the fold: a change replaces only a stay of the guest\'s own that stands, and a confirm replaces only that', async () => {
    const { s, ctx } = await setup();
    const { c } = await stayed(s, ctx);
    const theirs = await ask(asGuest(s, OTHER), { ...DEC, arrive: '2027-03-01', depart: '2027-03-03' });
    const [, oc] = await decide(ctx, theirs.id, 'approved');
    const card = (replacesStay: unknown) => request({ args: { ...ARGS, arrive: '2027-05-01', depart: '2027-05-03', replacesStay } });
    await assert.rejects(s.append(GUEST, card(oc!.id)), refused(/replacesStay/));
    await assert.rejects(s.append(GUEST, card('nope')), refused(/replacesStay/));
    await assert.rejects(s.append(GUEST, card(5)), refused(/replacesStay/));
    const confirmReplacing = (replaces: string, email = 'guests@example.com') =>
      confirm('r-new', { email, arrive: '2027-06-01', depart: '2027-06-03', evt_id: 77, replaces });
    await assert.rejects(s.append('alice', confirmReplacing(oc!.id)), refused(/replaces/));
    await assert.rejects(s.append('alice', confirmReplacing('nope')), refused(/replaces/));
    await s.append('alice', confirmReplacing(c.id));
    assert.ok(s.state.stays.get(c.id)!.replacedBy);
    await assert.rejects(s.append('alice', confirmReplacing(c.id)), refused(/replaces/));
  });

  test('mail refused and the event cannot be deleted: the log names it, the member is told to delete it, the card stays', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    box.fail = '550 5.1.1 <guests@example.com>: Recipient address rejected';
    failDelete = true;
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')); };
    let err: unknown;
    try { await decide(ctx, o.id, 'approved'); } catch (e) { err = e; } finally { console.warn = warn; }
    assert.ok(err instanceof ToolError && err.status === 502, String(err));
    const message = (err as Error).message;
    assert.match(message, /could not be taken back off the Household calendar: delete it there by hand/);
    assert.match(message, /"Nguyen family staying \(3\)"/);
    assert.match(message, /550 5\.1\.1/);
    assert.doesNotMatch(message, /off the calendar again/);
    const made = event('create').length;
    assert.equal(made, 1);
    const lines = warned.filter((l) => l.startsWith('[booking]'));
    assert.equal(lines.length, 1, warned.join('\n'));
    assert.match(lines[0]!, /evt_id \d+ on \/alice\//);
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'open');
    assert.equal(s.state.stays.size, 0);
  });

  test('a guest withdrawing while a member approves: asked to try again; after, the stay is theirs to cancel', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    let release!: () => void;
    box.gate = new Promise<void>((r) => { release = r; });
    let handed!: () => void;
    const atMail = new Promise<void>((r) => { handed = r; });
    box.onSend = () => handed();
    const approving = decide(ctx, o.id, 'approved');
    await atMail; // the event is made and the mail is on its way
    const n = await count(s);
    await assert.rejects(cancelStay(asGuest(s), o.id, 'changed our minds'), says(/being decided right now: try again/, 409));
    await assert.rejects(changeStay(asGuest(s), o.id, { ...DEC, arrive: '2027-01-10', depart: '2027-01-12' }), says(/being decided/, 409));
    assert.equal(await count(s), n, 'no booking.cancel written');
    release();
    await approving;
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'approved');
    box.gate = null;
    box.onSend = null;
    await cancelStay(asGuest(s), o.id, 'changed our minds');
    assert.equal([...s.state.stays.values()][0]!.cancelled, true);
    assert.ok([...s.state.thread.offers.values()].some((x) => x.tool === 'release_stay' && x.status === 'open'));
  });

  test('another guest\'s request while it is being decided is not found (404), never "being decided": nothing is told about it', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    let release!: () => void;
    box.gate = new Promise<void>((r) => { release = r; });
    let handed!: () => void;
    const atMail = new Promise<void>((r) => { handed = r; });
    box.onSend = () => handed();
    const approving = decide(ctx, o.id, 'approved');
    await atMail;
    await assert.rejects(cancelStay(asGuest(s, OTHER), o.id, 'w'), says(/no such request/, 404));
    await assert.rejects(changeStay(asGuest(s, OTHER), o.id, { ...DEC, arrive: '2027-01-10', depart: '2027-01-12' }), says(/no such request/, 404));
    await assert.rejects(cancelStay(asGuest(s, OTHER), 'nope', 'w'), says(/no such request/, 404));
    // Their own, meanwhile, is "being decided".
    await assert.rejects(cancelStay(asGuest(s), o.id, 'w'), says(/being decided/, 409));
    release();
    await approving;
  });

  test('a guest withdrawing while a member declines (its mail on the way): asked to try again too', async () => {
    const { s, ctx, box } = await setup();
    const o = await ask(asGuest(s), DEC);
    let release!: () => void;
    box.gate = new Promise<void>((r) => { release = r; });
    let handed!: () => void;
    const atMail = new Promise<void>((r) => { handed = r; });
    box.onSend = () => handed();
    const declining = decide(ctx, o.id, 'declined', 'away');
    await atMail;
    await assert.rejects(cancelStay(asGuest(s), o.id, 'w'), says(/being decided right now/, 409));
    release();
    await declining;
    assert.equal(s.state.thread.offers.get(o.id)!.status, 'declined');
  });

  test('bob, who did not make the Household calendar, approves and later takes a cancelled stay off it', async () => {
    const { s, ctx, box } = await setup('bob');
    const o = await ask(asGuest(s), DEC);
    const [d, c] = await decide(ctx, o.id, 'approved');
    assert.equal(d!.who, 'bob');
    const conf = c as Extract<Event, { op: 'booking.confirm' }>;
    assert.equal(box.sent.length, 1);
    // On the NAS as bob sees it, by the ids it answered him with.
    const onNas = await getEvent(ctx.sid!, { evt_id: conf.evt_id, cal_id: conf.cal_id, original_cal_id: conf.original_cal_id }, via);
    assert.equal(onNas.summary, 'Nguyen family staying (3)');
    await cancelStay(asGuest(s), o.id, 'w');
    const card = [...s.state.thread.offers.values()].find((x) => x.tool === 'release_stay')!;
    calls.length = 0;
    await decide(ctx, card.id, 'approved');
    assert.equal(event('delete').length, 1);
    assert.equal(s.state.stays.get(conf.id)!.released, true);
    await assert.rejects(getEvent(ctx.sid!, { evt_id: conf.evt_id, cal_id: conf.cal_id, original_cal_id: conf.original_cal_id }, via));
  });

  test('restore: scope bookings carries the confirm, cancel, release and suggest', async () => {
    const { s, ctx } = await setup();
    const o = await ask(asGuest(s), DEC);
    await decide(ctx, o.id, 'approved');
    await cancelStay(asGuest(s), o.id, 'w');
    const card = [...s.state.thread.offers.values()].find((x) => x.tool === 'release_stay')!;
    await decide(ctx, card.id, 'approved');
    const p = await ask(asGuest(s), { ...DEC, arrive: '2027-02-01', depart: '2027-02-03' });
    await suggest(ctx, p.id, { arrive: '2027-02-10', depart: '2027-02-12', why: 'w' });
    const all = await s.since(null);
    for (const op of ['booking.confirm', 'booking.cancel', 'booking.release', 'booking.suggest']) {
      const e = all.find((x) => x.op === op)!;
      assert.ok(e, op);
      assert.equal(scopeOf(e), 'bookings', op);
    }
    // And the whole log replays to the same stays.
    assert.deepEqual([...replay(all).stays], [...s.state.stays]);
  });

  test('restore of bookings alone: the preview names what it needs (the conversation for requests withdrawn) instead of failing in the fold', async () => {
    const { s, ctx } = await setup();
    await s.append('alice', { op: 'guests.arrival', text: 'Gate code 4471' });
    const o = await ask(asGuest(s), DEC);
    await decide(ctx, o.id, 'approved');
    const w = await ask(asGuest(s), { ...DEC, arrive: '2027-02-01', depart: '2027-02-03' });
    await cancelStay(asGuest(s), w.id, 'withdrawn by the guest');
    const backup = parseBackup((await s.since(null)).map((e) => JSON.stringify(e)).join('\n'));
    const target = await fresh();

    const alone = planRestore(target.state, backup, ['bookings']);
    assert.ok(alone.missingPrerequisites.some((m) => /withdrawn request.*needs its card.*conversation.*in the backup but not selected/.test(m)),
      alone.missingPrerequisites.join('\n'));
    assert.ok(alone.summary.some((m) => /arrival note.*Settings.*not selected/.test(m)), alone.summary.join('\n'));
    assert.throws(() => eventsToApply(alone), /missing prerequisite/);

    const talk = planRestore(target.state, backup, ['thread']);
    assert.ok(talk.missingPrerequisites.some((m) => /guests@example\.com.*guest list.*bookings.*in the backup but not selected/.test(m)),
      talk.missingPrerequisites.join('\n'));

    // Both, and the settings: clean, and taken into a household that has neither.
    const both = planRestore(target.state, backup, ['bookings', 'thread', 'settings']);
    assert.deepEqual(both.missingPrerequisites, []);
    assert.deepEqual(both.collisions, []);
    await target.adopt(eventsToApply(both));
    assert.deepEqual([...target.state.stays], [...s.state.stays]);
    assert.equal(target.state.settings.arrival, 'Gate code 4471');
    assert.equal(target.state.thread.offers.get(w.id)!.status, 'replaced');
  });

  test('restore: a stay changed and approved carries its replaces, and replays to the same stays', async () => {
    const { s, ctx } = await setup();
    const { c } = await stayed(s, ctx);
    const fresh = await changeStay(asGuest(s), c.id, LATER);
    await decide(ctx, fresh.id, 'approved');
    const all = await s.since(null);
    const parsed = parseBackup(all.map((e) => JSON.stringify(e)).join('\n'));
    const conf = parsed.events.find((e) => e.op === 'booking.confirm' && e.replaces !== undefined) as Extract<Event, { op: 'booking.confirm' }>;
    assert.equal(conf.replaces, c.id);
    assert.equal(scopeOf(conf), 'bookings');
    const replayed = replay(parsed.events);
    assert.equal(replayed.stays.get(c.id)!.replacedBy, conf.id);
    assert.deepEqual([...replayed.stays], [...s.state.stays]);
  });
});
