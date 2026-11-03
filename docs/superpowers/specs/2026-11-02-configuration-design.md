# Configuration: Settings for the household, Connectors for the NAS

Status: design, for review. Decided with the owner on 2026-11-02.
Extends `2026-11-01-storage-design.md` and keeps the log, scopes and DSM
session rules of `2026-10-28-home-planner-design.md`.

## Intent

Home Planner is configured almost entirely from `.env` today, so a new time
zone or mail server means editing a file on the NAS and restarting. The owner
wants configuration inside the app wherever it can be, on two surfaces. The
household's owner configures the household in Settings, and each choice is a
household event with an author and a date. The NAS's administrator configures
what the NAS connects to on a new page, Connectors, kept in one file beside
the households and never in a household log.

The second change follows. Today a household writes documents under
`PLANNER_ROOT` as soon as Drive takes them. After this, nothing is written to
Drive until the owner has chosen where documents go. A folder nobody chose is
a folder nobody looks after.

## Goals

1. **A household's own choices are made in Settings** by its owner, and logged.
2. **The NAS's connections are set on Connectors** by an administrator, each
   row on, off or broken, and why, in one line.
3. **Nothing goes to Drive before the owner chooses a folder**, attachments
   included.
4. **A new folder moves the documents** without breaking a link, surviving a
   restart.
5. **An upgrade changes nothing a household can see.**

## Non-goals

- **No admin powers inside a household.** Connectors lists households as
  `GET /api/admin/households` does, and chooses nothing for them.
- **No secret goes back to the browser**, and no Drive admin endpoint is
  called: a Team Folder is enabled in Synology Drive Admin Console.
- **`DSM_PORT`, `TRUST_PROXY` and `FAKE_DSM_ACCOUNTS` stay in `.env`.** They
  describe the container. `ADMIN_USER` stays as an optional override.
- **No booking for two households at once.** There is one booking page.

## Anti-goals: failures even if it technically works

- **A secret in a household log**, which is append-only and in every backup,
  or a changed password still on disk.
- **Two households in one folder.** Search is scoped by folder.
- **A move that trusts a stale `DocRef`**: its path goes stale, and its link
  may too.
- **A setup reminder dressed as a decision**, or an admin locked out by their
  own save.

## Constraints

Unchanged: data is not code; `api/data` is never committed; no secret in a
household log; the DSM `sid` lives in the member's in-memory session only;
the fake DSM mimics the real NAS so the app's code path is the same against
both; every write is an event the fold replays; external effects first, the
log last.

New here:

- **Values are read when used.** `DSM_PUBLIC_URL`, `ALLOWED`, the match
  model, `CONTACTS_VERSION`, `PLANNER_ROOT` and the booking config are module
  constants today. Each becomes a lookup: saved value or saved off, else the
  deployment's, else the built-in default. The Anthropic key is one of them,
  so a reset or revoked key never needs a rebuild or a restart.
- **Owner-only choices are enforced by the fold**, as `member.add` is. The
  routes check too, but they are one door and the log is the record.

## What moves where

| Setting | Today | Who sets it after | Kept in |
|---|---|---|---|
| Where documents live | `PLANNER_ROOT` | Owner, Settings | Household log |
| Time zone | `TZ` | Owner, Settings | Household log |
| Which calendar | Settings already | Owner, Settings | Household log |
| Booking for this household | `BOOK_HOUSEHOLD` | Owner, Settings | Household log |
| Envelope suggestion model | `CLAUDE_MATCH_MODEL` | Owner, Settings | Household log |
| NAS public address | `DSM_PUBLIC_URL` | Admin, Connectors | `connectors.json` |
| Who may sign in | `ALLOWED_USERS` | Admin, Connectors | `connectors.json` |
| Booking page address | `BOOK_URL` | Admin, Connectors | `connectors.json` |
| Mail server | `SMTP_*` | Admin, Connectors | `connectors.json` |
| Pricing keys | `CENSUS_API_KEY`, `EIA_API_KEY` | Admin, Connectors | `connectors.json` |
| Claude API key | `ANTHROPIC_API_KEY` | Admin, Connectors | `connectors.json` |
| Contacts API version | `SYNO_CONTACTS_VERSION` | Nobody: probed | `connectors.json` |

