# The Plan page, by area

**Status:** design, for review. Agreed with the owner on 2026-11-09.

## Intent

The Plan board is a grid drawn for two people at a desk: areas down the side, Planning and Doing across. On a
phone each area becomes two labelled lists, and every empty one says "Nothing in Doing in House." The filter
reads Both, Mine, Theirs, which stops meaning anything the day a third member joins. Giving a plan to someone
takes an ask, a card on their Today and an answer. Areas are edited in Settings, a screen away from the board
they shape. Finished plans come back only through a global Show done. And nothing says what a plan is for.

The owner liked the envelope pages of 0.6.0: plain rows, each opening its own page, adding as the last row.
This release, 0.7.0, the first of three, gives Plan that shape. Each area is a heading that opens a page; its
plans are rows in one card; a row carries its own state as a glyph, so the two columns go.

On goals the owner's model replaced the designer's: "I can finish all plans and the goal may not yet be
complete… the unknown unknowns travel beyond the last open plan." A goal is never finished. On figures: "I
don't want us to keep trying to curate bespoke labels and data lines." Every count below names its source.

## Goals

- The board is one card of rows per area, in the household's order. No columns. State is a glyph on the row.
- An area's name opens the Area page, where it is renamed, moved and removed, and where its Done lives.
- A people bar replaces Both / Mine / Theirs and works for any number of members.
- "Hand it to" replaces ask-to-take: the owner gives a plan to another member, at once, with an optional word.
- A plan may carry one goal. Goals filter the board, begin by use, and end only when removed.
- Adding happens where the thing will appear. The Area page and the card behave as the envelope pages do.

## Non-goals

- The card below its head stays as it is, Due date and Block time too. The mock's When line is not built.
- No drag, no area icons, no per-member colours, no household list of goals, nothing about goals in Settings.
- No moving a plan onto or off a shelf, no goal on its page in Drive, no Claude tools for goal names or areas.
- No URL for a page and no wiring of the browser's Back. Deep links stay function calls, as they are today.
- Today and Calendar are not redrawn here. What they show in the meantime is said under "The thread".

## Anti-goals

- A count the reader cannot reproduce by counting rows on the same screen.
- A goal drawn as finished, ticked, struck or greyed because its plans are done.
- A third member shown as "Theirs", sharing a filter with someone else, or missing from Hand it to.
- A plan landing on someone's list with no line in Today saying who handed it and why.
- A plan added under a filter that does not appear in the view it was added in.
- An area removed from under a done plan. An old ask with no way to answer it. A new ask by any door.

## The board

`#plan` holds, top to bottom: the head, the people bar, the goal row, the areas, one quiet line, and either
the last card or the goal's foot. All of it is drawn from one `GET /api/plans` (shape under "Reading").

**Head.** `h1` "Plan" and one count line built from the rows in view: `P` the cards in every `rows[].plans`,
`A` the rows that have any, `D` those in Doing.

- no filter: "12 plans in 4 areas · 5 doing"; the doing part is left off at 0. With no plans at all: "Nothing
  is planned yet. Anything the household means to do goes here."
- a person pressed: "Bob's · 4 plans in 3 areas · 2 doing" ("Yours · …" for yourself).
- a goal pressed: "Toward New roof · 4 plans in 2 areas · 2 doing · 1 done". Under a goal `P` and `A` count
  `rows[].done` too, and "· N done" follows when N is not 0.

**An area.** A `section` per row. Its heading is one link (the `h2` in title weight, a count, a chevron) that
opens the Area page. The count is "5 plans · 2 doing" with no filter ("No plans" at 0), "2 of 5 plans" under a
person (`row.plans.length` of `row.all.plans`), and "3 toward it" under a goal (plans and done together). With
no filter every area is drawn. Under a filter an area with nothing in view is not drawn, and one quiet line
after the last area names them: "Nothing of Bob's in People.", "Nothing toward this goal in People or Trips
yet.", or "Nothing of Bob's toward this goal in People or Trips." An area's `.rows` surface holds, in order:

1. **Shelf rows** (no filter only). The shelf icon, the title in semibold, "holds 3 · 1 doing" and the discs
   of the owners of its open plans (`shelf.holds`, `.doing`, `.owners`); " · 2 done" follows when `shelf.done`
   is not 0. It opens the Area page at that shelf's card. Under a filter there is no shelf row: each matching
   plan on a shelf is an ordinary row with "on Kitchen refresh" in small type under its title.
