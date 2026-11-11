# One budget, envelopes and categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution:** subagent-driven development (chosen): a fresh implementer per task, a reviewer per task, a whole-branch review at the end. Tasks run in order, one at a time, in one worktree. An implementer sees only its own task, the sections above the first task, and the files the task names.

**Goal:** Release 0.10.0: a household has one budget; every receipt is sorted by a person into one envelope (or split across several) and counts there and only there; "category" is the heading envelopes sit under; adding a category or an envelope is one short form and one press.

**Architecture:** The budget layer leaves the log: the household's state holds its envelopes, categories, months, bills and location directly, and no op, tool, route or request carries a budget. A receipt, a split part and a rule name an envelope id; categories are an ordered list of headings; a removed envelope's id is reserved and its closed months keep it in history. Tools a person's press uses are approved in one request; Claude still only proposes. The page loses the picker, Compare, the Categories sheet and every "Show what this would do" on adding and sorting.

**Tech Stack:** Node 22.6+ running TypeScript by type stripping, `node:test`, an append-only JSONL log folded by `api/src/replay.ts`, one vanilla-JS page (`site/index.html`) with `site/tokens.css`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-10-one-budget-envelopes-design.md` (approved, committed at 2d9f350; binding: where this plan and the spec disagree the spec wins, except the Rulings below, which settle what the spec leaves open). **Input, read only for its file:line map:** the category survey the dispatch names (`<scratchpad>/categories/survey.md`). Its multi-budget recommendations (shared envelope ids across budgets, "In other budgets", the outside note reworded) are overruled by the spec and are not to be built.

**Scope:** Plan's areas, the Calendar's layout, Today's day cards and Bills' dates are not touched, except for words that name budgets or categories and the arguments that carried a budget. Line numbers below are the tree's at 2d9f350 (`site/index.html` is 14,615 lines); from Task 7 on, find things by function name or section marker.

## Global Constraints

- Commits: `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit`. The subject is one plain sentence saying what a person now sees (no `feat:` or any other prefix), then a blank line, then exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, whatever model writes the commit. Never bare `git`, never the `/usr/bin` shim, never suggest Xcode tools.
- Never stage `api/data/`, `site/budget.jsonl`, `site/transactions.jsonl`, `site/planner.html`, `.env` or `.claude/`. Stage files by name, never `git add -A` or `.`. Never push. Never bare `git stash`.
- The repository is public. Stand-in names only: accounts `alice`, `bob`, `casey`, `dana`; people Alex, Bob, Casey, Dana; payees in the "Example Power" style (`EXAMPLE MARKET`, `EXAMPLE GYM`, `CORNER BISTRO`, `QUIKSTOP`) and the invented ones this plan gives. No real banks, utilities, employers, vendors, places or devices in code, tests, docs or commit messages.
- One noun per concept on screen: **envelope** (where money is set aside and a receipt is sorted) and **category** (the heading an envelope sits under). On the Budget side never "band", "area", "group" or "kind"; never "category" about a receipt; never "budget" as a choice (no budget names, no "which budget", no "every budget", no "Compare"). "To sort" names the queue. Plan's own word "area" is untouched.
- Every control this release adds or changes has a 44px hit area through the `hit` class (rule `.hit::after`). No text is dimmed by `opacity`; quiet text uses `--ink-soft`. No colour, weight or size as a literal in new CSS: tokens only. A selected state is never a tint alone.
- The app's conventions: secondary button first and the primary at the right; a form's error slot is always rendered (`epErr()`); Escape cancels an open form before it goes Back (`data-cancel` / `cancelMark`); a committed change reloads (`loadBudget()`); every async continuation on an envelope's page checks `envelopePage === page`; nothing is bound at load by new code except where a task says.
- The suite and the typecheck pass after every task: `cd api && npm test` and `cd api && npm run typecheck`, both clean. The suite stood at **2087 tests** at 2d9f350. Tasks 1, 2 and 7 to 12 delete tests of behaviour the spec retires; each task's commit body says "Suite: N tests." and names every deleted test file or `describe` with the behaviour it pinned. No task deletes a test of behaviour the spec keeps: it rewrites it.
- `site/index.html` is edited by function name or section marker, never by line number. Section markers (`// ── … ──`) keep their text unless a task renames one, because `api/test/page-ledger.test.ts` slices the page by them.
- Version 0.10.0 lands in Task 13, with the package, its lockfile, `BUILD` and the stylesheet's `?v=` together; until then all three stay at 0.9.2 so the ledger's build test holds.
- After any CSS change: `python3 docs/superpowers/design/tools/contrast.py site/tokens.css` exits 0.

### Running the page by hand

`<worktree>` is the worktree's root and `<scratchpad>` a scratch folder outside the repository (the dispatch names both). Never port 5555, never a `.env`. Run each in the background, with absolute paths:

```bash
mkdir -p <scratchpad>/run/fake-root
DSM_PORT=5598 FAKE_DSM_ACCOUNTS=alice:correct-horse,bob:battery-staple,casey:paper-lantern FAKE_DSM_ROOT=<scratchpad>/run/fake-root \
  exec node --experimental-strip-types <worktree>/api/tools/fake-dsm/server.ts
PORT=5577 COOKIE_INSECURE=1 TZ=America/Denver SITE_DIR=<worktree>/site DSM_URL=http://127.0.0.1:5598 PLANNER_ROOT=/Planner \
  LOG_PATH=<scratchpad>/run/events.jsonl HOUSEHOLDS_DIR=<scratchpad>/run/households SESSIONS_PATH=<scratchpad>/run/sessions.json CONNECTORS_PATH=<scratchpad>/run/connectors.json \
  exec node --experimental-strip-types <worktree>/api/src/server.ts
```

Stop each by pid, never `pkill`: `kill $(lsof -nP -iTCP:5577 -sTCP:LISTEN -t)` and the same for 5598. Open `http://localhost:5577`, sign in as alice (`correct-horse`), make the household "Home", add bob and casey under Settings. A page check is done at 375 × 812 and at desk width (1280), in dark and in light.

**The seed** (valid from Task 2 on, in the new vocabulary). With the planner stopped, a throwaway `<scratchpad>/seed.ts` opens Home's log under `<scratchpad>/run/households/<id>/events.jsonl` with `Store` from `<worktree>/api/src/store.ts` (`new Store({ path })`, `await store.load()`, `await store.append('alice', [...])`), dates computed from today so it stays right. It appends: `household.locate` Springfield, IL, ZIP 62701; categories `home` "Home", `food` "Food", `utilities` "Utilities", `sinking` "Savings and sinking funds", `fun` "Fun", and `kids` "Children" (empty); envelopes `rent` (home, $2,500), `groceries` (food, $600), `dining` (food, $200), `elec` (utilities, $150), `roof` (sinking, $25, `sinking: { kind: 'every', estimate: { cost: 120000, everyYears: 4 } }`), `gym` (fun, $40); an income source of $5,000 monthly; rules `EXAMPLE MARKET` → groceries and `EXAMPLE GYM` → gym; last month and this month opened from the template, last month closed after its receipts; receipts in each month: `EXAMPLE MARKET` -$120 (groceries), `EXAMPLE GYM` -$40 (gym), `EXAMPLE POWER BILLP 8842193` -$146 (elec), and this month also `CORNER BISTRO` -$80 split dining -$50 / gym -$30, `UNKNOWN SHOP` -$22.50 with no envelope, `CITY WATER` -$48 with no envelope; then `rule.remove` of the gym rule and `envelope.remove` of `gym` (why "cancelled the membership"); a `bill.set` on elec, due on the 16th. After it, To sort holds this month's EXAMPLE GYM, the CORNER BISTRO split (its gym part blank), UNKNOWN SHOP and CITY WATER; last month's Gym row shows under Fun, marked removed.

## Reused, not rebuilt

- **Server:** `validate`, `applyTo`, `freeze`, `thaw`, `Draft`, `checkParts`, `splitProblem`, `fundedFor`, `plannedFor`, `requireReason` (`replay.ts`); `monthView`, `carriedInto`, `openMonths`, `latestMonth` (`envelopes.ts`); `pace`, `snapshot`, `fixedCharges`, `billsOf`, `donors`, `drift`, `monthClock` (`analytics.ts`); `goalFor`, `sinkingPlan`, `balanceAsOf`, `savingsCheck` (`sinking.ts`); `hintFor`, `incomeSuggestion`, `cardFor`, `coverFor` (`figures.ts`); `pickerOptions`, `suggest`, `suggestForRows`, `ruleProblem`, `SPLIT_OPTION` (`match.ts`); `describe`, `Tool`, `ToolError`, `TOOLS`, `APPROVE_IN_ONE`, `ctx.proposals.put`, `str`, `money`, `basisArg` (`tools.ts`); `scopeOf`, `parseBackup`, `planRestore`, `eventsToApply`, `newerBackup` (`restore.ts`); `slug` (`types.ts`); `Store.append`, `Store.adopt`.
- **Page:** `approveNow`, `loadBudget`, `envelopeRow`, `envBar`, `envFrame`, `envSection`, `envLine`, `epField`, `epErr`, `textBtn`, `node`, `icon`, `cancelMark`, `cancelOpen`, `setupMenu` (split, Task 8), `keepOnScreen`, `closeMenus`, `envelopeSelect`, `splitEditor`, `suggestionTag`, `openEnvSubPage`, `backToEnvelope`, `showEnvSubPage`, `reviewState`, `showProposal`, `panel`, `showManageProposal`, `figureField`, `openEnvelopePage`, `openBudgetAt`, `showProblem`, `walkField`, `walkMsg`; classes `.band`, `.list`, `.erow`, `.add-row`, `.ep-form`, `.ep-f`, `.ep-acts`, `.ep-err`, `.ep-foot`, `.menu`, `.menu-list`, `.menu-item`, `.hit`, `.note`.
- **Tests:** the `ev` / `house` style helpers already in `api/test/bills.test.ts`, `core.test.ts` and `tools.test.ts` (rewritten in place, not replaced); `figuresOf` / `readLog` of `api/test/bill-figures.ts` (renamed in Task 3); the ledger's `REGIONS`, `between`, `uncommented`, `missing`, `Line`.

## Interfaces: the shapes every task reads

What the log, the state and the readers look like once Tasks 1 and 2 have landed. Task 1 makes the budget layer go and leaves receipts on categories; Task 2 makes this block true as written. Later tasks rely on these names exactly.

```ts
// api/src/types.ts
export type EnvelopeId = string;
export type CategoryId = string;                 // a heading's id, from its label
export const TRANSFER = '__transfer'; export const INCOME = '__income'; export const SPLIT = '__split';
export type NonSpend = typeof TRANSFER | typeof INCOME;
/** Where a receipt is sorted: an envelope, not spending, or split. Replaces Assignment. */
export type SortedInto = EnvelopeId | NonSpend | typeof SPLIT;
export const isSpend: (e: SortedInto | null) => e is EnvelopeId;
export interface Txn { readonly id: TxnId; date: Day; payee: string; memo?: string; amount: Cents; account?: string; dedupeKey: string;
  envelope: SortedInto | null; manual?: boolean; suggestedBy?: 'claude'; split?: readonly SplitPart[] }   // `category` is gone
export interface SplitPart { readonly envelope: EnvelopeId | NonSpend; readonly amount: Cents }
export function partsOf(t: Pick<Txn, 'envelope' | 'amount' | 'split'>): readonly SplitPart[];
export interface Rule { readonly id: string; readonly match: string; readonly envelope: SortedInto }
export interface Category { readonly id: CategoryId; readonly label: string }
export interface Envelope { readonly id: EnvelopeId; readonly label: string; readonly category: CategoryId; readonly rollover: boolean;
  readonly template: Cents; readonly order: number; readonly sinking?: SinkingGoal; readonly needsFigure?: true; readonly source?: string; readonly basis?: Basis }
export interface SinkingEstimate { readonly cost: Cents; readonly everyYears: number }
export type SinkingGoal = { readonly kind: 'every'; readonly estimate: SinkingEstimate | null } | { readonly kind: 'by'; readonly target: Cents; readonly by: Month };
export interface Location { label: string; state?: string; postal?: string; stateFips?: string; countyFips?: string; county?: string }  // was BudgetLocation
/** `keptIn`: the months that were closed when it was removed; only they keep it in their history (Ruling 23). */
export interface RemovedEnvelope { readonly id: EnvelopeId; readonly label: string; readonly category: CategoryId; readonly keptIn: readonly Month[] }
export interface MonthPlan { readonly closed?: boolean; readonly month: Month; readonly openedAt: string; readonly plan: ReadonlyMap<EnvelopeId, Cents>; readonly adjustments: readonly Adjustment[]; readonly income: Cents }
// State: categories (ReadonlyMap<CategoryId, Category>, iterating in category order), envelopes (ReadonlyMap<EnvelopeId, Envelope>),
//        removedEnvelopes (ReadonlyMap<EnvelopeId, RemovedEnvelope>), bills (ReadonlyMap<string, BillRecord>, by billSlot),
//        location (Location | null), months (ReadonlyMap<Month, MonthPlan>), rules, txns, incomeSources, … as before.
// Gone: Budget, BudgetId, BudgetLocation, State.budgets, monthKey, Assignment, Match, Envelope.group, Envelope.match,
//       Category.kind/archived/sinking, Txn.category, Prediction.budget, Offer.budget, IncomeSource.budget.

// Ops, as they read once Task 2 lands (every op that carried `budget` has lost it in Task 1):
//   category.add { category, label }            appended last
//   category.rename { category, label }
//   category.move { category, to: number }      `to` is its 0-based place once moved
//   category.remove { category }                refused while an envelope sits in it
//   envelope.define { envelope, label, category, rollover?, template, order?, sinking?: SinkingGoal | null, needsFigure?, source?, basis? }
//   envelope.remove { envelope, why }
//   household.locate { location: Location | null, why }        (was budget.locate)
//   txn.sort { txn, envelope: EnvelopeId | NonSpend | null, manual?: boolean, suggestedBy?: 'claude' }
//   txn.split { txn, parts: readonly SplitPart[], why? }
//   rule.add { rule, match, envelope: SortedInto }
//   month.open { month, income, plan? }  month.close { month, closed, why }  month.discard { month, why }
//   assign { month, envelope, to, why }  move { month, from, to, amount, why }  income.set { month, amount, why }
//   bill.set { envelope, bill, name, byHand?, date }  bill.remove { envelope, bill, name }
//   income.source.define { source, label, earner, amount, frequency, anchor, until? }
//   prediction.record { prediction, month, envelope, expected, why }
//   thread.briefing { day, source, headline, … }  thread.ask { question, plan? }  thread.note { text, plan? }
//   proposal.offer { …, month, envelopes, … }    plan.set { …, envelope?: EnvelopeId | null }
// Retired (an unknown op to the fold, and named as from before 0.10.0 by restore, Task 5):
//   budget.create, budget.rename, budget.archive, budget.locate, txn.categorize, category.define, category.archive, category.sinking
export const RETIRED_OPS: ReadonlySet<string>;   // the eight above, Task 5

// api/src/envelopes.ts
export interface EnvelopeLine { readonly txnId: string; readonly amount: Cents; readonly split: boolean }   // `category` is gone
/** `removed` only in a month that keeps a removed envelope; its `envelope` is then built from the record (rollover false, template 0). */
export interface EnvelopeView { /* as today */ readonly removed?: true }
export interface MonthView { /* as today, without `budget` and `outside` */ }
export function monthView(state: State, month: Month): MonthView | null;
export function carriedInto(state: State, month: Month, envelope: EnvelopeId): Cents;
export const openMonths: (state: State) => Month[];
export const latestMonth: (state: State) => Month | null;
export function envelopeIdFor(state: Pick<State, 'envelopes' | 'removedEnvelopes'>, label: string): EnvelopeId;   // Task 2
// gone: matches, envelopeFor, overlappingCategories

// api/src/analytics.ts
export interface ToSort { readonly count: number; readonly outflow: Cents; readonly inflow: Cents; readonly oldest: Day | null;
  readonly txnIds: readonly TxnId[]; readonly missing: ReadonlyMap<TxnId, readonly EnvelopeId[]> }   // replaces Unsorted
export function inToSort(state: State, t: Txn): boolean;
export function toSort(state: State): ToSort;
export function snapshot(state: State, month: Month, today: Day): Snapshot | null;    // Snapshot.toSort replaces .unsorted
export function drift(state: State, month: Month, lookback?: number): Drift[];
export function billsOf(state: State, opts?: { fixed?: readonly FixedCharge[] }): ReadonlyMap<EnvelopeId, readonly Bill[]>;
// FixedCharge: { key, payee, envelope, typical, months, lastDate }; chargeKey(payee, envelope)

// api/src/sinking.ts:  goalFor(state, env, month)  sinkingPlan(state, month)  balanceAsOf(state, env, day)
//                      sinkingEnvelopes(state)  heldAsOf(state, day)  savingsCheck(state, today)
// api/src/figures.ts:  lastMonthSpent(state, envelope, month)  spentOver(state, envelope, month, months)  hintFor(state, env, month)  incomeSuggestion(state, month)
// api/src/match.ts:    pickerOptions(state): PickerOption[]  suggestForRows(state, rows)  filedLabel(state, e: SortedInto)  ruleProblem(state, payee, rule, target)
// api/src/replay.ts:   byRule(rules, t): SortedInto | null   (was categorize)
// api/src/income.ts:   sourcesFor(state)        api/src/calendar-money.ts: calendarMoney(state, w)
// api/src/first-run.ts:
export type FirstRunStep = 'where' | 'income' | 'envelopes';
export interface FirstRun { readonly step: FirstRunStep | null; readonly started: boolean; readonly month: Month; readonly monthOpen: boolean;
  readonly hasEnvelopes: boolean; readonly income: { suggestion: { exact: string; from: 'source' | 'imports' } | null; hasSource: boolean };
  readonly location: string | null;
  readonly categories: readonly { readonly id: CategoryId; readonly label: string;
    readonly envelopes: readonly { readonly id: EnvelopeId; readonly label: string; readonly priced: boolean }[] }[] }   // `groups` until Task 2
export function firstRun(state: State, today: Day): FirstRun;
```

