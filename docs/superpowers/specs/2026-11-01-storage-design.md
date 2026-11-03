# Storage: the log for decisions, Drive for documents, Synology for the rest

Status: design, for review. Brainstormed with the owner on 2026-11-01.
Companion to `2026-10-28-home-planner-design.md`, whose log, scopes, effect
stage and Synology clients it builds on. Nothing here changes what a member
sees; it changes where what they see is kept.

## Intent

The planner was built on one deliberate bet: a single append-only log per
household, replayed into memory, with Synology holding the things Synology is
good at (dates, people, files, identity). The bet paid: backup is one file,
restore is partial by scope, every change carries a reason and an author, and
only four modules know the disk exists. The owner's question was whether the
same shape still fits now that the log is about to fill with prose rather than
decisions. His words: *"Calendar events are already individually usable items
… with a solid store surface on the Synology. I'm thinking that Plans and
today briefings should actually be markdown files with YAML frontmatter … we
might want to consider a KV store … we will probably want some kind of vector
index for cosine matching items, and as the list of documents grow, that sort
of indexable tool would be very valuable."*

This document sorts everything the planner holds into three tiers, says which
tier each thing belongs to and why, and names Synology Drive as the home for
the document tier. It was written after reading Synology's published Office
Suite APIs (`docs/reference/synology-office-suite-api.md`), which changed one
earlier assumption: documents should go into **Drive**, not a bind-mounted
share, because Drive gives each file a stable id, a content hash, versions,
labels, full-text search and change notifications that the app would otherwise
have to build.

## The three tiers

| Tier | What | Where | Backed up? |
|---|---|---|---|
| **Decisions** | Anything with a reason, an author, an approval, or an invariant another thing depends on | The per-household JSONL log, as today | Yes: the log is the record |
| **Documents** | Prose that is written once and read many times, or that a person would want to open in another app | Synology Drive, a Team Folder on the Planner share, as markdown with YAML frontmatter | Yes, by Synology, with the rest of the share |
| **Derived** | Anything rebuildable from the two above | RAM, rebuilt on start; an index on local disk if one is ever needed | Never |

The test for the first two: **if losing it would lose a decision or break an
invariant, it is a decision; if losing it would lose words, it is a
document.** A plan's due date is a decision (it has a reason, a calendar event
hangs off it). A briefing is a document (it is a rendering of a day; the
next day has another). A member's note to the other member is a decision (it
is part of why something was decided, and the thread design says the
conversation is part of the record). Claude's research answer is a document
(long, as-of, superseded by the next ask), while the proposals it made are
decisions.

The planner's **Synology stores**, unchanged in role:

- **DSM accounts** hold identity. The app has no user table.
- **Synology Calendar** holds dates: the Household calendar, due markers,
  blocks, appointments, bookings. The log holds only the link (`cal_id`,
  `evt_id`, `ical_uid`, `dav_etag`) and the reason.
- **Synology Contacts** holds people. The log holds the link.
- **Synology Drive** (new in this role) holds documents and, as it already
  does under the name File Station, attachments. The log holds the link.

## Goals

1. **The log stops growing with prose.** Briefings and Claude's answers leave
   the log; the log keeps a pointer and a one-line headline. Plans stay in the
   log and gain a readable page beside their files.
2. **A member can open the household's documents without the planner.** In
   Synology Drive on a phone, in Finder over SMB, in any markdown editor: a
   folder per household, a page per plan, a page per day.
3. **Search that is one tool call.** A `search` tool for Claude and a search
   box for members that find plans, briefings, answers and attachments by
   words in them, with the matching passage, scoped to the household.
4. **Nothing is decided outside the log.** A document can be read, rendered,
   indexed and even edited elsewhere, but every change to a plan is still a
   log event with an author and a reason, and an edit made in Drive comes back
   to Today as a card, like calendar drift does.
5. **Backup stays one sentence.** Today: back up the log. After this: back up
   the log and the Planner share, both of which Synology already backs up if
   the owner has it backing up anything.

## Non-goals

- **No SQLite, no KV store, no Postgres, no Redis.** Not now. The log plus
  RAM *is* the key-value store for one household; a second writer is the only
  thing that would call for Postgres, and there is none. `node:sqlite` is
  present in Node 26 with no dependency and is named below as the shape if a
  derived index ever needs to survive a restart; it is not built here.
- **No embeddings and no vector index**, until keyword search demonstrably
  misses. The trigger and the shape are written down under *Later*.
