/**
 * Reads the NAS's own answers, so the client's guesses can be compared with them.
 *
 * Signs in as CHECK_USER at DSM_URL, asks which versions of each API the NAS
 * offers, and prints the raw reply to each read the app makes. Every call here
 * is a read: nothing is created, changed or deleted, except for the one opt-in
 * write below. (Signing in does leave a login in DSM's own log, and this signs
 * out again at the end.)
 *
 *   CHECK_USER, CHECK_PASS   a DSM account; CHECK_OTP if it asks for a code
 *   DSM_URL                  the NAS, e.g. http://192.0.2.10:5000
 *
 * One File Station read (list_share) and the Contacts reads are always made,
 * since they need no path: a sid that works for Calendar but is answered 105
 * or 119 by these is a sid the session name scoped to Calendar.
 *
 * Optional, each a read: CHECK_CALENDAR names the calendar to use for Sharing
 * and Events (the first one otherwise); CHECK_FOLDER is a File Station folder
 * to list; CHECK_FILE is a file to download (only its size and type are shown).
 *
 * Synology Drive is read when PLANNER_ROOT is set, as the app reads it: the
 * Team Folders, the root's metadata, and a path that does not exist. The one
 * write is opt-in: with CHECK_DRIVE_WRITE=1 it makes <share>/.planner-check/
 * through File Station and writes check.md in it twice, then reads it back and
 * searches for it; then it makes .planner-check/sub and writes one check.md
 * there, to see whether the folder's cursor moves for a write two levels down.
 * Nothing else is written, and nothing outside that folder.
 *
 * The last section, "What the configuration design guessed", asks the NAS about
 * what the configuration work could only guess: how DSM names administrators
 * and accounts, Team Folder rights, folders, moves and the Contacts version.
 * CHECK_ADMIN_USER and CHECK_ADMIN_PASS (an administrator, optional) give it
 * the administrator's side; CHECK_SECOND_TEAM names a second Team Folder for a
 * move between two. With CHECK_DRIVE_WRITE=1 it also makes .planner-check/made
 * and a few small files under .planner-check (and a .planner-check in the
 * second Team Folder). It deletes nothing it did not make, and nothing at all.
 *
 * The session id and the password are never printed: every line goes through
 * `say`, which blanks them. See README.md for what to look for.
 */

import { createHash } from 'node:crypto';

import { ACCOUNTS_CALL, ADMIN_GROUP_CALL, isAdministrator, listAccounts } from '../../src/accounts.ts';
import { AUTH_VERSION, OtpRequired, checkWithDsm, DSM_URL } from '../../src/auth.ts';
import {
  DRIVE_API, DRIVE_BASE, DRIVE_NAME_TAKEN, byLink, getFile, isNoSuchFile, listChanges, listFolders, listTeamFolders,
  readFile, search, teamFolderName, teamFolderPath, teamFolders, writeFile,
} from '../../src/drive.ts';
import type { DriveFile } from '../../src/drive.ts';
import {
  CALENDAR_LIST_PARAMS, CAL_VERSION, COPY_MOVE_VERSION, EVENT_VERSION, EtagMismatch, FILE_STATION_VERSION, NAS_MOVE_WAIT_MS,
  NOT_AN_ETAG_REFUSAL, SHARING_VERSION, SynologyError, contactsVersionNow, createCalendar, createContact, createEvent,
  createFolder, deleteEvent, dsm, downloadFile, fetchFor, getEvent, jsonBody, listAddressbooks, listCalendars, listContacts,
  listEvents, listFolder, listRows, reach, renameCalendar, searchContacts, setEvent, shareCalendar, sharingOf, uploadFile,
  verdict,
} from '../../src/synology.ts';
import type { Addressbook, CalEvent, CalendarRef, Contact, DsmFetch } from '../../src/synology.ts';
import { MOVE_WAIT_MS } from '../../src/moves.ts';

const user = process.env['CHECK_USER']?.trim() ?? '';
const pass = process.env['CHECK_PASS'] ?? '';
const otp = process.env['CHECK_OTP']?.trim() ?? '';
const calendarName = process.env['CHECK_CALENDAR']?.trim() ?? '';
const folder = process.env['CHECK_FOLDER']?.trim() ?? '';
const file = process.env['CHECK_FILE']?.trim() ?? '';
const plannerRoot = (process.env['PLANNER_ROOT']?.trim() ?? '').replace(/\/+$/, '');
const driveWrite = process.env['CHECK_DRIVE_WRITE']?.trim() === '1';
const adminUser = process.env['CHECK_ADMIN_USER']?.trim() ?? '';
const adminPass = process.env['CHECK_ADMIN_PASS'] ?? '';
const secondTeam = process.env['CHECK_SECOND_TEAM']?.trim() ?? '';
const calendarWrite = process.env['CHECK_CALENDAR_WRITE']?.trim() === '1';
const shareWith = process.env['CHECK_SHARE_WITH']?.trim() ?? '';
const contactsWrite = process.env['CHECK_CONTACTS_WRITE']?.trim() === '1';
const addressbookName = process.env['CHECK_ADDRESSBOOK']?.trim() ?? '';

let sid = '';
/** The administrator's own sid, when CHECK_ADMIN_USER and CHECK_ADMIN_PASS were given. */
let adminSid = '';

/** The only way anything is printed: with the secrets blanked, wherever they turn up. */
const say = (text = ''): void => {
  let out = text;
  for (const [secret, label] of [
    [sid, 'session id'], [adminSid, 'session id'], [pass, 'password'], [adminPass, 'password'], [otp, 'one-time code'],
  ] as const) {
    if (secret.length >= 4) out = out.split(secret).join(`[${label}]`);
  }
  console.log(out);
};

const stop = (sentence: string): never => {
  say(sentence);
  process.exit(1);
};

/** The Contacts version the client asks for: asked of the NAS, as the app asks, once the sign-in is done. */
let contactsVersion = 1;

/** The versions the client asks for: the client's own constants, so they cannot drift apart. */
const clientAsks = (): [api: string, version: number][] => [
  ['SYNO.API.Auth', AUTH_VERSION],
  ['SYNO.Cal.Cal', CAL_VERSION], ['SYNO.Cal.Sharing', SHARING_VERSION], ['SYNO.Cal.Event', EVENT_VERSION],
  ['SYNO.Contacts.Contact', contactsVersion], ['SYNO.Contacts.Addressbook', contactsVersion],
  ['SYNO.FileStation.List', FILE_STATION_VERSION], ['SYNO.FileStation.CreateFolder', FILE_STATION_VERSION],
  ['SYNO.FileStation.Upload', FILE_STATION_VERSION], ['SYNO.FileStation.Download', FILE_STATION_VERSION],
  ['SYNO.FileStation.CopyMove', COPY_MOVE_VERSION],
];

const RAW_MAX = 4000;
const raw = (data: unknown): string => {
  const text = JSON.stringify(data, null, 2) ?? 'undefined';
  return (text.length > RAW_MAX ? `${text.slice(0, RAW_MAX)}\n… (${text.length - RAW_MAX} more characters)` : text)
    .split('\n').map((line) => `    ${line}`).join('\n');
};

const failed: string[] = [];

/** What went wrong in a sentence; a refusal from DSM already carries its code. */
const why = (err: unknown): string => (err as Error)?.message ?? String(err);

/** Print the raw reply of one call, then what the client makes of it. A failure of either is shown, not fatal. */
async function probe(title: string, rawCall: () => Promise<unknown>, client?: () => Promise<string>): Promise<unknown> {
  say(`\n${title}`);
  let data: unknown;
  try {
    data = await rawCall();
    say('  raw data:');
    say(raw(data));
  } catch (err) {
    failed.push(title);
    say(`  FAILED: ${why(err)}`);
    return undefined;
  }
  if (client) {
    try {
      say(`  the client reads: ${await client()}`);
    } catch (err) {
      failed.push(`${title} (client)`);
      say(`  the client could not read it: ${why(err)}`);
    }
  }
  return data;
}

/** One read of Drive's REST door as the client makes it (the sid as a cookie, never in the URL), for its raw reply. */
async function driveGet<T>(name: string, path: string, who = sid): Promise<T> {
  return driveCall<T>(who, name, 'GET', path);
}

