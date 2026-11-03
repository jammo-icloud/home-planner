/**
 * Sign-in, against the NAS's own accounts.
 *
 * The app has no password of its own. It takes what you type, asks DSM whether
 * that is really you, keeps only the session DSM hands back (in memory, never
 * on disk), and issues its own session. That means there is no second set of
 * credentials to manage or leak, and revoking a DSM account revokes this too.
 *
 * Same shape as the comic reader on the same NAS, with three deliberate
 * differences, noted where they occur.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DSM_URL = process.env['DSM_URL'] ?? 'http://host.docker.internal:5000';
/** The SYNO.API.Auth version signing in and out asks for; the check compares it with the NAS's range. */
export const AUTH_VERSION = 6;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const COOKIE = 'budget-session';

export interface Session {
  readonly who: string;
  readonly expiresAt: number;
  /** True when signed in through the local bypass rather than DSM. */
  readonly local: boolean;
  /**
   * Which household this person is looking at.
   *
   * On the session rather than in the log: two people can reasonably be in
   * different households at the same moment, and which one you have open is a
   * view, not a fact about the household.
   */
  household: string | null;
  /**
   * The DSM session this person signed in with, for calling the NAS as them.
   *
   * Memory only: never written to the sessions file, so a session carried
   * across a restart has none, and a local-bypass session never has one.
   */
  readonly sid: string | null;
  /**
   * Whether this person is an administrator, decided once at sign-in (DSM's
   * administrators group, or ADMIN_USER) and kept here only.
   *
   * Memory only, like the sid: never written to the sessions file, so a
   * session carried across a restart is not an admin until they sign in again.
   */
  readonly admin: boolean;
}

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** DSM says the account is real but wants its second factor. */
export class OtpRequired extends Error {
  constructor() { super('a one-time code is required'); this.name = 'OtpRequired'; }
}

/**
 * Kept on disk as hashes, so a deploy does not sign the phones out.
 *
 * Session tokens are bearer credentials, and a file of them on the same volume
 * as the budget would be a permanent key next to the thing it unlocks. So the
 * file never holds a token: each session is filed under the SHA-256 of its
 * token, and the token itself exists only in the cookie. A token is 32 random
 * bytes, so the hash cannot be turned back into one, and presented as a cookie
 * a hash opens nothing. Reading the file tells you who is signed in until
 * when — not how to be them.
 *
 * Bypass sessions stay in memory. Their sandbox is discarded on restart, so a
 * bypass session that outlived it would point at nothing.
 *
 * Writes are synchronous: issue() hands back a token there and then, and this
 * changes a few times a week — at sign-in, sign-out and switching household.
 * A file that cannot be read costs everyone a sign-in, never the boot; one that
 * cannot be written is reported and sessions carry on in memory, which is how
 * this always worked.
 */
export class Sessions {
  #byHash = new Map<string, Session>();
  #now: () => number;
  #path: string | null;

  constructor(opts: { path?: string; now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now;
    this.#path = opts.path ?? null;
    this.#load();
  }

  issue(
    who: string,
    opts: { local?: boolean; household?: string | null; sid?: string | null; admin?: boolean } = {},
  ): string {
    this.#sweep();
    const token = randomBytes(32).toString('hex');
    this.#byHash.set(hash(token), {
      who, expiresAt: this.#now() + SESSION_TTL_MS, local: opts.local === true,
      household: opts.household ?? null, sid: opts.sid ?? null, admin: opts.admin === true,
    });
    if (opts.local !== true) this.#save();
    return token;
  }

  /** Move a live session to another household without signing in again. */
  select(token: string | undefined, household: string | null): void {
    const s = this.get(token);
    if (!s || s.household === household) return;
    s.household = household;
    if (!s.local) this.#save();
  }

  get(token: string | undefined): Session | null {
    if (!token) return null;
    const key = hash(token);
    const s = this.#byHash.get(key);
    if (!s) return null;
    if (s.expiresAt < this.#now()) { this.#byHash.delete(key); this.#save(); return null; }
    return s;
  }

  revoke(token: string | undefined): void {
    if (token && this.#byHash.delete(hash(token))) this.#save();
  }

  get size(): number { this.#sweep(); return this.#byHash.size; }

  #sweep(): void {
    const now = this.#now();
    let dropped = false;
    for (const [h, s] of this.#byHash) if (s.expiresAt < now) { this.#byHash.delete(h); dropped = true; }
    if (dropped) this.#save();
  }

  #load(): void {
    if (!this.#path) return;
    let text: string;
    try {
      text = readFileSync(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      console.warn(`[budget] cannot read ${this.#path} (${(err as Error).message}) — everyone signs in again`);
      return;
    }
    try {
      const parsed = JSON.parse(text) as { sessions?: Stored[] };
      const now = this.#now();
      for (const x of parsed.sessions ?? []) {
        if (typeof x.hash !== 'string' || typeof x.who !== 'string' || typeof x.expiresAt !== 'number') continue;
        if (x.expiresAt < now) continue;
        this.#byHash.set(x.hash, {
          who: x.who, expiresAt: x.expiresAt, local: false,
          household: typeof x.household === 'string' ? x.household : null,
          sid: null, admin: false,
        });
      }
    } catch (err) {
      console.warn(`[budget] ${this.#path} is damaged (${(err as Error).message}) — everyone signs in again`);
    }
  }

  #save(): void {
    if (!this.#path) return;
    const sessions: Stored[] = [];
    for (const [h, s] of this.#byHash) {
      if (!s.local) sessions.push({ hash: h, who: s.who, expiresAt: s.expiresAt, household: s.household });
    }
    // Whole file, written aside and renamed over, so a crash mid-write leaves
    // the previous version rather than half of this one.
    const tmp = `${this.#path}.tmp`;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ sessions }) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.#path);
    } catch (err) {
      console.warn(`[budget] cannot write ${this.#path} (${(err as Error).message}) — `
        + 'sessions are in memory only until this is fixed, and a restart will sign everyone out');
    }
  }
}

