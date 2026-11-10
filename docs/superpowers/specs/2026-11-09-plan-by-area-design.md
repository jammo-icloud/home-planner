# The Plan page, by area

**Status:** design, for review. Agreed with the owner on 2026-11-09.

## Intent

The Plan board is a grid drawn for two people at a desk: areas down the side, Planning and Doing across. On a
phone each area becomes two labelled lists, and every empty one says "Nothing in Doing in House." The filter
reads Both, Mine, Theirs, which stops meaning anything the day a third member joins. Giving a plan to someone
takes an ask, a card on their Today and an answer. Areas are edited in Settings, a screen away from the board
they shape. Finished plans come back only through a global Show done. And nothing says what a plan is for.

The owner liked the envelope pages of 0.6.0: plain rows, each opening its own page, adding as the last row.
This release, 0.7.0, the first of three, gives Plan that shape: an area is a heading that opens a page, its
plans are rows in one card, and a row carries its state as a glyph, so the two columns go.

On goals the owner's model replaced the designer's: "I can finish all plans and the goal may not yet be
complete… the unknown unknowns travel beyond the last open plan." On figures: "I don't want us to keep trying
to curate bespoke labels and data lines." On grouping: "retire shelves, goals do that job." The words are now
Area, Plan, Goal and the checklist in a plan, superseding the 2026-10-28 Home Planner spec on shelves.

## Goals

- The board is one card of rows per area, in the household's order. No columns. State is a glyph on the row.
- An area's name opens the Area page, where it is renamed, moved and removed, and where its Done lives.
- A people bar replaces Both / Mine / Theirs and works for any number of members.
- "Hand it to" replaces ask-to-take: any member gives a plan away or takes one, at once, a word optional.
- A plan may carry one goal. Goals filter the board, begin by use, and end only when removed.
- Shelves are retired: a former shelf is an ordinary plan, and it and the plans that sat on it carry a goal
  named after it. The accepted cost: one goal a plan, so none is in "Kitchen refresh" and toward another.

## Non-goals

- The card below its head stays as it is, Due date and Block time too. The mock's When line is not built.
- No drag, no area icons, no per-member colours, no list of goals, nothing about goals in Settings, no goal on
  a plan's page in Drive, no Claude tools for goal names or areas.
- No URL for a page and no wiring of the browser's Back. Deep links stay function calls, as they are today.
- Today and Calendar are not redrawn here. What they show in the meantime is said under "The thread".

## Anti-goals

- A count the reader cannot reproduce by counting rows on the same screen.
- A goal drawn as finished, ticked, struck or greyed because its plans are done.
- A third member shown as "Theirs", sharing a filter with someone else, or missing from Hand it to.
- A plan changing hands with no line in Today saying who moved it, from whom, to whom and why.
- A plan added under a filter that does not appear in that view. An area removed from under a done plan.
- An old ask with no way to answer it. A new ask by any door.

## The board

`#plan` holds, top to bottom: the head, the people bar, the goal row, the areas, one quiet line, and either
the last card or the goal's foot. All of it is drawn from one `GET /api/plans` (shape under "Reading"). The
carry-over ledger (`docs/superpowers/design/2026-11-10-carry-over-ledger.md`) lists what today's screen shows:
every Kept and Changed row of its Plan section is drawn by this release, and a row is deleted only where this
spec says so. The shared loading line and error box stay above the board, the Area page and the card.

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
yet.", or "Nothing of Bob's toward this goal in People or Trips." An area's `.list` holds, in order:

