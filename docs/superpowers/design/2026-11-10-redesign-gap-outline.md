# The three redesigns: what the code is missing

**Status:** an outline for the planner and the owner, written 2026-11-10. Not a plan: no steps, no code beyond
signatures. It reads the three agreed specs of 2026-11-09 (Plan by area, 0.7.0; Today as day cards, 0.8.0; the
Calendar as a day page, 0.9.0) against the code at 0.6.0 and says what each needs that is not there.

A gap is something a spec requires that the code does not do today. Line numbers are the tree's at 0.6.0
(`site/index.html` is 11,356 lines). Sizes: **S** under 50 lines in one file; **M** one module and its tests;
**L** several modules, or a change to the fold that an old log could feel. Table rows are long on purpose: one
row, one gap. Members in examples are Alex (the viewer), Bob and Casey.

## At a glance

1. **0.7.0 is a one-way door from its first boot.** An older build cannot open a log that holds an op it does
   not know (`replay.ts:1925` throws, and `Store.load` at `store.ts:116` does not catch it), and 0.7.0 writes
   `shelves.retire` by itself the first time it opens a household that has a shelf. Rolling back then means
   putting the pre-upgrade log back by hand. Take a backup before each of the three upgrades, and say so.
2. **A backup made after 0.7.0 will not restore its plans as the code stands.** `restore.ts:229` names the
   author of every plans-scope line that is not a member as a collision, and `shelves.retire` is written by
   `system`. The same walk does not know the three new area ops (`restore.ts:262`). Both are small fixes that
   belong in 0.7.0; neither is in the spec.
3. **Nothing tells an old tab or an old backup that it is old.** A tab left open on a plan's card crashes on
   the new answer (`index.html:6848`), `tokens.css` is cached for an hour while the page is not
   (`server.ts:640`), and a backup holding ops this build does not know is parsed without complaint and those
   lines are left out silently (checked: they count under "undefined"). One header and one check in `api()`,
   a versioned stylesheet link, and unknown ops reported as unreadable close all three for every later release.
4. **The helpers all three screens share live inside the regions being rebuilt.** `icon`, `lucide`, `whoDisc`,
   `chip`, `inlineForm` and `members` sit in the Plan region (`index.html:6452-6759`); the household's clock
   (`keyAt`, `todayKey`, `clockOf`, `keyWords`) and `openTodayAt` sit in the Calendar region (`10181-10331`).
   The first task of 0.7.0 should move them above the screens, changing nothing else.
5. **0.9.0 is two releases.** Bills (two ops, a tool, a redefined `stillExpected`, a section on the envelope's
   page) stands on its own and is the riskier half; the Calendar's day page needs it only for its money rows.
   Ship Bills first. With that split, 0.7.0 is the largest release and should not be split further.
6. **Three members are still two in places no spec touches.** Claude is told "Both of them read it"
   (`briefing.ts:925`) and that notes are "between the two of them" (`briefing.ts:297`, `conversation.ts:208`);
   Today's calendar rail draws any other member's event with the first other member's disc
   (`index.html:2467`). The complete list is under "Shared foundations".
7. **A bill's key freezes two things the code is free to change today.** `bill.set` stores `chargeKey`, which
   is `normalisePayee(payee)` and a category id (`analytics.ts:75`, `:382`). Sorting that payee's receipts into
   another category, or tuning the normaliser, orphans the date a member set. Decide before the op exists.
8. **After a restore the log's order is not time's order.** `Store.adopt` keeps ids and timestamps and appends
   at the end (`store.ts:183`). Today's day cards, "3 new" and the divider must group by household day and
   count "new" by place in the log, never by run of entries or by comparing ids.
9. **The specs leave 27 decisions to the code** (listed per release), some of them plain disagreements. The
   ones that change a wire shape: `hand` is `{ plan, from, to }` in one spec and `{ plan, to }` in the other; a
   calendar row's `event` carries no name to print in bold; a tool's lane cannot be typechecked because
   `Tool.name` is a `string` (`tools.ts:130`); the word on a hand is called `word` where `decide()`,
   `describe()` and the thread all read `why`.
10. **The page has no automated check, and three rebuilds in a row will lose things.** A text-level test of
    `site/index.html` against a written ledger (ids, labels, routes, functions kept and deleted) is about 60
    lines of `node:test` and would have caught "an element was not brought over". Proposed under "Test
    strategy".

## 0.7.0: Plan by area

### Server

