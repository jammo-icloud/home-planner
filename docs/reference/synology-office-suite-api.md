# Synology Office Suite APIs, as they bear on Home Planner

Captured 2026-11-01 from two official sources:

- **Synology Office Suite WebAPI portal**, https://office-suite-api.synology.com (Synology Account sign-in
  for the pages; the OpenAPI files under `/specs/` are public). Covers Drive, Spreadsheet, MailPlus and
  Calendar as REST APIs. Every one except Spreadsheet needs **DSM 7.2.2 nano3 or above** and a DSM `sid`
  carried as the cookie `id=<sid>`.
- **Calendar API Guide** (PDF, "Last updated Jun 28, 2024", Synology Calendar 2.5.0+), the legacy
  `/webapi/entry.cgi` form the app calls today:
  https://global.download.synology.com/download/Document/Software/DeveloperGuide/Package/Calendar/All/enu/Calendar_API_Guide_enu.pdf

The OpenAPI files are public, at `https://office-suite-api.synology.com/specs/<Package>/openapi_latest.json`:

- Drive: https://office-suite-api.synology.com/specs/Synology-Drive/openapi_latest.json (v2 pinned:
  https://office-suite-api.synology.com/specs/Synology-Drive/openapi_v2.json)
- Calendar: https://office-suite-api.synology.com/specs/Synology-Calendar/openapi_latest.json
- MailPlus: https://office-suite-api.synology.com/specs/Synology-MailPlus/openapi_latest.json
- Spreadsheet: https://office-suite-api.synology.com/specs/Synology-Spreadsheet/openapi_latest.json

| Package | Spec | Min package | Auth | Endpoints |
|---|---|---|---|---|
| Synology Drive | `openapi_v2` (v1 also published) | 4.0.0 (v1: 3.5.2) | DSM sid cookie | 40 paths |
| Synology Calendar | `openapi_v1` | 2.5.3 | DSM sid cookie | 17 paths |
| Synology MailPlus | `openapi_v1` | 3.3.1 | DSM sid cookie | 9 paths |
| Synology Spreadsheet | `openapi_latest` (3.4.1) | Office 3.7.0 + separate `synology/spreadsheet-api` container | JWT from `/spreadsheets/authorize`, 28 days | 17 paths |

Not on the portal and still without an official guide: **Synology Contacts** (`SYNO.Contacts.*`, which the
app calls and the design doc marks unofficial) and **calendar sharing** (`SYNO.Cal.Sharing`, which the app
calls to share the Household calendar; neither the PDF nor the REST spec documents it). File Station has
its own older guide (`Synology_File_Station_API_Guide.pdf` on the download server).

## Synology Drive v2

Base path `/api/SynologyDrive/default/v2/`. Sign in with `POST login` (`account`, `passwd`, `format: "sid"`).

**Addressing.** Every file call takes `path` in one of seven forms: `link:<permanent_link>`, `id:<file_id>`,
`id:<file_id>/<basename>`, `/mydrive/<relative>`, `/team-folders/<name>/<relative>`,
`/views/<view_id>/<relative>`, `/volumes/<absolute>`. A Team Folder is a DSM shared folder enabled for
Drive (`admin/team-folder`), so the Planner share can be one and keep its File Station path too.

**File metadata** (`GET files`, and every list): `file_id`, `permanent_link` (UUID), `parent_id`, `name`,
`path`, `display_path`, `dsm_path`, `type` (file/dir), `content_type` (dir/document/image/audio/video/file),
`size`, `hash` (content hash), `version_id`, `revisions` (count), `change_id` and `max_id` (change counters
under a folder), `sync_id`, `created_time`/`modified_time`/`change_time`/`access_time`, `owner`,
`shared`, `shared_with[]`, `starred`, `labels[]`, `removed`, `encrypted`, `capabilities{can_read, can_write,
can_share, can_delete, can_comment, ...}`, and two free-form objects: **`properties`** and
**`app_properties`**. The last two are schema-less JSON, but they appear **only in responses**: no write in
the v2 spec (`POST files`, `PUT files`, `PUT files/upload`) accepts them, so an application cannot keep its
own metadata on a file this way. There is also no last-modified-by field; `owner` is who created the file.
`conflict_action: version` is offered only by the multipart `PUT files/upload`, not by the base64 `POST
files`. (Corrected 2026-11-02 after checking the request schemas.)

