// api/test/guest-ask.test.ts
//
// 0.11.0: someone not on the guest list asks, from the booking page, to be
// put on it. The request is the app's line (`system`), never the asker's: an
// address typed on a public page proves nothing. It waits on Today for any
// member, for 30 days at most; one member's Add puts them on the list and
// sends one email with a plain link to the booking page, a Decline says
// nothing to anyone outside.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { answerGuestAsk, askToBeAdded } from '../src/booking.ts';
import { Households } from '../src/households.ts';
import { laneOf } from '../src/lanes.ts';
import { MailError } from '../src/mail.ts';
import type { Mail, SmtpConfig } from '../src/mail.ts';
import { waiting } from '../src/offers.ts';
import { replay, ReplayError, needsMember } from '../src/replay.ts';
import { eventsToApply, parseBackup, planRestore, scopeOf } from '../src/restore.ts';
import { Store } from '../src/store.ts';
import { build, thread } from '../src/thread.ts';
import { describe as describeEvent, ProposalStore } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { ToolError } from '../src/errors.ts';
import { ASK_DAYS, openAsks, SYSTEM } from '../src/types.ts';
import type { Event } from '../src/types.ts';

const NOW = '2026-11-18T17:00:00.000Z';
const TODAY = '2026-11-18';
const SMTP: SmtpConfig = { host: 'mail.example.com', port: 587, user: 'robot', pass: 'pw', from: 'house@example.com' };
const SAM = { email: 'sam@example.com', name: 'Sam Rivera', how: "Alex's college roommate" };

/** A household of alice (owner) and bob, in UTC. */
async function fresh(now = NOW): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-guest-ask-')), 'events.jsonl');
  const s = new Store({ path, now: () => new Date(now) });
  await s.load();
  await s.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'member.add', member: 'bob', why: 'my partner' },
    { op: 'household.zone', zone: 'UTC' },
  ]);
  return s;
}

const refused = (re: RegExp) => (e: unknown) => e instanceof ReplayError && re.test(e.message);
const toolRefused = (status: number, re: RegExp) => (e: unknown) => e instanceof ToolError && e.status === status && re.test(e.message);

/** A member's context, with booking's mail on it as the server puts it there while booking is on here. */
function member(store: Store, who: string, sent: Mail[], o: { fail?: boolean; mail?: false; today?: string } = {}): ToolContext {
  return {
    store, who, today: o.today ?? TODAY, proposals: new ProposalStore(), sid: null,
    ...(o.mail === false ? {} : {
      mail: {
        smtp: SMTP, url: 'https://planner.example.com',
        send: async (_cfg: SmtpConfig, m: Mail) => {
          if (o.fail) throw new MailError('550 mailbox unavailable');
          sent.push(m);
        },
      },
    }),
  };
}

let ipSeq = 0;
/** A fresh client address per call, so the per-address limit is the only one in play unless a test says otherwise. */
const nextIp = () => `198.51.100.${++ipSeq}`;
/**
 * The limits' clock: two days on before every test, so the limits (memory, for the whole process) are each test's
 * own. The household's day, and the time on the lines, are NOW's.
 */
let clock = Date.parse(NOW);
beforeEach(() => { clock += 2 * 86_400_000; });
const ask = (store: Store, body: Record<string, unknown>, ip = nextIp(), today = TODAY) =>
  askToBeAdded({ store, now: () => clock, ip, today }, body);

const asks = (s: Store) => s.since(null).then((all) => all.filter((e) => e.op === 'guest.ask'));

// ─── the fold ─────────────────────────────────────────────────────────────────

