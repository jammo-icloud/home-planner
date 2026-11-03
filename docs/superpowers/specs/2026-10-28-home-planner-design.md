# Home Planner: one shell, three apps, one Today

Status: design, for review. Brainstormed with the owner on 2026-10-28.
Companion to `2026-10-28-today-thread-design.md`, which this extends and does
not replace. A third document, `2026-10-28-booking-design.md`, covers the one
piece with a different audience.

## Intent

household-budget grows into the household's planner: the one place either
member opens to see what matters today, drawn from three sources — the money,
the plans, and the calendar — and the one place where things get decided.

The owner's words on why. Trello: *"The cards pile up and I lose track of
what's actually due. It can be abused on adding tasks for other people. The
lack of visibility outside of Trello forces you to spend your time in there.
The organization into columns feels like ugly kanban — I can't see across all
of my stuff, and the swimlanes are vertical rather than cross-cutting."* And:
*"ideas have tasks that need accomplishing, or just sit there in research,
thinking, considering sort of modes instead of action."* Calendars: *"Right now
we use iCloud and it's hit or miss."*

The thread design already made Today the place money is talked about and
decided, with Claude drafting and a person approving. This design keeps that as
the spine and adds two more sources that post into it. Nothing here is a
dashboard of three apps; it is one question — *what matters for us today?* —
answered from three places.

## Goals

1. **Today is the thread, extended.** One briefing per household per day,
   composed from the budget, the plans and the calendar. Cards come from Claude,
   from a member asking the other to take something, from a guest booking (other
   document), and from drift between a plan and its calendar event. The
   briefing's job is triage across sources — the sentence no single app can
   write: *"Bob's dentist is Thursday; Health has $40 left; the registration
   renewal is due the same day and nothing is funding it."*