2. **Plan rows**: plans on shelves first (filter only), then Doing before Planning, each in the log's order. A
   row is one button: the state glyph, the title, a meta line, a chevron; a Doing row has a 3px accent rail on
   its left edge. The meta line, in order: the owner's disc; the plan's chips; the clock ("2 wks", in Doing
   from 14 days, from `daysInState`); the due day; blocks; "research"; the envelope ("$ Groceries · $40 left",
   from `envelope.left`); the goal flag, left off under that goal.
3. **The add row.** "A new plan in House"; with another member pressed, "…, for Bob"; with a goal pressed, "…,
   toward this goal"; with both, "A new plan in House, for Bob, toward this goal". It opens a form where the
   row was: the field "The new plan" (placeholder "e.g. Fix the fence gate", 200 characters), one line saying
   what the filter adds ("It will be Bob's, toward New roof.", or either half), the error slot, Cancel and
   **Add it**. An empty name says "Give it a name". Adding returns focus to the add row.
4. **The done row**, when `row.done` is not empty: sunken, a small green check, "3 done" ("1 done toward this
   goal" under a goal), a chevron. It opens the Area page with Done open and focused. One exception: under a
   goal, an area with no open plan toward it draws its done plans as rows instead (title softened, "done Mon
   12 Oct" from `doneAt`), so a card is never only an add row and a fold.

**The last card** (no goal pressed): "A new area". It opens in place: "The new area" (placeholder "e.g.
Garden", 60 characters), the hint "It joins the board at the bottom. Rename it, move it or remove it from its
own page.", Cancel and **Add it**. Adding opens its page, saying "Garden is on the board, under Trips."

**On the desk** (the page container at 1040px) the areas are columns that wrap, each the same card, "A new
area" a dashed column at the end. The add row may read "A new plan" there, its accessible name whole.

## The people bar and the shared helpers

These four are written once, beside `icon()`. The Today and Calendar specs call them by these names.

- `memberDisc(name)` replaces `whoDisc`: a disc with the member's initial, solid for you, a ring for every
  other member, no third colour. `title` and the accessible name are the member's name.
- `stateGlyph(state)`: `planning` is a dashed circle (Lucide `circle-dashed`) in `--ink-faint`; `doing` is a
  circle with its right half filled, in `--accent`; `done` is Lucide `circle-check` in `--good`. Each is named
  "Planning", "Doing" or "Done" for a screen reader unless the word is printed beside it.
- `goalFlag(label)`: Lucide `flag` and the goal's whole label, on one line, cut by the row with an ellipsis.
- `peopleBar(host, { label, people, pressed, onPress })`: a `.seg` group named by `label`. "Everyone" first,
  then one button per entry of `people` (`{ key, label, n }`), you first, then the household's order, the
  count after the name. One is pressed at a time (`aria-pressed`). Past the width it scrolls sideways.

**Where the pressed person is kept.** One module variable, `personPressed` (a member's account name, or null
for Everyone), set only through `pressPerson(member)`, which mirrors it to `sessionStorage['hp.person']` so a
reload keeps it. It returns to null, and the key goes, on a household switch and on sign-out; a stored name
that is not a member is dropped. All three tabs read it. A tab where that person has nothing in view shows
Everyone pressed and leaves it alone: on Plan the route decides this and says so (`who` in the answer).

**On Plan** the bar is labelled "Whose plans", is hidden while the household has one member, and lists the
answer's `members`: each member who owns a plan in view, with how many. The counts ignore the pressed person
and respect the pressed goal, so under a goal only members with plans toward it are listed.

## Goals on the board

The goal row is drawn only when the answer's `goals` is not empty: "All goals", then a chip per goal with the
flag, alphabetical, in one row that scrolls sideways and brings the pressed chip into view. The pressed goal
is Plan's own (`planGoal`), not shared with the other tabs. No chip ever looks finished.

With a goal pressed, the foot of the board holds "Rename this goal", "Remove this goal" and one line: "Both
act on all 4 plans that carry it, done ones included." (the last three words only when `done` is not 0;
figures from that goal's entry in `goals`). Each opens where the buttons were.

- **Rename.** "Call it", prefilled, 60 characters; the hint "The new name goes on all 4 plans that carry it.";
  the error slot; Cancel and **Rename it on 4 plans**. The board reloads pressed on the new name.
- **Remove.** "This will", "Take **New roof** off 4 plans, 1 of them done", "Leave the plans as they are", and
  small: "The goal ends here: it leaves the filter row. Putting the same words on a plan later starts it
  again." Cancel and **Remove the goal**. The board reloads on All goals, saying "New roof is off 4 plans."

## The Area page

Drawn in `#plan` with the board hidden, as an envelope's page is drawn in `#budget`. It always shows the whole
area, whatever is pressed on the board, from an unfiltered `GET /api/plans`. Top to bottom:

1. **Head.** `‹ Plan`, the area's name as the `h1`, and one line: "5 plans · 2 doing · 3 done · first on the
   board", from `row.all` and the area's place in `areas` ("first", "last" or "2 of 4"; left off with one
   area). An empty area reads "Nothing planned yet · last on the board".
2. **A slot** for the rename form and a status line, so the form opens at the top with focus in it.
3. **A card per shelf.** A small caps heading "Kitchen refresh · shelf" with the shelf icon and the link "Open
   the shelf" (its own card). Its rows are its open plans; its last row is "A new plan on Kitchen refresh".
4. **Plans.** The area's open plans that are on no shelf, then "A new plan in House".
5. **Done · 3.** Folded, with Show / Hide; open when the page was reached from a done row. Rows newest first
   by `doneAt`: the done glyph, the title softened, the owner's disc, "done Tue 3 Nov", the goal flag, and "on
   Kitchen refresh" under the title for a plan on a shelf. Not drawn when there are none.
6. **Foot.** "Rename this area", "Move up", "Move down", "Remove this area", then one line. An impossible move
   is not offered. Rename opens in the slot: "Call it", prefilled, the hint "Its plans go with it.", Cancel
   and **Rename it**; an unchanged name closes without a write. A move redraws and says "House is now 2 of 4."
   Remove is live only when the area holds nothing ("Nothing is in it, so removing it loses nothing."); it
   removes at once and returns to the board, focus on "A new area". Otherwise it is `aria-disabled` under
   "House holds 8 plans, 3 of them done. An area is removed once it holds nothing." (open plus done, from
   `row.all`; no middle clause at 0 done). The last area: "A household keeps at least one area."

## The plan's card

`#plan-card` keeps its sections. What changes:

- **Head.** The Back button says where it returns ("‹ Plan", "‹ House", "‹ Today", "‹ Calendar"). The crumb
  reads Plan › House › Kitchen refresh: Plan is the board, the area is its page, the shelf is its card. The
  state segment's two buttons carry their glyphs; Mark done carries the check. "Ask Bob to take it" goes.
- **Owner**, a section above Notes, on every plan that is not a shelf. One line: "You own it" or "Bob owns
  it", over "since Wed 21 Oct · you made it", "… · Alex made it" or "since Mon 9 Nov · from Alex"
  (`ownerSince`, `createdBy`, `ownerFrom`). The owner alone sees **Change**: "Who owns it?", a radio list of
  every member with the owner checked, and a live line: "It stays yours; nothing moves." or "It becomes Bob's
  at once and shows in Today. Bob can hand it back." With another member picked, the field "A word for Bob
  (optional)" appears (300 characters, placeholder "Why them, or what to know first"). Cancel and **Hand it to
  Bob**, `aria-disabled` until another member is picked. The card reloads with the status "Bob has it." While
  an ask from before 0.7.0 is open, a quiet line with no buttons sits under the owner: "Bob was asked to take
  it on Mon 2 Nov. It is answered on Today; handing it to anyone settles it."
- **Goal**, a section under Owner, same exclusion. One line: "No goal" over "this plan stands on its own",
  with **Set a goal**; or the flag and label over "one of 4 plans toward it · 1 done" ("the only plan toward
  it" at 1), with **Change**; figures from this goal's entry in the card's `goals`. The form asks "What is it
  toward?" and picks before it types: "No goal"; each goal in use with "4 plans · 1 done"; then "A new goal…",
  which shows the field "Call it" (60 characters, placeholder "e.g. New roof"). One live line: "It stays
  toward New roof." / "It moves to Summer trip. New roof keeps 3 other plans." / "It comes off New roof, which
  keeps 3 other plans." / "New roof ends here: no other plan carries it." / "A goal begins when a plan carries
  it. This plan will be its first." / "Summer trip is already a goal; this plan joins it." Cancel and
  **Save**; nothing changed closes without a write.
- **Foot.** A plan on no shelf that holds no plans also offers "Make it a shelf": "The first plan on it", the
  hint "Fix the fence gate becomes a shelf: a group that holds plans and has no state, owner or goal of its
  own." (with a goal: "Its goal, New roof, goes to the first plan on it."), Cancel and **Add it**.
- **A shelf's card** has no state line, Owner or Goal. "On this shelf" lists rows, ending in the add row.
  **Between us** asks "Leave a note about this", for any number of readers.

## Pages: Back, Escape, focus, deep links

The mechanism is the envelope pages', not a new one: page state in a module variable, a function that opens
it, a document Escape listener while it is open, every async continuation guarded against a page since left.
`areaPage = { area, boardScroll, from }`, `openArea(area, { linked, focus })`, `closeArea()`, `areaEscape`,
and `clearAreaPage()`, called wherever `clearEnvelopePage()` is.

- Opening a page scrolls the window to the top once and focuses the heading, or the first field when it opens
  on a form, with `preventScroll`. `focus` may name a shelf's card or `done`.
- Back, and Escape with nothing open, return to where the page was opened from, at the scroll it was left at,
  with focus on the row or heading that opened it. Escape first cancels an open form (`[data-cancel]`), as on
  an envelope's page, and does nothing while a sheet, a menu or the search box has it.
- A committed change redraws the page from a fresh read. It never goes Back by itself, except Remove.
- The card records where it was opened from (`cardFrom`: the view, the area page if any, the scroll, the row)
  unless it is opened from another card. Back and Escape return there.
- **Deep links** are two functions: `openCard(plan)`, as today, and `openArea(area)`. So opened (`linked`),
  Back returns to the caller. A plan that is gone is a 404 in the error box; an unknown area opens the board.

## The server

### Ops

Seven are added to `Event` in `api/src/types.ts`. The area ops extend the `areas.` family already there rather
than adding an `area.` one; `areas.set` and `areas.rename` stay exactly as they are.

    { op: 'plan.hand';    plan: PlanId; to: Actor; word?: string }
    { op: 'plan.goal';    plan: PlanId; goal: string | null }
    { op: 'goal.rename';  from: string; to: string }
    { op: 'goal.remove';  goal: string }
    { op: 'areas.add';    area: string }
    { op: 'areas.remove'; area: string }
    { op: 'areas.move';   area: string; to: number }   // the index it ends at

`Plan` gains `goal: string | null`, `ownerSince: string` and `ownerFrom: Actor | null`. `planShaped` is
`op.startsWith('plan.')`, so `goal.rename` and `goal.remove` are added to it by name (only members write them)
and to the `plans` scope in `restore.ts`; the three area ops join `validateSettings` and the `settings` scope.
None is in `CLAUDE_MAY` or `REQUIRES_WHY`. `plan.create` and `plan.ask.accept` set the owner fields too, so
old logs replay. The takeover in `member.remove` sets `ownerSince` to that event's time and `ownerFrom` to the
removed member's account: the card reads "since Mon 9 Nov · from casey", the name as plain text, and
`restore.ts` allows a non-member there, as it does for an account once asked.

### Replay

- **`plan.hand`.** Refused unless the plan is live; "only the owner, alex, can hand on Fix the fence gate";
  "Fix the fence gate is already bob's"; "casey is not in this household"; "Kitchen refresh is a shelf; its
  plans have owners, it does not"; a word over 300 characters. Then `owner` becomes `to`, `ownerSince` the
  event's time, `ownerFrom` the old owner, and an open ask is closed through `lapseAsk`, retiring its card.
  State, the Doing clock and the calendar links are untouched: a plan's events are coloured by the calendar
  they sit on, never by owner (`calendar-view.ts`), so nothing there changes.
- **A goal's label** is trimmed, its inner runs of space made one, and is 1 to 60 characters
  (`PLAN_LIMITS.goal`). Two labels are the same goal when they match ignoring case. The goals that exist are
  the labels on live plans, in any state: nothing is stored but `Plan.goal`.
- **`plan.goal`.** Refused on a removed plan and on a shelf ("…its plans carry goals, it does not"). Allowed
  in any state, done included. A label that matches an existing goal takes that goal's spelling. The same goal
  again, or null on a plan with none, changes nothing and is not refused.
- **A shelf carries no goal.** When a plan carrying a goal gains its first live plan (`plan.create` with that
  `parent`, by any door), the fold gives the goal to the new plan and clears it on the parent: a goal never
  drops out of the list or returns by itself, and `goal.rename` and `goal.remove` never meet a shelf. A
  shelf's owner and state stay as today: stored, not shown, and back if it empties.
- **`goal.rename`, `goal.remove`.** Both are refused when no goal matches ("there is no goal called New
  roof"). Rename is also refused when `to` is exactly `from`, or matches another goal: "Summer trip" is
  already a goal. No merge; a change of case alone is a rename. Each acts on every live plan carrying it.
- **`areas.add`.** The name rule of `areas.set`, at most 60 characters; "Garden" is already an area.
- **`areas.remove`.** "there is no area called Garden"; "keep at least one area"; and, while any plan that is
  not removed sits in it, in any state: "House" still has plans in it. `areas.set` already enforces this, so
  done plans block removal today; removed plans are history and do not.
- **`areas.move`.** `to` is a whole number within the list; the area's present place changes nothing.

### Reading

`board()` in `api/src/plans.ts` changes signature and shape, and `GET /api/plans` returns it whole:

    board(state, events, { who: Actor | 'everyone'; goal?: string | null; today; tz })
    GET /api/plans?who=<member>|everyone&goal=<label>
    { who, goal, areas: string[],
      rows: [{ area, all: { plans, doing, done },
               shelves: [{ id, title, holds, doing, done, owners: Actor[] }],
               plans: BoardCard[], done: BoardCard[] }],
      members: [{ member, plans }], goals: [{ goal, plans, done }] }

- A plan is counted and listed only if it is live and not a shelf. `plans` holds the open ones in view (Doing
  first, then the log's order), `done` the finished ones in view, newest first; both include plans on shelves.
  `all` and each shelf's figures ignore both filters. `owners` are the owners of its open plans.
- `board()` is strict: `who: <member>` returns only what that member owns, even when that is nothing, and an
  open ask no longer puts a plan in the asked member's view. Only the route retries as everyone when the
  member has nothing in view, and says so with `who: 'everyone'`. With no `who`, the route means everyone.
- `goal=<label>` keeps plans carrying it; the answer's `goal` is the stored spelling, or null if none exists.
- `members`: each member's cards in view (open; under a goal, done too), ignoring `who`, members with none
  left out. `goals`: every goal, alphabetical, `plans` in any state and `done` of those, unfiltered.
- `BoardCard` gains `goal`, `shelf` (its shelf's title, or null) and `doneAt` (`stateAt` when done). It keeps
  `asked`, which the briefing still reads. `planning`, `doing` and `showDone` are gone.
- `GET /api/plans/:id` gains the three `Plan` fields and `goals`, the same list.

Other callers: `plansRail` and `list_plans` call `board()` strictly; a member who owns nothing gets an empty
rail. `plansBlock` asks for everyone. The Calendar's picker calls the route bare and reads `rows[].plans`.

### Routes and tools

- `POST /api/plans` takes `owner?` and `goal?` beside `title`, `area`, `parent?`. It appends `plan.create`,
  then `plan.hand` when `owner` is another member, then `plan.goal`, in one write: all or nothing.
- `POST /api/plans/:id/hand { to, word? }` and `POST /api/plans/:id/goal { goal }` answer `{ plan }`.
- `POST /api/goals/rename { from, to }` and `POST /api/goals/remove { goal }` answer `{ plans }`, how many.
- `POST /api/settings/areas/add { area }`, `…/remove { area }`, `…/move { area, to }` answer `{ areas }`.
- Each reads its body through `plan-rules.ts` and answers a fold refusal as a 400 in the fold's words.
- A `who` that is present and neither a member nor `everyone` is a 400. `filter` or `showDone` in the query is
  a 400: "This screen is from an older version. Reload the page." `POST /api/plans/:id/ask-to-take` answers
  410: "Asking is gone. Reload, then hand it from the card." `POST /api/plans/:id/answer` stays for open asks.

`ask_to_take` is removed and `hand_plan { plan, to, word? }` takes its place: a proposal ("Hand Fix the fence
gate to bob"). No card is visible to its owner alone (`visibleTo` covers private `propose_event` cards only),
so it is seen like any other, and approving it as anyone but the owner is refused in the fold's words.
`set_plan_goal { plan, goal }` is new, a proposal too. `list_plans` takes `who` and `goal` in place of
`filter` and `showDone`. `answer_ask` stays registered: cards in the log name it. `decide()` in `offers.ts`
refuses to approve a card whose events hold a `plan.ask` (409: "Nobody is asked to take a plan any more. Hand
it from its card."), so such a card can only be declined.

### The thread, old events and old clients

`plan.hand` joins `PLAN_LINES` in `thread.ts`, so it is a `change` entry: `what` from `describe()` is "handed
Fix the fence gate to bob", `why` is the word or null, and the entry carries `hand: { plan, to }`, the plan as
`{ id, title }`, for the Today spec's notice. The current Today already draws it as one line, "**alex** handed
Fix the fence gate to bob", with the word in quotes under it, and a lapsed ask as "The ask to bob lapsed", so
Today needs no change for 0.7.0. `PLAN_LINES` decides which plan-shaped ops are lines, so `goal.rename` and
`goal.remove` are added there too, or they stay quiet; `areas.add` and `areas.remove` are not plan-shaped and
are lines already. `plan.goal` stays on the card's History, like chips. `areas.move` writes no line.

The fold still accepts `plan.ask`, `plan.ask.accept` and `plan.ask.decline`, so old logs and backups replay;
what closes is every door that wrote a new `plan.ask`. An ask open at the upgrade keeps its card on Today with
Take it and Decline, and `plan.hand` on that plan settles it. `restore.ts` names an account a plan was handed
to that is not a member, as it does for one asked. `areas.set` and its route stay for old logs and restores;
the page no longer calls it. A tab left open on the old page is told to reload by the two refusals above.

## What is deleted

- **Page script:** `planFilter`, `planShowDone`, `LANES`, `laneLabel`, `renderBoard`, `boardCard`, the "asked"
  chip in `planChips`, `newPlan` and `#plan-form`, the card's "Waiting for you" block and "Ask … to take it"
  button, `betweenSection`'s `theirs`, and Plan's two uses of `otherMember` (it stays for the Calendar's
  callers). In Settings: `areasItem`, `areasForm`, `areaCounts` and the `/api/plans?showDone=1` read in
  `loadSettings`. `askAnswer` and `askCardNode` are kept on purpose: Today's ask card uses them.
- **Markup:** `#plan-filters` with Both, Mine, Theirs and Show done; the New plan button; `#plan-empty`.
- **CSS:** `.board`, `.board-head`, `.lane`, `.lane-label`, `.lane-empty`, `.area-head`, `.bcard` and its
  variants, `.shelf`, `.chip.asked`, `.ask-line`, once nothing uses them. `.provisional` stays (Today).
- **Server:** `askToTake`, `recordAsk` and `raiseAskCards` in `plan-edits.ts` and their calls in `server.ts`,
  `offers.ts` and `tools.ts`; the `askToTake` tool; `filter` and `showDone` everywhere.
- **Copy:** "Both", "Mine", "Theirs", "Show done", "New plan", "the two of you", "Nothing in Doing in …", "the
  clock runs", "no clock", "Ask … to take it", and Settings' "The rows of the Plan board."

## Copy rules

As on the envelope pages: sentences, no exclamation marks, placeholders that are examples. A count is a number
and a noun ("3 done", "holds 3", "2 of 5 plans"), singular at one, never summed up in a word ("both", "all").
A goal is "toward", never "for" or "under". Handing is "hand it to", never "assign" or "ask". Members are
named as the app names them elsewhere; "you" and "yours" only in sentences, never in the people bar.

## Accessibility and the phone

Every row, heading link, chip and bar button is a real button or link, 44px tall or more. A plan row's name is
its title, state, owner and due day in words. The people bar and the goal row are groups of `aria-pressed`
buttons; radio lists are real radio groups; live and status lines are `aria-live="polite"`. Every form has its
error slot rendered from the start, its secondary button first and its primary at the right. The state glyphs
differ in shape, not only colour. Focus is managed on every transition. At 375 × 812 nothing scrolls sideways
but the two bars, and the first field of a form that opens is in the top half of the viewport.

## Left to the builder

- Exact CSS within `tokens.css`; the mock's 56px rows, 22px glyphs and 18px discs are a guide. Desk columns.
- Whether the Area page and the envelope page share a frame helper, and which form helper the card uses.
- How `areas.move` is kept out of the thread, and the words of the new lines in the thread and in History.
- Tests, in the shape of `api/test/plans.test.ts` and `server-plans.test.ts`.

## Calls I made (the owner to check)

1. **Only a plan's owner hands it on**: I read the ruling's "(any member)" as "whoever owns it". The
   alternative is that any member may change the owner, as any member may already finish or remove any plan.
2. **Three or more members already work on the server** (`members` is a set, `member.add` has no limit). Only
   the `theirs` filter and the page's `otherMember` assumed two; the Calendar's uses are its spec's.
3. **A plan made under a pressed person is a create and a hand in one write**, not a new field on
   `plan.create`: the card can say who made it, and the new owner gets the same line in Today as any hand.
4. **Old asks are answered on Today only.** No "asked" chip, no dashed row; the card says one quiet line. An
   asked plan no longer counts as the asked member's.
5. **Renaming a goal onto another goal is refused, not merged**: a merge cannot be undone. Removal is read
   back by the page from counts it already has; it is not a server proposal and asks for no reason.
6. **Under a goal every count includes done plans** (head, area, people bar), since a goal's plans are counted
   in any state. Without a goal, counts are open plans and done has its own row.
7. **Areas leave Settings entirely.** No row, no pointer. Create is on the board; the rest is on the page.
8. **Three new `areas.` ops, not `areas.set` for everything** (a whole-list replace from two members at once
   loses a change), and no `GET /api/areas/:area`: the Area page reads the unfiltered board.
9. **Shelves are made from a card's foot**, since the New plan form that made them is gone. A shelf row opens
   the Area page, not the shelf's card. `plan.hand` and `plan.goal` are refused on a shelf.
10. **Smaller ones.** Handing changes nothing on the calendar: the code colours by calendar, not owner. The
    card's Back returns to where it was opened from. Its When is not redrawn. An area with nothing in view is
    hidden under a filter. A goal keeps its first spelling.
11. **Only the route falls back to everyone; `board()` is strict** (orchestrator's call).
12. **`GET /api/plans` with no `who` means everyone** (orchestrator's call), for the Calendar's picker.
13. **A shelf carries no goal: the fold moves it to the first plan put on it** (orchestrator's call).
14. **A member's removal stamps `ownerSince` and `ownerFrom`** (orchestrator's call), the name as plain text.

## Mockup

The boards are on the owner's private canvas "Plan, by area" (claude.ai artifact `PptFxVnUdiUHbW3T3JoN9T`):
Board, ByPerson, ByGoal, GoalDone, GoalRemove, Area, NewArea, EmptyArea, Card, Goal, Desk. The words above are
the contract. Where a board disagrees, it predates a ruling or a rule here and is wrong:

- Board, Area, Desk: the "asked …" chip. ByPerson: the dashed "yours, asked of …" row, and that plan counted
  under the member asked (4 where owning gives 3; the bar's 5 + 4 + 4 against "12 plans").
- ByGoal, GoalRemove: the pressed chip moved to the front; the second member's count omits a done plan.
- GoalDone, Goal: "2 plans, both done", "1 toward it · done". GoalRemove: the areas in the read-back.
- Every board: a goal's label shortened on a row; it is shown whole. Area: Done is not newest first.
- Card, Goal: Back fixed to the area; "Anyone can hand it on again"; "handed by you just now · it was yours
  since …"; the When line; the done note, which is cut to "Bob has it."
- NOTES.md: `area.create` and its siblings, `GET /api/areas/:area`, `#plan/<id>` and owner-coloured events.
