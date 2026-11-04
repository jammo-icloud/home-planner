import { createHash, randomBytes } from 'node:crypto';

/** How long a setup link works. Short, because it is a bearer credential in a QR code. */
export const SETUP_CODE_TTL_MS = 10 * 60_000;

export interface SetupEntry {
  readonly member: string;
  readonly household: string;
  readonly origin: string;
  readonly dsmPublicUrl: string | null;
  readonly expiresAt: number;
}

export interface PhoneCodes {
  issue(o: { member: string; household: string; origin: string; dsmPublicUrl: string | null }):
    { code: string; url: string; expiresAt: number };
  /** The entry, if live, without spending it. */
  peek(code: string): SetupEntry | null;
  /** The entry, if live, spent by this call. */
  redeem(code: string): SetupEntry | null;
}

// Kept as a hash, as auth.ts keeps session tokens, so memory never holds a usable code.
const hash = (code: string): string => createHash('sha256').update(code).digest('hex');

const SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function createPhoneCodes(now: () => number = Date.now): PhoneCodes {
  const byHash = new Map<string, SetupEntry>();
  const byMember = new Map<string, string>();

  const drop = (h: string): void => {
    const e = byHash.get(h);
    if (!e) return;
    byHash.delete(h);
    if (byMember.get(e.member) === h) byMember.delete(e.member);
  };

  const live = (code: unknown): { h: string; entry: SetupEntry } | null => {
    if (typeof code !== 'string' || !SHAPE.test(code)) return null;
    const h = hash(code);
    const entry = byHash.get(h);
    if (!entry) return null;
    if (entry.expiresAt <= now()) { drop(h); return null; }
    return { h, entry };
  };

  return {
    issue(o) {
      for (const [h, e] of byHash) if (e.expiresAt <= now()) drop(h);
      // A member's earlier code stops working the moment a new one is made.
      const earlier = byMember.get(o.member);
      if (earlier) drop(earlier);
      const code = randomBytes(32).toString('base64url');
      const expiresAt = now() + SETUP_CODE_TTL_MS;
      const h = hash(code);
      byHash.set(h, {
        member: o.member, household: o.household,
        origin: o.origin, dsmPublicUrl: o.dsmPublicUrl, expiresAt,
      });
      byMember.set(o.member, h);
      return { code, url: `${o.origin}/setup/${code}`, expiresAt };
    },
    peek: (code) => live(code)?.entry ?? null,
    redeem(code) {
      const found = live(code);
      if (!found) return null;
      drop(found.h);
      return found.entry;
    },
  };
}

/** The origin itself when it may receive a phone, else null: https anywhere, http only on a loopback host. */
export function acceptedOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
  if (u.protocol === 'https:') return u.origin;
  const loopback = u.hostname === 'localhost' || u.hostname.endsWith('.localhost')
    || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  return u.protocol === 'http:' && loopback ? u.origin : null;
}

/**
 * The origin when it can be put on a Home Screen: http or https on any host,
 * nothing after the host. Looser than acceptedOrigin because this link carries
 * no credential, only the page's own address.
 */
export function homeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
}

/** The address a phone scans to open the page with Safari's add-to-Home-Screen banner. */
export const homeLink = (origin: string): string => `${origin}/?add=home`;