Routes after Task 2: `GET /api/budget` → `{ thisMonth, lastIncomeExact, location, envelopes, months, started }` (replaces `GET /api/budgets`); `GET /api/budget/first-run` (no query); `POST /api/match { txnIds }`; `POST /api/import/preview { filename, content }`; `POST /api/import/commit { rows: [{ id, date, payee, amountCents, account?, envelope?, suggestedBy?, split?: [{ envelope, amountCents }] }], source, balances, savingsToday? }` answering `{ added, sorted, divided, toSort, balances }`; `GET /api/thread` answers `notStarted: true` in place of `noBudgets`; no route reads a `budget` field or query. `GET /api/categories` and `GET /api/budgets` are gone.

Tools after Task 4 (the page calls the first group with `?approve=1`):
- **Approved in one request:** `sort_receipts`, `add_envelope`, `change_envelope`, `add_category`, `rename_category`, `move_category`, `remove_category`, `set_location`, `open_month`, `set_month_income`, `define_income_source`, `make_starter_envelopes`, `set_envelope_figure`, `set_bill`, `move_money`, `set_assignment`.
- **Proposals:** `add_rule`, `remove_envelope`, `set_sinking_goal`, `restore_transaction`, `seed_from_location`, `close_month`, `discard_month`, `remove_income_source`, and every plan, calendar and booking tool as today.
- **Retired:** `create_budget`, `rename_budget`, `archive_budget`, `compare_budgets`, `set_budget_location` (Task 1); `categorize_transactions`, `define_category`, `archive_category`, `add_starter_set` (Task 2); `define_envelope` (Task 4).

## Review Focus

A reviewer rejects a task for any of these, whatever else is right.

**What the owner named.** "Several UI elements were not brought over": every row of the ledger below is owned by a task with its fate and pinned in `api/test/page-ledger.test.ts`; an element on today's page with no row is a miss to report, not to drop. "No magic": a receipt is never sorted by anything but a person's press, a rule a person approved, or a suggestion a person accepted; nothing re-sorts receipts behind a press.

**The five inputs most likely to bite a person**, most likely first, each with its test in the owning task:

1. **An envelope removed mid-month, with receipts in a closed month, an open month, and a split.** A closed month keeps its lines under the removed envelope's name, marked removed, and never changes; the open months' receipts go to To sort; a split with a part in it goes to To sort whole, shown with its split and that part blank, while its other parts still count where they are. Tasks 2 (fold and readers), 3 (fixture), 7 and 10 (page).
2. **The same name added again after a removal.** It gets a fresh id (`gym-2`); old receipts stay in To sort or in closed history and are never pulled back. Tasks 2 (fold), 4 (`add_envelope`).
3. **Names that differ only in case or spaces.** "groceries " beside "Groceries" is refused for envelopes and for categories, and "New category…" typed as a category that exists is refused with words, never silently merged. Tasks 2, 4, 8.
4. **A page left open while another member changes the headings.** Adding an envelope into a category just removed, moving a category already moved, or removing one that just gained an envelope: refused in the form's own slot with what was typed kept, then the list is read again. Tasks 4 (refusals), 8 (slot).
5. **A log or backup from before 0.10.0, and a backup restored into a household that already has a budget.** The backup is refused in words naming 0.10.0, never as "a newer Home Planner"; restoring the Budget or Months band in place into a household whose budget is not empty is a collision in the spec's words, never a merge; a receipt naming an envelope that is not there lands in To sort. Task 5.

## Rulings

The spec leaves these open, or reads two ways; each is settled here and carried by the named task. The cost is what goes wrong if the ruling is wrong.

1. **The budget layer is flattened onto `State`** (`envelopes`, `categories`, `removedEnvelopes`, `bills`, `location`, `months` by month): no internal budget record is kept, because every reader would otherwise see it. Task 1. Cost: none beyond the churn the spec already implies.
2. **Removing an envelope writes `rule.remove` for each rule that sorts into it, then `envelope.remove`, in one append; the fold refuses `envelope.remove` while a rule still points at it and deletes the envelope's bill records itself.** The log then says which rules went. Task 2. Cost: a hand-written log must remove the rules first.
3. **A split receipt with a part in a removed envelope, in a month not closed, is listed in To sort whole, and its live parts still count in their envelopes**; only the missing part's money is in no envelope. "Goes to To sort whole" is read as where it is listed, not as un-counting money that did go to a live envelope. Task 2. Cost: if the owner meant the whole receipt to leave every envelope, Spent reads higher by the live parts until it is re-sorted.
4. **A receipt or rule naming an envelope id that never existed here (restored, or hand-written) is To sort in any month, closed or not**; only a *removed* envelope keeps closed-month history, since only it has a name to show. Task 2. Cost: none seen.
5. **First run is "not started" while the household has no location and no envelopes.** The Where it is step shows while not started and this month is not open; its Skip is held on the page (as pricing is today), so after Skip and the income step a reload lands on Envelopes. Today's prompt "The budget is not started yet." shows while not started. Tasks 1, 12. Cost: a reload between Skip and saving the income returns to Where it is.
6. **Envelope ids:** `slug(label)` (lower-case, dashes, 24 characters), then `-2`, `-3`… while the id is a live envelope's, a removed envelope's, or a reserved value; a starter row keeps its starter id (`rent`, `elec`…) when free, so local pricing and the figure hints keep working. Task 2 (`envelopeIdFor`). Cost: none.
7. **Category ids:** `slug(label)`, then `-2`… while a live category has it; a removed category's id may be used again, since it holds nothing. Starter ids: `home`, `food`, `insurance`, `utilities`, `sinking` ("Savings and sinking funds"), `everyday`. Task 2. Cost: none.
8. **Sorting by hand is `sort_receipts` approved in one, without a rule; the rule offer is a separate proposal, `add_rule`.** `sort_receipts` keeps `alsoAddRuleMatching` for Claude's cards, and the approve-in-one path refuses it ("A rule is shown before it is added."). Task 4. Cost: two calls where a person sorts and then remembers.
9. **Rename and Change its category on an envelope's page, and every category press, write at once.** They move no money; the spec's "no proposal step" extends to them as it does to figures. The goal form (`set_sinking_goal`) keeps its proposal: the spec names adding and sorting only. Tasks 4, 9. Cost: the goal form is the one edit on the page that still shows "This will".
10. **Starter envelopes still start "No figure yet"** (`needsFigure`), as the walkthrough's words say; only Add an envelope lands at $0 unflagged. Tasks 2, 4. Cost: none.
11. **The restore scope `budgets` is renamed `budget`;** its band holds `category.*`, `envelope.*`, `bill.*`, `income.source.*` and `household.locate`; `facts` keeps `txn.*`, `rule.*` and `account.balance`. The Months band's "same rule" uses the same sentence as the Budget band's. Task 5. Cost: none.
12. **A backup holding a retired op is refused whole in words naming 0.10.0**, not as "made by a newer Home Planner". Task 5. Cost: none.
13. **The Today waiting item keeps "N receipts to sort" and "In no envelope yet"** (T70), which stay true of a receipt whose envelope was removed; the server's kind is renamed `tosort`. Ids `unsorted-q` and the section marker `// ── the unsorted queue` keep their text: they are not words on screen. Tasks 4, 10. Cost: none.
14. **The savings check line moves under the last category**, its Settings link opening Settings at the Savings account row (key `savings`). Task 7. Cost: the line sits further from the savings envelopes when their category is not last.
15. **The head keeps its pill and menu**, reading "Budget" with the month under it; no `h1` is added. Task 7. Cost: none.
16. **A 'budget' briefing's byline reads "Claude · the budget's briefing".** `BriefingSource 'budget'` and Today's lane key `budget` stay: they name the Budget tab, not a choice. Task 7. Cost: copy the owner may want changed.
17. **The category menu** is a 44px "More" button beside the heading opening a `.menu-list` drawn by an element form of `setupMenu`; "Move up" is absent on the first category and "Move down" on the last; an empty category offers "Remove", one with envelopes shows the line "Move its envelopes first." in place of it. Task 8. Cost: none.
18. **Rename and Change its category sit in the envelope page's foot**, before "Remove this envelope", each opening a small form in a slot under the foot. Task 9. Cost: one more line in the foot.
19. **`removeWords`** says "Its 12 receipts from this month go back to To sort." when every such receipt is in the current month, and "Its 12 receipts from months not yet closed go back to To sort." otherwise; the rules join the same sentence (", and the rule "EXAMPLE GYM" goes with it."); a bill is its own line. Task 2. Cost: copy.
20. **Doors the server closes before the page stops calling them** are listed in `RETIRING` in the ledger's route test (Task 1), each removed by the page task that drops its last call and the list deleted in Task 13. The page is not used by hand between Task 1 and Task 7. Cost: no hand check of the Budget screen in Tasks 1 to 6.
21. **The two old-log fixtures are replaced by one.** Task 1 converts `bills-old-log.jsonl` to one budget and re-keys its frozen figures (never recomputing them), as a pin that removing the budget layer moved no figure; Task 2 deletes it with `old-log.*`, whose vocabulary is gone; Task 3 writes the one new fixture and freezes its figures for every later task. Cost: Task 2 has unit tests, not a golden, as its figure pin.
22. **Restore a removed receipt offers no split** (`envelopeSelect(..., { allowSplit: false })`): `restore_transaction` puts a receipt back whole. Task 10. Cost: a receipt that was split is restored unsorted or into one envelope, then split from To sort.
23. **"Closed" is read at the removal.** A removed envelope keeps the months that were closed when it was removed (`keptIn`); a receipt counts in its history only in such a month while it stays closed. A month closed *after* the removal does not swallow its receipts out of To sort, and a kept month reopened sends them to To sort. The spec says closed-month receipts "stay", which only a month already closed can do. Task 2. Cost: one more field on the record.
24. **The route test also reads `approveNow('<tool>'` and a panel's `tool: '<tool>'`** (Task 1), since most of the page's writes name their tool that way and the literal-route pattern never sees them. Cost: none.

## The ledger: every element, its fate and its owner

Fate: **K** kept, **C** changed, **R** removed, **A** added, **M** moved. Every row is pinned in `api/test/page-ledger.test.ts` by its owning task (the 0.10.0 block Task 7 creates); the pins are in each task's ledger step. Rows were read from the page at 2d9f350.

**The head (`#budget-head`) and its menu**

| Row | What a member sees or presses | Fate | Task |
|---|---|---|---|
| B1 | The pill naming the budget (`#budget-label`), opening the menu | C: reads "Budget", the month under it (`#budget-month`) | 7 |
| B2 | The budget switcher in the menu (`#budget-switch`, a radio item per budget) | R | 7 |
| B3 | The hidden budget select (`#budget-pick`) and its change handler | R | 7 |
| B4 | "Where it is" with its note (place, ZIP, county, or "Not set yet, so local costs cannot be looked up") | K | 7 |
| B5 | "Price it from local data", off with no location | K | 7 |
| B6 | "Rename it" and its panel "Rename this budget" | R | 7 |
| B7 | "New budget" and its panel (Name, Start from: Empty or a budget) | R | 7 |
| B8 | "Discard <Month>'s plan", hidden when closed, and its panel | K | 7 |
| B9 | "Archive this budget" and its panel | R | 7 |
| B10 | Tabs Budget, Import, Compare, the last remembered on the device | C: Budget, Import; a remembered Compare opens Budget | 7 |
| B11 | Compare: two budget selects, "against", the verdict, affordability, the table by band, "Pick two different budgets." | R | 7 |
| B12 | The "Where is <budget> for" panel: Place, ZIP, Census state code, Census county code, Why | C: titled "Where it is"; no period-or-moving words; sends `set_location` | 7 |

**The list (`#budget-list`)**

| Row | What a member sees or presses | Fate | Task |
|---|---|---|---|
| B13 | The card: headline, line, "Go to the next one", green line; Income (opens income), Planned, Spent | K | 7 |
| B14 | Income: recorded sources and Remove, "Record an income", "What if…", the projection | K | 7 |
| B15 | "Needs you" | K | 7 |
| B16 | The outside note ("…was spent in categories no envelope here covers…") and "Add an envelope for them" | R | 7 |
| B17 | The bands: one per group in the server's order, its name, its envelopes | C: one per category in category order, its label, its envelopes in order | 7 |
| B18 | "Saved in Savings": savings envelopes in a band of their own, the savings check line and its Settings link | C: savings envelopes under their own category; the check line under the last category | 7 |
| B19 | An envelope's row: name, bar, amount (left, Short, No figure yet, saved), sub-line, chevron; opens its page | K | 7 |
| B20 | An empty category: its heading and "No envelopes yet" | A | 7 |
| B21 | The empty category's "Add an envelope", opening the form with that category chosen | A | 8 |
| B22 | A category heading's menu: Rename, Move up, Move down, Remove (empty) or "Move its envelopes first." | A | 8 |
| B23 | The add row "Add an envelope" (`#env-new`), opening a panel at the top | C: two add rows, "Add an envelope" and "Add a category" (`#cat-add`), each opening its form in place | 8 |
| B24 | Add an envelope: Name, Band, a figure, "Fed by (choose one or more)", "Show what this would do", the proposal, Approve or Not now | C: Name; Category (the categories, then "New category…" which becomes a text field); Cancel and "Add it"; written at once at $0; its page opens with Change ready | 8 |
| B25 | Add a category: Name; Cancel and "Add it"; the empty heading appears | A | 8 |
| B26 | The month's end: its note and Close / Reopen with its panel | K | 7 |
| B27 | In a closed month, a removed envelope's row, under its category, marked "removed" | A | 7 |

**An envelope's page**

