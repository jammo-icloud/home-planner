# Figures by the year, the quarter or the week, and from receipts: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An envelope's figure can be typed the way the bill is known ("1,200 a year", "250 a quarter", "40 a week"), is shown as the monthly it becomes before saving, keeps that basis so the row reads "$100.00 a month, from $1,200 a year" and a later edit starts from the yearly figure; and every envelope with categories can take its figure from its own receipts as the average of the last 1, 3 or 6 months.

**Architecture:** Every figure stays a monthly amount in cents in the log and on the month; nothing downstream changes. `envelope.define` gains an optional `basis: { amount, per }` carried like `source` is. One pure function `monthlyOf(basis)` in figures.ts turns a basis into the monthly and is the only place that arithmetic lives; the server recomputes the monthly from a basis it is given, so a page can never send a monthly that disagrees with its basis. `hintFor` grows from "last month, three envelopes" to "the averages over 1, 3 and 6 months, any envelope with categories". The page gains a small parser for the period words, separate from `toCents`, a live "= $x a month" line, and average buttons inside the figure form.

**Tech Stack:** Node 22+ native TypeScript, node:test, vanilla JS page.

**Spec:** James's ruling in chat on 2026-11-07: build utilities 1 (period-aware figure with the basis kept) and 2 (average of the last N months) together; utility 3 (spread a yearly total across a group) is deferred.

## Global Constraints

- Commit with `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit`. Plain-sentence message, no prefix, ending with a blank line and exactly this trailer, whatever model you are: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- Never commit `api/data/`, `site/budget.jsonl`, `site/transactions.jsonl`, `site/planner.html`, `.env`, or anything under `.claude/`.
- Nothing in the tree may name the household: no real domain, private IP, first name, bank or vendor. Examples: `planner.example.com`, `alex`, `bob`.
- No new npm dependencies. Do not change `toCents` on the page (about 25 callers).
- `cd api && npm test` (1776 pass at base) and `npm run typecheck` stay green after every task.
- Copy in sentences, in the voice of the Budget screen. Money is formatted by the existing `fmt`/`fmtExact` helpers.

## The contract between the tasks

