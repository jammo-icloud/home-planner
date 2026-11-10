# Carry-over ledger: Today, Plan and Calendar

Status: audit, for the owner. Written on 2026-11-10 against `site/index.html` as it stands and the three
specs of 2026-11-09 (Plan by area, Today as day cards, The Calendar as a day page). Nothing was changed.

## At a glance

Every row below is one thing a member can see or press on the three screens today. Each has one fate.
**Kept**: the spec describes it the same, by name or by an "as now". **Changed**: what it does survives in
another form, and the row says which, even when the spec's "What is deleted" names the old element.
**Deleted on purpose**: the spec removes what it does. **No home**: no section of any spec mentions it.

| Screen | Rows | Kept | Changed | Deleted on purpose | No home |
|---|---|---|---|---|---|
| Today | 121 | 62 | 30 | 8 | 21 |
| Plan (board and card) | 68 | 35 | 14 | 11 | 8 |
| Calendar | 69 | 32 | 29 | 3 | 5 |
| All three | 258 | 129 | 73 | 22 | 34 |

The No home rows that matter most, most important first:

1. **P21, the plan's title renames in place on its card.** It is the page's only way to rename a plan. The
   Plan spec rebuilds the card's head and lists Back, the crumb, the state buttons and the ask, not the title.
2. **P31, the chips row on the card** ("Add a chip", and × on each). The page's only way to add or take off
   a chip. The board's rows still show chips, so they would become read-only by accident.
3. **C46, the Day field on "Change this event".** The Calendar spec lists that form's fields and leaves Day
   out, so moving an appointment to another day would mean deleting it and adding it again. Its live overlap
   check is not listed either.
4. **T113 and T114, the no-budget and no-open-month prompts** ("Open it from the template", "Open Budget").
   The Today spec keeps the two flags on the wire and never says the page still draws the way forward.
5. **T18 and T19, a briefing kept in Drive**: the "Reading the briefing…" line and the three lines said when
   it cannot be read ("Sign in again to read the whole briefing." and two more).
6. **T12, Today reads itself again when the browser tab comes back into view.** One listener, registered at
   load, easy to drop with `loadThread`.
7. **T61, a friend's request that asks for nights kept for the household since**: the line that says so.
8. **T87, whose disc a Yours calendar row wears for another member's calendar.** It leans on `otherMember()`,
   which is wrong for three members and which the Plan and Calendar specs each delete only in part.
9. **T49, the asker's reason on an old ask's card.** The member asked decides on it and the spec's row drops it.
10. **T23 and T56, the plan crumb** ("on Fix the fence gate") on a question, a drift card and a member's own
    version of a card. The spec keeps it on a note only.
11. **P51, "Also in Today's thread"** under Between us: unmentioned, and it breaks the rule that the app never
    says "thread".

## How to use this ledger

A builder ticks every row as its fate is carried out, and a No home row is not ticked until the owner has
ruled on it. A reviewer rejects a release that leaves a Kept or Changed row undrawn.

Line numbers are approximate. In each ledger, a section named without a spec is that screen's own spec.
Where the current copy uses a long dash, the row writes "(long dash)". Alex is the viewer; Bob and Casey are
the other members; Dana is a friend who stays.

## Today