- **No rewrite of existing logs.** Briefings already in a log stay there and
  still render. Only new ones go to Drive.
- **No move of attachments.** They are already on the same share, at paths the
  log names. They become visible in Drive the moment the share is a Team
  Folder; their upload path stays File Station.
- **No MailPlus, no Spreadsheet.** Noted in the reference doc; not this design.
- **No two-way editing of plans in the first build.** The plan page is a
  projection first; edits in Drive become cards in a later phase, below.

## Anti-goals — failures even if it technically works

- **A decision that lives only in a file.** If a due date, a reason, an
  approval or a checklist state can be found in Drive but not in the log, the
  log is no longer the record and restore is no longer whole.
- **A pointer to nothing.** A `thread.briefing` whose document write failed,
  or a plan page recorded before Drive confirmed it. The effect-first rule
  from the planner design applies: write the file, then append the event that
  names it; if the write fails, fall back to the inline body and say nothing
  to the member.
- **Documents nobody can read without the planner.** Frontmatter is for the
  app; the body is for a person. A page that is a JSON dump with a `.md`
  extension misses the point.
- **A sid on disk.** Drive needs a DSM session on every call, exactly like
  Calendar. The session stays in the member's in-memory app session. No
  service account, no stored password, no token file.
- **Search that crosses households.** A member's Drive search must be scoped
  to their household's folder on every call. The Team Folder is shared by
  every member of every household on this NAS, so the scope is the app's job,
  not Drive's.
- **A document written as one member being unreadable by another.** Every
  member has read-write on the Team Folder; a file's Drive owner is whoever
  wrote it. If a member leaves and their account is removed, their files must
  still open for the others. Team Folders keep files when a member leaves;
  My Drive does not. This is why it is a Team Folder and never a home folder.

## Constraints

Unchanged from the project: append-only JSONL log per household, replayed into
state; every edit that moves money or changes a plan carries a reason; Node 26
with type stripping and no build step; dependency-light API; the Anthropic key
is optional and every Claude feature has a plain fallback; the DSM `sid` is
kept in memory only, for the life of the member's app session; external
effects run first and the log records last.

New here:

- **Synology Drive 4.0.0 or later and DSM 7.2.2 nano3 or later** on the NAS,
  for the v2 REST API at `/api/SynologyDrive/default/v2/`, authenticated with
  the member's DSM `sid` as the cookie `id=<sid>`. The same `sid` the app holds
  for Calendar is reused; nothing new is asked of the member at sign-in. The
  first-real-use check (`npm run synology:check`) grows a Drive section and
  confirms the version before the first call.
- **The Planner share is a Team Folder.** `PLANNER_ROOT` keeps its meaning (the
  shared folder, as DSM names it, e.g. `/Planner`) and gains one deploy step:
  enable it as a Team Folder in Synology Drive Admin Console. Drive then
  addresses the same files as `/team-folders/Planner/<household>/…`, and File
  Station keeps addressing them as `/Planner/<household>/…`. One share, two
  doors, the same bytes. If the share is not a Team Folder, documents fall
  back to the log inline and Settings says why, the same way attachments say
  they are off without a root.
- **Drive's file metadata is the contract.** From the published v2 spec: every
  file has `file_id`, `permanent_link`, `hash`, `version_id`, `revisions`,
  `change_id`, `modified_time`, `owner`, `labels[]` and `capabilities{}`. Two
  free-form objects, `properties` and `app_properties`, appear in responses
  only: **no write in the spec accepts them**, so the app cannot store its own
  metadata on a file and does not try. `PUT files/upload` (multipart) is the
  write the app uses for every document, because it is the one that takes
  `conflict_action: version`; `POST files` (base64) takes only `overwrite |
  autorename | stop`. `POST files/search` runs Universal Search with
  `keyword`, `location`, `labels` and `content_snippet: true`. `POST webhooks`
  subscribes a URL to changes under an `app_id`, payload undocumented. There is
  **no last-modified-by field**: `owner` is who created the file. Addressing by
  `link:<permanent_link>` survives renames and moves; addressing by path does
  not.
- **Universal Search must be indexing the share.** Content search over a Team
  Folder depends on DSM's Universal Search having the folder indexed (a DSM
  setting, not an API). If it is not, `files/search` still finds names and
  labels. The builder confirms content snippets come back for `.md` on the
  owner's NAS before the search tool claims to search bodies.
