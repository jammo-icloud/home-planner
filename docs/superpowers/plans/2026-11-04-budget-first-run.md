# The Budget's First Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Budget screen that is never empty (a three-step walkthrough when the budget has no envelopes, starter envelopes in six groups, every unpriced envelope marked Action required with a hint), a left-to-assign card that states the zero-based rule in words, an overspent envelope that offers its own cover, the More menu folded into the person menu, and "Set up your iPhone" split into a Home Screen QR and a calendar account.

**Architecture:** The envelope gains two event-sourced fields on `envelope.define`, `needsFigure` and `source`, cleared only by a later define without them, so restore's bands stay self-contained. Three new tools (`make_starter_envelopes`, `set_month_income`, `set_envelope_figure`) and changes to `define_envelope`, `set_assignment`, `move_money` and `seed_from_location` do the writes; one new pure module, `figures.ts`, works out hints, the card's words, the cover card and the income suggestion, and `get_month` carries them to the page. `first-run.ts` says which walkthrough step a budget is at. `server.ts` gains `?approve=1` on the tools route for a fixed set of tools, `GET /api/budget/first-run`, the budget notices on `/api/today`, and `GET /api/phone-setup/home`. The page work is all in `site/index.html` (and the tints in `site/tokens.css`), done after the server and checkable against the fake DSM.

**Tech Stack:** Node 22 with `--experimental-strip-types`, `node:test`; `qrcode` (already a dependency) for the SVG; single-file vanilla JS page, no build step.

**Spec:** `docs/superpowers/specs/2026-11-04-budget-first-run-design.md`, including its Rulings and its Appendix of copy and colours. It is the authority; read it whole before your task. Where this plan decides something the spec left open, the task says so.

## Global Constraints

