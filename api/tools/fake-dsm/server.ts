/**
 * A stand-in for DSM, for running the app on a laptop and for tests.
 *
 * It answers the APIs the app calls, the way DSM does: the same endpoint, the
 * same form fields, HTTP 200 with `success: false` and a code when it says no.
 * Sign-in, calendars and who they are shared with, events (with an etag that
 * changes on every change, and the account that last changed it), one address
 * book, File Station on a temporary directory, and Synology Drive's own REST
 * door onto the Team Folders in it. Everything but the files is in memory and
 * gone when it stops.
 *
 * One door DSM does not have: `POST /fake/move`, JSON `{ evt_id, by, shift }`
 * (seconds to move it by) or `{ evt_id, by, dtstart, dtend }`, or
 * `{ evt_id, by, delete: true }`. It changes an event as `by` would on their
 * phone, for seeing the app notice drift.
 *
 * A calendar shared with someone may be listed for them under a `cal_id` of
 * their own, its `original_cal_id` staying the owner's (src/types.ts,
 * sameCalendar). `alias(who, cal_id, as)` on the handle makes it so here: from
 * then on `who` sees the calendar, and its events, as `as`, and must address
 * them by it. An event asked for by `get`, `set` or `delete` under a `cal_id`
 * that is not its calendar as the asker sees it is a 9009, as it would be on
 * a calendar they do not have.
 *
 * Where the app's client guesses at a shape DSM does not document (comments in
 * src/synology.ts saying "the check shows it" or "first real use"), this
 * answers the guess. It proves the app and the fake agree, not that DSM does;
 * tools/synology-check is for that.
 *
 * Accounts and their passwords are test values in .env, never real DSM ones.
 * It listens on loopback only: a sign-in server that says yes to known
 * passwords has no business being reachable from the rest of the network.
 *
 * Not application code, and not in the image — the Dockerfile copies src/ only.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize, posix, relative, sep } from 'node:path';

export interface Account {
  readonly password: string;
  readonly otp?: string | null;
  /** In DSM's administrators group: may list that group and the accounts. */
  readonly admin?: boolean;
}

export interface FakeDsm {
  readonly port: number;
  /** The directory File Station's paths are under. */
  readonly root: string;
  /** From now on `who` sees calendar `cal_id` (one shared with them) as `as`. */
  alias(who: string, cal_id: string, as: string): void;
  /**
   * How Drive's asynchronous move behaves, read afresh on every move so a test
   * can change it between moves. `delayMs`: how long after answering its task
   * id the file is at its new path. The moved file keeps its `permanent_link`,
   * as on the real NAS. `refuse`: file names whose move is refused at once with 1001.
   */
  readonly moves: { delayMs: number; refuse: Set<string> };
  close(): Promise<void>;
}

/** `name:password`, `name:password:otp` or `name:password:otp:admin` (`alice:pw::admin`), comma separated. */
export const parseAccounts = (raw: string): Record<string, Account> => {
  const accounts: Record<string, Account> = {};
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, password, otp, admin] = entry.split(':');
    if (!name || !password) throw new Error(`FAKE_DSM_ACCOUNTS entry "${name ?? entry}" has no password`);
    accounts[name.toLowerCase()] = { password, otp: otp || null, admin: admin === 'admin' };
  }
  return accounts;
};

// DSM's own numbering where there is one; the rest are this fake's choices,
// listed in the README.
const NO_SUCH_API = 102;
const NO_SUCH_METHOD = 103;
const NO_PERMISSION = 105;
const MISSING_PARAM = 114;
const SID_NOT_FOUND = 119;
const BAD_PARAM = 120;
/** The client's assumption for a stale etag (src/synology.ts, setEvent). */
const ETAG_MISMATCH = 9006;
/** No such calendar or event, or not one this account may touch. */
const NO_SUCH_CAL = 9009;
/** Calendar's "Parameter error"; the real NAS gave it for `SYNO.Cal.Cal list` with no parameters. */
const PARAMETER_ERROR = 9009;
const FS_NOT_FOUND = 408;
const FS_EXISTS = 414;
/** Drive: no such file or folder, or a path that is not in a Team Folder; confirmed on the real NAS (src/drive.ts, DRIVE_NO_SUCH_FILE). */
const DRIVE_NOT_FOUND = 1003;
/** Drive: a name already taken where a folder is made; confirmed on the real NAS (src/drive.ts, DRIVE_NAME_TAKEN). A move onto one is accepted, not refused. */
const DRIVE_NAME_TAKEN = 1022;
/** Drive: a move told to fail (`moves.refuse`); this fake's choice. */
const DRIVE_MOVE_REFUSED = 1001;

/** Drive's REST door, and where its paths for Team Folders start. */
const DRIVE_BASE = '/api/SynologyDrive/default/v2';
const TEAM_FOLDERS = '/team-folders/';
/** How much of a file a search hit shows either side of the words. */
const SNIPPET_CHARS = 60;

/** A refusal, thrown inside a handler and answered as DSM would. */
class Refuse extends Error {
  readonly code: number;
  constructor(code: number) { super(`code ${code}`); this.code = code; }
}

type Privilege = 'RO' | 'RW';

interface Calendar {
  cal_id: string;
  owner: string;
  displayname: string;
  description: string;
  color: string;
  type: 'event' | 'todo';
  isDefault: boolean;
  /** Replaced whole by Sharing.set, as the client believes DSM does. */
  share: { ug_name: string; cal_privilege: Privilege }[];
  /** Kept as sent, and handed back by Sharing.get, so a client that drops them shows it. */
  groups: unknown[];
}

interface CalEvent {
  evt_id: number;
  cal_id: string;
  ical_uid: string;
  dav_etag: string;
  summary: string;
  description: string;
  is_all_day: boolean;
  dtstart: number;
  dtend: number;
  tz_id: string;
  color: string;
  /** The account that made or last changed it, as the client guesses DSM names it. */
  last_modify_user: string;
}

interface Contact {
  id: number;
  addressbook_id: number;
  full_name: string;
  tel: unknown;
  email: unknown;
  org: string;
}

/** What Drive knows of a file or folder beyond its bytes. */
interface DriveMeta {
  file_id: number;
  permanent_link: string;
  /** Up by one on every Drive write. */
  version: number;
  change_id: number;
  /** The sha256 last seen, so an edit made outside Drive is noticed when next asked about. */
  hash: string;
  /** Seen once and since found gone from disk: that took a change_id of its own. */
  gone: boolean;
}

