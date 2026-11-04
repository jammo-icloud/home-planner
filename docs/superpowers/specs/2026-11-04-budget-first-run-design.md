# The budget's first run, receipts over the envelope, and the phone sheet in two

**Status:** approved by the owner on 2026-11-04 from the wireframes (five
boards: the walkthrough, the budget after it, a receipt over the envelope,
the phone sheet split in two, the phone after the scan). This document is
what those boards mean. Ships as version 0.3.0.

## Intent

On first real use the Budget screen offered nothing to work with: a pink
"left to assign" card and three lowercase envelopes named after data keys.
People find budgeting hard, and an empty screen makes it harder. The owner's
rule: there must always be a starting state, even a wrong one, as long as it
can be edited. Envelope budgeting is common sense when it is shown plainly:
an envelope is sized for one thing and holds its receipts; every envelope
together adds up to the income; a receipt cannot be paid from an envelope
that does not hold enough, so the shortfall has to be covered from somewhere.

Separately, the phone setup did too much in one QR code. It installed a
profile holding both a Home Screen icon and a calendar account, and the
calendar account asked for a password with no user name shown, which nobody
could place. The two become two actions, and the password is explained.

Two small things ride along: the More menu in the top bar goes, since the
owner asked for one menu and More held only outside links and a duplicate
Settings; and envelopes priced from local data get proper names.

## Goals

- The Budget screen, when the household's budget has no envelopes, is a
  three-step walkthrough: income, envelopes, pricing. Skipping any step still
  leaves a usable budget.
- A starter set of envelopes in six groups, offered ticked: Home, Food,
  Insurance, Utilities, Savings and sinking funds, Everyday. Rename, untick,
  add your own.
- Every envelope without a figure reads **Action required**, with a hint
  where one exists, until a person gives it a number.
- The left-to-assign card speaks in words and states the zero-based rule:
  income, planned, how many still need a figure, what is left or over. Green
  only when every envelope has a figure and they add up to income.
- Figures from local data land as the envelope's plan, with their source
  under the envelope's name, and under proper names.
- A receipt that lands in an envelope with too little left is allowed, and
  loud: the envelope shows the shortfall and the app offers to cover it from
  envelopes with the most to spare, or from unassigned income while there is
  any.
- "Set up your iPhone" is two plain sections: a QR code that only opens the
  app with a banner saying Share, then Add to Home Screen; and a calendar
  account, with the password named up front.
- The More menu is gone. The household's outside links move into the person
  menu.

## Non-goals

- No change to how receipts are imported, sorted or matched to envelopes.
- No new public data sources. Pricing covers what it covers today: rent,
  property tax, electricity.
- No signed profile, no MDM, no App Store. The calendar account is still an
  unsigned configuration profile or typed steps.
- No change to categories' three kinds (House, People, Future). Groups are an
  envelope's, and already free text.
- No redesign of Import or Compare.

## Anti-goals

- A figure the app made up presented as if a person chose it. Every number
  the app supplies shows where it came from.
- Refusing an imported receipt because an envelope is thin. The receipt
  lands; the shortfall is the thing to deal with.
- Hiding the walkthrough behind a button. If there are no envelopes, the
  walkthrough is the screen.

## Constraints

- Everything here is event-sourced through the existing tools and proposal
  flow. Nothing is written without an approve, except what a person types
  into a form and submits.
- The public tree stays clean: nothing names the owner's domain, Team Folder,
  private addresses, first names, banks or vendors. Placitas and
  America/Denver are fine. The examples in this document use Alex and the
  Rivera household.
- Node 22 native TypeScript, no build step, no front-end framework, no new
  dependencies. `qrcode` is already a dependency.
- Version 0.3.0 in `package.json`; Settings shows it.

## Decisions

### Where the walkthrough shows

- The Budget tab, when the chosen budget has no envelopes. When the
  household has no budget at all, a step before income makes one: its name
  and its location (town or ZIP, as the existing locate form takes it), via
  `create_budget` and `set_budget_location`.
- The walkthrough is the whole Budget screen in that state. It is not a modal
  and has no dismiss. Leaving the tab and coming back resumes at the first
  unfinished step. Step 1 can be skipped; step 2 cannot (a budget with no
  envelopes is this screen), and "Make these N envelopes" needs at least one
  ticked. Step 3 runs on the same screen right after step 2, in the client's
  state; nothing persists "step 3 done". After a reload between the two, the
  normal Budget screen shows, and pricing is reached from the existing
  "Price it from local data" menu item, which the rows for rent, tax and elec
  also offer as their hint action while the budget has a location and they
  have no figure. A budget whose envelopes were all removed on purpose is
  back at the walkthrough; it has nothing else to show.