1. **Plan rows**, Doing before Planning, each in the log's order. A row is a button: the state glyph, the
   title, a meta line, a chevron; a Doing row an accent rail. Meta, in order: the owner's disc; its chips; the
   clock ("2 wks", from 14 days in Doing, `daysInState`); the due day; blocks; "research"; the envelope ("$
   Groceries · $40 left", `envelope.left`, the problem colour below zero); the goal flag (not under it).
2. **The add row.** "A new plan in House"; with another member pressed, "…, for Bob"; with a goal pressed, "…,
   toward this goal"; with both, "A new plan in House, for Bob, toward this goal". It opens a form where the
   row was: the field "The new plan" (placeholder "e.g. Fix the fence gate", 200 characters), one line saying
   what the filter adds ("It will be Bob's, toward New roof.", or either half), the error slot, Cancel and
   **Add it**. An empty name says "Give it a name". Adding returns focus to the add row.
3. **The done row**, when `row.done` has any: sunken, a green check, "3 done" ("1 done toward this goal" under
   a goal), a chevron. It opens the Area page with Done open and focused. Under a goal, an area with no open
   plan toward it draws its done plans as rows instead (title softened, "done Mon 12 Oct" from `doneAt`).

**The last card** (no goal pressed): "A new area". It opens in place: "The new area" (placeholder "e.g.
Garden", 60 characters), the hint "It joins the board at the bottom. Rename it, move it or remove it from its
own page.", Cancel and **Add it**. Adding opens its page, saying "Garden is on the board, under Trips."

**On the desk** (the page container at 1040px) the areas are columns that wrap, each the same card, "A new
area" a solid column at the end. The add row may read "A new plan" there, its accessible name whole.

## The people bar and the shared helpers

Written once, in the shared region above the screens, each at one size; Today and Calendar call them by name.

- `memberDisc(name)` replaces `whoDisc` at every caller (Today's rail and Between us too): the member's
  initial, solid for you, a ring for every other member, no third colour; two others whose initials match show
  two letters. `.who` at `--disc`, `.who.sm` at `--disc-small`; the ring is `.who.other`, with `.partner` its
  alias until the Calendar moves. `title` and the accessible name are the member's name.
- `stateGlyph(state)`: a dashed circle (Lucide `circle-dashed`) in `--state-planning`; a half-filled circle in
  `--state-doing`; Lucide `circle-check` in `--state-done`. One `.st` rule: `--disc` in a row's leading slot,
  `--disc-small` beside a word; on a calendar box it takes the box's ink. Its words "Planning", "Doing",
  "Done" live with it: the card's state buttons (`LANES` is gone) and its accessible name.
- `goalFlag(label)`: Lucide `flag` at 12px and the goal's whole label, on one line, cut with an ellipsis.
- `peopleBar(host, { label, people, pressed, onPress })`: a `.seg.people` group named by `label`, `--control`
  high, a 44px hit area. "Everyone" first, then a button per entry of `people` (`{ key, label, n }`), you
  first, then the household's order, the count after the name in `.n`. It scrolls sideways.

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
flag, alphabetical, in one row that scrolls to the pressed chip. The chips are `.filters button`s: the pressed
one is the ink-filled pill, never a tint. The pressed goal (`planGoal`) is Plan's own, not shared.

With a goal pressed, the foot of the board holds "Rename this goal", "Remove this goal" and one line: "Both
act on all 4 plans that carry it, done ones included." (the last three words only when `done` is not 0;
figures from that goal's entry in `goals`). Each opens where the buttons were.

- **Rename.** "Call it", prefilled, 60 characters; the hint "The new name goes on all 4 plans that carry it.";
  the error slot; Cancel and **Rename it on 4 plans**. The board reloads pressed on the new name.
- **Remove.** Solid (`.ep-review`): "This will", "Take **New roof** off 4 plans, 1 of them done", "Leave the
  plans as they are", and small: "The goal ends here: it leaves the filter row. Putting the same words on a
  plan later starts it again." Cancel and **Remove the goal**. Then All goals, and "New roof is off 4 plans."

## The Area page

Drawn in `#plan` with the board hidden, as an envelope's page is drawn in `#budget`. It always shows the whole
area, whatever is pressed on the board, from an unfiltered `GET /api/plans`. Top to bottom:

1. **Head.** `‹ Plan`, the area's name as the `h1`, and one line: "5 plans · 2 doing · 3 done · first on the
   board", from `row.all` and the area's place in `areas` ("first", "last" or "2 of 4"; left off with one
   area). An empty area reads "Nothing planned yet · last on the board".
2. **A slot** for the rename form and a status line, so the form opens at the top with focus in it.
3. **Plans.** The area's open plans, then "A new plan in House".
4. **Done · 3.** Folded, with Show / Hide; open when the page was reached from a done row. Rows newest first
   by `doneAt`: the done glyph, the title softened, the owner's disc, "done Tue 3 Nov", the goal flag.
5. **Foot.** "Rename this area", "Move up", "Move down", "Remove this area", then one line. An impossible move
   is not offered. Rename opens in the slot: "Call it", prefilled, the hint "Its plans go with it.", Cancel
   and **Rename it**; an unchanged name closes without a write. A move redraws and says "House is now 2 of 4."
   Remove is live only when the area holds nothing ("Nothing is in it, so removing it loses nothing."); it
   removes at once and returns to the board, focus on "A new area". Otherwise it is `aria-disabled` under
   "House holds 8 plans, 3 of them done. An area is removed once it holds nothing." (open plus done, from
   `row.all`; no middle clause at 0 done). The last area: "A household keeps at least one area."

## The plan's card

`#plan-card` keeps its sections. What changes:

- **Head.** The Back button says where it returns ("‹ Plan", "‹ House", "‹ Today", "‹ Calendar"). The crumb
  reads Plan › House: Plan is the board, the area is its page. The state segment's two buttons carry their
  glyphs; Mark done carries the check. "Ask Bob to take it" goes. As now: the title renames in place; a
  finished plan shows a "Done" chip in Mark done's place and either state button opens it again; the chips row
  sits under the state row, each chip with its ×, "Add a chip", and "2 wks" from 14 days in Doing.
- **Owner**, a section above Notes. One line: "You own it" or "Bob owns it", over "since Wed 21 Oct · you made
  it", "… · Alex made it" or "since Mon 9 Nov · from Alex" (`ownerSince`, `createdBy`, `ownerFrom`). Every
  member sees **Change**: "Who owns it?", a radio list of every member with the owner checked, a live line, a
  word (300 characters, placeholder "Why them, or what to know first", sent as `why`), Cancel and the primary,
  `aria-disabled` while the owner is still picked ("It stays yours; nothing moves.", or "It stays Bob's; …").
  Giving away your own: "It becomes Bob's at once and shows in Today. Bob can hand it back.", "A word for Bob
  (optional)", **Hand it to Bob**, then the status "Bob has it." Taking someone else's: "It becomes yours at
  once and shows in Today.", "A word about why (optional)", **Take it**, "It is yours." Moving one between two
  others: "It becomes Casey's at once and shows in Today.", "A word for Casey (optional)", **Hand it to
  Casey**, "Casey has it." While an ask from before 0.7.0 is open, a quiet line sits under it: "Bob was asked
  to take it on Mon 2 Nov. It is answered on Today; handing it to anyone settles it."
- **Goal**, a section under Owner. One line: "No goal" over "this plan stands on its own", with **Set a
  goal**; or the flag and label over "one of 4 plans toward it · 1 done" ("the only plan toward it" at 1),
  with **Change**; figures from the card's `goals`. The form asks "What is it toward?" and picks before it
  types: "No goal"; each goal in use with "4 plans · 1 done"; then "A new goal…", which shows the field "Call
  it" (60 characters, placeholder "e.g. New roof"). One live line: "It stays toward New roof." / "It moves to
  Summer trip. New roof keeps 3 other plans." / "It comes off New roof, which keeps 3 other plans." / "New
  roof ends here: no other plan carries it." / "A goal begins when a plan carries it. This plan will be its
  first." / "Summer trip is already a goal; this plan joins it." Cancel and **Save**; no change, no write.
- **Between us** asks "Leave a note about this" and its note reads "Also in Today". "On this shelf" goes.
  Owner and Goal are `.ep-line`s; a radio list is a `.check` variant, filled when checked.

## Pages: Back, Escape, focus, deep links

The mechanism is the envelope pages': page state in a module variable, an opener, a document Escape listener
while open, every async continuation guarded. `areaPage = { area, boardScroll, from }`, `openArea(area, {
linked, focus })`, `closeArea()`, `areaEscape`, `clearAreaPage()` (called where `clearEnvelopePage()` is).

- Opening a page scrolls the window to the top once and focuses the heading, or the first field when it opens
  on a form, with `preventScroll`. `focus` may name `done`.
- Back, and Escape with nothing open, return to where the page was opened from: the board and the Area page at
  the scroll they were left at, focus on what opened it; "‹ Today" and "‹ Calendar" to the screen as it opens,
  until their specs do better. Removing a plan returns the same way, to the area's heading.
- Escape first cancels an open form, and does nothing while a sheet, a menu or the search box has it. The
  card's small forms (due, block, remove, money, contact search, a chip, a step, a file's reason) close
  themselves today with no mark: each gains `[data-cancel]`, so one Escape closes it and the next goes Back.
- A committed change redraws the page from a fresh read and never goes Back by itself, except a removal.
  `reloadView()` learns the Area page (with `areaPage` set it redraws the page, not the hidden board). A
  rename answers the Settings view, so `areaPage.area` takes the new name before the redraw. A form's refusal
  goes in its own slot, a failed read or section write in the shared box, never both.
- The card records where it was opened from (`cardFrom`: the view, the area page if any, the scroll, the row)
  unless it is opened from another card. Back and Escape return there.
- **Deep links** are two functions: `openCard(plan)`, as today, and `openArea(area)`. So opened (`linked`),
  Back returns to the caller. A plan that is gone is a 404 in the error box; an unknown area opens the board.

## The server

### Ops

Eight are added to `Event` in `api/src/types.ts`. The area ops extend the `areas.` family already there rather
than adding an `area.` one; `areas.set` and `areas.rename` stay exactly as they are.

    { op: 'plan.hand';    plan: PlanId; to: Actor; why?: string }
    { op: 'plan.goal';    plan: PlanId; goal: string | null }
    { op: 'goal.rename';  from: string; to: string }
    { op: 'goal.remove';  goal: string }
    { op: 'areas.add';    area: string }
    { op: 'areas.remove'; area: string }
    { op: 'areas.move';   area: string; to: number }   // the index it ends at
    { op: 'shelves.retire' }                              // written by the app, never by a member

`Plan` gains `goal: string | null`, `ownerSince: string` and `ownerFrom: Actor | null`. `planShaped` is
`op.startsWith('plan.')`, so `goal.rename` and `goal.remove` are added to it by name and to the `plans` scope
in `restore.ts`; the area ops join `validateSettings` and the `settings` scope. `shelves.retire` is `system`'s
alone, in the `plans` scope, not plan-shaped. None is in `CLAUDE_MAY` or `REQUIRES_WHY`. `plan.create` and
`plan.ask.accept` set the owner fields too. The takeover in `member.remove` sets `ownerSince` to that event's
time and `ownerFrom` to the removed account: the card reads "… · from casey", plain text; `ownerFrom` is the
fold's own, so nothing checks it. `state.hands` joins `Draft`, `emptyDraft`, `freeze` and `thaw`.
`old-log.test.ts` lets nested new fields through with stated defaults, snapshot untouched.

### Replay

- **`plan.hand`.** Sent by any member, for any live plan; a member may hand a plan to themselves when someone
  else owns it. Refused: "Fix the fence gate is already bob's"; "casey is not in this household"; a `why` over
  300 characters. The reason is `why`, optional, because `decide()`, `describe()` and the thread all read that
  name. `owner` becomes `to`, `ownerSince` the event's time, `ownerFrom` the previous owner, whoever sent it,
  and an open ask is closed through `lapseAsk`. The fold also keeps each hand's previous owner (`state.hands`,
  keyed by event as drifts are); the event does not carry it. State, the Doing clock and the calendar links
  are untouched: a plan's events are coloured by the calendar they sit on, never by owner.