| Row | What a member sees or presses | Fate | Task |
|---|---|---|---|
| B28 | "‹ Budget", the name, and `group · Month` (or `Saved in Savings · Month`) | C: `Category · Month` for every envelope | 9 |
| B29 | The card, its meter and sums, the question form "How much each month?", the cover block | K | 9 |
| B30 | Each month: the line and Change; on a savings envelope Change opens the goal form | K | 9 |
| B31 | This month: the line and Adjust; the funding page (Funded this month, Take it from, Why, This will, Back to) | K | 9 |
| B32 | Bills (0.9.0's B1 to B13) | K | 9 |
| B33 | Receipts: the count, each receipt and its share, Edit, "Nothing has been spent from this envelope yet.", the tie-out warning | K | 9 |
| B34 | The foot: "Make this a savings goal" / "Change its goal", "Remove this envelope" | K | 9 |
| B35 | "Rename" in the foot, a name field, Cancel and Save | A | 9 |
| B36 | "Change its category" in the foot, the category picker with "New category…", Cancel and Save | A | 9 |
| B37 | The goal form: Goal; one line per category feeding it ("<Category> costs", "Every how many years"); "Kept on the categories, so every budget sets aside the same…"; target and by; Cancel; "Show what this would do" | C: one line, "It costs" and "Every how many years", hint "Leave the cost empty for none."; the proposal stays | 9 |
| B38 | Remove: "Remove <name>", "Its receipts stay, but stop belonging to any envelope.", Why, Cancel and Remove, This will | C: the line is the server's count sentence (Ruling 19); bills and rules named in This will | 9 |
| B39 | Escape cancels an open form, then goes Back | K: the new forms carry `data-cancel` | 9 |

**Sorting: To sort, the picker, the split editor, a receipt's Edit**

| Row | What a member sees or presses | Fate | Task |
|---|---|---|---|
| B40 | To sort (`#unsorted-q`): "N receipts to sort", "…are in no envelope yet, so Spent does not include them. Give each one an envelope.", "Showing the newest N." | C: also lists receipts whose envelope was removed in a month not closed | 10 |
| B41 | A row: date, payee, amount, the picker "— not sorted —" | C: picking an envelope writes at once; the row leaves on reload | 10 |
| B42 | "remember" and the payee text the rule matches ("remember: always ask to divide" for a split) | C: once the pick lands, "Remember this for <Envelope>?" with a field "Receipts whose payee contains" filled with the payee's merchant and editable; "Show the rule" proposes with what is typed, its proposal, "Remember it" or "Not now"; a refusal is said under the field, which stays editable (final review) | 10 |
| B43 | "a rule says: divide this", and the split editor opened | K | 10 |
| B44 | "Suggest envelopes", "Asking Claude…", "N suggested" or "Nothing confident enough to suggest"; Suggested and Accept on a row | C: Accept writes at once, as a pick does | 10 |
| B45 | "Show what this would do", the proposal, Approve or Not now | R | 10 |
| B46 | A split receipt with a part in a removed envelope: shown with its split, that part blank; choosing an envelope for it sorts it | A | 10 |
| B47 | The picker's lists: envelopes under their band, "Not in this budget" categories, "Not spending" (Transfer between our accounts, Income), "Split across envelopes…" | C: envelopes by name under their category, then Not spending, then "Split across envelopes…" | 10 |
| B48 | The split editor: lines of envelope and dollars, ×, "+ another line", the footer's words, the blank amount taking the rest | K: parts are `{ envelope, amountCents }` | 10 |
| B49 | A receipt's Edit: the picker at its envelope or Split, the split editor, Save, Cancel, the error line, the proposal | C: Save writes at once and the list is read again; no proposal | 10 |

**Import**

| Row | What a member sees or presses | Fate | Task |
|---|---|---|---|
| B50 | The drop zone and "Where to get one" | K | 10 |
| B51 | In the file, Already have, Sorted by rule, Needs you | K | 10 |
| B52 | Rows that could not be read; Claude's error, "Sort these by hand, or try again later." | K | 10 |
| B53 | "Claude suggested an envelope for N receipts no rule caught." and "Accept all suggestions" | K | 10 |
| B54 | The table (Date, Payee, Amount, Envelope), unsorted first, a picker per row (its own list when a payee-narrowed envelope labels it differently), Suggested and Accept, the split editor | C: one list for every row; rows carry `envelope` | 10 |
| B55 | What each statement's account showed; "What does Savings show today?" | K | 10 |
| B56 | "Import N receipts" / "Record the balance" / "Nothing new to import", and "N will land with no envelope until you sort them…" / "Every receipt has an envelope." | K | 10 |
| B57 | "Added N receipts, M already sorted (K divided). J still need an envelope." | K | 10 |
| B58 | "Remember this as a rule…?", "Show the rules", the proposal, "Remember it" / "Remember them", "Not now", "Remembered." | C: sends `add_rule` for each | 10 |

**Restore a removed receipt (Today)**

| Row | What a member sees or presses | Fate | Task |
|---|---|---|---|
| B59 | "not in the ledger" / "back in the ledger", "Put it back" | K | 10 |
| B60 | "Put it in", a select of category labels with "— no envelope yet —"; Reason; "Show what this would do", the proposal, Leave it; the refusal slot | C: "Put it in" is the envelope picker (no split) with "— no envelope yet —"; sends `envelope` | 10 |

**The Categories sheet, Settings' Budget row, the Backup page's bands**

| Row | What a member sees or presses | Fate | Task |
|---|---|---|---|
| B61 | The sheet `#cat-sec`: "Categories", Done, "Shared by every budget…", the list by kind, Add a category (Name, Band: House/People/Future), Rename one, Stop using one, Add the starter set, and their panels | R | 11 |
| B62 | Escape and click guards that skip `#cat-sec` (the envelope page, an Area page, the card, Settings, Today), and the household switch that hides it | C: they name `#phone-sec` alone | 11 |
| B63 | Settings' "Budget" row: "N categories · Savings …", "The categories every budget shares, and the account…" | C: "Savings account", status without the categories, "The account the envelopes saved in Savings live in." | 11 |
| B64 | "N categories in use" and "Edit the categories" | R | 11 |
| B65 | "Savings is" and "Use it"; the account and its last balance; Change / Choose; "Type what Savings shows today" and "Record it"; the hint | K | 11 |
| B66 | Backup band "Receipts, categories and rules" / "…Depends on nothing." | C: "Receipts and rules" / "What was actually spent, and which envelope each is in. Needs the budget's envelopes." | 11 |
| B67 | Backup band "Budgets and envelopes" / "The plan: how categories are grouped… Needs its categories." | C: "Budget" / "The categories, the envelopes and what they are funded at, the income and where it is." | 11 |
| B68 | Backup band "Months and adjustments" | K | 11 |

**The first-run walkthrough (`#walk`)**

| Row | What a member sees or presses | Fate | Task |
|---|---|---|---|
| B69 | "Start the household's budget"; the rail Income, Envelopes, Pricing (Done, Current, To do); "A budget is a set of envelopes…" | K | 12 |
| B70 | "Name the budget": Name it, Where is it for, ZIP, "Make the budget", "Give it a name." | C: "Where it is": Where is it, ZIP; Skip and Save; "Give a town or a ZIP, or Skip." | 12 |
| B71 | Income: "<Month> income", "seen in imports", "the same every month", Save, Skip / Cancel and their messages | K | 12 |
| B72 | Income alone: "Open <Month> for <budget>" | C: "Open <Month>" (Task 7 takes the budget names off the page) | 7 |
| B73 | Envelopes: the lead, a card per group with its rows (tick, name, "priced in step 3" / "No figure yet"), "Add one of your own" with a Group select, the hint, "Make these N envelopes", the foot | C: a card per starter category; a row of one's own picks a category the way Add an envelope does | 12 |
| B74 | Pricing: "Looking up what this place costs…", the proposal, "Set the location", "Finish", Why | K | 12 |

**Elsewhere: words and requests that named a budget**

| Row | What a member sees or presses | Fate | Task |
|---|---|---|---|
| B75 | Today: a briefing's byline "Claude · briefing for <budget>" | C: "Claude · the budget's briefing" | 7 |
| B76 | Today: " · <budget>" after a change when there is more than one budget | R | 7 |
| B77 | Today: "This household has no budgets yet. Create the first one to begin." and the box "This household has no budget yet." with Open Budget | C: "The budget is not started yet." with Open Budget | 7 |
| B78 | Today's money rail: "No budget has this month open yet." | C: "This month is not open yet." | 7 |
| B79 | The box "<Budget> has no plan for this month yet." with "Open it from the template" | C: "The budget has no plan for this month yet." | 7 |
| B80 | A plan's card, Money: the "Budget" select over "Envelope", and "In <budget>; this month isn't open" | C: the Envelope select alone; "This month isn't open" | 7 |
| B81 | Today's "Looked at": "the budgets side by side" | R | 7 |
| B82 | Requests that sent a budget: the thread, Today, the Calendar, a question, a note, a typed savings balance, an import | R | 7 |
| B83 | Today's waiting item "N receipts to sort", "In no envelope yet", going to To sort | K: counts every receipt To sort holds | 10 |
| B84 | Links that open an envelope from Today and the Calendar (setup notes, "Open the envelope", money rows) | C: name the envelope alone | 7 |

Owners: Task 7 owns 32 rows (B1–B20, B26, B27, B72, B75–B82, B84), Task 8 owns 5 (B21–B25), Task 9 owns 12 (B28–B39), Task 10 owns 22 (B40–B60, B83), Task 11 owns 8 (B61–B68), Task 12 owns 5 (B69–B71, B73, B74). Eighty-four rows; none is left over.

**Existing pins this release moves** (each by the named task, in the same commit as the change): KEPT `T113` 'This household has no budget yet. ' and ADDED `T113` "new Error('This household has no budgets yet." → B77 (Task 7); KEPT `T95` → B78 (7); ADDED `T14` 'Claude · briefing for ' → B75 (7); KEPT `T3` 'openBudgetAt(a.budget, a.envelope, a.cover === true)' becomes 'openBudgetAt(a.envelope, a.cover === true)' and ADDED `S19` 'openBudgetAt(o.budget, o.envelope)' becomes 'openBudgetAt(o.envelope)' (7); KEPT `S21` 'const chosenBudget', ADDED `S21` 'chosenBudget()' (calendar) and the Bills block's `assert.ok(page.includes('const chosenBudget ='), 'S21')` become one assertion that `chosenBudget` is nowhere on the page (7); KEPT `S20` 'async function categoryList(' → GONE (11); KEPT_092's Household items line `budgetItem()` becomes `savingsItem()` (11).

---

### Task 1: One budget: the budget layer leaves the log, every reader, every tool and every route

Receipts still carry categories in this task; only the budget goes. Mechanical but wide: `grep -ln budget api/src/*.ts` lists every file to read. The word stays only where it names the Budget tab (`Lane 'budget'`, `BriefingSource 'budget'`, `'budget'` as a view).

**Files:**
- Modify: `api/src/types.ts`, `replay.ts`, `envelopes.ts`, `analytics.ts`, `sinking.ts`, `figures.ts`, `income.ts`, `calendar-money.ts`, `calendar-view.ts`, `offers.ts`, `thread.ts`, `conversation.ts`, `briefing.ts`, `claude.ts` (`householdContext` only), `setup.ts`, `first-run.ts`, `lanes.ts`, `match.ts`, `plans.ts`, `plan-rules.ts`, `plan-edits.ts`, `restore.ts`, `tools.ts`, `server.ts`, and any other file the grep names; every test the suite then fails; `api/test/page-ledger.test.ts` (the route test only); `api/test/fixtures/bills-old-log.jsonl`, `bills-old-log.pace.json`, `api/test/bills-old-logs.test.ts`, `api/test/bill-figures.ts`
- Delete: `api/test/fixtures/old-log.jsonl`, `api/test/fixtures/old-log.state.json`, `api/test/old-log.test.ts`
- Create: `api/test/one-budget.test.ts`

**Interfaces:**
- Consumes: nothing from this plan.
- Produces: `State.envelopes`, `State.bills`, `State.location: Location | null`, `State.months: ReadonlyMap<Month, MonthPlan>`; `Location`; every op of the Interfaces block without `budget`; `household.locate { location, why }` (in `REQUIRES_WHY` in place of `budget.locate`); `Plan.envelope` and `plan.set`'s `envelope` as `EnvelopeId | null`; `thread.ts`'s `Open` as `{ envelope: EnvelopeId }`; every reader signature of the Interfaces block without its budget parameter (`monthView(state, month)`, `carriedInto(state, month, envelope)`, `snapshot(state, month, today)`; `pickerOptions(state, t)` and `envelopeFor(state, t)` keep their receipt argument until Task 2); tool `set_location { label, postal?, stateFips?, countyFips?, why }` (approved in one); `GET /api/budget`; `firstRun(state, today)` with `step: 'where' | 'income' | 'envelopes' | null` and `started`, and `groups` as today; `GET /api/thread`'s `notStarted`; in the ledger test, `RETIRING`.

- [ ] **Step 1: Write the failing tests** in `api/test/one-budget.test.ts`, with the helpers the other tests use (`ev`, a `claim`):
```ts
describe('one budget per household', () => {
  test('a household holds its envelopes, months and bills directly', () => {
    const s = replay([claim, ev({ op: 'category.define', category: 'groceries', label: 'Groceries' }),
      ev({ op: 'envelope.define', envelope: 'groc', label: 'Groceries', group: 'Food', match: { categories: ['groceries'] }, template: cents(60000) }),
      ev({ op: 'month.open', month: '2026-11', income: cents(500000) })]);
    assert.deepEqual([...s.envelopes.keys()], ['groc']);
    assert.equal(s.months.get('2026-11')?.income, 500000);
    assert.equal('budgets' in s, false);
    assert.equal(monthView(s, '2026-11')?.envelopes[0]?.envelope.id, 'groc');
  });
  for (const op of ['budget.create', 'budget.rename', 'budget.archive', 'budget.locate']) {
    test(`${op} is not an op`, () => assert.throws(() => replay([claim, ev({ op, budget: 'x', label: 'X' } as never)]), new RegExp(`unknown op: ${op.replace('.', '\\.')}`)));
  }
  test('household.locate says where the household is, and needs a reason', () => {
    const s = replay([claim, ev({ op: 'household.locate', location: { label: 'Springfield, IL', postal: '62701' }, why: 'where we live' })]);
    assert.deepEqual(s.location, { label: 'Springfield, IL', postal: '62701' });
    assert.throws(() => requireReason(ev({ op: 'household.locate', location: null } as never)));   // the store's append runs it
    assert.ok(REQUIRES_WHY.has('household.locate'));
  });
  test('no tool takes a budget, and the budget tools are gone', () => {
    for (const t of TOOLS) assert.equal(JSON.stringify(t.input).includes('"budget"'), false, t.name);
    assert.deepEqual(TOOLS.map((t) => t.name).filter((n) => ['create_budget', 'rename_budget', 'archive_budget', 'compare_budgets', 'set_budget_location'].includes(n)), []);
    assert.ok(APPROVE_IN_ONE.has('set_location'));
  });
  test('first run: where it is, then income, then envelopes', () => {
    const today = '2026-11-10';
    assert.deepEqual(pick(firstRun(replay([claim]), today)), { step: 'where', started: false });
    const located = replay([claim, ev({ op: 'household.locate', location: { label: 'Springfield, IL' }, why: 'w' })]);
    assert.deepEqual(pick(firstRun(located, today)), { step: 'income', started: true });
    // Where it is skipped and the month opened: the income step is done, so Envelopes, though nothing has started it.
    const skipped = replay([claim, ev({ op: 'month.open', month: '2026-11', income: cents(0) })]);
    assert.deepEqual(pick(firstRun(skipped, today)), { step: 'envelopes', started: false });
  });
});
```
  `pick` keeps `step` and `started`. In `api/test/server-*.test.ts` (the file that already tests `/api/budgets`, renamed in place), add: `GET /api/budget` answers `{ thisMonth, lastIncomeExact, location: null, envelopes: 0, months: [], started: false }` for a fresh household; `GET /api/thread` answers `notStarted: true` for it and not after `household.locate`; a `POST /api/thread/note` body with a `budget` field writes a note with no `budget`.
- [ ] **Step 2: Run to verify it fails.** Run: `cd api && node --test --experimental-strip-types test/one-budget.test.ts`. Expected: FAIL (`s.envelopes` is undefined).
- [ ] **Step 3: Types.** In `types.ts`: delete `Budget`, `BudgetId`, `monthKey`, `budget.create`, `budget.rename`, `budget.archive`, `budget.locate`; rename `BudgetLocation` to `Location`; add `household.locate`; take `budget` off every op, `MonthPlan`, `Prediction`, `Offer`, `IncomeSource` and `Plan.envelope`; add the four `State` fields of Produces. Fix the two-layer doc comment at the file's top to say a household has one budget (receipts stay on categories until Task 2).
- [ ] **Step 4: The fold.** In `replay.ts`: `Draft` loses `budgets` and gains `envelopes`, `bills`, `location`; `freeze` and `thaw` list them (a field missed in either is lost on the next append with no error); `months` is keyed by `e.month`; `budgetOrThrow` goes; `monthOrThrow(d, month, e)` refuses ``month ${month} is not open``; the four budget cases go, `household.locate` sets `location`; `envelope.define`, `envelope.remove`, `bill.*`, `month.*`, `assign`, `move`, `income.set` act on the household's. `validate`'s briefing check ("the household's briefing is no one budget's") and the guest card's `budget` check go with the field.
- [ ] **Step 5: Every reader.** Drop the budget parameter from each function the Interfaces block lists and from their callers: `envelopes.ts`, `analytics.ts`, `sinking.ts`, `figures.ts`, `income.ts`, `calendar-money.ts`, `calendar-view.ts`, `offers.ts` (`fingerprint(state, month, envelopes)`, `raiseSavingsCard(ctx, written)`), `thread.ts` (`budgetOf` goes; `Open` as Produces), `conversation.ts` (`note(ctx, text, plan?)`, `askInThread(ctx, question, plan?)`, `dayEvents(events, today)`; the money line reads "Money: linked to <envelope>, which has no open month to read"), `briefing.ts` (the budget picker at ~533 goes; one `budget` section a day), `setup.ts`, `match.ts`, `plans.ts`, `plan-rules.ts` (`envelopeRef` takes an id), `lanes.ts`. `claude.ts`'s `householdContext` takes `location` in place of `budgets` and says `Where it is: <label>.` or nothing.
- [ ] **Step 6: Tools.** In `tools.ts`: no tool's `input` names `budget` and no `run` reads `args['budget']`; `resolveMonth(state, month)` refuses `no months are open`; delete `create_budget`, `rename_budget`, `archive_budget`, `compare_budgets`; rename `set_budget_location` to `set_location`, writing `household.locate` (in `APPROVE_IN_ONE` in its place, `create_budget` out); `describe` drops every " for <budget>" and " in <budget>", says `set where the household is to ${label}` / `cleared where the household is` for `household.locate`, and its `budget()` and `env(b, id)` helpers become `env(id)`.
- [ ] **Step 7: Routes.** In `server.ts`: no route reads a `budget` body field or query; `defaultBudget` and `budgetInView` go; `GET /api/budgets` becomes `GET /api/budget` as the Interfaces block says (`started` from `firstRun`); `GET /api/budget/first-run` reads no query; `GET /api/thread` sends `notStarted: true` while `firstRun(...).started` is false, in place of `noBudgets`; the route list at the file's top says so.
- [ ] **Step 8: First run.** `firstRun(state, today)`: `started` is `state.location !== null || state.envelopes.size > 0`; `step` is `'where'` while not started and this month is not open, else `'income'` while the month is not open and (no source or no envelopes), else `'envelopes'` while there are none, else `null`; `location` is `state.location?.label ?? null`; `groups` as today. The `FirstRunStep` `'budget'` goes.
- [ ] **Step 9: The ledger's route test.** In `api/test/page-ledger.test.ts`, inside `'every route the page calls is one the server answers'`: after `called` is built, add every tool the page names through `approveNow` or a panel (Ruling 24), then compute `unanswered` with today's filter, and replace its assertion:
```ts
for (const m of script.matchAll(/approveNow\('([a-z_]+)'|tool: '([a-z_]+)'/g)) called.add(`/api/tools/${m[1] ?? m[2]}`);
const unanswered = [...called].filter((route) => (route.startsWith('/api/tools/')
  ? !tools.includes(`name: '${route.slice('/api/tools/'.length)}'`) : !server.includes(route)));
/** Doors the server has closed that the page still knocks on, each until the page task that drops its last call (plan 2026-11-10-one-budget-envelopes, Ruling 20). */
const RETIRING: readonly string[] = ['/api/tools/compare_budgets', '/api/tools/create_budget', '/api/tools/rename_budget',
  '/api/tools/archive_budget', '/api/tools/set_budget_location', '/api/budgets'];
assert.deepEqual(unanswered.filter((r) => !RETIRING.includes(r)), []);
assert.deepEqual(RETIRING.filter((r) => !unanswered.includes(r)), [], 'a door the page no longer calls, or one still open, comes off RETIRING');
```
  Declare `RETIRING` at the top level beside `DRAWN_LATER` so later tasks edit one list. Before changing any source, run the extended test against the tree as it is: expected PASS with `RETIRING` empty (every name the page uses is a tool at 2d9f350); then fill it.
- [ ] **Step 10: The fixtures.** Delete `old-log.jsonl`, `old-log.state.json` and `old-log.test.ts` (it pinned the multi-budget state's shape, which the spec retires). Convert `bills-old-log.jsonl` with a throwaway `<scratchpad>/convert.ts` (not committed): drop every line whose `budget` is `ridge` and every `budget.create`; delete the `budget` field from the rest. Re-key the frozen figures with a throwaway `<scratchpad>/rekey.ts` that reads `bills-old-log.pace.json`, keeps only `bills-old-log`, keeps its `fixed` as it is, keeps the `months` keys that begin `harbor/` with that prefix removed, and writes the file back with `JSON.stringify(x, null, 1)`; never recompute it. In `bill-figures.ts`, `figuresOf` walks `openMonths(state)` and keys `` `${month}/${today}` ``; `readLog` takes `'bills-old-log'` only. In `bills-old-logs.test.ts`, loop over `bills-old-log` alone and drop `harbor/` from every key the hand-worked test reads.
- [ ] **Step 11: Migrate the other tests.** For every failing test file: delete `budget.create` lines; delete `budget:` fields from events and tool arguments; `state.budgets.get(x)!.envelopes` → `state.envelopes`; `monthKey(b, m)` → `m`; `budget.locate` → `household.locate`. Delete a test only when it pins a second budget (switching, copying, comparing, archiving, a receipt counted in two budgets, "only in one"): list each in the commit body.
- [ ] **Step 12: Run the pins.** Run: `cd api && node --test --experimental-strip-types test/one-budget.test.ts test/bills-old-logs.test.ts test/page-ledger.test.ts`. Expected: PASS. `bills-old-logs.test.ts` passing against the re-keyed golden is the proof that no figure moved; if it fails, the code is wrong, not the golden.
- [ ] **Step 13: Suite, typecheck, commit.** Both clean. Commit every file above by name: "A household has one budget: no budget is named, picked, renamed, archived or compared, and where it is belongs to the household."

### Task 2: A receipt is sorted into one envelope, and envelopes sit under categories

The final vocabulary of the Interfaces block, in the fold, every rollup, and every tool and route that must write or read it. The heading tools and the approve-in-one doors are Task 4's; this task only keeps what exists working in the new shape.

**Files:**
- Modify: `api/src/types.ts`, `replay.ts`, `envelopes.ts`, `analytics.ts`, `sinking.ts`, `figures.ts`, `match.ts`, `starter.ts`, `first-run.ts`, `local.ts`, `restore.ts` (`scopeOf` only), `lanes.ts`, `activity.ts`, `offers.ts`, `briefing.ts` (fields only; words are Task 6's), `tools.ts`, `server.ts`, every test the suite then fails, `api/test/bill-figures.ts`, `api/test/page-ledger.test.ts` (`RETIRING` only)
- Delete: `api/test/fixtures/bills-old-log.jsonl`, `api/test/fixtures/bills-old-log.pace.json`, `api/test/bills-old-logs.test.ts`
- Create: `api/test/sorted-into-envelopes.test.ts`

**Interfaces:**
- Consumes: Task 1's `State` fields and signatures.
- Produces: everything in the Interfaces block's `types.ts`, `envelopes.ts`, `analytics.ts`, `sinking.ts`, `figures.ts`, `match.ts`, `replay.ts` and `first-run.ts` parts; `envelopeIdFor`; `categoryIdFor(state, label): CategoryId` (in `envelopes.ts`, beside it); starter data in `starter.ts`: `STARTER_CATEGORIES: readonly { id: CategoryId; label: string; envelopes: readonly { id: EnvelopeId; label: string }[] }[]` (the six of Ruling 7, rows as today's `GROUP_IDS` with today's labels; Health & medical is gone), `PRICED` (rent, tax, elec), `STARTER_RULES` with `envelope`, `missingRules(state)`; tool `sort_receipts` (was `categorize_transactions`); `get_month`'s `categories: { id, label, envelopes: number }[]` (in order, empty ones included) and each envelope's `category`; `list_transactions { toSortOnly?, envelope?, … }`; `make_starter_envelopes { envelopes: [{ label, id?, category?, newCategory? }] }`; `set_sinking_goal`'s `estimate?: { costCents, everyYears } | null`; `remove_envelope`'s count sentence; `restore_transaction { txnId, envelope?, why }`; the routes of the Interfaces block.

- [ ] **Step 1: Write the failing tests** in `api/test/sorted-into-envelopes.test.ts`. Helpers at the top: `ev`, `claim`; `house(more)`: claimed; categories `food` "Food", `fun` "Fun"; envelopes `groceries` (food, $600), `dining` (food, $200), `gym` (fun, $40); 2026-09, 2026-10 and 2026-11 opened, `month.close` 2026-09, then `more` (so September is closed before anything in `more` happens; a receipt is a fact and lands in a closed month); `t(id, date, payee, dollars)` a `Txn` with `envelope: null`; `add(txn)` its `txn.add`; `sortTo(id, envelope)` a `txn.sort`; `spent(s, month)` each envelope's `activity` by id; `bad(e, re)` asserting `apply(house(), [ev(e)])` throws `re`. Then:
```ts
describe('a receipt is sorted into one envelope', () => {
  test('txn.sort files it, and it counts there and only there', () => {
    const s = house([add(t('m1', '2026-11-03', 'EXAMPLE MARKET', '-120.00')), ev({ op: 'txn.sort', txn: 'm1', envelope: 'groceries', manual: true })]);
    assert.deepEqual(spent(s, '2026-11'), { groceries: 12000, dining: 0, gym: 0 });
  });
  test('suggestedBy stays when the same envelope is confirmed and goes when it changes', () => { /* sort suggestedBy claude; sort same: kept; sort dining: gone */ });
  test('a split counts each part in its own envelope', () => { /* -60 split groceries -20, dining -40 */ });
  test('the fold refuses', () => {
    bad({ op: 'txn.sort', txn: 'm1', envelope: SPLIT }, /a split is written with txn\.split/);
    bad({ op: 'txn.split', txn: 'm1', parts: [{ envelope: 'dining', amount: -6000 }, { envelope: 'dining', amount: -6000 }] }, /an envelope appears twice in the split/);
    bad({ op: 'txn.split', txn: 'm1', parts: [{ category: 'dining', amount: -12000 }] }, /a part names its envelope/);
    bad({ op: 'txn.add', txns: [{ ...t('x', '2026-11-01', 'X', '-1.00'), envelope: SPLIT }] }, /split/);
  });
  test('a receipt or rule naming an envelope that is not here replays, and is To sort in any month', () => {
    const s = house([add({ ...t('o', '2026-09-02', 'OLD', '-5.00'), envelope: 'nowhere' }), ev({ op: 'rule.add', rule: 'r', match: 'OLD', envelope: 'nowhere' })]);
    assert.deepEqual(toSort(s).txnIds, ['o']);
  });
});
describe('categories are headings', () => {
  test('added last, renamed, moved to a place, removed only when empty', () => { /* add home; move home to 0: order [home, food, fun]; remove fun refused /Fun still holds envelopes/ */ });
  test('names are unique, case and spaces ignored', () => {
    bad({ op: 'category.add', category: 'food2', label: ' food ' }, /There is already a category called Food\./);
    bad({ op: 'envelope.define', envelope: 'g2', label: 'GROCERIES', category: 'food', template: cents(0) }, /There is already an envelope called Groceries\./);
  });
  test('an envelope needs a category that is here', () => bad({ op: 'envelope.define', envelope: 'x', label: 'X', category: 'nope', template: cents(0) }, /no such category: nope/));
});
describe('removing an envelope', () => {
  const gymTxns = [add(t('g9', '2026-09-05', 'EXAMPLE GYM', '-40.00')), sortTo('g9', 'gym'), add(t('g11', '2026-11-05', 'EXAMPLE GYM', '-40.00')), sortTo('g11', 'gym'),
    add(t('b11', '2026-11-12', 'CORNER BISTRO', '-80.00')), ev({ op: 'txn.split', txn: 'b11', parts: [{ envelope: 'dining', amount: cents(-5000) }, { envelope: 'gym', amount: cents(-3000) }] })];
  const removed = () => house([...gymTxns, ev({ op: 'envelope.remove', envelope: 'gym', why: 'cancelled' })]);
  test('a closed month keeps its receipts under its name, marked removed', () => {
    const g = monthView(removed(), '2026-09')!.envelopes.find((e) => e.envelope.id === 'gym')!;
    assert.deepEqual([g.removed, g.envelope.label, g.activity], [true, 'Gym', 4000]);
  });
  test("a month not closed sends them to To sort; a split goes whole and its other part still counts", () => {
    const s = removed();
    assert.deepEqual([...toSort(s).txnIds].sort(), ['b11', 'g11']);
    assert.deepEqual(toSort(s).missing.get('b11'), ['gym']);
    assert.equal(monthView(s, '2026-11')!.envelopes.find((e) => e.envelope.id === 'dining')!.activity, 5000);
    assert.equal(monthView(s, '2026-11')!.envelopes.some((e) => e.envelope.id === 'gym'), false);
  });
  test('a month closed after the removal keeps its receipts in To sort; a kept month reopened sends them there too', () => {
    const later = apply(removed(), [ev({ op: 'month.close', month: '2026-11', closed: true, why: 'done' })]);
    assert.ok(toSort(later).txnIds.includes('g11'));
    const reopened = apply(removed(), [ev({ op: 'month.close', month: '2026-09', closed: false, why: 'a late receipt' })]);
    assert.ok(toSort(reopened).txnIds.includes('g9'));
  });
  test('its id is reserved, and the same name takes a fresh one', () => {
    assert.throws(() => apply(removed(), [ev({ op: 'envelope.define', envelope: 'gym', label: 'Gym', category: 'fun', template: cents(0) })]), /gym was removed; a new envelope takes a new id/);
    assert.equal(envelopeIdFor(removed(), 'Gym'), 'gym-2');
    const back = apply(removed(), [ev({ op: 'envelope.define', envelope: 'gym-2', label: 'Gym', category: 'fun', template: cents(0) })]);
    assert.deepEqual([...toSort(back).txnIds].sort(), ['b11', 'g11'], 'old receipts are never pulled back');
  });
  test('a rule still sorting into it refuses the removal; its bills go with it', () => { /* rule.add EXAMPLE GYM -> gym then remove: /a rule still sorts into Gym/; bill.set on gym then rule.remove + remove: state.bills has none for gym */ });
});
describe('savings and repeating charges', () => {
  test("an every goal's estimate is the envelope's own", () => { /* roof every { cost 120000, everyYears 4 }: goalFor monthly 2500 */ });
  test('the balance on a day counts split parts', () => { /* a split with a part in roof: balanceAsOf includes it */ });
  test('pace counts a savings envelope as committed', () => { /* pace row for roof committed true */ });
  test('a repeating charge is grouped by payee and envelope', () => {
    // Two P2P PAYMENTs a month into one envelope are one charge seen twice a month, so not fixed (was: two fixed charges by category).
  });
});
describe('the starter set', () => {
  test('six categories of starter envelopes, keeping today\'s ids', () => {
    assert.deepEqual(STARTER_CATEGORIES.map((c) => c.id), ['home', 'food', 'insurance', 'utilities', 'sinking', 'everyday']);
    assert.deepEqual(STARTER_CATEGORIES.find((c) => c.id === 'utilities')!.envelopes.map((e) => e.id), ['elec', 'heat', 'water', 'internet']);
    assert.deepEqual(STARTER_RULES.map((r) => r.envelope), [TRANSFER, TRANSFER, INCOME, INCOME]);
  });
});
```
  In `api/test/tools.test.ts`, add `describe('sort_receipts')` (sorting into an envelope, a split, transfer and income, `suggestedBy`, `no envelope nope` for an id not live, `alsoAddRuleMatching` writing `rule.add` with `envelope`), and `describe('remove_envelope')`: with the gym receipts above, a rule `EXAMPLE GYM` and a bill, the proposal's events are `rule.remove`, then `envelope.remove`, and its effects include exactly `'Its 2 receipts from this month go back to To sort, and the rule "EXAMPLE GYM" goes with it.'` and `'Its bill EXAMPLE GYM goes with it.'`; with receipts in October and November both open, `'Its 2 receipts from months not yet closed go back to To sort.'`.
- [ ] **Step 2: Run to verify it fails.** Run: `cd api && node --test --experimental-strip-types test/sorted-into-envelopes.test.ts`. Expected: FAIL (`txn.sort` is an unknown op).
- [ ] **Step 3: Types.** As the Interfaces block: `SortedInto`, `NonSpend`, `isSpend`, `Txn.envelope`, `SplitPart`, `partsOf`, `Rule`, the new `Category`, `Envelope.category`, `SinkingGoal`'s estimate, `RemovedEnvelope`, `State.categories` and `State.removedEnvelopes`; the four category ops, the new `envelope.define`, `txn.sort`, `txn.split`, `rule.add`; delete `Assignment`, `Match`, `txn.categorize`, `category.define`, `category.archive`, `category.sinking`, and the two `REQUIRES_WHY` entries for the retired ops. `BillRecord`'s comment: removed with its envelope.
- [ ] **Step 4: The fold.** In `replay.ts`, with the refusals of Step 1 word for word: `checkParts` (`a part names its envelope`, `an envelope appears twice in the split`, a part may not be `SPLIT`); `splitProblem(parts, amount, envelopes, noEnvelope)` checks a spend part's envelope with the given set (the tools pass the live envelopes; the fold does not check existence); `txn.sort` as `txn.categorize` was (it sets `manual`, keeps `suggestedBy` on the same envelope confirmed, clears `split`); `txn.split` sets `envelope = SPLIT`; `rule.add` replaces a rule of the same id or match text, as today; `category.add` appends; `category.rename`; `category.move` rebuilds the map in the new order (`a category moves to a place in the list` for `to` outside `0..n-1`); `category.remove` (`${label} still holds envelopes`); `envelope.define` refuses a missing category (`no such category: ${id}`), a removed id (`${id} was removed; a new envelope takes a new id`) and a label another live envelope has, trimmed and case ignored (`There is already an envelope called ${label}.`), and keeps today's merge of an existing envelope's fields; `envelope.remove` refuses while a rule's `envelope` is it (`a rule still sorts into ${label}`), moves it into `removedEnvelopes` with `keptIn` the months closed at that moment, deletes its bill records. `categorize` becomes `byRule(rules, t)`, returning a rule's `envelope`. `freeze`/`thaw` carry `removedEnvelopes`.
- [ ] **Step 5: Ids.** In `envelopes.ts`: `envelopeIdFor(state, label)` and `categoryIdFor(state, label)` by Rulings 6 and 7, refusing a label with no letters or digits (`that name has no letters or numbers in it`).
- [ ] **Step 6: The rollups.** A private `kept(state, envelope, month)`: the envelope is in `removedEnvelopes`, `month` is in its `keptIn`, and `months.get(month)?.closed`. `monthView(state, month)` walks each receipt's `partsOf`: a part whose envelope is live counts there; a part whose envelope is `kept` counts in a view for it (`removed: true`, its `envelope` built from the record, its plan entry if the month's plan has one), placed after the live envelopes of its category; any other spend part counts nowhere. `MonthView.outside` and `EnvelopeLine.category` go. `carriedInto` the same. `inToSort(state, t)`: `t.envelope === null`, or some spend part's envelope is neither live nor `kept` in `monthOf(t.date)`; `toSort(state)` sums them as `unsorted` did, with `missing` per split receipt (the part envelopes that are neither live nor kept). `analytics.ts`: `chargeKey(payee, envelope)`, `fixedCharges` over parts by envelope, `pace`'s committed test `state.envelopes.get(line.envelope)?.sinking !== undefined`, `Snapshot.toSort`. `sinking.ts`: `goalFor`'s every goal is `estimate` alone (`estimatesFor` goes), `balanceAsOf` walks `partsOf` (the fix the spec asks for). `figures.ts`: by envelope id. `local.ts`: estimates keyed by envelope id (`rent`, `tax`, `elec`, unchanged strings).
- [ ] **Step 7: The picker.** `pickerOptions(state)`: each live envelope as `{ value: id, label, group: <its category's label> }` in category order then envelope order; then `{ value: TRANSFER, label: 'Transfer between our accounts', group: 'Not spending' }`, `{ value: INCOME, label: 'Income', group: 'Not spending' }`, `SPLIT_OPTION`. The `'Not in this budget'` group and the per-receipt argument go. `suggest` and `suggestForRows` choose among these values; `filedLabel` names an envelope by its label (a removed one by its record's); `ruleProblem` compares `envelope`.
- [ ] **Step 8: Starter and first run.** `starter.ts` as Produces; `groupOrder`, `groupKind`, `missingStarter` and the old `StarterCategory` go. `firstRun`'s `categories` replace `groups`.
- [ ] **Step 9: The tools that must speak it.** In `tools.ts`: `categorize_transactions` becomes `sort_receipts` (input `assignments: [{ txnId, envelope, parts?: [{ envelope, amount }], alsoAddRuleMatching?, suggestedBy? }]`; its description says to choose an envelope id from the envelopes `get_month` lists; it refuses an id not live with `no envelope ${id}`, 404); `get_month` sends `categories` and each envelope's `category`, drops `groups`, `envelopes[].group`, `envelopes[].categories` and `spentOutsideThisBudget`, sends `toSort` for `unsorted`, and each savings envelope's `sinking.estimate` as `{ cost, everyYears } | null`; `explain_envelope` drops `feedsFrom` and reports `envelope` on each receipt and part; `list_transactions` takes `toSortOnly` and `envelope` in place of `uncategorizedOnly` and `category`, and sends each receipt's `envelope`, `parts`, and `missing` when To sort holds it for a missing part; `define_envelope` takes `category` (a category id that is here) in place of `group` and `categories`, and stays until Task 4; `set_sinking_goal` takes `estimate`; `remove_envelope` as Step 1's test, the sentence from a private `removeWords(n, allThisMonth, rules)`; `make_starter_envelopes` as Produces, writing `category.add` for each starter category a row names that is not here (in starter order), `category.add` for a typed `newCategory`, the missing starter rules, then each `envelope.define` (`needsFigure: true`, as today); `restore_transaction` takes `envelope`; `look_up_local_costs` and `seed_from_location` find the envelope by id; `open_month` loses the overlap warning; delete `define_category`, `archive_category`, `add_starter_set`. `describe`: `txn.sort` "sorted a receipt into <Envelope>" (transfer: "marked a receipt as a transfer", income: "marked a receipt as income", null: "took a receipt out of its envelope"); `txn.split` "split a receipt across <Envelope> $X and <Envelope> $Y"; `rule.add` `added the rule "${match}" for <Envelope>`; `category.add` "added the category Food"; `category.rename` "renamed a category to Food and drink"; `category.move` "moved the category Food to place 2"; `category.remove` "removed the category Food"; `envelope.define` "set up the envelope Gym under Fun"; a removed envelope reads by its record's label. `activity.ts`'s `removedTxn` answers `envelope` in place of `category`; `offers.ts` reads `toSort` (its waiting kind is renamed in Task 4); `lanes.ts` follows the compiler.
- [ ] **Step 10: The routes.** `POST /api/import/preview` and `/api/import/commit` and `POST /api/match` as the Interfaces block (rows carry `envelope`; one shared `options`; `exists` checks a live envelope or a non-spend value; the commit's `toSort` count from `toSort(state).count`); `GET /api/categories` goes; `GET /api/settings` drops `categoriesInUse`.
- [ ] **Step 11: Restore's bands, only as far as the compiler asks.** `scopeOf`: the new category ops and `envelope.*` in `'budgets'`, `txn.sort` and `txn.split` and `rule.*` in `'facts'`. The rest of restore is Task 5's.
- [ ] **Step 12: `RETIRING`.** Add `'/api/tools/categorize_transactions'`, `'/api/tools/define_category'`, `'/api/tools/archive_category'`, `'/api/tools/add_starter_set'`, `'/api/categories'`.
- [ ] **Step 13: Migrate the tests.** Delete `bills-old-log.jsonl`, `bills-old-log.pace.json` and `bills-old-logs.test.ts` (their vocabulary is gone; Task 3 writes the one that replaces them); keep `bill-figures.ts`, its `fixed` rows read `[key, payee, envelope, typical, months]`. In every failing file: `category.define` becomes `category.add` of the heading the envelope sits under; `envelope.define`'s `group` and `match` become `category`; `txn.categorize` becomes `txn.sort` naming the envelope its category fed; parts and rules name envelopes. Delete a test only when it pins what the spec retires (a category feeding several envelopes, the payee predicate, "already feeds", the outside total, category estimates summed): list each in the commit body. A test of the bills plan's trap 1 (two fixed charges of one payee in one envelope) is rewritten to the spec's grouping, by payee and envelope, not deleted.
- [ ] **Step 14: Run.** Run: `cd api && node --test --experimental-strip-types test/sorted-into-envelopes.test.ts test/tools.test.ts test/split.test.ts test/core.test.ts`. Expected: PASS.
- [ ] **Step 15: Suite, typecheck, commit.** Both clean. Commit by name: "A receipt is sorted into one envelope and counts only there, an envelope sits under a category, and a removed envelope's open months go to To sort."

### Task 3: One household log in the new vocabulary, its figures frozen

No file under `api/src` changes in this task.

**Files:**
- Create: `api/test/fixtures/household-log.jsonl`, `api/test/fixtures/household-log.figures.json`, `api/test/household-log.test.ts`
- Rename: `api/test/bill-figures.ts` → `api/test/household-figures.ts`

**Interfaces:**
- Consumes: the ops and readers of the Interfaces block.
- Produces: `readLog(): Event[]` and `figuresOf(state: State): Figures` from `household-figures.ts`, `Figures` gaining `toSort: { txnIds: string[]; missing: [string, string[]][] }`, `categories: [string, string][]` and `removed: string[]`. Every later task runs `household-log.test.ts` and never regenerates the frozen file.

- [ ] **Step 1: The fixture.** Write `household-log.jsonl` with a throwaway generator in `<scratchpad>` (commit only its output): ids `h1`, `h2`…, `who` alice or bob, `why` on every op that takes one, `at` in the month each belongs to. In order:
  - `household.claim`, `member.add` bob, `household.zone` America/Denver, `household.locate` Springfield, IL (62701).
  - Categories `home` "Home", `food` "Food", `utilities` "Utilities", `sinking` "Savings and sinking funds", `fun` "Fun"; then `category.rename` food → "Food and drink"; `category.move` utilities to 0; `category.add` `pets` "Pets" and `category.remove` pets.
  - Envelopes `rent` (home, 250000), `groceries` (food, 60000), `dining` (food, 20000), `elec` (utilities, 15000), `water` (utilities, 5000), `roof` (sinking, 2500, every, estimate 120000 every 4), `gym` (fun, 4000); later, in one append, `category.add` `kids` "Children" and `envelope.define` `childcare` (kids, 30000).
  - Rules `PAYMENT THANK YOU` → `__transfer`, `PAYROLL` → `__income`, `EXAMPLE MARKET` → groceries, `EXAMPLE GYM` → gym. An income source of 500000 monthly from 2026-08-01.
  - Months 2026-08 to 2026-11 opened in order; `month.close` 2026-08 and 2026-09 after their receipts; an `assign` raising dining to 25000 in 2026-10; a `move` of 2000 from groceries to dining in 2026-11; a `bill.set` on elec for `example power billp`, due on the 16th.

  | Payee | Where | Days and amounts | Why it is here |
  |---|---|---|---|
  | `P2P PAYMENT` | rent | -2500.00 on the 1st, Aug to Nov | a fixed charge |
  | `PAYROLL` | income by rule | +5000.00 on the 1st, Aug to Nov | not spending |
  | `EXAMPLE MARKET` | groceries by rule | -120.00 Aug 3, -118.00 Sep 3, -130.00 Oct 3, -125.00 Nov 3 | sorted by rule at import |
  | `EXAMPLE GYM` | gym by rule | -40.00 on the 5th, Aug to Nov | its envelope is removed in November |
  | `EXAMPLE POWER BILLP 8842193` | elec | -146.00 Aug 14, -138.75 Sep 14, -152.00 Oct 14 | a bill with a date |
  | `CORNER BISTRO` | split | Sep 9 -60.00: dining -40.00, groceries -20.00; Oct 12 -80.00: dining -50.00, gym -30.00 | a split, and a split with a part in the removed envelope |
  | `QUIKSTOP 10001` | null, then `txn.sort` groceries, manual | -10.15 Oct 9 | sorted by hand later |
  | `CITY WATER` | null, then `txn.sort` water with `suggestedBy: 'claude'` | -48.00 Nov 1 | Claude's suggestion accepted |
  | `UNKNOWN SHOP` | null | -22.50 Nov 6 | To sort |
  | `PAYMENT THANK YOU` | transfer by rule | +300.00 Nov 7 | not spending |

  Last, in November: `rule.remove` of the gym rule, `envelope.remove` gym (why "cancelled the membership"), then `envelope.define` `gym-2` "Gym" under fun at 0.
- [ ] **Step 2: `household-figures.ts`.** `figuresOf` as `bill-figures.ts` has it, plus `toSort` (ids sorted, `missing` as entries), `categories` (`[id, label]` in order) and `removed` (the removed ids).
- [ ] **Step 3: Freeze it.** A throwaway `<scratchpad>/freeze.ts` writes `figuresOf(replay(readLog()))` to `household-log.figures.json` with `JSON.stringify(x, null, 1)`. Not committed: nothing in the tree can regenerate this file.
- [ ] **Step 4: Write `household-log.test.ts`.**
```ts
const FROZEN = JSON.parse(readFileSync(new URL('./fixtures/household-log.figures.json', import.meta.url), 'utf8'));
describe('the household log reads the same figures', () => {
  test('every figure, every month, four days of each', () => assert.deepEqual(figuresOf(replay(readLog())), FROZEN));
  test('replayed one line at a time, the same', () => {
    let s = replay([]);
    for (const e of readLog()) s = apply(s, [e]);
    assert.deepEqual(figuresOf(s), FROZEN);
  });
  test('worked by hand', () => {
    const s = replay(readLog());
    assert.deepEqual(FROZEN.categories.map(([id]: string[]) => id), ['utilities', 'home', 'food', 'sinking', 'fun', 'kids']);
    assert.deepEqual(FROZEN.toSort.txnIds.length, 4, 'October and November gym, the October split, UNKNOWN SHOP');
    assert.deepEqual(new Map(FROZEN.toSort.missing).get(splitId), ['gym']);
    const view = (m: string, id: string) => monthView(s, m)!.envelopes.find((e) => e.envelope.id === id);
    assert.deepEqual([view('2026-08', 'gym')?.removed, view('2026-08', 'gym')?.activity], [true, 4000]);
    assert.equal(view('2026-10', 'dining')!.activity, 5000, "the split's live part still counts");
    assert.equal(view('2026-10', 'groceries')!.activity, 14015);
    assert.equal(view('2026-11', 'water')!.activity, 4800);
    assert.equal(view('2026-11', 'gym'), undefined);
    assert.equal(view('2026-11', 'gym-2')!.activity, 0, 'the old receipts are not pulled back');
    assert.equal(goalFor(s, s.envelopes.get('roof')!, '2026-11')?.monthly, 2500);
  });
});
```
  `splitId` is the October CORNER BISTRO receipt's id as the generator wrote it. If a hand-worked number disagrees, the fixture is not what the table says: fix the generator and freeze again, in this task only.
- [ ] **Step 5: Prove it can fail.** Change one digit in the frozen file, run, expect FAIL naming that month; put it back.
- [ ] **Step 6: Suite, typecheck, commit** the three new files and the rename: "One household log in the new words pins every figure, To sort and a removed envelope's history, before the doors change."

### Task 4: Envelopes, categories and sorting by a press: the tools the page calls at once

**Files:**
- Modify: `api/src/tools.ts`, `api/src/offers.ts` (the waiting kind), `api/src/thread.ts` (the waiting kind), `api/test/tools.test.ts`, `api/test/page-ledger.test.ts` (`RETIRING` only), the tests that name `define_envelope` or the `unsorted` kind
- Create: `api/test/envelope-tools.test.ts`

**Interfaces:**
- Consumes: `envelopeIdFor`, `categoryIdFor`, `pickerOptions`, `ruleProblem`, the fold's refusals (Task 2).
- Produces, all approved in one (`APPROVE_IN_ONE`):
  - `add_envelope { label, category } | { label, newCategory }` → (`category.add` when new) + `envelope.define { template: 0, rollover: true, order: last in its category }`, no `needsFigure`; answers `touches: { envelope }`.
  - `change_envelope { envelope, label?, category?, newCategory? }` → (`category.add`) + `envelope.define` with the envelope's other fields as they are.
  - `add_category { label }`, `rename_category { category, label }`, `move_category { category, direction: 'up' | 'down' }`, `remove_category { category }`.
  - `sort_receipts` joins `APPROVE_IN_ONE`; its approve-in-one path refuses `alsoAddRuleMatching`.
- Produces, a proposal: `add_rule { match, envelope, txnId? }` → `rule.add`, checked by `ruleProblem` (with the receipt's payee when `txnId` is given).
- The waiting kind `'tosort'` (was `'unsorted'`), title and line unchanged (Ruling 13).
- `define_envelope` deleted.

- [ ] **Step 1: Write the failing tests** in `api/test/envelope-tools.test.ts`, on a household seeded as Task 2's `house` behind a server started the way `server-*.test.ts` start one. `approve(name, args)` posts `/api/tools/${name}?approve=1` with that file's `call()` and answers the body; `state()` is the household's state after it; `refusedWith(p, words)` asserts the answer is a 4xx whose `error` is exactly `words`:
```ts
describe('adding by a press', () => {
  test('an envelope lands at $0 planned and $0 funded, unflagged, at the end of its category', async () => {
    const r = await approve('add_envelope', { label: 'Pets', category: 'fun' });
    const e = state().envelopes.get('pets')!;
    assert.deepEqual([e.category, e.template, e.needsFigure, r.touches.envelope], ['fun', 0, undefined, 'pets']);
    const v = monthView(state(), '2026-11')!.envelopes.find((x) => x.envelope.id === 'pets')!;
    assert.deepEqual([v.planned, v.funded], [0, 0]);
  });
  test('a new category and its first envelope are one append', async () => {
    const before = state().eventCount;
    await approve('add_envelope', { label: 'Daycare', newCategory: 'Children' });
    assert.equal(state().eventCount - before, 2);
    assert.equal(state().envelopes.get('daycare')!.category, 'children');
  });
  test('names are refused with words', async () => {
    await refusedWith(approve('add_envelope', { label: 'groceries ', category: 'food' }), 'There is already an envelope called Groceries.');
    await refusedWith(approve('add_envelope', { label: 'Treats', newCategory: 'food' }), 'There is already a category called Food. Choose it from the list.');
    await refusedWith(approve('add_category', { label: ' FUN' }), 'There is already a category called Fun.');
  });
  test('a name used by a removed envelope takes a fresh id', async () => { /* remove gym (rule first), add 'Gym': envelope 'gym-2' */ });
});
describe('changing an envelope and the headings', () => {
  test('rename and change its category keep its figure, goal and receipts', async () => { /* change_envelope groceries label 'Market', category fun: template unchanged, receipts still in it */ });
  test('move up and down, refused at the ends', async () => {
    await approve('move_category', { category: 'fun', direction: 'up' });
    assert.deepEqual([...state().categories.keys()], ['fun', 'food']);
    await refusedWith(approve('move_category', { category: 'fun', direction: 'up' }), 'Fun is already first.');
    await refusedWith(approve('move_category', { category: 'food', direction: 'down' }), 'Food is already last.');
  });
  test('a category is removed only when empty', async () => {
    await refusedWith(approve('remove_category', { category: 'food' }), 'Move its envelopes first.');
    await approve('add_category', { label: 'Pets' }); await approve('remove_category', { category: 'pets' });
    assert.equal(state().categories.has('pets'), false);
  });
  test('a heading or envelope that went meanwhile is said, not guessed', async () => {
    await refusedWith(approve('add_envelope', { label: 'X', category: 'gone' }), 'no category gone');
    await refusedWith(approve('change_envelope', { envelope: 'gone', label: 'X' }), 'no envelope gone');
  });
});
describe('sorting by a press', () => {
  test('sort_receipts writes at once', async () => { /* approve sort_receipts m1 -> groceries: txn sorted */ });
  test('but never with a rule', async () => {
    await refusedWith(approve('sort_receipts', { assignments: [{ txnId: 'm1', envelope: 'groceries', alsoAddRuleMatching: 'EXAMPLE MARKET' }] }), 'A rule is shown before it is added.');
  });
  test('add_rule is a proposal that says what it would cover', async () => { /* proposal events [rule.add {envelope: groceries}]; effects name Groceries; ruleProblem refusals pass through */ });
  test('nothing the page calls at once is a proposal tool, and define_envelope is gone', () => {
    for (const n of ['sort_receipts', 'add_envelope', 'change_envelope', 'add_category', 'rename_category', 'move_category', 'remove_category']) assert.ok(APPROVE_IN_ONE.has(n), n);
    assert.equal(APPROVE_IN_ONE.has('add_rule'), false);
    assert.equal(TOOLS.some((t) => t.name === 'define_envelope'), false);
  });
});
```
- [ ] **Step 2: Run to verify it fails.** Run: `cd api && node --test --experimental-strip-types test/envelope-tools.test.ts`. Expected: FAIL (`add_envelope` is not a tool).
- [ ] **Step 3: Implement the tools** in `tools.ts`, beside `remove_envelope`, each with a description written for Claude (no "budget" as a choice, "category" only as a heading). Refusal words as the tests; a missing envelope or category is a 404 (`no envelope ${id}`, `no category ${id}`). Summaries: "Add Pets under Fun", "Rename Groceries to Market", "Move Groceries under Fun", "Add the category Children", "Rename Food to Food and drink", "Move Fun up", "Remove the category Pets". `sort_receipts`'s refusal is in the approve-in-one path of the route (`?approve=1`), not in the tool, so Claude's cards keep their rule.
- [ ] **Step 4: The waiting kind.** `offers.ts` pushes `{ kind: 'tosort', count }` from `toSort(state)`; `thread.ts` reads it; the title "N receipts to sort" stays.
- [ ] **Step 5: `RETIRING`** gains `'/api/tools/define_envelope'`; the tests that drove `define_envelope` drive `add_envelope` and `change_envelope`.
- [ ] **Step 6: Run.** Run: `cd api && node --test --experimental-strip-types test/envelope-tools.test.ts test/tools.test.ts test/household-log.test.ts`. Expected: PASS, the frozen figures untouched.
- [ ] **Step 7: Suite, typecheck, commit** the files above: "Adding an envelope or a category, renaming, moving and sorting a receipt are each one press, written at once, and a rule is still shown before it is kept."

### Task 5: Restore: one budget, never merged

**Files:**
- Modify: `api/src/restore.ts`, `api/src/types.ts` (`RETIRED_OPS`), `api/src/server.ts` (the two restore routes' refusal), `api/test/households.test.ts`, `api/test/restore-people.test.ts`
- Create: `api/test/restore-budget.test.ts`

**Interfaces:**
- Consumes: `scopeOf` (Task 2), `toSort`.
- Produces: `Scope` with `'budget'` in place of `'budgets'` (Ruling 11); `unreadableBackup(b: ParsedBackup): string | null` in place of `newerBackup`, used by both restore routes; `budgetIsEmpty(state): boolean` (no categories, envelopes, income sources, bills, location or months); `planRestore`'s collision kind `'budget'` in its new meaning; `eventsToApply` writing the Budget band before receipts. The kinds `'category'` and `'envelope-category'` go.

- [ ] **Step 1: Write the failing tests** in `api/test/restore-budget.test.ts`, with stores in a temp dir: `home` (a category, two envelopes, a month, receipts sorted into them, a rule), `backup = parseBackup(home's log)`, `fresh` (claimed, nothing else), and `other` (claimed, with one category and one envelope of its own):
```ts
describe('restoring a budget', () => {
  test('into a household whose budget is empty, as today', () => { /* plan clean; adopt; envelopes, categories, location equal */ });
  test("a household's own backup restores over itself: its lines are left out", () => { /* planRestore(home.state, backup, ['facts','budget','months']): no collision, take empty */ });
  test('into a household that already has a budget, a collision in words', () => {
    const plan = planRestore(other.state, backup, ['budget']);
    assert.deepEqual(plan.collisions.map((c) => c.why), ['This household already has a budget. Restore it as a new household instead.']);
    assert.deepEqual(planRestore(other.state, backup, ['months']).collisions.map((c) => c.why), ['This household already has a budget. Restore it as a new household instead.']);
  });
  test('receipts without the Budget band, into a budget with no envelopes, is a missing prerequisite', () => {
    assert.deepEqual(planRestore(fresh.state, backup, ['facts']).missingPrerequisites,
      ["Receipts and rules are sorted into envelopes, and this household's budget has none yet: choose Budget too, or restore it as a new household."]);
  });
  test('a receipt naming an envelope that is not here lands in To sort, never refused or left out', () => { /* fresh with one envelope 'groceries'; backup's receipt sorted into 'dining': adopted; toSort has it */ });
  test('the Budget band is written before the receipts', () => { /* eventsToApply order: every budget-scope event before the first facts event */ });
  test('a backup from before 0.10.0 is refused in words', () => {
    const b = parseBackup('{"id":"x1","at":"2026-10-01T00:00:00Z","who":"alice","op":"budget.create","budget":"home","label":"Home"}\n');
    assert.equal(unreadableBackup(b), 'This backup was made before Home Planner 0.10.0, which keeps one budget and sorts receipts into envelopes. It cannot be restored into this version.');
  });
});
```
- [ ] **Step 2: Run to verify it fails.** Run: `cd api && node --test --experimental-strip-types test/restore-budget.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `restore.ts` with the words above: the `'budget'` band in place; the old budget, category and envelope-category collisions go; after lines already here are left out, any remaining `'budget'` or `'months'` line into a household where `!budgetIsEmpty(target)` is one `'budget'` collision; the facts-without-budget prerequisite only when `target.envelopes.size === 0`; months without the Budget band into an empty budget: "Months need the budget they were planned in: choose Budget too."; `eventsToApply` sorts by band (budget, then facts, then the rest), stable inside each; `unreadableBackup` names `RETIRED_OPS` first and keeps the "newer" sentence for any other unknown op. The summary line "N budgets and M envelope definitions" becomes "the budget: M envelopes in N categories". `server.ts`'s two routes call `unreadableBackup`.
- [ ] **Step 4: Migrate** `households.test.ts` and `restore-people.test.ts`: a test of merging a budget into a household that has one now expects the collision; list any deleted test in the commit body.
- [ ] **Step 5: Run.** Run: `cd api && node --test --experimental-strip-types test/restore-budget.test.ts test/households.test.ts test/restore-people.test.ts`. Expected: PASS.
- [ ] **Step 6: Suite, typecheck, commit** the files above: "A backup restores its budget only into a household whose budget is empty, says so in words otherwise, and an older backup is refused by name."

### Task 6: Claude speaks of one budget, envelopes and categories

**Files:**
- Modify: `api/src/claude.ts` (`METHOD_RULES`), `api/src/briefing.ts`, `api/src/tools.ts` (descriptions only), `api/src/match.ts` (`SYSTEM` prompt), `api/src/conversation.ts` (words only), `api/test/briefing.test.ts`, `api/test/claude-key.test.ts` or the test that reads `METHOD_RULES`
- Create: `api/test/claude-words.test.ts`

**Interfaces:**
- Consumes: `sort_receipts`, `add_envelope`, the heading tools (Task 4); `Snapshot.toSort`.
- Produces: words only. No tool name or argument changes.

- [ ] **Step 1: Write the failing test** `api/test/claude-words.test.ts`:
```ts
const FORBIDDEN = /\bbudgets\b|categori[sz]|uncategor|two layers|interpretation|every budget|other budget|compare_budgets|create_budget|the other place|moved to|moving to|fed by/i;
test('nothing Claude reads names budgets as a choice, categorises a receipt or plans a move', () => {
  const texts = [METHOD_RULES, SYSTEM_FOR_MATCH, ...TOOLS.flatMap((t) => [t.description, JSON.stringify(t.input)])];
  assert.deepEqual(texts.filter((t) => FORBIDDEN.test(t)).map((t) => t.slice(0, 80)), []);
  assert.match(METHOD_RULES, /exactly one envelope/);
  assert.match(METHOD_RULES, /CATEGORIES?, which are only headings/);
});
test("the briefing's own words say To sort", () => {
  // the fallback briefing over a snapshot with 3 receipts in To sort
  assert.match(plainMonth(snapWithToSort(3), 0).headline, /^3 receipts to sort$/);
  assert.doesNotMatch(briefingFacts(snapWithToSort(3)), /UNCATEGORISED|no envelope here/);
  assert.match(briefingFacts(snapWithToSort(3)), /^TO SORT: 3 receipts/m);
});
```
  `SYSTEM_FOR_MATCH` is `match.ts`'s `SYSTEM`, exported for the test; `plainMonth` and the facts builder (`briefingFacts`, the function at ~205 that assembles `parts`) are exported if they are not. `snapWithToSort(n)` is the test's own: `snapshot(replay(events), '2026-11', '2026-11-10')!` over a claimed household with one category, one envelope, November opened, and `n` receipts with no envelope.
- [ ] **Step 2: Run to verify it fails.** Run: `cd api && node --test --experimental-strip-types test/claude-words.test.ts`. Expected: FAIL naming `METHOD_RULES` and several tool descriptions.
- [ ] **Step 3: `METHOD_RULES`.** Replace the two-layer paragraphs with:
  > The plan is zero-based: every dollar of take-home is assigned a job, and the month balances to zero rather than reporting a surplus. The household has one budget: a set of ENVELOPES, each a month's money for one thing, sitting under CATEGORIES, which are only headings that group them on the page.
  >
  > Every receipt is sorted by a person into exactly one envelope, or split across several, and counts there and nowhere else. A receipt not sorted yet is in To sort, and no envelope counts it. Your suggestions name an envelope; a person decides.

  Keep the PLAN and ADJUSTMENT paragraph. The transfers paragraph says they are sorted as a transfer, and income as income, and that no envelope counts either. Delete the paragraph that begins "Assume they know the method" up to "the other place." and keep its first sentence ("Assume they know the method and do not need it explained.").
- [ ] **Step 4: The briefing.** `BUDGET: <month>` in place of `BUDGET: <label> — <month>`; the "spent outside every envelope" line and the "was spent in categories with no envelope here." clause go; `UNCATEGORISED:` becomes `TO SORT: N receipts — $X out, $Y in, oldest D`; the headline "N transactions still need categorising" becomes "N receipts to sort"; "N receipts … are not in an envelope yet." stays.
- [ ] **Step 5: Every tool description** that fails the test, reworded: one budget, receipts sorted into envelopes, categories as headings, `sort_receipts` choosing an envelope id from `get_month`. The match prompt sorts "a household's bank transactions into its envelopes".
- [ ] **Step 6: Run.** Run: `cd api && node --test --experimental-strip-types test/claude-words.test.ts test/briefing.test.ts`. Expected: PASS.
- [ ] **Step 7: Suite, typecheck, commit** the files above: "Claude reads one budget whose receipts are sorted into envelopes under category headings, and the briefing says To sort."

### Task 7: The Budget screen shows one budget: its head, its list by category, and no budget named anywhere

The first page task. It makes the Budget screen draw again against Tasks 1 to 6, and takes every trace of a second budget off the page. Adding (Task 8), the envelope's page (9), sorting (10), the sheet and Settings (11) and the walkthrough (12) follow.

**Files:**
- Modify: `site/index.html` (the head's markup; the regions `// ── budget`, `// ── which budget am I looking at` (renamed `// ── reading the screen again`), `// ── comparison` (deleted), `// ── managing budgets and envelopes` (renamed `// ── adding envelopes and categories`), `// ── where a budget is, and what that place costs` (renamed `// ── where it is, and what that place costs`), `// ── views`; in `// ── the budget walkthrough`, `drawWalk`'s heading and every `loadBudgets()` call; Today's `threadParams`, `loadThread`, `briefingNode`'s byline, the change row, `moneyRailRows`, `renderSetupNotes`, `rowLink` callers, `askClaude`, `leaveNote`; the card's `moneyRows` and `moneyForm`; the Calendar's two `/api/calendar` reads and its money rows; `budgetForm`'s balance post; Import's preview post; the CSS of Compare and of the outside note), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `GET /api/budget`, `get_month`'s `categories` and envelopes' `category` and `removed`, `set_location`, `GET /api/thread`'s `notStarted`, `Open { envelope }`.
- Produces, on the page: `let budgetMeta` filled by `async function loadBudgetMeta()` (replaces `loadBudgets`, `budgets` and `chosenBudget`); `openBudgetAt(envelope, focus)`; `function categoryBand(c, list)` drawing one category's heading and rows, with a `data-category` on the band and a `.band-head` holding the `h2` (Task 8 adds the menu there); `function savingsCheckLine(check)`; `const BUDGET_SUBS = ['budget', 'import'];`; regions in the ledger test: `budget`, `budgetMarkup`, `matchSrc`.

- [ ] **Step 1: The ledger block, before the work.** In `api/test/page-ledger.test.ts`, add to `REGIONS`: `budget: between(script, '// ── budget', '// ── plan: the board and the card')`, `budgetMarkup: markup.slice(markup.indexOf('<div class="page-head budget-head"'), markup.indexOf('<!-- Plan: the board'))`, `matchSrc: read('../src/match.ts')`. Add at the end of the file:
```ts
// ── 0.10.0: one budget, receipts sorted into envelopes, categories as headings. Rows B1 to B84 of plan 2026-11-10-one-budget-envelopes. ──
describe('the page ledger: 0.10.0', () => {
  test('what 0.10.0 keeps, adds and takes away', () => {
    assert.deepEqual(missing(KEPT_010, true), []);
    assert.deepEqual(missing(ADDED_010, true), []);
    assert.deepEqual(missing(GONE_010, false), []);
  });
});
```
  with `KEPT_010`, `ADDED_010`, `GONE_010` (`readonly Line[]`) declared above it. Put this task's Kept rows in now and run the ledger against the page as it is: expected PASS.
  - KEPT: `['B4', 'id="bud-where"', 'budgetMarkup']`, `['B4', 'Not set yet, so local costs cannot be looked up', 'budget']`, `['B5', 'id="bud-seed">Price it from local data', 'budgetMarkup']`, `['B8', 'id="month-discard"', 'budgetMarkup']`, ``['B8', "`Discard ${name}'s plan`", 'budget']``, `['B13', 'id="ta-next"', 'budgetMarkup']`, `['B13', '<span class="k">Planned</span>', 'budgetMarkup']`, `['B14', 'Record an income', 'budgetMarkup']`, `['B14', 'id="inc-what-if"', 'budgetMarkup']`, `['B15', 'id="needs-h">Needs you<', 'budgetMarkup']`, `['B19', 'function envelopeRow(', 'budget']`, `['B19', "amt = 'No figure yet'", 'budget']`, `['B26', 'id="month-close"', 'budgetMarkup']`, ``['B26', '`Reopen ${name}`', 'budget']``.
- [ ] **Step 2: Add this task's Added and Gone rows**, run, expect FAIL naming each:
  - ADDED: `['B1', 'id="budget-month"', 'budgetMarkup']`, `['B10', "const BUDGET_SUBS = ['budget', 'import'];", 'page']`, `['B10', 'aria-label="Budget or Import"', 'budgetMarkup']`, `['B12', "panel('Where it is'", 'budget']`, `['B12', "tool: 'set_location'", 'budget']`, `['B17', 'function categoryBand(', 'budget']`, `['B17', 'for (const c of result.categories)', 'budget']`, `['B18', 'function savingsCheckLine(', 'budget']`, `['B18', "openSettings('household', 'savings')", 'budget']`, `['B20', "'No envelopes yet'", 'budget']`, `['B27', "'erow-removed'", 'budget']`, ``['B72', '`Open ${monthLong(fr.month)}`', 'budget']``, ``['B75', "Claude · the budget's briefing", 'today']``, `['B77', 'The budget is not started yet.', 'page']`, `['B78', 'This month is not open yet.', 'today']`, `['B79', 'The budget has no plan for this month yet. ', 'page']`, `['B80', "lab('Envelope', envSel)", 'plan']`, `['B84', 'async function loadBudgetMeta(', 'budget']`, `['B84', "api('/api/budget')", 'budget']`, `['B84', 'async function openBudgetAt(envelope, focus)', 'budget']`.
  - GONE: `['B1', 'function markChosenBudget(', 'page']`, `['B2', 'budget-switch', 'page']`, `['B3', 'budget-pick', 'page']`, `['B6', 'bud-rename', 'page']`, `['B6', 'Rename this budget', 'page']`, `['B7', 'bud-new', 'page']`, `['B7', 'New budget', 'page']`, `['B9', 'bud-archive', 'page']`, `['B9', 'Archive this budget', 'page']`, `['B10', 'data-sub="compare"', 'page']`, `['B11', 'id="compare"', 'page']`, `['B11', 'compare_budgets', 'page']`, `['B11', 'function loadCompare(', 'page']`, `['B11', 'Pick two different budgets.', 'page']`, `['B11', '.verdict', 'css']`, `['B11', 'table.cmp', 'css']`, `['B12', 'blank if it is a period, not a place', 'page']`, ``['B12', 'Where is ${b?.label', 'page']``, `['B16', 'outside-box', 'page']`, `['B16', 'no envelope here covers', 'page']`, `['B16', 'Add an envelope for them', 'page']`, `['B17', 'result.groups', 'page']`, `['B17', 'bands.get(e.group)', 'page']`, `['B18', 'function savingsBand(', 'page']`, `['B72', "?.label ?? 'this budget'", 'page']`, `['B75', 'Claude · briefing for ', 'page']`, `['B76', 'live.length > 1 ? live.find', 'page']`, `['B77', 'no budgets yet', 'page']`, `['B77', 'This household has no budget yet.', 'page']`, `['B78', 'No budget has this month open yet.', 'page']`, ``['B79', "b?.label ?? 'This budget'", 'page']``, `['B80', "lab('Budget', budgetSel)", 'page']`, `['B80', "a budget'}; this month isn't open", 'page']`, `['B81', 'the budgets side by side', 'page']`, `['B82', 'chosenBudget', 'page']`, `['B82', 'loadBudgets', 'page']`, `['B82', "'/api/budgets'", 'page']`, `['B82', 'budget: month.budget', 'page']`, `['B84', 'openBudgetAt(m.budget', 'page']`.
  - Move the existing pins this task owns (the ledger section's "Existing pins this release moves"): T113 both, T95, T14, T3, S19, S21 and the Bills block's S21 assertion, which becomes `assert.equal(page.includes('chosenBudget'), false, 'S21: one budget, none chosen')`.
- [ ] **Step 3: The head and the menu.** The pill's `#budget-label` reads "Budget" and gains `<span class="sub" id="budget-month"></span>`, filled by `loadBudget` with `monthLong(result.month)`; the menu holds Where it is, Price it from local data, a separator and Discard; `#budget-seg` holds Budget and Import (`aria-label="Budget or Import"`), and `budgetSub()` answers `'budget'` for a remembered `'compare'`. Delete `#budget-switch`, `#budget-pick`, `#bud-rename`, `#bud-new`, `#bud-archive`, `#compare` and the `// ── comparison` region with its CSS (`.vs`, `.verdict`, `.afford`, `table.cmp`), `markChosenBudget`, `chosenBudget`, the `budget-pick` handler, and the `bud-new`, `bud-rename`, `bud-archive` handlers. `#bud-where`'s panel is `panel('Where it is', …)` with placeholders "e.g. Springfield, IL", "unlocks rent data", the two Census fields as today, and Why "e.g. we moved", sending `set_location` with no budget.
- [ ] **Step 4: One budget's facts.** `loadBudgetMeta()` reads `GET /api/budget` into `budgetMeta` (`thisMonth`, `location`, `months`, `started`); every caller of `loadBudgets` calls it; `#where-note` reads `budgetMeta.location`. Every request that sent a budget sends none: `threadParams`, `/api/today`, `/api/thread/ask`, `/api/thread/note`, both `/api/calendar` reads, the savings balance post, the import preview and commit, `/api/match`, and every tool call (`budget: month.budget` and `budget: chosenBudget()` go). `showProblem` matches `/not started yet|no open month|no months are open/`: "The budget is not started yet." with Open Budget, and "The budget has no plan for this month yet. " with Open it from the template (whose `open_month` sends `month` only). Today: `loadThread` no longer writes `#budget-label`; `if (page.notStarted) showProblem(new Error('The budget is not started yet.'))`; the byline of a `budget` briefing is "Claude · the budget's briefing"; a change row adds no budget label; the money rail's empty line is "This month is not open yet."; `LOOKED` loses `compare_budgets`.
- [ ] **Step 5: The list.** `loadBudget` draws, `for (const c of result.categories)`, `categoryBand(c, envelopes in it)`: a `.band` with `data-category`, a `.band-head` holding `h2` with the label, then the `.list` of `envelopeRow`s in order, savings envelopes among them; an empty category shows `node('p', 'quiet', 'No envelopes yet')` in place of the list. In a closed month an envelope view with `removed` is drawn by `envelopeRow` with `node('span', 'erow-removed', 'removed')` after its name, `--ink-soft`, and opens nothing (a `div`, not a button). `savingsCheckLine(result.savings)` is appended after the last band when there is a check; its Settings link calls `openSettings('household', 'savings')`. Delete `savingsBand`, the outside note's markup, CSS and handler, and the `/api/categories` read in `loadBudget`.
- [ ] **Step 6: Elsewhere.** The walkthrough's `drawWalk` loses its budget label: the alone income step's heading is `` `Open ${monthLong(fr.month)}` `` (B72); its steps call `loadBudgetMeta()` where they called `loadBudgets()`; the rest of the walkthrough is Task 12's. `openBudgetAt(envelope, focus)`; its callers in Today's setup notes, "Open the envelope", the Calendar's money rows and the card pass the envelope alone. The card's Money form has the Envelope select alone, filled from `get_month` (`{}`), sending `{ envelope: envSel.value || null }`; `moneyRows` reads "This month isn't open" for a linked envelope with no money.
- [ ] **Step 7: `RETIRING`.** Remove `'/api/tools/compare_budgets'`, `'/api/tools/rename_budget'`, `'/api/tools/archive_budget'`, `'/api/budgets'`. `create_budget` and `set_budget_location` stay until Task 12 (the walkthrough still calls them).
- [ ] **Step 8: Check by hand.** Start both servers, run the seed. As alice, at 375 and 1280, dark and light: the head reads Budget and this month, and its menu has Where it is, Price it from local data and Discard, nothing else; the tabs read Budget and Import; Where it is opens titled "Where it is" and saves; the list reads Utilities, Home… in the seed's order with Children showing "No envelopes yet"; Roof sits under Savings and sinking funds with its saved amount, and the savings check line is under the last category, its Settings link landing on Settings. The screen shows the latest month only, so for B27: make a second household "Old", seed it with one category Fun, one envelope Gym, this month opened, one EXAMPLE GYM receipt in it, `month.close` this month, then `envelope.remove` gym; its Budget screen shows this month closed with Gym under Fun marked removed, and pressing the row does nothing. Back in Home: Today's briefing byline, the money rail, a setup note's link and the Calendar's money row all open the right envelope; a card's Money form lists envelopes only. In the console: `localStorage.setItem('hp.budgetTab', 'compare')`, reload, press Budget: the list. The hit-area snippet `[...document.querySelectorAll('.hit')].filter((el) => el.offsetParent).map((el) => [el.textContent.trim().slice(0, 20), getComputedStyle(el, '::after').height, getComputedStyle(el, '::after').width]).filter(([, h, w]) => parseFloat(h) < 44 || parseFloat(w) < 44)` answers `[]`. The walkthrough is not checked here (Task 12). Acceptance, ticked against the running page: **B1–B20, B26, B27, B72 (by reading the code), B75–B82, B84**. Stop both by pid.
- [ ] **Step 9: Ledger, suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "The Budget screen names one budget and its month, lists envelopes under their categories, and nothing on any screen picks or compares budgets."

### Task 8: Adding a category or an envelope is one short form and one press

**Files:**
- Modify: `site/index.html` (`// ── menus`: `setupMenu`; `// ── adding envelopes and categories`; `loadBudget`'s add rows and `categoryBand`; the `#env-new` markup), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `add_envelope`, `add_category`, `rename_category`, `move_category`, `remove_category` (Task 4), `categoryBand` (Task 7), `get_month`'s `categories[].envelopes`.
- Produces: `function menuOn(btn, list, onOpen)` (the element form `setupMenu` now calls; returns its `close`), `const bandMenus = []` closed by `closeMenus` and emptied by each `loadBudget`; `function addEnvelopeForm(slot, { category })`, `function addCategoryForm(slot)`, `function categoryField(categories, value)` (a select of the given `{ id, label }` list starting on `value`, then "New category…", which swaps in a text field; answers `{ el, value() }` where `value()` is `{ category }`, `{ newCategory }`, or null while the typed name is empty) for Tasks 9 and 12; `function categoryMenu(c, i, n)`.

- [ ] **Step 1: The ledger rows, before the work.** Add, run, expect FAIL naming each:
  - ADDED: `['B21', "addEnvelopeForm(slot, { category: c.id })", 'budget']`, `['B22', 'function categoryMenu(', 'budget']`, `['B22', "'Move up'", 'budget']`, `['B22', "'Move down'", 'budget']`, `['B22', "'Move its envelopes first.'", 'budget']`, `['B22', "approveNow('rename_category'", 'budget']`, `['B22', "approveNow('move_category'", 'budget']`, `['B22', "approveNow('remove_category'", 'budget']`, `['B22', 'function menuOn(', 'page']`, `['B23', 'id="cat-add"', 'budgetMarkup']`, `['B23', 'id="env-new" type="button">Add an envelope', 'budgetMarkup']`, `['B24', 'function addEnvelopeForm(', 'budget']`, `['B24', "'New category…'", 'budget']`, `['B24', "approveNow('add_envelope'", 'budget']`, `['B24', "focus: 'change'", 'budget']`, `['B25', 'function addCategoryForm(', 'budget']`, `['B25', "approveNow('add_category'", 'budget']`, `['B25', "'Add it'", 'budget']`.
  - GONE: `['B24', "panel('Add an envelope'", 'page']`, `['B24', 'Fed by (choose one or more)', 'page']`, `['B24', "label: 'Band'", 'page']`, `['B24', 'Leave it empty to give it a figure later.', 'page']`, `['B24', 'catOptions', 'page']`, `['B24', "tool: 'define_envelope'", 'page']`.
- [ ] **Step 2: The add rows.** Under `#bands`: `<button class="add-row hit" id="env-new" type="button">Add an envelope</button>` then `<button class="add-row hit" id="cat-add" type="button">Add a category</button>`, and a `<div id="add-slot"></div>` the forms open in, the two rows hidden while one is open. An empty category's band ends with `textBtn('Add an envelope', 'link hit', null, …)` opening `addEnvelopeForm(slot, { category: c.id })` in a slot under its heading.
- [ ] **Step 3: The forms.** Built from `.ep-form`, `epField`, `epErr`, `.ep-acts` with Cancel first (marked by `cancelMark`) and the primary `'Add it'` at the right. Add an envelope: Name (placeholder "e.g. Vehicles", 40 characters), Category (`categoryField(month.categories, given ?? first)`; "New category…" last, which swaps the select for a text field labelled "New category" with a "Choose from the list" link back, both `hit`). Add it calls `approveNow('add_envelope', { label, ...field.value() })`; a refusal goes in the form's slot with what was typed kept and focus on the slot; on success `loadBudget()`, then `openEnvelopePage(r.touches.envelope, { focus: 'change' })`: the new envelope's page opens on its Each month line "$0 a month" with focus on Change (`data-key="change"`, which `renderEnvelopePage` already honours), the figure's Change ready. Add a category: Name (placeholder "e.g. Pets"); Add it calls `approveNow('add_category', { label })`, then `loadBudget()` and focus on the new band's heading. Escape closes either and puts focus back on the row that opened it. Delete the old `#env-new` handler, `catOptions`, and the `outside-add` handler if any is left.
- [ ] **Step 4: The heading's menu.** Split `setupMenu` into `menuOn(btn, list, onOpen)` and the id form; `categoryBand` adds to `.band-head` a `.menu` with `button.btn.bare.hit` (an ellipsis icon, `aria-label` "<Category>: rename, move or remove", `aria-haspopup="menu"`) and a `.menu-list` with `menuitem`s: Rename (the heading becomes a one-field form, Cancel and Save, `approveNow('rename_category', …)`), Move up (not on the first), Move down (not on the last), and Remove when `c.envelopes === 0`, else a `p.menu-note` "Move its envelopes first." Each write reloads and focuses the band's heading; a refusal is said in `showProblem` after the reload, since the menu has no slot. Its closer goes in `bandMenus`.
- [ ] **Step 5: `RETIRING`.** Remove `'/api/tools/define_envelope'`.
- [ ] **Step 6: Check by hand.** Seeded, as alice at 375 and 1280, dark and light: Add an envelope with Name "Pets" and New category "Animals": one band Animals appears with Pets, Pets' page opens with the figure form ready; Add an envelope "groceries" under Food: "There is already an envelope called Groceries." in the form's slot, the name kept; New category typed "food": the category sentence; Add a category "Garden": an empty heading reading "No envelopes yet" with its own Add an envelope, which opens with Garden chosen; Garden's menu: Rename to "Yard", Move up (the band moves), on the first band no Move up and on the last no Move down, Remove (gone); Food's menu says "Move its envelopes first."; with two windows, remove Garden in one and add an envelope into it from the other: the refusal in the slot, the list read again. Keyboard: the menu opens with ArrowDown, Escape closes it with focus back. The hit-area snippet answers `[]`. Acceptance: **B21–B25**. Stop both by pid.
- [ ] **Step 7: Ledger, suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "Adding a category or an envelope is one short form and one press, and a category's heading renames, moves and removes it."

### Task 9: An envelope's page says its category, and renames or moves the envelope

**Files:**
- Modify: `site/index.html` (`// ── an envelope's page`: `renderEnvelopePage`, `goalForm`, `openRemovePage`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `change_envelope` (Task 4), `categoryField` (Task 8), `remove_envelope`'s effects (Task 2), `set_sinking_goal`'s `estimate`.
- Produces: nothing later tasks use.

- [ ] **Step 1: The ledger rows, before the work.** Add, run, expect FAIL naming the Added and Gone ones:
  - KEPT: `['B29', 'function envCard(', 'budget']`, `['B29', 'How much each month?', 'budget']`, `['B29', 'function coverBlock(', 'budget']`, `['B30', "envSection('Each month')", 'budget']`, `['B31', 'function openFundingPage(', 'budget']`, `['B31', "epField('Take it from', from)", 'budget']`, `['B32', "envSection('Bills', 'bills')", 'budget']`, `['B33', 'Nothing has been spent from this envelope yet.', 'budget']`, `['B33', 'do not trust this envelope', 'budget']`, `['B34', 'Make this a savings goal', 'budget']`, `['B34', 'Remove this envelope', 'budget']`, `['B39', "host.querySelector('.ep-slot [data-cancel]')", 'budget']`.
  - ADDED: `['B28', 'month.categories.find((c) => c.id === e.category)', 'budget']`, `['B35', "textBtn('Rename', 'link hit', 'rename'", 'budget']`, `['B36', "textBtn('Change its category', 'link hit', 'move'", 'budget']`, `['B36', "approveNow('change_envelope'", 'budget']`, `['B37', "'It costs'", 'budget']`, `['B37', 'Leave the cost empty for none.', 'budget']`, `['B38', 'proposal.effects[0]', 'budget']`.
  - GONE: `['B28', "e.sinking ? 'Saved in Savings' : e.group", 'page']`, `['B37', 'Kept on the categories, so every budget sets aside the same.', 'page']`, `['B37', 'e.categories', 'page']`, `['B38', 'Its receipts stay, but stop belonging to any envelope.', 'page']`.
- [ ] **Step 2: The head and the foot.** The line is the envelope's category label and the month (B28's pin). The foot, while the month is open: "Make this a savings goal" / "Change its goal", then "Rename", then "Change its category", then "Remove this envelope", each `link hit`. Rename and Change its category open a small `.ep-form` in a slot under the foot (Name with the current label; or `categoryField(month.categories, e.category)`), Cancel (`data-cancel`) and Save; Save calls `approveNow('change_envelope', { envelope: e.id, label })` or `approveNow('change_envelope', { envelope: e.id, ...field.value() })`, a refusal in the form's slot; on success `page.focusNext = 'rename'` / `'move'` and `loadBudget()`. Opening either closes an open Bills form and the other.
- [ ] **Step 3: The goal form.** One estimate line: "It costs" (dollars) and "Every how many years", filled from `e.sinking.estimate`; the hint "Leave the cost empty for none."; sends `estimate: null` or `{ costCents, everyYears }`; its `await categoryList()` goes. The proposal stays (Ruling 9).
- [ ] **Step 4: Remove.** The page's line is left empty until the proposal answers; the Why form posts `remove_envelope` as today; the review's first effect (the count sentence) is also shown as the head's line once it lands (B38's pin), and This will lists the rest.
- [ ] **Step 5: Check by hand.** Seeded, at 375 and 1280, dark and light: Groceries' line reads "Food · <Month>"; Rename it to "Market" (the row and heading say Market, the receipts still listed); Change its category to Fun (it moves bands, the page's line says Fun); "groceries" typed into Rename on another envelope: the name sentence in the slot; Escape closes the open form, then goes Back; Roof's goal form shows one line "It costs" $1,200 "Every how many years" 4; Remove Dining: the line reads the server's sentence, This will names its bills and rules. Acceptance: **B28–B39**. Stop both by pid.
- [ ] **Step 6: Ledger, suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "An envelope's page says its category, and renames the envelope or moves it to another category at once."

### Task 10: Sorting a receipt is choosing its envelope, everywhere, and it is written at once

**Files:**
- Modify: `site/index.html` (`// ── the unsorted queue`: `loadUnsorted`; `// ── receipts: what actually went in`: `showReceipts`, `editReceipt`; `// ── import`: `envelopeSelect`, `splitEditor`, `renderPreview`, `updateCommit`, the commit handler, `offerRules`; `// ── a removed receipt, and putting it back`: `askToRestore`; Today's `waitingLine` and `renderWaiting`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `sort_receipts` approved in one, `add_rule` (Task 4); `list_transactions { toSortOnly }` with `missing`; `/api/match`'s options; the import routes; `restore_transaction { envelope }`.
- Produces: `function ruleOffer(box, { match, envelope, label, txnId })`, the rule offer the queue and Import share.

- [ ] **Step 1: The ledger rows, before the work.** Add a region-local slice in the 0.10.0 block, `const queue = between(script, '// ── the unsorted queue', '// ── reading the screen again')`, and assert `uncommented(queue).includes('Show what this would do') === false` (B45) in its own test. Add, run, expect FAIL naming the Added and Gone ones:
  - KEPT: `['B40', 'Give each one an envelope.', 'budget']`, `['B43', 'a rule says: divide this', 'budget']`, `['B44', 'Nothing confident enough to suggest', 'budget']`, `['B48', 'function splitEditor(', 'budget']`, `['B48', '+ another line', 'budget']`, `['B48', 'an envelope is on two lines', 'budget']`, `['B48', 'a split needs two envelopes', 'budget']`, `['B50', 'Drop a bank export here, or choose one', 'page']`, `['B51', '<div class="k">Sorted by rule</div>', 'page']`, `['B52', 'Sort these by hand, or try again later.', 'budget']`, `['B53', 'Accept all suggestions', 'budget']`, `['B55', 'What does Savings show today?', 'budget']`, `['B56', 'Every receipt has an envelope.', 'budget']`, `['B57', 'still need an envelope.', 'budget']`, `['B59', 'Put it back', 'budget']`, `['B83', 'In no envelope yet', 'today']`, `['B47', "'Split across envelopes…'", 'matchSrc']`.
  - ADDED: `['B83', "w.kind === 'tosort'", 'today']`, `['B40', 'toSortOnly: true', 'budget']`, `['B41', "approveNow('sort_receipts'", 'budget']`, `['B42', 'function ruleOffer(', 'budget']`, `['B42', "'Show the rule'", 'budget']`, `['B42', "'/api/tools/add_rule'", 'budget']`, `['B46', 't.missing', 'budget']`, `['B48', 'envelope: l.sel.value', 'budget']`, `['B49', "approveNow('sort_receipts', { assignments: [entry] })", 'budget']`, `['B54', 'r.envelope', 'budget']`, `['B60', 'envelopeSelect(options, r.envelope ?? null, { allowSplit: false })', 'budget']`.
  - GONE: `['B83', "w.kind === 'unsorted'", 'page']`, `['B41', 'uncategorizedOnly', 'page']`, `['B42', "' remember '", 'page']`, `['B42', 'remember: always ask to divide', 'page']`, `['B42', 'Payee text the rule matches', 'page']`, `['B47', 'Not in this budget', 'matchSrc']`, `['B47', 'records the category that feeds it', 'page']`, `['B49', "'/api/tools/categorize_transactions'", 'page']`, `['B54', 'r.options ?? preview.options', 'page']`, `['B54', 'r.category', 'budget']`, `['B60', 'for (const c of await categoryList())', 'page']`, ``['B60', "...(sel.value ? { category: sel.value } : {})", 'page']``.
- [ ] **Step 2: The picker and the split editor.** `envelopeSelect`'s doc comment says it lists envelopes under their categories, then Not spending, then the split; its code is unchanged. `splitEditor` works in `{ envelope, amountCents }` (`parts()` and its `initialParts`); the footer's words are kept.
- [ ] **Step 3: To sort.** `loadUnsorted` reads `list_transactions { toSortOnly: true, limit: 50 }` and `/api/match { txnIds: [] }`. A row's pick (not `__split`) calls `approveNow('sort_receipts', { assignments: [{ txnId, envelope, ...(suggested and kept ? { suggestedBy: 'claude' } : {}) }] })`, the select disabled while it goes; on success `ruleOffer(cell, { match: ruleFor(row), envelope, label, txnId })` when `ruleProblem` would allow one (the server says; a refused offer shows nothing), then `loadBudget()` after the offer is answered or dismissed; a refusal goes in a `p.err` under the row with the pick put back. A split row sorts when its editor balances, through a "Save the split" `btn hit` in the row (the editor's own `onChange` never writes). A receipt with `missing` opens with `splitEditor(options, amount, t.parts.map((p) => t.missing.includes(p.envelope) ? { ...p, envelope: '' } : p))`. Accept on a suggestion is a pick. Delete the remember tick, its text field and "Show what this would do".
- [ ] **Step 4: `ruleOffer`.** In `box`: `p.quiet` "Remember <match> for <label>?", "Show the rule" (`btn hit`), which posts `/api/tools/add_rule { match, envelope, txnId }` and draws its effects with "Remember it" (`btn primary hit`, commits the proposal) and "Not now"; "Remembered." after. Import's `offerRules` uses it for each match.
- [ ] **Step 5: A receipt's Edit.** Save calls `approveNow('sort_receipts', { assignments: [entry] })` (B49's pin, `entry` naming `envelope` and split parts by envelope) and on success reads the list again (`void showReceipts(rcpts, e)` through `loadBudget()`); no proposal.
- [ ] **Step 6: Import.** One `preview.options` for every row; rows read and write `r.envelope`; the commit sends `envelope` and `split: [{ envelope, amountCents }]`; the result line reads `out.toSort` where it read `out.unsorted`. Today's `waitingLine` and `renderWaiting` read the `'tosort'` kind (Task 4) where they read `'unsorted'`; the words stay.
- [ ] **Step 7: Restore a removed receipt.** "Put it in" is `envelopeSelect(options, r.envelope ?? null, { allowSplit: false })` with its first option relabelled "— no envelope yet —", the options from `/api/match { txnIds: [] }`; it sends `envelope`.
- [ ] **Step 8: `RETIRING`.** Remove `'/api/tools/categorize_transactions'`.
- [ ] **Step 9: Check by hand.** Seeded, at 375 and 1280, dark and light: To sort lists four receipts; the CORNER BISTRO split shows Dining $50 and a blank line for $30; pick Fun's new envelope for it and save the split: it leaves; pick Groceries for UNKNOWN SHOP: it leaves at once, and "Remember UNKNOWN SHOP for Groceries?" offers; Show the rule, Remember it; Today's waiting item counts what is left and opens To sort; on Groceries' page, Edit a receipt to Dining: saved at once, it moves; Import a small CSV with an `EXAMPLE MARKET` row and an unknown one: one list per row, the rule sorts the first, the result line counts the rest; remove a receipt on Today and Put it back into Dining. The picker never says "category"; the hit-area snippet answers `[]`. Acceptance: **B40–B60, B83**. Stop both by pid.
- [ ] **Step 10: Ledger, suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "Sorting a receipt is choosing its envelope in To sort, Import, a receipt's Edit and Restore, and a choice is kept at once."

### Task 11: The Categories sheet goes, Settings keeps the savings account, and Backup names its bands anew

**Files:**
- Modify: `site/index.html` (the `#cat-sec` markup and CSS, `renderCategories`, `openCategories`, `cat-close`, the four category panels, `categoryList` and `categoriesCache`, every `#cat-sec` guard; `budgetItem` / `budgetForm`; `settingsGroups`' Household items; `BANDS` and the restore pick's default set), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: Task 5's scope `'budget'`.
- Produces: `savingsItem()` and `savingsForm()` (row key `savings`), the target of Task 7's `openSettings('household', 'savings')`.

- [ ] **Step 1: The ledger rows, before the work.** Add, run, expect FAIL naming the Added and Gone ones:
  - KEPT: `['B65', "submit: 'Record it'", 'page']`, `['B65', 'Envelopes saved in Savings are checked against this account.', 'page']`, `['B68', 'Opened plans and every move made in them.', 'page']`.
  - ADDED: `['B62', "if (!$('phone-sec').hidden) return;", 'page']`, `['B63', "key: 'savings', title: 'Savings account'", 'page']`, `['B63', 'The account the envelopes saved in Savings live in.', 'page']`, `['B66', "name: 'Receipts and rules'", 'page']`, `['B66', "Needs the budget's envelopes.", 'page']`, `['B67', "{ key: 'budget', name: 'Budget'", 'page']`, `['B67', "new Set(['facts', 'budget', 'months', 'thread'])", 'page']`.
  - GONE: `['B61', 'cat-sec', 'page']`, `['B61', 'function renderCategories(', 'page']`, `['B61', 'function openCategories(', 'page']`, `['B61', 'Shared by every budget', 'page']`, `['B61', "'Add the starter set'", 'page']`, `['B61', "'Stop using a category'", 'page']`, `['B61', "['House', 'People', 'Future']", 'page']`, `['B61', 'function categoryList(', 'page']`, `['B61', 'categoriesCache', 'page']`, `['B61', '.cat-kind', 'css']`, `['B64', 'Edit the categories', 'page']`, `['B64', 'categoriesInUse', 'page']`, `['B66', 'Receipts, categories and rules', 'page']`, `['B67', 'Budgets and envelopes', 'page']`, `['B67', 'how categories are grouped', 'page']`.
  - Move the existing pins: KEPT `S20` 'async function categoryList(' comes out (B61's GONE holds it); KEPT_092's Household items line becomes `items: [setupItem(), zoneItem(), modelItem(), membersItem(), savingsItem(), hcalItem(), guestsItem(), documentsItem(),`.
- [ ] **Step 2: Delete the sheet** and everything the GONE rows name, its CSS included (`.cat-kind`, and `#cat-sec .row` out of the rule it shares with `#income-sec .row`); each Escape and click guard that read `!$('cat-sec').hidden || !$('phone-sec').hidden` reads `!$('phone-sec').hidden`; the household switch stops hiding it.
- [ ] **Step 3: Settings.** `savingsItem()`: key `savings`, title "Savings account", status `Savings $X` / `Savings account N` / `No savings account`, line "The account the envelopes saved in Savings live in."; `savingsForm()` is `budgetForm` without the categories line. A `STEP_ROW` or link that named `budget` names `savings`.
- [ ] **Step 4: Backup's bands.** `facts`: "Receipts and rules" / "What was actually spent, and which envelope each is in. Needs the budget's envelopes."; `budget`: "Budget" / "The categories, the envelopes and what they are funded at, the income and where it is."; Months keeps its words; the default chosen set uses `'budget'`.
- [ ] **Step 5: `RETIRING`.** Remove `'/api/tools/define_category'`, `'/api/tools/archive_category'`, `'/api/tools/add_starter_set'`, `'/api/categories'`.
- [ ] **Step 6: Check by hand.** At 375 and 1280, dark and light: no menu or link opens a Categories sheet; Settings, Household, Savings account reads its status, chooses an account and records a balance; Escape on an envelope's page with the phone sheet open still does nothing under it; Backup: download Home's backup, make a second household, restore Budget and Receipts and rules into it (clean, the envelopes and To sort as in Home), then restore Budget again into Home: "This household already has a budget. Restore it as a new household instead." Acceptance: **B61–B68**. Stop both by pid.
- [ ] **Step 7: Ledger, suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "The Categories sheet is gone, Settings keeps the savings account on its own, and Backup names its bands Receipts and rules, and Budget."

### Task 12: First run starts from where the household is, then income, then envelopes under the starter categories

**Files:**
- Modify: `site/index.html` (`// ── the budget walkthrough`: `drawWalk`, `walkBudgetStep` (renamed `walkWhereStep`), `walkIncomeStep`, `walkEnvelopesStep`), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: `firstRun`'s `step`, `started` and `categories`; `set_location`; `make_starter_envelopes { envelopes: [{ label, id?, category?, newCategory? }] }`; `categoryField` (Task 8), given the starter categories in place of the month's.
- Produces: `let walkWhereSkipped = false`, held on the page as `pricingFor` is.

- [ ] **Step 1: The ledger rows, before the work.** Add, run, expect FAIL naming the Added and Gone ones; then add the completeness test:
  - KEPT: `['B69', "Start the household's budget", 'budgetMarkup']`, `['B69', "['envelopes', 'Envelopes']", 'budget']`, `['B71', 'the same every month', 'budget']`, `['B71', 'seen in imports', 'budget']`, `['B74', "'Set the location'", 'budget']`, `['B74', "'Finish'", 'budget']`.
  - ADDED: `['B70', 'function walkWhereStep(', 'budget']`, `['B70', "'Where it is'", 'budget']`, `['B70', 'Give a town or a ZIP, or Skip.', 'budget']`, `['B70', "approveNow('set_location'", 'budget']`, `['B70', 'walkWhereSkipped = true', 'budget']`, `['B73', 'for (const [gi, g] of fr.categories.entries())', 'budget']`, `['B73', 'categoryField(fr.categories', 'budget']`.
  - GONE: `['B70', 'Name the budget', 'page']`, `['B70', 'Make the budget', 'page']`, `['B70', "'create_budget'", 'page']`, `['B70', 'fr.budget', 'page']`, `['B73', "'Group'", 'page']`, `['B73', 'fr.groups', 'page']`.
  - The completeness test, in the 0.10.0 block:
```ts
test('every row of the ledger is pinned', () => {
  const rows = new Set([...KEPT_010, ...ADDED_010, ...GONE_010].map(([r]) => r));
  assert.deepEqual(Array.from({ length: 84 }, (_, i) => `B${i + 1}`).filter((r) => !rows.has(r)), []);
});
```
- [ ] **Step 2: Where it is.** `drawWalk` shows `walkWhereStep()` when `fr.step === 'where' && !walkWhereSkipped`, else treats it as income (the rail's Income current, as the budget step was). The form: `h2` "Where it is", "Where is it" (placeholder "e.g. Springfield, IL") and ZIP (placeholder "unlocks rent data", numeric, `postal-code`); Skip (`btn hit`, sets `walkWhereSkipped = true` and draws Income) then Save (`btn primary hit`); Save with both empty says "Give a town or a ZIP, or Skip."; else `approveNow('set_location', { label: town || zip, ...(zip ? { postal: zip } : {}), why: 'set when the budget was started' })`, then `loadBudgetMeta()` and `loadBudget()`. Every `fr.budget` goes (the steps send no budget; `walkDraft` and `walkFr` are compared by nothing but their presence).
- [ ] **Step 3: Envelopes.** A card per `fr.categories` entry, its rows as today (`priced`, "No figure yet"), each sending `{ label, id: e.id, category: g.id }`; a row of one's own gets `categoryField(fr.categories, fr.categories.at(-1)?.id)` in place of the Group select, sending `{ label, ...field.value() }`; the lead, the hint and the foot keep their words.
- [ ] **Step 4: `RETIRING`.** Remove `'/api/tools/create_budget'` and `'/api/tools/set_budget_location'`. The list is now empty; leave it for Task 13.
- [ ] **Step 5: Check by hand.** A fresh `<scratchpad>/run` (no seed): sign in, make Home. Today says "The budget is not started yet." with Open Budget; Budget shows Where it is; Save with nothing: the sentence; Skip: Income; reload: Where it is again (Ruling 5); type Springfield, IL and 62701, Save: Income; Save $5,000: Envelopes, a card per starter category; untick Travel, rename Fun to "Outings", add one of your own "Pets" under a new category "Animals"; Make these N envelopes: Pricing looks up the place; Finish: the list under Home, Food, Insurance, Utilities, Savings and sinking funds, Everyday, Animals; Today no longer says "not started". At 375 and 1280, dark and light; the hit-area snippet answers `[]`. Then B72 on screen: with the envelopes made and no income source (the $5,000 was saved without "the same every month"), Discard this month's plan from the menu: the walkthrough's lone step reads "Open <Month>". Acceptance: **B69–B71, B73, B74**, and B72. Stop both by pid.
- [ ] **Step 6: Ledger, suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "First run asks where the household is, then its income, then envelopes under the starter categories, and a row of one's own picks a category."

### Task 13: The sweep, the notes and version 0.10.0

**Files:**
- Modify: `site/index.html` (dead CSS and names, comments, `BUILD`, the stylesheet link), `api/src/*.ts` (comments only), `README.md`, `DEPLOY.md`, `docs/superpowers/design/2026-10-28-design-language.md`, `api/package.json`, `api/package-lock.json`, `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: everything above. Produces: release 0.10.0.

- [ ] **Step 1: The ledger's allowance goes.** Delete `RETIRING` and its two assertions; the route test asserts `unanswered` is `[]` as it did before Task 1. Run: expected PASS.
- [ ] **Step 2: One noun per concept, page-wide.** Run `grep -nE "[Bb]ands?\b|[Gg]roups?\b|\b[Kk]ind\b|[Cc]ategori[sz]|[Uu]ncategor|[Bb]udgets\b|Compare|other budget|every budget" <worktree>/site/index.html` and read every hit in the Budget, To sort, Import, Settings and walkthrough regions: words a member reads are fixed; class names, ids, the `role="group"` attribute, the `.band` class, Plan's areas and Today's kinds are not words on screen and stay. The same grep over `api/src/*.ts` comments: reword any that describes several budgets or receipt categories (the survey's file:line map lists them: `types.ts:1-16`, `envelopes.ts:1-8`, `starter.ts:1-13`, `server.ts`'s route list and the `/api/categories` comment).
- [ ] **Step 3: Dead CSS.** Delete any rule for a class or id nothing draws any more (the "budget switcher" block and its `.archived-note`, `.savings-check` rules left from the old band if `savingsCheckLine` uses others, `.band h2` if the heading's rule moved to `.band-head`). Run `python3 docs/superpowers/design/tools/contrast.py site/tokens.css`: exit 0.
- [ ] **Step 4: README, DEPLOY and the design language.** README: line ~16 "the categories" → "the envelopes"; the figures bullet (~48) says "an envelope can also take its figure from the average of its receipts"; replace the "Several budgets, compared" bullet with "**One budget, sorted into envelopes.** Each receipt is sorted into one envelope, by a person helped by rules and Claude's suggestions; envelopes sit under categories, the headings of the Budget page. Two homes are two households." DEPLOY: ~164 and ~202 "a category list" / "categories" → "an envelope list" / "envelopes"; ~801 "categorisations" → "how receipts are sorted"; ~1071 and ~1079 drop Compare ("Today, Budget and Import"); after the upgrade steps add "### Upgrading to 0.10.0": "0.10.0 keeps one budget per household and sorts receipts into envelopes. It cannot open a household's log written before it, nor restore a backup made before it: the backup is refused in words. Every household so far holds test data, so remove each one from Settings and make it again; back up first if you want the old file." The design language's shell paragraph (~261): Budget's sub-tabs are Budget and Import.
- [ ] **Step 5: The version.** Run `cd api && npm version 0.10.0 --no-git-tag-version`. Expected: `v0.10.0` in `package.json` and `package-lock.json`. On the page: `const BUILD = '0.10.0';` and `/tokens.css?v=0.10.0`. The ledger's build test passes.
- [ ] **Step 6: The release, by hand.** A fresh `<scratchpad>/run`, both servers. First run as in Task 12, then the seed's receipts imported as a CSV; then walk every ledger row B1 to B84 at 375 and 1280, dark and light, with alice, bob and casey members, using the ledger's table: each Kept row still there, each Changed row as its fate says, each Removed row nowhere, each Added row working. Then: copy a household log written before 0.10.0 (any from an earlier run in `<scratchpad>`, or one line `{"id":"x1","at":"2026-10-01T00:00:00Z","who":"alice","op":"budget.create","budget":"home","label":"Home"}` after a `household.claim`) into a new folder under `households/` and choose it: write down what the page and the server's log say, check the other households still open, and make DEPLOY's upgrade section say what was seen; restore a backup made before 0.10.0 into a fresh household: refused in Task 5's sentence. The hit-area snippet answers `[]` on the list, an envelope's page, To sort and the walkthrough. Stop both by pid.
- [ ] **Step 7: Suite, typecheck, commit** `site/index.html README.md DEPLOY.md docs/superpowers/design/2026-10-28-design-language.md api/package.json api/package-lock.json api/test/page-ledger.test.ts` and the `api/src` files whose comments changed: "Version 0.10.0: one budget per household, receipts sorted into envelopes, and categories as the headings envelopes sit under."
