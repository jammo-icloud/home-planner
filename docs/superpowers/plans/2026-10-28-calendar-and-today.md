# Calendar and Today Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plans with dates land on the Household calendar, drift between a plan and its event is a card, "schedule my dentist at 10 on Thursday" becomes a checked proposal, the calendar is drawn in the app, the day's briefing is one household text from three sources, and the shell becomes Today · Plan · Calendar · Budget · More.

**Architecture:** An **effect stage** in `offers.ts` lets a tool run external calls at decision time and append their results with the decision in one write — the one mechanism `propose_event`, due dates, blocks and (later) booking share. `api/src/calendar.ts` owns plan↔event links and drift. `briefing.ts` gains a household-level composer that gathers facts from the budget, plans and the Household calendar and writes `thread.briefing { source: 'household' }`; the per-source sections remain as the fallback. The UI gets a week view and the new shell.

**Tech Stack:** As the project. Requires `2026-10-28-synology-sources.md` and `2026-10-28-plan-app.md` complete.

**Spec:** `docs/superpowers/specs/2026-10-28-home-planner-design.md` — Goals 1, 3, 4, 6; the "shared Today is materially different" principle; Decided › The shell, › Today, › Calendar; Calls 9, 11, 12, 13.

## Global Constraints

- The shared briefing reads **only** the Household calendar. Personal and partner calendars appear only in the viewer's own rail and conflict checks.
- Writes go only to the Household calendar or the acting member's own calendar. A partner's calendar is never written.
- Conflict checks read only `state.calendar.conflicts.get(who)` plus the Household calendar plus the member's default calendar.
- Every event write carries the stored `dav_etag`; a mismatch is `calendar.drift`, never a retry.
- Drift is always a card with three choices: move the plan, put the calendar back, leave both. Never auto-resolved. A deleted event is drift.
- A due date → all-day VEVENT on that date; a block → timed VEVENT; summary = plan title; description = `From Home Planner · Plan › <area> › <title>` (no URL: the planner has no public origin of its own, and the phone shows the words).
- Effects run before the decision is recorded; on any failure, compensate and append nothing.
- One briefing per household per day, one Claude call, `source: 'household'`, `budget: null`. Fallback: per-source sections stitched. Replace rule unchanged.
- `propose_event` never picks a different time than asked without saying so in the proposal.
- `TZ` from the environment is the `tz_id` on every event.

## Review Focus

1. **A plan's due date is cleared** (`plan.due null`) — the all-day event must be deleted and the link removed, not left on the phone. Pinned in task 3.
2. **The Household calendar does not exist yet when the first due date is set.** `ensureHouseholdCalendar` must run inside the effect. Pinned in task 3.
3. **Two drifts on the same link** before anyone resolves the first — one open drift card per link, the second replaces. Pinned in task 4.
4. **The briefing's calendar fetch fails** (NAS down) — the household briefing must still be written from budget and plans, with a line saying the calendar could not be read; never a 500 on Today. Pinned in task 6.
5. **`propose_event` for a time in the past, or end before start** — refused in `run`, before any proposal. Pinned in task 5.

---

### Task 1: The effect stage

**Files:**
- Modify: `api/src/tools.ts:75-82` (`Tool.effect?`), `api/src/offers.ts:90-106` (`decide`), `api/src/tools.ts:1755-1760` (`commit`)
- Test: `api/test/offers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // tools.ts
  export interface Tool { …; effect?(args: Record<string, unknown>, ctx: ToolContext): Promise<NewEvent[]> }
  export async function runEffect(tool: Tool, args: Record<string, unknown>, ctx: ToolContext): Promise<NewEvent[]>;  // [] when the tool has none
  ```
  `decide(... 'approved')`: `const extra = await runEffect(tool, o.args, ctx)` **before** the append; append `[choice, ...events, ...extra]` in one write. If `runEffect` throws, nothing is appended and the error propagates (a `ToolError` keeps its status; a `SynologyError` is wrapped as `ToolError(msg, 502)`). `commit()` does the same for the member path. The tool's `effect` is responsible for its own compensation.