- A rail on the left names the three steps with their state (done, current,
  to do), with a one-paragraph plain statement of what a budget is, from the
  board. On a phone the rail becomes a row of three pills above the step.

### Step 1, income

- One figure: this month's income. Prefilled, in order of preference, from a
  recurring income source already defined, else the income-categorised
  receipts of the last full month if any were imported (shown as "seen in
  imports"), else empty.
- Saving it opens the month if it is not open and sets the month's income.
  A checkbox "the same every month" also defines an income source with that
  amount, for the signed-in member.
- Skip leaves income at zero; the card then says so.

### Step 2, the envelopes

- Six groups, each a card with its envelopes ticked. The groups and
  envelopes, in this order, with the category each is fed by:

  | Group | Envelopes (category id) |
  |---|---|
  | Home | Rent or mortgage (rent), Property tax (tax), Repairs & upkeep (upkeep) |
  | Food | Groceries (groceries), Dining out (dining) |
  | Insurance | Home insurance (homeins), Car insurance (carins), Health insurance (healthins, new) |
  | Utilities | Electricity (elec), Gas & heating (heat), Water & trash (water), Internet & phone (internet) |
  | Savings and sinking funds | Emergency fund (emergency), Savings (savings), Travel (travel), Gifts (gifts) |
  | Everyday | Fuel & transport (transport), Clothing (clothing), Personal care (personal), Subscriptions (subscriptions), Fun (fun) |

  Health & medical (health) stays a category for receipts but is not a
  starter envelope; Health insurance is the envelope. The starter category
  list gains `healthins` (People).
- Each row: a checkbox, the name (editable in place), and a chip: "priced in
  step 3" for rent, tax and elec; "Action required" for the rest.
- "Add one of your own" appends a row with a name and a group picker.
- The button "Make these N envelopes" defines them in one proposal, each
  envelope with `group` set to its group's name, fed by its category, with
  no figure (see below), rollover on. Starter categories that are missing are
  defined in the same proposal, via the existing starter-set logic.
- An envelope's `group` is the group's display name. The Budget screen
  orders groups by this fixed list first, then any other group name
  alphabetically, so older budgets with House, People and Future still show.

### No figure yet

- An envelope carries a flag `needsFigure` from the moment it is made until
  a person gives it a number. The flag is event-sourced: `envelope.define`
  gains an optional `needsFigure: true`; any later `envelope.define` for the
  same id without the flag clears it, as does setting this month's
  assignment on it by hand. A typed zero clears it: zero on purpose is a
  figure.
- Giving an envelope a figure means two writes in one proposal: its
  template, for the months to come, and this month's assignment, so the card
  moves today. Copy on the form: "From this month on".
- On the Budget screen such an envelope's row shows the chip "Action
  required" where its figure would be, a one-line hint under its name, and a
  "Set" action that opens the figure form in place. Rows with the flag have
  the warm tint from the board.
- Hints, by starter envelope id; none for the rest:
  - groceries, dining, transport: the last full month's receipts in the
    envelope's categories, when there were any: "Last month's imports show
    $612 at grocers" with a "Use $612" action.
  - upkeep: "A common rule is 1% of the home's value a year."
  - homeins, carins, healthins: "Your policy's annual premium, divided by 12."
  - emergency: "Many start at $1,000, then three months of the envelopes
    above."
  - travel, gifts: "A sinking fund: a yearly amount, saved by the month."

### The card

- Headline: the amount still to assign (income minus this month's
  assignments), in words: "$4,312 still to assign". When assignments exceed
  income: "$310 over".
- Second line: "Income is $6,400. The 3 priced envelopes plan $2,088. The
  other 17 need a figure; give each one and this reaches zero." The counts
  are live. When nothing needs a figure: "Income is $6,400 and every envelope
  has a figure. $310 is still unassigned." or "...They add up to the income."
- Colour: warm (as the board) while any envelope needs a figure or there is
  money unassigned; red when over; green when zero and nothing needs a
  figure. The one-line explanation of green stays on the card.
- A "Go to the next one" button scrolls to and focuses the first envelope
  that needs a figure.
- Income, Planned and Spent in the corner stay. Planned is this month's
  assignments.
- The Today screen carries one notice while envelopes need a figure: "17
  envelopes still need a figure", opening Budget at the first.

### Step 3, pricing

- Runs the existing local-data lookup for the budget's location and shows
  its proposal: for each priced envelope, the figure, the source, the period
  and the caveat, exactly as the tool returns them. Approving sets each
  priced envelope's template and this month's assignment and clears its
  flag.
- When the lookup finds nothing, the step says so in one line and offers to
  set the location, then finishes.
- The source stays on the envelope: the priced envelope's row shows its
  source as a grey chip under the name until a person changes the figure.
  The source is kept on the envelope as an event-sourced note on the
  `envelope.define` that priced it (`source: string`).
- Names: each estimate carries a `label` ("Rent or mortgage", "Property
  tax", "Electricity"), and the tool uses it for a new category or envelope
  instead of the id. Envelopes made by the walkthrough already exist, so the
  common path is an update, never a new lowercase envelope.

### A receipt over the envelope

- Nothing changes about where a receipt lands. When an envelope's available
  amount goes below zero, two things appear until it is back at zero or
  above:
  - On the Budget screen, the envelope's row in the red tint with a chip
    "Short $42", and under it the cover card from the board.
  - On Today, a notice "Groceries is short $42" opening that card.
- The cover card lists up to three envelopes with the most to spare, from
  the existing donor logic, each with a one-tap "Move $42" that runs the
  existing move. Envelopes with less spare than the shortfall are not
  offered. When none qualify the card says so.
- While income is not fully assigned, a second option: "Assign $42 to
  Groceries" from the unassigned amount. It is absent at zero.
- Each action is a proposal approved in one tap; the record shows who moved
  what from where, as moves do today.

### The More menu goes

- The More button and its menu leave the top bar at every width; the four
  tabs stay. On a phone, the hamburger is gone too.
- The household's outside links, when there are any, appear in the person
  menu as a group "Household apps" between Set up your iPhone and Switch
  household, each link as today (label, host, opens in the same tab). The
  Settings row for links is unchanged.
- The Today notice and Settings copy that mention "Links under More" say
  "Links in your menu".

### The phone sheet in two

- Section 1, "Home Planner on your Home Screen": a QR code carrying the
  app's own address as the browser sees it (the page's origin) with a marker
  that asks for the banner, e.g. `/?add=home`. No server call, no code, no
  expiry, no profile. Copy from the board: scan, Safari opens the app with a
  banner that says Share, then Add to Home Screen; nothing to install, no
  password.
- The banner: when the page loads with the marker, is not already running
  from the Home Screen (`navigator.standalone` is false), and this device has
  not dismissed it, the Today screen shows the two-step banner from the
  board at the top. Done hides it and remembers that on the device. The
  marker is removed from the address bar on load so a bookmark never
  carries it. The Home Screen title becomes "Home Planner".
- Section 2, "The Household calendar in Apple Calendar": one paragraph on
  what it is (a calendar account on the phone pointed at the NAS; events
  changed there come back as cards). A warm callout: "It will ask for one
  password. That is your NAS password, the one you sign in to Home Planner
  with. Your user name, alex, is already filled in." A button "Add the
  calendar account" that makes the one-time code as today and shows its QR,
  with the one line about Profile Downloaded and Not Verified. The typed
  steps stay as a fold-out, with the password line.
- The profile holds the calendar account only. The Home Screen web clip
  payload, its checkbox, and the `home` flag are removed from the profile,
  the code endpoint and the tests. The Mac download stays, calendar only.
- The sheet before the NAS address is set behaves as today for section 2;
  section 1 does not need the address and always works.

## Left to the builder

- The exact event shapes for `needsFigure` and `source` on
  `envelope.define`, their replay, and restore's handling of them.
- How the walkthrough's steps keep their state across a reload (the server
  knows income and envelopes; "step done" is derivable).