| Capability (spec section) | Today | To build | Touches | Size and risk |
|---|---|---|---|---|
| `Plan` gains `goal`, `ownerSince`, `ownerFrom` (Ops) | `types.ts:964` has none; owner is set at `replay.ts:1563`, `:1625`, `:1295` | Three fields, set in `plan.create`, `plan.ask.accept` and the `member.remove` takeover; `PLAN_LIMITS.goal = 60` | `cardOf`, `CardView` (`plans.ts`); every test that compares a whole plan; `old-log.test.ts` | M. The old-log snapshot only allows new top-level fields (`old-log.test.ts:30`); these are nested in `plans` |
| `plan.hand` and `state.hands` (Replay) | Nothing; asks only (`replay.ts:1608-1627`) | The op; a `validatePlan` case; the fold with its three refusals and `lapseAsk`; `hands: Map<EventId, { plan, from, to }>` | `describe` (`tools.ts:734`), `scopeOf`, `PLAN_LINES` (`thread.ts:106`), `Draft`, `emptyDraft`, `freeze`, `thaw` | M. `freeze` and `thaw` list fields by hand (`replay.ts:130-205`); a missed line loses every hand on the next append, as `closed` once was (`:175`) |
| `plan.goal`, `goal.rename`, `goal.remove`, the label rule (Replay) | Nothing | `goalLabel(v)` in `plan-rules.ts`; `goalsOf(state): { goal, plans, done }[]` exported from `plans.ts`; three folds | `planShaped` by name (`types.ts:721`); `describe`; `scopeOf`; `PLAN_LINES` for the two goal ops | M. `validatePlan` returns unless the op starts `plan.` and then demands a `plan` (`replay.ts:609`, `:620`), so the goal ops need their own check; "same goal ignoring case" must be one function for fold, route and board |
| `areas.add`, `areas.remove`, `areas.move` (Replay, Routes) | `areas.set`, `areas.rename` (`replay.ts:468-490`, `:1383-1406`; routes `server.ts:2261-2287`) | Three ops, `validateSettings` cases, folds, three routes answering `{ areas }` | `describe`; `scopeOf` settings; `NOT_A_CHANGE` for `areas.move` (`activity.ts:30`); `settings-log.test.ts`, `server-settings.test.ts` | M. Unlike `areas.set` they refuse when already true ("already an area"), which a restore into the same household will meet |
| `shelves.retire`; the five shelf refusals go (Replay) | Refusals at `replay.ts:1557`, `:1559`, `:1578`, `:1601`, `:1688`; `hasLiveChildren` (`:2005`) | The op, "only from system" in `validate`, the fold, a place in the `markPages` test (`replay.ts:1029`), and one helper `retireShelves(store)` | Called after each load (`households.ts:117`, `:141`, `:181`; `server.ts:1273`) and the adopt (`server.ts:1885`); `NOT_A_CHANGE`; `plans.test.ts` (61 lines name shelves or filters) | L. Restore (finding 2); the one-way door (finding 1); every former item's page is rewritten in Drive, 25 at a time, only once someone with a NAS session loads Today |
| `board()` and `GET /api/plans` in the new shape (Reading) | `plans.ts:117-141`; `server.ts:2865-2873` | The signature and answer as written; the route's fall back to everyone; 400 for `filter`, `showDone`, an unknown `who` | `plansRail` (`server.ts:906`), `plansBlock` (`briefing.ts:551`), `list_plans` (`tools.ts:3405`); page callers at `index.html:6563`, `:7759`, `:10699`; `plans.test.ts`, `server-plans.test.ts`, `briefing.test.ts` | L. Three server callers and three page callers read `planning` and `doing`; on the page a missed one is a TypeError at run time, not a type error |
| `GET /api/plans/:id` gains the fields and `goals`, loses `shelf` and `children` (Reading) | `card()` (`plans.ts:144-182`) | As written | `planContext` (`conversation.ts:151`), `get_plan`'s description (`tools.ts:3415`) | S. An old tab's card throws on `v.children.length` (`index.html:6848`); keeping `children: []` and `shelf: null` for one release costs two fields |
| `POST /api/plans` with `owner?` and `goal?` in one write; `parent` refused (Routes) | `createPlan` (`plan-edits.ts:61-69`); `server.ts:2875` | `createPlan(ctx, { title, area, owner?, goal? })` appending up to three events through one `writePlan` | `shelfFor` goes (`plan-rules.ts:111`); `server-plans.test.ts` | S. `Store.append` already dry-runs a batch whole (`store.ts:146-149`). Today then shows two lines for one add: "made a plan" and "handed" |
| `POST …/hand`, `…/goal`, `/api/goals/rename`, `/api/goals/remove` (Routes) | Nothing; the sub-route list is one regex (`server.ts:2880`) | `handPlan`, `setGoal`, `renameGoal`, `removeGoal` in `plan-edits.ts`, each through `refusedAs400` | `server-plans.test.ts` | M. None |
| Asking closes at every door (Routes, tools) | `askToTake`, `recordAsk`, `raiseAskCards` (`plan-edits.ts:102-124`); called at `server.ts:2927`, `offers.ts:210`, `tools.ts:3597` | 410 on the route; delete the three; `decide()` refuses stored events holding `plan.ask` or `parent` | `TOOLS`, `RESEARCH_WRITES` (`tools.ts:3455`, `:3496`); `offers.test.ts`, `tools.test.ts` | M. "Work it out again" on an old `ask_to_take` card answers "no tool named ask_to_take" (`offers.ts:55`), true but not the spec's words |
| `hand_plan`, `set_plan_goal`; `list_plans` by `who` and `goal`; shelf checks leave four tools (Tools) | `tools.ts:2580-2960`, `:3385-3411` | Two tools; the changed inputs and descriptions | `tools.test.ts`; the tool list Claude is sent | M. The spec does not say whether the two new tools join `RESEARCH_WRITES` |
| The hand in the thread (The thread) | A change entry has `what`, `why`, `count`, `budget`, `name`, `flag` (`thread.ts:45-49`) | `plan.hand`, `goal.rename`, `goal.remove` in `PLAN_LINES`; `hand` on the entry, read from `state.hands` | `thread.test.ts`, `thread-view.test.ts` | S. The two specs give `hand` different shapes (finding 9) |
| Restore knows the eight ops (Ops) | `scopeOf` is exhaustive, so a missing op fails `npm run typecheck` (`restore.ts:25`) | Scopes; an outsider for `plan.hand`'s `to`; `system` let through; the area walk taught the three ops | `households.test.ts`, `settings-log.test.ts` | M. See findings 1 and 2 under "What the spec leaves open" |

### Client

