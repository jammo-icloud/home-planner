# The Calendar as a day page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution:** subagent-driven development (chosen): a fresh implementer and a reviewer per task, a whole-branch review at the end. Tasks run in order in one worktree. An implementer sees only its own task, the sections above the first task, and the files the task names.

**Goal:** Part 2 of release 0.9.0: on a phone the Calendar is a strip of seven days with marks over the chosen day as one card of plain rows that carry plans, money and the record; the legend goes; the desk keeps its grid and gains the same marks; the release ships as 0.9.0.

**Architecture:** `GET /api/calendar` grows and writes nothing. On the page one block with no DOM in it, `// ── the calendar: what a day shows ──`, says for any day what it draws; the strip, month, bar, card, desk heads and "also has" line all read it, and a test reads that block out of the page and runs it. Forms open in place of the row that asked (from a box, in `#cal-panel`).

**Tech Stack:** Node TypeScript by type stripping, `node:test`, an append-only log, one vanilla-JS page. New files: `api/src/calendar-money.ts`, `api/test/calendar-day.test.ts`.

**Spec:** `docs/superpowers/specs/2026-11-09-calendar-day-page-design.md`, the "Part 2" sections and the Part 2 lines of "The server", "What is deleted", "Copy rules" and "Accessibility and the phone" (binding; where this plan and the spec disagree the spec wins, except the Rulings below). **Inputs:** `docs/superpowers/design/2026-11-10-carry-over-ledger.md`, `…/2026-11-10-redesign-gap-outline.md`, `…/2026-11-10-visual-audit.md`.

