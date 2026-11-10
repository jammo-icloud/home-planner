# Today as day cards

Status: design, for review. Agreed with the owner on 2026-11-09.

## Intent

Today is the household's record and reads like a log. It opens at the bottom, a day is a grey heading, four
filters mix two questions (whose, and is it waiting), what waits hides behind a tray, and search is a second
box in the top bar. People open it to ask what happened today and what needs them, not to read a log.

This release (0.8.0, built on the Plan spec) makes the day the unit. A day is a card; the briefing opens it;
what happened sits inside as rows that read lane icon, who, what, when. Kinds and the people bar narrow every
day at once, and what waits on you is listed first and jumps to its buttons. The thread design of 2026-10-28
stands (the thread is the record, nothing waiting gets buried, a suggestion never looks like a decision), and
so does the Home Planner design's rule that the shared Today and a member's own layer never mix.

## Goals

- A day is one card. Today's is first and open; earlier days are closed below it, loaded a month at a time.
- Every row has one lane (`budget | calendar | plans | claude | notes`), server-set; a kind filter shows one.
- "Waiting on you" is a list above today's card; a row jumps to the card that holds the buttons.
- Two control rows: kinds, then the people bar from the Plan spec with the person the three tabs share.
- One search, in Today's head: the same day cards holding only matching rows, then "Elsewhere".

## Non-goals

- No change to how a card is offered, decided, worked out again or adjusted (`offers.ts`), to the write
  routes, to what Claude sees when asked, or to how and when the briefing is written.
- No new asks: the Plan spec's "Hand it to" replaced them. Today draws its notice and an old ask's card.
- No sectioned briefing, no editing or removing a row, no notifications, no count on the Today tab.
- No Calendar day page. Until the Calendar spec ships, a calendar row opens the Calendar's week.

## Anti-goals

- **Something waiting is buried.** No filter, closed card or month not yet shown hides that something waits:
  the list's heading always carries the whole count. The list itself never approves or declines.
- **A filtered page reads as quiet.** An emptied day says of what, and one line counts the days left out.
- **A day that differs by device.** A row's day is the household's (`householdDay`), never the phone's clock.
- **A label nobody computed.** No head, row or line states a number or a summary that a named function did not
  derive from the log. No row lacks a lane: a new op or tool without one fails to typecheck.
- **A member's own layer in the shared count.** Yours is the viewer's alone, never a day's entry.

## The page

Inside `#briefing`, top to bottom: (1) the head: `h1` "Today", under it the household's date in full
("Thursday 12 November 2026"), search at the right; (2) the Home Screen banner and the setup notes, as now
(`homeBanner`, `renderSetupNotes`), above the controls because nothing filters them; (3) the kinds row, then
the people bar; (4) "Waiting on you"; (5) today's card; (6) "Earlier" with its sort, the earlier days, the
left-out line and "Show <month>"; (7) the composer, sticky at the foot. The page opens at its top, not its
bottom. From 1040px, as now, Yours is a second, sticky column. While searching, 2, 4, 6 and 7 are hidden.

## Lanes

One lane per entry, and a row's first column is its lane's icon: the Budget, Calendar and Plan tab icons,
Claude's mark, and a speech square (Lucide `message-square`) for Notes. The briefing is `claude`. So is a
question with Claude's answer under it, wherever it was asked, a plan's card included. A note is `notes`,
wherever it was left. A proposal card takes its tool's lane, a decision row its card's, and a change its op's.
Which events become change rows is today's rule in `thread.ts`, unchanged: not in `NOT_A_CHANGE`, `quiet`, and
not appended by an approval in the same write. The lane of every op the log can hold:

- `budget`: assign, move, income.set, month.open, month.close, month.discard, txn.add, txn.categorize,
  txn.split, txn.remove, rule.add, rule.remove, envelope.define, envelope.remove, envelopes.model,
  budget.create, budget.rename, budget.locate, budget.archive, category.define, category.archive,
  category.sinking, income.source.define, income.source.remove, account.balance, savings.account.
- `calendar`: calendar.appointment, calendar.appointment.change (new), calendar.appointment.remove,
  calendar.drift.resolve on a calendar drift, calendar.household, calendar.household.rename, calendar.target,
  guest.allow, guest.revoke, guests.arrival, guests.booking, and all six booking.* ops.
