# The Calendar as a day page

**Status:** design, for review. Agreed with the owner on 2026-11-09. Release 0.9.0, the third of three, built
after "Plan by area" (0.7.0) and "Today as day cards" (0.8.0). It uses by name, and does not specify again,
their people bar, member discs, state glyphs, goal flag and chips, any-state goal list, lanes, day cards and
deep links. The members in its examples are Alex (the viewer), Bob and Casey; Dana is a friend who stays.

## Intent

On a phone the Calendar is the desk's week grid cut down to one column: fourteen hours at 52px each, mostly
empty, with a legend under it to explain the shapes (five swatches; eight on the desk, nine where friends
book). The strip of days above it shows coloured dots that say whose calendar has something, never how much or
what. A plan due on Saturday is a dashed box with no state. The envelope that cannot pay next week's bill, and
what was said that day, are on other tabs.

The owner ruled that on the phone the day is rows, not an hour grid. The week is a strip with marks under each
date; the chosen day is one card of plain rows that read *when, whose, what, a figure*; and what Plans, Budget
and the record have on that day sits in the same rows. The legend goes because nothing is left to explain: a
row's disc is the disc in the bar above it, a plan carries the Plan page's state glyph, dashed is a marker,
hatched is held nights, red is a clash. The desk keeps its grid and gains the same marks.

The owner's bar for every figure: "I don't want us to keep trying to curate bespoke labels and data lines."
Each numeral here names the function it comes from; where the data did not exist, Calls 1 to 3 say so.

## Goals

- The phone page is a head, a bar of calendars, a row of overlays, a strip of seven days with marks, the
  chosen day as one card of rows, one "also has" line and one link at the foot.
- Every mark and every count is computed from the rows the card would draw, by one page helper, so the strip,
  the month, the bar and the desk's day heads cannot disagree with the card.
- A plan's due date and blocks carry the plan's state glyph, owner, goal and area, and open its card.
- Money lands on a day twice where it applies (ruling 21), from what the receipts say; the day's record is one
  row that opens Today (ruling 25).
- Adding is the card's last row, opened in place, with what it overlaps and when is free (ruling 23).
- The legend is deleted on the phone and the desk. The desk keeps the week grid.
- With the calendars out of reach the page still draws everything the log holds.

## Non-goals

- No hour grid on the phone. No month view of events: the month is a picker. No month picker on the desk.
- No new op. How an event is made, changed, deleted, proposed, drifted or held is unchanged: `propose_event`,
  `POST /api/calendar/events`, the drift cards and the booking ops. A change made in place still writes the
  Today spec's `calendar.appointment.change`, as it has since 0.8.0.
- No due day on an envelope, no date an envelope "runs out", and no sinking fund on the calendar: a goal by a
  month has no day, and an estimate "every 4 years" has no next date.
- No event location or attendee: the app does not read them from the NAS (`CalEvent` has neither).
- No filtering on the server (`who=`, `kinds=`). The page filters the window it already holds.
- No drag, no editing an event the app did not make, no writing to another member's calendar.

## Anti-goals

- A numeral in the strip, the month, the bar or a desk day head that is not the rows the card draws.
- The word "due", or a date that no function computed, on a money row.
- A filter that hides a row silently. A legend that comes back as a key, a footnote or a tooltip.
- Two forms open at once, or a form that opens somewhere other than the row that asked for it.
- Household, pressed here, changing who is pressed elsewhere. A blank page because the NAS did not answer.

## The phone page

Under 1040px of the page container, as now. `#calendar`, top to bottom.