**Base:** `main` at `bc8c368`, after the Today plan (`plans/2026-11-10-today-day-cards.md`) and the Bills plan (`plans/2026-11-10-bills.md`) merged. Their names exist as built: `daysOf(entries, state, viewer, w)`, `build(events, state, who)`, `ordered(entries)`, `DayRow` (`{ day, count, total, waiting, fresh, by: { who, name?, count }[] }`), `DayWindow`, the exported `type Open`, and `openOf`, a closure inside `build` (`api/src/thread.ts`; that file also exports its own `PlanRef`, `{ id, title }`, which Task 2's is not); `ownerOf`, `ViewerEvent.owner` (`api/src/calendar-view.ts`); `billsOf(state, budget)` (a map of envelope id to `Bill[]`), `billOccurrences(bill, from, to)`, `billsExpected(bills, month)` (`api/src/analytics.ts`). On the page: `householdDisc(label)`, `laneIcon(lane)`, `openCalendarDay(day)` in the shared region (its one caller is `openFor`), `openTodayAt(target)` (`{ day }`, `{ event }`, `{ offer }` or `{ drift }`), `yoursStrip()`, `calendarRows(cal)`, `openFor(e, text)`, `dayCard(row)`; the Bills heading on an envelope's page is `envSection('Bills', 'bills')`'s `h2`, `data-key` `bills` set by `dataset`, `tabIndex` -1, so it is found by `[data-key="bills"]` and never by that text in the markup.

## Global Constraints

- **Dropped elements are the owner's standing worry.** Every row of the carry-over ledger's "## Calendar" section and each "Shared and at risk" row that touches the Calendar is owned by a named task with its fate (table below), and `api/test/page-ledger.test.ts` pins it. A page task is done when its pins pass and the reviewer has ticked its rows against the running page. An unowned row means not done.
- Build from the spec, not the wireframes, where they differ. Never paste a wireframe's stylesheet. No new class named `.row`, `.rows`, `.line`, `.done`, `.over`, `.quiet`, `.msg`.
- No colour, weight, tracking or size as a literal in new CSS: tokens only. New rules go between `/* ── calendar: the day page ── */` and `/* ── end of calendar ── */`, the last thing in `<style>`. A mask's stop is `var(--ink)`.
- Every control has a 44px hit area through 0.7.0's helper: class `hit` (rule `.hit::after`). A selected state is never a tint alone: the chosen day takes the ink ring, a pressed chip is the ink-filled pill. `--accent-tint` is only the row a link landed on. No text is dimmed by opacity. No two-member assumptions. One word per concept: "Record" and "The day's record", never "thread"; "Overlaps" on the form, "clash" only in an accessible name; "Keep nights", never "block".
- Copy (spec, Copy rules): sentences, Apple's spellings, no exclamation marks. Times are `clockOf`. Amounts are the server's text; an average is "about". The when column's capitals are exactly ALL DAY, DUE, NIGHTS, AUTO PAY, PAY BY, BILL, PAID; a day read from a receipt is BILL. A date gone by says "no receipt yet", never "late", "overdue" or "missed", and is never red. A count is singular at one.
- The public tree stands in Alex, Bob, Casey, Dana, `planner.example.com` and "Example Power" for real names; no real names, banks, utilities, employers, vendors, private addresses or devices in code, tests, docs or commit messages. Test accounts are `alice`, `bob`, `carol`, `casey`; payees in tests begin `EXAMPLE`.
- Data is not code: never commit `api/data/`, `site/budget.jsonl`, `site/transactions.jsonl`, `site/planner.html`, `.env` or `.claude/`.
- Commits: `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit` (never bare `git`), a plain-sentence subject with no conventional-commit prefix, a blank line, then exactly: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- "Suite, typecheck, commit" means `cd api && npm test` and `cd api && npm run typecheck`, both clean, then the commit of the files named with the sentence given. "Run the pins" means `cd api && node --test --experimental-strip-types test/page-ledger.test.ts`; "run the day test" the same with `test/calendar-day.test.ts`.
- In `site/index.html` find things by function, id or `// ── name ──` marker, never by line number. The script is one module: a listener left for something deleted throws at load and nothing below it runs, sign-in included.
- Conventions: secondary button first, primary at the right; error slots always rendered; Escape cancels an open form first, focus back on what opened it; a committed change always reloads; every async continuation checks it is still the latest.

### Running the page by hand

`W` is the worktree's root, `S` a scratch folder outside the repository. Run each in the background, absolute paths; never port 5555:

```bash
mkdir -p $S/run/fake-root
DSM_PORT=5598 FAKE_DSM_ACCOUNTS=alice:correct-horse,bob:battery-staple,casey:paper-lantern FAKE_DSM_ROOT=$S/run/fake-root node --experimental-strip-types $W/api/tools/fake-dsm/server.ts
PORT=5577 COOKIE_INSECURE=1 TZ=America/Denver SITE_DIR=$W/site DSM_URL=http://127.0.0.1:5598 PLANNER_ROOT=/Planner LOG_PATH=$S/run/events.jsonl HOUSEHOLDS_DIR=$S/run/households SESSIONS_PATH=$S/run/sessions.json CONNECTORS_PATH=$S/run/connectors.json node --experimental-strip-types $W/api/src/server.ts
```

Sign in at `http://localhost:5577` as alice, make the household "Home", add bob and casey, make the Household calendar, turn booking on. Stop the planner by pid and run a throwaway `$S/seed.ts` (`Store` from `$W/api/src/store.ts`: `new Store({ path })`, `await store.load()`, `await store.append('alice', [...])`) against `$S/run/households/<the one id>/events.jsonl`, dates from today: budget `harbor`, envelope `util` with three monthly `EXAMPLE POWER BILLP 8842193` receipts at $146 and a `bill.set` this week; three plans due this week, one per state and per member, two toward "New roof"; a `plan.block`; a `booking.block`; a `thread.note`. Give alice sight of bob's and casey's calendars as `bobHasPT` does in `api/test/calendar.test.ts` and put an event on each, two overlapping. Start the planner.

Check at 375 × 812 and 1280, light and dark, console empty, three members. Stop by pid: `kill $(lsof -nP -iTCP:5577 -sTCP:LISTEN -t)`, the same for 5598; never `pkill`.

**Hit-area snippet** answers `[]`: `[...document.querySelectorAll('#calendar .hit')].filter((el) => el.offsetParent).map((el) => [el.textContent.trim().slice(0, 20), getComputedStyle(el, '::after').height, getComputedStyle(el, '::after').width]).filter(([, h, w]) => parseFloat(h) < 44 || parseFloat(w) < 44)`. **Sideways check** at 375 answers `true`: `document.documentElement.scrollWidth <= innerWidth`.

## Reused, not rebuilt

- **Server:** `weekEvents`, `viewerEvents`, `markClashes`, `weekWindow` (`calendar-view.ts`), `goalsOf` (`plans.ts`), `budgetInView` (a `const` local to `server.ts`), `monthView` (`envelopes.ts`), `monthOf` (`types.ts`), `fmt`, `fmtExact` (`money.ts`), `addDays` (`calendar.ts`); `formConflicts`, `saveNewEvent` (`appointment-edits.ts`), unchanged.
- **Page:** `node`, `textBtn`, `icon`, `lucide`, `memberDisc`, `stateGlyph`, `goalFlag`, `peopleBar`, `pressPerson`, `peopleOrder`, `epField`, `epErr`, `cancelMark`, `cancelOpen`, `listOf`, `nameIn`, the household clock, `openBudgetAt`, `openCard`, `closeCard`, `chosenBudget`, `bookingHere`, `dsmCalendarUrl`, `eventPlans`, `heldNights`, `whenWords`, `timedBoxes`, `nowLine`, `hourLabels`.

## Review Focus

A reviewer rejects a task for any of these, whatever else is right.

1. **An element dropped.** Every Kept and Changed row below is still drawn. Pinned by the page ledger and each task's row list, ticked against the running page, not the diff.
2. **A numeral that is not the rows,** or a filter that makes a real clash look clear. Task 5's day test: the bar's count is the sum of day counts; a shown row whose partner is hidden keeps its dot; a hidden row is reported by "also has".
3. **A late reply drawn over a newer view:** arrow, arrow, month, a deep link while a week is out, a household switch. One `calFetch` counter (Tasks 6, 8, 11), each task's check.
4. **Words typed and lost.** A form half typed survives leaving the browser tab and a window drag across 1040px; a refusal keeps the values. Task 9's check; Task 10's `ResizeObserver` does not redraw while `calOpen` is set.
5. **Three members, and a day that differs by device.** Casey has her own entry and ring; a calendar that is no member's shows under Everyone only; Household pressed changes nothing elsewhere; a device in another zone sees the household's days. Tasks 2, 5, and every page check with `TZ=America/Denver`.

## Rulings

The spec leaves these open; each is settled here.

1. A bar count is the sum of that entry's day counts over the window, so the numerals add up. Task 5.
2. Household's key is `'@household'` (`CAL_HOUSEHOLD`): a DSM account cannot begin with `@`. Task 5.
3. `dayMarks` takes its inputs so a test can call it; the page has one `calLens()`. Task 5.
4. On a calendar: `kind` `due` or `block`, `held` and `calendar === 'household'` are Household; otherwise `owner`; a checked calendar that is no member's has no key. Task 5.
5. A proposal for the viewer's own calendar has `owner` the viewer. Task 2.
6. "and 2 more" goes through `listOf` as a last item: "A, B, C and 2 more". Task 5.
7. A clash phrase uses `clockOf` in full ("2 at 9:00 AM"), per the Copy rules. Task 5.
8. `keyWords` with weekday and day reads "12 Thursday" on a US device, so `dayLong` and `dayShort` assemble the spec's order. `heldNights` and `whenWords` keep theirs. Task 5.
9. On a timed row's second line state words outrank "for a plan": proposed, moved, not on the calendar, "for …", the calendar's name. The accessible name carries all that apply. Task 7.
10. A due row off the calendar or moved says so on its meta line (C59, C61). Task 7.
11. `money` is null with no budget or an archived one: that is "no live budget". Task 4.
12. Money rows come in the server's order: short first, then by envelope order, unpaid before paid. Task 4.
13. `calWeekData` and `calGridData` are kept side by side. The card reads the week's; the grid and the bar the picker's while open. Leaving the tab shuts the picker. Tasks 6, 8.
14. While the picker is open the month button says the grid's month; an arrow there moves the grid and not the chosen day. Task 8.
15. A deep link's tint, Everyone view and overlays end together: another day, a bar or chip press, an arrow, Today, or a change reloading. Task 11.
16. `#cal-card` and `#cal-panel` are not width-classed, so a form stays visible across a width change. Tasks 7, 10.
17. From a row in a card a form opens in place of that row, on either width; from a box, New event or the desk's Keep nights, in `#cal-panel`. Tasks 9, 10.
18. After a desk Save the day's card opens in the panel, so focus has a row. Task 10.
19. The Keep nights row reads "Keep nights for the household"; the desk's quiet button "Keep nights". Task 7.
20. The glyph's words are "a plan in planning", "a plan in progress", "a plan done". Task 5.
21. A desk bill box past its date adds " · no receipt yet". Task 10.
22. The desk keeps its filled disc on today (C12); the chosen head takes the ink ring and `aria-current`. Task 10.
23. `.btn.small` at 29.5px is fixed in `#calendar`: `hit`, and `--control` drawn. Task 6.
24. Bar labels are account names, as Plan's, and "Household". A goal is compared ignoring case. Task 5.
25. The record row's writers come from `dayWriters(by)`, lifted from `dayCard`. Task 7.
26. Every Yours calendar row opens the Calendar (T86), on the rail's own day. Task 11.
27. `calendar.drift.resolve` has no `key`: its op has no `evt_id`. Task 3.
28. An arrow or This week on the desk closes a day's card in the panel: it names a day the grid has left. Task 10.
29. A change committed while the picker is open shuts it, so no count in the grid is stale. Task 9.

## Every Calendar row of the ledger, and its task

K kept, C changed, G gone. The five "No home" rows are K as the spec now says.

| Rows | Fate | Task |
|---|---|---|
| C1 month button | C | 6, 8 |
| C2, C3, C4 arrows, This week, the week in words | K | 1, 6 |
| C5 Keep nights; C7 New event and Add | C | 6, 7, 9 |
| C6 way to Synology Calendar | C | 6, 7 |
| C8 one panel, in place on a phone | C | 9, 10 |
| C9, C10, C11 legends and hint | G | 6 |
| C12 day heads | C | 10 |
| C13 to C17 all-day row, hours, boxes, now line, a box's look | K | 1, 10 |
| C18 second line; C19 accessible name | C | 10 |
| C20 "Busy" | K | 1, 5, 7, 10 |
| C21 strip marks; C22 its names | C | 5, 6 |
| C23 no fetch on a day | K | 6 |
| C24 to C27 heading, all-day words, timed rows, now line | C | 7 |
| C28, C29 what an arrow chooses, kept across tabs | K | 1, 6 |
| C30 what a press opens | K | 1, 9 |
| C31 a stay can be pressed | C | 7 |
| C32, C37, C42, C45, C47, C48, C49, C51 form contents | K | 1, 9 |
| C33 to C36, C38, C39, C40, C43, C44, C50, C52, C54 | C | 9 |
| C41, C46, C53, C55, C68, C69 | K | 9 |
| C56, C57 out of reach, missed | C | 6 |
| C58 to C63 what the log draws | K | 1, 2, 7 |
| C64, C65 loading, late answers | K | 1, 6, 8 |
| C66, C67 where friends book, the address | K | 1, 7 |

| Shared row | Fate here | Task |
|---|---|---|
| S2 `reloadView` | Kept; gains a Calendar branch | 6 |
| S3 listeners at load | `#cal-block` goes with its listener; the others stay with their markup | 6 |
| S5 `openTodayAt` | Kept; `evOpen` adds the stay | 1, 7 |
| S8, S10 discs | Kept: rows call them | 7 |
| S9 `otherMember`, `sourceName` | Gone | 6, 10 |
| S11, S14 clock, who is signed in | Kept | 1, 6 |
| S15 "For a plan" | Kept on 0.7.0's shape | 9 |
| S19 `openBudgetAt` | Changed: a focus key; `true` still cover, `false` nothing | 7 |
| S21 which budget | Kept: sent as `budget=` | 6 |
| S22 one error box | Kept for a week that cannot be read; forms use slots | 9 |
| S24, T86 `calWeek`, Yours row | Changed: three callers become `openCalendarAt` | 11 |
| S27 `bookingHere`, `dsmCalendarUrl` | Kept | 6, 7 |
| S28 `held.by` | Kept | 1, 7 |
| S1, S4, S6, S7, S12, S13, S16 to S18, S20, S23, S25, S26, S29 to S33 | Do not touch the Calendar | none |

---

### Task 1: The page ledger learns the Calendar's regions and pins what stands

**Files:** Modify: `api/test/page-ledger.test.ts`

**Interfaces:**
- Produces: regions `calendar` (script from `// ── the calendar` to `// ── views`), `calendarMarkup`, `calendarView`. Later tasks append to `KEPT`, `ADDED`, `GONE`, naming a region on every entry.

- [ ] **Step 1: Add the regions.** In `REGIONS`, after `plan`:
```ts
calendar: between(script, '// ── the calendar', '// ── views'),
calendarMarkup: markup.slice(markup.indexOf('<div id="calendar"'), markup.indexOf('<div id="settings"')),
calendarView: read('../src/calendar-view.ts'),
```
In `'the regions the entries are searched in are found'` add `assert.ok(REGIONS.calendar.includes('function evClasses('), 'the calendar region holds its script');`.
- [ ] **Step 2: Append to `KEPT`:**
```ts
// The Calendar (0.9.0): what stands before the rebuild and after it.
['C2', 'aria-label="Previous week"', 'calendarMarkup'], ['C2', 'aria-label="Next week"', 'calendarMarkup'], ['C3', 'This week', 'calendarMarkup'], ['C4', '.formatRange(keyDate(calWeek), keyDate(days[6]))', 'calendar'],
['C13', "node('div', 'adlab', 'all day')", 'calendar'], ['C14', "hourLabels('hours')", 'calendar'], ['C14', '.week .col.is-today{', 'css'], ['C15', 'function timedBoxes(', 'calendar'], ['C15', "'↑ '", 'calendar'], ['C15', "' ↓'", 'calendar'],
['C16', 'function nowLine(', 'calendar'], ['C16', 'Now, ${clockOf(Date.now() / 1000)}', 'calendar'], ['C17', 'function evClasses(', 'calendar'], ['C17', '.ev.proposed{', 'css'], ['C17', '.ev.drift{', 'css'], ['C17', '.ev.off{', 'css'], ['C17', '.ev.held{', 'css'], ['C20', "|| 'Busy'", 'calendar'],
['C28', 'calDay = days.includes(today) ? today : days[0]', 'calendar'], ['C29', 'await loadCalendar(calWeek ?? todayKey())', 'page'], ['C30', 'function evOpen(', 'calendar'], ['C30', 'openCard(e.plan.id)', 'calendar'], ['S5', 'openTodayAt({ drift: e.drift })', 'calendar'], ['S5', 'openTodayAt({ offer: e.proposed })', 'calendar'],
['C32', "placeholder: 'Dentist'", 'calendar'], ['C32', "'All day'", 'calendar'], ['C32', "'From'", 'calendar'], ['C32', "'To'", 'calendar'], ['C37', 'Nothing else at that time on ${listOf(out.checked)}.', 'calendar'], ['C37', 'There is no calendar to check it against yet.', 'calendar'], ['C42', "'Save'", 'calendar'],
['C45', "'Change this event'", 'calendar'], ['C45', "'Ends on'", 'calendar'], ['C45', "node('span', 'quiet', 'For ')", 'calendar'], ['C47', 'Take it off the calendar for good?', 'calendar'], ['C47', "'Delete it'", 'calendar'], ['C47', "'Keep it'", 'calendar'], ['C48', 'so only its owner changes it.', 'calendar'], ['C48', 'so it is changed where it was made.', 'calendar'], ['C48', ', shared with you', 'calendar'],
['C49', 'Kept for the household: ${heldNights(first, last)}', 'calendar'], ['C49', "'Why open them again'", 'calendar'], ['C49', 'Friends see these nights as taken.', 'calendar'], ['C51', "'Keep nights for the household'", 'calendar'], ['C51', "'First night'", 'calendar'], ['C51', "'Last night'", 'calendar'], ['C51', "placeholder: 'Family is here'", 'calendar'],
['C58', 'marked.push(', 'calendarView'], ['C59', 'offCalendar: true', 'calendarView'], ['C60', "o.tool !== 'propose_event'", 'calendarView'], ['C61', 'driftOf(e.evt_id)', 'calendarView'], ['C62', 'export function markClashes(', 'calendarView'], ['C63', 'stayEvents', 'calendarView'], ['S28', 'by: b.by', 'calendarView'],
['C64', 'if (mine === calFetch) showProblem(ex)', 'calendar'], ['C64', "$('loading').hidden = false", 'calendar'], ['C65', 'if (mine !== calFetch) return;', 'calendar'], ['C66', 'const bookingHere', 'calendar'], ['C67', 'const dsmCalendarUrl', 'calendar'],
['S11', 'const keyAt', 'shared'], ['S11', 'const mondayOf', 'shared'], ['S14', 'myName = who.who', 'page'],
```
- [ ] **Step 3: Run the pins.** Expected: PASS. Add `['C0', 'no such words', 'calendar']` to `KEPT`, expect a FAIL naming it, remove it.
- [ ] **Step 4: Suite, typecheck, commit** `api/test/page-ledger.test.ts`: "The page ledger pins what the Calendar's rebuild must keep."

### Task 2: The answer's events grow, and the window reaches 42 days

**Files:** Modify: `api/src/calendar-view.ts`, `api/test/calendar.test.ts`, `api/test/server-thread.test.ts`

**Interfaces:**
- Consumes: `ViewerEvent.owner`, `ownerOf`; `goalsOf(state)` (`api/src/plans.ts`).
- Produces, from `api/src/calendar-view.ts`:
```ts
export interface PlanRef { readonly id: PlanId; readonly title: string; readonly state: PlanState; readonly owner: Actor; readonly goal: string | null; readonly area: string }
export const planRef: (p: Plan) => PlanRef;          // ViewerEvent.plan?: PlanRef. Not thread.ts's PlanRef ({ id, title }): calendar-view.ts never imports that one
// viewerEvents answers { events, missed, mine: boolean }
// WeekEvent.held?: { kind: 'stay'; id: EventId; request: EventId; name: string; headcount: number } | { kind: 'block'; id: EventId; by: string }
// WeekCalendar gains mine?: boolean (absent when unavailable) and goals: ReturnType<typeof goalsOf>
export const WEEK_MAX_DAYS = 42;
```

- [ ] **Step 1: Write the failing tests.** In `server-thread.test.ts`, `describe('the calendar on screen')`, rename `'a window is whole days, at most eight of them'` to `'…at most forty-two of them'`; its first two lines become `inDays(43)` is 400 and `inDays(42)` is 200. In `calendar.test.ts`, inside the describe that defines `setup()`, add `describe('what the Calendar reads')`, `w = { start: '2026-11-02', end: '2026-11-09' }`:
  - `'a plan says its state, owner, goal and area, and its owner follows a hand-over'`: append `plan.due` on `2026-11-07`, `{ op: 'plan.goal', plan: 'gate', goal: 'New roof' }`, `{ op: 'plan.hand', plan: 'gate', to: 'bob' }`. `assert.deepEqual(week.events.find((e) => e.kind === 'due')!.plan, { id: 'gate', title: gate(c).title, state: gate(c).state, owner: 'bob', goal: 'New roof', area: gate(c).area })`.
  - `'a linked block the calendars did not show is drawn from the plan, once'`: a `plan.block` on 4 November and `block('b1', 901)` (no such event on the NAS): one row, `offCalendar` and `clash` undefined. Unlinked: `offCalendar: true`. Shown by the NAS: one row.
  - Update the existing held-nights assertion to `{ kind: 'stay', id: stayId, request: 'r1', name: <that stay's name>, headcount: 3 }`; the block's is unchanged.
  - `'mine…'`: true with the NAS; `'mine' in` the answer with `sid: null` is false. `'goals…'`: `assert.deepEqual(week.goals, goalsOf(c.store.state))`, a done plan's goal among them.
  - `'a proposal for your own calendar is yours'`: from an open `propose_event`, `on: 'mine'` has `owner === c.who`; `on: 'household'` has `owner === undefined`.

  Run: `cd api && node --test --experimental-strip-types test/calendar.test.ts test/server-thread.test.ts`. Expected: FAIL on those.
- [ ] **Step 2: Implement.** One `planRef(p)` replaces the four `{ id, title }` literals. `viewerEvents` answers `mine: listing.calendars.some((c) => c.isDefault)`; `weekEvents` starts `let mine = false` and reads it beside `events` and `missed`. The blocks loop follows the due loop: `shownBlocks` from `out`, `link = p.links.find((l) => l.kind === 'block' && l.block === b.id)`, `if (link && shownBlocks.has(link.evt_id)) continue`, pushed with `...driftOf(link?.evt_id), ...(link ? {} : { offCalendar: true as const })`; everything from the log stays after `markClashes`. The stays loop's `held` adds `request: st.request, name: st.name, headcount: st.headcount`; its `summary` stays as it is, the page says the name. A proposal adds `...(on === 'mine' ? { owner: ctx.who } : {})` (Ruling 5). The comment on `WEEK_MAX_DAYS` says a week or the picker's 42 days. The answer adds `...(unavailable === undefined ? { mine } : {})`, `goals: goalsOf(state)`.
- [ ] **Step 3: Run** the two files. Expected: PASS. Rows C58 to C63, what the log draws, stand: these tests and Task 1's pins hold them.
- [ ] **Step 4: Suite, typecheck, commit** the three files: "The Calendar's answer says whose an event is, what a plan is toward, who is staying, and reaches six weeks."

### Task 3: The record's numbers on the answer, and which appointment a change row is about

**Files:** Modify: `api/src/calendar-view.ts`, `api/src/thread.ts` (`openOf`), `api/test/calendar.test.ts`, `api/test/thread-view.test.ts`

**Interfaces:**
- Consumes: `build`, `ordered`, `daysOf`, `DayRow`. `DayWindow.to` is inclusive.
- Produces: `WeekCalendar.thread: readonly { day: Day; entries: number; by: DayRow['by']; waiting: number }[]`; a change entry's `open` becomes `{ calendar: Day; key?: number }`: the `{ calendar: Day }` arm of `export type Open` at the top of `thread.ts`.

- [ ] **Step 1: Write the failing tests.** In `describe('what the Calendar reads')`:
```ts
test('the record row is the numbers of a day card, unnarrowed, in any window', async () => {
  const c = await setup();
  await c.store.append('alice', { op: 'thread.note', text: 'The gate is done', budget: null });
  const row = (await weekEvents(c, { start: '2026-10-26', end: '2026-11-02' })).thread.find((t) => t.day === '2026-10-29')!;
  assert.deepEqual([row.entries, row.waiting, row.by.map((b) => b.who)], [1, 0, ['alice']]);
  assert.deepEqual((await weekEvents(c, { start: '2026-11-02', end: '2026-11-09' })).thread, []);
});
```
  And: with `sid: null` the row is still there, and an open `propose_event` for the household makes `waiting` 1. In `thread-view.test.ts`: a `calendar.appointment` and a `calendar.appointment.change` with `evt_id: 300` build change entries whose `open` is `{ calendar: <its day>, key: 300 }`; a `calendar.drift.resolve` entry's `open` has no `key`. Run both files. Expected: FAIL.
- [ ] **Step 2: Implement.** In `weekEvents`, whether or not the NAS answered: `thread: daysOf(ordered(build(await ctx.store.since(null), state, ctx.who)), state, ctx.who, { from: window.start, to: addDays(window.end, -1) }).map((r) => ({ day: r.day, entries: r.total, by: r.by, waiting: r.waiting }))`. `total`, never `count`. In `openOf` (the closure inside `build`), the shared `case 'calendar.appointment': case 'calendar.appointment.change':` return adds `key: e.evt_id` beside its `calendar` day, keeping the bare-date reading of an all-day start; `booking.block`, `booking.confirm` and `calendar.drift.resolve` stay as they are. `export type Open`'s `{ calendar: Day }` arm becomes `{ calendar: Day; key?: number }`.
- [ ] **Step 3: Run** both files. Expected: PASS.
- [ ] **Step 4: Suite, typecheck, commit** the four files: "Each day on the Calendar has the record's numbers, and a change row knows its appointment."

### Task 4: Money on a day

**Files:**
- Create: `api/src/calendar-money.ts`
- Modify: `api/src/server.ts` (the route `path === '/api/calendar'`; the route list at the top), `api/test/bills.test.ts`, `api/test/server-thread.test.ts`

**Interfaces:**
- Consumes: `billsOf(state, budget)`, `billOccurrences(bill, from, to)` (both days inclusive), `billsExpected(bills, month)`, `monthView`.
- Produces, from `api/src/calendar-money.ts`:
```ts
export interface MoneyRow {
  readonly day: Day; readonly kind: 'due' | 'autopay' | 'payby' | 'bill' | 'paid' | 'short';
  readonly budget: BudgetId; readonly envelope: EnvelopeId;
  readonly label: string;   // the envelope's name
  readonly bill?: string; readonly name: string;  // key and name; a short row's first bill's
  readonly amount?: string; readonly about?: string;  // paid: fmtExact; fmt, a short row's the sum expected
  readonly noReceipt?: true;
  readonly left?: string; readonly over?: string;  // fmt of available, when `short`
  readonly short: boolean;
  readonly bills?: number; readonly billDay?: Day; readonly billKind?: 'due' | 'autopay' | 'payby' | 'bill';  // a short row's
}
export function calendarMoney(state: State, budget: BudgetId, w: { from: Day; to: Day; today: Day }): MoneyRow[];  // `to` inclusive
```
- The route answers `money: MoneyRow[] | null`.

- [ ] **Step 1: Write the failing tests** in `api/test/bills.test.ts`, a new `describe('a bill on the calendar')`, using the file's `ev`, `pay`, `house`, `POWER`, `SET` and its unexported `envelope(id, label, categories, template, order, extra)` helper. Add the imports the file lacks: `import { calendarMoney } from '../src/calendar-money.ts'; import type { MoneyRow } from '../src/calendar-money.ts'; import { monthView } from '../src/envelopes.ts';` (`State` is imported already).
```ts
const rows = (s: State, from: string, to: string, today = '2026-11-02') => calendarMoney(s, 'harbor', { from, to, today });
const NOV = ['2026-11-01', '2026-11-30'] as const;
test('an undated bill sits on the day of its last receipt, in later months too, never in a month gone by unpaid', () => {
  const [r, ...rest] = rows(house(POWER), ...NOV);
  assert.deepEqual(rest, []);
  assert.deepEqual([r!.day, r!.kind, r!.label, r!.name, r!.about, r!.short], ['2026-11-14', 'bill', 'Utilities', 'EXAMPLE POWER BILLP', '$146', false]);
  assert.deepEqual(rows(house(POWER), '2026-12-01', '2026-12-31').map((x) => [x.day, x.kind]), [['2026-12-14', 'bill']]);
  assert.deepEqual(rows(house(POWER), '2026-10-01', '2026-10-31').map((x) => [x.day, x.kind, x.amount]), [['2026-10-14', 'paid', '$146.00']]);
});
test('a date a member set reads its kind, and says no receipt once its day has gone', () => {
  const s = house(POWER, [ev(SET)]);
  assert.deepEqual(rows(s, ...NOV).map((r) => [r.day, r.kind, r.about, r.noReceipt]), [['2026-11-16', 'due', '$146', undefined]]);
  assert.deepEqual(rows(s, ...NOV, '2026-11-20').map((r) => [r.day, r.kind, r.noReceipt]), [['2026-11-16', 'due', true]]);
});
test('a receipt takes the row to its own day', () => {
  const s = house([...POWER, pay('n', '2026-11-15', 'EXAMPLE POWER BILLP', '-143.20', 'elec')], [ev(SET)]);
  assert.deepEqual(rows(s, ...NOV).map((r) => [r.day, r.kind, r.amount]), [['2026-11-15', 'paid', '$143.20']]);
});
test('an unpaid date before it was set, in a month gone by, is not drawn', () => assert.deepEqual(rows(house([], [ev(SET)]), '2026-10-01', '2026-10-31'), []));
test('a savings envelope has no row', () => {
  const roofing = ['2026-09-20', '2026-10-20'].map((d) => pay(`r${d}`, d, 'EXAMPLE ROOFING', '-80.00', 'roofing'));
  assert.deepEqual(rows(house(roofing), ...NOV), []);
});
describe('less left than its bills', () => {
  const room = (s: State) => monthView(s, 'harbor', '2026-11')!.envelopes.find((e) => e.envelope.id === 'util')!.available;
  const leaving = (cents: number) => house([...POWER, pay('w', '2026-11-01', 'EXAMPLE WATER ONE OFF', `-${((room(house(POWER)) - cents) / 100).toFixed(2)}`, 'water')]);
  test('util is funded for these tests', () => assert.ok(room(house(POWER)) >= 14600));
  test('a short row on today, first, and on the bill it is about', () => {
    const got = rows(leaving(1400), ...NOV);
    const s = got[0]!;
    assert.deepEqual([s.kind, s.day, s.left, s.over, s.about, s.bills, s.billDay, s.billKind, s.name, s.short], ['short', '2026-11-02', '$14', undefined, '$146', 1, '2026-11-14', 'bill', 'EXAMPLE POWER BILLP', true]);
    const b = got.find((r) => r.kind === 'bill')!;
    assert.deepEqual([b.short, b.left], [true, '$14']);
  });
  const anyShort = (r: readonly MoneyRow[]) => r.some((x) => x.kind === 'short');
  test('over reads over; enough left, none; no window without today; no month not open', () => {
    assert.equal(rows(leaving(-2000), ...NOV)[0]!.over, '$20');
    assert.equal(rows(leaving(0), ...NOV)[0]!.left, '$0');
    assert.equal(anyShort(rows(house(POWER), ...NOV)), false);
    assert.equal(anyShort(rows(leaving(1400), '2026-11-08', '2026-11-30')), false);
    assert.equal(anyShort(rows(leaving(1400), '2026-12-01', '2026-12-31', '2026-12-05')), false);
  });
  test('one still without a figure is never short', () => {
    const gas = ['2026-09-09', '2026-10-09'].map((d) => pay(`g${d}`, d, 'EXAMPLE GAS CO', '-50.00', 'gas'));
    // houseEvents defines heat with no needsFigure; defined again here with it, so no other test's figures move.
    const noFigure = house(gas, [envelope('heat', 'Heating', ['gas'], '0.00', 2, { needsFigure: true })]);
    assert.equal(monthView(noFigure, 'harbor', '2026-11')!.envelopes.find((e) => e.envelope.id === 'heat')!.envelope.needsFigure, true, 'heat has no figure yet');
    assert.equal(anyShort(rows(noFigure, ...NOV)), false);
  });
});
```
  `houseEvents` is left as it is: an `envelope.define` replayed again takes `needsFigure` from that event alone. In `server-thread.test.ts`: with no budget `r.json.money === null`; with one, an array; `&budget=nope` reads the default budget, as when none is sent; an archived budget named answers `null` (Ruling 11). Run both. Expected: FAIL.
- [ ] **Step 2: Implement `calendarMoney`.** Per envelope of `state.budgets.get(budget)!.envelopes` sorted by `order` (the map `billsOf` answers is keyed by envelope id in definition order, not `order`), skipping `envelope.sinking`; per bill of `billsOf(state, budget).get(id) ?? []`, per `billOccurrences(bill, from, to)` (`{ month, day, dated, paid: BillPaid | null, about: Cents | null }`):
  - `paid` set: kind `paid`, `day: paid.day`, `amount: fmtExact(paid.amount)`, only when `paid.day` is in the window.
  - `paid` null, `dated`: kind `bill.date!.kind` (`'due' | 'autopay' | 'payby'`), `day`, `about` when not null, `noReceipt: true` when `day < today`; drawn when `bill.since !== null && day >= bill.since` (`since` is `Day | null`) or `monthOf(day) === monthOf(today)`, and in the window.
  - `paid` null, undated: kind `bill`, only when `about !== null` and `month >= monthOf(today)`.

  A savings envelope has no row (test: a fixed charge in `roof` draws nothing). Short: with `view = monthView(state, budget, monthOf(today))` not null, per `view.envelopes` entry (an `EnvelopeView`: `envelope`, `available` in cents) whose `envelope` is neither `sinking` nor `needsFigure`, `expected = billsExpected(bills, monthOf(today))` over that envelope's bills, when `expected > 0 && entry.available < expected` (`available` is the entry's; `MonthView` itself has none): if `today` is in the window one `short` row on `today` (`bills`, `billDay`, `billKind`, `name` from that envelope's unpaid occurrences this month with `about !== null`, earliest first, ties by name); every unpaid row of that envelope in this month gets `short: true` and `left` (`fmt(available)` when `>= 0`) or `over` (`fmt(-available)`). Order: Ruling 12.
- [ ] **Step 3: The route.**
```ts
const window = weekWindow(url.searchParams.get('start'), url.searchParams.get('end'));
const week = await weekEvents(ctx, window);
const budget = budgetInView(ctx, url.searchParams.get('budget'));
const live = budget !== null && !ctx.store.state.budgets.get(budget)!.archived;
return json(res, 200, { ...week, money: live ? calendarMoney(ctx.store.state, budget, { from: window.start, to: addDays(window.end, -1), today: ctx.today }) : null });
```
  `server.ts` imports `weekEvents`, `weekWindow` and `addDays` already; add `import { calendarMoney } from './calendar-money.ts';`. The route list's three lines at the top of `server.ts` that begin `GET  /api/calendar?start&end    the Calendar screen` (they say "at most 8") become: `GET  /api/calendar?start&end&budget  the Calendar screen: 1 to 42 days of events, plans' dates, held nights, the record's numbers and one budget's money`.
- [ ] **Step 4: Run** both files. Expected: PASS.
- [ ] **Step 5: Suite, typecheck, commit** the four files: "Each bill is a row on its day, a receipt moves it to the day it landed, and an envelope short of its bills says so on today."

### Task 5: What a day shows, in one block a test can read

**Files:**
- Modify: `site/index.html` (`// ── the calendar ──`: a new block; `daysOf` moves into it), `site/tokens.css`, `api/test/page-ledger.test.ts`
- Create: `api/test/calendar-day.test.ts`

**Interfaces:**
- Consumes: the answer's shape from Tasks 2 to 4; `keyAt`, `clockOf`, `listOf`, and `weekdayShort`, `weekdayLong`, which this task declares above the block (`(k) => keyWords(k, { weekday: 'short' })`, and `'long'`).
- Produces, between the markers `// ── the calendar: what a day shows ──` and `// ── the calendar: end of what a day shows ──`, using only those five names and each other, no DOM. `data` is `{ events, money, thread, goals }`; `lens` is `{ pressed, goal, over: { plans, budget, record } }`:
```js
const CAL_HOUSEHOLD = '@household';
function daysOf(e)                         // as today
const dayShort, dayLong                    // "Mon 16", "Thursday 12"
const isPlanRow = (e) => e.kind === 'due' || e.kind === 'block';
function calKey(e)                         // Ruling 4
function showsUnder(e, lens)               // the pressed calendar and the goal chip, not the overlays
function calTitle(e)
function rowKey(e)                         // String(evt_id ?? proposed ?? plan id ?? held id)
function dayView(day, data, lens)          // { shown, hidden, money, record, due, held, allDay, timed }
function dayMarks(day, data, lens)         // { count, glyph, money: 'short'|'due'|'paid'|null, clash, held }
function markList(m, limit = Infinity)
function marksWords(dayWords, m)
function barEntries(events, days, lens, order)  // [{ key, label, n }]
function pressedOn(wanted, entries)
function clashLine(timed)
function alsoHasLine(day, view)
function nowIndex(timed, nowSec)
function whenOf(e, day)                    // { top, under, bold }
function rowWords(e, day, me)
function moneyWords(m)
function visitNeedsEveryone(day, key, data, lens)  // 'absent' | false | true
function nightHeld(day, events)            // any event, shown or not
```

- [ ] **Step 1: Write the failing test,** `api/test/calendar-day.test.ts`:
```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The block has no DOM in it: it is read out of the page and run here.
const page = readFileSync(new URL('../../site/index.html', import.meta.url), 'utf8');
const block = page.slice(page.indexOf('// ── the calendar: what a day shows ──'), page.indexOf('// ── the calendar: end of what a day shows ──'));
const keyAt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clockOf = (s: number) => new Date(s * 1000).toISOString().slice(11, 16);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekdayLong = (k: string) => DAYS[new Date(`${k}T12:00:00Z`).getUTCDay()]!;
const weekdayShort = (k: string) => weekdayLong(k).slice(0, 3);
const listOf = (n: string[]) => (n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`);
const f = new Function('keyAt', 'clockOf', 'weekdayLong', 'weekdayShort', 'listOf', `${block}
return { calKey, calTitle, dayView, dayMarks, markList, marksWords, barEntries, pressedOn, clashLine, alsoHasLine, nowIndex, whenOf, rowWords, moneyWords, visitNeedsEveryone, nightHeld, dayShort, dayLong, CAL_HOUSEHOLD };`)(keyAt, clockOf, weekdayLong, weekdayShort, listOf) as any;