- `plans`: plan.create, plan.state, plan.remove, plan.due, plan.block, plan.unblock, plan.attach, plan.detach,
  plan.hand (Plan spec), calendar.drift.resolve on a page drift, areas.set, areas.rename and the Plan spec's
  other area ops that write a line, goal.rename, goal.remove.
- `notes`: household.claim, member.add, member.remove, household.zone, links.set, documents.folder.
- No row, as now: briefing.read, prediction.record, flag.seen, scheme.set, calendar.conflicts, plan.doc,
  documents.moved; thread.answer (under its question); proposal.offer and proposal.decide (the card); the plan
  ops outside `PLAN_LINES`, which a card or the plan's History says (plan.set, plan.checklist, plan.contact.*,
  plan.calendar.*, plan.page.drift, calendar.drift, plan.ask*), and the Plan spec's plan.goal,
  areas.move and shelves.retire.

A card's lane is one total table keyed by tool name, kept beside `laneOf`. It lists every name that ever
offered a card (retired `ask_to_take` too, which old cards name) and is typechecked against the registered
write tools, so a tool without a lane fails to compile. `plans`: create_plan, update_plan, set_plan_state,
set_checklist, set_plan_due, block_plan_time, remove_plan, hand_plan, set_plan_goal, ask_to_take, answer_ask,
link_contact, create_contact. `calendar`: propose_event, approve_booking, release_stay, and resolve_drift
(`plans` on a page drift). `budget`: move_money, set_assignment, set_envelope_figure, set_month_income,
set_sinking_goal, categorize_transactions, restore_transaction, open_month, close_month, discard_month,
create_budget, rename_budget, archive_budget, set_budget_location, seed_from_location, define_envelope,
remove_envelope, add_starter_set, make_starter_envelopes, define_category, archive_category,
define_income_source, remove_income_source, savings_short.

## A day card

**The head** is one button across the card, with `aria-expanded` and a chevron. Its first line is the day:
"Today", or the weekday in bold with the date small after it ("Wednesday 11 November", with the year when it
is not this one). Its second line is small and faint, the same open or closed, parts joined by " · ": the
count ("7 entries", "1 entry", and "3 of 7 entries" while a kind, a person or a search narrows the day); "2
waiting" when rows in it wait on the viewer; on a closed card, "3 new" when rows in it are new to them; then
who wrote, "You" first, the other members in the household's order, Claude, and guests by the list's name.

**The numbers.** The server groups `build()`'s entries by `householdDay(zoneOf(state), at)` (a briefing by its
own `day`). `total` is its entries, the briefing being one; `count` is those in view under the lane, person
and words (under a pressed person the briefing is shown but not counted); `waiting`, those in view found in
`waiting(state, who, events)`; `fresh`, those in view after the viewer's read cursor (`state.readCursor`) and
not their own; `by`, each author under the lane and the words, whoever is pressed, counted.

**Open and closed.** Today's card starts open and every other day closed; any card, today's too, opens and
closes at its head. Opening a closed card reads that day's entries once (day mode, below). Which days are open
is page state: it survives a tab switch and the reload after a committed change, not a fresh load.

**The body**: the briefing; on today's card on a phone, Yours; then the rows as they happened, morning to
night, whatever the sort says. The divider "New since you last looked" sits once, before the first new row of
the newest open day that has one. The read cursor moves (`POST /api/briefing/read`, up to the newest entry)
once the last row of today's open card has been on screen with All and Everyone pressed and no search. Today
with nothing in it says "Nothing yet today. Ask Claude something, or leave a note."

## Rows

