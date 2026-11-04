# Checking the NAS against what the app assumes — read-only unless asked, run once

Synology documents its Calendar API in a guide, its Contacts API not at all, and
parts of File Station only by example. Synology Drive has a spec, but the copy
the app was written from is not the NAS's own word. `src/synology.ts` and
`src/drive.ts` therefore contain
guesses, and each comment says which kind it is: "the check shows it" (this
script prints the NAS's answer) or "first real use" (a write, or a path this
script does not make; the tables below say what a wrong guess looks like then).
This is the check that settles the first kind: it signs in to your NAS, asks
it which versions of each API it offers, and prints the **raw** reply to each
read the app makes, beside what the app's own client made of that reply. A
shape that differs is visible in the raw text. With the write flags below it
settles much of the second kind too: it makes the writes the app makes, on
things of its own, and prints DSM's whole reply to each.

Without a write flag it creates, changes and deletes nothing. Each write is
asked for by its own flag (`CHECK_DRIVE_WRITE`, `CHECK_CALENDAR_WRITE`,
`CHECK_CONTACTS_WRITE`, below), writes only what that flag names, and deletes
nothing it did not make; the last lines of the run, *What the opt-in writes
left on the NAS*, say what is still there. Signing in leaves one login in DSM's log,
and the script signs out at the end. It never prints the session id, your
password or the one-time code; every line is blanked of them before it is shown.
The raw replies do contain your calendar names, one contact's name, number and
email address, and at most a few events, so read them before pasting anywhere.

```bash
cd api
cp tools/synology-check/.env.example tools/synology-check/.env && chmod 600 tools/synology-check/.env
# fill in DSM_URL, CHECK_USER, CHECK_PASS and PLANNER_ROOT, then:
npm run synology:check
```

The check and the probes (below) read `tools/synology-check/.env` when it is
there, so the account, the NAS and the flags you keep on can live in it
instead of on every command line. It is covered by the repository's `.env`
ignore rule and holds the password in clear, so keep it mode 0600. Anything
on the command line still wins over the file. When DSM wants a one-time code
for the account, the run asks for it on the terminal; `CHECK_OTP=<code>` is
only for a run with no terminal.

**Probes.** Beside the check, `tools/synology-check/probes/` holds small
scripts that each try several ways of making one DSM call, stop at the first
the NAS accepts, and delete what they made. They are for a 9009 or 120 the app
meets on a write, where the guide's wording leaves the encoding open: `npm run
synology:probe` lists them, `npm run synology:probe -- <name>` runs one, and
each prints only codes and parameter names. `cal-create` settled that the NAS
reads a required field sent empty as missing (2026-11-03); `event-create` asks
the same of an event's `color`.

Every write at once, which is the run that settles the write paths:

```bash
CHECK_USER=<your-dsm-account> DSM_URL=http://<nas-ip>:5000 PLANNER_ROOT=/<team-folder>/<folder> \
  CHECK_DRIVE_WRITE=1 CHECK_CALENDAR_WRITE=1 CHECK_SHARE_WITH=<another-dsm-account> \
  CHECK_CONTACTS_WRITE=1 npm run synology:check