| Capability (spec section) | Today | To build | Touches | Size and risk |
|---|---|---|---|---|
| Shared helpers out of the Plan region (not in the spec) | `index.html:6452-6548` and `:6705-6759` hold `members`, `ICONS`, `icon`, `lucide`, `whoDisc`, `chip`, `dueText`, `blockText`, `inlineForm`, `need` | A "shared" region above Today; a move with no edit | Every screen calls them; the tab bar builds at load with `lucide` (`:10975`) | M (about 400 lines moved, none changed). A `const` moved below a top-level use stops the script at load: a blank app |
| `memberDisc`, `stateGlyph`, `goalFlag`, `peopleBar` (The people bar) | `whoDisc` has two classes, `mine` and `partner` (`:6518`); no glyph, flag or bar | The four, beside `icon()` | `whoDisc`'s callers: `:2467` (Today's rail), `:6628`, `:6948`, `:7447` | M. `:2467` is in Today's region and is easy to leave calling a name that is gone |
| The pressed person (Where the pressed person is kept) | Nothing | `personPressed`, `pressPerson(member)`, `sessionStorage['hp.person']` | Cleared at the household switch (`:11121`), on entering (`:11291`) and at sign-out | S. A stored name that is no longer a member |
| The board: head line, an area's card, plan rows, add row, done row, "A new area", the quiet line, desk columns (The board) | `loadBoard`, `renderBoard`, `planChips`, `boardCard`, `newPlan` (`:6558-6777`); markup `:1730-1745` | One renderer from the new answer; add forms that open where the row was | CSS `.board`, `.lane`, `.bcard`, `.shelf`; listeners bound at load on `#plan-filters` and `#plan-new` (`:6692`, `:6778`) | L. Delete the markup without those two listeners and the page does not boot |
| The goal row and the goal's foot (Goals on the board) | Nothing | `planGoal`; the chip row; Rename and Remove forms where the buttons were | The board's reload "pressed on the new name" | M. A goal renamed or removed in another tab while its chip is pressed: the answer's `goal` is null |
| The Area page (The Area page; Pages) | Nothing; the envelope page is the model (`:3607-3675`) | `areaPage`, `openArea`, `closeArea`, `areaEscape`, `clearAreaPage` | `showView` (`:10992`) and its `clearEnvelopePage` call (`:11000`); `reloadView` (`:3019`); `envFrame` hard-codes `env-page-h` (`:3683`) | L. `showView('plan')` always reloads the board (`:11025`); `reloadView` on `plan` redraws the hidden board, not the page |
| The card: Back that says where, `cardFrom`, the crumb, glyphs, Owner and its form, Goal and its form (The plan's card) | `renderCard` (`:6845-7080`): Back is fixed to Plan (`:6857`); the ask button and form (`:6953-6960`); shelf parts (`:6848`, `:6867`, `:7042-7047`) | Two sections above Notes; `cardFrom = { view, area, scroll, row }` | `openCard`'s ten callers (search `:1994`, Today `:2493`, `:2525`, `:2671`, `:2910`, Calendar `:10268`, `:10777`) | L. Back to Today cannot return to the scroll it left: `loadThread` scrolls to the bottom after every load (`:2335`) |
| "Between us" for any number (The plan's card) | `betweenSection(v, theirs)` (`:7441-7453`) | The new placeholder; drop `theirs` | None | S. None |
| Areas leave Settings (What is deleted) | `areasItem`, `areasForm` (`:8714-8776`), `areaCounts` (`:7660`), the plans read (`:7759`, `:7770`), the group list (`:7893`) | Deletion | The Settings list's order | S. The plans read would otherwise get the 400 meant for old tabs |
| The Calendar's plan picker reads `rows[].plans` (Reading) | `eventPlans` reads `planning` and `doing` (`:10699`) | One line | The New event form | S. It is in a region this release does not otherwise open |
| An old tab is told to reload (not in the spec beyond two refusals) | `api()` has no version check (`:2062`) | The server stamps its version on every answer; `api()` compares it with the page's own | `softwareVersion()` (`server.ts:2257`); the `tokens.css` link (`index.html:30`) | S. It protects from 0.8.0 on: a 0.6.0 tab cannot run code it does not have |

### Deletions, and what still leans on them

- `otherMember` (`:6465`) cannot go: the Calendar uses it (`:10223`, `:10251`, `:10410`) until 0.9.0, and
  Today's rail uses it (`:2467`) with no release to remove it. Finding.
- `askAnswer` stays, as the spec says, for Today's card (`:2678`); its two Plan callers (`:6654`, `:6920`) go.
- `liveChildren` has a caller the fold's change makes dead but not wrong: `syncNames` renames the events of a
  shelf's items when the shelf changes area (`calendar.ts:520`). It may go only because `shelves.retire` has
  always run before the first request; if the append at open ever fails, the open must fail loudly.
- `parent` must stay in `PAGE_FIELDS` and in `FIELD_WORDS` (`types.ts:925`, `drift.ts:483`): `validate`
  refuses a `plan.page.drift` naming a field it does not know (`replay.ts:733`), and old logs hold them.
- `filter` and `showDone` also live in `list_plans`'s input (`tools.ts:3399-3409`), `plansRail`
  (`server.ts:906`), `plansBlock` (`briefing.ts:551`) and the route comment (`server.ts:20`).
- `areas.set` and its route stay for old logs and for `server-settings.test.ts`; nothing on the page calls it.

### Order within the release

1. Move the shared helpers and the household clock; add the version check. Page only, no behaviour change.
2. `Plan`'s three fields, `plan.hand`, `state.hands`, with `describe`, `scopeOf` and the fold's tests.
3. The goal rule, `plan.goal`, `goal.rename`, `goal.remove`, `goalsOf`.
4. The three area ops and their routes.
5. `shelves.retire`, the five refusals removed, the append at open, and `restore.ts` (scopes, outsiders, the
   area walk, unknown ops reported).
6. The write routes and tools: hand, goal, the goals pair, `POST /api/plans`, the 410, `hand_plan`,
   `set_plan_goal`, `decide()`'s two refusals.
7. `board()` and `card()` in the new shape, with `plansRail`, `plansBlock`, `list_plans` and the page's
   picker and Settings reads.
8. The page: `memberDisc`, `stateGlyph`, `goalFlag`, `peopleBar`, `pressPerson`.
9. The board. 10. The Area page. 11. The card. 12. The goal row and foot. 13. The sweep: copy, CSS, README,
   version.

Steps 2 to 6 add ops and routes and change no read, so each lands and is tested with `node:test` while the
0.6.0 page still works. Step 7 changes what the page reads and must not be deployed without steps 8 to 11.

### What the spec leaves open that the code forces a decision on

1. **`system` is an outsider to restore.** `restore.ts:229-230` calls `outside(e.who, 'made')` for every
   plans-scope line. With `shelves.retire` in that scope, as the spec puts it, every backup that ever had a
   shelf is refused: "system is not a member of this household". The line must restore in its place, because
   goal ops after it are meant to win, so the fix is to let `system` through, not to drop the line.
2. **The area ops and restore.** The prerequisite walk tracks areas through `areas.set` and `areas.rename` only
   (`restore.ts:262-268`), so a plan made in an area that `areas.add` created is reported as needing an area
   "which does not exist here". And once the page stops writing `areas.set`, a household's areas are a chain
   of ops that replay only from the same starting list: restoring Settings into the household it came from
   meets "Garden is already an area". Decide whether `planRestore` dry-runs area ops and reports them, or
   leaves out those already true.
3. **The spec says restore "allows" a non-member as a previous owner.** `ownerFrom` is worked out by the fold
   and is in no event, so restore has nothing to allow. What restore does with an account asked that is not a
   member is refuse and name it (`restore.ts:231`, `:234-240`), which the spec's later section says correctly.
4. **`areas.move` and `shelves.retire` are thread lines unless something stops them.** `quiet()` passes every
   op that is not plan-shaped (`thread.ts:111`); `NOT_A_CHANGE` (`activity.ts:30`) is the only list that stops
   one. Both belong there, or Today shows a row written by "system".
5. **`word` or `why`.** `decide()` carries an approver's reason only into a field called `why`
   (`offers.ts:190`), `describe()` returns `why` (`tools.ts:739`) and lines collapse on `why`
   (`activity.ts:57`). A `hand_plan` card approved with a reason would lose it. Either the field is `why`
   (optional, not in `REQUIRES_WHY`) or all three learn `word`.
6. **A hand approved from a card has no change row.** An approval's effects are hidden as already said by the
   card (`thread.ts:151-157`). The spec's rule that every hand says "from whom, to whom" then rests on
   `hand_plan`'s summary naming both; write the summary to that rule.
7. **A plan's History cannot say why its goal or owner changed.** `card()` lists events whose `plan` is the
   card's (`plans.ts:169`). `goal.rename`, `goal.remove`, `shelves.retire` and `member.remove` name no plan.
8. **Where a log opens.** There are four loads and one adopt (rows above). One of the loads, a whole backup
   as a new household, cannot hold plans at all today: `createFromLog` drops the people lines, then loads, then
   claims (`households.ts:175-182`), so the first plan line is refused as from a non-member. Checked by
   replaying a two-line log. It predates these designs; it decides what "has just restored into" can mean.
9. **The old-log snapshot.** `old-log.test.ts` compares a whole replayed state and lets new fields through
   only at the top level. Its one plan will gain three fields. Extend the allowance to nested fields with
   stated defaults; do not regenerate the snapshot, which is the test's whole point.
10. **Back, and the two screens this release does not redraw.** "‹ Today" at the scroll it was left at needs
    `loadThread` to stop scrolling to the bottom (`index.html:2335`); "‹ Calendar" needs `loadCalendar` to
    keep the chosen day. Either touch both now, or say that in 0.7.0 Back returns to the screen and not the
    place.
11. **`reloadView` knows three screens** (`index.html:3019-3023`): the board, the card, and "else the
    thread". Every `inlineForm` and `actionButton` defaults to it. The Area page needs a case now; the
    Calendar's forms in place will need one in 0.9.0, where today a stray default would reload Today.
12. **The rename on the Area page** uses the existing route, which answers the whole Settings view
    (`server.ts:2286`), not `{ areas }`; `areaPage.area` must follow the new name before the redraw or the page
    falls to "an unknown area opens the board".

## 0.8.0: Today as day cards

### Server

| Capability (spec section) | Today | To build | Touches | Size and risk |
|---|---|---|---|---|
| A lane for every entry (Lanes; The server) | Nothing | `type Lane`; `laneOf(e, state): Lane or null`, exhaustive like `scopeOf`; a table of tool names to lanes | `thread.ts`; `tools.ts`; a new `lanes.test.ts` | M. `Tool.name` is `string` (`tools.ts:130`), so "a tool without a lane fails to compile" cannot hold; a test over `toolByName` can. A tool name in an old log that no table lists needs a stated fallback |
| Cards as entries of their own, with `raised`; `decision` entries; `cards` gone from briefings and answers (Entries) | `build()` hangs cards under what raised them (`thread.ts:139-145`); only `standalone` kinds are entries (`:88`, `:192-215`) | Every visible offer an entry at its place; a `decision` entry for a decision on a later day | `thread.test.ts`, `thread-view.test.ts` (456 lines), `server-thread.test.ts` (928) | L. A replaced briefing hands its cards on through `settle()` (`thread.ts:131-135`); `raised.entry` must be the settled one or its from-line jumps to a row that is not drawn |
| A change gains `plan`, `open`, `event`, `hand` (Entries) | `thread.ts:216-229` builds it from the first event of a collapsed group | The four fields, from that first event and `state.hands` | `activity.ts` (`Change.events`) | M. A line that stands for three events has one `open` |
| `days`, and the route's `through`, `open`, `lane`, `who`, `day`, `at` (GET /api/thread) | `thread()` pages by count and an event id (`thread.ts:256-298`); the route is `server.ts:2661-2717` | A pure `daysOf(entries, state, viewer, { from, to, lane, who })`, exported; the route's modes and its 400s and 404 | `server-thread.test.ts`; the Calendar reuses `daysOf` in 0.9.0 | L. Log order is not time order after a restore (finding 8); `opensItsDay` assumes a day is one run (`thread.ts:241-252`) |
| `waiting` items carry `lane`, `by`, `at`, `day`, `title`, `entry` (GET /api/thread) | `Waiting` is three bare shapes (`offers.ts:281-284`) | The added fields, worked out in `thread.ts` beside the entries | `offers.test.ts` | M. The unsorted item has no entry and no day |
| `calendar.appointment.change` (One new op) | `changeEvent` writes the NAS and, for a plan's link, an etag (`appointment-edits.ts:91-112`) | The op; a `validateCalendarLines` case; the fold; `BOARD_CALENDAR_OPS`; `PLAN_LINES`; `describe`; scope `plans`; one append of the change and the etag | `server-calendar-events.test.ts` | M. `was` must be read from the NAS event just fetched (`:96`): the state's copy is stale for anything changed before 0.8.0. The undo on a refused append is a second NAS write that can itself fail |
| `GET /api/search` over the record (Search) | `searchHousehold` merges Drive and the log, 8 at most (`search.ts:228-240`); `fromDrive` and `driveHit` are private (`:124`, `:152`) | `searchRecord(ctx, words, { lane, who })` over `build()`'s entries, with Drive's briefing and answer passages joined; `elsewhere` | `search.test.ts`; `build` exported or the function placed in `thread.ts` | L. Drive answers 50 at most (`search.ts:52`), so "newest 100" is not every match in Drive; a hit on a briefing since replaced has no entry to join |
| What leaves (What is deleted) | `filter`, `allBudgets`, `limit`, `before` as an id (`thread.ts:64-72`, `server.ts:2705-2714`); `author`, `hasWaiting`, `inView` | Deletion; `budget=` stays for the fallback and the two flags | `searchKind` stays for Claude's `search` tool | S. None |

### Client

| Capability (spec section) | Today | To build | Touches | Size and risk |
|---|---|---|---|---|
| The page's order: head and date, banner and notes, kinds, people, waiting, today, Earlier, composer (The page) | Markup `:1548-1575`; `loadThread` (`:2301`); `renderThread` (`:2374`) | The new skeleton inside `#briefing` | Listeners bound at load on `#t-filters`, `#t-all`, `#t-earlier`, `#tray` (`:3132-3156`) | L. The page opens at its top; four load-time listeners die with their markup |
| A day card: head, numbers, open and closed, the day read on opening (A day card) | A grey heading per run of entries by the device's day (`:2395-2398`) | One card per server `day`; open days as page state; day mode on opening | The tab-return reload (`:3169`) and every reload after a write | L. A reload must keep open days, the kind, the sort, focus and a reason half typed in an approve form |
| Rows: note, question and answer, change, a hand, a calendar change, a late decision (Rows) | `entryNode` (`:2565-2642`), `answerNode` (`:2914`), `removedBlock` (`:6199`) | One row shape, four columns; the text link from `open` | `clockOf` for times, in place of the device's `timeOf` (`:2236`) | L. The household clock helpers live in the Calendar region until they are moved |
| Proposal cards in a row (Proposal cards in a row) | Six renderers: `offerCard` (`:2959`), `askCardNode` (`:2650`), `driftCardNode` (`:2698`), `savingsCardNode` (`:2749`), `bookingCardNode` (`:2780`), `releaseCardNode` (`:2826`); `approveForm`, `adjustForm` (`:3044`, `:3062`) | Each re-housed in the block: label, title, effects, an error slot always rendered, buttons, the from-line | "Waiting for either of you" at `:2721`, `:2761`, `:2798`, `:2836` | L. The most likely place for a button or a settled line not to be brought over |
| The briefing in its day; Yours as a strip on the phone (The briefing and Yours) | Briefing in `entryNode`; `placeYours` moves one node between two places (`:2429`) | The by-line and clamp as now; one row per rail on the phone; the column kept on the desk | `calendarRail`, `plansRail`, `moneyRail` (`:2487-2540`) | M. `placeYours` and its observer go |
| Kinds, the people bar, empty days, the left-out line (Kinds and people) | Four filters (`:1553-1558`) | A kinds group; `peopleBar` with the shared person | Each press is a fetch: the counts are the server's | M. Each fetch runs the briefing and drift work first (`server.ts:2672-2704`) unless narrowing reads are spared it |
| "Waiting on you" and its jump (Waiting on you) | A tray button that switches the filter (`:2410-2412`, `:3156`); `unsortedItem` (`:2549`) | A list above today's card; rows that open the day and focus the card | `openTodayAt` | M. A card on a day in a month not on the page |
| One search, in Today's head (Search) | The top bar's box and menu (`:1887-2057`; markup `:1466-1474`) | The field in the head; results as day cards; "Elsewhere" | `searchClose` callers (`:1994`, `:2011`); Escape guards that name the bar's box (`:3652`) | L. Search is 190 lines today and its listeners bind at load (`:2021-2056`) |
| The composer (The composer) | `#composer` with the tray; the read cursor moves when it scrolls into view (`:3160-3166`) | The status slot; the kind returned to All when it would hide the new row | `askClaude` (`:3082`) | M. The read cursor's new rule: today's last row seen, All and Everyone pressed, no search |
| `openTodayAt(target)` and the links out (Deep links) | `openTodayAt(selector, { further })` in the Calendar region (`:10308-10331`); callers `:2011`, `:10264`, `:10265` | The target form; `{ day }`, `{ event }`, `{ offer }`, `{ drift }` | `endFilterDetour` is called from the tab bar (`:11055`) | M. The function sits in a region 0.9.0 rebuilds; move it in 0.7.0's first task |
| The two prompts Today owns (not in the spec's page list) | "No budgets yet" and "no open month" are drawn through `showProblem` (`:2330-2331`, `:4661`) | Kept, above the controls | The answer keeps `noBudgets` and `noOpenMonth` | S. Named nowhere in the page section, so a rebuild from the spec alone drops them |

### Deletions, and what still leans on them

- `endFilterDetour` is called from the tab bar's handler (`index.html:11055`) and `filterBeforeDetour` is
  declared in the Calendar region (`:10299`); both are outside the region being rebuilt.
- `threadFilter` is read by the read-cursor observer (`:3161`), which the spec replaces but does not list.
- `dayKey` goes only "for grouping": `blockText` and the card's notes still use it (`:6540`, `:7446`).
- `standalone` and `cardsFor` have no caller outside `thread.ts`. `kind` leaves the search route
  (`server.ts:2833`) while `searchKind` stays for the tool (`tools.ts:3452`).
- An old tab: the 0.6.0 and 0.7.0 pages loop over a briefing's `cards` (`index.html:2587`), which is gone, so
  Today throws and shows a raw error in the box. The version check from 0.7.0 turns that into "Reload".

### Order within the release

1. `laneOf`, the tool table and its test. Nothing reads them yet.
2. `calendar.appointment.change`, end to end. The 0.7.0 page already draws it as a line.
3. The entries: lanes, days, cards with `raised`, decisions, `open`, `event`, `hand`.
4. `daysOf`, the route's modes, the waiting fields. 5. The search route.
6. The page's skeleton, day cards and plain rows. 7. Cards in rows. 8. The briefing and Yours.
9. Kinds, people, empty days. 10. The waiting list and `openTodayAt`. 11. Search. 12. The composer and the
   read cursor. 13. The sweep and the version.

Steps 1 and 2 can be deployed alone. Steps 3 to 5 are tested with `node:test` before any page work but change
the wire, so they ship with the page.

### What the spec leaves open that the code forces a decision on

1. **`hand` has two shapes.** Plan spec: `{ plan: PlanRef, from, to }`. Today spec: `{ plan, to }`, "as the
   Plan spec defines". The row "handed … from Bob to Casey" needs `from`.
2. **A calendar row has no name to print.** The entry's `event` is `{ start, end, allDay, on, was? }`; the rows
   read "added **Swim meet**" and "renamed **Swim** to **Swim practice**". `describe()` gives "made an
   appointment: Swim meet" as one string. Add `summary` to `event`, or the page parses a sentence.
3. **Order and "new".** Entries must be grouped by `householdDay` and sorted by time within a day; `fresh` and
   the divider must use the cursor's place in the log. After a restore an old line sits after the cursor, so
   an old day will honestly read "3 new": decide whether adopted lines count as new.
4. **A pressed person and Claude's cards.** A person shows "the rows that person wrote, a question with its
   answer". A card raised by that answer is now its own entry, written by Claude. Say whether it shows under
   the person whose question raised it (`raised.by`), and whether `by` counts it.
5. **A jump to a day off the page.** Day mode reads one day by `at`. If its month is not loaded, the page
   holds a card with a gap of months above it. Decide: load every month down to it, or show it alone under a
   line that says so.
6. **A narrowing press is a fetch that starts with the briefing.** `GET /api/thread` writes the briefing and
   looks for drift before answering (`server.ts:2672-2704`). Both are guarded, but Claude's refusal path is
   not cheap. Either the page narrows from one full answer, or the route skips the preamble when `lane`,
   `who` or `open` is all that changed.
7. **`was` and the etag.** A notes-only save writes no line (the spec's rule), so the state's `dav_etag` goes
   stale; harmless, because `changeEvent` reads the event again before every write (`appointment-edits.ts:72`).
8. **The tool table's reach.** It must list every name that ever offered a card. The code can list the write
   tools registered then and the retired `ask_to_take`; a name only an old log knows needs the fallback
   from the first row of the server table.

## 0.9.0: the Calendar as a day page, and Bills

### Server

| Capability (spec section) | Today | To build | Touches | Size and risk |
|---|---|---|---|---|
| A window of 1 to 42 days (The server) | `WEEK_MAX_DAYS = 8` (`calendar-view.ts:191`); `weekWindow` (`:205`) | The constant | `server-calendar-events.test.ts` covers the window | S. Calendars are read one after another (`:64-82`); six weeks of each on a slow NAS |
| `owner` on an event (The server) | `mine`, `household` or `partner` (`calendar-view.ts:19`, `:56`); `ownedBy` reads the id (`:92`) | `ownerOf(ref): Actor or null`, set in `viewerEvents` | `todayEvents`, so Today's rail gets it too | S. Account names compared without case; a checked calendar that is no member's |
| `plan` grows to `{ id, title, state, owner, goal, area }`; a stay's `held` grows (The server) | `{ id, title }` built in four places (`:58-61`, `:282`, `:294`, `:338`); `held` at `:306` | One `planRef(p)` | `WeekEvent`'s type | S. None |
| A linked block the calendars did not show is drawn from the plan (The server) | Only a block with no link is drawn (`:287-297`); a due date already uses a `shown` set (`:274-279`) | The same `shown` test for blocks | `calendar.test.ts` | S. Drawn twice if the test is on the link and not on what was shown |
| `mine`, `goals`, `thread` on the answer (The server) | Nothing | `goalsOf` from 0.7.0; `daysOf` from 0.8.0 over the window; `mine` from the listing's default calendar (`:53`) | `weekEvents` must read the log (`store.since(null)`) | M. `daysOf` must take a window, not a month: 42 days can touch three |
| `bill.set`, `bill.remove`; bills kept on the budget (Bills in the log) | Nothing; a draft budget's fields are listed by hand in `freeze` and `thaw` (`replay.ts:132`, `:169-170`) | Two ops; validation; the fold; `bills` beside `envelopes`; `envelope.remove` drops them; `describe`; scope `budgets`; lane `budget` | A new `bills.test.ts`; `tools.test.ts`; `old-log.test.ts` (nested again) | L. The key (finding 7). A missed line in `thaw` loses every bill on the next append |
| `chargeKey` exported; `FixedCharge.lastDate` (Money on a day) | Private (`analytics.ts:75`); no date kept (`:46-54`) | Both | `analytics.test.ts` | S. None |
| One function for an envelope's bills and a window's money rows; `stillExpected` redefined on it (Money on a day) | `pace` (`analytics.ts:186-261`) | `billsFor(state, budget, envelope)`; `moneyRows(state, { from, to, today })` | `briefing.ts:236` and `explain_envelope` (`tools.ts:487`) print `stillExpected`; `analytics.test.ts` (531 lines) | L. See findings 2 to 4 below. The promise "until a date is set, every number is as today" needs a test written before the change |
| `set_bill` (Bills in the log) | Nothing | One write tool; `APPROVE_IN_ONE` (`tools.ts:3481`); `TOOLS`; the lane table | `tools.test.ts`; `lanes.test.ts` | M. A `name` that matches two bills in one envelope |
| `get_month` gains `bills` per envelope; `money` on `GET /api/calendar` (The server) | `get_month` (`tools.ts:258`); the short walk exists in `budgetNotices` (`setup.ts:181`) | Both, from the one function | `tools.test.ts`, `calendar.test.ts` | M. None |
| A calendar change's `open` gains `key` (The server) | From 0.8.0 | The appointment's `evt_id` | `thread.ts` | S. None |

### Client

| Capability (spec section) | Today | To build | Touches | Size and risk |
|---|---|---|---|---|
| The phone's head, the calendars bar, overlays and goal chips (The phone page) | Head and strip markup (`#cal-bar`, `#cal-month`, `#cal-strip`); no bar | `peopleBar` with a Household entry; one line in `pressPerson`; `hp.calOver` | `pressPerson` from 0.7.0 | M. Household pressed here must not change who is pressed elsewhere |
| `dayMarks(day)` and every numeral from it (The week strip) | Dots per source (`:10516-10519`); a count of things (`:10529`) | One helper read by the strip, the month, the bar and the desk's day heads | Accessible names in words | M. Two counters that drift apart is the anti-goal |
| The month picker (The month picker) | Nothing; one fetch per week with a guard on late answers (`:10430-10435`) | A 42-day fetch kept beside the week's | `calFetch` | M. A late 42-day answer drawn over a week |
| The day card's rows, the now line, "also has" (The day card) | An hour grid (`renderDay`, `:10504-10543`; `timedBoxes`, `evNode`, `evSub`) | Eight kinds of row in a five-column grid | `evOpen`'s order (`:10262-10272`) | L. Clash groups are worked out on the page: the server's flag does not say which rows clash with which |
| Add, Keep nights, a kept row, Change this event, the read-only view, all in place (Adding to a day; Opening an event) | Four forms drawn in `#cal-panel` (`openEventForm` `:10710`, `openEventView` `:10907`, `openBlockForm` `:10573`, `openHeld` `:10620`) | The same contents, hosted in the row on the phone and in the panel on the desk | `reloadView`; listeners bound at load on `#cal-block`, `#cal-this`, `#cal-new` (`:10614`, `:10661`, `:10939`) | L. "One thing open at a time" across two hosts |
| The desk: day heads as buttons with marks, the panel, boxes that name owners, money in the all-day row (The desk) | `renderWeek` (`:10453-10501`) | The additions; the grid kept | `evClasses` (`:10225`) | L. The grid is kept, so this is the one screen edited in place and not rebuilt |
| `openCalendarAt(day, key?)`; Today's three callers; Back from a card (Deep links) | Today's rail opens the Calendar's week (`:2493`) | The function; a row tinted until the day changes | `cardFrom` from 0.7.0 | M. A late reply after the visit moved on |
| `householdDisc()` (The day card) | Inside `sourceDisc` (`:2460-2470`) | Lifted beside `memberDisc` | Today's rail | S. See the deletion of `otherMember` below |
| Bills on the envelope's page (Bills, on the envelope's page) | Sections Each month, This month, Receipts (`:3848-3898`) | `envSection('Bills', 'bills')` between the last two; the form; `set_bill` through `approveNow` | `openBudgetAt`'s third argument becomes a focus key (`:3927`; caller `:2368` passes a boolean) | M. A closed month shows no action; a savings envelope no section |

### Deletions, and what still leans on them

- `otherMember()` is deleted "wherever the Calendar names a calendar's owner". Its last caller would then be
  Today's rail (`index.html:2467`), which draws every `partner` event with the first other member's disc. Set
  `owner` in `viewerEvents`, not only in `weekEvents`, and the rail can use it; then the function can go.
- `#cal-panel` stays on the desk; only the phone stops using it. `closeCalPanel` has callers in the event
  form (`:10594`, `:10777`).
- `legend()` is called twice from `renderWeek` (`:10464-10465`), which is kept: delete the calls with it.

### Order within the release

Bills first, deployable alone: 1. `chargeKey` exported and `lastDate`. 2. The two ops, the fold, restore.
3. The bills function, with a test that pins every `pace` number before any date is set. 4. `set_bill` and
`get_month`. 5. The Bills section on the envelope's page.

Then the Calendar: 6. The answer's growth (`owner`, `plan`, `held`, blocks, `mine`, `goals`, `thread`, the
window). 7. `money` on the answer. 8. `dayMarks`, the bar, the overlays. 9. The strip and the day card.
10. The month picker. 11. The forms in place. 12. The desk. 13. `openCalendarAt` and Today's callers.
14. The sweep and the version. Steps 1 to 4, 6 and 7 are server work the old page ignores.

### What the spec leaves open that the code forces a decision on

1. **The bill's key** (finding 7). `chargeKey` is `normalisePayee(payee)`, a bar, and the category id; the
   normaliser strips digits and cuts at 24 characters (`analytics.ts:382-390`). Once in the log both are a
   format. Pin them with a test, or key a dated bill by a name the member confirms.
2. **An envelope with nothing funded is never short.** `pace` skips an envelope with no funding and no
   activity (`analytics.ts:206`), so it has no `Pace` to compare: the envelope with a bill coming and nothing
   in it, the one most worth a row, gets none.
3. **A month that is not open has no lines.** `monthView` is null without a month plan (`envelopes.ts:131`),
   and a receipt "lands in the envelope" by a line of its view. Paid rows in a past month never opened, and
   BILL rows in a later month, must find their receipts through `envelopeFor` directly, as `pace` already
   does for its map (`analytics.ts:195-201`).
4. **A receipt belongs to no budget.** Receipts are the household's; each live budget's envelopes claim them
   by category. With two live budgets the same bill is a row in both, one receipt pays both, and a short
   envelope in a budget kept only for comparison turns today's `$` red. The spec names the budget on the row;
   decide whether every live budget is drawn or only the one in view.
5. **Clashes.** `markClashes` runs before rows drawn from the log are added (`calendar-view.ts:270`), so a
   proposed event, an off-calendar block and the new linked blocks never clash; and the flag names no partner,
   so "2 at 9:00" is regrouped on the page by overlap among flagged rows.
6. **`openBudgetAt` opens this month's page** (`index.html:3935-3936`). A PAID row from last month opens the
   envelope as it stands now, at Bills. Say that is meant.
7. **A stay's row opens its request's card**, which may be months old: it needs 0.8.0's day mode by `at` and
   the decision in finding 5 of that release.

## Across the three

### Shared foundations, and the two-member list

Built once in 0.7.0 for all three: the helper move; `memberDisc`, `stateGlyph`, `goalFlag`, `peopleBar`;
`personPressed` and `pressPerson`; `goalsOf` as an exported function; `cardFrom` and `openArea` as the link
functions; the household clock above the screens; `reloadView` taught a fourth screen; the version check.
Built in 0.8.0 for 0.9.0: `daysOf` over a window; `openTodayAt(target)`; `laneOf` and the tool table.

Every place that assumes two members, and the release that fixes it:

| Where | What it assumes | Fixed in |
|---|---|---|
| `plans.ts:120-135`; `server.ts:2866`; `server.ts:906`; `briefing.ts:551`; `tools.ts:3399-3409` | The board is filtered both, mine or theirs | 0.7.0 |
| `index.html:1734-1736`, `:6446`, `:6575-6576` | Both, Mine, Theirs; "Theirs" renamed after the one other member | 0.7.0 |
| `index.html:1743` | "anything the two of you mean to do" | 0.7.0 |
| `index.html:6518-6519` | `whoDisc`: you, or "partner" | 0.7.0 (`memberDisc`; one ring for every other member is the design) |
| `index.html:6850`, `:6953-6960` | The card offers to ask "the" other member | 0.7.0 |
| `index.html:7441-7453` | A note "for" the other member, or "each other" | 0.7.0 |
| `thread.ts:69`, `:282-283`; `server.ts:2712`; `index.html:1555-1556` | Today filtered mine or theirs | 0.8.0 |
| `index.html:1567` | "leave a note for each other" | 0.8.0 (the new placeholder says "the others") |
| `index.html:2721`, `:2761`, `:2798`, `:2836` | "Waiting for either of you" | 0.8.0 |
| `calendar-view.ts:19`, `:56` | Any checked calendar that is not yours is "partner" | 0.9.0 (`owner`) |
| `index.html:10223`, `:10251`, `:10410-10415`, `:10519` | The Calendar names a partner's calendar after the first other member | 0.9.0 |
| `index.html:2459-2467` | Today's rail: the same, through `sourceDisc` | **None.** 0.9.0 lifts the house mark out and leaves the rest |
| `index.html:6465` | `otherMember` itself | **None** while the row above stands |
| `briefing.ts:297` | Claude's facts are headed "NOTES THE TWO OF THEM LEFT EACH OTHER" | **None** |
| `briefing.ts:925` | The briefing's prompt: "Both of them read it" | **None** |
| `conversation.ts:208` | Every question's context: "Notes are between the two of them" | **None** |
| `index.html:9537` | The reason for adding a member: "e.g. my partner" | **None** (a placeholder) |
| `types.ts:476`; `activity.ts:2-7`; `conversation.ts:2`, `:31`; `server.ts:14`, `:35`; `calendar-view.ts:220` | Comments: "the other member", "the two of you" | None; a sweep |

The Plan spec's call 2 ("three or more members already work on the server") is right about the data and wrong
about the words: the fold has no limit, and the three prompt lines above tell Claude there are two people. The
Today spec rules out changing what Claude sees, so these need a ruling of their own. They are three strings.

### Data and upgrade risks

For every new op: an old log replays unchanged (no old line changes meaning; new fields take defaults in the
fold), and an older build cannot open a log that holds one (`replay.ts:1925`). The rows say what differs.

| Op | A backup from before, restored after | A backup from after, on an older build | A tab left open |
|---|---|---|---|
| `plan.hand` | Restores; old asks keep their cards | Parsed, counted nowhere, left out: the plan keeps its earlier owner, silently | 0.6.0 page shows the new owner; it has no hand |
| `plan.goal`, `goal.rename`, `goal.remove` | Restores | Left out silently. On a current build, a rename onto a goal the target already has is refused in the fold, and with it the whole restore (`Store.adopt` is all or nothing) | The board's read is refused with "Reload the page" |
| `areas.add`, `areas.remove`, `areas.move` | Restores (old backups hold `areas.set`) | Left out silently; plans then need areas that "do not exist here" | Settings' area form posts its stale list as `areas.set`: it undoes a move and drops an empty area added since |
| `shelves.retire` | Restores with shelves; the app appends a retire after the adopt | Left out: shelves come back as shelves, which is safe there | A 0.6.0 card throws on the new answer (`index.html:6848`) |
| `calendar.appointment.change` | Restores | Left out: the appointment reads as first made | 0.6.0 and 0.7.0 Today throw on the new entries (`:2587`) |
| `bill.set`, `bill.remove` | Restores | Left out: dates are lost, receipts are not | An old page ignores `bills` and `money` |

Three things follow. A whole backup "as a new household" fails today for any log with plans
(`households.ts:175-182`), before and after these releases. The restore preview should list ops it does not
know under "unreadable" instead of dropping them (`restore.ts:84-104`): 0.7.0 is the first build that can
do that for the two after it. And `shelves.retire` is the only new op written with no member acting, which is
what makes finding 1 certain and not merely possible.

### The one-file page

Three releases of this size fit the convention. The page grows from about 11,400 lines to about 13,000: Plan
adds a page and forms and loses its grid; Today trades a thread for cards at similar length and absorbs
search; the Calendar keeps the desk and adds the phone's rows; Bills adds one section. One file with no build
is still the cheapest way a fix reaches a phone, and nothing here needs a second file.

What the file lacks is seams an editor can trust. The script is already cut by `// ── name ──` headings
(`index.html:1815` to `:11063`), but helpers sit where they were first needed, so a rebuild of one screen
deletes what two others call. If it stays one file: (1) one shared region first, holding `node`, `api`,
`icon`, `lucide`, the discs, glyphs, flag and bar, the household clock, `inlineForm`, `actionButton`,
`textBtn`, the page frame and `reloadView`; (2) then one region per screen that calls shared helpers and its
own, and other screens only through the link functions (`openCard`, `openArea`, `openTodayAt`,
`openCalendarAt`, `openBudgetAt`); (3) then `showView` and the household boot. The CSS block (`:31-1410`) and
the markup (`:1456-1786`) want the same order.

The discipline that keeps three rebuilds from undoing each other:

- **A ledger per screen, written before the rebuild.** Every id, every listener bound at load, every button's
  words, every route called, every state variable, every link in and out; each line then marked kept,
  replaced by, or deleted by which section of the spec. The specs' "What is deleted" lists are half of it.
- **Listeners bound at load are the sharp edge.** Thirteen sit on ids these releases delete or re-make
  (`:2021-2056`, `:3132-3156`, `:6692`, `:6778`, `:10614`, `:10661`, `:10939`). Markup removed without its
  listener stops the script: no screen draws.
- **A smoke pass per screen against the fake DSM** at 375 wide and on the desk, after every task, for all
  four tabs and not only the one being rebuilt.
- **New CSS reaches phones late.** `tokens.css` is served with `max-age=3600` (`server.ts:640`) beside a page
  that is never cached. Link it with the version (`/tokens.css?v=0.7.0`) or keep each release's CSS in the page.

### Test strategy

`node:test` covers all of the server: each op's validation, fold and refusals; `describe`, `scopeOf` and
`laneOf` (all three exhaustive, so `npm run typecheck` names a missed op); `board`, `card`, `goalsOf`,
`daysOf`, the search; the routes, through the `server-*.test.ts` files and the fake DSM; restore, with one
new test per release that takes a backup from a log holding the release's ops and restores it into a fresh
household and into the one it came from; and the bills function against fixed receipts.

The page has no automated check. No test reads its script. So each release needs a written manual check: the
ledger's kept lines walked on a phone and a desk; the review focus the envelope pages used (the keyboard at
375 by 812, a reply after Back, a failed save keeping what was typed, a deep link on a cold load); three
members signed in, not two; a tab left open across the upgrade; a restore of yesterday's backup.

The smallest check that would have caught "an element was not brought over" is a text test,
`page-ledger.test.ts`, with no browser:

- **Boot:** every id passed to `$()` at the top level of the script exists in the markup.
- **Kept:** each string in the release's ledger marked kept is still in the file (ids, button words,
  function names such as `removedBlock(`, `approveForm(`, `openBudgetAt(`).
