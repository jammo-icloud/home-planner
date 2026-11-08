# Budget as rows, each envelope its own page

**Status:** approved by the owner on 2026-11-07 from a clickable mockup of
four phone screens (the Budget list, an envelope with a figure, an envelope
with no figure, this month's funding) and, after a second pass, the
amount-plus-period figure control. This document is what those screens mean.

## Intent

The envelope card on the Budget screen grew one button at a time. Open, it
shows thirteen things: two status words in its header, a Set or Change button
that stays on screen after it has done its job, two forms with two different
save verbs (a standing figure that saves at once, and this month's money that
comes back as a proposal), a row of three unrelated verbs (preview a move,
turn into a savings goal, remove), a Reason placeholder written to the
developer, spent shown three times, and a body four screens tall on a phone.
Nothing on screen says that "From this month on" and "Set funding to" are
different things. The figure field accepted "100" as a month, but its
placeholder taught the opposite, so the owner believed a period was required.

Settings had the same disease and was cured the same way in 0.5.0: a list of
rows, each opening its own page, one form at a time, at the top, with focus
in it. This release applies that to envelopes.

The owner's bar: "design this with the intention of using it like an actual
envelope budgeting app in a modern design standard."

## Goals

- The Budget screen is a list. Each envelope is one tappable row: name, what
  is left this month, a thin bar, a chevron. No buttons in rows.
- Tapping a row opens the envelope's page. The page shows the envelope first
  (left, funded, spent, as one block), then one line per thing you can change,
  each with one action, then the receipts, then two quiet links.
- A figure is entered as an amount and a period chosen from a list, never as
  typed words. A bare number is a month.
- Every write still goes the way it goes today: a figure saves at once; this
  month's money comes back as a proposal, read as a short receipt with
  Approve. The server does not change.
- Today's reminders and the summary card's "next" land on the right page with
  the right thing focused.
- Back and Escape return to the list exactly where it was.

## Non-goals

- No change to Import, Compare, the first-run walkthrough's steps, the
  unsorted-receipt queue, the categories editor, or the budget menu.
- No change to the server's tools, routes, or figures. `basis` stays
  `{ amount, per }` with the six periods; monthly rounding stays the server's.
- No typed-words parser on the page. Whether the server keeps a text form for
  Claude's own tool calls is not this release's concern (it has none today:
  the tools take `amountCents` and `basis`).
- No desktop-specific layout. The column is the same reading column as
  today, at most 720 wide, and the pages read the same on a desk.
- Asking Claude from the Budget screen (shelved by the owner on 2026-11-07).

## The list

`#budget` keeps its order: the summary card (`.toassign`, its words and tone
the server's), the unsorted queue, the month's own action when due, then the
groups. Each group is a heading and one `.rows` surface; Savings stays a group
of its own, last, with its check line under it. The order of groups and of
envelopes inside them is unchanged.

Each envelope is one `a.row` (or a button; it must be reachable by Tab and
Enter) laid out in three columns:

- left: the name, and under it a 4px bar. The bar shows spent against funded
  (carried-in money counts as funded, as today). A savings envelope's bar
  fills toward its goal. An overspent bar is full and in the problem colour.
- right: the amount, bold, and under it one small line. For an envelope with a
  figure: what is left, and "left of $1,200" (funded, including carried in).
  For a savings envelope: saved so far, and "of $3,000 goal · June" (or "of
  $x of estimates", or "no estimates yet"). For a short envelope: "Short $120"
  in the problem colour, and "$320 spent of $200". For an envelope with no
  figure: "No figure yet" in the figure-chip colour, and what has been spent
  ("$212 spent" or "nothing spent"), with no bar fill.
- a chevron.

Row tints stay: a no-figure row is the warm `--figure-row`, a short row is
`--short-row`. The chips "Action required", "Short $x" and the source chip
leave the list; where the figure came from is said on the page. The words
"Action required" leave the Budget screen and the walkthrough's copy; a row or
a line says "No figure yet" or "needs a figure" instead. The server's card
line already says "still need a figure".

Nothing in a row opens inline. The Set, Change, Use, Price-it-from-local-data
buttons, the hint paragraph, the cover card, the meta line and the open body
all go from the row. What they did lives on the page.

"Add an envelope" stays at the foot of the list, as it is today, except that
its figure field is the figure control below.

## The page

Tapping a row saves `window.scrollY` and the envelope id, hides the list and
draws the page in the same `#budget` box (the budget head with its name and
Budget / Import / Compare stays above it). The window scrolls to the top once.
The page, top to bottom:

1. **Head.** A `‹ Budget` button, the envelope's name as the heading, and
   under it a small line: group name · month name. For a savings envelope the
   group line says "Saved in Savings".
2. **The envelope.** One card: the big number is what is left this month,
   with "left" after it in small type; a meter; a line with funded on the
   left and spent on the right. Variants:
   - *No figure yet:* the card is replaced by the question form (below). The
     first thing on the page is the only thing to do.
   - *Short:* the card shows left as a negative in the problem colour and,
     under it inside the same card, the cover block: the title "Cover the
     $120", the sentence naming the receipt that took it under (the server's
     words as today), then the donor rows (each "Move $120" button) and the
     assign-from-income button while it exists. One tap, approved at once, as
     today; the page redraws from the new month.
   - *Savings:* the big number is saved so far, "of $3,000 by June" (or the
     estimates wording) in small type, and the meter fills toward the goal.
   - *Closed month:* the card as it stood; no forms anywhere on the page and
     no actions, only receipts.
   - *Carried in and adjusted:* the funded side says "$1,400 funded · was
     $1,200" when the month was adjusted, and "$80 carried in" when it was.
3. **Each month.** Heading, then one line: "$1,200 a month" and under it
   "from $14,400 a year" when the basis is not monthly, or where the figure
   came from when the server gives a source (public data), or nothing. The
   action is Change. Change swaps the line for the figure form in place.
   Saving returns the line. A savings envelope's line says "$250 a month
   toward $3,000 by June" (or the estimates wording) and its Change opens the
   existing goal form as this section's form.
4. **This month.** Heading, then one line: "$1,200 funded" and under it "as
   planned", or "was $1,200" when the month was adjusted. (The server does not
   record where a month's money came from, and this release does not add
   that.) The action is Adjust, which opens this month's funding page
   (below). With no figure yet, the line says what has been spent and
   "Nothing funded yet. Give it a figure first." with no action.
5. **Receipts.** Heading with the count, then the existing receipt list
   (`showReceipts`) in a `.rcpts` surface: payee, date, amount, and each
   receipt's existing editor when tapped. An empty list is one line.
6. **Foot.** Two quiet links under a hairline: "Make this a savings goal"
   (or "Change its goal" on a savings envelope; this opens the same goal form
   as Each month's Change does on a savings envelope) and "Remove this
   envelope", which opens a page of its own: the name, one line saying its
   receipts stop belonging to any envelope, a Why field, Remove. Remove shows
   the server's proposal in place of the form, the same "This will" review
   as the funding page, with "Change it" and Approve; approving returns to
   the list with the row gone.

Focus goes to the first field when the page opens with a form (the question
form), otherwise to the heading, with `preventScroll: true`. Back, Escape
(a document listener while a page is open, ignoring an open sheet, as
Settings does), or the browser's back when the app wires it, return to the
list, restore `scrollY`, and focus the row that was opened. A save on the
page redraws the page from the freshly loaded month; it does not go back.
A reply that lands after the person has left the page draws nothing
(`envelopePage?.id === id` on every async continuation).

## The figure control

One component, used by the Each month form, the question form and Add an
envelope. It reads as one phrase in one bordered field:

    [ $ | 14,400                 | a year ▾ ]

- The amount is an `input` with `inputmode="decimal"`, no border of its own,
  the dollar sign before it as text. Whole dollars by default; cents allowed.
- The period is a native `select` attached to the right end, styled as part
  of the field (sunken background, hairline on its left, a chevron drawn by
  the page since `appearance: none` removes the native one). Options, in this
  order and with these words: a week, a fortnight, a month, a quarter, every
  six months, a year. Values are the server's `Per` names (`week`,
  `fortnight`, `month`, `quarter`, `half-year`, `year`). It starts at "a
  month" on a new figure and at the saved basis's period on an existing one.
- Under the field, one live line: "= $1,200 a month" when the period is not a
  month (the server's rounding, up to the cent, repeated on the page as
  today's `monthlyOfFigure`); nothing when it is; "A number, in dollars." in
  the problem colour when the amount is not a non-negative number.
- The receipt averages, when the server sends them, are chips under the field
  ("Last month $1,140", "3-month average $1,215", "6-month average $1,180").
  A chip fills the amount, sets the period to a month, and shows as selected
  until the field is edited. They fill, never save. When the server offers
  public-data pricing for the envelope (`hint.price`), a "Price it from local
  data" chip sits after them and runs the budget menu's pricing action, as the
  row's button does today.
- Under the chips, the server's hint sentence (`hint.text`, for example "A
  common rule is 1% of the home's value a year.") in small muted type, when
  there is one. It is advice about the amount, not about typing.
- No helper sentence about how to type. There is nothing to teach.
- Submitting sends what the tools take today: `basis: { amountCents, per }`
  when the period is not a month, `amountCents` when it is. A typed 0 is a
  figure. The whole field shows the focus ring when either part is focused.

`parseFigure`, `figureProblem`, `basisText`'s use for prefilling the input,
and the "Say how often" message go. `basisText` may stay for the "from
$14,400 a year" line.

## This month's funding page

Opened by Adjust. Head: `‹ <envelope name>`, the heading "This month's
funding", a line: "<Name> has $1,200 funded for November and $860 of it
left." Then one form:

- *Funded this month*, a decimal amount, prefilled with the current funded
  amount. Under it a live line: "+$200 more than planned" / "$200 less than
  planned; it goes back to Money not yet assigned" (a decrease is always a
  `set_assignment`, today's rule) / nothing when unchanged.
- *Take it from*, a select: "Money not yet assigned · $430" first, then every
  other envelope with what it has left, as today's `buildEditor` builds it. A
  decrease cannot name another envelope (today's rule), and the live line
  says so instead of waiting for the server.
- *Why*, one line, required as today; the placeholder is an example ("e.g.
  two birthdays this month"), and a small line under it says "One line. It is
  what gets read next month when someone asks why." No sermon.
- Cancel returns to the envelope's page. Save runs the same tool call as
  today (`set_assignment` from the pool, `move_money` from an envelope) and
  shows the proposal in place of the form as a short receipt: the heading
  "This will", then the proposal's effects one per line, then the reason in
  quotes, then "Change it" (back to the form, values kept) and Approve
  (the proposal's summary as its label, as today). Approve commits, shows a
  done state with the new figures and a "Back to <envelope>" button, and the
  envelope's page redraws from the new month when returned to.

## Deep links

- `openBudgetAt(budget, envelope, cover)` opens the envelope's page directly
  (no scrolling of the list, no simulated tap): with `cover`, focus on the
  first cover button; while the envelope needs a figure, focus in the amount;
  otherwise on the heading. Back from a page opened this way returns to the
  list at the top with the row in view and focused.
- The summary card's "next" (`#ta-next`) opens the first no-figure envelope's
  page, focus in the amount.
- The savings check line's Settings link, the Price-it action on the budget
  menu, and the walkthrough are unchanged.

## What is deleted

`envelopeRow`'s meta, bar-in-row, acts, body and toggle; `openEnvBody`;
`openFigureForm` (replaced by the page's form); `buildEditor` (replaced by
this month's funding page); `coverCard` as a row child (its content becomes
the page's cover block, the same tool calls); `goToRow`'s scrolling (replaced
by opening the page); the `.env-head`, `.env-body`, `.env-acts`, `.env-sub`,
`.env-hint`, `.edit`, `.figure-form` CSS once nothing uses them; the
"Action required" chip and wording. `panel()` stays for Add an envelope and
the budget menu's forms. `showProposal` may stay for the receipt editor; this
month's funding page draws its own review.

## Server

No route, tool or field changes. One string changes: the walkthrough's
proposal effect in api/src/tools.ts, "Every one starts as Action required
until it has a figure", becomes "Every one starts without a figure until it
is given one", with its test. The Claude-facing tool descriptions that say
"Action required" keep their words; they are not shown to a person.

## Copy

Sentences, Apple's spellings, no exclamation marks. Status words are nouns
or states ("No figure yet", "Short $120", "as planned", "was $1,200").
Placeholders are examples, never instructions. The one question on a new
envelope is "How much each month?" with the field label "From this month on".

## Accessibility and the phone

Rows are real links or buttons, 44px tall or more, with the amount and the
state in their accessible name. The page heading is an `h1` in order. Every
form field has a label; the period select has `aria-label="How often"`.
The live line is `aria-live="polite"`. Focus is managed on every transition.
Nothing depends on hover. At 375 × 812 the first field of any form is in the
top half of the viewport when the page opens, so the keyboard cannot hide
it. Dark and light both read, through tokens only.

## Left to the builder

- Exact CSS values, within tokens.css; the mockup's numbers (64px rows, 4px
  bar, 8px meter, 10px radius on the field) are a guide.
- Whether the page is drawn by one `renderEnvelopePage(id)` that reads from
  `month` or by smaller renderers per section; the async guard is the rule,
  the structure is the builder's.
- How the receipt editor's own proposal card nests inside `.rcpts`.
- Whether the Remove page and this month's funding page share one page
  frame helper with the envelope page.

## Mockup

The approved boards are on the owner's private canvas "Envelope pages"
(claude.ai artifact 9x6MMkNVv59SYRtY3uL5u4). Static copies of the four
screens are not in the tree; the words above are the contract.