```

- `DSM_URL` is where the **NAS** answers, from the machine you run this on. The
  default (`host.docker.internal`) only means something inside the container,
  and the image does not carry `tools/`, so run it from a checkout.
- The Contacts version is not set by hand: the check asks the NAS, as the app
  does (the lowest version the range holds, 1 if it holds that), and the
  version table shows the range.
- Optional, all reads: `CHECK_CALENDAR="<display name>"` picks the calendar the
  Sharing and Event replies are for (the first one otherwise);
  `CHECK_FOLDER=/share/folder` lists a File Station folder;
  `CHECK_FILE=/share/folder/file.pdf` downloads one file and shows only its size
  and type.
- `PLANNER_ROOT=/Planner` names the Team Folder and folder to read, and adds
  the Synology Drive reads below. Without it the Drive section is skipped with a
  sentence. Drive paths are case-sensitive: write the Team Folder and folder
  exactly as Drive shows them. The real NAS answers 1003 (no such file) for
  `.../planner` where the folder is `Planner`.
  The app itself chooses each household's folder in Settings; there
  `PLANNER_ROOT` is only where files are carried over from, once, and the
  picker's first suggestion.
- `CHECK_ADMIN_USER` and `CHECK_ADMIN_PASS` (both, or neither) are a DSM
  administrator account. The checks of how DSM names administrators and accounts
  (*What the configuration design guessed*, below) are asked with the member's
  own session and, when these are given, the administrator's too. The
  administrator signs in and out like the member; the password is blanked from
  every line like the other.
- `CHECK_SECOND_TEAM=<name>` is a second Team Folder you may write: one of the
  move checks then moves a file into its `.planner-check` and back.
- `CHECK_DRIVE_WRITE=1` adds the Drive and File Station writes: it makes the folder
  `<PLANNER_ROOT>/.planner-check` through File Station, writes `check.md` in it
  twice through Drive, reads it back and searches for it, then makes
  `.planner-check/sub` and writes one `check.md` there. The design checks add
  `.planner-check/made` and a few small files in it (and a `.planner-check`
  in `CHECK_SECOND_TEAM`'s share), and move `check.md` out and back. It writes
  nothing anywhere else and deletes nothing. It also uploads `fs-upload.md` into
  `.planner-check` through File Station's own upload (replacing an earlier
  run's), downloads it and compares the bytes by sha256, and lists the folder.
  Delete `<PLANNER_ROOT>/.planner-check` afterwards (in File Station; Drive
  keeps the versions it made).
- `CHECK_CALENDAR_WRITE=1` makes a calendar of its own, `Planner check
  <date-time>`, reads its sharing, renames it to `… renamed`, makes one event
  in it (an hour, tomorrow), reads it back, moves it an hour later carrying the
  etag it read, then writes it again carrying the **old** etag (the stale-etag
  probe), deletes the event and deletes the calendar. Nothing is written to any
  other calendar. The app has no calendar delete, so the last step is the
  check's own raw `SYNO.Cal.Cal delete` with `cal_id`, as the Calendar guide
  has it; if it is not answered the calendar is left, and the run says so.
- `CHECK_SHARE_WITH=<dsm account>`, with `CHECK_CALENDAR_WRITE`, also shares
  that calendar read-only with the account and reads the sharing back. The
  account sees a calendar called `Planner check …` until it is deleted at the
  end of the run. Without it the share is skipped with a sentence.
- `CHECK_CONTACTS_WRITE=1` adds one contact, `Planner Check`, with the made-up
  address `planner-check@example.com`, finds it again, and tries to delete it.
  The app has no contact delete either, and Contacts is not documented, so the
  delete (`SYNO.Contacts.Contact delete` with `id`) is a guess; if it is not
  answered the contact is left, and the run says so. Contacts of that name from
  an earlier run are left alone.
- `CHECK_ADDRESSBOOK=<name>`, with `CHECK_CONTACTS_WRITE`, picks the address
  book to add it to (the first one listed otherwise).

### What the writes leave behind

| Flag | Left on the NAS | To remove it |
|---|---|---|
| `CHECK_DRIVE_WRITE` | Always: `<PLANNER_ROOT>/.planner-check` with `check.md`, `sub/check.md`, `fs-upload.md`, `made/` and the moves' small files; with `CHECK_SECOND_TEAM`, `/<second>/.planner-check` too | Delete the `.planner-check` folder(s) in File Station. Drive keeps the versions it made of `check.md`, which go with the folder |
| `CHECK_CALENDAR_WRITE` | Nothing, when `SYNO.Cal.Cal delete` is answered. Otherwise the calendar `Planner check <date-time> renamed` (or without `renamed`, if the rename was refused), shared with `CHECK_SHARE_WITH` if that was set. The event is deleted on its own before the calendar | Delete the calendar in Synology Calendar; the last lines name it |
| `CHECK_CONTACTS_WRITE` | Nothing, when the guessed delete is answered. Otherwise the contact `Planner Check` | Delete it in Synology Contacts |

It exits non-zero, with a sentence, if it cannot sign in or DSM_URL is not DSM.
It also exits non-zero if any call is refused or any API is missing or outside
the version the client asks for, but it carries on to the end first, since the
other replies are still the point.

## Reading the output

1. **API versions.** Each line is `minVersion–maxVersion` for that API, then the
   version the client asks for. `NOT OFFERED` means the package is not installed
   (Synology Calendar, Synology Contacts). `OUTSIDE the range` means that call
   will fail.
2. **`raw data` / `the client reads`.** For each call, DSM's own `data`, then
   what `src/synology.ts` made of it. If the second line is empty, wrong, or an
   error, the first line shows why. For the writes, which are made through the
   client's own functions, the raw text is DSM's whole reply (`success` and
   `data`, or `error` with its code), and a list of them when the function made
   more than one call; a refused write prints its raw reply before `FAILED`.
3. A `FAILED` line carries DSM's error code. 102 and 103 mean no such API or
   method; 105 no permission (the app says "your DSM account is not allowed to
   use …", and signing in again does not help); 114 a missing parameter; 120
   an invalid one; 119 a dead session; 408 no such file or folder. On Drive,
   1002 is no such file or folder.

## What the client assumes, and what to change

"Seen here" means this check shows it, with the flag named where it is a write.
The rest cannot be seen without a path of yours, or without a second person;
for those it says how to find out, and that is done once, by hand, in the real
app on the real NAS.

Almost all of these are literals inside the function named, not constants or
environment variables. None has an environment variable: the Contacts version
is asked of the NAS on first use and kept. The etag refusals are the one named
constant.

### Calendar

| Assumed | Seen here? | If the NAS disagrees |
|---|---|---|
| `Cal.Cal list` is sent `cal_type=event` and `is_evt=true` (`CALENDAR_LIST_PARAMS` in `synology.ts`) and answers `{ list: [...] }` as the guide shows it; a bare array or `{ cal_list }` is read too (`listCalendars`) | Yes: the first calendar block, whose title prints the parameters sent and says whether `is_evt` was among them | Confirmed on the real NAS (2026-11-03): a `list` with no parameters is refused **9009** ("Parameter error"). The guide marks `cal_type` required; its examples also send `is_evt`, and which of the two the NAS needs is not yet known, so both are sent. A 9009 with both: compare with the guide's `Method List` and change `CALENDAR_LIST_PARAMS`. Another wrapper: add its key to the `listRows` call in `listCalendars`. |
| `Cal.Cal create` takes the guide's twelve: `cal_type`, `cal_displayname`, `cal_description`, `cal_color` and the eight booleans `is_hidden_in_cal`, `is_hidden_in_list`, `notify_alarm_by_browser`, `notify_alarm_by_mail`, `notify_evt_by_browser`, `notify_evt_by_mail`, `notify_import_cal_by_browser`, `notify_import_cal_by_mail`. The real NAS accepted exactly these as plain words (2026-11-03) and refused the same request with `cal_description` sent empty with 9009: a required field sent empty counts as missing, so the client never sends one (`CALENDAR_DESCRIPTION`). A 9009 here means a field is wrong, missing or empty. It answers the calendar made, read by `calendarInfo` (`cal_id`, `original_cal_id`, `cal_displayname`, …) | Yes, with `CHECK_CALENDAR_WRITE`: the `SYNO.Cal.Cal create` block, then `listCalendars shows it under the same cal_id` | Refused 9009, 114 or 120: a parameter is wrong or missing; compare `CALENDAR_FLAGS` and the `params` of `createCalendar` with the guide's `Method create`. Answered, but the client reads `cal_id undefined`: `create` answers something other than the calendar (the raw reply shows what), so `createCalendar` must find the calendar it made in `listCalendars` instead (the check already does). `NOT the one create answered`: create and list name it differently; report both. |
| `Cal.Cal set` takes the whole calendar, every field required, so `renameCalendar` lists first and sends the calendar back with `cal_id`, `original_cal_id`, the new `cal_displayname`, its description, color and eight flags as listed | Yes, with `CHECK_CALENDAR_WRITE`, as the calendar's owner: a `list`, then the `SYNO.Cal.Cal set` block, then `listCalendars shows the new name` | Refused 9009: a field is missing or the list did not carry the flags (the raw `list` reply shows which); look at `renameCalendar` against the guide's `Method set`. Taken and the old name still listed: report both replies. Whether anyone but the owner may rename is still first real use. |
| `Sharing set` takes `cal_share_setting: { DSM_USER: [{ ug_name, cal_privilege }], DSM_GROUP }` (`shareCalendar`), and replaces the whole list, so `users` is everyone, not an addition | That it is taken and read back: yes, with `CHECK_CALENDAR_WRITE` and `CHECK_SHARE_WITH`, which shares the check's calendar RO and reads it again (`… is listed, RO, as set`). Whole-list replace: no, it needs two people | `NOT listed, though set was taken`: either `set` wants another shape (`shareCalendar`) or `get` answers the users elsewhere (`sharingOf`); the two raw `Sharing get` replies say which. Replace or add: share the Household calendar through the app with two people, remove one, then run this with `CHECK_CALENDAR=Household`. If the removed person is still listed under `Sharing get`, `set` adds rather than replaces, and `shareCalendar` must send the difference instead. |
| `Sharing get` answers `cal_share_setting.DSM_USER`, or `DSM_USER` at the top of `data` (`sharingOf`) | Yes: the Sharing block. The fake DSM lets only the owner read a calendar's sharing; if the NAS refuses it for the first calendar, use `CHECK_CALENDAR` to pick one you own | Another place for the user list: change the `setting` line in `sharingOf`. Each user is read as `{ ug_name, cal_privilege }`. |
| `Event get` takes `evt_id`, `cal_id`, `original_cal_id` (`getEvent`) | Yes, if there is an event in the coming week: the Event get block | If it answers 114 or 120, `evt_id` alone may be all it wants: trim the `params` of `getEvent`. |
| `Event list` takes `cal_id_list` (a JSON list of ids), `start`, `end` as epoch seconds, and answers `{ list: [...] }` as the guide shows it (a bare array is read too) (`listEvents`) | Yes: the Event list block | If `cal_id_list` is refused (114 or 120), it is the one parameter to rename in `listEvents`. An empty `[]` for a week with events means the window or the ids were read differently, not that the call worked. |
| `Event create` takes the fields of `eventFields`, with an empty string spelled as the JSON literal `""` (the real NAS refused `color=` sent plainly empty with 9009 and took `color=""`, 2026-11-03), and answers the event with `evt_id`, `dav_etag`, `ical_uid` (`createEvent`, `calEvent`) | Yes, with `CHECK_CALENDAR_WRITE`: `evt_id …, dav_etag …, dtstart … as sent` | Refused 114 or 120: a field of `eventFields` or `EVENT_REQUIRED` is named otherwise, or `tz_id` (this machine's zone, printed in the title) is not one DSM knows. `evt_id undefined`: create answers something other than the event; the remaining event steps are skipped and the calendar's delete takes the event with it. |
| `Event get` answers `dav_etag` and `last_modify_user` (`getEvent`) | Yes, with `CHECK_CALENDAR_WRITE`, for the event the check made | No `dav_etag`: `setEvent` makes no call without one, so the app could change no event; find the field in the raw reply and read it in `calEvent`. No `last_modify_user`: the drift card cannot say who changed an event; find the field and read it in `calEvent`. |
| `Event set` takes the whole event: the fields of `eventFields`, `evt_id`, the current `dav_etag`, and `notify_setting`, `participant`, `location_info` and `attachments` sent back exactly as `get` returned them (`setEvent`, `EVENT_CARRIED`; the real NAS refused a set without `location_info` in its full shape and `attachments` with 9009, 2026-11-03). It answers the event with a **new** `dav_etag` | Yes, with `CHECK_CALENDAR_WRITE`: `dav_etag …: a new one; … one hour later as asked` | `NONE` or `the SAME as before`: the app keeps the etag from `set`'s reply, so it would hold none (and refuse the next change) or a stale one; `setEvent` must `getEvent` after a set. Counted as a failure. |
| A stale etag is refused with 9009, the same code as a parameter error (the real NAS, 2026-11-03); so every refusal of `set` but those in `NOT_AN_ETAG_REFUSAL` (9007, 9017) is settled by reading the event again: an etag that moved is a mismatch, the same etag is a plain refusal, and 9009 on an event that cannot be read is gone (`setEvent`) | Yes, with `CHECK_CALENDAR_WRITE`: the block titled `carrying the OLD dav_etag …: what does a stale etag answer?`. Its raw reply is a list: `set`'s refusal, with its `error.code`, then the `get` `setEvent` makes to see that the etag really moved | See below. |
| `Event delete` takes `evt_id` alone (`deleteEvent`; the real NAS refused it with `cal_id` and `original_cal_id` added, 9009, 2026-11-03); a `get` of a deleted event is refused 9009, which the app takes as gone (`NO_SUCH_EVENT` in `src/calendar.ts`) | Yes, with `CHECK_CALENDAR_WRITE`: `listEvents no longer shows it`, then `refused with code 9009` | Still listed: the delete was not done; look at `deleteEvent`. Another code for the deleted event: set `NO_SUCH_EVENT` in `src/calendar.ts` to it, or the app takes an event deleted on a phone for a failure. Both counted as failures. |
| `Cal.Cal delete` takes `cal_id` alone (the Calendar guide's `Method Delete`). The app deletes no calendar: this is only the check's clean-up | Yes, with `CHECK_CALENDAR_WRITE`: the last calendar block, `answered, and listCalendars no longer shows it` | Refused: the calendar is left, the run says so in its last lines, and you delete it in Synology Calendar. Nothing in the app depends on it. |

**A stale etag.** The real NAS refuses it with 9009 (2026-11-03), the same
code as any parameter error, so the code alone says nothing. `setEvent` takes
every refusal `set` gives as a possible stale etag, **except** the codes in
`NOT_AN_ETAG_REFUSAL` (9007, 9017, in `src/synology.ts`), a dead session, or a
NAS that did not answer, and settles it by fetching the event again: an etag
that moved is a mismatch, the same etag means the refusal stands as it was, and
9009 on an event that can no longer be read means it is gone. If that fetch
fails any other way, the mismatch is reported anyway, just without showing what
changed. 9009 as the stale code is written in `STALE_ETAG_ASSUMED` here, the
comment on `setEvent`, and `ETAG_MISMATCH` in `tools/fake-dsm/server.ts`.

With `CHECK_CALENDAR_WRITE=1` the check makes that write: it reads the event,
moves it with that etag, then writes it again with the etag it read first. The
`the client reads` line of that block says which of these it is:

- `refused with code 9009, as the real NAS did …; the client reads it as
  EtagMismatch`: nothing to change.
- `refused with code 9007` (or 9017) `… is in NOT_AN_ETAG_REFUSAL`: on this
  NAS that code is the stale-etag refusal, and the app would report a stale
  etag as a plain refusal. Remove it from `NOT_AN_ETAG_REFUSAL` in
  `src/synology.ts`, and change 9009 to it in `STALE_ETAG_ASSUMED`,
  `setEvent`'s comment and `ETAG_MISMATCH` in the fake DSM. Counted as a failure.
- `refused with code <n>, NOT the 9009 … not in NOT_AN_ETAG_REFUSAL`: the app
  already takes it as a stale etag; change 9009 to `<n>` in the same three
  places, so the fake answers as this NAS does. Counted as a failure, since
  the NAS differs from the one this was settled on.
- `ACCEPTED`: the NAS does not compare `dav_etag` at all, and the app would
  overwrite an edit made on a phone. Report it before plans are written to a
  shared calendar. Counted as a failure.
- `the client does NOT read it as EtagMismatch`: the code was one the app
  takes as a stale etag, but the `get` that follows (the second raw reply)
  showed the same etag as before, so `setEvent` took the refusal for something
  else; read both raw replies.

Without the check, the same can be tested by hand in the app: open an event in
the app, change the same event in Synology Calendar, then save in the app. "This
event was changed on the NAS since it was last read" is the right answer; "the
NAS refused SYNO.Cal.Event set (code …)" means that code is in
`NOT_AN_ETAG_REFUSAL` and should not be.

**A calendar shared with you: are its ids yours or its owner's?** DSM does not
say whether a calendar shared with someone is listed for them under the
owner's `cal_id` and `original_cal_id` or under ids of their own. The app
matches a listed calendar with the Household one on either id, which covers a
different `cal_id` with the same `original_cal_id`; this settles which it is.

1. Share the Household calendar with a second member: the household's owner
   adds them in the app, which shares it at once if the owner made the
   calendar; otherwise the calendar's maker opens the app once afterwards.
2. Run this check **as the second member**, with `CHECK_CALENDAR=Household`.
   The line `Using the calendar "Household" (cal_id …, original_cal_id …)` is
   their view. (`Sharing get` is refused for them: only the owner may ask.)
3. Compare it with the log's record of the calendar:
   `grep calendar.household /data/households/<id>/events.jsonl` on the server.

- Both ids the same: nothing to do.
- `cal_id` differs and `original_cal_id` matches: the app still recognises it.
  Note it for the plan events, which are written with the acting member's ids.
- Both differ: the app cannot tell it is the Household calendar for them, and
  shows it as an ordinary calendar. Matching needs another key; report it
  before plans are written to a shared calendar.

### Contacts

Synology does not document any of this, so every name is a guess; the replies
here are the first evidence.

| Assumed | Seen here? | If the NAS disagrees |
|---|---|---|
| The API version is asked of the NAS (1 if the range holds it, else the lowest offered) | Yes: the version table shows the range | If DSM answers 104 for the version, the app forgets it and asks again once; report the range shown. |
| Methods `list` on `Addressbook` and `list`, `get`, `create` on `Contact` (`get` takes `id`; `list` takes `addressbook_id`, `limit`, `offset`) | `list` always; `create` with `CHECK_CONTACTS_WRITE`; `get` no | 102/103 on the others the first time the app uses them. Change the `method` or `params` in `getContact`, `createContact`, `listContacts`. |
| `Addressbook list` answers `{ addressbook: [...], total }`, rows with `id` and `name` (`listAddressbooks`); `{ addressbooks }` and a bare array are read too | Yes. Confirmed on the real NAS (2026-11-03): the singular key, rows also carrying `shared_from`, `shared_with`, `type`, `mode`, which the app does not use | Another key: add it to the `listRows` call in `listAddressbooks`. |
| `Contact list` answers `{ contact: [...], offset }` (`listContacts`); `{ contacts }` and a bare array are read too | Yes. Confirmed on the real NAS (2026-11-03): the singular key, rows carrying `full_name`, `primary_mail`, `primary_tel`, `company` among others | Another key: add it to the `listRows` call in `listContacts`. |
| A contact has `id`, `addressbook_id`, `full_name`, `org`; phones under `tel`, `phone` or `phones`; emails under `email` or `emails`, each a string, a list of strings, or a list of `{ value }` (`contact()`) | Yes, if there is a contact: the `the client reads` line says how many phones and emails it found. If it found none for a contact that has them, the field name differs | Add the real field name to the two lists in `contact()`. |
| `get` and `create` answer the contact itself, or `{ contact }` (`contactReply`) | `create` with `CHECK_CONTACTS_WRITE`: the `SYNO.Contacts.Contact create` block shows the whole reply and `id …, full_name "Planner Check"`; `get` no | A refusal naming "no contact": change `contactReply` to the place the raw reply keeps it. |
| `create` takes `addressbook_id`, `full_name`, and `email` as a list of `{ value }` (`createContact`); the contact is then found by `searchContacts` | Yes, with `CHECK_CONTACTS_WRITE`: `emails ["planner-check@example.com"]` on the create line, and `searchContacts finds it`. The list block prints only the rows called `Planner Check`, never the rest of the address book | `The email is not read back`: the list rows printed under it show how the NAS kept the address; if they have none, `create` wants it otherwise (change the line in `createContact` that builds `email`, and `tel` the same way); if they have it under another name, add that name to `contact()`. Not found by `searchContacts`: the contact went to another address book, or `full_name` is not what DSM keeps the name in. |
| `Contact delete` takes `id`. The app deletes no contact: this is only the check's clean-up, and both the method and the parameter are guesses | Yes, with `CHECK_CONTACTS_WRITE`: `answered, and searchContacts no longer finds it` | Refused (103 no such method, 114/120 a parameter named otherwise): the contact is left, the run says so in its last lines, and you delete it in Synology Contacts. Nothing in the app depends on it. |

### File Station

One read that needs no path (`list_share`) is always made. Read-only checks
exist for a folder list and a download if you give them a path (`CHECK_FOLDER`,
`CHECK_FILE`). Create-folder and upload are writes and are not run, unless
`CHECK_DRIVE_WRITE=1`: create-folder for `.planner-check` (see *Synology
Drive*), and File Station's own upload of `fs-upload.md` into it, its download,
and a list of the folder, at the end of the Drive section.

| Line | Should show | If it does not |
|---|---|---|
| `SYNO.FileStation.Upload upload …/.planner-check/fs-upload.md, overwrite true` | `success: true`, and `taken: <n> bytes sent, sha256 …` | 119 with a sid that works elsewhere: DSM wants the `Cookie: id=` header on upload too; send it as `downloadFile` does. 408: `path` wants to be JSON-quoted. 414: `overwrite` was not taken as sent. |
| `SYNO.FileStation.Download download …/fs-upload.md` | The size, the content-type, and `the bytes read back are the bytes uploaded (sha256 equal)` | `DIFFER`: File Station kept other bytes than `uploadFile` sent; compare its multipart body with the file on the NAS. Counted as a failure. |
| `SYNO.FileStation.List list …/.planner-check` | `fs-upload.md is listed, <n> bytes, as uploaded` | Not listed, or at another size: the upload went elsewhere, or was skipped. Counted as a failure. |

What the client assumes of File Station in general:

| Assumed | Seen here? | If the NAS disagrees |
|---|---|---|
| The sid from signing in with `session=Calendar` (`checkWithDsm` in `src/auth.ts`) is accepted by File Station and Contacts as well as Calendar | Yes: the `list_share` block and the two Contacts blocks, which are always run | File Station or Contacts answers 105/119 while Calendar works → the session name scopes the sid. Change the `session` value in `checkWithDsm` and run the check again until all three answer. |
| Path parameters are plain strings, not JSON-quoted: `folder_path` and `name` on create-folder, `folder_path` on list, `path` on download and on the upload form (`createFolder`, `listFolder`, `downloadFile`, `uploadFile`) | List and download, with the two env vars; all four with `CHECK_DRIVE_WRITE`. A path that exists but is answered 408 is the symptom | `JSON.stringify` the value in the `params` of the call that fails. |
| Where File Station takes a list of paths it splits on commas, so a comma in a name or path is refused before any call (`noComma`) | No | This only costs anything if a folder or file name has a comma. If File Station accepts such a single path, remove the `noComma` calls. |
| Upload reads the session id from a `_sid` multipart part (`uploadFile`) | Yes, with `CHECK_DRIVE_WRITE`: the upload block above | Upload answering 119 with a sid that works elsewhere means DSM wants the `Cookie: id=` header there too; send the header as `downloadFile` does. |
| Download reads the session id from a `Cookie: id=` header, not `_sid` in the query (`downloadFile`) | Yes, with `CHECK_FILE` | A 119 on download only: DSM wants `_sid` instead; add it to the query, knowing that puts the sid in the NAS's access log. |

### Synology Drive

Drive is a door of its own: ordinary REST under `/api/SynologyDrive/default/v2`,
not `entry.cgi`, with the session id in the `id` cookie. It needs `PLANNER_ROOT`
to be set, and the share to be a Team Folder (DEPLOY.md, *Documents in Synology
Drive*). The section starts with a line saying how File Station and Drive name
the same root (`/Planner` and `/team-folders/Planner`). The write steps run only
with `CHECK_DRIVE_WRITE=1`; the others are reads.

| Line | Should show | If it does not |
|---|---|---|
| `SYNO.API.Info query` for `SYNO.SynologyDrive.Files` | A range, with the sentence that the copied spec's Files methods are `x-syno-version` 11. An empty reply is not a failure: Drive's REST door may not be listed in `SYNO.API.Info` at all, and the lines below are what show whether it answers | A range that does not include 11 means the NAS's Drive is not the version the client was written from; report the range. |
| `Drive team-folder list` | `"Planner"` (the first segment of `PLANNER_ROOT`) listed among the Team Folders | `NOT listed`: the share is not a Team Folder yet, which is a setting in Synology Drive Admin Console, not a code change (DEPLOY.md). An empty `items` for a share that is one means the account has no access to it. A reply that is not `items` of `{ name }`: change the unwrap in `listTeamFolders`. |
| `Drive files get` on the root | `change_id` and `max_id` of the Team Folder, `type dir` | 1003 (no such file) on a Team Folder that is listed: the path form is wrong, or its case differs from the folder's as Drive shows it (paths are case-sensitive: `/Family/planner` is 1003 where the folder is `Planner`), so compare `path` in the team-folder reply with `teamFolderPath` in `src/drive.ts`. |
| `Drive files get` on `.planner-check-missing` | `error code 1003, which the client takes as no such file`; confirmed on the real NAS (2026-11-03) | Another code: put it in `DRIVE_NO_SUCH_FILE` in `src/drive.ts`. The client takes only the codes in that set as "no such file" (`isNoSuchFile`); any other refusal is the NAS failing. |
| `File Station create folder` (with `CHECK_DRIVE_WRITE`) | Created, or already there | This is File Station's own create, so a refusal is the account having no Read/Write on the share. Whether Drive's upload would have made the missing folder itself is **not** tested here, because the folder exists by now; the app makes its folders through File Station either way, so nothing depends on the answer. |
| `Drive folder cursor` before and after the two writes | `cursor` is `change_id.max_id` of the folder (`listChanges`); the second is **not equal** to the first | `NOT moved`: neither counter moves when a file under the folder changes, so the app would never notice a document edited in Synology Drive. Change what `listChanges` uses as the cursor (a counter from the file rows, or all their `version_id`s joined). The spec does not say which counter moves, which is why both are in the cursor. |
| `Drive files upload 1` and `2` | The same `permanent_link`, a higher `version_id`, a different `hash`; the line `across the two writes` says so | A different link or a lower version means `conflict_action=version` replaced the file instead of versioning it: look at `writeFile` in `src/drive.ts`. The same hash for different text means Drive does not return the new hash on upload. |
| `Drive files get, by the permanent link the upload answered` | `the GET's hash equals the upload's` | `DIFFERS`: Drive's upload answers a hash that its own `files` GET does not, so the app would take every page it wrote for an edit. Set the pre-write check (`writeOne` in `src/pages.ts`) and the look (`lookAtPages` in `src/drift.ts`) to compare the GET's hash only, recording a GET's hash after each write. Counted as a failure. |
| `Drive files download, by permanent link` | `the text read back is the second write` | A refusal on a link that has just come back from an upload: `byLink` (`link:` plus the link) is not the form Drive takes in place of a path. |
| `Drive files search` | `check.md` is found, with a `content_snippet` that contains the token | Found without a snippet, or not found: Universal Search is not indexing the share (or has not caught up; wait a few minutes and run it again). Until it does, the search tool finds names only. This line is said, not failed: the run still exits 0 on it. DEPLOY.md says how to turn it on. |
| `the hit's display_path ... starts with the location asked` (when check.md is found) | `starts`. Confirmed on the real NAS (2026-11-03): `display_path` is `/team-folders/<team>/…`, while `path` is relative to the Team Folder (`/<folder>/.planner-check/check.md`), so the app compares `display_path` only, here, in `inHousehold` and in `toDocRef` | `does NOT start`: Drive answers a hit's `display_path` in another form than the `location` it was asked with, so the search tool's household filter (`fromDrive` in `src/search.ts`) drops every hit. Set the prefix there to match the form printed. Counted as a failure. |
| `Drive folder cursor of ".planner-check", after writing ".../sub/check.md"` | `moved from` | `NOT moved from`: a folder's cursor does not move for a change two levels down, which is where plan pages are (`<household>/<plan>/plan.md`). Nothing breaks: such edits are seen only by the hourly full look (`PAGES_FULL_EVERY_MS` in `src/drift.ts`), not the ten-minute one. Said, not failed. |