An `.env` value for a moved item is the default until someone saves the
setting, shown on both surfaces as "from the deployment". On Connectors a
saved off beats it, and clearing brings it back. `PLANNER_ROOT` is the exception: it feeds the
carry-over and the picker's first suggestion, and is never a default folder,
because a default folder is what this design removes.

## Who is the admin

An account in DSM's administrators group is an admin, unless `.env` sets
`ADMIN_USER`, in which case that name is. Membership is asked once, at
sign-in, with the fresh `sid`, and kept on the in-memory session as `admin`,
never in the sessions file. After a restart an admin signs in again for
Connectors, as members do for Calendar. A failed call means not an admin. The
`ADMIN_USER` comparisons in `server.ts`, at sign-in, `/api/auth/check` and the
gate's `isAdmin`, read the flag. Which DSM call reports membership is an open
item for the check tool. The fake gains an admin flag as a fourth field in
`FAKE_DSM_ACCOUNTS`, `alice:correct-horse::admin`, and answers that call.

## The household's choices

### Events

Five new ops in the `settings` restore scope. Replay refuses all but
`documents.moved` from anyone but the owner; that one any member may write:

```ts
/** A Team Folder and a folder in it, one or more segments: Drive's
 *  /team-folders/<team>/<folder> and File Station's /<team>/<folder>. */
| { op: 'documents.folder'; team: string; folder: string; source: 'owner' | 'deployment' }
/** One file moved into the chosen folder: a Drive document by the link it
 *  had, with its whole DocRef read back after the move, or a card's file by
 *  plan and name, with where it landed. `gone`: there was nothing to move. */
| { op: 'documents.moved'; file: { link: string; doc?: DocRef } | { plan: PlanId; name: string; path?: string }; gone?: true }
/** The household's IANA zone, such as America/Denver. */
| { op: 'household.zone'; zone: string }
/** Whether friends may ask to stay with this household. */
| { op: 'guests.booking'; on: boolean }
/** The model that suggests envelopes on import; null for the default. */
| { op: 'envelopes.model'; model: string | null }
```

The `system` actor, reserved in the `Actor` comment, becomes real with a
`SYSTEM_MAY` set holding only `documents.folder` with `source: 'deployment'`
and `guests.booking` with `on: false`.
`documents.moved` is written by the member whose session moved the file, as
`plan.doc` is. The fold gains `state.documents`: the folder, the one before
it, the event that chose it and the files moved since, from which it derives
whether a move is pending and how many files are left. `state.zone`,
`state.settings.booking` and `state.settings.model` hold the rest.

The link is not assumed to survive a move. The fold puts a moved file's new
`DocRef` wherever state held the old link: a briefing's `doc`, an answer's
`doc`, a plan's `plan.doc`. Readers of `doc.link` read state, so they need
no change.

**Restore.** Restoring as a new household keeps `household.zone` and
`envelopes.model` by writing them again as the person restoring, the new
owner, in the pass that appends `household.claim`. It drops
`documents.folder`, `documents.moved` and `guests.booking`, and the restore
summary says so: the copy chooses its own folder, since no two households
share one, and booking is one household at a time. Restoring the settings
scope in place from a backup with another owner stays refused, as today, and
replay's owner check on the five ops is unchanged.

No household zone event exists today. `householdZone` takes a zone, but its
callers in `calendar.ts`, `calendar-view.ts`, `appointments.ts`,
`appointment-edits.ts`, `drift.ts`, `booking.ts`, `tools.ts`,
`conversation.ts` and the boot-time `tz` in `server.ts` pass none. Each
passes `state.zone`, and `ctx.today` follows it per request.

### Where documents live: the picker

Settings gains a **Setup** section atop the household's group. Every member
sees it; a member reads "Only <owner> can change these." Its first row, "Where
documents live", is a picker in three steps, with the owner's own `sid`:

1. **A Team Folder**, from `GET /team-folder`. One without
   `capabilities.can_write` is greyed. A plain shared folder is not in the
   answer, so the page says: "A shared folder not listed here is not a Team
   Folder yet. Enable it in Synology Drive Admin Console, Team Folder."
   `PLANNER_ROOT`'s Team Folder, if set, comes first as "from the deployment".
2. **A folder in it**, from `POST /files/list` on `/team-folders/<name>` with
   `filter: { type: ['dir'] }`, or a new name, suggested from the household's
   label.
3. **Checks before saving:** a Team Folder, asked again rather than trusted;
   writable by the owner, from `capabilities`; indexed by Universal Search.
   Then "Use this folder".

`documentsStatus` in `docs.ts` checks only the Team Folder and does not probe
indexing, so the index check is new: `files/search` with `content_snippet`,
scoped to the folder, for a word the app knows is in a page there. An empty
folder gives "not known yet", and Settings asks again after the first page.
Only the first two checks block saving; unindexed, search finds names only,
as the storage design allows. An advisory line from
`GET /team-folder/members` names any household member who cannot write
there: "their briefings stay in the log until they can".

"Use this folder" makes a new folder with `POST /files` `type=folder`, checks
again, and appends `documents.folder`. A folder that is, holds or sits in
another household's is refused, "Another household on this NAS keeps its
documents there", without naming it. The server keeps every household's
folder in memory, folded at boot, to answer without opening logs.

`householdFolder` and `inHousehold` in `docs.ts` derive the home from
`state.documents.folder`. During a move, `inHousehold` also accepts the
folder being left.

### Nothing in Drive before the choice

Without a folder, `writeDocOrRefusal` returns null, as it does today without
a root, so briefings and answers stay inline in the log. `canWrite` in
`pages.ts` is false, so no plan page is written until a folder exists.
`attachmentPath` and `readAttachment` refuse with "Files on cards are off
until <owner> chooses where documents live, in Settings."

### Carry-over at boot

Before the server listens, each household without a `documents.folder` whose
log names a file the app wrote gets one, if `PLANNER_ROOT` is set: written by
`system`, `source: 'deployment'`, `team` the root's first segment and `folder`
the rest of the root plus the household's id. A log names a file when it has
a `doc` on `thread.briefing` or `thread.answer`, a `plan.doc`, or a
`plan.attach`. This is judged from the log because boot has no DSM session.
A household with nothing chooses from scratch. One with a choice is skipped,
so running every boot is running once. Settings shows "set from the
deployment", changeable like any choice.

A `PLANNER_ROOT` that is a plain shared folder, not a Team Folder, is carried
over the same way and counts as chosen. This applies the owner's decision
that files keep working on upgrade. Attachments keep working through File
Station exactly as today, and documents stay inline in the log with the
existing "not a Team Folder" line. The Team Folder check is not made at boot,
which has no session. It runs on the next member request that has one, and
its answer is kept in memory with `documentsStatus`'s. Until it says yes, the
owner's Today card stays, worded for this case.

### Changing the folder moves the documents

A new `documents.folder` starts a move when the log names files in the old
folder: each distinct `doc.link` on briefings and answers, the latest
`plan.doc` per plan, and each file on a live card, as the log stood before
the choice. Files with a `documents.moved` since are done. A link that Drive
places outside the folder being left, as a copy-restored household's may, is
left alone and counted done.

Each Drive file goes to a parent worked out from its kind, never its stale
`path`: `<new>/today`, `<new>/answers` or `<new>/<plan-id>`, made first
through File Station as `writeDoc` does. Then one `POST /files/move` per
file, with `files: ['link:<permanent_link>']`, the parent's Drive path and
`conflict_action: 'stop'`. The spec makes the move asynchronous, answering an
`async_task_id`, with no endpoint to ask after it. The link may not survive,
so the app asks `getFile` for the file's expected new path, the parent plus
its name, for a few seconds; a file not there yet is looked at next pass.
Then `documents.moved` is appended with the `DocRef` that answer gives.

