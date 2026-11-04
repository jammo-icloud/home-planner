/**
 * Every call to the NAS's own APIs goes through `dsm()`, or, for the two that
 * move bytes (File Station upload and download), through the same `reach` and
 * `verdict` it is built from.
 *
 * One function, because DSM has one door (`/webapi/entry.cgi`) and the same
 * quirks behind it: it answers HTTP 200 whether or not the call worked, so
 * `res.ok` means nothing and the verdict is `success` in the body; a dead
 * session is one of three error codes that all mean "sign in again"; and a wrong
 * port can be answered by something that is not DSM at all. Handled once here,
 * those cannot be forgotten by the calendar, the contacts or whatever comes next.
 *
 * The session id travels in the form body as `_sid` (a cookie for downloads), never in the URL. It is a
 * NAS-wide credential, and a query string lands in the NAS's access log and in
 * anything else along the way that records URLs. Same reason `checkWithDsm`
 * posts the password.
 */

import { randomUUID } from 'node:crypto';

import { DSM_URL } from './auth.ts';
import { connectors, forgetProbe, recordProbe } from './connectors.ts';
import { ToolError } from './errors.ts';
import type { CalendarRef } from './types.ts';

export type { CalendarRef };

/*
 * Which version of each API the client asks for. Exported so the check
 * (api/tools/synology-check) compares the NAS's offered range with these very
 * numbers rather than a copy of them.
 */
export const CAL_VERSION = 5;
export const SHARING_VERSION = 1;
export const EVENT_VERSION = 5;
export const FILE_STATION_VERSION = 2;
export const COPY_MOVE_VERSION = 3;

/*
 * Everything marked "the check shows it" below is printed by
 * api/tools/synology-check (see its README.md). Everything marked "first real
 * use" is a write or a path the check does not make; the README says what a
 * wrong guess looks like when the app first does it on the real NAS.
 */

export type DsmFetch = typeof globalThis.fetch;

/**
 * The fetch every call uses when it is not handed one. Null means the real
 * one. A test seam: route tests swap in a recording or failing fetch here,
 * since a route has no way to pass one down.
 */
let defaultFetch: DsmFetch | null = null;

export function setDsmFetch(f: DsmFetch | null): void {
  defaultFetch = f;
}

/** Looked up on every call, so a swap takes effect without reloading anything. */
export const fetchFor = (f: DsmFetch | undefined): DsmFetch => f ?? defaultFetch ?? globalThis.fetch;

/** DSM said no, or answered in a way that is not a yes. */
export class SynologyError extends Error {
  readonly api: string;
  readonly code: number;
  readonly status: number;
  constructor(message: string, api: string, code: number, status = 502) {
    super(message);
    this.name = 'SynologyError';
    this.api = api;
    this.code = code;
    this.status = status;
  }
}

/** The DSM session behind this sign-in has ended; the person has to sign in again. */
export class SessionLost extends SynologyError {
  constructor(api: string, code: number) {
    super('sign in again to use this', api, code, 409);
    this.name = 'SessionLost';
  }
}

/**
 * DSM refused this account the API (code 105, "no permission"). Signing in
 * again cannot fix it, so it is not a `SessionLost`: either the account lacks
 * the package's permission in DSM, or the session name the sid was issued
 * under (`session=Calendar`) scopes it away from this API. The check's README
 * says how to tell which.
 */
export class NotAllowed extends SynologyError {
  constructor(api: string, code: number) {
    super(`your DSM account is not allowed to use ${api}`, api, code, 403);
    this.name = 'NotAllowed';
  }
}

/** Something answered at DSM_URL, but it was not DSM. */
export class NotDsm extends SynologyError {
  constructor(api: string, detail: string) {
    super(detail, api, 0, 502);
    this.name = 'NotDsm';
  }
}

/**
 * This sign-in never had a DSM session (the local sandbox), so there is nothing
 * to call the NAS with. Same words and same status as `SessionLost`: either way
 * the person has to sign in again, with DSM this time.
 */
export class NeedsDsm extends ToolError {
  constructor() {
    super('sign in again to use this', 409);
    this.name = 'NeedsDsm';
  }
}

/**
 * The sid to call the NAS with, or a refusal. Every Synology-backed route goes
 * through this first, so a missing sid stops here rather than becoming the
 * string "undefined" in a form body.
 */
export const requireSid = (ctx: { sid: string | null }): string => {
  if (!ctx.sid) throw new NeedsDsm();
  return ctx.sid;
};

/** 106 timed out, 107 duplicate login, 119 invalid session. (105 is `NotAllowed`.) */
export const SESSION_LOST_CODES: ReadonlySet<number> = new Set([106, 107, 119]);

/** DSM's "no permission". */
const NO_PERMISSION = 105;

export interface DsmCall {
  api: string;
  version: number;
  method: string;
  /** Null for the few calls DSM answers without a session (`SYNO.API.Info`): no `_sid` is sent. */
  sid: string | null;
  params?: Record<string, string | number | boolean | object>;
}

/** How long a call that only exchanges JSON may take; also a document's write, a few KB of text. */
export const CALL_TIMEOUT_MS = 10_000;

/**
 * How long a call that moves a file may take, upload or download. Ten seconds
 * is right for a form and JSON, and far too short for a photo over a slow link.
 */
