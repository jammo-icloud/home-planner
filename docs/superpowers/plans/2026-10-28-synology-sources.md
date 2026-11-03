# Synology Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the DSM session the member signed in with, and give the app one tested client for Synology Calendar, Contacts and File Station — plus the Household calendar it creates and shares — so the Plan, Calendar and Booking plans can call the NAS.

**Architecture:** The DSM `sid` moves from "logged out immediately" to "held on the in-memory `Session`, never written to the sessions file." A new `api/src/synology.ts` wraps every `SYNO.*` call through one `dsm()` function with injectable `fetch`, the same way `checkWithDsm` already does, and raises `SessionLost` on DSM's session error codes so every route fails the same way. Household-level settings and the Household calendar are new event ops in a new `settings` restore scope.

**Tech Stack:** Node 26 (`--experimental-strip-types`), `node:test`, no new dependencies. Synology web API over `POST /webapi/entry.cgi` form bodies. `api/tools/fake-dsm` grows to answer the APIs this plan calls.

**Spec:** `docs/superpowers/specs/2026-10-28-home-planner-design.md` — Constraints ("One session, no stored passwords", "The Synology APIs this relies on"), Decided › Calendar ("The Household calendar", "Settings"), Calls 6, 7. Read it first.

## Global Constraints

- Every Synology call uses the `sid` from the member's sign-in; the app never holds a DSM password after `checkWithDsm` returns.
- The `sid` is in memory only. `Sessions.#save` must not write it; a session loaded from disk has no `sid`.
- A local-bypass session (`session.local === true`) has no `sid`; every Synology-backed route refuses it with `NeedsDsm`.
- Sign-in posts `session=Calendar` to `SYNO.API.Auth`.
- `SYNO.Cal.Cal` v5 `create`/`set`/`list`; `SYNO.Cal.Sharing` v1 `set`/`get`; `SYNO.Cal.Event` v5 `create`/`set`/`get`/`list`/`delete`; `SYNO.Contacts.Contact`/`Addressbook` (version from `SYNO.API.Info` at first call, default 1); `SYNO.FileStation.Upload` v2, `Download` v2, `CreateFolder` v2, `List` v2. Exact versions are confirmed against the owner's NAS before first use (task 10).
- DSM error codes that mean "the session is gone": 105, 106, 107, 119. Any of these → `SessionLost`.
- A member's "My Calendar" cannot be shared; the app creates its own. Default name `Household`.
- `cal_privilege` is `"RO"` or `"RW"`. The Household calendar is shared `RW` to every member.
- Node 26 type-stripping, no build step; tests in `api/test/*.test.ts` with `node:test`; integer cents; every money-moving edit requires a reason (no money moves in this plan).

## Review Focus

1. **DSM returns HTTP 200 with `success:false` and a code** — never an HTTP error. A client that checks `res.ok` sees every refusal as success. Pinned in task 2.
2. **A session restored from `sessions.json` after a redeploy has no `sid`.** Opening Calendar must say "sign in again", not crash with `undefined` in a form body. Pinned in task 1 and task 3.
3. **`SYNO.Cal.Event.set` without the stored `dav_etag` silently overwrites.** The client must refuse to call `set` without one. Pinned in task 5.
4. **The Household calendar is created twice** if two members open the app in the same second. The create must be idempotent against the log. Pinned in task 8.
5. **A DSM reply that is not JSON** (wrong port, AirPlay on 5000) must read as "not DSM," the way `checkWithDsm` already does. Pinned in task 2.

---

### Task 1: Keep the DSM session on the in-memory Session

**Files:**
- Modify: `api/src/auth.ts:21-34` (`Session`), `:81-91` (`issue`), `:122-172` (`#load`/`#save`), `:184-262` (`checkWithDsm`)
- Modify: `api/src/server.ts:306-357` (login route)
- Test: `api/test/auth.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Session.sid: string | null`; `Sessions.issue(who, { local?, household?, sid? })`; `checkWithDsm(...)` returns `Promise<{ sid: string }>`; `export const DSM_URL: string` from `auth.ts`.

- [ ] **Step 1: Write the failing tests**

In `api/test/auth.test.ts`, replace `'the DSM session is thrown away once it has answered'` with:

```ts
test('the DSM session is kept, and sign-in asks for the Calendar session', async () => {
  const d = dsm({ success: true, data: { sid: 'abc' } });
  const got = await checkWithDsm('alice', 'pw', undefined, d.fn);
  await new Promise((r) => setImmediate(r));
  assert.equal(got.sid, 'abc');
  assert.equal(d.calls.length, 1, 'login only — no logout');
  assert.match(d.calls[0]!.body, /session=Calendar/);
});
```

Add to the `Sessions` describe:

```ts
test('the sid lives in memory and never reaches the sessions file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pb-sess-'));
  const path = join(dir, 'sessions.json');
  const s = new Sessions({ path });
  const token = s.issue('alice', { sid: 'secret-sid' });
  assert.equal(s.get(token)?.sid, 'secret-sid');
  const onDisk = await readFile(path, 'utf8');
  assert.doesNotMatch(onDisk, /secret-sid/);
  const again = new Sessions({ path });
  assert.equal(again.get(token)?.sid, null, 'a session carried across a restart has no sid');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && node --test --experimental-strip-types test/auth.test.ts`
Expected: FAIL — `got` is `undefined`; `sid` property does not exist.

- [ ] **Step 3: Implement**

In `auth.ts`: add `readonly sid: string | null` to `Session`; `issue()` takes `sid?: string | null` and stores `sid: opts.sid ?? null`; `#save` omits `sid` from `Stored`; `#load` sets `sid: null`. In `checkWithDsm`, add `session: 'Calendar'` to the login form, delete the logout block, return `{ sid: data.data?.sid ?? '' }`; throw `AuthError('DSM answered without a session id', 502)` when `sid` is empty. Export `DSM_URL`. Update the comment that justified dropping it to say why it is now kept and where it may not go.

In `server.ts` login route: capture `const { sid } = await checkWithDsm(...)` and pass `sid: isBypass ? null : sid` to `sessions.issue`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npm test`
Expected: all pass (the old logout test is gone; `server-thread.test.ts` still passes because the bypass path passes `sid: null`).

- [ ] **Step 5: Commit**

```bash
git add api/src/auth.ts api/src/server.ts api/test/auth.test.ts
git commit -m "Keep the DSM session in memory, for the calendar and nothing on disk"
```

---

### Task 2: One way to call Synology

**Files:**
- Create: `api/src/synology.ts`
- Test: `api/test/synology.test.ts`

**Interfaces:**
- Consumes: `DSM_URL` from `auth.ts`.
- Produces:
  ```ts
  export type DsmFetch = typeof globalThis.fetch;
  export class SynologyError extends Error { readonly api: string; readonly code: number; readonly status: number /* 502 */ }
  export class SessionLost extends SynologyError { /* status 409, message 'sign in again to use this' */ }
  export class NotDsm extends SynologyError { /* status 502 */ }
  export const SESSION_LOST_CODES: ReadonlySet<number> = new Set([105, 106, 107, 119]);
  export interface DsmCall { api: string; version: number; method: string; sid: string; params?: Record<string, string | number | boolean | object> }
  export async function dsm<T>(call: DsmCall, fetchImpl?: DsmFetch): Promise<T>;
  ```
  Object params are JSON-encoded; everything is posted as a form body with `_sid` appended; the response's `data` is returned.

- [ ] **Step 1: Write the failing tests**

```ts
// api/test/synology.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dsm, SessionLost, SynologyError, NotDsm } from '../src/synology.ts';