const H = (d: string, h = 0) => Date.parse(`${d}T${String(h).padStart(2, '0')}:00:00Z`) / 1000;
const D = '2026-11-14', NEXT = '2026-11-15';   // a Saturday, a Sunday
const timed = (summary: string, from: number, to: number, more = {}) => ({ summary, is_all_day: false, dtstart: H(D, from), dtend: H(D, to), calendar: 'mine', owner: 'alice', label: 'Mine', kind: 'other', ...more });
const allDay = (summary: string, first = D, after = NEXT, more = {}) => ({ summary, is_all_day: true, dtstart: H(first), dtend: H(after), calendar: 'household', owner: null, label: 'Household', kind: 'other', ...more });
const plan = (state: string, goal: string | null = null) => ({ id: 'gate', title: 'Fix the gate', state, owner: 'bob', goal, area: 'House' });
const due = (state: string, goal: string | null = null, more = {}) => allDay('Fix the gate', D, NEXT, { kind: 'due', plan: plan(state, goal), ...more });
const HELD = { held: { kind: 'stay', id: 's', request: 'r', name: 'Dana', headcount: 2 } };
const on = (events: any[], money: any[] = [], thread: any[] = []) => ({ events, money, thread, goals: [] });
const ALL = { pressed: null, goal: null, over: { plans: true, budget: true, record: true } };
const lens = (more: object) => ({ ...ALL, ...more });
const off = (k: string) => lens({ over: { ...ALL.over, [k]: false } });
const marks = (d: any, l: any = ALL, day = D) => f.dayMarks(day, d, l);
const hers = { calendar: 'partner', owner: 'casey', label: 'Casey' };

