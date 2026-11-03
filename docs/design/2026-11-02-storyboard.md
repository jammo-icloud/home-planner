# Home Planner storyboard

2026-11-02. Every screen and flow a member, the owner (the DSM admin) and a guest (a friend booking a stay) goes through, as frames with a sentence each on what the person sees, does and decides. The companion list of use cases is [2026-11-02-use-cases.md](2026-11-02-use-cases.md).

How this was made: from the design documents in `docs/superpowers/specs/`, `README.md`, `DEPLOY.md`, the routes in `api/src/server.ts`, the tools in `api/src/tools.ts` and the screens in `site/index.html` and `site/book.html`, and by running `main` against `api/tools/fake-dsm` with two test accounts, a fake mail server and **no Anthropic key**. No household data was read.

Each frame is marked **seen running** (walked in the app; the quoted words are the app's), **in the code** (found in code or specs, not walked; example content is illustrative), or **expected, not found** (what I would expect and could not find). 87 frames: 46 seen running, 32 in the code, 9 expected, not found.

## Where what I expected differs from what is built

- **Calendar's "New event" is Claude only.** It switches to Today and types "Schedule " into Ask Claude. With no API key there is no way to put an appointment on the calendar from the app. The planner design says appointments are made "by conversation or on the calendar"; I expected a small form too.
- **The first run is four steps and ends with no envelopes.** Budget, then income, then open the month, then envelopes added one at a time. The starter set brings 21 categories and 4 rules but no envelopes, so the first month opens as "0 envelopes seeded" with all income left to assign.
- **After every redeploy, each member has to sign out and in again.** The calendar, the rail and approval cards say "sign in again". There is no button for it, and a booking approval is stuck until someone does. The design accepts this cost; it is the most likely everyday annoyance.
- **The owner can share a household but not unshare it from the screen.** DELETE /api/members exists and no screen calls it. There is no way to hand ownership on either.
- **A hand sort on Import never offers a rule.** The README says sorting by hand offers to remember it as a rule. That happens on the Unsorted list on Budget. On Import, only Claude suggestions a person kept are offered as rules, so the first statement from a new bank teaches nothing unless it is sorted on Budget.
- **Nothing reaches a member outside the app.** This is a stated non-goal. Now that friends send booking requests and partners ask each other to take plans, a request can wait until someone happens to open Today.
- **The storage design is not on main yet.** There is no Drive copy of briefings, answers or plan pages, no search box and no search tool. A worktree is building these now.
- **Settings does not say whether Claude is on.** It explains booking and attachments. Claude's state shows only under the reply box, and the NAS session's state only as errors where it is needed.
- **Smaller ones.** Recurring bills are found and mentioned in the briefing but have no screen. The guest's confirmation has no calendar file and no reminder before arrival. The web manifest is there but nothing works offline. Contacts can be created only from Claude's research. On a fresh envelope, the line "$1,800 funded was $0" reads as if something went wrong.

## A. Getting in

A member signs in with their DSM account, starts or joins a household, and builds a first budget. Four steps before the first envelope.

### A1. Sign in

*member · seen running*

- **Sees:** "Home Planner · Sign in · Use your Synology account — the same one as the NAS." Username and password.
- **Does:** Types their DSM account name and password; if DSM has two-step sign-in, a verification-code field appears.
- **Decides:** Nothing yet. A wrong password and an account that is not allowed get the same message, so names do not leak.
- **Where:** `site/index.html #login · POST /api/auth/login · api/src/auth.ts`

### A2. Nothing here yet

*the owner · seen running*

- **Sees:** "Signed in as alice. Start one, or ask someone to add you to theirs." Start a new household, Restore from a backup file, All households on this server (admin only), Sign out.
- **Does:** Starts a household, restores one from a backup, or waits to be added by a partner.
- **Decides:** Whether this account owns a household or joins someone else's.
- **Where:** `site/index.html #households · GET/POST /api/households`

### A3. First budget, on Today

*the owner · seen running*

- **Sees:** Today opens with a banner, "This household has no budgets yet", over a briefing that says nothing needs attention. Fields: Name it, Where is it for, ZIP; "Start with common categories and card-payment rules" ticked.
- **Does:** Names the budget (Placitas), gives the place and ZIP, presses "Show what this would do" and reads the preview: 21 categories, 4 rules, location.
- **Decides:** Whether to take the starter set.
- **Where:** `create_budget, add_starter_set · api/src/starter.ts`

### A4. Record what comes in

*the owner · seen running*

- **Sees:** "No income is recorded for Placitas, so there is nothing to open the month at." What is it, Whose, Each payday, A real payday, How often; preview by month.
- **Does:** Records a salary and checks the four-month preview.
- **Decides:** How often pay arrives, which sets what each month opens with.
- **Where:** `define_income_source, plan_income · api/src/income.ts`

### A5. Open the month

*the owner · seen running*

- **Sees:** "Placitas has no plan for this month yet. Open it from the template." The preview reads "0 envelopes seeded from the Placitas template · To assign would be $6,000.00".
- **Does:** Opens November.
- **Decides:** Nothing to decide; the plan of record is snapshotted.
- **Where:** `open_month · api/src/tools.ts`

### A6. Envelopes, one at a time

*the owner · seen running*

- **Sees:** Budget shows "$6,000 left to assign · Not yet given a job" in red and a single "Add an envelope" row. The starter set made categories, not envelopes.
- **Does:** Adds envelopes one by one: label, band, categories, template amount; then funds each with a reason.
- **Decides:** Every envelope and its amount, from nothing.
- **Where:** `define_envelope, set_assignment`

### A7. Starter envelopes

*the owner · expected, not found*

- **Sees:** I expected the starter set to offer a matching set of envelopes (House, People, Future) at amounts priced from the place, so the first month opens with something to fund.
- **Does:** Accepts or trims a proposed envelope list in one preview.
- **Decides:** Which envelopes to keep.
- **Where:** not built

### A8. Price it from local data

*the owner · in the code*

- **Sees:** Budget menu → "Where it is" and "Price it from local data": rent from Zillow, county rent and property tax from Census, electricity from EIA, each with its source and caveat beside the old figure.
- **Does:** Approves the envelopes that public data can price, usually one or two.
- **Decides:** Whether a measured figure for the place replaces their own.
- **Where:** `set_budget_location, look_up_local_costs, seed_from_location · api/src/local.ts`

### A9. Share it with someone

*the owner · in the code*

- **Sees:** Household menu → "Share it with someone": their DSM account name and a reason.
- **Does:** Adds the partner by DSM account name, "my partner".
- **Decides:** Who may use this household. Today records "shared the household with bob".
- **Where:** `site/index.html #hh-share · POST /api/members`

### A10. The partner arrives

*member · seen running*

- **Sees:** Bob signs in and lands straight in the household's Today: the same briefing, alice's note as a bubble, and cards marked "Waiting for you" or "Waiting for either of you".
- **Does:** Reads, takes what was asked of him, approves what waits on either of them.
- **Decides:** His own cards.
- **Where:** `enterApp · GET /api/thread`

### A11. All households on this server

*the owner · in the code*

- **Sees:** As ADMIN_USER: each household's owner, size and last activity. Nothing inside any of them.
- **Does:** Checks the server holds what it should.
- **Decides:** Nothing in a household; being admin does not make him a member.
- **Where:** `GET /api/admin/households · DEPLOY.md "The administrator"`

### A12. Backup and restore

*the owner · in the code*

- **Sees:** Household menu → "Download a backup" (the log itself) and "Restore from a backup", which previews by band: receipts and rules, budgets and envelopes, opened months, the thread, plans, bookings.
- **Does:** Picks the bands to take.
- **Decides:** What to bring back; anything that would collide refuses and says why.
- **Where:** `GET /api/backup · /api/restore/preview · /api/restore · api/src/restore.ts`

## B. Today and its cards

One thread per household: the day's briefing first, then notes, questions, Claude's answers, cards and quiet lines for every direct change. Newest at the bottom beside the reply box.

### B1. The day's briefing

*member · in the code*

- **Sees:** One briefing for the household, written once a day by one Claude call from the budget, the plans and the Household calendar: a headline, a folded write-up, and cards.
- **Does:** Reads it; opens the cards it raised.
- **Decides:** Which suggestions to act on.
- **Where:** `api/src/briefing.ts briefHousehold · thread.briefing { source: "household" }`

### B2. Briefing without Claude

*member · seen running*

- **Sees:** "Briefing · written without Claude": plain sentences from the same facts ("No budget is open for this month. Nothing on the board is overdue… There is no Household calendar yet.") and why.
- **Does:** Reads it. The next look tries Claude again and replaces it if Claude answers.
- **Decides:** Nothing different; every direct change still shows.
- **Where:** `briefing.ts fallback sections`

### B3. New since you last looked

*member · seen running*

- **Sees:** A divider, then quiet one-line entries for every direct change: "You created budget Placitas", "alice set Replace the water heater due 2026-11-20", "alice shared the household with bob · my partner".
- **Does:** Skims what happened.
- **Decides:** Nothing; these are the record.
- **Where:** `/api/briefing/read · api/src/thread.ts`

### B4. Yours: what the briefing was written from

*member · seen running*

- **Sees:** A rail per member: Today and tomorrow (their calendars), Plans that need you (dated chips), Money this month (to assign and envelopes running low).
- **Does:** Taps an item to jump to its screen.
- **Decides:** Nothing; it is the member's own layer, never in the shared text.
- **Where:** `GET /api/today · renderYours`

### B5. Filters and the waiting tray

*member · seen running*

- **Sees:** Everything · Mine · Theirs · Waiting, an "All budgets" switch, and a pill above the reply box: "3 waiting on you".
- **Does:** Taps Waiting to see only what needs a decision.
- **Decides:** What to deal with first.
- **Where:** `renderThread · #t-filters · #tray`

### B6. Leave a note

*member · seen running*

- **Sees:** The reply box: "Ask Claude about the budget, or leave a note for each other", with Leave a note and Ask Claude.
- **Does:** Leaves a note for the other member; it costs no Claude call and Claude never answers it.
- **Decides:** Nothing; the note becomes part of why later things were decided.
- **Where:** `POST /api/thread/note · conversation.ts note`

### B7. Ask Claude

*member · in the code*

- **Sees:** The question in the thread with name and time, then Claude's answer "as of" that moment, with the tools it used folded away, and any cards it raised.
- **Does:** Asks "Can we cover Groceries this month?".
- **Decides:** Whether to approve what the answer proposes.
- **Where:** `POST /api/thread/ask · api/src/conversation.ts · api/src/claude.ts`

### B8. Ask Claude, with no key

*member · seen running*

- **Sees:** "Claude isn't set up on this server. Notes still work." Ask Claude is dimmed.
- **Does:** Leaves a note instead.
- **Decides:** Nothing.
- **Where:** `site/index.html #say-note`

### B9. A card

*member · in the code*

- **Sees:** What it does, why, its effects, and Approve · Not now · Adjust. A decided card collapses to one line: approved, declined or put off, by whom, when, why.
- **Does:** Approves it; the decision and its events are written together, in their name.
- **Decides:** Approve, put it off, or adjust it into a new card of their own.
- **Where:** `/api/thread/decide · /api/thread/adjust · api/src/offers.ts`

### B10. The numbers have moved

*member · in the code*

- **Sees:** "The numbers have moved since this was suggested." The card cannot be approved in one click.
- **Does:** Refreshes it: the stored tool runs again with the stored arguments and a new card replaces the old.
- **Decides:** Approve the refreshed card or not.
- **Where:** `offers.ts fingerprint, refresh · /api/thread/refresh`

### B11. Not now, and back again

*member · in the code*

- **Sees:** A put-off card leaves the tray, then returns to Waiting (and to the next briefing) as soon as a figure it was based on changes. A newer card for the same envelopes replaces it.
- **Does:** Puts a card off.
- **Decides:** When to look again, which the numbers decide for them.
- **Where:** `offers.ts waiting, replaces`

### B12. A receipt was removed

*member · in the code*

- **Sees:** A flag on a removed receipt, waiting for every member except the one who removed it: "Put it back" or "Seen it".
- **Does:** Puts it back, which proposes restoring it, or marks it seen.
- **Decides:** Whether the removal stands.
- **Where:** `flag.seen · /api/thread/seen · restore_transaction`

### B13. Ask-to-take

*member · seen running*

- **Sees:** "Waiting for you · Gutter repair before winter · alice asked you to take it · 'you know the ladder better than I do'". On the asker's side the plan sits dashed on the other's board.
- **Does:** Takes it, or declines with a reason that goes back to the asker as a line in Today.
- **Decides:** Whether to own the plan. There is no other way onto someone's board.
- **Where:** `plan.ask, plan.ask.accept/decline · /api/plans/:id/answer`

### B14. A plan's date moved on a phone

*member · in the code*

- **Sees:** "Bob moved the vet to Tuesday on their phone" with Move the plan too · Keep the plan, put the calendar back · Leave both. Deleting the event on a phone is drift too.
- **Does:** Chooses which side wins.
- **Decides:** Plan or calendar; the app never merges on its own.
- **Where:** `api/src/drift.ts · resolve_drift (card only)`

### B15. Schedule it, by saying it

*member · in the code*

- **Sees:** "Schedule my dentist at 10 on Thursday" comes back as a card that leads with any clash, offers the nearest clear slots, and says which calendar it lands on.
- **Does:** Approves; the event is created on Synology Calendar before the decision is recorded.
- **Decides:** The time and the calendar (their own or Household).
- **Where:** `propose_event · offers.ts effect stage · api/src/appointments.ts`

### B16. Told outside the app

*member · expected, not found*

- **Sees:** I expected something to reach a member when a card waits on them, at least a daily email or a phone notification, since a friend's booking request now arrives here.
- **Does:** Opens Today from the message.
- **Decides:** Same cards, sooner.
- **Where:** not built (a stated non-goal in the planner and thread designs)

## C. The budget

Zero-based envelopes per budget, months opened from a template, receipts imported from bank files and sorted into envelopes by rule, by Claude's suggestion or by hand.

### C1. Budget

*member · seen running*

- **Sees:** The budget's name as a menu, Budget · Import · Compare, "$800 left to assign" with Income, Funded, Spent; "Needs you"; envelopes in House, People and Future bands with funded, spent and what is left.
- **Does:** Opens an envelope, sorts what needs sorting, adds an envelope.
- **Decides:** Where the unassigned money goes.
- **Where:** `get_month · api/src/envelopes.ts · site/index.html #budget`

### C2. An envelope, open

*member · seen running*

- **Sees:** Set funding to, Take it from (money not yet assigned or another envelope), Reason ("this is what gets read tomorrow morning"), Show what this would do, Remove this envelope; Receipts with Edit on each; the sum "$0.00 carried in + $250.00 funded − $36.75 spent = $213.25 left".
- **Does:** Moves money in with a reason, previews it, approves.
- **Decides:** How much, from where, and why.
- **Where:** `move_money, set_assignment, explain_envelope · showReceipts`

### C3. Income and what if

*member · in the code*

- **Sees:** Tapping Income opens the sources, "Record an income" and "What if…", which projects a change before it is recorded.
- **Does:** Tries a raise or a lost job before recording it.
- **Decides:** Whether to record the change.
- **Where:** `#income-sec · plan_income · renderProjection`

### C4. Import a bank file

*member · seen running*

- **Sees:** "Drop a bank export here, or choose one · QFX, OFX or CSV. Nothing is saved until you approve it." "Where to get one" says what to download from a bank or card's website: QFX or OFX where it is offered, or a CSV that names its columns.
- **Does:** Drops the card's CSV.
- **Decides:** Which file.
- **Where:** `POST /api/import/preview · api/src/parse.ts`

### C5. The preview

*member · seen running*

- **Sees:** Counts: In the file 7 · Already have 0 · Sorted by rule 1 · Needs you 6. A row per receipt with an envelope picker: this budget's envelopes by band, "Not in this budget", Transfer between our accounts, Income, Split across envelopes….
- **Does:** Picks envelopes for what the rules left.
- **Decides:** Each receipt's envelope, or to leave it unsorted.
- **Where:** `site/index.html renderPreview · envelopeFor`

### C6. Claude's suggestions

*member · in the code*

- **Sees:** With a key, rows the rules missed come back with a suggested envelope drawn as a suggestion, "Accept all suggestions" beside per-row accept; Claude is sent payee names and envelope names only.
- **Does:** Accepts most, fixes one.
- **Decides:** Which suggestions to keep; an unaccepted one imports unsorted.
- **Where:** `POST /api/match · api/src/match.ts (Haiku)`

### C7. Split across envelopes

*member · seen running*

- **Sees:** The row grows lines: envelope picker and amount per line, × to remove, "+ another line", and "$165.00 still to place" until it reads "balanced".
- **Does:** Divides the warehouse-club receipt into Groceries $120 and Gifts $45.
- **Decides:** The parts, in whole cents that add up exactly.
- **Where:** `splitEditor · txn.split · replay.ts checkParts`

### C8. Imported

*member · seen running*

- **Sees:** "Added 7 receipts, 5 already sorted (1 divided). 2 still need an envelope." A "Remember these as rules?" box appears only for Claude suggestions a person kept; nothing is offered for receipts sorted by hand here.
- **Does:** Goes to Budget to sort the rest.
- **Decides:** Rules for accepted suggestions, if any.
- **Where:** `POST /api/import/commit · offerRules`

### C9. Needs you: sort and remember

*member · seen running*

- **Sees:** Unsorted receipts with a picker; choosing one shows "☑ remember [GREEN CHILE GRILL]" with the rule text editable; the preview says "Rule 'GREEN CHILE GRILL' would cover 1 transaction from now on".
- **Does:** Sorts Green Chile Grill to Dining out and keeps the rule.
- **Decides:** The envelope and whether to make the rule, and its wording.
- **Where:** `#needs #unsorted-q · categorize_transactions · match.ts ruleProblem`

### C10. Edit a split later

*member · in the code*

- **Sees:** Each receipt in an envelope's list has Edit: the picker and a split editor filled in with the current parts, "−$120.00 of −$165.00" shown beside the whole.
- **Does:** Re-divides, adds or removes a part, or sorts the receipt whole again.
- **Decides:** The new parts; each save is one more decision in the log.
- **Where:** `showReceipts Edit · categorize_transactions __split`

### C11. Categories

*member · in the code*

- **Sees:** A sheet: "Shared by every budget. An envelope is a group of them." Add a category, Rename one, Stop using one, Add the starter set.
- **Does:** Adds "Pets".
- **Decides:** The shared category list.
- **Where:** `#cat-sec · define_category, archive_category, add_starter_set`

### C12. Compare

*member · in the code*

- **Sees:** Two budget pickers, "Placitas against Lakeside", and the difference envelope by envelope with the public-data sources.
- **Does:** Prices living elsewhere.
- **Decides:** A conversation, not a change.
- **Where:** `#compare · compare_budgets`

### C13. Close the month

*member · in the code*

- **Sees:** In the month's last days, or once it has ended, a "Close the month" section at the foot of Budget. The budget menu also has "Discard this month's plan".
- **Does:** Closes October.
- **Decides:** That the month is done; untouched and put-off cards for it expire.
- **Where:** `#month-sec · close_month, discard_month`

### C14. Bills that recur

*member · expected, not found*

- **Sees:** The code finds merchants that charge in three or more months at a steady amount and mentions them in the briefing; I expected a list of them on Budget, each with "make a rule" and "fund it".
- **Does:** Turns a recurring charge into a rule and a funded line.
- **Decides:** Which recurring charges are commitments.
- **Where:** `analytics.ts recurring → briefing.ts only; no screen`

## D. The Plan board and a plan's card

Areas of life as rows, Planning and Doing as columns, done as an archive. The card holds notes, checklist, files, people, money, dates and Claude's research, kept apart from the members' notes.

### D1. The board

*member · seen running*

- **Sees:** Plan · Both · Mine · Theirs · Show done · New plan. Rows House, Money, People, Trips with plan counts; "Planning · no clock" and "Doing · the clock runs"; cards show owner, chips, dated due chip and "$ House repairs · $300 left"; a shelf strip "Vacations we'd like to take · holds 2".
- **Does:** Scans across areas for what is due and what is stuck.
- **Decides:** What to pick up.
- **Where:** `GET /api/plans · renderBoard · api/src/plans.ts`

### D2. New plan

*member · seen running*

- **Sees:** What is it ("e.g. Fix the back gate"), Area, On a shelf (Not on a shelf, or a shelf in that area); Make it, Cancel.
- **Does:** Adds "Replace the water heater" in House.
- **Decides:** Its area and shelf.
- **Where:** `POST /api/plans · plan-edits.ts createPlan`

### D3. A shelf

*member · in the code*

- **Sees:** Opening a shelf shows it as a page listing its items, each a card in its own state. Items hold nothing further.
- **Does:** Adds "Bahamas, March" to Vacations.
- **Decides:** Which ideas belong together.
- **Where:** `plan parent · renderBoard shelf strip`

### D4. A plan's card

*member · seen running*

- **Sees:** Plan › House; title; Planning | Doing; Mark done; "You own it"; Change the due date; Block time; chips. Notes, Checklist "1 of 3", Attachments, Claude, Between us. Sidebar: Money (envelope, left this month, estimated cost), People, When (due, blocks), History, Remove this plan.
- **Does:** Ticks a checklist step and edits the notes.
- **Decides:** Everything about this one plan.
- **Where:** `GET /api/plans/:id · renderCard · api/src/plans.ts card`

### D5. Ask the other to take it

*member · in the code*

- **Sees:** With a partner in the household, the card shows "Ask bob to take it". With one member it does not appear.
- **Does:** Asks, with a reason.
- **Decides:** To hand it over, which the other must accept.
- **Where:** `/api/plans/:id/ask-to-take`

### D6. Files on the card

*member · seen running*

- **Sees:** "Drop files here, or choose them · up to 25 MB, kept on the NAS". Each file opens through the app; taking one off needs a reason. If PLANNER_ROOT is unset, the card says attachments are off.
- **Does:** Drops two installer quotes.
- **Decides:** What belongs with the plan.
- **Where:** `POST /api/plans/:id/attach · GET …/files/:name · api/src/attachments.ts`

### D7. People from Contacts

*member · seen running*

- **Sees:** "No one is linked to this card yet. Link someone from Contacts": search the household address book; a linked person shows name and phone, tap to call.
- **Does:** Links the plumber.
- **Decides:** Who is involved.
- **Where:** `GET /api/contacts · POST /api/plans/:id/contact`

### D8. Due date and time blocks

*member · seen running*

- **Sees:** A due date becomes an all-day marker on the Household calendar (created and shared with every member the first time one is needed); a block becomes a timed event. "A due date goes on the Household calendar as an all-day marker; a block, as time set aside."
- **Does:** Sets the due date to Nov 20.
- **Decides:** When.
- **Where:** `/api/plans/:id/due, /block · api/src/calendar.ts`

### D9. Claude on the card

*member · in the code*

- **Sees:** "Ask Claude about this card". The answer lands as a gold block with its time and "as of"; anything concrete it proposes (an item, a contact, a due date) is a dashed suggestion with its own approve.
- **Does:** Asks "find tankless installers near Placitas".
- **Decides:** Which suggestions to accept.
- **Where:** `POST /api/plans/:id/ask · tools.ts researchMay`

### D10. Between us

*member · seen running*

- **Sees:** "Between us · Also in Today's thread": member notes kept on the card.
- **Does:** Notes "the quote from xyz includes haul-away".
- **Decides:** Nothing; it is context for later decisions.
- **Where:** `POST /api/plans/:id/note`

### D11. Done

*member · in the code*

- **Sees:** Mark done takes it off the board; "Show done" brings done plans back. Nothing in Planning ever shows its age.
- **Does:** Marks the registration done.
- **Decides:** That it is finished.
- **Where:** `/api/plans/:id/state done · board showDone`

### D12. The plan as a page in Drive

*member · expected, not found*

- **Sees:** Per the storage design: plan.md beside the plan's files in the Planner Team Folder, readable on a phone in Synology Drive; edits made there come back to Today as a card.
- **Does:** Opens the plan in Drive without the planner.
- **Decides:** Whether to take an edit made in Drive.
- **Where:** not on main (2026-11-01 storage design, phases 3–4; being built in a worktree)

## E. The Household calendar

Synology Calendar keeps every event; the app draws a week from the member's own calendar, the shared Household calendar and the calendars they tick.

### E1. The week

*member · seen running*

- **Sees:** ‹ › This week, the range, Block nights, New event; a legend (Mine, alice's shared with you, Household, Due date, Proposed not approved, Not on the calendar, Moved plan disagrees, Clash, Held nights); an all-day row with dashed due markers; the hours.
- **Does:** Pages to Thanksgiving week.
- **Decides:** Nothing on its own; it is the view.
- **Where:** `GET /api/calendar · api/src/calendar-view.ts · renderWeek`

### E2. On a phone

*member · in the code*

- **Sees:** A strip of the week's days and one day at a time below it, with its own legend.
- **Does:** Taps Thursday.
- **Decides:** Nothing.
- **Where:** `renderDay · #cal-strip`

### E3. New event

*member · seen running*

- **Sees:** Pressing New event switches to Today with "Schedule " typed into the Ask Claude box. Without a Claude key there is no other way to make an event in the app.
- **Does:** Finishes the sentence and asks Claude.
- **Decides:** Through the propose_event card.
- **Where:** `site/index.html cal-new handler → showView("today")`

### E4. A form for a new event

*member · expected, not found*

- **Sees:** I expected a plain form for when Claude is off or for a quick entry: title, day, time, which calendar, link to a plan, with the clash check run before saving.
- **Does:** Adds "Dentist, Thu 10:00" by hand.
- **Decides:** Time and calendar.
- **Where:** not built

### E5. Block nights

*member · seen running*

- **Sees:** "Keep nights for the household": First night, Last night, Why ("Family is here"); "Friends see these nights as taken, and never why. A stay already confirmed cannot be blocked."
- **Does:** Blocks Christmas week.
- **Decides:** Which nights guests cannot have.
- **Where:** `POST /api/bookings/block · openBlockForm`

### E6. Held nights

*member · in the code*

- **Sees:** A stay or a block drawn hatched across the all-day row; opening one offers to release the stay or unblock, with a reason.
- **Does:** Releases a cancelled stay.
- **Decides:** Whether the nights open again.
- **Where:** `openHeld · release_stay · DELETE /api/bookings/block/:id`

## F. Settings and More

Reached from the household pill. "Yours" first (only you see these), then "The household's" (both of you see and change these; every change goes in the history).

### F1. Settings: yours

*member · seen running*

- **Sees:** Appearance: Quartz, Lapis, Iolite, Graphite; Light, Dark, Match this device ("follows you to every phone and computer you sign in on"). Calendars I check for conflicts: My Calendar and Household always, plus any calendar someone has shared with you.
- **Does:** Picks Lapis and ticks the calendar bob shared.
- **Decides:** How the app looks for them, and what clash checks read.
- **Where:** `/api/settings/appearance · /api/calendars/conflicts`

### F2. Settings: the household's

*member · seen running*

- **Sees:** Areas (rename, add; an area with plans cannot be removed); Links under More; Household calendar ("Made by you · shared with you and bob, both can edit": Rename, Use another calendar, Replace it); Guests; Attachments ("On… in /Planner, up to 25 MB each. This is set in Home Planner's deployment").
- **Does:** Adds a link to Photos under More.
- **Decides:** The household's shared setup.
- **Where:** `GET /api/settings · /api/settings/areas, /links · /api/calendars/household`

### F3. More

*member · in the code*

- **Sees:** The household's other NAS apps as links that open in the same tab.
- **Does:** Goes to Photos.
- **Decides:** Nothing.
- **Where:** `renderMore · /api/settings/links`

### F4. What is switched on

*the owner · expected, not found*

- **Sees:** Settings says when booking is off and why, and that attachments are on. I expected the same line for Claude (key set, which models), the NAS session ("you are signed in to the NAS until…"), and Drive.
- **Does:** Sees at a glance what is degraded.
- **Decides:** What to fix in the deployment.
- **Where:** `partial: settingsView covers booking and attachments only`

## G. Booking: the friend's side

A separate page at /book with no member chrome. A friend on the household's list gets a code and a link by email, picks open nights, and asks.

### G1. Come and stay

*guest · seen running*

- **Sees:** A drawn Sandia ridge at night with the house lit; "PLACITAS, NEW MEXICO · 5,955 FEET · Come and stay · On the north side of the Sandias. Pick nights that are open and send a request; we'll answer by email." Your email.
- **Does:** Types their email and presses "Send me a link".
- **Decides:** Nothing yet.
- **Where:** `GET /book · site/book.html · POST /book/start`

### G2. A link is on its way

*guest · seen running*

- **Sees:** "If that address is one we know, a link is on its way. The email has a link and a six-digit code. Either one signs you in. The code works for ten minutes." The same words whether or not the address is on the list.
- **Does:** Types the code, or follows the link from the email.
- **Decides:** Which device to finish on.
- **Where:** `POST /book/code · /book/open`

### G3. The email

*guest · seen running*

- **Sees:** "Your link to book a stay with Rivera-Test": the code and the single-use link, plain text, from SMTP_FROM.
- **Does:** Taps the link.
- **Decides:** Nothing.
- **Where:** `api/src/mail.ts · booking.ts`

### G4. Pick your nights

*guest · seen running*

- **Sees:** "With the Rivera-Test household · signed in as … · Sign out". A month of nights with ‹ ›; legend Open, Taken, Yours waiting, Yours confirmed, Chosen. Taken never says who or why.
- **Does:** Taps the arrival night, then the last night.
- **Decides:** Dates, among open nights only.
- **Where:** `GET /book/nights · booking.ts guest nights`

### G5. Ask for nights

*guest · seen running*

- **Sees:** Arriving, Leaving, How many of you, A note for them; "Your nights are held for you until they answer. Taken nights just say taken."
- **Does:** Asks for Fri 27 to Mon 30, 3 people, "We'd love to see the house!".
- **Decides:** Headcount and what to say.
- **Where:** `POST /book/request`

### G6. Your requests

*guest · seen running*

- **Sees:** "Fri 27 to Mon 30 November · 3 people · waiting for an answer" with Change and Cancel, dashed until answered.
- **Does:** Waits; may change dates or cancel.
- **Decides:** Whether to change or cancel.
- **Where:** `GET /book/mine · POST /book/change, /book/cancel`

### G7. Before you come

*guest · seen running*

- **Sees:** Local notes: almost 6,000 feet so bring layers and drink water; free-roaming horses on the ridges, don't feed them; in December, farolitos for Las Posadas; "They'll send the address and how to get in before you arrive."
- **Does:** Reads.
- **Decides:** Nothing.
- **Where:** `site/book.html #s-know`

### G8. Confirmed

*guest · seen running*

- **Sees:** An email "Your stay with Rivera-Test is confirmed: Nov…" with dates, headcount, their note, the household's arrival note ("How to get here") and the link to change or cancel. On the page the nights turn "Yours, confirmed".
- **Does:** Plans the trip.
- **Decides:** Nothing.
- **Where:** `booking.ts confirmedMail`

### G9. Other dates suggested

*guest · in the code*

- **Sees:** An email and a banner: those dates don't work, how about these, with the household's reason; "Ask for these nights" or "No thanks". Suggested nights are not held; a suggestion never taken up lapses.
- **Does:** Asks for the suggested nights in one tap.
- **Decides:** Whether the counter-offer works.
- **Where:** `POST /book/accept-suggestion · booking.suggest`

### G10. Declined

*guest · in the code*

- **Sees:** An email with the reason; the request shows as declined and its nights open again.
- **Does:** Picks other dates or not.
- **Decides:** Whether to ask again.
- **Where:** `proposal.decide declined · mail.ts`

### G11. Add it to my calendar

*guest · expected, not found*

- **Sees:** I expected the confirmation to carry a calendar file (or a link to one), and a reminder a few days before arrival repeating how to get in.
- **Does:** Adds the stay to their phone in one tap.
- **Decides:** Nothing.
- **Where:** not built (confirmation is plain text, no .ics, no reminder)

## H. Booking: the household's side

The list of friends lives in the log; requests arrive on Today as cards a member decides; approval writes the Household calendar and sends the email before anything is recorded.

### H1. The guest list

*the owner · in the code*

- **Sees:** Settings → Guests: each address with name and reason, Add, Remove (with a reason, which signs them out everywhere at once), and the arrival note. When booking is off it names the missing setting: "Booking is off until BOOK_HOUSEHOLD is set in Home Planner's deployment."
- **Does:** Adds the Nguyens, "old friends from Lakeside".
- **Decides:** Who may ask.
- **Where:** `GET/POST /api/guests · DELETE /api/guests/:email · /api/guests/arrival`

### H2. A request on Today

*member · seen running*

- **Sees:** "Waiting for either of you · The Nguyens would like to come Nov 27–30, 3 people: 'We'd love to see the house!'" with what approving does: an all-day event on the Household calendar, a confirmation email. Approve · Decline · Suggest other dates.
- **Does:** Approves.
- **Decides:** Yes, no, or other dates.
- **Where:** `approve_booking (card only) · renderThread booking card`

### H3. Approve without a NAS session

*member · seen running*

- **Sees:** After a redeploy, Approve shows "sign in again to use this" in red on the card and nothing is recorded. There is no button to sign in again from here.
- **Does:** Signs out and in, or leaves it for the other member.
- **Decides:** Who approves.
- **Where:** `offers.ts effect stage · requireSid`

### H4. Approved

*member · seen running*

- **Sees:** "Approved by you, 3:23 PM" collapsed into the thread; the stay appears hatched on the calendar as "The Nguyens staying (3) · a friend staying"; the guest has the email.
- **Does:** Nothing more.
- **Decides:** Done.
- **Where:** `booking.confirm · calendar held nights`

### H5. Decline or suggest

*member · in the code*

- **Sees:** Decline asks for a reason, which is mailed. Suggest other dates declines the original (its nights are released), records the suggestion and mails it with the link.
- **Does:** Suggests Dec 4–7, "Thanksgiving is family this year".
- **Decides:** The counter-offer and its reason.
- **Where:** `bookingDecline · POST /api/bookings/suggest`

### H6. The guest changed their plans

*member · in the code*

- **Sees:** A change or a cancel comes back as a card; cancelling an approved stay deletes its calendar event when a member acknowledges it.
- **Does:** Acknowledges the cancel.
- **Decides:** Release the nights.
- **Where:** `release_stay (card only) · releaseCardNode`

## I. When the NAS or Claude is not there

The budget never needs the NAS after sign-in and never needs Claude. Calendar, contacts and files need the member's DSM session, which lives in memory and is lost on every redeploy.

### I1. Claude off or out of credit

*member · seen running*

- **Sees:** The briefing is the plain one, marked "written without Claude"; Ask Claude says it is not set up; a question asked while Claude is down shows "Claude didn't answer this one."; Import says "Claude could not suggest envelopes" and sorts by rule and hand.
- **Does:** Keeps working: notes, cards already raised, direct edits.
- **Decides:** Nothing different.
- **Where:** `briefing.ts fallback · match.ts error · conversation.ts`

### I2. NAS session lost

*member · seen running*

- **Sees:** After a redeploy the budget is untouched, but Calendar shows "Sign in again to see your calendars. Due dates from your plans are still shown.", the rail says "Sign in again to see your calendars.", and calendar-writing cards refuse.
- **Does:** Finds Sign out in their own menu and signs in again.
- **Decides:** Whether to bother now.
- **Where:** `auth.ts in-memory sid · requireSid · DEPLOY.md Environment`

### I3. Sign in again, in place

*member · expected, not found*

- **Sees:** I expected the "sign in again" message to be a button that asks for the DSM password right there and returns to the same card.
- **Does:** Signs in without losing their place.
- **Decides:** Nothing.
- **Where:** not built (the design rules out an inline password prompt; sign-out and sign-in is the path)

### I4. NAS down altogether

*member · in the code*

- **Sees:** Sign-in fails, since DSM checks every password; the boot log names the cause ("cannot reach the NAS…"). A member already signed in keeps the budget, which needs nothing from DSM.
- **Does:** Waits or tells the owner.
- **Decides:** Nothing.
- **Where:** `auth.ts checkWithDsm · DEPLOY.md "When sign-in fails"`

### I5. The app itself is unreachable

*member · expected, not found*

- **Sees:** The app has a web manifest but no offline copy; with the NAS off, a phone shows a browser error. I expected at least the last Today and this month's envelopes readable offline.
- **Does:** Checks what is left in Groceries from the store.
- **Decides:** Nothing; read-only.
- **Where:** not built (site/manifest.webmanifest, no service worker)

### I6. Mail cannot go out

*the owner · in the code*

- **Sees:** Booking is off until all seven settings are set, and Settings says which one is missing or unusable; a guest is told nothing. A request already waiting can be declined only if mail works, and never approved while booking is off.
- **Does:** Fixes SMTP in the deployment.
- **Decides:** Nothing in the app.
- **Where:** `booking config · DEPLOY.md Booking`
