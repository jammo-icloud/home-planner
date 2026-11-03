# Split receipts, and the model that answers "split" and writes the rule

Status: design, for review. Written on 2026-11-02 from the owner's brief, with
the owner away; every place the brainstorm needed an answer from him is marked
**Assumption** and can be overturned without unpicking the rest. Companion to
`2026-10-28-home-planner-design.md` (the log, facts and interpretations) and
`2026-10-28-today-thread-design.md` (Import in the language of envelopes, Haiku
suggesting, rules offered after acceptance).

## Intent

Some receipts are not one kind of spending. A warehouse-club run is groceries, a set of
tyres and a birthday present on one line of the bank export. Today that line
has exactly one category, so it either lands whole in Food and makes Food look
overspent, or sits unsorted for ever. The owner's words: *"[The warehouse club] is a multi
category split. And that should be a valid option in the list of options for
the Model to respond with!"*

The second half is about work over time. Each import asks Haiku about every
payee no rule caught, and a person accepts the answer, and the app then
guesses a rule string with a regex. The owner wants the model to *reduce
matching requests over time by writing the rule, not only the category*: when
Haiku has looked at `BIGBOX WHSE #0100 SPRINGFIELD` and said what it is, it is
also the right moment to say that `bigbox` is the part that identifies the
merchant. A rule whose answer is "split" then means *always put this in front
of a person to divide*, and that payee is never sent to the model again.

Two things, built in this order because the second needs the first's vocabulary:

1. **Split transactions.** One receipt divided across several categories by
   amount, in integer cents, summing exactly; rolled into envelopes and months
   by part; visible as a split everywhere a receipt is shown; made from the
   import screen and the unsorted queue.
2. **The model answers "split" and writes the rule.** Haiku may answer
   `__split` (with the categories it is usually split between, when it can
   say), and returns for every match the shortest substring of the payee that
   names the merchant. The server checks the string before anyone sees it.
   The Remember box offers the model's string, with the regex as the fallback.

## Goals

- A member can divide a receipt across two or more categories so each part
  lands in its envelope and month, and the envelope's receipts list shows the
  part, not the whole.
- Every existing log replays unchanged. A log with no splits produces the
  same state and the same numbers as before.
- Restore by scope keeps working: a split is a fact, like a categorize.
- Haiku may answer "split" for a payee, and the UI then asks a person to
  divide the receipt rather than filing it.
- Haiku's rule strings replace the regex guess wherever the model was asked;
  the regex still runs when Claude is not configured.
- A rule whose target is split never results in a model call for that payee.
- The rule language stays a case-insensitive substring. No predicate grammar.

## Non-goals

- Splitting by percentage, by receipt line item, or by tax. By amount only.
- Splitting one receipt across two **budgets**. A split is a fact (categories);
  each budget decides where the parts land, as it does for any category.
- Editing a split from the Activity feed. (Editing from the envelope's
  receipts list was a non-goal in the first draft; the owner overruled that,
  see "Editing a split".)
- Haiku guessing the **amounts** of a split. It is never sent amounts, and a
  guess at how much of the warehouse-club run was groceries would be a number a person then
  has to check. It may name the categories; a person types the amounts.
- Rules that split automatically with fixed proportions. A split rule means
  "ask a person", by the owner's brief.

## Anti-goals

- A split that double-counts: the same dollars in two envelopes, or a part
  that counts in its envelope *and* the whole receipt somewhere else.
- A split whose parts drift from the receipt: parts that sum to anything but
  the transaction's amount must be impossible to write to the log.
- An unsorted receipt that looks sorted because a rule marked it "split".
  Marked-to-divide is a kind of unsorted until a person divides it.
- A rule string that would silently re-file history: a model string that
  matches receipts already filed under a different category is never offered.
- The model writing anything. Every split and every rule is still a proposal
  a member accepts, or a row a member commits.

## Constraints

- Append-only JSONL log per household; state is a replay. Integer cents.
  Every event the store appends is validated and dry-run through the fold
  before it is written.
- Claude (the actor) may not write `txn.split` or `rule.add`; they come from
  a member, through a proposal or an import commit, as today.