- **Gone:** each name in the spec's "What is deleted" is absent (`planFilter`, `renderBoard`, "Theirs").
- **Routes:** every `/api/…` literal in the page is a route `server.ts` answers.

It reads two files and compares lists. It cannot see layout or focus; it does see a dropped button, a dead
listener and a call to a route that has gone, which is most of what a rebuild loses.

### Sequencing and size

| Release | Tasks, roughly | Where the weight is |
|---|---|---|
| 0.7.0 Plan by area | 13 | The server: eight ops, a fold that drops five rules, restore, one read reshaped under six callers. Then three page tasks of size L |
| 0.8.0 Today as day cards | 13 | The page: a 965-line region rebuilt, six card renderers re-housed, search moved in. One op on the server, one read reshaped |
| 0.9.0 as specified | 14 | Two halves: Bills (5 tasks, analytics and the log) and the Calendar (9 tasks, mostly page) |

0.7.0 is the largest and carries the most risk to data, and it should not be split: goals are what shelves
retire into, and the board cannot be drawn half way. It can be made safer by landing its steps 2 to 6 as
server work behind the old page. 0.8.0 is the largest on the page and has the least data risk. 0.9.0 should
be two releases, Bills then the Calendar, because the first is a change to money's arithmetic and the log,
and the second is a screen.

Pulled forward into 0.7.0 because all three need them: the helper move and the household clock; the version
check and the versioned stylesheet link; unknown ops reported by the restore preview; the nested allowance in
`old-log.test.ts`; `goalsOf` exported; `page-ledger.test.ts` with Plan's ledger as its first list. None is in
the Plan spec. Together they are two small tasks, and each later release is cheaper for them.
