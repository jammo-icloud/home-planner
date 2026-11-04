/**
 * What This NAS group of Settings shows: one row for each thing the NAS connects to,
 * each on, off or broken, with where its value comes from and one line saying
 * how it stands. Worked out on every load from the environment as it stands
 * (`resolvedEnv()`), what is saved in `connectors.json` and what the server
 * already knows (Drive answering, booking, the Claude key's live health).
 *
 * No secret is in a row: the mail password, the Claude key and the Census and
 * EIA keys are only `set` or `not set`.
 */

import { claudeHealth, connectors, currentTest, sourceOf } from './connectors.ts';
import type { Source } from './connectors.ts';
import { bookingOffWords, dayWords } from './booking.ts';
import type { BookingStatus } from './booking.ts';
import { folderOf } from './folders.ts';
import { dsmPublicUrl } from './settings.ts';

export type RowId = 'claude' | 'drive' | 'calendar' | 'mail' | 'booking' | 'sign-in' | 'pricing';

export const ROW_ORDER: readonly RowId[] = ['claude', 'drive', 'calendar', 'mail', 'booking', 'sign-in', 'pricing'];

/** Each row's name, as This NAS heads it and an admin's Today card names it. */
export const ROW_NAME: Readonly<Record<RowId, string>> = {
  claude: 'Claude', drive: 'Synology Drive', calendar: 'Where phones reach the NAS', mail: 'Mail',
  booking: 'Booking address', 'sign-in': 'Who may sign in', pricing: 'Pricing sources',
};

export interface ConnectorRow {
  readonly id: RowId;
  readonly state: 'on' | 'off' | 'broken';
  readonly source: Source;
  /** One line, in every state. */
  readonly line: string;
  /** What the row's form starts from; secrets as 'set' | 'not set', never their values. */
  readonly form: Readonly<Record<string, unknown>>;
}

const OFF_ON_PURPOSE = 'Off on purpose';
/** The Claude row's broken line: a live 401, or a Test that got one. testClaude says it in lower case. */
const KEY_REJECTED = 'The key has expired or been revoked';

const setOrNot = (v: string | undefined): 'set' | 'not set' => (v ?? '') !== '' ? 'set' : 'not set';

/** `Nov 3, 2026`, the UTC day of an ISO time: the NAS's rows belong to no household's zone. */
const dateOf = (iso: string): string => `${dayWords(iso.slice(0, 10))}, ${iso.slice(0, 4)}`;

function claudeRow(env: NodeJS.ProcessEnv): ConnectorRow {
  const source = sourceOf('claude', env);
  const key = env['ANTHROPIC_API_KEY'] || env['ANTHROPIC_AUTH_TOKEN'] || '';
  const form = { key: setOrNot(key) };
  if (source === 'off') return { id: 'claude', state: 'off', source, line: OFF_ON_PURPOSE, form };
  if (!key) return { id: 'claude', state: 'off', source, line: 'No key: Claude is off on this NAS', form };
  // A test of a key saved over since says nothing about this one.
  const counted = currentTest('claudeTest');
  if (claudeHealth().rejectedAt !== null || (counted && !counted.ok && counted.words.toLowerCase() === KEY_REJECTED.toLowerCase())) {
    return { id: 'claude', state: 'broken', source, line: KEY_REJECTED, form };
  }
  if (counted && !counted.ok) return { id: 'claude', state: 'broken', source, line: `The last test failed: ${counted.words}`, form };
  const worked = counted?.worked;
  return { id: 'claude', state: 'on', source, line: worked ? `Key set, last worked ${dateOf(worked)}` : 'Key set, not tested yet', form };
}

function driveRow(
  households: readonly { id: string; label: string; owner: string | null }[], reachable: boolean | null,
): ConnectorRow {
  const rows = households.map((h) => {
    const folder = folderOf(h.id);
    return { label: h.label, owner: h.owner, folder: folder ? `${folder.team}/${folder.folder}` : 'not chosen' };
  });
  const chosen = rows.filter((r) => r.folder !== 'not chosen').length;
  const form = { households: rows };
  // DSM_URL is the deployment's: Drive is reached wherever it says.
  const source: Source = 'from the deployment';
  if (reachable === false) return { id: 'drive', state: 'broken', source, line: 'Drive did not answer your session', form };
  // Without a session nothing was asked: Drive is not known to be failing.
  if (reachable === null) return { id: 'drive', state: 'on', source, line: 'Sign in again to look at Drive', form };
  return {
    id: 'drive', state: 'on', source, form,
    line: `Reachable; ${chosen} of ${households.length} households have chosen a folder`,
  };
}

function calendarRow(env: NodeJS.ProcessEnv): ConnectorRow {
  const source = sourceOf('publicUrl', env);
  const raw = env['DSM_PUBLIC_URL']?.trim() ?? '';
  const form = { address: raw || null };
  if (source === 'off') return { id: 'calendar', state: 'off', source, line: OFF_ON_PURPOSE, form };
  if (!raw) return { id: 'calendar', state: 'off', source, line: 'Not set: phones are told to ask the owner', form };
  const origin = dsmPublicUrl(raw);
  if (origin === null) return { id: 'calendar', state: 'broken', source, line: 'The saved address no longer parses', form };
  return { id: 'calendar', state: 'on', source, line: origin, form };
}