// ─── guests ──────────────────────────────────────────────────────────────────

const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** The guest's cookie: its own name, on its own path, never read outside `/book`. */
export const GUEST_COOKIE = 'book-guest';

export interface GuestSession { readonly email: string; readonly expiresAt: number }

/**
 * A friend signed in to the booking page, by the email they proved they read.
 *
 * Kept apart from `Sessions` on purpose: a different class, a different map, a
 * different cookie on a different path, so a guest token handed to a member
 * route is simply nobody. Memory only, filed under the token's SHA-256 like a
 * member's; nothing is written to disk, so a restart signs every guest out and
 * they ask for a new link. That is accepted: it costs a friend an email.
 */
export class GuestSessions {
  #byHash = new Map<string, GuestSession>();
  #now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now;
  }

  issue(email: string): string {
    this.#sweep();
    const token = randomBytes(32).toString('hex');
    this.#byHash.set(hash(token), { email, expiresAt: this.#now() + GUEST_TTL_MS });
    return token;
  }

  get(token?: string): GuestSession | null {
    if (!token) return null;
    const key = hash(token);
    const g = this.#byHash.get(key);
    if (!g) return null;
    if (g.expiresAt < this.#now()) { this.#byHash.delete(key); return null; }
    return g;
  }

  revoke(token?: string): void {
    if (token) this.#byHash.delete(hash(token));
  }

  /** Every session of one address, as the list keys it: a guest taken off the list is signed out everywhere. */
  revokeEmail(email: string): void {
    this.revokeAll([email]);
  }

  /** Every session of each of these addresses, keyed as revokeEmail keys one: a household's guests, when booking leaves it. */
  revokeAll(emails: Iterable<string>): void {
    const keys = new Set([...emails].map((e) => e.trim().toLowerCase()));
    if (!keys.size) return;
    for (const [h, g] of this.#byHash) if (keys.has(g.email.trim().toLowerCase())) this.#byHash.delete(h);
  }

  #sweep(): void {
    const now = this.#now();
    for (const [h, g] of this.#byHash) if (g.expiresAt < now) this.#byHash.delete(h);
  }
}

/** What is on disk for a session: never the token, only its hash. */
interface Stored { hash: string; who: string; expiresAt: number; household: string | null }

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

// ─── DSM ─────────────────────────────────────────────────────────────────────

export type Fetch = typeof globalThis.fetch;

/**
 * Ask DSM whether these credentials are real.
 *
 * Posted as a form body rather than appended to the URL. DSM accepts either,
 * but a query string puts the password into its access log, and into anything
 * else along the way that records URLs.
 */
export async function checkWithDsm(
  username: string,
  password: string,
  otpCode: string | undefined,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ sid: string }> {
  // `session=Calendar` makes this DSM session one the Calendar and Contacts
  // APIs will accept, which a bare login would not be.
  const body = new URLSearchParams({
    api: 'SYNO.API.Auth', version: String(AUTH_VERSION), method: 'login',
    account: username, passwd: password, session: 'Calendar', format: 'sid',
  });
  if (otpCode) body.set('otp_code', otpCode);

  let res: Response;
  try {
    res = await fetchImpl(`${DSM_URL}/webapi/entry.cgi`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // Unreachable DSM is an outage, never an invitation. The comic reader falls
    // back to accepting any credentials when it cannot reach DSM and NODE_ENV
    // is unset — one missing variable away from an open door. This refuses.
    //
    // The cause is named because these fail differently and are fixed
    // differently: a self-signed DSM certificate looks exactly like the machine
    // being down unless you say so.
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause?.code
      ?? (err as { cause?: { message?: string } })?.cause?.message
      ?? (err as Error)?.name ?? 'unknown';
    const detail = /CERT|SSL|DEPTH_ZERO|SELF_SIGNED/i.test(cause)
      ? 'point DSM_URL at http://…:5000 on the internal network, or install a certificate '
        + 'the container trusts'
      : /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/i.test(cause)
        ? 'check DSM_URL, and that extra_hosts maps host.docker.internal to host-gateway'
        : /Timeout|Abort/i.test(cause) ? 'it did not answer within five seconds' : '';
    // The code is always named, matched or not. A first deployment fails in a
    // way nobody has seen before, and "cannot reach the NAS" on its own sends
    // you looking at the machine when the problem is a certificate or a mapping.
    throw new AuthError(
      `cannot reach the NAS to check that sign-in (${cause})`
      + `${detail ? ` — ${detail}` : ''}`, 502);
  }

  // Something answered — but a wrong port can be answered by anything. A Mac
  // holds 5000 for AirPlay, which replies 403 with an empty body; read blindly,
  // that is a JSON parse error, and anything shaped differently would read as
  // a wrong password and send you to retype it. Name what answered instead.
  let data: { success?: unknown; error?: { code?: number }; data?: { sid?: string } };
  try {
    data = await res.json() as typeof data;
  } catch {
    data = {};
  }
  if (typeof data?.success !== 'boolean') {
    const type = res.headers?.get('content-type');
    throw new AuthError(
      `something answered at DSM_URL but it is not DSM (HTTP ${res.status ?? '?'}, `
      + `${type ? `content-type ${type}` : 'no content-type'}) — check that DSM_URL's port is DSM's`, 502);
  }
  if (!data.success) {
    if (data.error?.code === 403) throw new OtpRequired();
    throw new AuthError('that username or password is not right');
  }

  // The DSM session is kept, so the calendar, contacts and files can be read
  // as the person who signed in. It is a NAS-wide credential, so it stays on
  // the in-memory Session: never written to disk, never logged, never sent to
  // the browser, and gone when the budget session ends or the process restarts.
  // The password is still not kept.
  const sid = data.data?.sid ?? '';
  if (!sid) throw new AuthError('DSM answered without a session id', 502);
  return { sid };
}

// ─── the local bypass ────────────────────────────────────────────────────────

/**
 * A development sign-in with the whole app and none of the household.
 *
 * Enabled only by setting DEV_USER, and it does not hand out access — the
 * server points a bypass session at a different log entirely, so every screen
 * works against data that is not yours. Nothing here can reach the real budget,
 * which is why it can be allowed to skip DSM at all.
 */
export const localBypassUser = (): string | null => process.env['DEV_USER']?.trim() || null;

// ─── cookies ─────────────────────────────────────────────────────────────────

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * `Secure` is set unless explicitly disabled, because the phones reach this
 * over TLS and a session cookie that also travels in clear is worth having on
 * neither. Set COOKIE_INSECURE=1 for plain-HTTP LAN use.
 */
export const sessionCookie = (token: string): string => {
  const bits = [`${COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (process.env['COOKIE_INSECURE'] !== '1') bits.push('Secure');
  return bits.join('; ');
};

export const clearedCookie = (): string =>
  `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

/**
 * The guest's cookie. `Path=/book`, so the browser never sends it to `/api/`,
 * and it would open nothing there if it did. `Secure` on the same terms as
 * the member's.
 */
export const guestCookie = (token: string): string => {
  const bits = [`${GUEST_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/book',
    `Max-Age=${Math.floor(GUEST_TTL_MS / 1000)}`];
  if (process.env['COOKIE_INSECURE'] !== '1') bits.push('Secure');
  return bits.join('; ');
};

export const clearedGuestCookie = (): string =>
  `${GUEST_COOKIE}=; HttpOnly; SameSite=Lax; Path=/book; Max-Age=0`;

/** Constant-time compare, so a name cannot be probed a character at a time. */
export const sameUser = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