**Reading and writing.**
- `POST files` creates a file from base64 content up to 1 MB (`type`, `path`, `conflict_action`,
  optional `permanent_link`, `created_time`, `modified_time`, labels); `PUT files/upload` is multipart for
  anything larger. `conflict_action` is one of `overwrite`, `autorename`, `stop`, `version`, `skip`, and
  `version` writes a new revision rather than a copy.
- `PUT files` updates metadata (name, starred, labels, times, removed, encrypted). `POST files/download`
  streams a file or a zip of several. `copy`, `move`, `delete`, `ancestors`, `thumbnail`, `convert-office`.
- `POST files/list` lists a folder with filters (`extensions`, `type`, `label_id`, `starred`) and paging.
- `POST files/search` goes through **Universal Search**: `keyword`, `file_type`, `location` (mydrive /
  team folders), `labels`, owner, size and date ranges, and `content_snippet: true` to get the matching
  passage back. This is server-side full text over file contents, not only names.
- Labels are first-class (`labels` CRUD, shared labels with invitees and permissions, `files/label` to
  tag). `starred`, `recent`, `shared-with-me`, `shared-with-others` are ready-made views.
- Sharing links and permissions (`sharing/create-link`, `sharing`, `sharing/permissions`), file requests
  (an upload-only link for outsiders), team-folder membership, and an admin console surface for enabling
  team folders and version rotation (`rotate_cnt` 0–32, `rotate_days`, `rotate_policy`).

**Webhooks.** `POST webhooks` subscribes to file-change notifications for an `app_id`: `type` is `url`
(Drive calls your URL) or `shared_library` (a `.so` on the NAS), with an optional `token` appended for
validation and `options.filter_file_ext` / `options.filter_events` (`"TrueEvent"` or `"FakeEvent"`). The
spec documents the subscription calls but **not the notification payload**, so the body Drive posts has
to be observed on first use.

## Synology Calendar

Two shapes of the same service.

**Legacy WebAPI** (the PDF; what `api/src/synology.ts` calls today at `CAL_VERSION = 5`,
`EVENT_VERSION = 5`): `SYNO.Cal.Cal` (list/create/set/delete, version 5), `SYNO.Cal.Event`
(create/set/subevent_set/invite_event_set/invite_subevent_set/list/get/delete/set_exdate/
set_personal_property, version 5), `SYNO.Cal.Todo`, `SYNO.Cal.Setting`, `SYNO.Cal.Timezone`,
`SYNO.Cal.Contact`. Requests go to `/webapi/entry.cgi`, `_sid` as parameter or `id` cookie, and
`X-SYNO-TOKEN` from the login when CSRF is on. Common error codes 100–160 and 400–599; Calendar's own
9006 database, 9007 permission, 9009 parameter, 9011 system, 9014 ICS handling, 9017 update in progress.

**REST v1** (portal): the same operations as resources under `/api/Calendar/default/v1/`: `cal`
(create/modify/delete/get, `cal/list`, `cal/export` returns ICS), `event` (create/modify/delete/get,
`event/list`, `event/subevent`, `event/invite-event`, `event/invite-subevent`, `event/exdate`,
`event/personal-property`), `task` (create/update/delete/get, `task/list`), `setting`, `timezone`,
`contact`. Same field names and the same object definitions.