/** One call to Drive's REST door as `who` (a sid, sent as the cookie), with a JSON body for a POST. */
async function driveCall<T>(who: string, name: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await reach(DRIVE_API, `${DSM_URL}${DRIVE_BASE}${path}`, {
    method,
    headers: { cookie: `id=${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, fetchFor(undefined));
  return verdict<T>(DRIVE_API, name, res, await jsonBody(DRIVE_API, res));
}

/** Drive's `version_id` is a string here, since it is an int64; compare it as one. */
const versionOf = (f: DriveFile): bigint => { try { return BigInt(f.version_id); } catch { return 0n; } };

const fileLine = (f: DriveFile): string =>
  `version_id ${f.version_id}, hash ${f.hash || '(none)'}, permanent_link ${f.permanent_link || '(none)'}`;

async function checkDrive(root: string): Promise<void> {
  const teamName = teamFolderName(root);
  const team = teamFolderPath(root);
  const calendarWorked = !failed.some((t) => t.startsWith('SYNO.Cal.Cal list'));
  let scoped = false;
  /** A Drive refusal of 105, or of 119 while Calendar worked, is the sid's session name, not Drive. */
  const noteCode = (code: number): void => {
    if (code === 105 || (code === 119 && calendarWorked)) scoped = true;
  };
  const noticing = <T>(call: () => Promise<T>) => async (): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      if (err instanceof SynologyError) noteCode(err.code);
      throw err;
    }
  };

  say(`\nSynology Drive, for PLANNER_ROOT ${root}: File Station sees it as ${root}, Drive as ${team}.`);
  try {
    await driveReads(root, team, teamName, noticing, noteCode);
  } finally {
    if (scoped) say('\nThe sid issued with `session=Calendar` does not reach Drive; see README.');
  }
}

async function driveReads(
  root: string, team: string, teamName: string,
  noticing: <T>(call: () => Promise<T>) => () => Promise<T>, noteCode: (code: number) => void,
): Promise<void> {
  // 1. Which versions Drive offers.
  let row: { minVersion?: number; maxVersion?: number } | undefined;
  await probe(`SYNO.API.Info query for ${DRIVE_API}`,
    async () => {
      const info = await dsm<Record<string, { minVersion?: number; maxVersion?: number }>>({
        api: 'SYNO.API.Info', version: 1, method: 'query', sid, params: { query: DRIVE_API },
      });
      row = info?.[DRIVE_API];
      return row ?? {};
    },
    async () => row
      ? `${DRIVE_API} offers ${row.minVersion ?? '?'}–${row.maxVersion ?? '?'}; the copied spec's Files methods are x-syno-version 11`
      : `${DRIVE_API} is not listed here (Drive's REST door may not be), so the reads below are what show whether it answers; `
        + "the copied spec's Files methods are x-syno-version 11");

  // 2. The Team Folders: is the share one?
  let names: string[] = [];
  await probe('Drive team-folder list',
    noticing(async () => {
      const data = await driveGet<{ items?: { name?: string }[] }>('team-folder', '/team-folder');
      names = (data.items ?? []).map((i) => i.name ?? '');
      return data;
    }),
    async () => {
      const listed = (await noticing(() => listTeamFolders(sid))()).includes(teamName);
      if (!listed) failed.push(`Team Folder ${teamName} not listed`);
      return listed
        ? `"${teamName}" is listed among ${names.length} Team Folder(s)`
        : `"${teamName}" is NOT listed among ${names.length} Team Folder(s): enable it as a Team Folder in Synology Drive Admin Console (DEPLOY.md)`;
    });

  // 3. The root itself: its change counters.
  await probe(`Drive files get, path "${team}"`,
    noticing(() => driveGet('files', `/files?${new URLSearchParams({ path: team })}`)),
    async () => {
      const dir = await noticing(() => getFile(sid, team))();
      return `change_id ${dir.change_id}, max_id ${dir.max_id}, type ${dir.type}`;
    });

  // 4. A path that does not exist: the code the client takes as "no such file".
  const missing = `${team}/.planner-check-missing`;
  await probe(`Drive files get, path "${missing}", which should not exist`,
    async () => {
      try {
        return { answered: await getFile(sid, missing) };
      } catch (err) {
        if (err instanceof SynologyError && err.api === DRIVE_API) return { refused: { code: err.code, message: err.message } };
        throw err;
      }
    },
    async () => {
      let refusal: unknown = null;
      try { await getFile(sid, missing); } catch (err) { refusal = err; }
      if (refusal === null) {
        failed.push('missing path was answered');
        return 'Drive answered for a path that should not exist, so there is no error code to read';
      }
      const code = refusal instanceof SynologyError ? refusal.code : 0;
      noteCode(code);
      if (!isNoSuchFile(refusal)) failed.push(`missing path answered code ${code}`);
      return `error code ${code}${isNoSuchFile(refusal) ? ', which the client takes as no such file' : ''}; `
        + 'the real NAS answered 1003 (2026-11-03); if this is not 1003, set it in DRIVE_NO_SUCH_FILE (src/drive.ts)';
    });

  // 5. The one write, only when asked.
  if (!driveWrite) {
    say(`\nDrive writes: skipped. Set CHECK_DRIVE_WRITE=1 to write check.md twice under ${root}/.planner-check/ `
      + 'and search for it (delete that folder afterwards).');
    return;
  }
  const dir = `${team}/.planner-check`;
  const path = `${dir}/check.md`;
  const token = `plannercheck${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const text = (n: number): string => `# Planner check\n\nWrite ${n}. The token is ${token}.\n`;
  afterWrites.push(`The folder ${root}/.planner-check and what the check wrote in it were left; delete the folder in File Station `
    + '(Drive keeps the versions it made).');

  await probe(`File Station create folder "${root}/.planner-check" (the only folder the check makes)`,
    // Not through `noticing`: a 105 here is File Station's share permission, not the sid's session name.
    async () => { await createFolder(sid, root, '.planner-check'); return { folder: `${root}/.planner-check` }; });

  let before = '';
  await probe(`Drive folder cursor before writing, "${dir}"`,
    noticing(async () => { const c = await listChanges(sid, dir); before = c.cursor; return c; }),
    async () => `cursor ${before}`);

  const written: DriveFile[] = [];
  for (const n of [1, 2]) {
    await probe(`Drive files upload ${n}, "${path}", conflict_action version`,
      noticing(async () => { const f = await writeFile(sid, path, text(n)); written.push(f); return f; }),
      async () => fileLine(written[n - 1]!));
  }
  const [one, two] = written;
  if (one && two) {
    const sameLink = one.permanent_link !== '' && one.permanent_link === two.permanent_link;
    const higher = versionOf(two) > versionOf(one);
    const newHash = one.hash !== two.hash;
    say(`\n  across the two writes: the link is ${sameLink ? 'the same' : 'DIFFERENT'}, `
      + `the version is ${higher ? 'higher' : 'NOT higher'}, the hash is ${newHash ? 'different' : 'THE SAME'}`);
    if (!sameLink || !higher || !newHash) failed.push('the second write was not a new version of the same file');
  }

  // The app records the upload's hash, then compares it with a GET's (the pre-write check, and the look).
  if (two?.permanent_link) {
    let got: DriveFile | null = null;
    await probe('Drive files get, by the permanent link the upload answered',
      noticing(async () => { got = await getFile(sid, byLink(two.permanent_link)); return got; }),
      async () => {
        const same = got!.hash === two.hash;
        if (!same) failed.push("the GET's hash is not the upload's");
        return `the GET's hash ${same ? 'equals' : 'DIFFERS from'} the upload's (${got!.hash || '(none)'} / ${two.hash || '(none)'}); `
          + "if these differ, set the pre-write check and the look to compare the GET's hash only (src/pages.ts, src/drift.ts)";
      });
  }

  let after = '';
  await probe(`Drive folder cursor after writing, "${dir}"`,
    noticing(async () => { const c = await listChanges(sid, dir); after = c.cursor; return c; }),
    async () => {
      const moved = after !== before;
      if (!moved) failed.push('the folder cursor did not move');
      return `cursor ${after}, ${moved ? 'moved from' : 'NOT moved from'} ${before}`;
    });

  if (two?.permanent_link) {
    let back = '';
    await probe('Drive files download, by permanent link',
      noticing(async () => { back = await readFile(sid, byLink(two.permanent_link)); return { text: back }; }),
      async () => {
        const same = back === text(2);
        if (!same) failed.push('reading back by link');
        return same ? 'the text read back is the second write' : 'the text read back is NOT the second write';
      });
  }

  let hits: DriveFile[] = [];
  await probe(`Drive files search, keyword ${token}, location "${dir}"`,
    noticing(async () => { hits = await search(sid, { keyword: token, location: dir }); return hits; }),
    async () => {
      const hit = hits.find((h) => h.name === 'check.md');
      if (hit?.content_snippet.includes(token)) return `check.md is found, content_snippet ${JSON.stringify(hit.content_snippet)}`;
      // Said, not failed: an unindexed share is the expected first-run outcome.
      return `${hit ? `check.md is found, content_snippet ${JSON.stringify(hit.content_snippet)}, without the token` : `${hits.length} hit(s), none of them check.md`}. `
        + 'No snippet means Universal Search is not indexing the share yet; the search tool finds names only until it does';
    });

  // The search tool keeps only hits whose display_path is under the household's folder, in the form it asked with.
  // Drive's `path` is relative to the Team Folder (the real NAS, 2026-11-03), so the app never compares it.
  const hit = hits.find((h) => h.name === 'check.md');
  if (hit) {
    const under = hit.display_path.startsWith(`${dir}/`);
    if (!under) failed.push("a search hit's display_path is not in the form of the location asked");
    say(`\n  the hit's display_path ${JSON.stringify(hit.display_path)} ${under ? 'starts' : 'does NOT start'} with the location asked, "${dir}/" `
      + `(its path, which the app does not use, is ${JSON.stringify(hit.path)}); `
      + 'if not, every Drive search hit is dropped by the household filter (src/search.ts): set the prefix to match this form');
  }

  // A page is two levels under the household's folder (<household>/<plan>/plan.md): does a write there move the folder's cursor?
  const sub = `${dir}/sub`;
  await probe(`File Station create folder "${root}/.planner-check/sub"`,
    async () => { await createFolder(sid, `${root}/.planner-check`, 'sub'); return { folder: `${root}/.planner-check/sub` }; });
  let deepBefore = '';
  let deepAfter = '';
  await probe(`Drive folder cursor of "${dir}", before writing two levels down`,
    noticing(async () => { const c = await listChanges(sid, dir); deepBefore = c.cursor; return c; }),
    async () => `cursor ${deepBefore}`);
  await probe(`Drive files upload, "${sub}/check.md"`,
    noticing(() => writeFile(sid, `${sub}/check.md`, text(3))));
  await probe(`Drive folder cursor of "${dir}", after writing "${sub}/check.md"`,
    noticing(async () => { const c = await listChanges(sid, dir); deepAfter = c.cursor; return c; }),
    async () => {
      // Said, not failed: the hourly full look still finds such an edit.
      const moved = deepAfter !== deepBefore;
      return `cursor ${deepAfter}, ${moved ? 'moved from' : 'NOT moved from'} ${deepBefore}; `
        + 'if it did not, edits two levels down are seen only by the hourly full look (src/drift.ts PAGES_FULL_EVERY_MS)';
    });

  await fileStationRoundTrip(`${root}/.planner-check`);
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * File Station's own upload and download, as the app stores and serves a
 * card's files: `fs-upload.md` into `.planner-check` (replacing an earlier
 * run's), read back and compared byte for byte, and listed. Nothing else.
 */
async function fileStationRoundTrip(folder: string): Promise<void> {
  const name = 'fs-upload.md';
  const path = `${folder}/${name}`;
  const bytes = new TextEncoder().encode(`# Planner check\n\nUploaded through File Station at ${new Date().toISOString()}.\n`);
  const uploaded = await viaClient(
    `SYNO.FileStation.Upload upload (v${FILE_STATION_VERSION}), "${path}", overwrite true, the sid as a _sid multipart part`,
    (f) => uploadFile(sid, { folder, name, bytes, overwrite: true }, f),
    () => `taken: ${bytes.length} bytes sent, sha256 ${sha256(bytes)}`);
  if (!uploaded) {
    say('  A 119 here, with a sid that works elsewhere, is DSM wanting the sid as a cookie on upload too (uploadFile, src/synology.ts).');
    return;
  }

  let back: Uint8Array | null = null;
  await probe(`SYNO.FileStation.Download download (v${FILE_STATION_VERSION}), "${path}", the sid in a cookie (the bytes are not printed)`,
    async () => {
      const got = await downloadFile(sid, path);
      back = got.bytes;
      return { bytes: got.bytes.length, contentType: got.contentType, sha256: sha256(got.bytes) };
    },
    async () => {
      const same = sha256(back!) === sha256(bytes);
      if (!same) failed.push('File Station gave back other bytes than it was sent');
      return same ? 'the bytes read back are the bytes uploaded (sha256 equal)'
        : 'the bytes read back DIFFER from the bytes uploaded: compare the multipart body uploadFile builds with what File Station keeps';
    });

  await viaClient(`SYNO.FileStation.List list (v${FILE_STATION_VERSION}), "${folder}"`,
    (f) => listFolder(sid, folder, f),
    (rows) => {
      const row = rows.find((r) => r.name === name && !r.isdir);
      if (!row || row.size !== bytes.length) failed.push(`${name} is not listed at its size`);
      return row
        ? `${name} is listed, ${row.size} bytes${row.size === bytes.length ? ', as uploaded' : `, NOT the ${bytes.length} uploaded`}`
        : `${name} is NOT listed among ${rows.length} entries`;
    });
}

// ─── what the configuration design guessed ───────────────────────────────────

/** A call's answer or DSM's refusal of it, both as data: a refusal that is expected must print, not abort. */
type Answer = { answered: unknown } | { refused: { code: number; message: string } };

async function answer(call: () => Promise<unknown>): Promise<Answer> {
  try {
    return { answered: await call() };
  } catch (err) {
    if (err instanceof SynologyError) return { refused: { code: err.code, message: err.message } };
    throw err;
  }
}

/** `probe` for a call whose refusal is a finding: the raw answer or refusal prints, then `read` says what it means. */
async function ask(title: string, call: () => Promise<unknown>, read: (a: Answer) => string | Promise<string>): Promise<Answer | undefined> {
  let got: Answer | undefined;
  await probe(title, async () => (got = await answer(call)), async () => read(got!));
  return got;
}

// ─── the opt-in writes ────────────────────────────────────────────────────────

/** What each opt-in write left on the NAS, or removed again: said once more at the very end. */
const afterWrites: string[] = [];

/** One reply, or the list of them when a client call made several. */
const oneOrAll = (bodies: unknown[]): unknown => (bodies.length === 1 ? bodies[0] : bodies);

/**
 * A fetch that keeps every JSON body DSM answers through it. Handed to a client
 * function, it shows DSM's whole reply (`success` and `data`, or `error` and its
 * code) to the very call the client makes, with the client's own parameters.
 * Not for a download: that body is the file.
 */
function recording(): { f: DsmFetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const f = (async (input: Parameters<DsmFetch>[0], init?: Parameters<DsmFetch>[1]) => {
    const res = await fetchFor(undefined)(input, init);
    bodies.push(await res.clone().json().catch(() =>
      `(not JSON: HTTP ${res.status}, ${res.headers.get('content-type') ?? 'no content-type'})`));
    return res;
  }) as DsmFetch;
  return { f, bodies };
}

/**
 * `probe` for a write made through the client: DSM's whole raw reply prints,
 * then `read` says what the client returned. A refusal prints its raw reply
 * before the FAILED line. The value comes back wrapped, so a call that returns
 * nothing still says it was taken; undefined means it was not.
 */
async function viaClient<T>(
  title: string, call: (f: DsmFetch) => Promise<T>, read: (got: T) => string | Promise<string>,
): Promise<{ value: T } | undefined> {
  const { f, bodies } = recording();
  let got: { value: T } | undefined;
  await probe(title, async () => {
    try {
      got = { value: await call(f) };
    } catch (err) {
      if (bodies.length) {
        say('  raw reply:');
        say(raw(oneOrAll(bodies)));
      }
      throw err;
    }
    return oneOrAll(bodies);
  }, async () => read(got!.value));
  return got;
}

const keysOf = (data: unknown): string =>
  Array.isArray(data) ? `a bare list of ${data.length}`
    : data && typeof data === 'object' ? `the keys ${Object.keys(data).join(', ') || '(none)'}` : `a ${typeof data}`;

/** The names in `{ users: [{ name }] }`, as `namesIn` (src/accounts.ts) reads them; the text says what else it saw. */
function usersShape(data: unknown): { names: string[]; text: string } {
  const users = (data as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) return { names: [], text: `NOT { users: [...] }: the reply is ${keysOf(data)}, so the app reads nobody` };
  const names = users.flatMap((u: { name?: unknown } | null) => (typeof u?.name === 'string' ? [u.name] : []));
  if (!names.length) {
    return { names, text: `\`users\` has ${users.length} row(s) but none with a string \`name\` (the first row is ${keysOf(users[0])}), so the app reads nobody` };
  }
  return { names, text: `shaped { users: [{ name }] }: ${names.length} name(s) the app reads: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}` };
}

/** The sessions the account probes use: the member's own, and the administrator's when given. */
const sessions = (): { label: string; who: string; sid: string; admin: boolean }[] => [
  { label: 'CHECK_USER', who: user, sid, admin: false },
  ...(adminSid ? [{ label: 'CHECK_ADMIN_USER', who: adminUser, sid: adminSid, admin: true }] : []),
];

/** Probes 1 and 2: one account call, asked with each session; says what each answer means for the app. */
async function accountCall(
  name: string, constant: string, call: { api: string; version: number; method: string; params?: Record<string, string> },
  appReads: (s: { who: string; sid: string }) => Promise<string>,
): Promise<void> {
  for (const s of sessions()) {
    await ask(`${call.api} ${call.method} (v${call.version}) as ${s.label} ${s.who}, ${name}`,
      () => dsm({ ...call, sid: s.sid }),
      async (a) => {
        if ('refused' in a) {
          const { code } = a.refused;
          if (!s.admin && code === 105) return 'refused 105: the member is not an administrator, which is what the app expects of one';
          failed.push(`${name} as ${s.label}`);
          return `REFUSED with code ${code}${s.admin ? ' to an administrator' : ''}. 102/103 mean no such API or method, 114/120 a wrong `
            + `parameter: change ${constant} in src/accounts.ts`;
        }
        const shape = usersShape(a.answered);
        if (!shape.names.length) failed.push(`${name} as ${s.label} (shape)`);
        const note = s.admin ? '' : '; if CHECK_USER is not an administrator, DSM lets any member ask, and the app relies on its own filter alone';
        return `${shape.text}${shape.names.length ? note : ''}\n  the app: ${await appReads(s)}`;
      });
  }
}

/** What went wrong with a step that is not a probe: failed and said (blanked), never thrown, so the check carries on. */
function stepFailed(what: string, err: unknown): void {
  failed.push(what);
  say(`  FAILED: ${what}: ${why(err)}`);
}

/** A file at a Drive path: null when there is none; undefined (failed and said) when the NAS could not say. */
async function lookup(path: string): Promise<DriveFile | null | undefined> {
  try {
    return await getFile(sid, path);
  } catch (err) {
    if (isNoSuchFile(err)) return null;
    stepFailed(`looking for ${path}`, err);
    return undefined;
  }
}

/** A write that is not a probe: the file, or undefined (failed and said) when the NAS refused or did not answer. */
async function writing(path: string, text: string): Promise<DriveFile | undefined> {
  try {
    return await writeFile(sid, path, text);
  } catch (err) {
    stepFailed(`writing ${path}`, err);
    return undefined;
  }
}

/** Poll for a file at a Drive path; its milliseconds from `since`, or null when `limit` runs out or the NAS fails (said). */
async function appearsAt(path: string, since: number, limit: number): Promise<{ file: DriveFile; ms: number } | null> {
  for (;;) {
    const file = await lookup(path);
    if (file) return { file, ms: Date.now() - since };
    if (file === undefined || Date.now() - since >= limit) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Drive's `files/move`, as `moveFile` (src/drive.ts) sends it, with the reply kept whole. */
const driveMove = (link: string, toParent: string): Promise<{ async_task_id?: unknown }> =>
  driveCall(sid, 'move', 'POST', '/files/move', { files: [byLink(link)], to_parent_folder: toParent, conflict_action: 'stop' });

/** File Station's CopyMove as `moveOnNas` (src/synology.ts) sends it, both replies kept whole. */
async function copyMove(from: string, destFolder: string): Promise<{ start: unknown; status: unknown; polls: number }> {
  const api = 'SYNO.FileStation.CopyMove';
  const start = await dsm<{ taskid?: string } | null>({
    api, version: COPY_MOVE_VERSION, method: 'start', sid,
    params: { path: [from], dest_folder_path: destFolder, overwrite: false, remove_src: true },
  });
  const until = Date.now() + NAS_MOVE_WAIT_MS;
  for (let polls = 1; ; polls++) {
    const status = await dsm<{ finished?: boolean } | null>({
      api, version: COPY_MOVE_VERSION, method: 'status', sid, params: { taskid: String(start?.taskid ?? '') },
    });
    if (status?.finished === true || Date.now() >= until) return { start, status, polls };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const formOf = (f: DriveFile, prefix: string): string =>
  `path ${JSON.stringify(f.path)} ${f.path.startsWith(prefix) ? 'starts' : 'does NOT start'} with ${prefix}, `
  + `display_path ${JSON.stringify(f.display_path)} ${f.display_path.startsWith(prefix) ? 'starts' : 'does NOT start'} with it`;

/** Probe 3: Team Folder rights and members, as each session sees them. */
async function teamRights(teamName: string): Promise<void> {
  say(`\nProbe 3, Team Folder rights${teamName ? ` (PLANNER_ROOT's Team Folder is "${teamName}")` : ' (no PLANNER_ROOT, so the first Team Folder listed stands in for it)'}`);
  for (const s of sessions()) {
    let rows: { name?: string; team_id?: unknown; capabilities?: Record<string, unknown> }[] = [];
    await probe(`Drive team-folder list as ${s.label} ${s.who}`,
      async () => {
        const data = await driveGet<{ items?: typeof rows }>('team-folder', '/team-folder', s.sid);
        rows = data.items ?? [];
        return data;
      },
      async () => {
        const seen = new Set(rows.flatMap((r) => Object.keys(r.capabilities ?? {})));
        if (rows.length && !seen.has('can_write')) failed.push(`team-folder capabilities as ${s.label}`);
        const mine = rows.find((r) => r.name === teamName);
        const there = teamName
          ? (mine ? `"${teamName}" is listed with ${JSON.stringify(mine.capabilities ?? null)}` : `"${teamName}" is NOT listed`)
          : 'no PLANNER_ROOT to look for';
        if (teamName && !mine) failed.push(`${teamName} not listed as ${s.label}`);
        const app = (await teamFolders(s.sid)).map((t) => `${t.name} canWrite ${t.canWrite}`).join('; ') || '(none)';
        return `capabilities keys seen: ${[...seen].join(', ') || 'NONE (the app reads capabilities.can_write, so every Team Folder would be read-only)'}; ${there}\n  the app: ${app}`;
      });
    const target = rows.find((r) => r.name === teamName) ?? (teamName ? undefined : rows[0]);
    if (!target) {
      say(`  members: skipped for ${s.label}, since there is no Team Folder to ask about.`);
      continue;
    }
    const id = String(target.team_id ?? '');
    const forms: [string, string][] = [['double-quoted (the app sends this)', JSON.stringify(id)], ['plain', id]];
    const worked: string[] = [];
    for (const [form, value] of forms) {
      const a = await ask(`Drive team-folder/members as ${s.label} ${s.who}, team_id ${form} = ${value}`,
        () => driveGet('team-folder/members', `/team-folder/members?${new URLSearchParams({ team_id: value })}`, s.sid),
        (got) => {
          if ('refused' in got) {
            return `refused (code ${got.refused.code})${!s.admin && got.refused.code === 105 ? ': not open to this member; the picker then says the members are not known' : ''}`;
          }
          const items = (got.answered as { items?: { name?: string; role?: string }[] } | null)?.items;
          if (!Array.isArray(items)) { failed.push(`team-folder/members shape as ${s.label}`); return `NO items list: the reply is ${keysOf(got.answered)}`; }
          const roles = [...new Set(items.map((i) => i.role ?? '(no role)'))];
          const me = items.find((i) => (i.name ?? '').toLowerCase() === s.who.toLowerCase());
          if (items.length && items.every((i) => typeof i.role !== 'string')) failed.push(`team-folder/members roles as ${s.label}`);
          return `${items.length} member(s); roles seen: ${roles.join(', ') || '(none)'}; ${s.who} is ${me ? `listed as ${me.role ?? '(no role)'}` : 'NOT listed'}. `
            + 'The app counts every role but "viewer" as able to write (cannotWrite in src/folders.ts): if the NAS names its read-only role otherwise, change that test';
        });
      if (a && 'answered' in a) worked.push(form);
    }
    say(`\n  team_id wire form, as ${s.label}: ${worked.length ? `answered to: ${worked.join(' and ')}` : 'answered to neither form'}`);
    if (!worked.length && s.admin) failed.push('team-folder/members refused both forms to the administrator');
    if (worked.length && !worked[0]!.startsWith('double-quoted')) {
      failed.push('team-folder/members wants a plain team_id');
      say('  the double-quoted form was refused and the plain one answered: send team_id as it is in teamFolderMembers (src/drive.ts)');
    }
  }
}

async function checkDesign(): Promise<void> {
  say('\n── What the configuration design guessed ──');
  if (!adminSid) {
    say("(CHECK_ADMIN_USER and CHECK_ADMIN_PASS are not both set and signed in, so probes 1 and 2 show the member's side only.)");
  }

  // 1. The administrators group.
  await accountCall('probe 1, the administrators group', 'ADMIN_GROUP_CALL', ADMIN_GROUP_CALL,
    async (s) => `isAdministrator("${s.who}") is ${await isAdministrator(s.sid, s.who)}`);

  // 2. Every account.
  await accountCall('probe 2, every account', 'ACCOUNTS_CALL', ACCOUNTS_CALL,
    async (s) => `listAccounts reads ${(await listAccounts(s.sid)).length} name(s)`);

  // 3. Team Folder rights and members.
  const teamName = plannerRoot ? teamFolderName(plannerRoot) : '';
  await teamRights(teamName);

  // 7 needs nothing of the root, so it runs before the probes that do.
  for (const api of ['SYNO.Contacts.Contact', 'SYNO.Contacts.Addressbook']) {
    let row: { minVersion?: unknown; maxVersion?: unknown } | undefined;
    await probe(`Probe 7, SYNO.API.Info query for ${api} with no sid`,
      async () => {
        const info = await dsm<Record<string, { minVersion?: unknown; maxVersion?: unknown }> | null>({
          api: 'SYNO.API.Info', version: 1, method: 'query', sid: null, params: { query: api },
        });
        row = info?.[api];
        return info ?? {};
      },
      async () => {
        const ok = Number.isInteger(row?.minVersion) && Number.isInteger(row?.maxVersion);
        if (!ok) failed.push(`${api} range with no sid`);
        return ok
          ? `${api} offers ${String(row!.minVersion)}–${String(row!.maxVersion)} to a caller with no session; contactsVersionNow asks for v${await contactsVersionNow()}`
          : `NO range for ${api} without a session: contactsVersionNow would call at 1 and keep nothing (src/synology.ts)`;
      });
  }

  if (!plannerRoot) {
    say('\nProbes 4, 5 and 6: skipped, because PLANNER_ROOT is not set.');
    return;
  }

  // 4. Folders in a Team Folder: the dir filter, a search in a folder that is not there, and a name taken.
  const team = teamFolderPath(plannerRoot);
  const teamRoot = `/team-folders/${teamName}`;
  const dir = `${team}/.planner-check`;
  const nasDir = `${plannerRoot}/.planner-check`;
  const prefix = `${teamRoot}/`;
  await probe(`Probe 4, Drive files list with filter { type: ['dir'] } on "${teamRoot}"`,
    () => driveCall(sid, 'list', 'POST', `/files/list?${new URLSearchParams({ path: teamRoot })}`, { filter: { type: ['dir'] } }),
    async () => {
      const names = await listFolders(sid, teamRoot);
      return `listFolders reads ${names.length} folder(s): ${names.slice(0, 8).join(', ') || '(none)'}. A file among them means the filter was ignored`;
    });
  const gone = `${team}/.planner-check-no-such-folder`;
  await ask(`Probe 4, Drive files search, keyword planner, location "${gone}", which should not exist`,
    () => driveCall(sid, 'search', 'POST', '/files/search', { keyword: 'planner', location: gone, content_snippet: true }),
    (a) => {
      if ('refused' in a) return `an ERROR, code ${a.refused.code}: the picker's index check treats it as "not known", as it does an empty list`;
      const n = (a.answered as { items?: unknown[] } | null)?.items?.length ?? 0;
      return n === 0
        ? 'an empty list, which the picker\'s index check treats as "not known"'
        : `${n} hit(s) from a folder that is not there, so the index check would count them`;
    });

  const token = `plannercheck${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (!driveWrite) {
    say(`\nProbe 4 (making a folder twice), probes 5 and 6 and the path form of a file reached by its link: skipped. Set CHECK_DRIVE_WRITE=1 to run them under ${nasDir}.`);
    return;
  }
  const made = `${dir}/made`;
  const path = `${dir}/check.md`;
  await probe(`File Station create folder "${nasDir}" (the only folder the check makes, apart from what is inside it)`,
    async () => { await createFolder(sid, plannerRoot, '.planner-check'); return { folder: nasDir }; });
  const makeQuery = `/files?${new URLSearchParams({ path: made, type: 'folder', conflict_action: 'stop' })}`;
  let firstCode: number | null = null;
  for (const n of [1, 2]) {
    await ask(`Probe 4, Drive POST files type=folder "${made}", ${n === 1 ? 'the first time' : 'the second time (a name already taken)'}`,
      // The request `makeFolder` (src/drive.ts) sends, with the reply kept whole.
      () => driveCall(sid, 'create', 'POST', makeQuery, {}),
      (a) => {
        if ('answered' in a) {
          if (n === 2) failed.push('a folder made twice was not refused');
          return n === 1 ? 'made' : 'ANSWERED, so a taken name is not refused: makeFolder would reuse it silently';
        }
        const code = a.refused.code;
        if (n === 1) { firstCode = code; return `refused (code ${code})`; }
        const known = DRIVE_NAME_TAKEN.has(code);
        if (!known) failed.push(`DRIVE_NAME_TAKEN is not ${code}`);
        const first = firstCode === null ? '' : firstCode === code
          ? '; the first call was refused with the same code, so the folder was made by an earlier run'
          : `; the first call was refused with code ${firstCode}, a different one`;
        return `refused with code ${code}; DRIVE_NAME_TAKEN holds ${[...DRIVE_NAME_TAKEN].join(', ')}: ${known ? 'the app takes it as "taken"' : `NOT in it, so set ${code} there (src/drive.ts)`}${first}`;
      });
  }

  // The file the moves use: check.md, written if the Drive section has not.
  let there = await lookup(path);
  if (there === null) {
    await probe(`Drive files upload, "${path}", since the Drive section did not write it`,
      async () => { there = (await writing(path, `# Planner check\n\n${token}\n`)) ?? null; return there; });
  }
  if (!there) {
    say('\nProbes 5 and 6: skipped, because check.md could not be read or written.');
    return;
  }
  const checkMd: DriveFile = there;

  // The form of a path when a file is reached by its link: inHousehold (src/docs.ts) relies on /team-folders/<team>/….
  let byLinkFile: DriveFile | null = null;
  await probe(`Drive files get, "${path}" by its permanent link`,
    async () => { byLinkFile = await getFile(sid, byLink(checkMd.permanent_link)); return byLinkFile; },
    async () => {
      const f = byLinkFile!;
      const ok = f.display_path.startsWith(prefix);
      if (!ok) failed.push('a file reached by link has no /team-folders/<team>/ display_path');
      return `${formOf(f, prefix)}. ${ok ? 'inHousehold, which reads display_path only, finds it' : "display_path does not, so inHousehold (src/docs.ts) would refuse every file as another household's"}`;
    });

  // 5. Moves.
  const waitMax = MOVE_WAIT_MS * 3;
  /** One move by link and the wait for the file at its new path; null if it was refused or never came. */
  const moveStep = async (title: string, file: DriveFile, toParent: string, expected: string): Promise<DriveFile | null> => {
    const started = Date.now();
    const a = await ask(title, () => driveMove(file.permanent_link, toParent),
      (got) => ('refused' in got ? `refused (code ${got.refused.code})` : `accepted, task id ${JSON.stringify((got.answered as { async_task_id?: unknown } | null)?.async_task_id)}`));
    if (!a || 'refused' in a) { failed.push(`${title} was refused`); return null; }
    const found = await appearsAt(expected, started, waitMax);
    if (!found) {
      failed.push(`the moved file did not appear at ${expected}`);
      say(`  NOT found at "${expected}" within ${waitMax} ms`);
      return null;
    }
    // The Team Folder the file went to, which for a move into a second one is not the root's.
    const there = `${expected.split('/').slice(0, 3).join('/')}/`;
    const within = found.ms <= MOVE_WAIT_MS;
    say(`  found at "${expected}" after ${found.ms} ms (${within ? 'within' : 'LATER than'} MOVE_WAIT_MS ${MOVE_WAIT_MS}${within ? '' : ': a pass would leave it for the next look; raise MOVE_WAIT_MS in src/moves.ts'})`);
    const kept = found.file.permanent_link === file.permanent_link;
    if (!kept) failed.push('a Drive move changed the permanent_link');
    say(`  permanent_link ${kept ? 'unchanged' : 'CHANGED'} by the move (${file.permanent_link} → ${found.file.permanent_link})${kept ? '' : ': moveDoc (src/moves.ts) takes a file at the new path under another link for a taken name, so every move would fail as taken'}`);
    say(`  ${formOf(found.file, there)}`);
    if (!found.file.display_path.startsWith(there)) failed.push('a moved file has no /team-folders/<team>/ display_path');
    return found.file;
  };

  const inMade = await moveStep(`Probe 5, Drive files move "${path}" by link into "${made}"`, checkMd, made, `${made}/check.md`);
  if (inMade) await moveStep(`Probe 5, Drive files move it back into "${dir}"`, inMade, dir, path);

  if (secondTeam) {
    const other = `/team-folders/${secondTeam}/.planner-check`;
    await probe(`File Station create folder "/${secondTeam}/.planner-check" (CHECK_SECOND_TEAM)`,
      async () => { await createFolder(sid, `/${secondTeam}`, '.planner-check'); return { folder: `/${secondTeam}/.planner-check` }; });
    afterWrites.push(`The folder /${secondTeam}/.planner-check was left; delete it in File Station.`);
    const back = await lookup(path);
    if (back) {
      const over = await moveStep(`Probe 5, Drive files move "${path}" by link into the second Team Folder "${other}"`, back, other, `${other}/check.md`);
      if (over) await moveStep('Probe 5, Drive files move it back from the second Team Folder', over, dir, path);
    }
  } else {
    say('\nProbe 5, a move into a second Team Folder: skipped. Set CHECK_SECOND_TEAM=<another Team Folder you may write> to make it (it writes only .planner-check there).');
  }

  // Onto a taken name: two files of one name, one in the folder and one in made.
  const takenName = `taken-${token}.md`;
  const source = await writing(`${dir}/${takenName}`, `# Planner check\n\nThe file that is moved. ${token}\n`);
  const target = await writing(`${made}/${takenName}`, `# Planner check\n\nThe file already there. ${token}\n`);
  if (source && target) {
    const startedTaken = Date.now();
    const takenAnswer = await ask(`Probe 5, Drive files move "${dir}/${takenName}" into "${made}", where that name is taken (conflict_action 'stop')`,
      () => driveMove(source.permanent_link, made),
      (a) => {
        if ('refused' in a) {
          const known = DRIVE_NAME_TAKEN.has(a.refused.code);
          return `refused at once with code ${a.refused.code}, where the real NAS (2026-11-03) accepted it; DRIVE_NAME_TAKEN holds ${[...DRIVE_NAME_TAKEN].join(', ')}: ${known ? 'the app maps it to "taken"' : 'NOT in it, so a refusal is said in the NAS\'s words'}`;
        }
        return 'accepted, as the real NAS does (2026-11-03): moveDoc (src/moves.ts) finds the name taken by the other link at the new path';
      });
    if (takenAnswer && 'answered' in takenAnswer) {
      await new Promise((resolve) => setTimeout(resolve, MOVE_WAIT_MS));
      const targetNow = await lookup(`${made}/${takenName}`);
      const sourceNow = await lookup(`${dir}/${takenName}`);
      const kept = targetNow?.hash === target.hash;
      if (!kept) failed.push('a move onto a taken name overwrote the file there, or it could not be read');
      say(`  ${Date.now() - startedTaken} ms later the file already there is ${kept ? 'unchanged' : 'CHANGED (overwritten) or unreadable'} and the source is ${sourceNow ? 'still in its folder' : 'GONE from its folder or unreadable'}`);
    }
  } else {
    say('\nProbe 5, a move onto a taken name: skipped, because its two files could not be written (said above).');
  }

  // 6. File Station's CopyMove, confirmed through File Station's own list, as moveCard (src/moves.ts) does.
  // Drive indexes File Station's changes late (the real NAS, 2026-11-03: not found 9 s later), so it is not asked.
  const nasName = `nas-${token}.md`;
  const readCopyMove = (a: Answer): string => {
    if ('refused' in a) return `refused (code ${a.refused.code})`;
    const { start, status, polls } = a.answered as { start: unknown; status: unknown; polls: number };
    const st = (status ?? {}) as { finished?: unknown; skipstatus?: { status?: unknown }; found_file_num?: unknown; total?: unknown };
    return `start answered ${keysOf(start)}; status (asked ${polls} time(s)) answered ${keysOf(status)} with finished ${JSON.stringify(st.finished)}, `
      + `skipstatus.status ${JSON.stringify(st.skipstatus?.status)}, found_file_num ${JSON.stringify(st.found_file_num)}, total ${JSON.stringify(st.total)}. `
      + 'moveOnNas takes skipstatus "all" as a taken name (414); "none" is not proof of a move, so the lists below decide';
  };
  /** The file of that name in a File Station folder, or null; a folder that is not there has none. */
  const inFolder = async (folder: string, name: string): Promise<{ size: number } | null> => {
    try {
      return (await listFolder(sid, folder)).find((x) => !x.isdir && x.name === name) ?? null;
    } catch (err) {
      if (err instanceof SynologyError && err.code === 408) return null;
      throw err;
    }
  };
  const nasFirst = await writing(`${dir}/${nasName}`, `# Planner check\n\nMoved by File Station. ${token}\n`);
  if (!nasFirst) {
    say('\nProbe 6: skipped, because its file could not be written (said above).');
  } else {
    await ask(`Probe 6, File Station CopyMove start and status, "${nasDir}/${nasName}" into "${nasDir}/made" (overwrite false, remove_src true)`,
      () => copyMove(`${nasDir}/${nasName}`, `${nasDir}/made`), readCopyMove);
    const atDest = await inFolder(`${nasDir}/made`, nasName);
    const atSource = await inFolder(nasDir, nasName);
    const moved = !!atDest && !atSource;
    if (!moved) failed.push('File Station did not show the moved file in its new folder and gone from the old one');
    say(`  File Station's list: the file is ${atDest ? `in "${nasDir}/made" (${atDest.size} bytes)` : `NOT in "${nasDir}/made"`} and ${atSource ? `STILL in "${nasDir}"` : `gone from "${nasDir}"`}`
      + `${moved ? ', so it moved; this is how moveCard (src/moves.ts) confirms a card\'s file' : ''}`);

    const second = await writing(`${dir}/${nasName}`, `# Planner check\n\nA second file of that name. ${token}\n`);
    if (second) {
      await ask(`Probe 6, File Station CopyMove start and status, "${nasDir}/${nasName}" into "${nasDir}/made" again, where that name is taken (overwrite false)`,
        () => copyMove(`${nasDir}/${nasName}`, `${nasDir}/made`),
        (a) => ('refused' in a
          ? `refused with code ${a.refused.code}, where the real NAS (2026-11-03) finished with skipstatus "all"; moveOnNas says a refusal as File Station gives it`
          : readCopyMove(a)));
      const after = await inFolder(`${nasDir}/made`, nasName);
      const stillThere = await inFolder(nasDir, nasName);
      const untouched = !!after && !!atDest && after.size === atDest.size;
      if (atDest && after && after.size !== atDest.size) failed.push('File Station overwrote a file on a taken name');
      say(`  File Station's list: the file already in made is ${untouched ? 'unchanged in size' : 'CHANGED, gone or unreadable'} and the source is ${stillThere ? 'still in its folder' : 'GONE from its folder'}`
        + `${untouched && stillThere ? ', so File Station skipped it, which moveCard says as a taken name' : ''}`);
    }
  }
  say(`\nThe check left files under ${nasDir}${secondTeam ? ` and /${secondTeam}/.planner-check` : ''}; delete the .planner-check folder(s) in File Station.`);
}

// ─── calendar writes, with CHECK_CALENDAR_WRITE=1 ────────────────────────────

/** The code the client's comments assume for a stale etag (setEvent, src/synology.ts; ETAG_MISMATCH in the fake DSM). */
const STALE_ETAG_ASSUMED = 9006;
/** The code the app takes as "this event is gone" (NO_SUCH_EVENT in src/calendar.ts), a guess until the delete below answers. */
const NO_SUCH_EVENT_ASSUMED = 9009;
const HOUR = 60 * 60;

/** The two ids of a calendar, without the rest of what `listCalendars` reads. */
const refOf = (c: CalendarRef): CalendarRef => ({ cal_id: c.cal_id, original_cal_id: c.original_cal_id });

/**
 * Makes a calendar of the check's own, shares it (with CHECK_SHARE_WITH),
 * renames it, writes one event in it, moves the event with its etag and then
 * with the old one, deletes the event, and deletes the calendar. Nothing is
 * written to any other calendar.
 */
async function checkCalendarWrite(): Promise<void> {
  if (!calendarWrite) {
    say('\nCalendar writes: skipped. Set CHECK_CALENDAR_WRITE=1 to make a calendar "Planner check <date-time>", write and '
      + 'move one event in it (once with a stale etag), and delete both again; CHECK_SHARE_WITH=<dsm account> also shares it.');
    return;
  }
  const name = `Planner check ${new Date().toISOString()}`;
  const renamed = `${name} renamed`;
  say(`\n── Calendar writes (CHECK_CALENDAR_WRITE): a calendar of the check's own, "${name}" ──`);

  /** The calendar of that name as listCalendars reads it, or null. */
  const listed = async (displayname: string) => (await listCalendars(sid)).find((c) => c.displayname === displayname) ?? null;

  const made = await viaClient(`SYNO.Cal.Cal create (v${CAL_VERSION}), "${name}", with the parameters createCalendar sends`,
    (f) => createCalendar(sid, {
      displayname: name, description: 'Made by the Home Planner NAS check, which deletes it again.', color: '#5B8DEF',
    }, f),
    async (c) => {
      const there = await listed(name);
      if (!there) failed.push('the calendar made is not listed');
      return `cal_id ${JSON.stringify(c.cal_id)}, original_cal_id ${JSON.stringify(c.original_cal_id)}, displayname ${JSON.stringify(c.displayname)}; `
        + (!there ? 'listCalendars does NOT show it'
          : `listCalendars shows it${there.cal_id === c.cal_id ? ' under the same cal_id' : ` under cal_id ${there.cal_id}, NOT the one create answered`}`);
    });

  // Found by its name whatever create answered: a reply the client could not read may still have made it.
  const found = await listed(name).catch(() => null);
  const cal = found ? refOf(found) : made?.value.cal_id ? refOf(made.value) : null;
  if (!cal) {
    if (made) {
      failed.push('the calendar made could not be found again');
      afterWrites.push(`The calendar '${name}' was made but could not be found again; if Synology Calendar shows it, delete it there.`);
    } else {
      afterWrites.push('No calendar was left: create was refused.');
    }
    say('\nThe rest of the calendar writes: skipped, because there is no calendar of the check\'s to use.');
    return;
  }

  let nameNow = name;
  let sharedWith = '';
  try {
    // Who it is shared with, then (with CHECK_SHARE_WITH) a share and the sharing read again.
    const before = await viaClient(`SYNO.Cal.Sharing get (v${SHARING_VERSION}), the calendar just made`,
      (f) => sharingOf(sid, cal.cal_id, f),
      (s) => `${s.users.length} user(s), ${s.groups.length} group(s)${s.users.length || s.groups.length ? '' : ', as a calendar just made should have'}`);
    if (!shareWith) {
      say('\nSYNO.Cal.Sharing set: skipped. Set CHECK_SHARE_WITH=<another dsm account> to share the check\'s calendar with it, read-only, and read the sharing back.');
    } else {
      const shared = await viaClient(`SYNO.Cal.Sharing set (v${SHARING_VERSION}), with ${shareWith} RO, as shareCalendar sends it`,
        (f) => shareCalendar(sid, cal.cal_id, { users: [{ name: shareWith, privilege: 'RO' }], groups: before?.value.groups ?? [] }, f),
        () => 'taken');
      if (shared) {
        sharedWith = shareWith;
        await viaClient(`SYNO.Cal.Sharing get (v${SHARING_VERSION}), after sharing with ${shareWith}`,
          (f) => sharingOf(sid, cal.cal_id, f),
          (s) => {
            const u = s.users.find((x) => x.name.toLowerCase() === shareWith.toLowerCase());
            if (!u) failed.push(`${shareWith} is not in the calendar's sharing after set`);
            return u
              ? `${shareWith} is listed, ${u.privilege}${u.privilege === 'RO' ? ', as set' : ', NOT RO as set'}`
              : `${shareWith} is NOT listed, though set was taken: either set wants another cal_share_setting (shareCalendar) `
                + 'or get answers the users elsewhere (sharingOf, src/synology.ts); the two raw replies say which';
          });
      }
    }

    await viaClient(`SYNO.Cal.Cal set (v${CAL_VERSION}), cal_displayname "${renamed}", as renameCalendar sends it`,
      (f) => renameCalendar(sid, cal, renamed, f),
      async () => {
        const there = await listed(renamed);
        if (there) nameNow = renamed;
        else failed.push('the renamed calendar is not listed under its new name');
        return there ? 'listCalendars shows the new name' : `taken, but listCalendars does NOT show "${renamed}": look at the params of renameCalendar`;
      });

    await eventWrites(cal);
  } finally {
    await deleteCheckCalendar(cal, nameNow, sharedWith);
  }
}

/** One event in the check's calendar: made, read, moved with its etag, written with the old one, deleted. */
async function eventWrites(cal: CalendarRef): Promise<void> {
  // Tomorrow, on the hour, for an hour; in this machine's zone, as the app sends the household's.
  const start = (Math.floor(Date.now() / 1000 / HOUR) + 24) * HOUR;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const made = (await viaClient(`SYNO.Cal.Event create (v${EVENT_VERSION}), one hour tomorrow, tz_id ${tz}`,
    (f) => createEvent(sid, {
      ...cal, summary: 'Planner check', description: 'Made by the Home Planner NAS check, which deletes it again.',
      is_all_day: false, dtstart: start, dtend: start + HOUR, tz_id: tz,
    }, f),
    (e) => `evt_id ${e.evt_id}, dav_etag ${JSON.stringify(e.dav_etag)}, ical_uid ${JSON.stringify(e.ical_uid)}, `
      + `dtstart ${e.dtstart}${e.dtstart === start ? ', as sent' : `, NOT ${start} as sent`}`))?.value;
  if (!made) {
    say('\nThe other event steps: skipped, because create was refused.');
    return;
  }
  if (typeof made.evt_id !== 'number') {
    failed.push('event create answered no evt_id');
    say('\nThe other event steps: skipped, because create answered no evt_id (calEvent reads `evt_id` from its reply; the raw reply shows what it holds). '
      + 'Deleting the calendar takes the event with it.');
    return;
  }
  const ref = { ...cal, evt_id: made.evt_id };

  const got = (await viaClient(`SYNO.Cal.Event get (v${EVENT_VERSION}), evt_id ${made.evt_id}, as getEvent sends it`,
    (f) => getEvent(sid, ref, f),
    (e) => {
      if (!e.dav_etag) failed.push('event get answered no dav_etag');
      return `dav_etag ${JSON.stringify(e.dav_etag)}${e.dav_etag === made.dav_etag ? ', the one create answered' : made.dav_etag ? `, not create's ${JSON.stringify(made.dav_etag)}` : ''}, `
        + (e.last_modify_user ? `last_modify_user ${JSON.stringify(e.last_modify_user)}`
          : 'no last_modify_user (the client\'s guess at the name: without it the drift card cannot say who changed an event)');
    }))?.value;

  if (got?.dav_etag) {
    const base = Number.isFinite(got.dtstart) ? got.dtstart : start;
    const moved = (await viaClient(`SYNO.Cal.Event set (v${EVENT_VERSION}), one hour later, carrying the dav_etag get answered`,
      (f) => setEvent(sid, got, { dtstart: base + HOUR, dtend: base + 2 * HOUR }, f),
      (e) => {
        const fresh = !!e.dav_etag && e.dav_etag !== got.dav_etag;
        if (!fresh) failed.push('event set answered no new dav_etag');
        return `dav_etag ${JSON.stringify(e.dav_etag)}: ${fresh ? 'a new one' : e.dav_etag ? 'the SAME as before' : 'NONE'}; `
          + `dtstart ${e.dtstart}${e.dtstart === base + HOUR ? ', one hour later as asked' : ''}`
          + (fresh ? '' : '. setEvent reads the new etag from set\'s reply (calEvent); with none the app holds no etag, and refuses the next change of this event');
      }))?.value;
    if (moved) await staleEtag(got);
    else say('\nThe stale-etag write: skipped, because the set above was not taken, so the etag get answered is not stale.');
  } else {
    say('\nThe two event sets: skipped, because there is no dav_etag to carry (setEvent makes no call without one).');
  }

  const day = 24 * HOUR;
  const deleted = await viaClient(`SYNO.Cal.Event delete (v${EVENT_VERSION}), evt_id ${made.evt_id}, as deleteEvent sends it`,
    (f) => deleteEvent(sid, ref, f),
    async () => {
      const still = (await listEvents(sid, { calendars: [cal], start: start - day, end: start + day })).some((e) => e.evt_id === made.evt_id);
      if (still) failed.push('a deleted event is still listed');
      return still ? 'listEvents STILL shows it' : 'listEvents no longer shows it';
    });
  if (deleted) {
    await ask(`SYNO.Cal.Event get (v${EVENT_VERSION}), the event just deleted`,
      () => dsm({ api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'get', sid, params: { ...ref } }),
      (a) => {
        if ('answered' in a) {
          failed.push('a deleted event was answered');
          return 'ANSWERED for an event that was deleted';
        }
        const { code } = a.refused;
        if (code === NO_SUCH_EVENT_ASSUMED) return `refused with code ${code}, which the app takes as "gone" (NO_SUCH_EVENT in src/calendar.ts)`;
        failed.push(`a deleted event is answered ${code}, not ${NO_SUCH_EVENT_ASSUMED}`);
        return `refused with code ${code}, NOT ${NO_SUCH_EVENT_ASSUMED}: set NO_SUCH_EVENT in src/calendar.ts to ${code}, `
          + 'or the app takes an event deleted on a phone for a failure';
      });
  }
}

/**
 * The key probe: `setEvent` with the copy read before the move, whose etag is
 * now stale. Made through the client, so the raw replies are set's refusal and
 * the get setEvent makes to see whether the etag really moved.
 */
async function staleEtag(old: CalEvent): Promise<void> {
  const { f, bodies } = recording();
  let accepted = false;
  let refusal: unknown = null;
  await probe(`SYNO.Cal.Event set (v${EVENT_VERSION}), carrying the OLD dav_etag ${JSON.stringify(old.dav_etag)}: what does a stale etag answer?`,
    async () => {
      try {
        await setEvent(sid, old, { summary: 'Planner check, from a stale copy' }, f);
        accepted = true;
      } catch (err) {
        if (!(err instanceof SynologyError) || bodies.length === 0) throw err;
        refusal = err;
      }
      // The first reply is set's; a second is the get setEvent makes before it says EtagMismatch.
      return oneOrAll(bodies);
    },
    async () => {
      if (accepted) {
        failed.push('a stale dav_etag was accepted');
        return 'ACCEPTED: the NAS took a set carrying an etag that is no longer the event\'s, so dav_etag guards nothing and '
          + 'setEvent (src/synology.ts) would overwrite an edit made on a phone. Report this before the app writes to a shared calendar.';
      }
      const code = (bodies[0] as { error?: { code?: unknown } } | undefined)?.error?.code;
      const mismatch = refusal instanceof EtagMismatch;
      if (!mismatch) failed.push('a stale etag was not read as EtagMismatch');
      const client = mismatch
        ? 'the client reads it as EtagMismatch ("this event was changed on the NAS since it was last read"), as it should'
        : `the client does NOT read it as EtagMismatch: it says "${why(refusal)}"`;
      if (typeof code !== 'number') {
        failed.push('a stale etag was refused with no code');
        return `refused with no error code in the reply; ${client}`;
      }
      if (code === STALE_ETAG_ASSUMED) {
        return `refused with code ${code}, the ${STALE_ETAG_ASSUMED} the client assumes (setEvent, src/synology.ts); ${client}`;
      }
      failed.push(`a stale etag was refused with ${code}, not ${STALE_ETAG_ASSUMED}`);
      const fix = `set ${STALE_ETAG_ASSUMED} to ${code} in setEvent's comment (src/synology.ts) and in ETAG_MISMATCH (tools/fake-dsm/server.ts)`;
      return NOT_AN_ETAG_REFUSAL.has(code)
        ? `refused with code ${code}, NOT the ${STALE_ETAG_ASSUMED} the client assumes, and ${code} is in NOT_AN_ETAG_REFUSAL, so the app `
          + `reports a stale etag as a plain refusal, never as "changed on the NAS". Remove ${code} from NOT_AN_ETAG_REFUSAL in src/synology.ts, and ${fix}; ${client}`
        : `refused with code ${code}, NOT the ${STALE_ETAG_ASSUMED} the client assumes. ${code} is not in NOT_AN_ETAG_REFUSAL `
          + `(${[...NOT_AN_ETAG_REFUSAL].join(', ')}, src/synology.ts), so the app still takes it as a stale etag; ${fix}; ${client}`;
    });
}

/**
 * The check's own clean-up: the app has no deleteCalendar, so this is a raw
 * call. The Calendar guide's `Method Delete` (2024-06) takes `cal_id` alone,
 * from version 5, and lists 9006, 9007, 9009 and 9017 as its errors; the guide
 * spells the method with a capital D, and `delete` is sent as every other
 * method name is. Whether deleting takes the events with it is not said.
 */
async function deleteCheckCalendar(cal: CalendarRef, name: string, sharedWith: string): Promise<void> {
  let gone = false;
  await ask(`SYNO.Cal.Cal delete (v${CAL_VERSION}), cal_id ${cal.cal_id} (the check's own clean-up; the app deletes no calendar)`,
    () => dsm({ api: 'SYNO.Cal.Cal', version: CAL_VERSION, method: 'delete', sid, params: { cal_id: cal.cal_id } }),
    async (a) => {
      if ('refused' in a) return `refused (code ${a.refused.code})`;
      gone = !(await listCalendars(sid)).some((c) => c.cal_id === cal.cal_id);
      return gone ? 'answered, and listCalendars no longer shows it' : 'answered, but listCalendars STILL shows it';
    });
  if (gone) {
    afterWrites.push(`The calendar '${name}' was deleted; no calendar was left.`);
    return;
  }
  failed.push('the check\'s calendar was not deleted');
  const left = `The calendar '${name}' was left; delete it in Synology Calendar.`;
  say(`  ${left}`);
  afterWrites.push(`${left}${sharedWith ? ` It is shared with ${sharedWith}.` : ''}`);
}

// ─── contacts writes, with CHECK_CONTACTS_WRITE=1 ────────────────────────────

const CHECK_CONTACT = 'Planner Check';
const CHECK_EMAIL = 'planner-check@example.com';

/** Adds one contact, finds it, and tries to delete it again; nothing else in the address book is touched. */
async function checkContactsWrite(): Promise<void> {
  if (!contactsWrite) {
    say(`\nContacts writes: skipped. Set CHECK_CONTACTS_WRITE=1 to add a contact "${CHECK_CONTACT}" (${CHECK_EMAIL}), find it, `
      + 'and try to delete it again (CHECK_ADDRESSBOOK=<name> picks the address book; the first otherwise).');
    return;
  }
  say(`\n── Contacts writes (CHECK_CONTACTS_WRITE): a contact of the check's own, "${CHECK_CONTACT}" ──`);
  let books: Addressbook[] = [];
  try {
    books = await listAddressbooks(sid);
  } catch (err) {
    stepFailed('listing the address books', err);
  }
  const book = addressbookName ? books.find((b) => b.name === addressbookName) : books[0];
  if (!book) {
    if (addressbookName) failed.push(`no address book called ${addressbookName}`);
    say(`\nContacts writes: skipped, because the client reads ${addressbookName ? `no address book called "${addressbookName}"` : 'no address book'}.`);
    afterWrites.push('No contact was left: there was no address book to add one to.');
    return;
  }
  say(`\nUsing the address book "${book.name}" (id ${book.id}).`);

  // Those of that name already there (an earlier run's), so only the one made now is deleted.
  const named = async (): Promise<Contact[]> => (await searchContacts(sid, CHECK_CONTACT)).filter((c) => c.full_name === CHECK_CONTACT);
  const earlier = new Set((await named().catch(() => [])).map((c) => c.id));
  if (earlier.size) say(`  ${earlier.size} contact(s) called "${CHECK_CONTACT}" are there already, from an earlier run; they are left as they are.`);

  const made = (await viaClient(`SYNO.Contacts.Contact create (v${contactsVersion}), "${CHECK_CONTACT}" with ${CHECK_EMAIL}, in address book ${book.id}, as createContact sends it`,
    (f) => createContact(sid, { addressbook_id: book.id, full_name: CHECK_CONTACT, emails: [CHECK_EMAIL] }, f),
    (c) => {
      if (c.full_name !== CHECK_CONTACT || !Number.isFinite(c.id)) failed.push('the created contact was not read back as made');
      if (!c.emails.includes(CHECK_EMAIL)) failed.push('the created contact\'s email was not read back');
      return `id ${c.id}, full_name ${JSON.stringify(c.full_name)}, emails ${JSON.stringify(c.emails)}, addressbook_id ${c.addressbook_id}`
        + (c.emails.includes(CHECK_EMAIL) ? '' : '. The email is not read back: either create did not take `email` as a list of { value } '
          + '(createContact), or the reply names it otherwise (contact(), src/synology.ts); the list rows below show how the NAS keeps it');
    }))?.value;

  // The rows of that name only, never the whole address book: its other contacts are not the check's to print.
  let hits: Contact[] = [];
  await probe(`SYNO.Contacts.Contact list (v${contactsVersion}), limit 1000, the rows called "${CHECK_CONTACT}" only; then searchContacts`,
    async () => {
      const data = await dsm<unknown>({ api: 'SYNO.Contacts.Contact', version: contactsVersion, method: 'list', sid, params: { limit: 1000 } });
      const rows = listRows<{ full_name?: unknown }>(data, 'contact', 'contacts');
      return { reply: keysOf(data), rows: rows.length, [CHECK_CONTACT]: rows.filter((r) => r.full_name === CHECK_CONTACT) };
    },
    async () => {
      hits = await named();
      const fresh = hits.filter((c) => !earlier.has(c.id));
      if (!fresh.length) failed.push('the contact made is not found by searchContacts');
      return fresh.length ? `searchContacts finds it: id ${fresh.map((c) => c.id).join(', ')}, emails ${JSON.stringify(fresh[0]!.emails)}`
        : `searchContacts does NOT find it among ${hits.length} of that name`;
    });

  // The one made now: by the id create answered, else the one new row of that name.
  const fresh = hits.filter((c) => !earlier.has(c.id));
  const id = made && Number.isFinite(made.id) && !earlier.has(made.id) ? made.id : fresh.length === 1 ? fresh[0]!.id : null;
  if (id === null) {
    if (!made && !fresh.length) {
      afterWrites.push('No contact was left: create was refused.');
      return;
    }
    failed.push('the check\'s contact could not be told apart to delete');
    const left = `The contact '${CHECK_CONTACT}' was left; delete it in Synology Contacts.`;
    say(`\n  ${left}`);
    afterWrites.push(left);
    return;
  }

  // The check's own clean-up. Contacts is not documented and the app deletes no contact,
  // so `delete` and its `id` are both guesses, `id` because `get` takes it.
  let gone = false;
  await ask(`SYNO.Contacts.Contact delete (v${contactsVersion}), id ${id} (the check's own clean-up; method and parameter are guesses)`,
    () => dsm({ api: 'SYNO.Contacts.Contact', version: contactsVersion, method: 'delete', sid, params: { id } }),
    async (a) => {
      if ('refused' in a) {
        return `refused (code ${a.refused.code}): 103 is no such method, 114 or 120 a parameter it wants otherwise (an \`id_list\`, perhaps); `
          + 'nothing in the app depends on it';
      }
      gone = !(await named()).some((c) => c.id === id);
      return gone ? 'answered, and searchContacts no longer finds it' : 'answered, but searchContacts STILL finds it';
    });
  if (gone) {
    afterWrites.push(`The contact '${CHECK_CONTACT}' was deleted; no contact was left.`);
    return;
  }
  failed.push('the check\'s contact was not deleted');
  const left = `The contact '${CHECK_CONTACT}' was left; delete it in Synology Contacts.`;
  say(`  ${left}`);
  afterWrites.push(left);
}

if (!user || !pass) {
  stop('Set CHECK_USER and CHECK_PASS (and CHECK_OTP if the account asks for a code) to a DSM account, then run this again.');
}

say(`Checking ${DSM_URL} as ${user}.`);
try {
  ({ sid } = await checkWithDsm(user, pass, otp || undefined));
} catch (err) {
  stop(err instanceof OtpRequired
    ? 'DSM wants a one-time code for this account: set CHECK_OTP to the current code and run this again.'
    : `Could not sign in to ${DSM_URL}: ${(err as Error).message}.`);
}
say('Signed in.');

// The administrator's own session, for the account probes, when both are given.
if (adminUser || adminPass) {
  if (!adminUser || !adminPass) {
    say("Set both CHECK_ADMIN_USER and CHECK_ADMIN_PASS, or neither: the administrator's side of probes 1 and 2 is skipped.");
  } else {
    try {
      ({ sid: adminSid } = await checkWithDsm(adminUser, adminPass, undefined));
      say(`Signed in as ${adminUser}, the administrator.`);
    } catch (err) {
      failed.push('CHECK_ADMIN_USER sign-in');
      say(`Could not sign in as ${adminUser}: ${why(err)}. The administrator's side of probes 1 and 2 is skipped.`);
    }
  }
}

try {
  // 1. Which versions the NAS offers.
  say('\nAPI versions (SYNO.API.Info query)');
  try {
    // The app's own question (no session, the lowest version the range holds), so the line below shows what it will call.
    contactsVersion = await contactsVersionNow();
    const asked = clientAsks();
    const info = await dsm<Record<string, { minVersion?: number; maxVersion?: number }>>({
      api: 'SYNO.API.Info', version: 1, method: 'query', sid,
      params: { query: asked.map(([api]) => api).join(',') },
    });
    for (const [api, asks] of asked) {
      const row = info?.[api];
      const status = !row ? 'NOT OFFERED by this NAS'
        : typeof row.minVersion === 'number' && typeof row.maxVersion === 'number'
          ? (asks >= row.minVersion && asks <= row.maxVersion ? 'ok' : 'OUTSIDE the range')
          : 'range not given';
      const range = row ? `${row.minVersion ?? '?'}–${row.maxVersion ?? '?'}` : '-';
      say(`  ${api.padEnd(30)} ${range.padEnd(6)} the client asks for v${asks}: ${status}`);
      if (status !== 'ok') failed.push(`${api} version`);
    }
  } catch (err) {
    failed.push('SYNO.API.Info');
    say(`  FAILED: ${why(err)}`);
  }

  // 2. Calendars.
  // The real NAS refused a `list` with no parameters 9009; the guide marks
  // `cal_type` required and its examples send `is_evt`. Say what was sent.
  const calListParams = Object.entries(CALENDAR_LIST_PARAMS).map(([k, v]) => `${k}=${String(v)}`).join(', ');
  await probe(`SYNO.Cal.Cal list (v${CAL_VERSION}), with ${calListParams} `
    + `(is_evt ${'is_evt' in CALENDAR_LIST_PARAMS ? 'sent' : 'NOT sent'}; 9009 here means "Parameter error")`,
    () => dsm({ api: 'SYNO.Cal.Cal', version: CAL_VERSION, method: 'list', sid, params: { ...CALENDAR_LIST_PARAMS } }),
    async () => {
      const cals = await listCalendars(sid);
      return `${cals.length} event calendar(s)${cals.length ? `: ${cals.map((c) => c.displayname).join(', ')}` : ''}`;
    });

  // 3. Contacts, always: like list_share below, these need nothing of yours,
  // so a sid scoped away from Contacts shows up here.
  await probe(`SYNO.Contacts.Addressbook list (v${contactsVersion})`,
    () => dsm({ api: 'SYNO.Contacts.Addressbook', version: contactsVersion, method: 'list', sid }),
    async () => {
      const books = await listAddressbooks(sid);
      return `${books.length} address book(s)${books.length ? `: ${books.map((b) => `${b.id} ${b.name}`).join(', ')}` : ''}`;
    });
  await probe(`SYNO.Contacts.Contact list (v${contactsVersion}), limit 1`,
    () => dsm({ api: 'SYNO.Contacts.Contact', version: contactsVersion, method: 'list', sid, params: { limit: 1 } }),
    async () => {
      const [c] = await listContacts(sid, { limit: 1 });
      return c
        ? `id ${c.id}, name "${c.full_name}", ${c.phones.length} phone(s), ${c.emails.length} email(s), org "${c.org}"`
        : 'no contacts';
    });

  // 4. Sharing and events, for the first calendar the client can see.
  const calendars = await listCalendars(sid).catch(() => []);
  const first = calendarName ? calendars.find((c) => c.displayname === calendarName) : calendars[0];
  if (!first) {
    say(calendarName
      ? `\nSYNO.Cal.Sharing get and SYNO.Cal.Event list: skipped, because the client sees no calendar called "${calendarName}".`
      : '\nSYNO.Cal.Sharing get and SYNO.Cal.Event list: skipped, because the client reads no calendar from the reply above.');
  } else {
    say(`\nUsing the calendar "${first.displayname}" (cal_id ${first.cal_id}, original_cal_id ${first.original_cal_id}).`);
    await probe(`SYNO.Cal.Sharing get (v${SHARING_VERSION})`,
      () => dsm({ api: 'SYNO.Cal.Sharing', version: SHARING_VERSION, method: 'get', sid, params: { cal_id: first.cal_id } }),
      async () => {
        const { users, groups } = await sharingOf(sid, first.cal_id);
        return `${users.length} user(s)${users.length ? `: ${users.map((u) => `${u.name} ${u.privilege}`).join(', ')}` : ''}`
          + `, ${groups.length} group(s) kept as DSM sent them`;
      });

    const start = Math.floor(Date.now() / 1000);
    const end = start + 7 * 24 * 60 * 60;
    const events = await probe(`SYNO.Cal.Event list (v${EVENT_VERSION}), the coming week, cal_id_list as the client sends it`,
      () => dsm({ api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'list', sid, params: { cal_id_list: [first.cal_id], start, end } }),
      async () => `${(await listEvents(sid, { calendars: [first], start, end })).length} event(s)`);

    const one = listRows<{ evt_id?: unknown }>(events, 'list')[0];
    if (typeof one?.evt_id === 'number') {
      const evt_id = one.evt_id;
      await probe(`SYNO.Cal.Event get (v${EVENT_VERSION}), the first event above, with the params the client sends`,
        () => dsm({
          api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'get', sid,
          params: { evt_id, cal_id: first.cal_id, original_cal_id: first.original_cal_id },
        }),
        async () => `dav_etag "${(await getEvent(sid, { evt_id, cal_id: first.cal_id, original_cal_id: first.original_cal_id })).dav_etag}"`);
    } else {
      say('\nSYNO.Cal.Event get: skipped, because there is no event in the coming week to ask about.');
    }
  }

  // 4b. Calendar writes, only when asked, on a calendar the check makes and deletes.
  try {
    await checkCalendarWrite();
  } catch (err) {
    stepFailed('the calendar writes stopped before their end', err);
  }

  // 4c. Contacts writes, only when asked: one contact the check adds and tries to delete.
  try {
    await checkContactsWrite();
  } catch (err) {
    stepFailed('the contacts writes stopped before their end', err);
  }

  // 5. File Station. One read that needs no path, always: if it is answered
  // 105 or 119 while the calendar reads worked, the sid is scoped by the
  // session name it was issued under, and every File Station call would fail
  // the same way. The two with a path only when asked; both are reads.
  await probe(`SYNO.FileStation.List list_share (v${FILE_STATION_VERSION}), no path needed`,
    () => dsm({ api: 'SYNO.FileStation.List', version: FILE_STATION_VERSION, method: 'list_share', sid }));
  if (folder) {
    await probe(`SYNO.FileStation.List list (v${FILE_STATION_VERSION}), folder_path "${folder}" as a plain string`,
      () => dsm({ api: 'SYNO.FileStation.List', version: FILE_STATION_VERSION, method: 'list', sid, params: { folder_path: folder, additional: ['size'] } }),
      async () => `${(await listFolder(sid, folder)).length} entries`);
  }
  if (file) {
    say(`\nSYNO.FileStation.Download download (v${FILE_STATION_VERSION}), path "${file}" as a plain string, sid in a cookie`);
    try {
      const got = await downloadFile(sid, file);
      say(`  the client received ${got.bytes.length} bytes, content-type ${got.contentType}`);
    } catch (err) {
      failed.push('SYNO.FileStation.Download');
      say(`  FAILED: ${why(err)}`);
    }
  }

  // 6. Synology Drive, when there is a PLANNER_ROOT to look at.
  if (plannerRoot) {
    await checkDrive(plannerRoot);
  } else {
    say('\nSynology Drive: skipped, because PLANNER_ROOT is not set (set it as the app does, such as PLANNER_ROOT=/Planner).');
  }

  // 7. What the configuration design guessed.
  try {
    await checkDesign();
  } catch (err) {
    stepFailed('the design section stopped before its end', err);
  }
} finally {
  if (adminSid) await dsm({ api: 'SYNO.API.Auth', version: AUTH_VERSION, method: 'logout', sid: adminSid }).catch(() => undefined);
  const out = await dsm({ api: 'SYNO.API.Auth', version: AUTH_VERSION, method: 'logout', sid }).then(() => true, () => false);
  say(out ? '\nSigned out.' : '\nCould not sign out; the session will expire on its own.');
}

// What the writes left, said again here whatever happened above them, so it is the last thing read.
if (afterWrites.length) {
  say('\nWhat the opt-in writes left on the NAS:');
  for (const line of afterWrites) say(`  ${line}`);
} else {
  say('\nNo write was asked for, so the check made nothing on the NAS.');
}

if (failed.length) {
  stop(`${failed.length} thing(s) did not match or did not answer: ${failed.join('; ')}. Their replies above are what to read; see README.md.`);
}
say('Every call answered. Compare each raw reply above with what README.md says the client assumes.');