**Head.** The heading "Calendar". Under it the month as a button with a chevron and `aria-expanded` ("November
2026", the chosen day's). At the right: Previous week, "Today", Next week. Today loads this week, chooses
today and closes the month picker. A week reached by an arrow chooses today when it holds it, else its Monday,
as now.

**The calendars bar** (ruling 3). The Plan spec's `peopleBar`, given calendars as its `{ key, label, n }`
entries: `role="group"`, `aria-label="Whose calendar"`. "Everyone" with no count; then each member, the viewer
included, in the bar's order, whose own calendar has a row in the window, by name with that count; then
Household, one more entry with a key of its own, when it has any. A row is on a member's calendar when its
event's `owner` is that member. A plan's due date or block (`kind` `due` or `block`) is one Household row
wherever its event sits: its `owner` is not used, and it is counted once, under Household, never under the
member whose calendar holds it. Held nights and anything proposed for the household are Household rows too. A
count is those rows in the window (the week; the picker's 42 days while it is open), after the Plans toggle
and the goal chip. A member with no calendar of their own, or whose calendar the viewer has not ticked in
Settings, has no entry; nor has a calendar the viewer checks that is no member's, which shows under Everyone
only. With fewer than two entries after Everyone the bar is not drawn.

Who is pressed (ruling 4): the Plan spec's pressed person is the page's shared state; this page adds one flag
of its own, Household pressed. Pressing Everyone or a member calls the Plan spec's `pressPerson`, and this
release adds one line to that function: it clears the flag. That is how a press on any tab clears it. Pressing
Household sets only the flag; a household switch and sign-out clear it too. When the shared person has no
entry here, Everyone shows pressed and the kept choice stays.

**Overlays and goals.** One scrolling row, `role="group"`, `aria-label="Over the calendar"`, faded at its
right edge: three toggle chips, "Plans", "Budget", "Record", each `aria-pressed` and showing its icon only
while on (Record's is the Today tab's, the Lucide `sun`); then a hairline; then goal chips, drawn only while
Plans is on and the any-state goal list is not empty (ruling 22). The chips are this page's own row, built
with the Plan spec's `goalFlag` (flag and label, alphabetical, scrolled to the pressed one), not the Plan
page's goal row: there is no "All goals" chip, and a pressed chip is released by pressing it again. All three
toggles start on. The choice is kept per device in `localStorage` (`hp.calOver`), like `hp.budgetTab`; storage
that cannot be read means all on. Budget is not drawn when the household has no live budget.

- Plans off: plan due and block rows, the state glyph mark and the goal chips go. An appointment made for a
  plan is an event on a calendar and stays.
- Budget off: money rows and the `$` mark go. Record off: the record row goes.
- A goal chip, one at a time, keeps only the plan rows that carry it. Events are untouched. It is released on
  a household switch (ruling 4).

**The week strip.** Seven buttons, Monday to Sunday (`mondayOf`), each the short weekday, the date and a row
of marks. Today's date is in the accent ink; the chosen day is raised with a border and `aria-current="date"`.
Pressing a day chooses it and redraws the card with no fetch.

The marks, in this order, from one page helper `dayMarks(day)` that reads what the card would draw:

1. **Count.** A numeral: the calendar rows on that day under the pressed calendar, the Plans toggle and the
   goal chip. Calendar rows are everything in `events`; one covering several days counts on each (`daysOf`).
   Never money or the record. No numeral at zero.
2. **State glyph.** One, from `events[].plan.state`, when a shown plan row lands that day: doing if any is
   doing, else planning, else done.
3. **`$`.** When Budget is on and `money[]` has a row for that day: caution colour, or the problem colour when
   any of them is `short`. The calendars bar does not change it: money is on nobody's calendar.
4. **Clash dot.** Red, when a shown timed row that day has `clash`. The flag is the server's, set by
   `markClashes` across every calendar read, before the page filters.
5. **Hatch.** When a shown row that day has `held`. A stay from Friday to Sunday holds Friday and Saturday.
   Four marks fit a phone cell: when all five apply the hatch is left out and stays in the button's accessible
   name. The desk's day heads show all five.

**The month picker.** Pressing the month replaces the strip with a grid: Mon to Sun heads, then 42 days from
the Monday on or before the 1st, the same cells and marks, other months' days faint. The arrows become
Previous month and Next month. Pressing a day chooses it and closes the picker onto its week; pressing the
month again, or Escape, closes it with nothing changed. The day card stays below. It is never a view of
events. While it is open the window is its 42 days, asked for in one call.

**The day card.** A `section` labelled by its heading: the long weekday and the date ("Thursday 12"), with a
small "Today" in the accent ink on today. At the heading's right, one phrase per group of overlapping clash
rows with two or more rows showing, in time order, in the problem colour, joined by a middle dot: the number
showing and the time the overlap begins, which is the second row's start ("2 at 9:00"). A shown row whose
clashing partner is hidden keeps its red outline and its accessible words, and the day keeps its dot: a filter
never makes a real clash look clear.

Rows are a five-column grid: when (60px), a 22px slot, what, a figure, a chevron; 56px tall or more. In order:

1. *Money*, while Budget is on. On today, each envelope that cannot cover the bills it still expects: "BILL"
   over the bill's day ("Mon 16"); the Budget lane's icon; the envelope's name over "Example Power, about
   $146" ("2 bills, about $246" for several); the figure "$14 left", or "$20 over", in the problem colour. On
   a bill's own day: "BILL"; the envelope's name over the payee, with "$14 left" after it in the problem
   colour while its envelope is short; the figure "about $146". With more than one live budget the second line
   leads with the budget's name. Opens the envelope's page.
2. *A plan's due date*, by title. When is "DUE"; the slot is the plan's state glyph; what is the title over
   one meta line: the owner's small disc, the goal flag and goal when it has one, the area. A dashed outline
   in the provisional colour; the accent rail while doing; when done the title softens, the glyph is the check
   and the outline takes the good colour. Opens the plan's card.
3. *Held nights*, hatched. A friend's stay: "NIGHTS" over "Fri – Sun"; `householdDisc()`; "Dana staying" over
   "2 people · Fri 13 to Sun 15". Opens its request's card on Today. Nights kept: the reason over "kept by Bob
   · Fri 13 to Sun 15" ("kept by you"). Opens in place (below).
4. *All-day events*, by start then title. "ALL DAY", with the span under it when it covers more than a day;
   the calendar's disc; the title, or "Busy".
5. *Timed rows*, by start then end. The start in bold over the end (`clockOf`); a row begun on an earlier day
   reads "from Wed" over its end, one ending later its start over "to Fri". The slot is the calendar's disc:
   the Plan spec's `memberDisc` (the viewer's solid, another's a ring with an initial), or `householdDisc()`,
   the house mark `sourceDisc` draws today, lifted into a helper beside it by this release. A plan's block has
   the plan's state glyph in the slot and the due row's meta line, with no outline. A second line appears only
   to say one of: "for Fix the fence gate" (an appointment made for a plan), "proposed, not approved" (an open
   card; dashed accent outline), "moved on the calendar" (an open drift; caution outline), "not on the
   calendar yet" (a date kept on its plan with no event), or the calendar's name when it is no member's. A
   clashing row keeps a red outline.
6. *The record*, while Record is on and the day has entries: the count in bold over "entries" ("entry"); the
   Today tab's icon; "The day's record" over its writers, written with the helper and in the order of a closed
   day card's head (You, the other members in the household's order, Claude, guests by the list's name), then
   " · 2 waiting on you" when any wait. Opens Today on that day.
7. *Add*, then 8. *Keep nights* (both below).

On today, the now line (the accent line and the time, `role="img"`, "Now, 1:40 PM") sits among the timed rows
before the first that starts after now; after the last when all have started; not drawn with no timed rows. A
card with no rows above Add starts with one quiet line: "Nothing on."

**"Also has"** (ruling 24). One line under the card, `aria-live="polite"`, only when the pressed calendar or a
goal chip hides calendar rows from this day: "Friday also has 2 other things: Bins and Dana staying." The
number is the hidden rows; the titles are the first three (`listOf`), then "and 2 more": hidden rows that
clash with a shown one first, then the card's order. One reads "1 other thing". An overlay switched off is not
reported: its unpressed chip already says so.

**Adding to a day.** The row "Add to Thursday 12", a plus in the accent ink. Not drawn on a day already gone
(the server refuses those times) or while the calendars are unavailable. Pressed, the row becomes a form in
place, headed "Add to Thursday 12", focus in the first field:

- *What*: text, required, 200 characters, placeholder "Dentist".
- *All day*: a checkbox; ticked, it hides the two times.
- *From*, *To*: time inputs side by side. They start at the next whole hour today (no earlier than 9:00, no
  later than 22:00) or at 9:00 on another day, an hour long, as the form does now.
- A live block, asked of `POST /api/calendar/conflicts` 300ms after a time changes (`formConflicts`, which
  reads the viewer's own calendar, the Household's and the ones they check). Each overlap: "Overlaps **Swim
  practice**, 4:30 PM to 5:30 PM", the name in the problem colour, "something" when it has none. Then up to
  three chips, `aria-label="Free from"`, each a start time from `freeSlotsNear` (same length, same day, 7:00
  to 21:00, on the half hour, nearest first, none already gone); a chip sets From and To. Nothing overlapping:
  "Nothing else at that time on Alex's calendar and Household." No calendar to read: "There is no calendar to
  check it against yet." A 409: "Sign in again to check for overlaps." Any other failure: "Overlaps could not
  be checked just now." An overlap never stops Save.
- *On*: a pair, "Household" and "Alex's" (the viewer's own, drawn only when `mine` is true),
  `aria-label="Which calendar"`. It starts on Household whoever is pressed in the bar (ruling 23).
- *For a plan*: a select, "None" then each plan in planning or doing as "Fix the fence gate · House", if any.
- *Notes*: optional, 2,000 characters.
- The error slot, then Cancel and Save, Save at the right.

Save posts what the form posts now (`{ summary, start, end, allDay, on, plan?, notes }` to
`/api/calendar/events`); a member's Save is the decision, with no proposal. The window reloads and focus lands
on the new row, or on the "also has" line when the pressed calendar hides it. A refusal fills the error slot
and keeps the values. Cancel or Escape closes the form and returns focus to the Add row.

This form only makes an event. `propose_event` stays Claude's: its open card is the "proposed" row, decided on
Today. A plan's due date and blocks are set on its card; "For a plan" makes the event that plan's appointment.

**Keep nights for the household.** A quiet last row with the hatch glyph, drawn only where friends book with
this household (`settings.booking.on`), on today or a later day whose night is not already held. It opens in
place what "Block nights" opens now: the same heading; First night (the card's day) and Last night; Why,
required, 200 characters, placeholder "Family is here"; the line "Friends see these nights as taken, and never
why. Nights of a confirmed stay cannot be kept."; the error slot; Cancel and "Keep these nights". `POST
/api/bookings/block` is unchanged, and its refusals (a stay holds them, already kept, too many nights, passed)
show in the slot in the server's words. A kept row opens in place what `openHeld` shows now: "Kept for the
household: the nights of Fri 13 Nov to Sat 14 Nov", the reason and who kept them, "Why open them again"
(required), Close and "Open these nights" (`DELETE /api/bookings/block/:id`).

**Opening an event.** The order `evOpen` has now, with a stay added: an open drift, a proposal and a stay go
to their card on Today; an appointment the app made, which this member may change, opens "Change this event"
in place (What, All day, From, To, "Ends on" when it spans days, Notes; "On Household" as words; "For Fix the
fence gate" as a link to the card; Close, Delete, Save, with Delete asking "Take it off the calendar for
good?", Keep it, Delete it); any other event opens read-only in place (its title, when, "On Bob's calendar,
shared with you", its notes, the line `openEventView` has now for why it is not changed here, Close and "Open
in Synology Calendar"). One thing is open in a card at a time; opening another closes the first.

**Foot, and when the calendars are out of reach.** The foot is "Open in Synology Calendar", a text link to a
new tab, only when `settings.dsmPublicUrl` is set. `unavailable` draws one `.unavailable` line above the
strip: the server's reason with a capital, then "Plans' dates, held nights, money and the record are still
shown." The Add row and the desk's New event are not drawn (Save needs the NAS); Keep nights stays (it does
not). `missed` draws: "Bob's calendar could not be read just now; the rest is shown."

## The desk

From 1040px. The grid is kept as it is: day heads, the all-day row, 7:00 to 21:00, seven columns, `timedBoxes`
with its side-by-side lanes and edge arrows, `nowLine`.

- *Head.* "Calendar" over the week in words ("9 – 15 November 2026", not a control); at the right Previous
  week, "This week", Next week, the calendars bar, then "New event", primary, last. Under it the overlays and
  goal chips at the left, and at the right the quiet buttons "Keep nights" (where friends book) and "Open in
  Synology Calendar".
- *Panel.* `#cal-panel`, above the grid, holds one thing: a day's card, a form or view opened from a box, the
  keep-nights form, or New event. New event is the Add form headed "New event" with a "Day" field after What
  (today or later), starting on the chosen day.
- *Day heads* are buttons: weekday, date and the marks, with room for all five. Pressing one opens that day's
  card in the panel, with the phone's rows, Add, Keep nights and "also has" line; pressing it again closes it.
- *Boxes.* The three shades stay, and a box on another member's calendar names them from `owner`. A due date
  is dashed with its state glyph, "due" and its goal; a block has its glyph before the time; held nights are
  hatched across their nights; money sits in the all-day row as a caution-tinted box ("Electricity · $14 left"
  over "bill Mon 16" on today, "Electricity · about $146" over the payee on the bill's day). Proposed, moved
  and off-calendar boxes keep their looks and say which in their second line. A box opens what its row opens.
  Filters remove boxes as rows.
- The record row is in the day card only. There is no legend and no hint line under the grid.

## Deep links

The page links by function, as `openBudgetAt` does; there are no addresses.

- **In:** `openCalendarAt(day, key?)`. It sets the chosen day, shows the Calendar and loads that day's week.
  With a key (an event's `evt_id`, a proposal's id, or a plan's id for a date drawn from the log) it scrolls
  that row to the centre, focuses it and tints it with `--accent-tint` until another day is chosen or a change
  redraws the card. If the pressed calendar, an overlay or a goal chip would hide the row, this visit draws
  under Everyone with that overlay on and the goal released; the kept person is not changed. A key no longer
  there opens the day with no tint and no message. On the desk the day's card opens in the panel. A reply that
  lands after the person has left draws nothing. After this release Today calls it from exactly three places:
  each row of the desk Yours calendar rail, `openCalendarAt(day, evt_id)`; the phone strip's calendar row,
  `openCalendarAt(today)` with no key; and "Open the day" on a calendar change row, `openCalendarAt(day,
  key?)`.
- **Out:** a plan row uses the Plan spec's plan-card link, and Back returns to the Calendar on the same day
  and scroll. A money row calls `openBudgetAt(budget, envelope, cover)`, with `cover` only when the envelope
  is over; Back there returns to the Budget list, as it does. The record row uses the Today spec's link to a
  day, with no entry. Drift, proposal and stay rows use its link to a card.

## The server

No op, replay rule or refusal changes, and nothing here writes. One endpoint grows; an old page asks for a
week and ignores what is added, and an old log needs nothing.

`GET /api/calendar?start=<day>&end=<day>`: the window may be 1 to 42 days (`WEEK_MAX_DAYS` goes from 8 to 42;
the refusal keeps its words with the new number). The page asks for a week, or the picker's 42 days. The
answer keeps `events`, `unavailable` and `missed`, and adds:

- On each event, `owner?: Actor`: the viewer for `mine`; for `partner`, the account the calendar's id begins
  with (the rule `ownedBy` reads) when that account is a member of the household; absent otherwise.
- `plan` grows from `{ id, title }` to `{ id, title, state, owner, goal, area }`, `goal` being the label the
  Plan spec's `plan.goal` sets, or null.
- A stay's `held` grows to `{ kind: 'stay', id, request, name, headcount }`, from `state.stays`.
- A block whose linked event the calendars did not show is drawn from the plan, as a due date already is.
- `mine: boolean`: whether the viewer's account lists a calendar of its own. Absent when `unavailable`.
- `goals`: the same list `GET /api/plans` returns, from the same function.
- `thread: [{ day, entries, by, waiting }]` (the wire name stays), one per household day in the window with
  any entry, built by the function that builds `GET /api/thread`'s `days` in the Today spec, unnarrowed:
  `entries` is that day's `total`, `waiting` its `waiting`, `by` its `by`. No second count is defined here.
- A calendar change entry's `open`, in the Today spec's thread, grows to `{ calendar: Day, key?: number }`:
  the `evt_id` of the appointment the row is about, when its op carries one.
- `money: MoneyRow[]`, or null with no live budget.

**Money on a day.** What exists: `fixedCharges` finds payees that bill once a month, in two months or more, at
about the same amount, and `pace` gives each envelope `available` and `stillExpected`, the typical amounts of
its fixed charges not yet landed this month. What does not exist: any due day. An envelope has a template and
a `basis` with no anchor date; a sinking goal has a month; and `analytics.ts` projects a month-end total,
never the day an envelope empties. So:

- `FixedCharge` gains `lastDate`, the day of its latest receipt. A bill's day in a month is that day of the
  month, held to the month's last day. This is when it billed last time, which is all the app knows.
- A new pure function beside `pace`, sharing its two maps: per envelope, the fixed charges it expects that
  have not landed in the month, each `{ payee, typical, day }`. Their sum is the envelope's
  `Pace.stillExpected`, so the two cannot disagree.
- For each live budget whose current month is open (the walk `budgetNotices` makes): one `bill` row per such
  charge on its day, which may have passed; and, on `ctx.today`, one `short` row per envelope where
  `Pace.available < Pace.stillExpected`. In a later month inside the window, every fixed charge an envelope
  has taken before gets a `bill` row on its day, with no figures from a month not yet open. Earlier months get
  nothing: those are receipts.
- `MoneyRow` is `{ day, kind: 'bill' | 'short', budget, budgetLabel?, envelope, label, payee, bills, expected,
  billDay, left?, over?, short }`, amounts as the money rail sends them (`fmt`): `expected` is the charge's
  `typical` on a bill row and `stillExpected` on a short one, `left` and `over` are from `Pace.available`, and
  `budgetLabel` is sent only with more than one live budget.

## What is deleted

`legend()`, `#cal-legend`, `#cal-legend-phone`, the `.legend` and `.sw` CSS; the phone's hour grid
(`renderDay`'s `.dayview`, its `hourLabels('hrs')` and the `long` argument of `timedBoxes`, `evNode` and
`evSub`); the strip's `.dots`; `#cal-day-count` and "3 things" / "nothing on"; `sourceName`, and
`otherMember()` wherever the Calendar names a calendar's owner (the event's `owner` does); the desk hint
"Shows your calendar, Household, and the calendars you check for conflicts. Change which in Settings."; the
copy "Block nights", "Block these nights", "Unblock these nights", "A stay already confirmed cannot be
blocked", "Where it goes", "Plan (optional)", "Notes (optional)", the form's "Clashes with" and "Free
instead:" (a proposal card's words are the server's and stay) and "Due dates from your plans are still shown";
`#cal-panel` as where forms open on the phone; the phone's icon-only Synology button. `openEventForm`,
`openEventView`, `openHeld` and the block form keep their content and routes and are drawn in place.

## Copy rules

Sentences, Apple's spellings, no exclamation marks. Times are `clockOf` and days `keyWords`, in the
household's zone; amounts are the server's `fmt`. An average is "about". Money is never "due"; a plan is. The
small capitals in the when column are exactly ALL DAY, DUE, NIGHTS and BILL. A count is singular at one ("1
entry", "1 other thing", "1 person"). The form says "Overlaps"; only an accessible name says "clash". The app
never says "thread" to a member (the Today spec's rule): the chip is "Record" and the row is "The day's
record".

## Accessibility and the phone

Every row, cell, chip and day head is a real button or link with a 44px target (the arrows, "Today" and the
chips are drawn smaller and padded to it). A strip cell's name is the full date and every mark in words:
"Saturday 14 November, 4 things, a plan in progress, money, a clash, nights held", or "nothing on". A row's
name carries its time, whose calendar and its state words; a clashing row adds "clashes with another event",
so red is never the only signal. The bar and the overlays are groups of `aria-pressed` buttons; the month is
`aria-expanded`; the chosen day is `aria-current="date"`. Every form field has a label; error slots are always
rendered; live lines are `aria-live="polite"`. Escape closes an open form or the picker before anything else,
and focus returns to what opened it. A committed change always reloads the window. At 375 × 812 the first
field of a form opened in place is scrolled into the top half. Nothing depends on hover.

## Left to the builder

- CSS values within tokens.css; the boards' numbers (72px strip cells, 56px rows, 22px discs) are a guide.
- How the 42-day answer is kept beside the week's; how the day card and a form share `#cal-panel` on the desk.
- The new analytics function's name, `MoneyRow`'s field names, and the tests, shaped as `api/test/*.test.ts`.

## Calls I made (the owner to check)

1. **No due day exists, so a bill's day is read from its last receipt** (`FixedCharge.lastDate`: no new op,
   nothing kept by hand). Only a bill that has landed once a month, in two months or more, at about the same
   amount, appears; a quarterly or yearly bill, a new one and every sinking fund never do. The alternative was
   a "due on the" field on the envelope page.
2. **"Projected to run out before its bill" became "has less left than the bills it still expects"**:
   `Pace.available < Pace.stillExpected`. `analytics.ts` has no model of the day an envelope empties.
3. **Money is never called "due".** The row says BILL, the payee and "about $146".
4. **The bar filters by calendar and nothing else.** Under Bob, only what is on Bob's calendar shows. A
   board's note has a pressed person also bring their plans and entries; ruling 3 and honest counts decided.
5. **Money and the record row ignore the calendars bar and are not in the count**: neither is on a calendar.
6. **When five marks apply on the phone, the hatch is the one left out.**
7. **A goal chip narrows plan rows only**, and the chips list every goal that exists, as Plan does.
8. **"Also has" reads "2 other things"**, not "2 Household things": one form for any mix of calendars.
9. **Filtering and counting are the page's**, over a window raised to 42 days; no `who=` or `kinds=`.
10. **Notes stay on the Add form.** The board omits them; the server takes them and Change shows them.
11. **No place or person under an event's title.** The boards show both; the app reads neither.
12. **Proposed, moved and off-calendar rows say so in a second line.** The boards show none of the three.
13. **A linked block is drawn from the log when the NAS is out of reach**, as due dates are.
14. **The desk has no month picker**, and its day head opens the day's card in the panel above the grid.
15. **Keep nights is hidden on a past day and a held night; a stay's row opens its request's card on Today.**
16. **A deep link to a hidden row draws that visit under Everyone** without changing the kept person.
17. **A clash is the server's flag, and a filter never clears it** (orchestrator's call): the outline, dot and
    words stay; the heading needs two rows showing; "also has" names hidden clashing rows first.
18. **A plan's due date or block is one Household row wherever its event sits** (orchestrator's call).
19. **Today calls `openCalendarAt` from exactly three places**, and a calendar change entry's `open` gains
    `key` (orchestrator's call). There is no search hit for an event.
20. **The record row's numbers and names are the Today spec's own function and helper** (orchestrator's call).
21. **The app says "Record", never "thread"; Household is one more `peopleBar` entry, its flag cleared inside
    `pressPerson`; `householdDisc()` and the goal chip row are defined here** (orchestrator's calls).

## Mockup

The boards are on the owner's private canvas "Calendar, as a day" (claude.ai artifact
`PB6RsPTZ33w9cdAAHKZpKz`; six boards: Day, Week, DayFiltered, New, Month, Desk). Static copies are not in the
tree; the words above are the contract. Wrong in them:

- *All of them* use the household's real names, say "Thread" for "Record", show a place and a person under
  event titles (Call 11), link with addresses where the page links by function, and draw controls under 44px.
- *Day, Month, Desk:* the money row's "due", group name and "funded" figure (Calls 1 to 3).
- *Day, Week, New, Desk:* a hatch on the morning a stay leaves; the code holds the nights before it.
- *DayFiltered:* predates the reading of ruling 3 in Call 4; its "also has" wording (Call 8); its strip counts
  one thing on a day where the pressed calendar has none.
- *New:* no Notes field (Call 10); the overlap line's dash is "to" here.