- [ ] **Step 1: Write the failing tests** — register a test-only tool with `effect` returning `[{ op: 'thread.note', text: 'effect ran', budget: null }]` (any harmless op) → after `decide approved`, the log's last three events are decide, the stored event, the note, with the same `at`; a tool whose `effect` throws `ToolError('nas said no', 502)` → `decide` rejects with it and the offer is still `open`; `commit()` behaves the same.

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "An effect stage: the NAS first, then the decision, or nothing at all"`

---

### Task 2: Links and drift in the log

**Files:**
- Modify: `api/src/types.ts`, `api/src/replay.ts`, `api/src/restore.ts`, `api/src/tools.ts` (`describe`)
- Test: `api/test/calendar.test.ts`

**Interfaces:**
- Produces ops (scope `plans`):
  ```ts
  | { op: 'plan.calendar.link'; plan: PlanId; kind: 'due' | 'block' | 'appointment'; block?: string; cal_id: string; original_cal_id: string; evt_id: number; ical_uid: string; dav_etag: string }
  | { op: 'plan.calendar.unlink'; plan: PlanId; kind: 'due' | 'block' | 'appointment'; block?: string }
  | { op: 'plan.calendar.etag'; plan: PlanId; evt_id: number; dav_etag: string }           // after our own successful set
  | { op: 'calendar.drift'; plan: PlanId; evt_id: number; theirs: { dtstart: number; dtend: number; summary: string } | null /* null = deleted */; ours: { dtstart: number; dtend: number; summary: string } }
  | { op: 'calendar.drift.resolve'; drift: EventId; choice: 'plan' | 'calendar' | 'leave' }
  | { op: 'calendar.appointment'; evt_id: number; cal_id: string; original_cal_id: string; ical_uid: string; dav_etag: string; summary: string; start: string; end: string; allDay: boolean; plan?: PlanId; contact?: ContactLink }   // a standalone event the app made
  ```
  `Plan` gains `readonly links: readonly { kind; block?; cal_id; original_cal_id; evt_id; ical_uid; dav_etag }[]`; `State` gains `readonly drifts: ReadonlyMap<EventId, { plan; evt_id; theirs; ours; resolved: 'plan' | 'calendar' | 'leave' | null }>` and `readonly appointments: ReadonlyMap<number /* evt_id */, …>`. Fold: `link` replaces a link of the same kind+block; `etag` updates it; a second open `calendar.drift` for the same `evt_id` marks the first resolved `'leave'` with `replacedBy`.

- [ ] **Step 1: Write the failing tests** — link, relink same kind replaces, etag updates, unlink removes, drift then resolve, second drift replaces first, `scopeOf` of each is `'plans'`, `describe` of each is non-empty.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "A plan remembers its calendar event, and when the two disagree"`

---

### Task 3: Due dates and blocks become events

**Files:**
- Create: `api/src/calendar.ts`
- Modify: `api/src/tools.ts` (`set_plan_due` and `block_plan_time` gain `effect`; `remove_plan` gains `effect` that deletes linked events), `api/src/plans.ts` (`setDue`, `addBlock`, `removeBlock`, `removePlan` call the same effect, since member edits are direct)
- Test: `api/test/calendar.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function eventFor(plan: Plan, kind: 'due' | 'block', block: Block | null, tz: string, cal: CalendarRef): NewCalEvent;  // due: all-day on due, dtend = next day; block: timed
  export async function syncDue(ctx: ToolContext, plan: Plan, due: Day | null, f?: DsmFetch): Promise<NewEvent[]>;   // create / set / delete, returns link|unlink|etag events; EtagMismatch → returns [calendar.drift …] and does not write
  export async function syncBlock(ctx, plan: Plan, block: Block, f?): Promise<NewEvent[]>;
  export async function unsyncBlock(ctx, plan: Plan, blockId: string, f?): Promise<NewEvent[]>;
  export async function unsyncAll(ctx, plan: Plan, f?): Promise<NewEvent[]>;
  ```
  Every one calls `ensureHouseholdCalendar` first and uses `targetCalendar(state)`. `ctx.sid === null` → `NeedsDsm` (a bypass session can set a due date on the plan but no event is made; the route reports `calendar: 'sign in again'`).

