# A stand-in for DSM — laptop and tests only

The app has no passwords of its own; it asks DSM whether yours is right, and
then reads your calendars, contacts and files on the NAS as you. Off the NAS
there is no DSM to ask, so this answers in its place: the same endpoint
(`/webapi/entry.cgi`), the same form fields, and DSM's habit of answering
HTTP 200 with `success: false` and a code. The app's own code runs unchanged.
The container reaches it the way it reaches DSM on the NAS —
`host.docker.internal` — and only the port differs.

Nothing here is in the image; the Dockerfile copies `src/` only.

In the repository's `.env`:

```bash
DSM_PORT=5555
FAKE_DSM_ACCOUNTS=alice:correct-horse,bob:battery-staple:123456
# Optional: where File Station keeps files. A fresh temp directory otherwise.
FAKE_DSM_ROOT=/tmp/fake-nas
```

`name:password`, or `name:password:code` for an account that asks for a
one-time code. Test values — never a real DSM password.

A fourth field, `admin`, puts the account in DSM's administrators group:
`alice:correct-horse::admin` (the third field left empty for no code). The app
asks DSM once at sign-in whether the member is in that group, with their own
session id, so a plain member and an administrator go through the same code
path as on the real NAS. Two calls answer an administrator and refuse anyone
else with code 105:

- `SYNO.Core.Group.Member` `list` (`group=administrators`) answers
  `{ users: [{ name }…the administrators], total }`.
- `SYNO.Core.User` `list` answers `{ users: [{ name }…every account], total }`.

Both calls are provisional until `tools/synology-check` confirms them on the
real NAS; the app's two constants are in `src/accounts.ts`.

```bash
cd api && npm run fake-dsm
docker compose up -d --build budget-api
```

A test can run it in-process instead, on a free port:

