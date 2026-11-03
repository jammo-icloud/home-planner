# Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Home Planner's configuration out of `.env` and into the app: the household's owner makes the household's choices in Settings, as logged events; an administrator sets what the NAS connects to on a new Connectors page, kept in `api/data/connectors.json`; and nothing is written to Drive until the owner has chosen a folder, which a later change moves without breaking a link.

**Architecture:** One new NAS-wide module, `connectors.ts`, owns `connectors.json` and answers every moved setting through `resolvedEnv()`: the deployment's environment with each saved value written over its variables and each saved off deleted, read on every use, so the existing readers (`bookingConfig`, `mailWhileOff`, `dsmPublicUrl`, the pricing tools, the Claude client) change only where they read. Five new household ops in the `settings` scope give the fold `state.documents`, `state.zone`, `state.settings.booking` and `state.settings.model`; the fold enforces owner-only. `folders.ts` is the Drive picker, its checks, the in-memory registry of every household's folder and the boot carry-over; `moves.ts` moves the documents in the per-household lane `schedulePages` already uses. `setup.ts` computes the Settings checklist and the Today notices per load; neither is ever in a log.

**Tech Stack:** Node 26 (`--experimental-strip-types`), `node:test`, `@anthropic-ai/sdk` (already a dependency), no new dependencies. Synology Drive REST v2 (`team-folder`, `team-folder/members`, `files`, `files/list`, `files/move`), File Station (`CreateFolder`, `CopyMove`), DSM WebAPI for the administrators group and the account list. `api/tools/fake-dsm` grows each. Single-file vanilla JS UI in `site/index.html`.

**Spec:** `docs/superpowers/specs/2026-11-02-configuration-design.md`. It extends `docs/superpowers/specs/2026-11-01-storage-design.md` (Team Folders, `DocRef`, pages, `PAGE_RETRY_MS`) and keeps the log, scope and DSM-session rules of `docs/superpowers/specs/2026-10-28-home-planner-design.md`. Drive shapes are in https://office-suite-api.synology.com/specs/Synology-Drive/openapi_v2.json. The previous plan, `docs/superpowers/plans/2026-11-02-storage.md`, is the house style and names the helpers reused here (`fakeNas`, `writeDocOrRefusal`, `schedulePages`, `oneAtATime`). Read the spec first.

## Global Constraints