- **The document write path needs a session.** A briefing is written when the
  first member opens Today; an answer when a member asks. If the member has no
  NAS session (after a redeploy, before they sign in again), or the Drive
  write fails, the body is written **inline in the log as today**, and stays
  there. Nothing moves it later: a briefing written again that day (Claude's
  in place of the fallback, or the household's with the calendar) is a new
  write and goes wherever that write can go. No new mechanism, no new flag.
- **Markdown files are small.** A briefing is a few kilobytes; a plan page is
  under a hundred. Attachments keep their File Station upload path.

## Decided in conversation

### What goes where

**Stays in the log, unchanged:** every budget event; `plan.*` structure and
state (create, set, state, parent, area, due, blocks, checklist, contact and
calendar links, attach/detach); `thread.ask` and `thread.note` (short, capped
at `THREAD_TEXT_MAX`, part of the record); `proposal.offer` and
`proposal.decide`; `calendar.*`; `guest.*` and `booking.*`; `settings.*`;
`flag.seen`.

**Moves to Drive, with a pointer in the log:**

- **Briefings.** `thread.briefing` keeps `day`, `source`, `budget`,
  `headline`, `writtenBy`, `replaces`, `calendarUnread`, and gains an optional
  `doc` (below). When `doc` is present, `body` is omitted. Replay accepts
  either shape; an event with neither is invalid. The file is
  `<household>/today/<day>-<source>[-<budget>].md`, written with
  `conflict_action: version`: a briefing written again that day (routine, see
  `record()` in `briefing.ts`) writes the same file as a new version, and the
  replaced event's `doc` keeps the `version_id` of the version it described.
  Replaced briefings are never shown, so the pointer going stale costs
  nothing, and a person in Drive sees one file per day per source with its
  history behind it.
- **Claude's answers.** `thread.answer` keeps `replyTo`, `plan`, `tools`,
  `model` and gains `doc`; `text` becomes the first line or two (the headline
  shown in the thread), the full answer is the file at
  `<household>/answers/<replyTo>.md`, named for the question because the file
  is written before the answer's own id exists, and one question has one
  answer. The thread shows the headline and *Read the whole answer*; a plan
  card's gold block renders the file.
- **What Claude reads of them.** `dayContext()` today hands Claude the full
  body of the day's briefing and every earlier answer. After the move it
  fetches those files from Drive with the asker's session, in parallel, which
  on the NAS's own loopback is quick. Without a session it hands over the
  headlines and one line saying the full texts were not read, so an answer
  that leans on them says so rather than guessing.

**Projected to Drive, log-authoritative:**

- **Plan pages.** Every plan has one file, `<household>/<plan-id>/plan.md`,
  beside its attachments, so a person opening the plan's folder in Drive sees
  the page and the files together. The page is rewritten (`conflict_action:
  version`, so Drive keeps the history) after every `plan.*` event that
  changes it, as a best-effort follow-on, never as an effect the plan change
  waits on: a plan edit must not fail because Drive is unreachable. After each
  successful write the log records `plan.doc { plan, doc, event }`, where
  `event` is the last plan event the page reflects. It is small, carries no
  prose, and is the durable record of what the app last wrote, which phase 4
  needs and RAM would lose on restart. A page whose write failed is simply
  behind: the next open of the plan, or the next drift check, sees the latest
  `plan.doc.event` older than the plan's latest event and rewrites it. Replay
  does not need the page; the page needs replay.

### The `doc` reference

One shape, used by every pointer:

```
doc: {
  link: string,        // Drive permanent_link; how the file is addressed
  file_id: string,     // Drive file_id, for logs and checks
  hash: string,        // content hash Drive returned on write
  version_id: string,  // the version this event describes
  path: string         // display path at write time, for a human reading the log
}
```

`link` is what the app uses. `path` is for people and is allowed to go stale.
`hash` and `version_id` are what drift detection compares.

### The page format

Markdown with a YAML frontmatter block, written so a person can read it and
the app can parse it. The render is deterministic: the same state gives the
same bytes, with no timestamp in the page (the `event` key says how current it
is), so a page can be compared with what the app would write now.

A plan page:

```markdown
---
planner: 1
kind: plan
id: mvsvplat-000259
title: Replace the water heater
area: house
state: doing
parent: null
due: 2026-11-20
people: [contacts:4123]
envelope: house-repairs
estimate: 185000      # cents, as everywhere
event: mvsyzlo0-000260   # the last log event this page reflects
---

# Replace the water heater

Why: the old one is 14 years old and the pan has rust.

## Checklist
- [x] Get two quotes
- [ ] Pick an installer
- [ ] Book the day

## Files
- quote-abc.pdf
- quote-xyz.pdf
```

A briefing page carries `kind: briefing`, `day`, `source`, `budget`,
`writtenBy`, and the headline as its first heading. An answer page carries
`kind: answer`, `replyTo`, `plan`, `model`, and the tools it used as a short
list at the end, as the thread design already requires.

The frontmatter key set per kind is fixed in `types.ts` beside the event
shapes, so there is one definition of what a page means.

### Search

A new tool, `search`, available to Claude in every conversation and behind a
search box in the shell. It takes words and an optional kind (`plan`,
`briefing`, `answer`, `file`) and returns up to a handful of hits, each with
the kind, the title, a passage, and what to open (a plan id, a day, an event
id, an attachment). Two sources, merged:

1. **Drive `files/search`** with the member's `sid`, `keyword` = the words,
   `location` = the household's folder on the Team Folder, `content_snippet:
   true`. This covers pages, briefings, answers and attachments by content,
   server-side, with no index of the app's own.
2. **The replayed state**, for things that are not documents: plan titles,
   asks, notes, proposals. A plain substring match over RAM; one household's
   state is small.

The merge prefers a plan page over a plan title for the same plan, and a
document hit carries the passage Drive returned. Claude's tool definition
follows `tools.ts`: it reads, it never writes, and it returns the ids a later
tool call would need.

### Edits made in Drive (second phase)

A member opens a plan page in Synology Drive on their phone and changes the
due date, ticks a checklist item or adds a line to the notes. The planner
notices (a webhook when its payload has been observed on the owner's NAS;
until then, a `change_id` check over the household folder when Today opens,
the same cadence as calendar drift), sees the file's `hash` differs from the
last `plan.doc`, fetches the page, and compares its frontmatter, checklist and
notes against what it would render from state now. Whitespace and ordering
differences an editor introduces are not differences.

Every difference becomes a card: *"The water heater's page was changed in
Drive: due date Nov 20 → Nov 27"* with **Take the change** / **Put the page
back** / **Leave both**. Taking it appends the matching `plan.*` event with
**the member who takes it** as actor and the reason *"edited in Drive"*;
putting it back rewrites the page. Drive does not record who last modified a
file, only who created it, so the card names the file, not a person, and the
log's authorship rule holds because the author is the member who accepted the
change. Notes are not taken silently: the log is where a plan's notes live
(`plan.set`), so a note edited in Drive is a card like the rest, and the page
is never rewritten over an unreviewed edit while its card is waiting. This is
the calendar drift mechanism with a file where the event was, so it shares
`drift.ts`'s shape and card, not a second one. If the webhook payload turns
out to carry the editor, the card can name them and notes can be taken
without a card; that is a change to one line of this section, not to the log.

### What this does to backup and restore

Backup is the log **and** the Planner share. Restore scopes are unchanged:
`thread` and `plans` carry the pointer events. A household restored on the
same NAS finds its documents by `link:`, which survives moves and renames. A
household restored on another NAS, or under a new id, has pointers to files
that are not there, exactly as attachments already do (`DEPLOY.md`, *A
household restored under a new id no longer sees its files*); a page the app
can rebuild (a plan page) is rebuilt on first open, a page it cannot (a
briefing, an answer) shows its headline and *the full text is on the old
NAS*. `DEPLOY.md` says so.

### Phasing

1. **Drive client and the Team Folder.** `drive.ts` beside `synology.ts`:
   `writeFile` (multipart, `version`), `readFile`, `getFile` (metadata by
   `link:`), `search`, `listChanges`, with a fake in the style of the Calendar
   fake whose `hash` changes when content does. `synology:check` learns Drive. Deploy
   step added. Nothing user-visible yet.
2. **Briefings and answers to Drive.** The `doc` shape, the two event shapes
   grow it, replay accepts both, the thread reads back through the app. The
   log stops growing with prose.
3. **Plan pages and search.** `plan.doc`, the projection rewritten on every
   plan event, the `search` tool and the search box. Members can open the
   household in Drive and see it whole.
4. **Edits in Drive come back as cards.** `change_id` polling first; webhooks
   once the payload is known.

Each phase ships on its own and leaves the app working if the next never
comes.

## Later, with the trigger written down

- **An index of the app's own** (`node:sqlite`, FTS5, in a derived file the
  container may lose) is wanted only if Drive's search proves too slow or too
  coarse for the search box, or if search has to work for a member without a
  NAS session. Rebuilt from the log and a Drive listing on start; never
  backed up.
- **Embeddings and cosine matching** are wanted only when a member or Claude
  asks for something by meaning and keyword search misses it often enough to
  notice: *"the thing about the roof guy"* finding a plan titled *Gutter
  repair*. When that day comes: one embedding per page, from Voyage or a
  local model (Anthropic does not sell embeddings), stored in the same
  `node:sqlite` file with `sqlite-vec`, brute-force cosine over a few
  thousand rows, which is what one household will have for years. Postgres
  with pgvector is the answer only if a second writer ever appears; there is
  none in sight.
- **Calendar tasks** (`SYNO.Cal.Todo` / REST `task`) are a native shape for a
  dated plan: title, body, due, done, etag. The planner uses all-day events
  for due markers instead, because they appear on every phone calendar and
  tasks appear only in Synology's own apps. Revisit if members want a to-do
  list on their phones that is the plan board.

## Calls I made (the owner to check)

1. **Drive over a bind mount.** The earlier sketch had the container writing
   markdown to a mounted share. Drive gives ids, hashes, versions, search and
   change notice for the same files, and the app already holds the session
   Drive needs. The cost is that document writes need a member's session; the
   fallback for that already exists.
2. **Plans are log-authoritative with a projection**, not markdown-authoritative
   as the owner first put it. A plan has reasons, an author per change, a
   calendar event hanging off its due date and a checklist whose state other
   cards read. Making the file the truth would move all of that out of the
   record. The page is the *view* a person wants; edits to it come back
   through the log. If this proves to fight how the household actually uses
   Drive, the phase 4 card can become automatic for more fields.
3. **Briefings and answers are the first to move**, because they are the
   bulk of the prose the log will hold and nothing depends on their bodies.
4. **The plan page lives beside the plan's files**, at
   `<household>/<plan-id>/plan.md`, rather than in a `plans/` folder, so a
   person browsing Drive finds everything about one plan in one place.
   `plan.md` is reserved: an attachment may not be named that.
5. **No metadata on the Drive file itself.** The spec's `app_properties` is
   read-only, so filtering by state or area stays in RAM where it already is;
   Drive labels were considered and rejected as a second place to keep state.
   A file's kind comes from its path and its frontmatter.
6. **No local index and no embeddings yet**, with the triggers above. The
   owner raised both; the honest answer for one household is that Drive's
   search and a RAM scan cover it until shown otherwise.
7. **Every document is written with `conflict_action: version`** through the
   multipart upload, the one write that offers it. Drive keeps the revisions;
   the app keeps only the `version_id` it wrote. A briefing written again that
   day is a new version of the same file.
8. **Every edit made in Drive is a card, notes included**, taken by the member
   who accepts it, because Drive cannot say who made the edit and the log
   does not record changes without an author. Revisit when the webhook payload
   is known.
9. **The household's folder name in Drive is its id**, as it already is for
   attachments, not its label. Labels change; ids do not.
10. **`plan.doc` is appended after every successful page write**, not once.
    One small event per plan change, no prose, so the record of what the app
    last wrote survives a restart and phase 4 can tell *Drive is behind* from
    *Drive was edited*.
11. **Claude fetches the day's briefing and earlier answers from Drive** when
    the asker has a session, and is told plainly when it could not. The
    alternative, headlines only, would make every answer worse to save a few
    loopback reads.
12. **An answer's file is named for its question** (`answers/<replyTo>.md`),
    since the file exists before the answer's own id does.

## Left to the builder

- Exact Drive endpoint shapes and error codes, confirmed against the copied
  spec and the owner's NAS; which error means *"not a Team Folder"* and
  which means *"version too old"*.
- The frontmatter parser: a small hand-written YAML subset (scalars, lists,
  the keys above), not a YAML library. The keys are fixed; the parser can be.
- Rendering of a document read back from Drive in the thread and on a card,
  within the existing tokens.
- The `search` tool's ranking and the number of hits returned; how a hit is
  drawn in the shell.
- How the fake Drive behaves in tests, including a `hash` that changes when
  content does, so drift tests mean something.
- Polling cadence for `change_id` beyond *when Today opens*, and the webhook
  receiver once the payload is observed.
- The `synology:check` additions and the `DEPLOY.md` section on enabling the
  Team Folder and Universal Search indexing.
- Migration: none. Old events keep their bodies; new events point to Drive.