describe('a request to be a guest, in the log', () => {
  test('written by system, it opens a request keyed by the address', async () => {
    const s = await fresh();
    await s.append(SYSTEM, { op: 'guest.ask', email: 'Sam@Example.com ', name: ' Sam Rivera ', how: SAM.how });
    const a = s.state.guestAsks.get('sam@example.com');
    assert.ok(a);
    assert.equal(a.name, 'Sam Rivera');
    assert.equal(a.how, SAM.how);
    assert.equal(a.answer, null);
    assert.deepEqual(openAsks(s.state, TODAY).map((x) => x.email), ['sam@example.com']);
  });

  test('nobody else writes one: not a member, not a guest, not Claude', async () => {
    const s = await fresh();
    await s.append('alice', { op: 'guest.allow', email: 'g@example.com', name: 'G', why: 'friends' });
    for (const who of ['alice', 'guest:g@example.com', 'claude']) {
      await assert.rejects(s.append(who, { op: 'guest.ask', ...SAM }), (e: unknown) => e instanceof ReplayError, who);
    }
  });

  test('a line of the wrong shape is refused by name', async () => {
    const s = await fresh();
    await assert.rejects(s.append(SYSTEM, { op: 'guest.ask', ...SAM, email: 'not an address' }), refused(/email address/));
    await assert.rejects(s.append(SYSTEM, { op: 'guest.ask', ...SAM, name: '  ' }), refused(/name/));
    await assert.rejects(s.append(SYSTEM, { op: 'guest.ask', ...SAM, name: 'x'.repeat(61) }), refused(/60/));
    await assert.rejects(s.append(SYSTEM, { op: 'guest.ask', ...SAM, how: '' }), refused(/how/));
    await assert.rejects(s.append(SYSTEM, { op: 'guest.ask', ...SAM, how: 'x'.repeat(121) }), refused(/120/));
    await s.append(SYSTEM, { op: 'guest.ask', ...SAM, name: 'x'.repeat(60), how: 'y'.repeat(120) });
  });

  test('someone already on the list is not asked for again', async () => {
    const s = await fresh();
    await s.append('alice', { op: 'guest.allow', email: SAM.email, name: 'Sam', why: 'friends' });
    await assert.rejects(s.append(SYSTEM, { op: 'guest.ask', ...SAM }), refused(/already on the list/));
  });

  test('putting them on the list closes the request, as added by whoever did', async () => {
    const s = await fresh();
    await s.append(SYSTEM, { op: 'guest.ask', ...SAM });
    await s.append('bob', { op: 'guest.allow', email: SAM.email, name: SAM.name, why: SAM.how });
    assert.equal(s.state.guestAsks.get(SAM.email)?.answer?.kind, 'added');
    assert.equal(s.state.guestAsks.get(SAM.email)?.answer?.by, 'bob');
    assert.deepEqual(openAsks(s.state, TODAY), []);
  });

  test('a member declines it; only a waiting request can be declined, and only by a member', async () => {
    const s = await fresh();
    await assert.rejects(s.append('alice', { op: 'guest.ask.decline', email: SAM.email }), refused(/no longer waiting/));
    await s.append(SYSTEM, { op: 'guest.ask', ...SAM });
    await assert.rejects(s.append(SYSTEM, { op: 'guest.ask.decline', email: SAM.email }), refused(/not a member/));
    await assert.rejects(s.append('claude', { op: 'guest.ask.decline', email: SAM.email }), (e: unknown) => e instanceof ReplayError);
    await s.append('alice', { op: 'guest.ask.decline', email: SAM.email });
    assert.deepEqual(s.state.guestAsks.get(SAM.email)?.answer?.kind, 'declined');
    await assert.rejects(s.append('bob', { op: 'guest.ask.decline', email: SAM.email }), refused(/no longer waiting/));
  });

  test('asking again after a decline opens a new request', async () => {
    const s = await fresh();
    const [first] = await s.append(SYSTEM, { op: 'guest.ask', ...SAM });
    await s.append('alice', { op: 'guest.ask.decline', email: SAM.email });
    const [again] = await s.append(SYSTEM, { op: 'guest.ask', ...SAM, how: 'We met at the reunion' });
    const a = s.state.guestAsks.get(SAM.email)!;
    assert.notEqual(first!.id, again!.id);
    assert.equal(a.id, again!.id);
    assert.equal(a.answer, null);
    assert.equal(a.how, 'We met at the reunion');
  });

  test(`a request nobody answers stops waiting after ${ASK_DAYS} days, by the household's day; no line is needed`, async () => {
    const s = await fresh();
    await s.append(SYSTEM, { op: 'guest.ask', ...SAM });
    assert.equal(ASK_DAYS, 30);
    assert.equal(openAsks(s.state, '2026-12-17').length, 1, 'day 29');
    assert.equal(openAsks(s.state, '2026-12-18').length, 0, 'day 30');
    const events = await s.since(null);
    assert.equal(waiting(s.state, 'alice', events, '2026-12-17').filter((w) => w.kind === 'guest').length, 1);
    assert.equal(waiting(s.state, 'alice', events, '2026-12-18').filter((w) => w.kind === 'guest').length, 0);
  });

  test('it waits on every member', async () => {
    const s = await fresh();
    const [e] = await s.append(SYSTEM, { op: 'guest.ask', ...SAM });
    const events = await s.since(null);
    for (const who of ['alice', 'bob']) {
      const w = waiting(s.state, who, events, TODAY).find((x) => x.kind === 'guest');
      assert.ok(w && w.kind === 'guest', who);
      assert.deepEqual(w.ask, { id: e!.id, at: NOW, email: SAM.email, name: SAM.name, how: SAM.how });
    }
  });
});