- Data is not code. `api/data` is never committed, and no test writes under it: `connectors.ts` writes a file only after `loadConnectors(path)` has named one, which only `start()` and tests that pass a temporary path do.
- `.env` is never committed, never created and never edited by an implementer. `.env.example` is edited in Task 24 only.
- A fake NAS run never uses port 5555 (the developer's own `npm run fake-dsm`). Tests start the fake on port 0.
- The DSM `sid` lives on the member's in-memory session only: never in a URL, a log line, a file or a response. The new `Session.admin` flag is memory only too, never in `sessions.json`.
- No secret in a household log. `connectors.json` holds the secrets, mode 0600, written whole to `<path>.tmp` and renamed over; each save writes the file before the copy in memory. No `GET` and no POST answer carries the mail password, the Census or EIA key or the Claude key: only `set` or `not set`. A mail value without `pass` keeps the saved password.
- Every write is an event the fold replays; external effects first, the log last. Existing logs replay unchanged, including seeded ones whose facts are authored by `system`: the `system` rules below govern the five new ops only.
- Owner-only choices are enforced by the fold, as `member.add` is (`replay.ts:1159`). `documents.moved` is any member's. The calendar's owner-only check sits in the routes only, because old logs hold calendar events written by members.
- Values are read when used: saved value or saved off, else the deployment's `.env`, else the built-in default. Each row and choice says which, in exactly these words: `saved`, `off`, `from the deployment`, `default`.
- `PLANNER_ROOT` is never a default folder: it is the carry-over's source and the picker's first suggestion, nothing else.
- `DSM_PORT`, `TRUST_PROXY` and `FAKE_DSM_ACCOUNTS` stay in `.env`. `ADMIN_USER` stays as an optional override of the administrators group.
- No Drive admin endpoint is called (`/admin/*`). A Team Folder is enabled in Synology Drive Admin Console by a person.
- No two households share or nest folders.
- Drive writes: documents stay `PUT files/upload` with `conflict_action: version`; `POST files` is used only with `type=folder`; a move is `POST files/move` with `conflict_action: 'stop'`.
- Node 26 type stripping, no build step: no parameter properties, no enums.
- Integer cents everywhere (untouched here).
- Words on screen are plain sentences; the exact copy the spec pins is copied verbatim.
- Commit as the owner, with exactly this trailer whatever model you are: `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit -m "<plain sentence>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`. No conventional-commit prefixes. Never push.
- Tests: `cd api && npm test`; typecheck: `cd api && npx tsc --noEmit -p .`. Both green at the end of every task.

## Review Focus

1. **A `connectors.json` with one entry of the wrong shape** (hand-edited, or from an older build): that entry is ignored and the deployment's value applies; the rest of the file still counts, and sign-in still works. Pinned in Task 1 (`a key of the wrong shape is ignored, the rest kept`).
2. **Account names typed with capitals or spaces** on Who may sign in (`"Alice "`): stored trimmed and lowercased, matched against the lowercased DSM name, and the lockout check compares the same way, so an admin is neither locked out nor wrongly refused. Pinned in Task 19.
3. **A folder name typed with a trailing slash, a leading slash, spaces, `..`, `%` or a comma** in the picker: trimmed and normalized, or refused in words, before any call to the NAS. Pinned in Task 11 (`folderProblem`) and Task 12 (the route).
4. **Two members opening Today at the same moment during a move**: each file is moved once and recorded by one `documents.moved`; a second record of the same file is refused by the fold. Pinned in Task 17.
5. **A Claude key pasted with a trailing newline or spaces** from a password manager: trimmed before it is saved, so the next call does not send a header the API refuses. Pinned in Task 19.

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `api/src/connectors.ts` (new) | `connectors.json`: load, save, `Saved<T>`, the memory copy, `resolvedEnv()`, `sourceOf()`, test results, the Contacts probe record, the live Claude 401 | 1, 2, 8, 19, 21 |
| `api/src/accounts.ts` (new) | DSM: is this account an administrator; which accounts the admin's session can list | 3 |
| `api/src/folders.ts` (new) | Drive picker rows, checks, folder shape, the registry of every household's folder, the carry-over | 11, 15 |
| `api/src/moves.ts` (new) | Moving a household's files to its new folder: one pass, failures, waits | 16, 17 |
| `api/src/setup.ts` (new) | The Settings checklist and the Today notices, computed per load | 12, 22 |
| `api/src/connectors-view.ts` (new) | The Connectors rows: state, source, one line, form, broken | 19 |
| `api/src/types.ts` | Five ops, `SYSTEM`, `DocumentsFolder`, `MoveFile`, `DocumentsState`, `zoneOf`, the new `State` fields | 4, 5 |
| `api/src/replay.ts` | Validate, the `system` rules, owner-only fold, `state.documents` and relinking | 4, 5 |
| `api/src/restore.ts`, `api/src/households.ts` | Scopes; restore as a new household keeps zone and model | 4, 5, 6 |
| `api/src/auth.ts` | `Session.admin`, memory only | 3 |
| `api/src/drive.ts`, `api/src/synology.ts` | Team folders with capabilities, members, folder list and make, Drive move; File Station move; the probed Contacts version | 10, 21 |
| `api/src/docs.ts`, `api/src/pages.ts`, `api/src/attachments.ts`, `api/src/drift.ts`, `api/src/search.ts`, `api/src/briefing.ts`, `api/src/conversation.ts`, `api/src/thread.ts`, `api/src/plans.ts` | The home from `state.documents.folder`; nothing before a choice; readers follow relinked documents | 14, 16 |
| `api/src/claude.ts`, `api/src/match.ts` | The key per call; the envelope model per household | 8, 9 |
| `api/src/booking.ts`, `api/src/settings.ts`, `api/src/tools.ts`, the zone callers | Values per use; booking from the log; the household's zone | 2, 7, 18 |
| `api/src/server.ts` | Routes, sign-in, gate, boot | 2, 3, 7, 9, 12, 15, 17, 18, 19, 22 |
| `site/index.html` | Setup in Settings, the Connectors page, setup notices on Today | 13, 20, 22 |
| `api/tools/fake-dsm/server.ts` (+ README) | Admin flag and membership, accounts, capabilities, members, `POST files`, async move, File Station move, Contacts in `SYNO.API.Info` | 3, 10, 21 |
| `api/tools/synology-check/check.ts` (+ README), `DEPLOY.md`, `.env.example` | Probes 1 to 7; deploy words | 21, 23, 24 |
| `api/test/fake-nas.ts`, `api/test/fake-anthropic.ts` (new), `api/test/folder.ts` (new) | Shared helpers, not test files | 3, 8, 10, 14 |

---

## Phase 1: The NAS-wide file, and who is the admin

### Task 1: `connectors.json`, and the environment as it stands

**Files:**
- Create: `api/src/connectors.ts`
- Test: `api/test/connectors.test.ts` (new)

**Interfaces:**
- Produces, in `connectors.ts`:
  ```ts
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
  /** Read at boot. A file that does not parse is reported and ignored (nothing in memory, the file untouched); one key of the wrong shape is dropped and named. */
  export function loadConnectors(path: string): { problems: string[] };
  /** The copy in memory. Empty `{ version: 1 }` before load, and for tests that never load. */
  export function connectors(): Readonly<Connectors>;
  /** Write the file whole (0600, tmp then rename), then memory. Before `loadConnectors`, memory only. */
  export async function saveConnector<K extends SavedKey>(key: K, change: Change<K>, by: string, now?: Date): Promise<void>;
  export async function recordTest(key: 'mailTest', r: NonNullable<Connectors['mailTest']>): Promise<void>;
  export async function recordTest(key: 'claudeTest', r: NonNullable<Connectors['claudeTest']>): Promise<void>;
  /** The deployment's environment with every saved value written over its variables, and every saved off deleting them. Read per use. */
  export function resolvedEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  export function sourceOf(key: SavedKey, env?: NodeJS.ProcessEnv): Source;
  /** The admin who saved last, for "who can fix it" words; null when nothing is saved. */
  export function lastSavedBy(): string | null;
  /** Forget everything in memory and the file's path: for tests only. */
  export function resetConnectors(): void;
  ```
  How a value lands in the environment: `publicUrl` → `DSM_PUBLIC_URL`; `signIn` → `ALLOWED_USERS` joined with `,`; `bookUrl` → `BOOK_URL`; `mail` → the five `SMTP_*` (`String(port)`) and `SMTP_PLAIN_AUTH` `'1'` or deleted; `claude` → `ANTHROPIC_API_KEY`, with `ANTHROPIC_AUTH_TOKEN` deleted so the saved key wins; `census`, `eia` → their keys. A saved off deletes every variable of its key. `sourceOf` is `saved` for a value, `off` for an off, `from the deployment` when any of the key's variables is non-empty in `env`, else `default`. `{ clear: true }` deletes the key, and with it `mailTest` for `mail` and `claudeTest` for `claude`.

  The shape check on load and on save: `publicUrl`, `bookUrl`, `claude`, `census`, `eia` hold a non-empty string; `signIn` a non-empty list of non-empty strings; `mail` all six fields with a whole `port` from 1 to 65535; every `Saved` has string `by` and `at`. `saveConnector` throws `Error('signIn cannot be off')` for `{ off: true }` on `signIn` (the route's 400 is Task 19's).

- [ ] **Step 1: Write the failing tests**

```ts
// api/test/connectors.test.ts
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectors, loadConnectors, resetConnectors, resolvedEnv, saveConnector, sourceOf, recordTest, lastSavedBy,
} from '../src/connectors.ts';

let path = '';
beforeEach(async () => { resetConnectors(); path = join(await mkdtemp(join(tmpdir(), 'pb-conn-')), 'connectors.json'); });
const MAIL = { host: 'mail.example.com', port: 587, user: 'robot', pass: 'hunter2-long', from: 'house@example.com', plainAuth: false };

describe('connectors.json', () => {
  test('a saved value is written over the deployment, an off deletes it, a clear brings it back', async () => {
    loadConnectors(path);
    const env = { DSM_PUBLIC_URL: 'https://env.example.com', ANTHROPIC_AUTH_TOKEN: 'tok' };
    assert.equal(sourceOf('publicUrl', env), 'from the deployment');
    await saveConnector('publicUrl', { value: 'https://nas.example.com:5001' }, 'carol');
    assert.equal(resolvedEnv(env)['DSM_PUBLIC_URL'], 'https://nas.example.com:5001');
    assert.equal(sourceOf('publicUrl', env), 'saved');
    await saveConnector('publicUrl', { off: true }, 'carol');
    assert.equal(resolvedEnv(env)['DSM_PUBLIC_URL'], undefined);
    assert.equal(sourceOf('publicUrl', env), 'off');
    await saveConnector('publicUrl', { clear: true }, 'carol');
    assert.equal(resolvedEnv(env)['DSM_PUBLIC_URL'], 'https://env.example.com');
    assert.equal(sourceOf('census', {}), 'default');
  });
  test('a saved Claude key wins over the deployment token; mail fills every SMTP variable', async () => {
    loadConnectors(path);
    await saveConnector('claude', { value: 'sk-saved' }, 'carol');
    await saveConnector('mail', { value: { ...MAIL, plainAuth: true } }, 'carol');
    const env = resolvedEnv({ ANTHROPIC_AUTH_TOKEN: 'tok' });
    assert.equal(env['ANTHROPIC_API_KEY'], 'sk-saved');
    assert.equal(env['ANTHROPIC_AUTH_TOKEN'], undefined);
    assert.deepEqual([env['SMTP_HOST'], env['SMTP_PORT'], env['SMTP_PLAIN_AUTH']], ['mail.example.com', '587', '1']);
  });
  test('the file is 0600, written whole, and holds no old password and no .tmp afterwards', async () => {
    loadConnectors(path);
    await saveConnector('mail', { value: MAIL }, 'carol');
    await saveConnector('mail', { value: { ...MAIL, pass: 'correct-horse-2' } }, 'carol');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, /hunter2-long/);
    assert.deepEqual((await readdir(join(path, '..'))).sort(), ['connectors.json']);
  });
  test('a file that does not parse is reported, ignored and left as it was', async () => {
    await writeFile(path, '{ not json');
    const { problems } = loadConnectors(path);
    assert.equal(problems.length, 1);
    assert.deepEqual(connectors(), { version: 1 });
    assert.equal(await readFile(path, 'utf8'), '{ not json');
  });
  test('a key of the wrong shape is ignored, the rest kept', async () => {   // Review Focus 1
    await writeFile(path, JSON.stringify({ version: 1,
      signIn: { value: 'alice', by: 'carol', at: '2026-11-02T00:00:00Z' },
      bookUrl: { value: 'https://book.example.com', by: 'carol', at: '2026-11-02T00:00:00Z' } }));
    const { problems } = loadConnectors(path);
    assert.match(problems.join(' '), /signIn/);
    assert.equal(connectors().signIn, undefined);
    assert.equal(resolvedEnv({ ALLOWED_USERS: 'alice,bob' })['ALLOWED_USERS'], 'alice,bob');
    assert.equal(resolvedEnv({})['BOOK_URL'], 'https://book.example.com');
  });
  test('who may sign in is never off', async () => {
    loadConnectors(path);
    await assert.rejects(() => saveConnector('signIn', { off: true }, 'carol'), /cannot be off/);
  });
  test('a clear forgets its test; the last to save is named', async () => {
    loadConnectors(path);
    await saveConnector('mail', { value: MAIL }, 'carol', new Date('2026-11-01T00:00:00Z'));
    await recordTest('mailTest', { at: '2026-11-01T00:00:01Z', to: 'me@example.com', ok: true, words: 'sent' });
    await saveConnector('census', { value: 'k' }, 'dave', new Date('2026-11-02T00:00:00Z'));
    assert.equal(lastSavedBy(), 'dave');
    await saveConnector('mail', { clear: true }, 'carol');
    assert.equal(connectors().mailTest, undefined);
  });
  test('before a file is named, saves stay in memory and nothing is written', async () => {
    await saveConnector('census', { value: 'k' }, 'carol');
    assert.equal(resolvedEnv({})['CENSUS_API_KEY'], 'k');
    await assert.rejects(() => stat(path));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && node --test --experimental-strip-types test/connectors.test.ts`
Expected: FAIL. Cannot find module `../src/connectors.ts`.

- [ ] **Step 3: Implement the signatures above in `api/src/connectors.ts`.** Module header: the NAS's connections, not any household's; never in a log; secrets only here; values read per use. It imports nothing from `synology.ts`, `claude.ts` or `server.ts`, so every module may import it without a cycle. `resolvedEnv` returns a fresh object each call (`{ ...env }` then the overlays).

- [ ] **Step 4: Run to verify they pass**

Run: `cd api && node --test --experimental-strip-types test/connectors.test.ts && npm test && npx tsc --noEmit -p .`
Expected: PASS (8 new tests); the rest unchanged.

- [ ] **Step 5: Commit**: `git add api/src/connectors.ts api/test/connectors.test.ts` then commit `"The NAS's connections live in one file of their own, and the environment is read through it"`

---

### Task 2: Moved settings are read when used

**Files:**
- Modify: `api/src/server.ts:208-221` (`ADMIN_USER` stays; `ALLOWED` becomes a function), `:229` (add `CONNECTORS_PATH`), `:958-985` (booking at boot and `bookingNow`), `:1158-1173` (sign-in allowlist), `:1932` (members allowlist), `:818-855` (`settingsView.dsmPublicUrl`), `:2284-2290` (listening line)
- Modify: `api/src/settings.ts:26-46` (`DSM_PUBLIC_URL` constant becomes `currentPublicUrl()`)
- Modify: `api/src/tools.ts:2040,2094` (pricing keys)
- Modify: `api/src/booking.ts` callers only: `bookingStatus` and `mailWhileOff` are now passed `resolvedEnv()`
- Test: `api/test/server-settings.test.ts`, `api/test/settings.test.ts`

**Interfaces:**
- Consumes: `loadConnectors`, `resolvedEnv`, `saveConnector`, `resetConnectors` (Task 1).
- Produces:
  ```ts
  // server.ts
  const CONNECTORS_PATH = process.env['CONNECTORS_PATH'] ?? 'data/connectors.json';   // beside sessions.json, outside HOUSEHOLDS_DIR
  /** Who may sign in: the saved list, else ALLOWED_USERS, else anyone (empty). Lowercased and trimmed. Read per use. */
  const allowedUsers = (): string[];
  // settings.ts
  /** DSM's public origin as it stands now: saved, else DSM_PUBLIC_URL, else null. */
  export const currentPublicUrl = (): string | null;   // dsmPublicUrl(resolvedEnv()['DSM_PUBLIC_URL'])
  ```
  `start()` calls `loadConnectors(CONNECTORS_PATH)` first, before adoption, and prints each problem as `[budget] connectors.json: <problem>; that setting comes from the deployment`. `bookingNow()` works the status out from `resolvedEnv()` on every call (Task 18 replaces the household half). The listening line names `allowedUsers()` as it is at boot.

- [ ] **Step 1: Write the failing tests** (in `server-settings.test.ts`, which sets `CONNECTORS_PATH: join(dir, 'connectors.json')` in its `Object.assign(process.env, …)` and imports `saveConnector` after `src/`)

```ts
describe('settings moved off .env are read when used', () => {
  test("the NAS's public address: saved beats the deployment, and off hides it, without a restart", async () => {
    process.env['DSM_PUBLIC_URL'] = 'https://env.example.com:5001';
    assert.equal((await call(alice, 'GET', '/api/settings')).json.dsmPublicUrl, 'https://env.example.com:5001');
    await saveConnector('publicUrl', { value: 'https://nas.example.com:5001' }, 'carol');
    assert.equal((await call(alice, 'GET', '/api/settings')).json.dsmPublicUrl, 'https://nas.example.com:5001');
    await saveConnector('publicUrl', { off: true }, 'carol');
    assert.equal((await call(alice, 'GET', '/api/settings')).json.dsmPublicUrl, null);
    await saveConnector('publicUrl', { clear: true }, 'carol');
  });
  test('who may sign in is the saved list once there is one', async () => {
    await saveConnector('signIn', { value: ['alice', 'bob'] }, 'carol');
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'c' }) });
    assert.equal(res.status, 401);
    await signIn('bob', 'battery-staple');
    await saveConnector('signIn', { clear: true }, 'carol');
  });
});
```

```ts
// settings.test.ts
test('the public address is read when asked, not when loaded', async () => {
  resetConnectors();
  process.env['DSM_PUBLIC_URL'] = 'https://a.example.com';
  assert.equal(currentPublicUrl(), 'https://a.example.com');
  process.env['DSM_PUBLIC_URL'] = 'https://b.example.com/path';
  assert.equal(currentPublicUrl(), 'https://b.example.com');
  delete process.env['DSM_PUBLIC_URL'];
});
```

- [ ] **Step 2: Run to verify they fail.** Run `cd api && node --test --experimental-strip-types test/server-settings.test.ts test/settings.test.ts`. Expected: FAIL (`saveConnector` has no effect on the server; `currentPublicUrl` is not exported).

- [ ] **Step 3: Implement.** Replace every read of the moved variables in `src/` with a read through `resolvedEnv()` at the point of use: `ALLOWED` at both call sites, `DSM_PUBLIC_URL` in `settingsView` and wherever else `server.ts` and `settings.ts` read it, `CENSUS_API_KEY`/`EIA_API_KEY` in both tool runs, and the `process.env` passed to `bookingStatus` and `mailWhileOff`. `grep -n "process.env\['\(ALLOWED_USERS\|DSM_PUBLIC_URL\|BOOK_URL\|SMTP_\|CENSUS_API_KEY\|EIA_API_KEY\)" src` returns nothing afterwards. Each test file that starts the server sets `CONNECTORS_PATH` to its temporary directory.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"The public address, who may sign in, mail, booking's page and the pricing keys are read when used"`

---

### Task 3: An administrator is one by DSM's group

**Files:**
- Create: `api/src/accounts.ts`
- Modify: `api/src/auth.ts:23-44` (`Session.admin`), `:93-101` (`issue`), `:131-155` (`#load`; `#save` unchanged)
- Modify: `api/src/server.ts:1158-1214` (`signIn`), `:1271-1281` (`/api/auth/check`), `:1294` (`isAdmin`), `:1698-1710` (`/api/whoami`), and the boot line `admin:` (`:950`)
- Modify: `api/tools/fake-dsm/server.ts` (`Account.admin`, `parseAccounts`, `APIS`, two handlers) and its `README.md`
- Modify: `api/test/fake-nas.ts` (`fakeNas({ admins })`)
- Test: `api/test/auth.test.ts`, `api/test/fake-dsm.test.ts`, `api/test/server-connectors.test.ts` (new; Task 19 adds to it)

**Interfaces:**
- Produces, in `accounts.ts` (both calls provisional until probes 1 and 2 of Task 23 name them; each is one constant so the swap is one line):
  ```ts
  export const ADMIN_GROUP_CALL = { api: 'SYNO.Core.Group.Member', version: 1, method: 'list', params: { group: 'administrators' } } as const;
  export const ACCOUNTS_CALL = { api: 'SYNO.Core.User', version: 1, method: 'list' } as const;
  /** Whether `who` is in DSM's administrators group, asked with their own fresh sid. Any failure is false. */
  export async function isAdministrator(sid: string, who: string, f?: DsmFetch): Promise<boolean>;
  /** The DSM accounts this session can list, lowercased. A refusal is a SynologyError. */
  export async function listAccounts(sid: string, f?: DsmFetch): Promise<string[]>;
  ```
  Both read `data.users[].name` (the fake answers that shape; the check prints the real one).
- Produces, in `auth.ts`: `Session.admin: boolean` (readonly); `issue(who, { …, admin?: boolean })`; a session read from the file has `admin: false`.
- Produces, in `server.ts`: the rule, read at sign-in only:
  ```ts
  /** ADMIN_USER when set, else DSM's administrators group, asked once with the fresh sid. The bypass is never an admin unless ADMIN_USER names it. */
  async function adminAtSignIn(username: string, sid: string | null): Promise<boolean>;
  ```
  `/api/auth/check`, `/api/whoami`, `POST /api/auth/login` and `isAdmin` read `session.admin`. The boot line reads `admin: ADMIN_USER=<name>` or `admin: DSM's administrators group`.
- Produces, in the fake: `Account.admin?: boolean`; `FAKE_DSM_ACCOUNTS` entries `name:password[:otp[:admin]]` (`alice:correct-horse::admin`); `SYNO.Core.Group.Member` `list` answers an admin caller `{ users: [{ name }…admins], total }` and anyone else 105; `SYNO.Core.User` `list` answers an admin `{ users: [{ name }…all], total }` and anyone else 105. `fakeNas(o?: { teamFolders?; admins?: readonly string[] })`.

- [ ] **Step 1: Write the failing tests**

```ts
// auth.test.ts
test('the admin flag is kept in memory and never in the sessions file', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-admin-')), 'sessions.json');
  const s = new Sessions({ path });
  const token = s.issue('carol', { sid: 'S', admin: true });
  assert.equal(s.get(token)!.admin, true);
  assert.doesNotMatch(await readFile(path, 'utf8'), /admin/);
  assert.equal(new Sessions({ path }).get(token)!.admin, false, 'after a restart, sign in again for Connectors');
});
```

```ts
// fake-dsm.test.ts
test('the fourth field makes an admin', () => {
  assert.deepEqual(parseAccounts('alice:correct-horse::admin,bob:b')['alice'], { password: 'correct-horse', otp: null, admin: true });
  assert.equal(parseAccounts('bob:b')['bob']!.admin, false);
});
test('the administrators group answers an admin, and refuses anyone else', async () => {
  const nas = await fakeNas({ admins: ['carol'] });
  assert.equal(await isAdministrator(await nas.signIn('carol'), 'carol', nas.via), true);
  assert.equal(await isAdministrator(await nas.signIn('alice'), 'alice', nas.via), false);
  assert.deepEqual((await listAccounts(await nas.signIn('carol'), nas.via)).sort(), ['alice', 'bob', 'carol']);
  const plain = await nas.signIn('alice');
  await assert.rejects(() => listAccounts(plain, nas.via), SynologyError);
  await nas.close();
});
```

```ts
// api/test/server-connectors.test.ts (new: the fake with carol as admin, ADMIN_USER unset, CONNECTORS_PATH temporary)
describe('who is an admin', () => {
  test("an account in DSM's administrators group is one, at sign-in, and says so everywhere", async () => {
    const carol = await signIn('carol', 'c');
    assert.equal((await call(carol, 'GET', '/api/auth/check')).json.admin, true);
    assert.equal((await call(carol, 'GET', '/api/households')).json.admin, true);
    assert.equal((await call(carol, 'GET', '/api/admin/households')).status, 200);
    const alice = await signIn('alice', 'correct-horse');
    assert.equal((await call(alice, 'GET', '/api/auth/check')).json.admin, false);
    assert.equal((await call(alice, 'GET', '/api/admin/households')).status, 403);
  });
});
```

Add one test to `server-settings.test.ts`, which sets `ADMIN_USER: 'alice'` in its env: `test('ADMIN_USER names the admin, whatever the group says')`, asserting `alice`'s `/api/auth/check` says `admin: true` and `bob`'s `false`.

- [ ] **Step 2: Run to verify they fail.** Run the four files. Expected: FAIL (`admin` undefined; `isAdministrator` not exported; the fake answers 102).

- [ ] **Step 3: Implement.** `isAdministrator` calls `dsm(ADMIN_GROUP_CALL…)` and is true only when the answer lists `who` (case-blind); any thrown error is false and is not logged (the error could carry nothing actionable, and the sid must not reach a log). The fake's README gains a paragraph on the fourth field and the two calls.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"An administrator is one by DSM's own group, asked once at sign-in and kept in memory, unless ADMIN_USER says otherwise"`

---

## Phase 2: The household's choices in the log

### Task 4: Zone, booking and the envelope model in the log, and the system actor

**Files:**
- Modify: `api/src/types.ts` (three ops; `SYSTEM`; `Settings.booking`, `Settings.model`; `State.zone`; `zoneOf`; `CONFIG_OPS`)
- Modify: `api/src/replay.ts` (`Draft`, `emptyDraft`, `freeze`, `thaw`; `validate`; `validateSettings`; `fold`, including `calendar.household` clearing `calendarGone`)
- Modify: `api/src/restore.ts:43-47` (scope `settings`), `:316-318` (summary words)
- Modify: `api/src/tools.ts` (`describe` words for the three ops), `api/src/activity.ts` if it lists ops by name
- Test: `api/test/settings-log.test.ts` (new)

**Interfaces:**
- Produces, in `types.ts`:
  ```ts
  /** The app itself, as an author: it carries over a folder at boot and turns booking off. */
  export const SYSTEM: Actor = 'system';
  // Events (settings scope):
  /** The household's IANA zone, such as America/Denver. */
  | { op: 'household.zone'; zone: string }
  /** Whether friends may ask to stay with this household. `calendarGone`: written by `system` when the Household calendar was found gone. */
  | { op: 'guests.booking'; on: boolean; calendarGone?: true }
  /** The model that suggests envelopes on import; null for the default. */
  | { op: 'envelopes.model'; model: string | null }
  /** The five ops of this design, which only the owner (and, for two of them, `system`) may write. */
  export const CONFIG_OPS: ReadonlySet<Op>;   // 'documents.folder', 'documents.moved', 'household.zone', 'guests.booking', 'envelopes.model'
  /** What `system` may write among CONFIG_OPS. Facts a seed wrote as `system` are not limited by this. */
  export const systemMay = (e: NewEventShape): boolean;   // documents.folder with source 'deployment'; guests.booking with on false
  // Settings gains:
  readonly booking: { readonly on: boolean; readonly by: Actor; readonly at: string; readonly calendarGone: boolean } | null;
  readonly model: string | null;
  // State gains:
  readonly zone: string | null;
  export const zoneOf = (s: Pick<State, 'zone'>): string => householdZone(s.zone);
  ```
  `documents.folder` and `documents.moved` are typed here too (Task 5 folds them; until then the fold refuses them with `not yet`), so `CONFIG_OPS` is whole from the start.

  The rules:
  - `validate`: a `system` author of a `CONFIG_OPS` op that `systemMay` refuses is `system cannot <op>`; `calendarGone` from anyone but `system`, or with `on: true`, is refused.
  - `validateSettings`: `household.zone` is a non-empty string with no spaces, at most 64 characters (`a time zone is a name such as America/Denver`); whether ICU knows it is the route's to say, so a log written on one Node replays on another. `envelopes.model` is null or a non-empty string at most 100 characters. `guests.booking.on` is a boolean.
  - Fold, for the three: `e.who` is the owner or `system`, else `only the owner, <owner>, can choose this`. `household.zone` sets `zone`; `envelopes.model` sets `settings.model`; `guests.booking` sets `settings.booking`. `calendar.household` sets `settings.booking.calendarGone` to false.
  - `planRestore`'s settings summary line becomes `the household's settings: areas, links, calendars, the arrival note, appearance, the time zone, booking and the envelope model`.
  - `describe`: `set the household's time zone to <zone>`; `turned booking on` / `turned booking off` (`, because the Household calendar is gone` with `calendarGone`); `chose <model> to suggest envelopes` / `went back to the default model for envelopes`.

- [ ] **Step 1: Write the failing tests**

```ts
// api/test/settings-log.test.ts (a household claimed by alice, bob a member, as calendar.test.ts makes one)
describe("the household's choices", () => {
  test('the owner sets the zone, the model and booking; state holds them', async () => {
    await s.append('alice', [{ op: 'household.zone', zone: 'America/Denver' }, { op: 'envelopes.model', model: 'claude-sonnet-5-5' },
      { op: 'guests.booking', on: true }]);
    assert.equal(s.state.zone, 'America/Denver');
    assert.equal(zoneOf(s.state), 'America/Denver');
    assert.equal(s.state.settings.model, 'claude-sonnet-5-5');
    assert.deepEqual({ ...s.state.settings.booking, at: '' }, { on: true, by: 'alice', at: '', calendarGone: false });
  });
  test('a member is refused, in the log and not only at the route', async () => {
    await assert.rejects(() => s.append('bob', { op: 'household.zone', zone: 'Europe/London' }), /only the owner, alice/);
  });
  test('system may turn booking off, and nothing else of these', async () => {
    await s.append(SYSTEM, { op: 'guests.booking', on: false, calendarGone: true });
    assert.equal(s.state.settings.booking!.calendarGone, true);
    await assert.rejects(() => s.append(SYSTEM, { op: 'guests.booking', on: true }), /system cannot guests.booking/);
    await assert.rejects(() => s.append(SYSTEM, { op: 'household.zone', zone: 'UTC' }), /system cannot household.zone/);
    await assert.rejects(() => s.append('alice', { op: 'guests.booking', on: false, calendarGone: true }), /calendarGone/);
  });
  test('a calendar chosen again clears the calendar-gone mark', async () => { /* calendar.household with replaces → calendarGone false */ });
  test("a seed's facts written as system still replay", async () => {
    const seeded = replay([ev('system', { op: 'category.define', category: 'groceries', label: 'Groceries' }),
      ev('system', { op: 'budget.create', budget: 'home', label: 'Home' })]);
    assert.equal(seeded.budgets.size, 1);
  });
  test('a zone with a space, or empty, is refused by name', async () => { /* 'Mountain Time', '' → /a time zone is a name/ */ });
  test('all three are settings, for a restore', () => { /* scopeOf each === 'settings' */ });
});
```

- [ ] **Step 2: Run to verify they fail.** Run `cd api && node --test --experimental-strip-types test/settings-log.test.ts`. Expected: FAIL (unknown ops; type errors).

- [ ] **Step 3: Implement** as specified. Tests that deep-equal a whole `Settings` or `State` gain the new fields (`booking: null`, `model: null`, `zone: null`).

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"The household's time zone, booking and envelope model are the owner's choices in the log, and the app may turn booking off"`

---

### Task 5: Where documents live, in the log

**Files:**
- Modify: `api/src/types.ts` (`DocumentsFolder`, `MoveFile`, `moveKey`, `DocumentsState`, `State.documents`, `movesLeft`)
- Modify: `api/src/replay.ts` (validate the two ops; `Draft.documents`; fold `documents.folder`, `documents.moved`, and the tracking in `thread.briefing`, `thread.answer`, `plan.doc`)
- Modify: `api/src/tools.ts` (`describe`), `api/src/activity.ts` (`NOT_A_CHANGE` += `documents.moved`), `api/src/thread.ts` (`documents.moved` is not a line)
- Test: `api/test/settings-log.test.ts`

**Interfaces:**
- Produces, in `types.ts`:
  ```ts
  /** A Team Folder and a folder in it, one or more segments: Drive's /team-folders/<team>/<folder>, File Station's /<team>/<folder>. */
  export interface DocumentsFolder { readonly team: string; readonly folder: string }
  | { op: 'documents.folder'; team: string; folder: string; source: 'owner' | 'deployment' }
  | { op: 'documents.moved'; file: { link: string; doc?: DocRef } | { plan: PlanId; name: string; path?: string }; gone?: true }
  /** A file the log says the app wrote: a Drive document by its link, under its parent (`today`, `answers` or a plan's id), or a file on a card. */
  export type MoveFile =
    | { readonly kind: 'doc'; readonly link: string; readonly parent: string; readonly name: string }
    | { readonly kind: 'card'; readonly plan: PlanId; readonly name: string };
  export const moveKey = (f: { link: string } | { plan: PlanId; name: string }): string;   // `link:<link>` or `card:<plan>/<name>`
  export interface DocumentsState {
    readonly folder: (DocumentsFolder & { readonly source: 'owner' | 'deployment'; readonly event: EventId; readonly by: Actor; readonly at: string }) | null;
    /** The folder before this one; null for the first choice. */
    readonly previous: DocumentsFolder | null;
    /** Every Drive document the app wrote that the log still points to, by moveKey. */
    readonly docs: ReadonlyMap<string, Extract<MoveFile, { kind: 'doc' }>>;
    /** The files still to move out of `previous`, by moveKey. Empty when no move is pending. */
    readonly waiting: ReadonlyMap<string, MoveFile>;
    /** A moved document's link before the move, to its DocRef now. */
    readonly relinked: ReadonlyMap<string, DocRef>;
  }
  export const movesLeft = (s: Pick<State, 'documents'>): number => s.documents.waiting.size;
  ```
  The fold:
  - `thread.briefing` and `thread.answer` with a `doc` put `{ kind: 'doc', link, parent: 'today' | 'answers', name: basename(doc.path) }` in `docs` (a briefing written again the same day has the same link, so the same key). `plan.doc` replaces that plan's earlier page in `docs` when the link differs, with `parent` the plan's id and `name` `plan.md`.
  - `documents.folder`: the owner or `system` (Task 4's rule). With files `waiting`, refused: `Wait until the <N> documents have moved.` The same team and folder as now: `documents already live in <team>/<folder>`. With a folder already chosen, `previous` becomes it and `waiting` becomes every entry of `docs` plus a `card` entry for each attachment on each live plan, as the log stood before this event. A first choice moves nothing.
  - `documents.moved`: a member (`<who> is not a member of this household`). A key not in `waiting` is refused: `that file is not waiting to move`. A `doc` relinks: `relinked` gains old link → doc, every `relinked` value whose link was the old one becomes the doc, `docs` moves to the new key, and any plan whose `page.doc.link` was the old link gets `page: { doc, event: page.event }`. `gone`, or a `link` with neither `doc` nor `gone` (left where Drive keeps it, outside the old folder), takes the key out of `docs`. The key leaves `waiting` either way.
  - Validate: `team` is one segment and `folder` one or more, each passing `attachments.ts`'s `segment` rule (no `/` in a segment, no `..`, control character, comma or `%`), no empty segment, no spaces around; `source` is `owner` or `deployment`; `deployment` from anyone but `system` is `the deployment's folder is carried over only by system`, and `owner` from `system` is refused by Task 4's `systemMay`. `documents.moved.file` is exactly one of the two shapes; `doc` passes `isDocRef`; `path` is a non-empty string; `doc` and `gone` are not both present.
  - `describe`: `chose <team>/<folder> for the household's documents` (`, carried over from the deployment` for `source: 'deployment'`); `moved <name> to the household's new folder` / `found <name> gone, so there was nothing to move`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('where documents live', () => {
  const DOC = { link: 'f3c1', file_id: '881', hash: 'abc', version_id: '1', path: '/team-folders/Planner/h1/today/2026-11-02-household.md' };
  test('a first choice moves nothing', async () => {
    await s.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'owner' });
    assert.deepEqual({ team: s.state.documents.folder!.team, folder: s.state.documents.folder!.folder }, { team: 'Planner', folder: 'h1' });
    assert.equal(movesLeft(s.state), 0);
  });
  test('a second choice waits on every file the log names in the old folder, as it stood', async () => {
    // a briefing with DOC (twice, same link), an answer with another doc, plan gate with plan.doc and an attachment quote.pdf,
    // plan old removed with an attachment
    await s.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'home/h1', source: 'owner' });
    assert.deepEqual(s.state.documents.previous, { team: 'Planner', folder: 'h1' });
    assert.deepEqual([...s.state.documents.waiting.keys()].sort(),
      ['card:gate/quote.pdf', `link:${ANSWER.link}`, `link:${DOC.link}`, `link:${PAGE.link}`].sort());
  });
  test('a third choice mid-move is refused, saying how many are left', async () => {
    await assert.rejects(() => s.append('alice', { op: 'documents.folder', team: 'Planner', folder: 'x', source: 'owner' }),
      /Wait until the 4 documents have moved\./);
  });
  test('a moved document with a new link is followed: relinked, the page pointer replaced, the key moved', async () => {
    const NEW = { ...PAGE, link: 'n3w', path: '/team-folders/Planner/home/h1/gate/plan.md' };
    await s.append('bob', { op: 'documents.moved', file: { link: PAGE.link, doc: NEW } });
    assert.deepEqual(s.state.documents.relinked.get(PAGE.link), NEW);
    assert.equal(s.state.plans.get('gate')!.page!.doc.link, 'n3w');
    assert.ok(s.state.documents.docs.has('link:n3w'));
    assert.equal(movesLeft(s.state), 3);
  });
  test('the same file twice is refused', async () => {   // Review Focus 4, in the log
    await assert.rejects(() => s.append('bob', { op: 'documents.moved', file: { link: PAGE.link, doc: PAGE } }), /not waiting to move/);
  });
  test('gone, and left alone, both count as done and drop the document', async () => { /* gone: true; { link } alone */ });
  test('a card file is recorded by plan and name, with where it landed', async () => { /* path: '/Planner/home/h1/gate/quote.pdf' */ });
  test('the deployment is only for system; a folder must be segments', async () => {
    await refused(s, 'alice', { op: 'documents.folder', team: 'Planner', folder: 'x', source: 'deployment' }, /only by system/);
    for (const folder of ['', '../up', 'a/../b', 'a,b', '50%', 'a//b']) {
      await refused(s, 'alice', { op: 'documents.folder', team: 'Planner', folder, source: 'owner' }, /folder/);
    }
  });
  test('a non-member cannot record a move', async () => { /* carol → /not a member/ */ });
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (Task 4's `not yet`).

- [ ] **Step 3: Implement** as specified. `waiting` is computed inside the fold from `d.documents.docs` and `d.plans` at the moment `documents.folder` folds, so restoring or replaying the same log gives the same list.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"Where documents live is a choice in the log, and a change of folder lists every file to move, as the log stood"`

---

### Task 6: A restore as a new household keeps the zone and the model

**Files:**
- Modify: `api/src/households.ts:146-167` (`createFromLog`)
- Modify: `api/src/server.ts:1368-1375` (the restore route answers with `summary`)
- Test: `api/test/households.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** createFromLog now also answers what it dropped and kept, in sentences for the restore's answer. */
  async createFromLog(who: Actor, label: string, events: Event[], opts?: { id?: string }):
    Promise<{ id: string; store: Store; summary: string[] }>;
  ```
  Every `CONFIG_OPS` event is left out of the file written. After `household.claim`, the latest `household.zone` and the latest `envelopes.model` in the backup are appended as `who`, in that order, when present. `summary` holds `kept the time zone, <zone>` and `kept the envelope model, <model or the default>` for those, and, when the backup held any, the sentence: `The copy chooses its own folder for documents and starts with booking off: no two households share a folder, and friends book with one household at a time.` `POST /api/restore` with `asNewHousehold` answers `{ id, events, mode: 'new household', summary }`.

  Restoring the settings scope in place from a backup with another owner stays refused: replay refuses the five ops from anyone but this household's owner, so `active.adopt` throws and nothing is written. A test pins it.

- [ ] **Step 1: Write the failing tests**

```ts
describe('restoring a whole household keeps its zone and model, and chooses its own folder', () => {
  test('zone and model are written again by the new owner; folder, moves and booking are dropped, and it says so', async () => {
    const source = new Households(await dir());
    const a = await source.create('someone-else', 'Theirs');
    await a.store.append('someone-else', [{ op: 'household.zone', zone: 'America/Denver' },
      { op: 'envelopes.model', model: 'claude-sonnet-5-5' }, { op: 'guests.booking', on: true },
      { op: 'documents.folder', team: 'Planner', folder: 'theirs', source: 'owner' }]);
    const hh = new Households(await dir());
    const { store, summary } = await hh.createFromLog('alice', 'Restored', parseBackup(await readFile(a.store.path, 'utf8')).events as Event[]);
    assert.equal(store.state.zone, 'America/Denver');
    assert.equal(store.state.settings.model, 'claude-sonnet-5-5');
    assert.equal(store.state.documents.folder, null);
    assert.equal(store.state.settings.booking, null);
    const last = (await store.since(null)).slice(-2);
    assert.deepEqual(last.map((e) => [e.op, e.who]), [['household.zone', 'alice'], ['envelopes.model', 'alice']]);
    assert.match(summary.join(' '), /chooses its own folder/);
  });
  test('restoring settings in place from another owner is still refused, and writes nothing', async () => {
    // planRestore(target, backup with another owner's household.zone, ['settings']); eventsToApply; adopt rejects; eventCount unchanged
  });
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (the zone event from someone-else is refused before the claim, and the restore does not load).

- [ ] **Step 3: Implement** as specified.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"A household restored as a copy keeps its zone and model, under its new owner, and chooses its own folder"`

---

### Task 7: A household's zone decides its day

**Files:**
- Modify: every no-argument `householdZone()` in `src/`: `appointment-edits.ts:104,152`, `appointments.ts:139,335`, `booking.ts:921`, `calendar-view.ts:114,225`, `calendar.ts:247,354`, `conversation.ts:206`, `drift.ts:455,514,641,664`, `tools.ts:2755,2828`, `server.ts:840,921`
- Modify: `api/src/calendar.ts:351-361` (`lastWrittenEvent`, `lastWritten` take `tz`), `api/src/drift.ts:142` (the guard), `:454` (`driftWords(plan, d, tz)`), `:543` (`pageDriftWords(plan, d, tz)`) and their callers
- Modify: `api/src/server.ts`: `todayInTz(tz)` per request from the household's state; `ensureHousehold(… tz: zoneOf(active.state))`; `GET /api/settings` `tz`; `/api/whoami` `timeZone`; `/book/me` and the other `/book/*` days from the booking household's state; new `POST /api/settings/zone`
- Test: `api/test/server-settings.test.ts`, `api/test/server-thread.test.ts`

**Interfaces:**
- Consumes: `zoneOf`, `household.zone` (Task 4).
- Produces:
  ```ts
  // calendar.ts
  export function lastWritten(plan: Plan, slot: Slot, link: CalendarLink, tz: string): DriftSide;
  // drift.ts
  export function driftWords(plan: Plan, d: Drift, tz: string): { summary: string; effects: string[] };
  export function pageDriftWords(plan: Plan, d: PageDrift, tz: string): { summary: string; effects: string[] };
  ```
  Each caller with a context passes `zoneOf(ctx.store.state)`. `ctx.today` is `householdDay(zoneOf(active.state))`, per request.

  `POST /api/settings/zone { zone }`: 403 `only <owner> can change this` for a member; 400 `<zone> is not a time zone this server knows` when `new Intl.DateTimeFormat('en', { timeZone: zone })` throws; else `household.zone`, answering `settingsView`.

  **The drift guard** (the spec leaves whether a zone change makes `drift.ts` see the app's own events as changed: it would, so this guards it). An event whose etag moved is compared with the plan as written in the zone the event itself carries: `lastWritten(plan, slot, link, now.tz_id || zoneOf(state))`. An event the app wrote before a change of zone, touched since only by a note, is still the app's own: its etag is recorded and nothing is asked.

- [ ] **Step 1: Write the failing tests**

```ts
// server-settings.test.ts
describe("a household's zone", () => {
  test('decides its today, whatever the other households say', async () => {
    assert.equal((await call(alice, 'POST', '/api/settings/zone', { zone: 'Pacific/Kiritimati' })).status, 200);
    const here = await call(alice, 'GET', '/api/whoami');
    assert.equal(here.json.timeZone, 'Pacific/Kiritimati');
    assert.equal(here.json.today, householdDay('Pacific/Kiritimati'));
    // a second household of bob's at Pacific/Pago_Pago: its today differs (25 hours apart)
  });
  test('only the owner sets it, and only to a zone this server knows', async () => {
    assert.equal((await call(bob, 'POST', '/api/settings/zone', { zone: 'Europe/London' })).status, 403);
    const r = await call(alice, 'POST', '/api/settings/zone', { zone: 'Mars/Olympus' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not a time zone/);
  });
});
```

```ts
// server-thread.test.ts (the drift tests' fake and helpers)
test("a change of zone does not make the app's own events look changed", async () => {
  // a plan due 2026-11-20 put on the calendar while the household is UTC
  await call(owner, 'POST', '/api/settings/zone', { zone: 'America/Denver' });
  await fetch(`http://127.0.0.1:${nas.port}/fake/move`, { method: 'POST', body: JSON.stringify({ evt_id, by: 'alice', shift: 0 }) });
  await call(owner, 'POST', '/api/calendar/check', {});
  const events = await store.since(null);
  assert.ok(!events.some((e) => e.op === 'calendar.drift'));
  assert.ok(events.some((e) => e.op === 'plan.calendar.etag'));
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (404 for the route; a `calendar.drift` is raised).

- [ ] **Step 3: Implement** as specified.

- [ ] **Step 4: Verify.** Run `cd api && npm test && npx tsc --noEmit -p .`; expected PASS. Then `grep -rn "householdZone()" api/src` prints nothing.

- [ ] **Step 5: Commit**: `"Each household's day is read in its own time zone, and a new zone does not make the app's own events look changed"`

---

## Phase 3: Claude

### Task 8: The Claude key is read on every call

**Files:**
- Modify: `api/src/claude.ts:47-66` (`claude`, `setClaudeClient`, `claudeConfigured`), and the three `messages.create` calls in `ask` (`:227`), `classify` (`:313`) and `structured` (`:337`)
- Modify: `api/src/connectors.ts` (the live 401, memory only)
- Create: `api/test/fake-anthropic.ts` (a shared helper, not a test file)
- Test: `api/test/claude-key.test.ts` (new)

**Interfaces:**
- Consumes: `resolvedEnv`, `saveConnector`, `loadConnectors`, `resetConnectors` (Task 1).
- Produces, in `claude.ts`:
  ```ts
  /** The key as it stands now: a saved one (as ANTHROPIC_API_KEY), else ANTHROPIC_API_KEY, else ANTHROPIC_AUTH_TOKEN; null when off or unset. */
  export function claudeKey(): { readonly key: string; readonly as: 'apiKey' | 'authToken' } | null;
  /** A client built with that key, every call, never cached with a key in it. A test's client from setClaudeClient wins. ClaudeUnavailable('Claude is off on this NAS') without a key. */
  export function claude(): Anthropic;
  export const claudeConfigured = (): boolean;   // forced || claudeKey() !== null; never reads ANTHROPIC_BASE_URL
  /** One minimal request, a one-token message to the deployment's envelope model, for Connectors' Test. Never throws; never says the key. */
  export async function testClaude(): Promise<{ ok: boolean; words: string }>;
  ```
  The client is `new Anthropic({ apiKey | authToken, the other null, timeout: 90_000, maxRetries: 1 })`. Each `messages.create` goes through one private wrapper: an `Anthropic.AuthenticationError` (401) calls `claudeRejected(Date.now())` and is rethrown; a success calls `claudeAccepted()`. `testClaude` sends `{ model: process.env['CLAUDE_MATCH_MODEL'] || DEFAULT_MATCH_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }` (Task 9 exports `DEFAULT_MATCH_MODEL`; until then the literal `'claude-haiku-5-5'`), and answers `{ ok: true, words: 'Claude answered' }`, `{ ok: false, words: 'the key has expired or been revoked' }` for a 401, or `{ ok: false, words: unavailableReason(err) }`.
- Produces, in `connectors.ts`:
  ```ts
  export function claudeRejected(at: number): void;   // a live 401
  export function claudeAccepted(): void;             // a live success, a passing Test, or a new key saved, clears it
  export function claudeHealth(): { readonly rejectedAt: number | null };
  ```
  Kept in memory only (decided here: the spec says a live 401 breaks the row, not that it is written down; a restart forgets it and the next live call finds out again). `saveConnector('claude', …)` clears it.
- Produces, in `api/test/fake-anthropic.ts`:
  ```ts
  export interface FakeAnthropic { url: string; keys: string[]; answer: 'ok' | 401; close(): Promise<void> }
  /** An HTTP server for POST /v1/messages: records x-api-key (or the bearer token), answers a one-text-block message or a 401. */
  export async function fakeAnthropic(): Promise<FakeAnthropic>;
  ```
  Its success body is `{ id: 'msg_1', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: '{"matches":[]}' }], stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } }`; its 401 is `{ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }`.

- [ ] **Step 1: Write the failing tests**

```ts
// api/test/claude-key.test.ts
const fake = await fakeAnthropic();
process.env['ANTHROPIC_BASE_URL'] = fake.url;
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];
const { claudeConfigured, classify, testClaude } = await import('../src/claude.ts');
const { saveConnector, loadConnectors, claudeHealth } = await import('../src/connectors.ts');
loadConnectors(join(await mkdtemp(join(tmpdir(), 'pb-claude-')), 'connectors.json'));
const SCHEMA = { type: 'object', additionalProperties: false, required: ['matches'], properties: { matches: { type: 'array' } } };