const ADDRESSBOOK = { id: 1, name: 'Personal' } as const;

/** The APIs answered, for SYNO.API.Info. Versions are the ones the app asks for. */
const APIS: Record<string, [number, number]> = {
  'SYNO.API.Info': [1, 1], 'SYNO.API.Auth': [1, 6],
  'SYNO.Cal.Cal': [1, 5], 'SYNO.Cal.Sharing': [1, 1], 'SYNO.Cal.Event': [1, 5],
  'SYNO.Contacts.Addressbook': [1, 1], 'SYNO.Contacts.Contact': [1, 1],
  'SYNO.FileStation.CreateFolder': [1, 2], 'SYNO.FileStation.List': [1, 2],
  'SYNO.FileStation.Upload': [1, 2], 'SYNO.FileStation.Download': [1, 2], 'SYNO.FileStation.CopyMove': [1, 3],
  'SYNO.Core.Group.Member': [1, 1], 'SYNO.Core.User': [1, 1],
};

const reply = (res: ServerResponse, body: unknown): void => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const fail = (res: ServerResponse, code: number): void => reply(res, { success: false, error: { code } });

const readAll = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

/** The text fields and the one file of a multipart body, enough for File Station's upload. */
function parseMultipart(body: Buffer, contentType: string):
  { fields: Map<string, string>; file: { name: string; bytes: Buffer } | null } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const fields = new Map<string, string>();
  let file: { name: string; bytes: Buffer } | null = null;
  if (!boundary) return { fields, file };
  const delim = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let at = body.indexOf(delim);
  while (at >= 0) {
    const start = at + delim.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delim, start);
    if (next < 0) break;
    // Each part: CRLF, headers, CRLF CRLF, content, CRLF.
    const part = body.subarray(start + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    if (split >= 0) {
      const head = part.subarray(0, split).toString('utf8');
      const content = part.subarray(split + 4);
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      if (filename !== undefined) file = { name: filename.replace(/%22/g, '"'), bytes: Buffer.from(content) };
      else if (name) fields.set(name, content.toString('utf8'));
    }
    at = next;
  }
  return { fields, file };
}

const sidFromCookie = (header: string | undefined): string | null => {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'id') return v.join('=');
  }
  return null;
};

const hex = (n: number): string => randomBytes(n).toString('hex');