- The public tree stays clean: nothing in the tree names the owner's domain, Team Folder, private network addresses, first names, banks or vendors; Placitas and America/Denver are fine; examples use Alex and the Rivera household. Test fixtures use the account `alex` (and `bob` where a second member is needed), the household label `Rivera household`, the budget `Placitas` (id `placitas`, location `Placitas, NM`), and hosts `planner.example.com` and `nas.example.com`. Payees in fixtures are generic (`VALLEY MARKET`, `CORNER BISTRO`, `EXAMPLE POWER`).
- No new dependencies, runtime or dev.
- Version 0.3.0 in `api/package.json` (Task 15); Settings shows it through `api/src/version.ts`, unchanged.
- Never commit, stage or edit `api/data/`, `site/*.jsonl`, `site/planner.html` or any `.env`.
- Tests and typecheck from `api/`: `npm test` and `npm run typecheck`, both green before every commit. 1674 tests pass at `29edffb`; the count only grows.
- Commit as the owner, with exactly this trailer whatever model you are: `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit -m "<plain sentence>" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`. A plain-sentence subject, no conventional-commit prefix. Never push, never branch.
- If a bare `git` fails with `xcodebuild` or `Abort trap: 6`, use `/opt/homebrew/bin/git`. Do not install anything from Xcode.
- Everything is written through a tool's proposal and an approve (the existing `/api/commit`, or the new `?approve=1` for the named tools only). No route appends events itself.
- Exact copy the spec pins (the Decisions and the Appendix) is copied verbatim, punctuation included. Copy this plan adds where the spec is silent is marked "(plan's words)".
- The page is checked by hand against the fake DSM, never on port 5555 (the fake DSM's): `cd api && npm run fake-dsm` in one shell, `cd api && PORT=5577 node --env-file=../.env --experimental-strip-types src/server.ts` in another, then `http://localhost:5577`. If `../.env` is missing, stop and ask; do not write one.
- Node type stripping: no parameter properties, no enums. Comments in the repository's voice: plain sentences saying why.

## Review Focus

1. **A double tap on "Move $42"** (two requests in flight, or a retry after a slow answer): the second must not move the money again. `move_money` takes `onlyWhileShort: true` from the cover card and refuses 409 once the envelope is no longer short. Pinned in Task 7 (`a cover move is refused once the envelope is no longer short`).
2. **`?approve=1` on a tool outside the named set, or on a named tool whose run refuses**: nothing is written and the tool's own words come back. Pinned in Task 8 (`a tool outside the set is refused with approve and writes nothing`, `a named tool that refuses writes nothing`).
3. **Receipts imported into envelopes that still have no figure** (every starter envelope is at zero, so the first import makes most of them overspent): Today must show the one "N envelopes still need a figure" notice, not a "short" notice per unpriced envelope. Pinned in Task 7 (`an envelope with no figure yet is not also called short`).
4. **A row of one's own named like a category already here, or two rows on one category** ("Groceries" ticked and "Groceries" added again; "Pets" when the household has a "Pets" category under another id): the category is reused by name, and two envelopes on one category are refused with words before anything is written. Pinned in Task 3 (`a row of your own reuses a category by name`, `two rows on one category, or one already fed, are refused with words`).
5. **The planner opened over plain http on the LAN** (`http://planner.example.com:8088`): section 1's Home Screen QR still works for that address, while the calendar code keeps refusing it as today. Pinned in Task 9 (`homeOrigin takes http on any host`, `the Home Screen QR is the page's address with the marker, and spends no code`).

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `api/src/types.ts` | `needsFigure` and `source` on `Envelope` and `envelope.define` | 1 |
| `api/src/replay.ts` | Their validation and fold | 1 |
| `api/src/tools.ts` | `redefine`; the three new tools; changes to `define_envelope`, `set_assignment`, `move_money`, `seed_from_location`, `get_month`; `APPROVE_IN_ONE` | 1, 3, 4, 5, 6, 7, 8 |
| `api/src/starter.ts` | `healthins`, `STARTER_GROUPS`, `PRICED`, `groupOrder`, `groupKind` | 2 |
| `api/src/local.ts` | `label` on each estimate | 5 |
| `api/src/figures.ts` (new) | Hints, income suggestion, the card, the cover | 6, 7 |
| `api/src/setup.ts` | `budgetNotices` | 7 |
| `api/src/first-run.ts` (new) | Which walkthrough step a budget is at | 8 |
| `api/src/server.ts` | `?approve=1`, `/api/budget/first-run`, `budget` on `/api/today`, the phone routes | 7, 8, 9 |
| `api/src/profile.ts`, `api/src/phone-setup.ts` | Calendar-only profile; flags gone; `homeOrigin`, `homeLink` | 9 |
| `site/tokens.css`, `site/index.html`, `site/manifest.webmanifest` | The page | 10 to 14 |
| `DEPLOY.md`, `README.md`, `api/package.json` | Words, version | 15 |

---

## Phase 1: The server

### Task 1: `needsFigure` and `source` on an envelope

**Files:**
- Modify: `api/src/types.ts:139-156` (`Envelope`), `api/src/types.ts:312-325` (`envelope.define`)
- Modify: `api/src/replay.ts:308` (validate), `api/src/replay.ts:1052-1068` (fold)
- Modify: `api/src/tools.ts` (`redefine`; used at `createBudget` copyFrom `:1270`, `setSinkingGoal` `:1493`)
- Test: `api/test/budgets.test.ts`, `api/test/households.test.ts`

**Interfaces:**
- Produces, in `types.ts`: `Envelope` gains `readonly needsFigure?: true; readonly source?: string;`. The `envelope.define` op gains `needsFigure?: true; source?: string;`, documented: absent on a later define clears each; only a figure (Task 4) or pricing (Task 5) writes a define without them on purpose, every other rewrite carries them.
- Produces, in `tools.ts`:
  ```ts
  /**
   * An envelope.define that rewrites `env` with `change`, carrying every field it does not
   * name (needsFigure, source and sinking among them). `figure` means a number was given:
   * the template becomes it, the flag goes, and the source becomes `figure.source` (none when absent).
   */
  export function redefine(budget: BudgetId, env: Envelope, change?: {
    label?: string; group?: string; match?: Match; rollover?: boolean; sinking?: SinkingGoal | null;
    figure?: { template: Cents; source?: string };
  }): NewEvent;
  ```

- [ ] **Step 1: Write the failing tests.** In `budgets.test.ts`, a new `describe('an envelope with no figure yet')`:
  - `the flag and the source are kept from the define that carries them`: append an `envelope.define` for `harbor/pets` with `needsFigure: true, source: 'Zillow Observed Rent Index, ZIP 12345, 2026-06'` (define the `pets` category first); `env.needsFigure === true`, `env.source` equals it.
  - `a later define without them clears both`: append the same define without the two fields; `assert.ok(!('needsFigure' in env))`, `assert.ok(!('source' in env))`.
  - `a flag that is not true, or a source that is empty or too long, is refused`: `needsFigure: false` rejects with `ReplayError` matching `/needsFigure/`; `source: ''` and `source: 'x'.repeat(201)` reject matching `/source/`.
  - `copying a budget and saving it in Savings carry the flag and the source`: with `pets` flagged and sourced, `create_budget` with `copyFrom: 'harbor'` committed gives the copy's `pets` both; `set_sinking_goal` on it (goal `every`) committed keeps both.
  In `households.test.ts`, beside the restore tests: `the flag and the source come back with the budget`: a backup whose log has a flagged, sourced envelope, restored into a fresh household with `['facts', 'budgets']`, has both on the envelope.

- [ ] **Step 2: Run them to see them fail.** `cd api && node --test --experimental-strip-types test/budgets.test.ts test/households.test.ts` — FAIL on the new tests.

- [ ] **Step 3: Implement.** Validation in `validate` beside the empty-match check: `needsFigure` present and not `true` is refused ("an envelope's needsFigure is true or absent"); `source` present and not a string of 1 to 200 characters is refused ("an envelope's source is a line of up to 200 characters"). The fold sets each from the event only (no `prev` fallback), leaving the key absent rather than `undefined`. `redefine` builds the define from `env` plus `change`, with `order: env.order` and `template: change.figure?.template ?? env.template`; replace the two hand-built defines in `createBudget` and `setSinkingGoal` with it. Restore needs no code: these fields ride on an event already in the `budgets` scope, and no event in another scope clears them (that is why Task 4 clears the flag with a define rather than in the `assign` fold).

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `"An envelope can carry a flag saying it has no figure yet and the source of the figure it has, both on its define"`

---

### Task 2: The starter groups

**Files:**
- Modify: `api/src/starter.ts`
- Test: `api/test/starter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StarterGroup { readonly name: string; readonly envelopes: readonly { readonly id: CategoryId; readonly label: string }[] }
  export const STARTER_GROUPS: readonly StarterGroup[];       // the spec's table, in its order; an envelope's id is its category's id
  export const PRICED: ReadonlySet<CategoryId>;               // rent, tax, elec
  export function groupOrder(names: Iterable<string>): string[];   // distinct; the six in order first, then the rest alphabetically
  export function groupKind(group: string): 'House' | 'People' | 'Future';   // for a category made for a row of one's own
  ```
- `STARTER_CATEGORIES` gains `{ id: 'healthins', label: 'Health insurance', kind: 'People' }`, after `carins`.

- [ ] **Step 1: Write the failing tests.**
  - `six groups in the spec's order, each envelope a starter category`: `STARTER_GROUPS.map((g) => g.name)` deepEquals `['Home', 'Food', 'Insurance', 'Utilities', 'Savings and sinking funds', 'Everyday']`; the ids per group deepEqual `['rent','tax','upkeep']`, `['groceries','dining']`, `['homeins','carins','healthins']`, `['elec','heat','water','internet']`, `['emergency','savings','travel','gifts']`, `['transport','clothing','personal','subscriptions','fun']`; each envelope's label equals its starter category's label; `health` is in no group but still in `STARTER_CATEGORIES`; `healthins` is `Health insurance`, `People`.
  - `PRICED is rent, tax and elec`.
  - `groupOrder puts the six first and the rest alphabetically`: `groupOrder(['People', 'Food', 'Zeta', 'Home', 'Alpha', 'Food'])` deepEquals `['Home', 'Food', 'Alpha', 'People', 'Zeta']`.
  - `groupKind`: Home and Utilities are House; Savings and sinking funds is Future; Food, Insurance, Everyday and `Pets` are People.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement** in `starter.ts`. Labels are read from `STARTER_CATEGORIES` by id, not typed twice. The existing starter test counting `STARTER_CATEGORIES.length` follows on its own.

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `"The starter set names six groups of envelopes, with Health insurance among the categories"`

---

### Task 3: Making the starter envelopes, and setting a month's income

**Files:**
- Modify: `api/src/tools.ts` (two new tools, added to `TOOLS`)
- Test: `api/test/first-run-tools.test.ts` (new)

**Interfaces:**
- Consumes: `STARTER_GROUPS`, `groupKind`, `missingStarter` (Task 2).
- Produces two write tools:
  - `make_starter_envelopes`, input `{ budget: string; envelopes: { label: string; group: string; category?: string }[] }`. `category` names the feeding category (a starter row); absent means a row of one's own. Events, in order: every category and rule `missingStarter` returns (as `add_starter_set` writes them), then a `category.define` for each row of one's own that needs one, then one `envelope.define` per row: id = its category id, `label` and `group` as given, `match: { categories: [id] }`, `template: 0`, `rollover: true`, `needsFigure: true`, `order: b.envelopes.size + i`. Summary `Make ${n} envelope(s) in ${b.label}`; effects one line per group (`Home: Rent or mortgage, Property tax`), then `Every one starts as Action required until it has a figure`, then the starter set's own lines when it adds anything.
  - `set_month_income`, input `{ budget: string; month?: string; amountCents: number; why?: string }`. `month` defaults to `monthOf(ctx.today)`; one `income.set` with `why` defaulting to `set this month's income`. Summary `Set ${monthName} income to ${fmtExact}`.

- [ ] **Step 1: Write the failing tests.** A fresh store (no categories), `budget.create placitas 'Placitas'`, `who: 'alex'`, `today: '2026-11-04'`.
  - `ticked starter rows become envelopes in their groups, with no figure`: rows `rent/Home`, `groceries/Food`, `healthins/Insurance` (each `{ label, group, category }`); after `commit`, `rent` is in group `Home`, `needsFigure === true`, `template === 0`, `rollover === true`, `match.categories` `['rent']`; category `rent` is labelled `Rent or mortgage`; `state.rules.length === STARTER_RULES.length`; the proposal's effects include `Every one starts as Action required until it has a figure`.
  - `a renamed row keeps its category and the category its starter name`: `{ label: 'Mortgage', group: 'Home', category: 'rent' }` → envelope `Mortgage`, category still `Rent or mortgage`.
  - `a row of your own makes its category`: `{ label: 'Pets', group: 'Everyday' }` → category `pets`, label `Pets`, kind `People`; envelope `pets` flagged.
  - `a row of your own reuses a category by name` (Review Focus 4): with an existing category id `animals` labelled `Pets`, the row `{ label: 'pets', group: 'Everyday' }` feeds `animals` and the proposal has no `category.define` for `pets`.
  - `two rows on one category, or one already fed, are refused with words` (Review Focus 4): rows `{ label: 'Groceries', group: 'Food', category: 'groceries' }` and `{ label: 'Groceries', group: 'Food' }` reject matching `/Groceries and Groceries would both be fed by groceries/`; with an existing envelope `food` on `groceries`, a `groceries` row rejects matching `/groceries already feeds/`; in both, `store.state.lastEventId` is unchanged.
  - `nothing ticked, a blank name, or an unknown category is refused`: `envelopes: []` rejects `/at least one envelope/`; `label: '  '` rejects `/name/`; `category: 'nope'` rejects `/no category nope/`.
  - `set_month_income sets the open month's income`: with `2026-11` open at 0 and an envelope funded 100000, committing `amountCents: 640000` makes `monthView(...).income === 640000` and `toAssign === 540000`.
  - `set_month_income refuses a month that is not open or is closed`: `/2026-11 is not open for Placitas/`; after `month.close`, `/closed/`.

- [ ] **Step 2: Run them to see them fail.** `node --test --experimental-strip-types test/first-run-tools.test.ts`.

- [ ] **Step 3: Implement both tools.** Decisions: a row of one's own takes the category whose id is `slug(label)` or whose label matches case-insensitively, looking in the state and in the starter categories this same proposal defines, else defines `slug(label)` with `kind: groupKind(group)`; a slug with no letters or digits is refused like `create_budget` refuses one. A starter `category` that is neither in the state nor among `missingStarter`'s categories is unknown. Every check runs before `ctx.proposals.put`, so a refusal makes no proposal. `amountCents` below zero is refused (`an income is not less than nothing`). Two tool descriptions over sixty characters, written for Claude.

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `"The walkthrough's envelopes are made in one proposal with no figure, and a month's income can be set on its own"`

---

### Task 4: Giving an envelope a figure

**Files:**
- Modify: `api/src/tools.ts` (`set_envelope_figure` new, in `TOOLS`; `defineEnvelope` `:1350`; `setAssignment` `:921`)
- Test: `api/test/first-run-tools.test.ts`

**Interfaces:**
- Consumes: `redefine` (Task 1).
- Produces `set_envelope_figure`, input `{ budget: string; envelope: string; amountCents: number; month?: string }`. Events: `redefine(budget, env, { figure: { template: amount } })`, then `{ op: 'assign', budget, month, envelope, to: amount, why: 'gave it a figure' }` when `month` (default `monthOf(ctx.today)`) is open and not closed. Summary `${label}: ${fmtExact(amount)} a month`; first effect `From this month on: ${label} is planned at ${fmtExact(amount)} a month`; with no assign, the effect `This month is not open or is closed, so only the months to come change` (plan's words).
- `define_envelope`: `templateCents` leaves `required`. Given, the define is `redefine(..., { label, group, match, rollover, figure: { template } })`. Absent on an existing envelope: `redefine` without `figure` (template, flag and source kept). Absent on a new envelope: template 0 and `needsFigure: true`.
- `set_assignment`: when the envelope carries `needsFigure` or `source`, the proposal also carries `redefine(budget, env, { figure: { template: env.template } })` after the `assign`: the flag and the source go, the template stays.

- [ ] **Step 1: Write the failing tests.** Fixture: Task 3's store with `groceries` made flagged, `2026-11` open at `640000`.
  - `a figure writes the template and this month's assignment, and clears the flag`: `amountCents: 61200`; events ops `['envelope.define', 'assign']`; after commit `template === 61200`, `fundedFor` this month `61200`, `!('needsFigure' in env)`; effects include `From this month on`.
  - `zero on purpose is a figure`: `amountCents: 0` clears the flag.
  - `a priced envelope's source goes when a person changes the figure`: an envelope with `source` set, given a figure, has none.
  - `in a month that is not open, only the template is written`: with `month: '2026-12'`, events are the one define and the effects say `only the months to come change`.
  - `define_envelope without a template keeps the template, the flag and the source; with one clears them`: rename `groceries` to `Food at home` with no `templateCents` → label changed, flag kept; again with `templateCents: 50000` → flag gone, template 50000.
  - `a new envelope defined without a template starts with no figure`: `needsFigure === true`, `template === 0`.
  - `setting this month's assignment by hand clears the flag and the source, and keeps the template`: `set_assignment` `toCents: 40000` on flagged `groceries` → ops `['assign', 'envelope.define']`; after commit funded 40000, template 0, no flag.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement.** Amount below zero is refused (`a figure is not less than nothing`). `define_envelope`'s schema description for `templateCents` says leaving it out keeps the figure the envelope has. `group`'s description becomes `The group it shows under, e.g. Home or Food`.

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `"An envelope is given a figure from this month on, and only a figure clears its Action required"`

---

### Task 5: Pricing fills only the envelopes there are

**Files:**
- Modify: `api/src/local.ts` (`Estimate.label`, set at each source)
- Modify: `api/src/tools.ts` (`seedFromLocation` `:2080`, `localCosts` output)
- Test: `api/test/local.test.ts`

**Interfaces:**
- Produces: `Estimate` gains `readonly label: string` — `rent` is `Rent or mortgage`, `tax` `Property tax`, `elec` `Electricity` (the starter labels, read from `STARTER_CATEGORIES`). `look_up_local_costs` answers `label` beside `category`.
- `seed_from_location` no longer writes `category.define` or a new envelope. For each estimate, the envelope fed by its category gets `redefine(budget, env, { figure: { template: e.monthly, source: \`${e.source}, ${e.measuredOver}, ${e.asOf}\` } })` and, when `monthOf(ctx.today)` is open and not closed, an `assign` to `e.monthly` with `why: 'priced from local data'`. An estimate with no envelope adds the effect `Not applied: no envelope for ${e.label}`. When no estimate applies, it refuses 409: `Nothing in ${b.label} is fed by what public data prices (${labels}). Make an envelope for one and price it again.` (plan's words). The existing "would become", provenance and caveat lines stay.

- [ ] **Step 1: Write the failing tests.** Replace `it builds the category and the envelope when neither exists` with:
  - `an estimate with no envelope is listed as not applied and nothing is made`: fixture with only an envelope on `tax` (none on `rent`) and a Census reply carrying tax; effects include `Not applied: no envelope for Rent or mortgage`; after commit there is no `rent` category or envelope.
  - `when no envelope takes any estimate it says there is nothing to price`: no envelopes → rejects `/Nothing in Lakeside is fed by what public data prices/`.
  Add:
  - `a priced envelope gets its figure, its source and this month's assignment, and loses its flag`: `seedFixture({ withEnvelope: true })` with the `carry` envelope flagged and `2026-08` opened; after commit `template` is 390922, `source === 'Zillow Observed Rent Index, ZIP 12345, 2026-06'`, no flag, funded this month 390922.
  - `each estimate carries its label`: `rentFromZillow` → `Rent or mortgage`; `censusCounty`'s tax row → `Property tax`; `electricityFromEia` → `Electricity` (use the file's existing fixtures for each).
  The other seeding tests stay as they are.

- [ ] **Step 2: Run them to see them fail.** `node --test --experimental-strip-types test/local.test.ts`.

- [ ] **Step 3: Implement.** The closing "This is measured data for…" line counts the estimates applied, not found.

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `"Pricing from local data sets the envelopes that exist, under their names, with their source, and makes none"`

---

### Task 6: Hints, the income suggestion and the card

**Files:**
- Create: `api/src/figures.ts`
- Modify: `api/src/tools.ts` (`getMonth` `:221`)
- Test: `api/test/figures.test.ts` (new), `api/test/tools.test.ts` (one `get_month` test)

**Interfaces:**
- Consumes: `PRICED`, `groupOrder` (Task 2); `monthView`, `MonthView` (`envelopes.ts`); `incomeFor`, `sourcesFor` (`income.ts`).
- Produces, in `figures.ts`:
  ```ts
  export interface Hint { readonly text: string; readonly use?: { readonly cents: Cents; readonly label: string }; readonly price?: true }
  /** Net money out of `categories` in the month before `month`. */
  export function lastMonthSpent(state: State, categories: readonly CategoryId[], month: Month): Cents;
  export function hintFor(state: State, budget: Budget, env: Envelope, month: Month): Hint | null;
  export interface IncomeSuggestion { readonly cents: Cents; readonly from: 'source' | 'imports' }
  export function incomeSuggestion(state: State, budget: BudgetId, month: Month): IncomeSuggestion | null;
  export type CardTone = 'warm' | 'over' | 'done';
  export interface Card { readonly tone: CardTone; readonly headline: string; readonly line: string; readonly next: EnvelopeId | null; readonly green: string }
  export function cardFor(view: MonthView): Card;
  ```
- `get_month` answers, per envelope, `needsFigure: boolean`, `source: string | null`, `hint: Hint | null` (only while `needsFigure`; `use.cents` also as `use.exact` via `fmtExact`), and at the top `card: Card` and `groups: string[]` (`groupOrder` of the budget's groups, sinking envelopes included).

- [ ] **Step 1: Write the failing tests** in `figures.test.ts`, on a store built as Task 3's (`today` `2026-11-04`, so last month is `2026-10`):
  - `groceries, dining and transport offer last month's imports`: groceries receipts in October of 412.40 and 200.00 → `{ text: "Last month's imports show $612 at grocers", use: { cents: 61200, label: 'Use $612' } }`; dining → `... at restaurants`; transport → `... on fuel and transport` (plan's words for those two).
  - `no receipts, or refunds that net to nothing, give no hint`: none → null; −50.00 and +50.00 → null.
  - `the fixed hints, word for word`: `upkeep` → `A common rule is 1% of the home's value a year.`; `homeins`, `carins`, `healthins` → `Your policy's annual premium, divided by 12.`; `emergency` → `Many start at $1,000, then three months of the envelopes above.`; `travel`, `gifts` → `A sinking fund: a yearly amount, saved by the month.`; `pets` → null.
  - `rent, tax and elec offer pricing while the budget has a location`: with `Placitas, NM` → `{ text: 'Public data for Placitas, NM can price this.', price: true }` (plan's words); with no location → null.
  - `the income is a source's paydays this month, else last month's imports`: a monthly source of 640000 → `{ cents: 640000, from: 'source' }`; a biweekly 200000 anchored `2026-11-02` → 600000 (three paydays, not a twelfth of a year); no source and October receipts in `INCOME` of 320000 twice → `{ cents: 640000, from: 'imports' }`; neither → null.
  - `the card while envelopes need a figure`: income 640000, three envelopes funded 208800 in all, seventeen flagged → `tone 'warm'`, `headline '$4,312 still to assign'`, `line 'Income is $6,400. The 3 priced envelopes plan $2,088. The other 17 need a figure; give each one and this reaches zero.'`, `next` the first flagged envelope by order, `green 'When every envelope has a figure and they add up to income, this card turns green.'`
  - `the card in its other states` (plan's words where the spec gives none): one priced, one flagged → `The 1 priced envelope plans $X. The other 1 needs a figure; give it one and this reaches zero.`; none priced, twenty flagged → `Income is $6,400. None of the 20 envelopes has a figure yet; give each one and this reaches zero.`; one envelope, flagged → `Income is $6,400. The envelope has no figure yet; give it one and this reaches zero.`; none flagged, 31000 left → `Income is $6,400 and every envelope has a figure. $310 is still unassigned.`, tone `warm`; none flagged, zero → `Income is $6,400 and every envelope has a figure. They add up to the income.`, tone `done`, headline `Nothing left to assign`, `next` null; over by 31000 → headline `$310 over`, tone `over`, and with none flagged `Income is $6,400 and every envelope has a figure. They plan $310 more than the income.`; income zero → the line begins `No income is set for this month yet.` in place of `Income is $X.` / `Income is $X and`.
  In `tools.test.ts`: `get_month answers each envelope's flag, source and hint, the card and the groups in order` — a flagged groceries envelope has a hint, a priced one has `hint: null` and its `source`; `groups` puts `Home` before `Food` before an old `House`.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement.** Hints are keyed by the envelope's id (a starter envelope's id is its category's). The amount in a "show" hint and its "Use" is rounded to whole dollars, as `fmt` rounds. `cardFor` counts `needsFigure` among `view.envelopes`; "priced" is the rest; "plan" is `view.funded`; it says the income with `fmt`. Tone: `over` when `toAssign < 0`; else `warm` while any envelope needs a figure or `toAssign > 0`; else `done`.

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `"The month says in words what is left to assign and how many envelopes need a figure, with a hint for each"`

---

### Task 7: The cover card, and the budget's notices on Today

**Files:**
- Modify: `api/src/figures.ts` (`coverFor`), `api/src/tools.ts` (`getMonth`, `moveMoney` `:866`), `api/src/setup.ts` (`budgetNotices`), `api/src/server.ts` (`/api/today` `:2672`)
- Test: `api/test/figures.test.ts`, `api/test/setup.test.ts`, `api/test/moves.test.ts` or `api/test/tools.test.ts` (wherever `move_money` is tested)

**Interfaces:**
- Consumes: `donors`, `monthClock` (`analytics.ts`).
- Produces, in `figures.ts`:
  ```ts
  export interface Cover {
    readonly amount: Cents;                                   // the shortfall, positive
    readonly receipt: { readonly payee: string; readonly amount: Cents } | null;   // the latest line to land in it
    readonly hadLeft: Cents;                                  // what it had before that receipt
    readonly donors: readonly { readonly envelope: EnvelopeId; readonly label: string; readonly spare: Cents }[];  // spare >= amount, most first, at most 3
    readonly assign: Cents | null;                            // min(amount, toAssign) while toAssign > 0, else null
  }
  export function coverFor(state: State, view: MonthView, envelope: EnvelopeId, today: Day): Cover | null;   // null unless available < 0
  ```
- `get_month` answers `short: Cover | null` per envelope (cents also as exact dollars).
- `move_money` takes optional `onlyWhileShort: boolean`; with it, a `to` envelope whose available is 0 or more is refused 409: `${label} is no longer short` (plan's words).
- In `setup.ts`:
  ```ts
  export interface BudgetNotice {
    readonly kind: 'figures' | 'short';
    readonly text: string;
    readonly action: { readonly label: string; readonly open: 'budget'; readonly budget: BudgetId; readonly envelope: EnvelopeId; readonly cover?: true };
  }
  /** Per live budget with this month open: one notice while envelopes need a figure, one per short envelope that has a figure. */
  export function budgetNotices(state: State, today: Day): BudgetNotice[];
  ```
- `/api/today` answers `budget: budgetNotices(active.state, ctx.today)` beside `setup`, the sandbox included.

- [ ] **Step 1: Write the failing tests.**
  In `figures.test.ts`:
  - `a short envelope's cover names the receipt, what it had, and who can spare it`: groceries funded 4540, then `VALLEY MARKET` −87.40 → `amount 4200`, `hadLeft 4540`, `receipt { payee: 'VALLEY MARKET', amount: 8740 }`; four other envelopes with spare 90000, 50000, 30000 and 1000 → donors are the first three in that order; 1000 is never offered.
  - `the unassigned option is what is unassigned, up to the shortfall, and absent at zero`: toAssign 100000 → `assign 4200`; 2000 → `2000`; 0 → null.
  - `no one can spare it: no donors`, and `an envelope not short has no cover` (null).
  In the `move_money` tests:
  - `a cover move is refused once the envelope is no longer short` (Review Focus 1): with groceries short 4200, a `move_money` of 4200 with `onlyWhileShort: true` commits; the same call again rejects 409 matching `/Groceries is no longer short/`; without the flag the existing behaviour is unchanged.
  In `setup.test.ts`, a `describe("Today's budget notices")`:
  - `envelopes needing a figure are one notice that opens the first`: seventeen flagged → `{ kind: 'figures', text: '17 envelopes still need a figure', action: { label: 'Go to the first one', open: 'budget', budget: 'placitas', envelope: <first by order> } }`; one → `1 envelope still needs a figure`.
  - `a short envelope with a figure is its own notice that opens its cover`: `{ kind: 'short', text: 'Groceries is short $42', action: { label: 'Cover it', open: 'budget', budget: 'placitas', envelope: 'groceries', cover: true } }`.
  - `an envelope with no figure yet is not also called short` (Review Focus 3): a flagged envelope with a receipt in it gives the figures notice only.
  - `with more than one live budget each notice names its budget`: `Placitas: Groceries is short $42`; an archived budget and a budget without this month open give none. (The button labels are the plan's words.)

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement.** `coverFor` finds the latest line by its receipt's date (ties: the later one in `lines`) and the receipt's payee from `state.txns`; donors come from `donors(view, monthClock(view.month, today), envelope, state)` filtered to `spare >= amount` and sliced to three. `budgetNotices` orders a budget's figures notice before its short ones, budgets by label.

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `"An overspent envelope offers its cover from the envelopes with most to spare or from what is unassigned, and Today says so"`

---

### Task 8: One request to approve, and where the walkthrough is

**Files:**
- Create: `api/src/first-run.ts`
- Modify: `api/src/tools.ts` (`APPROVE_IN_ONE`), `api/src/server.ts` (tools route `:2914`, new route beside `/api/budgets`)
- Test: `api/test/first-run.test.ts` (new), `api/test/server-first-run.test.ts` (new, modelled on `server-phone-setup.test.ts`: the fake DSM on a free port, `alex` signed in, a household `Rivera household` made)

**Interfaces:**
- Consumes: `incomeSuggestion` (Task 6), `STARTER_GROUPS`, `PRICED` (Task 2).
- Produces, in `tools.ts`: `export const APPROVE_IN_ONE: ReadonlySet<string>` = `create_budget`, `set_budget_location`, `open_month`, `set_month_income`, `define_income_source`, `make_starter_envelopes`, `set_envelope_figure`, `move_money`, `set_assignment`. (`seed_from_location` is not in it: step 3 shows its proposal, with sources and caveats, before the approve, through `/api/commit` as today.)
- `POST /api/tools/:name?approve=1`: for a tool in the set, `runTool` then `commit(proposal.id, ctx)` in the same request, answering `{ proposal, summary, committed: [{ id, op, at, who }], touches: touches(proposal.events), lastEventId }`. For any other tool, 400 `${name} is not approved in one step; approve its proposal` (plan's words), before running it. Without `approve`, the route is unchanged.
- Produces, in `first-run.ts`:
  ```ts
  export type FirstRunStep = 'budget' | 'income' | 'envelopes';
  export interface FirstRun {
    readonly step: FirstRunStep | null;        // null: the budget has envelopes, so the Budget screen shows
    readonly budget: BudgetId | null;          // the asked budget if live, else the first live one, else null
    readonly month: Month;                     // monthOf(today)
    readonly monthOpen: boolean;
    readonly income: { readonly suggestion: { readonly exact: string; readonly from: 'source' | 'imports' } | null; readonly hasSource: boolean };
    readonly location: string | null;          // the budget's location label
    readonly groups: readonly { readonly name: string; readonly envelopes: readonly { readonly id: string; readonly label: string; readonly priced: boolean }[] }[];
  }
  export function firstRun(state: State, asked: string | null, today: Day): FirstRun;
  ```
  Step: no live budget → `budget`; the budget has no envelopes and `month` is not open → `income`; no envelopes → `envelopes`; else null. (Plan's decision: step 1 is done once this month is open, which Skip does by opening it at zero.)
- `GET /api/budget/first-run?budget=<id>` answers `firstRun(active.state, param || null, ctx.today)`.

- [ ] **Step 1: Write the failing tests.**
  `first-run.test.ts`: `no budget is the budget step`; `a budget with no month is the income step, with its suggestion`; `an open month with no envelopes is the envelopes step`; `envelopes mean no walkthrough`; `an archived budget asked for falls to a live one`; `the groups are the starter groups, rent, tax and elec marked priced`; `hasSource is true once an income source is recorded`.
  `server-first-run.test.ts`:
  - `approve runs a named tool and writes it as the member, in one request`: `POST /api/tools/create_budget?approve=1 { label: 'Placitas' }` → 200, `committed[0].op === 'budget.create'`, `committed[0].who === 'alex'`, `touches.budget === 'placitas'`; `GET /api/budgets` lists it.
  - `a tool outside the set is refused with approve and writes nothing` (Review Focus 2): `define_category?approve=1 { category: 'pets', label: 'Pets' }` → 400 matching `/not approved in one step/`; `GET /api/categories` has no `pets`; the next approved call's `lastEventId` is one write after the last one before it.
  - `a named tool that refuses writes nothing` (Review Focus 2): `open_month?approve=1` for `2026-11` twice → the second answers the tool's `already open` words with its status, and the event count is unchanged.
  - `the walkthrough end to end`: `create_budget`, `set_budget_location` (`label: 'Placitas, NM'`, `state: 'NM'`, no ZIP, so no network), `open_month` with `incomeCents: 640000`, `make_starter_envelopes` with all the starter rows, each `?approve=1`; then `first-run` answers `step: null`, `get_month`'s `card.tone === 'warm'` and `card.headline === '$6,400 still to assign'`.
  - `Today carries the budget notices`: after the walkthrough, `/api/today`'s `budget[0].text === '23 envelopes still need a figure'` (the number of starter rows; compute it from `STARTER_GROUPS` in the test rather than typing it).
  - `first-run answers the step for the chosen budget`: before any budget `step: 'budget'`, after `create_budget` `step: 'income'`.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement.** Read `approve` from `url.searchParams.get('approve') === '1'`. Check the set before `runTool`, so a refused tool does not even make a proposal. A run that throws answers as the route does today; `commit`'s refusal answers likewise, and either leaves the log as it was.

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `"The walkthrough's steps and the budget's one-tap actions approve in the same request, and the server says which step a budget is at"`

---

### Task 9: The phone setup in two

**Files:**
- Modify: `api/src/profile.ts`, `api/src/phone-setup.ts`, `api/src/server.ts` (`setupAsked` `:562`, icon read `:1236`, `/setup/` `:1739`, routes `:2042-2058`)
- Test: `api/test/profile.test.ts`, `api/test/phone-setup.test.ts`, `api/test/server-phone-setup.test.ts`

**Interfaces:**
- `profile.ts`: `ProfileInput` becomes `{ member: string; household: string; dsmPublicUrl: string | null }`; `buildProfile` writes the CalDAV payload only and throws `/address/` without one. Outer `PayloadDescription` `The Household calendar in Apple Calendar.`; outer UUID seed `${member}\0calendar`. The web clip payload, `origin`, `home`, `iconPng` and their helpers go.
- `phone-setup.ts`: `SetupFlags` and `flags` go from `SetupEntry` and `issue`. New:
  ```ts
  /** The origin when it can be put on a Home Screen: http or https on any host, nothing after the host. */
  export function homeOrigin(raw: unknown): string | null;
  export const homeLink = (origin: string): string => `${origin}/?add=home`;
  ```
- `server.ts`: `POST /api/phone-setup/code` takes `{ origin }` (any `calendar` or `home` in the body is ignored), needs the NAS's address and an `acceptedOrigin` as today, answers as today. `GET /api/phone-setup/profile` takes no parameters and serves the calendar profile. New `GET /api/phone-setup/home?origin=<origin>` behind the session: 400 for a refused origin, else `{ url: homeLink(origin), qr }` with the SVG made as the code's is; it touches no code. The read of `icon-180.png` and its warning go (the file stays; Task 14 points the touch icon at it).

- [ ] **Step 1: Change the tests first.**
  - `profile.test.ts`: drop the web clip, no-icon and payload-choice tests; `the profile holds the calendar account only`: types `['com.apple.caldav.account']`, description `The Household calendar in Apple Calendar.`; the refusal test keeps only `/address/`; the UUID test compares two members instead of two flag sets.
  - `phone-setup.test.ts`: `ask` loses `flags`; `homeOrigin takes http on any host` (Review Focus 5): `http://planner.example.com:8088`, `https://planner.example.com`, `http://localhost:5577` and `https://planner.example.com/` (as `https://planner.example.com`) accepted; `https://planner.example.com/app`, `https://u:p@planner.example.com`, `https://planner.example.com/?x=1`, `ftp://planner.example.com`, `''`, `null`, `42` refused; `homeLink('https://planner.example.com') === 'https://planner.example.com/?add=home'`.
  - `server-phone-setup.test.ts`: `issue()` sends `{ origin }`; drop `only the payloads asked for`, `both off is refused 400` and the Home-Screen-alone half of the address test; add `a code's profile and the Mac download hold the calendar only, whatever home says` (body `{ home: true, origin }` → types `['com.apple.caldav.account']`); `the Home Screen QR is the page's address with the marker, and spends no code` (Review Focus 5): issue a code, then `GET /api/phone-setup/home?origin=http%3A%2F%2Fplanner.example.com%3A8088` → 200, `url === 'http://planner.example.com:8088/?add=home'`, `qr` starts `<svg`; the code's `/setup/` link still serves the profile; `a refused origin gets no Home Screen QR` → 400; `with no address there is no code, and the Home Screen QR still works`; `no session, no Home Screen QR` → 401 as the other routes.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement.** `setupAsked` shrinks to the origin and the address; its comment says the calendar is the profile's only payload now.

- [ ] **Step 4: Run the tests to see them pass**, then `npm test` and `npm run typecheck`. `grep -n "webClip\|iconPng\|SetupFlags" api/src api/test -r` prints nothing.

- [ ] **Step 5: Commit** — `"The phone's profile is the calendar account alone, and the Home Screen has its own QR of the planner's address"`

---

## Phase 2: The page

No test drives `site/index.html`. Each task below is checked by hand against the fake DSM as the Global Constraints say, at desk width and at 375 px (nothing scrolls sideways), in light and dark. A fresh household for the walkthrough is made from the person menu, Create a new household. `cd api && npm test` stays green after each.

Shared page helper, added in Task 10 and used after it:
```js
/** Run one of the tools the server approves in one request; answers { proposal, summary, committed, touches, lastEventId }. */
const approveNow = (tool, args) => api(`/api/tools/${tool}?approve=1`, args);
```

### Task 10: Envelope rows, the card and the tints

**Files:**
- Modify: `site/tokens.css` (the semantic core, light, and both dark copies), `site/index.html` (`loadBudget` `:3120`, `envelopeRow` `:3220`, `#toassign` markup `:1401`, `env-new` `:4176`, its CSS near `.toassign` and `.env`)

**Interfaces:**
- Consumes: `get_month`'s `card`, `groups`, and per envelope `needsFigure`, `source`, `hint` (Task 6); `set_envelope_figure` with `?approve=1` (Tasks 4, 8).
- Produces: `approveNow`; `openFigureForm(row, e)` (Task 11's `openBudgetAt` opens it); each envelope row carries `data-envelope="<id>"`.

- [ ] **Step 1: Tokens.** Light: `--figure-chip: #FDF1E3; --figure-chip-ink: #8A4B08; --figure-row: #FFFBF5; --warm-card: #FFF8EF; --warm-card-line: #D9A066; --short-chip: #FBE7E6; --short-chip-ink: #A12622; --short-row: #FFF6F5; --short-row-line: #E8B4B1; --source-chip: #EEF0F3; --source-chip-ink: #4B5563;`. In both dark copies map them to the existing roles: figure and warm to `--caution-tint` / `--caution` / `--caution-line`, short to `--problem-tint` / `--problem` / `--problem-line`, source to `--hair` / `--ink-soft`.

- [ ] **Step 2: The card.** `#toassign` draws `card.headline` (the big figure), `card.line`, a `Go to the next one` button while `card.next` (scrolls to and focuses that row, then opens its figure form), and `card.green` under it, always. Class `warm` uses `--warm-card` with `--warm-card-line`; `over` the problem tint; `done` the good tint. The `left to assign` label and `ta-note` go. The corner keeps Income and Spent; Funded reads **Planned** (same figure, `funded`).

- [ ] **Step 3: The rows.** Bands follow `groups` (sinking still last as today). A row with `needsFigure`: class `needs-figure` (`--figure-row` background), the chip `Action required` where `left` would be, the hint's text as one line under the name, and a `Set` button; a hint with `use` adds its button (`Use $612`) that runs `set_envelope_figure` with `use.cents`; a hint with `price` adds `Price it from local data`, which clicks `#bud-seed`. A row with `source` shows it as a grey chip under the name. `openFigureForm(row, e)` opens in the row's body: one money input, the words `From this month on`, Save → `approveNow('set_envelope_figure', { budget, envelope, amountCents })` then `loadBudget()`; a typed `0` is a figure.

- [ ] **Step 4: The add form.** `env-new`'s band picker becomes the six groups from `get_month.groups` order plus the budget's other groups; the figure field may be left empty (sent without `templateCents`, so it starts Action required).

- [ ] **Step 5: Check by hand.** On a budget with flagged and priced envelopes (make them from the console with `approveNow('make_starter_envelopes', …)` until Task 12 exists): warm card with the spec's two lines; Go to the next one lands on the first flagged row with its form open; Set with 612 moves the card at once and the chip goes; a typed 0 clears the chip; Use $612 appears only with October receipts; the source chip shows on a priced row; red and green states by setting figures; dark mode uses the caution and problem roles. Then commit — `"Envelopes without a figure say Action required with their hint, and the card says what is left in words"`

---

### Task 11: The cover card, and Today's budget notices

**Files:**
- Modify: `site/index.html` (`envelopeRow`, `renderSetupNotes` `:2297`, `loadThread` `:2271`)

**Interfaces:**
- Consumes: `get_month`'s `short` (Task 7); `/api/today`'s `budget` (Task 7); `move_money` and `set_assignment` with `?approve=1` (Task 8).
- Produces: `openBudgetAt(budget, envelope, cover)`: chooses the budget, shows Budget, scrolls to the row and opens its cover card (`cover`) or its figure form.

- [ ] **Step 1: The short row.** A row with `short`: class `short` (`--short-row`, border `--short-row-line`), chip `Short $42` (`--short-chip`), and under it the cover card: title `Cover the $42`; body `The receipt from VALLEY MARKET for $87.40 is in Groceries, which had $45.40 left. An envelope never pays what it does not hold, so this one is marked Action required until the shortfall is covered.` (payee, amounts and name from `short`; without a receipt, the first sentence is left out); group `Take it from another envelope` with one row per donor (label, `$X spare`, button `Move $42`) → `approveNow('move_money', { budget, from, to, amountCents, why: 'covered the shortfall in Groceries', onlyWhileShort: true })`; note `Listed with the most to spare first. Envelopes with less than $42 left are not offered.`; with no donors, `No envelope has $42 to spare.` (plan's words). While `short.assign`: group `Or, while income is not all assigned`, button `Assign $42 to Groceries` (the `assign` amount) → `approveNow('set_assignment', { budget, envelope, toCents: funded + assign, why: 'covered the shortfall from unassigned income' })`; note `This choice disappears once the budget reaches zero.` Every button disables on its first tap and the screen reloads after.

- [ ] **Step 2: Today's notices.** `renderSetupNotes(setup, budgetNotes)` draws the budget's notices after the setup ones in the same box, each action calling `openBudgetAt(a.budget, a.envelope, a.cover === true)`.

- [ ] **Step 3: Check by hand.** Import (or append from the console) a receipt that overspends a priced envelope: the red row, chip and cover card with the spec's copy; Move $42 from the first donor clears it in one tap; a quick double tap moves once (the second answers "no longer short"); Assign appears only while money is unassigned and goes at zero. Today shows `Groceries is short $42` and `N envelopes still need a figure`, each opening the right row; with two budgets they name the budget. Commit — `"An overspent envelope shows its cover card, and Today's notices open the envelope they are about"`

---

### Task 12: The walkthrough

**Files:**
- Modify: `site/index.html` (`loadBudget`, `showProblem` `:3811`; `offerFirstBudget` and `offerFirstIncome` `:3870-4060` go; new `#walk` section beside `#budget`, its CSS)

**Interfaces:**
- Consumes: `GET /api/budget/first-run` (Task 8); `create_budget`, `set_budget_location`, `open_month`, `set_month_income`, `define_income_source`, `make_starter_envelopes` via `approveNow`; `seed_from_location` and `/api/commit` with `showManageProposal`, as `#bud-seed` does.

- [ ] **Step 1: When it shows.** `loadBudget` first reads `first-run` for `chosenBudget()`; with a `step`, it hides `#budget` and draws `#walk`, else as today. Leaving Budget and coming back reads it again, so the walk resumes at the first unfinished step. `showProblem`'s "no budgets yet" on Today reads `This household has no budget yet.` with a button `Open Budget` (plan's words); the "no open month" prompt for a budget that has envelopes is unchanged.

- [ ] **Step 2: The rail.** Three steps, `Income`, `Envelopes`, `Pricing` (plan's names), each marked done, current or to do, and the paragraph `A budget is a set of envelopes. Each holds a month's money for one thing and the receipts it pays. Together they add up to the income, no more and no less.` On a phone (under 768 px) the rail is a row of three pills above the step. While on Envelopes, a done Income step can be clicked to change the figure (plan's decision; that is when `set_month_income` is used).

- [ ] **Step 3: Before income, when there is no budget.** Name and location (town, ZIP, as `#bud-where` takes them) → `approveNow('create_budget', { label })`, then, with a location, `approveNow('set_budget_location', { budget: touches.budget, label, postal?, why: 'set when the budget was made' })`; store the id as the chosen budget; read `first-run` again.

- [ ] **Step 4: Income.** One money field, prefilled from `income.suggestion` with `seen in imports` beside it when `from` is `imports`. `the same every month` checkbox only while `!hasSource`. Save: with the box ticked, `define_income_source` (`label: 'Monthly income'` (plan's words), `earner` the signed-in member, `frequency: 'monthly'`, `anchor: '<month>-01'`) first; then `open_month` with `incomeCents` when the month is not open, else `set_month_income`. Skip: `open_month` with `incomeCents: 0`.

- [ ] **Step 5: Envelopes.** The lead `Start with these envelopes. Most households need most of these. Untick what you do not, rename anything, and add your own at the end. Every one starts as Action required until it has a figure.`; one card per group with its rows ticked: a checkbox, the name as an input, and a chip `priced in step 3` for `priced` rows, `Action required` for the rest. `Add one of your own` appends a row with a name and a group picker of the six. The button reads `Make these N envelopes` with the ticked count and is disabled at zero; it sends `make_starter_envelopes` with each ticked row (`category` for starter rows, none for one's own). The footer `Public data for the household's location prices rent, property tax and electricity. Each figure comes with its source and lands as that envelope's monthly plan. Everything else stays Action required until you type a number, and the budget says how much is still unassigned.` A refusal's words show under the button.

- [ ] **Step 6: Pricing,** in the client's state right after step 2. With a location: `Looking up what this place costs…`, then `seed_from_location`'s proposal through `showManageProposal`; approving finishes. When it refuses (nothing found, or nothing to price) or there is no location: its words (or `No location yet, so nothing can be looked up.` (plan's words)) in one line, a `Set the location` button opening the `#bud-where` form, and `Finish`. Finishing draws the Budget screen.

- [ ] **Step 7: Check by hand.** A new household: the budget step, then income (Skip and Save both reach Envelopes; a reload in between resumes at the right step), then the six groups with 21 rows ticked; untick, rename, add `Pets` under Everyday; Make these N envelopes; pricing with no ZIP says so in one line and finishes; the Budget screen shows the warm card and Action required rows. Remove every envelope of a budget: the walkthrough is back. At 375 px the pills replace the rail. Commit — `"A budget with no envelopes is a three-step walkthrough of income, envelopes and pricing"`

---

### Task 13: The More menu goes

**Files:**
- Modify: `site/index.html` (nav markup `:1251-1257`, `setupMenu('more-menu-btn', …)` `:1626`, `renderMore` `:8567-8598`, tab insertion `:9423-9428`, `linksRow` title `:7462`, the settings error `:9741`, the hamburger CSS near `:389`)

- [ ] **Step 1: Out of the bar.** Remove `#more-menu-btn`, `#more-menu`, its `.menu` wrapper, its `setupMenu`, the `lucide('menu')` prepend and the hamburger rules; tabs are appended to `#tabs-top`. The four tabs stay at every width.

- [ ] **Step 2: Into the person menu.** `renderMore` becomes `renderHouseholdApps()`: with links, a group `Household apps` (an eyebrow, then `linkItem(l)` for each, as today) in `#me-main` between `#me-phone` and `#switch-hh`; with none, nothing. Called where `renderMore` was.

- [ ] **Step 3: Words.** The Settings row title `Links under More` reads `Links in your menu`; the settings-could-not-be-read error says `the links in your menu`. `grep -n "more-menu\|renderMore\|under More" site/index.html` prints nothing.

- [ ] **Step 4: Check by hand.** Desk and 375 px: no More, no hamburger, four tabs; the person menu lists Household apps when Settings has links and not otherwise; arrow keys move through them; a link opens in the same tab. Commit — `"The More menu is gone, and the household's links are in the person menu as Household apps"`

---

### Task 14: The phone sheet in two, and the banner

**Files:**
- Modify: `site/index.html` (`drawPhoneSheet` `:7310`, `phoneCode` `:7352`, `openPhoneSheet`, `phoneBox` goes, head `:15-21`, the Today screen's top, a load-time read of the marker), `site/manifest.webmanifest`

**Interfaces:**
- Consumes: `GET /api/phone-setup/home`, `POST /api/phone-setup/code { origin }`, `GET /api/phone-setup/profile` (Task 9).

- [ ] **Step 1: The sheet.** Lead `Two separate things. Do either, or both.` Section 1, title `Home Planner on your Home Screen`, body `Scan with the camera. Safari opens Home Planner with a banner that says what to tap: Share, then Add to Home Screen.`, the QR from `/api/phone-setup/home?origin=<location.origin>` drawn on open (as an `<img>` of the SVG, as today), note `That is all it does. No profile, nothing to install, no password. The code is just the household's address.` It never depends on the NAS's address. Section 2, title `The Household calendar in Apple Calendar`, body `This adds a calendar account to the phone, pointed at the NAS. The Household calendar then shows in Apple Calendar with alerts and Siri, and an event you change there comes back here as a card to approve.`, the warm callout (`--warm-card`) `It will ask for one password. That is your NAS password, the one you sign in to Home Planner with. Your user name, <myName>, is already filled in.`, the button `Add the calendar account` → the code as today (`{ origin }` only), its QR, the note `Opens as a profile: Settings → Profile Downloaded → Install. It is unsigned, so iOS says "Not Verified".`, the expiry and Make a new code as today; the Mac download (`/api/phone-setup/profile`) beside it; the fold-out `Type it instead` as today, its last line `Password: your NAS password.` Before the address is set, section 2 is `phoneUnset` as today. The checkboxes go.

- [ ] **Step 2: The banner.** At load, before sign-in: if `new URLSearchParams(location.search).get('add') === 'home'`, remove the marker with `history.replaceState` (keeping any other query) and note it in `sessionStorage` (`hp.addHome`), so it survives the sign-in page. On Today, when that note is there, `navigator.standalone !== true`, and `localStorage` `hp.homeBannerDone` is unset: a banner at the top, title `Put Home Planner on your Home Screen`, steps `Tap Share, the box with the arrow, at the bottom of Safari.` and `Choose Add to Home Screen, then Add.`, note `It opens full screen, like an app, signed in as you.`, button `Done` (sets `hp.homeBannerDone`, clears the note, hides it). Every storage call in `try`.

- [ ] **Step 3: The Home Screen's name and icon.** `apple-mobile-web-app-title` content `Home Planner`; `apple-touch-icon` points at `/icon-180.png` (iOS does not use an SVG touch icon); the manifest's `name` and `short_name` are `Home Planner`.

- [ ] **Step 4: Check by hand.** The sheet with and without the NAS address (section 1 always draws); Add the calendar account makes a code whose profile (open the code's URL) has the calendar only; the Mac link downloads it. Open `http://localhost:5577/?add=home` signed out: sign in, Today shows the banner, the address bar has no `add=home`; Done hides it and a reload with the marker does not show it again. The callout names the signed-in account. Commit — `"Set up your iPhone is two sections, a Home Screen QR with its banner and the calendar account with its password named"`

---

### Task 15: The words, and 0.3.0

**Files:**
- Modify: `DEPLOY.md` (the phone setup, `:411-445`, and wherever it mentions More, the web clip or `home=`), `README.md` (`:129-130` and any More), `api/package.json`

- [ ] **Step 1: DEPLOY.md.** Setting up a phone is two things: a QR of the planner's own address with `?add=home`, which opens Safari with a banner (no profile, no code, any address the phone can reach, http included); and a calendar account, a one-time code as before, its profile holding the CalDAV account only, the password being the member's NAS password. The address rule now concerns the calendar code only. The web clip and its icon are no longer in the profile. Links are under the person menu's Household apps. The Budget screen paragraph, if DEPLOY.md has one, says a budget with no envelopes is a walkthrough.
- [ ] **Step 2: README.md.** Members set up an iPhone from Set up your iPhone: a QR that puts Home Planner on the Home Screen, and a calendar account for the Household calendar.
- [ ] **Step 3: Version.** `api/package.json` `"version": "0.3.0"`.
- [ ] **Step 4: Verify.** `grep -n "More\b\|web clip\|webClip\|home=1\|Home Screen icon" DEPLOY.md README.md` shows nothing stale; `cd api && npm test && npm run typecheck`; the version test passes and Settings shows 0.3.0. Then grep the tree for the public-tree rule: `git diff 29edffb --stat` and read every added line for a name, domain, folder, address, bank or vendor.
- [ ] **Step 5: Commit** — `"Version 0.3.0: the budget's first run, a receipt over its envelope, and the phone set up in two"`