describe('the Claude key', () => {
  test('a base URL alone is not a key: Claude is off, and the briefing falls back', () => {
    assert.equal(claudeConfigured(), false);
  });
  test('a key saved on Connectors is used by the next call, and a new one by the call after, without a restart', async () => {
    await saveConnector('claude', { value: 'sk-one' }, 'carol');
    assert.equal(claudeConfigured(), true);
    await classify('claude-haiku-5-5', 'sys', 'x', SCHEMA);
    await saveConnector('claude', { value: 'sk-two' }, 'carol');
    await classify('claude-haiku-5-5', 'sys', 'x', SCHEMA);
    assert.deepEqual(fake.keys.slice(-2), ['sk-one', 'sk-two']);
  });
  test('off beats the deployment; clear brings the deployment back', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-env';
    await saveConnector('claude', { off: true }, 'carol');
    assert.equal(claudeConfigured(), false);
    await saveConnector('claude', { clear: true }, 'carol');
    await classify('claude-haiku-5-5', 'sys', 'x', SCHEMA);
    assert.equal(fake.keys.at(-1), 'sk-env');
    delete process.env['ANTHROPIC_API_KEY'];
  });
  test('a 401 from a live call is remembered, and Test says the key is no good, never the key', async () => {
    await saveConnector('claude', { value: 'sk-revoked' }, 'carol');
    fake.answer = 401;
    await assert.rejects(() => classify('claude-haiku-5-5', 'sys', 'x', SCHEMA));
    assert.notEqual(claudeHealth().rejectedAt, null);
    const t = await testClaude();
    assert.deepEqual(t, { ok: false, words: 'the key has expired or been revoked' });
    fake.answer = 'ok';
    assert.deepEqual(await testClaude(), { ok: true, words: 'Claude answered' });
    assert.equal(claudeHealth().rejectedAt, null);
  });
});
after(() => fake.close());
```

- [ ] **Step 2: Run to verify they fail.** Run `cd api && node --test --experimental-strip-types test/claude-key.test.ts`. Expected: FAIL (`testClaude` not exported; the cached client keeps `sk-one`).

- [ ] **Step 3: Implement** as specified. The tests that delete `ANTHROPIC_API_KEY` to get the fallback keep working, since `claudeConfigured` now reads only the resolved key.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"Claude's key is read on every call, so a key saved, reset or revoked counts from the next request"`