describe('the count', () => {
  test('a span counts on each day; a stay holds the nights before its last day', () =>
    assert.deepEqual(['2026-11-13', D, NEXT].map((d) => marks(on([allDay('x', '2026-11-13', NEXT, HELD)]), ALL, d).count), [1, 1, 0]));
  test('never money or the record', () => assert.equal(marks(on([], [{ day: D, kind: 'bill', short: false }], [{ day: D, entries: 3, by: [], waiting: 0 }])).count, 0));
  test('Plans off takes a date and a block; an appointment for a plan stays', () => {
    const d = on([due('doing'), timed('B', 9, 10, { kind: 'block', plan: plan('doing') }), timed('A', 11, 12, { kind: 'appointment', plan: plan('doing') })]);
    assert.deepEqual([marks(d).count, marks(d, off('plans')).count], [3, 1]);
  });
  test('a goal chip keeps only the plan rows that carry it, ignoring case', () =>
    assert.equal(marks(on([due('doing', 'New roof'), due('planning', 'Garden'), timed('Swim', 9, 10)]), lens({ goal: 'new roof' })).count, 2));
});

describe('whose it is', () => {
  const members = ['alice', 'bob', 'casey'];
  const d = on([timed('Mine', 9, 10), timed('Hers', 11, 12, hers), timed('Club', 13, 14, { calendar: 'partner', owner: null, label: 'Club' }), due('doing', null, { calendar: 'partner', owner: 'bob' }), allDay('Bins'), allDay('Asked', D, NEXT, { proposed: 'o1' })]);
  test("a plan's date is Household wherever its event sits; a calendar that is no member's has no key", () =>
    assert.deepEqual(d.events.map((e: any) => f.calKey(e)), ['alice', 'casey', null, f.CAL_HOUSEHOLD, f.CAL_HOUSEHOLD, f.CAL_HOUSEHOLD]));
  test('the bar: members in order with a row, then Household', () =>
    assert.deepEqual(f.barEntries(d.events, [D], ALL, members).map((e: any) => [e.key, e.label, e.n]), [['alice', 'alice', 1], ['casey', 'casey', 1], [f.CAL_HOUSEHOLD, 'Household', 3]]));
  test('a count is the sum of its day counts', () => {
    const two = on([allDay('Trip', D, '2026-11-16', { calendar: 'partner', owner: 'bob', label: 'Bob' }), timed('Mine', 9, 10)]);
    const n = f.barEntries(two.events, [D, NEXT], ALL, members).find((e: any) => e.key === 'bob').n;
    assert.equal(n, marks(two, lens({ pressed: 'bob' })).count + marks(two, lens({ pressed: 'bob' }), NEXT).count);
  });
  test('under two entries there is no bar; a person with no entry falls back to Everyone', () => {
    assert.deepEqual(f.barEntries([timed('Mine', 9, 10)], [D], ALL, members), []);
    assert.equal(f.pressedOn('bob', [{ key: 'alice' }, { key: f.CAL_HOUSEHOLD }]), null);
    assert.equal(f.pressedOn('alice', [{ key: 'alice' }, { key: f.CAL_HOUSEHOLD }]), 'alice');
  });
});

describe('the marks', () => {
  test('the glyph: doing, else planning, else done', () => {
    assert.deepEqual([[due('done'), due('planning'), due('doing')], [due('done'), due('planning')], [due('done')]].map((e) => marks(on(e)).glyph), ['doing', 'planning', 'done']);
    assert.equal(marks(on([due('doing')]), off('plans')).glyph, null);
  });
  test('money: short, else unpaid, else paid; a pressed calendar does not move it', () => {
    const m = (...k: [string, boolean][]) => on([], k.map(([kind, short]) => ({ day: D, kind, short })));
    assert.deepEqual([m(['paid', false], ['bill', true]), m(['paid', false], ['due', false]), m(['paid', false])].map((d) => marks(d).money), ['short', 'due', 'paid']);
    assert.equal(marks(m(['due', false]), lens({ pressed: 'bob' })).money, 'due');
    assert.equal(marks(m(['due', false]), off('budget')).money, null);
    assert.equal(marks({ ...m(['due', false]), money: null }).money, null);
  });
  test('a filter never clears a real clash on a row it leaves showing', () => {
    const d = on([timed('A', 9, 11, { clash: true }), timed('B', 10, 12, { clash: true, ...hers })]);
    assert.deepEqual([marks(d, lens({ pressed: 'alice' })).clash, marks(d, lens({ pressed: 'bob' })).clash], [true, false]);
  });
  test('five marks on a phone leave the hatch out', () => {
    const m = { count: 2, glyph: 'doing', money: 'due', clash: true, held: true };
    assert.deepEqual(f.markList(m, 4), ['count', 'glyph', 'money', 'clash']);
    assert.equal(f.markList(m).length, 5);
  });
  test('the accessible name says the date and every mark', () => {
    const say = (m: object) => f.marksWords('Saturday 14 November', m);
    assert.equal(say({ count: 4, glyph: 'doing', money: 'due', clash: true, held: true }), 'Saturday 14 November, 4 things, a plan in progress, money, a clash, nights held');
    assert.equal(say({ count: 1, glyph: 'planning', money: 'short', clash: false, held: false }), 'Saturday 14 November, 1 thing, a plan in planning, money short');
    assert.equal(say({ count: 1, glyph: 'done', money: 'paid', clash: false, held: false }), 'Saturday 14 November, 1 thing, a plan done, bills paid');
    assert.equal(say({ count: 0, glyph: null, money: null, clash: false, held: false }), 'Saturday 14 November, nothing on');
  });
});