const TRANSFER_TIMEOUT_MS = 120_000;

/**
 * A request or a body read that threw (unreachable, timed out, a certificate
 * the container does not trust) is one more way DSM fails, so it fails the same
 * way, with the cause named. Node's own message is just "fetch failed"; the
 * reason is on its `cause`.
 */
const didNotAnswer = (api: string, err: unknown): SynologyError => {
  const e = err as { message?: string; name?: string; cause?: { code?: string; message?: string } };
  const reason = e?.cause?.code ?? e?.cause?.message;
  const what = e?.message ?? e?.name ?? 'unknown';
  return new SynologyError(
    `the NAS did not answer ${api} (${what}${reason ? `: ${reason}` : ''})`, api, 0, 502);
};

/** Send one request to the NAS. */
export async function reach(
  api: string, url: string, init: RequestInit, fetchImpl: DsmFetch, timeoutMs = CALL_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw didNotAnswer(api, err);
  }
}

/**
 * Read a response body. The timeout armed by `reach` covers the body too, so a
 * read can be aborted midway; that is the NAS not answering, same as a fetch
 * that threw, not a raw `TimeoutError`.
 */
async function readBody<T>(api: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    // A refusal made while reading (a body over a cap) is already the answer.
    if (err instanceof SynologyError) throw err;
    throw didNotAnswer(api, err);
  }
}

/** The response as parsed JSON; `{}` if it was not JSON, which `verdict` calls not-DSM. */
export const jsonBody = (api: string, res: Response): Promise<DsmBody> =>
  readBody(api, async () => {
    try {
      return await res.json() as DsmBody;
    } catch (err) {
      if (err instanceof SyntaxError) return {};
      throw err;
    }
  });

export type DsmBody = { success?: unknown; error?: { code?: number }; data?: unknown };

/**
 * DSM's verdict on a call, from its parsed body: the data when it worked, and
 * otherwise the error it is: something that is not DSM, a dead session, or a
 * refusal. `body` is whatever the response parsed to, `{}` if it did not.
 */
export function verdict<T>(api: string, method: string, res: Response, body: DsmBody | null | undefined): T {
  if (typeof body?.success !== 'boolean') {
    const type = res.headers?.get('content-type');
    throw new NotDsm(api,
      `something answered at DSM_URL but it is not DSM (HTTP ${res.status ?? '?'}, `
      + `${type ? `content-type ${type}` : 'no content-type'}) — check that DSM_URL's port is DSM's`);
  }
  if (!body.success) {
    const code = body.error?.code ?? 0;
    if (SESSION_LOST_CODES.has(code)) throw new SessionLost(api, code);
    if (code === NO_PERMISSION) throw new NotAllowed(api, code);
    throw new SynologyError(`the NAS refused ${api} ${method} (code ${code})`, api, code);
  }
  return body.data as T;
}