A card's file moves through File Station, `/<team>/<old>/<plan-id>/` to
`/<team>/<new>/<plan-id>/`. `plan.attach.path` goes stale too, but
`readAttachment` already works the path out from household, plan and name.
Detached files and files the app did not write stay behind, and Settings says
so. Nothing is deleted.

The move runs after the response, in the per-household lane `schedulePages`
uses, before the pages, on any member's request that has a `sid`.

- **One file fails.** The name and the NAS's words are kept in memory, and
  that file waits `PAGE_RETRY_MS`; the rest go on. A lost session stops the
  pass. A name already taken at the destination fails until a person acts,
  and Today names the file.
- **A file is not there.** Drive's no such file, or File Station's 408, is
  recorded `gone: true` so the move can finish.
- **A restart mid-move.** The log says what moved, and boot prints how many
  files are left per household. No credential is stored, so the first
  request from a member with a NAS session resumes the pass. A file the NAS
  moved whose event was lost is found at its new path and recorded.
- **A write during the move.** A write whose file is still waiting moves it
  first. The page follow-on skips plans whose page has not moved.
- **Another change of folder** mid-move is refused: "Wait until the N
  documents have moved."

Today shows every member "Moving N documents to <team>/<folder>", and after a
failure "N could not be moved yet: <name>. Trying again at <time>."

### Time zone, calendar, booking and model

- **Time zone.** From `Intl.supportedValuesOf`, checked on the server by
  building an `Intl.DateTimeFormat`. Unchosen, `TZ` applies, else UTC.
  Settings warns that events already on the calendar keep their zone.
- **Calendar.** Owner-only, like the folder. The existing picker is reused,
  and `/api/calendars/household` and `/api/calendars/target` refuse anyone but
  the owner; a member's own calendars checked for clashes stay their own.
  The check is in the routes, not replay, because existing logs hold these
  events from members and must still replay.
- **Booking.** A switch: on when the latest `guests.booking` says so or, with
  none, when `BOOK_HOUSEHOLD` names the household. It is unavailable, with a
  line saying why, until the household has a calendar and the Mail connector
  works. When it is not, the existing "Booking is off until…" line names who
  can fix it: the owner for the calendar; for mail, `ADMIN_USER`, else the
  last admin to save on Connectors, else "the NAS's administrator".
- **Booking's guests.** While the booking household has an open request or a
  confirmed stay ahead, its owner cannot turn booking off and another owner
  cannot turn it on; the refusal names what blocks it, with counts, such as
  "2 requests waiting and 1 stay ahead". With nothing ahead, another owner's
  switch moves booking: `system` appends `guests.booking` off in the old
  household's log. Switching off, either way, signs that household's guests
  out. If two logs say on after a restore, the first to turn it on keeps it.
- **A calendar cleared or lost.** When the app finds the household's
  calendar gone, `system` appends `guests.booking` off, its guests are signed
  out, and the owner's Today says "Booking is off: the household calendar is
  gone. Choose one, then turn booking on again", with any requests and stays
  still ahead counted. They stand in the log.
- **Envelope model.** A short list in `match.ts` beside today's default, plus
  `CLAUDE_MATCH_MODEL` when set. Marked "Claude is off on this NAS" without a key.

## The NAS-wide file

`api/data/connectors.json`, beside `sessions.json` and outside the households
directory, moved by `CONNECTORS_PATH` as `SESSIONS_PATH` moves the sessions.
Mode 0600, written whole to a temporary file and renamed into place; read at
boot, and each save writes the file before the copy in memory.

```ts
interface Connectors {
  version: 1;
  publicUrl?: Saved<string>;          // an origin only
  signIn?: Saved<string[]>;           // never off
  bookUrl?: Saved<string>;            // an origin only
  mail?: Saved<{ host: string; port: number; user: string; pass: string; from: string; plainAuth: boolean }>;
  mailTest?: { at: string; to: string; ok: boolean; words: string };
  claude?: Saved<string>;             // the Anthropic API key
  claudeTest?: { at: string; ok: boolean; words: string; worked?: string };
  census?: Saved<string>;
  eia?: Saved<string>;
  probed?: { contactsVersion: { version: number; min: number; max: number; at: string } };
}
type Saved<T> = ({ value: T } | { off: true }) & { by: string; at: string };
```