/** DSM, stubbed, in the shape auth.test.ts already uses. */
export const fakeDsm = (reply: unknown, opts: { status?: number; notJson?: boolean } = {}) => {
  const calls: { url: string; body: string }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return {
      ok: true, status: opts.status ?? 200,
      headers: new Headers({ 'content-type': opts.notJson ? 'text/html' : 'application/json' }),
      json: async () => { if (opts.notJson) throw new SyntaxError('nope'); return reply; },
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
};

describe('calling Synology', () => {
  test('posts a form with the sid, and returns data', async () => {
    const d = fakeDsm({ success: true, data: { hello: 1 } });
    const out = await dsm<{ hello: number }>({ api: 'SYNO.Cal.Cal', version: 5, method: 'list', sid: 'S' }, d.fn);
    assert.deepEqual(out, { hello: 1 });
    assert.match(d.calls[0]!.url, /\/webapi\/entry\.cgi$/);
    assert.match(d.calls[0]!.body, /api=SYNO\.Cal\.Cal/);
    assert.match(d.calls[0]!.body, /version=5/);
    assert.match(d.calls[0]!.body, /_sid=S/);
    assert.doesNotMatch(d.calls[0]!.url, /_sid/, 'the sid is never in the URL');
  });
  test('object params are sent as JSON', async () => {
    const d = fakeDsm({ success: true, data: {} });
    await dsm({ api: 'SYNO.Cal.Sharing', version: 1, method: 'set', sid: 'S',
      params: { cal_share_setting: { DSM_USER: [{ ug_name: 'bob', cal_privilege: 'RW' }] } } }, d.fn);
    assert.match(decodeURIComponent(d.calls[0]!.body), /cal_share_setting=\{"DSM_USER"/);
  });
  test('success:false is an error with the code, even at HTTP 200', async () => {
    const d = fakeDsm({ success: false, error: { code: 9007 } });
    await assert.rejects(() => dsm({ api: 'SYNO.Cal.Event', version: 5, method: 'create', sid: 'S' }, d.fn),
      (e: unknown) => e instanceof SynologyError && e.code === 9007 && e.api === 'SYNO.Cal.Event');
  });
  test('a lost session is its own error, and says to sign in again', async () => {
    for (const code of [105, 106, 107, 119]) {
      const d = fakeDsm({ success: false, error: { code } });
      await assert.rejects(() => dsm({ api: 'SYNO.Cal.Cal', version: 5, method: 'list', sid: 'S' }, d.fn),
        (e: unknown) => e instanceof SessionLost && e.status === 409 && /sign in again/.test(e.message));
    }
  });
  test('something that is not DSM is named as such', async () => {
    const d = fakeDsm(null, { notJson: true, status: 403 });
    await assert.rejects(() => dsm({ api: 'SYNO.Cal.Cal', version: 5, method: 'list', sid: 'S' }, d.fn), NotDsm);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && node --test --experimental-strip-types test/synology.test.ts`
Expected: FAIL — cannot find module `../src/synology.ts`.

- [ ] **Step 3: Implement `dsm()` and the three error classes in `api/src/synology.ts`**

Form body: `api`, `version`, `method`, each param (objects via `JSON.stringify`), then `_sid`. `AbortSignal.timeout(10000)`. A non-boolean `success` → `NotDsm` with the HTTP status and content-type in the message, matching `checkWithDsm`'s wording. Module header comment: why one function, why the sid is never in a URL (the NAS access log).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && node --test --experimental-strip-types test/synology.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/synology.ts api/test/synology.test.ts
git commit -m "One way to call Synology, with a lost session named as one"
```

---

### Task 3: The tool context carries the sid, and routes refuse without it

**Files:**
- Modify: `api/src/tools.ts:68-73` (`ToolContext`)
- Modify: `api/src/server.ts:492` (ctx construction), error handler at `:290-296`
- Modify: `api/src/synology.ts` (add `NeedsDsm`, `requireSid`)
- Test: `api/test/server-thread.test.ts` (one test), `api/test/synology.test.ts`

**Interfaces:**
- Produces: `ToolContext.sid: string | null`; `export class NeedsDsm extends ToolError` (`'sign in again to use this'`, 409); `export const requireSid = (ctx: { sid: string | null }): string` throws `NeedsDsm`. The server's error handler maps `SessionLost` to `409` and `SynologyError` to `502`.

- [ ] **Step 1: Write the failing tests**

In `synology.test.ts`:
```ts
test('a context without a sid is refused before any call is made', () => {
  assert.throws(() => requireSid({ sid: null }), NeedsDsm);
  assert.equal(requireSid({ sid: 'S' }), 'S');
});
```
In `server-thread.test.ts` (bypass session, so `sid` is null):
```ts
test('a bypass session cannot reach the NAS', async () => {
  const r = await call('GET', '/api/calendars');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /sign in again/);
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: `requireSid` not exported; `/api/calendars` is 404.

- [ ] **Step 3: Implement**

Add `readonly sid: string | null` to `ToolContext`; set `sid: session.sid` in `server.ts`. Add `NeedsDsm` and `requireSid` to `synology.ts`. In the server's catch: `err instanceof SynologyError ? err.status : …`. Add a placeholder `GET /api/calendars` route that calls `requireSid(ctx)` and returns `{ calendars: [] }` (task 4 fills it).

- [ ] **Step 4: Run tests**

Run: `cd api && npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/tools.ts api/src/server.ts api/src/synology.ts api/test/synology.test.ts api/test/server-thread.test.ts
git commit -m "Routes that need the NAS say so when the session cannot reach it"
```

---

### Task 4: Calendar client — calendars and sharing

**Files:**
- Modify: `api/src/synology.ts`
- Test: `api/test/synology.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CalendarRef { cal_id: string; original_cal_id: string }
  export interface CalendarInfo extends CalendarRef { displayname: string; color: string; privilege: 'RO' | 'RW'; type: 'event' | 'todo'; isDefault: boolean }
  export async function listCalendars(sid: string, f?: DsmFetch): Promise<CalendarInfo[]>;        // SYNO.Cal.Cal v5 list, cal_type 'event' only
  export async function createCalendar(sid: string, o: { displayname: string; description?: string; color: string }, f?: DsmFetch): Promise<CalendarInfo>;
  export async function shareCalendar(sid: string, cal_id: string, users: readonly { name: string; privilege: 'RO' | 'RW' }[], f?: DsmFetch): Promise<void>;  // SYNO.Cal.Sharing v1 set
  export async function sharingOf(sid: string, cal_id: string, f?: DsmFetch): Promise<{ name: string; privilege: 'RO' | 'RW' }[]>;  // SYNO.Cal.Sharing v1 get
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('calendars', () => {
  test('create sends every required field and reads the ids back', async () => {
    const d = fakeDsm({ success: true, data: { cal_id: '/alice/abc/', original_cal_id: '/alice/abc/', cal_displayname: 'Household', cal_color: '#112233', cal_privilege: 'RW', cal_type: 'event', default_calendar: false } });
    const c = await createCalendar('S', { displayname: 'Household', color: '#112233' }, d.fn);
    assert.equal(c.cal_id, '/alice/abc/');
    const b = decodeURIComponent(d.calls[0]!.body);
    for (const k of ['cal_type=event', 'cal_displayname=Household', 'cal_description=', 'cal_color=#112233',
                     'is_hidden_in_cal=false', 'is_hidden_in_list=false', 'notify_alarm_by_browser=',
                     'notify_import_cal_by_mail=']) assert.match(b, new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
  test('share posts the privilege object the 2.4 guide shows', async () => {
    const d = fakeDsm({ success: true });
    await shareCalendar('S', '/alice/abc/', [{ name: 'bob', privilege: 'RW' }], d.fn);
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /api=SYNO\.Cal\.Sharing/); assert.match(b, /version=1/); assert.match(b, /method=set/);
    assert.match(b, /cal_share_setting=\{"DSM_USER":\[\{"ug_name":"bob","cal_privilege":"RW"\}\],"DSM_GROUP":\[\]\}/);
  });
  test('list keeps event calendars and drops task lists', async () => {
    const d = fakeDsm({ success: true, data: [
      { cal_id: '/alice/home/', original_cal_id: '/alice/home/', cal_displayname: 'My Calendar', cal_color: '#fff', cal_privilege: 'RW', cal_type: 'event', default_calendar: true },
      { cal_id: '/alice/todo/', original_cal_id: '/alice/todo/', cal_displayname: 'Tasks', cal_color: '#fff', cal_privilege: 'RW', cal_type: 'todo', default_calendar: false },
    ] });
    const cs = await listCalendars('S', d.fn);
    assert.deepEqual(cs.map((c) => c.displayname), ['My Calendar']);
    assert.equal(cs[0]!.isDefault, true);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — Expected: not exported.

- [ ] **Step 3: Implement the four functions.** `createCalendar` sends every boolean the guide marks required (`is_hidden_in_cal=false`, `is_hidden_in_list=false`, all six `notify_*=false`). `list` returns `data` as an array (if DSM wraps it in `{ cal_list }`, unwrap — note this in a comment as a shape to confirm in task 10).

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Calendar client: list, create and share"`

---

### Task 5: Calendar client — events, with the etag enforced

**Files:**
- Modify: `api/src/synology.ts`
- Test: `api/test/synology.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CalEvent extends CalendarRef { evt_id: number; ical_uid: string; dav_etag: string; summary: string; description: string; is_all_day: boolean; dtstart: number; dtend: number; tz_id: string; color: string }
  export interface NewCalEvent extends CalendarRef { summary: string; description: string; is_all_day: boolean; dtstart: number; dtend: number; tz_id: string }
  export async function createEvent(sid: string, e: NewCalEvent, f?: DsmFetch): Promise<CalEvent>;
  export async function setEvent(sid: string, e: CalEvent, changes: Partial<Pick<CalEvent, 'summary' | 'description' | 'is_all_day' | 'dtstart' | 'dtend' | 'tz_id'>>, f?: DsmFetch): Promise<CalEvent>;  // throws EtagMismatch on DSM's refusal
  export async function getEvent(sid: string, ref: CalendarRef & { evt_id: number }, f?: DsmFetch): Promise<CalEvent>;
  export async function listEvents(sid: string, o: { calendars: readonly CalendarRef[]; start: number; end: number }, f?: DsmFetch): Promise<CalEvent[]>;  // epoch seconds
  export async function deleteEvent(sid: string, ref: CalendarRef & { evt_id: number }, f?: DsmFetch): Promise<void>;
  export class EtagMismatch extends SynologyError { readonly current?: CalEvent }
  ```
  Required-by-guide fields always sent on create/set: `is_repeat_evt=false`, `color=''`, `notify_setting=[]`, `participant=[]`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('events', () => {
  const ev = { cal_id: '/a/h/', original_cal_id: '/a/h/', summary: 'Dentist', description: '', is_all_day: false, dtstart: 1762452000, dtend: 1762455600, tz_id: 'America/Denver' };
  const reply = { evt_id: 42, ical_uid: 'u@cal.synology.com', dav_etag: 'E1', ...ev, color: '' };
  test('create returns the ids the link needs', async () => {
    const d = fakeDsm({ success: true, data: reply });
    const c = await createEvent('S', ev, d.fn);
    assert.equal(c.evt_id, 42); assert.equal(c.ical_uid, 'u@cal.synology.com'); assert.equal(c.dav_etag, 'E1');
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /is_repeat_evt=false/); assert.match(b, /participant=\[\]/); assert.match(b, /notify_setting=\[\]/);
  });
  test('set always carries the stored etag', async () => {
    const d = fakeDsm({ success: true, data: { ...reply, dav_etag: 'E2', summary: 'Dentist (moved)' } });
    const out = await setEvent('S', { ...reply }, { summary: 'Dentist (moved)' }, d.fn);
    assert.match(decodeURIComponent(d.calls[0]!.body), /dav_etag=E1/);
    assert.equal(out.dav_etag, 'E2');
  });
  test('set refuses to run without an etag', async () => {
    const d = fakeDsm({ success: true, data: reply });
    await assert.rejects(() => setEvent('S', { ...reply, dav_etag: '' }, { summary: 'x' }, d.fn), /etag/);
    assert.equal(d.calls.length, 0);
  });
  test("DSM's refusal of a stale etag is EtagMismatch", async () => {
    const d = fakeDsm({ success: false, error: { code: 9006 } });
    await assert.rejects(() => setEvent('S', { ...reply }, { summary: 'x' }, d.fn), EtagMismatch);
  });
  test('list asks for every calendar in the window', async () => {
    const d = fakeDsm({ success: true, data: [reply] });
    const out = await listEvents('S', { calendars: [{ cal_id: '/a/h/', original_cal_id: '/a/h/' }], start: 1, end: 2 }, d.fn);
    assert.equal(out.length, 1);
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /start=1/); assert.match(b, /end=2/); assert.match(b, /cal_id_list=\["\/a\/h\/"\]/);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — Expected: not exported.

- [ ] **Step 3: Implement.** `setEvent` throws `new SynologyError('an event cannot be changed without its etag', …)` before any call when `dav_etag` is empty. Which DSM error code means "etag mismatch" is not documented; treat `9006` (database operation error) **and** any `set` failure whose code is not 9007/9009/9017 as `EtagMismatch`, and fetch the current event into `current` when it does. Comment that task 10 confirms the code.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Calendar client: events, and nothing changes without its etag"`

---

### Task 6: Contacts client

**Files:**
- Modify: `api/src/synology.ts`
- Test: `api/test/synology.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Addressbook { id: number; name: string }
  export interface Contact { id: number; addressbook_id: number; full_name: string; phones: string[]; emails: string[]; org: string }
  export async function listAddressbooks(sid: string, f?: DsmFetch): Promise<Addressbook[]>;
  export async function listContacts(sid: string, o: { addressbook_id?: number; limit?: number; offset?: number }, f?: DsmFetch): Promise<Contact[]>;
  export async function getContact(sid: string, id: number, f?: DsmFetch): Promise<Contact>;
  export async function createContact(sid: string, c: { addressbook_id: number; full_name: string; phones?: string[]; emails?: string[]; org?: string }, f?: DsmFetch): Promise<Contact>;
  export async function searchContacts(sid: string, q: string, f?: DsmFetch): Promise<Contact[]>;  // list-and-filter; no server search is documented
  export const CONTACTS_VERSION = Number(process.env['SYNO_CONTACTS_VERSION'] ?? 1);
  ```
  The parser is tolerant: `phones` from any of `tel`, `phone`, `phones` (string or `{ value }[]`); `emails` the same from `email`/`emails`; missing fields are `[]`/`''`.

- [ ] **Step 1: Write the failing tests** — `listContacts` maps a reply with `{ id, addressbook_id, full_name, tel: [{ value: '555' }], email: 'a@b' }` to `phones: ['555'], emails: ['a@b']`; `searchContacts('and')` matches `full_name` case-insensitively on a two-contact list; `createContact` posts `full_name` and `addressbook_id`; every call uses `SYNO.Contacts.Contact` and `version=${CONTACTS_VERSION}`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**, with a module comment saying this API is undocumented by Synology and the shapes are to be confirmed in task 10.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Contacts client, tolerant of an undocumented shape"`

---

### Task 7: File Station client

**Files:**
- Modify: `api/src/synology.ts`
- Test: `api/test/synology.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function createFolder(sid: string, parent: string, name: string, f?: DsmFetch): Promise<void>;   // SYNO.FileStation.CreateFolder v2, force_parent=true
  export async function uploadFile(sid: string, o: { folder: string; name: string; bytes: Uint8Array; overwrite?: boolean }, f?: DsmFetch): Promise<void>;  // SYNO.FileStation.Upload v2, multipart, file part last
  export async function downloadFile(sid: string, path: string, f?: DsmFetch): Promise<{ bytes: Uint8Array; contentType: string }>;  // SYNO.FileStation.Download v2 mode=download
  export async function listFolder(sid: string, path: string, f?: DsmFetch): Promise<{ name: string; size: number; isdir: boolean }[]>;  // SYNO.FileStation.List v2 list, additional=["size"]
  ```

- [ ] **Step 1: Write the failing tests** — `uploadFile` sends `multipart/form-data` whose last part is the file (`assert.ok(body.lastIndexOf('name="file"') > body.lastIndexOf('name="path"'))`), with `api`, `version`, `method=upload`, `path`, `create_parents=true`, `overwrite` as earlier parts; `createFolder` posts `folder_path`, `name`, `force_parent=true`; `downloadFile` returns the bytes and content-type the fake replied with; `listFolder` maps `data.files`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Build the multipart body by hand (no dependency): boundary, text parts, then the file part with `Content-Type: application/octet-stream`. `downloadFile` is a `GET` to `/webapi/entry.cgi` with the params in the query **except** `_sid`, which goes in a `Cookie: id=<sid>` header (File Station download rejects `_sid` in the query on some DSM versions — comment, confirm in task 10).

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "File Station client: folders, upload and a proxied download"`

---

### Task 8: Settings events, and the Household calendar in the log

**Files:**
- Modify: `api/src/types.ts` (Event union, `State`), `api/src/replay.ts` (`Draft`, `emptyDraft`, `freeze`, `applyTo`), `api/src/restore.ts` (`scopeOf`, `Scope`), `api/src/tools.ts:480-540` (`describe`)
- Create: `api/src/settings.ts`
- Test: `api/test/settings.test.ts`, `api/test/households.test.ts` (scope test), `api/test/tools.test.ts` (describe test)

**Interfaces:**
- Produces, in `types.ts`:
  ```ts
  | { op: 'areas.set'; areas: readonly string[] }
  | { op: 'links.set'; links: readonly { label: string; url: string }[] }
  | { op: 'calendar.household'; cal_id: string; original_cal_id: string; name: string }
  | { op: 'calendar.target'; cal_id: string; original_cal_id: string }
  | { op: 'calendar.conflicts'; calendars: readonly { cal_id: string; original_cal_id: string; label: string }[] }   // per member: keyed by e.who
  | { op: 'scheme.set'; scheme: Scheme; mode: Mode }   // per member: keyed by e.who (design language, "Where the scheme preference lives")
  export type Scheme = 'quartz' | 'lapis' | 'iolite' | 'graphite';
  export type Mode = 'light' | 'dark' | 'match';
  export interface Appearance { readonly scheme: Scheme; readonly mode: Mode }
  export interface Settings { readonly areas: readonly string[]; readonly links: readonly { label: string; url: string }[]; readonly appearance: ReadonlyMap<Actor, Appearance> }
  export interface CalendarState { readonly household: CalendarRef & { name: string } | null; readonly target: CalendarRef | null; readonly conflicts: ReadonlyMap<Actor, readonly (CalendarRef & { label: string })[]> }
  // State gains: readonly settings: Settings; readonly calendar: CalendarState
  export const DEFAULT_AREAS: readonly string[] = ['House', 'Money', 'People', 'Trips'];
  ```
  `Scope` gains `'settings'`; the six ops above map to it. In `settings.ts`:
  ```ts
  export async function ensureHouseholdCalendar(ctx: ToolContext, members: readonly Actor[], f?: DsmFetch): Promise<CalendarRef>;
  export const targetCalendar = (state: State): CalendarRef | null;   // target ?? household
  ```

- [ ] **Step 1: Write the failing tests**

`settings.test.ts`:
```ts
test('areas default to four and are replaced whole', async () => { /* replay [] → DEFAULT_AREAS; append areas.set ['House','Garden'] → ['House','Garden'] */ });
test('an empty areas list is refused', async () => { /* append areas.set [] → rejects ReplayError /at least one/ */ });
test('conflict calendars are per member', async () => { /* alice sets two, bob sets one; state.calendar.conflicts.get('alice').length === 2 */ });
test('ensureHouseholdCalendar creates once, shares with everyone but the creator, and records it', async () => {
  // fake replies: create → {cal_id:'/alice/hh/',...}; sharing set → {success:true}
  // first call: 2 DSM calls, state.calendar.household.cal_id === '/alice/hh/', sharing body names bob, not alice
  // second call: 0 DSM calls, same ref returned
});
test('a new member is added to the share when the calendar already exists', async () => { /* household exists; members [alice,bob,carol] with carol new → one Sharing.set call naming bob and carol */ });
test('targetCalendar is the chosen one, else the Household one, else null', () => { /* three states */ });
test('appearance is per member and defaults to nothing', async () => { /* replay [] → appearance.get('alice') undefined; alice sets lapis/dark, bob sets graphite/match → two entries; an unknown scheme or mode → rejects ReplayError */ });
```
`households.test.ts` → the scope sample list gains `['areas.set', 'settings'], ['calendar.household', 'settings']`. `tools.test.ts` → the describe test's `ops` list gains `{ op: 'areas.set', areas: ['House'] }` and `{ op: 'calendar.household', cal_id: '/a/h/', original_cal_id: '/a/h/', name: 'Household' }`.

- [ ] **Step 2: Run to verify they fail** — Expected: `never` exhaustiveness error in `applyTo` once the union has the ops; tests fail on missing exports.

- [ ] **Step 3: Implement.** Fold: `areas.set` replaces (refuse empty); `links.set` replaces; `calendar.household` sets `d.calendar.household` and refuses a second (`ReplayError('the household calendar is already set')`); `calendar.target` sets; `calendar.conflicts` sets `d.calendar.conflicts.set(e.who, …)`; `scheme.set` sets `d.settings.appearance.set(e.who, { scheme, mode })` and refuses a value outside the two unions. `ensureHouseholdCalendar`: if `state.calendar.household` exists, compare `sharingOf()` with members minus the creator and `shareCalendar` the difference; else `createCalendar({ displayname: 'Household', color: '#3F6F8C' })`, `shareCalendar` to every member except `ctx.who`, append `calendar.household`. Serialise with an in-flight map keyed by `store.path`, as `ensureSection` does. `describe()` cases: `'set the areas to House, Money'`, `'set the links'`, `'set up the Household calendar'`, `'chose the calendar plans go on'`, `'chose which calendars to check for conflicts'`, `'chose the Lapis scheme, dark'` (scheme name capitalised; mode `match` reads `'matching the device'`).

- [ ] **Step 4: Run tests** — `npm test` — Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit** — `git commit -m "Settings in the log, and a Household calendar the app creates and shares"`

---

### Task 9: Routes for settings and calendars, and the fake DSM grows

**Files:**
- Modify: `api/src/server.ts` (new routes before the tools dispatch)
- Modify: `api/tools/fake-dsm/server.ts`, `api/tools/fake-dsm/README.md`
- Test: `api/test/server-settings.test.ts` (new, in the style of `server-thread.test.ts`, with `FAKE_DSM`-free in-process fakes via `setDsmFetch`)

**Interfaces:**
- Produces routes: `GET /api/settings` → `{ areas, links, appearance: <mine, or null>, calendar: { household, target, conflicts: <mine> }, members }`; `POST /api/settings/areas { areas }`; `POST /api/settings/links { links }`; `POST /api/settings/appearance { scheme, mode }` (appends `scheme.set` by the session's member; 400 on a value outside the unions); `GET /api/calendars` → `listCalendars(sid)` mapped plus `{ household, target }`; `POST /api/calendars/household` → `ensureHouseholdCalendar`; `POST /api/calendars/target { cal_id, original_cal_id }`; `POST /api/calendars/conflicts { calendars }`. And in `synology.ts`: `export function setDsmFetch(f: DsmFetch | null): void` — the test seam, used when no `fetchImpl` is passed.
- The fake DSM answers `SYNO.Cal.Cal` (list/create/set), `SYNO.Cal.Sharing` (get/set), `SYNO.Cal.Event` (create/set/get/list/delete, with an in-memory map and an etag that changes on every set), `SYNO.Contacts.*` (one address book, list/get/create/set), `SYNO.FileStation.*` (a temp directory). It validates `_sid` against the sids it issued and answers `119` for an unknown one.

- [ ] **Step 1: Write the failing tests** — the bypass session's `/api/settings` returns `DEFAULT_AREAS` and `appearance: null`; `POST /api/settings/appearance { scheme: 'lapis', mode: 'dark' }` then `GET /api/settings` shows it, and `{ scheme: 'amber' }` is 400 (settings and appearance need no DSM: they must work on a bypass session); `POST /api/settings/areas` with `[]` is 400; a DSM-backed session (issue one via `sessions.issue` through a test-only `DEV_USER` that the server treats as DSM — simpler: mount a `setDsmFetch(fakeDsm(...).fn)` and sign in through the fake with `DSM_URL` pointed at an in-process `fake-dsm` started by the test on port 0) can `POST /api/calendars/household` and then `GET /api/settings` shows `calendar.household.name === 'Household'`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** the routes and the fake. Export `start(opts: { port: number; accounts })` from the fake so a test can run it in-process.

- [ ] **Step 4: Run tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Settings and calendar routes, and a fake DSM that remembers"`

---

### Task 10: Confirm the API shapes against the real NAS

**Files:**
- Create: `api/tools/synology-check/README.md`, `api/tools/synology-check/check.ts`
- Modify: `DEPLOY.md` (one section), `.env.example` (`SYNO_CONTACTS_VERSION=`)

**Interfaces:** none; this is the one task that runs against the owner's NAS, by the owner.

- [ ] **Step 1: Write `check.ts`**: signs in with `FAKE_DSM_ACCOUNTS`-style env (`CHECK_USER`, `CHECK_PASS`, `CHECK_OTP`) against `DSM_URL`, calls `SYNO.API.Info` `query` for `SYNO.Cal.Cal,SYNO.Cal.Sharing,SYNO.Cal.Event,SYNO.Contacts.Contact,SYNO.Contacts.Addressbook,SYNO.FileStation.Upload,SYNO.FileStation.Download` and prints `minVersion–maxVersion` for each; then `listCalendars`, `listAddressbooks`, `listContacts({ limit: 1 })`, and prints the **raw** `data` of each, so a shape that differs from the client's assumption is visible. Creates nothing.

- [ ] **Step 2: Add `npm run synology:check`** to `package.json`.

- [ ] **Step 3: Document** in `DEPLOY.md`: run it once after deploying; what to do if Contacts' version is not 1 (`SYNO_CONTACTS_VERSION`), if `cal_id_list` is rejected by `Event.list`, or if the etag-mismatch code is not 9006 — each a one-line env or constant to change, named in the client's comments.

- [ ] **Step 4: Run it locally against the fake DSM** — Expected: prints versions and shapes without error.

- [ ] **Step 5: Commit** — `git commit -m "A check that reads the NAS's own API versions before trusting them"`