**What an event carries** (`evt_obj`): `evt_id`, `cal_id`, `original_cal_id`, `ical_uid`, **`dav_etag`**,
`create_time`, `modify_time`, `last_modify_user`, `owner_id`/`owner_name`, `summary`, `description`,
`color`, `is_all_day`, `tz_id`, `dtstart`/`dtend` (epoch) plus `dtstart_string`/`dtend_string`
(`YYYYMMDD` or `YYYYMMDDThhmmss`), `is_repeat_evt` + `repeat_setting` (day/week/month/year, interval,
weekday[], week_start_day, month_option, end{never|count|date}), `notify_setting[]` (VALARM: action,
description, duration{related,minutes} or datetime{utc_seconds}, ical_extra_info[]), `participant[]`
(type dsm|email, status, role, user_name, email), `location_info` (name, address, map_type, place_id,
gps), `attachments[]` (Synology share-link uploads or ICS ATTACH), `extra_info` (main event dates and
`repeat_index` for an occurrence), `personal_property{is_visible}`, `from_syno_app_url{app, msg_id}`, and
`evt_ical`, the full ICS text. **Modify requires the current `dav_etag`**; a stale one is how "someone
else changed it" is reported, which is what the app's drift detection already leans on.

**Tasks** (`task_obj` / `SYNO.Cal.Todo`): `summary`, `description`, optional `dtstart` and `due`
(`has_start_time`, `has_end_time`), `percent_complete` 0 or 100, `priority_order`, alarms, the same
`dav_etag`, in a task list (`cal_type: "todo"`). A plan with a due date maps onto this shape directly,
with the title, body, due and done state all native to Calendar.

**Listing** (`event/list`): by `cal_id_list`, `start`/`end`, `evt_color_list`, `keyword` (summary,
description, location), `limit`, and the starred/own/invited filters. There is **no "changed since"
cursor and no push**: finding what moved means listing a window and comparing `dav_etag` or
`modify_time`, as `drift.ts` does now.

**Gaps that matter here.** No sharing endpoint in either document, so the Household calendar share the
app makes stays on the undocumented `SYNO.Cal.Sharing` and should stay guarded by `synology:check`.
No webhooks. Guest participants exist only as `email` participants on an event.

## Synology MailPlus v1

`/api/MailClient/default/v1/`: `drafts/send` sends a message (`from`, `to[]`, `cc[]`, `bcc[]`,
`subject`, `body`, `is_plain`, attachments, or a saved draft `id`); `mailboxes`, `labels` and `filters`
each have get/create/set/delete/list. No read or search over messages in this version. Relevant only if the
NAS runs MailPlus Server: it would let booking mail go out through DSM's own session instead of the five
`SMTP_*` settings.

## Synology Spreadsheet 3.4.1

Not part of the Office package: a separate `synology/spreadsheet-api` container that proxies to DSM, one
worker per user per sheet, discouraged on the same DSM as Office. `GET/PUT values/{range}`, `append`,
styles, `sheet/add`, CSV export. Heavy for what it gives this app; noted for completeness only.

## What this changes for the storage discussion

1. **Drive, not File Station, is the right home for documents.** Uploading plans and briefings as markdown
   into a Team Folder gives each file a stable `file_id` and `permanent_link`, a content `hash`,
   `version_id` with server-kept revisions, `change_id` for cheap "did anything move" checks, and
   Universal Search with content snippets. Structured fields live in the file's frontmatter, since
   `app_properties` cannot be written and labels would be a second place to keep state (the storage design,
   `docs/superpowers/specs/2026-11-01-storage-design.md`, rules both out). Webhooks remove the need to poll
   for edits made from Synology Drive on a phone, once the payload is observed.
2. **Calendar tasks are a native shape for dated plans.** Title, body, due, done and an etag are all there.
   The things Calendar cannot hold stay in the log: the reason on a change, asks between members,
   checklist items, envelopes and the per-member audit.
3. **Conflict detection stays etag-based everywhere.** Calendar `dav_etag`, Drive `hash`/`version_id`.
   Neither service offers a change feed, so the log remains the only place with an ordered history.
4. **The two undocumented calls stay fenced.** Calendar sharing and Contacts are still outside any guide;
   the first-real-use check in `DEPLOY.md` remains the contract for them.
