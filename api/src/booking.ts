/**
 * Friends asking to come and stay.
 *
 * The one part of the app with a different audience: people with no account
 * on the NAS, reaching `/book` through the owner's reverse proxy. So it is off
 * until everything it needs is said — where the page is publicly and how to
 * send mail (This NAS, else the deployment), and which household friends
 * book with (its owner's switch in Settings, one household at a time) — and a
 * member is told which of those is missing. A guest is never told anything.
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { emailKey, isDay, isEmail, isGuest, MONTHS_SHORT, zoneOf } from './types.ts';
import type { Actor, Day, Event, EventId, Offer, State, Stay } from './types.ts';
import { ToolError } from './errors.ts';
import { Limiter } from './limiter.ts';
import { MailError, sendMail } from './mail.ts';
import type { Mail, SmtpConfig } from './mail.ts';
import { decide, offer, oneAtATime } from './offers.ts';
import { guestEmail } from './replay.ts';
import { makeEvent, midnight } from './calendar.ts';
import { ensureHouseholdCalendar } from './settings.ts';
import { currentTest, lastSavedBy } from './connectors.ts';
import { SynologyError, deleteEvent, requireSid } from './synology.ts';
import type { DsmFetch } from './synology.ts';
import type { NewEvent, Store } from './store.ts';
import { ProposalStore } from './tools.ts';
import type { ToolContext } from './tools.ts';

export interface BookingConfig {
  /** The public origin, from `BOOK_URL`. Links are built from this, never from a request's Host. */
  url: string;
  /** The one household that may be booked: the one whose owner turned booking on (bookingHousehold). */
  household: string;
  smtp: SmtpConfig;
}

/** What booking needs from the NAS's side, in the order a missing one is named. */
const NEEDED = ['BOOK_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;

/** Why booking is off when BOOK_URL is plain HTTP and nothing says this is the LAN. */
const HTTPS_ONLY = 'BOOK_URL must be https:// (http:// only with COOKIE_INSECURE=1)';

/**
 * BOOK_URL as an origin, or why it cannot be one. An origin and nothing else:
 * the links in every email are built on it, and a path, a query or a login in
 * it would end up in each of them. https, unless COOKIE_INSECURE=1 says this
 * is plain HTTP on the LAN (a guest's cookie is not Secure then either).
 */
export function bookUrl(env: NodeJS.ProcessEnv): string | { off: string } {
  const raw = (env['BOOK_URL'] ?? '').trim().replace(/\/$/, '');
  if (!raw) return { off: 'BOOK_URL' };
  let url: URL;
  try { url = new URL(raw); } catch { return { off: 'BOOK_URL is not usable' }; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/'
    || url.search || url.hash || url.username || url.password) return { off: 'BOOK_URL is not usable' };
  if (url.protocol === 'http:' && env['COOKIE_INSECURE'] !== '1') return { off: HTTPS_ONLY };
  return url.origin;
}

/** Where mail goes, from SMTP_*, or why it cannot: the first one missing, or one that is not usable. */
function smtpConfig(env: NodeJS.ProcessEnv): SmtpConfig | { off: string } {
  for (const name of NEEDED) {
    if (name.startsWith('SMTP_') && !env[name]?.trim()) return { off: name };
  }
  const portText = env['SMTP_PORT']!.trim();
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) return { off: 'SMTP_PORT is not usable' };
  const from = env['SMTP_FROM']!.trim();
  if (!isEmail(from)) return { off: 'SMTP_FROM is not usable' };
  return {
    host: env['SMTP_HOST']!.trim(),
    port,
    user: env['SMTP_USER']!.trim(),
    // A password is what it is; spaces in it are part of it.
    pass: env['SMTP_PASS']!,
    from,
    // The password in the clear on a connection without TLS: only for a
    // relay on the NAS itself, and only when the owner says so.
    ...(env['SMTP_PLAIN_AUTH']?.trim() === '1' ? { allowPlainAuth: true } : {}),
  };
}

/**
 * Booking's page and mail, read from the environment (This NAS's values laid
 * over the deployment's), or why it is off: the first variable missing,
 * `'<variable> is not usable'` for one set to something that cannot work, or
 * that BOOK_URL must be https. All six are required; there is no half-on.
 */
export function bookingConfig(env: NodeJS.ProcessEnv): Omit<BookingConfig, 'household'> | { off: string } {
  for (const name of NEEDED) {
    if (!env[name]?.trim()) return { off: name };
  }
  const url = bookUrl(env);
  if (typeof url !== 'string') return url;
  const smtp = smtpConfig(env);
  if ('off' in smtp) return smtp;
  return { url, smtp };
}

/**
 * The mail server while booking is off, if the deployment still gives a
 * usable one: a request already on Today can be declined with it (its guest
 * mailed the reason, with no page to go back to), never approved.
 */
export function mailWhileOff(env: NodeJS.ProcessEnv): SmtpConfig | null {
  const smtp = smtpConfig(env);
  return 'off' in smtp ? null : smtp;
}

/**
 * Why booking is off, in the words Settings shows a member and the boot log
 * prints: a variable to set, a setting that cannot work, or another household's.
 */
export function bookingOffWords(why: string): string {
  if (/^[A-Z_]+$/.test(why)) return `Booking is off until ${why} is set in Home Planner's deployment.`;
  if (/^[A-Z_]+ /.test(why)) return `Booking is off: ${why}.`;
  return `Booking is off here: ${why}.`;
}

export type BookingStatus = { on: true; config: BookingConfig } | { on: false; why: string };

/**
 * How a decision reaches the guest: the mail server, the booking page's
 * origin for links, and the function that sends. On a member's context in the
 * household friends book with while booking is on; while it is off, on any
 * member's, with `off` saying why and no page, so a request already waiting
 * can still be declined (if a mail server is set) and never approved. A test
 * hands in a send that records.
 */
export interface BookingMail {
  smtp: SmtpConfig | null;
  url: string | null;
  send: typeof sendMail;
  /** Booking is off, in bookingOffWords' words. */
  off?: string;
}

/** Why booking is off when its page and mail are set but no household has turned it on. */
export const NO_BOOKING_HOUSEHOLD = 'no household has booking on';

/**
 * The one household friends book with: the first whose latest guests.booking
 * turned it on (earliest `at`, so after a restore that brings two, the first
 * keeps it); with none on, BOOK_HOUSEHOLD if its log has no guests.booking at
 * all; else null. Only the households given count, so a BOOK_HOUSEHOLD naming
 * none of them is no household.
 */
export function bookingHousehold(
  logs: readonly { id: string; booking: State['settings']['booking'] }[], env: NodeJS.ProcessEnv,
): string | null {
  let first: { id: string; at: string } | null = null;
  for (const { id, booking } of logs) {
    if (booking?.on && (first === null || Date.parse(booking.at) < Date.parse(first.at))) first = { id, at: booking.at };
  }
  if (first) return first.id;
  const named = env['BOOK_HOUSEHOLD']?.trim();
  return named && logs.some((l) => l.id === named && l.booking === null) ? named : null;
}

/**
 * Whether booking is on, worked out each time it is asked: its page and mail
 * configured, and a household that books (bookingHousehold). The page and
 * mail are named first: they are what a deployment that has not set booking
 * up at all is missing.
 */
export function bookingStatus(env: NodeJS.ProcessEnv, household: string | null): BookingStatus {
  const config = bookingConfig(env);
  if ('off' in config) return { on: false, why: config.off };
  if (household === null) return { on: false, why: NO_BOOKING_HOUSEHOLD };
  return { on: true, config: { ...config, household } };
}

/** What blocks a switch: requests still waiting, and confirmed stays not yet over. */
export function aheadOf(state: State, today: Day): { requests: number; stays: number } {
  let requests = 0;
  for (const o of state.thread.offers.values()) {
    if (o.prompt.kind === 'booking' && o.tool === 'approve_booking' && isGuest(o.who) && (o.status === 'open' || o.status === 'snoozed')) requests++;
  }
  let stays = 0;
  for (const s of state.stays.values()) if (!s.cancelled && s.depart > today) stays++;
  return { requests, stays };
}

/** `'2 requests waiting and 1 stay ahead'`, `'1 request waiting'`, `'3 stays ahead'`. */
export const aheadWords = (a: { requests: number; stays: number }): string => [
  a.requests ? `${a.requests} ${a.requests === 1 ? 'request' : 'requests'} waiting` : '',
  a.stays ? `${a.stays} ${a.stays === 1 ? 'stay' : 'stays'} ahead` : '',
].filter(Boolean).join(' and ');

/** What booking says once the app found the Household calendar gone, until one is chosen again. */
export const CALENDAR_GONE = 'Booking is off: the household calendar is gone. Choose one, then turn booking on again.';

/** Who is reading booking's words: the one who must act is told "you". */
export interface Viewer { readonly who: string; readonly admin: boolean }

/** Mail that can send: all of it set and usable, and its last test (if one still counts) not failed. */
const mailWorks = (env: NodeJS.ProcessEnv): boolean => !('off' in smtpConfig(env)) && currentTest('mailTest')?.ok !== false;