// ─── words, lanes and bands ───────────────────────────────────────────────────

describe('a request, in words and in its band', () => {
  test('the record: asked, added, declined', async () => {
    const s = await fresh();
    const [a] = await s.append(SYSTEM, { op: 'guest.ask', ...SAM });
    assert.equal(describeEvent(a!, s.state).what, 'Sam Rivera asked to be a guest');
    assert.equal(describeEvent(a!).what, 'Sam Rivera asked to be a guest');
    const [d] = await s.append('alice', { op: 'guest.ask.decline', email: SAM.email });
    assert.equal(describeEvent(d!, s.state).what, "declined Sam Rivera's request");
    await s.append(SYSTEM, { op: 'guest.ask', ...SAM });
    const [y] = await s.append('bob', { op: 'guest.allow', email: SAM.email, name: SAM.name, why: SAM.how });
    assert.equal(describeEvent(y!, s.state).what, 'added Sam Rivera to the guest list');
  });

  test('on Today: the request is the app\'s line, saying who asked; the answers are the member\'s', async () => {
    const s = await fresh();
    const [a] = await s.append(SYSTEM, { op: 'guest.ask', ...SAM });
    const [d] = await s.append('alice', { op: 'guest.ask.decline', email: SAM.email });
    const rows = build(await s.since(null), s.state, 'bob');
    const asked = rows.find((r) => r.id === a!.id);
    assert.ok(asked && asked.kind === 'change');
    assert.equal(asked.app, true);
    assert.equal(asked.what, 'Sam Rivera asked to be a guest');
    assert.equal(asked.lane, 'calendar');
    const declined = rows.find((r) => r.id === d!.id);
    assert.ok(declined && declined.kind === 'change');
    assert.equal(declined.who, 'alice');
    assert.equal(declined.app, undefined);
  });

  test("Today's waiting list has it, titled as the row says it", async () => {
    const s = await fresh();
    const [a] = await s.append(SYSTEM, { op: 'guest.ask', ...SAM });
    const page = await thread(s, { who: 'bob', today: TODAY });
    const w = page.waiting.find((x) => x.kind === 'guest');
    assert.ok(w);
    assert.equal(w.title, 'Sam Rivera asks to be a guest');
    assert.equal(w.lane, 'calendar');
    assert.equal(w.by, null);
    assert.equal(w.entry, a!.id);
  });

  test('both lines are in the bookings band, the calendar lane, and the request needs no member', () => {
    const at = { id: 'i', at: NOW };
    const asked = { ...at, who: SYSTEM, op: 'guest.ask', ...SAM } as Event;
    const no = { ...at, who: 'alice', op: 'guest.ask.decline', email: SAM.email } as Event;
    assert.equal(scopeOf(asked), 'bookings');
    assert.equal(scopeOf(no), 'bookings');
    assert.equal(laneOf(asked, { pageDrifts: new Map() }), 'calendar');
    assert.equal(laneOf(no, { pageDrifts: new Map() }), 'calendar');
    assert.equal(needsMember(asked), false);
    assert.equal(needsMember(no), true);
  });

  test('a backup brings them back: a waiting request waits again, a declined one stays declined', async () => {
    const src = await fresh();
    await src.append(SYSTEM, { op: 'guest.ask', ...SAM });
    await src.append(SYSTEM, { op: 'guest.ask', email: 'kim@example.com', name: 'Kim', how: 'neighbours' });
    await src.append('alice', { op: 'guest.ask.decline', email: 'kim@example.com' });
    const backup = parseBackup(await readFile(src.path, 'utf8'));
    assert.equal(backup.counts.bookings, 3);
    assert.deepEqual(backup.unknown, []);
    // Into a household of alice's own, with bob in it, the bookings band alone.
    const { store: target } = await new Households(join(await mkdtemp(join(tmpdir(), 'pb-guest-ask-r-')), 'households')).create('alice', 'Here');
    await target.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
    const plan = planRestore(target.state, backup, ['bookings']);
    assert.deepEqual(plan.missingPrerequisites, []);
    assert.deepEqual(plan.collisions, []);
    const after = replay([...(await target.since(null)), ...eventsToApply(plan)]);
    assert.equal(after.guestAsks.get(SAM.email)?.answer, null);
    assert.equal(after.guestAsks.get('kim@example.com')?.answer?.kind, 'declined');
  });
});