**Basis.** `type Per = 'week' | 'fortnight' | 'month' | 'quarter' | 'half-year' | 'year'`; `interface Basis { readonly amount: Cents; readonly per: Per }`. `PER_YEAR: Record<Per, number> = { week: 52, fortnight: 26, month: 12, quarter: 4, 'half-year': 2, year: 1 }`. `monthlyOf(b: Basis): Cents = ceil(b.amount * PER_YEAR[b.per] / 12)` in whole cents (ceil, as sinking's `everyMonthly` rounds up, so twelve months never fall short). `monthlyOf({ amount: 120000, per: 'year' }) === 10000`; `{ 4000, week }` → `17334` (4000 × 52 / 12 = 17333.33… → 17334); `{ 25000, quarter }` → `8334`; `{ 100000, month }` → `100000`.

**Event.** `envelope.define` gains optional `basis?: Basis`. Absent means the figure was given as a monthly. `redefine(budget, env, { figure: { template, source?, basis? } })`: when `figure` is given, `basis` is `figure.basis` (absent clears it, as `source` works); when `figure` is not given, the envelope's existing basis is carried. Replay validates: `amount` an integer ≥ 0, `per` one of the six.

**Tools.** `set_envelope_figure` takes `amountCents` OR `basis: { amountCents: number; per: Per }`, exactly one; with `basis`, the template is `monthlyOf` of it and the proposal's summary reads `${label}: ${fmtExact(basis)} a ${perWord} (${fmtExact(monthly)} a month)`; the `assign` for an open month uses the monthly. `define_envelope` takes the same optional `basis` beside `templateCents`. `perWord`: week, fortnight, month, quarter, "half year", year.

**get_month.** Every envelope answers `basis: { amount: string (exact dollars, as `fmtExact` without the sign), per: Per } | null`, and `hint` is answered for every envelope with categories, not only flagged ones: `Hint` gains `averages?: { months: 1 | 3 | 6; cents: Cents }[]` (only the windows with any receipts, whole dollars) and `use` becomes the 3-month average when it exists, else the 1-month, with labels `Use ${fmt} (3-month average)` and `Use ${fmt} (last month)`. `text` for an envelope that is not one of the three named ones reads `Your receipts average ${fmt} a month over the last ${n} months`; the three keep their wording. `FIXED` and `PRICED` texts apply when there are no receipts at all. Sinking envelopes get no averages (analytics never extrapolates them).

**Page parser.** `parseFigure(text) → { cents, per } | null`, beside `toCents`, never replacing it. It takes an amount in the forms `toCents` already accepts, followed by optional period words; no words means `per: 'month'`. Period words, case-insensitive, with "a", "per", "each", "every" and "/" all accepted: year (`a year`, `per year`, `/yr`, `/y`, `yearly`, `annually`, `every 12 months`), quarter (`a quarter`, `quarterly`, `/q`, `every 3 months`), month (`a month`, `monthly`, `/mo`, `/m`, `every month`), week (`a week`, `weekly`, `/wk`, `/w`), fortnight (`a fortnight`, `fortnightly`, `every two weeks`, `every 2 weeks`, `every other week`, `biweekly`), half-year (`every six months`, `every 6 months`, `half-yearly`, `twice a year`). Anything else after the amount → null.

## Review Focus

1. **Ceil at the cent, not the dollar.** `$4,000 a week` must give $17,333.34 a month, and twelve of them must cover the year. Pinned in Task 1's `monthlyOf` tests.
2. **An old log stays valid.** Envelopes defined before this change have no `basis`; replay accepts, the row shows the monthly alone, and `redefine` without `figure` carries an absent basis as absent. Pinned in Task 1's replay test.
3. **A figure typed as a monthly clears an old yearly basis.** Otherwise the row would say "from $1,200 a year" about a figure that is no longer that. Pinned in Task 1's redefine test and Task 2's form behaviour (the page sends `basis` only when a period was typed or kept).
4. **"1200" alone is a month, and "1200 a yr" is a year; "1200 a fortnight or so" is refused.** Pinned in Task 2's parser table (checked by hand in the browser, since the page has no unit tests) and by the server's own `per` validation.
5. **Months with no receipts do not drag the average to zero.** A household that imported only two of the last six months gets the average of those two. Pinned in Task 1's `spentOver` tests.

---

### Task 1: The server keeps a basis and averages receipts

**Files:**
- Modify: `api/src/types.ts` (the `envelope.define` event ~320 and the `Envelope` type), `api/src/replay.ts` (the `envelope.define` validation and apply), `api/src/figures.ts` (`Basis`, `Per`, `PER_YEAR`, `monthlyOf`, `spentOver`, `hintFor`, `Hint`), `api/src/tools.ts` (`redefine` ~340, `set_envelope_figure` ~2422, `define_envelope` ~1413, get_month's per-envelope view ~295-305), `api/src/restore.ts` only if envelope.define fields are enumerated there
- Modify tests: `api/test/figures.test.ts`, `api/test/budgets.test.ts` or `api/test/first-run-tools.test.ts` (wherever `set_envelope_figure` and `redefine` are tested today), `api/test/tools.test.ts` for get_month's shape

**Interfaces:** Produces everything under "The contract between the tasks" above, exported from figures.ts: `Per`, `Basis`, `PER_YEAR`, `monthlyOf`, `perWord`, `spentOver(state, categories, month, months: 1 | 3 | 6): Cents | null`.

- [ ] **Step 1: Failing tests, figures**

```ts
test('monthlyOf rounds up at the cent', ...)   // the four values in the contract, and { 1, 'year' } → 1
test('spentOver averages only the months that had receipts', ...)
// receipts in two of the last six months → the mean of those two; none → null; refunds count against, as lastMonthSpent does
test('hintFor offers the averages to any envelope with categories, 3-month first', ...)
// an envelope outside SHOWN with receipts in 1 and 3 month windows → averages [{1},{3}], use.label 'Use $… (3-month average)', text 'Your receipts average…'
// the same envelope with no receipts at all and an id in FIXED → the FIXED text and no averages
// a sinking envelope → no averages
```

- [ ] **Step 2: Failing tests, redefine and tools**

```ts
test('redefine carries a basis, and a figure given as a monthly clears it', ...)
test('set_envelope_figure with a basis writes the monthly it computes and keeps the basis', ...)
// basis { amountCents: 120000, per: 'year' } → event template 10000, basis { amount: 120000, per: 'year' }, assign to 10000 when the month is open
test('set_envelope_figure refuses both or neither of amountCents and basis, and an unknown per', ...)
test('an envelope.define with a bad basis does not replay', ...)   // amount -1; per 'decade'; amount 1.5
test('an envelope.define without basis still replays and the envelope has none', ...)
test('get_month answers basis as exact dollars and hint for every envelope with categories', ...)
```

- [ ] **Step 3: Run to see them fail**

Run: `cd api && node --test --experimental-strip-types test/figures.test.ts test/tools.test.ts` (and the file holding the redefine tests)
Expected: FAIL (exports missing).

- [ ] **Step 4: Implement**

types.ts, replay.ts, figures.ts, tools.ts as the contract says. In `set_envelope_figure`, parse `basis` with `money()` for the amount and a membership check for `per` (ToolError `'per is one of week, fortnight, month, quarter, half-year, year'`); `'give amountCents or basis, not both'` and `'a figure needs amountCents or basis'` for the other refusals. The description strings of both tools mention the basis in one sentence each.

- [ ] **Step 5: Suite, typecheck, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: pass.

```bash
git add api/src/types.ts api/src/replay.ts api/src/figures.ts api/src/tools.ts api/src/restore.ts api/test/figures.test.ts api/test/tools.test.ts <the redefine test file>
git commit   # "An envelope's figure can be given by the year, quarter, fortnight or week and keeps that basis, and any envelope with receipts is offered their average"
```

---

### Task 2: The page takes a figure the way the bill is known

**Files:**
- Modify: `site/index.html` (`toCents` ~3305 stays; add `parseFigure` beside it; the row's actions ~3530-3548; `openFigureForm` ~3663-3707; the row's planned-figure text wherever the template is shown; the Add an envelope panel ~4823-4841), `README.md` (Budget section, one paragraph), `api/package.json` + lock (0.4.0)

**Interfaces:** Consumes the contract. Code to it; Task 1 is being built at the same time, so your `npm test` may show its failures until it lands.

- [ ] **Step 1: `parseFigure`**

As the contract defines, next to `toCents`, with a comment listing the words it understands. Also `perWords = { week: 'a week', fortnight: 'a fortnight', month: 'a month', quarter: 'a quarter', 'half-year': 'every six months', year: 'a year' }` and `basisText(basis)` → `"1,200 a year"` style (exact dollars without a currency sign unless the page already shows one in inputs; follow `fmtExact`'s look minus the sign).

- [ ] **Step 2: The figure form**

- Label stays `From this month on`; placeholder becomes `e.g. 1,200 a year`.
- Prefilled: with the envelope's `basis` as `basisText`, else with its monthly as exact dollars, else empty.
- A live line under the field, updated on input: for a period other than month, `= $100.00 a month`; for a plain monthly, nothing; when `parseFigure` returns null and the field is not empty, `Say how often: a month, a year, a quarter, a fortnight or a week.` in the form's existing `msg` style.
- Averages, when `e.hint?.averages` has any: a row of small buttons under the field, `Last month $612`, `3-month average $598`, `6-month average $560` (only the windows present); pressing one puts the monthly into the field as exact dollars and updates the line. These are helpers, not saves.
- Save: `parseFigure`; null → the message above and focus; otherwise `set_envelope_figure` with `basis: { amountCents, per }` when `per !== 'month'`, else `amountCents` alone (a monthly clears any old basis, Review Focus 3). Then `loadBudget()` as today.

- [ ] **Step 3: Every row can change its figure**

The row's action is `Set` while `needsFigure`, else `Change` (the same `openFigureForm`), hidden when the month is closed. The Use button stays for flagged rows only. Where the row shows its planned figure, append `from $1,200 a year` in the row's small text when `basis` is present (use `basisText` with the sign the row already uses).

- [ ] **Step 4: Add an envelope**

The panel's figure field accepts the same grammar and sends `basis` or `templateCents` accordingly; its placeholder becomes `e.g. 1,200 a year, or leave it for later`.

- [ ] **Step 5: README and version**

README's Budget section: one paragraph, that a figure can be typed as the bill is known and the row keeps the basis, and that an envelope can take the average of its last one, three or six months of receipts. `cd api && npm version 0.4.0 --no-git-tag-version`.

- [ ] **Step 6: Check by hand, then commit**

Start the fake DSM and the planner with inline env (DSM on 5598, planner on 5577: see the memory note `worktree-page-checks`, or ask the orchestrator for the two commands), open a budget, and check the parser table from the contract in the form's live line: `1200` → nothing; `1,200 a year` → `= $100.00 a month`; `4000 a week` → `= $17,333.34 a month`; `250 a quarter` → `= $83.34 a month`; `1200 a fortnight or so` → the refusal. Save `1,200 a year` and see the row read `from $1,200 a year`; reopen and see `1,200 a year` prefilled; save `100` and see the basis gone. Stop both servers by pid.

Run: `cd api && npm test && npm run typecheck` (after Task 1 has landed; if it has not, report that the page is done and the suite waits for it).

```bash
git add site/index.html README.md api/package.json api/package-lock.json
git commit   # "Version 0.4.0: a figure typed the way the bill is known, kept with its basis, and the average of recent receipts offered on every envelope"
```