/**
 * Whether this household could turn booking on, and if not, why, naming who
 * can fix it: its owner for the calendar; for the page and mail, ADMIN_USER,
 * else the last admin to save on This NAS, else the NAS's administrator.
 * Whoever reads it and is the one to act is told "you": the owner for the
 * calendar, any administrator for the address and mail. A calendar the app
 * found gone is no calendar (the log still names it until one is chosen
 * again). Mail whose last test failed is not working mail.
 */
export function bookingAvailability(state: State, o: { env: NodeJS.ProcessEnv; adminUser: string | null; viewer?: Viewer }):
  { available: true } | { available: false; why: string } {
  if (state.settings.booking?.calendarGone) return { available: false, why: CALENDAR_GONE };
  if (!state.calendar.household) {
    return {
      available: false,
      why: o.viewer?.who === state.owner ? 'Booking is off until you choose the Household calendar.'
        : `Booking is off until ${state.owner ?? 'the owner'} chooses the Household calendar.`,
    };
  }
  const you = o.viewer?.admin === true;
  const fixer = o.adminUser || lastSavedBy() || "the NAS's administrator";
  if (typeof bookUrl(o.env) !== 'string') {
    return { available: false, why: you ? 'Booking is off until you set the booking address.' : `Booking is off until ${fixer} sets the booking address.` };
  }
  if (!mailWorks(o.env)) {
    return {
      available: false,
      why: you ? 'Booking is off until you set up mail under Settings › This NAS.' : `Booking is off until ${fixer} sets up mail under Settings › This NAS.`,
    };
  }
  return { available: true };
}

/** What a member who cannot set the booking address or mail reads in its place. */
export const ADMIN_SETS = 'An administrator sets this.';

export type BookingNeedId = 'calendar' | 'address' | 'mail';
/** One thing booking needs: done, and the line Guests and booking says beside it. */
export interface BookingNeed { readonly id: BookingNeedId; readonly done: boolean; readonly line: string }

/**
 * What booking needs, in the order Guests and booking lists them: the
 * Household calendar (the owner's), the booking page's address and working
 * mail (an administrator's). Done, each line says what is set; not, it says
 * what is missing to the one who sets it, and who sets it to anyone else.
 */
export function bookingNeeds(state: State, o: { env: NodeJS.ProcessEnv; viewer: Viewer }): BookingNeed[] {
  const gone = state.settings.booking?.calendarGone === true;
  const cal = gone ? null : state.calendar.household;
  const calendarLine = cal ? cal.name
    : o.viewer.who !== state.owner ? `${state.owner ?? 'The owner'} chooses this.`
    : gone ? 'The Household calendar is gone. Choose another.' : 'Not chosen yet.';
  const url = bookUrl(o.env);
  const addressLine = typeof url === 'string' ? url
    : !o.viewer.admin ? ADMIN_SETS
    : url.off === 'BOOK_URL' ? 'Not set yet.'
    : url.off === HTTPS_ONLY ? 'The address set starts http://. It needs https://.'
    : 'The address set cannot be used. Just the address, with no path: like https://planner.example.com.';
  const mail = mailWorks(o.env);
  const test = currentTest('mailTest');
  const mailLine = mail ? 'Set up'
    : !o.viewer.admin ? ADMIN_SETS
    : !('off' in smtpConfig(o.env)) && test && !test.ok ? `The last test failed: ${test.words}` : 'Not set up yet.';
  return [
    { id: 'calendar', done: cal !== null, line: calendarLine },
    { id: 'address', done: typeof url === 'string', line: addressLine },
    { id: 'mail', done: mail, line: mailLine },
  ];
}

/** Why booking is off on this NAS, as This NAS's Booking row says what is missing after "Off: ". */
export function bookingMissing(why: string): string {
  if (why === 'BOOK_URL') return 'the booking address is not set';
  if (why === HTTPS_ONLY) return 'the booking address must start https://';
  if (why.startsWith('BOOK_URL')) return 'the booking address cannot be used';
  if (why.startsWith('SMTP_')) return 'mail is not set up';
  if (why === NO_BOOKING_HOUSEHOLD) return 'no household has turned booking on';
  return why;
}

// ─── signing a guest in ──────────────────────────────────────────────────────
//
// A guest types their email; if it is on the household's list they get one
// message with a six-digit code and a link, and either one signs them in. The
// page is told the same sentence whatever happened, and takes the same time to
// hear it, so the list cannot be read off the door. The code and the link exist
// in that email and in memory here, and nowhere else: never in a response,
// never in a log. Memory only, like the guest sessions; a restart forgets them.

/** The reason on a guest's own cancel and change: the app's words, never theirs. */
export const GUEST_CANCEL_WHY = 'withdrawn by the guest';
export const GUEST_CHANGE_WHY = 'changed by the guest';

/** What `POST /book/start` always says. */
export const SIGN_IN_MESSAGE = 'If that address is one we know, a link is on its way.';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CODE_TTL_MS = 10 * MINUTE;
const LINK_TTL_MS = 24 * HOUR;
/** Wrong codes for an address before its outstanding codes stop working (the links still do). */
const CODE_TRIES = 5;
/**
 * Wrong codes for an address in a day, however many emails it asked for:
 * past this every code for it is refused until the day is out, so asking for
 * fresh codes does not buy fresh guesses. Its links still work.
 */
const WRONG_CODES_PER_DAY = 10;
const PER_EMAIL_PER_HOUR = 5;
const PER_IP_PER_HOUR = 20;
/** Codes typed from one address (its /64 for IPv6) in an hour, right or wrong. */
const CODES_PER_IP_PER_HOUR = 30;
/**
 * Every request to start a sign-in takes at least this long, sent or not. The
 * mail itself goes out after the answer, so a slow mail server cannot tell
 * the page which addresses are on the list.
 */
const SIGN_IN_FLOOR_MS = 100;

export interface SignIn {
  code: string;
  token: string;
  email: string;
  /** When the code stops working. */
  expiresAt: number;
  /** When the link stops working: a day, against the code's ten minutes. */
  linkExpiresAt: number;
  /** Wrong codes typed for this address while this one was live. */
  tries: number;
  /** Spent: the link or the code was used, or another sign-in for the address was. */
  used: boolean;
}

const byToken = new Map<string, SignIn>();
const byEmail = new Map<string, SignIn[]>();

const perEmail = new Limiter(PER_EMAIL_PER_HOUR, HOUR);
const perIp = new Limiter(PER_IP_PER_HOUR, HOUR);
const wrongCodes = new Limiter(WRONG_CODES_PER_DAY, 24 * HOUR);
const codesPerIp = new Limiter(CODES_PER_IP_PER_HOUR, HOUR);