---

### Task 9: The envelope model is the household's

**Files:**
- Modify: `api/src/match.ts:35` (the module constant becomes per call), `:120-128` (`suggest`)
- Modify: `api/src/server.ts` (`settingsView.model`; `POST /api/settings/model`)
- Test: `api/test/match.test.ts`, `api/test/server-settings.test.ts`

**Interfaces:**
- Produces, in `match.ts` (the models offered are the builder's: today's default, and one more careful model):
  ```ts
  export const DEFAULT_MATCH_MODEL = 'claude-haiku-5-5';
  export const MATCH_MODELS: readonly { readonly id: string; readonly label: string }[] = [
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5: quick, and the default' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5: slower and more careful' },
  ];
  /** The list Settings offers: MATCH_MODELS, and CLAUDE_MATCH_MODEL when set and not among them, marked from the deployment. */
  export function modelChoices(env?: NodeJS.ProcessEnv): { id: string; label: string; fromDeployment: boolean }[];
  /** The household's choice, else CLAUDE_MATCH_MODEL, else the default. */
  export function matchModel(state: State, env?: NodeJS.ProcessEnv): string;
  export function modelSource(state: State, env?: NodeJS.ProcessEnv): 'owner' | 'deployment' | 'default';
  ```
  `settingsView` gains `model: { chosen: string; source; choices; claudeOff: boolean }`; Settings marks the row `Claude is off on this NAS` when `claudeOff`. `POST /api/settings/model { model: string | null }`: 403 `only <owner> can change this` for a member, 400 `choose one of the models offered` for one not in `modelChoices()`, else `envelopes.model`, answering `settingsView`.

- [ ] **Step 1: Write the failing tests**

```ts
// match.test.ts
test("the household's model is the one asked, else the deployment's, else the default", async () => {
  const calls = fakeClaude([{ matches: [] }, { matches: [] }]);   // the file's existing FakeClaude, recording the model
  await suggest(state, ['ACME'], options);
  assert.equal(calls[0]!.model, 'claude-haiku-5-5');
  const chosen = apply(state, [ev('alice', { op: 'envelopes.model', model: 'claude-sonnet-5-5' })]);
  await suggest(chosen, ['ACME'], options);
  assert.equal(calls[1]!.model, 'claude-sonnet-5-5');
});
test('the deployment model is offered too, and marked', () => {
  assert.deepEqual(modelChoices({ CLAUDE_MATCH_MODEL: 'claude-opus-5-5' }).at(-1), { id: 'claude-opus-5-5', label: 'claude-opus-5-5', fromDeployment: true });
});
```

```ts
// server-settings.test.ts
test('the envelope model: the owner chooses from the list, and Settings says where it came from', async () => {
  assert.equal((await call(alice, 'POST', '/api/settings/model', { model: 'gpt-4' })).status, 400);
  assert.equal((await call(bob, 'POST', '/api/settings/model', { model: 'claude-sonnet-5-5' })).status, 403);
  const r = await call(alice, 'POST', '/api/settings/model', { model: 'claude-sonnet-5-5' });
  assert.deepEqual([r.json.model.chosen, r.json.model.source], ['claude-sonnet-5-5', 'owner']);
  assert.equal(r.json.model.claudeOff, true);
  assert.equal((await call(alice, 'POST', '/api/settings/model', { model: null })).json.model.source, 'default');
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement** as specified. `testClaude` (Task 8) now imports `DEFAULT_MATCH_MODEL`.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"Which model suggests envelopes is the household's choice, from a short list"`

---

## Phase 4: The Drive picker

### Task 10: Drive and File Station learn folders and moves; the fake grows them

**Files:**
- Modify: `api/src/drive.ts` (six exports; `listTeamFolders` reimplemented on `teamFolders`)
- Modify: `api/src/synology.ts` (File Station move)
- Modify: `api/tools/fake-dsm/server.ts` and its `README.md`
- Modify: `api/test/fake-nas.ts` (`readOnly`, `moves`)
- Test: `api/test/drive.test.ts`, `api/test/fake-dsm.test.ts`

**Interfaces:**
- Produces, in `drive.ts`:
  ```ts
  export interface TeamFolder { readonly name: string; readonly team_id: string; readonly canWrite: boolean }
  export async function teamFolders(sid: string, f?: DsmFetch): Promise<TeamFolder[]>;              // GET team-folder; capabilities.can_write
  export interface TeamMember { readonly name: string; readonly role: string }
  export async function teamFolderMembers(sid: string, team_id: string, f?: DsmFetch): Promise<TeamMember[]>;  // GET team-folder/members?team_id=
  export async function listFolders(sid: string, path: string, f?: DsmFetch): Promise<string[]>;     // POST files/list?path=, body { filter: { type: ['dir'] } }; names
  export async function makeFolder(sid: string, path: string, f?: DsmFetch): Promise<DriveFile>;     // POST files?path=&type=folder&conflict_action=stop, body {}
  /** One file to a new parent, by any Drive path (a `link:` one here). Asynchronous on the NAS: answers its task id. */
  export async function moveFile(sid: string, file: string, toParent: string, f?: DsmFetch): Promise<string>;   // POST files/move { files: [file], to_parent_folder, conflict_action: 'stop' }
  /** Drive's answer for a name already taken, as the fake gives it; probe 5 names the real one. */
  export const DRIVE_NAME_TAKEN: ReadonlySet<number> = new Set([1003]);
  export const isNameTaken = (err: unknown): boolean;
  ```
- Produces, in `synology.ts`:
  ```ts
  export const COPY_MOVE_VERSION = 3;
  export const NAS_MOVE_WAIT_MS = 5000;
  /** File Station's move: `SYNO.FileStation.CopyMove` start (remove_src, no overwrite), then status until finished or the wait is up (false). 408 and 414 are SynologyErrors as File Station says them. */
  export async function moveOnNas(sid: string, path: string, destFolder: string, f?: DsmFetch): Promise<boolean>;
  ```
- Produces, in the fake: `start` takes `readOnly?: Readonly<Record<string, readonly string[]>>` (account → Team Folders it may only read). `GET team-folder` answers `{ name, team_id: name, capabilities: { can_read: true, can_write } }` per account; `GET team-folder/members?team_id=` answers every account, role `viewer` where read-only, else `organizer`; a write, folder or move into a read-only Team Folder is 105. `POST files` (`type=folder`) makes one folder under an existing parent (1002 without it, 1003 when taken). `POST files/list` honours `filter.type: ['dir']`. `POST files/move` answers `{ async_task_id }` at once and moves after `moves.delayMs`; a taken name at the destination is 1003, answered at once; a name in `moves.refuse` is 1001. With `moves.changeLink`, the moved file gets a new `permanent_link`; else it keeps its own. `SYNO.FileStation.CopyMove` `start` moves at once and answers `{ taskid }`; `status` answers `{ finished: true }`; 408 for a missing source, 414 for a taken name. `FakeDsm` gains `moves: { delayMs: number; changeLink: boolean; refuse: Set<string> }`, mutable. `APIS` gains `'SYNO.FileStation.CopyMove': [1, 3]`. `fakeNas(o?: { teamFolders?; admins?; readOnly? })`.

- [ ] **Step 1: Write the failing tests**

```ts
// drive.test.ts (request shapes, with fakeDsm)
test('a folder is made with POST files, type folder, stop on a taken name', async () => {
  const d = fakeDsm({ success: true, data: { ...FILE, type: 'dir' } });
  await makeFolder('S', '/team-folders/Planner/home', d.fn);
  assert.equal(d.calls[0]!.method, 'POST');
  assert.match(d.calls[0]!.url, /\/files\?path=%2Fteam-folders%2FPlanner%2Fhome&type=folder&conflict_action=stop$/);
  assert.equal(d.calls[0]!.body, '{}');
});
test('a move is by link, to a parent, and never overwrites', async () => {
  const d = fakeDsm({ success: true, data: { async_task_id: 'task-12' } });
  assert.equal(await moveFile('S', 'link:f3c1', '/team-folders/Planner/home/today', d.fn), 'task-12');
  assert.deepEqual(JSON.parse(d.calls[0]!.body), { files: ['link:f3c1'], to_parent_folder: '/team-folders/Planner/home/today', conflict_action: 'stop' });
});
test('Team Folders come with whether you can write; folders are listed by the dir filter', async () => { /* … */ });
```

```ts
// fake-dsm.test.ts, describe('Synology Drive: folders and moves')
test("a read-only Team Folder is greyed for that account only, and its members say who can write", async () => {
  const nas = await fakeNas({ teamFolders: ['Planner', 'Family'], readOnly: { alice: ['Family'] } });
  const a = await nas.signIn('alice');
  assert.deepEqual((await teamFolders(a, nas.via)).map((t) => [t.name, t.canWrite]), [['Family', false], ['Planner', true]]);
  assert.deepEqual((await teamFolderMembers(a, 'Family', nas.via)).find((m) => m.name === 'alice')?.role, 'viewer');
  await assert.rejects(() => makeFolder(a, '/team-folders/Family/x', nas.via), (e: unknown) => e instanceof SynologyError && e.code === 105);
  await nas.close();
});
test('a move is asynchronous: the file is at its new path after the delay, with its link kept or changed', async () => {
  nas.nas.moves.delayMs = 200;
  // write today/a.md under h1; makeFolder h2/today; moveFile(link:…) → getFile(new path) rejects at once, resolves after 300 ms
  // permanent_link equal; then with changeLink true another file's link differs after its move
});
test('a taken name at the destination is refused at once; a name told to fail fails', async () => { /* 1003; moves.refuse → 1001 */ });
test("File Station's move takes a card's file to its new folder; a file not there is 408", async () => {
  // uploadFile into /Planner/h1/gate/quote.pdf; createFolder /Planner/h2/gate; moveOnNas → true; bytes now under h2
});
```

- [ ] **Step 2: Run to verify they fail.** Run `cd api && node --test --experimental-strip-types test/drive.test.ts test/fake-dsm.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** as specified. A file the fake moves keeps its `DriveMeta` (version, hash) under its new path; `links` points the kept link, or the new one, at the new path. The README gains a paragraph on `readOnly`, `moves`, and the two moves.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"Drive lists Team Folders with what each account may do, makes folders and moves files; the fake does the same, a little late"`

---

### Task 11: The picker, its checks, and every household's folder

**Files:**
- Create: `api/src/folders.ts`
- Test: `api/test/folders.test.ts` (new; imports `./planner-root.ts` first)