// ─── the booking page's door ──────────────────────────────────────────────────

describe('asking, from the booking page', () => {
  test('a new address: one request, written by system', async () => {
    const s = await fresh();
    assert.equal(await ask(s, SAM), undefined);
    const lines = await asks(s);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.who, SYSTEM);
    assert.deepEqual(s.state.guestAsks.get(SAM.email)?.name, SAM.name);
  });

  test('already on the list, already asked, declined before: the same answer, and only the declined one writes again', async () => {
    const s = await fresh();
    await s.append('alice', { op: 'guest.allow', email: 'on@example.com', name: 'On', why: 'friends' });
    await ask(s, { ...SAM, email: 'on@example.com' });
    assert.equal((await asks(s)).length, 0, 'on the list: nothing written');
    await ask(s, SAM);
    await ask(s, { ...SAM, how: 'twice' });
    assert.equal((await asks(s)).length, 1, 'asked already: nothing more written');
    await s.append('alice', { op: 'guest.ask.decline', email: SAM.email });
    await ask(s, SAM);
    assert.equal((await asks(s)).length, 2, 'declined before: a new request');
  });

  test('a request over 30 days old with no answer is asked again', async () => {
    const s = await fresh();
    await ask(s, SAM);
    await ask(s, SAM, nextIp(), '2026-12-18');
    assert.equal((await asks(s)).length, 2);
  });

  test('the fields are checked, in plain words, before anything is counted', async () => {
    const s = await fresh();
    const ip = nextIp();
    await assert.rejects(ask(s, { ...SAM, name: '' }, ip), toolRefused(400, /^give your name$/));
    await assert.rejects(ask(s, { ...SAM, name: 'x'.repeat(61) }, ip), toolRefused(400, /^keep your name under 60 characters$/));
    await assert.rejects(ask(s, { ...SAM, email: 'sam at example' }, ip), toolRefused(400, /^that is not an email address$/));
    await assert.rejects(ask(s, { ...SAM, how: ' ' }, ip), toolRefused(400, /^say how you know them$/));
    await assert.rejects(ask(s, { ...SAM, how: 'x'.repeat(121) }, ip), toolRefused(400, /^keep how you know them under 120 characters$/));
    await assert.rejects(ask(s, { email: SAM.email }, ip), toolRefused(400, /^give your name$/));
    // None of those was counted against the address it came from.
    for (let i = 0; i < 5; i++) await ask(s, { ...SAM, email: `fields${i}@example.com` }, ip);
    assert.equal((await asks(s)).length, 5);
  });

  test('five an hour from one place; the sixth is refused, and writes nothing', async () => {
    const s = await fresh();
    const ip = nextIp();
    for (let i = 0; i < 5; i++) await ask(s, { ...SAM, email: `place${i}@example.com` }, ip);
    await assert.rejects(ask(s, { ...SAM, email: 'place5@example.com' }, ip), toolRefused(429, /too many requests from here/));
    assert.equal((await asks(s)).length, 5);
  });

  test('three a day for one address, from anywhere; the fourth is refused', async () => {
    const s = await fresh();
    for (let i = 0; i < 3; i++) await ask(s, { ...SAM, email: 'busy@example.com' });
    await assert.rejects(ask(s, { ...SAM, email: 'Busy@Example.com' }), toolRefused(429, /too many requests for that address/));
  });
});

// ─── answering, on Today or in Settings ───────────────────────────────────────