2. **Plan replaces Trello** without rebuilding it. Two axes: areas of life as
   rows, read across; two states as columns, **Planning** and **Doing**. Done is
   an archive, not a column. A plan may hold items ("Vacations we'd like to
   take" holds "Bahamas, March"); never a third level. The card is where the
   details live — Linear-shaped, with notes, checklist, attachments, people,
   money, time, and Claude's research kept visibly apart from the humans'.
3. **Calendar is ours to draw, Synology's to keep.** Every event is a VEVENT in
   Synology Calendar Server, reached through the DSM session the member already
   has. The app creates a Household calendar and shares it with every member.
   A plan with a due date becomes an all-day marker; a plan with a block of time
   becomes a timed event; an appointment is a timed event that may link to a
   plan. The two are different shapes everywhere they appear. Phones see the
   same events over CalDAV.
4. **Conversational scheduling.** *"Schedule my dentist at 10 on Thursday"* in
   the reply box reads the member's calendar and every partner calendar they
   have chosen, and comes back as a proposal that names any clash and offers
   nearby clear slots. Approving writes the event.
5. **Sources, not apps.** Synology Contacts supplies people (the dentist's
   office on an appointment, the installer Claude found on a card). File
   Station holds attachments. Neither gets a tab; both get linked.
6. **One shell.** Today · Plan · Calendar · Budget, with the household's other
   self-hosted apps under *More* as real links, so leaving to the photo library feels like
   changing tabs.

## Non-goals

- No calendar, contact or file storage of our own. Synology keeps all three.
- No sync engine. The plan and the calendar are each a system of record; the
  app holds the link between them and *reports* disagreement. It never merges.
- No CalDAV or CardDAV client. Both need the member's DSM password on every
  request, and the app never has it.
- No writing to a partner's personal calendar, ever. Reads only, and only the
  calendars that partner has shared and the member has ticked.
- No notifications, push or email in this design. (Booking needs email and has
  its own document.) *Reversed on 2026-11-02: notifications are designed in
  `2026-11-02-calendar-notifications-sinking-guests-design.md`, Part 3.*
- No change to the admin boundary: an admin sees that households exist and
  never what is in them.
- No third level in Plan. A plan may hold items; items hold nothing.
- No new repository. See call 1.

## Anti-goals — failures even if it technically works

- **Today turns into widgets.** Three stacked panels is the pile of cards in new
  clothes. The briefing is the page; everything else is what it was written
  from.
- **A thinking item gets nagged.** Nothing in Planning shows age. The clock
  runs only in Doing. "Bahamas, four months in Planning" is just true.
- **Assigning without asking.** There is no gesture that puts a plan on the
  other member's board without their accepting it.
- **A suggestion reads as a decision.** Claude's research can propose items,
  contacts and dates; until a person accepts one, it is drawn as a suggestion
  and stored as an offer, never as the thing itself.
- **Silent overwrite on drift**, in either direction. An etag mismatch stops
  the write and raises a flag. The member chooses.
- **The app reaches into a calendar it was not given.** Conflict checks read
  only what the member ticked in settings.
- **Claude writes something.** Unchanged from the thread design: every write is
  a proposal a person approves, attributed to the person who clicked.

## Constraints

Unchanged from the project and the thread design: append-only JSONL log per
household, replayed into state; integer cents; every money-moving edit requires
a reason; never floor or clamp a cost estimate; Node 26 type-stripping with no
build step; single-file vanilla JS UI in `site/index.html` with the existing
tokens; the Anthropic key is optional and every Claude feature has a plain
fallback.

New here:

- **One session, no stored passwords — and the DSM session is kept in memory
  only.** Today `checkWithDsm()` in `auth.ts` drops the DSM `sid` the moment
  sign-in succeeds, on purpose: the budget never needed the NAS again, and
  holding a NAS-wide credential for the life of an app session was a cost with
  no benefit. Calendar, Contacts and files need it on every call, so the app
  now keeps the `sid` **in the member's in-memory session, never on disk, for
  the life of that app session.** The sessions file keeps holding hashes only.
  The consequence is accepted: after a redeploy, or when DSM expires the `sid`
  on its own schedule, Calendar / Contacts / Attachments say *"sign in again to
  use this"* while the budget keeps working. There is no inline password
  prompt; the app handles a password at sign-in and nowhere else. If
  `SYNO.Cal.*` requires `session=Calendar` at `SYNO.API.Auth` login (the
  guide's examples use it), sign-in requests that session name. Decided with
  the owner on 2026-10-28.
- **The Synology APIs this relies on**, with what is known about each:
  - `SYNO.Cal.Cal` `create` / `set` — documented, Calendar 2.5+, version 5.
    `create` returns `cal_id`, `original_cal_id`, `cal_privilege`.
  - `SYNO.Cal.Sharing` `set` / `get` — documented in the **2.4** guide only,
    version 1. `set` takes `cal_id` and
    `cal_share_setting: { DSM_USER: [{ ug_name, cal_privilege: "RO"|"RW" }], DSM_GROUP: [...] }`.
    A member's "My Calendar" cannot be shared; only additional calendars can,
    which is why the app creates one.
  - `SYNO.Cal.Event` `create` / `set` / `get` / `list` / `delete` — documented,
    version 5. `create` returns `evt_id`, `ical_uid` (server-generated, cannot
    be chosen) and `dav_etag`. **`dav_etag` is a required parameter of `set`**,
    and the server refuses the write if it no longer matches — the guide's
    words: *"it indicates someone else has already changed it."* The server
    underneath is DAViCal; the ICS carries `PRODID:-//davical.org//`.
  - `SYNO.Contacts.Contact` `list` / `get` / `create` / `set` / `delete` and
    `SYNO.Contacts.Addressbook` `list` — **unofficial**. No Synology guide
    exists; the community wrapper documents method names but not versions or
    full field lists, and no search. The first call on the owner's NAS confirms
    the shape. If `create` proves unviable, Contacts falls back to link-existing
    only and the UI says so.
  - `SYNO.FileStation.Upload` / `Download` / `List` — documented. Upload is
    RFC 1867 multipart with the file as the last part.
- `SYNO.API.Info` on the owner's NAS is the authority on versions; the builder
  confirms each before relying on the numbers above.

## Decided in conversation

### The shell

- Top bar: **Today · Plan · Calendar · Budget · More ▾**, then the household
  pill and the member pill. Today is home.
- *More* is a household-level list of links — label and URL — set in settings
  and opened in the same tab. The other apps need know nothing about the
  planner. (A "← Home Planner" crumb injected at the proxy was discussed and
  left to the owner; the browser's back button is the baseline.)
- The budget app's own tabs — Budget, Import, Compare — nest under **Budget**.
  Activity has already folded into the thread.

### Today

Everything in the thread design stands. One principle, in the owner's words,
governs the deltas: **the shared Today is materially different from a
member's personal Today.** The thread, and the day's briefing that opens it,
are the household's and read the same for both members. Around them, each
member sees their own layer — their rail, their calendars, their conflict
checks, their "new since you last looked." The two never bleed into each other.

So the **shared briefing reads only the Household calendar.** A member's
personal calendars, and any partner calendar they have been shared and ticked,
appear in that member's own rail and their own conflict checks — never in the
shared paragraph. The rule for the household is *"if you want it in the
briefing, put it on Household,"* which is also what makes it show on both
phones. The alternative — whatever the first opener can see goes into the
shared text — would make the briefing differ by who got there first, and
would put one member's personal items in front of the other without either
having chosen that. Decided with the owner on 2026-10-28.

The deltas:

- **One briefing per household per day, written in one Claude call.** The
  thread as built writes `thread.briefing { source: 'budget' }` once per
  source per day; adding `plans` and `calendar` as sources is small but can
  never write the sentence in goal 1, because no section sees the others. So
  the day's briefing is one call: the generator gathers facts from all three
  sources — the budget from `analytics.ts`, plans from the log, the calendar
  from Synology — and writes `thread.briefing { source: 'household' }`. The
  per-source sections remain as the **fallback**: when Claude is unreachable,
  each source's plain summary is written as its own section and stitched, and
  the existing replace rule promotes the composed briefing when Claude is
  reachable again. The per-budget key becomes per-household; the budget in
  view is a section of the composed text, not a separate briefing.
- **Thread events already have a scope.** As built, `scopeOf()` has `thread`
  for the thread's ops. Plan ops get `plans` the same way. `thread.ask
  { budget }` remains an optional context field.
- **Cards from more places.** A card is raised by Claude (briefing, answer), by
  a member (an ask-to-take, below), by a guest (booking, other document), or by
  the app on drift (below). All use `proposal.offer` / `proposal.decide`, with
  `prompt` widened beyond `briefing | answer | flag` to name the source.
- **Rails under the briefing** — *Today & tomorrow* (calendar, both members),
  *Plans that need you*, *Money this month* — are glanceable summaries, each
  item a link into its app. They are what the briefing was written from, not a
  second way to read it. Drawn in the wireframe and not objected to; the
  builder may trim them.
- **The reply box is the Ask box.** Questions get answers; instructions get
  proposals. "Schedule my dentist at 10 on Thursday" is an instruction.

### Plan

- **Model.** A *plan* has an area, a title, an optional parent (the shelf it
  sits on), a state, an owner, and the things on its card. A plan with children
  is a *shelf*: drawn as a labelled group across its area's row, with no state
  of its own and no card on the board; clicking it opens it as a page listing
  its items. A plan with no children is an *item*: a card in a column. Two
  levels, enforced in replay.
- **Areas** are rows, household-defined, seeded with House · Money · People ·
  Trips, editable in settings. Every plan belongs to exactly one.
- **States.** `planning` and `doing` are the columns. `done` leaves the board
  and returns with *Show done*. Moving to `doing` records when; the clock reads
  from that.
- **Chips, not columns.** "Researching", "someday", "waiting on X" and the like
  are properties on the card, shown as chips. They never affect which column a
  card sits in and never show age.
- **The clock** runs only in `doing`. The threshold and wording are the
  builder's; the rule is that nothing in `planning` ever shows one.
- **Filters:** Both · Mine · Theirs (the other member's) · Show done.
- **Asking, not assigning.** `plan.ask { plan, to, why }` by the owner. The
  plan appears dashed on the recipient's board and as a card on their Today.
  `plan.ask.accept` makes them the owner; `plan.ask.decline { why }` returns it
  to the asker's board with the reason as a line in Today (amended 2026-10-29
  during the build). There is no other path to someone else's board.
- **The card** (as drawn): crumb (Plan › area › shelf); title; state segment;
  *Mark done*; owner; *Ask [partner] to take it*; *+ due date*; *+ block time*.
  Then, in the main column: **Notes** (markdown), **Checklist** (steps too
  small for their own card, each with done/undone), **Attachments**,
  **Claude** (research block, suggestions, an Ask box scoped to this card),
  **Between us** (member notes on this card, which are thread entries with the
  plan as context). In the sidebar: **Money** (linked envelope, left this month,
  estimated cost, months at current funding), **People** (linked contacts),
  **When** (due, blocks), **History**.
- **Attachments** — html, png, md, pdf and the like — are files in a folder on
  the NAS, uploaded through `SYNO.FileStation.Upload` with the member's
  session, under `<PLANNER_ROOT>/<household>/<plan>/`. The log stores
  `plan.attach { plan, path, name, size }`; the file is stored once, on the
  NAS. Downloads go through the app so the DSM session is used and a file is
  never served to anyone who could not open the card.
- **Claude research into a card.** "Ask Claude to investigate tankless water
  heater installers nearby" is `thread.ask` with the plan as context. The
  `thread.answer` is attached to the card as a gold block, timestamped and "as
  of". Anything concrete it proposes — an item, a contact, a due date — is a
  `proposal.offer` with `prompt: research`, drawn as a suggestion, accepted
  with `proposal.decide`. Research may read the budget and say what a cost
  means in envelope terms; it may not move money.
- **Money on a card** is a link to an envelope in the budget in view, plus an
  optional estimated cost. Figures shown come from `analytics.ts`, as
  everywhere.

### Calendar

- **The Household calendar.** On first use the app calls `SYNO.Cal.Cal.create`
  (display name "Household" by default, editable) and `SYNO.Cal.Sharing.set` to
  share it RW with every current member; a new member is added to the share
  when they join. The log records `calendar.household { cal_id,
  original_cal_id }`. If the owner already has a calendar they want used
  instead, settings let them pick it.
- **Settings, per household:** which calendar receives plan events (default:
  the Household calendar). **Per member:** which calendars to read when
  checking for conflicts — chosen from the calendars visible to that member,
  which includes a partner's personal calendar only if the partner shared it
  (RO is enough) and the member ticked it.
- **Plan → calendar.** A due date becomes an all-day VEVENT on that date; a
  block becomes a timed VEVENT. Both are created with `SYNO.Cal.Event.create`
  on the configured calendar, summary = the plan's title, description = a line
  that says it came from the planner plus a link back. The log records
  `plan.calendar.link { plan, kind: "due" | "block", cal_id, evt_id, ical_uid,
  dav_etag }`. One plan may hold one due link and any number of block links.
- **Appointments** are events created directly — by conversation or on the
  calendar — on the member's own calendar or the Household calendar (their
  choice in the proposal). An appointment may link to a plan
  (`plan.calendar.link` with `kind: "appointment"`) and may carry a contact.
- **Keeping them in step.** Any change to a plan that affects its event calls
  `SYNO.Cal.Event.set` with the stored `dav_etag`. If the server refuses, the
  app does **not** retry blind: it fetches the event, records
  `calendar.drift { plan, evt_id, theirs: { dtstart, dtend, summary }, ours }`,
  and raises a card: *"Bob moved the vet to Tuesday on their phone"* with
  **Move the plan too** / **Keep the plan, put the calendar back** / **Leave
  both**. Drift is also checked whenever Today opens (an `Event.get` per linked
  event, or an `Event.list` over the window) so the member hears about it
  before they next try to write. Deleting a plan's event on the phone is drift
  too.
- **The calendar view** is a week, with each calendar a shade (Alice, Bob,
  Household), an all-day row for due markers (dashed), timed blocks for
  appointments and plan blocks (solid; a plan block carries its link), and a
  red outline for a proposed or clashing event. Data comes from
  `SYNO.Cal.Event.list` over the member's visible calendars for the window.
- **Conversational scheduling.** A new tool, `propose_event`, takes what the
  member said, resolves the time, lists events across the member's
  conflict-check calendars for that window, and returns a proposal that leads
  with any clash, offers the nearest clear slots when there is one, and says
  which calendar it will land on. It may offer to make a plan alongside.
  Approval is `proposal.decide`, whose effect is the `Event.create`. The tool
  never picks a different time than asked without saying so.

### Contacts

- Read through `SYNO.Contacts.*` with the member's session. A card or an
  appointment may link one or more contacts: `plan.contact.link { plan,
  contact_id, addressbook_id, display }` and the same on an appointment.
  Display shows name and the phone number, tap to call, tap to open in Synology
  Contacts.
- Create only from a suggestion — Claude's research found an installer — via
  `SYNO.Contacts.Contact.create`, as a proposal the member accepts.
- Search is "list and filter here" unless the API turns out to have one.

## Calls I made (the owner to check)

1. **Same repository, same log.** The household, sign-in, log, replay,
   proposals, backup and restore, and the thread are all built and tested in
   household-budget; a second repository would duplicate each. Plans and thread
   entries are new event types in the per-household log, with their own scopes
   (`plans`, `thread`) so partial restore keeps working. The budget becomes one
   app inside the shell. The repository is renamed when it stops being just a
   budget; not in this design.
2. **Thread scope** — moot. The thread's builder shipped `scopeOf()` with
   `thread` before this document was reviewed. Plans follow the same pattern
   with `plans`.
3. **Areas seeded with four and editable**, rather than fixed or free-form.
   Fixed cannot grow with the household; free-form drifts into tags.
4. **A plan's shelf is its parent.** Not a separate "list" type. One type, one
   optional parent, depth checked in replay.
5. **Chips are free text on the card**, not an enum. "Researching" and
   "someday" are the two the UI offers first; anything else is typed. If this
   proves messy the builder may close the list.
6. **Conflict checks read only calendars the member ticked.** The app never
   enumerates a partner's calendars on their behalf and never asks Synology to
   share something to itself.
7. **Household calendar defaults**: name "Household", colour chosen by the
   builder from the existing tokens, created lazily on the first plan that
   needs a calendar event, shared RW to every member.
8. **Attachment root** `PLANNER_ROOT` is an env var with **no default**, and
   it must name a shared folder every member has read-write on — a DSM home
   folder is private to its account, and the household "owner" in the log may
   not even be an account on this NAS (a restored household). The app creates
   `<household>/<plan>/` beneath it on first attach. If unset, Attachments is
   off and the card says so to members. Which shared folder is the owner's
   choice at deploy, like SMTP for booking. Downloads are proxied. Size cap is
   the builder's.
9. **Drift is always a card**, never resolved automatically, in either
   direction, including deletion. The card's three choices are as written.
10. **Research suggestions are proposals** with `prompt: research`, so they
    appear in the thread's Waiting tray like any other offer and are decided
    with the same event.
11. **Event description carries a back-link**, so a member on their phone can
    see an event came from the planner and open the card. The exact text is the
    builder's.
12. **The rails under the briefing stay** unless the builder finds them
    fighting the briefing for attention, in which case they fold.
13. **An effect stage at decide time, shared.** Today `decide()` in
    `offers.ts` appends `proposal.decide` plus the offer's pre-baked events in
    one write. Several proposals here have effects that cannot be pre-baked
    because their values come from Synology at the moment of approval —
    `propose_event` needs `evt_id`, `ical_uid` and `dav_etag` from
    `Event.create`; a due date needs the same; booking's approval needs them
    and an email. The rule: **run the external effects first, in order; if
    every one succeeds, append the decision and the effect events together in
    one write; if any fails, compensate what already happened (delete the
    event just created) and append nothing** — the card stays waiting and says
    why. One mechanism in `offers.ts`, built once by the planner and reused by
    booking, rather than two builders each changing `offers.ts` and `replay.ts`.

## Left to the builder

- Layout and visuals within the existing tokens; the week view; paging the
  board and the thread as they grow.
- The clock's threshold and wording in Doing.
- Tool definitions for Claude — `propose_event`, research into a card, the
  plan tools — following the shape in `tools.ts`: every write returns a
  proposal, only `commit` writes.
- The checklist's storage: inline on the plan's state versus sub-events. Inline
  is fine; it is not money.
- Attachment size cap, accepted types, and what to show for a file whose path
  no longer exists on the NAS.
- Drift polling cadence beyond "when Today opens and before every write."
- Exact Synology API versions, confirmed with `SYNO.API.Info` on the owner's
  NAS before the first call to each; and whether `session=Calendar` is required.
- Test shape, following `api/test/*.test.ts`, including a fake for each
  Synology API in the style of the existing DSM auth fake.
- Migration: existing logs have no plans and no calendar links. Nothing to
  migrate; the Household calendar is created on first need.
