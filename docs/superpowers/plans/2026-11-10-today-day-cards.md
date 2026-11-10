# Today as day cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release 0.8.0: Today becomes one card per household day, opened by its briefing, with rows that read lane icon, who, what, when; six kinds and the people bar narrow every day at once; what waits on the viewer is listed first and jumps to its buttons; and the household's one search moves into Today's head.

**Architecture:** `api/src/lanes.ts` gives every op and tool a lane. `build()` in `api/src/thread.ts` makes every visible card its own entry and stamps each entry with lane, day, `fresh` and `waits`; a pure `daysOf()` makes the numbers; `GET /api/thread` answers days, a month at a time, with a day mode; `GET /api/search` answers the same shape. One op joins the log. On the page `#briefing` is rebuilt under the page ledger, and the six card renderers are re-housed in a dashed block.

**Tech Stack:** Node 22.6+ TypeScript by type stripping, `node:test`, an append-only log, one vanilla-JS page.

**Spec:** `docs/superpowers/specs/2026-11-09-today-day-cards-design.md` (binding; the Rulings below settle what it leaves open). **Inputs:** `docs/superpowers/design/2026-11-10-carry-over-ledger.md`, `…/2026-11-10-redesign-gap-outline.md`, `…/2026-11-10-visual-audit.md`.

## Global Constraints

- **Dropped elements are the owner's standing worry.** Every row of the carry-over ledger's Today section, and each "Shared and at risk" row that touches Today, is owned by a named task with its fate, and `api/test/page-ledger.test.ts` pins it. A page task is done when its pins pass and the reviewer has ticked its rows against the running page.
- Build from the spec, not the wireframes, where they differ.
- No colour, weight, tracking or size as a literal in new CSS: tokens only (`--fs-*`, `--fw-*`, `--sp-*`, `--r-*`, `--stroke*`, `--tap`, `--control`, `--row`, `--disc`, `--disc-small`, `--tracking-*`, `--mark-fill`, `--claude-paper`, `--claude-line`, `--provisional`). New rules go between `/* ── today: day cards ── */` and `/* ── end of today ── */`, the last thing in `<style>`.
- Every control has a 44px hit area through 0.7.0's helper: class `hit` on the control. A selected state is never a tint alone: a pressed kind is the ink-filled pill. No text is dimmed by opacity. No two-member assumptions: nothing says "either of you", "each other" or "both", and no code picks "the other member". One word per concept on screen: "entry" and "entries" are what is counted; nothing on the page says "thread" or "lane".
- Copy: sentences, the app's spellings, no exclamation marks. A row is a past-tense sentence starting with who. A count is a number and a noun ("7 entries", "2 waiting", "3 new", "1 of 3"). A date is a weekday, a day and a month, the year only when not this one; times are the household's. " · " separates parts of a line; no dashes.
- The wireframes' stylesheet is never pasted. No new class named `.row`, `.rows`, `.line`, `.quiet`, `.msg`, `.bubble`, `.turn`.
- The public tree stands in Alex, Bob, Casey, Dana, `planner.example.com` and "Example Power" for real names; no real names, banks, utilities, employers, vendors, private addresses or devices in code, tests or docs. (Test accounts are `alice`, `bob`, `carol`; a third member in a test is `casey`.)
- Data is not code: never commit `api/data/`, `site/budget.jsonl`, `site/transactions.jsonl`, `site/planner.html`, `.env` or `.claude/`.
- Commits: `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit` (never bare `git`), a plain-sentence subject with no conventional-commit prefix, then a blank line and exactly: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- "Suite, typecheck, commit" means `cd api && npm test` and `cd api && npm run typecheck`, both clean, then the commit of the files named with the sentence given.
- `site/index.html` is about 12,900 lines: find things by the function, id or `// ── name ──` marker named. The script is one module: a listener or call left behind for something deleted throws at load and nothing below it runs, sign-in included. "Run the pins" means `cd api && node --test --experimental-strip-types test/page-ledger.test.ts`.
- Built alongside the Bills plan in another worktree: stay out of `// ── an envelope's page ──`, `api/src/envelopes.ts`, `api/src/money.ts` and the analytics. Whoever merges second adds `bill.set` and `bill.remove` to `budget` in `laneOf` and gives both `open: { budget, envelope }` in `openOf`; typecheck names the first.
- Between Task 4 and Task 15 Today is partly drawn or throws. The branch is never deployed mid-way.
- **Page checks** use the fake DSM on 5598 and the planner on 5577, started by hand with inline environment variables; never port 5555. `W` is the worktree's root, `S` a scratch folder outside the repository; run each in the background:
```bash
mkdir -p $S/run/fake-root
DSM_PORT=5598 FAKE_DSM_ACCOUNTS=alice:correct-horse,bob:battery-staple,casey:paper-lantern FAKE_DSM_ROOT=$S/run/fake-root node --experimental-strip-types $W/api/tools/fake-dsm/server.ts
PORT=5577 COOKIE_INSECURE=1 TZ=America/Denver SITE_DIR=$W/site DSM_URL=http://127.0.0.1:5598 PLANNER_ROOT=/Planner LOG_PATH=$S/run/events.jsonl HOUSEHOLDS_DIR=$S/run/households SESSIONS_PATH=$S/run/sessions.json CONNECTORS_PATH=$S/run/connectors.json node --experimental-strip-types $W/api/src/server.ts
```
  Open `http://localhost:5577`; sign in as alice, make the household "Home", add bob and casey under Settings. Stop by pid: `kill $(lsof -nP -iTCP:5577 -sTCP:LISTEN -t)`, the same for 5598; never `pkill`. Check at 375 and 1280, light and dark, console open, with entries by three members. **Hit-area snippet** answers `[]`: `[...document.querySelectorAll('#briefing .hit')].filter((el) => el.offsetParent).map((el) => [el.textContent.trim().slice(0, 20), getComputedStyle(el, '::after').height, getComputedStyle(el, '::after').width]).filter(([, h, w]) => parseFloat(h) < 44 || parseFloat(w) < 44)`. A second one finds a control with no helper, and answers `[]` at 1280, where a `.btn` is drawn under 44: `[...document.querySelectorAll('#briefing button, #briefing a')].filter((el) => el.offsetParent && !el.classList.contains('hit') && el.getBoundingClientRect().height < 44).map((el) => el.textContent.trim().slice(0, 20))`. "Hit-area snippet" in a task means both. **Sideways check** at 375 answers `true`: `document.documentElement.scrollWidth <= innerWidth`.

## Review Focus

1. **An element dropped.** Pinned by the page ledger (Tasks 1, 7 to 16) and each page task's row list, ticked against the running page.
2. **Something waiting hidden by a narrowing.** With a kind and a person pressed, on a closed day in a month not loaded, the list's heading carries the whole count. Pinned in Task 5 (`waiting` unnarrowed) and Task 13's check.
3. **A day that differs by device or by the log's order.** 23:30 household time on the 10th sits on the 10th when UTC says the 11th; after a restore a day's rows are in time order and adopted lines read new. Pinned in Tasks 4 and 5.
4. **A person typing loses their words.** Coming back to the browser tab with a reason half typed leaves the form. Pinned by the check in Task 7 and the Escape order in Task 9.
5. **An old log, an old tab, every kind of card.** An old ask, both drifts, a guest's request and a cancelled stay all draw; a 0.7.0 tab is told to reload. Pinned in Tasks 4, 9 and 16.

## Rulings