Every NAS-wide value has three saved states: a value; an explicit off, which
beats a value in `.env`; or no key, which means the deployment's value and
then the built-in default. Each row says which as `saved`, `off`, `from the
deployment` or `default`. No `GET` carries `pass`, `census`, `eia` or the Claude key, only
`set` or `not set`. A mail value without `pass` keeps the saved password.

**Contacts version.** `SYNO_CONTACTS_VERSION` is no longer read; boot says so
if it is set. On the first Contacts call, `SYNO.API.Info` gives the range for
`SYNO.Contacts.Contact`: 1 if the range holds it, else the lowest offered,
kept under `probed` and asked again only when DSM refuses the version.

## Connectors

A page under the person icon, in `#me-menu`, shown only to an admin session,
and beside "All households on this server" on the households screen for an
admin in no household. Clicking a row opens its form below it.

| Row | Says | Form |
|---|---|---|
| Claude | Key set or not set, and the date it last worked | The key; "Test" |
| Synology Drive | Reachable; "N of M households have chosen a folder" | Households by label and owner, chosen or not |
| Calendar on phones | The public address, or off | The address |
| Mail | `host:port`, last test and its date | Host, port, user, password, from, plain auth; "Send me a test" |
| Booking | On for <household> at <address>/book, or off and why | The booking page's address |
| Who may sign in | Any DSM account, or N accounts | DSM accounts to tick |
| Pricing sources | Which keys are set | The two keys |

**Broken** means set but failing: Drive did not answer the admin's session,
the last mail test failed, or a saved address no longer parses. "Send me a
test" mails an address the admin types, prefilled with the last, through the
`send` the server already injects. **Who may sign in** lists the accounts the
admin's session can list, members marked; without a session, names are
typed. A list leaving out the admin saving it is refused. A row saved off is
off on purpose and stays out of the admin's card.

**Claude** works like Mail. A pasted key is the only way in: Anthropic's API
takes API keys, Workload Identity Federation, which needs a public OIDC
issuer, and App Attest, for iOS and macOS apps, and offers no browser sign-in
a third-party app can use. The key may be personal or a service account's,
scoped to one workspace, and may expire. "Test" sends one minimal request, a
one-token message to the envelope model, and keeps the result in
`claudeTest`, with `worked` the last time it succeeded. Cleared, the key falls
back to `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` as `claudeConfigured`
accepts today, then "Claude is off". A 401 from the test or from any live
call makes the row broken, "the key has expired or been revoked", and the
admin's Today card says so. Every Claude feature keeps its plain fallback.

`claude.ts` builds one client from `process.env` and caches it in `claude`,
and `claudeConfigured` reads the env too; `briefing.ts`, `conversation.ts`,
`match.ts` and `tools.ts` reach Anthropic only through them. Both read the
resolved key per call instead, so a saved key is used by the next request
without a restart. The client is built with that key each time, never cached
with one in it. `setClaudeClient` stays for tests.

## Cards on Today before setup

A separate notice, not thread cards. A thread card, like those
`raiseDriftCards` raises, is a `proposal.offer`: a decision in the log, the
same for every member. A reminder decides nothing, differs for owner, member
and admin, goes when its step is done, and its NAS half belongs in no
household's log. So `GET /api/today` gains a `setup` list, computed per load.

- **No folder.** The owner sees "Your documents are not in Drive yet" and
  "Choose a folder", which opens Settings at the first unfinished step,
  marked, the checklist below in its order: folder, time zone, calendar,
  booking, envelope model. Booking follows the calendar because it needs one.
  A step is finished when chosen or covered by a deployment value, the folder
  only by a choice. The zone is unfinished only without `TZ`, the calendar
  only with no Household calendar or target, booking and model never. Members
  see "Documents are not in Drive yet. Ask <owner> to choose a folder."
- **A carried-over folder that is not a Team Folder.** The owner sees
  "Your documents are not in Drive yet: <folder> is not a Team Folder", with
  two ways out: enable it in Synology Drive Admin Console, or choose another
  folder. Members see their card as above.