**Interfaces:**
- Consumes: `teamFolders`, `teamFolderMembers`, `listFolders`, `makeFolder`, `getFile`, `search`, `isNoSuchFile` (Task 10); `segment`, `PLANNER_ROOT` from `attachments.ts`; `slugify` from `households.ts`; `DocumentsFolder` (Task 5).
- Produces:
  ```ts
  export const drivePathOf = (c: DocumentsFolder): string;   // `/team-folders/${team}/${folder}`
  export const nasPathOf = (c: DocumentsFolder): string;     // `/${team}/${folder}`
  /** The choice as typed, made clean: segments trimmed, empty ones from a leading, trailing or doubled slash dropped. Words for what cannot be. */
  export function cleanFolder(x: { team?: unknown; folder?: unknown }): DocumentsFolder | { problem: string };
  // The registry: every household's folder, in memory, filled at boot (Task 15) and on every choice.
  export function rememberFolder(household: string, c: DocumentsFolder | null): void;
  export function folderOf(household: string): DocumentsFolder | null;
  /** Another household's folder that is this one, holds it or sits in it; compared segment by segment, case-blind. */
  export function takenBy(c: DocumentsFolder, household: string): string | null;
  export const TAKEN = 'Another household on this NAS keeps its documents there';
  export const NOT_TEAM_FOLDER = 'A shared folder not listed here is not a Team Folder yet. Enable it in Synology Drive Admin Console, Team Folder.';
  export interface TeamRow { readonly name: string; readonly canWrite: boolean; readonly fromDeployment: boolean }
  /** Step 1: Team Folders, PLANNER_ROOT's first and marked; one you cannot write is kept, greyed by the page. */
  export async function pickerTeams(sid: string, f?: DsmFetch): Promise<TeamRow[]>;
  /** Step 2: the folders in it, and a new name suggested from the household's label (slugify; `-2`, `-3` past a taken one). */
  export async function pickerFolders(sid: string, team: string, label: string, f?: DsmFetch): Promise<{ folders: string[]; suggested: string }>;
  export interface FolderChecks {
    readonly teamFolder: boolean; readonly writable: boolean;
    /** true: a page there came back with its words; false: names only; null: not known yet (nothing there to find). */
    readonly indexed: boolean | null;
    /** Household members the Team Folder's members list does not show able to write. */
    readonly cannotWrite: readonly string[];
    /** The blocking ones, in words; empty when the folder may be used. */
    readonly problems: readonly string[];
  }
  /** Step 3, making nothing: the Team Folder asked again, writable by this session, not another household's; indexing and members advise only. */
  export async function checkFolder(sid: string, c: DocumentsFolder, o: { household: string; members: readonly string[] }, f?: DsmFetch): Promise<FolderChecks>;
  /** "Use this folder": refuse what checkFolder blocks; make each missing segment with POST files; check again; append documents.folder as ctx.who; remember it. */
  export async function chooseFolder(ctx: ToolContext & { readonly household: string }, c: DocumentsFolder, f?: DsmFetch): Promise<Event[]>;
  ```
  Decided here: the index probe searches the keyword `planner` (every page's frontmatter opens `planner: 1`) with `location` the folder's Drive path; a hit with a snippet is `true`, hits with none `false`, no hit `null`. A member can write unless the members list omits them or names them `viewer` (probe 3 names the roles). The blocking words: `<team> is not a Team Folder. ` + `NOT_TEAM_FOLDER`; `You cannot write to <team>: ask the NAS's administrator for Read/Write on it.`; `TAKEN`. The `cleanFolder` words: `choose a Team Folder`, `name a folder in it`, and `segment`'s own for a bad segment.

- [ ] **Step 1: Write the failing tests** (`fakeNas({ teamFolders: ['Planner', 'Family'], readOnly: { alice: ['Family'] } })`; `PLANNER_ROOT=/Planner`)

```ts
describe('the picker', () => {
  test("the deployment's Team Folder comes first and is marked; a read-only one is listed, not writable", async () => {
    assert.deepEqual(await pickerTeams(alice, nas.via), [
      { name: 'Planner', canWrite: true, fromDeployment: true }, { name: 'Family', canWrite: false, fromDeployment: false }]);
  });
  test('folders in it, and a name suggested from the label that is not taken', async () => {
    await makeFolder(alice, '/team-folders/Planner/the-riveras', nas.via);
    assert.deepEqual(await pickerFolders(alice, 'Planner', "The Rivera's", nas.via), { folders: ['the-riveras'], suggested: 'the-riveras-2' });
  });
  test('what is typed is made clean, or refused in words, before the NAS is asked', () => {   // Review Focus 3
    assert.deepEqual(cleanFolder({ team: ' Planner ', folder: '/home//riveras/ ' }), { team: 'Planner', folder: 'home/riveras' });
    for (const folder of ['', '/', 'a/../b', 'a,b', '100%']) assert.ok('problem' in cleanFolder({ team: 'Planner', folder }), folder);
    assert.ok('problem' in cleanFolder({ team: 'a/b', folder: 'x' }));
  });
  test("checks: a folder in a Team Folder you can write, with no other household's in the way", async () => {
    const ok = await checkFolder(alice, { team: 'Planner', folder: 'h1' }, { household: 'h1', members: ['alice', 'bob'] }, nas.via);
    assert.deepEqual([ok.teamFolder, ok.writable, ok.indexed, ok.problems], [true, true, null, []]);
    const ro = await checkFolder(alice, { team: 'Family', folder: 'h1' }, { household: 'h1', members: ['alice'] }, nas.via);
    assert.match(ro.problems.join(' '), /You cannot write to Family/);
    const plain = await checkFolder(alice, { team: 'Shared', folder: 'h1' }, { household: 'h1', members: ['alice'] }, nas.via);
    assert.match(plain.problems.join(' '), /Shared is not a Team Folder\. A shared folder not listed here/);
  });
  test('the index is known once a page is there', async () => { /* writeFile a page with "planner: 1" under the folder → indexed true */ });
  test('a member who cannot write there is named, and does not block', async () => { /* readOnly bob: ['Planner'] → cannotWrite ['bob'], problems [] */ });
  test("another household's folder, one inside it, or one around it, is refused without naming it", async () => {
    rememberFolder('h2', { team: 'Planner', folder: 'home/h2' });
    for (const folder of ['home/h2', 'home/h2/sub', 'home', 'HOME/H2']) {
      assert.equal(takenBy({ team: 'Planner', folder }, 'h1'), 'h2', folder);
    }
    assert.equal(takenBy({ team: 'Planner', folder: 'home/h22' }, 'h1'), null);
    const r = await checkFolder(alice, { team: 'Planner', folder: 'home' }, { household: 'h1', members: ['alice'] }, nas.via);
    assert.deepEqual(r.problems, [TAKEN]);
  });
  test('choosing makes the folder, segment by segment, logs it as the owner, and remembers it', async () => {
    const [e] = await chooseFolder(ctx, { team: 'Planner', folder: 'homes/h1' }, nas.via);
    assert.deepEqual([e!.op, e!.who], ['documents.folder', 'alice']);
    assert.ok(existsSync(join(nas.nas.root, 'Planner/homes/h1')));
    assert.deepEqual(folderOf('h1'), { team: 'Planner', folder: 'homes/h1' });
  });
  test('choosing a refused folder makes nothing and logs nothing', async () => { /* Family → ToolError 409; no folder on disk; no event */ });
});
```

- [ ] **Step 2: Run to verify they fail.** Run `cd api && node --test --experimental-strip-types test/folders.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** as specified. `chooseFolder` throws `ToolError(problems.join(' '), 409)` for a blocked folder, and a `ToolError` 403 `only <owner> can change this` when `ctx.who` is not the owner (the fold would refuse too; the route's words come from here).

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"The folder picker: Team Folders you can write, the folders in them, the checks, and no folder another household keeps"`

---

### Task 12: The picker's routes, Setup in Settings' data, and the calendar is the owner's

**Files:**
- Create: `api/src/setup.ts` (the checklist only; Task 22 adds the notices)
- Modify: `api/src/server.ts` (four routes; `GET /api/settings` gains `setup`; `/api/calendars/household` and `/api/calendars/target` owner-only; route list in the header comment)
- Modify: `api/src/docs.ts` (`documentsStatus` names the owner when there is no folder)
- Test: `api/test/server-setup.test.ts` (new: the fake DSM, `PLANNER_ROOT=/Planner`, `TZ` unset), `api/test/server-settings.test.ts`

**Interfaces:**
- Consumes: Task 11's exports; `zoneOf`, `matchModel`/`modelSource`; `movesLeft`.
- Produces, in `setup.ts`:
  ```ts
  export type SetupStep = 'folder' | 'zone' | 'calendar' | 'booking' | 'model';
  export const SETUP_ORDER: readonly SetupStep[] = ['folder', 'zone', 'calendar', 'booking', 'model'];
  export interface StepView { readonly id: SetupStep; readonly done: boolean; readonly source: 'owner' | 'deployment' | 'default' | null }
  /** The checklist: the folder done only by a choice; the zone unfinished only without a choice and without TZ; the calendar unfinished only with no Household calendar or target; booking and model always done. */
  export function setupSteps(state: State, env?: NodeJS.ProcessEnv): { steps: StepView[]; first: SetupStep | null };
  ```
- Produces, routes (each needs a session with a `sid` (409 `sign in again to use this`) and an open household; writes owner-only, 403 `only <owner> can change this`):
  ```
  GET  /api/drive/team-folders          { teams: TeamRow[] }
  GET  /api/drive/folders?team=         { folders: string[]; suggested: string }
  POST /api/drive/folder-check          { team, folder } → FolderChecks; 400 for what cleanFolder refuses
  POST /api/settings/documents          { team, folder } → settingsView; 409 with the checks' words or "Wait until the N documents have moved."
  ```
  `GET /api/settings` (and every `settingsView` answer) gains:
  ```ts
  setup: {
    owner: Actor; youOwn: boolean; why: string | null;          // why: `Only ${owner} can change these.` for a member
    steps: StepView[]; first: SetupStep | null;
    documents: { folder: DocumentsFolder | null; source: 'owner' | 'deployment' | null; left: number;
      /** The index check, asked again on each GET with a sid until it says true; kept in memory per household. */
      indexed: boolean | null };
    zone: { zone: string; source: 'owner' | 'deployment' | 'default' };
  }
  ```
  `documents.why` (from `documentsStatus`) without a folder: `Briefings and answers are kept in the log until ${owner} chooses where documents live, in Settings.`
  The calendar routes: `POST /api/calendars/household` (make, or `replace`) and `POST /api/calendars/target` answer 403 `only ${owner} can choose the household's calendar` to anyone else. Renaming and a member's own conflict calendars are unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// api/test/server-setup.test.ts
describe('Setup in Settings', () => {
  test('a new household starts at the folder, and a member reads who can change it', async () => {
    const s = await call(alice, 'GET', '/api/settings');
    assert.deepEqual(s.json.setup.steps.map((x: any) => [x.id, x.done]),
      [['folder', false], ['zone', false], ['calendar', false], ['booking', true], ['model', true]]);
    assert.equal(s.json.setup.first, 'folder');
    assert.match(s.json.documents.why, /until alice chooses where documents live/);
    assert.equal((await call(bob, 'GET', '/api/settings')).json.setup.why, 'Only alice can change these.');
  });
  test("the picker's three steps, with the owner's own session", async () => {
    const teams = await call(alice, 'GET', '/api/drive/team-folders');
    assert.deepEqual(teams.json.teams[0], { name: 'Planner', canWrite: true, fromDeployment: true });
    const inside = await call(alice, 'GET', '/api/drive/folders?team=Planner');
    assert.equal(inside.json.suggested, 'home');
    const checks = await call(alice, 'POST', '/api/drive/folder-check', { team: 'Planner', folder: 'home' });
    assert.deepEqual(checks.json.problems, []);
    assert.equal(existsSync(join(nas.root, 'Planner/home')), false, 'checking makes nothing');
  });
  test('"Use this folder" makes it, logs it, and Settings shows it chosen', async () => {
    const r = await call(alice, 'POST', '/api/settings/documents', { team: 'Planner', folder: 'home' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.setup.documents, { folder: { team: 'Planner', folder: 'home' }, source: 'owner', left: 0, indexed: null });
    assert.equal(r.json.setup.first, 'zone');
  });
  test('a member may look, not choose', async () => {
    assert.equal((await call(bob, 'POST', '/api/settings/documents', { team: 'Planner', folder: 'x' })).status, 403);
  });
  test("another household's folder is refused in words that do not name it", async () => {
    // carol's household chooses Planner/carols; alice asks for Planner/carols/sub → 409, error === TAKEN
  });
  test('a typed folder that cannot be one is a 400 before the NAS is asked', async () => {   // Review Focus 3
    const r = await call(alice, 'POST', '/api/drive/folder-check', { team: 'Planner', folder: '../etc' });
    assert.equal(r.status, 400);
  });
  test('without a NAS session the picker says sign in again', async () => { /* bypass session → 409 */ });
});
```

```ts
// server-settings.test.ts: the tests at :296 and :311 now act as alice, the owner, and gain
test("only the owner chooses the household's calendar", async () => {
  const bob = await signIn('bob', 'battery-staple');
  assert.equal((await call(bob, 'POST', '/api/calendars/household', { replace: true })).status, 403);
  assert.equal((await call(bob, 'POST', '/api/calendars/target', ref)).json.error, "only alice can choose the household's calendar");
});
```

- [ ] **Step 2: Run to verify they fail.** Run `cd api && node --test --experimental-strip-types test/server-setup.test.ts test/server-settings.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** as specified. In `server-settings.test.ts`, the two existing tests that had bob choose the target and replace the calendar are rewritten for alice; their assertions about what the calendar becomes stay.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"Settings asks the owner where documents live, in three steps, and only the owner chooses the household's calendar"`

---

### Task 13: Setup on the Settings screen

**Files:**
- Modify: `site/index.html` (`renderSettings` ~6628: a Setup section first in "The household's" group; the existing `householdCalSec` ~6998 for owner-only; new `setupSec`, `folderPicker`, `zoneRow`, `modelRow`; the `openSettings(section)` path takes `'setup'` and a step)

**Interfaces:** consumes `settingsData.setup`, `settingsData.model`, the four Task 12 routes, `POST /api/settings/zone` and `POST /api/settings/model`.

- [ ] **Step 1: The Setup section.** A `setSec('setup', 'Setup', …)` at the top of the household's group, with one row per step in `SETUP_ORDER`, the first unfinished marked (`aria-current="step"` and the existing accent) and a member's rows read-only under `setup.why`. Each row says its source in the four words.

- [ ] **Step 2: Where documents live.** The row opens the picker in place, the way `rowForm` opens a row:
  1. A list of `teams`; a row with `canWrite: false` is shown disabled; `fromDeployment` says *from the deployment*; under the list, the sentence `NOT_TEAM_FOLDER` (Task 11).
  2. Its folders as choices, plus *A new folder* with `suggested` filled in.
  3. The checks from `POST /api/drive/folder-check`: each blocking line as `.err`; *not known yet* for `indexed: null` (*Settings asks again after the first page*); for `cannotWrite`, `<names>: their briefings stay in the log until they can`. *Use this folder* is disabled while `problems` is not empty.
  With a folder chosen, the row shows `<team>/<folder>`, *set from the deployment* when `source` is `deployment`, and *Change*.

- [ ] **Step 3: Time zone, calendar, booking, model.** Time zone: a `select` of `Intl.supportedValuesOf('timeZone')`, the current one chosen, and the note *Events already on the calendar keep the zone they were made in.* Calendar: the existing section, with its make, replace and target controls hidden for a member and `Only <owner> can choose the household's calendar.` in their place. Booking: the switch arrives in Task 18; until then the row shows the current `guests` words. Model: a `select` of `model.choices`, *Claude is off on this NAS* in `.hint` when `claudeOff`.

- [ ] **Step 4: Verify by hand.** Run `npm run fake-dsm` (its own `DSM_PORT`, never changed here), then `npm start` with `PLANNER_ROOT=/Planner`. As the owner: Settings opens with Setup first and Where documents live marked; choose Planner, a new folder, see the checks, use it; the folder appears under the fake's root. As a member: the same rows, read-only, with *Only <owner> can change these.* At 375 px wide the picker fits with no sideways scroll. Then `cd api && npm test`: PASS.

- [ ] **Step 5: Commit**: `"Settings opens with Setup: where documents live, the time zone, the calendar, booking and the envelope model"`

---

## Phase 5: Nothing in Drive before the choice

### Task 14: The household's home is its chosen folder

**Files:**
- Modify: `api/src/docs.ts` (`DocAccess`, `householdFolder`, `inHousehold`, `writeDocOrRefusal`, `documentsStatus`)
- Modify: `api/src/pages.ts:275` (`canWrite`), `:344` (`inHousehold`)
- Modify: `api/src/attachments.ts:43-54` (`attachmentPath`), `:120-151` (`readAttachment`), `ATTACHMENTS_OFF` → `filesOff`
- Modify: `api/src/drift.ts:242,287,318`, `api/src/search.ts` (the Drive half's gate and location), `api/src/briefing.ts:780` (`access` carries the store), `api/src/server.ts` (the attach route's gate; `settingsView.attachments`)
- Create: `api/test/folder.ts` (a shared helper, not a test file)
- Test: `api/test/docs.test.ts`, `api/test/pages.test.ts`, `api/test/plans.test.ts`, `api/test/briefing.test.ts`, and the fixtures of `page-drift.test.ts`, `search.test.ts`, `conversation.test.ts`, `server-plans.test.ts`

**Interfaces:**
- Consumes: `drivePathOf`, `nasPathOf` (Task 11); `state.documents` (Task 5).
- Produces:
  ```ts
  // docs.ts
  export interface DocAccess { readonly sid: string | null; readonly household?: string; readonly store: { readonly state: State } }
  /** The household's folder as Drive addresses it, or null until one is chosen. */
  export const householdFolder = (state: State): string | null;
  /** Under the chosen folder; while files wait to move, under the folder being left too. */
  export function inHousehold(file: DriveFile, state: State): boolean;
  /** What a session learned of a Team Folder, kept with documentsStatus's answer: true, false, or null for not asked yet. */
  export function teamFolderKnown(team: string): boolean | null;
  // attachments.ts
  export const filesOff = (owner: Actor | null): string =>
    `Files on cards are off until ${owner ?? 'the owner'} chooses where documents live, in Settings.`;
  export function attachmentPath(state: State, plan: PlanId, name: string): string;   // `${nasPathOf(folder)}/${plan}/${name}`, else ToolError(filesOff(owner), 409)
  // api/test/folder.ts
  export async function chooseFolderIn(store: Store, c?: DocumentsFolder): Promise<void>;   // documents.folder as the owner; default { team: 'Planner', folder: <the store's household id or 'h1'> }
  ```
  `writeDocOrRefusal` returns null without a folder (as it did without a root), and without asking Drive when `teamFolderKnown(folder.team) === false`. `documentsStatus` checks the chosen folder's Team Folder (not `PLANNER_ROOT`'s) and remembers the answer per team for `teamFolderKnown`. `canWrite` in `pages.ts`: a sid, a household and a folder. `PLANNER_ROOT` is no longer read by `docs.ts`, `pages.ts`, `drift.ts`, `search.ts` or `attachments.ts`' paths; `attachments.ts` keeps exporting it for the carry-over and the picker.

  Each fixture that wrote to Drive, or attached a file, under `PLANNER_ROOT=/Planner` and household `h1` (or the test's own id) now calls `chooseFolderIn(store)` once, so its existing assertions about `/team-folders/Planner/h1/…` and `/Planner/h1/…` stand.

- [ ] **Step 1: Write the failing tests**

```ts
// docs.test.ts
test('without a folder nothing is asked of Drive, and the words stay in the log', async () => {
  const s = await household();   // no chooseFolderIn
  const before = nas.calls.length;
  assert.equal(await writeDoc({ sid: await nas.signIn('alice'), household: 'h1', store: s }, ['today', 'x.md'], 'x', nas.via), null);
  assert.equal(nas.calls.length, before);
  assert.match((await documentsStatus({ sid: 'S', household: 'h1', store: s }, nas.via)).why!, /until alice chooses where documents live/);
});
test('the home is the chosen folder, wherever PLANNER_ROOT points', async () => {
  const s = await household();
  await chooseFolderIn(s, { team: 'Planner', folder: 'homes/riveras' });
  const doc = await writeDoc({ sid: await nas.signIn('alice'), household: 'h1', store: s }, ['today', 'x.md'], 'x', nas.via);
  assert.equal(doc!.path, '/team-folders/Planner/homes/riveras/today/x.md');
});
// pages.test.ts
test('no folder, no page: the follow-on asks nothing', async () => { /* followOn → [], no upload in nas.calls */ });
// plans.test.ts (replacing the PLANNER_ROOT path test at :868)
test("a card's file is under the chosen folder; with none, files are off, naming the owner", async () => {
  assert.throws(() => attachmentPath(fresh.state, 'p1', 'gate.png'),
    (e: unknown) => e instanceof ToolError && e.status === 409 && e.message === 'Files on cards are off until alice chooses where documents live, in Settings.');
  await chooseFolderIn(store, { team: 'Planner', folder: 'rivera' });
  assert.equal(attachmentPath(store.state, 'p1', 'gate.png'), '/Planner/rivera/p1/gate.png');
});
// briefing.test.ts
test("without a folder, the household's briefing is inline even with a session", async () => { /* e.body string, no doc */ });
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (`writeDoc` writes under `PLANNER_ROOT`).

- [ ] **Step 3: Implement** as specified, then add `chooseFolderIn` to the fixtures named above.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS. `grep -n PLANNER_ROOT api/src/docs.ts api/src/pages.ts api/src/drift.ts api/src/search.ts` prints nothing.

- [ ] **Step 5: Commit**: `"Nothing goes to Drive, and no file onto a card, until the owner has chosen where documents live"`

---

### Task 15: Carried over at boot, and every household's folder known

**Files:**
- Modify: `api/src/folders.ts` (`namesAFile`, `carriedFolder`, `carryOver`)
- Modify: `api/src/server.ts` (boot, before listening: fold folders, carry over, print; `GET /api/admin/households` gains `folder`; `GET /api/settings` and `GET /api/today` run the Team Folder check when the session has a sid)
- Test: `api/test/server-carry.test.ts` (new)

**Interfaces:**
- Produces, in `folders.ts`:
  ```ts
  /** The log names a file the app wrote: a doc on thread.briefing or thread.answer, a plan.doc, or a plan.attach. */
  export function namesAFile(events: readonly Event[]): boolean;
  /** PLANNER_ROOT's first segment is the team; the rest of it, then the household's id, is the folder. */
  export function carriedFolder(root: string, household: string): DocumentsFolder;   // '/Planner' + 'h1' → Planner, h1; '/Planner/home' → Planner, home/h1
  /** Each household with no documents.folder whose log names a file gets one, by system, from the deployment. Answers who got what. */
  export async function carryOver(households: Households, root: string | null): Promise<{ id: string; folder: DocumentsFolder }[]>;
  ```
  Boot order: `loadConnectors` → adoption → for every household: open it, `rememberFolder(id, state.documents.folder)` → `carryOver` → booking → listen. One line per household: `[budget]   <id>: folder <team>/<folder> (from the deployment|chosen) | none chosen; zone <zone> (<source>); <N> files left to move` (the last only when N > 0). Then `[budget] admin: …` (Task 3) and `[budget] Claude: key saved on Connectors | from the deployment | off`, never the key. `GET /api/admin/households` rows gain `folder: '<team>/<folder>' | null`.

  A `PLANNER_ROOT` that is a plain shared folder is carried over the same way and counts as chosen. Nothing about Team Folders is asked at boot. The first request with a sid runs `documentsStatus`, which remembers the verdict for `teamFolderKnown`: briefings and answers stay inline, and card files keep working through File Station, as they did.

- [ ] **Step 1: Write the failing tests** (`PLANNER_ROOT=/Shared`, the fake's Team Folders `['Planner']` only, so the root is a plain shared folder; the logs are written into `HOUSEHOLDS_DIR` before `start()`)

```ts
const seed = async (id: string, lines: object[]) => { /* mkdir households/<id>; write events.jsonl: claim by alice, then lines */ };
await seed('h-doc', [{ op: 'thread.briefing', day: '2026-10-30', source: 'household', budget: null, headline: 'Quiet', writtenBy: 'fallback',
  doc: { link: 'l', file_id: '1', hash: 'h', version_id: '1', path: '/team-folders/Shared/h-doc/today/2026-10-30-household.md' } }]);
await seed('h-files', [/* plan.create gate, plan.attach /Shared/h-files/gate/quote.pdf */]);
await seed('h-none', []);
await seed('h-chosen', [{ op: 'documents.folder', team: 'Planner', folder: 'chosen', source: 'owner' }]);

describe('carried over at boot', () => {
  test('a log that names a file gets the deployment folder, by system; one that names none chooses from scratch', async () => {
    const doc = (await households.open('h-doc')).state.documents.folder!;
    assert.deepEqual([doc.team, doc.folder, doc.source, doc.by], ['Shared', 'h-doc', 'deployment', 'system']);
    assert.equal((await households.open('h-none')).state.documents.folder, null);
    assert.equal((await households.open('h-chosen')).state.documents.folder!.team, 'Planner');
  });
  test('running every boot is running once', async () => {
    await server.close(); server = await start({ households });
    const lines = (await (await households.open('h-doc')).since(null)).filter((e) => e.op === 'documents.folder');
    assert.equal(lines.length, 1);
  });
  test('a plain shared folder: files on cards keep working, documents stay inline, and Settings says why', async () => {
    await call(alice, 'POST', '/api/households/select', { household: 'h-files' });
    const r = await call(alice, 'GET', '/api/plans/gate/files/quote.pdf');      // the bytes put on disk by the test
    assert.equal(r.status, 200);
    const s = await call(alice, 'GET', '/api/settings');
    assert.match(s.json.documents.why, /Shared is not a Team Folder/);
    // GET /api/thread writes today's briefing with body, not doc
  });
  test('the boot log names each folder and where the Claude key comes from, never a key', () => {
    assert.ok(logged.some((l) => /h-doc: folder Shared\/h-doc \(from the deployment\)/.test(l)));
    assert.ok(logged.some((l) => /h-none: none chosen/.test(l)));
    assert.ok(logged.some((l) => /Claude: off/.test(l)));
  });
  test("an admin sees each household's folder, and nothing in it", async () => { /* carol admin; folder 'Shared/h-doc' | null */ });
});
```

- [ ] **Step 2: Run to verify they fail.** Run `cd api && node --test --experimental-strip-types test/server-carry.test.ts`. Expected: FAIL (no folder carried; files refused).

- [ ] **Step 3: Implement** as specified.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"A household that already has files keeps them working: its folder is carried over from the deployment, once"`

---
## Phase 6: A new folder moves the documents

### Task 16: Drive documents move, and every pointer follows them

**Files:**
- Create: `api/src/moves.ts`
- Modify: `api/src/pages.ts:390-404` (`schedulePages` runs `movePass` first, in the same lane), `:267-270` (`toWrite` skips a plan whose page is waiting)
- Modify: `api/src/docs.ts` (`currentDoc`), and its readers: `api/src/server.ts` (`GET /api/docs/:event`), `api/src/conversation.ts:64-80` (`readDayDocs`), `api/src/thread.ts:177,187`, `api/src/plans.ts:164`, `api/src/search.ts:114`
- Modify: `api/src/briefing.ts:830` (`moveFirst` before a briefing's write)
- Test: `api/test/moves.test.ts` (new; imports `./planner-root.ts` first)

**Interfaces:**
- Consumes: `moveFile`, `getFile`, `byLink`, `isNoSuchFile`, `isNameTaken` (Task 10); `createFolder` from `synology.ts`; `drivePathOf`, `nasPathOf`; `toDocRef`, `inHousehold` (Task 14); `PAGE_RETRY_MS` from `pages.ts`; `MoveFile`, `moveKey`, `movesLeft` (Task 5).
- Produces, in `moves.ts` (the waits are the builder's: 3 s per file, looked at every 250 ms; 25 files a pass, as pages):
  ```ts
  export const MOVE_BATCH = 25;
  export const MOVE_WAIT_MS = 3000;
  export const MOVE_POLL_MS = 250;
  /** Where a file goes: `<new>/today`, `<new>/answers` or `<new>/<plan-id>`, worked out from its kind, never its stale path. */
  export function destinationOf(state: State, file: MoveFile): { readonly drive: string; readonly nas: string; readonly name: string };
  export interface MoveFailure { readonly name: string; readonly words: string; readonly at: number }
  /** Files that failed, by store path, in memory: the name and the NAS's words, retried after PAGE_RETRY_MS. */
  export function moveFailures(storePath: string): readonly MoveFailure[];
  /** One pass: up to MOVE_BATCH waiting Drive documents (card files arrive in Task 17), each recorded by documents.moved as ctx.who. A lost session stops it. */
  export async function movePass(ctx: ToolContext, f?: DsmFetch): Promise<Event[]>;
  /** A write about to land on a file still waiting (a briefing written again the same day) moves that file first. */
  export async function moveFirst(ctx: ToolContext, rel: readonly [folder: string, file: string], f?: DsmFetch): Promise<void>;
  // docs.ts
  /** A document as it is now: followed through every move the log has recorded. */
  export const currentDoc = (state: State, doc: DocRef): DocRef;   // state.documents.relinked.get(doc.link) ?? doc
  ```
  One Drive document, in this order:
  1. Its parent is made through File Station (`createFolder(sid, nasPathOf(new), parent)`), as `writeDoc` does.
  2. `getFile(<destination drive path>/<name>)`. Found: it was moved and its event lost (a restart mid-move); record `{ link, doc: toDocRef(found) }`.
  3. `getFile(byLink(link))`. No such file: record `gone: true`. Found outside the folder being left (a copy-restored household's link): record `{ link }`, left alone and done.
  4. `moveFile(sid, byLink(link), <destination drive path>)`, then `getFile(<expected path>)` every `MOVE_POLL_MS` for `MOVE_WAIT_MS`. Found: record `{ link, doc: toDocRef(found) }`. Not yet: left for the next pass, which is not a failure.
  5. A refusal is a `MoveFailure` (`isNameTaken`: `a file called <name> is already in <team>/<folder>/<parent>: move or rename it there`, which fails until a person acts); the file waits `PAGE_RETRY_MS`; the pass goes on. `SessionLost` stops the pass.

  `schedulePages` becomes `movePass`, then `followOn`, in the one `${path}|pages` lane. `toWrite` skips a plan whose page's key is in `waiting`. The five readers of an event's `doc` read `currentDoc(state, e.doc)`.

- [ ] **Step 1: Write the failing tests** (`fakeNas()`; a household `h1` whose folder was `Planner/h1`, with a briefing, an answer and gate's page written there through `writeDoc`/`followOn`; then `documents.folder` `Planner/home/h1`)

```ts
describe('moving the documents', () => {
  test('each file goes to the parent its kind says, and is recorded with the DocRef Drive gives back', async () => {
    const out = await movePass(ctx, nas.via);
    assert.equal(out.filter((e) => e.op === 'documents.moved').length, 3);
    for (const rel of ['today/2026-11-02-household.md', `answers/${askId}.md`, 'gate/plan.md']) {
      assert.ok(existsSync(join(nas.nas.root, 'Planner/home/h1', rel)), rel);
    }
    assert.equal(movesLeft(s.state), 0);
  });
  test('a move Drive finishes late is seen on the next pass, not counted a failure', async () => {
    nas.nas.moves.delayMs = MOVE_WAIT_MS + 500;
    assert.equal((await movePass(ctx, nas.via)).length, 0);
    assert.deepEqual(moveFailures(s.path), []);
    nas.nas.moves.delayMs = 0;
    await sleep(600);
    assert.equal((await movePass(ctx, nas.via)).length, 3);
  });
  test('one file that fails waits, and the rest go on', async () => {
    nas.nas.moves.refuse.add('plan.md');
    await movePass(ctx, nas.via);
    assert.equal(movesLeft(s.state), 1);
    assert.equal(moveFailures(s.path)[0]!.name, 'plan.md');
    assert.equal((await movePass(ctx, nas.via)).length, 0, 'not asked again before PAGE_RETRY_MS');
  });
  test('a file that is gone is recorded gone, so the move can finish', async () => { /* rm the answer on disk → gone: true */ });
  test('a changed link is replaced in every pointer: the thread, the card, the docs route', async () => {
    nas.nas.moves.changeLink = true;
    await movePass(ctx, nas.via);
    const b = (await s.since(null)).find((e) => e.op === 'thread.briefing')!;
    const now = currentDoc(s.state, b.doc!);
    assert.notEqual(now.link, b.doc!.link);
    assert.equal(await readDoc({ ...ctx }, now, nas.via), await readFile(join(nas.nas.root, 'Planner/home/h1/today/2026-11-02-household.md'), 'utf8'));
    assert.equal(s.state.plans.get('gate')!.page!.doc.path, '/team-folders/Planner/home/h1/gate/plan.md');
  });
  test('a file the NAS moved whose record was lost is found at its new path and recorded', async () => { /* move by hand on disk, then movePass */ });
  test('a link Drive keeps outside the old folder is left alone, and done', async () => { /* doc whose link names Planner/other/x.md */ });
  test("a briefing written again mid-move moves first, then writes, and the page waits", async () => {
    await moveFirst(ctx, ['today', '2026-11-02-household.md'], nas.via);
    assert.ok(!s.state.documents.waiting.has(`link:${briefingLink}`));
    assert.deepEqual(await followOn(ctx, nas.via), [], "gate's page has not moved, so it is not written");
  });
});
```

- [ ] **Step 2: Run to verify they fail.** Run `cd api && node --test --experimental-strip-types test/moves.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** as specified. Log lines `[moves] <name>: <words>`, never the sid.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"A new folder moves the household's documents one by one, confirmed where they land, and every link follows"`

---

### Task 17: Card files move too, a restart resumes, and a second change waits

**Files:**
- Modify: `api/src/moves.ts` (card files in `movePass`)
- Modify: `api/src/attachments.ts` (`readAttachment` reads where the file is now)
- Modify: `api/src/server.ts` (`POST /api/settings/documents` mid-move; `setup.documents` gains `moving`; boot prints files left)
- Test: `api/test/moves.test.ts`, `api/test/server-setup.test.ts`

**Interfaces:**
- Consumes: `moveOnNas`, `createFolder` (Task 10); `attachmentPath` (Task 14).
- Produces:
  ```ts
  // attachments.ts
  /** Where a card's file is now: the folder being left while it waits to move, else the chosen folder. */
  export function attachmentFolder(state: State, plan: PlanId, name: string): string;   // a File Station folder path
  ```
  A card's file: `createFolder(sid, nasPathOf(new), plan)`, then `moveOnNas(sid, <old>/<plan>/<name>, <new>/<plan>)`. Finished: record `{ plan, name, path: <new>/<plan>/<name> }`. Not finished in `NAS_MOVE_WAIT_MS`: the next pass (step 2 of Task 16 finds it at its new path first, by File Station's list). 408: `gone: true`. 414: a `MoveFailure`, as a taken Drive name. Files taken off a card, and anything the app did not write, stay behind; nothing is deleted.

  `setup.documents` gains `moving: { left: number; to: string; failed: { name: string; words: string; retryAt: string }[]; behind: number } | null` (`behind`: files in the old folder that stay, counted from the log's detached attachments). `POST /api/settings/documents` while files wait answers 409 `Wait until the <N> documents have moved.` without asking the NAS.

- [ ] **Step 1: Write the failing tests**

```ts
// moves.test.ts
test("a card's file moves through File Station, and the card reads it from wherever it is", async () => {
  assert.equal((await readAttachment(fileCtx, 'gate', 'quote.pdf', nas.via)).bytes.length, 5, 'read from the old folder while it waits');
  await movePass(ctx, nas.via);
  const e = (await s.since(null)).findLast((x) => x.op === 'documents.moved')!;
  assert.deepEqual(e.file, { plan: 'gate', name: 'quote.pdf', path: '/Planner/home/h1/gate/quote.pdf' });
  assert.equal((await readAttachment(fileCtx, 'gate', 'quote.pdf', nas.via)).bytes.length, 5);
});
test('a file taken off its card stays behind', async () => { /* detached old.pdf is still under Planner/h1/gate */ });
test('two members looking at once move each file once', async () => {   // Review Focus 4
  await Promise.all([movePass(ctxAlice, nas.via), movePass(ctxBob, nas.via)].map((p) => p.catch(() => [])));
  const moved = (await s.since(null)).filter((e) => e.op === 'documents.moved');
  assert.equal(new Set(moved.map((e) => JSON.stringify(e.file))).size, moved.length);
  assert.equal(movesLeft(s.state), 0);
});
```

```ts
// server-setup.test.ts
describe('changing the folder', () => {
  test('moves after the answer, shows progress, and refuses another change until done', async () => {
    nas.moves.delayMs = MOVE_WAIT_MS + 500;            // the first pass finds nothing finished
    const r = await call(alice, 'POST', '/api/settings/documents', { team: 'Planner', folder: 'elsewhere' });
    assert.equal(r.status, 200);
    assert.ok(r.json.setup.documents.moving.left > 0);
    const again = await call(alice, 'POST', '/api/settings/documents', { team: 'Planner', folder: 'third' });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /^Wait until the \d+ documents have moved\.$/);
  });
  test('a restart mid-move resumes on the first request with a NAS session', async () => {
    await server.close(); server = await start({ households });          // boot prints "<N> files left to move"
    nas.moves.delayMs = 0;
    const bobAgain = await signIn('bob', 'battery-staple');
    await call(bobAgain, 'GET', '/api/thread');
    await pagesIdle(storePath);
    assert.equal((await call(alice, 'GET', '/api/settings')).json.setup.documents.moving, null);
  });
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement** as specified.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"Files on cards move with the documents, a restart picks the move up again, and the folder cannot change mid-move"`

---

## Phase 7: Booking from the log

### Task 18: Booking is switched on in Settings, for one household at a time

**Files:**
- Modify: `api/src/booking.ts:143-148` (`bookingStatus` takes the household from the logs), new `bookingHousehold`, `aheadOf`, `aheadWords`, `bookingAvailability`
- Modify: `api/src/server.ts:958-985` (booking at boot and `bookingNow` worked out again on each `guests.booking` or Connectors save), `settingsView.booking`, new `POST /api/settings/booking`, `GET /api/calendars` (a lost calendar)
- Modify: `api/src/auth.ts` (`GuestSessions.revokeAll(emails)`)
- Modify: `site/index.html` (the Booking row's switch in Setup, and the Guests section's off line)
- Test: `api/test/booking.test.ts`, `api/test/server-booking-switch.test.ts` (new)

**Interfaces:**
- Consumes: `state.settings.booking` (Task 4); `resolvedEnv`, `lastSavedBy`, `connectors().mailTest` (Task 1); `SYSTEM`.
- Produces, in `auth.ts`: `GuestSessions.revokeAll(emails: Iterable<string>): void`, each as `revokeEmail` keys it.
- Produces, in `booking.ts`:
  ```ts
  /** The one household friends book with: the first whose latest guests.booking turned it on (earliest `at`); with none on, BOOK_HOUSEHOLD if its log has no guests.booking at all; else null. */
  export function bookingHousehold(logs: readonly { id: string; booking: State['settings']['booking'] }[], env: NodeJS.ProcessEnv): string | null;
  export function bookingStatus(env: NodeJS.ProcessEnv, household: string | null): BookingStatus;   // 'no household has booking on' when null
  /** What blocks a switch: requests still waiting, and confirmed stays not yet over. */
  export function aheadOf(state: State, today: Day): { requests: number; stays: number };
  export const aheadWords = (a: { requests: number; stays: number }): string;   // '2 requests waiting and 1 stay ahead'; '1 request waiting'; '3 stays ahead'
  /** Whether this household could turn booking on, and if not, why, naming who can fix it. */
  export function bookingAvailability(state: State, o: { env: NodeJS.ProcessEnv; adminUser: string | null }): { available: true } | { available: false; why: string };
  ```
  `bookingAvailability`'s words, in order: no Household calendar → `Booking is off until ${owner} chooses the Household calendar.`; no booking page address → `Booking is off until ${fixer} sets the booking page's address on Connectors.`; no usable mail, or a last mail test that failed → `Booking is off until ${fixer} sets up mail on Connectors.` `fixer` is `ADMIN_USER`, else `lastSavedBy()`, else `the NAS's administrator`.

  `POST /api/settings/booking { on: boolean }` (owner only, 403):
  - `on: true`: 409 with `bookingAvailability`'s words when unavailable. When another household books: its `aheadOf` not empty → 409 `<label> has ${aheadWords}: booking stays with them until then.`; else `system` appends `guests.booking { on: false }` in that household's log and its guests are signed out. Then `guests.booking { on: true }` here.
  - `on: false`, here the booking household, with anything ahead → 409 `Booking stays on: ${aheadWords}.`; else `guests.booking { on: false }` and this household's guests are signed out.
  - Either way the in-memory booking is worked out again, and the answer is `settingsView`.

  A lost calendar: `GET /api/calendars` by the Household calendar's maker, whose listing has no calendar `sameCalendar` with it, is the app finding it gone (decided here: only its maker's listing is sure to include it). If this household books, `system` appends `guests.booking { on: false, calendarGone: true }`, its guests are signed out and booking is worked out again. `settingsView.booking` gains `{ available, why, calendarGone, ahead }`.

- [ ] **Step 1: Write the failing tests**

```ts
// booking.test.ts
test('the booking household: the first to turn it on keeps it; BOOK_HOUSEHOLD only when no log says', () => {
  const on = (at: string) => ({ on: true, by: 'x', at, calendarGone: false });
  assert.equal(bookingHousehold([{ id: 'a', booking: on('2026-11-02') }, { id: 'b', booking: on('2026-11-01') }], {}), 'b');
  assert.equal(bookingHousehold([{ id: 'a', booking: null }], { BOOK_HOUSEHOLD: 'a' }), 'a');
  assert.equal(bookingHousehold([{ id: 'a', booking: { ...on('x'), on: false } }], { BOOK_HOUSEHOLD: 'a' }), null);
});
test('what is ahead is counted in words', () => {
  assert.equal(aheadWords({ requests: 2, stays: 1 }), '2 requests waiting and 1 stay ahead');
  assert.equal(aheadWords({ requests: 0, stays: 3 }), '3 stays ahead');
});
```

```ts
// api/test/server-booking-switch.test.ts (two households, alice's "home" with a Household calendar and bob's "cabin"; mail and page saved on Connectors)
describe('booking, switched in Settings', () => {
  test('unavailable without a calendar, saying who can fix it', async () => {
    const r = await call(bob, 'POST', '/api/settings/booking', { on: true });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'Booking is off until bob chooses the Household calendar.');
  });
  test('on for one household; refused off while a request waits, and refused to another owner, with counts', async () => {
    assert.equal((await call(alice, 'POST', '/api/settings/booking', { on: true })).status, 200);
    // a guest asks to stay through /book/request
    const off = await call(alice, 'POST', '/api/settings/booking', { on: false });
    assert.equal(off.json.error, 'Booking stays on: 1 request waiting.');
    const theirs = await call(bob, 'POST', '/api/settings/booking', { on: true });  // after bob made a calendar
    assert.equal(theirs.json.error, 'Home has 1 request waiting: booking stays with them until then.');
  });
  test("with nothing ahead, another owner's switch moves it: system turns it off in the old log and its guests are signed out", async () => {
    // the request declined; bob turns it on
    const last = (await (await households.open('home')).since(null)).at(-1)!;
    assert.deepEqual([last.op, last.who, (last as any).on], ['guests.booking', 'system', false]);
    assert.equal((await fetch(base + '/book/me', { headers: { cookie: guestCookie } })).status, 401);
  });
  test('a member cannot switch it', async () => { /* bob in alice's household → 403 */ });
  test("the calendar found gone turns booking off, and says so", async () => {
    // cabin's maker deletes the Household calendar on the fake; GET /api/calendars as its maker
    const s = await call(bob, 'GET', '/api/settings');
    assert.equal(s.json.booking.calendarGone, true);
    assert.equal(s.json.booking.on, false);
  });
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement** as specified, and in `site/index.html` the Booking row of Setup becomes a switch (`role="switch"`, `aria-checked`) posting `{ on }`, disabled with `booking.why` beside it when unavailable; a 409 goes to the error box with its words. The existing `booking.test.ts` cases for `bookingStatus(env, ids)` are rewritten for `(env, household)`.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS (`server-book*.test.ts` keep `BOOK_HOUSEHOLD` and work unchanged).

- [ ] **Step 5: Commit**: `"Booking is the owner's switch, held while guests are waiting or staying, and moved, never shared, between households"`

---

## Phase 8: Connectors

### Task 19: The Connectors routes, and what each row says

**Files:**
- Create: `api/src/connectors-view.ts`
- Modify: `api/src/server.ts` (eleven routes, admin only; header comment)
- Test: `api/test/server-connectors.test.ts`

**Interfaces:**
- Consumes: Task 1, `claudeHealth`, `testClaude` (Task 8), `listAccounts` (Task 3), `teamFolders` (Task 10), `folderOf` (Task 11), `bookingStatus` (Task 18), the injected `send`.
- Produces, in `connectors-view.ts`:
  ```ts
  export type RowId = 'claude' | 'drive' | 'calendar' | 'mail' | 'booking' | 'sign-in' | 'pricing';
  export const ROW_ORDER: readonly RowId[] = ['claude', 'drive', 'calendar', 'mail', 'booking', 'sign-in', 'pricing'];
  export interface ConnectorRow {
    readonly id: RowId; readonly state: 'on' | 'off' | 'broken'; readonly source: Source;
    /** One line, in every state. */
    readonly line: string;
    /** What the row's form starts from; secrets as 'set' | 'not set', never their values. */
    readonly form: Readonly<Record<string, unknown>>;
  }
  export function connectorsView(o: {
    env: NodeJS.ProcessEnv; households: readonly { id: string; label: string; owner: string | null }[];
    driveReachable: boolean | null; booking: BookingStatus; bookingLabel: string | null; adminRule: 'group' | 'ADMIN_USER';
  }): { rows: ConnectorRow[]; adminRule: 'group' | 'ADMIN_USER' };
  /** The rows an admin's Today names: broken, or off and not left off on purpose. */
  export const needsAdmin = (rows: readonly ConnectorRow[]): RowId[];
  ```
  The lines (the builder's words, one per state):
  - Claude: `Key set, last worked <date>` / `Key set, not tested yet` / broken `The key has expired or been revoked` (a failed `claudeTest` or a live 401) / `Off on purpose` / `No key: Claude is off on this NAS`.
  - Synology Drive: `Reachable; <N> of <M> households have chosen a folder` / broken `Drive did not answer your session` / `Sign in again to look at Drive`. Form: the households by label and owner, each `folder` or `not chosen`.
  - Calendar on phones: `<origin>` / `Off on purpose` / `Not set: phones are told to ask the owner` / broken `The saved address no longer parses`.
  - Mail: `<host>:<port>, last test <ok|failed> on <date>` / `<host>:<port>, not tested yet` / broken `The last test failed: <words>` / `Off on purpose` / `Not set: no mail goes out`. Form: host, port, user, `pass: 'set' | 'not set'`, from, plainAuth, `lastTo`.
  - Booking: `On for <label> at <address>/book` / `Off: <bookingOffWords>`. Form: the address.
  - Who may sign in: `Any DSM account` / `<N> accounts`. Form: the names.
  - Pricing sources: `Census and EIA keys set` / `Census key set` / `EIA key set` / `No keys: pricing from public data is off`. Form: `census`, `eia` as `set` | `not set`.

  Routes, each admin only (403 `not an administrator`), each POST answering `connectorsView`; every save takes exactly one of `{ value }`, `{ off: true }`, `{ clear: true }`, else 400 `send one of value, off or clear`:
  ```
  GET  /api/connectors              the view
  GET  /api/connectors/accounts     { accounts: { name; member: boolean }[] } with the admin's sid; 409 'sign in again to list accounts; type the names instead' without
  POST /api/connectors/public-url   value: an origin (400 'an address such as https://nas.example.com:5001, with nothing after the port')
  POST /api/connectors/sign-in      value: names, trimmed and lowercased; 400 'who may sign in cannot be off; clear it to let any DSM account sign in';
                                    400 'keep <who> in the list, or you would lock yourself out'
  POST /api/connectors/book-url     value: an origin, https (http with COOKIE_INSECURE=1), as bookUrl checks it
  POST /api/connectors/mail         value: { host, port, user, pass?, from, plainAuth }; no pass keeps the saved one; none saved → 400 'the password is needed the first time'
  POST /api/connectors/mail/test    { to }: sent with `send`; recorded in mailTest; 400 for an address that is not one
  POST /api/connectors/census       value: the key, trimmed
  POST /api/connectors/eia          value: the key, trimmed
  POST /api/connectors/claude       value: the key, trimmed
  POST /api/connectors/claude/test  testClaude(); recorded in claudeTest, `worked` its `at` when ok
  ```
  Every save goes through `saveConnector(…, who)` and then works booking out again (Task 18).

- [ ] **Step 1: Write the failing tests** (`server-connectors.test.ts`: carol is an admin by group; the server's `send` records; `fakeAnthropic()` at `ANTHROPIC_BASE_URL`)

```ts
describe('Connectors', () => {
  test('seven rows, in order, each with its state, its source and one line', async () => {
    const r = await call(carol, 'GET', '/api/connectors');
    assert.deepEqual(r.json.rows.map((x: any) => x.id), ['claude', 'drive', 'calendar', 'mail', 'booking', 'sign-in', 'pricing']);
    assert.ok(r.json.rows.every((x: any) => ['on', 'off', 'broken'].includes(x.state) && typeof x.line === 'string' && x.line));
  });
  test('no secret comes back, not on a GET, not in a POST answer, not in a household log', async () => {
    await call(carol, 'POST', '/api/connectors/mail', { value: { host: 'mail.example.com', port: 587, user: 'robot', pass: 'S3cret-pass', from: 'h@example.com', plainAuth: false } });
    await call(carol, 'POST', '/api/connectors/claude', { value: '  sk-ant-pasted\n' });   // Review Focus 5
    await call(carol, 'POST', '/api/connectors/census', { value: 'census-k3y' });
    const text = JSON.stringify((await call(carol, 'GET', '/api/connectors')).json);
    for (const secret of ['S3cret-pass', 'sk-ant-pasted', 'census-k3y']) assert.ok(!text.includes(secret), secret);
    assert.equal(connectors().claude && 'value' in connectors().claude! ? connectors().claude!.value : null, 'sk-ant-pasted');
    for (const id of await households.ids()) assert.doesNotMatch(await readFile(households.path(id), 'utf8'), /S3cret|sk-ant/);
  });
  test('a mail save without the password keeps the saved one', async () => { /* save with no pass; resolvedEnv().SMTP_PASS === 'S3cret-pass' */ });
  test('the first mail save needs a password', async () => { /* after clear, no pass → 400 */ });
  test('Send me a test mails the typed address, and a failure makes the row broken', async () => {
    const ok = await call(carol, 'POST', '/api/connectors/mail/test', { to: 'carol@example.com' });
    assert.equal(sent.at(-1)!.to, 'carol@example.com');
    assert.equal(ok.json.rows.find((x: any) => x.id === 'mail').state, 'on');
    failSend = true;
    const bad = await call(carol, 'POST', '/api/connectors/mail/test', { to: 'carol@example.com' });
    assert.equal(bad.json.rows.find((x: any) => x.id === 'mail').state, 'broken');
  });
  test('Claude: Test sends one minimal request, a 401 makes the row broken in words', async () => {
    fake.answer = 401;
    const r = await call(carol, 'POST', '/api/connectors/claude/test', {});
    const row = r.json.rows.find((x: any) => x.id === 'claude');
    assert.deepEqual([row.state, row.line], ['broken', 'The key has expired or been revoked']);
  });
  test('who may sign in: never off, never without the admin saving it, names made plain', async () => {   // Review Focus 2
    assert.equal((await call(carol, 'POST', '/api/connectors/sign-in', { off: true })).status, 400);
    assert.match((await call(carol, 'POST', '/api/connectors/sign-in', { value: ['alice'] })).json.error, /keep carol in the list/);
    const r = await call(carol, 'POST', '/api/connectors/sign-in', { value: [' Alice ', 'CAROL'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.rows.find((x: any) => x.id === 'sign-in').form.names, ['alice', 'carol']);
    await signIn('alice', 'correct-horse');
    assert.equal((await call(carol, 'POST', '/api/connectors/sign-in', { clear: true })).status, 200);
  });
  test('the accounts the admin can list, members marked', async () => { /* alice member: true; carol member: false */ });
  test('saved off beats the deployment, and says off', async () => { /* public-url off with DSM_PUBLIC_URL set → state 'off', source 'off' */ });
  test('a member who is not an admin is refused every route', async () => { /* alice → 403 on GET and each POST */ });
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (404s).

- [ ] **Step 3: Implement** as specified.

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS.

- [ ] **Step 5: Commit**: `"Connectors: an administrator sets what the NAS connects to, each row on, off or broken, and no secret comes back"`

---

### Task 20: The Connectors page

**Files:**
- Modify: `site/index.html` (`#me-menu` ~1213: a *Connectors* item, shown only when `state.admin`; the households screen ~1160: a *Connectors* button beside *All households on this server*; a new `<div id="connectors" hidden>` in `main`; `showView('connectors')`; `renderConnectors`)

**Interfaces:** consumes the Task 19 routes.

- [ ] **Step 1: The way in.** The menu item and the households-screen button appear only for an admin session (`/api/auth/check`'s `admin`). An admin in no household opens the page from the households screen; it needs no household (the routes ask none).

- [ ] **Step 2: The rows.** One row per `rows[]` entry, in order: the name, the state as a chip (*On*, *Off*, *Broken*, with the existing tokens for good, quiet and error), the source in the four words, and the line. Clicking a row opens its form below it, as Settings' `rowForm` does, with *Save*, *Turn off* (not on Who may sign in) and *Use the deployment's* (`clear`). Mail and Claude carry their test button; the mail test's address is prefilled with `form.lastTo`. Secret fields are password inputs, empty, with *set* or *not set* beside them. Who may sign in lists `GET /api/connectors/accounts` as checkboxes, members marked; on a 409 it shows a text field for names instead. A refusal goes to the one error box with the server's words.

- [ ] **Step 3: Opened at a row.** `openConnectors(row?)` scrolls to and opens that row; Task 22's card uses it.

- [ ] **Step 4: Verify by hand.** With `FAKE_DSM_ACCOUNTS` in the developer's own `.env` naming an admin (`name:password::admin`; implementers do not edit `.env`, the developer does), sign in as the admin: *Connectors* is in the person menu; each row opens its form; saving Mail without a password keeps it; *Send me a test* reports; a non-admin sees no menu item. At 375 px nothing scrolls sideways. `cd api && npm test`: PASS.

- [ ] **Step 5: Commit**: `"The Connectors page, under the person icon, for administrators"`

---

### Task 21: The Contacts version is asked of the NAS

**Files:**
- Modify: `api/src/synology.ts:580-690` (`contactsVersion`/`CONTACTS_VERSION` removed; every Contacts call asks `contactsVersionNow`)
- Modify: `api/src/connectors.ts` (`recordProbe`, `forgetProbe`)
- Modify: `api/src/server.ts` (boot says `SYNO_CONTACTS_VERSION` is no longer read, when set)
- Modify: `api/tools/fake-dsm/server.ts` (`APIS` already lists `SYNO.Contacts.Contact` [1, 1]: answered without a session), `api/tools/synology-check/check.ts:40,74,380-387` (imports the new function; prints the range)
- Test: `api/test/synology.test.ts` (the version tests at :260-286 replaced)

**Interfaces:**
- Produces, in `synology.ts`:
  ```ts
  /** The version Contacts is called with: the one kept under probed, else asked of SYNO.API.Info (no session) and kept; 1 if the range holds it, else the lowest offered. */
  export async function contactsVersionNow(f?: DsmFetch): Promise<number>;
  /** DSM's answer for a version it does not support (104): forget the probe, ask again once, then call again once. */
  ```
- Produces, in `connectors.ts`: `recordProbe(p: { version: number; min: number; max: number; at: string }): Promise<void>` and `forgetProbe(): Promise<void>`, writing `probed.contactsVersion`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('the Contacts version', () => {
  test('asked once, without a session, and kept: 1 when the range holds it', async () => {
    resetConnectors();
    const d = fakeDsmSeq([{ success: true, data: { 'SYNO.Contacts.Contact': { minVersion: 1, maxVersion: 2 } } },
      { success: true, data: { addressbooks: [] } }, { success: true, data: { addressbooks: [] } }]);
    await listAddressbooks('S', d.fn); await listAddressbooks('S', d.fn);
    assert.match(d.calls[0]!.body, /api=SYNO\.API\.Info/);
    assert.doesNotMatch(d.calls[0]!.body, /_sid/);
    assert.equal(d.calls.length, 3, 'asked once, then kept');
    assert.match(d.calls[1]!.body, /version=1(&|$)/);
    assert.equal(connectors().probed!.contactsVersion.version, 1);
  });
  test('else the lowest offered', async () => { /* min 2, max 3 → version=2 */ });
  test('a version DSM refuses is asked about again, once', async () => { /* 104, then Info, then success with the new version */ });
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL.

- [ ] **Step 3: Implement** as specified; `fakeDsmSeq` is a two-line helper in `fake-dsm-fetch.ts` answering its replies in order. The other Contacts tests set the probe first (`await recordProbe({ version: 1, min: 1, max: 1, at: '' })`).

- [ ] **Step 4: Run to verify they pass.** Run `cd api && npm test && npx tsc --noEmit -p .`. Expected: PASS. `grep -rn SYNO_CONTACTS_VERSION api/src` prints only the boot line that says it is no longer read.

- [ ] **Step 5: Commit**: `"The Contacts version is asked of the NAS on first use and kept, not set by hand"`

---

## Phase 9: Setup on Today

### Task 22: Setup notices on Today

**Files:**
- Modify: `api/src/setup.ts` (`setupNotices`)
- Modify: `api/src/server.ts:2029-2035` (`GET /api/today` gains `setup`)
- Modify: `site/index.html` (`loadThread` ~2099 keeps `rails.setup`; a notice strip at the top of `#thread`'s column, above the thread, not among the entries; each notice's button opens Settings at a step, or Connectors at a row)
- Test: `api/test/setup.test.ts` (new), `api/test/server-setup.test.ts`

**Interfaces:**
- Consumes: `setupSteps` (Task 12), `movesLeft`, `moveFailures` (Tasks 5, 16), `teamFolderKnown` (Task 14), `needsAdmin`, `connectorsView` (Task 19), `state.settings.booking` (Task 4).
- Produces:
  ```ts
  export type NoticeKind = 'folder' | 'not-team-folder' | 'connectors' | 'moving' | 'booking-off';
  export interface SetupNotice {
    readonly kind: NoticeKind; readonly text: string;
    readonly action?: { readonly label: string; readonly open: 'settings'; readonly step: SetupStep } | { readonly label: string; readonly open: 'connectors'; readonly row: RowId };
  }
  /** Per load, never logged: the household's notices first, then the NAS's; none for the sandbox. */
  export function setupNotices(o: {
    state: State; who: Actor; admin: boolean; sandbox: boolean; env: NodeJS.ProcessEnv;
    teamFolder: boolean | null; failures: readonly MoveFailure[]; adminRows: readonly RowId[]; rowName: (id: RowId) => string;
  }): SetupNotice[];
  ```
  The words, copied from the spec where it pins them:
  - No folder, the owner: `Your documents are not in Drive yet`, action `Choose a folder` → Settings at `first`. A member: `Documents are not in Drive yet. Ask <owner> to choose a folder.`
  - A carried-over folder that is not a Team Folder (`teamFolder === false`), the owner: `Your documents are not in Drive yet: <team>/<folder> is not a Team Folder. Enable it in Synology Drive Admin Console, Team Folder, or choose another folder.`, action `Choose another folder`. A member: the member line above.
  - An admin, rows needing them: `Set up the NAS: <names of the rows, joined with commas and "and">.`, action `Open Connectors` → the first. Nobody else.
  - Moving, every member: `Moving <N> documents to <team>/<folder>`; after a failure, also `<N> could not be moved yet: <name>. Trying again at <time>.`, the time in the household's zone, `HH:MM`.
  - Booking off for a lost calendar, the owner, until a calendar is chosen: `Booking is off: the household calendar is gone. Choose one, then turn booking on again`, with `, and <aheadWords> still stand.` when anything is ahead; action `Choose a calendar` → Settings at `calendar`.

- [ ] **Step 1: Write the failing tests**

```ts
// api/test/setup.test.ts (pure: states built by replay)
test('no folder: the owner is asked to choose, the member to ask the owner', () => {
  const [o] = setupNotices({ ...base, who: 'alice' });
  assert.deepEqual(o, { kind: 'folder', text: 'Your documents are not in Drive yet',
    action: { label: 'Choose a folder', open: 'settings', step: 'folder' } });
  assert.equal(setupNotices({ ...base, who: 'bob' })[0]!.text, 'Documents are not in Drive yet. Ask alice to choose a folder.');
});
test('a carried-over plain share is worded for what it is', () => { /* teamFolder false → /is not a Team Folder\. Enable it/ */ });
test("an admin's card names the rows that need them; the owner's comes first; the sandbox sees none", () => {
  const n = setupNotices({ ...base, who: 'alice', admin: true, adminRows: ['mail', 'claude'], rowName });
  assert.deepEqual(n.map((x) => x.kind), ['folder', 'connectors']);
  assert.equal(n[1]!.text, 'Set up the NAS: Mail and Claude.');
  assert.deepEqual(setupNotices({ ...base, sandbox: true, admin: true, adminRows: ['mail'], rowName }), []);
});
test('a row left off on purpose is not on the card', () => { /* needsAdmin on rows with source 'off' → [] */ });
test('the move is said to everyone, and a failure with its name and when', () => { /* … 'Trying again at 14:20.' */ });
test('booking off for a lost calendar, to the owner, until a calendar is chosen', () => { /* then calendar.household → gone */ });
```

```ts
// server-setup.test.ts
test("Today's setup is computed per load and written nowhere", async () => {
  const before = (await store.since(null)).length;
  const t = await call(alice, 'GET', '/api/today');
  assert.ok(Array.isArray(t.json.setup));
  assert.equal((await store.since(null)).length, before);
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (module export missing).

- [ ] **Step 3: Implement** as specified, then the strip on Today: one quiet card per notice (not a thread card: no decide buttons), the action a button that calls `openSettings('setup', step)` or `openConnectors(row)`.

- [ ] **Step 4: Verify.** Run `cd api && npm test && npx tsc --noEmit -p .`; PASS. By hand against the fake: a new household's owner sees *Your documents are not in Drive yet* and *Choose a folder* opens Settings at Setup with the folder marked; a member sees the ask-the-owner line; an admin with Mail unset sees *Set up the NAS*.

- [ ] **Step 5: Commit**: `"Today reminds the owner, the members and the administrator of what is not set up yet, and goes once it is"`

---

## Phase 10: The real NAS, and the deploy words

### Task 23: `synology:check` confirms what this design guessed

**Files:**
- Modify: `api/tools/synology-check/check.ts`, `api/tools/synology-check/README.md`

**Interfaces:** none; new env for the check: `CHECK_ADMIN_USER`/`CHECK_ADMIN_PASS` (an admin account, optional), `CHECK_DRIVE_WRITE=1` as before.

- [ ] **Step 1: Add a section per probe**, each through `probe` so the raw reply prints, each with a README line saying what it should show and which constant to change when it does not:
  1. `ADMIN_GROUP_CALL` as `CHECK_USER` and, when given, as the admin: the raw reply both ways (`accounts.ts`).
  2. `ACCOUNTS_CALL` as both: the shape, and the non-admin's refusal code (`accounts.ts`).
  3. `GET team-folder` and `GET team-folder/members?team_id=` as `CHECK_USER`: each `capabilities`, whether `PLANNER_ROOT`'s share is listed, the role names (`folders.ts`'s writable roles).
  4. `POST files/list` with `filter: { type: ['dir'] }` on the root's Team Folder; with `CHECK_DRIVE_WRITE=1`, `POST files` `type=folder` for `.planner-check/made`, twice, printing the second's refusal code (`DRIVE_NAME_TAKEN`).
  5. With `CHECK_DRIVE_WRITE=1`: move `.planner-check/check.md` by `link:` into `.planner-check/made`; print the task id, the milliseconds until `getFile(<new path>)` finds it, whether `permanent_link` changed; move it back; then into a second Team Folder when `CHECK_SECOND_TEAM` names one; and once more onto a name already taken, printing the conflict code (`MOVE_WAIT_MS`, `DRIVE_NAME_TAKEN`).
  6. With `CHECK_DRIVE_WRITE=1`: File Station `CopyMove` of a file under `.planner-check`, then `getFile` on the same file by its Drive path: that a Team Folder's name is its share's (`moveOnNas`).
  7. `SYNO.API.Info` `query` for `SYNO.Contacts.Contact` and `SYNO.Contacts.Addressbook` with no sid (`contactsVersionNow`).

- [ ] **Step 2: Run it against the fake**: with `npm run fake-dsm` running (on the developer's own port from their `.env`, never changed here), `CHECK_USER=alice CHECK_PASS=<pw> CHECK_ADMIN_USER=<admin> CHECK_ADMIN_PASS=<pw> DSM_URL=http://127.0.0.1:<that port> PLANNER_ROOT=/Planner CHECK_DRIVE_WRITE=1 npm run synology:check` from `api/`. Expected: each probe prints a raw reply; the move finds the file at its new path; the taken-name code is 1003; no line contains the sid.

- [ ] **Step 3: Commit**: `"The check asks the NAS how it names administrators, accounts, Team Folder rights, folders and moves"`

---

### Task 24: `DEPLOY.md` and `.env.example`

**Files:**
- Modify: `DEPLOY.md` (*Checking the NAS's API shapes* ~21, *Who owns the budget* ~77 and *The administrator* ~116, *Environment* ~145, *Calendar on the NAS* ~192, *Files on plans* ~263, *Documents in Synology Drive* ~314, *Booking* ~376, *The volume* ~433, and a new *Connectors* section after *Environment*)
- Modify: `.env.example`

- [ ] **Step 1: DEPLOY.md.** Cover these points, in the file's own voice:
  - The administrator is any account in DSM's administrators group; `ADMIN_USER` overrides it. An admin signs in again after a restart to use Connectors.
  - Connectors: the seven rows, `api/data/connectors.json` (0600, back it up with `sessions.json`, never commit it), `CONNECTORS_PATH`. An `.env` value is the default until saved, shown as *from the deployment*; a saved off beats it. **An allowlist that locks everyone out is undone by deleting `signIn` from `connectors.json` and restarting.**
  - The moved variables (`DSM_PUBLIC_URL`, `ALLOWED_USERS`, `BOOK_URL`, `SMTP_*`, `CENSUS_API_KEY`, `EIA_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_MATCH_MODEL`, `TZ`, `BOOK_HOUSEHOLD`) become defaults, in the Environment table. `DSM_PORT`, `TRUST_PROXY` and `FAKE_DSM_ACCOUNTS` stay.
  - *Documents in Synology Drive* becomes *choose a folder in Settings*: enable a Team Folder in Synology Drive Admin Console; the owner picks it and a folder in it; nothing goes to Drive, and no file onto a card, until then. `PLANNER_ROOT` is only carried over for a household that already has files (once, at the first boot of this version), and suggested first in the picker. A carried-over plain shared folder keeps files working and says so on Today until it is a Team Folder or another is chosen.
  - A change of folder moves the documents in the background; Today shows progress and names any file that could not move.
  - Booking is the owner's switch in Settings; one household at a time; it needs the Household calendar and working mail.
  - `SYNO_CONTACTS_VERSION` goes: the version is asked of the NAS. Its troubleshooting row at ~41 becomes *install Synology Contacts* only.
  - Checking the NAS: the new probes and `CHECK_ADMIN_USER`.
  - The Claude key: *Claude* on Connectors; a reset or revoked key is pasted there, no rebuild.
- [ ] **Step 2: `.env.example`.** Each moved variable keeps its line with *a default: set it on Connectors (or Settings for TZ, CLAUDE_MATCH_MODEL and BOOK_HOUSEHOLD) instead*; `SYNO_CONTACTS_VERSION` is removed; `ADMIN_USER` reads *optional: the administrators group decides, unless this names one account*; `PLANNER_ROOT` reads *only for an install from before folders were chosen in Settings*; `FAKE_DSM_ACCOUNTS` shows `name:password[:otp[:admin]]` with `alice:correct-horse::admin`.
- [ ] **Step 3: Verify.** `grep -n "SYNO_CONTACTS_VERSION" DEPLOY.md .env.example` prints only the line saying it is no longer read. `cd api && npm test && npx tsc --noEmit -p .`: PASS.
- [ ] **Step 4: Commit**: `"The deploy notes: Connectors, choosing a folder in Settings, the administrators group, and what is left in .env"`

---

## Self-review

**Spec coverage.**

| Spec section | Where |
|---|---|
| Intent; goals 1–5 | Tasks 4–5, 12–13 (Settings); 19–20 (Connectors); 14 (nothing before a choice); 16–17 (the move); 15 (an upgrade changes nothing a household sees) |
| Non-goals: no admin powers in a household; no secret to the browser; no Drive admin endpoint; what stays in `.env`; one booking page | Global Constraints; Tasks 15, 18, 19 |
| Anti-goals: no secret in a log; no two households in a folder; no stale `DocRef`; no reminder as a decision; no self-lockout | Tasks 1, 19; 11; 16; 22; 19 |
| Constraints: values read when used | Tasks 1, 2, 7, 8, 9, 21 (and `PLANNER_ROOT` in 14–15) |
| Constraints: owner-only in the fold | Tasks 4, 5 |
| What moves where | Tasks 1–2 (NAS rows), 4–9 (household rows), 21 (Contacts) |
| Who is the admin; the fake's flag | Task 3; probe 1 in Task 23 |
| The five events; `SYSTEM_MAY`; `state.documents` and the rest; relinking | Tasks 4, 5, 16 |
| Restore as a new household; in place unchanged | Task 6 |
| Zone callers pass `state.zone`; `ctx.today` | Task 7 |
| The picker: three steps, greyed, deployment first, new name suggested, checks, index probe, members advisory, refusal of another household's | Tasks 10–13 |
| `householdFolder`/`inHousehold` from state; during a move | Tasks 14, 16 |
| Nothing in Drive before the choice; files refused with the owner's name | Task 14 |
| Carry-over at boot; plain shared folder | Task 15 |
| The move: parents by kind, one `files/move` per file, `getFile` confirmation, failures, gone, restart, a write mid-move, a second change refused, Today's lines | Tasks 16, 17, 22 |
| Time zone, calendar owner-only, booking (switch, guests, moved, lost calendar), envelope model | Tasks 7, 12, 18, 9 |
| The NAS-wide file; three saved states; no secret in a GET; Contacts probed | Tasks 1, 19, 21 |
| Connectors: seven rows, broken, mail test, sign-in rules, Claude key and Test, a live 401 | Tasks 8, 19, 20 |
| Cards on Today before setup | Task 22 |
| Routes (new and changed) | Tasks 7, 9, 12, 17, 18, 19, 22; `/api/auth/check`, `/api/whoami` in 3; `/api/admin/households` in 15 |
| Boot | Tasks 2, 3, 15, 21 |
| The check tool's seven probes | Task 23 |
| Testing against the fake | Tasks 3, 10, and each task's tests |
| Left to the builder | membership and account calls (3, provisional until 23); the models (9); the move's waits and batch (16); the drift guard (7); layouts and words (13, 19, 20, 22); `DEPLOY.md` and `.env.example` (24) |

**Gaps, and decisions taken where the spec was silent.**
- The spec says readers of `doc.link` "read state, so they need no change". Briefings' and answers' `doc`s live on log events, not in state, so the five readers are changed to read `currentDoc(state, e.doc)` (Task 16), from the fold's `relinked` map.
- The spec's `SYSTEM_MAY` would refuse the facts in seeded logs, which are authored by `system`. The rule is applied to the five new ops only, so old logs replay (Task 4).
- Telling the owner booking went off *because the calendar was lost*, until a calendar is chosen, needs the log to say why: `guests.booking` gains an optional `calendarGone: true`, written only by `system` (Task 4). This is the one addition to the spec's event shapes.
- How the app *finds* the calendar gone is not specified: it is the calendar maker's own listing not showing it (Task 18).
- A live 401 is kept in memory, not in `connectors.json` (Task 8).
- The membership and account-list calls (`SYNO.Core.Group.Member`, `SYNO.Core.User`) and Drive's taken-name code (1003) are provisional, each one constant, until the check's probes name them on the real NAS (Tasks 3, 10, 23).

**Type consistency.** These names are used the same way in every task where they appear: `Saved`, `Change`, `Source`, `resolvedEnv`, `sourceOf`, `saveConnector`, `loadConnectors`, `lastSavedBy`, `claudeHealth` (Tasks 1, 2, 8, 18, 19, 21); `SYSTEM`, `systemMay`, `CONFIG_OPS`, `zoneOf` (4, 7, 15, 18); `DocumentsFolder`, `MoveFile`, `moveKey`, `DocumentsState`, `movesLeft` (5, 11, 14, 16, 17, 22); `drivePathOf`, `nasPathOf`, `cleanFolder`, `rememberFolder`, `folderOf`, `takenBy`, `TAKEN`, `NOT_TEAM_FOLDER`, `chooseFolder` (11, 12, 15, 16); `householdFolder(state)`, `inHousehold(file, state)`, `currentDoc`, `teamFolderKnown`, `filesOff`, `attachmentPath(state, …)`, `attachmentFolder` (14, 16, 17, 22); `movePass`, `moveFirst`, `moveFailures`, `MOVE_WAIT_MS` (16, 17, 22); `SetupStep`, `setupSteps`, `setupNotices` (12, 22); `RowId`, `connectorsView`, `needsAdmin` (19, 22); `bookingHousehold`, `bookingStatus(env, household)`, `aheadOf`, `aheadWords`, `bookingAvailability` (18, 22). `chooseFolderIn` is the test helper (14), `chooseFolder` the module's (11).

**Proportion.** About 1,900 lines for a 560-line spec, across 24 tasks in ten phases, a little more than the storage plan's ratio because the spec reaches into almost every module. Code blocks are tests and signatures; the only bodies are the fixed words the spec pins and the order of one move's steps, which no signature determines.