- [ ] **Step 1: Write the failing tests** (fake DSM as in `synology.test.ts`) — `syncDue` with no link creates and returns `[plan.calendar.link {kind:'due', evt_id, dav_etag}]` and the create body has `is_all_day=true`, `dtstart` = midnight of the due date in `TZ`; `syncDue` with a link sets with the stored etag and returns `[plan.calendar.etag]`; `syncDue(null)` with a link deletes and returns `[unlink]`; a `9006` on set returns `[calendar.drift]` with `theirs` from `getEvent`; the Household calendar is created on first use.

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** `set_plan_due.effect = (args, ctx) => syncDue(ctx, plan, args.due)`; `plans.setDue` appends `[plan.due, ...await syncDue(...)]` in one write.
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "A due date is an all-day marker; a block is time set aside"`

---

### Task 4: Drift becomes a card

**Files:**
- Modify: `api/src/calendar.ts` (`checkDrift`), `api/src/tools.ts` (`resolve_drift` write tool with `effect`), `api/src/server.ts` (`GET /api/thread` calls `checkDrift` after `ensureSection`; `POST /api/calendar/check`), `api/src/types.ts` (`OfferPrompt.kind` gains `'drift'`), `api/src/thread.ts` (`'drift'` cards are standalone entries), `site/index.html` (`offerCard` renders a drift card as `provisional drift` with the `chip moved` chip and the words "moved", per the design's Conventions, with the three choices for `tool === 'resolve_drift'`: **Move the plan too** → `choice: 'plan'`; **Put the calendar back** → `'calendar'`; **Leave both** → `'leave'`)
- Test: `api/test/calendar.test.ts`, `api/test/server-thread.test.ts`

**Interfaces:**
- `checkDrift(ctx, f?): Promise<Event[]>` — for every link on every live plan, `getEvent`; if `dav_etag` differs, append `calendar.drift` and `offer({ tool: 'resolve_drift', args: { drift: id, choice: 'plan' }, prompt: { kind: 'drift', ref: id } })`; a 404 from `getEvent` is `theirs: null`. Skips links whose drift is already open. Never throws on a `SynologyError` — logs and returns what it did.
- `resolve_drift.effect`: `'plan'` → append `plan.due`/`plan.block` from `theirs` plus `plan.calendar.etag`; `'calendar'` → `setEvent` back to `ours` with the current etag (fetched), append `etag`; `'leave'` → append `calendar.drift.resolve` only. All three append `calendar.drift.resolve`.
- Card summary: `"<who> moved <title> to <date> on their phone"` when `theirs`; `"<title> was deleted from the calendar"` when null. `who` is `last_modify_user` from `getEvent`.

- [ ] **Step 1: Write the failing tests** — a link whose fake event now has `dav_etag 'E2'` and `dtstart` a day later → one `calendar.drift` and one open `resolve_drift` offer; running `checkDrift` again adds nothing; approving with `choice: 'plan'` changes the plan's `due` and the link's etag; `theirs: null` card text matches `/deleted/`.

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "When a phone moves an event, Today says so and asks"`

---

### Task 5: "Schedule my dentist at 10 on Thursday"

**Files:**
- Modify: `api/src/tools.ts` (`propose_event` write tool with `effect`), `api/src/calendar.ts` (`conflictsFor`, `freeSlotsNear`), `api/src/claude.ts` (`METHOD_RULES` gains one paragraph on scheduling: resolve relative days from TODAY, never move a time without saying so, name clashes)
- Test: `api/test/calendar.test.ts`, `api/test/briefing.test.ts` (the `METHOD_RULES` name-leak assertion still passes)

