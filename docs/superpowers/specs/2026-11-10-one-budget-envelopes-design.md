# One budget, envelopes and categories (design, 0.10.0)

Status: draft for the owner's approval.

## Why

The Budget side speaks two vocabularies that do not line up. Envelopes sit under **Bands** (Home, Food,
Insurance, Utilities, Savings and sinking funds, Everyday). Receipts carry **Categories** (Clothing, Gifts, Travel,
22 of them), and an envelope is "fed by" one or more categories. The starter set made nearly one category per
envelope, so a person sees two near-duplicate lists under different names. The Add an envelope form (Name, Band, a
figure, a "Fed by" multi-select, then "Show what this would do") needs explaining at every field. And a household
can hold several budgets, each quietly re-sorting every receipt through those shared categories, which a person
cannot see, Claude cannot summarise, and Today cannot report on.

The owner's words: "There is no magic here. Category is envelope. Trying to magic away the act of sorting a receipt
is not helpful." And: "one and only one budget per household."

## The decisions (owner's)

1. **One budget per household.** Creating, renaming, archiving, copying and comparing budgets go. Two homes are two
   households; each receipt lives in exactly one household.
2. **A receipt is sorted into one envelope, by a person** (helped by rules and Claude's suggestions, as today).
   The old receipt-level category is gone: what a receipt was "categorised as" is now simply the envelope it is in.
3. **"Category" is the heading envelopes sit under** on the Budget page (today's Band). On screen it is only ever
   "category": never band, area, group or kind. Plan's **areas** are a separate Plan-page word and are untouched.
4. **The Budget page adds two things: a category, or an envelope.** Adding an envelope asks its name and its
   category; the category can be picked or typed new, so the first envelope can create its category.
5. **A new envelope lands at $0 planned and $0 funded** for the month, with no "Show what this would do" step.
   The person balances things afterwards.
6. All data is test data: no migration and no compatibility with old logs. The log must replay its own new lines.

## Goals

1. Two nouns on the Budget side, each meaning one thing: **envelope** (where money is set aside and where a receipt
   is sorted) and **category** (the heading an envelope sits under).
2. Sorting a receipt is choosing its envelope everywhere: import, To sort, a receipt's Edit, splits, rules,
   Claude's suggestions, Restore a removed receipt.
3. Adding a category or an envelope is one short form and one press.
4. Nothing a person can do today is lost without a decision recorded here.

## Non-goals

- Plan's areas, Calendar, Today and Bills' dates, except for words that name budgets or categories.
- How a month is funded, moved or closed.

## Anti-goals (a failure even if it works)

- The word "category" anywhere on screen meaning what a receipt is sorted into.
- Any trace of a second budget: a picker, a budget name, a "which budget" argument, a Compare.
- A receipt counted, or offered for sorting, anywhere but its one envelope or To sort.
- Any Budget-page element dropped without a fate in the ledger.

## Data model

**The budget layer goes.** A household's state holds its envelopes, categories, months, income sources, bills,
savings account and location directly. No op, tool, route or page carries a `budget` argument or shows a budget
name; the Budget page's title is "Budget". Retired: `budget.create`, `budget.rename`, `budget.archive`,
`create_budget` (and its `copyFrom`), `rename_budget`, `compare_budgets`, the Compare tab and the budget picker.
`budget.locate` becomes the household's location (same fields), still set from "Where it is".
*(My call on shape: if keeping one internal record reduces churn, the builder may, so long as nothing outside the
fold sees it.)*

**Receipts name an envelope.** `Txn.envelope: EnvelopeId | '__transfer' | '__income' | '__split' | null` replaces
`Txn.category`. Split parts are `{ envelope, amount }`. Rules are `{ id, match, envelope }`. New ops
`txn.sort { txn, envelope, manual?, suggestedBy? }`, `txn.split { txn, parts: [{ envelope, amount }] }`,
`rule.add { rule, match, envelope }`. Retired: `txn.categorize`, `category.define`, `category.archive`,
`category.sinking`, `State.categories`, `Envelope.match` (and its `payee` predicate), `overlappingCategories` and
every "already feeds" guard. A receipt counts in its envelope, and only there. Transfers, income and split keep
their reserved values and the starter rules that point at them.

**Envelope ids** are made from the name when it is added and never change; a rename changes only the name. Two
envelopes cannot share a name (case ignored): "There is already an envelope called Groceries."

**Categories are first class and ordered.** `category.add { category, label }` adds one at the end;
`category.rename { category, label }`; `category.move { category, to }`; `category.remove { category }` is refused
while any envelope sits in it. These reuse the retired op names with new meanings, so replay of a new log is
unambiguous. `envelope.define` carries a required `category` in place of `group`. A new category and its first
envelope are written in one append.

**Removing an envelope** leaves its receipts' lines as they are (the log is history) and its id is reserved: a
later envelope of the same name gets a fresh id, so it never pulls old receipts back. Receipts dated in a **closed
month** stay in that month's history under the removed envelope's name, marked "removed"; closed months never
change. Receipts dated in a month not yet closed go to To sort. The confirmation counts only those: "Its 12
receipts from this month go back to To sort." Rules pointing at it are removed with it and named in the same
sentence; its bills go with it. *(My call.)*

**To sort** is receipts with no envelope (`null`), plus receipts in a month not yet closed whose envelope (or any
of whose split parts' envelopes) no longer exists, so nothing quietly disappears. A split receipt with a missing
part goes to To sort whole, shown with its split and the missing part blank; choosing an envelope for that part
sorts it. *(My call.)* This replaces "unsorted" and "uncategorised" everywhere, including Today's waiting item and
the briefing.

**Savings estimates move onto the envelope.** A savings envelope's "every" goal carries its own
`{ cost, everyYears }`; today's sum over several categories becomes one estimate. Pace's "committed" test becomes
"the envelope is a savings envelope". Fix in passing: the Savings check by date (`sinking.ts balanceAsOf`) skips
split receipts; it goes through `partsOf` like every other rollup.

**Bills and plans** drop the budget from their keys: a bill record is keyed by (envelope, key); a plan links to an
envelope. A repeating charge is grouped by payee and envelope (was payee and category).

## The Budget page

- **Head:** "Budget", the month, and the Budget / Import tabs (Compare goes). The menu keeps Where it is, Price it
  from local data and Discard this month's plan; New budget, Rename it and Archive this budget go.
- **The list** is envelopes under their category headings, in category order, then envelope order. Savings
  envelopes sit under the category they were given, with the savings mark they carry today. *(My call: no separate
  "Saved in Savings" heading; a second kind of heading would be a second noun.)*
- **The Add control** (where "Add an envelope" is now) offers **Add an envelope** and **Add a category**.
- **Add an envelope:** Name; Category, a picker of the categories with a last choice "New category…" that turns
  into a text field. One button, **Add it**. No figure field, no "Fed by", no proposal step. It lands at $0
  planned and $0 funded this month and template $0; its page opens with the figure's Change ready. *(My call: it
  is not flagged "No figure yet"; $0 is a figure the person chose.)*
- **Add a category:** Name; **Add it**. It appears as an empty heading reading "No envelopes yet", with its own
  "Add an envelope" link that opens the form with that category chosen.
- **A category heading** has a small menu: **Rename**, **Move up**, **Move down**, and **Remove** when it is empty
  (otherwise the menu says "Move its envelopes first"). *(My call: no drag.)*
- **An envelope's page** gains **Rename** and **Change its category** beside the figure, goal, bills and Remove.
  Its subtitle reads `Category · Month`.
- **Every receipt picker** (To sort, import preview, a receipt's Edit, split parts, Restore a removed receipt)
  lists envelopes by name under their category headings, then "Not spending" (transfer, income), then "Split
  across envelopes…". Restore a removed receipt, the one picker that shows raw category labels today, changes to
  this.
- **Sorting a receipt by hand writes at once**, as figure changes do now: the "Show what this would do" step goes
  from To sort and from a receipt's Edit. A rule offer still asks before the rule is added. *(My call, extending
  decision 5 to the other everyday write.)*
- **Gone:** the Categories sheet (`#cat-sec`) and its menu entry; the "spent in categories no envelope here covers"
  note (with one budget, every sorted receipt is in an envelope). Settings' **Budget** row becomes **Savings
  account** and keeps only the savings-account form.
- **First run:** the walkthrough's groups become the starter categories (Home, Food, Insurance, Utilities, Savings
  and sinking funds, Everyday) and its rows the starter envelopes under them, keeping today's ids so local pricing
  and the figure hints keep working. A row of one's own picks a category the way Add an envelope does. The starter
  rules (card payments as transfer, payroll and dividends as income) stay.
- **First run's first step** "Name the budget" becomes "Where it is": the town and ZIP local pricing uses, no name.
  A new household starts with no categories and no envelopes; the envelopes step brings the starter categories with
  the starter envelopes. First run counts as not started until the location step or the envelopes step is done.
  The walkthrough's screens are in the ledger like every other. *(My call.)*

## Claude

- The method prompt (`claude.ts` METHOD_RULES) and the briefing's wording are rewritten: one budget, receipts
  sorted into envelopes, categories as headings. The "habit transfers to the other place" lines and every
  move-planning wording are deleted: a household never reads another household's receipts. Planning a future home
  is its own household with its own figures. *(Follows from decision 1.)* Nothing
  says "budget" as a choice, "category" about a receipt, or compares budgets.
- `categorize_transactions` becomes `sort_receipts` (envelope ids). `define_category` / `archive_category` become
  the heading tools. `add_starter_set` folds into `make_starter_envelopes` (keeping only the transfer and income
  rules). `create_budget`, `rename_budget`, `compare_budgets` go. Every tool loses its `budget` argument. Tools that
  reported categories report the envelope (and its category heading where they report grouping).
- Claude's suggestions are envelope ids; `suggestedBy` stays on the receipt. Claude itself still only proposes;
  "no proposal step" applies to a person's presses on the page.

## Restore

The bands become "Receipts and rules" and "Budget" (was "Budgets"). Restoring receipts and rules into a household
whose budget has no envelopes, without the Budget band, is a missing prerequisite named in words. A receipt or rule
naming an envelope that is not there is legal and lands in To sort; it is never refused or left out. The Budget
band writes before receipts.

**Budget band in place never merges.** Lines already in this log are left out as today (a household's own backup
restores over itself). Otherwise the Budget band restores in place only into a household whose budget is empty (no
categories, no envelopes, no income sources, no bills, no location, no month opened); into any other it is a
collision in words: "This household already has a budget. Restore it as a new household instead." The Months band
follows the same rule. As a new household, everything lands as today. *(My call: a wrong merge is silent, so the
file's own rule, refuse rather than merge, stands.)*

## What is left to the builder

Op and field names beyond those above; the exact copy of empty states and refusals (plain words, one noun per
concept); how the category menu is drawn; test fixture shape (the two old-log fixtures are replaced by one in the
new vocabulary); how the work is split into releases or tasks.

## Process requirements

- Before any page edit, a **ledger of every element on today's Budget page (head, menu, picker, tabs, Compare),
  envelope page, To sort queue, import preview, receipt Edit, Restore a removed receipt, Categories sheet and
  Settings' Budget row**, each with a fate (kept / changed / removed / moved), owned by a plan task and pinned in
  `api/test/page-ledger.test.ts`.
- Version 0.10.0. Public-tree rule: stand-in names only.