- The query for last month's receipts per category for the hints, and
  whether it reuses the drift or recurring analytics.
- How the cover card and the Today notice are produced (likely the
  briefing's notices, like the setup notices) and the shape the screen draws
  from.
- The banner's exact markup and where the marker is read.
- Test shapes, following the existing files for tools, setup notices,
  phone-setup and the server routes.

## Rulings from the builder check

These settle the questions a builder raised. They are part of the design.

- **Submits, not cards.** The walkthrough's three steps, the figure form,
  "Use $612", "Move $42" and "Assign $42" each create their proposal and
  approve it in the same request, as the signed-in member. The activity
  record shows who did it, as approvals do today. The existing proposal
  cards are untouched elsewhere; this is one server path that runs a tool
  and approves its proposal when the request says so, and only for these
  named tools.
- **Income.** With no income source, step 1 opens the month with the typed
  figure as its income (the override the open tool already takes); on an
  open month it sets the month's income. "The same every month" defines an
  income source for the signed-in member: monthly, anchored on the first of
  the current month. It can be edited later where income sources are edited
  today.
- **Funded is the figure that moves.** "Planned" on the card and the
  zero-based sums mean this month's assignments (funded), since the month's
  opening snapshot is taken before the envelopes exist. A new tool,
  `set_envelope_figure`, writes the template and this month's assignment in
  one proposal and clears `needsFigure`.
- **Savings envelopes take a plain monthly figure.** No sinking goal is
  created by the walkthrough or the figure form; the existing sinking-goal
  tool remains the way to set one. The travel and gifts hint stays as copy.
- **Pricing only fills envelopes that exist.** `seed_from_location` no
  longer creates a category or an envelope. An estimate whose category feeds
  no envelope in the budget is listed in the proposal as "Not applied: no
  envelope for X" and skipped. In step 2 the "priced in step 3" chip is a
  promise about the lookup, not a state; after pricing, whatever still has
  no figure reads Action required.
- **The flag survives edits.** `needsFigure` is cleared only by a figure:
  `set_envelope_figure`, a `define_envelope` whose request carries a
  template, or an assignment set on the envelope by hand. Rename and regroup
  keep it.
- **Several budgets.** Notices and the cover card are per budget; when the
  household has more than one, the notice names the budget ("Placitas:
  Groceries is short $42").
- **The copy and the tints are in the appendix below**, taken from the
  approved boards, so the builder does not need the canvas.

## Appendix: copy and colours from the boards

Tints (light theme; the dark theme uses the app's existing tokens for the
same roles): Action required chip `#FDF1E3` on `#8A4B08`; the row tint
behind a flagged envelope `#FFFBF5`; the warm card `#FFF8EF` with border
`#D9A066`; the red chip `#FBE7E6` on `#A12622` and its row `#FFF6F5` with
border `#E8B4B1`; the source chip `#EEF0F3` on `#4B5563`.

Walkthrough rail paragraph: "A budget is a set of envelopes. Each holds a
month's money for one thing and the receipts it pays. Together they add up
to the income, no more and no less."

Step 2 lead: "Start with these envelopes. Most households need most of
these. Untick what you do not, rename anything, and add your own at the end.
Every one starts as Action required until it has a figure."

Step 2 footer: "Public data for the household's location prices rent,
property tax and electricity. Each figure comes with its source and lands as
that envelope's monthly plan. Everything else stays Action required until
you type a number, and the budget says how much is still unassigned."

Card, needing figures: "$4,312 still to assign" / "Income is $6,400. The 3
priced envelopes plan $2,088. The other 17 need a figure; give each one and
this reaches zero." / button "Go to the next one" / "When every envelope has
a figure and they add up to income, this card turns green."

Cover card: title "Cover the $42"; body "The receipt from [payee] for
$87.40 is in Groceries, which had $45.40 left. An envelope never pays what
it does not hold, so this one is marked Action required until the shortfall
is covered."; group labels "Take it from another envelope" and "Or, while
income is not all assigned"; notes "Listed with the most to spare first.
Envelopes with less than $42 left are not offered." and "This choice
disappears once the budget reaches zero."

Phone sheet, lead: "Two separate things. Do either, or both." Section 1
title "Home Planner on your Home Screen"; body "Scan with the camera.
Safari opens Home Planner with a banner that says what to tap: Share, then
Add to Home Screen."; note "That is all it does. No profile, nothing to
install, no password. The code is just the household's address." Section 2
title "The Household calendar in Apple Calendar"; body "This adds a
calendar account to the phone, pointed at the NAS. The Household calendar
then shows in Apple Calendar with alerts and Siri, and an event you change
there comes back here as a card to approve."; callout "It will ask for one
password. That is your NAS password, the one you sign in to Home Planner
with. Your user name, [account], is already filled in."; button "Add the
calendar account"; note "Opens as a profile: Settings → Profile Downloaded
→ Install. It is unsigned, so iOS says "Not Verified"."; fold-out "Type it
instead" with the server, user name and "Password: your NAS password."

Banner: title "Put Home Planner on your Home Screen"; steps "Tap Share, the
box with the arrow, at the bottom of Safari." and "Choose Add to Home
Screen, then Add."; note "It opens full screen, like an app, signed in as
you."; button "Done".