**Interfaces:**
- `propose_event { summary: string; start: string /* ISO local */; end: string; allDay?: boolean; on: 'mine' | 'household'; plan?: PlanId; contact?: ContactLink; makePlan?: { area: string } }`.
- `run`: validates (`end > start`, `start >= today 00:00`), calls `conflictsFor(ctx, start, end)` → `{ clashes: CalEvent[]; near: CalEvent[] /* same day, no overlap */ }` over the member's default calendar + Household + `conflicts.get(who)`; builds a proposal whose `summary` is `"<summary> · <day> <time>–<time> · on <mine|Household>"`, whose `effects` lead with each clash (`"Clashes with Bob · PT 11:00"`) then each near event (`"Bob has PT at 11:00 the same morning — not a clash"`), then `"Reminder 1 hr before"`; when there is a clash, `effects` also list up to three `freeSlotsNear` and the proposal's events are still for the time asked. `events` is `[]` (the effect supplies them).
- `effect`: `createEvent` on the chosen calendar (member's default from `listCalendars` `isDefault`, or `targetCalendar`); if `makePlan`, append `plan.create` first and link `kind: 'appointment'`; returns `[calendar.appointment …, plan.calendar.link? …]`.

- [ ] **Step 1: Write the failing tests** — end before start → `ToolError`; a window with one overlapping event on a conflict calendar → `effects[0]` matches `/Clashes with/` and three suggested slots follow; no clash → first effect is the calendar line; `effect` creates on the Household calendar when `on: 'household'` and returns an appointment event with the fake's `evt_id`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Schedule it in words; the proposal names the clash"`

---

### Task 6: One briefing for the household

**Files:**
- Modify: `api/src/briefing.ts` (`householdFacts`, `briefHousehold`, `ensureHousehold`; `sections()` keyed on `source`), `api/src/types.ts` (`thread.briefing.source: 'budget' | 'plans' | 'calendar' | 'household'`), `api/src/server.ts` (`GET /api/thread` calls `ensureHousehold` instead of `ensureSection`; `ensureSection` remains for the fallback path), `api/src/thread.ts` (a `household` briefing entry is the day's opener; per-source sections show only when no household one exists for the day)
- Test: `api/test/briefing.test.ts`

**Interfaces:**
- `householdFacts(store, o: { who, today, sid, tz }): Promise<{ text: string; sources: ('budget' | 'plans' | 'calendar')[]; missing: string[] }>` — budget block = existing `facts()` for the default budget (or "no budget open"); plans block = due within 7 days, overdue, in Doing ≥ 14 days, asks waiting on either member; calendar block = Household-calendar events today..+7 via `listEvents` (on `SynologyError`, `missing` gets `'calendar: <reason>'` and the block says so). Never personal calendars.
- `briefHousehold(store, o): Promise<Briefing>` — one Claude call with the three blocks; `writtenBy: 'fallback'` stitches the three blocks' plain summaries when Claude is unavailable.
- `ensureHousehold(store, o): Promise<Section>` — same in-flight and replace rules as `ensureSection`, keyed `${store.path}|household|${today}`; writes `thread.briefing { source: 'household', budget: null }`.

- [ ] **Step 1: Write the failing tests** — with `fake-claude`, one call is made and its user content contains all three headings (`THIS MONTH`, `PLANS`, `HOUSEHOLD CALENDAR`); the calendar fetch throwing `SynologyError` still yields a briefing whose body mentions the calendar could not be read; Claude unavailable → `writtenBy: 'fallback'` and the body has the three blocks; a second `ensureHousehold` the same day writes nothing; the thread's first entry for the day is the household briefing.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "One briefing a day, for the household, from all three sources"`

---

### Task 7: The rails, and the Ask box takes instructions

**Files:**
- Modify: `api/src/server.ts` (`GET /api/today` → rails), `api/src/calendar.ts` (`viewerEvents`), `site/index.html` (three rails under the briefing; the reply box's "Ask Claude" is unchanged — `propose_event` is now a tool Claude can call, so an instruction yields a card)
- Test: `api/test/server-thread.test.ts`

**Interfaces:**
- `GET /api/today` → `{ calendar: { today: CalEvent[]; tomorrow: CalEvent[] } /* viewer's default + Household + conflicts */, plans: BoardCard[] /* mine or asked to me, due ≤ 7d or doing */, money: { budget, toAssign, low: { envelope, label, left }[] } }`.

- [ ] **Step 1: Write the failing test** — the bypass session's `/api/today` returns `plans` and `money` and `calendar: { today: [], tomorrow: [], unavailable: 'sign in again…' }`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Rails are compact hairline lists inside **one** `yours` container labelled "Yours · what the briefing was written from" (`docs/superpowers/design/mockups/Today-phone.html`, `Today-desk.html`; the `today`, `yours`, `rail` sections of `components.css`): below the briefing on a phone, a sticky side column on the desk. Never three boxes under the briefing. Each item links into its app.
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "What the briefing was written from, under it"`

---

### Task 8: The calendar on screen

**Files:**
- Modify: `api/src/server.ts` (`GET /api/calendar?start&end` → `viewerEvents` merged with links: each event tagged `kind: 'appointment' | 'due' | 'block' | 'other'`, `calendar: 'mine' | 'household' | 'partner'`, `plan?`), `site/index.html` (`TABS` gains `{ view: 'calendar', label: 'Calendar' }`; `<div id="calendar">`; `loadCalendar(weekStart)`, `renderWeek(events)`)
- Browser check.

- [ ] **Step 1: Add the route.**
- [ ] **Step 2: Build the calendar** from `docs/superpowers/design/mockups/Calendar-desk.html` and `Calendar-phone.html` (the `cal-bar`, `legend`, `ev`, `week`, `daystrip`, `dayview` sections of `components.css`). Desk, from 1040px: day columns Mon–Sun, the all-day row as one strip so a span can cross days, a timed grid 7:00–21:00, today's column tinted with the accent "now" line. Phone: a strip of seven days with a dot per source, and the chosen day as one full-width timed column with its all-day markers above. Shades by `calendar` (`ev mine|partner|household`); a due marker is dashed; a plan block links to its card; a **proposed** event is hollow and dashed in the accent; an open drift is an **amber ring** with "moved" in words (`ev drift`); a clash is the red ring (`ev clash`), the only red on the grid. Prev/next week; a legend.
- [ ] **Step 3: Browser check** — set a due date and a block on a plan; see both on the week; move the fake's event (the fake exposes `POST /fake/move`); reload Today; see the drift card; choose "Move the plan too"; see the plan's due change.
- [ ] **Step 4: Commit** — `git commit -m "The calendar, drawn by us"`

---

### Task 9: The shell

**Files:**
- Modify: `site/index.html` (`TABS` → `[today, plan, calendar, budget]`; Import and Compare become a segmented sub-tab row inside `#budget`; `More` lists `state.settings.links`; a Settings screen reachable from the household pill), `api/src/server.ts` (nothing new; the appearance route exists from Synology sources task 9)
- Browser check.

**Design (binding):** the shell per `docs/superpowers/design/mockups/Main.html`, `Today-*.html` and `More-phone.html`: wrap the top bar and `<main>` in `<div class="hp">` (the container query root) with the phone `tabbar`, the `more-sheet` and the `scrim` as siblings **outside** it; desk (760px up) shows `tabs-top` in the top bar with the chosen tab underlined in the accent, phone shows five `tabbar` slots with More as the fifth. **More on a phone is a sheet** headed "These leave Home Planner", each link with a leaving glyph and "Change these links" at the bottom; on the desk the same list as a menu. **Settings** per `Settings-phone.html` and `Settings-desk.html`, two groups: *Yours* — **Appearance** (the four schemes as tiles each stamped with its own `data-scheme`/`data-mode`, and Light / Dark / Match this device; saves through `POST /api/settings/appearance`, writes `localStorage['hp.appearance']` as `{ scheme, mode }`, and re-stamps `<html>` at once; on every load the app compares the log's value with the cache and re-stamps if they differ) and **Calendars I check for conflicts**; *The household's* — Areas, Links under More, Household calendar, Guests (booking plan), Attachments (read only, grey panel with a lock). Desk adds a sticky section index; phone stacks with Done at the top.

- [ ] **Step 1: Rework `TABS` and `showView`** so `budget` shows a sub-tab row and remembers the last sub-tab.
- [ ] **Step 2: Add More** — a sheet on the phone, a menu on the desk; each link opens in the same tab (`location.href = url`).
- [ ] **Step 3: Add the Settings screen**, each section saving through the routes from the Synology Sources plan; Appearance as described above.
- [ ] **Step 4: Browser check** — all four tabs at phone and desk width; Budget › Import; More lists a link; Settings saves areas and the board's rows change; picking Lapis / Dark re-stamps the page at once and survives a reload.
- [ ] **Step 5: Commit** — `git commit -m "One shell: Today, Plan, Calendar, Budget, and More"`

---

### Task 10: Creating a contact from a suggestion

**Files:**
- Modify: `api/src/tools.ts` (`create_contact` — replace the Plan App's 501 stub), `site/index.html` (the research block's "Add <name> as a contact" suggestion is this tool's card)
- Test: `api/test/calendar.test.ts`

**Interfaces:**
- `create_contact { full_name: string; phones?: string[]; emails?: string[]; org?: string; plan?: PlanId }` — `run`: `full_name` required; proposal summary `"Add <full_name> to Contacts"`, effects `["A new contact in the household address book", "Linked to <plan title>"?]`, `events: []`. `effect`: `listAddressbooks` → the first; `createContact`; when `args.plan`, returns `[{ op: 'plan.contact.link', plan, contact_id, addressbook_id, display: full_name }]`, else `[]`. A `SynologyError` propagates (nothing appended; the card stays).

- [ ] **Step 1: Write the failing tests** — `run` without `full_name` throws; `effect` through the fake DSM creates in the first address book and returns one `plan.contact.link` when `plan` is given and `[]` when not; approving the card from a research answer (`prompt.kind 'research'`) lands the link on the plan's `contacts`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "A contact Claude found becomes one you keep, once you say so"`