A row is four columns: the lane icon, faint; the author's disc (the member disc from the Plan spec; Claude's
mark on its paper); the text; the time at the right, in household time as `clockOf` writes it, "7:52 AM". The
text opens with the author in bold ("You" for the viewer, a guest by the list's name) and runs on as one
sentence. A row the app raised (a drift, Savings short, a cancelled stay) has no disc and no name. Rows are
not links: what a row opens is a text link at the end of its text.

- **Note.** "**Bob** left a note", then the words; on a plan's card, the crumb "on Fix the fence gate".
- **Question.** "**You** asked Claude", the question, then the answer on Claude's paper as `answerNode` draws
  it now, "Read the whole answer", the "Looked at …" line and "Ask again" included.
- **Change.** "**Bob** " and the entry's `what`, which is `describe()`'s sentence unchanged ("moved $40 from
  Dining out to Groceries", "categorized a transaction as Groceries (3 times)"), with its `why` as the quoted
  reason. A removed receipt keeps its block, "Put it back" and "Seen it". With more than one live budget, a
  row whose entry names a budget ends " · <budget label>".
- **A plan handed over.** "**Bob** handed **Fix the fence gate** to you" (or "to Casey"), the optional word as
  the quoted line, and "Open the plan". A notice: no buttons, and never in the waiting list.
- **A calendar change.** "**Casey** added **Swim meet** to the Household calendar" (or "to their own
  calendar"), and when under it: "Saturday 14 November, 9:00 AM". A change: "**Casey** moved **Swim
  practice**" with "Thursday 12 November, 4:30 PM, from 4:00 PM", or "renamed **Swim** to **Swim practice**".
- **A decision made on a later day than its card.** "**Bob** approved **Move $120.00 from Travel to
  Groceries**" (or "declined"), the reason quoted, and "Suggested on Tuesday 10 November", which jumps to the
  card. A decision on the card's own day has no row; the card says it.

## Proposal cards in a row

Each card the viewer may see is its own row, in its tool's lane, where offered. It reads "**Claude**
suggested"; "**Bob** suggested" for a member's own; "**Bob** asked you to take" for an old ask; "**<Guest>**
asked to stay"; none for the app's. Under it, the block, dashed (`--provisional`) while it waits:

- the label "Waiting" (an old ask says "Waiting for you" to the member asked and "Waiting on Bob" to the
  others; "for either of you" goes, since there may be three), the title (`offer.summary`; on an ask, the
  plan's title as a link to its card) and the effects as a list;
- an error slot, always rendered, `role="alert"`: a refusal is said there, never in a button's label;
- the buttons, the primary at the right: Decline, Adjust (move_money and set_assignment only), Not now,
  Approve. Approve asks for the reason in the block (`approveForm`), and every other card's buttons and forms
  (a drift's three choices, "Seen it", a request's Decline and "Suggest other dates", "Take it off the
  calendar", an old ask's Decline and "Take it", "Work it out again") keep their words and rules;
- the from-line, a link that jumps to what raised it: "From the day's briefing", "From your question at 1:22
  PM" ("From Bob's question on Tuesday 10 November" on another day), "In place of an earlier suggestion";
- decided, plain lines in the block's place: the title, then "Approved by Bob · 8:14 PM · “The trip is paid
  for”" (with the day when it is not the card's). Other settled lines keep their words, " · " for a dash.

## The briefing and Yours

**The briefing** is first in its day's body, on Claude's paper: the by-line "Claude · the day's briefing" with
its time at the right (a fallback keeps "Briefing · written without Claude"; a budget's own section, on a day
with no household briefing, keeps "Claude · briefing for <budget>"), then the headline. On today's card the
write-up follows, clamped as `clampBody` clamps it; on an earlier day only the headline shows. "Read the whole
briefing" opens the rest in place, from the entry's `body` or from Drive, and then goes. It is drawn under All
and under Claude and hidden under any other kind. Under a pressed person it is shown but not counted.

**Yours on a phone** is a strip in today's card, under the briefing, on the page colour: an eyebrow with the
viewer's solid disc, "Yours · what the briefing was written from" ("Yours" when no briefing is drawn), then
one row per rail from `GET /api/today`, each with its lane icon and a chevron. A row is the rail's first item
as the desk rail draws it, then "and 2 more" when the rail holds more; an empty or unreadable rail shows its
existing line. A row opens the rail's screen. Under Budget, Calendar or Plans the strip keeps only that rail;
under Claude and Notes it is absent. **On the desk** Yours is the column it is now, its three rails in full
(`calendarRail`, `plansRail`, `moneyRail`). No filter touches the column, and no person the strip.

## Waiting on you

A `section` above today's card: the heading "Waiting on you · 2", then one dashed-bordered list; absent when
nothing waits. It holds what `waiting()` returns for the viewer: open cards (an old ask only for the member
asked), put-off cards whose figures have moved, receipts someone else removed that the viewer has not seen,
and unsorted receipts as one item, for every budget. Newest first, the receipts last.

Each row: the lane icon; the title (`offer.summary`; the plan's title for an ask; "A receipt was removed:
<payee>, <amount>" from `Removed`; "14 receipts to sort"); a small line of who and when ("Claude suggested it
· today, 1:22 PM", "Bob suggested it · Tuesday 10 November", "Bob asked you · …", "<Guest> asked · …", "Bob
removed it · …", the time alone for a card the app raised, "In no envelope yet" for the receipts), ending " ·
the numbers have moved" when they have; a chevron. A row has no buttons. It jumps: the card's day opens (read
first if need be), and the row scrolls to the centre and takes focus. An item with no row of its own jumps to
the card that caused it: a receipt removed by an approved card has no change row, so that card draws the
removal block with "Put it back" and "Seen it". The receipts row opens Budget at the unsorted queue, as "Sort
them" does now. Under a kind or a person the list keeps only the rows in view, the heading reads "Waiting on
you · 1 of 3", and a last quiet row, "Show all 3", presses All and Everyone.

## Kinds and people

**Kinds**: one row of six pill buttons, a group labelled "Show": All, Budget, Calendar, Plans, Claude, Notes.
One is pressed at a time. **People**: the people bar from the Plan spec, labelled "Whose": Everyone, then each
member with entries in view and their count (the sum of `by` over the days on the page). As on the Plan spec's
bar, pressing a person changes neither who is listed nor the counts. Claude and guests are never in it. It is
hidden when only one member has entries in view. A pressed person shows the rows that person wrote, a question
with its answer. Kinds and people apply together.

**Empty days.** Under either, a day with nothing in view has no card (under a person, a day whose only entry
in view is the briefing has none either), except today, which says what it is empty of, above its briefing
when one is drawn: "Nothing under Budget today.", "Nothing by Bob today.", "Nothing under Budget by Bob
today." After the last earlier day, once: "4 other days since 1 November have nothing under Budget and are
left out." (the days on the page whose `count` is 0, and the first day the page covers).

**What is kept.** The pressed person is the Plan spec's shared page state; when that person has nothing in
view on the days the page covers, the server answers `who: 'everyone'`, Everyone shows pressed and the kept
choice is untouched. The pressed kind is Today's own: it holds through tab switches and reloads, and starts at
All on a fresh load, a household switch and a deep link in. "All budgets" is gone: every budget shows.

## Earlier days

Under today's card: the heading "Earlier" and, at its right, the sort, a text button with an up-down icon
reading "Newest first" or "Oldest first". Pressing it flips the order of the earlier cards on the page; today
stays first and rows inside a day stay morning to night. The first load covers the household's current month.
"Show October" (the answer's `before`; with the year when it is not this year) adds that month's cards. It
sits where its days will land: after the last card under Newest first, directly under the heading under Oldest
first. It is absent at the start of the record; with no earlier day and no `before` the heading is absent too.

## Search

There is one search and it is Today's; the top bar's box and its menu of hits go. On a phone the head carries
a search button (named "Search the household"); pressing it swaps the title for the field, focused, with a
clear button inside it and "Cancel" beside it. On the desk the field is always in the head. Placeholder:
"Search the household". Until two letters are typed the days stay as they were. From two letters, 250ms after
typing stops and with only the latest answer drawn (as now), the results take the days' place:

- A line: "**4** in the record for “dentist” · newest first".
- Day cards, newest first, each open and holding only its matching rows; the head, not a button, reads "2 of 7
  entries". A row is drawn as in its day, without blocks or buttons, the words marked wherever they occur
  (`mark` nodes). A question adds "Claude answered: " and the passage at the match, or else the answer's
  opening; a briefing shows its headline and passage. Words found only in a document kept in Drive show
  Drive's passage as the second line. A result row links to its day and leaves search.
- "Elsewhere · 1": plans and files, as the household search finds them now: a plan's title with "A plan ·
  “…passage…”", opening its card; a file's name with "A file on <plan>", opening in a new tab.
- A last line: "Searched every day since the record began.", or "Showing the newest 100. Add a word to narrow
  it." when capped; and "Sign in again to search briefings, answers and files too." when Drive was not asked.

Nothing found: "Nothing in the household matches that." A failure: "The search could not be done just now."
Kinds and people narrow the record's results. Cancel, Escape in the field, or emptying it on the desk puts the
days back with their filters and open cards. A household switch empties it.

## The composer

A sticky bar at the foot, with no tray (the waiting list replaced it): the field (the existing `#say`,
placeholder "Ask Claude, or leave a note for the others"), then one line: a status slot at the left reading
"Goes into today", "Leave a note", and "Ask Claude" as the primary at the right. Enter asks and Shift+Enter is
a new line. With no key configured "Ask Claude" is disabled and the slot says "Claude isn't set up on this
server. Notes still work." While asking it says "Asking Claude…"; a refusal or failure is said there.

It always writes into today, whatever day is being read: a row's day is when it was written. After a send,
today's card opens and the new row scrolls into view. If the pressed kind would hide it, the kind returns to
All. If a pressed person would hide it, nothing changes and the slot says "Left in today. It shows under
Everyone." While a form in a row has focus the bar rests at the end of the page, as now.

## Deep links

Today has no addresses. A deep link is a page function, as `openBudgetAt` is for an envelope.

- **In.** `openTodayAt(target)` replaces the selector form; `target` is `{ day }`, `{ event }`, `{ offer }` or
  `{ drift }`. It shows Today, leaves search, presses All, reads the day holding the target (day mode with
  `at`), opens its card, scrolls the row to the centre and focuses it; if the pressed person hides the row it
  presses Everyone. `{ day }` alone opens that day's card at its head. It answers false when no day shows the
  target. Its callers are the Calendar (`{ drift }`, `{ offer }`), the waiting list, the from-lines and search
  rows. Rows keep `data-event`, `data-offer` and `data-drift`.
- **Out.** An entry's `open`, set by the server, is the text link at the end of its row. "Open the plan"
  (`openCard(id)`, the Plan spec's card) on a `plans` change to a live plan. "Open the envelope"
  (`openBudgetAt(budget, envelope)`) on assign, envelope.define and a move (the envelope the money went to).
  "Open the day" on a calendar row: it sets `calWeek` to that day and shows the Calendar's week.

## The server

**Lanes.** `type Lane = 'budget' | 'calendar' | 'plans' | 'claude' | 'notes'`. `laneOf(e, state): Lane | null`
is an exhaustive switch like `scopeOf` (null for the no-row ops); a card's lane comes from the tool table
beside it. Lanes are worked out on reading and nothing is stored, so old logs need nothing.

**Entries.** Every `ThreadEntry` gains `lane` and `day`. A briefing and an answer lose `cards`: every offer
`visibleTo` the viewer is a `card` entry at its own place in the log, with `raised?: { how: 'briefing' |
'answer' | 'research' | 'member', entry, day, at, by }`. A `decision` entry `{ id, at, who, lane, day,
decision: 'approved' | 'declined', why?, offer: { id, summary, day } }` comes from a `proposal.decide` on a
later day than its offer. A `change` gains `plan?: PlanRef`, `open?: { plan } | { budget, envelope } | {
calendar: Day }` and, on an appointment, `event: { start, end, allDay, on: 'household' | 'own', was? }`. A
`plan.hand` change carries `hand: { plan, to }`, as the Plan spec defines, and its `word` as its `why`.

**`GET /api/thread`** answers `{ today, who, days, entries, waiting, newSince, before, noBudgets?,
noOpenMonth? }`, and still writes the day's briefing and looks for drift first.

- `days: { day, count, total, waiting, fresh, by: { who, name?, count }[] }[]`: one per day with entries, from
  the first day of the month `through` (default: today's month) to today, newest first, today always.
- `entries`: flat, oldest first, for today and each day named in `open` (comma-separated); no other day's.
- `lane=<lane>` and `who=<member>|everyone` narrow `count`, `fresh`, `waiting`, `entries` and `before`, never
  `total`; `by` is narrowed by the lane, never by `who`. The answer's `who` is the member applied, or
  `everyone` when that member has nothing in view on the days the page covers, exactly as `GET /api/plans`
  answers it. `before` is the next month back (`YYYY-MM`) with a day in view, or null.
- `waiting`: every item, unnarrowed, with `lane`, `by`, `at`, `day`, `title` and `entry` added: its row, or
  the card that caused it when it has no row of its own.
- Day mode: `day=<YYYY-MM-DD>`, or `at=<the id of an entry, an answer, an offer or a drift>`, answers `{
  today, days: [that day], entries }` and does none of the briefing or drift work.
- `budget=` stays for the briefing's fallback and the two flags, and hides nothing. `filter`, `all`, `limit`
  and an event id in `before` are no longer read. A lane, a member, a day or a month that is not one is a 400
  ("lane must be budget, calendar, plans, claude or notes"); an `at` no day shows is a 404.

**`GET /api/search?q=&lane=&who=`** answers `{ who, days, entries, capped, elsewhere, documents }`. The
record's results do not come from `searchHousehold`: a new function matches over `build()`'s entries, newest
first, with `count` the matches and `total` the day's entries. An entry matches on the words the log holds: a
note; a question and its answer; a briefing's headline and body; a change's `what`, `why` and removed payee; a
card's summary, effects and reason. Briefing and answer text kept only in Drive stays searchable: Drive's
briefing and answer hits (the `driveHit` path) are still fetched and joined to their entries, each carrying
its `passage`. Together they are capped at 100 entries (`capped` says it cut). `elsewhere` is the plan and
file hits only, under `searchHousehold`'s existing cap. `searchHousehold` and Claude's `search` tool are
unchanged; the route's `kind` is no longer read.

**One new op.** Changing an appointment in the app writes nothing to the log today (`changeEvent` writes the
NAS, and an etag only for a plan's link), so a "moved" row has no source and the state's copy goes stale.
`calendar.appointment.change { evt_id, summary, start, end, allDay, dav_etag, was: { summary, start, end,
allDay } }` is appended by `changeEvent` once the NAS accepts, when the name or the time changed. Replay
refuses it for an appointment not recorded and otherwise updates that `Appointment`. It joins
`BOARD_CALENDAR_OPS` and `PLAN_LINES`; it restores in scope `plans`; `describe()` says "moved <summary>" or
"renamed <was> to <summary>". If the log refuses, the event is put back as read.

**Old events and old pages.** An old open `plan.ask` is a `plans` card until a `plan.hand` settles it. `GET
/api/today` and the write routes are unchanged. A page open across the upgrade errors until reloaded.

## What is deleted

- Server: `ThreadOptions.filter`, `allBudgets`, `limit` and the event-id `before`; `author()`, `hasWaiting`
  and `inView`; `standalone()` and `cardsFor`; `cards` on briefings and answers; `kind` on `GET /api/search`.
- Markup: `#t-filters`, `.thread-tools`, `#t-all`, `#t-earlier`, `#tray`, `#thread` (the day cards take its
  place) and the top bar's `#search` with its list.
- Script: `threadFilter`, `threadAll`, `filterBeforeDetour`, `endFilterDetour`, the read-further loop and the
  Waiting detour in `openTodayAt`; `placeYours` and its `ResizeObserver`; `unsortedItem`; the scroll to the
  bottom in `loadThread`; the observer on the composer; `dayKey` for grouping; `searchOpen`, `searchClose`,
  `searchMark`, `searchDraw`, `searchGo`, `searchSay`, `SEARCH_KINDS`, `atEvent`.
- CSS, once unused: `.thread-tools`, `.allb`, `.tday`, `.msg`, `.bubble`, `.turn`, `.line`, `.tray`, the left
  border of `.card.offer`, `.search-list`, `.search-hit`, `.top-inner > .search`.
- Copy: the four filters' names; "All budgets"; "Show earlier"; "N waiting on you"; "Nothing is waiting on
  you."; "Read all of it"; "adjusted a suggestion"; "Waiting for either of you".

## Copy rules

Sentences, the app's spellings, no exclamation marks. A row is a past-tense sentence starting with who. The
server's sentences (`describe`) are shown as written. A count is a number and a noun ("7 entries", "2
waiting", "3 new", "1 of 3"). A date is a weekday, a day and a month, the year only when not this one; times
are the household's. " · " separates parts of a line; no dashes. Nothing on the page says "thread" or "lane".

## Accessibility and the phone

"Today" is the `h1`; "Waiting on you" and "Earlier" are `h2`; a day's name names its `section` and head.
Kinds, the people bar, the sort, a day head, a waiting row and the search button are real buttons with a 44px
hit area. The results line, the left-out line and the composer's slot are `aria-live="polite"`. Focus goes to
the row on a jump, stays on the head when a card opens or closes, to the field when search opens and back to
its button after. Escape cancels a form open in a row first, then leaves search. At 375 wide the control rows
never scroll the page sideways and the composer never covers a focused field.

## Left to the builder

- Exact CSS within `tokens.css`; the numbers in the wireframe's `today.css` are a guide.
- Whether a day is drawn by one renderer or one per entry kind, and how the existing card nodes are re-housed
  in the block. Every async continuation checks it is still wanted, as the envelope pages do.
- How the route gets Drive's briefing and answer hits without `searchHousehold`'s cap of 8 cutting them; how
  long a passage is; where `laneOf` lives; the test shape (as `api/test/thread*.test.ts`).

## Calls I made (the owner to check)

1. **Household facts are in the `notes` lane** (members, the time zone, the links, the documents folder). The
   contract has five lanes and these fit none; the other choice was to drop them from Today.
2. **Stays and guests are `calendar`; every `plan.*` change, areas and goals `plans`; savings `budget`.**
3. **A proposal is a row where it was offered, and its decision shows on it.** Only a decision on a later day
   gets a row of its own that day, so no day hides that money moved in it.
4. **A moved appointment gets a log line** (`calendar.appointment.change`): the wireframe's "moved … from
   4:00" row had no data behind it. Its quoted reason is cut. The Calendar spec should reuse this op.
5. **The briefing counts as one of a day's entries, and only a kind other than Claude hides it.**
6. **Paging is by calendar month; the wire name is `lane`** (`kind` is taken); deep links are page functions.
7. **A narrowed count reads "3 of 7 entries"**; the wireframe's bespoke counts and summaries are cut.
8. **The waiting list narrows with the filters but its heading keeps the whole count.** Newest first.
9. **The kind, the open days and the sort survive tab switches, not a reload**; only the person lasts longer.
   A closed head says "3 new", from the read cursor, since a divider cannot show inside a closed card.
10. **One search: the top bar's box is deleted** and search lives in Today's head, a row freed on every phone.
11. **Yours on a phone is one row per rail (first item, "and N more")**; setup notes stay above the controls.
12. **Buttons run Decline, Adjust, Not now, Approve**, by the app's convention; the boards draw Approve first.
13. **The composer never changes the pressed person**, only the kind, to All when it hides the new row.
14. **The people bar's counts ignore the pressed person, and the server answers `who`** (orchestrator's call).
15. **Under a pressed person the briefing is shown but not counted** (orchestrator's call).
16. **Search matches `build()`'s entries, newest 100; "Elsewhere" keeps its own cap** (orchestrator's call).
17. **A waiting item with no row of its own jumps to the card that caused it** (orchestrator's call).

## Mockup

The boards are on the owner's private canvas "Today, redesigned" (claude.ai artifact
`SEySRupmbgydpMd6Qjf5sF`): Today, Earlier days, Budget only, Searching, On the desk. They were redrawn to this
document; no static copies are in the tree. Where a board still disagrees, this document is right:

- Every board uses the household's real first names; here they are Alex (the viewer), Bob and Casey.
- Today, On the desk: "Looked at this month's envelopes and the receipts." is not a line `LOOKED` writes.
- Today, On the desk: in Yours, the plan's "from <member>" is the board's wording; the row shows the chips the
  plans rail draws. On the desk, "Dining out · no figure yet" is not a row `moneyRail` draws, and the lane
  icon and chevron on each rail row are not in the column as it is now.
- Earlier days: the decided card keeps its from-line; here a decided card is its title and one settled line.