- Haiku is sent payee strings and picker labels only. No amounts, dates or
  accounts. The model is `CLAUDE_MATCH_MODEL`, default `claude-haiku-5-5`.
- `MATCH_THRESHOLD` (0.7) stays the floor for a suggestion of any kind.
- The data under `api/data/` and `site/*.jsonl` is never committed.
- `npm test` and `npm run typecheck` in `api/` pass at the end of every task.

## Part 1: split transactions

### The shape

A transaction keeps its single `category` field, and gains an optional list
of parts. The category of a split receipt is the sentinel `__split`.

```ts
export const SPLIT = '__split' as const;

export interface SplitPart {
  readonly category: Assignment;   // a CategoryId, or __transfer / __income; never __split
  readonly amount: Cents;          // signed, same convention as Txn.amount
}

export interface Txn {
  …
  category: Assignment | null;     // SPLIT when `split` is set
  split?: readonly SplitPart[];
}
```

Why a sentinel rather than `category: null` plus parts: every reader that
asks "is this receipt sorted?" asks `category !== null`, and a split receipt
*is* sorted. Why not replace `category` with a list everywhere: that would
touch every reader in the API and the UI for a case that is the exception,
and the single-category receipt would become a one-element list that every
screen has to unwrap. The sentinel keeps the common case as it is and makes
the split case impossible to mistake for a single category.

`isSpend(SPLIT)` is **false**. That is deliberate: any reader not taught
about splits treats the whole receipt as not-spending, which can
under-count but can never double-count. The readers that matter (envelopes,
pace, held counts, the receipts list) are taught, below.

Two helpers in `types.ts` so no reader reinvents the rule:

```ts
export const isSplit = (t: Pick<Txn, 'category'>): boolean => t.category === SPLIT;

/**
 * How a receipt is filed, one line per category: the parts of a split, or the
 * one line a single category is. Empty for an unsorted receipt.
 */
export function partsOf(t: Pick<Txn, 'category' | 'amount' | 'split'>): readonly SplitPart[];
```

`partsOf` is the one join readers use. A reader that wants only spending
filters its lines with `isSpend(part.category)`.

Because `CategoryId` is `string`, `__split` already type-checks as an
`Assignment`; `isSpend` is the gate, as it is for `__transfer` and
`__income`. `Rule.category` may therefore be `__split` without a type change.

### The event

```ts
| { op: 'txn.split'; txn: TxnId; parts: readonly SplitPart[]; why?: string }
```

Replay (`applyTo`):