- **NAS not set up.** An admin sees the rows that are broken, or off and not
  left off, with "Open Connectors", which opens at the first. Nobody else does.
- **Moving.** The move's line, for every member.
- **Booking turned off** because the calendar was lost, for the owner, until
  a calendar is chosen.
- Owner and admin in one sees the household's card first; the sandbox, none.

## Routes

New, household, writes owner-only:

```
GET  /api/drive/team-folders      step 1: name, can_write, from the deployment
GET  /api/drive/folders?team=     step 2: the folders inside it
POST /api/drive/folder-check      { team, folder }: the checks; makes nothing
POST /api/settings/documents      { team, folder }: make if new, check, log; may start a move
POST /api/settings/zone           { zone }
POST /api/settings/booking        { on }: 409 naming what is ahead, with counts
POST /api/settings/model          { model | null }
```

New, admin only, each answering with the Connectors view. Every save takes
one of `{ value }`, `{ off: true }` or `{ clear: true }`:

```
GET  /api/connectors              rows and forms; secrets as set or not set
GET  /api/connectors/accounts     the DSM accounts the admin's session can list
POST /api/connectors/public-url   value: an origin
POST /api/connectors/sign-in      value: account names; off refused; clear: ALLOWED_USERS, then any account
POST /api/connectors/book-url     value: an origin
POST /api/connectors/mail         value: { host, port, user, pass?, from, plainAuth }
POST /api/connectors/mail/test    { to }
POST /api/connectors/census       value: the key
POST /api/connectors/eia          value: the key
POST /api/connectors/claude       value: the key
POST /api/connectors/claude/test  one minimal request; the result, never the key
```

Changed: `GET /api/settings` gains `setup`, with each choice's `source`, the
move's progress and the checks, and `documents.why` names the owner.
`GET /api/today` gains `setup`. Sign-in, `/api/auth/check` and `/api/whoami`
take `admin` from the session. `GET /api/admin/households` gains each folder.
Booking is worked out again on each `guests.booking` or Connectors save, not
once at boot as `bookingNow` does.

## Boot

Read `connectors.json`, reporting and ignoring one that does not parse. Fold
every household's folder into memory, carry over, work out booking, and print
each household's folder, zone and pending move, the admin rule, and where the
Claude key comes from, never the key.

## What the check tool must confirm on the real NAS

Probes in `api/tools/synology-check/check.ts`, each with a README line:

1. **The call that says an account is in the administrators group**, as an
   admin and as a non-admin. Open: not guessed here.
2. The call that lists DSM accounts, and its answer to a non-admin.
3. `GET /team-folder` and `GET /team-folder/members` as a non-admin: a
   read-only folder's `capabilities`, a plain share's absence, the role names.
4. `POST /files/list` with the `dir` filter; `POST /files` with `type=folder`.
5. `POST /files/move` by `link:`: the task id, how soon `getFile` finds the
   new path, whether the link changes, moves between Team Folders, the
   conflict error. The opt-in write section moves its own `check.md` and back.
6. File Station's move, and that a Team Folder's name is its share's, so
   Drive sees the moved file where File Station put it.
7. `SYNO.API.Info` for `SYNO.Contacts.*` without a session.

## Testing against the fake DSM

The fake grows what the probes find: the admin flag and membership call, the
account list, per-account `capabilities` with read-only folders, `POST files`
for folders, an asynchronous `POST files/move` with a set delay, File
Station's move, and `team-folder/members`. Handles make one file's move fail
and make a move keep or change the link. Tests run through the server and cover:

- Admin by group and by `ADMIN_USER`; value, off, deployment and default for
  each setting; no secret in a `GET`, a log or a stale file; no lockout.
- A Claude key saved on Connectors used by the next call without a restart; a
  401 making the row broken and the admin's card say so. Briefing tests guard
  on the resolved key, never on `ANTHROPIC_BASE_URL`, which the Claude Code
  harness sets without a key.
- Without a folder: briefings inline, no pages, files refused, the right card
  for owner and member. Carry-over for a log with a `doc` only, once; for a
  plain shared folder, files working, documents inline and the card worded so.