- **A goal's label** is trimmed, inner spaces made one, 1 to 60 characters (`PLAN_LIMITS.goal`). Labels that
  match ignoring case are one goal. The goals that exist are the labels on live plans, in any state.
- **`plan.goal`.** Refused on a removed plan. Allowed in any state. A label that matches an existing goal
  takes that goal's spelling. The same goal again, or null on a plan with none, is a quiet no-op.
- **Shelves, in old events.** The fold still takes `plan.create` with a `parent` naming a live plan, and still
  moves the plans under a plan when its area changes, so old logs replay as they did. Its other shelf rules
  were all refusals (two levels, an item's area, a shelf's state, removing a full one) and go.
- **`shelves.retire`.** Only from `system`. For each live plan with live plans under it, in the log's order:
  the label is its title as it stands then, by the goal rule, cut to its first 60 characters; a goal that
  already matches gives its spelling. That plan and each live plan under it take the goal unless they carry
  one. Then every live plan's `parent` becomes null: no shelf is left, and each page in Drive is written again
  with `parent:` empty (the event joins what `markPages` watches). A former shelf keeps the state and owner
  the log gave it. Goal ops written afterwards are later in the log, so they win on every replay.
  `retireShelves(store)` appends it whenever the log holds a live plan with a `parent`: after each of the four
  loads (`open`, `create`, `createFromLog` in `households.ts`; the sandbox's in `server.ts`) and after a
  restore's adopt, so before any request. It is the one write no member asked for, so it first copies the log
  to `<log>.before-0.7.0` (`copyFile`, `COPYFILE_EXCL`: never overwritten); if either fails, the open fails
  loudly. An older build cannot open a log holding an op it does not know: going back is that file put back.
- **`goal.rename`, `goal.remove`.** Both are refused when no goal matches ("there is no goal called New
  roof"). Rename is also refused when `to` is exactly the spelling the goal is stored in (whatever case `from` was typed in), or matches another goal: "Summer trip" is
  already a goal. No merge; a change of case alone is a rename. Each acts on every live plan carrying it.
- **`areas.add`, `areas.remove`, `areas.move`.** A name follows the rule of `areas.set`, at most 60
  characters. Each changes nothing when already true (an add of an area that is there, ignoring case; a remove
  of one that is not; a move to where it stands, `to` held within the list), so a household's own backup
  replays; the routes refuse those first: "Garden" is already an area; "there is no area called Garden". The
  fold refuses a remove that leaves none ("keep at least one area") or, while any plan that is not removed
  sits in the area, in any state: "House" still has plans in it. `areas.set` already does.

### Reading

`board()` in `api/src/plans.ts` changes signature and shape, and `GET /api/plans` returns it whole:

    board(state, events, { who: Actor | 'everyone'; goal?: string | null; today; tz })
    GET /api/plans?who=<member>|everyone&goal=<label>
    { who, goal, areas: string[],
      rows: [{ area, all: { plans, doing, done },
               plans: BoardCard[], done: BoardCard[] }],
      members: [{ member, plans }], goals: [{ goal, plans, done }] }

- Every live plan is counted and listed. `plans` holds the open ones in view (Doing first, then the log's
  order), `done` the finished ones in view, newest first. `all` ignores both filters.
- `board()` is strict: `who: <member>` returns only what that member owns, even when that is nothing, and an
  open ask no longer puts a plan in the asked member's view. Only the route retries as everyone when the
  member has nothing in view, and says so with `who: 'everyone'`. With no `who`, the route means everyone.
- `goal=<label>` keeps plans carrying it; the answer's `goal` is the stored spelling, or null if none exists.
- `members`: each member's cards in view (open; under a goal, done too), ignoring `who`, members with none
  left out. `goals`: every goal, alphabetical, `plans` in any state and `done` of those, unfiltered.
- `BoardCard` gains `goal` and `doneAt` (`stateAt` when done) and loses `parent`. It keeps `asked`, which the
  briefing still reads. `shelves`, `planning`, `doing` and `showDone` are gone.
- `GET /api/plans/:id` gains the three `Plan` fields and `goals`. `shelf` is always null and `children` always
  empty, kept for this one release so a 0.6.0 tab's card still draws, and gone in the next.

Other callers: `plansRail` and `list_plans` call `board()` strictly; a member who owns nothing gets an empty
rail. `plansBlock` asks for everyone. The Calendar's picker calls the route bare and reads `rows[].plans`.

### Routes and tools

- `POST /api/plans` takes `owner?` and `goal?` too, appending `plan.create`, `plan.hand` for another `owner`
  and `plan.goal` in one write. `parent` is a 400: "Plans no longer sit on shelves. Give it a goal instead."
- `POST /api/plans/:id/hand { to, why? }` and `POST /api/plans/:id/goal { goal }` answer `{ plan }`.
- `POST /api/goals/rename { from, to }` and `POST /api/goals/remove { goal }` answer `{ plans }`, how many.
- `POST /api/settings/areas/add { area }`, `…/remove { area }`, `…/move { area, to }` answer `{ areas }`.
- Each reads its body through `plan-rules.ts` and answers a fold refusal as a 400 in the fold's words.
- A `who` that is present and neither a member nor `everyone` is a 400. `filter` or `showDone` in the query is
  a 400 and `POST /api/plans/:id/ask-to-take` a 410, in the stale page's words (below), for 0.6.0 tabs.

`ask_to_take` is removed and `hand_plan { plan, to, why? }` takes its place (in `RESEARCH_WRITES` too, where
`set_plan_goal` joins it), a proposal any member may approve. Its summary names both ends ("Hand Fix the fence
gate from alex to bob"), because an approval's effect is hidden as already said by its card. `set_plan_goal {
plan, goal }` is new. `list_plans` takes `who` and `goal` in place of `filter` and `showDone`. `create_plan`
loses `parent`, and `update_plan`, `set_plan_state` and `remove_plan` lose their shelf checks. `answer_ask`
stays registered: cards in the log name it. `decide()` in `offers.ts` refuses to approve a card whose events
hold a `plan.ask` (409: "Nobody is asked to take a plan any more. Hand it from its card.") or a `parent` (409,
the route's words), so it can only be declined; working it out again answers the same.

### The thread, old logs, restore and stale pages

`plan.hand` joins `PLAN_LINES` in `thread.ts`, so it is a `change` entry: `why` is the reason or null, and
`what` from `describe()`, which reads `state.hands`, names everyone involved: "handed Fix the fence gate to
bob" when the sender owned it, "took Fix the fence gate from bob" when the sender is the new owner, "handed
Fix the fence gate from bob to casey" otherwise. The entry carries `hand: { plan: PlanRef, from, to }` for the
Today spec's notice. The current Today draws it as one line with the reason quoted under it, and a lapsed ask
as "The ask to bob lapsed". `goal.rename` and `goal.remove` join `PLAN_LINES` too, or they stay quiet;
`areas.add` and `areas.remove` are lines already. `areas.move` and `shelves.retire` would be lines by default,
so both join `NOT_A_CHANGE` in `activity.ts`. `plan.goal` stays on the card's History, like chips; a goal
renamed or removed for all, the retirement and a member's removal name no plan and are in no card's History.

**Old logs.** The fold still accepts `plan.ask`, `plan.ask.accept` and `plan.ask.decline`; what closes is
every door that wrote a new one. An ask open at the upgrade keeps its card on Today with Take it and Decline,
and `plan.hand` on that plan settles it. `areas.set` and its route stay for old logs and restores.

**Restore.** `restore.ts` learns the eight ops. It lets `system` through as the author of `shelves.retire`, so
the line restores in its place and later goal ops still win. Its area walk follows the three new area ops. It
names an account a plan was handed to that is not a member, as for one asked. A backup from before 0.7.0
restores with its shelves and the app retires them after the adopt. A backup holding an op this build does not
know is refused, never read as if the line were absent: `parseBackup` lists it ("line 12: unknown op
bill.set") and the preview says "This backup was made by a newer Home Planner. It holds bill.set, which this
version cannot read." A test backs up a log holding this release's ops and restores it into a fresh household
and into its own. (`createFromLog` already fails for any log with plans: not fixed here.)

**A stale page**, settled once for every later release. The page holds its build as a literal, `BUILD =
'0.7.0'`, and `api()` sends it as `x-hp-build`. Before any route runs, the server answers an `/api/` request
whose build is not its own with 409 `{ error: "Home Planner has been updated. Reload.", stale: true }`; a
request with no header passes (the guest page, scripts). `api()` shows the sentence in the shared error box
with one button, **Reload**. The stylesheet link is `/tokens.css?v=0.7.0`, so CSS is not served an hour stale
beside a page that is never cached. A 0.6.0 tab sends no build: the 400 and 410 above say the same.

**Claude's words for three.** `briefing.ts`: "NOTES THE TWO OF THEM LEFT EACH OTHER" becomes "NOTES THE
MEMBERS LEFT EACH OTHER", and "Both of them read it" becomes "Every member reads it". `conversation.ts`:
"Notes are between the two of them" becomes "Notes are between the members". The rest of the outline's list
that 0.7.0 owns is above. Not owned: Today's filters and "Waiting for either of you" (0.8.0), the Calendar's
partner calendars (0.9.0), and Today's rail (`sourceDisc`), wrong for three until its events carry an owner.

### Order and tests

The shared helpers move first, changing nothing else: `icon`, `lucide`, `whoDisc`, `chip`, `inlineForm`,
`members`, the household clock (`clockOf`, `keyAt`, `todayKey`, `addDayKey`, `keyWords`, `mondayOf`) and
`openTodayAt` go to one shared region above the screens, with the build check. Then ops, folds, restore and
write routes, behind the 0.6.0 page. Then `board()` and the card in the new shape, with the page that reads
them. Markup with a load-time listener (`#plan-filters`, `#plan-new`) goes with its listener.

`api/test/page-ledger.test.ts` is new, a text test of `site/index.html` written from the ledger's Plan
section: every id passed to `$()` at the script's top level is in the markup; Kept and Changed rows' words and
functions are present ("Mark done", "Add a chip", "Also in Today", `askAnswer(`, `openArea(`, `memberDisc(`);
names under "What is deleted" are absent (`planFilter`, `renderBoard`, `whoDisc(`, "Theirs"); every `/api/`
literal is a route `server.ts` answers; `BUILD` and the stylesheet's `?v=` equal `api/package.json`'s version.

## What is deleted

- **Page script:** `planFilter`, `planShowDone`, `LANES`, `laneLabel`, `renderBoard`, `boardCard`, the "asked"
  chip in `planChips`, `newPlan` and `#plan-form`, the card's "Waiting for you" block and "Ask … to take it"
  button, `betweenSection`'s `theirs`, and Plan's two uses of `otherMember` (it stays for the Calendar's
  callers). In Settings: `areasItem`, `areasForm`, `areaCounts` and the `/api/plans?showDone=1` read in
  `loadSettings`. `askAnswer` and `askCardNode` are kept on purpose: Today's ask card uses them.
- **Markup:** `#plan-filters` with Both, Mine, Theirs and Show done; the New plan button; `#plan-empty`.
- **CSS:** `.board`, `.board-head`, `.lane` and its two, `.area-head`, `.bcard` and its variants, `.shelf`,
  `.ask-line`, marked superseded in `components.css`. `.provisional` stays, and `.chip.asked` until 0.8.0.
- **Server:** `askToTake`, `recordAsk` and `raiseAskCards` in `plan-edits.ts` and their calls in `server.ts`,
  `offers.ts` and `tools.ts`; the `askToTake` tool; `filter` and `showDone` everywhere.
- **Shelves, page:** `ICONS.shelf`, `isShelf`, the crumb's shelf, "On this shelf", "Add an item", the buttons
  in `renderBoard`, "On a shelf" in `newPlan`, `.area > .shelf`, "holds", "The item", "Not on a shelf".
- **Shelves, server:** `shelfFor`, `liveChildren` and their uses; `hasLiveChildren` and 5 refusals; `shelves`,
  `shelfIds`, `BoardCard.parent` in `plans.ts`; shelf words in `conversation.ts` and the tools.
- **Copy:** "Both", "Mine", "Theirs", "Show done", "New plan", "the two of you", "the clock runs", "no clock".

## Copy rules

As on the envelope pages: sentences, no exclamation marks, example placeholders. A count is a number and a
noun ("3 done", "2 of 5 plans"), singular at one, never a word ("both", "all"). A goal is "toward", never
"for" or "under". Handing is "hand it to" and taking is "take it", never "assign" or "ask". Members are named
as the app names them elsewhere; "you" and "yours" only in sentences, never in the people bar.

## Visual rules

From the visual audit (`docs/superpowers/design/2026-11-10-visual-audit.md`), binding where it names Plan.

- **Extend what ships; never paste a wireframe stylesheet** (its class names collide). `.list` is the area
  card; `.erow.plan`, `.erow.add`, `.erow.fold` the rows, with a leading `--disc` slot; `.area-head` the
  heading; the `.ep-*` frame and `.back` the Area page; `.ep-line` Owner and Goal; `.ep-review` the read-back;
  `.seg` the bar; `.filters button` a goal chip; `.add-row` the desk's "A new area". New are `.st` and the
  meta marks, none named `.row`, `.rows`, `.line`, `.plan-head`, `.done`, `.money`, `.over` or `.quiet`.
- **Added to `site/tokens.css` now**: `--state-planning`, `--state-doing`, `--state-done`; `--src-other-fill`,
  `-line` and `-ink` (the `--src-partner-*` names stay as aliases); `--mark-fill`; `--hatch`;
  `--tracking-headline`, `--tracking-caps`; `--r-inner`; `--stroke-rail`; `--disc` (22px), `--disc-small`
  (18px); `--row` (56px); `--control` (36px). `design/tools/contrast.py` gains its pairs and runs clean.
- **Selected is never a tint alone**: a pressed chip is the ink-filled pill, a chosen item takes the ink ring
  the app already has. **Dashed means only** that a person still has to say yes, or a provisional date: the
  desk's "A new area" and the read-back are solid (the Planning glyph's dashes say "not begun" in small).
- **Every control has a 44px hit area** whatever its drawn height (one helper: the bar, chips, an area's
  heading, the done row, Back, the crumb, the foot). A row is `--row`, a compact control `--control`, a chip
  30px; `.btn` is `--fs-ui`, weight 500, `--tap` high on a phone. **No opacity on text**: a done row softens
  its title with `--ink-soft` only. Checked at 375 wide in Graphite, both modes, nothing reading by hue.

## Accessibility and the phone

Every row, heading link, chip and bar button is a real button or link. A plan row's name is its title, state,
owner and due day in words. The people bar and the goal row are groups of `aria-pressed` buttons; radio lists
are real radio groups; live and status lines are `aria-live="polite"`. At 375 × 812 nothing scrolls sideways
but the two bars, and the first field of a form that opens is in the top half of the viewport.

## Left to the builder

- Exact CSS within the tokens and rules above; the desk's column count; which helpers are shared.
- The new lines' words in the thread and History; the comment sweep; the audit's design-language edits.
- Tests, in the shape of `api/test/plans.test.ts` and `server-plans.test.ts`.

## Calls I made (the owner to check)

1. **Any member hands a plan on**, the owner's ruling of 2026-11-10: gives away, takes, or moves one.
2. **Three members already work on the server**: only `theirs`, `otherMember` and Claude's words assumed two.
3. **A plan made under a pressed person is a create and a hand in one write**, not a field on `plan.create`.
4. **Old asks are answered on Today only**: no "asked" chip or dashed row, one quiet line on the card.
5. **Renaming a goal onto another goal is refused, not merged.** Removal is read back by the page; no reason.
6. **Under a goal every count includes done plans** (head, area, people bar); without one, only open plans.
7. **Areas leave Settings entirely.** No row, no pointer. Create is on the board; the rest is on the page.
8. **Three new `areas.` ops, not `areas.set` for everything; no `GET /api/areas/:area`.**
9. **Shelves are retired by one event in the log**: the fold cannot tell an old shelf's move from a new one.
10. **Smaller.** The card's Back returns where it was opened (the screen only, for Today and the Calendar);
    its When is not redrawn. An empty area hides under a filter. A goal keeps its first spelling.
11. **Orchestrator's calls of 2026-11-09**: only the route falls back to everyone, `board()` is strict; `GET
    /api/plans` with no `who` means everyone; a member's removal stamps `ownerSince` and `ownerFrom`.
12. **The goal is the shelf's title as it stands at that event**, cut to 60; the former shelf carries it too.
13. **`parent` is refused at every door.** Drive pages keep an empty `parent:`; folders never nested by shelf.
14. **The README's note for 0.7.0**: "Shelves are gone. Each is now an ordinary plan, and it and the plans
    that sat on it carry a goal with its name: press that goal on Plan to see them together."
15. **Orchestrator's calls of 2026-11-10**: a hand's word is the op's `why`; `areas.move` and `shelves.retire`
    are quiet through `NOT_A_CHANGE`; a backup made after 0.7.0 restores; the log is copied before
    `shelves.retire`; stale pages, stale styles and unknown ops are settled once, here; Claude's two-member
    sentences are reworded; the shared helpers move first; a page ledger test is added.
16. **Mine within them.** The build is a literal the ledger test checks; a request with no build passes; the
    error box gains a Reload button; a backup with an unknown op is refused whole; the area ops change nothing
    when already true; a card's History omits goal ops made for all; `hand_plan` and `set_plan_goal` join
    `RESEARCH_WRITES`; the card's answer keeps an empty `shelf` and `children` for one release.

## Mockup

The boards are on the owner's private canvas "Plan, by area" (claude.ai artifact `PptFxVnUdiUHbW3T3JoN9T`).
The words above are the contract. Where a board disagrees, it predates a ruling or a rule here and is wrong:

- Board, Area, Desk: rows are not Doing first; a goal's label is shortened. Area: Done is not newest first.
- ByGoal, GoalDone, GoalRemove: the pressed chip moved to the front; their own words for "done ones included";
  a member's count omitting a done plan; "in House and Money"; GoalDone's "2 plans, both done".
- Goal, Card, EmptyArea: "both done", "so far", other live lines, a note after Save; Back fixed to the area;
  only the owner giving away; "Doing for 19 days"; a When line; a longer status.
- Against the Visual rules, every board: a pressed goal chip is a tint; most controls are under 44px; a done
  row's meta is at 80% opacity. Desk's "A new area" and GoalRemove's read-back are dashed.
- NOTES.md: `area.create` and its siblings, `GET /api/areas/:area`, `#plan/<id>`, goals read from `parent`.