describe('answering a request', () => {
  test('Add: on the list, the request closed, and one email with only a plain link to the booking page', async () => {
    const s = await fresh();
    await ask(s, SAM);
    const sent: Mail[] = [];
    const r = await answerGuestAsk(member(s, 'alice', sent), { email: SAM.email, answer: 'add' });
    assert.deepEqual(r, { answer: 'added', email: SAM.email, name: SAM.name, mailed: true });
    assert.deepEqual(s.state.guests.get(SAM.email), { name: SAM.name, why: SAM.how, allowedBy: 'alice', at: NOW });
    assert.equal(s.state.guestAsks.get(SAM.email)?.answer?.kind, 'added');
    assert.equal(sent.length, 1);
    const m = sent[0]!;
    assert.equal(m.to, SAM.email);
    assert.equal(m.subject, "You're on the list");
    assert.ok(m.text.includes('https://planner.example.com/book\n'), m.text);
    assert.ok(m.text.includes('Send me a link'), m.text);
    assert.doesNotMatch(m.text, /\/book\/open|token|\d{6}/);
    assert.deepEqual(m.text.match(/https?:\/\/\S+/g), ['https://planner.example.com/book']);
  });

  test('a mail that fails, or no mail set up: still added, and said so', async () => {
    const s = await fresh();
    await ask(s, SAM);
    await ask(s, { ...SAM, email: 'kim@example.com', name: 'Kim' });
    const warn = console.warn;
    const said: string[] = [];
    console.warn = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
    try {
      const failed = await answerGuestAsk(member(s, 'alice', [], { fail: true }), { email: SAM.email, answer: 'add' });
      assert.deepEqual(failed, { answer: 'added', email: SAM.email, name: SAM.name, mailed: false });
    } finally { console.warn = warn; }
    assert.ok(s.state.guests.has(SAM.email));
    // The log line says it failed, never to whom or what it said.
    assert.equal(said.length, 1);
    assert.doesNotMatch(said[0]!, /sam@example\.com|Sam Rivera|planner\.example\.com|pw/);
    const none = await answerGuestAsk(member(s, 'bob', [], { mail: false }), { email: 'kim@example.com', answer: 'add' });
    assert.deepEqual(none, { answer: 'added', email: 'kim@example.com', name: 'Kim', mailed: false });
    assert.ok(s.state.guests.has('kim@example.com'));
  });

  test('Decline: closed, not added, and nothing sent', async () => {
    const s = await fresh();
    await ask(s, SAM);
    const sent: Mail[] = [];
    const r = await answerGuestAsk(member(s, 'bob', sent), { email: SAM.email, answer: 'decline' });
    assert.deepEqual(r, { answer: 'declined', email: SAM.email, name: SAM.name });
    assert.equal(s.state.guests.has(SAM.email), false);
    assert.equal(s.state.guestAsks.get(SAM.email)?.answer?.kind, 'declined');
    assert.equal(sent.length, 0);
  });

  test('whoever answers first settles it; the other is told who did', async () => {
    const s = await fresh();
    await ask(s, SAM);
    const sent: Mail[] = [];
    const [one, two] = await Promise.allSettled([
      answerGuestAsk(member(s, 'alice', sent), { email: SAM.email, answer: 'add' }),
      answerGuestAsk(member(s, 'bob', sent), { email: SAM.email, answer: 'decline' }),
    ]);
    assert.equal(one.status, 'fulfilled');
    assert.equal(two.status, 'rejected');
    assert.ok(toolRefused(409, /^already answered by alice$/)((two as PromiseRejectedResult).reason));
    assert.equal(sent.length, 1, 'one email, from the one answer that counted');
    await assert.rejects(answerGuestAsk(member(s, 'alice', sent), { email: SAM.email, answer: 'decline' }), toolRefused(409, /^you already answered it$/));
  });

  test('added by hand meanwhile: answered by whoever added them', async () => {
    const s = await fresh();
    await ask(s, SAM);
    await s.append('bob', { op: 'guest.allow', email: SAM.email, name: 'Sam', why: 'met at the reunion' });
    await assert.rejects(answerGuestAsk(member(s, 'alice', []), { email: SAM.email, answer: 'add' }), toolRefused(409, /already answered by bob/));
  });

  test('no such request, an old one, or an answer that is neither: refused', async () => {
    const s = await fresh();
    await assert.rejects(answerGuestAsk(member(s, 'alice', []), { email: SAM.email, answer: 'add' }), toolRefused(404, /no such request/));
    await ask(s, SAM);
    await assert.rejects(answerGuestAsk(member(s, 'alice', []), { email: SAM.email, answer: 'maybe' }), toolRefused(400, /add or decline/));
    await assert.rejects(answerGuestAsk(member(s, 'alice', [], { today: '2026-12-18' }), { email: SAM.email, answer: 'add' }),
      toolRefused(409, /30 days/));
    assert.equal(s.state.guests.has(SAM.email), false);
  });
});