function mailRow(env: NodeJS.ProcessEnv): ConnectorRow {
  const source = sourceOf('mail', env);
  // The last address tested prefills the next test, whether that test still counts or not.
  const test = connectors().mailTest;
  const port = Number(env['SMTP_PORT']);
  const form = {
    host: env['SMTP_HOST'] ?? null, port: Number.isInteger(port) && port > 0 ? port : null, user: env['SMTP_USER'] ?? null,
    pass: setOrNot(env['SMTP_PASS']), from: env['SMTP_FROM'] ?? null, plainAuth: env['SMTP_PLAIN_AUTH']?.trim() === '1',
    lastTo: test?.to ?? null,
  };
  if (source === 'off') return { id: 'mail', state: 'off', source, line: OFF_ON_PURPOSE, form };
  if (!env['SMTP_HOST']?.trim()) return { id: 'mail', state: 'off', source, line: 'Not set: no mail goes out', form };
  const where = `${env['SMTP_HOST'].trim()}:${env['SMTP_PORT']?.trim() ?? ''}`;
  // A test of a mail server saved over since counts nowhere: the form still offers its address.
  const counted = currentTest('mailTest');
  if (!counted) return { id: 'mail', state: 'on', source, line: `${where}, not tested yet`, form };
  if (!counted.ok) return { id: 'mail', state: 'broken', source, line: `The last test failed: ${counted.words}`, form };
  return { id: 'mail', state: 'on', source, line: `${where}, last test ok on ${dateOf(counted.at)}`, form };
}

function bookingRow(env: NodeJS.ProcessEnv, booking: BookingStatus, label: string | null): ConnectorRow {
  const source = sourceOf('bookUrl', env);
  const form = { address: env['BOOK_URL']?.trim() || null };
  if (!booking.on) {
    // The off words mostly say "Booking is off" already; "Off: " only before those that do not.
    const words = bookingOffWords(booking.why);
    return { id: 'booking', state: 'off', source, line: words.startsWith('Booking is off') ? words : `Off: ${words}`, form };
  }
  return {
    id: 'booking', state: 'on', source, form,
    line: `On for ${label ?? booking.config.household} at ${booking.config.url}/book`,
  };
}

function signInRow(env: NodeJS.ProcessEnv): ConnectorRow {
  const names = (env['ALLOWED_USERS'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const line = names.length === 0 ? 'Any DSM account' : `${names.length} ${names.length === 1 ? 'account' : 'accounts'}`;
  return { id: 'sign-in', state: 'on', source: sourceOf('signIn', env), line, form: { names } };
}

function pricingRow(env: NodeJS.ProcessEnv): ConnectorRow {
  const census = setOrNot(env['CENSUS_API_KEY']) === 'set';
  const eia = setOrNot(env['EIA_API_KEY']) === 'set';
  // Two keys, one row: anything saved speaks for it, then the deployment's, then off, then nothing.
  const sources = [sourceOf('census', env), sourceOf('eia', env)];
  const source = (['saved', 'from the deployment', 'off'] as const).find((s) => sources.includes(s)) ?? 'default';
  const line = census && eia ? 'Census and EIA keys set' : census ? 'Census key set' : eia ? 'EIA key set'
    : 'No keys: pricing from public data is off';
  return {
    id: 'pricing', state: census || eia ? 'on' : 'off', source, line,
    form: { census: census ? 'set' : 'not set', eia: eia ? 'set' : 'not set' },
  };
}

/** Every row, in ROW_ORDER, from the environment as it stands (`resolvedEnv()`), and the rule that makes an admin. */
export function connectorsView(o: {
  env: NodeJS.ProcessEnv; households: readonly { id: string; label: string; owner: string | null }[];
  driveReachable: boolean | null; booking: BookingStatus; bookingLabel: string | null; adminRule: 'group' | 'ADMIN_USER';
}): { rows: ConnectorRow[]; adminRule: 'group' | 'ADMIN_USER' } {
  const rows: Record<RowId, ConnectorRow> = {
    claude: claudeRow(o.env),
    drive: driveRow(o.households, o.driveReachable),
    calendar: calendarRow(o.env),
    mail: mailRow(o.env),
    booking: bookingRow(o.env, o.booking, o.bookingLabel),
    'sign-in': signInRow(o.env),
    pricing: pricingRow(o.env),
  };
  return { rows: ROW_ORDER.map((id) => rows[id]), adminRule: o.adminRule };
}

/** The rows whose fix is the admin's alone. */
const ADMINS: ReadonlySet<RowId> = new Set<RowId>(['claude', 'calendar', 'mail', 'pricing']);

/**
 * The rows an admin's Today names: of Claude, Where phones reach the NAS, Mail and
 * Pricing sources, those with nothing saved and nothing in `.env` (source
 * `default`), and any that is broken, whatever its source. A row saved off is
 * off on purpose and never counts. Synology Drive (reachability, for
 * information) and Booking (an owner's switch in Settings) never count, nor
 * does Who may sign in, where nothing set means any DSM account.
 */
export const needsAdmin = (rows: readonly ConnectorRow[]): RowId[] => rows
  .filter((r) => ADMINS.has(r.id) && r.source !== 'off' && (r.state === 'broken' || r.source === 'default'))
  .map((r) => r.id);