export async function dsm<T>(call: DsmCall, fetchImpl?: DsmFetch): Promise<T> {
  const body = new URLSearchParams({
    api: call.api, version: String(call.version), method: call.method,
  });
  for (const [key, value] of Object.entries(call.params ?? {})) {
    body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  if (call.sid !== null) body.set('_sid', call.sid);

  const res = await reach(call.api, `${DSM_URL}/webapi/entry.cgi`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, fetchFor(fetchImpl));
  return verdict<T>(call.api, call.method, res, await jsonBody(call.api, res));
}

// ---------------------------------------------------------------------------
// Calendar: calendars and who they are shared with
// ---------------------------------------------------------------------------

export interface CalendarInfo extends CalendarRef {
  displayname: string;
  color: string;
  privilege: 'RO' | 'RW';
  type: 'event' | 'todo';
  isDefault: boolean;
}

/**
 * The eight booleans Synology's Calendar WebAPI guide (2024-06) marks required
 * on `SYNO.Cal.Cal` `create` and `set`, beside the type, name, description and
 * color. The real NAS accepted a `create` with exactly these, as plain words,
 * on 2026-11-03; an earlier version sent two `*_by_push` names the guide does
 * not have and lacked the two `notify_evt_*`.
 */
const CALENDAR_FLAGS = [
  'is_hidden_in_cal', 'is_hidden_in_list',
  'notify_alarm_by_browser', 'notify_alarm_by_mail',
  'notify_evt_by_browser', 'notify_evt_by_mail',
  'notify_import_cal_by_browser', 'notify_import_cal_by_mail',
] as const;
type CalendarFlag = (typeof CALENDAR_FLAGS)[number];

/** A calendar as DSM spells it. The flags are read back so `set` can send them unchanged. */
interface RawCalendar extends Partial<Record<CalendarFlag, boolean>> {
  cal_id: string;
  original_cal_id: string;
  cal_displayname: string;
  cal_description?: string;
  cal_color: string;
  cal_privilege: 'RO' | 'RW';
  cal_type: 'event' | 'todo';
  default_calendar: boolean;
}

/**
 * What `create` and `set` send for a calendar with no description. The real NAS
 * refused a `create` whose `cal_description` was sent empty with 9009, Parameter
 * error, and took the same request with a word in it (2026-11-03): a required
 * field sent empty counts as missing. So an empty description is never sent.
 */
export const CALENDAR_DESCRIPTION = 'Made by Home Planner.';
const described = (text: string | undefined): string => text?.trim() ? text : CALENDAR_DESCRIPTION;

/** Every flag of a calendar as DSM listed it, false where it said nothing. */
const flagsOf = (r: Partial<Record<CalendarFlag, boolean>>): Record<CalendarFlag, boolean> =>
  Object.fromEntries(CALENDAR_FLAGS.map((k) => [k, r[k] === true])) as Record<CalendarFlag, boolean>;

const calendarInfo = (r: RawCalendar): CalendarInfo => ({
  cal_id: r.cal_id,
  original_cal_id: r.original_cal_id,
  displayname: r.cal_displayname,
  color: r.cal_color,
  privilege: r.cal_privilege,
  type: r.cal_type,
  isDefault: r.default_calendar === true,
});

/**
 * What `listCalendars` sends with `SYNO.Cal.Cal` `list`. The real NAS refused a
 * `list` with no parameters with 9009 (2026-11-03). Synology's Calendar WebAPI
 * guide (2024-06) marks `cal_type` ("event", "todo" or "all") required for
 * `list` from version 5, and its request examples also carry `is_evt: true`,
 * so both are sent until the NAS says which one it wants. The check prints them.
 */
export const CALENDAR_LIST_PARAMS = { cal_type: 'event', is_evt: true } as const;

/** A list reply as the guide shows it, `{ list: [...] }`, or a bare array or another wrapper. */
export const listRows = <T>(data: unknown, ...keys: string[]): T[] => {
  if (Array.isArray(data)) return data as T[];
  for (const key of keys) {
    const rows = (data as Record<string, unknown> | null | undefined)?.[key];
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
};

/**
 * Event calendars only; the task lists that share the API are not ours.
 *
 * The ids are as *this* account sees them. A calendar shared with someone may
 * be listed for them under ids that differ from its owner's (DSM is not
 * documented either way), so a calendar from this list is matched with the
 * log's Household calendar on `cal_id` or `original_cal_id`, and the check's
 * README has a step that compares the two views on the real NAS.
 */
export async function listCalendars(sid: string, f?: DsmFetch): Promise<CalendarInfo[]> {
  return (await rawCalendars(sid, f)).filter((r) => r.cal_type === 'event').map(calendarInfo);
}

/** The calendars as DSM spells them, every type; `set` needs the fields `calendarInfo` leaves out. */
async function rawCalendars(sid: string, f?: DsmFetch): Promise<RawCalendar[]> {
  const data = await dsm<unknown>(
    { api: 'SYNO.Cal.Cal', version: CAL_VERSION, method: 'list', sid, params: { ...CALENDAR_LIST_PARAMS } }, f);
  // The guide wraps it as `{ list }`; a bare array or `{ cal_list }` is read too.
  return listRows<RawCalendar>(data, 'list', 'cal_list');
}

export async function createCalendar(
  sid: string,
  o: { displayname: string; description?: string; color: string },
  f?: DsmFetch,
): Promise<CalendarInfo> {
  const raw = await dsm<RawCalendar>({
    api: 'SYNO.Cal.Cal', version: CAL_VERSION, method: 'create', sid,
    params: {
      cal_type: 'event',
      cal_displayname: o.displayname,
      cal_description: described(o.description),
      cal_color: o.color,
      // The guide marks all eight flags required, so all eight are sent, off:
      // the app's calendar sends no reminders or notices of its own. Plain
      // strings and these words are what the real NAS accepted (2026-11-03).
      ...flagsOf({}),
    },
  }, f);
  return calendarInfo(raw);
}

/**
 * Give a calendar a new name. The guide's `SYNO.Cal.Cal` `set` takes the whole
 * calendar, every field required, not the one that changes, so the calendar is
 * read from the list first and sent back with only `cal_displayname` new. A
 * calendar the list does not show cannot be renamed and is reported as such.
 * The check's CHECK_CALENDAR_WRITE pass renames the calendar it made, as its
 * owner; whether DSM lets anyone but the owner do it is confirmed at first real
 * use, the first time a member renames the Household calendar.
 */
export async function renameCalendar(sid: string, cal: CalendarRef, name: string, f?: DsmFetch): Promise<void> {
  const listed = await rawCalendars(sid, f);
  const current = listed.find((r) => r.cal_id === cal.cal_id) ?? listed.find((r) => r.original_cal_id === cal.original_cal_id);
  if (!current) throw new SynologyError('the calendar to rename is not in your calendar list', 'SYNO.Cal.Cal', 0, 404);
  await dsm<unknown>({
    api: 'SYNO.Cal.Cal', version: CAL_VERSION, method: 'set', sid,
    params: {
      cal_id: current.cal_id,
      original_cal_id: current.original_cal_id,
      cal_displayname: name,
      cal_description: described(current.cal_description),
      cal_color: current.cal_color,
      ...flagsOf(current),
    },
  }, f);
}

type Privilege = 'RO' | 'RW';

export interface UserShare { name: string; privilege: Privilege }

/**
 * One group's entry in a calendar's sharing, exactly as DSM sent it. The app
 * shares with no groups of its own; it only hands back the ones it read, so a
 * group someone added in Synology Calendar survives the app's next `set`.
 */
export type GroupShare = Readonly<Record<string, unknown>>;

/** Who a calendar is shared with: users by name, and groups as DSM spells them. */
export interface Sharing { users: UserShare[]; groups: GroupShare[] }

interface ShareSetting { DSM_USER?: { ug_name: string; cal_privilege: Privilege }[]; DSM_GROUP?: unknown }

/**
 * Replace who `cal_id` is shared with. `set` is believed to be a whole-list
 * replace, so `users` is the complete list, not an addition to it, and
 * `groups` must be the groups read by `sharingOf` or they are unshared
 * (none, for a calendar just made). The check (CHECK_CALENDAR_WRITE=1 with
 * CHECK_SHARE_WITH) shows that `set` is taken; whether it replaces rather than
 * adds is confirmed by hand after first real use: the check's README has the steps.
 */
export async function shareCalendar(
  sid: string,
  cal_id: string,
  sharing: { users: readonly UserShare[]; groups?: readonly GroupShare[] },
  f?: DsmFetch,
): Promise<void> {
  await dsm<unknown>({
    api: 'SYNO.Cal.Sharing', version: SHARING_VERSION, method: 'set', sid,
    params: {
      cal_id,
      cal_share_setting: {
        DSM_USER: sharing.users.map((u) => ({ ug_name: u.name, cal_privilege: u.privilege })),
        DSM_GROUP: [...(sharing.groups ?? [])],
      },
    },
  }, f);
}

/**
 * Who `cal_id` is shared with. DSM lets only a calendar's owner ask, so for
 * anyone else this is a refusal.
 */
export async function sharingOf(
  sid: string,
  cal_id: string,
  f?: DsmFetch,
): Promise<Sharing> {
  const data = await dsm<{ cal_share_setting?: ShareSetting } & ShareSetting>(
    { api: 'SYNO.Cal.Sharing', version: SHARING_VERSION, method: 'get', sid, params: { cal_id } }, f);
  // The check shows it: `DSM_USER` under `cal_share_setting`, as `set` takes
  // it, or at the top level of `data`.
  const setting = data?.cal_share_setting ?? data;
  const groups = Array.isArray(setting?.DSM_GROUP) ? setting.DSM_GROUP as GroupShare[] : [];
  return {
    users: (setting?.DSM_USER ?? []).map((u) => ({ name: u.ug_name, privilege: u.cal_privilege })),
    groups,
  };
}

// ---------------------------------------------------------------------------
// Calendar: events, and nothing changes without its etag
// ---------------------------------------------------------------------------

export interface CalEvent extends CalendarRef {
  evt_id: number;
  ical_uid: string;
  dav_etag: string;
  summary: string;
  description: string;
  is_all_day: boolean;
  /** Epoch seconds. */
  dtstart: number;
  /** Epoch seconds. */
  dtend: number;
  tz_id: string;
  color: string;
  /**
   * The account that last changed it, when DSM says (the name is the client's
   * guess, confirmed at first real use). Absent when it does not.
   */
  last_modify_user?: string;
}

export interface NewCalEvent extends CalendarRef {
  summary: string;
  description: string;
  is_all_day: boolean;
  dtstart: number;
  dtend: number;
  tz_id: string;
}

type EventRef = CalendarRef & { evt_id: number };
type EventChanges = Partial<Pick<CalEvent, 'summary' | 'description' | 'is_all_day' | 'dtstart' | 'dtend' | 'tz_id'>>;

/**
 * DSM refused a change because the event is no longer the one the etag was read
 * from: someone edited it on the NAS in the meantime. `current` is the event as
 * it stands now, when it could be fetched, so the caller can show what changed.
 */
export class EtagMismatch extends SynologyError {
  readonly current?: CalEvent;
  constructor(api: string, code: number, current?: CalEvent) {
    super('this event was changed on the NAS since it was last read', api, code, 409);
    this.name = 'EtagMismatch';
    if (current) this.current = current;
  }
}

/**
 * An empty string as DSM's Calendar takes it: the JSON literal `""`. A field
 * sent plainly empty (`color=`) is read as missing and refused 9009, while
 * `color=""` is accepted and comes back as "" (real NAS, 2026-11-03). Plain
 * non-empty strings are fine, so only the empty case is spelled this way.
 */
const emptyAsJson = (s: string): string => s === '' ? '""' : s;

/**
 * `SYNO.Cal.Event` set/create want these four whether or not they are used.
 * Sent explicitly rather than left to DSM's defaults: the guide marks them
 * required, and `color` is always empty so the event takes its calendar's.
 */
const EVENT_REQUIRED = { is_repeat_evt: false, color: emptyAsJson(''), notify_setting: [], participant: [] };

const eventFields = (e: NewCalEvent) => ({
  cal_id: e.cal_id,
  original_cal_id: e.original_cal_id,
  summary: e.summary,
  description: emptyAsJson(e.description),
  is_all_day: e.is_all_day,
  dtstart: e.dtstart,
  dtend: e.dtend,
  tz_id: e.tz_id,
  ...EVENT_REQUIRED,
});

/** What DSM sent back, as a `CalEvent`; the refs fall back to the ones the call was made with. */
const calEvent = (r: Partial<CalEvent>, ref: CalendarRef): CalEvent => ({
  cal_id: r.cal_id ?? ref.cal_id,
  original_cal_id: r.original_cal_id ?? ref.original_cal_id,
  evt_id: r.evt_id as number,
  ical_uid: r.ical_uid as string,
  dav_etag: r.dav_etag as string,
  summary: r.summary ?? '',
  description: r.description ?? '',
  is_all_day: r.is_all_day === true,
  dtstart: r.dtstart as number,
  dtend: r.dtend as number,
  tz_id: r.tz_id ?? '',
  color: r.color ?? '',
  ...(typeof r.last_modify_user === 'string' && r.last_modify_user.trim()
    ? { last_modify_user: r.last_modify_user.trim() } : {}),
});

export async function createEvent(sid: string, e: NewCalEvent, f?: DsmFetch): Promise<CalEvent> {
  const raw = await dsm<Partial<CalEvent>>(
    { api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'create', sid, params: eventFields(e) }, f);
  return calEvent(raw, e);
}

export async function getEvent(sid: string, ref: EventRef, f?: DsmFetch): Promise<CalEvent> {
  // The check shows it, when there is an event in the coming week: `evt_id`
  // alone may be all `get` wants.
  const raw = await dsm<Partial<CalEvent>>({
    api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'get', sid,
    params: { evt_id: ref.evt_id, cal_id: ref.cal_id, original_cal_id: ref.original_cal_id },
  }, f);
  return calEvent(raw, ref);
}

/** Epoch seconds. */
export async function listEvents(
  sid: string,
  o: { calendars: readonly CalendarRef[]; start: number; end: number },
  f?: DsmFetch,
): Promise<CalEvent[]> {
  // The check shows it: if `cal_id_list` is rejected, this is the one
  // parameter to change. The guide wraps the reply as `{ list }`; a bare
  // array is read too.
  const data = await dsm<unknown>({
    api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'list', sid,
    params: { cal_id_list: o.calendars.map((c) => c.cal_id), start: o.start, end: o.end },
  }, f);
  return listRows<Partial<CalEvent>>(data, 'list').map((r) => calEvent(r, { cal_id: '', original_cal_id: '' }));
}

/**
 * The guide's `delete` takes `evt_id` alone, and the real NAS refused the same
 * call with `cal_id` and `original_cal_id` added with 9009 (2026-11-03), so
 * only the id is sent; the ref's calendar is for the caller's bookkeeping.
 */
export async function deleteEvent(sid: string, ref: EventRef, f?: DsmFetch): Promise<void> {
  await dsm<unknown>({
    api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'delete', sid,
    params: { evt_id: ref.evt_id },
  }, f);
}

/**
 * Failures of `set` taken to be about something other than the etag; these
 * stay plain `SynologyError`s. Exported for the check, whose
 * CHECK_CALENDAR_WRITE pass makes a stale-etag write on the real NAS and says
 * whether its code is one of these; its README says what each outcome means.
 */
export const NOT_AN_ETAG_REFUSAL: ReadonlySet<number> = new Set([9007, 9009, 9017]);

/**
 * Change an event, carrying the etag it was read with. Without one DSM would
 * silently overwrite whatever is there now, so no call is made at all.
 *
 * Which code DSM answers a stale etag with is not documented. Until the check
 * settles it (with CHECK_CALENDAR_WRITE=1, on a calendar it makes), 9006 (database
 * operation error) and any other code `set` fails with, bar the three above,
 * is taken to be the etag refusal. A session that ended, an account that is
 * not allowed, or a NAS that did not answer is never one.
 */
export async function setEvent(
  sid: string,
  e: CalEvent,
  changes: EventChanges,
  f?: DsmFetch,
): Promise<CalEvent> {
  if (!e.dav_etag?.trim()) {
    throw new SynologyError('an event cannot be changed without its etag', 'SYNO.Cal.Event', 0, 400);
  }
  const next: CalEvent = { ...e, ...changes };
  try {
    const raw = await dsm<Partial<CalEvent>>({
      api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'set', sid,
      params: { ...eventFields(next), evt_id: e.evt_id, dav_etag: e.dav_etag },
    }, f);
    return calEvent(raw, e);
  } catch (err) {
    if (!(err instanceof SynologyError) || err instanceof SessionLost || err instanceof NotDsm
        || err instanceof NotAllowed || err.code === 0 || NOT_AN_ETAG_REFUSAL.has(err.code)) throw err;
    let current: CalEvent | undefined;
    try {
      current = await getEvent(sid, e, f);
    } catch (again) {
      // The mismatch stands without `current`: the caller just cannot show what changed.
      if (again instanceof SessionLost) throw again;
    }
    // Same etag still on the NAS: the event did not move, so this failure was something else.
    if (current && current.dav_etag === e.dav_etag) throw err;
    throw new EtagMismatch(err.api, err.code, current);
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
//
// Synology does not document the Contacts web API, so none of the shapes below
// come from a guide: every name is guessed. The check shows the version range
// and the two `list` replies; `get` and `create` are confirmed at first real
// use. Until then the parser is tolerant rather than exact. The version is not
// configured: it is asked of the NAS.

const CONTACTS_API = 'SYNO.Contacts.Contact';

/** DSM's answer for a version it does not support. */
const UNSUPPORTED_VERSION = 104;

/**
 * The version Contacts is called with: the one kept under `probed`, else asked
 * of `SYNO.API.Info` (which needs no session) and kept; 1 if the range holds
 * it, else the lowest offered. A NAS that lists no range is called at 1 and
 * nothing is kept, so the next call asks again.
 */
export async function contactsVersionNow(f?: DsmFetch): Promise<number> {
  const kept = connectors().probed?.contactsVersion;
  if (kept) return kept.version;
  const info = await dsm<Record<string, { minVersion?: unknown; maxVersion?: unknown }> | null>({
    api: 'SYNO.API.Info', version: 1, method: 'query', sid: null, params: { query: CONTACTS_API },
  }, f);
  const row = info?.[CONTACTS_API];
  const min = row?.minVersion;
  const max = row?.maxVersion;
  if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) > (max as number)) return 1;
  const version = (min as number) <= 1 && 1 <= (max as number) ? 1 : (min as number);
  await recordProbe({ version, min: min as number, max: max as number, at: new Date().toISOString() });
  return version;
}

/**
 * A Contacts call at the version the NAS offers. DSM's 104 (unsupported
 * version) forgets the probe, asks again once and calls again once; a second
 * 104 is the answer.
 */
async function contactsCall<T>(call: Omit<DsmCall, 'version'>, f?: DsmFetch): Promise<T> {
  try {
    return await dsm<T>({ ...call, version: await contactsVersionNow(f) }, f);
  } catch (err) {
    if (!(err instanceof SynologyError) || err.code !== UNSUPPORTED_VERSION || err.api !== call.api) throw err;
    await forgetProbe();
    return dsm<T>({ ...call, version: await contactsVersionNow(f) }, f);
  }
}

export interface Addressbook { id: number; name: string }

export interface Contact {
  id: number;
  addressbook_id: number;
  full_name: string;
  phones: string[];
  emails: string[];
  org: string;
}

/** A phone number or address as DSM might spell it: absent, a string, or a list of strings or `{ value }`. */
const valuesOf = (raw: unknown): string[] => {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return items
    .map((item) => typeof item === 'object' && item !== null ? (item as { value?: unknown }).value : item)
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map(String)
    .filter((v) => v !== '');
};

const contact = (r: Record<string, unknown>): Contact => ({
  id: Number(r['id']),
  addressbook_id: Number(r['addressbook_id'] ?? 0),
  full_name: typeof r['full_name'] === 'string' ? r['full_name'] : '',
  phones: [...new Set(['tel', 'phone', 'phones'].flatMap((k) => valuesOf(r[k])))],
  emails: [...new Set(['email', 'emails'].flatMap((k) => valuesOf(r[k])))],
  org: typeof r['org'] === 'string' ? r['org'] : '',
});

/** The contact in a `get` or `create` reply, or a refusal to guess when there is none. */
const contactReply = (
  method: string, data: (Record<string, unknown> & { contact?: Record<string, unknown> }) | null | undefined,
): Record<string, unknown> => {
  const row = data?.contact ?? data;
  if (!row || typeof row !== 'object') {
    throw new NotDsm('SYNO.Contacts.Contact', `the NAS answered SYNO.Contacts.Contact ${method} with no contact`);
  }
  return row;
};

export async function listAddressbooks(sid: string, f?: DsmFetch): Promise<Addressbook[]> {
  const data = await contactsCall<unknown>(
    { api: 'SYNO.Contacts.Addressbook', method: 'list', sid }, f);
  // The real NAS answers `{ addressbook: [...], total }` (2026-11-03); the
  // plural and a bare array are read too.
  const rows = listRows<Record<string, unknown>>(data, 'addressbook', 'addressbooks');
  return rows.map((r) => ({ id: Number(r['id']), name: typeof r['name'] === 'string' ? r['name'] : '' }));
}

export async function listContacts(
  sid: string,
  o: { addressbook_id?: number; limit?: number; offset?: number },
  f?: DsmFetch,
): Promise<Contact[]> {
  const params: Record<string, number> = {};
  if (o.addressbook_id !== undefined) params['addressbook_id'] = o.addressbook_id;
  if (o.limit !== undefined) params['limit'] = o.limit;
  if (o.offset !== undefined) params['offset'] = o.offset;
  const data = await contactsCall<unknown>(
    { api: 'SYNO.Contacts.Contact', method: 'list', sid, params }, f);
  // The real NAS answers `{ contact: [...], offset }` (2026-11-03); the plural
  // `{ contacts }` and a bare array are read too.
  return listRows<Record<string, unknown>>(data, 'contact', 'contacts').map(contact);
}

export async function getContact(sid: string, id: number, f?: DsmFetch): Promise<Contact> {
  const data = await contactsCall<Record<string, unknown> & { contact?: Record<string, unknown> }>(
    { api: 'SYNO.Contacts.Contact', method: 'get', sid, params: { id } }, f);
  return contact(contactReply('get', data));
}

export async function createContact(
  sid: string,
  c: { addressbook_id: number; full_name: string; phones?: string[]; emails?: string[]; org?: string },
  f?: DsmFetch,
): Promise<Contact> {
  // Field names confirmed at first real use: `tel`/`email` as `{ value }` lists is a guess.
  const params: Record<string, string | number | object> = {
    addressbook_id: c.addressbook_id,
    full_name: c.full_name,
  };
  if (c.phones?.length) params['tel'] = c.phones.map((value) => ({ value }));
  if (c.emails?.length) params['email'] = c.emails.map((value) => ({ value }));
  if (c.org) params['org'] = c.org;
  const data = await contactsCall<Record<string, unknown> & { contact?: Record<string, unknown> }>(
    { api: 'SYNO.Contacts.Contact', method: 'create', sid, params }, f);
  return contact(contactReply('create', data));
}

/**
 * No server-side search is documented, so this lists and filters on `full_name`.
 * A household's address book fits in one page of 1000.
 */
export async function searchContacts(sid: string, q: string, f?: DsmFetch): Promise<Contact[]> {
  const needle = q.trim().toLowerCase();
  const all = await listContacts(sid, { limit: 1000 }, f);
  return all.filter((c) => c.full_name.toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// File Station: folders, upload and a proxied download
// ---------------------------------------------------------------------------
//
// Folder and list calls are ordinary `dsm()` calls. Upload and download are
// not: one sends a multipart body and the other receives bytes, so neither fits
// the form-in, JSON-out shape of `dsm()`. They share its base URL, its timeout
// and its error handling (`reach` and `verdict`), and still never put the sid
// in a URL.

/** A body under this size is looked at for a DSM error object whatever its content-type. */
const ERROR_BODY_MAX = 1024;

/**
 * Where File Station takes a list of paths it splits on commas, so a comma in a
 * single path could name two. Neither the check nor first real use shows which
 * calls do that (the check's README has the case); until someone needs a comma,
 * a name or path with one is refused before any call is made.
 */
function noComma(api: string, value: string): void {
  if (value.includes(',')) {
    throw new SynologyError(`a comma cannot be used in a File Station name or path: ${value}`, api, 0, 400);
  }
}

/** Create `name` under `parent`, and `parent` itself if it is missing. */
export async function createFolder(sid: string, parent: string, name: string, f?: DsmFetch): Promise<void> {
  noComma('SYNO.FileStation.CreateFolder', parent);
  noComma('SYNO.FileStation.CreateFolder', name);
  // `folder_path` and `name` are sent as plain strings. The guide shows some
  // path params JSON-quoted; plain is a guess confirmed at first real use.
  await dsm<unknown>({
    api: 'SYNO.FileStation.CreateFolder', version: FILE_STATION_VERSION, method: 'create', sid,
    params: { folder_path: parent, name, force_parent: true },
  }, f);
}

/** A header value inside quotes: the quote itself is percent-encoded, line breaks are dropped. */
export const quoted = (v: string): string => v.replace(/[\r\n]/g, '').replace(/"/g, '%22');

/**
 * Put a file in `folder`, creating the folder if needed. The multipart body is
 * built by hand (no dependency): the text parts first, the file part last,
 * because File Station reads the form in order and wants the destination before
 * the bytes. The sid is a text part like in `dsm()`'s form, not a URL parameter.
 * A file already there is refused (414) unless `overwrite` asks to replace it.
 */
export async function uploadFile(
  sid: string,
  o: { folder: string; name: string; bytes: Uint8Array; overwrite?: boolean },
  f?: DsmFetch,
): Promise<void> {
  const api = 'SYNO.FileStation.Upload';
  // `path` is a plain string, a guess confirmed at first real use; it is a multipart part,
  // not a list, so a comma in the folder or file name is not a problem here.
  const boundary = `----household-budget-${randomUUID()}`;
  const text: [string, string][] = [
    ['api', api], ['version', String(FILE_STATION_VERSION)], ['method', 'upload'],
    ['path', o.folder], ['create_parents', 'true'],
    // Sent only to replace. File Station reads overwrite=false as "skip it and
    // answer success", which would say a file was stored when it was not; left
    // out, a file already there is refused with 414, which the caller can say.
    ...(o.overwrite === true ? [['overwrite', 'true'] as [string, string]] : []),
    // First real use confirms DSM reads `_sid` from a multipart part on upload
    // (the alternative is the Cookie header the download uses).
    ['_sid', sid],
  ];
  const head = text.map(([k, v]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  const fileHead = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoted(o.name)}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n';
  const body = Buffer.concat([
    Buffer.from(head + fileHead), o.bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await reach(api, `${DSM_URL}/webapi/entry.cgi`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  }, fetchFor(f), TRANSFER_TIMEOUT_MS);
  verdict<unknown>(api, 'upload', res, await jsonBody(api, res));
}

/**
 * The bytes of a file, and the type DSM served it as. A failure comes back as a
 * JSON error body (or a non-2xx), and is classified like any other DSM failure.
 * With `maxBytes`, a file that turns out larger is refused with a 413 once its
 * length or the bytes read so far say so, and no more of it is held.
 */
export async function downloadFile(
  sid: string,
  path: string,
  f?: DsmFetch,
  o: { maxBytes?: number } = {},
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const api = 'SYNO.FileStation.Download';
  noComma(api, path);
  // `path` is a plain string. The guide shows some path params JSON-quoted;
  // plain is a guess the check shows, given CHECK_FILE.
  const query = new URLSearchParams({
    api, version: String(FILE_STATION_VERSION), method: 'download', mode: 'download', path,
  });
  // The sid goes in a cookie, not `_sid` in the query: some DSM versions reject
  // `_sid` in the query for downloads, and a query string is logged besides.
  // The check shows it, given CHECK_FILE.
  const res = await reach(api, `${DSM_URL}/webapi/entry.cgi?${query}`, {
    method: 'GET',
    headers: { cookie: `id=${sid}` },
  }, fetchFor(f), TRANSFER_TIMEOUT_MS);
  return bytesOrRefusal(api, 'download', res, o.maxBytes);
}

/**
 * The bytes a download answered with, or the refusal they are. DSM answers a
 * failed download with its JSON error body (or a non-2xx) in place of the
 * bytes, and that is classified like any other DSM failure. With `maxBytes`, a
 * body that turns out larger is refused with a 413 and no more of it is held.
 * File Station's download and Drive's read share it.
 */
export async function bytesOrRefusal(
  api: string, method: string, res: Response, maxBytes?: number,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const bytes = await readBody(api, () => maxBytes === undefined
    ? res.arrayBuffer().then((b) => new Uint8Array(b))
    : readCapped(api, res, maxBytes));
  const contentType = res.headers?.get('content-type') ?? '';
  // DSM answers a failed download with its usual JSON body, and is not careful
  // about the content-type it sends it with, so anything texty is looked at,
  // and so is anything small enough to be an error body whatever it is called.
  if (!res.ok || bytes.length < ERROR_BODY_MAX || /json|^text\//i.test(contentType)) {
    let parsed: DsmBody | undefined;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as DsmBody;
    } catch {
      // Not JSON.
    }
    // A text or JSON file is a download; only a non-2xx or DSM's refusal is an error.
    if (!res.ok || parsed?.success === false) {
      verdict<unknown>(api, method, res, parsed);
      throw new NotDsm(api, `the NAS answered ${api} ${method} with HTTP ${res.status}`);
    }
  }
  return { bytes, contentType: contentType || 'application/octet-stream' };
}

/** Too large to take: the file, or what DSM says its length is, is over the cap asked for. */
const overCap = (api: string, max: number): SynologyError =>
  new SynologyError(`the file is larger than ${max} bytes`, api, 0, 413);

/**
 * A body read a chunk at a time, abandoned as soon as it passes `max`: the
 * declared length is believed when it is over, and never trusted when under.
 */
async function readCapped(api: string, res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers?.get('content-length') ?? NaN);
  if (res.ok && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw overCap(api, max);
  }
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.length > max) throw overCap(api, max);
    return whole;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw overCap(api, max);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function listFolder(
  sid: string,
  path: string,
  f?: DsmFetch,
): Promise<{ name: string; size: number; isdir: boolean }[]> {
  noComma('SYNO.FileStation.List', path);
  // `folder_path` is a plain string, a guess the check shows, given CHECK_FOLDER.
  const data = await dsm<{ files?: { name: string; isdir?: boolean; additional?: { size?: number } }[] }>({
    api: 'SYNO.FileStation.List', version: FILE_STATION_VERSION, method: 'list', sid,
    params: { folder_path: path, additional: ['size'] },
  }, f);
  return (data?.files ?? []).map((e) => ({
    name: e.name, size: Number(e.additional?.size ?? 0), isdir: e.isdir === true,
  }));
}

/** How long `moveOnNas` waits for File Station to finish before it says it has not (false). */
export const NAS_MOVE_WAIT_MS = 5000;
const NAS_MOVE_POLL_MS = 200;
/** File Station's "a file by that name is there already", which `moveOnNas` also gives a skipped move. */
const NAS_NAME_TAKEN = 414;

/**
 * File Station's move of one file or folder into `destFolder`: `SYNO.FileStation.CopyMove`
 * `start` (the source removed, nothing overwritten), then `status` until it says
 * finished or the wait is up, when the answer is false and the move may yet
 * complete on the NAS. 408 (no such source) and 414 (the name is taken) are
 * SynologyErrors as File Station says them. `path` is sent as a JSON list and
 * `dest_folder_path` as a plain string, a guess confirmed at first real use.
 *
 * With overwrite false the real NAS (2026-11-03) does not refuse a taken name:
 * the task finishes with `skipstatus.status: "all"`, nothing moved, and that is
 * said here as 414. A `finished: true` with `skipstatus.status: "none"` is not
 * proof of a move either (its `found_file_num` and `total` were 0 for a move
 * that happened), so the caller confirms through File Station's own lists, never
 * through Drive, which indexes File Station's changes late.
 */
export async function moveOnNas(sid: string, path: string, destFolder: string, f?: DsmFetch): Promise<boolean> {
  const api = 'SYNO.FileStation.CopyMove';
  noComma(api, path);
  noComma(api, destFolder);
  const { taskid } = await dsm<{ taskid: string }>({
    api, version: COPY_MOVE_VERSION, method: 'start', sid,
    params: { path: [path], dest_folder_path: destFolder, overwrite: false, remove_src: true },
  }, f);
  const until = Date.now() + NAS_MOVE_WAIT_MS;
  for (;;) {
    const status = await dsm<{ finished?: boolean; skipstatus?: { status?: string } }>({
      api, version: COPY_MOVE_VERSION, method: 'status', sid, params: { taskid },
    }, f);
    if (status?.finished === true) {
      if (status.skipstatus?.status === 'all') {
        throw new SynologyError(`File Station skipped ${path}: ${destFolder} has a file by that name`, api, NAS_NAME_TAKEN, 409);
      }
      return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, NAS_MOVE_POLL_MS));
  }
}