- No such transaction: inert, like a categorize for a removed receipt.
- Otherwise `t.category = SPLIT; t.split = parts; t.manual = true;`
  `delete t.suggestedBy`. (A split is always a person's work: Haiku may say
  "split" but never the amounts, so there is nothing of Claude's to credit.)
- `txn.categorize` with a real category or non-spend clears `t.split`. The
  two events replace each other; the latest wins, as today.

Validation (`validate`, run at append time and on load):

- `parts` has at least two entries. One part is a categorize; refusing it
  keeps "split" meaning what it says. **Assumption.**
- Every `amount` is an integer and non-zero. Signs are not constrained: a
  receipt with a refund line on it may carry a negative part. **Assumption.**
- No category appears twice. Two lines for Groceries are one line.
- No part's category is `__split`.
- `txn.categorize` may not carry `category: '__split'` (use `txn.split`).
- A `txn.add` row may not arrive already split (`category: '__split'` or
  `split` set). A split at import is written as `txn.add` followed by
  `txn.split` in the same batch, so there is one way to say it.

The sum check needs the transaction, so it lives in the fold: `applyTo`
throws `ReplayError('the parts of a split must add up to the receipt')` when
the parts do not sum exactly to `t.amount`. The store dry-runs the fold
before writing, so a mismatched split is refused, never logged. A part whose
category does not exist is refused by the tool and by the import route (as
`txn.categorize` is today), not by the fold: the fold must still replay an
old log whose category was later archived.

`why` is optional, matching `txn.categorize`: sorting a receipt is not a
money-moving edit in the sense `REQUIRES_WHY` protects. **Assumption.**

`scopeOf('txn.split')` is `facts`. `describe()` reads: *"split a receipt
across Groceries $120.00 and Household $45.00"*. The Activity feed needs
nothing else: `txn.split` is a change, not bookkeeping, and consecutive
splits by the same person collapse like categorizes do.

### Rolling parts into envelopes and months

`envelopes.ts` gains one type and teaches `monthView` and `carriedInto` to
work by part.

```ts
export interface EnvelopeLine {
  readonly txnId: TxnId;
  readonly category: CategoryId;
  /** This part's money out, positive. For a split, the part; otherwise the receipt. */
  readonly amount: Cents;
  /** True when the receipt has other parts elsewhere. */
  readonly split: boolean;
}

export interface EnvelopeView {
  …
  readonly txnIds: readonly string[];   // kept; derived from lines, each id once
  readonly lines: readonly EnvelopeLine[];
}
```

`monthView` iterates `partsOf(t)` for each transaction of the month, keeps
spending parts, and resolves each part's envelope with `envelopeFor(budget,
{ payee, memo, category: part.category })`. `envelopeFor` and `matches`
change their parameter to `Pick<Txn, 'payee' | 'memo' | 'category'>` so a
probe works; a whole `Txn` still satisfies it, and `pickerOptions` already
builds exactly this probe. A part with no envelope in this budget joins
`outside`, as a whole receipt does today. `carriedInto` does the same walk
for the previous month.

`MonthView.outside.txnIds` keeps its name; a split receipt may appear in an
envelope's `txnIds` and in `outside.txnIds` at once, because one of its parts
is in each. That is correct and the UI shows the part amount in each place.

`pace()` sums `e.lines` by `line.amount` instead of `Math.abs(t.amount)` over
`e.txnIds`. The fixed-charge key for a line is `chargeKey(t.payee,
line.category)`. A split receipt as a whole is never a fixed charge or a
recurring subscription: `fixedCharges` and `recurring` skip `__split`
through `isSpend`, and a warehouse run is not a bill.

`explain_envelope` keeps its `transactions` key and its sign convention
(negative for money out, as `fmtExact(t.amount)` reads today) and lists one
entry per **line**: `{ date, payee, amount, category, of? }` where `amount`
is the part's share and `of` is the whole receipt, present only for a
split, so the UI can read *"−$120.00 of −$165.00"*. A split whose two parts
both feed the same envelope is two entries with the same receipt.

The three counts in `tools.ts` that ask "which receipts are filed under this
category" (envelope removal's orphan count, category archive's held count,
and any `category` filter in `list_transactions`) use `partsOf`.

`unsorted()`, `uncategorizedOnly` and every "needs a person" check stay
`category === null`. A split receipt is sorted.

### How a split reads

`list_transactions` rows gain `parts: [{ category, amount }] | null` beside
`category` (`'__split'` for a split). Filtering by `category` matches any
part. Claude reading the ledger from the thread can then answer "how much of the
warehouse-club run was groceries".

The Activity feed shows the `describe()` line. The envelope's receipts list
(Budget, open an envelope) shows the part with "of $165.00" after it.

### Making one

**The tool.** `categorize_transactions` keeps one entry per transaction and
learns one more shape of entry:

```ts
{ txnId, category: '__split', parts: [{ category, amount: Cents }], alsoAddRuleMatching?: string }
```

It validates the parts as the fold will (count, integers, no duplicates, sum
equals the receipt's amount, every category exists or is a non-spend) and
emits `txn.split`. The effect line reads *"2026-10-03 BIGBOX WHSE −$165.00
is split: Groceries $120.00, Household $45.00"*. With `alsoAddRuleMatching`
the rule's category is `'__split'` and the effect says *"Rule "bigbox" would
ask a person to divide 7 receipts from now on"*. `suggestedBy: 'claude'` is
refused on a split entry, since a split's amounts are never Claude's.

Amounts in tool arguments are integer cents, as `move_money` and
`assign` take them.

**The split editor (UI).** One component, used by both screens. The envelope
picker (`envelopeSelect`) gets one more option at the end, in its own group:
*"Split across envelopes…"* with value `__split`. It comes from
`pickerOptions`, so the model sees the same option the person does.
Choosing it opens an editor under the row:

```
  Groceries        ▾   $ 120.00
  Household        ▾   $  45.00
  + another line                     balanced ✓
