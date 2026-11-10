# The Calendar as a day page

**Status:** design, for review. Agreed with the owner on 2026-11-09. Release 0.9.0, the third of three, built
after "Plan by area" (0.7.0) and "Today as day cards" (0.8.0). It uses by name, and does not specify again,
their people bar, member discs, state glyphs, goal flag and chips, any-state goal list, lanes, day cards and
deep links. The owner changed the ruling on money the same day: the Bills parts are that change. In its
examples Alex is the viewer, Bob and Casey the other members, Dana a friend who stays.

## Intent

On a phone the Calendar is the desk's week grid cut down to one column: fourteen hours at 52px each, with a
legend under it to explain the shapes (five swatches; eight on the desk, nine where friends book). The strip
of days above it shows coloured dots that say whose calendar has something, never how much or what. A plan due
on Saturday is a dashed box with no state; a bill is not there at all.

The owner ruled that on the phone the day is rows, not an hour grid. The week is a strip with marks under each
date; the chosen day is one card of plain rows that read *when, whose, what, a figure*; and what Plans, Budget
and the record have on that day sits in the same rows. The legend goes because nothing is left to explain: a
row's disc is the bar's, a plan carries its state glyph, dashed is a marker, hatched is held nights, red is a
clash. The desk keeps its grid and gains the same marks.

On money the owner ruled twice, the second time with: "we should have a due date for bills (or Auto Pay date
or pay by date, etc.)", though "some percentage of the time (probably the majority) we won't have a due date,
as much as a receipt that it was paid for a particular month." So a bill may carry a date a member sets, its
last receipt gives its day when it has none, and a receipt is what says it is paid. His bar: "I don't want us
to keep trying to curate bespoke labels and data lines." Each numeral here names its function.

## Goals

- The phone page is a strip of seven days with marks and the chosen day as one card of plain rows.
- Every mark and every count is computed from the rows the card would draw, by one page helper, so the strip,
  the month, the bar and the desk's day heads cannot disagree with the card.
- A plan's due date and blocks carry the plan's state glyph, owner, goal and area, and open its card.
- A bill is one row per period: on the date a member set on the envelope's page, else on the day of its last
  receipt, and once paid on the day of that receipt (ruling 21, as changed).
- The day's record is one row that opens Today (ruling 25).
- Adding is the card's last row, opened in place, with what it overlaps and when is free (ruling 23).
- The legend is deleted; the desk keeps its grid; with no calendars the page draws what the log holds.

## Non-goals

- No hour grid on the phone. No month view of events: the month is a picker. No month picker on the desk.
- No new calendar op: `propose_event`, `POST /api/calendar/events`, drift and booking are unchanged. A change
  made in place still writes the Today spec's `calendar.appointment.change`, as it has since 0.8.0.
- No date an envelope "runs out". No sinking fund on the calendar (a goal by a month has no day) and no Bills
  section on a savings envelope. No weekly or fortnightly bill.
- No reminders or notifications for a bill; no event written to the Synology calendar for one; no reading due
  dates off statements; no paying anything.
- No event location or attendee: the app does not read them from the NAS (`CalEvent` has neither).
- No filtering on the server (`who=`, `kinds=`). No drag, no editing an event the app did not make, no writing
  to another member's calendar.

## Anti-goals

- A numeral in the strip, the month, the bar or a desk day head that is not the rows the card draws.
- A date word on a money row that no member set: a receipt's day is never "due". "Late", "overdue" or red
  because a date passed with no receipt: receipts arrive when someone imports them.
- A filter that hides a row silently. A legend that comes back as a key, a footnote or a tooltip.
- Two forms open at once, or a form that opens somewhere other than the row that asked for it.
- Household, pressed here, changing who is pressed elsewhere. A blank page because the NAS did not answer.

## The phone page

Under 1040px of the page container, as now. `#calendar`, top to bottom.