function sweep(now: number): void {
  perEmail.sweep(now);
  perIp.sweep(now);
  wrongCodes.sweep(now);
  codesPerIp.sweep(now);
  for (const [t, s] of byToken) if (s.used || s.linkExpiresAt < now) byToken.delete(t);
  for (const [e, list] of byEmail) {
    const live = list.filter((s) => !s.used && s.linkExpiresAt >= now);
    if (live.length) byEmail.set(e, live); else byEmail.delete(e);
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The wait every start-sign-in answer takes, for a caller with nothing to do (booking off). */
export const signInFloor = (): Promise<void> => pause(SIGN_IN_FLOOR_MS);

/** Addresses, and this sign-in's code and token, out of anything about to be logged. */
const scrub = (text: string, s: SignIn): string =>
  text.split(s.token).join('…').split(s.code).join('…').replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, '<address>');

/**
 * Start a sign-in. Always resolves, after the same floor, and says nothing:
 * the caller answers `SIGN_IN_MESSAGE` regardless, and then calls what this
 * resolves to, which hands the one email to the mail server (or does nothing).
 * An email goes only when the address is on the list and neither it nor the
 * IP has asked too often this hour. The send is not awaited; a failure is
 * logged without the address.
 */
export async function startSignIn(
  ctx: { store: Store; cfg: BookingConfig; now: () => number; ip: string },
  email: string,
  send = sendMail,
): Promise<() => void> {
  const floor = signInFloor();
  const now = ctx.now();
  sweep(now);
  const key = emailKey(typeof email === 'string' ? email : '');
  const guest = isEmail(key) ? ctx.store.state.guests.get(key) : undefined;
  // The IP is counted for every request, known address or not; an address only once the IP allowed it.
  if (perIp.take(ctx.ip, now) && isEmail(key) && perEmail.take(key, now) && guest) {
    const s: SignIn = {
      code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      token: randomBytes(32).toString('base64url'),
      email: key,
      expiresAt: now + CODE_TTL_MS,
      linkExpiresAt: now + LINK_TTL_MS,
      tries: 0,
      used: false,
    };
    byToken.set(s.token, s);
    byEmail.set(key, [...(byEmail.get(key) ?? []), s]);

    const label = ctx.store.state.label;
    const link = `${ctx.cfg.url}/book/open?token=${s.token}`;
    const text = [
      `Hello ${guest.name},`,
      '',
      `Here is your link to book a stay with ${label}. It works once, within a day:`,
      '',
      link,
      '',
      'Or type this code on the booking page, within ten minutes:',
      '',
      `    ${s.code}`,
      '',
      "If you didn't ask for this, ignore it.",
      '',
    ].join('\n');
    await floor;
    return () => {
      void (async () => send(ctx.cfg.smtp, { to: key, subject: `Your link to book a stay with ${label}`, text }, label))()
        .catch((err: unknown) => {
          const why = err instanceof MailError ? err.reply : (err as Error)?.message ?? String(err);
          console.warn(`[budget] a sign-in email was not sent: ${scrub(why, s)}`);
        });
    };
  }
  await floor;
  return () => {};
}

const notRight = () => new ToolError('that link or code is not right', 401);

const sameCode = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Finish a sign-in, by the link's token or by an address and its code, and
 * say whose it was. Anything stale, spent or unknown is the one refusal.
 * Success spends every outstanding link and code for that address: one email
 * signs in once, and an older link opened afterwards is dead.
 *
 * A code is a guess at a million: `ip` (the code route's caller) may type
 * thirty an hour (429 past that), and an address that has had ten wrong in a
 * day takes no code at all, right or wrong, until the day is out.
 */
export function finishSignIn(o: { token?: string; email?: string; code?: string; now: () => number; ip?: string }): string {
  const now = o.now();
  let found: SignIn | undefined;
  if (typeof o.token === 'string' && o.token) {
    const s = byToken.get(o.token);
    if (s && !s.used && now <= s.linkExpiresAt) found = s;
  } else if (typeof o.email === 'string' && typeof o.code === 'string') {
    if (o.ip !== undefined && !codesPerIp.take(o.ip, now)) throw new ToolError('too many codes from here: try again in an hour', 429);
    const key = emailKey(o.email);
    // Not an address (or past 254 characters): refused before anything is counted against it.
    if (isEmail(key) && !wrongCodes.full(key, now)) {
      const live = (byEmail.get(key) ?? []).filter((s) => !s.used && now <= s.expiresAt && s.tries < CODE_TRIES);
      const code = o.code.trim();
      found = /^\d{6}$/.test(code) ? live.find((s) => sameCode(s.code, code)) : undefined;
      if (!found) {
        for (const s of live) s.tries++;
        wrongCodes.take(key, now);
      }
    }
  }
  if (!found) { sweep(now); throw notRight(); }
  for (const s of byEmail.get(found.email) ?? []) s.used = true;
  found.used = true;
  sweep(now);
  return found.email;
}


// ─── which nights are open ───────────────────────────────────────────────────
//
// Nights are exclusive: a stay from the 12th to the 15th holds the nights of
// the 12th, 13th and 14th, and the 15th is open for the next party. A night is
// taken by a confirmed stay that is not cancelled, by a request still waiting
// on the thread (from anyone but the asker, so two friends cannot both pick the
// same week while a decision is pending), or by a block a member put on it.

/** What a guest is told about a night. */
export type NightStatus = 'open' | 'taken' | 'mine-pending' | 'mine-approved';

/** One night as a guest sees it: these two keys, and never a third. */
export interface Night { night: Day; status: NightStatus }

/** One night as a member sees it: why it is taken, and by whom. */
export interface MemberNight {
  night: Day;
  status: 'open' | 'taken';
  kind?: 'stay' | 'pending' | 'block' | 'past';
  /** The guest's name for a stay or request, the member's for a block. */
  by?: string;
  /** A block's reason. */
  why?: string;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const pad = (n: number): string => String(n).padStart(2, '0');

/** Every night of a `YYYY-MM`, in order; anything else is a 400. */
function nightsIn(month: unknown): Day[] {
  const m = typeof month === 'string' ? MONTH_RE.exec(month) : null;
  if (!m) throw new ToolError('month must be YYYY-MM', 400);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const length = mon === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(mon) ? 30 : 31;
  return Array.from({ length }, (_, i) => `${m[1]}-${m[2]}-${pad(i + 1)}`);
}


interface Hold {
  kind: 'stay' | 'pending' | 'block';
  /** What it is in the log: a stay's id and its request's, a request's card, a block's line. */
  ids: EventId[];
  from: Day;
  to: Day;
  /** The guest it belongs to, for a stay or a request. */
  email?: string;
  by: string;
  why?: string;
}

/** Everything that keeps nights, in the order a night is explained by it. */
function holds(state: State): Hold[] {
  const out: Hold[] = [];
  for (const [id, s] of state.stays) {
    if (!s.cancelled) out.push({ kind: 'stay', ids: [id, s.request], from: s.arrive, to: s.depart, email: s.email, by: s.name });
  }
  for (const o of state.thread.offers.values()) {
    if (o.prompt.kind !== 'booking' || o.tool !== 'approve_booking' || !isGuest(o.who)) continue;
    if (o.status !== 'open' && o.status !== 'snoozed') continue;
    const { arrive, depart, name } = o.args as { arrive?: unknown; depart?: unknown; name?: unknown };
    if (!isDay(arrive) || !isDay(depart) || arrive >= depart) continue;
    const email = guestEmail(o.who);
    out.push({
      kind: 'pending', ids: [o.id], from: arrive, to: depart, email,
      by: typeof name === 'string' && name.trim() ? name.trim() : state.guests.get(email)?.name ?? email,
    });
  }
  for (const [id, b] of state.stayBlocks) {
    out.push({ kind: 'block', ids: [id], from: b.from, to: b.to, by: b.by, why: b.why });
  }
  return out;
}

/**
 * The nights of a month, open or taken, for a guest. `forEmail` is the guest
 * asking: their own stay and request come back as theirs. `today` is the
 * household's today; nights before it are taken, because nobody books the past.
 * A bad `month` is a 400.
 *
 * A row is built here from `night` and `status` and nothing else, so nothing
 * about who has a night, or why, can ride along.
 */
export function availability(state: State, o: { month: string; forEmail?: string; today: Day }): Night[] {
  const nights = nightsIn(o.month);
  const all = holds(state);
  const me = o.forEmail === undefined ? null : emailKey(o.forEmail);
  return nights.map((night): Night => {
    if (night < o.today) return { night, status: 'taken' };
    const here = all.filter((h) => h.from <= night && night < h.to);
    const own = me === null ? undefined : here.find((h) => h.email === me);
    if (own) return { night, status: own.kind === 'stay' ? 'mine-approved' : 'mine-pending' };
    return { night, status: here.length ? 'taken' : 'open' };
  });
}

/**
 * The same month for a member, who is told why: a night is a `stay`, a
 * `pending` request, a `block` (with its reason), or `past`, and `by` says
 * whose. An open night says nothing more than that it is open.
 */
export function memberNights(state: State, o: { month: string; today?: Day }): MemberNight[] {
  const nights = nightsIn(o.month);
  const all = holds(state);
  return nights.map((night): MemberNight => {
    if (o.today !== undefined && night < o.today) return { night, status: 'taken', kind: 'past' };
    const h = all.find((x) => x.from <= night && night < x.to);
    if (!h) return { night, status: 'open' };
    return { night, status: 'taken', kind: h.kind, by: h.by, ...(h.why !== undefined ? { why: h.why } : {}) };
  });
}


// ─── asking to stay ──────────────────────────────────────────────────────────
//
// A request is a card on Today, raised by the guest: `approve_booking`, with
// the guest's email and the list's name for them, the nights, how many, and a
// note. It holds its nights from the moment it is asked until it is decided.

/** The longest stay one request asks for, in nights. */
export const MAX_NIGHTS = 30;
/** The most people one request brings. */
export const MAX_PARTY = 20;
/** A note is a few sentences to the household, not a letter. */
export const NOTE_MAX = 500;

export const dayWords = (d: Day): string => `${MONTHS_SHORT[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/**
 * A stay's dates as the card says them: "Dec 12–15", "Nov 28–Dec 3",
 * "Dec 30–Jan 2", and the year after them when it is not this one.
 */
export function stayDates(arrive: Day, depart: Day, today: Day): string {
  const to = arrive.slice(0, 7) === depart.slice(0, 7) ? String(Number(depart.slice(8, 10))) : dayWords(depart);
  const year = arrive.slice(0, 4) === today.slice(0, 4) ? '' : `, ${arrive.slice(0, 4)}`;
  return `${dayWords(arrive)}–${to}${year}`;
}

/** What a request asks for, read from a guest's words. */
export interface StayAsked { arrive: Day; depart: Day; headcount: number; note: string }

const nextDay = (d: Day): Day => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The nights of a stay: arrival (inclusive) to departure (exclusive). */
function nightsOf(arrive: Day, depart: Day): Day[] {
  const out: Day[] = [];
  for (let d = arrive; d < depart; d = nextDay(d)) out.push(d);
  return out;
}

/**
 * The dates, headcount and note of a stay, or a 400 saying what is wrong:
 * real days, leaving after arriving, at most thirty nights, one to twenty
 * people, a note of at most 500 characters. Given `today`, arriving today or later.
 */
export function stayAsked(o: Record<string, unknown>, today?: Day): StayAsked {
  const { arrive, depart, headcount, note } = o;
  if (!isDay(arrive)) throw new ToolError('the arrival is a date, YYYY-MM-DD');
  if (!isDay(depart)) throw new ToolError('the departure is a date, YYYY-MM-DD');
  if (depart <= arrive) throw new ToolError('the departure is after the arrival');
  if (today !== undefined && arrive < today) throw new ToolError('the arrival has passed');
  if (nightsOf(arrive, depart).length > MAX_NIGHTS) throw new ToolError(`a stay is at most ${MAX_NIGHTS} nights`);
  if (typeof headcount !== 'number' || !Number.isInteger(headcount) || headcount < 1 || headcount > MAX_PARTY) {
    throw new ToolError(`how many of you is a whole number from 1 to ${MAX_PARTY}`);
  }
  if (note !== undefined && typeof note !== 'string') throw new ToolError('the note is text');
  const text = (note ?? '').trim();
  if (text.length > NOTE_MAX) throw new ToolError(`keep the note under ${NOTE_MAX} characters`);
  return { arrive, depart, headcount, note: text };
}

/** "the night of Dec 14 is taken"; "the nights of Dec 31 and Jan 1 are taken". */
function takenWords(nights: readonly Day[]): string {
  if (nights.length > 3) return `${nights.length} of those nights are taken`;
  const words = nights.map(dayWords);
  const list = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}`;
  return `the night${nights.length === 1 ? '' : 's'} of ${list} ${nights.length === 1 ? 'is' : 'are'} taken`;
}

/**
 * Refuse a stay unless every night of it is open for this guest. Open is what
 * `availability` means by it: no stay, no request waiting and no block on the
 * night, and not before today. It is read here from the same holds rather
 * than from a guest's month, because a guest's own request shows over
 * anything else on its nights, and a block put there since must still count.
 *
 * Their own request or stay over it says "you already have …"; anyone else's,
 * or a block, says which nights are taken and nothing about why — unless
 * `voice` is a member's, who is told what took them. `ownPending` lets every
 * request of the guest's still waiting through; `except` lets through only
 * the stays and requests it names (by a stay's id or its request's, or a
 * card's): the card being decided, or the stay a change gives up.
 */
export function refuseClash(state: State, o: {
  email: string; arrive: Day; depart: Day; today: Day; voice: 'guest' | 'member'; ownPending: boolean;
  except?: readonly EventId[];
}): void {
  const me = emailKey(o.email);
  const mineWaiting = (h: Hold) => o.ownPending && h.kind === 'pending' && h.email === me;
  const excepted = (h: Hold) => h.kind !== 'block' && h.ids.some((id) => o.except?.includes(id));
  const all = holds(state).filter((h) => h.from < o.depart && o.arrive < h.to && !mineWaiting(h) && !excepted(h));
  const clash = nightsOf(o.arrive, o.depart)
    .filter((n) => n < o.today || all.some((h) => h.from <= n && n < h.to));
  if (!clash.length) return;

  if (o.voice === 'member') {
    const words = all.map((h) => (h.kind === 'stay' ? `${h.by} is staying ${stayDates(h.from, h.to, o.today)}`
      : h.kind === 'pending' ? `${h.by} asked for ${stayDates(h.from, h.to, o.today)}`
      : `${stayDates(h.from, h.to, o.today)} is kept for the household: “${h.why ?? ''}”`));
    throw new ToolError(`those nights are taken: ${words.join('; ') || takenWords(clash)}`, 409);
  }
  const own = all.find((h) => h.email === me && h.kind !== 'block');
  if (own) {
    throw new ToolError(`you already have ${own.kind === 'stay' ? 'a stay booked' : 'a request waiting'} for ${stayDates(own.from, own.to, o.today)}`, 409);
  }
  throw new ToolError(takenWords(clash), 409);
}

/** The card's sentence and what approving it does, in the list's name for the guest. */
export function requestWords(a: { name: string } & StayAsked, today: Day): { summary: string; effects: string[] } {
  const dates = stayDates(a.arrive, a.depart, today);
  const people = `${a.headcount} ${a.headcount === 1 ? 'person' : 'people'}`;
  return {
    summary: `${a.name} would like to come ${dates}, ${people}${a.note ? `: “${a.note}”` : ''}`,
    effects: [`An all-day event on the Household calendar, ${dates}`, `A confirmation email to ${a.name}`],
  };
}

/**
 * What a request card says before its sentence, from what raised it: a
 * suggestion the guest took up, or a change to dates they had.
 */
export function requestPrefix(args: Record<string, unknown>, today: Day): string {
  if (typeof args['suggestion'] === 'string' && args['suggestion']) return 'You suggested these: ';
  const from = args['changedFrom'] as { arrive?: unknown; depart?: unknown } | undefined;
  if (from && isDay(from.arrive) && isDay(from.depart) && from.arrive < from.depart) {
    return `Changed from ${stayDates(from.arrive, from.depart, today)}: `;
  }
  return '';
}

/** What else a request was raised from: never the guest's words, always the app's. */
export interface RequestFrom {
  /** The `booking.suggest` the guest took up. */
  suggestion?: EventId;
  /** The dates of the stay or request a change gives up. */
  changedFrom?: { arrive: Day; depart: Day };
  /**
   * The confirmed stay a change would take the place of. It stands, and holds
   * its nights, until the household decides; approving replaces it.
   */
  replacesStay?: EventId;
}

type GuestCtx = { store: Store; who: Actor; today: Day };

/** The guest a context speaks for, by their key on the list, or a refusal. */
function guestOf(ctx: GuestCtx): { email: string; name: string } {
  if (!isGuest(ctx.who)) throw new ToolError('only a guest asks to stay', 403);
  const email = guestEmail(ctx.who);
  const guest = ctx.store.state.guests.get(email);
  if (!guest) throw new ToolError('please sign in', 401);
  return { email, name: guest.name };
}

/**
 * A guest asks to stay: checked, then put in front of the household as a
 * card by the guest. Who they are is the session's and what they are called
 * is the list's; the body says only when, how many, and a note. `from` is the
 * app's, for a request raised by taking up a suggestion or by a change.
 */
export async function request(ctx: GuestCtx, o: Record<string, unknown>, from: RequestFrom = {}): Promise<Offer> {
  const { email, name } = guestOf(ctx);
  const asked = stayAsked(o, ctx.today);
  refuseTooMany(ctx.store.state, email, asked);
  // A change to a stay may overlap the stay's own nights: those are what it gives up, if approved.
  refuseClash(ctx.store.state, {
    email, ...asked, today: ctx.today, voice: 'guest', ownPending: false, ...(from.replacesStay ? { except: [from.replacesStay] } : {}),
  });
  return offer({ store: ctx.store, who: ctx.who, today: ctx.today, proposals: new ProposalStore(), sid: null }, {
    tool: 'approve_booking',
    args: {
      email, name, ...asked,
      ...(from.suggestion ? { suggestion: from.suggestion } : {}),
      ...(from.changedFrom ? { changedFrom: { arrive: from.changedFrom.arrive, depart: from.changedFrom.depart } } : {}),
      ...(from.replacesStay ? { replacesStay: from.replacesStay } : {}),
    },
    prompt: { kind: 'booking', ref: null },
    by: ctx.who,
  });
}

/** Requests one guest may have waiting at once, and the nights in all of them together. */
export const MAX_WAITING = 3;
export const MAX_WAITING_NIGHTS = 60;

/** A guest's own requests still waiting on the thread. */
const waitingOf = (state: State, email: string): Offer[] => [...state.thread.offers.values()].filter((o) =>
  o.prompt.kind === 'booking' && o.tool === 'approve_booking' && isGuest(o.who) && guestEmail(o.who) === email
  && (o.status === 'open' || o.status === 'snoozed'));

/**
 * One friend cannot fill the calendar with requests: three waiting at once,
 * and sixty nights in them, at most. Said in the guest's voice; a request
 * decided or withdrawn frees its place.
 */
function refuseTooMany(state: State, email: string, asked: StayAsked): void {
  const waiting = waitingOf(state, email);
  if (waiting.length >= MAX_WAITING) throw new ToolError('you already have three requests waiting: wait for an answer, or withdraw one', 409);
  const held = waiting.reduce((n, o) => {
    const { arrive, depart } = o.args;
    return isDay(arrive) && isDay(depart) && arrive < depart ? n + nightsOf(arrive, depart).length : n;
  }, 0);
  if (held + nightsOf(asked.arrive, asked.depart).length > MAX_WAITING_NIGHTS) {
    throw new ToolError(`you already have ${held} nights waiting for an answer: at most ${MAX_WAITING_NIGHTS} at once`, 409);
  }
}

/** One of a guest's own requests, as the booking page shows it. */
export interface MyRequest {
  id: EventId;
  arrive: Day;
  depart: Day;
  headcount: number;
  note: string;
  /** `lapsed`: other dates were suggested, and their arrival has passed. */
  status: 'pending' | 'approved' | 'declined' | 'suggested' | 'lapsed' | 'cancelled';
  /** A decline's reason, or a suggestion's. */
  why?: string;
  /** The dates a member put to them instead, the suggestion's id to take them up by, and whether they have. */
  suggested?: { id: EventId; arrive: Day; depart: Day; asked?: true };
  /** A change still waiting: the confirmed stay it would replace, which stands until it is decided. */
  replaces?: EventId;
  /** A confirmed stay's own id, which a change names in `replaces`. */
  stay?: EventId;
}

/**
 * A guest's own requests and stays, oldest first, and nobody else's. A
 * request that was approved shows the stay's dates; one declined, the
 * reason; one declined with other dates suggested, those dates. One the
 * guest withdrew (the fold marks it replaced) shows as cancelled; a guest's
 * card never has `replaces`, so no other replaced one is theirs to show.
 */
export function mine(state: State, events: readonly Event[], email: string, today: Day): MyRequest[] {
  const me = emailKey(email);
  const cancelled = new Set<EventId>();
  const suggested = new Map<EventId, Extract<Event, { op: 'booking.suggest' }>>();
  for (const e of events) {
    if (e.op === 'booking.cancel') cancelled.add(e.stay);
    if (e.op === 'booking.suggest') suggested.set(e.request, e);
  }
  // Suggestions already taken up: a fresh request names the one it came from.
  const askedFor = new Set<string>();
  for (const o of state.thread.offers.values()) {
    if (o.tool === 'approve_booking' && typeof o.args['suggestion'] === 'string') askedFor.add(o.args['suggestion']);
  }
  const stayOf = new Map<EventId, [EventId, Stay]>();
  for (const [id, s] of state.stays) if (s.email === me) stayOf.set(s.request, [id, s]);

  const out: MyRequest[] = [];
  const shown = new Set<EventId>();
  for (const o of state.thread.offers.values()) {
    if (o.prompt.kind !== 'booking' || o.tool !== 'approve_booking' || !isGuest(o.who)) continue;
    if (guestEmail(o.who) !== me) continue;
    if (o.status === 'replaced' && !cancelled.has(o.id)) continue;
    const a = o.args as Partial<StayAsked>;
    if (!isDay(a.arrive) || !isDay(a.depart)) continue;
    const base = {
      id: o.id, arrive: a.arrive, depart: a.depart,
      headcount: typeof a.headcount === 'number' ? a.headcount : 0, note: typeof a.note === 'string' ? a.note : '',
    };
    const stay = stayOf.get(o.id);
    if (stay) {
      shown.add(stay[0]);
      const [, st] = stay;
      // Replaced by a change since: the change's own row is that stay now.
      if (st.replacedBy) continue;
      out.push({ ...base, arrive: st.arrive, depart: st.depart, headcount: st.headcount,
        status: st.cancelled ? 'cancelled' : 'approved', stay: stay[0] });
      continue;
    }
    if (cancelled.has(o.id)) { out.push({ ...base, status: 'cancelled' }); continue; }
    const s = suggested.get(o.id);
    if (s) {
      // Dates whose arrival has passed are no longer on offer: lapsed, with nothing to take up.
      out.push({ ...base, status: s.arrive < today ? 'lapsed' : 'suggested', why: s.why,
        suggested: { id: s.id, arrive: s.arrive, depart: s.depart, ...(askedFor.has(s.id) ? { asked: true as const } : {}) } });
      continue;
    }
    if (o.status === 'declined') { out.push({ ...base, status: 'declined', ...(o.why ? { why: o.why } : {}) }); continue; }
    if (o.status === 'approved') { out.push({ ...base, status: 'approved' }); continue; }
    const replaces = o.args['replacesStay'];
    out.push({ ...base, status: 'pending', ...(typeof replaces === 'string' ? { replaces } : {}) });
  }
  // A stay confirmed for a request that is not on the thread as theirs.
  for (const [id, st] of state.stays) {
    if (st.email !== me || shown.has(id) || st.replacedBy) continue;
    out.push({ id, arrive: st.arrive, depart: st.depart, headcount: st.headcount, note: '',
      status: st.cancelled ? 'cancelled' : 'approved', stay: id });
  }
  return out;
}


// ─── what a guest is told ────────────────────────────────────────────────────
//
// Plain text, from the household by its name in Settings, to the guest by the
// list's name for them. Each names the household and the dates, and nothing
// about anyone else: no other guest, no member, no address but the page's.

const peopleWords = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;

/**
 * A stay approved: the dates, how many, the note as sent, and the way back to
 * change or cancel. A change approved says which dates it replaces.
 */
export function confirmedMail(o: {
  label: string; name: string; arrive: Day; depart: Day; headcount: number; note: string; url: string; today: Day;
  replaces?: { arrive: Day; depart: Day };
  /** The household's arrival note: how to get in. Said after the dates when there is one. */
  arrival?: string;
}): Omit<Mail, 'to'> {
  const dates = stayDates(o.arrive, o.depart, o.today);
  const arrival = (o.arrival ?? '').trim();
  return {
    subject: `Your stay with ${o.label} is confirmed: ${dates}`,
    text: [
      `Hello ${o.name},`,
      '',
      `Your stay with ${o.label} is confirmed:`,
      '',
      `    ${dates}, ${peopleWords(o.headcount)}`,
      ...(o.replaces ? ['', `This replaces your stay on ${stayDates(o.replaces.arrive, o.replaces.depart, o.today)}.`] : []),
      ...(arrival ? ['', 'How to get here:', '', ...arrival.split(/\r?\n/).map((l) => (l ? `    ${l}` : ''))] : []),
      ...(o.note ? ['', 'Your note:', '', `    “${o.note}”`] : []),
      '',
      'To change or cancel, go to the booking page:',
      '',
      `${o.url}/book`,
      '',
      'See you soon.',
      '',
    ].join('\n'),
  };
}

/**
 * A request turned down, with the reason in the member's words. A change
 * turned down says the stay it would have replaced stands.
 */
export function declinedMail(o: {
  label: string; name: string; arrive: Day; depart: Day; why: string; url: string | null; today: Day;
  stands?: { arrive: Day; depart: Day };
}): Omit<Mail, 'to'> {
  const dates = stayDates(o.arrive, o.depart, o.today);
  return {
    subject: `About your stay with ${o.label}: ${dates}`,
    text: [
      `Hello ${o.name},`,
      '',
      `${o.label} can't have you for ${dates}. They said:`,
      '',
      `    “${o.why}”`,
      '',
      ...(o.stands ? [`Your stay on ${stayDates(o.stands.arrive, o.stands.depart, o.today)} stands, as it was.`, ''] : []),
      // No page to send them to while booking is off.
      ...(o.url ? ['You can pick other nights on the booking page:', '', `${o.url}/book`, ''] : []),
    ].join('\n'),
  };
}

/** Other dates put to the guest, with the link that asks for them. */
export function suggestedMail(o: {
  label: string; name: string; arrive: Day; depart: Day; why: string; link: string; today: Day;
}): Omit<Mail, 'to'> {
  const dates = stayDates(o.arrive, o.depart, o.today);
  return {
    subject: `Other dates for your stay with ${o.label}`,
    text: [
      `Hello ${o.name},`,
      '',
      `Those dates don't work for ${o.label}, but how about ${dates}? They said:`,
      '',
      `    “${o.why}”`,
      '',
      'If they suit you, this link asks for them:',
      '',
      o.link,
      '',
      "The nights aren't held for you until you ask, so don't wait too long.",
      '',
    ].join('\n'),
  };
}

/** Booking's mail with booking on: its server and its page. */
interface MailOn { smtp: SmtpConfig; url: string; send: typeof sendMail }

/**
 * Booking's mail on this context, or a refusal before anything is done: a
 * guest who cannot be told is not answered. With booking off, only a decline
 * goes on (`decline`), and is refused there if no mail server is set.
 */
function mailOf(ctx: ToolContext): MailOn;
function mailOf(ctx: ToolContext, decline: true): BookingMail;
function mailOf(ctx: ToolContext, decline = false): BookingMail {
  const m = ctx.mail;
  if (!m) throw new ToolError("booking's mail is not set up here, so the guest cannot be told: nothing was done", 409);
  if (m.off && !decline) throw new ToolError(`${m.off} Until then a request can be declined, not approved.`, 409);
  if (!m.off && (!m.smtp || !m.url)) throw new Error("booking is on, and its mail has no server or page");
  return m;
}

/** Send, and say a refusal in words that name the mail server's reply. */
async function tell(ctx: ToolContext, m: BookingMail, to: string, mail: Omit<Mail, 'to'>, failed: string): Promise<void> {
  if (!m.smtp) throw new Error('tell() is handed a mail server');
  try {
    await m.send(m.smtp, { to, ...mail }, ctx.store.state.label);
  } catch (err) {
    if (err instanceof MailError) throw new ToolError(`${err.uncertain ? failed.replace('did not go', 'may not have gone') : failed}: ${err.reply}`, 502);
    throw err;
  }
}

/** A request card's args, read as approve_booking's run reads them. */
export interface CardAsked extends StayAsked {
  email: string;
  name: string;
  /** A change: the guest's confirmed stay it would replace, standing until then. */
  replacing?: { id: EventId; stay: Stay };
}

/**
 * The checks a request card meets now, the same when it is shown and when it
 * is decided: in shape, the guest still on the list, the arrival not passed,
 * and every night open. `ownPending` and `except` are refuseClash's: run, at
 * proposal, lets the guest's own waiting nights through; the effect, at
 * approval, only this card's.
 */
export function checkCard(state: State, args: Record<string, unknown>, o: {
  today: Day; voice: 'guest' | 'member'; ownPending: boolean; except?: readonly EventId[];
}): CardAsked {
  if (!isEmail(args['email'])) throw new ToolError("the request's email is not an email address");
  const email = emailKey(args['email']);
  const name = args['name'];
  if (typeof name !== 'string' || !name.trim()) throw new ToolError("the request has no guest's name");
  const asked = stayAsked(args);
  if (!state.guests.has(email)) throw new ToolError(`${name.trim()} is no longer on the guest list`, 409);
  if (asked.arrive < o.today) throw new ToolError(`the stay was to begin on ${dayWords(asked.arrive)}, which has passed`, 409);
  const replacesId = args['replacesStay'];
  let replacing: CardAsked['replacing'];
  if (replacesId !== undefined) {
    const st = typeof replacesId === 'string' ? state.stays.get(replacesId) : undefined;
    if (!st || st.email !== email) throw new ToolError(`the stay this changes is not ${name.trim()}'s`, 409);
    if (st.cancelled) throw new ToolError(`the stay this changes, ${stayDates(st.arrive, st.depart, o.today)}, is no longer booked`, 409);
    replacing = { id: replacesId as EventId, stay: st };
  }
  // A change's own stay is what it gives up: its nights do not count against it.
  const except = [...(o.except ?? []), ...(replacing ? [replacing.id] : [])];
  refuseClash(state, { email, ...asked, today: o.today, voice: o.voice, ownPending: o.ownPending, ...(except.length ? { except } : {}) });
  return { email, name: name.trim(), ...asked, ...(replacing ? { replacing } : {}) };
}

/**
 * Approving a request, outside the log, in the order the log can trust: the
 * nights checked again (only this card's own pass, and a change's own stay),
 * the all-day event made on the Household calendar, the confirmation sent, and
 * only then the `booking.confirm` handed back to be written with the decision.
 * If the mail is refused, the event is taken back off and the refusal is the
 * answer: the card stays open and nothing is written.
 *
 * A change's confirmation `replaces` the stay it changes, in the same line;
 * that stay's event comes off once the line is written (takeOffReplaced), so
 * a write refused after all leaves the old stay with its event.
 */
export async function confirmStay(ctx: ToolContext, args: Record<string, unknown>, card: EventId | undefined,
                                  f?: DsmFetch): Promise<NewEvent[]> {
  if (!card) throw new Error('a stay is confirmed from its card');
  const m = mailOf(ctx);
  const state = ctx.store.state;
  const a = checkCard(state, args, { today: ctx.today, voice: 'member', ownPending: false, except: [card] });
  const sid = requireSid(ctx);
  const cal = await ensureHouseholdCalendar(ctx, [...state.members], f);
  const tz = zoneOf(state);
  const summary = `${a.name} staying (${a.headcount})`;
  const made = await makeEvent(sid, {
    cal_id: cal.cal_id, original_cal_id: cal.original_cal_id,
    summary,
    description: 'From Home Planner · Booking',
    is_all_day: true, dtstart: midnight(a.arrive, tz), dtend: midnight(a.depart, tz), tz_id: tz,
  }, f);
  let refused: unknown = null;
  const replaces = a.replacing ? { replaces: { arrive: a.replacing.stay.arrive, depart: a.replacing.stay.depart } } : {};
  try {
    await m.send(m.smtp, {
      to: a.email,
      ...confirmedMail({ label: state.label, ...a, ...replaces, arrival: state.settings.arrival, url: m.url, today: ctx.today }),
    }, state.label);
  } catch (err) {
    refused = err;
  }
  if (refused !== null) {
    // The mail did not go, so the event comes back off. If that fails too, the
    // event is left on the calendar for a stay nobody approved: the log says
    // which, and the member is told to delete it rather than that it is gone.
    let left: unknown = null;
    try { await deleteEvent(sid, made, f); } catch (err) { left = err; }
    const reply = refused instanceof MailError ? refused.reply : null;
    // Silence after the whole message was sent: it may be in their inbox after all, and the member is told so.
    const went = refused instanceof MailError && refused.uncertain ? 'may not have gone' : 'did not go';
    if (left !== null) {
      console.warn(`[booking] an event made for an approval whose mail failed could not be deleted: evt_id ${made.evt_id} on ${made.cal_id}`
        + ` ("${summary}", ${a.arrive} to ${a.depart}): ${(left as Error)?.message ?? String(left)}`);
      throw new ToolError(`the confirmation to ${a.name} ${went}, so it is not approved; but its event, "${summary}" `
        + `(${stayDates(a.arrive, a.depart, ctx.today)}), could not be taken back off the Household calendar: delete it there by hand`
        + (reply ? `. The mail server said: ${reply}` : ''), 502);
    }
    if (reply !== null) {
      throw new ToolError(`the confirmation to ${a.name} ${went}, so it is not approved and the event is off the calendar again: ${reply}`, 502);
    }
    throw refused;
  }
  return [{
    op: 'booking.confirm', request: card, ...(a.replacing ? { replaces: a.replacing.id } : {}),
    email: a.email, arrive: a.arrive, depart: a.depart, headcount: a.headcount,
    cal_id: made.cal_id, original_cal_id: made.original_cal_id, evt_id: made.evt_id, ical_uid: made.ical_uid, dav_etag: made.dav_etag,
  }];
}

/**
 * Once a change is written, the event of the stay it replaced comes off the
 * Household calendar. Already gone is what was wanted. One that will not come
 * off is left there, named in the log, and the member is told to delete it by
 * hand: the change is approved and the guest has their confirmation either way.
 */
export async function takeOffReplaced(ctx: ToolContext, extra: readonly NewEvent[], f?: DsmFetch): Promise<void> {
  for (const e of extra) {
    if (e.op !== 'booking.confirm' || e.replaces === undefined) continue;
    const old = ctx.store.state.stays.get(e.replaces);
    if (!old) continue;
    try {
      await deleteEvent(requireSid(ctx), old, f);
    } catch (err) {
      if (err instanceof SynologyError && err.code === NO_SUCH_EVENT) continue;
      const summary = `${old.name} staying (${old.headcount})`;
      console.warn(`[booking] the event of a stay replaced by a change could not be deleted: evt_id ${old.evt_id} on ${old.cal_id}`
        + ` ("${summary}", ${old.arrive} to ${old.depart}): ${(err as Error)?.message ?? String(err)}`);
      throw new ToolError(`approved, and ${old.name} is told; but the old event, "${summary}" (${stayDates(old.arrive, old.depart, ctx.today)}), `
        + 'could not be taken off the Household calendar: delete it there by hand', 502);
    }
  }
}

/** Undo a confirmation whose write was refused: its event comes off the calendar. The mail has gone. */
export async function unconfirm(ctx: ToolContext, extra: readonly NewEvent[], f?: DsmFetch): Promise<void> {
  for (const e of extra) if (e.op === 'booking.confirm') await deleteEvent(requireSid(ctx), e, f);
}

/** A decline, told to the guest before it is written: one that could not be mailed is not a decline. */
export async function tellDeclined(ctx: ToolContext, args: Record<string, unknown>, why: string | undefined): Promise<void> {
  const m = mailOf(ctx, true);
  if (!why) throw new ToolError('declining needs a reason: the guest is told it');
  if (!isEmail(args['email']) || !isDay(args['arrive']) || !isDay(args['depart'])) throw new ToolError('that request is not in a shape to answer');
  const name = typeof args['name'] === 'string' && args['name'].trim() ? args['name'].trim() : 'there';
  if (!m.smtp) {
    throw new ToolError(`no mail server is set (${(m.off ?? '').replace(/\.$/, '')}), so ${name} cannot be told: it is not declined`, 502);
  }
  // A change turned down: the stay it would have replaced is still theirs, and they are told so.
  const was = typeof args['replacesStay'] === 'string' ? ctx.store.state.stays.get(args['replacesStay']) : undefined;
  const stands = was && !was.cancelled ? { stands: { arrive: was.arrive, depart: was.depart } } : {};
  await tell(ctx, m, emailKey(args['email']),
    declinedMail({ label: ctx.store.state.label, name, arrive: args['arrive'], depart: args['depart'], why, url: m.url, today: ctx.today, ...stands }),
    `the email to ${name} did not go, so it is not declined yet`);
}

/** A cancelled stay, by its id, that is still on the calendar; or a refusal. */
export function releasable(state: State, id: unknown): Stay {
  const st = typeof id === 'string' ? state.stays.get(id) : undefined;
  if (!st) throw new ToolError('there is no such stay', 404);
  if (!st.cancelled) throw new ToolError('that stay is not cancelled', 409);
  if (st.released) throw new ToolError('that stay is already off the calendar', 409);
  return st;
}

/** DSM's answer for an event that is not there: already off the calendar, which is what was wanted. */
const NO_SUCH_EVENT = 9009;

/** Take a cancelled stay's event off the Household calendar, and say so. */
export async function releaseStay(ctx: ToolContext, args: Record<string, unknown>, f?: DsmFetch): Promise<NewEvent[]> {
  const st = releasable(ctx.store.state, args['stay']);
  const sid = requireSid(ctx);
  try {
    await deleteEvent(sid, st, f);
  } catch (err) {
    if (!(err instanceof SynologyError && err.code === NO_SUCH_EVENT)) throw err;
  }
  return [{ op: 'booking.release', stay: String(args['stay']) }];
}

/**
 * Other dates for a guest's request, from a member: checked as a request's
 * are (and open now, though they are not held), then the request declined
 * with the reason (which emails it), the suggestion recorded, and a second
 * email with the link that asks for them, built on BOOK_URL. If that mail is
 * refused, the suggestion stands and the guest sees it on their page; the
 * member is told.
 */
export async function suggest(ctx: ToolContext, offerId: EventId,
                              o: { arrive?: unknown; depart?: unknown; why?: unknown }): Promise<Extract<Event, { op: 'booking.suggest' }>> {
  const state = ctx.store.state;
  const card = state.thread.offers.get(offerId);
  if (!card || card.tool !== 'approve_booking' || card.prompt.kind !== 'booking') throw new ToolError('there is no such request', 404);
  if (card.status !== 'open' && card.status !== 'snoozed') throw new ToolError('that request was already decided', 409);
  const m = mailOf(ctx);
  const why = typeof o.why === 'string' ? o.why.trim() : '';
  const headcount = typeof card.args['headcount'] === 'number' ? card.args['headcount'] : 1;
  const asked = stayAsked({ arrive: o.arrive, depart: o.depart, headcount, note: '' }, ctx.today);
  if (!why) throw new ToolError('suggesting other dates needs a reason: the guest is told it');
  if (!isEmail(card.args['email'])) throw new ToolError('that request is not in a shape to answer');
  const email = emailKey(card.args['email']);
  refuseClash(state, { email, ...asked, today: ctx.today, voice: 'member', ownPending: false, except: [offerId] });

  await decide(ctx, offerId, 'declined', why);
  const [e] = await ctx.store.append(ctx.who, {
    op: 'booking.suggest', request: offerId, email, arrive: asked.arrive, depart: asked.depart, why,
  });
  const line = e as Extract<Event, { op: 'booking.suggest' }>;
  const name = typeof card.args['name'] === 'string' && card.args['name'].trim() ? card.args['name'].trim() : 'there';
  await tell(ctx, m, email, suggestedMail({
    label: ctx.store.state.label, name, arrive: asked.arrive, depart: asked.depart, why,
    link: `${m.url}/book?suggest=${encodeURIComponent(line.id)}`, today: ctx.today,
  }), `the request is declined and the dates are on their booking page, but the email to ${name} did not go`);
  return line;
}

/**
 * A guest takes up dates suggested to them: a fresh request for those dates,
 * saying so, once. Anyone else's suggestion is as unknown as none.
 */
export async function acceptSuggestion(ctx: GuestCtx, suggestId: unknown): Promise<Offer> {
  const { email } = guestOf(ctx);
  const id = typeof suggestId === 'string' ? suggestId : '';
  const e = (await ctx.store.since(null)).find((x): x is Extract<Event, { op: 'booking.suggest' }> =>
    x.op === 'booking.suggest' && x.id === id && emailKey(x.email) === email);
  if (!e) throw new ToolError('there is no such suggestion', 404);
  const state = ctx.store.state;
  if ([...state.thread.offers.values()].some((o) => o.tool === 'approve_booking' && o.args['suggestion'] === id)) {
    throw new ToolError('you already asked for those dates', 409);
  }
  const was = state.thread.offers.get(e.request)?.args ?? {};
  return request(ctx, {
    arrive: e.arrive, depart: e.depart,
    headcount: typeof was['headcount'] === 'number' ? was['headcount'] : 1,
    note: typeof was['note'] === 'string' ? was['note'] : '',
  }, { suggestion: id, ...changeCarried(state, email, was) });
}

/**
 * What a request that changed a stay passes on to the request that follows it
 * (a suggestion taken up, or the change changed again): the stay it would
 * replace, while that still stands, and the dates it changed from.
 */
function changeCarried(state: State, email: string, args: Record<string, unknown>): Pick<RequestFrom, 'replacesStay' | 'changedFrom'> {
  const id = args['replacesStay'];
  const st = typeof id === 'string' ? state.stays.get(id) : undefined;
  if (!st || st.cancelled || st.email !== email) return {};
  return { replacesStay: id as EventId, changedFrom: { arrive: st.arrive, depart: st.depart } };
}

/** A change still waiting on a stay (named by its id or its request's), if there is one. */
function changeWaitingOn(state: State, id: string): Offer | undefined {
  const stay = state.stays.has(id) ? id : [...state.stays].find(([, s]) => s.request === id)?.[0];
  if (!stay) return undefined;
  return [...state.thread.offers.values()].find((o) => o.tool === 'approve_booking' && o.args['replacesStay'] === stay
    && (o.status === 'open' || o.status === 'snoozed'));
}

/** The guest's own stay (by its id or its request's) or request still waiting, with its dates; or not found. */
function ownStayOrRequest(state: State, email: string, id: string): { arrive: Day; depart: Day; stay: EventId | null } {
  let stay: [EventId, Stay] | undefined;
  const direct = state.stays.get(id);
  if (direct) stay = [id, direct];
  else for (const [sid, s] of state.stays) if (s.request === id) stay = [sid, s];
  if (stay) {
    if (stay[1].email !== email || stay[1].cancelled) throw new ToolError('there is no such request', 404);
    return { arrive: stay[1].arrive, depart: stay[1].depart, stay: stay[0] };
  }
  const o = state.thread.offers.get(id);
  if (!o || o.tool !== 'approve_booking' || !isGuest(o.who) || guestEmail(o.who) !== email
      || (o.status !== 'open' && o.status !== 'snoozed') || !isDay(o.args['arrive']) || !isDay(o.args['depart'])) {
    throw new ToolError('there is no such request', 404);
  }
  return { arrive: o.args['arrive'], depart: o.args['depart'], stay: null };
}

/**
 * A guest cancels one of their own. A request still waiting is withdrawn (the
 * fold marks it replaced: a guest never decides a card). A confirmed stay is
 * cancelled, its nights free from this line, and a card by the guest asks the
 * members to take its event off the Household calendar, which they
 * acknowledge by approving. The fold admits that card from a guest only as the
 * answer to their own cancel of that stay.
 *
 * Only their own is found: anyone else's id, or one never made, is a 404
 * before anything else. It then takes the card's turn: while a member is
 * approving or declining that request (its mail on the way), the guest is asked to try again in a moment,
 * so a confirmation never goes out for a request withdrawn under it. A stay
 * with a change waiting on it takes that change with it (the fold withdraws
 * it), so the change's turn is taken too.
 */
export async function cancelStay(ctx: GuestCtx, id: string, why: string): Promise<Event> {
  const { email } = guestOf(ctx);
  // Theirs, or not found, before anything else: another guest's request being
  // decided is as unknown as one never made, not "being decided".
  ownStayOrRequest(ctx.store.state, email, id);
  const busy = 'that request is being decided right now: try again in a moment';
  const change = changeWaitingOn(ctx.store.state, id);
  const cancel = () => oneAtATime(ctx, id, async () => {
    // Read inside the turn: an approval that finished just before makes this a stay.
    const was = ownStayOrRequest(ctx.store.state, email, id);
    const [e] = await ctx.store.append(ctx.who, { op: 'booking.cancel', stay: id, why });
    if (was.stay) {
      try {
        await raiseRelease(ctx, was.stay, ctx.who, e!.id);
      } catch (err) {
        // Today may have loaded between the cancel and here and asked about it
        // first (raiseReleaseCards): the fold keeps one card per stay, and that
        // one is this cancel's answer. The cancel is written; it is not an error.
        if (!releaseAsked(ctx.store.state, was.stay)) throw err;
      }
    }
    return e!;
  }, busy);
  return change ? oneAtATime(ctx, change.id, cancel, busy) : cancel();
}

/** Whether a card already asks to take this stay's event off the calendar, as the fold counts them. */
const releaseAsked = (state: State, stay: EventId): boolean => [...state.thread.offers.values()]
  .some((o) => o.tool === 'release_stay' && o.status !== 'replaced' && o.args['stay'] === stay);

/** The card that asks for a cancelled stay's event to come off the calendar, by `by`, answering `cancel`. */
async function raiseRelease(ctx: { store: Store; today: Day }, stay: EventId, by: Actor, cancel: EventId | null): Promise<Offer> {
  return offer({ store: ctx.store, who: by, today: ctx.today, proposals: new ProposalStore(), sid: null }, {
    tool: 'release_stay', args: { stay }, prompt: { kind: 'booking', ref: cancel }, by,
  });
}

/**
 * Cancelled stays whose event is still on the calendar and that no card has
 * ever asked about (the cancel landed and its card did not, or the cancel was
 * written some other way): asked about now, once each. Raised by whoever
 * cancelled while they still may write, else by the member looking. Run as
 * Today loads; a failure is logged and never stops the page.
 */
export async function raiseReleaseCards(ctx: ToolContext): Promise<Offer[]> {
  const out: Offer[] = [];
  const state = ctx.store.state;
  const asked = new Set([...state.thread.offers.values()]
    .filter((o) => o.tool === 'release_stay' && o.status !== 'replaced').map((o) => String(o.args['stay'])));
  for (const [id, s] of state.stays) {
    if (!s.cancelled || s.released || asked.has(id)) continue;
    const by = s.cancelledBy;
    const canWrite = by !== undefined && (isGuest(by) ? ctx.store.state.guests.has(guestEmail(by))
      : ctx.store.state.members.has(by));
    try {
      out.push(canWrite
        ? await raiseRelease(ctx, id, by!, s.cancelledIn ?? null)
        : await raiseRelease(ctx, id, ctx.who, s.cancelledIn ?? null));
    } catch (err) {
      console.warn(`[booking] no card was raised for the cancelled stay ${id}: ${(err as Error)?.message ?? String(err)}`);
    }
  }
  return out;
}

/**
 * A guest changes one of their own.
 *
 * A confirmed stay stands until the household decides: the change is a new
 * request that names the stay it would replace, saying what it changed from.
 * The stay keeps its nights for everyone else meanwhile (only this request's
 * own check lets them through); approving replaces it, declining leaves it.
 * One change waits on a stay at a time.
 *
 * A request still waiting is withdrawn and asked again: the new nights checked
 * first, with the old request's own counted free, then the old one withdrawn
 * and the new one raised. Refused, the old one stands. A request that was
 * itself a change passes on the stay it would replace.
 */
export async function changeStay(ctx: GuestCtx, id: string, body: Record<string, unknown>): Promise<Offer> {
  const { email } = guestOf(ctx);
  // Theirs, or not found, before anything else is said about it.
  const was = ownStayOrRequest(ctx.store.state, email, id);
  const asked = stayAsked(body, ctx.today);
  const changedFrom = { arrive: was.arrive, depart: was.depart };
  if (was.stay) {
    const stay = was.stay;
    return oneAtATime(ctx, `${stay}|change`, async () => {
      if (changeWaitingOn(ctx.store.state, stay)) {
        throw new ToolError('you already asked to change that stay: wait for their answer, or withdraw that change', 409);
      }
      return request(ctx, { ...asked }, { changedFrom, replacesStay: stay });
    }, 'that stay is being changed right now: try again in a moment');
  }
  const carried = changeCarried(ctx.store.state, email, ctx.store.state.thread.offers.get(id)?.args ?? {});
  refuseClash(ctx.store.state, {
    email, ...asked, today: ctx.today, voice: 'guest', ownPending: false, except: [id, ...(carried.replacesStay ? [carried.replacesStay] : [])],
  });
  await cancelStay(ctx, id, GUEST_CHANGE_WHY);
  return request(ctx, { ...asked }, { changedFrom, ...carried });
}


// ─── the household's own side: nights kept, and who may ask ──────────────────
//
// Members only, from the calendar and from Settings. Each is a line in the log
// by the member, with their reason; the routes call these after deciding the
// session belongs to the household friends book with.

/** The longest one block keeps, in nights: a season, not a year. */
export const MAX_BLOCK_NIGHTS = 90;
/** A reason is a phrase, for the members; a guest never sees it. */
export const REASON_MAX = 200;
/** A guest's name, as the household calls them. */
export const GUEST_NAME_MAX = 100;

type MemberCtx = { store: Store; who: Actor; today: Day };

/** A reason, trimmed, or a 400 saying what is wanted of it. */
function reasonOf(v: unknown, wanted: string): string {
  const why = typeof v === 'string' ? v.trim() : '';
  if (!why) throw new ToolError(wanted);
  if (why.length > REASON_MAX) throw new ToolError(`keep the reason under ${REASON_MAX} characters`);
  return why;
}

/**
 * Keep nights for the household, `from` (the first night) to `to` (the
 * morning after the last). Refused over a confirmed stay, naming it, and over
 * nights already kept; a request still waiting is no bar (its card says the
 * nights are now blocked, and approving it is refused). Guests see the nights
 * as taken, and never why.
 */
export async function blockNights(ctx: MemberCtx, o: Record<string, unknown>): Promise<Event> {
  const { from, to } = o;
  if (!isDay(from) || !isDay(to)) throw new ToolError('the first night and the morning after the last are days, such as 2026-12-24');
  if (!(to > from)) throw new ToolError('the morning after the last night must be after the first night');
  if (nightsOf(from, to).length > MAX_BLOCK_NIGHTS) throw new ToolError(`a block keeps at most ${MAX_BLOCK_NIGHTS} nights`);
  const why = reasonOf(o['why'], 'say why these nights are kept');
  if (to <= ctx.today) throw new ToolError(`${stayDates(from, to, ctx.today)} has passed`);
  const state = ctx.store.state;
  const stay = [...state.stays.values()].find((s) => !s.cancelled && s.arrive < to && from < s.depart);
  if (stay) {
    // In the words the request card's refusal uses for a stay.
    throw new ToolError(`those nights are taken: ${stay.name} is staying ${stayDates(stay.arrive, stay.depart, ctx.today)}`, 409);
  }
  const kept = [...state.stayBlocks.values()].find((b) => b.from < to && from < b.to);
  if (kept) throw new ToolError(`${stayDates(kept.from, kept.to, ctx.today)} is already kept for the household: “${kept.why}”`, 409);
  const [e] = await ctx.store.append(ctx.who, { op: 'booking.block', from, to, why });
  return e!;
}

/** Let kept nights go, with a reason; an unknown block is a 404. */
export async function unblockNights(ctx: MemberCtx, id: string, why: unknown): Promise<Event> {
  if (!ctx.store.state.stayBlocks.has(id)) throw new ToolError('there is no such block', 404);
  const reason = reasonOf(why, 'say why the nights are open again');
  const [e] = await ctx.store.append(ctx.who, { op: 'booking.unblock', block: id, why: reason });
  return e!;
}

/**
 * The words a waiting request's card adds when nights it asks for have been
 * kept for the household since: which, and why. Null when none are. For the
 * members only: it names the reason.
 */
export function blockedOver(state: State, args: Record<string, unknown>, today: Day): string | null {
  const { arrive, depart } = args;
  if (!isDay(arrive) || !isDay(depart) || arrive >= depart) return null;
  const over = [...state.stayBlocks.values()].filter((b) => b.from < depart && arrive < b.to)
    .sort((a, b) => (a.from < b.from ? -1 : 1));
  if (!over.length) return null;
  return `Nights now blocked: ${over.map((b) => {
    const from = b.from > arrive ? b.from : arrive;
    const to = b.to < depart ? b.to : depart;
    return `${stayDates(from, to, today)}, “${b.why}”`;
  }).join('; ')}`;
}

/** One entry on the guest list, as Settings shows it to members. */
export interface GuestRow { email: string; name: string; why: string; allowedBy: Actor; at: string }

/** The guest list, by name. */
export function guestList(state: State): GuestRow[] {
  return [...state.guests].map(([email, g]) => ({ email, name: g.name, why: g.why, allowedBy: g.allowedBy, at: g.at }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

/** Put someone on the list: their address, what the household calls them, and how it knows them. */
export async function allowGuest(ctx: MemberCtx, o: Record<string, unknown>): Promise<Event> {
  if (!isEmail(o['email'])) throw new ToolError('that is not an email address');
  const email = emailKey(o['email']);
  const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
  if (!name) throw new ToolError('give them a name, as you would say it');
  if (name.length > GUEST_NAME_MAX) throw new ToolError(`keep the name under ${GUEST_NAME_MAX} characters`);
  const why = reasonOf(o['why'], 'say how you know them');
  const already = ctx.store.state.guests.get(email);
  if (already) throw new ToolError(`${email} is already on the list, as ${already.name}`, 409);
  const [e] = await ctx.store.append(ctx.who, { op: 'guest.allow', email, name, why });
  return e!;
}

/** Take someone off the list, with a reason. Their stays and requests stand; the caller ends their sessions. */
export async function revokeGuest(ctx: MemberCtx, email: string, why: unknown): Promise<string> {
  const key = emailKey(email);
  if (!ctx.store.state.guests.has(key)) throw new ToolError('that address is not on the list', 404);
  const reason = reasonOf(why, 'say why they are coming off the list');
  await ctx.store.append(ctx.who, { op: 'guest.revoke', email: key, why: reason });
  return key;
}