- A restore as a new household keeping zone and model, dropping the rest; the
  picker's greyed folders and refusal of a taken one.
- The move: right parents, a delayed move seen next pass, one failure retried
  while the rest go on, `gone`, a changed link replaced in every pointer,
  resume after a restart, a write to a waiting file, a second change refused.
- Booking: refused off, and refused to another owner, with a request or stay
  ahead; moved and guests signed out when nothing is; unavailable without a
  calendar; turned off when the calendar is lost. Calendar routes refuse
  members. A household's zone deciding its `today`.

## Left to the builder

- The membership and account-list calls, once the check names them.
- The models offered for envelopes, and their labels.
- How long to wait on an asynchronous move, and how many files a pass takes.
- Whether a zone change makes `drift.ts` see the app's own events as changed.
  It must not raise cards for them: confirm and guard.
- The layout of Setup and Connectors within the existing tokens, and each
  row's one-line words in every state.
- `DEPLOY.md` and `.env.example`: moved variables become defaults, Documents
  in Synology Drive becomes "choose a folder in Settings", the administrator
  is the group, `SYNO_CONTACTS_VERSION` goes, and an allowlist that locks
  everyone out is undone by deleting `signIn` from `connectors.json`.

## Calls made while writing

The owner's: two surfaces, Settings and an admin-only Connectors; the admin as
DSM's administrators group or `ADMIN_USER`, with a fake admin flag and the
membership call left to a probe; the household and NAS split and what stays
in `.env`; secrets in their own file; `.env` values as defaults shown "from
the deployment"; nothing to Drive before a folder is chosen; the carry-over,
with files that keep working on upgrade, here applied to a `PLANNER_ROOT`
that is not a Team Folder; the three-step picker and its checks, with no
admin endpoints; a change of folder moving every document, one Drive move per
file, resumed from the log and retried like pages; the setup cards and who
sees which; the seven Connectors rows, and the Claude key set there like the
mail password rather than kept in `.env`; the calendar as an owner-only choice;
booking held while requests or stays are ahead, guests signed out when it
goes off, and booking needing a calendar and working mail, turned off if the
calendar is lost.

The builder's call:

1. `PLANNER_ROOT` is never a default folder, only the carry-over's source and
   the picker's suggestion: decision 6 outranks decision 5 here.
2. Carry-over judges "has files" from the log, since boot has no session;
   the chosen folder is the household's home, with nothing appended.
3. Five ops in the `settings` scope, owner-only in replay but for
   `documents.moved`; `system` writes the carry-over and booking's off.
4. One `documents.moved` per file, so Today counts without asking Drive.
5. Moves confirmed by `getFile` at the expected new path, as the spec has no
   task status; `conflict_action: 'stop'`, because answers are found by name.
6. The link is not assumed to survive: `documents.moved` carries the whole
   new `DocRef`, and the fold replaces every pointer to the old link.
7. A move resumes on the first member request with a session after boot.
8. A second change of folder is refused mid-move; detached files and files
   the app did not write stay behind.
9. Two checks block saving; indexing and members' access only advise.
10. No two households share or nest folders.
11. A restore as a new household rewrites zone and model as the new owner and
    drops folder, moves and booking, saying so; in-place restore is unchanged.
12. The calendar's owner-only check sits in the routes, since old logs hold
    calendar events from members; the checklist runs folder, zone, calendar,
    booking, model.
13. One booking household. With nothing ahead, another owner's switch moves
    it, and `system` turns it off in the old log, as it does when a calendar
    is lost; after a restore, the first to turn it on keeps it.
14. Setup notices are computed per load, not thread cards, and the admin flag
    is not kept in the sessions file.
15. Connectors saves take `{ value }`, `{ off: true }` or `{ clear: true }`;
    a saved off is off on purpose; sign-in refuses off.
16. The Claude key is read per call and never cached in a client; "Test" is
    a one-token message to the envelope model; a live 401 breaks the row too.
17. The mail test goes to a typed address; the Contacts version is probed on
    first use and kept under `probed`.