```ts
import { start } from '../tools/fake-dsm/server.ts';
const nas = await start({ port: 0, accounts: { alice: { password: 'pw' } }, log: () => {} });
process.env['DSM_URL'] = `http://127.0.0.1:${nas.port}`; // before anything imports src/auth.ts
// ...
await nas.close();
```

## Signing in

| Signing in with | Answers | The app shows |
|---|---|---|
| a listed name and its password | session id | signed in |
| anything else | code 400 | "that username or password is not right" |
| an account with a code, no code given | code 403 | the one-time-code prompt |
| the wrong code | code 404 | refused |

Every other call must carry a session id this fake issued and has not seen
signed out (`_sid` in the form; a multipart part for upload; the `id` cookie
for download and for everything on Drive). Anything else is code **119**,
which the app reads as "sign in again".

## What it remembers

All in memory and gone when it stops, apart from the files.

| API | Methods | Notes |
|---|---|---|
| `SYNO.API.Info` | query | the APIs below and their versions |
| `SYNO.Cal.Cal` | list, create, set, delete | `list` wants `cal_type` (`event`, `todo` or `all`) and `is_evt`, and refuses 9009 without them, and answers `{ list: [...] }` as the guide shows it; each account starts with "My Calendar" (its default) and a task list "My Tasks"; `list` shows your own and those shared with you; `delete` is the owner's, and takes the calendar's events with it |
| `SYNO.Cal.Sharing` | get, set | owner only; `set` replaces the whole list, groups included (kept as sent); `get` answers `{ cal_share_setting: { DSM_USER, DSM_GROUP } }` |
| `SYNO.Cal.Event` | create, get, list, set, delete | `list` takes `cal_id_list`, `start`, `end` (epoch seconds) and answers `{ list: [...] }` (the guide's wrapper) of the events overlapping it; every `set` gives a new `dav_etag`, and a `set` with a stale one is refused; each event says who last changed it in `last_modify_user` (the client's guess at DSM's name for it) |
| `SYNO.Contacts.Addressbook` | list | one address book, id 1, shared by every account; answers `{ addressbook: [...], total }`, the singular key as the real NAS answers it (2026-11-03) |
| `SYNO.Contacts.Contact` | list, get, create, set | `list` answers `{ contact: [...], offset }`, the singular key as the real NAS answers it (2026-11-03); rows carry `tel` and `email` as lists of `{ value }` |
| `SYNO.FileStation.CreateFolder` | create | |
| `SYNO.FileStation.List` | list, list_share | `list` with `additional.size`; `list_share` names the top-level folders under the root |
| `SYNO.FileStation.Upload` | upload | multipart; refuses an existing file unless `overwrite=true` |
| `SYNO.FileStation.Download` | download | a GET; the bytes, or DSM's JSON refusal |
| `SYNO.FileStation.CopyMove` | start, status | a move only (`remove_src=true`, never `overwrite=true`), of one path, into an existing folder; done before `start` answers `{ taskid }`, so `status` says `{ finished: true }`; 408 for a missing source or destination folder; a name already taken is as Upload has it: `overwrite=false` skips the file (the source stays) and still finishes, left out it is 414 |

File Station paths live under a directory of their own; `..` cannot climb
out of it.

## Synology Drive

Drive is a door of its own: ordinary REST under
`/api/SynologyDrive/default/v2/`, in the same `{ success, data }` envelope,
the session id taken from the `id` cookie only (`_sid` in the query is 119).
It serves the Team Folders named in `start({ teamFolders })` — `['Planner']`
when left out, each made under the root at start — and
`/team-folders/Planner/x.md` is the same file on disk as File Station's
`/Planner/x.md`, so a file written by one is read by the other. A path outside
those Team Folders, a missing file and a missing folder are all **1003**, as on the real NAS.

| Route | Answers |
|---|---|
| `GET files?path=` | a file's or folder's metadata: `display_path` is `/team-folders/<team>/…`, `path` is relative to the Team Folder, as on the real NAS (2026-11-03) |
| `POST files/list?path=` | the folder's children, as `items`; the JSON body is optional, and `{ filter: { type: ['dir'] } }` leaves the files out |
| `POST files?path=&type=folder&conflict_action=stop` | one folder under a parent that is there (1003 without it, 1022 when the name is taken, as on the real NAS); body `{}` |
| `POST files/move` | JSON `{ files: [path], to_parent_folder, conflict_action: 'stop' }`, one file; answers `{ async_task_id }` at once and moves after `moves.delayMs` (below) |
| `PUT files/upload` | multipart `path`, `conflict_action`, the file last; only `conflict_action=version` is taken, and the folder must already be there |
| `POST files/download` | JSON `{ files: [path] }`, one file: its bytes, or the JSON refusal |
| `POST files/search` | JSON `{ keyword, location, content_snippet }`; any case, in a name or the text, under `location` (`any` is every Team Folder); `?limit=` |
| `GET team-folder` | the Team Folders by name, as `items` of `{ name, team_id, path, capabilities: { can_read, can_write } }`; `team_id` is the name |
| `GET team-folder/members?team_id=` | every account, as `items` of `{ name, uid, display_name, role }`; `viewer` where the account may only read that Team Folder, else `organizer` |

Anywhere a path goes, `link:<permanent_link>` does too. What Drive knows of a
file beyond its bytes is in memory: a `permanent_link` (a UUID) given on first
sight and kept for good; `version_id`, 1 at first and up by one on every Drive
write; `hash`, the sha256 of the bytes on disk when asked, so a file edited
behind Drive's back (over SMB, or by File Station) changes it; and
`change_id`, which takes the next number on every write, whenever a hash
change is noticed, and when a file seen before is first found gone from disk.
A folder's `change_id` and `max_id` are the largest under it, deletions
included, so a file deleted behind Drive's back moves its folder's cursor the
next time the folder is asked about. A gone file is **1003** by path and by
link alike (never `removed: true`); written again at the same path, it keeps
its link and gains a version.

**Read-only Team Folders.** `start({ readOnly: { alice: ['Family'] } })` makes
`Family` a Team Folder `alice` may only read: her `GET team-folder` says
`can_write: false` for it, the members list gives her the role `viewer`, and an
upload, a new folder or a move into it (or out of it) is **105**. Other
accounts are unaffected. In tests, `fakeNas({ readOnly })` passes it on.

**Moves.** A Drive move answers its task id at once, as the real one does, and
the file is at its new path `moves.delayMs` later (0 by default: before the
answer). The handle's `moves` is read afresh on every move, so a test changes
it between them: `nas.moves.delayMs = 200`; the moved file keeps its `permanent_link`, version and hash, as on the real NAS; `nas.moves.refuse.add('a.md')`,
and a move of a file by that name is **1001** at once. A move onto a name already
taken at the destination is accepted like any other (its task id at once) and
then does nothing: both files stay as they were, as on the real NAS (2026-11-03). A move that lands moves both
folders' cursors move. File Station's move (`CopyMove`) is the other way to
the same end, and is done at once.

Where Synology does not document a shape (the comments in `src/synology.ts`
that say "the check shows it" or "first real use"), this answers the client's
guess. It shows the app and the fake agree, not that DSM does;
`tools/synology-check` against the real NAS is for that.

## The codes it answers with

| Code | Means here | DSM's own? |
|---|---|---|
| 102 / 103 | no such API / method | yes |
| 105 | an account outside the administrators group asked for the group or the accounts; on Drive, a write, a new folder or a move into a Team Folder the account may only read | yes |
| 114 | a required parameter is missing | yes |
| 119 | unknown or signed-out session id | yes |
| 120 | a parameter it could not read, or no such contact; on Drive, also an upload without `conflict_action=version`, a folder where a file is meant, or a download of more than one file | yes |
| 408 / 414 | File Station: no such file or folder / file already exists | yes |
| 1001 | Drive: a move of a file named in `moves.refuse` | this fake's choice |
| 1003 | Drive: no such file or folder, or a path outside the Team Folders | yes: the real NAS answered it for a path that does not exist, and for a Team Folder path in the wrong case (2026-11-03; `DRIVE_NO_SUCH_FILE`, src/drive.ts) |
| 1022 | Drive: a folder made where that name is already taken | yes: the real NAS refused a second `POST files` type=folder with it (2026-11-03; `DRIVE_NAME_TAKEN`, src/drive.ts) |
| 9006 | event `set` with a stale `dav_etag` | the client's assumption |
| 9009 | `SYNO.Cal.Cal list` without `cal_type` and `is_evt`; also no such calendar or event, or not one this account may use | yes for a `list` with no parameters (the real NAS, 2026-11-03; the guide calls it "Parameter error"); which of the two parameters the NAS needs is not confirmed, so the fake wants both; the rest is this fake's choice |

## Moving an event as a phone would

`POST /fake/move` with a JSON body changes an event as one of the accounts,
the way their phone's calendar would, so the app's drift card can be seen:

```bash
curl -s localhost:5555/fake/move -d '{"evt_id": 1, "by": "bob", "shift": 86400}'    # a day later
curl -s localhost:5555/fake/move -d '{"evt_id": 1, "by": "bob", "dtstart": 1794150000, "dtend": 1794160800}'
curl -s localhost:5555/fake/move -d '{"evt_id": 1, "by": "bob", "delete": true}'
```

The etag changes and `last_modify_user` becomes `by`. Not a DSM API, and
needs no session.

Three things it does that DSM does not: the door above; it refuses a password or a session id
sent in the URL (the app promises never to, and this is where that promise
gets checked), and it logs each DSM session the app closes, so "the DSM
session is closed when the member signs out" can be watched rather than
assumed.