### Page furniture

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| T1 | Home Screen banner: "Put Home Planner on your Home Screen", two steps, "It opens full screen, like an app, signed in as you.", Done | markup ~1540; `homeBanner` ~1808 | opened from the Home Screen QR, not already on the Home Screen, not done on this device | Kept | The page (2) |
| T2 | Setup notes, the household's: one line each with an alert icon (a clock for a move under way) and at most one button to a row of Settings: "Choose a folder", "Choose another folder", "Choose a calendar", "Open This NAS". No button on a member's "Ask the owner" line, a move under way or the certificate line | `renderSetupNotes` ~2348; `setupNotices` in `setup.ts` | `GET /api/today` `setup` is not empty; never in the sandbox | Kept | The page (2), "as now" |
| T3 | Setup notes, the budget's: "3 envelopes still need a figure" with "Go to the first one"; "Groceries is short $12.00" with "Cover it"; led by the budget's name with more than one live budget | `renderSetupNotes` ~2363; `budgetNotices` | an open month has envelopes with no figure, or short | Kept | The page (2). See S19 |
| T4 | Filter group "Show": Everything, Mine, Theirs, Waiting; one pressed; each press reads the thread again | markup ~1553; listener ~3132 | always | Changed | Kinds and people (six kinds, then the people bar); Waiting on you. Named in What is deleted |
| T5 | "All budgets" checkbox: off, entries and cards of the other budgets are hidden and not counted | ~1559; ~3154; `inView` in `thread.ts` | always | Deleted on purpose | Kinds and people, What is kept ("every budget shows"); What is deleted |
| T6 | "Show earlier", 100 entries further up | ~1561; ~3155 | the answer's `before` is not null | Changed | Earlier days ("Show October", a month at a time) |
| T7 | Day heading, grey: "Thursday 12 November", by the device's clock | `renderThread` ~2398 | before the first entry of each day | Changed | A day card, The head; Anti-goals (the household's day) |
| T8 | Divider "New since you last looked" | `renderThread` ~2406 | after the entry at the read cursor, unless it is the last | Changed | A day card, The body (once, in the newest open day that has a new row; "3 new" on a closed head) |
| T9 | The read cursor moves when the composer comes on screen | observer ~3160 | Today showing, Everything pressed | Changed | A day card, The body (the last row of today's open card on screen, All and Everyone, no search) |
| T10 | The page opens scrolled to its bottom (not with the banner up) | `loadThread` ~2335 | every load but "Show earlier" | Deleted on purpose | The page ("opens at its top"); What is deleted |
| T11 | Today is read again on coming back from another tab of the app | `showView` ~11041 | every switch to Today | Kept | A day card, Open and closed ("survives a tab switch and the reload") |
| T12 | Today is read again when the browser tab becomes visible | `visibilitychange` ~3169 | Today showing | No home | Keep, as page behaviour beside the composer's rules; skip it while a form in a row is open, since today it wipes a half-typed reason |
| T13 | The whole thread is one polite live region | `#thread[aria-live]` ~1562 | always | Deleted on purpose | What is deleted (`#thread`); Accessibility names the three live lines that remain |

### The thread: briefing, questions, notes, changes

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| T14 | Briefing by-line "Claude · briefing for Household" ("the household" when the budget is not known), no time | `entryNode` ~2568 | `writtenBy` is claude | Changed | The briefing and Yours ("Claude · the day's briefing" with its time; a budget's own section keeps the old words) |
| T15 | By-line "Briefing · written without Claude" | `entryNode` ~2570 | `writtenBy` is fallback | Kept | The briefing and Yours |
| T16 | Briefing headline, alone when there is no write-up and no document | `entryNode` ~2572 | always | Kept | The briefing and Yours |
| T17 | Briefing write-up, cut after 420 characters with "Read all of it" | `clampBody` ~2260 | write-up longer than 420 | Changed | The briefing and Yours ("Read the whole briefing"; earlier days show the headline only); What is deleted (copy) |
| T18 | Briefing kept in Drive: "Reading the briefing…", then the words, read without a press and once for the page's life | `entryNode` ~2579; `readDocText` ~2284 | `body` is null and `doc` is set | No home | Keep: on today's card read it without a press and say "Reading the briefing…" meanwhile; on an earlier day read it on "Read the whole briefing" |
| T19 | Briefing in Drive that cannot be read, in the write-up's place: "Sign in again to read the whole briefing." (no NAS session), "The full text is on the old NAS." (gone), "The whole briefing could not be read just now." | `readDocText` ~2292 | the read fails | No home | Keep all three, in the write-up's place under the headline |
| T20 | Claude's cards inside the briefing's bubble | `entryNode` ~2587 | offers the briefing raised | Changed | Proposal cards in a row (a row each, from-line "From the day's briefing"); The server, Entries. See S25 |
| T21 | A member's words, right-aligned: "**You** asked · 7:52 AM" or "**Bob** left a note · 7:52 AM", device's clock | `entryNode` ~2592 | a question or a note | Changed | Rows, Note and Question (a row; the time at the right in household time) |
| T22 | Plan crumb "on Fix the fence gate" on a note, opening the card | `planCrumb` ~2907 | the note was left on a plan's card | Kept | Rows, Note |
| T23 | The same crumb on a question | `entryNode` ~2599 | asked from a plan's card | No home | Keep: after "asked Claude", as on a note |
| T24 | Answer: "Claude answered · as of 7:52 AM" (with the date when not today), then the words | `answerNode` ~2931 | the question was answered | Kept | Rows, Question ("as `answerNode` draws it now") |
| T25 | "Read the whole answer"; once read it stays open; or "Sign in again to read the whole answer.", "The full text is on the old NAS.", "The whole answer could not be read just now." | `answerNode` ~2935 | the answer is kept in Drive | Kept | Rows, Question (the link is named; the lines ride on "as now") |
| T26 | "Looked at this month, receipts." | `answerNode` ~2950 | the answer read with tools in `LOOKED` | Kept | Rows, Question |
| T27 | Unanswered: by-line "Claude", "Claude didn't answer this one.", "Ask again" (no button with no key) | `answerNode` ~2916 | a question with no answer | Kept | Rows, Question ("Ask again" included) |
| T28 | Claude's cards inside the answer's bubble | `answerNode` ~2952 | offers the answer raised | Changed | Proposal cards in a row (from-line "From your question at 1:22 PM") |
| T29 | Change line: "**Bob** moved $40 from Dining out to Groceries", the reason in quotes under it; a guest by the list's name | `entryNode` ~2622 | a direct change | Changed | Rows, Change (lane icon, disc, time, the `open` link, the budget's label) |
| T30 | Removed receipt: "2026-11-03 Corner Shop $12.40" with the badge "not in the ledger" or "back in the ledger"; "Put it back" while it is gone | `removedBlock` ~6199 | a `txn.remove` change | Kept | Rows, Change ("keeps its block, 'Put it back' and 'Seen it'") |
| T31 | Put it back form: "Put it in" (no envelope yet, then the categories), "Reason" ("Why it belongs after all"), "Show what this would do", then the effects, a button reading the proposal's summary, "Leave it". A refusal replaces the button's label | `askToRestore` ~6225 | "Put it back" pressed | Kept | Rows, Change. The refusal in a label is against Proposal cards' error-slot rule: say which wins |
| T32 | "Seen it" on a removed receipt | `entryNode` ~2629 | someone else removed it, the viewer has not seen it, it is still gone | Kept | Rows, Change; Waiting on you |
| T33 | "No reason was given for this." and the red rule down the line's left | `entryNode` ~2627; `.line.flag` | a removal with no reason (old logs only: a removal now needs one); the red rule is on every removal | No home | Keep the sentence where the quoted reason would be. The red rule may go: the block and "Seen it" mark the row |

### Proposal cards

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| T34 | Claude's card: title, effects, an amber rule at its left (red once its numbers moved) | `offerCard` ~2959 | an open offer under a briefing or an answer | Changed | Proposal cards in a row (its own row, dashed block, "Waiting", from-line); What is deleted (the left border) |
| T35 | Buttons in the order Approve, Not now, Adjust, Decline | `offerCard` ~2988 | waiting, numbers not moved | Changed | Proposal cards (Decline, Adjust, Not now, Approve); Call 12 |
| T36 | Adjust only on a move of money or an assignment; Decline always, even on a card gone stale | `offerCard` ~3004 | as said | Kept | Proposal cards |
| T37 | "The numbers have moved since this was suggested." and "Work it out again" in Approve's place | `offerCard` ~2990 | `waiting[].moved` | Kept | Proposal cards ("keep their words and rules"); Waiting on you (" · the numbers have moved") |
| T38 | Approve form: "Reason, as it will read in the record", starting from the suggestion's own (300), then "Approve: Move $120.00 from Travel to Groceries" and "Decline", which sends the reason typed | `approveForm` ~3044 | Approve pressed | Kept | Proposal cards (`approveForm` is named) |
| T39 | Adjust form: "Amount to move" or "Fund it at", "Reason", "Suggest this instead", "Cancel"; "Enter an amount in dollars", "It needs a reason" | `adjustForm` ~3062 | Adjust pressed | Kept | Proposal cards ("every other card's buttons and forms") |
| T40 | A refusal replaces the pressed button's label: "Approving needs a reason, the same as moving money", or the server's words | `actionButton` ~3026 | any card action fails | Changed | Proposal cards (an error slot, `role="alert"`, "never in a button's label") |
| T41 | Decided: "Approved by **you** · 8:14 PM (long dash) "The trip is paid for"", or "Declined by" | `offerCard` ~2968 | approved or declined | Changed | Proposal cards, decided (title, one line, " · " for the dash, the day when not the card's); Rows, a decision on a later day |
| T42 | "Replaced by a newer suggestion for the same envelopes." | `offerCard` ~2964 | status replaced | Kept | Proposal cards ("Other settled lines keep their words") |
| T43 | Put off: "Put off by **Bob**. It comes back if its numbers change." (the first sentence alone on a card with no budget) | `offerCard` ~2980 | put off and not waiting again | Kept | Proposal cards (settled lines) |
| T44 | A put-off card still lists its effects above that line | `offerCard` ~2976 | put off | No home | Keep: a put-off card can come back, so the reader should still see what it would do. The spec's "title and one settled line" would drop them |
| T45 | Put off, then its numbers moved: back with the moved line and "Work it out again" | `offerCard`; `stirred` in `offers.ts` | put off and the figures differ since | Kept | Waiting on you ("put-off cards whose figures have moved") |
| T46 | A member's own version: "**You** adjusted a suggestion · 7:52 AM", the crumb, the card | `entryNode` ~2612 | an adjusted card | Changed | Proposal cards ("**Bob** suggested", "In place of an earlier suggestion"); What is deleted (copy) |
| T47 | "Waiting for either of you" on a drift, Savings short, a request and a cancelled stay | ~2721, ~2761, ~2798, ~2836 | the card is open | Changed | Proposal cards (label "Waiting"); What is deleted (copy) |
| T48 | Old ask, to the viewer: dashed, "Waiting for you", the plan's title as a link, "Take it", "Decline"; then "Why not? Bob reads this", "Decline", "Cancel"; "Declining needs a reason" | `askCardNode` ~2650; `askAnswer` ~6665 | an open ask of the viewer | Kept | Proposal cards; Plan spec, The thread, old events and old clients |
| T49 | Old ask, the asker's reason: "Bob asked you to take it · "I am away that week"" | `askCardNode` ~2675 | an open ask | No home | Keep: the reason as the quoted line under "**Bob** asked you to take". The card's effects do not carry it |
| T50 | Old ask, to someone else: "Waiting on Bob", "You asked Bob to take it", no buttons | `askCardNode` ~2666 | an open ask of another member | Kept | Proposal cards ("Waiting on Bob") |
| T51 | Old ask settled: "Taken by **bob**", "Declined by **bob** (long dash) "why"", "The ask to bob lapsed", the crumb | `askCardNode` ~2654 | answered or lapsed | Kept | Proposal cards (settled lines, " · " for a dash); Plan spec, The thread |
| T52 | Drift card: dashed, title, effects, three buttons. Calendar: "Move the plan too", "Put the calendar back", "Leave both". Page: "Take the change", "Put the page back", "Leave both" | `driftCardNode` ~2698 | an open drift | Kept | Proposal cards ("a drift's three choices") |
| T53 | Drift chip with an alert icon, "moved" (calendar) or "edited" (page), and the card's amber ink | `driftCardNode` ~2719; `.provisional.drift` | an open drift | No home | Keep the chip beside "Waiting": it is the only thing that tells a calendar drift from a page drift before reading, and amber not red is the 2026-10-28 rule |
| T54 | Drift on an event deleted from the calendar: no "Put the calendar back" | `driftCardNode` ~2737 | `drift.deleted` | Kept | Proposal cards ("words and rules") |
| T55 | Drift on a page that cannot be read: no "Take the change", and "Put the page back" is the primary | `driftCardNode` ~2734 | `drift.unreadable` | Kept | Proposal cards ("words and rules") |
| T56 | Plan crumb on a drift card, on its settled line, and on a member's own version of a card | ~2722, ~2711, ~2615 | the offer is about a plan | No home | Keep: the crumb ends the row's sentence, as on a note. Only an ask's title is a link in the spec |
| T57 | Drift settled: "Moved the plan too, by **bob**, 8:14 PM" (also "Put the calendar back", "Left both", "Took the change made in Drive", "Put the page back", "Left the page as edited"); "…; it changed again since, and the newer card asks about it"; "…; let go when the plan was removed" | `driftCardNode` ~2702 | settled, replaced or let go | Kept | Proposal cards (settled lines) |
| T58 | Savings short: dashed, title, effects, "Seen it" | `savingsCardNode` ~2749 | open | Kept | Proposal cards ("Seen it") |
| T59 | Savings settled: "Seen by **bob**, 8:14 PM", "A newer balance came in since", "Put away by **bob**", then the summary | `savingsCardNode` ~2751 | settled | Kept | Proposal cards (settled lines) |
| T60 | A friend's request: dashed, title, effects, "Approve" (no reason asked), "Decline", "Suggest other dates" | `bookingCardNode` ~2780 | open | Kept | Proposal cards ("a request's Decline and 'Suggest other dates'") |
| T61 | On a request, a last line in the problem colour naming nights kept for the household since | `bookingCardNode` ~2803; `blockedOver` in `thread.ts` | the entry's `blocked` is set | No home | Keep: the last line of the effects, in the problem colour; keep `blocked` on the card entry |
| T62 | Request, Decline: "Reason (long dash) they will read it" (300), "Decline", "Back"; "Declining needs a reason: they will read it" | `bookingDecline` ~2871 | Decline pressed | Kept | Proposal cards. Copy rules say no dashes: reword the label |
| T63 | Request, other dates: "Arriving", "Leaving" (the dates asked for), "Why these instead (long dash) they will read it", "Suggest these dates", "Back"; three refusals | `bookingSuggest` ~2885 | "Suggest other dates" pressed | Kept | Proposal cards. The same dash |
| T64 | A refusal said above the buttons, `role="alert"`, the card left open | `bookingSend` ~2850 | approving, declining, suggesting or taking off fails | Kept | Proposal cards (error slot) |
| T65 | Approved after all with something left to do by hand: the card is drawn as decided and the words go in the page's error box | `bookingSend` ~2860 | a 502 whose message starts "approved" | No home | Keep: redraw the row as decided and say the words in the page's error box, as now |
| T66 | Request settled: "Approved by **bob**, 8:14 PM", "Declined by **bob** (long dash) "why"", "Replaced by a newer request", "Withdrawn by them", then the summary | `bookingCardNode` ~2782 | settled | Kept | Proposal cards (settled lines) |
| T67 | Cancelled stay: dashed, title, effects, "Take it off the calendar" | `releaseCardNode` ~2826 | open | Kept | Proposal cards |
| T68 | Cancelled stay settled: "Taken off the calendar by **bob**" or "Left on the calendar by **bob**", then the summary | `releaseCardNode` ~2828 | settled | Kept | Proposal cards (settled lines) |
| T69 | `data-offer` on every card, `data-drift` on a drift, `data-event` on entries and answers | ~2404, ~2716, ~2930, ~2961 | always | Kept | Deep links, In |
| T70 | "14 receipts to sort", "They are in no envelope yet, so no envelope counts them as spent.", "Sort them" (Budget, at the unsorted queue) | `unsortedItem` ~2549 | Waiting pressed and receipts are unsorted | Changed | Waiting on you (one row, "In no envelope yet"); What is deleted |

### The composer

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| T71 | A sticky bar at the foot that rests at the end of the page while a field in a card has focus | `.composer` ~746; listeners ~3143 | always | Kept | The composer. See S31 |
| T72 | Tray "2 waiting on you"; pressing it presses Waiting | ~1564; ~2411; ~3156 | something waits and Waiting is not pressed | Changed | Waiting on you; What is deleted |
| T73 | The field: two rows, 2,000 characters, hidden label "Ask Claude, or leave a note", placeholder "Ask Claude about the budget, or leave a note for each other" | markup ~1565 | always | Changed | The composer (placeholder "Ask Claude, or leave a note for the others") |
| T74 | "Leave a note", off while it posts | ~3108 | always | Kept | The composer |
| T75 | "Ask Claude", the primary; off with no key and while asking | ~3101; ~2413 | always | Kept | The composer |
| T76 | "Claude isn't set up on this server. Notes still work." | `renderThread` ~2414 | no key | Kept | The composer |
| T77 | "Asking Claude…" | `askClaude` ~3087 | while asking | Kept | The composer |
| T78 | "Claude couldn't answer: …", or a refusal or failure in the server's words | ~3092; ~3118 | the ask or the note fails | Kept | The composer ("a refusal or failure is said there") |
| T79 | The status slot is empty at rest and is not a live region | `#say-note` | at rest | Changed | The composer ("Goes into today"); Accessibility (polite) |
| T80 | After a send: the field empties (not after "Ask again"), the thread is read again and scrolls to the bottom | `askClaude` ~3090 | a note or a question went | Changed | The composer (today's card opens, the row scrolls in, the kind returns to All, "Left in today. It shows under Everyone.") |

### Yours

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| T81 | Eyebrow: the viewer's solid disc, "Yours · what the briefing was written from" | markup ~1580; `renderYours` ~2541 | the rails were read | Kept | The briefing and Yours ("Yours" alone on a phone with no briefing drawn) |
| T82 | On a phone Yours sits after today's briefing; with none, before today's first entry; else at the end | `placeYours` ~2429 | under 1040px | Changed | The briefing and Yours (a strip in today's card); What is deleted |
| T83 | On the desk Yours is a sticky second column | CSS ~790 | from 1040px | Kept | The page; The briefing and Yours |
| T84 | Calendar rail "Today and tomorrow": a disc, the title or "Busy", and "9:30 AM", "all day", "until 11:00 AM", or "Fri 9:30 AM" for tomorrow | `calendarRail` ~2487 | events today or tomorrow | Kept | The briefing and Yours ("its three rails in full") |
| T85 | On a phone every item of every rail is listed | `renderYours` | under 1040px | Changed | The briefing and Yours (one row a rail: the first item and "and 2 more") |
| T86 | A calendar row opens the plan's card when the event is a plan's, else the Calendar's week | `calendarRail` ~2493 | a row pressed | Changed | Calendar spec, Deep links, In (`openCalendarAt(day, evt_id)` for every row) |
| T87 | The row's disc: solid for the viewer's calendar, the house mark for Household, a ring with the other member's initial for any other, its hover title the calendar's name | `sourceDisc` ~2460 | every calendar row | No home | Keep the three shapes. The ring needs the owner's name: add `owner` to `GET /api/today` events as the Calendar spec does for the week, else use the calendar label's first letter. See S9 |
| T88 | "Bob's calendar could not be read just now." | `calendarRail` ~2498 | `missed` | Kept | The briefing and Yours ("an empty or unreadable rail shows its existing line") |
| T89 | Calendars out of reach: a calendar icon and "Sign in again to see your calendars." or the NAS's reason | `calendarRail` ~2499 | `unavailable` | Kept | The briefing and Yours (the same sentence) |
| T90 | "Nothing on your calendars today or tomorrow." | `calendarRail` ~2505 | nothing either day | Kept | The briefing and Yours |
| T91 | Plans rail "Plans that need you": the title and chips (the due day, "not on the calendar", "2 wks", "doing"); opens the card | `plansRail` ~2522; `railChips` ~2511 | the viewer's plans due within the week or in Doing | Kept | The briefing and Yours; Mockup ("the chips the plans rail draws") |
| T92 | Rail chips "asked Bob" (yours, asked of Bob) and "Bob asked" (asked of you) | `railChips` ~2513 | an open old ask | No home | Delete both. Safe: after 0.7.0 an asked plan is no longer in the asked member's rail (Plan spec, Reading), and an ask shows as its card on Today and the quiet line on the plan's card (Plan spec, Call 4) |
| T93 | "Nothing of yours is due this week, or in Doing." | `plansRail` ~2523 | no such plan | Kept | The briefing and Yours |
| T94 | Money rail "Money this month": "To assign" and its figure; each short envelope with "$14 left", or "$20 over" in the problem colour; opens Budget | `moneyRail` ~2529 | the budget's month is open | Kept | The briefing and Yours |
| T95 | "No budget has this month open yet." | `moneyRail` ~2530 | no budget, or no open month | Kept | The briefing and Yours |
| T96 | The rails could not be read at all: the thread still draws, Yours stays as last drawn (absent if never drawn), and the setup notes are not redrawn | `loadThread` ~2314 | `GET /api/today` fails | No home | Keep: the day cards never wait on the rails; on a phone the strip is left out of today's card |

### Search

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| T97 | A search box in the top bar of every screen, "Search the household" | markup ~1466 | always | Changed | Search (in Today's head; a button on a phone); What is deleted; Call 10 |
| T98 | Asked 250ms after typing stops, from two letters, only the latest answer drawn | listener ~2021; `searchAsk` ~1965 | typing | Kept | Search ("as now") |
| T99 | Hits in a list under the box: a kind badge (Plan, Briefing, Answer, File, Thread), a title, two lines of passage | `searchDraw` ~1942 | hits came back | Changed | Search (day cards of matching rows, then "Elsewhere") |
| T100 | The arrows move through the hits with focus kept in the box; Enter opens one | listener ~2029 | the list is open | Deleted on purpose | What is deleted (`searchMark`, `searchGo`); Search (a result row is a link) |
| T101 | Escape closes the list and keeps the words; closed, it clears the box | listener ~2032 | in the box | Changed | Search (Escape puts the days back) |
| T102 | A hit opens a plan's card, a file in a new tab, or Today at the entry, reading further up for an old one | `searchGo` ~1989 | a hit chosen | Changed | Search (a row links to its day; "Elsewhere" opens plans and files); Deep links, In |
| T103 | "Nothing in the household matches that." | `searchAsk` ~1977 | no hits | Kept | Search |
| T104 | "The search could not be done just now." | `searchAsk` ~1971 | the request fails | Kept | Search |
| T105 | "Sign in again to search briefings, answers and files too." | `searchAsk` ~1978 | Drive was not asked | Kept | Search |
| T106 | "Today doesn't show that one as it is filtered now." | `searchGo` ~2012 | the entry is not on the page | Deleted on purpose | What is deleted (`searchSay`); Deep links, In (All and Everyone are pressed for it) |
| T107 | The box empties on a household switch | `searchReset` ~1929; `enterApp` | a switch | Kept | Search. See S23 |
| T108 | Hits that arrive after the box is left wait for it to take focus again; leaving the box closes the list | ~1963; ~2057 | focus leaves | Deleted on purpose | What is deleted (`searchOpen`, `searchClose`) |

### Deep links in

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| T109 | From the Calendar, Today opens at a drift's or a proposal's card, scrolled to the centre and focused | `openTodayAt` ~10308 | a moved or proposed event pressed | Kept | Deep links, In. See S5 |
| T110 | A card not on the page: Today goes to Waiting to find it and puts the filter back later | `openTodayAt` ~10318; `endFilterDetour` ~11045 | the card is further up | Deleted on purpose | What is deleted; Deep links, In (the target's day is read) |

### States and errors

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| T111 | "Reading the log…" | `#loading` ~1532 | while the thread is read | No home | Keep: the one loading line the screens share, above the head |
| T112 | The thread could not be read: the server's words in the page's one error box | `showProblem` ~4661 | `GET /api/thread` fails | No home | Keep: the shared error box, above the head |
| T113 | No budget: a quiet panel, "This household has no budget yet." and "Open Budget" | `loadThread` ~2330; `showProblem` ~4675 | the answer's `noBudgets` | No home | Keep exactly as now, above the head. The spec keeps the flag and never says the page draws it |
| T114 | No open month: "Household has no plan for this month yet.", "Open it from the template" (then the effects and a button reading the proposal's summary; a refusal beside the button), "Open Budget"; with no envelopes, "Open Budget" alone | `loadThread` ~2331; `showProblem` ~4683 | the answer's `noOpenMonth` | No home | Keep exactly as now, above the head |
| T115 | "Nothing here yet. Ask Claude something, or leave a note." | `renderThread` ~2389 | no entries | Changed | A day card, The body ("Nothing yet today. Ask Claude something, or leave a note.") |
| T116 | "Nothing is waiting on you." | `renderThread` ~2391 | Waiting pressed, nothing waits | Deleted on purpose | What is deleted (copy); Waiting on you ("absent when nothing waits") |
| T117 | An answer that lands after the member moved to another screen does not show Today over it | `loadThread` ~2325 | a slow briefing | Kept | Left to the builder ("Every async continuation checks it is still wanted") |

### Keyboard and focus

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| T118 | Enter asks Claude; Shift+Enter is a new line | listener ~3125 | in the field | Kept | The composer |
| T119 | Enter is a new line with no key set and while an input method is composing; a press with the field empty puts focus in it and sends nothing | ~3104; ~3110; ~3126 | as said | No home | Keep all three guards in The composer |
| T120 | Focus goes into the first field when a card's form opens: Approve's reason, Adjust's amount, a request's reason or arrival day, an ask's "Why not?" | ~3058, ~3079, ~2881, ~2903, ~6686 | a card's form opens | No home | Keep; Accessibility names only the jump, the day head and search |
| T121 | A button is off while its request is out ("Seen it", "Leave a note", "Ask again" and every card action) | `actionButton` ~3030 and others | a request is out | No home | Keep: it is what stops a second press writing twice |

## Plan

The board, then the plan's card. The Plan spec rebuilds the board and the card's head, and says the card
below its head stays as it is.

### The board

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| P1 | Heading "Plan" | markup ~1732 | always | Kept | The board, Head |
| P2 | Filter group "Show": Both, Mine, Theirs (it reads "Bob's" when there is another member) | markup ~1733; `renderBoard` ~6575 | always, with one member too | Changed | The people bar and the shared helpers; What is deleted |
| P3 | "Show done": finished plans come back in Doing, struck through, with a "done" chip | ~1738; `planChips` ~6629; `.bcard.is-done` | pressed | Changed | The board (the done row); The Area page (Done); What is deleted |
| P4 | "New plan", the primary, with a plus | markup ~1740 | always | Changed | The board (the add row of each area); What is deleted |
| P5 | New plan form above the board: "What is it" ("e.g. Fix the back gate", 200), "Area", "Make it", "Cancel"; "Give it a name"; Escape closes it | `newPlan` ~6762; `inlineForm` ~6705 | "New plan" pressed | Changed | The board, the add row ("The new plan", Cancel, "Add it", focus back on the add row) |
| P6 | "On a shelf" in that form: "Not on a shelf", then every shelf and every plan, with its area | `newPlan` ~6769 | the form is open | Deleted on purpose | What is deleted (Shelves, page) |
| P7 | "Nothing is planned yet: anything the two of you mean to do goes here." | markup ~1743; `renderBoard` ~6587 | Both pressed and nothing planned | Changed | The board, Head ("Anything the household means to do goes here."); What is deleted |
| P8 | Desk column heads "Planning · no clock" and "Doing · the clock runs" | `laneLabel` ~6550 | from 1040px | Deleted on purpose | Goals ("No columns"); What is deleted |
| P9 | An area: its name and "5 plans" (open plans in view); drawn for every area, empty or not | `renderBoard` ~6594 | always | Changed | The board, An area (a heading link, "5 plans · 2 doing"; an empty area hides under a filter) |
| P10 | On a phone, "Planning" and "Doing" labels in each area and "Nothing in Doing in House." | `renderBoard` ~6605 | a lane is empty | Deleted on purpose | Intent; What is deleted (copy) |
| P11 | A plan as a card: its title, opening the plan's card | `boardCard` ~6657 | every open plan in view | Changed | The board, Plan rows (state glyph, title, meta, chevron; an accent rail in Doing) |
| P12 | Its chips: the owner's disc, free chips, the due day (dashed), blocks ("Sat 7 Nov, 2:00 to 3:00 PM"), "research" with Claude's mark, "$ Groceries · $40 left", "2 wks" from 14 days in Doing | `planChips` ~6626 | as each applies | Changed | The board, Plan rows (the same facts in a new order, then the goal flag) |
| P13 | The envelope chip turns to the problem colour when what is left is below zero | `planChips` ~6637; `.chip.money.over` | the envelope is over | No home | Keep on the row's meta: it is the board's only sign that a plan's envelope is overspent |
| P14 | Chip "asked Bob" on your own plan | `planChips` ~6632 | an open ask | Deleted on purpose | What is deleted; Call 4 |
| P15 | A plan asked of you: dashed, its title, "Bob asked you · "why"", "Take it", "Decline", with no chips and no owner's disc | `boardCard` ~6648 | an open ask of the viewer | Deleted on purpose | What is deleted (`boardCard`); The server, Reading; Call 4 |
| P16 | Shelf strip under an area: "**Kitchen refresh** · holds 3", opening the shelf's card | `renderBoard` ~6612 | a plan has plans under it | Deleted on purpose | What is deleted (Shelves, page) |
| P17 | The pressed filter and "Show done" last through tab switches, not a reload, and are not reset on a household switch | module state ~6446 | always | Changed | The people bar, Where the pressed person is kept |

### The card: its head

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| P18 | Back, "‹ Plan", always to the board | `renderCard` ~6854 | always | Changed | The plan's card, Head; Pages (returns where it was opened, to its scroll and its row) |
| P19 | Crumb "Plan › House", both parts opening the board | `renderCard` ~6858 | always | Changed | The plan's card, Head (the area opens its page) |
| P20 | The crumb's third part, the shelf | `renderCard` ~6867 | the plan sits on a shelf | Deleted on purpose | What is deleted (Shelves, page) |
| P21 | The title renames in place: a heading named "Fix the fence gate, rename" that becomes a text box (200) on a click or Tab; Enter or leaving keeps it; Escape puts it back; an empty or unchanged name writes nothing; a refusal goes to the error box with the box still open | `renderCard` ~6873 | always | No home | Keep as it is, between the crumb and the state row. Nothing else on the page renames a plan |
| P22 | "Waiting for you" block in the head with "Take it" and "Decline" | `renderCard` ~6914 | an open ask of the viewer | Deleted on purpose | What is deleted; The plan's card, Owner (a quiet line; it is answered on Today) |
| P23 | State buttons "Planning" and "Doing", one pressed | `renderCard` ~6926 | not a shelf | Kept | The plan's card, Head (each gains its glyph). See S33 |
| P24 | "Mark done", with a check | `renderCard` ~6941 | not done | Kept | The plan's card, Head |
| P25 | On a finished plan a "Done" chip stands where "Mark done" was, neither state button is pressed, and pressing one opens the plan again | `renderCard` ~6939 | done | No home | Keep: after 0.7.0 done plans are opened from the Area page, so this state is reached far more often |
| P26 | A shelf's card has no state buttons and no "Mark done" | `renderCard` ~6925 | the plan has plans under it | Deleted on purpose | Goals ("a former shelf is an ordinary plan") |
| P27 | Owner in the head: the disc and "You own it" or "Bob owns it" | `renderCard` ~6947 | always | Changed | The plan's card, Owner (a section above Notes, with "since" and Change) |
| P28 | "Ask Bob to take it" and its form: "Why Bob? They read this on the card, and it stays yours until they answer.", "Ask Bob", "Asking needs a reason" | `renderCard` ~6953 | the owner, another member exists, no open ask | Changed | The plan's card, Owner ("Hand it to Bob", at once, a word optional); What is deleted |
| P29 | "Due date" or "Change the due date", and its form: "Due", "Set the due date", "Cancel", "Pick a day" | `renderCard` ~6965 | always | Kept | Non-goals ("Due date and Block time too") |
| P30 | "Block time" and its form: "From", "Until", "Block it"; "Give it a start", "Give it an end", "A block ends after it starts" | `renderCard` ~6973 | always | Kept | Non-goals |
| P31 | The chips row: each free chip with a × ("Take off researching"); "Add a chip" becomes a box ("e.g. researching", 40), Enter adds, Escape puts the button back | `renderCard` ~6989 | always | No home | Keep as it is, under the state row. Nothing else on the page adds or removes a chip, and the board's rows show them |
| P32 | Chip "asked Bob" in that row | `renderCard` ~6999 | the owner's view of an open ask | Deleted on purpose | Call 4; The plan's card, Owner (the quiet line) |
| P33 | Chip "2 wks" in that row | `renderCard` ~7000 | 14 days or more in Doing | No home | Keep "2 wks" in the chips row. The Mockup section calls the board's "Doing for 19 days" wrong and says nothing of what the card shows |

### The card: its sections

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| P34 | Notes: a box saved on leaving it; "What this is, and anything worth remembering about it" | `renderCard` ~7027 | always | Kept | The plan's card ("keeps its sections"); Non-goals |
| P35 | "On this shelf": the plans under it, "holds 3", "Add an item" ("The item", "Add it") | `renderCard` ~7042 | the plan has plans under it | Deleted on purpose | What is deleted (Shelves, page) |
| P36 | Checklist: "2 of 5"; a tick and the step (struck when done) with "Remove"; "No steps yet."; "Add a step" opens "The next step" (200) and "Add"; Enter adds; Escape closes and puts focus back on the button | `checklistSection` ~7319 | always | Kept | The plan's card |
| P37 | Attachments: the count; each file with an icon by type, its name and size, "You · Thu 5 Nov", opening in a new tab; "Remove" asks "Why take quote.pdf off the card? It stays on the NAS." ("e.g. the old quote"), "Take it off", "Taking a file off needs a reason" | `attachmentsSection` ~7103 | files on the card | Kept | The plan's card |
| P38 | Files listed as plain names, not links | `attachmentsSection` ~7110 | the server keeps no files | Kept | The plan's card |
| P39 | "**Attachments are off.**" and the server's reason, with a lock | `attachmentsSection` ~7134 | no documents folder chosen | Kept | The plan's card |
| P40 | "**Sign in again to add files.** Files are kept on the NAS, and this sign-in has no NAS session." | `noFilesHere` ~7095 | a sandbox sign-in, or an upload answered 409 | Kept | The plan's card |
| P41 | Drop zone: "Drop files here, or choose them · up to 25 MB, kept on the NAS"; it lights while a file is dragged over; "Putting quote.pdf on the NAS…" | `dropZone` ~7145 | files can be added | Kept | The plan's card |
| P42 | "quote.pdf is over 25 MB, the most a card holds." | `dropZone` ~7155 | a file is too big | Kept | The plan's card |
| P43 | An upload that failed: "quote.pdf: " and the server's words, or "the upload did not reach the server"; files sent before it stay | `dropZone` ~7164 | an upload fails | Kept | The plan's card |
| P44 | Claude: what it found, newest first, each headed by its mark and "Research · as of 7:52 AM"; the whole text read in from Drive, or a line saying why not | `claudeSection` ~7368 | research on the card | Kept | The plan's card. See S13 |
| P45 | Claude's suggestions as cards with Approve, Not now, Adjust and Decline; decided ones plain | `claudeSection` ~7387; `offerCard` | research raised offers | Kept | The plan's card. See S6 |
| P46 | "Nothing from Claude on this card yet." | `claudeSection` ~7395 | no research | Kept | The plan's card |
| P47 | "Ask Claude about this card" (2,000) and "Ask Claude", which reads "Asking…"; Enter asks; a failure sits under the box with the question kept: "Claude couldn't answer: …" | `claudeSection` ~7396 | always | Kept | The plan's card |
| P48 | The box and the button off, "Claude isn't set up on this server." | `claudeSection` ~7433 | no key | Kept | The plan's card |
| P49 | Between us: each note with a disc, the name, "Thursday 12 November, 7:52 AM" and the words; "Nothing said about this yet."; "Leave a note"; Enter leaves it | `betweenSection` ~7441 | always | Kept | The plan's card. See S8 |
| P50 | Its placeholder "Leave a note for Bob about this" ("for each other" alone) | `betweenSection` ~7453 | always | Changed | The plan's card, Between us ("Leave a note about this") |
| P51 | Its heading note "Also in Today's thread" | `betweenSection` ~7466 | always | No home | Keep the pointer and reword it "Also in Today": the Today spec's Copy rules forbid "thread" |
| P52 | On a phone, one card under the title: the When rows, the Money rows, "Change the money" | `factsCard` ~7480 | under the desk's width | Kept | The plan's card; Non-goals (the mock's When line is not built) |
| P53 | Money: "Envelope" (its label, or "In Household; this month isn't open", or "None"), "Left this month", "Estimated cost", "At current funding · 3 months" | `moneyRows` ~7498 | always | Kept | The plan's card |
| P54 | Money form: "Budget", "Envelope" ("No envelope", "Groceries · $40 left"), "Estimated cost, in dollars" ("e.g. 4000"), "Save", "Cancel", Escape; "The estimate is a dollar amount, like 4000"; "Its envelopes can't be listed: …" | `moneyForm` ~7510 | "Change" pressed | Kept | The plan's card |
| P55 | People: initials, the name, the first phone number as a link to call (or the organisation), "Unlink" | `peopleSection` ~7208 | contacts linked | Kept | The plan's card |
| P56 | "No one is linked to this card yet." with "Link someone from Contacts"; "Link someone" in the heading once someone is | `peopleSection` ~7243 | as said | Kept | The plan's card |
| P57 | Contact search: "Search Contacts by name", results as you type (250ms), "Link" or "Linked", "Cancel", Escape; "No one in Contacts by that name."; "The address book is empty."; "Contacts can't be read: …" | `contactSearch` ~7263 | linking | Kept | The plan's card |
| P58 | "**Sign in again to reach Contacts.** The address book is on the NAS, and this sign-in has no NAS session.", in the search's place | `noContactsHere` ~7190 | a sandbox sign-in, or Contacts answered 409 | Kept | The plan's card |
| P59 | When: "Due" with "Clear"; "Blocks · None"; each "Block" with "Let it go" ("Why let it go? It comes off the Household calendar.", "Letting time go needs a reason"); the hint "A due date goes on the Household calendar as an all-day marker; a block, as time set aside." | `whenSection` ~7580 | always | Kept | The plan's card; Non-goals |
| P60 | "not on the calendar" beside a date, and "Kept on the plan, not on the Household calendar yet. It goes there the next time someone signed in to the NAS opens Today, or now:" with "Put it on the calendar" | `whenRows` ~7591 | a date kept on the plan with no event | Kept | The plan's card |
| P61 | History: "You moved it to Doing · Thu 5 Nov"; Claude's lines with its mark | `renderCard` ~7058 | always | Kept | The plan's card; The thread, old events and old clients (`plan.goal` joins it) |
| P62 | "Remove this plan": "Why remove it? The log keeps it, and your reason." ("e.g. we decided against it"), "Remove Fix the fence gate", "Removing needs a reason" | `renderCard` ~7068 | always | Kept | The plan's card (below its head) |
| P63 | After removing, the board is shown | `renderCard` ~7075 | the plan was removed | No home | Keep a landing and say which: where the card was opened from (`cardFrom`), focus on the area's heading. Pages says "except Remove" of the Area page only |

### States and errors

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| P64 | "Reading the log…" while the board or a card is read, and the page's one error box when either cannot be | `loadBoard` ~6558; `loadCard` ~6788 | loading, or a failed read | No home | Keep both, above the board, the Area page and the card |
| P65 | A plan that is gone: "no such plan" in the error box | `loadCard`; `card()` in `plans.ts` | a link to a removed plan | Kept | Pages, Deep links |
| P66 | A change the server refuses: its words in the error box, the card as it was; a typed box comes back on, still holding its text | `cardEdit` ~6801; `postFrom` ~6811 | any section's write fails | Kept | The plan's card ("keeps its sections") |

### Keyboard and focus

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| P67 | The card opens with the page scrolled to its top | `openCard` ~6782 | a card opens | Kept | Pages ("scrolls the window to the top once") |
| P68 | Escape closes any small form on the card (due, block, remove, a file's reason, money, contact search, a chip, a step); Enter sends the one-line boxes | `inlineForm` ~6737 and each section | a form is open | Kept | Pages ("Escape first cancels an open form"). See S30 |

## Calendar

### The bar

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| C1 | On a phone, the chosen day's month, "November 2026", as plain text | `renderDay` ~10508 | under 1040px | Changed | The phone page, Head (a button that opens the month picker) |
| C2 | "Previous week" and "Next week" | markup ~1756; ~10659 | always | Kept | The phone page, Head; The desk, Head |
| C3 | "This week" | markup ~1758 | desk only | Kept | The desk, Head (the phone gains "Today") |
| C4 | The week in words, as "9 to 15 November 2026" in the locale's order | `renderWeek` ~10462 | desk only | Kept | The desk, Head |
| C5 | "Block nights", with the hatch glyph, which opens and closes its form | markup ~1761; ~10614 | desk only, where friends book | Changed | Keep nights for the household (a quiet button on the desk, a last row on the phone); What is deleted (copy) |
| C6 | The way to Synology Calendar in a new tab: an icon alone on a phone, "Open in Synology Calendar" on the desk | markup ~1763; `renderWeek` ~10456 | DSM's public address is set | Changed | Foot (a text link on the phone); The desk, Head; What is deleted |
| C7 | "New event", the primary (a plus alone on a phone); pressing it again closes its form; drawn even with the calendars out of reach | markup ~1764; ~10939 | always | Changed | Adding to a day (the row "Add to Thursday 12"; the desk keeps "New event"; neither is drawn while unavailable) |
| C8 | One panel above the page where every form and view opens, scrolled into view | `#cal-panel` ~1766 | something is open | Changed | The phone page (in place, in the row); The desk, Panel; What is deleted |
| C9 | Desk legend: Mine, "Bob's, shared with you", Household, Due date, "Proposed, not approved", "Not on the calendar", "Moved, plan disagrees", Clash, and "Held nights: a stay, or kept" where friends book | `legend` ~10408 | desk | Deleted on purpose | What is deleted; Intent |
| C10 | Phone legend: Mine, "Bob's", Household, Due, Proposed | `legend` ~10415 | phone | Deleted on purpose | What is deleted |
| C11 | "Shows your calendar, Household, and the calendars you check for conflicts. Change which in Settings." | markup ~1774 | desk | Deleted on purpose | What is deleted |

### The week, on the desk

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| C12 | Day heads "Mon 9", today's date in a filled disc with `aria-current` | `renderWeek` ~10471 | desk | Changed | The desk, Day heads (buttons with the marks, opening the day's card in the panel) |
| C13 | The "all day" row; an event that covers several days spans their columns | `renderWeek` ~10480 | desk | Kept | The desk ("The grid is kept as it is") |
| C14 | The hours, 7:00 to 21:00, and today's column tinted | `hourLabels` ~10398; `.col.is-today` | desk | Kept | The desk |
| C15 | Timed boxes: side by side where they overlap, held to the grid with ↑ or ↓ where one runs past its edge, never under half an hour tall | `timedBoxes` ~10347 | desk | Kept | The desk ("its side-by-side lanes and edge arrows") |
| C16 | The now line, named "Now, 1:40 PM" | `nowLine` ~10388 | today, between 7:00 and 21:00 | Kept | The desk (`nowLine`) |
| C17 | A box's look: the viewer's, another member's (a ring), Household; a due date dashed; proposed dashed in the accent; kept on its plan, sunken; moved, a caution outline; a clash, a red outline; held nights hatched | `evClasses` ~10225 | each as it applies | Kept | The desk, Boxes ("The three shades stay"; "keep their looks") |
| C18 | A box's second line: "moved", then the time ("all day", "due"), the other member's name first, "proposed", "not on the calendar", "from Plan", "clash" | `evSub` ~10240 | every box | Changed | The desk, Boxes (the owner's name from `owner`; a due date with its state glyph, "due" and its goal; a block with its glyph; "clash" in the accessible name only) |
| C19 | A hover title in full words: "…, on Household", "proposed, not approved", "kept on the plan, not on the calendar yet", "moved on the calendar, and the plan disagrees", "clashes with another event" | `evNode` ~10287 | every box | Changed | Accessibility and the phone (accessible names; "Nothing depends on hover") |
| C20 | An event with no title reads "Busy" | `evNode` ~10281 | no summary | Kept | The phone page, The day card (row 4); Opening an event |

### The day, on a phone

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| C21 | A strip of seven days: weekday, date and a dot for each source that has something (a due date, the viewer's, another's, Household, kept on its plan, proposed as a hollow dot, held nights); today marked; the chosen day `aria-current` | `renderDay` ~10511 | phone | Changed | The phone page, The week strip (the five marks); What is deleted (`.dots`) |
| C22 | A strip button's name: "Saturday 14 November, 3 on" or "nothing on" | `renderDay` ~10521 | phone | Changed | Accessibility and the phone (the date and every mark in words) |
| C23 | Choosing a day redraws with no fetch | `renderDay` ~10523 | a day pressed | Kept | The phone page, The week strip |
| C24 | The day as the page's heading, "Saturday 14 November", with "3 things", "1 thing" or "nothing on" | `renderDay` ~10528 | phone | Changed | The phone page, The day card ("Thursday 12", "Today", the clash phrases, "Nothing on."); What is deleted |
| C25 | All-day boxes above the hours, with a longer second line: "all day · Household", "due · Plan › Fix the fence gate", "kept for the household by you", "a friend staying" | `renderDay` ~10532; `evSub` | phone, all-day events | Changed | The phone page, The day card (rows 2, 3 and 4) |
| C26 | The hours, 7:00 to 21:00, with timed boxes reading "4:30 PM to 5:30 PM" | `renderDay` ~10538 | phone | Changed | The phone page, The day card (row 5, timed rows); What is deleted (the hour grid) |
| C27 | The now line across the phone's hours | `renderDay` ~10541 | today | Changed | The phone page, The day card (among the timed rows) |
| C28 | A week arrived at by an arrow chooses today when it holds it, else its Monday | `loadCalendar` ~10426 | the week changes | Kept | The phone page, Head |
| C29 | The week on screen, and the chosen day, are remembered while the member visits other tabs | `calWeek`, `calDay` ~10164; `showView` ~11026 | coming back to Calendar | No home | Keep: coming back shows the week and day that were left. Only "Today" and a deep link move them |

### Forms and views

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| C30 | What a press opens, in this order: nights kept, their view; a moved event, its card on Today; a proposed one, its card on Today; one made here that the viewer may change, the form; a plan's date or block, the plan's card; any other, a read-only view | `evOpen` ~10262 | a box pressed | Kept | The phone page, Opening an event |
| C31 | A friend's stay cannot be pressed | `evOpen` ~10271 | held nights of a stay | Changed | The day card (row 3: it opens its request's card on Today); Call 16 |
| C32 | New event: "What" (required, 200, "Dentist"), "All day" (hides the times), "From" and "To" (the next whole hour today, from 9:00 to 22:00; 9:00 on another day; an hour long) | `openEventForm` ~10710 | "New event" pressed | Kept | The phone page, Adding to a day |
| C33 | Its "Day" field: a date, not before today, starting on the chosen day | `openEventForm` ~10734 | new | Changed | Adding to a day (the row's own day on a phone; "Day" after What on the desk) |
| C34 | "Where it goes": "Household" or "Alex's calendar" | `openEventForm` ~10754 | new | Changed | Adding to a day ("On": "Household" and "Alex's", the second only when `mine`); What is deleted (copy) |
| C35 | "Plan (optional)": "None", then "Fix the fence gate · House" | `openEventForm` ~10780; `eventPlans` ~10697 | new, and a plan is in Planning or Doing | Changed | Adding to a day ("For a plan"). See S15 |
| C36 | "Notes (optional)", 2,000 | `openEventForm` ~10789 | always | Changed | Adding to a day ("Notes") |
| C37 | "Nothing else at that time on Alex's calendar and Household."; "There is no calendar to check it against yet." | `check` ~10817 | 300ms after a time changes, nothing overlaps | Kept | Adding to a day |
| C38 | "Clashes with Household · Swim practice 4:30 PM to 5:30 PM" ("something" for an untitled one) | `check` ~10822 | an overlap | Changed | Adding to a day ("Overlaps **Swim practice**, 4:30 PM to 5:30 PM"); What is deleted |
| C39 | "Free instead:" and chips reading a start and an end, each filling From and To | `check` ~10826 | an overlap and free slots | Changed | Adding to a day (up to three chips named "Free from", a start time each); What is deleted |
| C40 | "Sign in again to check for clashes."; "Clashes could not be checked just now." | `check` ~10841 | a 409; any other failure | Changed | Adding to a day ("…check for overlaps."; "Overlaps could not be checked just now.") |
| C41 | Nothing is said while the times do not read yet, such as an end before its start | `check` ~10840 | the check answers 400 | No home | Keep the silence: under the spec's "any other failure" this case would say "Overlaps could not be checked just now." while the member is still typing |
| C42 | "Save", which is the decision with no card, and "Cancel" | `openEventForm` ~10853 | always | Kept | Adding to a day |
| C43 | A refusal on Save goes to the page's error box above the calendar, and Save comes back on | `openEventForm` ~10894 | Save is refused | Changed | Adding to a day (the form's own error slot, the values kept) |
| C44 | After Save the panel closes, that day is chosen and its week is read | `openEventForm` ~10891 | saved | Changed | Adding to a day (focus lands on the new row, or on the "also has" line) |
| C45 | "Change this event": What, All day, From, To, "Ends on" when it spans days, Notes (without the app's own first line), "On Household" as words, "For Plan › Fix the fence gate" as a link to the card, "Save", "Delete", "Close" | `openEventForm` ~10710 | an event made here, not proposed, not on a calendar only checked | Kept | The phone page, Opening an event |
| C46 | On "Change this event": the "Day" field, and the live overlap check that leaves out the event itself | `openEventForm` ~10734; `check` ~10813 | changing an event | No home | Keep both. Opening an event lists the fields and omits Day, while What is deleted says the form keeps its content: the two disagree, and without Day an appointment moves to another day only by deleting it and adding it again |
| C47 | Delete asks "Take it off the calendar for good?" with "Delete it" and "Keep it"; focus goes to "Delete it", and back to "Delete" on "Keep it" | `openEventForm` ~10858 | "Delete" pressed | Kept | Opening an event |
| C48 | Read-only view: the title or "Busy"; "Thu 12 Nov, 4:30 PM to 5:30 PM" (its days when it spans them, "all day"); "On Bob's calendar, shared with you" or "On Household"; its notes; "It is on a calendar shared with you, so only its owner changes it." or "It was not made in Home Planner, so it is changed where it was made."; "Open in Synology Calendar" when the address is set; "Close" | `openEventView` ~10907 | any other event on a calendar | Kept | Opening an event; What is deleted (it keeps its content) |
| C49 | Nights kept, opened: "Kept for the household: the nights of Fri 13 Nov to Sat 14 Nov" ("the night of" for one); ""Family is here" · kept by you. Friends see these nights as taken."; "Why open them again" (required, 200); "Close" | `openHeld` ~10620 | kept nights pressed | Kept | Keep nights for the household |
| C50 | "Unblock these nights" | `openHeld` ~10635 | that view | Changed | Keep nights for the household ("Open these nights"); What is deleted (copy) |
| C51 | Keep nights form: "Keep nights for the household"; "First night" (the chosen day, or today when that has gone) and "Last night" (never before the first); "Why" (required, 200, "Family is here"); "Cancel" | `openBlockForm` ~10573 | "Block nights" pressed | Kept | Keep nights for the household |
| C52 | Its hint ending "A stay already confirmed cannot be blocked." and its button "Block these nights" | `openBlockForm` ~10590 | that form | Changed | Keep nights for the household ("Nights of a confirmed stay cannot be kept."; "Keep these nights"); What is deleted |
| C53 | After keeping nights the first night is chosen and its week is read | `openBlockForm` ~10602 | saved | No home | Keep: the card redraws on the first night, where the new hatched row is |
| C54 | A refusal of keeping nights, opening them again or deleting an event goes to the page's error box | ~10606; ~10650; ~10870 | the server refuses | Changed | Keep nights for the household ("show in the slot in the server's words"); Accessibility (error slots) |
| C55 | One thing is open at a time; opening another takes its place | `#cal-panel` | always | Kept | Opening an event; Anti-goals |

### States and errors

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| C56 | Calendars out of reach: a calendar icon and "Sign in again to see your calendars. Due dates from your plans are still shown." (or the NAS's reason first) | `loadCalendar` ~10439 | `unavailable` | Changed | Foot, and when the calendars are out of reach ("Plans' dates, held nights, money and the record are still shown."); What is deleted |
| C57 | "Bob's calendar and Family could not be read just now; the rest of the week is shown." | `loadCalendar` ~10443 | `missed`, one calendar or several | Changed | Foot ("…; the rest is shown."). The spec's example names one calendar: keep the list |
| C58 | With no calendars the page still draws due dates and blocks from the plans, held nights and what open cards ask for | `weekEvents` in `calendar-view.ts` | no NAS session, or the NAS refuses | Kept | Goals; Foot |
| C59 | A date or a block kept on its plan with no event: a sunken box, "not on the calendar" | `evClasses`; `weekEvents` ~272 | `offCalendar` | Kept | The day card (row 5, "not on the calendar yet"); The desk, Boxes |
| C60 | What an open card asks for: a dashed box, "proposed"; one for another member's own calendar is not drawn | `weekEvents` ~317 | an open `propose_event` the viewer may see | Kept | The day card (row 5, "proposed, not approved"); Adding to a day |
| C61 | An event moved on the calendar: a caution outline, "moved" | `evClasses`; `weekEvents` ~245 | an open drift | Kept | The day card (row 5, "moved on the calendar") |
| C62 | Two timed events that overlap: a red outline on both | `markClashes` | the server's `clash` | Kept | The day card ("keeps a red outline"); Call 18 |
| C63 | A cancelled stay's event is not drawn; one a member chose to leave on the calendar is drawn as an ordinary Household event | `weekEvents` ~256 | a cancelled stay | Kept | The server ("adds no op and writes nothing"; the answer keeps `events`) |
| C64 | "Reading the log…" while a week is read, and the page's one error box when it cannot be read at all | `loadCalendar` ~10431 | loading, or a failed read | No home | Keep both; the Anti-goals rule out a blank page and name no line for either |
| C65 | An answer for a week since left is dropped, never drawn over the newer one | `calFetch` ~10170 | weeks changed quickly | Kept | Deep links, In ("A late reply draws nothing") |
| C66 | No way to keep nights where friends do not book | `bookingHere` ~10551 | booking is off | Kept | Keep nights for the household |
| C67 | No link to Synology Calendar without DSM's public address; the read-only view then has "Close" alone | `dsmCalendarUrl` ~10684 | no address | Kept | Foot; Opening an event |

### Keyboard and focus

| # | Element | Drawn in | Shows when | Fate | Spec section, or recommendation |
|---|---|---|---|---|---|
| C68 | Escape closes the open form or view and focus goes back to what opened it | each form ~10594, ~10639, ~10879, ~10932 | something is open | Kept | Accessibility and the phone |
| C69 | Focus on opening: "What"; "First night"; "Why open them again"; the first button of a read-only view | ~10612, ~10656, ~10902, ~10936 | something opens | Kept | Adding to a day ("focus in the first field"); Accessibility |

## Shared and at risk

What a spec says a screen shows, traced to where the page gets it today and how a rebuild could cut it.

| # | The spec relies on | It comes from | How it is severed |
|---|---|---|---|
| S1 | Today: "New since you last looked" and "3 new" | `POST /api/briefing/read`, sent only by the observer on the composer (~3160) | The Today spec deletes that observer. If the new trigger is not built, the cursor never moves and every closed day says "N new" for good |
| S2 | Today: fresh rows after an action | `reloadView()` (~3019), shared by Today, the board and the card through `view`; `showView` (~11041); the `visibilitychange` listener (~3169) | A rebuilt `loadThread` or a renamed view leaves a branch pointing at nothing; the listener is easy to lose (T12) |
| S3 | All three: the page loads at all | Listeners registered at the top level on `#t-filters`, `#t-all`, `#t-earlier`, `#tray`, `#thread` (two), `#search`, `#search-q`, `#plan-filters`, `#plan-new`, `#cal-block`, `#cal-new`, `#composer` | The script is one module. Delete the markup and leave a listener, and it throws at load: nothing below it runs, sign-in included, since `enterApp` is the last block |
| S4 | Today: the tabs | The tab bar's handler calls `endFilterDetour()` (~11055) | The Today spec deletes the function; the call must go in the same change or every tab press throws |
| S5 | Calendar: a moved or proposed event opens its card on Today | `openTodayAt(selector)`, called with selector text from `evOpen` (~10264) and from search | 0.8.0 changes it to `openTodayAt(target)` while the Calendar is not rebuilt until 0.9.0: its two callers change in 0.8.0 |
| S6 | Plan card: Claude's suggestions with their buttons | Today's `offerCard`, `approveForm`, `adjustForm`, `actionButton`, the plan-card branch of `reloadView`, and the CSS `.card.offer`, `.is-decided` | The Today spec re-houses the card nodes in a row's block and deletes the card's left border "once unused": the plan's card is a user |
| S7 | Today: an old ask's "Take it" and "Decline" | `askAnswer` and `askCardNode`, in Today's region of the page, under the Yours rails; `POST /api/plans/:id/answer` | The Plan spec deletes `boardCard` around them and keeps both "on purpose": they need `actionButton`, `planPath` and `reloadView` too |
| S8 | All three: member discs | `whoDisc` (~6518), used by Today's rail, the board's chips, the card's owner and Between us | The Plan spec replaces it with `memberDisc`: every caller is renamed in 0.7.0, the rail's and Between us included |
| S9 | Today's rail and the Calendar: whose calendar | `otherMember()` (~6465): `sourceDisc` (~2467), `evSub` (~10251), `legend` (~10410); `sourceName` (~10223) is already unused | The Plan spec deletes Plan's two uses, the Calendar spec the Calendar's; `sourceDisc` belongs to neither and names the wrong member once there are three (T87) |
| S10 | Calendar: `householdDisc()` | The house mark inside `sourceDisc`, in the Today block | The Calendar spec lifts it into a helper: Today's rail must call the helper too, not keep a copy |
| S11 | Today: rows in household time, days by `householdDay` | `clockOf`, `keyAt`, `todayKey`, `addDayKey`, `keyWords`, `mondayOf`, defined in the Calendar block (~10184 to ~10217) and reading `settingsData.tz`, which `enterApp` sets | A Calendar rebuild that moves or renames them breaks Today's rail and the new rows. With Settings unread the zone is the device's, silently |
| S12 | Plan card and the top bar: dates and times | `dayKey`, `timeOf`, `fmtDate`, `asOf` (~2236), used by answers, research, block chips, Between us and the date under the household's name | The Today spec deletes "`dayKey` for grouping": the grouping, not the function |
| S13 | Today and the plan's card: text kept in Drive | `docTexts`, `readDocText`, `docRead`, and `docHousehold`, which `enterApp` sets for each household | A Today rebuild that owns these breaks research on the card; without `docHousehold` one household's text shows in another |
| S14 | All three: who is signed in | `claudeOn`, `myName`, `members`, `inSandbox`, `settingsData`, all set in `enterApp`; `attachmentsOn`, set on a card's first load | The people bar's order is `members`; "Hand it to" lists `members`; a module that reads them before `enterApp` has run sees the defaults |
| S15 | Calendar: "For a plan" | `eventPlans()` (~10697) reads `GET /api/plans` as `rows[].planning` and `.doing`, and treats any failure as no plans | 0.7.0 changes the shape to `rows[].plans`. Unchanged, the picker vanishes with no error until 0.9.0 |
| S16 | Settings: opens at all | `loadSettings` (~7759) reads `/api/plans?showDone=1` for `areaCounts` | The Plan spec answers `showDone` with a 400 and deletes the read: both in the same change |
| S17 | Plan card: draws at all | `renderCard` reads `v.children.length`, `v.shelf` and `v.asked` | `GET /api/plans/:id` loses `shelf` and `children` in 0.7.0: an untouched line throws |
| S18 | Today's plans rail: its chips | `railChips` uses `chip`, `showsClock`, `staleChip`, `dueText` from the Plan block, and the CSS `.chip.asked` | The Plan spec deletes `.chip.asked` "once nothing uses" it and the asked chip in `planChips`; the rail still uses the class (T92) |
| S19 | Today's setup notes and prompts: "Cover it", "Open Budget" | `openBudgetAt(budget, envelope, cover)` with `true` or `false` (~2368, ~4733) | The Calendar spec makes the third argument a focus key: `true` must still mean cover and `false` nothing |
| S20 | Today: the receipts row and "Put it back" | `#unsorted-q` on Budget (~2558); `categoryList()` and the restore tool (~6237) | Budget markup and its cache, reached from Today: a renamed id fails quietly |
| S21 | Today: which budget | `chosenBudget()` and `budgets`, Budget's state: the by-line's label, `budget=` on the thread, the rails, a question and a note | "All budgets" goes, the default budget stays: the fallback briefing and the two flags still read it |
| S22 | All three: one error box, one loading line | `showProblem`, `#app-err`, `#loading`; `showView` clears the box; budget prompts are hidden on Plan and Calendar | New in-form error slots beside old `showProblem` calls say a refusal twice, or leave a stale box above a form |
| S23 | Today: an empty search on a household switch | `enterApp` calls `searchReset`, which calls `searchClear`, which calls `searchClose` | The Today spec deletes `searchClose` and keeps the other two: every sign-in throws unless `searchClear` is rewritten with it |
| S24 | Today's "Open the day" and the Calendar's deep link | `calWeek`, `calDay` and `showView('calendar')`, which reads `calWeek` | 0.8.0 writes `calWeek` from Today; 0.9.0 replaces that with `openCalendarAt`: three call sites change again |
| S25 | Today: a card's from-line, "From the day's briefing" | `build()` in `thread.ts` hands the cards of a briefing that was replaced, or that stands aside for the household's, to the one shown (`settle`) | The spec deletes `cardsFor`; if `raised.entry` is not settled the same way, the from-line jumps to an entry no day shows |
| S26 | Today: one line for one decision | `build()` hides a change appended in the same write as its approval, and a drift let go by a plan's removal | The spec says the rule is unchanged; a rewrite of `build()` for flat cards must carry both |
| S27 | Calendar and Today: friends, kept nights, the Synology link | `bookingHere()` and `dsmCalendarUrl()` read `settingsData` | Read once in `enterApp` and after each Settings change: a Calendar module that caches them misses a change |
| S28 | Calendar: "kept by Bob" on kept nights | `held.by` on a block from `weekEvents` | The spec grows a stay's `held` and does not restate a block's: keep `by` |
| S29 | Today, a day card's rows: a guest's name | `name` on a change entry, from the guests list | The spec's new entry fields do not restate it: keep it, or a guest's address shows |
| S30 | Plan card: Escape goes Back | Each small form on the card closes itself on Escape (`inlineForm`, checklist, chips, money, contact search) | The Plan spec adds a document listener that first cancels `[data-cancel]`: these forms have no such mark, so one Escape would close the form and leave the card |
| S31 | Today: the composer rests while a card's field has focus | `focusin` and `focusout` on `#thread` (~3143) | `#thread` is deleted: the listeners move to the day cards' container |
| S32 | Today's phone strip: Yours under the briefing | `placeYours` reads `data-day` and `data-kind` on entries | Both attributes exist only for it and for search; the strip is drawn with today's card instead |
| S33 | Plan card: the state buttons' words | `LANES` (~6466) gives "Planning" and "Doing" to `renderCard` (~6930) | The Plan spec deletes `LANES` with the board's columns: the card needs the two words from somewhere |

## Recommendations for the specs

One line for each No home row: the sentence to add, and where.

**Today as day cards**

- T12, The page: "Coming back to the browser tab reads Today again, unless a form in a row is open."
- T18, The briefing and Yours: "A write-up kept in Drive is read without a press on today's card, which says
  'Reading the briefing…' until it arrives."
- T19, The briefing and Yours: "When it cannot be read the write-up's place says 'Sign in again to read the
  whole briefing.', 'The full text is on the old NAS.' or 'The whole briefing could not be read just now.'"
- T23, Rows, Question: "A question asked on a plan's card carries the crumb, as a note does."
- T33, Rows, Change: "A removal with no reason says 'No reason was given for this.' where the reason would be."
- T44, Proposal cards in a row: "A put-off card keeps its effects above its settled line."
- T49, Proposal cards in a row: "An old ask shows the asker's reason as the quoted line under its sentence."
- T53, Proposal cards in a row: "A drift keeps its chip beside the label, 'moved' or 'edited', in the caution
  colour."
- T56, Proposal cards in a row: "A card about a plan ends its sentence with the crumb, open or settled."
- T61, Proposal cards in a row: "A request whose nights were kept for the household since says so as the last
  line of its effects, in the problem colour (`blocked`)."
- T65, Proposal cards in a row: "An approval that leaves something to do by hand redraws the row as decided
  and says what is left in the page's error box."
- T87, The briefing and Yours: "A calendar row's disc is the viewer's, `householdDisc()`, or the ring of the
  member who owns the calendar: `GET /api/today` events gain `owner`, as the Calendar's do."
- T92, The briefing and Yours: "The plans rail draws no 'asked' chip."
- T96, The briefing and Yours: "If `GET /api/today` fails, the days draw without Yours and the setup notes
  stay as last drawn."
- T111 and T112, The page: "Above the head sit the shared loading line and the shared error box, as now."
- T113 and T114, The page: "`noBudgets` and `noOpenMonth` draw the prompts they draw now, above the head:
  'Open Budget', and 'Open it from the template' with its effects."
- T119, The composer: "With no key Enter is a new line; Enter is ignored while an input method composes; a
  press with the field empty puts focus in it."
- T120, Accessibility and the phone: "A form opened in a row takes focus in its first field."
- T121, Accessibility and the phone: "A button is off while its request is out."

**The Plan page, by area**

- P13, The board, Plan rows: "The envelope reads in the problem colour when what is left is below zero."
- P21, The plan's card, Head: "The title renames in place, as now."
- P25, The plan's card, Head: "A finished plan shows a 'Done' chip in Mark done's place, and either state
  button opens it again."
- P31 and P33, The plan's card, Head: "The chips row stays under the state row: each chip with its ×, 'Add a
  chip', and '2 wks' from 14 days in Doing."
- P51, The plan's card, Between us: "Its note reads 'Also in Today'."
- P63, Pages: "Removing a plan returns to where its card was opened from, with focus on the area's heading."
- P64, The board: "The shared loading line and error box sit above the board, the Area page and the card."

**The Calendar as a day page**

- C29, The phone page, Head: "The week and the chosen day are kept while the member visits other tabs."
- C41, Adding to a day: "A check the server answers with 400 says nothing: the times do not read yet."
- C46, Opening an event: "'Change this event' also has Day, and the live overlap block, which leaves out the
  event itself."
- C53, Keep nights for the household: "After 'Keep these nights' the card shows the first night."
- C64, Foot, and when the calendars are out of reach: "A week that cannot be read at all says so in the shared
  error box; the shared loading line shows while it is read."
