/**
 * The NAS's connections: the settings that belong to the whole deployment, not
 * to any one household. The public address, who may sign in, the booking page,
 * the outgoing mail, the Claude key and the Census and EIA keys.
 *
 * They live in one file, `connectors.json`, and nowhere else. The secrets are
 * here, so the file is mode 0600, is never written into a log, and is never
 * sent back to a browser: only whether a value is set.
 *
 * Values are read when they are used. `resolvedEnv()` lays what is saved over
 * the deployment's environment each time it is asked, so a saved change takes
 * effect on the next call with no restart and no rebuild.
 *
 * This module imports nothing from `synology.ts`, `claude.ts` or `server.ts`,
 * so every one of them can import it without a cycle.
 */

import { readFileSync } from 'node:fs';
import { chmod, rename, writeFile } from 'node:fs/promises';

export type Saved<T> = ({ value: T } | { off: true }) & { by: string; at: string };

export interface MailValue { host: string; port: number; user: string; pass: string; from: string; plainAuth: boolean }

export interface Connectors {
  version: 1;
  publicUrl?: Saved<string>; signIn?: Saved<string[]>; bookUrl?: Saved<string>;
  mail?: Saved<MailValue>; mailTest?: { at: string; to: string; ok: boolean; words: string };
  claude?: Saved<string>; claudeTest?: { at: string; ok: boolean; words: string; worked?: string };
  census?: Saved<string>; eia?: Saved<string>;
  probed?: { contactsVersion: { version: number; min: number; max: number; at: string } };
}

export type SavedKey = 'publicUrl' | 'signIn' | 'bookUrl' | 'mail' | 'claude' | 'census' | 'eia';
export type ValueOf<K extends SavedKey> = K extends 'signIn' ? string[] : K extends 'mail' ? MailValue : string;
export type Change<K extends SavedKey> = { value: ValueOf<K> } | { off: true } | { clear: true };
export type Source = 'saved' | 'off' | 'from the deployment' | 'default';

/** Which variables each key stands in for. A saved value is written over them; a saved off deletes them. */
export const VARIABLES: Readonly<Record<SavedKey, readonly string[]>> = {
  publicUrl: ['DSM_PUBLIC_URL'], signIn: ['ALLOWED_USERS'], bookUrl: ['BOOK_URL'],
  mail: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_PLAIN_AUTH'],
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], census: ['CENSUS_API_KEY'], eia: ['EIA_API_KEY'],
};

const SAVED_KEYS = Object.keys(VARIABLES) as SavedKey[];

// ─── shapes ───────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The value of a key, if it is the right shape for that key. */
function valueFits(key: SavedKey, v: unknown): boolean {
  if (key === 'signIn') return Array.isArray(v) && v.length > 0 && v.every(isNonEmpty);
  if (key === 'mail') {
    return isObject(v)
      && isNonEmpty(v['host']) && isNonEmpty(v['user']) && isNonEmpty(v['pass']) && isNonEmpty(v['from'])
      && typeof v['port'] === 'number' && Number.isInteger(v['port']) && v['port'] >= 1 && v['port'] <= 65535
      && typeof v['plainAuth'] === 'boolean';
  }
  return isNonEmpty(v);
}

function savedFits(key: SavedKey, e: unknown): boolean {
  if (!isObject(e) || !isText(e['by']) || !isText(e['at'])) return false;
  // Who may sign in is never off: such an entry would delete ALLOWED_USERS.
  if ('off' in e) return key !== 'signIn' && e['off'] === true && !('value' in e);
  return valueFits(key, e['value']);
}

const mailTestFits = (e: unknown): boolean =>
  isObject(e) && isText(e['at']) && isText(e['to']) && typeof e['ok'] === 'boolean' && isText(e['words']);

const claudeTestFits = (e: unknown): boolean =>
  isObject(e) && isText(e['at']) && typeof e['ok'] === 'boolean' && isText(e['words'])
  && (e['worked'] === undefined || isText(e['worked']));

function probedFits(e: unknown): boolean {
  if (!isObject(e)) return false;
  const c = e['contactsVersion'];
  return isObject(c) && isNumber(c['version']) && isNumber(c['min']) && isNumber(c['max']) && isText(c['at']);
}

// ─── the copy in memory, and the file it came from ────────────────────────────

let state: Connectors = { version: 1 };
let filePath: string | null = null;
/** Saves run one after another, so two at once cannot lose each other's change or share a .tmp. */
let tail: Promise<unknown> = Promise.resolve();

function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  tail = run.catch(() => undefined);
  return run;
}

/**
 * Read at boot. A file that does not parse is reported and ignored (nothing in
 * memory, the file untouched); one key of the wrong shape is dropped and named.
 * The words never quote the file: it holds secrets.
 */
export function loadConnectors(path: string): { problems: string[] } {
  state = { version: 1 };
  filePath = path;
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { problems: [] };
    return { problems: ['connectors.json could not be read, so it is ignored and left as it was.'] };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { problems: ['connectors.json does not parse, so it is ignored and left as it was.'] }; }
  if (!isObject(parsed) || parsed['version'] !== 1) {
    return { problems: ['connectors.json is not a version 1 file, so it is ignored and left as it was.'] };
  }

  const problems: string[] = [];
  const kept: Record<string, unknown> = { version: 1 };
  const keep = (key: string, fits: (e: unknown) => boolean): void => {
    const e = parsed[key];
    if (e === undefined) return;
    if (fits(e)) kept[key] = e;
    else problems.push(`connectors.json: ${key} is not the shape it should be, so it is ignored.`);
  };
  for (const key of SAVED_KEYS) keep(key, (e) => savedFits(key, e));
  keep('mailTest', mailTestFits);
  keep('claudeTest', claudeTestFits);
  keep('probed', probedFits);
  state = kept as unknown as Connectors;
  return { problems };
}