**Head.** "Calendar"; under it the month as a button with a chevron and `aria-expanded` ("November 2026", the
chosen day's); at the right Previous week, "Today", Next week. Today loads this week, chooses today and closes
the month picker. An arrow's week chooses today when it holds it, else its Monday.

**The calendars bar** (ruling 3). The Plan spec's `peopleBar`, given calendars as its `{ key, label, n }`
entries: `role="group"`, `aria-label="Whose calendar"`. "Everyone" with no count; then each member, the viewer
included, in the bar's order, whose own calendar has a row in the window, by name with that count; then
Household, one more entry with a key of its own, when it has any. A row is on a member's calendar when its
event's `owner` is that member. A plan's due date or block (`kind` `due` or `block`) is one Household row
wherever its event sits: its `owner` is not used, and it is counted once, under Household. Held nights and
anything proposed for the household are Household rows too. A count is those rows in the window (the week; the
picker's 42 days while it is open), after the Plans toggle and the goal chip. A member with no calendar of
their own, or one the viewer has not ticked in Settings, has no entry; nor has a calendar the viewer checks
that is no member's, which shows under Everyone only. The bar needs two entries after Everyone.

Who is pressed (ruling 4): the Plan spec's pressed person is the page's shared state; this page adds one flag
of its own, Household pressed. Pressing Everyone or a member calls the Plan spec's `pressPerson`, to which
this release adds one line: it clears the flag, which is how a press on any tab clears it. Pressing Household
sets only the flag; a household switch and sign-out clear it too. When the shared person has no entry here,
Everyone shows pressed and the kept choice stays.

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
3. **`$`.** When Budget is on and `money[]` has a row for that day: the faint ink when every one is `paid`,
   the caution colour when one is not, the problem colour when one is `short`. A date passed with no receipt
   changes no colour. The calendars bar does not change the mark: money is on nobody's calendar.
4. **Clash dot.** Red, when a shown timed row that day has `clash`. The flag is the server's, set by
   `markClashes` across every calendar read, before the page filters.
5. **Hatch.** When a shown row that day has `held`. A stay from Friday to Sunday holds Friday and Saturday.
   Four marks fit a phone cell: when all five apply the hatch is left out and stays in the button's accessible
   name. The desk's day heads show all five.

**The month picker.** Pressing the month replaces the strip with a grid: Mon to Sun heads, then 42 days from
the Monday on or before the 1st, the same cells and marks, other months' days faint. The arrows become
Previous month and Next month. Pressing a day chooses it and closes the picker onto its week; the month again,
or Escape, closes it unchanged. The day card stays below; the grid is never a view of events. While it is open
the window is its 42 days, asked for in one call.

**The day card.** A `section` labelled by its heading: the long weekday and the date ("Thursday 12"), with a
small "Today" in the accent ink on today. At the heading's right, one phrase per group of overlapping clash
rows with two or more rows showing, in time order, in the problem colour, joined by a middle dot: the number
showing and the time the overlap begins, which is the second row's start ("2 at 9:00"). A shown row whose
clashing partner is hidden keeps its red outline and its accessible words, and the day keeps its dot: a filter
never makes a real clash look clear.

Rows are a five-column grid: when (60px), a 22px slot, what, a figure, a chevron; 56px tall or more. In order:

1. *Money*, while Budget is on: one row per bill per period, the Budget lane's icon in the slot, the
   envelope's name over the bill's. *Not paid, dated:* on its date, reading the kind a member set, "DUE",
   "AUTO PAY" or "PAY BY"; the figure "about $146" when the receipts give a typical amount, none when they do
   not; once the day has passed the second line adds " · no receipt yet", in its ordinary ink. *Not paid,
   undated:* on the day of the month of its last receipt, reading "BILL" and "about $146". *Paid:* on the day
   its receipt landed, reading "PAID" with the receipt's amount ("$143.20"), in the soft ink; the unpaid row
   is gone. On today, also one row per envelope with less left than the bills it still expects this month: the
   first such bill's word over its day ("Mon 16"), the envelope's name over "Example Power, about $146" ("2
   bills, about $246"), and "$14 left" or "$20 over" in the problem colour, which those bills' own rows then
   add to their second line. With more than one live budget the second line leads with the budget's name. A
   bill's row opens the envelope's page at Bills; today's row at its cover when over, else at Bills.
2. *A plan's due date*, by title. "DUE"; the plan's state glyph; the title over one meta line: the owner's
   small disc, the goal flag and goal when it has one, the area. A dashed provisional outline; the accent rail
   while doing; done softens the title, with the check and a good-colour outline. Opens the plan's card.
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
6. *The record*, while Record is on and the day has entries: the count over "entries" ("entry"); the Today
   tab's icon; "The day's record" over its writers, written with the helper and in the order of a closed day
   card's head (You, the other members in the household's order, Claude, guests by the list's name), then " ·
   2 waiting on you" when any wait. Opens Today on that day.
7. *Add*, then 8. *Keep nights* (both below).

On today, the now line (the accent line and the time, `role="img"`, "Now, 1:40 PM") sits among the timed rows
before the first that starts after now; after the last when all have started; not drawn with no timed rows. A
card with no rows above Add starts with one quiet line: "Nothing on."

**"Also has"** (ruling 24). One line under the card, `aria-live="polite"`, only when the pressed calendar or a
goal chip hides calendar rows from this day: "Friday also has 2 other things: Bins and Dana staying." The
number is the hidden rows; the titles are the first three (`listOf`), then "and 2 more", hidden rows that
clash with a shown one first. One reads "1 other thing". An overlay switched off is not reported.

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
`/api/calendar/events`); it is the decision, with no proposal. The window reloads and focus lands on the new
row, or on the "also has" line when the pressed calendar hides it. A refusal fills the error slot and keeps
the values. Cancel or Escape closes the form with focus back on the Add row.

This form only makes an event. `propose_event` stays Claude's: its open card is the "proposed" row, decided on
Today. A plan's due date and blocks are set on its card; "For a plan" makes the event that plan's appointment.

**Keep nights for the household.** A quiet last row with the hatch glyph, only where friends book with this
household (`settings.booking.on`), on today or a later day whose night is not already held. It opens in place
what "Block nights" opens now: the same heading; First night (the card's day) and Last night; Why, required,
200 characters, placeholder "Family is here"; the line "Friends see these nights as taken, and never why.
Nights of a confirmed stay cannot be kept."; the error slot; Cancel and "Keep these nights". `POST
/api/bookings/block` is unchanged; its refusals show in the slot in the server's words. A kept row opens in
place what `openHeld` shows now: "Kept for the household: the nights of Fri 13 Nov to Sat 14 Nov", the reason
and who kept them, "Why open them again", Close and "Open these nights" (`DELETE /api/bookings/block/:id`).

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
shown." Add and the desk's New event are not drawn (Save needs the NAS); Keep nights stays. `missed` draws:
"Bob's calendar could not be read just now; the rest is shown."

## The desk

From 1040px. The grid is kept as it is: day heads, the all-day row, 7:00 to 21:00, seven columns, `timedBoxes`
with its side-by-side lanes and edge arrows, `nowLine`.

- *Head.* "Calendar" over the week in words ("9 – 15 November 2026", not a control); at the right Previous
  week, "This week", Next week, the calendars bar, then "New event", primary. Under it the overlays and goal
  chips, and at the right the quiet "Keep nights" (where friends book) and "Open in Synology Calendar".
- *Panel.* `#cal-panel`, above the grid, holds one thing: a day's card, a form or view opened from a box, the
  keep-nights form, or New event: the Add form with a "Day" field after What, starting on the chosen day.
- *Day heads* are buttons: weekday, date and the marks, with room for all five. Pressing one opens that day's
  card in the panel, with the phone's rows, Add, Keep nights and "also has" line; pressing it again closes it.
- *Boxes.* The three shades stay, and a box on another member's calendar names them from `owner`. A due date
  is dashed with its state glyph, "due" and its goal; a block has its glyph before the time; held nights are
  hatched. Money sits in the all-day row: an unpaid bill a caution-tinted box ("Electricity · about $146" over
  "due · Example Power", or "bill · …"), a paid one a sunken box ("Electricity · $143.20" over "paid · Example
  Power"), today's short one "Electricity · $14 left" over "due Mon 16". Proposed, moved and off-calendar
  boxes keep their looks and say so in words. A box opens what its row opens. Filters remove boxes as rows.
- The record row is in the day card only. There is no legend and no hint line under the grid.

## Bills, on the envelope's page

A bill is something an envelope pays, known by its payee. The envelope's page (0.6.0) gains a section,
`envSection('Bills', 'bills')`, between This month and Receipts, except on a savings envelope. It lists the
envelope's bills from `get_month`, dated ones first, then by name, one `envLine` each: the bill's name (its
last receipt's payee, or the name a member gave); under it, joined by " · ", what the receipts know ("about
$146", "last paid 14 Oct", or "no receipts yet") and its date when it has one ("Due on the 16th, every month",
"Auto Pay on the 16th, every month", "Pay by the 16th, every month"; for a longer period "Due on 14 February,
every quarter", "every six months", "every year"); and one action, "Set a date", or "Change" when it has one
(neither in a closed month). The last row is "Add a bill". With no bills the section starts "No bills in this
envelope's receipts yet." The action swaps the line for a form in place, headed with the bill's name ("Add a
bill" on the last row):

- *Name*, on Add a bill only: text, required, 60 characters, placeholder "Example Water".
- *Kind*: a group of three, "Due", "Auto Pay", "Pay by", starting on Due: a label, all three behave the same.
- *How often*: a select, "every month", "every quarter", "every six months", "every year": the figure
  control's periods from a month up, sent by the server's `Per` names.
- *Day of the month*, when every month: a whole number from 1 to 31, starting at the day of its last receipt.
  From 29 up a live line says "In a shorter month it falls on the last day."; for anything else, "A day from 1
  to 31." Otherwise *Next date*: a date input; the bill repeats from it.
- The error slot; then Cancel, "Clear the date" when one is set, and Save at the right; under a bill named by
  hand, a quiet "Remove this bill".

Save, Clear and Remove run `set_bill` approved in the same request (`approveNow`), as a figure saves: no
review and no reason, since no money moves. The page reloads with focus on the row's action; a refusal fills
the slot and keeps what was typed.

## Deep links

The page links by function, as `openBudgetAt` does; there are no addresses.

- **In:** `openCalendarAt(day, key?)`. It sets the chosen day, shows the Calendar and loads that day's week.
  With a key (an event's `evt_id`, a proposal's id, or a plan's id for a date drawn from the log) it scrolls
  that row to the centre, focuses it and tints it with `--accent-tint` until another day is chosen or a change
  redraws the card. If the pressed calendar, an overlay or a goal chip would hide the row, this visit draws
  under Everyone with that overlay on and the goal released; the kept person is not changed. A key no longer
  there opens the day untinted, with no message. On the desk the day's card opens in the panel. A late reply
  draws nothing. Today calls it from exactly three places: each row of the desk Yours calendar rail,
  `openCalendarAt(day, evt_id)`; the phone strip's calendar row, `openCalendarAt(today)`; and "Open the day"
  on a calendar change row, `openCalendarAt(day, key?)`.
- **Out:** a plan row uses the Plan spec's plan-card link, and Back returns to the Calendar on the same day
  and scroll. A money row calls `openBudgetAt(budget, envelope, focus)`, whose third argument grows from the
  `cover` flag to a focus key, `'cover'` or `'bills'` (true still means cover). The record row uses the Today
  spec's link to a day, with no entry; drift, proposal and stay rows its link to a card.

## The server

The Calendar itself adds no op and writes nothing. Bills add two ops and one tool. One endpoint grows; an old
page asks for a week and ignores what is added, and an old log needs nothing.

`GET /api/calendar?start=<day>&end=<day>`: the window may be 1 to 42 days (`WEEK_MAX_DAYS` goes from 8 to 42):
a week, or the picker's 42 days. The answer keeps `events`, `unavailable` and `missed`, and adds:

- On each event, `owner?: Actor`: the viewer for `mine`; for `partner`, the account the calendar's id begins
  with (the rule `ownedBy` reads) when that account is a member of the household; absent otherwise.
- `plan` grows to `{ id, title, state, owner, goal, area }`; `goal` is the Plan spec's label, or null.
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

**Bills in the log.** Two ops, restore scope `budgets`; in the Today spec's `laneOf` both are `budget` change
rows whose `open` is `{ budget, envelope }`.

- `bill.set { budget, envelope, bill, name, date }`. `bill` is the key: the fixed-charge key for a bill the
  receipts show (`chargeKey`, exported: the normalised payee, a bar, the category), or `normalisePayee(name)`
  and a bar for one named by hand. `date` is null (cleared) or `{ kind: 'due' | 'autopay' | 'payby', per:
  'month' | 'quarter' | 'half-year' | 'year', day?, on? }`: `day`, 1 to 31, with `month`; otherwise `on`, a
  day. Replay refuses an unknown budget or envelope, an empty `bill` or `name` and any other date shape. It
  keeps `{ envelope, key, name, date, since }` on the budget beside its envelopes (`envelope.define` replaces
  an envelope whole); `since` is the household day the date was given. `describe()`: "set Example Power in
  Electricity to due on the 16th, every month", or "cleared the date on Example Power in Electricity".
- `bill.remove { budget, envelope, bill }`: refused unless that bill was named by hand. `describe()`: "removed
  the bill Example Water from Utilities". `envelope.remove` drops the envelope's bills.
- A receipt part that lands in the envelope (a line of its `EnvelopeView`) is for a bill when
  `chargeKey(payee, category)` is its key, or when its normalised payee contains a hand-given name. A fixed
  charge whose payee contains such a name is that bill: one row, never two.
- `set_bill { budget, envelope, bill? | name?, kind?, per?, day?, on?, clear?, remove? }`: one write tool that
  returns a proposal, in `APPROVE_IN_ONE`, and `budget` in the Today spec's tool table. The page calls it
  approved; Claude calls it from the composer ("the power bill is due on the 16th") and its card is decided on
  Today. A `name` takes the envelope's bill whose payee contains it, else makes one by hand. Refused: a
  savings envelope, a date with a part missing, a clear with no date set, a remove of a bill the receipts show
  ("that bill comes from the receipts: clear its date instead"). Summary: "Example Power: due on the 16th,
  every month"; its effects say the same of the envelope, and "No money moves".
- `get_month`: each envelope gains `bills: [{ key, name, byHand, about?, lastPaid?, date? }]`.

**Money on a day.** `fixedCharges` finds payees that bill once in each month they are seen, in two months or
more, at about one amount (a steady quarterly or yearly bill too, once seen twice); `pace` gives each envelope
`available` and `stillExpected`. It has no date for a bill and no model of the day an envelope empties:

- `FixedCharge` gains `lastDate`. An envelope's bills are the fixed charges that have landed in it (the map
  `pace` builds) and the bills the log holds for it.
- *Paid.* A dated bill's dates are `day` in every month, or `on` and every 3, 6 or 12 months either side of
  it, each held to its month's last day. A receipt for it pays the date nearest the receipt's own day (the
  earlier on a tie); the first to do so is the payment. An undated bill's period is the calendar month, as
  `pace` counts `landed` now: its first receipt dated in a month pays that month.
- *Rows*, from one new pure function beside `pace`. A paid date or month: a `paid` row on the receipt's day
  with that part's amount. An unpaid date on or after `since`, or in the current month: a row of its kind on
  the date, with the fixed charge's `typical` as its `about` amount when there is one, and `noReceipt` once
  the day has passed. An undated fixed charge, unpaid in the current month, and in each later month of the
  window: a `bill` row on `lastDate`'s day of the month. Nothing else is drawn.
- `stillExpected` is redefined on that function, so the two cannot disagree: the typical amounts of the
  envelope's bills unpaid and expected in the month, an undated fixed charge every month, as now, a dated one
  only in a month a date of its falls in. Until a date is set, `pace` gives every number it gives today.
- The `short` row is drawn on `ctx.today` for each envelope, in each live budget whose current month is open
  (the walk `budgetNotices` makes), where `Pace.available < Pace.stillExpected`. It sums this month's unpaid
  bills only: one dated later is paid from a month not yet open, and one with no typical amount adds nothing.
- `MoneyRow` is `{ day, kind: 'due' | 'autopay' | 'payby' | 'bill' | 'paid' | 'short', budget, budgetLabel?,
  envelope, label, bill?, name, amount?, about?, noReceipt?, left?, over?, short, bills?, billDay?, billKind?
  }`. Amounts are text (`fmt`; `fmtExact` for a receipt); `left` and `over` are from `Pace.available`; the
  last three are a short row's count of bills and its first bill's day and kind.

## What is deleted

`legend()`, `#cal-legend`, `#cal-legend-phone`, the `.legend` and `.sw` CSS; the phone's hour grid
(`renderDay`'s `.dayview`, its `hourLabels('hrs')` and the `long` argument of `timedBoxes`, `evNode` and
`evSub`); the strip's `.dots`; `#cal-day-count` and "3 things" / "nothing on"; `sourceName`, and
`otherMember()` wherever the Calendar names a calendar's owner (the event's `owner` does); the desk hint under
the grid ("Shows your calendar, Household, …"); the copy "Block nights", "Block these nights", "Unblock these
nights", "A stay already confirmed cannot be blocked", "Where it goes", "Plan (optional)", "Notes (optional)",
the form's "Clashes with" and "Free instead:" (a proposal card's words are the server's and stay) and "Due
dates from your plans are still shown"; `#cal-panel` as where forms open on the phone; the phone's icon-only
Synology button. `openEventForm`, `openEventView`, `openHeld` and the block form keep their content and routes
and are drawn in place. Nothing on the Budget screen is deleted.

## Copy rules

Sentences, Apple's spellings, no exclamation marks. Times are `clockOf` and days `keyWords`, in the
household's zone; amounts are the server's text; an average is "about". The small capitals in the when column
are exactly ALL DAY, DUE, NIGHTS, AUTO PAY, PAY BY, BILL and PAID; on a money row DUE, AUTO PAY and PAY BY
appear only for a date a member set, and a day read from a receipt is BILL. A date gone by with no receipt
says "no receipt yet", never "late", "overdue" or "missed". A count is singular at one ("1 entry"). The form
says "Overlaps"; only an accessible name says "clash". The app never says "thread" to a member (the Today
spec's rule): the chip is "Record" and the row is "The day's record".

## Accessibility and the phone

Every row, cell, chip and day head is a real button or link with a 44px target (the arrows, "Today" and the
chips are drawn smaller and padded to it). A strip cell's name is the full date and every mark in words:
"Saturday 14 November, 4 things, a plan in progress, money, a clash, nights held", or "nothing on"; a red `$`
reads "money short". A row's name carries its time, whose calendar and its state words; a clashing row adds
"clashes with another event", so red is never the only signal; a money row's is its word, envelope, bill,
amount and "no receipt yet" when it says so. The bar and the overlays are groups of `aria-pressed` buttons;
the month is `aria-expanded`; the chosen day is `aria-current="date"`. Every form field has a label; error
slots are always rendered; live lines are `aria-live="polite"`. Escape closes an open form or the picker
before anything else, and focus returns to what opened it. A committed change always reloads. At 375 × 812 the
first field of a form opened in place is scrolled into the top half. Nothing depends on hover.

## Left to the builder

- CSS values within tokens.css; the boards' numbers (72px strip cells, 56px rows, 22px discs) are a guide.
- How the 42-day answer is kept beside the week's; how the day card and a form share `#cal-panel`; the new
  analytics function's name; the field names of `MoneyRow` and `bills`; how a budget keeps its bills in the
  state; the tests, shaped as `api/test/*.test.ts`.

## Calls I made (the owner to check)

1. **A bill may carry a date a member sets; with none, its day is read from its last receipt.** The kind is a
   label; the date is set on the envelope's page, with no reason (orchestrator's call).
2. **A dated bill is paid by the receipt nearest its date; an undated one by a receipt in the calendar
   month.** The month is all `pace` knows, but under it a bill due on the 1st and paid on the 31st reads "no
   receipt yet" for ever. `stillExpected` moves to the same function and changes nothing until a date is set.
3. **"Projected to run out before its bill" is "has less left than this month's unpaid bills".** A bill dated
   next month cannot be counted: that month is not open.
4. **An unpaid date is drawn only from the day its date was set, or in the current month.**
5. **"About" comes only from `FixedCharge.typical`**: a bill seen once, or twice in a month, has a date and no
   figure. **No weekly or fortnightly bill**: `fixedCharges` drops a payee with two charges in a month.
6. **One tool, `set_bill`, sets, clears and removes**: approved in one step from the page, a proposal from
   Claude (the orchestrator leaned yes). Adding a bill by name asks for its date in the same form.
7. **A bill named by hand matches a receipt whose payee contains its name**, and takes over the fixed charge
   that does. A savings envelope has no Bills section; a day with only paid rows shows a faint `$`.
8. **One row per bill per period, PAID replacing it; "no receipt yet" and no red for a date gone by; no
   reminders, no reading dates off statements, no paying, no event on the Synology calendar for a bill**
   (orchestrator's calls). The owner may want the last: it would put bills on the phone.
9. **The bar filters by calendar and nothing else** (ruling 3): a pressed person's plans stay Household rows.
10. **Money and the record row ignore the calendars bar and the count; with five marks the hatch goes.**
11. **A goal chip narrows plan rows only; "also has" reads "2 other things" for any mix of calendars.**
12. **Filtering and counting are the page's**, over a window raised to 42 days; no `who=` or `kinds=`.
13. **Notes stay on the Add form; no place or person sits under an event's title** (the app reads neither).
14. **Proposed, moved and off-calendar rows say so in words; a linked block is drawn from the log off line.**
15. **The desk has no month picker; its day head opens the day's card in the panel above the grid.**
16. **Keep nights is hidden on a past day and a held night; a stay's row opens its request's card on Today.**
17. **A deep link to a hidden row draws that visit under Everyone** without changing the kept person.
18. **A clash is the server's flag, and a filter never clears it** (orchestrator's call): the outline, dot and
    words stay; the heading needs two rows showing; "also has" names hidden clashing rows first.
19. **A plan's due date or block is one Household row; the record row's figures are the Today spec's; Today
    calls `openCalendarAt` from three places; a change entry's `open` gains `key`** (orchestrator's).
20. **The app says "Record", never "thread"; Household is one more `peopleBar` entry, its flag cleared inside
    `pressPerson`; `householdDisc()` and the goal chip row are defined here** (orchestrator's calls).

## Mockup

The boards are on the owner's private canvas "Calendar, as a day" (claude.ai artifact
`PB6RsPTZ33w9cdAAHKZpKz`), redrawn to this document, seven of them: Day, Week, DayFiltered, New, Month, Bills
(an envelope's page) and Desk. The words above are the contract. Beyond the household's real names:

- *Bills:* "A day from 1 to 31." is drawn under a good day (3); it is said only of a value that is not one.
- *New:* the chips read 5:30, 6:00 and 3:30 PM; `freeSlotsNear` offers no overlap, so 5:30, 3:30 and 6:30.
- *Desk:* the two clashing boxes print "clash" in their second line; here only an accessible name says it.
- *Accessible names:* DayFiltered's strip cells say the date and whose calendar, and Month's grid cells
  nothing, where every cell names its date and marks. Error slots are `role="alert"`, not polite.