export async function start(opts: {
  port: number;
  accounts: Readonly<Record<string, Account>>;
  /** Where File Station keeps files. A fresh temporary directory when omitted. */
  root?: string;
  /** The top-level folders under root that Drive serves as Team Folders, made at start. `['Planner']` when omitted. */
  teamFolders?: readonly string[];
  /** Account → the Team Folders it may only read: a write, a new folder or a move into one is 105. */
  readOnly?: Readonly<Record<string, readonly string[]>>;
  host?: string;
  /** Where its one-line notes go. Never a password, a code or a whole sid. */
  log?: (line: string) => void;
}): Promise<FakeDsm> {
  const accounts = new Map(Object.entries(opts.accounts).map(([k, v]) => [k.toLowerCase(), v]));
  const root = opts.root ?? await mkdtemp(join(tmpdir(), 'fake-dsm-'));
  await mkdir(root, { recursive: true });
  const teamFolders = [...(opts.teamFolders ?? ['Planner'])];
  for (const name of teamFolders) {
    if (!name || /[/\\]/.test(name) || name === '.' || name === '..') {
      throw new Error(`a Team Folder is a folder name under the root, not "${name}"`);
    }
    await mkdir(join(root, name), { recursive: true });
  }
  const log =opts.log ?? ((line: string) => console.log(`[fake-dsm] ${line}`));
  const readOnly = new Map(Object.entries(opts.readOnly ?? {}).map(([k, v]) => [k.toLowerCase(), new Set(v)]));
  const moves: FakeDsm['moves'] = { delayMs: 0, refuse: new Set() };
  /** Moves told to wait, so closing the fake does not leave them to fire into a deleted directory. */
  const pendingMoves = new Set<NodeJS.Timeout>();

  /** Session id → account. */
  const issued = new Map<string, string>();
  const calendars = new Map<string, Calendar>();
  const events = new Map<number, CalEvent>();
  const contacts = new Map<number, Contact>();
  let nextEvt = 1;
  let nextContact = 1;

  /** Every account has a calendar of its own and a task list, as on DSM. */
  const seed = (who: string): void => {
    if (calendars.has(`/${who}/home/`)) return;
    calendars.set(`/${who}/home/`, {
      cal_id: `/${who}/home/`, owner: who, displayname: 'My Calendar', description: '',
      color: '#5B8DEF', type: 'event', isDefault: true, share: [], groups: [],
    });
    calendars.set(`/${who}/home_todo/`, {
      cal_id: `/${who}/home_todo/`, owner: who, displayname: 'My Tasks', description: '',
      color: '#5B8DEF', type: 'todo', isDefault: false, share: [], groups: [],
    });
  };

  // ── parameters ────────────────────────────────────────────────────────────
  const need = (p: URLSearchParams, key: string): string => {
    const v = p.get(key);
    if (v === null || v === '') throw new Refuse(MISSING_PARAM);
    return v;
  };
  const num = (p: URLSearchParams, key: string): number => {
    const n = Number(need(p, key));
    if (!Number.isFinite(n)) throw new Refuse(BAD_PARAM);
    return n;
  };
  const bool = (p: URLSearchParams, key: string, fallback = false): boolean => {
    const v = p.get(key);
    return v === null ? fallback : v === 'true';
  };
  const parsed = (p: URLSearchParams, key: string): unknown => {
    const v = p.get(key);
    if (v === null) return undefined;
    try { return JSON.parse(v) as unknown; } catch { throw new Refuse(BAD_PARAM); }
  };

  // ── calendars ─────────────────────────────────────────────────────────────
  const privilegeOf = (cal: Calendar, who: string): Privilege | null =>
    cal.owner === who ? 'RW' : cal.share.find((u) => u.ug_name === who)?.cal_privilege ?? null;

  /** Per account: a shared calendar's real id → the id that account sees it by. */
  const aliases = new Map<string, Map<string, string>>();
  /** The id `who` sees a calendar by. */
  const seenAs = (cal_id: string, who: string): string => aliases.get(who)?.get(cal_id) ?? cal_id;
  /** The calendar `who` means by `cal_id`, or null when that is not an id they know it by. */
  const meant = (cal_id: string, who: string): string | null => {
    const theirs = aliases.get(who);
    if (!theirs) return cal_id;
    for (const [real, as] of theirs) if (as === cal_id) return real;
    return theirs.has(cal_id) ? null : cal_id;
  };

  const rawCalendar = (cal: Calendar, who: string) => ({
    cal_id: seenAs(cal.cal_id, who), original_cal_id: cal.cal_id,
    cal_displayname: cal.displayname, cal_description: cal.description, cal_color: cal.color,
    cal_privilege: privilegeOf(cal, who) ?? 'RO', cal_type: cal.type,
    default_calendar: cal.isDefault && cal.owner === who,
  });

  /** The calendar, if this account may see it by that id, and may write to it when `write`. */
  const calendarFor = (cal_id: string, who: string, write = false): Calendar => {
    const real = meant(cal_id, who);
    const cal = real === null ? undefined : calendars.get(real);
    const may = cal ? privilegeOf(cal, who) : null;
    if (!cal || !may || (write && may !== 'RW')) throw new Refuse(NO_SUCH_CAL);
    return cal;
  };

  const ownCalendar = (cal_id: string, who: string): Calendar => {
    const cal = calendarFor(cal_id, who);
    if (cal.owner !== who) throw new Refuse(NO_SUCH_CAL);
    return cal;
  };

  /** An event as `who` sees it: on its calendar under the id they know that calendar by. */
  const rawEvent = (e: CalEvent, who: string) => ({ ...e, cal_id: seenAs(e.cal_id, who), original_cal_id: e.cal_id });

  /** The event, if this account may see it; a `cal_id`, when sent, must be its calendar as they know it. */
  const eventFor = (p: URLSearchParams, who: string, write = false): CalEvent => {
    const e = events.get(num(p, 'evt_id'));
    if (!e) throw new Refuse(NO_SUCH_CAL);
    calendarFor(seenAs(e.cal_id, who), who, write);
    const asked = p.get('cal_id');
    if (asked && meant(asked, who) !== e.cal_id) throw new Refuse(NO_SUCH_CAL);
    return e;
  };

  const handlers: Record<string, Record<string, (p: URLSearchParams, who: string) => unknown>> = {
    'SYNO.Cal.Cal': {
      // The real NAS answered a `list` with no parameters 9009 (2026-11-03).
      // The guide marks `cal_type` required and its examples send `is_evt`;
      // which one the NAS wants is not known, so this asks for both. The
      // reply is wrapped as the guide shows it, `{ list }`.
      list: (p, who) => {
        const type = p.get('cal_type');
        if (!p.has('is_evt') || (type !== 'event' && type !== 'todo' && type !== 'all')) throw new Refuse(PARAMETER_ERROR);
        return {
          list: [...calendars.values()]
            .filter((c) => privilegeOf(c, who) && (type === 'all' || c.type === type))
            .map((c) => rawCalendar(c, who)),
        };
      },
      create: (p, who) => {
        const displayname = need(p, 'cal_displayname');
        const cal: Calendar = {
          cal_id: `/${who}/${hex(4)}/`, owner: who, displayname,
          description: p.get('cal_description') ?? '', color: p.get('cal_color') || '#5B8DEF',
          type: p.get('cal_type') === 'todo' ? 'todo' : 'event', isDefault: false, share: [], groups: [],
        };
        calendars.set(cal.cal_id, cal);
        log(`${who} made calendar "${displayname}" ${cal.cal_id}`);
        return rawCalendar(cal, who);
      },
      set: (p, who) => {
        const cal = ownCalendar(need(p, 'cal_id'), who);
        if (p.has('cal_displayname')) cal.displayname = p.get('cal_displayname')!;
        if (p.has('cal_description')) cal.description = p.get('cal_description')!;
        if (p.has('cal_color')) cal.color = p.get('cal_color')!;
        return rawCalendar(cal, who);
      },
      // Its owner's to delete, with its events: as deleting it in Synology Calendar does.
      delete: (p, who) => {
        const cal = ownCalendar(need(p, 'cal_id'), who);
        calendars.delete(cal.cal_id);
        for (const [id, e] of events) if (e.cal_id === cal.cal_id) events.delete(id);
        log(`${who} deleted calendar "${cal.displayname}" ${cal.cal_id}`);
        return {};
      },
    },

    'SYNO.Cal.Sharing': {
      // Nested under cal_share_setting, the client's first guess.
      get: (p, who) => {
        const cal = ownCalendar(need(p, 'cal_id'), who);
        return { cal_share_setting: { DSM_USER: cal.share.map((u) => ({ ...u })), DSM_GROUP: structuredClone(cal.groups) } };
      },
      // A whole-list replace, as the client believes.
      set: (p, who) => {
        const cal = ownCalendar(need(p, 'cal_id'), who);
        const setting = parsed(p, 'cal_share_setting') as { DSM_USER?: unknown; DSM_GROUP?: unknown } | undefined;
        if (!setting || !Array.isArray(setting.DSM_USER)) throw new Refuse(BAD_PARAM);
        if (setting.DSM_GROUP !== undefined && !Array.isArray(setting.DSM_GROUP)) throw new Refuse(BAD_PARAM);
        const users = setting.DSM_USER as { ug_name?: unknown; cal_privilege?: unknown }[];
        if (!users.every((u) => typeof u.ug_name === 'string' && (u.cal_privilege === 'RO' || u.cal_privilege === 'RW'))) {
          throw new Refuse(BAD_PARAM);
        }
        cal.share = users.map((u) => ({ ug_name: u.ug_name as string, cal_privilege: u.cal_privilege as Privilege }));
        cal.groups = (setting.DSM_GROUP as unknown[] | undefined) ?? [];
        log(`${who} shared ${cal.cal_id} with ${cal.share.map((u) => `${u.ug_name}:${u.cal_privilege}`).join(', ') || 'nobody'}`);
        return {};
      },
    },

    'SYNO.Cal.Event': {
      create: (p, who) => {
        const cal = calendarFor(need(p, 'cal_id'), who, true);
        const e: CalEvent = {
          evt_id: nextEvt++, cal_id: cal.cal_id, ical_uid: `${hex(8)}@fake-dsm`, dav_etag: hex(6),
          summary: p.get('summary') ?? '', description: p.get('description') ?? '',
          is_all_day: bool(p, 'is_all_day'), dtstart: num(p, 'dtstart'), dtend: num(p, 'dtend'),
          tz_id: p.get('tz_id') ?? '', color: p.get('color') ?? '', last_modify_user: who,
        };
        events.set(e.evt_id, e);
        return rawEvent(e, who);
      },
      // `evt_id` is all it needs; cal_id, when sent, must be the event's calendar as the asker knows it.
      get: (p, who) => rawEvent(eventFor(p, who), who),
      list: (p, who) => {
        const ids = parsed(p, 'cal_id_list');
        if (!Array.isArray(ids)) throw new Refuse(MISSING_PARAM);
        const from = num(p, 'start');
        const to = num(p, 'end');
        const visible = new Set(ids.flatMap((id) => {
          const real = typeof id === 'string' ? meant(id, who) : null;
          return real !== null && calendars.has(real) && privilegeOf(calendars.get(real)!, who) !== null ? [real] : [];
        }));
        // Wrapped as the guide shows it, `{ list }`.
        return {
          list: [...events.values()]
            .filter((e) => visible.has(e.cal_id) && e.dtstart < to && e.dtend > from)
            .sort((a, b) => a.dtstart - b.dtstart)
            .map((e) => rawEvent(e, who)),
        };
      },
      set: (p, who) => {
        const e = eventFor(p, who, true);
        if (need(p, 'dav_etag') !== e.dav_etag) throw new Refuse(ETAG_MISMATCH);
        if (p.has('summary')) e.summary = p.get('summary')!;
        if (p.has('description')) e.description = p.get('description')!;
        if (p.has('is_all_day')) e.is_all_day = bool(p, 'is_all_day');
        if (p.has('dtstart')) e.dtstart = num(p, 'dtstart');
        if (p.has('dtend')) e.dtend = num(p, 'dtend');
        if (p.has('tz_id')) e.tz_id = p.get('tz_id')!;
        e.dav_etag = hex(6);
        e.last_modify_user = who;
        return rawEvent(e, who);
      },
      delete: (p, who) => {
        events.delete(eventFor(p, who, true).evt_id);
        return {};
      },
    },

    // One address book, shared by every account. Rows as the client guesses
    // DSM spells them: tel and email as lists of { value }.
    'SYNO.Contacts.Addressbook': {
      list: () => [{ ...ADDRESSBOOK }],
    },
    'SYNO.Contacts.Contact': {
      list: (p) => {
        const book = p.get('addressbook_id');
        const offset = Number(p.get('offset') ?? 0);
        const limit = Number(p.get('limit') ?? 1000);
        return [...contacts.values()]
          .filter((c) => book === null || c.addressbook_id === Number(book))
          .slice(offset, offset + limit);
      },
      get: (p) => {
        const c = contacts.get(num(p, 'id'));
        if (!c) throw new Refuse(BAD_PARAM);
        return c;
      },
      create: (p) => {
        if (num(p, 'addressbook_id') !== ADDRESSBOOK.id) throw new Refuse(BAD_PARAM);
        const c: Contact = {
          id: nextContact++, addressbook_id: ADDRESSBOOK.id, full_name: need(p, 'full_name'),
          tel: parsed(p, 'tel') ?? [], email: parsed(p, 'email') ?? [], org: p.get('org') ?? '',
        };
        contacts.set(c.id, c);
        return c;
      },
      set: (p) => {
        const c = contacts.get(num(p, 'id'));
        if (!c) throw new Refuse(BAD_PARAM);
        if (p.has('full_name')) c.full_name = p.get('full_name')!;
        if (p.has('tel')) c.tel = parsed(p, 'tel');
        if (p.has('email')) c.email = parsed(p, 'email');
        if (p.has('org')) c.org = p.get('org')!;
        return c;
      },
    },
    // Who is an administrator, and which accounts exist. Only an administrator
    // may ask, as on DSM; anyone else is refused as having no permission.
    'SYNO.Core.Group.Member': {
      list: (p, who) => {
        if (!accounts.get(who)?.admin) throw new Refuse(NO_PERMISSION);
        if (p.get('group') !== 'administrators') throw new Refuse(BAD_PARAM);
        return named([...accounts].filter(([, a]) => a.admin).map(([name]) => name));
      },
    },
    'SYNO.Core.User': {
      list: (_p, who) => {
        if (!accounts.get(who)?.admin) throw new Refuse(NO_PERMISSION);
        return named([...accounts.keys()]);
      },
    },
  };
  const named = (names: string[]) => ({ users: names.map((name) => ({ name })), total: names.length });

  // ── File Station, on `root` ───────────────────────────────────────────────
  /** A DSM path as a path under root; `..` cannot climb out. */
  const onDisk = (dsmPath: string): string => {
    const rel = normalize(`/${dsmPath}`).replace(/^(\.\.[/\\])+/, '');
    const full = join(root, rel);
    if (!full.startsWith(root)) throw new Refuse(BAD_PARAM);
    return full;
  };
  const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

  /** The task ids `CopyMove` start has handed out. */
  const fileStationTasks = new Set<string>();
  const fileStation: Record<string, Record<string, (p: URLSearchParams) => Promise<unknown>>> = {
    'SYNO.FileStation.CreateFolder': {
      create: async (p) => {
        const parent = need(p, 'folder_path');
        const name = need(p, 'name');
        if (!bool(p, 'force_parent') && !(await exists(onDisk(parent)))) throw new Refuse(FS_NOT_FOUND);
        await mkdir(onDisk(`${parent}/${name}`), { recursive: true });
        return { folders: [{ isdir: true, name, path: `${parent}/${name}` }] };
      },
    },
    'SYNO.FileStation.List': {
      // The top-level folders under root stand for the NAS's shared folders.
      list_share: async () => {
        const entries = await readdir(root, { withFileTypes: true });
        const shares = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
          .map((name) => ({ isdir: true, name, path: `/${name}` }));
        return { shares, offset: 0, total: shares.length };
      },
      list: async (p) => {
        const folder = need(p, 'folder_path');
        let names: string[];
        try { names = await readdir(onDisk(folder)); } catch { throw new Refuse(FS_NOT_FOUND); }
        const files = await Promise.all(names.sort().map(async (name) => {
          const info = await stat(join(onDisk(folder), name));
          return { isdir: info.isDirectory(), name, path: `${folder}/${name}`, additional: { size: info.size } };
        }));
        return { files, offset: 0, total: files.length };
      },
    },
    // A move only: the source removed, nothing overwritten, which is all the app asks for.
    // It is done before `start` answers, so `status` always says finished. A name
    // already taken at the destination is as Upload has it: overwrite=false skips
    // the file and the task still finishes, and left out, it is refused with 414.
    'SYNO.FileStation.CopyMove': {
      start: async (p) => {
        if (!bool(p, 'remove_src') || bool(p, 'overwrite')) throw new Refuse(BAD_PARAM);
        const raw = need(p, 'path');
        const listed = parsed(p, 'path');
        const sources = Array.isArray(listed) ? listed.map(String) : raw.split(',');
        if (sources.length !== 1) throw new Refuse(BAD_PARAM);
        const from = onDisk(sources[0]!);
        const destDir = onDisk(need(p, 'dest_folder_path'));
        if (!(await exists(from)) || !(await stat(destDir).catch(() => null))?.isDirectory()) throw new Refuse(FS_NOT_FOUND);
        const to = join(destDir, basename(from));
        const taskid = `FileStation_${hex(6)}`;
        if (await exists(to)) {
          if (p.get('overwrite') === null) throw new Refuse(FS_EXISTS);
          fileStationTasks.add(taskid);
          log(`skipped ${sources[0]!}: ${need(p, 'dest_folder_path')} has a file by that name`);
          return { taskid };
        }
        await rename(from, to);
        fileStationTasks.add(taskid);
        log(`moved ${sources[0]!} to ${need(p, 'dest_folder_path')} with File Station`);
        return { taskid };
      },
      status: async (p) => {
        const taskid = need(p, 'taskid');
        if (!fileStationTasks.has(taskid)) throw new Refuse(BAD_PARAM);
        return { finished: true, progress: 1, taskid };
      },
    },
  };

  /** Upload: multipart, the sid a text part, the destination before the file. */
  const upload = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { fields, file } = parseMultipart(await readAll(req), req.headers['content-type'] ?? '');
    const who = issued.get(fields.get('_sid') ?? '');
    if (!who) { fail(res, SID_NOT_FOUND); return; }
    if (fields.get('api') !== 'SYNO.FileStation.Upload' || fields.get('method') !== 'upload') { fail(res, NO_SUCH_METHOD); return; }
    const folder = fields.get('path');
    if (!folder || !file) { fail(res, MISSING_PARAM); return; }
    try {
      const dir = onDisk(folder);
      if (!(await exists(dir))) {
        if (fields.get('create_parents') !== 'true') throw new Refuse(FS_NOT_FOUND);
        await mkdir(dir, { recursive: true });
      }
      const target = onDisk(`${folder}/${file.name}`);
      // As the File Station guide has it: overwrite=true replaces, overwrite=false
      // skips the file and still answers success, and left out, a file already
      // there is refused with 414.
      const overwrite = fields.get('overwrite');
      if (await exists(target) && overwrite !== 'true') {
        if (overwrite === undefined) throw new Refuse(FS_EXISTS);
        log(`${who} skipped ${folder}/${file.name}: it is already there`);
        reply(res, { success: true, data: {} });
        return;
      }
      await writeFile(target, file.bytes);
      log(`${who} uploaded ${folder}/${file.name} (${file.bytes.length} bytes)`);
      reply(res, { success: true, data: {} });
    } catch (err) {
      if (err instanceof Refuse) { fail(res, err.code); return; }
      throw err;
    }
  };

  /** Download: a GET, the sid in the `id` cookie, the bytes or DSM's JSON refusal. */
  const download = async (req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> => {
    const who = issued.get(sidFromCookie(req.headers.cookie) ?? '');
    if (!who) { fail(res, SID_NOT_FOUND); return; }
    if (url.searchParams.get('method') !== 'download') { fail(res, NO_SUCH_METHOD); return; }
    const path = url.searchParams.get('path');
    if (!path) { fail(res, MISSING_PARAM); return; }
    let bytes: Buffer;
    try {
      const full = onDisk(path);
      if (!(await stat(full)).isFile()) throw new Error('not a file');
      bytes = await readFile(full);
    } catch {
      fail(res, FS_NOT_FOUND);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    res.end(bytes);
  };

  // ── Synology Drive, on the same root ──────────────────────────────────────
  // Drive's own REST door under DRIVE_BASE, the sid in the `id` cookie only.
  // `/team-folders/<name>/<rel>` is `<root>/<name>/<rel>`, the bytes File
  // Station sees, for a name in `teamFolders`; anything else is 1003. What
  // Drive knows of a file beyond its bytes is kept here, keyed by its path on
  // disk, and brought up to date whenever the file is asked about.

  /** Path on disk → what Drive knows of it. */
  const metas = new Map<string, DriveMeta>();
  /** permanent_link → path on disk. */
  const links = new Map<string, string>();
  let nextFileId = 1;
  /** The last change_id handed out; every write, every hash change seen and every deletion seen takes the next. */
  let lastChange = 0;

  /** A file or folder seen before is not on disk now: the first time that is noticed, it is a change. */
  const noticeGone = (meta: DriveMeta | undefined): void => {
    if (!meta || meta.gone) return;
    meta.gone = true;
    meta.change_id = ++lastChange;
  };

  /** A Drive path, or `link:<permanent_link>`, as a path on disk. */
  const driveOnDisk = (path: string): string => {
    if (path.startsWith('link:')) {
      const full = links.get(path.slice('link:'.length));
      if (!full) throw new Refuse(DRIVE_NOT_FOUND);
      return full;
    }
    // normalize first, so `..` cannot climb out of a Team Folder into another share.
    const clean = posix.normalize(path);
    if (!clean.startsWith(TEAM_FOLDERS)) throw new Refuse(DRIVE_NOT_FOUND);
    const [name, ...rest] = clean.slice(TEAM_FOLDERS.length).split('/');
    if (!name || !teamFolders.includes(name)) throw new Refuse(DRIVE_NOT_FOUND);
    return join(root, name, ...rest);
  };
  const drivePath = (full: string): string => `${TEAM_FOLDERS}${relative(root, full).split(sep).join('/')}`;
  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const statOf = (full: string) => stat(full).catch(() => null);

  /**
   * What Drive knows of the file or folder at `full`, brought up to date: a
   * link and version 1 on first sight, and a new change_id when a file's bytes
   * no longer hash to what was last seen, or when it is back after being gone.
   * 1003 when nothing is there, by path or by link alike.
   */
  const sighted = async (full: string): Promise<{ meta: DriveMeta; isDir: boolean; mtime: number }> => {
    const info = await statOf(full);
    if (!info) {
      noticeGone(metas.get(full));
      throw new Refuse(DRIVE_NOT_FOUND);
    }
    const hash = info.isDirectory() ? '' : sha256(await readFile(full));
    let meta = metas.get(full);
    if (!meta) {
      meta = { file_id: nextFileId++, permanent_link: randomUUID(), version: 1, change_id: ++lastChange, hash, gone: false };
      metas.set(full, meta);
      links.set(meta.permanent_link, full);
    } else if (meta.gone || meta.hash !== hash) {
      Object.assign(meta, { hash, gone: false, change_id: ++lastChange });
    }
    return { meta, isDir: info.isDirectory(), mtime: Math.floor(info.mtimeMs / 1000) };
  };

  /** Everything under a folder, however deep, in path order. */
  const under = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { recursive: true })).sort().map((rel) => join(dir, rel));

  /**
   * A file or folder as Drive answers it. A folder's change_id and max_id are
   * the largest under it, deletions included, so a change anywhere below moves
   * them: everything on disk under it is looked at, and anything seen there
   * before that is not there now is noticed gone. One at a time, never in
   * parallel, so a first sighting cannot be made twice.
   */
  const driveFile = async (full: string): Promise<Record<string, unknown>> => {
    const { meta, isDir, mtime } = await sighted(full);
    let change = meta.change_id;
    if (isDir) {
      const present = new Set(await under(full));
      for (const p of present) await sighted(p);
      for (const [p, m] of metas) {
        if (!p.startsWith(`${full}${sep}`)) continue;
        if (!present.has(p)) noticeGone(m);
        change = Math.max(change, m.change_id);
      }
    }
    // As the real NAS answers (2026-11-03): `display_path` is the whole
    // `/team-folders/<team>/…`, `path` is relative to the Team Folder.
    const display = drivePath(full);
    const path = display.replace(/^\/team-folders\/[^/]+/, '') || '/';
    return {
      file_id: String(meta.file_id), permanent_link: meta.permanent_link, name: basename(full),
      path, display_path: display, type: isDir ? 'dir' : 'file', hash: meta.hash, version_id: meta.version,
      change_id: change, max_id: change, modified_time: mtime, removed: false,
    };
  };

  const folderOnDisk = async (path: string): Promise<string> => {
    const full = driveOnDisk(path);
    if (!(await statOf(full))?.isDirectory()) throw new Refuse(DRIVE_NOT_FOUND);
    return full;
  };
  const pathParam = (url: URL): string => {
    const path = url.searchParams.get('path');
    if (!path) throw new Refuse(MISSING_PARAM);
    return path;
  };
  /** The Team Folder a path on disk is in, and 105 if this account may only read it. */
  const mayWrite = (who: string, full: string): void => {
    if (readOnly.get(who)?.has(relative(root, full).split(sep)[0] ?? '')) throw new Refuse(NO_PERMISSION);
  };
  let nextTask = 1;
  const objectOf = (text: string): Record<string, unknown> => {
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Refuse(BAD_PARAM); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Refuse(BAD_PARAM);
    return body as Record<string, unknown>;
  };
  const jsonOf = async (req: IncomingMessage): Promise<Record<string, unknown>> =>
    objectOf((await readAll(req)).toString('utf8'));
  /** A JSON body that may be left out; one that is there must be an object. */
  const optionalJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const text = (await readAll(req)).toString('utf8');
    return text.trim() ? objectOf(text) : {};
  };

  /** `METHOD route` → its answer: the `data` of a success, or a Buffer, which is sent as the bytes. */
  const driveRoutes: Record<string, (req: IncomingMessage, url: URL, who: string) => Promise<unknown>> = {
    'GET files': async (_req, url) => driveFile(driveOnDisk(pathParam(url))),

    // The body is optional; `filter.type: ['dir']` leaves the files out.
    'POST files/list': async (req, url) => {
      const dir = await folderOnDisk(pathParam(url));
      const filter = (await optionalJson(req))['filter'];
      const types = typeof filter === 'object' && filter !== null ? (filter as { type?: unknown }).type : undefined;
      if (types !== undefined && (!Array.isArray(types) || types.some((t) => t !== 'dir' && t !== 'file'))) throw new Refuse(BAD_PARAM);
      const items: unknown[] = [];
      for (const name of (await readdir(dir)).sort()) {
        const full = join(dir, name);
        if (Array.isArray(types) && !types.includes((await statOf(full))?.isDirectory() ? 'dir' : 'file')) continue;
        items.push(await driveFile(full));
      }
      return { items, total: items.length };
    },

    // A folder only, under a parent that is there; a name already taken is refused, as `conflict_action=stop` asks.
    'POST files': async (req, url, who) => {
      if (url.searchParams.get('type') !== 'folder' || url.searchParams.get('conflict_action') !== 'stop') throw new Refuse(BAD_PARAM);
      await jsonOf(req);
      const full = driveOnDisk(pathParam(url));
      mayWrite(who, full);
      if (!(await statOf(dirname(full)))?.isDirectory()) throw new Refuse(DRIVE_NOT_FOUND);
      if (await statOf(full)) throw new Refuse(DRIVE_NAME_TAKEN);
      await mkdir(full);
      log(`${who} made folder ${drivePath(full)} on Drive`);
      return driveFile(full);
    },

    // One file to a new parent, never over a name that is taken. It answers its
    // task id at once; the file is at its new path after `moves.delayMs`. A move
    // onto a taken name is accepted like any other and then does nothing, both
    // files left as they were, as the real NAS does (2026-11-03).
    'POST files/move': async (req, _url, who) => {
      const body = await jsonOf(req);
      const { files, to_parent_folder: toParent } = body;
      if (!Array.isArray(files) || !files.length || typeof toParent !== 'string') throw new Refuse(MISSING_PARAM);
      if (files.length !== 1 || typeof files[0] !== 'string' || body['conflict_action'] !== 'stop') throw new Refuse(BAD_PARAM);
      const from = driveOnDisk(files[0]);
      const info = await statOf(from);
      if (!info) throw new Refuse(DRIVE_NOT_FOUND);
      if (!info.isFile()) throw new Refuse(BAD_PARAM);
      const to = join(await folderOnDisk(toParent), basename(from));
      mayWrite(who, from);
      mayWrite(who, to);
      if (moves.refuse.has(basename(from))) throw new Refuse(DRIVE_MOVE_REFUSED);
      await sighted(from);
      const task = `task-${nextTask++}`;
      const { delayMs } = moves;
      const settle = async (): Promise<void> => {
        if (!(await statOf(from)) || await statOf(to)) { log(`${who}'s move of ${drivePath(from)} found things changed, and did nothing`); return; }
        await rename(from, to);
        const meta = metas.get(from)!;
        // What stays behind is a file that is gone, under a link of its own.
        const left = { ...meta, permanent_link: randomUUID(), gone: true, change_id: ++lastChange };
        metas.set(from, left);
        links.set(left.permanent_link, from);
        links.set(meta.permanent_link, to);
        meta.change_id = ++lastChange;
        metas.set(to, meta);
        log(`${who} moved ${drivePath(from)} to ${drivePath(to)} on Drive`);
      };
      if (delayMs > 0) {
        const timer = setTimeout(() => {
          pendingMoves.delete(timer);
          settle().catch((err: unknown) => log(`a move on Drive failed: ${(err as Error).message}`));
        }, delayMs);
        pendingMoves.add(timer);
      } else {
        await settle();
      }
      return { async_task_id: task };
    },

    // Always a new version: the app only ever asks for one, and anything else is
    // refused here, so a client that stops asking shows it.
    'PUT files/upload': async (req, _url, who) => {
      const { fields, file } = parseMultipart(await readAll(req), req.headers['content-type'] ?? '');
      const path = fields.get('path');
      if (!path || !file) throw new Refuse(MISSING_PARAM);
      if (fields.get('conflict_action') !== 'version') throw new Refuse(BAD_PARAM);
      const full = driveOnDisk(path);
      mayWrite(who, full);
      // Drive does not make the folders on the way; the app makes them through File Station first.
      if (!(await statOf(dirname(full)))?.isDirectory()) throw new Refuse(DRIVE_NOT_FOUND);
      const there = await statOf(full);
      if (there?.isDirectory()) throw new Refuse(BAD_PARAM);
      const meta = there ? (await sighted(full)).meta : metas.get(full) ?? null;
      await writeFile(full, file.bytes);
      // A file written again where one was deleted keeps its link, and gains a version.
      if (meta) Object.assign(meta, { version: meta.version + 1, hash: sha256(file.bytes), gone: false, change_id: ++lastChange });
      const now = await driveFile(full);
      log(`${who} wrote ${drivePath(full)} on Drive, version ${String(now['version_id'])}`);
      return now;
    },

    // One file only: Drive zips several, or a folder, and this does not.
    'POST files/download': async (req) => {
      const { files } = await jsonOf(req);
      if (!Array.isArray(files) || !files.length) throw new Refuse(MISSING_PARAM);
      if (files.length !== 1 || typeof files[0] !== 'string') throw new Refuse(BAD_PARAM);
      const full = driveOnDisk(files[0]);
      const info = await statOf(full);
      if (!info) throw new Refuse(DRIVE_NOT_FOUND);
      if (!info.isFile()) throw new Refuse(BAD_PARAM);
      return readFile(full);
    },

    // The words, any case, in a file's name or its text, under `location`
    // (`any` is every Team Folder); each hit with the passage around them.
    'POST files/search': async (req, url) => {
      const body = await jsonOf(req);
      const keyword = typeof body['keyword'] === 'string' ? body['keyword'] : '';
      const location = typeof body['location'] === 'string' ? body['location'] : '';
      if (!keyword || !location) throw new Refuse(MISSING_PARAM);
      const limit = Number(url.searchParams.get('limit') ?? Infinity);
      if (Number.isNaN(limit)) throw new Refuse(BAD_PARAM);
      const folders = location === 'any'
        ? teamFolders.map((name) => join(root, name))
        : [await folderOnDisk(location)];
      const words = keyword.toLowerCase();
      const items: unknown[] = [];
      for (const dir of folders) {
        for (const full of await under(dir)) {
          if (!(await statOf(full))?.isFile()) continue;
          const text = (await readFile(full)).toString('utf8');
          const at = text.toLowerCase().indexOf(words);
          if (at < 0 && !basename(full).toLowerCase().includes(words)) continue;
          const snippet = body['content_snippet'] === true && at >= 0
            ? text.slice(Math.max(0, at - SNIPPET_CHARS), at + keyword.length + SNIPPET_CHARS) : '';
          items.push({ ...(await driveFile(full)), content_snippet: snippet });
        }
      }
      return { items: items.slice(0, limit), total: items.length };
    },

    // Sorted by name, as Drive's default is. `can_write` is false for an account that may only read it.
    'GET team-folder': async (_req, _url, who) => {
      const items = [...teamFolders].sort().map((name) => ({
        name, team_id: name, path: `${TEAM_FOLDERS}${name}`,
        capabilities: { can_read: true, can_write: !readOnly.get(who)?.has(name) },
      }));
      return { items, total: items.length };
    },

    // Every account is a member; a viewer where it may only read, else an organizer.
    'GET team-folder/members': async (_req, url) => {
      // The spec's form is team_id="4" (double-quoted-string); the plain form is taken too, so a probe can compare.
      const team = url.searchParams.get('team_id')?.replace(/^"(.*)"$/, '$1');
      if (!team) throw new Refuse(MISSING_PARAM);
      if (!teamFolders.includes(team)) throw new Refuse(DRIVE_NOT_FOUND);
      const items = [...accounts.keys()].sort().map((name, i) => ({
        name, uid: 1026 + i, display_name: name, role: readOnly.get(name)?.has(team) ? 'viewer' : 'organizer',
      }));
      return { items, total: items.length };
    },
  };

  /** Drive: the route, then the sid from the `id` cookie, then the answer in DSM's envelope or the bytes. */
  const drive = async (req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> => {
    const run = driveRoutes[`${req.method ?? ''} ${url.pathname.slice(DRIVE_BASE.length + 1)}`];
    if (!run) { res.writeHead(404).end(); return; }
    if (url.searchParams.has('_sid')) {
      log('REFUSED: the sid arrived in a Drive URL, which the app promises never to do');
      fail(res, SID_NOT_FOUND);
      return;
    }
    const who = issued.get(sidFromCookie(req.headers.cookie) ?? '');
    if (!who) { fail(res, SID_NOT_FOUND); return; }
    try {
      const data = await run(req, url, who);
      if (Buffer.isBuffer(data)) {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
        res.end(data);
        return;
      }
      reply(res, { success: true, data });
    } catch (err) {
      if (err instanceof Refuse) { fail(res, err.code); return; }
      throw err;
    }
  };

  /**
   * Someone changes an event on their phone: not DSM's API, this fake's own
   * door. Moved by `shift` seconds, or to `dtstart`/`dtend`, or deleted; the
   * etag changes and `by` is who changed it.
   */
  const move = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: { evt_id?: unknown; by?: unknown; shift?: unknown; dtstart?: unknown; dtend?: unknown; delete?: unknown };
    try { body = JSON.parse((await readAll(req)).toString('utf8')) as typeof body; } catch { body = {}; }
    const e = events.get(Number(body.evt_id));
    const by = typeof body.by === 'string' ? body.by.toLowerCase() : '';
    if (!e || !accounts.has(by)) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('name an event that is there, and an account to move it as');
      return;
    }
    if (body.delete === true) {
      events.delete(e.evt_id);
      log(`${by} deleted event ${e.evt_id} on their phone`);
      reply(res, { deleted: e.evt_id });
      return;
    }
    const shift = Number(body.shift ?? 0);
    const start = body.dtstart === undefined ? e.dtstart + shift : Number(body.dtstart);
    const end = body.dtend === undefined ? e.dtend + shift : Number(body.dtend);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('an event ends after it starts');
      return;
    }
    Object.assign(e, { dtstart: start, dtend: end, dav_etag: hex(6), last_modify_user: by });
    log(`${by} moved event ${e.evt_id} on their phone`);
    reply(res, rawEvent(e, by));
  };

  // ── the one door ──────────────────────────────────────────────────────────
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log(`error: ${(err as Error).message}`);
      if (!res.headersSent) fail(res, 100);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake-dsm');
    if (url.pathname === '/fake/move' && req.method === 'POST') { await move(req, res); return; }
    if (url.pathname.startsWith(`${DRIVE_BASE}/`)) { await drive(req, url, res); return; }
    if (url.pathname !== '/webapi/entry.cgi') { res.writeHead(404).end(); return; }

    // Real DSM accepts a password or a sid in the query string. This refuses
    // both, because the app promises never to send either there — they would
    // land in DSM's access log — and a stand-in that quietly accepted them
    // could not catch that breaking.
    if (url.searchParams.has('passwd')) {
      log('REFUSED: the password arrived in the URL, which the app promises never to do');
      fail(res, 101);
      return;
    }
    if (url.searchParams.has('_sid')) {
      log('REFUSED: the sid arrived in the URL, which the app promises never to do');
      fail(res, SID_NOT_FOUND);
      return;
    }

    if (req.method === 'GET' && url.searchParams.get('api') === 'SYNO.FileStation.Download') {
      await download(req, url, res);
      return;
    }
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    if (/^multipart\/form-data/i.test(req.headers['content-type'] ?? '')) {
      await upload(req, res);
      return;
    }

    const form = new URLSearchParams((await readAll(req)).toString('utf8'));
    const api = form.get('api') ?? '';
    const method = form.get('method') ?? '';

    if (api === 'SYNO.API.Info') {
      if (method !== 'query') { fail(res, NO_SUCH_METHOD); return; }
      reply(res, { success: true, data: Object.fromEntries(Object.entries(APIS).map(([name, [min, max]]) =>
        [name, { path: name === 'SYNO.API.Auth' ? 'auth.cgi' : 'entry.cgi', minVersion: min, maxVersion: max }])) });
      return;
    }
    if (api === 'SYNO.API.Auth') { auth(form, res); return; }

    const table = handlers[api] ?? fileStation[api];
    if (!table) { fail(res, NO_SUCH_API); return; }
    const who = issued.get(form.get('_sid') ?? '');
    if (!who) { fail(res, SID_NOT_FOUND); return; }
    const run = table[method];
    if (!run) { fail(res, NO_SUCH_METHOD); return; }
    try {
      reply(res, { success: true, data: await run(form, who) });
    } catch (err) {
      if (err instanceof Refuse) { fail(res, err.code); return; }
      throw err;
    }
  }

  function auth(form: URLSearchParams, res: ServerResponse): void {
    const method = form.get('method');
    if (method === 'logout') {
      const sid = form.get('_sid') ?? '';
      const who = issued.get(sid);
      issued.delete(sid);
      log(`logout ${sid.slice(0, 8)}… ${who ? `(${who}'s session)` : '(UNKNOWN session)'}`);
      reply(res, { success: true });
      return;
    }
    if (method !== 'login') { fail(res, NO_SUCH_METHOD); return; }

    // Account names are case-insensitive on DSM. Passwords and codes are never logged.
    const name = (form.get('account') ?? '').toLowerCase();
    const account = accounts.get(name);
    // 400 covers both "no such account" and "wrong password", as on DSM.
    if (!account || form.get('passwd') !== account.password) {
      log(`login "${name}": wrong username or password (400)`);
      fail(res, 400);
      return;
    }
    if (account.otp) {
      const code = form.get('otp_code');
      if (!code) { log(`login "${name}": one-time code required (403)`); fail(res, 403); return; }
      if (code !== account.otp) { log(`login "${name}": wrong one-time code (404)`); fail(res, 404); return; }
    }

    const sid = hex(16);
    issued.set(sid, name);
    seed(name);
    log(`login "${name}": ok, session ${sid.slice(0, 8)}…`);
    reply(res, { success: true, data: { sid } });
  }

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port, root, moves,
    alias: (who, cal_id, as) => {
      const key = who.toLowerCase();
      aliases.set(key, new Map([...(aliases.get(key) ?? []), [cal_id, as]]));
    },
    close: () => new Promise<void>((resolve, reject) => {
      for (const timer of pendingMoves) clearTimeout(timer);
      pendingMoves.clear();
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

if (import.meta.filename === process.argv[1]) {
  const port = Number(process.env['DSM_PORT']);
  // No default. 5000 is the real DSM on the NAS and, on a Mac, AirPlay — guessing
  // either is how the app ends up asking the wrong thing whether you are you.
  if (!Number.isInteger(port) || port <= 0) {
    console.error('[fake-dsm] set DSM_PORT in .env (5555 on the laptop) — the container is built to look for DSM there');
    process.exit(1);
  }
  const accounts = parseAccounts(process.env['FAKE_DSM_ACCOUNTS'] ?? '');
  if (!Object.keys(accounts).length) {
    console.error('[fake-dsm] FAKE_DSM_ACCOUNTS is empty — add name:password pairs to .env');
    process.exit(1);
  }
  const fake = await start({ port, accounts, ...(process.env['FAKE_DSM_ROOT'] ? { root: process.env['FAKE_DSM_ROOT'] } : {}) });
  console.log(`[fake-dsm] answering as DSM on 127.0.0.1:${fake.port} for ${Object.keys(accounts).join(', ')}; files in ${fake.root}`);
}