/** The copy in memory. Empty `{ version: 1 }` before load, and for tests that never load. */
export function connectors(): Readonly<Connectors> {
  return state;
}

/** The file whole, to `<path>.tmp` and renamed over, then the copy in memory: a failed write leaves both as they were. */
async function commit(next: Connectors): Promise<void> {
  if (filePath !== null) {
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, filePath);
  }
  state = next;
}

/** Write the file whole (0600, tmp then rename), then memory. Before `loadConnectors`, memory only. */
export async function saveConnector<K extends SavedKey>(key: K, change: Change<K>, by: string, now: Date = new Date()): Promise<void> {
  if ('off' in change && key === 'signIn') throw new Error('signIn cannot be off');
  if ('value' in change && !valueFits(key, change.value)) throw new Error(`${key} is not the shape it should be`);
  await inTurn(async () => {
    const next: Record<string, unknown> = { ...state };
    if ('clear' in change) {
      delete next[key];
      if (key === 'mail') delete next['mailTest'];
      if (key === 'claude') delete next['claudeTest'];
    } else {
      next[key] = { ...change, by, at: now.toISOString() };
    }
    await commit(next as unknown as Connectors);
    if (key === 'claude') claudeAccepted();
  });
}

// ─── what the NAS was asked ───────────────────────────────────────────────────

/** Keep the Contacts version the NAS answered, so it is asked once per deployment. */
export async function recordProbe(p: { version: number; min: number; max: number; at: string }): Promise<void> {
  await inTurn(() => commit({ ...state, probed: { contactsVersion: p } }));
}

/** Forget it, so the next Contacts call asks the NAS again. */
export async function forgetProbe(): Promise<void> {
  await inTurn(() => {
    const { probed: _gone, ...rest } = state;
    return commit(rest);
  });
}

// ─── the Claude key's live health, in memory only ─────────────────────────────

let rejectedAt: number | null = null;

/** A live 401. Kept in memory only: a restart forgets it and the next live call finds out again. */
export function claudeRejected(at: number): void {
  rejectedAt = at;
}

/** A live success, a passing Test, or a new key saved: the key is not known to be bad. */
export function claudeAccepted(): void {
  rejectedAt = null;
}

export function claudeHealth(): { readonly rejectedAt: number | null } {
  return { rejectedAt };
}

export async function recordTest(key: 'mailTest', r: NonNullable<Connectors['mailTest']>): Promise<void>;
export async function recordTest(key: 'claudeTest', r: NonNullable<Connectors['claudeTest']>): Promise<void>;
export async function recordTest(key: 'mailTest' | 'claudeTest', r: object): Promise<void> {
  await inTurn(() => commit({ ...state, [key]: r } as Connectors));
}

/**
 * The last test, only if it speaks for the value in use now: always for the
 * deployment's value, and for a saved one only if it was not made before the
 * save. A test of the mail server or key before the last save counts nowhere.
 * Null with none (a clear deletes it).
 */
export function currentTest<K extends 'mailTest' | 'claudeTest'>(key: K): NonNullable<Connectors[K]> | null {
  const test = state[key] as NonNullable<Connectors[K]> | undefined;
  if (!test) return null;
  const saved = state[key === 'mailTest' ? 'mail' : 'claude'];
  return saved && Date.parse(test.at) < Date.parse(saved.at) ? null : test;
}

// ─── the environment as it stands ─────────────────────────────────────────────

/** The deployment's environment with every saved value written over its variables, and every saved off deleting them. Read per use. */
export function resolvedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of SAVED_KEYS) {
    const saved = state[key];
    if (!saved) continue;
    for (const name of VARIABLES[key]) delete out[name];
    if ('off' in saved) continue;
    const value: unknown = saved.value;
    switch (key) {
      case 'publicUrl': out['DSM_PUBLIC_URL'] = value as string; break;
      case 'bookUrl': out['BOOK_URL'] = value as string; break;
      case 'census': out['CENSUS_API_KEY'] = value as string; break;
      case 'eia': out['EIA_API_KEY'] = value as string; break;
      case 'claude': out['ANTHROPIC_API_KEY'] = value as string; break;
      case 'signIn': out['ALLOWED_USERS'] = (value as string[]).join(','); break;
      case 'mail': {
        const m = value as MailValue;
        out['SMTP_HOST'] = m.host; out['SMTP_PORT'] = String(m.port); out['SMTP_USER'] = m.user;
        out['SMTP_PASS'] = m.pass; out['SMTP_FROM'] = m.from;
        if (m.plainAuth) out['SMTP_PLAIN_AUTH'] = '1';
        break;
      }
    }
  }
  return out;
}

/** Where a key's value comes from right now, in the words the screens use. */
export function sourceOf(key: SavedKey, env: NodeJS.ProcessEnv = process.env): Source {
  const saved = state[key];
  if (saved) return 'off' in saved ? 'off' : 'saved';
  return VARIABLES[key].some((name) => (env[name] ?? '') !== '') ? 'from the deployment' : 'default';
}

/** The admin who saved last, for "who can fix it" words; null when nothing is saved. */
export function lastSavedBy(): string | null {
  let latest: { by: string; at: string } | null = null;
  for (const key of SAVED_KEYS) {
    const saved = state[key];
    if (saved && (latest === null || Date.parse(saved.at) >= Date.parse(latest.at))) latest = saved;
  }
  return latest?.by ?? null;
}

/** Forget everything in memory and the file's path: for tests only. */
export function resetConnectors(): void {
  state = { version: 1 };
  filePath = null;
  rejectedAt = null;
}