1. `daysOf` keeps the spec's signature and reads `waits` and `fresh` from the entries, which `build()` stamps; it adds an optional `only` set (the words of a search).
2. `daysOf` returns days with entries; `thread()` adds today's empty row, so the Calendar can use `daysOf` over a window without today.
3. With no read cursor, or one the log no longer holds, nothing is fresh.
4. `waiting` and `fresh` use what is shown, `count` what is counted: under a pressed person a card their question raised adds to the first two only.
5. A fallback briefing and a card the app raised have no author in `by`. The app's cards carry `app: true`, because `who` on a drift, Savings short or a cancelled stay is whoever noticed.
6. `by` is ordered by the server: the viewer, members in the household's order, former members, Claude, guests by name.
7. An unanswered question is `claude`.
8. A head opens a card with `GET /api/thread?day=`, which applies `lane` and `who` literally, with no fallback, and does none of the briefing work, so it needs no `quiet=1`.
9. `waiting` items gain `inView` and `name`. The receipts item is in view under All and Budget with Everyone.
10. `entries` run newest day first; within a day the briefing, then time, then log order. `opensItsDay` is deleted.
11. The answer adds `last`, the last-placed entry in the log, which the page sends to `POST /api/briefing/read`.
12. `open: { calendar }` goes on rows whose op names a day: an appointment made or changed, a calendar drift resolved, nights kept (`from`), a stay confirmed (`arrive`).
13. An appointment both renamed and moved reads "moved <new name>".
14. `dav_etag` on the new op falls back to the etag read before the write.
15. A decision matches no search: its card is the hit.
16. `elsewhere` narrows by kind only (shown under All and Plans). A file hit carries `on`, its plan's title.
17. A result row's link reads "Show in its day"; "Open the day" already means the Calendar.
18. The desk, for Today, starts at 1040px: where Yours becomes a column.
19. No icon in a pressed kind: six pills must fit 375.
20. The people bar stays while a person is pressed, even with only that member in view. It gains `plural`, or its name would read "entrys".
21. `dayName` and `monthName` assemble dates in the spec's order; the month's name stays in the device's language.
22. "3 of 7 entries" shows only when the numbers differ.
23. Times in answers and settled lines use `clockAt`; `asOf` and `timeOf` stay for the plan's card.
24. When `GET /api/today` fails, the phone's strip is left out; the desk column stays as last drawn (T96).
25. `Put it back`'s refusal goes in a slot, not a label (T31 against the spec's rule).
26. "to your own calendar" when the row is the viewer's.
27. `owner` is set in `viewerEvents`: a member or null.
28. `.link` is underlined everywhere (the audit's note).
29. `set_bill` is listed in the tool table now, so Bills needs no edit there.
30. The three prompt lines that tell Claude a household is two people stay (spec, Non-goals).

## Every Today row of the ledger, and its task

K kept, C changed, G gone. The 21 "No home" rows are K or C as the spec now says; T92 is G. Each page task carries its own pins.

| Rows | Fate | Task |
|---|---|---|
| T1, T2, T3 | K | 1, 7 |
| T4, T6 | C | 12; old markup goes in 7 |
| T5, T10, T13, T110, T116 | G | 7 |
| T7, T8, T9, T115 | C | 7 |
| T11, T12, T109, T111, T112, T113, T114, T117 | K | 7 |
| T14, T17 | C | 10 |
| T15, T16, T18, T19 | K | 10 |
| T82, T85 | C | 11 |
| T81, T83, T84, T86 (until 0.9.0), T87 to T91, T93 to T96 | K | 11 |
| T92 | G | 11 |
| T20, T28, T34, T35, T40, T41, T46, T47 | C | 9 |
| T21, T29 | C | 8 |
| T22 to T27, T30 to T33 | K | 8 |
| T36 to T39, T42 to T45, T48 to T69, T120, T121 | K | 9 |
| T70, T72 | C | 13 (tray goes in 7) |
| T71, T74 to T78, T118, T119 | K | 15 |
| T73, T79, T80 | C | 15 |
| T97, T99, T101, T102 | C | 14 |
| T98, T103, T104, T105, T107 | K | 14 |
| T100, T106, T108 | G | 14 |
| S1, S2, S3, S4, S5, S14, S21, S31 | held | 7 (S3 + 14) |
| S6, S7, S22 | held | 9 |
| S8, S27 | done in 0.7.0; not touched here; pinned | 1 |
| S13 | held | 10 |
| S9, S10, S18, S32 | held | 11 |
| S11, S12, S19, S24, S29 | held | 8 (S29 + 4) |
| S20 | held | 8 + 13 |
| S23 | held | 14 |
| S25, S26 | held | 4 |
| S15, S16, S17, S28, S30, S33 | do not touch Today | none |

---

### Task 1: The page ledger learns Today's regions and pins what stands today

**Files:** Modify: `api/test/page-ledger.test.ts`

**Interfaces:**
- Produces: regions `today` (script from `// ── today` to `// ── budget`), `todayMarkup` (the markup of `#briefing`) and `threadSrc` (`api/src/thread.ts`). Later tasks append to `KEPT`, `ADDED`, `GONE`, naming a region on every entry.

- [ ] **Step 1: Add the regions.** In `REGIONS`, after `plan`:
```ts
today: between(script, '// ── today', '// ── budget'),
todayMarkup: markup.slice(markup.indexOf('<div id="briefing"'), markup.indexOf('<!-- Budget, Import and Compare')),
threadSrc: read('../src/thread.ts'),
```
Rename the `describe` to `'the page ledger'`; drop the words about 0.8.0 from the comment above `planMarkup`. In `'the regions the entries are searched in are found'` add `assert.ok(REGIONS.today.includes('function renderSetupNotes('), 'the today region holds its script');`.
- [ ] **Step 2: Append to `KEPT`** (each stands today and must stand after):
```ts
// Today (0.8.0): what stands before the rebuild and after it.
['T1', 'Put Home Planner on your Home Screen', 'todayMarkup'], ['T1', 'function homeBanner(', 'page'], ['T2', 'openSettings(a.group, a.row)', 'today'], ['T3', 'openBudgetAt(a.budget, a.envelope, a.cover === true)', 'today'],
['T19', 'Sign in again to read the whole ${what}.', 'today'], ['T19', 'The full text is on the old NAS.', 'today'], ['T19', 'The whole ${what} could not be read just now.', 'today'],
['T24', 'Claude answered · ', 'today'], ['T25', 'Read the whole answer', 'today'], ['T26', 'Looked at ${looked.join(', 'today'], ['T27', "Claude didn't answer this one.", 'today'], ['T27', "'Ask again'", 'today'],
['T30', 'not in the ledger', 'page'], ['T30', 'function removedBlock(', 'page'], ['T31', 'Why it belongs after all', 'page'], ['T31', "'Leave it'", 'page'], ['T32', "'/api/thread/seen'", 'today'],
['T36', "o.tool === 'move_money' || o.tool === 'set_assignment'", 'today'], ['T37', 'The numbers have moved since this was suggested.', 'today'], ['T37', "'Work it out again'", 'today'],
['T38', 'Reason, as it will read in the record', 'today'], ['T38', 'Approving needs a reason, the same as moving money', 'today'], ['T39', 'function adjustForm(', 'today'], ['T39', 'Amount to move', 'today'], ['T39', 'Fund it at', 'today'], ['T39', "'Suggest this instead'", 'today'], ['T39', 'Enter an amount in dollars', 'today'], ['T39', 'It needs a reason', 'today'],
['T42', 'Replaced by a newer suggestion for the same envelopes.', 'today'], ['T43', '. It comes back if its numbers change.', 'today'], ['T45', 'ctx.pending.has(o.id)', 'today'],
['T48', "actionButton('Take it'", 'today'], ['T48', ' reads this`', 'today'], ['T48', 'Declining needs a reason', 'today'], ['T51', 'Taken by ', 'today'], ['T51', 'The ask to ', 'today'],
['T52', "plan: 'Move the plan too'", 'today'], ['T52', "plan: 'Take the change'", 'today'], ['T52', "calendar: 'Put the page back'", 'today'], ['T52', "leave: 'Leave both'", 'today'], ['T54', 'if (!d.deleted)', 'today'], ['T55', 'd.unreadable === true', 'today'],
['T57', "plan: 'Moved the plan too'", 'today'], ['T57', "leave: 'Left both'", 'today'], ['T57', "plan: 'Took the change made in Drive'", 'today'], ['T57', "leave: 'Left the page as edited'", 'today'], ['T57', '; it changed again since, and the newer card asks about it', 'today'], ['T57', '; let go when the plan was removed', 'today'],
['T59', 'Seen by ', 'today'], ['T59', 'A newer balance came in since', 'today'], ['T59', 'Put away by ', 'today'], ['T60', "'Suggest other dates'", 'today'], ['T62', 'Declining needs a reason: they will read it', 'today'],
['T63', "'Suggest these dates'", 'today'], ['T63', 'Choose the day they would arrive and the day they would leave', 'today'], ['T63', 'They leave after they arrive', 'today'], ['T63', 'Suggesting other dates needs a reason: they will read it', 'today'],
['T66', 'Replaced by a newer request', 'today'], ['T66', 'Withdrawn by them', 'today'], ['T67', "'Take it off the calendar'", 'today'], ['T68', 'Taken off the calendar by ', 'today'], ['T68', 'Left on the calendar by ', 'today'], ['T69', 'dataset.offer', 'today'], ['T69', 'dataset.drift', 'today'],
['T74', 'id="leave-note"', 'todayMarkup'], ['T75', 'id="ask-claude"', 'todayMarkup'], ['T76', "Claude isn't set up on this server. Notes still work.", 'today'], ['T77', 'Asking Claude…', 'today'], ['T78', "Claude couldn't answer: ${r.error}", 'today'],
['T81', 'Yours · what the briefing was written from', 'todayMarkup'], ['T83', '.today > .yours{', 'css'], ['T84', 'function calendarRail(', 'today'], ['T84', 'function eventWhen(', 'today'], ['T88', 'could not be read just now.`', 'today'], ['T89', 'cal.unavailable', 'today'], ['T90', 'Nothing on your calendars today or tomorrow.', 'today'],
['T91', 'Plans that need you', 'todayMarkup'], ['T91', 'function plansRail(', 'today'], ['T93', 'Nothing of yours is due this week, or in Doing.', 'today'], ['T94', 'Money this month', 'todayMarkup'], ['T94', 'function moneyRail(', 'today'], ['T95', 'No budget has this month open yet.', 'today'],
['T103', 'Nothing in the household matches that.', 'page'], ['T104', 'The search could not be done just now.', 'page'], ['T105', 'Sign in again to search briefings, answers and files too.', 'page'], ['T112', 'function showProblem(', 'page'], ['T113', 'This household has no budget yet. ', 'page'], ['T114', 'Open it from the template', 'page'],
['T118', "ev.key === 'Enter' && !ev.shiftKey", 'today'], ['T119', '!ev.isComposing', 'today'],
['S12', 'const dayKey', 'today'], ['S12', 'const timeOf', 'today'], ['S12', 'const fmtDate', 'today'], ['S12', 'const asOf', 'today'], ['S13', 'const docTexts', 'today'], ['S13', 'function readDocText(', 'today'], ['S13', 'const docRead', 'today'], ['S13', 'let docHousehold', 'today'],
['S14', 'claudeOn = who.claude === true', 'page'], ['S20', 'id="unsorted-q"', 'page'], ['S20', 'async function categoryList(', 'page'], ['S21', 'const chosenBudget', 'page'], ['S24', 'let calWeek', 'page'], ['S27', 'const bookingHere', 'page'], ['S27', 'const dsmCalendarUrl', 'page'],
```
- [ ] **Step 3: Run the pins** against the page as it is. Expected: PASS (these strings were checked against the page at 33e9c67). Add `['T0', 'no such words', 'today']` to `KEPT`, expect a FAIL naming it, remove it.
- [ ] **Step 4: Suite, typecheck, commit** `api/test/page-ledger.test.ts`: "The page ledger pins what Today's rebuild must keep."

### Task 2: Every op and every tool has a lane

**Files:** Create: `api/src/lanes.ts`, `api/test/lanes.test.ts`

**Interfaces:**
- Produces from `api/src/lanes.ts`: `type Lane = 'budget' | 'calendar' | 'plans' | 'claude' | 'notes'`; `const LANES: readonly Lane[]` (that order); `isLane(v: unknown): v is Lane`; `laneOf(e: Event | NewEventShape, state: Pick<State, 'pageDrifts'>): Lane | null`; `const TOOL_LANES: Readonly<Record<string, Lane>>`; `cardLane(o: Pick<Offer, 'tool' | 'events' | 'prompt'>, state: Pick<State, 'pageDrifts'>): Lane`.
- **For 0.9.0 (Calendar, Bills):** `Lane`, `laneOf` and `TOOL_LANES` are the spec's table.

- [ ] **Step 1: Write the failing test.** `api/test/lanes.test.ts`, with `const state = { pageDrifts: new Map([['pd1', {}]]) } as never` and `const lane = (op, extra = {}) => laneOf({ op, ...extra } as never, state)`:
```ts
const WANT = {
  budget: ['assign', 'move', 'income.set', 'month.open', 'month.close', 'month.discard', 'txn.add', 'txn.categorize', 'txn.split', 'txn.remove', 'rule.add', 'rule.remove', 'envelope.define', 'envelope.remove', 'envelopes.model', 'budget.create', 'budget.rename', 'budget.locate', 'budget.archive', 'category.define', 'category.archive', 'category.sinking', 'income.source.define', 'income.source.remove', 'account.balance', 'savings.account'],
  calendar: ['calendar.appointment', 'calendar.appointment.remove', 'calendar.household', 'calendar.household.rename', 'calendar.target', 'guest.allow', 'guest.revoke', 'guests.arrival', 'guests.booking', 'booking.block', 'booking.unblock', 'booking.confirm', 'booking.cancel', 'booking.suggest', 'booking.release'],
  plans: ['plan.create', 'plan.state', 'plan.remove', 'plan.due', 'plan.block', 'plan.unblock', 'plan.attach', 'plan.detach', 'plan.hand', 'areas.set', 'areas.rename', 'areas.add', 'areas.remove', 'goal.rename', 'goal.remove'],
  notes: ['household.claim', 'member.add', 'member.remove', 'household.zone', 'links.set', 'documents.folder', 'thread.note'],
  claude: ['thread.briefing', 'thread.ask'],
};
const NONE = ['briefing.read', 'prediction.record', 'flag.seen', 'scheme.set', 'calendar.conflicts', 'plan.doc', 'documents.moved', 'thread.answer', 'proposal.offer', 'proposal.decide', 'plan.set', 'plan.checklist', 'plan.contact.link', 'plan.contact.unlink', 'plan.calendar.link', 'plan.calendar.unlink', 'plan.calendar.etag', 'plan.page.drift', 'calendar.drift', 'plan.ask', 'plan.ask.accept', 'plan.ask.decline', 'plan.goal', 'areas.move', 'shelves.retire'];
```
  Tests: one per lane (`lane(op) === name` for each); `NONE` all null; `lane('calendar.drift.resolve', { drift: 'd1' }) === 'calendar'`, with `'pd1'` `'plans'`; every write tool has a lane: `assert.deepEqual([...toolByName.values()].filter((t) => t.kind === 'write' && !(t.name in TOOL_LANES)).map((t) => t.name), [])` and `TOOL_LANES['ask_to_take'] === 'plans'`; `cardLane` of `propose_event` is `calendar`, `resolve_drift` with `prompt.ref` `'d1'` `calendar` and `'pd1'` `plans`, `move_money` `budget`; a name only an old log knows: first event `plan.state` gives `plans`, first event `plan.set` (no lane) gives `budget`, no events gives `budget`; `LANES` is the five in order. Run: FAIL.
- [ ] **Step 2: Write `api/src/lanes.ts`.** `laneOf` is an exhaustive `switch (e.op)` with no default, the shape of `scopeOf` in `api/src/restore.ts`, so a new op without a case fails `tsc`. `calendar.drift.resolve` is `plans` when `state.pageDrifts.has(e.drift)`, else `calendar`. `TOOL_LANES`: `plans`: create_plan, update_plan, set_plan_state, set_checklist, set_plan_due, block_plan_time, remove_plan, hand_plan, set_plan_goal, ask_to_take, answer_ask, link_contact, create_contact. `calendar`: propose_event, approve_booking, release_stay, resolve_drift. `budget`: move_money, set_assignment, set_envelope_figure, set_month_income, set_sinking_goal, categorize_transactions, restore_transaction, open_month, close_month, discard_month, create_budget, rename_budget, archive_budget, set_budget_location, seed_from_location, define_envelope, remove_envelope, add_starter_set, make_starter_envelopes, define_category, archive_category, define_income_source, remove_income_source, savings_short, set_bill. `cardLane`: `resolve_drift` with `state.pageDrifts.has(prompt.ref)` is `plans`; otherwise `TOOL_LANES[o.tool] ?? (o.events[0] ? laneOf(o.events[0], state) : null) ?? 'budget'`. Import only types from `types.ts`.
- [ ] **Step 3: Run it.** `cd api && node --test --experimental-strip-types test/lanes.test.ts`. Expected: PASS.
- [ ] **Step 4: Suite, typecheck, commit** `api/src/lanes.ts api/test/lanes.test.ts`: "Every op and every tool that can raise a card has a lane."

### Task 3: A moved appointment gets a log line

**Files:**
- Modify: `api/src/types.ts` (`Event` union beside `calendar.appointment.remove`; `BOARD_CALENDAR_OPS`), `api/src/replay.ts` (`validateCalendarLines`; the fold), `api/src/restore.ts` (`scopeOf`), `api/src/tools.ts` (`describe`), `api/src/thread.ts` (`PLAN_LINES`), `api/src/lanes.ts`, `api/src/appointment-edits.ts` (`changeEvent`)
- Test: `api/test/server-calendar-events.test.ts`, `api/test/households.test.ts`, `api/test/lanes.test.ts`

**Interfaces:**
- Produces: `{ op: 'calendar.appointment.change'; evt_id: number; summary: string; start: string; end: string; allDay: boolean; dav_etag: string; was: { summary: string; start: string; end: string; allDay: boolean } }`, `start` and `end` being ISO instants as `calendar.appointment` writes them.
- **For 0.9.0:** the Calendar's in-place changes keep writing this through `changeEvent`.

- [ ] **Step 1: Write the failing tests.** In `server-calendar-events.test.ts`, inside `describe('POST /api/calendar/events/:id…')`, using its `make`, `call`, `log`, `day`, `form`:
  - `'a move writes one line, with what it was as the NAS had it'`: make "Swim" at `${day(2)}T16:00` to `T17:00`, POST `T16:30` to `T17:30`; `const line = (await log()).findLast((e) => e.op === 'calendar.appointment.change')`; `line.start === new Date(`${day(2)}T16:30:00Z`).toISOString()`; `line.was` deep-equals `{ summary: 'Swim', start: …T16:00…, end: …T17:00…, allDay: false }`; `line.dav_etag` truthy.
  - `'a rename writes one line; a save of the notes alone writes none'`: a notes-only POST leaves `(await log()).length` alone; a new name gives `[line.was.summary, line.summary]` `['Swim', 'Swim practice']`.
  - `'with a plan linked, the change and the etag are one write'`: `(await log()).slice(-2).map((e) => e.op)` is `['calendar.appointment.change', 'plan.calendar.etag']`, and their `at` are equal.
  - `'the log refusing puts the event back as it was read'`: call `changeEvent(ctx, id, body, f)` directly with `ctx.store.append` rejecting; the NAS event's `summary` and `dtstart` are the old ones.
  - `'the log refusing and the undo failing says so'`: the same, with the fake fetch failing the second write: rejects with `/could not be put back/`.
  In `households.test.ts`, beside `'plans restore into an empty household whose areas they need'`: a source holding `calendar.appointment` then `.change` (`evt_id` 7, "Swim practice"); `planRestore(store.state, parseBackup(...), ['plans']).collisions` is `[]`; after `adopt`, `store.state.appointments.get(7)!.summary === 'Swim practice'`. A `.change` for `evt_id` 99 with none recorded is refused `/not recorded/`; one with an empty `summary` `/summary/`. Add the op to `WANT.calendar` in `lanes.test.ts`. Run: FAIL.
- [ ] **Step 2: Implement.** `validateCalendarLines` gains the op in its guard and a case: `whole(e.evt_id, 'evt_id')`, `named(e.summary)`, `named(e.dav_etag)`, start and end parse, `end >= start`, `allDay` boolean, `was` an object meeting the same four. The fold refuses `appointment ${e.evt_id} is not recorded` and otherwise sets `summary`, `start`, `end`, `allDay`, `dav_etag` on the `Appointment`, leaving `who`, `at`, `plan`, `contact`. Add it to `BOARD_CALENDAR_OPS`, `PLAN_LINES`, `scopeOf`'s `plans` group, `laneOf`'s `calendar`. `describe()`: if `start`, `end` or `allDay` differ from `was`, `moved ${e.summary}`; else `renamed ${e.was.summary} to ${e.summary}`.
  `changeEvent`: after the write and the etag, build `lines`: the change when `asked.summary !== current.summary.trim()` or `!unchanged`, its `summary` and `allDay` from `asked`, `start` and `end` `at(asked.dtstart).toISOString()` and `at(asked.dtend).toISOString()` (as `calendar.appointment` writes them), with `was` from `current` (`at(current.dtstart).toISOString()`, `at` from `calendar.ts`, `allDay: current.is_all_day`) and `dav_etag: etag || current.dav_etag`; then the plan's `plan.calendar.etag` under its existing condition. If any, `writePlan(ctx, lines)` in a `try`; on an error `setEvent(sid, { ...now, dav_etag: etag || now.dav_etag }, { summary: current.summary, description: current.description, is_all_day: current.is_all_day, dtstart: current.dtstart, dtend: current.dtend, tz_id: zoneOf(ctx.store.state) }, f)` and rethrow the first error. If the undo throws: `new ToolError('the change was saved on the calendar but could not be recorded, and it could not be put back: look at it in Synology Calendar', 502)`.
- [ ] **Step 3: Run them.** Expected: PASS.
- [ ] **Step 4: Suite, typecheck, commit** the files above: "Moving or renaming an appointment in the app writes a line to the log."

### Task 4: Every entry has a lane and a day, and every card is its own entry

**Files:**
- Modify: `api/src/thread.ts`, `api/src/activity.ts` (export `findRemoved`), `api/test/page-ledger.test.ts`
- Test: `api/test/thread-view.test.ts`, `api/test/conversation.test.ts`, `api/test/calendar.test.ts`, `api/test/server-thread.test.ts`

**Interfaces:**
- Consumes: `Lane`, `laneOf`, `cardLane`.
- Produces, exported from `api/src/thread.ts`: on every entry `lane: Lane; day: Day; fresh?: true; waits?: true`; `build(events: readonly Event[], state: State, who: Actor): ThreadEntry[]` (log order); `ordered(entries): ThreadEntry[]` (newest day first; in a day the briefing, then `at`, then log order; stable); `authorOf(e: ThreadEntry): Actor | null` (a briefing `'claude'`, or null when `writtenBy` is `fallback`; a card with `app`: null; else `e.who`); `interface Raised { how: 'briefing' | 'answer' | 'research' | 'member'; entry: EventId; day: Day; at: string; by: Actor }`.
  Entry changes: `cards` gone from `briefing` and `answer`; `card` adds `name?`, `app?: true`, `raised?: Raised`, `flags?: { event: EventId; removed?: Removed; seenByMe: boolean }[]`; new `{ kind: 'decision'; id; at; who; decision: 'approved' | 'declined'; why?: string; offer: { id: EventId; summary: string; day: Day } }`; `change` adds `plan?: PlanRef`, `open?: { plan: PlanId } | { budget: BudgetId; envelope: EnvelopeId } | { calendar: Day }`, `event?: { summary; start; end; allDay; on: 'household' | 'own'; was?: { summary; start; end; allDay } }`.
- **For 0.9.0:** `daysOf` reads `build` and `ordered`; a calendar row's `open` grows `key?` in `openOf`.

- [ ] **Step 1: Write the failing tests** in `thread-view.test.ts`. Change `ctx()` to `ctx(clock = { now: NOW })`, the store's `now: () => new Date(clock.now)`; add `const entries = async (c, who = 'alice') => build(await c.store.since(null), c.store.state, who);` and in `describe('flat entries')`:
  - a `move_money` offer with prompt `{ kind: 'briefing', ref: b.id }` is a `card` in lane `budget` with `raised` deep-equal `{ how: 'briefing', entry: b.id, day: '2026-08-13', at: NOW, by: 'claude' }`; a `propose_event` (`on: 'household'`) answering bob's question has lane `calendar`, `raised.how` `'answer'`, `raised.entry` the question's id, `raised.by` `'bob'`; the briefing has no `cards` key.
  - after a briefing with `replaces`, `raised.entry` is the newer id (S25).
  - a day is the household's: clock `'2026-08-14T04:30:00Z'`, `household.zone` `'America/Denver'`, a note's `day` is `'2026-08-13'`.
  - a decision: decided at `NOW`: no `decision` entry; offered at `NOW`, declined with why "no" at `'2026-08-15T09:00:00Z'`: `[d.day, d.lane, d.decision, d.why, d.offer.day]` is `['2026-08-15', 'budget', 'declined', 'no', '2026-08-13']`.
  - the effect of an approved card, and a drift let go by a plan's removal, are not `change` rows (S26).
  - `propose_event` on `mine` for alice is absent from `entries(c, 'bob')`.
  - `open`: `assign` `{ budget, envelope }`; `move` `{ budget, envelope: to }`; `envelope.define`; `plan.state` on a live plan `{ plan }`, on a removed plan no `open`.
  - an appointment: `event.on === 'household'`, `event.summary`, `event.was.summary`; `open.calendar` is the start's day.
  - `fresh`: bob's note with no cursor: not fresh; after `briefing.read` of it, bob's next note is fresh, alice's own and the read one are not.
  - `waits`: an open offer `waits`; a decided one no; a removal by bob unseen by alice `waits`.
  - guest's booking offer `name`; a drift, a `savings_short` and a `release_stay` card `app === true` and `authorOf` null (S29).
  - an offer with `txn.remove` in `events`, approved: no `change`; `card.flags[0].event` is its id, `removed.payee` set.
  - `'ordered'`: over `{ id, day, at, kind }` literals, `['z' briefing, 'b', 'b2', 'c', 'a']` for a day holding b, b2 (same `at`), c and a briefing z at the latest time, and an earlier day holding a.
  Update old readers: in `thread-view.test.ts`, `'answers attach…'`'s tail is `slice(-4)`, `['briefing', 'card', 'ask', 'card']`, and its `.cards` assertions read a `card` entry's `raised`; `'a briefing replaced later…'` finds a `card` whose `raised.entry === only.id`; `'what an approval applied…'` expects `['briefing', 'card', 'note']`; `'waiting shows only…'` expects the card's id. In `conversation.test.ts` near "The thread hangs the card under the answer", the card is its own entry with `raised.entry === r.question.id`. In `calendar.test.ts`, `ids` reads only `e.kind === 'card'`. In `server-thread.test.ts`, near "The card rides on Claude's answer": cards are `entries.filter((e) => e.kind === 'card' && e.offer.tool === 'propose_event' && e.raised?.entry === asked.id)`, `cards[0].offer.summary`. Add to the ledger `ADDED`: `['S25', 'settle(', 'threadSrc'], ['S26', 'appliedBy', 'threadSrc'], ['S29', 'guestEmail(', 'threadSrc']` and to `GONE`: `['spec', 'function opensItsDay', 'threadSrc'], ['spec', 'const standalone', 'threadSrc'], ['spec', 'cardsFor', 'threadSrc']`. Run: FAIL.
- [ ] **Step 2: Implement `build()`.** Delete `standalone`, `cardsFor`, `opensItsDay`, and `cards` on both types. `case 'proposal.offer'`: every `visibleTo` offer pushes a card, keeping today's `ask`, `drift`, `blocked`; `plan` is `asked?.plan ?? drift?.plan ?? e.plan ?? args.plan` when the state has it; `name` for a guest as a change has it; `app: true` when `prompt.kind` is `drift` or `savings`, or the tool is `release_stay`. `raised`: for `briefing`, `entry: settle(ref)`, its `day`, `at`, `by: 'claude'` (none for a null ref); for `answer` and `research`, the answer's question: its id, its `householdDay`, `at`, `who`; for `member`, `entry: ref`, the replaced offer's day and `at`, `by: e.who`. `case 'proposal.decide'`: approved or declined, offer visible, and the two days differ: a `decision`, lane `cardLane(offer)`. The `applied` set becomes `appliedBy: Map<EventId, EventId>` (effect to offer), fed by both of today's rules. After the loop, each `txn.remove` in `appliedBy` adds to its card `flags: [{ event, removed: findRemoved(events, e.txn, state), seenByMe }]`.
  Stamp each entry: `lane`; `day` (`householdDay(zoneOf(state), at)`; a briefing its own); `fresh` when the cursor's place in the log is known, the event's place is after it and `authorOf(e) !== who`; `waits` when `waiting(state, who, events)` names it (an offer by id; a flag by its change's id, or through `appliedBy` its card). A local `openOf(e, state, tz)` per Ruling 12 and: a `plans`-lane change naming a live plan (`e.plan`, `state.hands`, or the page drift's plan) `{ plan }`; `assign`, `envelope.define` `{ budget, envelope }`; `move` `{ budget, envelope: e.to }`. A change's `plan` is `planRef` of the plan its op names, `state.hands` or the page drift's. `event.on` is `sameCalendar(appointment, state.calendar.household)`. In `thread()`, `hasWaiting` becomes `e.waits === true`, `inView` treats a `decision` as household-wide, and it sorts with `ordered` (Task 5 finishes it).
- [ ] **Step 3: Run them** and the whole suite; fix any other reader of `.cards` the typecheck names. Expected: PASS.
- [ ] **Step 4: Suite, typecheck, commit** `api/src/thread.ts api/src/activity.ts api/test/page-ledger.test.ts` and the four test files: "Every entry has a lane and a day, and every card a person may see is its own entry."

### Task 5: Days, their numbers, and the route that answers them

**Files:**
- Modify: `api/src/thread.ts`, `api/src/server.ts` (`path === '/api/thread'`)
- Create: `api/test/thread-days.test.ts`, `api/test/every-entry.ts`
- Test: the callers listed in Step 3

**Interfaces:**
- Consumes: `build`, `ordered`, `authorOf`.
- Produces, exported from `api/src/thread.ts`:
```ts
export interface DayRow { day: Day; count: number; total: number; waiting: number; fresh: number; by: { who: Actor; name?: string; count: number }[] }
export interface DayWindow { from: Day; to: Day; lane?: Lane; who?: Actor | 'everyone'; only?: ReadonlySet<EventId> }
export function seen(e: ThreadEntry, lane: Lane | undefined, person: Actor | 'everyone'): boolean;
export function counted(e: ThreadEntry, lane: Lane | undefined, person: Actor | 'everyone'): boolean;
export function daysOf(entries: readonly ThreadEntry[], state: State, viewer: Actor, w: DayWindow): DayRow[];
export interface ThreadOptions { who: Actor; today: Day; through?: string; open?: readonly Day[]; lane?: Lane; person?: Actor | 'everyone' }
export type WaitingItem = Waiting & { lane: Lane; by: Actor | null; name?: string; at?: string; day?: Day; title: string; entry?: EventId; inView: boolean };
export interface ThreadPage { today: Day; who: Actor | 'everyone'; days: DayRow[]; entries: ThreadEntry[]; waiting: WaitingItem[]; newSince: EventId | null; before: string | null; last: EventId | null }
export async function thread(store: Store, o: ThreadOptions): Promise<ThreadPage>;
export async function threadDay(store: Store, o: { who: Actor; today: Day; day?: Day; at?: string; lane?: Lane; person?: Actor | 'everyone' }): Promise<{ today: Day; days: DayRow[]; entries: ThreadEntry[] } | null>;
```
- **For 0.9.0:** the Calendar's `thread: [{ day, entries, by, waiting }]` is `daysOf(ordered(build(events, state, who)), state, who, { from, to })`, unnarrowed.

- [ ] **Step 1: Write the failing tests.** `api/test/every-entry.ts`: `everyEntry(s: Store, who: Actor)` answers `{ entries: ordered(build(await s.since(null), s.state, who)), waiting: waiting(s.state, who, await s.since(null)) }`.
  `api/test/thread-days.test.ts`, entries as literals (`note(id, day, who, over)`, `brief(id, day, over)`, `card(id, day, who, over)`), `state = { members: new Set(['alice', 'bob', 'casey']) } as unknown as State`, `W = { from: '2026-11-01', to: '2026-11-30' }`, `pick` mapping to `[day, count, total]`:
  - a kind narrows count, never total: `[note, note lane budget, brief]` gives `[[D, 3, 3]]`, under `lane: 'budget'` `[[D, 1, 3]]`.
  - under a pressed person the briefing is shown, not counted: `[[D, 1, 2]]`.
  - a card a person's question raised: `raised.by: 'bob'`, `waits`, `fresh`, under `who: 'bob'` with bob's question: `[count, waiting, fresh]` is `[1, 1, 1]`.
  - `by` order: entries by a guest (`name: 'Dana'`), `claude`, `casey`, `bob`, `alice`, viewer alice, under `who: 'bob'`: `row.by.map((b) => b.name ?? b.who)` is `['alice', 'bob', 'casey', 'claude', 'Dana']`.
  - an `app` card and a fallback briefing leave `by` empty.
  - newest first, inside the window, no row for a day with no entry.
  - `only: new Set(['a'])` of two notes: `[[D, 1, 2]]`.
  `describe('thread()')` on a real `Store` with a movable clock, three members and a zone:
  - the first load covers today's month; `through: '2026-10'` adds October's days; today is always a row, zeros when nothing was written; `entries` holds today and each day in `open` only.
  - `before` is the next month back with a day in view under the kind: two months back when the month between holds nothing under it; null at the start.
  - `person: 'casey'` with nothing in view answers `who: 'everyone'` with everyone's entries; with entries, `who: 'casey'`.
  - `waiting` is every item under `lane: 'notes'` (Review Focus 2), `inView` false on a budget offer, each with `lane`, `by`, `at`, `day`, `title`, `entry`; the receipts item has no `entry` or `day`, comes last, title `14 receipts to sort`; an old ask's `title` is the plan's; a removal's `A receipt was removed: Corner Shop, $12.40`; a guest's item has `name`.
  - after `Store.adopt` of lines older than the day's first, that day's `entries` are in time order and the adopted lines are `fresh`.
  - `last` is the last-placed entry's id; `newSince` the cursor.
  - `threadDay`: `day` gives one row and that day's entries; `at` an answer's, an offer's, a drift's or a question's id gives that day; an id no day shows gives null.
  In `server-thread.test.ts`: each of `lane=money`, `who=nobody`, `day=2026-13-45`, `through=2026-1`, `open=nope` is 400 matching `/lane must be budget, calendar, plans, claude or notes/`, `/who must be a member/`, `/day must be a date/`, `/through must be a month/`, `/open must be dates/`; `at=none` is 404; `filter=mine&all=1&limit=1&before=e1` answers the same entry ids as none of them; after `quiet=1` and `day=<today>`, the count of `thread.briefing` events in the log has not moved; day mode's `Object.keys(json).sort()` is `['days', 'entries', 'today']`.
- [ ] **Step 2: Implement.** In `thread.ts` delete `ThreadOptions.filter`, `allBudgets`, `limit`, `before`, `budget`, and `author`, `hasWaiting`, `inView`. An exported `seen(e, lane, person)` (lane matches; person is everyone, or `authorOf` matches, or `e` is a briefing, or a card with `raised.by === person`) and `counted(e, lane, person)` (`seen`, not a briefing under a person, not a card by someone else under them). `daysOf`: `total` is every entry that day in the window; `by` counts `authorOf` for entries passing the lane and `only`, sorted per Ruling 6, a guest's `name` carried; `waiting` and `fresh` count `seen` with those stamps.
  `thread()`: `from` is `${through ?? today.slice(0, 7)}-01`; days under `person`; a person asked with every `count` 0 recomputes as everyone and answers `who: 'everyone'`. A zero row for today if none. `entries` is `ordered`, today plus `open`, `seen`. `before`: the greatest month under `from`'s month holding a `counted` entry under the lane and person applied. `waiting`: `waiting(state, who, events)` mapped to `WaitingItem`s, newest first, `unsorted` last, every item; `entry` is the entry whose `id` is the offer's or the flag's event, or whose `flags` hold that event (a receipt an approved card removed has no row of its own); `inView` by `seen` on that entry (Ruling 9); `title` per the spec's "Waiting on you". `last`: the entry with the greatest log place.
  `threadDay`: for `at`, the entry whose `id`, `answer.id` or `offer.id` is `at`, or whose drift prompt's `ref` is, or whose `flags` hold it; null if none. Answers that day's row and `seen` entries.
  `server.ts`: a local `threadQuery(url, state)` validates, the wire's `who` becoming `person` (`isDay`, `/^\d{4}-(0[1-9]|1[0-2])$/`, `isLane`, `who` as `GET /api/plans` does, same message); `day` or `at` go first to `threadDay` (404 `no day shows that`); the briefing, drift, pages and release block runs only when `quiet` is not `1`; `noBudgets`, `noOpenMonth` and the default `budget` stay.
- [ ] **Step 3: Move the old callers.** Every `thread(s, { who: X, budget: … })` in `briefing.test.ts`, `calendar.test.ts`, `conversation.test.ts`, `page-drift.test.ts`, `plans.test.ts`, `settings-log.test.ts`, `settings.test.ts` becomes `everyEntry(s, X)`. In `activity.test.ts`, `activity` reads `everyEntry`, reversed; delete `'"theirs" is how you find…'`; `'"waiting" holds…'` keeps entries where `e.waits`. In `calendar.test.ts` delete the `for (const f of ['waiting', 'theirs'])` loop. In `thread-view.test.ts`, `page` reads `everyEntry`; delete `'the default view…'`, `'mine and theirs…'`, `'waiting shows only…'`, `'paging returns…'`, `'what is waiting counts only…'`; `'the divider sits…'` reads `state.readCursor`. In `server-plans.test.ts` and `server-book.test.ts` drop `?filter=waiting`; where a test then asserts a card is absent from `entries` (`hers`, `still`, the deepEqual near `/ask-to-take`) assert on `.json.waiting`. In `server-thread.test.ts` drop `&filter=mine`.
- [ ] **Step 4: Run them.** Expected: PASS, whole suite.
- [ ] **Step 5: Suite, typecheck, commit** the sources and tests above: "The record answers by the day, with its numbers worked out in one place."

### Task 6: One search over the record

**Files:** Modify: `api/src/search.ts`, `api/src/server.ts` (`path === '/api/search'`); Test: `api/test/search.test.ts`, `api/test/server-thread.test.ts`

**Interfaces:**
- Consumes: `build`, `ordered`, `daysOf`, `seen`, `counted`.
- Produces: `searchRecord(ctx: ToolContext, words: string, o: { lane?: Lane; person?: Actor | 'everyone' }, f?: DsmFetch): Promise<RecordResults>`; `interface RecordResults { who: Actor | 'everyone'; days: DayRow[]; entries: (ThreadEntry & { passage?: string })[]; capped: boolean; elsewhere: (SearchHit & { on?: string })[]; documents: 'searched' | 'not searched' }`; `const RECORD_MAX = 100`. `fromDrive` answers `{ hits: SearchHit[]; atLimit: boolean } | null`. `searchHousehold` and Claude's `search` tool behave as before.

- [ ] **Step 1: Write the failing tests** in `search.test.ts`, `describe('the record, searched')`, on `fresh()`, `member()`, `writeDoc` and the fake Drive as `'briefings and answers are found…'` uses them:
  - each of a note, question, answer, briefing, change, removed payee and card's effects finds its entry.
  - a day of 3 entries, 2 matching: `days[0]` `count` 2, `total` 3.
  - a question found in its answer has `passage` at the match; found in the question, the answer's opening.
  - a briefing and an answer kept only in Drive are joined, `passage` Drive's; a briefing since replaced is dropped.
  - 101 notes: `entries.length` 100, `capped` true; Drive answering 50: `capped` true.
  - `elsewhere` is plans and files, 8 at most, `file.on` the plan's title.
  - `lane: 'budget'`: `elsewhere` `[]`; `lane: 'plans'` kept; `person: 'bob'` only bob's rows; a person with no match: `who: 'everyone'`.
  - a card on someone's own calendar is not found by anyone else.
  In `server-thread.test.ts`, `'the search box asks for two letters…'`: `kind=thread` is now 200; `r.json.elsewhere[0].open.plan` is the plan; `documents` is `'not searched'`; `lane=money` and `who=nobody` are 400. Run: FAIL.
- [ ] **Step 2: Implement `searchRecord`.** Over `ordered(build(...))`, with `has()`: `note` text; `ask` text and `answer.text`; `briefing` headline and body; `change` `what`, `why`, `flag.removed.payee`; `card` `offer.summary`, `offer.effects`, `offer.why`, `ask.why`; never `decision`. `passage` with `around()`. `fromDrive` (not `searchHousehold`, so its cut of 8 does not apply): keep `briefing` and `answer` hits, join on `open.event` to the briefing's id or the entry whose `answer.id` it is, Drive's passage overriding; drop what no entry shows. Person and lane by `daysOf`'s rules, falling back as `thread()` does. Keep the newest `RECORD_MAX`, morning to night within a day; `capped` if cut or `atLimit`. `days = daysOf(all, state, who, { from: '0000-01-01', to: ctx.today, lane, who: applied, only: new Set(keptIds) }).filter((d) => d.count > 0)`. `elsewhere`: Drive's `plan` and `file` hits then `fromLog`'s plans not already found, `.slice(0, SEARCH_MAX)`, empty unless the lane is unset or `plans`. Route: `searchWords(q)`, lane and who validated with Task 5's messages.
- [ ] **Step 3: Run them.** Expected: PASS, whole suite.
- [ ] **Step 4: Suite, typecheck, commit** `api/src/search.ts api/src/server.ts api/test/search.test.ts api/test/server-thread.test.ts`: "Search answers day cards of matching rows, and plans and files elsewhere."

### Task 7: The page's frame, the day cards, and getting to a row

**Files:** Modify: `site/index.html` (`#briefing` markup; `<style>`; `// ── today ──`, `// ── the thread ──`; `openTodayAt` in the shared region; `searchGo`; `evOpen`; `showView` and the tab bar's handler; `forgetHousehold`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `GET /api/thread` (`ThreadPage`).
- Produces in the Today region: `threadData`, `todayKind` (`'all'` or a lane), `todaySort` (`'newest'`), `todayThrough` (month or null), `daysOpen` (`Set` of days other than today), `todayShut`, `dayRows` (`Map<Day, entries[]>`); `dayIsOpen(day)`, `threadParams(extra)`, `loadThread({ quiet })` (name kept: its callers stay), `renderToday()`, `dayCard(row)`, `rowFormOpen()`, `pressDay(day)`, `todayCtx()`, `watchLastRow()`; hosts `#today-head`, `#today-day`, `#t-kinds`, `#t-people`, `#t-waiting`, `#days`, `#day-today`, `#earlier`, `#earlier-days`.
- Produces in the shared region (**for 0.9.0**): `async function openTodayAt(target)`, `target` being `{ day } | { event } | { offer } | { drift }`, answering true or false; `dayName(key, { year })` ("Wednesday 11 November"; the year when not this one, or when asked); `monthName(month)` ("October", the year when not this one); `clockAt(iso)`.

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['T7', 'function dayCard(', 'today'], ['T7', "'Today'", 'today'], ['T7', 'aria-expanded', 'today'], ['T7', 'function dayName(', 'shared'], ['T7', 'function monthName(', 'shared'], ['T7', 'function clockAt(', 'shared'],
['T8', 'New since you last looked', 'today'], ['S1', "api('/api/briefing/read', { upTo: threadData.last })", 'today'], ['S1', 'function watchLastRow(', 'today'], ['T9', "todayKind === 'all'", 'today'],
['T11', "if (view === 'today') { window.scrollTo({ top: 0 }); await loadThread(); }", 'page'], ['T12', 'if (rowFormOpen()) return;', 'today'], ['S5', 'openTodayAt({ drift: e.drift })', 'page'], ['S5', 'openTodayAt({ offer: e.proposed })', 'page'], ['T109', "block: 'center'", 'shared'],
['T111', "$('loading').hidden = false", 'today'], ['T113', "new Error('This household has no budgets yet.", 'today'], ['T114', "new Error('no open month')", 'today'], ['T115', 'Nothing yet today. Ask Claude something, or leave a note.', 'today'], ['T117', 'if (turn !== loadTurn || household !== householdTurn) return;', 'today'],
['S2', 'else await loadThread();', 'today'], ['S3', "$('days').addEventListener('focusin'", 'today'], ['S31', "$('days').addEventListener('focusout'", 'today'],
['frame', '<h1>Today</h1>', 'todayMarkup'], ['frame', 'id="today-day"', 'todayMarkup'], ['frame', 'id="t-kinds"', 'todayMarkup'], ['frame', 'id="t-people"', 'todayMarkup'], ['frame', 'id="t-waiting"', 'todayMarkup'], ['frame', 'id="day-today"', 'todayMarkup'], ['frame', 'id="earlier-days"', 'todayMarkup'], ['frame', '.day-open{', 'css'], ['frame', '.day-body', 'css'],
```
To `GONE`:
```ts
['T4', 'id="t-filters"', 'page'], ['T4', 'threadFilter', 'page'], ['T4', '>Mine<', 'page'], ['T4', '>Theirs<', 'page'], ['T4', '>Everything<', 'page'], ['T5', 'id="t-all"', 'page'], ['T5', 'threadAll', 'page'], ['T5', 'All budgets', 'page'], ['T6', 'id="t-earlier"', 'page'], ['T6', 'Show earlier', 'page'], ['T10', 'document.documentElement.scrollHeight', 'today'], ['T13', 'id="thread"', 'page'], ['T13', "$('thread')", 'page'], ['T72', 'id="tray"', 'page'], ['T72', "$('tray')", 'page'], ['T72', ' waiting on you`', 'page'], ['T110', 'filterBeforeDetour', 'page'], ['S4', 'endFilterDetour', 'page'], ['T116', 'Nothing is waiting on you.', 'page'], ['spec', "$('composer'))", 'today'],
```
And a test:
```ts
test("Today's new rules name tokens, never literals", () => {
  const css = between(REGIONS.css, '/* ── today: day cards ── */', '/* ── end of today ── */').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(css.length > 200, 'the section is found');
  assert.deepEqual(css.replace(/[^{}]+\{/g, '{').match(/#[0-9a-f]{3,8}\b|rgba?\(|\d(px|em|rem)\b|font-weight:\s*\d|letter-spacing:\s*-?[\d.]|opacity:/gi), null);
});
```
Run the pins: FAIL.
- [ ] **Step 2: Replace the markup inside `.today-main`,** keeping the banner, `#setup-notes` and the composer (Task 15), and `#yours` where it is:
```html
<header class="today-head" id="today-head"><div class="today-title"><h1>Today</h1><p id="today-day"></p></div></header>
<!-- banner, #setup-notes -->
<div class="filters kinds" id="t-kinds" role="group" aria-label="Show"></div>
<div id="t-people"></div>
<section id="t-waiting" aria-labelledby="t-waiting-h" hidden></section>
<div id="days">
  <div id="day-today"></div>
  <section id="earlier" aria-labelledby="earlier-h" hidden><div class="earlier-head"><h2 id="earlier-h">Earlier</h2></div><div id="earlier-days"></div></section>
</div>
```
Delete `#t-filters`, `#t-all`, `#t-earlier`, `#tray`, `#thread`, in the same change as every listener on them, `threadFilter`, `threadAll`, `filterBeforeDetour`, `endFilterDetour` and the tab bar's call to it (S3, S4). Move `focusin` and `focusout` to `$('days')` (S31). In `forgetHousehold`, clear the new hosts, reset the module state, hide `#earlier`, keep the rest. `#home-banner-done` and both `textBtn` calls in `renderSetupNotes` (`'btn small hit'`) take `hit`.
- [ ] **Step 3: `loadThread`.** `const turn = ++loadTurn, household = householdTurn;`, and after the reads `if (turn !== loadTurn || household !== householdTurn) return;` (T117). It still shows `#loading`, hides `#app-err`, reads `GET /api/thread?${threadParams()}` and, unless `quiet`, `GET /api/today` beside it with `.catch(() => null)`, calling `renderYours` and `renderSetupNotes` when the rails came, as now. `threadParams(extra)`: `budget`; `lane` unless all; `who` when `personPressed`; `through`; `open`; then `extra` (`quiet`, `day`, `at`). Then keep the `$('budget-label')` line as now (S21), rebuild `dayRows` by `e.day`, `renderToday()`, `$('briefing').hidden = view !== 'today'`, the two `showProblem` lines as now (T113, T114). No scroll here. `showView`: `if (view === 'today') { window.scrollTo({ top: 0 }); await loadThread(); }`. `reloadView` keeps every branch (S2).
- [ ] **Step 4: Day cards.** `renderToday()`: `#today-day` from `dayName(todayKey(), { year: true })`; today's card into `#day-today`; earlier days, `count > 0`, newest first, into `#earlier-days`; `#earlier` hidden when there are none; `$('ask-claude').disabled` and `#say-note`'s no-key line as `renderThread` did. Delete `renderThread`, `placeYours` and its `ResizeObserver`. `dayCard(row)`: `section.day[data-day][aria-labelledby]`, `h3.day-h > button.day-open.hit` with `aria-expanded`, `aria-controls`, `id`, its two lines and a chevron; when open, `div.list.day-body` with rows. First line: "Today", or `b` weekday and `small` date. Second line, joined " · ": the count (`${count} of ${total} entries` when they differ; `1 entry`), `${n} waiting`, on a closed card `${n} new`, then who wrote: `name ?? nameOf(who)` for each of `row.by`, `Claude` for `claude`. `pressDay(day)` toggles; opening with no `dayRows.get(day)` reads `GET /api/thread?${threadParams({ day, who: threadData.who })}` once (the person the page applied: day mode has no fallback, so a kept person the server fell back from would empty the card), guarded as in Step 3; redraw with `section.replaceWith(dayCard(row))` and focus back on its head. Body: `.tnew` "New since you last looked" once, before the first `e.fresh` row of the newest open day that has one; rows from `entryNode(e, todayCtx())` with `dataset.event = e.id` (remove the three `.cards` loops; old nodes stay until Task 8). An empty today: "Nothing yet today. Ask Claude something, or leave a note." `todayCtx()`: `{ pending, moved, flagged }` from `threadData.waiting`.
- [ ] **Step 5: The read cursor and the tab coming back.** `watchLastRow()`, from `renderToday`: disconnect the last observer; observe the last element of today's open `.day-body`; on intersection, if `view === 'today'`, `todayKind === 'all'`, `threadData.who === 'everyone'` and `threadData.last !== threadData.newSince`: set `newSince` and `void api('/api/briefing/read', { upTo: threadData.last }).catch(() => {})`. Delete the observer on the composer. `rowFormOpen()`: `!!$('days').querySelector('[data-cancel]')`. The `visibilitychange` listener returns on `if (rowFormOpen()) return;`.
- [ ] **Step 6: `openTodayAt(target)`,** in place of the selector form: `todayKind = 'all'`; `await showView('today')`; read `GET /api/thread?${threadParams({ at })}` for an `event`, `offer` or `drift`, or `threadParams({ day })` for a day (a 404, a failed read or an empty `days` answers false). If the day's month is before the page's first, set `todayThrough` and `await loadThread({ quiet: true })`. Open its day, draw, find `[data-event="…"], [data-offer="…"], [data-drift="…"]` (`CSS.escape`); if none and a person is pressed, `pressPerson(null)`, reload, look again. `scrollIntoView({ block: 'center' })`, `tabIndex = -1`, `focus({ preventScroll: true })`. `{ day }` alone focuses that card's head. `evOpen` uses `openTodayAt({ drift: e.drift })` and `openTodayAt({ offer: e.proposed })`. In `searchGo`, for now, `{ event: o.event }` or `{ day: o.day }`, no `further`; delete `atEvent`.
- [ ] **Step 7: CSS,** in the new section: `.day{margin-top:0}` (`section` has a global margin), `.day-open{…}` full width, `--tap` minimum height, first line `--fs-title` / `--fw-semibold` / `--tracking-tight`, second `--fs-micro` in `--ink-faint`; `.day-body` on `.list`. Delete the unused `.day` and `.day h2` under `/* ── activity, a day at a time ── */`. Add the helpers to the shared region.
- [ ] **Step 8: Run the pins.** Expected: PASS.
- [ ] **Step 9: Check by hand.** Entries over several days (older ones appended, dated, while stopped). Opens at its top; today's card open, earlier closed, "N new" on a closed head; opening reads once and keeps focus; a tab switch keeps what is open, a fresh load does not. A moved event on the Calendar opens its card, centred and focused. A form half typed survives leaving the browser tab (T12). Today's last row on screen clears "new" on reload (S1). The two prompts draw above the head. Other tabs draw; sign out and in (S3). Hit-area snippet.
- [ ] **Step 10: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "Today is one card per day, read a month at a time, and a deep link finds its row."

### Task 8: A row is lane, who, what and when

**Files:** Modify: `site/index.html` (`entryNode`, `answerNode`, `planCrumb`; `ICONS` and `LUCIDE`; `askToRestore`; `<style>`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: Task 4's entry fields; `dayName`, `clockAt`.
- Produces in the Today region: `entShell(e)` returning `{ row, text }`, `whoWord(who, name)`, `rowLink(label, act)`, `whenLine(event)`, `openFor(e)`, `removalBits(flag, eventId, ctx)`. In the shared region (**for 0.9.0**): `laneIcon(lane)`, `claudeDisc()`, `openCalendarDay(day)`.

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['T21', 'function entShell(', 'today'], ['T21', 'left a note', 'today'], ['T21', 'asked Claude', 'today'], ['T22', 'planCrumb(e.plan)', 'today'], ['T23', "e.kind === 'ask' && e.plan", 'today'], ['T29', "node('span', 'ent-why'", 'today'], ['T31', 'refused.textContent = ex.message', 'page'], ['T33', 'No reason was given for this.', 'today'],
['S11', 'clockOf(', 'shared'], ['S24', 'function openCalendarDay(', 'shared'], ['S24', 'calWeek = mondayOf(day)', 'shared'], ['S29', 'name ?? nameOf(who)', 'today'], ['S19', 'openBudgetAt(o.budget, o.envelope)', 'today'],
['hand', ' handed ', 'today'], ['hand', ' took ', 'today'], ['cal', ' added ', 'today'], ['cal', 'the Household calendar', 'today'], ['cal', 'their own calendar', 'today'], ['cal', 'your own calendar', 'today'], ['cal', ' renamed ', 'today'], ['late', 'Suggested on ', 'today'], ['open', "'Open the plan'", 'today'], ['open', "'Open the envelope'", 'today'], ['open', "'Open the day'", 'today'],
['lane', 'function laneIcon(', 'shared'], ['lane', "'message-square':", 'shared'], ['lane', 'function claudeDisc(', 'shared'], ['lane', '.who.claude', 'css'], ['ent', '.ent{', 'css'], ['ent', 'cursor:pointer;text-decoration:underline', 'css'],
```
To `GONE`: `['T21', "node('div', 'turn')", 'today'], ['T21', "'msg member'", 'today'], ['S32', 'dataset.kind = e.kind', 'today']`. Run: FAIL.
- [ ] **Step 2: The shell.** `entShell(e)`: `div.ent[data-event]`, four children: `span.ent-lane` (`laneIcon(e.lane)`, faint), `span.ent-who` (`claudeDisc()`, or `memberDisc(name)` for a member or a guest by the list's name, or nothing for a row the app raised), `div.ent-text`, `span.ent-at` (`clockAt(e.at)`). `whoWord(who, name)`: `Claude` for `claude`, else `name ?? nameOf(who)`. The text opens with the author in `b`. `.ent` is a grid `var(--disc) var(--disc) minmax(0,1fr) auto`, gap `--sp-2`, padding `--sp-3 --sp-4`, top border `--stroke` in `--hair`; `.ent-at` `--fs-micro`, `--ink-faint`, `white-space:nowrap`.
- [ ] **Step 3: The rows.** `entryNode(e, ctx)` keeps its name and dispatches:
  - **Note.** `**Bob** left a note`, the words in `p.ent-words`, the crumb `planCrumb(e.plan)` when on a plan.
  - **Question.** `**You** asked Claude`, the question, the crumb when `e.kind === 'ask' && e.plan`, then `answerNode(e, ctx)`, rewritten on `.claude` with `.byline.claude-by` (`icon('mark', 'mark')`, "Claude answered · as of …"), keeping every branch (T24 to T27); "Read the whole answer" and "Ask again" take `hit`. `as of` uses `clockAt`, with the date in `dayName` form when not today's household day.
  - **Change.** `**Bob** ` and `e.what`, ending ` · ${label}` with several live budgets (`budgets.filter((b) => !b.archived).length > 1`) and an entry naming one; its `why` as `node('span', 'ent-why', `“${e.why}”`)`, or "No reason was given for this." on a removal with none; then `removalBits` (`removedBlock(e.flag.removed)` when set, "Seen it" when `ctx.flagged.has(eventId)`, a `btn hit`).
  - **A hand.** With `e.hand`: `who === from`: "handed **T** to you" / "to Casey"; `who === to`: "took **T** from Bob"; else "handed **T** from Bob to Casey"; `nameIn` mid-sentence; `why` quoted.
  - **A calendar change.** With `e.event` and no `was`: "added **Swim meet** to the Household calendar", "to their own calendar", or "to your own calendar" when the viewer's; `whenLine(event)`: `dayName(keyAt(ms))`, then `, ${clockAt(start)}` unless all day. With `was`: time changed: "moved **Swim practice**" and "Thursday 12 November, 4:30 PM, from 4:00 PM" (the from-part names its day when it differs); else "renamed **Swim** to **Swim practice**".
  - **A decision.** "**Bob** approved **Move $120.00 from Travel to Groceries**" (or "declined"), the reason quoted, then `rowLink` "Suggested on Tuesday 10 November" calling `openTodayAt({ offer: e.offer.id })`.
- [ ] **Step 4: Links.** `rowLink(label, act)` is `textBtn(label, 'link hit', null, act)`. Append `;text-decoration:underline` after `cursor:pointer` in the `.link` rule where it is defined. `openFor(e)` ends the text: `{ plan }`: "Open the plan", `openCard(id)`; `{ budget, envelope }`: "Open the envelope", `openBudgetAt(o.budget, o.envelope)`; `{ calendar }`: "Open the day", `openCalendarDay(day)`, which sets `calWeek = mondayOf(day)`, `calDay = day`, `showView('calendar')`. Add `hit` to `planCrumb`. Rows are not links.
- [ ] **Step 5: `Put it back`.** In `askToRestore`, an always-rendered `const refused = node('div', 'block-err')` with `role="alert"` above the row says a refusal (`refused.textContent = ex.message`), not the button's label. `cancelMark` the form. "Put it back" in `removedBlock` and the form's buttons take `hit`. `.block-err` is `--fs-small` in `--problem` and takes no margin when empty; Task 9 reuses it.
- [ ] **Step 6: Icons.** `LUCIDE['message-square']`: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`. `laneIcon`: `wallet`, `calendar`, `square-kanban`, `icon('mark', 'i')`, `message-square`. `claudeDisc()`: `span.who.claude`, the mark, `role="img"`, `aria-label` "Claude"; `.who.claude` is `--claude-paper` in a `--claude-line` ring at `--disc`.
- [ ] **Step 7: Run the pins.** Expected: PASS.
- [ ] **Step 8: Check by hand.** Each kind of row reads as the spec's sentence, time at the right in household time (try a device in another zone); the three links go where they say; a removed receipt keeps "Put it back" and "Seen it", its refusal beside the form. Hit-area snippet.
- [ ] **Step 9: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "A row on Today reads lane, who, what and when, and opens what it is about from a link in its text."

### Task 9: A waiting card is a dashed block with its own error slot

**Files:** Modify: `site/index.html` (`offerCard`, `offerButtons`, `approveForm`, `adjustForm`, `askAnswer`, `askCardNode`, `driftCardNode`, `savingsCardNode`, `bookingCardNode`, `releaseCardNode`, `bookingSend`, `bookingDecline`, `bookingSuggest`, `actionButton`, `entryNode`; `<style>`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `entShell`, `rowLink`, `removalBits`, `dayName`, `clockAt`, `openTodayAt`, `cancelMark`, `cancelOpen`.
- Produces: `actionButton(label, cls, act, slot = null)`; `waitingBlock({ cls, label, tag, title, effects, clash })` returning `{ card, err, row }`; `blockSlot(card)`; `cardRow(e, ctx)`; `decidedLine(o)`; `todayEscape(ev)`. `offerCard(o, ctx)` keeps its signature for the plan's card (S6).

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['T20', "From the day's briefing", 'today'], ['T28', 'From your question at ', 'today'], ['T46', 'In place of an earlier suggestion', 'today'], ['T46', ' suggested', 'today'], ['T47', "label = 'Waiting'", 'today'], ['T34', 'function waitingBlock(', 'today'], ['T35', "'Not now'", 'today'], ['T34', '.block-err', 'css'], ['T40', 'function blockSlot(', 'today'], ['T40', 'function actionButton(label, cls, act, slot = null)', 'today'], ['T41', 'function decidedLine(', 'today'], ['T44', "o.status === 'snoozed'", 'today'],
['T49', 'asked you to take', 'today'], ['T50', 'mine ? \'Waiting for you\' : `Waiting on ${ask.to}`', 'today'], ['T53', 'DRIFT_LABELS[on].chip', 'today'], ['T56', 'planCrumb(e.plan)', 'today'], ['T58', "actionButton('Seen it'", 'today'], ['T61', 'clash: e.blocked', 'today'], ['T62', 'Reason (they will read it)', 'today'], ['T63', 'Why these instead (they will read it)', 'today'], ['T64', 'function bookingSend(', 'today'], ['T65', '/^approved\\b/.test(ex.message)', 'today'],
['T120', 'why.focus()', 'today'], ['T120', 'arrive.focus()', 'today'], ['T121', 'b.disabled = true', 'today'], ['S6', '.is-decided', 'css'], ['S7', 'function askAnswer(', 'today'], ['S22', 'showProblem(ex)', 'today'], ['esc', 'function todayEscape(', 'today'], ['esc', 'cancelMark(row, closeDecline)', 'today'], ['esc', 'cancelMark(row, closeBooking)', 'today'],
```
In `KEPT`, delete the entry `['S7', "node('div', 'waiting', mine ? 'Waiting for you'", 'page']`: the `T50` entry is its form now. To `GONE`: `['spec', 'adjusted a suggestion', 'page'], ['T47', 'Waiting for either of you', 'page'], ['spec', 'Reason — they will read it', 'page'], ['spec', 'Why these instead — they will read it', 'page'], ['spec', "node('div', 'line')", 'today']`. And a test:
```ts
test('a suggestion\'s buttons run Decline, Adjust, Not now, Approve', () => {
  const b = between(REGIONS.today, 'function offerButtons(', '/** The screen a button acted on');
  const at = ["'Decline'", "'Adjust'", "'Not now'", "'Approve'"].map((w) => b.indexOf(w));
  assert.ok(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!)), String(at));
});
```
Run: FAIL.
- [ ] **Step 2: The slot.** In `actionButton`, on a refusal `b.disabled = false`, then the words go in `slot` when given, else the label as now; a press clears the slot. Plan's other callers pass none. A slot is `div.block-err[role="alert"]`, always rendered. `blockSlot(card)`: `card.querySelector(':scope > .block-err')`.
- [ ] **Step 3: The frame.** `waitingBlock({ cls = '', label = 'Waiting', tag = null, title, effects = [], clash = null })`: `div.card.provisional`, then in order `.waiting` (the `tag` chip beside the label), `h3`, `ul.effects` (`clash` as a last `li.clash`), the slot, `div.row.actions`.
- [ ] **Step 4: Re-house the six, keeping their names and every word.** Every row is built secondary first, the primary last. Every button and link a block draws, its forms' included, takes `hit` in its class.
  - `offerCard`: while it waits, `card offer provisional`; buttons Decline, Adjust (move_money and set_assignment), Not now, Approve, or "Work it out again" in Approve's place with the moved line above; `offerButtons` passes `blockSlot(card)`. `approveForm`: Decline, then `Approve: ${o.summary}`. `adjustForm`: Cancel, then "Suggest this instead". Decided, `decidedLine(o)`: `Approved by **bob** · 8:14 PM · “The trip is paid for”`, or `Declined by`, the day in `dayName` form when not the card's. A put-off card keeps its effects above "Put off by **bob**. It comes back if its numbers change."
  - `askCardNode`: label `mine ? 'Waiting for you' : `Waiting on ${ask.to}``, the plan's title as a link in `h3`; `askAnswer` reads Decline then Take it (primary), slotted, its form with `cancelMark(row, closeDecline)`. Settled: plain lines, the words kept, " · " for a dash.
  - `driftCardNode`: `tag` the chip with `DRIFT_LABELS[on].chip` and the alert icon; buttons Leave both, the calendar choice, the plan choice (primary); `nothingToTake` and `d.deleted` as now. Settled lines keep their words; the two already naming the summary draw no separate title.
  - `savingsCardNode`: Seen it. `bookingCardNode`: Decline, Suggest other dates, Approve (primary); `clash: e.blocked`; forms take `cancelMark(row, closeBooking)` and put the buttons back on close; two labels lose their dash ("Reason (they will read it)", "Why these instead (they will read it)"). `releaseCardNode`: Take it off the calendar. `bookingSend` says a refusal in the slot and keeps its 502 branch as it is.
- [ ] **Step 5: The row.** `entryNode`'s card branch calls `cardRow(e, ctx)`: `entShell(e)` with `data-offer`, and `data-drift` for a drift. The sentence: "**Claude** suggested"; "**Bob** suggested" for a member's own; "**Bob** asked you to take" (or "asked Casey to take"), the asker's reason quoted under it; "**Dana** asked to stay"; none for the app's; `planCrumb(e.plan)` ending it. Under it the block, then, while it waits, a `rowLink` calling `openTodayAt({ event: e.raised.entry })`: "From the day's briefing"; "From your question at 1:22 PM"; "From Bob's question on Tuesday 10 November" on another day; "In place of an earlier suggestion". Then `removalBits` for each of `e.flags`. `.ent .card{box-shadow:none}`; a settled card has no border.
- [ ] **Step 6: Escape.** A document listener bound at load, `todayEscape(ev)`: returns unless `view === 'today'`, the key is Escape, not `ev.isComposing`, not `ev.defaultPrevented`, and the target is not inside `#cat-sec` or `#phone-sec`; `if (cancelOpen($('days'))) ev.preventDefault();`.
- [ ] **Step 7: Run the pins.** Expected: PASS.
- [ ] **Step 8: Check by hand.** One of each: a suggestion (all four buttons; stale after its figures move), an old ask (as the member asked and as another), a calendar drift, one on a deleted event, a page drift, an unreadable page, Savings short, a request with a night kept since, a cancelled stay. For each: label, chip, title, effects, refusal in the slot, button order, first field focused, Escape closing it first. A plan's card takes the block and `.is-decided` folds. An approval that leaves something by hand redraws decided and the page's box says it. Hit-area snippet.
- [ ] **Step 9: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "A waiting card is a dashed block in its own row, with its buttons in one order and its refusals in a slot."

### Task 10: The briefing opens its day

**Files:** Modify: `site/index.html` (`entryNode`'s briefing branch, `clampBody`, `dayCard`; `<style>`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `dayCard`, `clockAt`, `readDocText`, `docRead`.
- Produces in the Today region: `briefingBlock(e, isToday)`.

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['T14', "Claude · the day's briefing", 'today'], ['T14', 'Claude · briefing for ', 'today'], ['T14', '.day .claude', 'css'], ['T15', 'Briefing · written without Claude', 'today'], ['T16', "'headline'", 'today'], ['T17', 'Read the whole briefing', 'today'], ['T18', 'Reading the briefing…', 'today'],
```
To `GONE`: `['T17', 'Read all of it', 'page'], ['spec', "'msg claude'", 'today'], ['spec', "node('div', 'bubble'", 'today']`. Run: FAIL.
- [ ] **Step 2: The briefing.** `briefingBlock(e, isToday)`: `div.claude[data-event]`, by-line `.byline.claude-by` with `icon('mark', 'mark')` and its time at the right: "Claude · the day's briefing" (`source === 'household'`), "Claude · briefing for <budget>", or, with no mark, "Briefing · written without Claude". Then the headline. On today's card the write-up, clamped by `clampBody`, whose button reads "Read the whole briefing", takes `hit` and then goes; kept in Drive it is read at once on today's card, which says "Reading the briefing…" until it arrives. On an earlier day only the headline shows, then "Read the whole briefing" (`button.link.hit`) when there is a `body` or a `doc`; that press opens the rest in place, from `body` or from Drive, and the link goes. Unreadable, its place says `readDocText`'s line. `.day .claude{border-block:var(--stroke) solid var(--claude-line);background:var(--claude-paper);padding:var(--sp-3) var(--sp-4)}`, no radius. `dayCard` draws it first in the body.
- [ ] **Step 3: Run the pins.** Expected: PASS.
- [ ] **Step 4: Check by hand.** A long briefing, one in Drive, one unreadable, a fallback and a budget's own, each under the gold rule; the same on an earlier day, headline only until pressed. Hit-area snippet.
- [ ] **Step 5: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "The briefing opens its day on Claude's paper, whole on today's card and by its headline on an earlier one."

### Task 11: Yours is a strip on a phone and a column on the desk

**Files:** Modify: `site/index.html` (the three rails, `railRow`, `railChips`, `renderYours`, `sourceDisc`, `dayCard`; `<style>`), `api/src/calendar-view.ts` (`viewerEvents`), `api/test/calendar.test.ts`, `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `dayCard`, `briefingBlock`, `todayKind`, `laneIcon`, `memberDisc`.
- Produces: `owner: Actor | null` on each `ViewerEvent`; `ownerOf(c: CalendarRef, state: State): Actor | null`, exported from `api/src/calendar-view.ts`. In the shared region (**for 0.9.0**): `householdDisc(label)`. In the Today region: `yoursStrip()`, `yoursRails`, `calendarRows(cal)`, `planRows(plans)`, `moneyRailRows(money)` (`moneyRows` is the plan's card's: a second declaration of it in the one module stops the page loading).

- [ ] **Step 1: The server's test.** In `calendar.test.ts`, beside the first test reading `todayEvents`: an event on the viewer's calendar has `owner` the viewer; on Household `null`; on a checked calendar whose `original_cal_id` begins `/casey/`, a member: `'casey'`; beginning with a non-member's name: `null`. Run: FAIL.
- [ ] **Step 2: Add the pins.** To `ADDED`:
```ts
['T82', 'function yoursStrip(', 'today'], ['T85', ' more`', 'today'], ['T81', "'Yours'", 'today'], ['T86', 'e.plan ? openCard(e.plan.id)', 'today'], ['T87', 'function householdDisc(', 'shared'], ['T87', 'e.owner', 'today'], ['T96', 'yoursRails', 'today'], ['S10', 'householdDisc(e.label)', 'today'], ['S32', 'yoursStrip()', 'today'], ['strip', '.yours-strip', 'css'],
```
To `GONE` (`S9` looks in the Today region: the Calendar's own two uses of the phrase stand until 0.9.0): `['T82', 'placeYours', 'page'], ['T92', 'asked ${c.asked.to}', 'page'], ['T92', '${c.owner} asked', 'page'], ['S9', 'otherMember() ?? e.label', 'today']`. Run: FAIL.
- [ ] **Step 3: `owner`.** In `viewerEvents` each `cals` entry records `owner`: the viewer for `mine`, null for `household`, `ownerOf(seen, state)` for `partner` (the account `ownedBy`'s rule reads, when a member, case-insensitively; else null). Each event carries it.
- [ ] **Step 4: Yours.** Split each rail into `{ rows: [{ lead, text, value, valueCls, open }], line: Node | null }` with `calendarRows`, `planRows`, `moneyRailRows`; `calendarRail`, `plansRail`, `moneyRail` keep their names and draw every row and the line through `railRow`, whose button takes `hit` (T85's row was measured at 36); a calendar row still opens `e.plan ? openCard(e.plan.id) : showView('calendar')` (T86). `railChips` loses both asked lines (T92). `renderYours(r)` stores `yoursRails = r`. `sourceDisc(e)`: household: `householdDisc(e.label)`, which lifts the house mark into the shared region; otherwise `memberDisc(e.owner ?? e.label)`, `title` and `aria-label` the calendar's name.
  `yoursStrip()` returns `div.yours-strip`, in today's card under the briefing, hidden from 1040px: on the page colour, an eyebrow with the viewer's solid disc and "Yours · what the briefing was written from", or "Yours" when no briefing is drawn; one `button.strip-row.hit` per rail with its lane icon and a chevron: the rail's first row as the desk draws it, then "and 2 more"; an empty or unread rail shows its line; a press opens `showView('calendar')`, `'plan'` or `'budget'`. Under Budget, Calendar or Plans it keeps that rail; under Claude and Notes it is absent; with no rails read it is left out. `#yours` is hidden under 1040px and stays the unfiltered sticky column from there.
- [ ] **Step 5: Run the pins and the calendar test.** Expected: PASS.
- [ ] **Step 6: Check by hand.** At 375 the strip; at 1280 the column. Casey's calendar wears her ring. Kill the fake DSM mid-load: days draw, the strip goes, setup notes stay. Hit-area snippet, sideways check.
- [ ] **Step 7: Suite, typecheck, commit** `site/index.html api/src/calendar-view.ts api/test/calendar.test.ts api/test/page-ledger.test.ts`: "Yours is a strip on a phone and a column on the desk, and a calendar's disc is its owner's."

### Task 12: Kinds, people, empty days and the earlier months

**Files:** Modify: `site/index.html` (`peopleBar`; `renderToday`, `dayCard`; `LUCIDE`; `<style>`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `todayKind`, `todaySort`, `todayThrough`, `threadData`, `loadThread`, `pressPerson`, `peopleOrder`.
- Produces: `peopleBar(host, { label, people, pressed, onPress, noun = 'plan', plural })`; `KINDS`; `pressKind(kind)`; `emptyLine()`; `leftOutLine()`; `showMonth(month)`; `flipSort()`.

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['T4', 'const KINDS = ', 'today'], ['T4', "['all', 'All']", 'today'], ['T4', "['notes', 'Notes']", 'today'], ['T4', 'function pressKind(', 'today'], ['T4', "label: 'Whose'", 'today'], ['T4', "plural: 'entries'", 'today'], ['T4', '.filters.kinds', 'css'], ['T6', '`Show ${', 'today'], ['T6', 'function showMonth(', 'today'], ['sort', 'function flipSort(', 'today'], ['sort', "'Newest first'", 'today'], ['sort', "'Oldest first'", 'today'], ['sort', "'arrow-up-down':", 'shared'], ['empty', 'function emptyLine(', 'today'], ['empty', 'Nothing under ${', 'today'], ['left', 'and are left out.', 'today'], ['left', 'and is left out.', 'today'], ['bar', 'plural', 'shared'],
```
Run: FAIL.
- [ ] **Step 2: The bar's plural.** `peopleBar` gains `plural`, default `` `${noun}s` ``, used in the accessible name. Plan's caller is unchanged.
- [ ] **Step 3: Kinds.** `KINDS` is `[['all', 'All'], ['budget', 'Budget'], ['calendar', 'Calendar'], ['plans', 'Plans'], ['claude', 'Claude'], ['notes', 'Notes']]`. `renderToday` fills `#t-kinds` once with `button.hit[data-kind][aria-pressed]`, then sets `aria-pressed`; one delegated listener at load. `pressKind(kind)`: sets `todayKind`, `void loadThread({ quiet: true })`. `.filters.kinds{flex-wrap:nowrap}`, buttons `padding-inline:var(--sp-2)` and `min-width:var(--tap)`, with room above and below for the hit area.
- [ ] **Step 4: People.** `peopleBar($('t-people'), { label: 'Whose', pressed: threadData.who === 'everyone' ? null : threadData.who, noun: 'entry', plural: 'entries', onPress: (key) => { pressPerson(key); void loadThread({ quiet: true }); }, people })`: `people` is `peopleOrder()` with `n` the sum of `by` over `threadData.days`, at least 1, members only. Hidden when only one member has entries and Everyone shows pressed.
- [ ] **Step 5: Empty days.** An earlier day with `count === 0` has no card. Today's always draws; at `count === 0` under a narrowing, `emptyLine()` above its briefing: "Nothing under Budget today.", "Nothing by Bob today.", "Nothing under Budget by Bob today." After the last earlier day, once, `p#left-out[aria-live="polite"]`: "4 other days since 1 November have nothing under Budget and are left out." (singular: "1 other day since 1 November has nothing under Budget and is left out."), counting `count === 0` days other than today, the date the first of the first month covered (`${Number(first.slice(8))} ${monthName(first.slice(0, 7))}`). Under a person alone it reads "nothing by Bob", under both "nothing under Budget by Bob", as `emptyLine` words them.
- [ ] **Step 6: Earlier.** `.earlier-head` gains at its right `button.link.hit` with `lucide('arrow-up-down')` reading "Newest first" or "Oldest first"; `flipSort()` flips the earlier cards only. `LUCIDE['arrow-up-down']`: `<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>`. "Show October" (`monthName(threadData.before)`, `button.link.hit`, `showMonth` sets `todayThrough` and reloads quiet) sits after the last card under Newest first, directly under the heading under Oldest first; absent when `before` is null; the heading absent with no earlier day and no `before`.
- [ ] **Step 7: Run the pins.** Expected: PASS.
- [ ] **Step 8: Check by hand.** Each kind at 375: one row, reads in Graphite. Budget and Bob together: empty days and the left-out line. A member with nothing in view: Everyone shows pressed, the choice kept. Tab switch holds kind and sort; fresh load: All. "Show October" under each sort. A jump two months back brings the months between. Hit-area snippet, sideways check.
- [ ] **Step 9: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "Six kinds and the people bar narrow every day, an empty day says what it is empty of, and earlier months come a month at a time."

### Task 13: Waiting on you

**Files:** Modify: `site/index.html` (Today region; `<style>`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `threadData.waiting` (`WaitingItem`), `openTodayAt`, `pressPerson`, `laneIcon`, `dayName`, `clockAt`. Produces: `renderWaiting()`.

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['T70', 'function renderWaiting(', 'today'], ['T70', 'In no envelope yet', 'today'], ['S20', "$('unsorted-q').scrollIntoView({ block: 'start' })", 'today'], ['T72', 'Waiting on you · ', 'today'], ['T72', '`Show all ${', 'today'], ['wait', 'suggested it · ', 'today'], ['wait', ' asked you · ', 'today'], ['wait', ' removed it · ', 'today'], ['wait', ' · the numbers have moved', 'today'], ['wait', '#t-waiting', 'css'],
```
To `GONE`: `['T70', 'function unsortedItem(', 'page'], ['T70', 'They are in no envelope yet, so no envelope counts them as spent.', 'page']`. Run: FAIL.
- [ ] **Step 2: Draw it.** `renderWaiting()` fills `#t-waiting`, absent when `waiting` is empty. `h2#t-waiting-h`: "Waiting on you · 2", or "Waiting on you · 1 of 3" when some are not `inView`. One `div.provisional` around `button.rowi.hit` rows: `laneIcon(w.lane)`, the title, `span.meta`, a chevron (`icon('go')`). The small line: "Claude suggested it · today, 1:22 PM"; "Bob suggested it · Tuesday 10 November"; "Bob asked you · …"; "Dana asked · …"; "Bob removed it · …"; the when alone when `w.by === null`; "In no envelope yet" for the receipts; ending " · the numbers have moved" when `w.moved`. The when: `today, ${clockAt(w.at)}` on today, else `dayName(w.day)`. A row jumps with `openTodayAt({ event: w.entry })`; the receipts row runs `await showView('budget'); $('unsorted-q').scrollIntoView({ block: 'start' })`. Rows not `inView` are left out; a last quiet `button.rowi.hit`, "Show all 3", sets All, `pressPerson(null)`, reloads. Call it from `renderToday`. In the section: `#t-waiting` takes `margin-block:var(--sp-4)`, its `.provisional` `padding:0`, its rows full width.
- [ ] **Step 3: Run the pins.** Expected: PASS.
- [ ] **Step 4: Check by hand.** Every kind of item, newest first, receipts last. A row on a closed day or an earlier month opens it and focuses the card. A receipt removed by an approved card jumps to that card, with "Put it back" and "Seen it". A kind: "1 of 3"; "Show all 3" presses All and Everyone. Nothing waiting: absent. Hit-area snippet.
- [ ] **Step 5: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "What waits on you is listed first, and each row jumps to the card that holds its buttons."

### Task 14: One search, in Today's head

**Files:** Modify: `site/index.html` (delete `// ── search ──` up to `/** "2026-10" as "October". */`; the top bar's `#search`; `#today-head`, the Today region; `forgetHousehold`, `enterApp`; `LUCIDE`; `<style>`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `GET /api/search` (`RecordResults`), `entShell`, `rowLink`, `openTodayAt`, `openCard`, `planPath`, `todayEscape`.
- Produces: `todaySearchReset()`, `searchActive()`, `leaveSearch()`, `askRecord(words)`, `markWords(el, words)`.

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['T97', 'id="t-search-q"', 'todayMarkup'], ['T97', 'id="t-search-btn"', 'todayMarkup'], ['T97', 'Search the household', 'todayMarkup'], ['T98', 'setTimeout(() => { void askRecord(words); }, 250)', 'today'], ['T98', 'if (asked !== recordAsked) return;', 'today'], ['T99', 'in the record for', 'today'], ['T99', 'Claude answered: ', 'today'], ['T99', 'function markWords(', 'today'], ['T101', 'if (leaveSearch()) ev.preventDefault();', 'today'], ['T102', "'Show in its day'", 'today'], ['T102', "'_blank', 'noopener'", 'today'], ['T107', 'function todaySearchReset(', 'today'], ['S23', 'todaySearchReset();', 'page'], ['S3', "$('t-search-q').addEventListener", 'today'],
['srch', 'Elsewhere · ', 'today'], ['srch', 'A plan · ', 'today'], ['srch', 'A file on ', 'today'], ['srch', 'Searched every day since the record began.', 'today'], ['srch', 'Showing the newest 100. Add a word to narrow it.', 'today'], ['srch', 'function searchActive(', 'today'], ['srch', '  search: \'<path', 'shared'], ['srch', '  x: \'<path', 'shared'], ['mark', '--mark-fill', 'css'],
```
To `GONE`:
```ts
['T97', 'id="search"', 'page'], ['T97', 'id="search-q"', 'page'], ['T97', 'id="search-list"', 'page'], ['T100', 'function searchMark(', 'page'], ['T106', 'function searchSay(', 'page'], ['T106', "Today doesn't show that one", 'page'], ['T108', 'function searchOpen(', 'page'], ['T99', 'function searchDraw(', 'page'], ['T102', 'function searchGo(', 'page'], ['spec', 'SEARCH_KINDS', 'page'], ['spec', 'function searchClose(', 'page'], ['spec', 'searchClear(', 'page'], ['spec', 'searchReset(', 'page'],
```
Run: FAIL.
- [ ] **Step 2: Delete the old search, in one change:** the section through `$('search')`'s listener, keeping `monthLong` and `api`; the top bar's `#search`; `searchReset()` in `enterApp` and `forgetHousehold` becomes `todaySearchReset()`.
- [ ] **Step 3: The head.** In `#today-head`, after `.today-title`: `button#t-search-btn.btn.hit` (Lucide `search`, `aria-label` "Search the household"), then `div.t-search.search` holding a visually hidden label, `input#t-search-q` (`type="search"`, placeholder "Search the household"), `button#t-search-clear.hit` (`aria-label` "Clear", Lucide `x`) inside it and `button#t-search-cancel.link.hit` "Cancel". `LUCIDE` keys `search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>'` and `x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'`. On a phone pressing the button adds `.searching` to the head, hides the title and focuses the field; from 1040px (`@container page`) the field is always there and the button and Cancel never show. Focus returns to the button when the phone's field closes. The field is `--fs-input`.
- [ ] **Step 4: Asking.** On input, under two letters puts the days back; from two letters `setTimeout(() => { void askRecord(words); }, 250)`; `askRecord` counts `recordAsked` and draws only the latest. `GET /api/search?q=&lane=&who=`; a kind or person pressed while searching re-asks.
- [ ] **Step 5: Results.** While `searchActive()` (two letters or more) `#briefing` has class `searching-record`: CSS hides the banner, `#setup-notes`, `#t-waiting`, `#days` and `#composer`, shows `#t-results` in `#days`' place, holding:
  - a line, `aria-live="polite"`: "**4** in the record for “dentist” · newest first";
  - day cards, newest first, a plain head, the day's name and then "2 of 7 entries", rows by `entShell` and the row's words, no blocks or buttons; a question adds "Claude answered: " and `e.passage`; a briefing its headline and passage; a passage only Drive held as the second line; each row ends `rowLink('Show in its day', …)` calling `todaySearchReset()` then `openTodayAt({ event: e.id })`;
  - `markWords(el, words)` wraps every case-insensitive occurrence in `mark`, by walking text nodes; `#t-results mark{background:var(--mark-fill);color:var(--ink);font-weight:var(--fw-semibold)}`;
  - `h2` "Elsewhere · 1", each a `button.rowi.hit`: a plan's title with "A plan · “…passage…”" opening `openCard`; a file's name with "A file on <plan>" opening `window.open(planPath(plan, '/files/' + encodeURIComponent(name)), '_blank', 'noopener')`;
  - a last line: "Searched every day since the record began." or, when `capped`, "Showing the newest 100. Add a word to narrow it."; and when `documents === 'not searched'`, "Sign in again to search briefings, answers and files too."
  Nothing found: "Nothing in the household matches that." Failure: "The search could not be done just now." `watchLastRow` also checks `!searchActive()`.
- [ ] **Step 6: Leaving.** `leaveSearch()` clears the field, the timer and a late answer, removes the classes, answers whether it did anything. Cancel and emptying the desk's field call it. In `todayEscape`, after the `cancelOpen` line: `if (leaveSearch()) ev.preventDefault();`. `openTodayAt` calls `todaySearchReset()` first (spec: it leaves search).
- [ ] **Step 7: Run the pins.** Expected: PASS.
- [ ] **Step 8: Check by hand.** No box in the top bar. At 375 the button swaps the title for the field. One letter: days stay; two: results; quick typing: only the last answer. Kinds and people narrow. A row's link leaves search for its day; Elsewhere opens plans and files. Escape closes a form first, then leaves search. Sign out and in: empty. Hit-area snippet, sideways check.
- [ ] **Step 9: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "There is one search, in Today's head, and it answers in day cards."

### Task 15: The composer

**Files:** Modify: `site/index.html` (`#composer`; `askClaude`, the `leave-note` and `say` listeners, `renderToday`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `loadThread`, `todayKind`, `personPressed`, `todayShut`, `claudeOn`. Produces: `afterSend(id, lane)`.

- [ ] **Step 1: Add the pins.** To `ADDED`:
```ts
['T73', 'Ask Claude, or leave a note for the others', 'todayMarkup'], ['T79', 'id="say-note" aria-live="polite"', 'todayMarkup'], ['T79', 'Goes into today', 'today'], ['T80', 'function afterSend(', 'today'], ['T80', 'Left in today. It shows under Everyone.', 'today'], ['T71', '.composer.resting', 'css'], ['T71', "$('composer').classList.add('resting')", 'today'], ['T119', "if (!text) { $('say').focus(); return; }", 'today'], ['T74', "$('leave-note').disabled = true", 'today'], ['T75', "$('ask-claude').disabled = !claudeOn", 'today'],
```
To `GONE`: `['T73', 'leave a note for each other', 'page']`. Run: FAIL.
- [ ] **Step 2: The bar.** `#say` keeps its id, two rows, 2,000 characters and hidden label; placeholder "Ask Claude, or leave a note for the others". `.composer-row`: `<span class="quiet" id="say-note" aria-live="polite">` at the left, "Leave a note", "Ask Claude" (primary, right), both `.hit`. At rest with a key the slot reads "Goes into today"; with no key "Ask Claude" is disabled and it reads "Claude isn't set up on this server. Notes still work."; while asking "Asking Claude…"; a refusal is said there, `Claude couldn't answer: …` as now.
- [ ] **Step 3: Keys,** as now: Enter asks, Shift+Enter a new line, with no key a new line, ignored while composing, a press on an empty field only focuses it.
- [ ] **Step 4: After a send.** `afterSend(id, lane)`: if `todayKind` is neither `all` nor `lane`, `todayKind = 'all'`; `todayShut = false`; `await loadThread({ quiet: true })`; if `personPressed` is not null and not `myName`, nothing changes and the slot says "Left in today. It shows under Everyone."; else scroll `[data-event="id"]` into view. A note: `event.id`, `notes`; a question: `r.question.id`, `claude`; "Ask again" keeps the field. While a form in a row has focus the bar rests (Task 7's listeners).
- [ ] **Step 5: Run the pins.** Expected: PASS.
- [ ] **Step 6: Check by hand.** Note and question under All, under Budget, under a pressed Bob, with no key. Empty field: focus only. At 375 the bar does not cover a focused field. A closed today's card opens and the new row scrolls in. Hit-area snippet.
- [ ] **Step 7: Suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "The composer says where a note goes, and a new row is brought into view."

### Task 16: The sweep, the notes and version 0.8.0

**Files:** Modify: `site/index.html` (dead CSS, comments, `BUILD`, stylesheet link), `docs/superpowers/design/components.css`, `docs/superpowers/design/2026-10-28-design-language.md`, `docs/superpowers/design/tools/contrast.py`, `api/src/thread.ts` and `api/src/server.ts` (comments), `README.md` (`### Today`), `DEPLOY.md` (before `### Upgrading to 0.7.0`), `api/package.json`, `api/package-lock.json`, `api/test/page-ledger.test.ts`

**Interfaces:** Consumes everything above. Produces release 0.8.0.

- [ ] **Step 1: The ledger says the whole of "What is deleted".** To `GONE`:
```ts
['spec', '.thread-tools', 'css'], ['spec', '.allb', 'css'], ['spec', '.tday', 'css'], ['spec', '.msg .by', 'css'], ['spec', '.msg.claude', 'css'], ['spec', '.msg.member', 'css'], ['spec', '.bubble', 'css'], ['spec', '.turn{', 'css'], ['T33', '.line{', 'css'], ['T33', '.line b', 'css'], ['T33', '.line .why', 'css'], ['T33', '.line.flag', 'css'], ['T33', '.line .row', 'css'], ['T72', '.tray', 'css'], ['T92', '.chip.asked', 'css'],
['T34', 'border-left:3px solid var(--caution-line);box-shadow:none', 'css'], ['T34', '.card.offer.moved{border-left-color', 'css'], ['T97', '.search-list', 'css'], ['T97', '.search-hit', 'css'], ['T97', '.top-inner > .search', 'css'], ['T99', '#search-notes', 'css'],
```
A test: `assert.doesNotMatch(read('../../docs/superpowers/design/tools/contrast.py'), /\("--ink-faint","--accent-tint",4\.5/);`. Run: FAIL, naming them.
- [ ] **Step 2: Delete them,** and the `.msg.member` line in the `max-width:520px` block. Keep `.sec-form .msg`, `.cover .msg`, `.goal-form .msg`, `.s-files .msg`, `.s-people .msg`, `.rowform .msg`, `.card.offer`, `.is-decided`, `.tnew`, `.plan-crumb`, `.search input` and its two companions. Grep the rest of the spec's list: `author(`, `hasWaiting`, `standalone(`, `searchKind` used by the tool only. Update comments describing a thread of bubbles: the `#briefing` markup comment, the header of `// ── the thread ──` and of `api/src/thread.ts`, and the route list at the top of `api/src/server.ts`.
- [ ] **Step 3: Two members, nowhere on Today.** `grep -nE "otherMember|[Tt]heirs|the two of|each other|either of you|[Bb]oth of|partner" $W/site/index.html`. Expected: `otherMember` only at its declaration and in the Calendar region; "partner" only the `.who.partner` alias, the Calendar's `calendar === 'partner'` and the member form's placeholder. A comment saying "either of you" (the booking and savings cards have them) is reworded. Leave `briefing.ts` and `conversation.ts`.
- [ ] **Step 4: The contrast tool.** Take `("--ink-faint","--accent-tint",4.5,"faint on accent tint")` out of `known`, leaving `known = []`, its comment saying none is short now that a mark is `--mark-fill` under `--ink`, semibold. `python3 docs/superpowers/design/tools/contrast.py site/tokens.css`: exit 0.
- [ ] **Step 5: The design language.** The line beginning `- **Today**:` under Components reads: "- **Today**: `today` (three regions), `brief`, `briefing`, `yours` and `rail`, `composer`, `day`, `ent`, `seg people`, `tnew`." with no "From 0.8.0" sentence; in the `- **People and chips**` line `chip` loses `asked`. Then apply, word for word, the visual audit's "Design-language amendments" for: Tokens lines 64 and 68; the type table's headline, title and body rows; Conventions "A proposal", "A decision", "Claude's text", "The error box"; Layout's Today paragraph, replaced by one sentence naming this spec and keeping "shared Today is not personal Today"; Copy voice line 322. In `components.css` mark `.day-head`, `.newsince`, `.msg` and variants, `.line` and variants, `.tray` and `.n` with `/* superseded 2026-11-09: see specs/2026-11-09-today-day-cards-design.md */`.
- [ ] **Step 6: README and DEPLOY.** README `### Today`, the paragraph's first two sentences become: "Each day is one card. Today's is first and open, and its briefing opens it; earlier days are closed below it, a month at a time. Inside, what happened sits as rows that read who did what and when: questions for Claude, notes between members, every change made on another screen, and cards that wait for a person to decide (Claude's suggestions, a calendar event moved on a phone, a plan's page edited in Drive, a guest's booking request). What waits on you is listed above today's card. Kinds and the people bar narrow every day at once, and the one search in the household is at the top of Today."
  DEPLOY.md, before `### Upgrading to 0.7.0`, "### Upgrading to 0.8.0": "Back up first: download each household's backup from Settings, and copy the `data` folder. 0.8.0 adds one line to the log, written when a member moves or renames an appointment in the app. An older build cannot open a log that holds that line, so going back means restoring the backup taken before the upgrade, and whatever was written since is lost. Nothing is rewritten on upgrade: which day and kind an entry belongs to is worked out on reading. A page left open on a phone across the upgrade says \"Home Planner has been updated. Reload.\""
- [ ] **Step 7: The version.** `cd api && npm version 0.8.0 --no-git-tag-version`; `const BUILD = '0.8.0';`; `/tokens.css?v=0.8.0`. The ledger's build test passes.
- [ ] **Step 8: The release, by hand.** Fresh `$S/run`:
  - **Every ledger row.** At 375 and 1280, light and dark, walk T1 to T121 with the table in this plan; a plan's card suggestions take the block; Calendar, Budget, Settings draw; `$('briefing').innerText` matches neither `/\bthread\b/i` nor `/\blane\b/i`.
  - **An old log.** An appended `plan.ask` with its `proposal.offer`, and notes dated in earlier months: the old ask draws for the member asked; earlier months arrive with "Show <month>".
  - **A restore** into a second household: the preview is clean; rows in a day are in time order; restored lines read "new" until read.
  - **A tab across the upgrade.** Edit `BUILD` to `0.7.0` in the browser and read: "Home Planner has been updated. Reload."
  - Hit-area snippet, sideways check, Graphite at 375 reading every pressed state with no hue. Stop both by pid.
- [ ] **Step 9: Suite, typecheck, commit** the files above: "Version 0.8.0: Today as day cards."