**The session name.** A Drive line that is refused with 105, or with 119 while
the Calendar lines worked, ends the section with *the sid issued with
`session=Calendar` does not reach Drive*. It is the same cause as File Station
and Contacts answering 105/119 (see the File Station table above): change the
`session` value in `checkWithDsm` in `src/auth.ts` until Calendar, File Station
and Drive all answer.

### What the configuration design guessed

The Connectors and Settings pages rest on a handful of calls whose names,
shapes or answers only the real NAS can confirm. This section of the output
starts at `── What the configuration design guessed ──`. Each probe prints the
raw reply (a refusal is printed as data, not as a failure, where it is the
expected answer) and a line saying what the app makes of it. The sentence names
the constant to change when it is not what the app assumes. Probes 4 (the second
half), 5 and 6 need `CHECK_DRIVE_WRITE=1` and `PLANNER_ROOT`; probe 3 needs
`PLANNER_ROOT` only to know which Team Folder to ask about (it takes the first
one listed without it); probes 1, 2 and 7 need neither.

| Probe | Should show | If it does not |
|---|---|---|
| **1.** `SYNO.Core.Group.Member list` (`group=administrators`) as `CHECK_USER` and as the administrator | For an administrator: `{ users: [{ name }] }` with their name in it, and `isAdministrator(...) is true`. For a member who is not one: `refused 105`. A `CHECK_USER` that is answered means either it is an administrator or DSM lets any member ask | `REFUSED` to the administrator (102/103 no such API or method, 114/120 a wrong parameter) or a shape that is not `{ users: [{ name }] }` (the line says what it is): change `ADMIN_GROUP_CALL` in `src/accounts.ts`. `namesIn` returns nobody **silently** on a shape it does not know, so an administrator would be taken for an ordinary member: read the raw reply. |
| **2.** `SYNO.Core.User list` as both | The same shape, with every account's `name`; the member is refused with the code printed (105 is what the app treats as "not allowed") | As above, for `ACCOUNTS_CALL`. A refusal code other than 105 for the member is printed: the app treats only 105 as the quiet refusal. |
| **3.** `GET team-folder` and `GET team-folder/members` as both | `capabilities` with `can_write` on each Team Folder, `PLANNER_ROOT`'s listed; `team_id` answered to the double-quoted form (the app sends `team_id="…"`, as the spec's `double-quoted-string` has it); the role names; whether the member is allowed to ask for members at all | No `can_write` anywhere: every Team Folder would be read-only to the app, since `teamFolders` (`src/drive.ts`) reads `capabilities.can_write`. `team_id` answered to the plain form only: change `teamFolderMembers` in `src/drive.ts` (counted as a failure). Members refused to the member (105) and not to the administrator: the picker then says the members are *not known*, which is the designed fall-back, not a fault. A read-only role named other than `viewer`: change the test in `cannotWrite` (`src/folders.ts`); to see that role, run the check as a member who has only Read on the share. |
| **4.** `POST files/list` with `filter: { type: ['dir'] }` on the Team Folder; `files/search` with `location` at a folder that does not exist; `POST files type=folder` for `.planner-check/made` twice | Only folders in the list; the search answers an error (its code is printed) or an empty list: either is "not known" to the picker's index check, a list with hits would not be; the first make is made (or refused if an earlier run made it), the second is refused with **1022**, confirmed on the real NAS (2026-11-03; not 1003, which is "no such file") | A file in the list: the filter is ignored and `listFolders` (`src/drive.ts`) must drop files itself. Hits from a folder that is not there: `indexed` (`src/folders.ts`) would count them. A second make that is answered: `makeFolder` reuses a taken name silently. A refusal code other than 1022: set it in `DRIVE_NAME_TAKEN` (`src/drive.ts`); counted as a failure. |
| **5.** `POST files/move` of `check.md` by `link:` into `.planner-check/made` (Drive's reply prints whole), back, into a second Team Folder (`CHECK_SECOND_TEAM`), and onto a name already taken | The task id, the milliseconds until `getFile(<new path>)` finds the file (within `MOVE_WAIT_MS`, 3000; about 100 ms on the real NAS), `permanent_link` unchanged (confirmed on the real NAS, 2026-11-03), and a `display_path` that starts with `/team-folders/<team>/` (what `inHousehold` in `src/docs.ts` relies on; the line for a file reached by its link says it too; `path` is relative to the Team Folder and is printed only). The move onto a taken name is **accepted** (its task id, as the real NAS answered on 2026-11-03), and 3 seconds later the file already there is unchanged and the source still in its folder | Later than `MOVE_WAIT_MS`: a pass leaves the file for the next look; raise `MOVE_WAIT_MS` in `src/moves.ts`. A file never found: counted as a failure (the move may need longer, or Drive moved it elsewhere). A `display_path` that does not start with `/team-folders/<team>/`: `inHousehold` would take every file for another household's; counted as a failure. A changed `permanent_link`: `moveDoc` (`src/moves.ts`) finds a moved file by its link at the new path and takes another link there for a taken name, so it must change; counted as a failure. A taken name that is *refused* at once instead: the app still says "taken" if the code is in `DRIVE_NAME_TAKEN`. A taken name that *overwrote* the file there: counted as a failure. |
| **6.** File Station `CopyMove` of a file under `.planner-check` into `made` (the `start` and the `status` replies both print whole, with `skipstatus.status`, `found_file_num` and `total` named), then File Station's own `list` of both folders; again onto a name that is taken. `SYNO.FileStation.CopyMove`'s version range is in the version table at the top | Confirmed on the real NAS (2026-11-03): `finished: true` with `skipstatus.status: "none"` (and `found_file_num` 0, `total` 0, `path` "" even though the file moved), and File Station's list shows the file in `made` and gone from where it was. For the taken name: `finished: true` with `skipstatus.status: "all"`, the file in `made` unchanged and the source still in its folder; `moveOnNas` says that as 414, a taken name. Drive is not asked: on the real NAS it had not indexed the moved file 9 seconds later (1003), so `moveCard` confirms through File Station's lists only | The list not showing the file in `made`, or still showing it where it was, after `finished: true`: counted as a failure; look at `moveOnNas` (`src/synology.ts`) and `moveCard` (`src/moves.ts`). Another `skipstatus.status` for the taken name: change the test in `moveOnNas`. A file on a taken name changed in size: counted as a failure. |
| **7.** `SYNO.API.Info query` for `SYNO.Contacts.Contact` and `SYNO.Contacts.Addressbook` with no sid | A `minVersion` and `maxVersion` for each, and the version `contactsVersionNow` asks for | No range without a session: `contactsVersionNow` (`src/synology.ts`) would call at 1 and keep nothing (counted as a failure), and the question must be asked with a sid. |

## Against the stand-in

`npm run fake-dsm` answers all of this with the client's own guesses, so
running the check against it (`DSM_URL=http://127.0.0.1:<DSM_PORT>`, one of
`FAKE_DSM_ACCOUNTS`) proves only that the script and the client agree. Only the
real NAS can say whether DSM does. Every write flag runs against it and leaves
nothing but `.planner-check` in its temporary directory: the fake answers the
two clean-up deletes (`SYNO.Cal.Cal delete`, `SYNO.Contacts.Contact delete`)
with its own guesses, which the real NAS has not yet confirmed.