```

- Each line is the same envelope picker (without the split option) and a
  dollars field. Dollars are typed unsigned and parsed with the UI's
  `toCents`; every part takes the sign of the receipt, so `120.00` on a
  −$165.00 receipt is −12000. A money-in receipt (a deposit that is part
  income, part transfer) splits the same way with positive parts. A refund
  line inside a receipt (a part of the opposite sign) is something the log
  and the tool accept but this editor does not offer. **Assumption.**
- The last empty amount takes the remainder when the person leaves the field
  blank and tabs on, so a two-way split is one number typed. **Assumption:**
  that convenience is wanted; it is cheap to remove.
- The footer says what is left to place: *"$45.00 still to place"*,
  *"$5.00 over"*, or *"balanced"*. Only a balanced split with every line
  given an envelope counts as sorted.
- Choosing any single envelope again closes the editor and drops the parts.

On the **import screen**, a row that is split carries `category: '__split'`
and `split: [{ category, amountCents }]` in the preview rows the client
holds. A row marked to divide that nobody divides is **not** a reason to
block the import: today an unsorted row may land unsorted and be sorted
from the queue, and one undivided warehouse-club line must not hold back a
statement. The client commits such a row with `category: null`; the note
under the button counts *"3 will land with no envelope until you sort
them, 1 of them to divide"*. `/api/import/commit` accepts `split` per row
and refuses a row that says `__split` without balanced parts (naming the
payee), so a client fault can never write a half-split; it appends
`txn.add` (split rows with `category: null`) followed by one `txn.split`
per split row, in one batch.

On the **unsorted queue**, the editor sits in the row's last cell under the
picker, and *Show what this would do* sends the split entry to
`categorize_transactions`. A row whose editor is not balanced is left out of
the proposal, as an unpicked row is today.

The queue applies the split rules it did not apply before. `/api/match`
answers, beside `suggestions`, a `toDivide` list: the ids of the rows a
split rule in `state.rules` covers. Those rows are never sent to Haiku (the
filter lives in `suggestForRows`, so Import and the queue share it). The
queue shows them with the picker set to *Split across envelopes…*, the
editor open and empty, and a tag reading *"a rule says: divide this"*. That
closes the gap the undivided import row opens: it lands unsorted, and the
next look at the queue says what to do with it without asking the model.

The Remember tick on a split row offers a rule whose target is split; its
label reads *"remember: always ask to divide"*.

### Editing a split

*(Added 2026-11-02 after the owner read the first build: "leaving full CRUD
out of the split won't work". A member must be able to add parts, remove
parts, change a part, and undo the split, each as a logged decision.)*

The log already edits by replacement: `txn.categorize` replaces the last
assignment, and the `txn.split` fold sets `t.split = parts` wholesale. So an
edit to a split is **a new `txn.split` carrying the full new parts list**,
and undoing a split is **a `txn.categorize` to one category**, which clears
the parts. No per-part events (`txn.split.part.add` and the like): a part is
not a thing with an identity, it is a line of a division, and a division is
only ever valid as a whole (the sum check needs every line). One event per
save, whatever changed within the editor, and the latest event wins on
replay exactly as it does for a categorize.

What this means for each edit a member makes:

| Edit | Event |
|---|---|
| Add a part | `txn.split` with the old parts plus the new one, re-balanced |
| Remove a part | `txn.split` with that part gone, the rest re-balanced |
| Change a part's envelope or amount | `txn.split` with the changed list |
| Undo the split, sort whole | `txn.categorize { category }` (clears `split`) |
| Split a receipt sorted whole | `txn.split` (sets `category: '__split'`) |

The sum check, the two-parts minimum and the rest of `checkParts` apply to
every one of these, because each is just a `txn.split`. A split of one part
remains a categorize, so "remove a part until one is left" is the undo path
above, which the screen offers directly rather than making a member delete
lines to reach it.

Nothing changes in the tool: `categorize_transactions` already accepts a
split entry for a receipt that is already split (it writes a replacement) and
a category entry for a split receipt (it writes a categorize). Its effect
lines now say which it was: *"… is divided again: Groceries $120.00, Tyres
$45.00"* for a receipt that was already split, and *"… is no longer split;
becomes Groceries"* for an undo. Haiku's option list and the import routes are
untouched.

On the screen, the envelope's receipts list (every sorted receipt shows there,
a split one under each envelope it touches) gets an **Edit** control per
receipt. It opens the same envelope picker as the queue, set to the receipt's
envelope or to *Split across envelopes…*, and for a split the same editor,
pre-filled with the current lines and amounts. Each editor line gains a
remove control; *+ another line* already exists. Save proposes one
`categorize_transactions` entry and goes through the usual proposal card.
For the screen to open the editor, `explain_envelope`'s entries carry the
receipt id, its amount in cents and its parts in cents, beside the formatted
strings they already carry.

The queue and Import get the remove control for free, since it is the one
editor.

### Restore and old logs

Nothing in a log written before this design mentions `__split` or
`txn.split`, so the fold produces the state it produced before, line for
line. A backup that contains `txn.split` events restores under the `facts`
scope with its transactions; restoring `facts` without `budgets` leaves
splits intact, because a split names categories, not envelopes.

## Part 2: the model answers "split", and writes the rule

### Options

`pickerOptions` appends, after Income, `{ value: '__split', label: 'Split
across envelopes…', group: 'Several envelopes' }`. One list serves the
select and the model, as today.

### What Haiku is asked

The system prompt gains two paragraphs, in plain words:

- A household sometimes divides one merchant's receipts across several
  envelopes every time (a warehouse store is groceries and household goods
  on one receipt). For such a payee answer the id `__split`, and in `parts`
  list the ids it is usually divided between, when you can say. Never
  answer `__split` for a merchant that sells one kind of thing.
- For every payee also give `rule`: the shortest run of the payee text,
  as written, that identifies the merchant and nothing else. Store numbers,
  cities, dates and reference codes are not the merchant. `HILLTOP FOODS
  #12 SPRINGFIELD` → `hilltop foods`. `BIGBOX WHSE #0100` → `bigbox`.

The JSON schema becomes:

```ts
matches: [{ payee, choice, confidence, rule, parts? }]
// rule: string (required; may be empty when the model cannot say)
// parts: string[] (optional; only meaningful when choice is __split)
```

`Suggestion` becomes `{ value, confidence, rule?: string, parts?:
readonly string[] }`.

### Checking the answer

`suggest()` keeps its guards (a payee it sent, a choice from the options,
confidence at or above the threshold) and adds:

- `parts`: kept only when `choice` is `__split`; each must be an option id
  other than `__split`; duplicates and unknowns dropped; an empty list is
  omitted.
- `rule`: passed through `ruleProblem(state, payee, rule, target)`, a pure
  function in `match.ts` that names the first problem or returns null, and
  dropped (not the suggestion, just the rule) unless all of these hold:
  1. non-empty after trimming, and at least 3 characters;
  2. a case-insensitive substring of the payee;
  3. no transaction already in `state.txns` whose `payee + memo` contains it
     is filed under a different single category than `target`, and none is
     filed as a split unless `target` is `__split`; an unsorted receipt does
     not block;
  4. no rule in `state.rules` already has that match string
     (case-insensitively); the fold would replace it, and re-offering it is
     noise or a silent retarget.

Because rule 3 needs the ledger, `suggest()` takes the state;
`suggestForRows` already has it. Rows with a split rule in `state.rules`
arrive from Import with `category: '__split'`, and `suggestForRows` also
runs `categorize(state.rules, row)` over the open rows it is handed (the
queue's rows carry `payee` and `memo` for this) and sets aside any the
rules mark split, returning them as `toDivide`. Neither path sends them.

The check at suggestion time is against the model's choice. The person may
then pick a different envelope, or the model's string may have been dropped
and the regex guess offered instead, so the same check runs once more
where the rule is actually proposed: `categorize_transactions` calls
`ruleProblem` with the entry's final category. There it **refuses** only
an empty or shorter-than-three-character match (a two-letter rule is never
what anyone meant), and for a conflict it **warns** in the effects rather
than refusing: *"Rule "co" also matches 3 receipts filed elsewhere (Dining
out, Electricity)"*. A person may want a rule that files future receipts
differently from past ones; what they must not get is one they did not see
coming. The regex guess therefore gets the same scrutiny as the model's
string, on the proposal card, with no second request. **Assumption:** warn,
not refuse, for conflicts a person typed.

### Threading it to the screen

- `/api/import/preview` rows gain `rule` and `parts` beside `suggested` and
  `confidence`. A row a split rule caught arrives with `category:
  '__split'` and no `split`; `ruled` counts single-category rules only, and
  the response adds `toDivide` for rows a rule marked split, so the screen
  can say *"3 sorted by rules, 1 to divide, 4 need sorting"*.
- `/api/match` returns `suggestions: { [txnId]: { choice, rule?, parts? } }`
  instead of a bare string. The UI is the only client and is changed in the
  same task.
- `offerRules(rows)` uses `r.rule ?? ruleSuggestion(r.payee)` and groups by
  that string. On the queue, when a suggestion arrives for a row, its
  Remember field is set to the model's string when there is one. The regex
  is still the whole answer when Claude is not configured, since no
  suggestion arrives at all.
- After an import commits, the rows offered as rules are the ones where
  the person kept what the model suggested: a single envelope accepted
  (`suggestedBy: 'claude'`, as today) **or** a split the model suggested
  that the person divided and committed as a split. The client marks the
  latter itself (`keptSuggestion`), since the log records no
  `suggestedBy` for a split. A split row's rule entry is `{ txnId,
  category: '__split', parts: <the committed parts>, alsoAddRuleMatching }`:
  the receipt is re-split identically, which the fold treats as a no-op in
  effect, and the rule rides along. Hand-sorted and hand-split rows are
  not offered after an import, as hand-sorted rows are not today; on the
  queue the Remember tick covers them.

### The model says "split"

On either screen a `__split` suggestion is shown as a suggestion is today
(*Suggested · Accept*), with the picker reading *Split across envelopes…*.
Accepting it opens the split editor with one line per suggested part, the
envelope set and the amount blank, cursor in the first amount. The row stays
unsorted until the editor balances. The `suggestedBy: 'claude'` mark is not
recorded for a split, as above.

A rule with target `__split` works the same at import, without the model:
the row arrives marked to divide and the editor opens with no lines
pre-filled. **Assumption:** a split rule does not remember the categories.
Remembering them would be a second rule field; if it turns out that the warehouse
club is always Groceries plus Household and typing the first envelope each time
grates, that is one more optional field on `rule.add` later.

## What is left to the builder

- Exact wording of effect lines and the footer of the split editor.
- Whether `EnvelopeLine` carries the memo. The receipts list does not show
  it today.
- How `list_transactions` formats a part's amount (signed, like `amount`).
- Test fixtures: a warehouse-club receipt split three ways, one part outside the
  budget; a log with a split restored under `facts` only; a model reply
  with a rule that matches a differently filed receipt; a rule target of
  `__split` at import.

## The calls made without the owner, in one place

1. A split has at least two parts; one part is a categorize.
2. Part signs are unconstrained; only the exact sum is enforced.
3. `txn.split` takes an optional `why`, like `txn.categorize`.
4. ~~Splitting is offered on Import and the unsorted queue only.~~ Overruled
   by the owner: a sorted receipt is edited from the envelope's receipts
   list, where any receipt may be re-sorted, split, re-divided or un-split
   (see "Editing a split"). An edit is one replacement event per save.
5. Haiku names a split's categories, never its amounts.
6. A split rule does not remember categories; the editor opens empty.
7. The last blank amount in the editor takes the remainder.
8. A model rule string that an existing rule already uses is not offered.
9. An undivided row marked to divide lands unsorted rather than blocking
   the import; the queue then applies split rules and shows it as "divide
   this" without asking the model.
10. On the proposal, a conflicting rule warns in the effects; only an empty
    or two-character match is refused.
11. The editor types unsigned dollars and gives every part the receipt's
    sign; refund lines within a receipt are for the tool, not the editor.
12. `explain_envelope` keeps its `transactions` key and sign, one entry per
    part, with `of` for a split.
13. An edit to a split is a replacement `txn.split` with the whole list, never
    a per-part event; undo is a `txn.categorize`.
14. Edit is offered on every receipt in an envelope's list, closed month or
    not: sorting is a fact about the receipt, not an adjustment to the month.