describe('the card', () => {
  test('rows in their order', () => {
    const v = f.dayView(D, on([timed('Late', 15, 16), timed('Early', 9, 10), allDay('B'), allDay('A'), due('doing')]), ALL);
    assert.deepEqual([v.due.length, v.allDay.map((e: any) => e.summary), v.timed.map((e: any) => e.summary)], [1, ['A', 'B'], ['Early', 'Late']]);
  });
  test("clash phrases: one per group with two showing, the second row's start", () => {
    const c = { clash: true };
    assert.equal(f.clashLine([timed('A', 9, 11, c), timed('B', 10, 12, c), timed('C', 15, 17, c), timed('D', 16, 17, c), timed('E', 16, 18, c)]), '2 at 10:00 · 3 at 16:00');
    assert.equal(f.clashLine([timed('A', 9, 11, c)]), '');
  });
  test('"also has": what the pressed calendar or goal hides, clashing rows first; an overlay off is not reported', () => {
    const d = on([timed('Mine', 9, 11, { clash: true }), allDay('Bins'), allDay('x', D, NEXT, HELD), timed('Her thing', 10, 11, { clash: true, ...hers })]);
    assert.equal(f.alsoHasLine(D, f.dayView(D, d, lens({ pressed: 'alice' }))), 'Saturday also has 3 other things: Her thing, Bins and Dana staying.');
    assert.equal(f.alsoHasLine(D, f.dayView(D, on([due('doing')]), off('plans'))), '');
    assert.equal(f.alsoHasLine(D, f.dayView(D, on(['A', 'B', 'C', 'D', 'E'].map((s) => allDay(s))), lens({ pressed: 'alice' }))), 'Saturday also has 5 other things: A, B, C and 2 more.');
    assert.equal(f.alsoHasLine(D, f.dayView(D, on([allDay('Bins')]), lens({ pressed: 'alice' }))), 'Saturday also has 1 other thing: Bins.');
  });
  test('the now line, and when across days', () => {
    const rows = [timed('A', 9, 10), timed('B', 15, 16)];
    assert.deepEqual([8, 12, 20].map((h) => f.nowIndex(rows, H(D, h))).concat(f.nowIndex([], H(D, 12))), [0, 1, 2, -1]);
    assert.deepEqual(f.whenOf(rows[0], D), { top: '09:00', under: '10:00', bold: true });
    assert.deepEqual(f.whenOf({ ...rows[0], dtstart: H('2026-11-11', 9), dtend: H('2026-11-20', 9) }, D), { top: 'from Wed', under: 'to Fri', bold: false });
  });
  test('words', () => {
    assert.deepEqual([f.calTitle(allDay('')), f.dayLong('2026-11-12'), f.dayShort('2026-11-16')], ['Busy', 'Thursday 12', 'Mon 16']);
    assert.equal(f.calTitle(allDay('Dana staying (2)', D, NEXT, HELD)), 'Dana staying');
    const kept = [allDay('x', D, NEXT, { held: { kind: 'block', id: 'b', by: 'bob' } })];
    assert.deepEqual([f.nightHeld(D, kept), f.nightHeld(NEXT, kept)], [true, false]);
    assert.equal(f.rowWords(timed('Swim', 9, 10, { clash: true }), D, 'alice'), '09:00 to 10:00, Swim, on your calendar, clashes with another event');
    assert.equal(f.rowWords(due('doing'), D, 'alice'), 'due, Fix the gate, on Household, Doing');
    assert.equal(f.moneyWords({ kind: 'autopay', label: 'Utilities', name: 'Example Power', about: '$146', short: false }), 'Auto Pay, Utilities, Example Power, about $146');
    assert.equal(f.moneyWords({ kind: 'short', billKind: 'bill', label: 'Utilities', name: 'Example Power', about: '$146', left: '$14', short: true }), 'Bill, Utilities, Example Power, about $146, $14 left');
  });
  test('a deep link: a row a filter hides draws under Everyone; one no longer there opens the day', () => {
    const d = on([timed('Hers', 9, 10, { evt_id: 7, ...hers }), timed('Mine', 11, 12, { evt_id: 8 })]);
    assert.deepEqual(['7', '8'].map((k) => f.visitNeedsEveryone(D, k, d, lens({ pressed: 'alice' }))), [true, false]);
    assert.equal(f.visitNeedsEveryone(D, '9', d, ALL), 'absent');
    assert.equal(f.visitNeedsEveryone(D, 'gate', on([due('doing')]), off('plans')), true);
  });
});
```
  Run the day test. Expected: FAIL (`block` is empty, so the `return` throws a `ReferenceError`).
- [ ] **Step 2: Write the block,** directly after the `SPAN` constant, and delete the old `daysOf`. What the signatures and tests do not determine:
  - `dayView`: `on` is every event with `first <= day && last >= day`; `overlaid` drops `isPlanRow` when `!over.plans`; `shown`, `hidden` split it by `showsUnder`, keeping its order. `due`: by title. `held`: by start. `allDay`: `is_all_day`, neither due nor held, by start then title. `timed`: by start then end. `money` is `[]` when Budget is off or `data.money` is null (no live budget); `record` null when Record is off.
  - `calTitle`: a stay is `` `${e.held.name} staying` `` (its `summary` also carries the headcount); otherwise `e.summary || 'Busy'`.
  - `dayMarks` reads `dayView`: `count` is `shown.length`; `glyph` from shown `isPlanRow` rows only; `clash` from `timed`; `held` from `shown`.
  - `barEntries`: per member of `order`, then `CAL_HOUSEHOLD`, `n` the sum over `days` of `dayMarks(d, { events, money: [], thread: [] }, { ...lens, pressed: key }).count`; keep `n > 0`.
  - `clashLine`: flagged rows by start then end, grouped by a sweep (a row joins when it starts before the group's latest end); each group of two or more is `${n} at ${clockOf(g[1].dtstart)}`; joined `" · "`.
  - `alsoHasLine`: a hidden row "clashes with a shown one" when it has `clash` and overlaps a shown row with `clash`; those first. `names` are the first three by `calTitle`; `listOf(more > 0 ? [...names, `${more} more`] : names)`.
  - `rowWords`, joined ", ": the time (`nights`, `due`, `all day`, or `${start} to ${end}`); `calTitle`; `on Household`, `on your calendar`, `on ${owner}'s calendar`, or `on ${label}`; then those that apply: `Planning`/`Doing`/`Done` for a plan row (a local table), `proposed, not approved`, `moved on the calendar`, `not on the calendar yet`, `clashes with another event`.
  - `moneyWords`, joined ", ": its kind in words (a `short` row's `billKind`); `label`; `name`; `amount` or `about ${about}`; `no receipt yet`; `${left} left` or `${over} over`.
- [ ] **Step 3: Tokens.** In `site/tokens.css`, after `--disc-small`: `--when: 68px;` (a calendar row's when column: "10:00 AM" at 14px, 600) and `--mark: 6px;` (a day's clash dot).
- [ ] **Step 4: Run the day test.** Expected: PASS. Add to `ADDED`: `['block', '// ── the calendar: what a day shows ──', 'calendar'], ['C21', 'function dayMarks(', 'calendar'], ['C22', 'function marksWords(', 'calendar'], ['C20', "e.summary || 'Busy'", 'calendar']`. Run the pins: PASS. Grep the block for `document|node\(|\$\(|window|localStorage|settingsData|myName|calDay|calWeek`: nothing.
- [ ] **Step 5: Suite, typecheck, commit** `site/index.html site/tokens.css api/test/calendar-day.test.ts api/test/page-ledger.test.ts`: "What a day shows is worked out in one place, and a test runs it."

### Task 6: The head, the calendars bar, the overlays and the strip of marks

**Files:** Modify: `site/index.html` (the `#calendar` markup; `<style>`; `// ── the calendar ──` through the listeners after `openHeld`; `pressPerson`; `reloadView`; `forgetHousehold`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: Task 5's block; `peopleBar(host, { label, people, pressed, onPress, noun, plural })`; `goalFlag`, `stateGlyph`, `lucide`, `chosenBudget`.
- Produces: `let calHousehold = false;` directly above `pressPerson` in the shared region. In the Calendar region: `calWeekData`, `calGridData`, `calGridFrom`, `calGridMonth`, `calGoal`, `calOver` (`{ plans, budget, record }`), `calVisit` (`{ day, key, everyone }`), `calPanelDay`, `calOpen` (each null at rest but `calOver`); `calData()` (`calGridFrom && calGridData || calWeekData`); `calDays()` (the window's day keys); `calLens()`; `calPress(key)`; `renderCalendar()`, `renderHead()`, `renderPeople()`, `renderOverlays()`, `renderStrip()`; `dayCell(key, data, lens, limit, { outside })`; `drawMarks(host, m, list)`; `calDesk()` (`document.querySelector('.hp').getBoundingClientRect().width >= 1040`).

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['C1', 'class="cal-month on-phone hit" id="cal-month"', 'calendarMarkup'], ['C5', 'id="cal-keep"', 'calendarMarkup'], ['C6', 'id="cal-dsm"', 'calendarMarkup'], ['C7', 'id="cal-new"', 'calendarMarkup'], ['btn', 'class="btn small hit" id="cal-prev"', 'calendarMarkup'], ['btn', 'class="btn small hit" id="cal-next"', 'calendarMarkup'], ['btn', 'class="btn small hit on-desk" id="cal-this"', 'calendarMarkup'], ['btn', 'class="btn small hit on-phone" id="cal-today"', 'calendarMarkup'], ['btn', '.cal-bar .btn.small{min-height:var(--control)', 'css'],
['bar', 'id="cal-people"', 'calendarMarkup'], ['bar', "label: 'Whose calendar'", 'calendar'], ['bar', "noun: 'thing'", 'calendar'], ['bar', 'calHousehold = false', 'shared'], ['bar', 'function calPress(', 'calendar'],
['over', 'aria-label="Over the calendar"', 'calendarMarkup'], ['over', "'hp.calOver'", 'calendar'], ['over', "lucide('sun')", 'calendar'], ['over', 'function renderOverlays(', 'calendar'], ['over', '#cal-over{', 'css'],
['C21', 'function dayCell(', 'calendar'], ['C21', "node('span', 'marks')", 'calendar'], ['C21', '.daystrip .marks', 'css'], ['C22', 'marksWords(', 'calendar'], ['C23', 'calDay = key;', 'calendar'],
['C56', "Plans' dates, held nights, money and the record are still shown.", 'calendar'], ['C57', 'could not be read just now; the rest is shown.', 'calendar'],
['S2', "else if (view === 'calendar') await loadCalendar(calWeek)", 'page'], ['S21', 'chosenBudget()', 'calendar'], ['S27', 'bookingHere()', 'calendar'], ['S27', 'dsmCalendarUrl()', 'calendar'], ['S14', 'peopleOrder()', 'calendar'],
```
To `GONE`:
```ts
['C9', 'function legend(', 'page'], ['C9', 'cal-legend', 'page'], ['C10', 'legend(', 'calendar'], ['C11', 'Shows your calendar', 'page'], ['S3', 'cal-block', 'page'], ['C21', '.dots', 'css'], ['spec', '.legend', 'css'], ['spec', '.sw{', 'css'], ['spec', '.sw.', 'css'], ['spec', 'sourceName', 'page'], ['C6', 'class="btn small" id="cal-dsm"', 'calendarMarkup'], ['C56', 'Due dates from your plans are still shown', 'page'], ['C57', 'the rest of the week is shown', 'page'],
```
  Run: FAIL.
- [ ] **Step 2: The markup.** Replace `#cal-bar`, `#cal-legend` and the hint so `#calendar` holds, in order: the bar, `.cal-under`, `#cal-off`, `#cal-panel`, `#cal-week`, `#cal-strip`, and (until Task 7) `.day-head`, `#cal-day`. Delete `#cal-legend-phone`. Icons are the ones already on those buttons:
```html
<div class="cal-bar" id="cal-bar">
  <div class="cal-name"><h1>Calendar</h1>
    <button class="cal-month on-phone hit" id="cal-month" type="button" aria-expanded="false"><span id="cal-month-t"></span>…chevron…</button>
    <span class="range on-desk" id="cal-range"></span></div>
  <div class="cal-nav">
    <button class="btn small hit" id="cal-prev" type="button" aria-label="Previous week">…</button>
    <button class="btn small hit on-phone" id="cal-today" type="button">Today</button>
    <button class="btn small hit on-desk" id="cal-this" type="button">This week</button>
    <button class="btn small hit" id="cal-next" type="button" aria-label="Next week">…</button></div>
  <div id="cal-people" hidden></div>
  <button class="btn small primary hit on-desk" id="cal-new" type="button" aria-expanded="false">… New event</button>
</div>
<div class="cal-under">
  <div class="filters" id="cal-over" role="group" aria-label="Over the calendar"></div>
  <div class="cal-quiet on-desk">
    <button class="link hit" id="cal-keep" type="button" aria-expanded="false" hidden>Keep nights</button>
    <a class="link hit" id="cal-dsm" target="_blank" rel="noopener" hidden>Open in Synology Calendar</a></div>
</div>
```
  Every `$('cal-block')` in the script becomes `$('cal-keep')`; Task 9 rewrites those lines.
- [ ] **Step 3: State.** `calOver` reads `localStorage['hp.calOver']` (JSON of the three booleans; unreadable means all on), in try/catch. `calLens()`: with `calVisit?.everyone`, nothing pressed, no goal, `over: { ...calOver, plans: true }` (Plans is the only overlay that can hide a row a link names, and the spec turns on only that one); otherwise `{ goal: calGoal, over: calOver, pressed: pressedOn(calHousehold ? CAL_HOUSEHOLD : personPressed, barEntries(calData().events, calDays(), { goal: calGoal, over: calOver }, peopleOrder())) }`. The kept choice is never changed by this. `calPress(key)`: `calVisit = null;` `if (key === CAL_HOUSEHOLD) calHousehold = true; else pressPerson(key);` `renderCalendar()`. `pressPerson`'s first line becomes `calHousehold = false;`.
- [ ] **Step 4: `loadCalendar(weekStart)`** keeps its head, `calFetch` guard and `finally`. It reads `/api/calendar?start=…&end=…`, plus `&budget=${encodeURIComponent(chosenBudget())}` when not empty. After the guard: `calWeekData = { ...r, week: calWeek }`; release `calGoal` when no longer in `r.goals` (ignoring case); fill `#cal-off` with the shipped `icon('cal', 'i')` and exactly `${Reason}. Plans' dates, held nights, money and the record are still shown.` or `${listOf(r.missed)} could not be read just now; the rest is shown.`; `renderCalendar()`.
- [ ] **Step 5: `renderCalendar()`** returns when `!calWeekData`, sets `calOpen = null`, calls `renderHead`, `renderPeople`, `renderOverlays`, `renderStrip`, `renderDay`, `renderWeek`. `renderHead`: `#cal-month-t` from `keyWords(calDay, { month: 'long', year: 'numeric' })`; `#cal-range` moved from `renderWeek` unchanged; `#cal-keep` by `bookingHere()`; `#cal-dsm` by `dsmCalendarUrl()`; `#cal-new` hidden when `unavailable`. `renderWeek()` reads `calWeekData.events` and loses its booking, Synology, range and `legend` lines and its closing `renderDay()`. Until Task 7 `renderDay()` draws only the day: its `$('cal-month')` line and its strip loop go, since they would overwrite the new button and strip, and it reads `calWeekData.events`. Delete `calEvents`, `legend` and `sourceName`.
- [ ] **Step 6: `renderPeople()`:** entries `barEntries(calData().events, calDays(), calLens(), peopleOrder())`; `#cal-people` hidden when none; else `peopleBar($('cal-people'), { label: 'Whose calendar', people: entries, pressed: calLens().pressed, noun: 'thing', onPress: calPress })`.
- [ ] **Step 7: `renderOverlays()`** fills `#cal-over`: three `button.hit` with `aria-pressed`, "Plans", "Budget", "Record", each with its icon only while on (`lucide('square-kanban')`, `lucide('wallet')`, `lucide('sun')`). Budget is not drawn when `calData().money === null`. Each reads its state from `calLens().over`, so a visit under Everyone shows what it draws; a press sets `calOver[k]` to the opposite of what shows, writes storage, clears `calVisit`, redraws. While `calLens().over.plans` and `calData().goals` is not empty: `span.sep`, then one `button.hit` per goal holding `goalFlag(g.goal)`, `aria-pressed` from `calLens().goal`; a press sets `calGoal`, or null when already pressed, clears `calVisit`, redraws. The pressed chip scrolls into view inside the row only.
- [ ] **Step 8: `dayCell(key, data, lens, limit, { outside = false } = {})`:** a `button.hit` with `data-day`, classes `is-today` and `outside`: `span.dn` (`weekdayShort(key)`), `span.dd`, `node('span', 'marks')` filled by `drawMarks(host, m, markList(m, limit))`: `count` a `span.mk-n`; `glyph` `stateGlyph(m.glyph, { small: true })`; `money` a `span.mk-m` reading `$` (`.due`), `$!` (`.short`) or `icon('check')` (`.paid`); `clash` an `i.mk-c`; `held` an `i.mk-h`. `aria-label` from `marksWords(keyWords(key, { weekday: 'long', day: 'numeric', month: 'long' }), m)`; `aria-current="date"` when chosen. A press: `calDay = key; calVisit = null; renderCalendar();`, focus back on the same cell. `renderStrip()` draws seven with `limit` 4.
- [ ] **Step 9: Listeners and clearing.** `cal-prev`, `cal-next`, `cal-this` keep their lines plus `calVisit = null`. New: `cal-today`: `calDay = todayKey(); calVisit = null; void loadCalendar(todayKey())`. `reloadView` gains `else if (view === 'calendar') await loadCalendar(calWeek);` before its last branch. `forgetHousehold`'s id list loses the legends, gains `'cal-people', 'cal-over', 'cal-month-t'` for `'cal-month'`; its `calEvents = []` line goes; it sets the Produces state to null, all but `calOver` (a per-device choice, not the household's), and `calHousehold = false`, and hides `#cal-people`, `#cal-keep`, `#cal-dsm`.
- [ ] **Step 10: CSS.** Delete `.legend…`, `.sw…`, `.daystrip .dots…`. Add the two marker comments as the last thing in `<style>`; everything new from here goes between them. New: `.cal-name`, `.cal-nav`, `.cal-under`, `.cal-quiet`, `.cal-month` lay out the head above on tokens alone; `.cal-bar .btn.small{min-height:var(--control)}`; under 1040px `#cal-people` is a full-width row; `#cal-people .n{color:var(--ink-soft)}`; `#cal-over{…}` scrolls with no wrap, padded `var(--sp-2)` in the block axis so 44px areas are not clipped, faded at its right edge; `.daystrip .marks` a centred row: `.mk-n` `--fs-micro` `--ink-soft`, `.mk-m.due` `--caution`, `.mk-m.short` `--problem` semibold, `.mk-m.paid` `--ink-soft`, `.mk-c` a `--mark` dot in `--problem`, `.mk-h` a small hatch in `--line-strong`.
- [ ] **Step 11: Run the pins and the day test.** Expected: PASS.
- [ ] **Step 12: Check by hand.** Rows C1 to C7 (buttons), C9 to C11, C21 to C23, C28, C29, C56, C57, C64, C65, S2, S3, S9, S11, S14, S21, S27: Household pressed leaves Plan unchanged; a person pressed on Plan clears Household; a person with no entry shows Everyone pressed, the kept choice staying. Two quick arrows draw the last week. Hit-area snippet (`#cal-prev` at 1280), sideways check.
- [ ] **Step 13: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "The Calendar's head, its bar and overlays, and a strip of marks in place of dots and legends."

### Task 7: The day card

**Files:** Modify: `site/index.html` (`#cal-day` markup; `renderDay`, `evNode`, `evSub`, `timedBoxes`, `evOpen`; `openBudgetAt`; `dayCard`; the shared region; `<style>`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: Task 5's block; `calLens`, `calVisit`; `memberDisc`, `householdDisc(label)`, `laneIcon(lane)`, `stateGlyph`, `goalFlag`; `openTodayAt({ offer } | { day })`.
- Produces: `renderDayCard()` (replaces `renderDay`); `calCardHost()`, answering `$('cal-card')`; `calRow({ cls, when, slot, title, sub, figure, words, key, open, state, plan })`, the `button.erow.cal` (a `div` when `open` is null); `calDisc(e)`; `planLine(e)`; `const calAlso`, the one persistent live line; `KIND_WORDS`; `dayWriters(by)` in the shared region, answering the array of names a day card's head joins with ", "; `openBudgetAt(budget, envelope, focus)`, `focus` being `'cover' | 'bills' | true | false | undefined`. `evOpen(e)` returns a function taking the row (`anchor`), or null.

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['C24', 'function renderDayCard(', 'calendar'], ['C24', 'id="cal-card"', 'calendarMarkup'], ['C24', "'Nothing on.'", 'calendar'], ['C24', 'clashLine(', 'calendar'], ['C24', 'dayLong(', 'calendar'], ['row', 'function calRow(', 'calendar'], ['row', '.erow.cal{', 'css'], ['row', '--when', 'css'],
['C25', "'NIGHTS'", 'calendar'], ['C25', "'ALL DAY'", 'calendar'], ['C25', ' staying', 'calendar'], ['C25', 'kept by ${nameIn(', 'calendar'], ['C26', 'whenOf(', 'calendar'], ['C27', 'nowIndex(', 'calendar'], ['C27', '.cal-now{', 'css'], ['C31', 'openTodayAt({ offer: e.held.request })', 'calendar'],
['C59', 'not on the calendar yet', 'calendar'], ['C60', 'proposed, not approved', 'calendar'], ['C61', 'moved on the calendar', 'calendar'], ['C62', '.erow.cal.clash{', 'css'], ['C7', 'Add to ${', 'calendar'], ['C66', 'nightHeld(', 'calendar'], ['C6', 'id="cal-foot"', 'calendarMarkup'],
['money', "'AUTO PAY'", 'calendar'], ['money', "'PAY BY'", 'calendar'], ['money', "'BILL'", 'calendar'], ['money', "'PAID'", 'calendar'], ['money', "'DUE'", 'calendar'], ['money', ' · no receipt yet', 'calendar'], ['money', ' left`', 'calendar'], ['money', ' over`', 'calendar'], ['money', ' bills, about ', 'calendar'],
['rec', "The day's record", 'calendar'], ['rec', ' waiting on you', 'calendar'], ['rec', 'openTodayAt({ day', 'calendar'], ['rec', 'function dayWriters(', 'shared'], ['rec', 'dayWriters(', 'today'], ['also', 'alsoHasLine(', 'calendar'], ['also', "calAlso.setAttribute('aria-live', 'polite')", 'calendar'],
['S8', 'memberDisc(', 'calendar'], ['S10', 'householdDisc(e.label)', 'calendar'], ['S19', "focus === 'bills'", 'page'], ['S19', "focus === true || focus === 'cover'", 'page'],
```
To `GONE`: `['C26', 'dayview', 'page'], ['C26', "hourLabels('hrs')", 'page'], ['C24', 'cal-day-count', 'page'], ['C24', 'cal-day-title', 'page'], ['C24', '.day-head', 'css'], ['C26', 'id="cal-day"', 'page'], ['spec', 'evNode(e, long', 'page'], ['spec', 'evSub(e, long', 'page'], ['spec', 'timedBoxes(events, day, long)', 'page'], ['spec', 'renderDay(', 'page']`. Run: FAIL.
- [ ] **Step 2: Remove the hour grid.** Replace `.day-head` and `#cal-day` with `<div id="cal-card"></div>` then `<a class="link hit on-phone" id="cal-foot" target="_blank" rel="noopener" hidden>Open in Synology Calendar</a>`, set by `renderHead`. Delete `renderDay`, the `long` argument of `timedBoxes`, `evNode` and `evSub`, and every `.dayview` selector. `forgetHousehold` clears `'cal-card'` for the three day ids and hides `#cal-foot`. `renderCalendar` calls `renderDayCard` where it called `renderDay`.
- [ ] **Step 3: `calRow`.** A `button.erow.cal.hit`, or a `div` when `open` is null. Five columns: `.cal-when` (`when: [top, under]`, top `b` when bold), `.cal-slot`, `.erow-l` with `.erow-name` and `.cal-sub`, `.cal-fig`, `icon('go', 'i sm chev')` only with `open`. `aria-label` is `words`; `data-key`, `data-plan`, `data-state` when given; class `landed` when `calVisit?.day === calDay && calVisit.key === key`. A press calls `open(el)`.
- [ ] **Step 4: `renderDayCard()`.** `if (calDesk()) { $('cal-card').textContent = ''; return; }` (Task 10 extends this). `v = dayView(calDay, calWeekData, calLens())`. A `section.cal-day` labelled by `h2#cal-day-h` (`tabIndex = -1`: focus lands there): `dayLong(calDay)`, on today a `small` "Today" in the accent ink, and `span.cal-clashes` from `clashLine(v.timed)`. One `div.list` of rows in this order; with none above Add its first child is `p.cal-none` "Nothing on."

  **Money** (`v.money`). `when [KIND_WORDS[m.kind]]`, `const KIND_WORDS = { due: 'DUE', autopay: 'AUTO PAY', payby: 'PAY BY', bill: 'BILL', paid: 'PAID' }`; `slot` `laneIcon('budget')`; `title` `m.label`; `words` `moneyWords(m)`; `open` `() => openBudgetAt(m.budget, m.envelope, m.kind === 'short' && m.over ? 'cover' : 'bills')`.
  - unpaid: `sub` `m.name`, `' · no receipt yet'` when `noReceipt`, in the ordinary ink, then when `m.short` ` · ` and `span.cal-short` reading `` `${m.left} left` `` or `` `${m.over} over` ``; `figure` `` `about ${m.about}` `` when there is one.
  - `paid`: class `paid`, `sub` `m.name`, `figure` `m.amount`.
  - `short`: `when [KIND_WORDS[m.billKind], dayShort(m.billDay)]`; `sub` `` m.bills > 1 ? `${m.bills} bills, about ${m.about}` : `${m.name}, about ${m.about}` ``; `figure` the left/over words in `--problem`.

  **Due** (`v.due`). `when ['DUE']`; `slot` `stateGlyph(e.plan.state)`; `title` `calTitle(e)`; `sub` `planLine(e)`: `span.erow-meta` holding `memberDisc(e.plan.owner, { small: true })`, `goalFlag(e.plan.goal)` when it has one, the area, then Ruling 10's words. Classes `due`, `drift`, `off`; `state`, `plan`, `key`. Done: no dashes, softened title.

  **Held** (`v.held`). Class `held`; `when ['NIGHTS', `${weekdayShort(first)} – ${weekdayShort(toDay)}`]`, `first` being `daysOf(e).first` and `toDay = keyAt(e.dtend * 1000)`; `slot` `householdDisc(e.label)`. A stay: `title` `calTitle(e)`, `sub` `` `${n} ${n === 1 ? 'person' : 'people'} · ${dayShort(first)} to ${dayShort(toDay)}` ``. Kept: `title` `e.summary`, `sub` `` `kept by ${nameIn(e.held.by)} · ${dayShort(first)} to ${dayShort(toDay)}` ``.

  **All-day** (`v.allDay`). `when ['ALL DAY', <`${weekdayShort(first)} – ${weekdayShort(last)}` when it spans days>]`; `slot` `calDisc(e)`; `sub` as a timed row's.

  **Timed** (`v.timed`). `when` from `whenOf(e, calDay)`. `slot`: `stateGlyph(e.plan.state)` for a block, else `calDisc(e)`. `sub`: a block's `planLine(e)`; otherwise Ruling 9's first of `proposed, not approved` (class `proposed`), `moved on the calendar` (`drift`), `not on the calendar yet` (`off`), `` `for ${e.plan.title}` ``, `e.label` when `calKey(e) === null`. Class `clash`; a block passes `plan: e.plan.id`, so Back finds its row. On today the now line sits at `nowIndex(v.timed, Date.now() / 1000)`: `div.cal-now`, `role="img"`, `aria-label` `` `Now, ${clockOf(Date.now() / 1000)}` ``, with the time.

  `calDisc(e)`: `calKey(e) === CAL_HOUSEHOLD ? householdDisc(e.label) : memberDisc(e.owner ?? e.label)`. Every event row passes `key: rowKey(e)`, `words: rowWords(e, calDay, myName)`, `open: evOpen(e)`.

  **Record** (`v.record`). `when [String(r.entries), r.entries === 1 ? 'entry' : 'entries']`; `slot` `lucide('sun')`; `title` "The day's record"; `sub` `` [...(r.by.length ? [dayWriters(r.by).join(', ')] : []), ...(r.waiting ? [`${r.waiting} waiting on you`] : [])].join(' · ') ``, the writers joined as a day card's head joins them; `open` `() => openTodayAt({ day: calDay })`.

  **Add.** Not when `calDay < todayKey()` or `calWeekData.unavailable`: class `add`, an accent `icon('plus')`, `` `Add to ${dayLong(calDay)}` ``, `open` `(el) => openEventForm(null, { anchor: el, day: calDay })`.

  **Keep nights.** Only when `bookingHere() && calDay >= todayKey() && !nightHeld(calDay, calWeekData.events)`: a quiet row, an `.mk-h`, "Keep nights for the household", `open` `(el) => openBlockForm({ anchor: el, day: calDay })`.

  At the top of the region: `const calAlso = node('p', 'cal-also'); calAlso.setAttribute('aria-live', 'polite'); calAlso.tabIndex = -1;`. `calCardHost().replaceChildren(section, calAlso)`; `calAlso.textContent = alsoHasLine(calDay, v)`.
- [ ] **Step 5: `evOpen`** adds, after the drift line and before `e.proposed`: `if (e.held?.kind === 'stay') return () => openTodayAt({ offer: e.held.request });`. The kept-nights, change and read-only branches take the row: `(anchor) => openHeld(e, { anchor })`, and so on.
- [ ] **Step 6: `dayWriters(by)`.** Today's `dayCard` writes who wrote as one part of its second line: `if (row.by.length) second.push(row.by.map((b) => (b.who === 'claude' ? 'Claude' : (b.name ?? nameOf(b.who)))).join(', '));`. Lift the `map` into `function dayWriters(by) { return by.map((b) => (b.who === 'claude' ? 'Claude' : (b.name ?? nameOf(b.who)))); }` in the shared region (above `// ── today`; `nameOf` is the `const` just below that marker, read only when called), and that line becomes `if (row.by.length) second.push(dayWriters(row.by).join(', '));`. The head's words are unchanged.
- [ ] **Step 7: `openBudgetAt(budget, envelope, focus)`.** Its third parameter is `cover` today, and its callers pass `a.cover === true` (Today's notice), nothing (`openFor`) and `false` (the walkthrough); rename it `focus`. Its last line, `if (month.envelopes.some((x) => x.id === envelope)) openEnvelopePage(envelope, { linked: true, focus: cover ? 'cover' : null });`, becomes the same test with `focus: focus === true || focus === 'cover' ? 'cover' : focus === 'bills' ? 'bills' : null`, then when `focus === 'bills'`: `$('env-page').querySelector('[data-key="bills"]')?.scrollIntoView({ block: 'start' })`. `renderEnvelopePage({ focus })` already focuses the element whose `data-key` is the focus asked for, so `'bills'` lands on the Bills heading with no more code.
- [ ] **Step 8: CSS.** `.erow.cal{grid-template-columns:var(--when) var(--disc) minmax(0,1fr) auto auto;min-height:var(--row);border-top:var(--stroke) solid var(--hair)}`. Modifiers: `.due` a dashed `--provisional` outline, none when done (text `--ink-soft`); doing the shipped rail; `.proposed` dashed `--accent`; `.drift` a `--caution-line` outline; `.off` sunken; `.clash` a solid `--problem` outline; `.held` `var(--hatch),var(--surface-sunken)`, text `--ink-soft`; `.paid` `--ink-soft`; `.landed{background:var(--accent-tint)}`, no `--ink-faint` on it. Capitals in `--fs-micro`, `--tracking-caps`. `.cal-clashes`, `.cal-short` `--problem`; `.cal-now{…}` an accent line; `.cal-also:empty{display:none}`.
- [ ] **Step 9: Run the pins and the day test.** Expected: PASS.
- [ ] **Step 10: Check by hand.** Rows C5, C6, C7, C20, C24 to C27, C31, C58 to C63, C66, C67, S5, S8, S10, S19, S27, S28: every row kind at 375 × 812; "10:00 AM" fits. A money row opens the envelope with Bills at the top and focused. Hit-area snippet, sideways check, Graphite with no hue.
- [ ] **Step 11: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "On a phone the chosen day is one card of plain rows, with plans, money and the record in them."

### Task 8: The month picker

**Files:** Modify: `site/index.html` (`renderStrip`, `dayCell`, `renderHead`, the `cal-prev`, `cal-next`, `cal-today` listeners, a new `cal-month` listener, `showView`, `<style>`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `dayCell`, `calFetch`, `calGridData`, `calGridFrom`, `calGridMonth`.
- Produces: `openPicker(month)`, `shutPicker()`, `pickerOpen()`.

- [ ] **Step 1: Add the pins.** To `ADDED`: `['month', 'function openPicker(', 'calendar'], ['month', 'function shutPicker(', 'calendar'], ['month', "'Previous month'", 'calendar'], ['month', "'Next month'", 'calendar'], ['month', '.daystrip.month', 'css'], ['C1', "$('cal-month').setAttribute('aria-expanded'", 'calendar']`. Run: FAIL.
- [ ] **Step 2: Implement.**
  - `openPicker(month)`: `calGridMonth = month`; `calGridFrom = mondayOf(`${month}-01`)`; `$('cal-month').setAttribute('aria-expanded', 'true')`; the arrows' `aria-label`s become 'Previous month', 'Next month'; `const mine = ++calFetch`; `#loading` shown; reads `calGridFrom` to `addDayKey(calGridFrom, 42)` with the same `budget=`; under the same guard stores `calGridData` and `renderCalendar()`; a failed read `showProblem(ex)` under the guard; `#loading` hidden in a `finally` under it, as `loadCalendar` does.
  - `shutPicker()`: nothing when shut. Otherwise clears the three, `aria-expanded` false, labels back to week, `calFetch++` and `$('loading').hidden = true`, since the read it drops no longer hides the line.
  - The month button: while open, `shutPicker()`, then `loadCalendar(calWeek)` if `calWeekData?.week !== calWeek`, else `renderCalendar()`. While shut, `openPicker(calDay.slice(0, 7))`.
  - `cal-prev`, `cal-next` while open: `openPicker(<month ± 1>)`. `cal-today`: `shutPicker()` first. `showView`: `if (next !== 'calendar') shutPicker();`. `renderHead` reads `` `${calGridMonth}-15` `` while open.
  - `renderStrip`, while open and the grid's answer is in: `#cal-strip` gets class `month` and `aria-label` "This month"; seven `span.mh` (Mon to Sun), then 42 `dayCell(key, data, lens, 4, { outside: key.slice(0, 7) !== calGridMonth })`. A press in the picker: `calDay = key; calVisit = null; shutPicker(); await loadCalendar(key);`, then focus `#cal-strip [aria-current="date"]`. The card keeps reading `calWeekData`. Otherwise `renderStrip` takes the class off and the label back to "This week".
- [ ] **Step 3: CSS.** `.daystrip.month` six rows of the same cell; `.daystrip .outside .dd` in `--ink-faint`, never opacity; counts in `--fs-micro`, never `--fs-nano`.
- [ ] **Step 4: Run the pins.** Expected: PASS.
- [ ] **Step 5: Check by hand.** C1, C64, C65: with the fake DSM stopped mid-read, month then month draws nothing over. A day two months back: the picker shuts onto its week. The bar's counts follow the 42 days. Leave for Plan with it open: back, shut, week and day kept.
- [ ] **Step 6: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "Pressing the month shows its six weeks as a picker, with the same cells and marks."

### Task 9: Forms in place

**Files:** Modify: `site/index.html` (`// ── nights kept for the household ──`, `// ── a new event, and one the app made ──`, `renderCalendar`, `forgetHousehold`, `.cal-panel` CSS), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `epField`, `epErr()` (`{ err, say }`), `cancelMark`, `cancelOpen`, `calAlso`, `calCardHost`, `pickerOpen`, `shutPicker`.
- Produces:
```js
function calMount(anchor, el, first)     // closes what was open; el replaces anchor, or fills #cal-panel with no anchor; focuses first; scrolls el to the top
function closeCalOpen(focus)             // restores the row or empties the panel; focus?.focus()
function calEscape(ev)                   // the one document listener
async function afterCalChange(day, key)  // shuts the picker; calVisit = null; calDay = day; reload; focus row `key`, or calAlso when hidden
openEventForm(e, { anchor = null, day = null } = {})
openEventView(e, { anchor = null } = {})
openBlockForm({ anchor = null, day = null } = {})
openHeld(e, { anchor = null } = {})
```

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['C8', 'function calMount(', 'calendar'], ['C55', 'function closeCalOpen(', 'calendar'], ['C68', 'function calEscape(', 'calendar'], ['C68', "document.addEventListener('keydown', calEscape)", 'calendar'], ['C69', 'first.focus({ preventScroll: true })', 'calendar'],
['form', 'ep-form cal-form', 'calendar'], ['C33', "panelField('Day'", 'calendar'], ['C34', "'Which calendar'", 'calendar'], ['C34', "panelLabel('On')", 'calendar'], ['C35', "'For a plan'", 'calendar'], ['C36', "'Notes'", 'calendar'], ['C38', "'Overlaps '", 'calendar'], ['C39', "'Free from'", 'calendar'], ['C40', 'Sign in again to check for overlaps.', 'calendar'], ['C40', 'Overlaps could not be checked just now.', 'calendar'], ['C41', 'ex.status !== 400', 'calendar'],
['C43', 'say(ex.message)', 'calendar'], ['C44', 'async function afterCalChange(', 'calendar'], ['C46', 'except: e.evt_id', 'calendar'], ['C50', "'Open these nights'", 'calendar'], ['C52', "'Keep these nights'", 'calendar'], ['C52', 'Nights of a confirmed stay cannot be kept.', 'calendar'], ['C53', 'afterCalChange(from.value', 'calendar'], ['S15', 'await eventPlans()', 'calendar'], ['form', '.cal-form{', 'css'], ['form', '.cal-form .clashes .clash{color:var(--problem)', 'css'],
```
To `GONE`: `['spec', 'Block these nights', 'page'], ['C50', 'Unblock these nights', 'page'], ['C52', 'cannot be blocked', 'page'], ['C34', 'Where it goes', 'page'], ['C35', 'Plan (optional)', 'page'], ['C36', 'Notes (optional)', 'page'], ['C38', 'Clashes with ${', 'page'], ['C39', 'Free instead', 'page'], ['C40', 'check for clashes', 'page'], ['spec', 'closeCalPanel', 'page'], ['spec', 'Plan › ${e.plan.title}', 'calendar']`. And in `describe('the page ledger')`:
```ts
test('a Calendar form says a refusal once: only a week that cannot be read uses the error box', () => {
  assert.equal(uncommented(REGIONS.calendar).split('showProblem(').length - 1, 2);   // loadCalendar, openPicker
  assert.equal(uncommented(REGIONS.calendar).includes("$('app-err')"), false);
});
```
  Run: FAIL.
- [ ] **Step 2: The one thing open.** `calMount`: `closeCalOpen()`; `calOpen = { el, anchor }`; with an anchor `anchor.replaceWith(el)`, else `$('cal-panel').replaceChildren(el)`, unhidden, `calPanelDay = null`; then `el.scrollIntoView({ block: 'start' })`, `first.focus({ preventScroll: true })`. Each opener takes `const turn = ++calOpenTurn` (`let calOpenTurn = 0`) and after any `await` returns unless still the latest and its anchor, if any, still connected. `closeCalOpen`: nothing when `!calOpen`; restores `anchor` or empties and hides the panel; `#cal-keep`, `#cal-new` `aria-expanded` false; `focus?.focus()`. `renderCalendar`'s `calOpen = null` becomes `closeCalOpen()`; `forgetHousehold`'s `closeCalPanel()` becomes `closeCalOpen()` (left, it throws on every sign-in). Each marks itself `cancelMark(el, () => closeCalOpen(anchor ?? opener))`. Delete every form-level Escape `keydown`, `$('app-err').hidden = true` and `showProblem(ex)` in these forms, and `closeCalPanel`.
  `calEscape`, bound once at the top level: returns unless Escape, `view === 'calendar'`, not `ev.isComposing` and not `ev.defaultPrevented`; `if (cancelOpen($('calendar'))) { ev.preventDefault(); return; }`; `if (pickerOpen()) { shutPicker(); renderCalendar(); $('cal-month').focus(); ev.preventDefault(); }`.
  `panelField(label, attrs)` (today a `label` wrapping `node('input', 'input')`) becomes `const i = node('input', 'input'); Object.assign(i, attrs); return [epField(label, i), i];` (`epField(label, control, ...under)`, the envelope page's). A form is `node('form', 'ep-form cal-form')` in place of `node('form', 'cal-panel-form')` and its `f.style.display`/`f.style.gap` lines; its actions `node('div', 'ep-acts')` in place of `node('div', 'actions')`. `panelLabel(text)` is new, declared beside `panelField`: `const panelLabel = (text) => node('span', 'cal-l', text);`. It replaces the form's `node('span', '', 'Where it goes')`, its `ev-where-l` id and the seg's `aria-labelledby`.
- [ ] **Step 3: `afterCalChange(day, key)`:** `shutPicker(); calVisit = null; calDay = day; await loadCalendar(day);` then, when `key !== undefined`, `(calCardHost().querySelector(`[data-key="${CSS.escape(String(key))}"]`) ?? (calAlso.textContent ? calAlso : null))?.focus()`.
- [ ] **Step 4: `openEventForm(e, { anchor, day })`.** Keep `startDay`, `openHour`, `notes0`, `range()`, `check()`, `queueCheck()`, the date listeners and the `api` calls. Three headings: with an anchor `` `Add to ${dayLong(day)}` `` and no Day field (`dayIn` a detached input holding `day`); no anchor and no `e`, "New event", Day after What, `min` today, starting on `calDay` or today when that has gone; changing, "Change this event".
  Order, adding: What; All day (`label.check.hit`); From, To in `.pair`; `clash`; On; For a plan; Notes; the slot; Cancel then Save. Changing: What; Day (no `min`); All day; From, To; Ends on when it spans days; `clash`; `On ${e.label}` as `p.quiet`; `For ` and a `link hit` button of `e.plan.title` (`closeCalOpen()`, then `openCard`); Notes; the slot; Close, Delete with its `sure`, Save.
  On: `panelLabel('On')`, then `div.seg` with `role="group"` and `aria-label` "Which calendar", buttons `hit`: "Household" and, only when `calWeekData.mine`, the viewer's capitalised name with `'s`; it starts on `household` whoever is pressed. For a plan: `epField('For a plan', select)`, "None" then `` `${x.title} · ${x.area}` ``, drawn only when `await eventPlans()` has any. Notes: `epField('Notes', textarea.input)`, 2,000.
  `check()`'s words: one `p` per clash: `'Overlaps '`, `b.clash` with `c.summary || 'something'`, `` `, ${clockOf(c.dtstart)} to ${clockOf(c.dtend)}` ``. Then up to three `button.chip.hit` in `div.chips` with `role="group"` and `aria-label` "Free from", reading `clockOf(s.start)`, each setting From and To and calling `queueCheck()`. The catch keeps its shape, `if (ex.status !== 400) …`: a 400 says nothing; 409 "Sign in again to check for overlaps."; else "Overlaps could not be checked just now.". Guards use `f.isConnected`.
  Save posts what it posts now. Success: `await afterCalChange(dayIn.value, saved.appointment.evt_id)`, or `e.evt_id` when changing. Refusal: `go.disabled = false; say(ex.message);`, values kept. Delete's refusal `say(ex.message)`, success `await afterCalChange(calDay)`; it keeps its focus moves (C47).
- [ ] **Step 5: `openEventView`.** Content unchanged, in a `div.cal-form`; `ep-acts` with Close first and "Open in Synology Calendar" at the right. Focus its first button.
- [ ] **Step 6: `openBlockForm`.** Heading "Keep nights for the household"; First night starts on `day`, or `calDay` or today when that has gone; Last night; Why; hint exactly "Friends see these nights as taken, and never why. Nights of a confirmed stay cannot be kept."; slot; Cancel then "Keep these nights". Success: `await afterCalChange(from.value)`, focus `#cal-day-h`. Refusal `say(ex.message)`.
- [ ] **Step 7: `openHeld`.** Content as now; slot; Close then "Open these nights". Refusal `say(ex.message)`.
- [ ] **Step 8: Desk toggles.** `cal-keep` and `cal-new`: `aria-expanded` true closes, otherwise open and set it (C7). The `cal-new` listener's old test, the panel's `.cal-panel-form h2` reading "New event", goes with that class.
- [ ] **Step 9: CSS.** Rename every `.cal-panel X` a form uses to `.cal-form X`, moved between the markers, any literal size it carried (`72px`, `28px`) now a token; `.cal-form .clashes .clash{color:var(--problem)}`; `.cal-form{padding:var(--sp-3) var(--sp-4);scroll-margin-top:calc(var(--sp-9) + var(--sp-4))}`, no padding inside `.cal-panel`; `label.check` `--tap` tall; `.seg` and chips `--control` drawn with `hit`.
- [ ] **Step 10: Run the pins.** Expected: PASS.
- [ ] **Step 11: Check by hand,** both widths, rows C5, C7, C8, C30, C32 to C55, C68, C69, S15, S22:
  - Add: first field in the top half at 375 × 812; an overlap says so, a chip sets both times; saved onto Household with Alice pressed, focus lands on the "also has" line. A refusal fills the slot and keeps what was typed.
  - Half typed: still there after a browser tab switch and a drag across 1040.
  - A second row opened brings the first back. Escape closes a form, then the picker, focus returned.
  - Fake DSM stopped: Add is not drawn, Keep nights is.
- [ ] **Step 12: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "Adding, changing and keeping nights open in place, one at a time, and say a refusal in the form."

### Task 10: The desk

**Files:** Modify: `site/index.html` (`renderWeek`, `evNode`, `evSub`, `renderDayCard`, `calCardHost`, `afterCalChange`, `calEscape`, the `cal-prev`, `cal-next`, `cal-this` listeners, `<style>`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `dayMarks`, `markList`, `marksWords`, `drawMarks`, `showsUnder`, `isPlanRow`, `rowWords`, `moneyWords`, `calTitle`, `calKey`, `dayShort`, `KIND_WORDS`.
- Produces: `dayHead(key, data, lens)`; `pressDayHead(key)`; `openPanelDay(day)`; `moneyBox(m)`; `calCardHost()` answers `$('cal-panel')` when `calPanelDay`, else `$('cal-card')`.

- [ ] **Step 1: Add the pins.** To `ADDED`: `['C12', 'function dayHead(', 'calendar'], ['C12', "node('button', `dh", 'calendar'], ['C12', '.week .dh[aria-current="date"]', 'css'], ['C8', 'function openPanelDay(', 'calendar'], ['C8', 'function pressDayHead(', 'calendar'], ['C18', 'e.owner', 'calendar'], ['C18', 'stateGlyph(e.plan.state, { small: true })', 'calendar'], ['C19', "el.setAttribute('aria-label', rowWords(", 'calendar'], ['desk', 'function moneyBox(', 'calendar'], ['desk', '.ev.money{', 'css'], ['desk', '.ev.money.paid{', 'css'], ['desk', '.ev.money.short{', 'css'], ['desk', 'new ResizeObserver(', 'calendar']`. To `GONE`: `['C19', 'el.title = said.join', 'page'], ['C18', "parts.push('clash')", 'page'], ['C18', "parts.push('from Plan')", 'page'], ['S9', 'otherMember', 'page'], ['spec', '.ev .s{display:block;opacity', 'css']`. In `KEPT` delete `['S9', 'const otherMember', 'shared']`. Run: FAIL.
- [ ] **Step 2: Day heads.** `dayHead`: `node('button', `dh hit${key === today ? ' is-today' : ''}`)`, `data-day`, the weekday, `b` with the date (the disc on today, as now), `node('span', 'marks')` by `drawMarks` with no limit, `aria-label` from `marksWords`, `aria-current="date"` when chosen, `aria-expanded` when its card is in the panel. The first `.dh` cell stays a `div`.
- [ ] **Step 3: The panel.** `openPanelDay(day)`: `closeCalOpen(); calDay = day; calPanelDay = day; renderCalendar();`, then `$('cal-panel').scrollIntoView({ block: 'nearest' })` and focus `#cal-day-h` (`tabIndex = -1`). `pressDayHead(key)`: when `calPanelDay === key`, `calPanelDay = null; renderCalendar();` and focus the head; else `openPanelDay(key)`. `renderDayCard`: on a desk with no `calPanelDay` empties both hosts and hides the panel; otherwise draws into `calCardHost()`, the panel unhidden. The panel's section carries no `cancelMark`: `cancelOpen` takes the first in document order, so it would beat a form open inside it. Instead `calEscape` gains a last branch, `if (calPanelDay) { pressDayHead(calPanelDay); ev.preventDefault(); }`. `cal-prev`, `cal-next` and `cal-this` add `calPanelDay = null` (Ruling 28). `afterCalChange` on a desk calls `openPanelDay(day)` after the reload and before the focus.
- [ ] **Step 4: Width crossings.** At the top level of the region, `let calWasDesk = false;` and `new ResizeObserver(() => { const d = calDesk(); if (d !== calWasDesk) { calWasDesk = d; if (view === 'calendar' && !calOpen && calWeekData) { if (d) shutPicker(); else calPanelDay = null; renderCalendar(); } } }).observe(document.querySelector('.hp'));`: the desk has no picker, and the phone no panel of days.
- [ ] **Step 5: Boxes filter and say so.** In `renderWeek`, `const shows = (e) => (lens.over.plans || !isPlanRow(e)) && showsUnder(e, lens)`; the all-day loop and `timedBoxes` use `calWeekData.events.filter(shows)`. For each day, `dayView(key, calWeekData, lens).money` go into `adrow` by `moneyBox(m)` with that day's `gridColumn`.
  `evNode(e, before, after)`: `.t` is `calTitle(e)`, for a due date `stateGlyph(e.plan.state, { small: true })` before it; a block's glyph first inside `.s`. `el.setAttribute('aria-label', rowWords(e, daysOf(e).first, myName))`; delete every `el.title`. A box calls `open(null)`.
  `evSub(e, before, after)`, joined " · ": kept nights "kept for the household", a stay "a friend staying". Otherwise: the owner's name first when `e.owner && e.owner !== myName && !e.proposed`, or `e.label` when `calKey(e) === null`; `moved`; `due` and the goal, or `all day`, or the arrows and start as now; `proposed`, or `not on the calendar`. No "from Plan", no "clash".
- [ ] **Step 6: `moneyBox(m)`.** `button.ev.money` plus `paid` or `short`; `aria-label` `moneyWords(m)`; the same `openBudgetAt` as the row. `.t` over `.s`, `w` being `KIND_WORDS[…].toLowerCase()`:
  - unpaid: `` m.about ? `${m.label} · about ${m.about}` : m.label `` over `` `${w} · ${m.name}` ``, + " · no receipt yet" when `noReceipt`.
  - paid: `` `${m.label} · ${m.amount}` `` over `` `paid · ${m.name}` ``.
  - short: `` `${m.label} · ${m.left ? `${m.left} left` : `${m.over} over`}` `` over `` `${w} ${dayShort(m.billDay)}` ``.
- [ ] **Step 7: CSS.** `.ev .s` loses `opacity:.85`: a box's second line is the box's ink. `.week .dh` as a button with its shipped borders and text; `.week .dh[aria-current="date"]{box-shadow:inset 0 0 0 var(--stroke-heavy) var(--ink)}`; `.ev.money{background:var(--caution-tint);color:var(--caution)}`; `.ev.money.paid{background:var(--surface-sunken);color:var(--ink-soft)}`; `.ev.money.short{background:var(--problem-tint);color:var(--problem)}`; `.ev.partner` on `--src-other-*`.
- [ ] **Step 8: Delete `otherMember`:** its uses in the Calendar region and its declaration.
- [ ] **Step 9: Run the pins and the day test.** Expected: PASS.
- [ ] **Step 10: Check by hand** at 1280, rows C8, C12 to C20, C44, S9: a head opens its card, again closes; an arrow closes it; a box replaces the card in the panel; Escape with a form open in the card closes the form and keeps the card, and a second closes the card; New event has Day and closes on a second press. Casey's box names her; a glyph takes its box's ink; pressing Bob removes boxes as rows go; Graphite shows the ink ring. At 760 to 1039 the phone layout.
- [ ] **Step 11: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "The desk keeps its grid, with the day's marks on its heads, a day's card above it, money in the all-day row and owners named."

### Task 11: Deep links

**Files:** Modify: `site/index.html` (the Calendar region; `calendarRows`, `yoursStrip`, `openFor`; `openCalendarDay`; `openCard`, `closeCard`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `visitNeedsEveryone`, `calVisit`, `calCardHost`; a change entry's `open: { calendar, key? }`.
- Produces: `async function openCalendarAt(day, key)` in the Calendar region; `key` an `evt_id`, a proposal's id, a plan's id, or absent.

- [ ] **Step 1: Add the pins.** Remove from `ADDED` (Today's pins, not `KEPT`) `['S24', 'function openCalendarDay(', 'shared']`, `['S24', 'calWeek = mondayOf(day)', 'shared']` and `['T86', 'e.plan ? openCard(e.plan.id)', 'today']`. To `ADDED`: `['S24', 'async function openCalendarAt(', 'calendar'], ['S24', 'calWeek = mondayOf(day)', 'calendar'], ['T86', 'openCalendarAt(day, e.evt_id)', 'today'], ['S24', 'openCalendarAt(todayKey())', 'today'], ['S24', 'openCalendarAt(o.calendar, o.key)', 'today'], ['back', "view === 'plan' || view === 'calendar'", 'plan'], ['visit', 'visitNeedsEveryone(', 'calendar'], ['visit', '.erow.cal.landed{', 'css']`. To `GONE`: `['S24', 'openCalendarDay', 'page']`. Run: FAIL.
- [ ] **Step 2: `openCalendarAt(day, key)`:** `closeCalOpen(); shutPicker(); calDay = day; calWeek = mondayOf(day); calVisit = key == null ? null : { day, key: String(key), everyone: false }; calPanelDay = calDesk() ? day : null; await showView('calendar');`. In `loadCalendar`, after storing `calWeekData` and before `renderCalendar()`: when `calVisit` and not yet `everyone`, `const need = visitNeedsEveryone(calVisit.day, calVisit.key, r, calLens())`; `'absent'` clears `calVisit`; `true` sets `calVisit.everyone = true`. After `renderCalendar()`, once per visit (`calVisit.landed`): find the row in `calCardHost()`; `scrollIntoView({ block: 'center' })`; `focus({ preventScroll: true })`.
- [ ] **Step 3: Today's three callers,** and delete `openCalendarDay` (shared region; `openFor` is its only caller):
  - `calendarRows(cal)`: its `const open = (e) => (e.plan ? openCard(e.plan.id) : showView('calendar'));` becomes `const open = (e, day) => openCalendarAt(day, e.evt_id);`, a plan's event included (Ruling 26); the `cal.today` loop's rows press `() => open(e, today)` and the `cal.tomorrow` loop's `() => open(e, tomorrow)`, `today` and `tomorrow` being the function's own locals (`todayKey()`, `addDayKey(today, 1)`).
  - `yoursStrip()`: its rows are one loop over `[lane, view, …]` whose press is `() => { void showView(view); }`; it becomes `() => { void (lane === 'calendar' ? openCalendarAt(todayKey()) : showView(view)); }`.
  - `openFor(e, text)`: `const o = e.open;` and its line `else if (o.calendar) link = rowLink('Open the day', () => void openCalendarDay(o.calendar));` reads `openCalendarAt(o.calendar, o.key)` in its place.
- [ ] **Step 4: Back.** `openCard` (plan region): `cardFrom`'s `scroll: view === 'plan' ? window.scrollY : 0` becomes `scroll: (view === 'plan' || view === 'calendar') ? window.scrollY : 0`; `cardFrom.view` is already `'calendar'` from there, and `cardFrom.row` the pressed row's `data-plan`. `closeCard`: its line `if (!from || from.view !== 'plan') { await showView(from?.view ?? 'plan'); return; }` gains, after the `showView` and before the `return`: if `from?.view === 'calendar' && turn === householdTurn && view === 'calendar'`, `window.scrollTo({ top: from.scroll })` and focus `` `[data-plan="${CSS.escape(from.row ?? '')}"]` `` in `calCardHost()` with `preventScroll`.
- [ ] **Step 5: Run the pins and the day test.** Expected: PASS.
- [ ] **Step 6: Check by hand.** S24, T86: a Yours row lands centred, focused, tinted, the tint going on another day. With Bob pressed, a link to Casey's event draws under Everyone, the kept person unchanged. With Plans off, a plan's link turns it on for this visit. A removed event opens the day untinted. Plan row, card, Back: same day, scroll and focus.
- [ ] **Step 7: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "Today links to a day and a row on the Calendar, and Back from a plan returns there."

### Task 12: The sweep, the notes and version 0.9.0

**Files:** Modify: `site/index.html` (dead CSS, comments, `BUILD`, stylesheet link), `site/tokens.css`, `docs/superpowers/design/2026-10-28-design-language.md`, `docs/superpowers/design/components.css`, `api/src/calendar-view.ts`, `api/src/server.ts` (comments), `README.md`, `DEPLOY.md`, `api/package.json`, `api/package-lock.json`, `api/test/page-ledger.test.ts`

**Interfaces:** Consumes everything above. Produces release 0.9.0.

- [ ] **Step 1: The ledger says the whole of "What is deleted".** Read the spec's list beside `GONE` and add any page name still missing. In `describe('the page ledger')`:
```ts
test('the Calendar says none of the words the spec retired', () => {
  const text = uncommented(REGIONS.calendar) + uncommented(REGIONS.calendarMarkup);
  for (const w of ['Block nights', 'Unblock', 'overdue', 'thread']) assert.equal(new RegExp(`['\`>]${w}`, 'i').test(text), false, w);
});
```
  Run: PASS, or a FAIL that names something to delete now.
- [ ] **Step 2: Two members and literals.**
```bash
grep -nE "otherMember|[Tt]heirs|the two of|each other|either of you|[Bb]oth of" $W/site/index.html
/opt/homebrew/bin/git diff $(/opt/homebrew/bin/git merge-base HEAD main) -- site/index.html | grep -nE '^\+.*(#[0-9a-fA-F]{3,8}\b|rgba?\(|font-weight: *[0-9]|font-size: *[0-9]|letter-spacing: *[0-9.-]+|opacity:)'
```
  Expected: nothing on the Calendar or in the shared region; no literal. Reword comments in `calendar-view.ts` that say "the other member". If `grep -rn 'src-partner' site` finds only the three alias lines in `tokens.css`, delete them.
- [ ] **Step 3: The design language.**
  - The line beginning `- **Calendar**:` under Components reads: "- **Calendar**: `cal-bar`, `marks`, `erow cal`, `ev` (`mine`, `partner`, `household`, `proposed`, `drift`, `clash`, `due`, `held`, `money`, `paid`, `short`), `week` (desk), `daystrip` (phone)." with no "From 0.9.0" sentence.
  - "On the calendar": from "A clash is a red ring" to its end becomes: "A clash is a red ring, the only red ring; a bill its envelope cannot cover is red in its words and figure. An unpaid bill is caution, a paid one quiet, and a date going by changes neither. Held nights are hatched; a friend never sees why, a member's row names the stay or the reason."
  - Layout's paragraph beginning "**The Calendar.**" becomes: "**The Calendar.** See `specs/2026-11-09-calendar-day-page-design.md`: a strip of days with marks over one day's card of rows on a phone, the week grid with the same marks on a desk."

  In `components.css` mark `.legend`, `.legend span` and the `.sw…` rules (it has no `.dayview` or `.daystrip .dots` rule) with `/* superseded 2026-11-09: see specs/2026-11-09-calendar-day-page-design.md */`, as Today's and Plan's superseded rules there are marked. `python3 docs/superpowers/design/tools/contrast.py site/tokens.css`: exit 0.
- [ ] **Step 4: README and DEPLOY.** README `### Calendar`, before its first paragraph: "On a phone the Calendar is a strip of seven days with marks under each date, over the chosen day as one card of plain rows: what the calendars have, each plan's due date and blocks, each bill, and the day's record. The month opens from its name. Whose calendar, and whether plans, money and the record are shown, are pressed at the top. On a desk the week's grid stays, with the same marks on its day heads and a day's card above it." README `### Budget`, a new last bullet: "- **Bills.** An envelope's page lists its bills. A member may give one a Due, Auto Pay or Pay by date; with none, its day is the day of its last receipt. A receipt is what says it is paid, and the Calendar shows each bill on its day."
  DEPLOY.md, before `### Upgrading to 0.8.0`, "### Upgrading to 0.9.0": "Back up first: download each household's backup from Settings, and copy the `data` folder. 0.9.0 adds two lines to the log, written when a member sets a bill's date or removes a bill named by hand. An older build cannot open a log that holds either, so going back means restoring the backup taken before the upgrade, and whatever was written since is lost. Nothing is rewritten on upgrade, and no budget's figures move until a date is set. The Calendar reads up to six weeks at a time when its month is opened, one calendar after another, so a slow NAS may show the loading line for longer there. A page left open on a phone across the upgrade says \"Home Planner has been updated. Reload.\""
- [ ] **Step 5: The version.** From 0.8.0 in all three: `cd api && npm version 0.9.0 --no-git-tag-version`; `const BUILD = '0.9.0';`; `/tokens.css?v=0.9.0`. The ledger's build test passes.
- [ ] **Step 6: The release, by hand.** Fresh `$S/run`, seeded, both widths, light and dark:
  - **Every ledger row.** Walk C1 to C69 and each Shared row with the tables in this plan.
  - **Two parts, one release.** A date set on the envelope's page shows as DUE; a receipt moves it to PAID on its own day; no date reads BILL.
  - **An old log.** Yesterday's backup restored into a second household: a clean preview, the Calendar draws.
  - **A tab across the upgrade.** `BUILD` edited to `0.8.0` reads "Home Planner has been updated. Reload."
  - **Other screens** draw with an empty console. **No calendars:** with the fake DSM stopped the rest still shows under the `.unavailable` line.
  - Hit-area snippet, sideways check, Graphite at 375 with no hue on any chosen or pressed state. Stop both by pid.
- [ ] **Step 7: Nothing private went in.** The branch's file list has none of the Data paths above, and no added test or doc names anything a real household would recognise.
- [ ] **Step 8: Suite, typecheck, commit** the files above: "Version 0.9.0: the Calendar as a day page, and bills on their days."
