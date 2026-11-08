# Envelope pages: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution:** subagent-driven development (chosen). Tasks run in order, one at a time: they all edit site/index.html and each builds on the names the one before it produces.

**Goal:** The Budget screen becomes a list of envelope rows with no buttons in them. Tapping a row opens that envelope's own page: the envelope first, then one line per thing you can change, each with one action, then its receipts. A figure is entered as an amount and a period picked from a list.

**Architecture:** Today `envelopeRow` (site/index.html ~3300) builds a card that opens in place, holding `openFigureForm`, `buildEditor`, `coverCard`, `goalForm` and `showReceipts` together. The rework copies the Settings pages pattern (`settingsPage`, `openPage`/`closePage`, `renderSettingsPage`, `pageEscape`, `focusFirst`, `redrawPage`, ~7482-7640). One piece of state, `envelopePage`, says which page is open. `renderEnvelopePage` draws it from `month` into a new `#env-page` box inside `#budget`, while the list sits hidden in `#budget-list`. `loadBudget` draws the list every time and then redraws the open envelope page, so every save that ends in `await loadBudget()` redraws the page from the new month. A new `figureField` control replaces the typed-words parser everywhere. The tool calls stay exactly as they are today.

**Tech Stack:** vanilla JS and CSS in one file, no build; node:test only for the server test that pins the one changed string.

**Spec:** docs/superpowers/specs/2026-11-07-envelope-pages-design.md (binding; where this plan and the spec disagree, the spec wins, except the rulings listed at the end).

## Global Constraints

- Commit with `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit`. Plain-sentence message, no prefix, ending with a blank line and exactly this trailer, whatever model you are: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- Never commit `api/data/`, `site/budget.jsonl`, `site/transactions.jsonl`, `site/planner.html`, `.env`, or anything under `.claude/`.
- Nothing in the tree may name the household: no real domain, private IP, first name, bank or vendor.
- The server changes in one string only: the walkthrough's proposal effect at api/src/tools.ts:2455, "Every one starts as Action required until it has a figure", becomes "Every one starts without a figure until it is given one", with its assertion at api/test/first-run-tools.test.ts:46. No route, tool, field or figure changes; `basis` stays `{ amount, per }` with the six periods and the server's monthly rounding; the Claude-facing tool descriptions that say "Action required" keep their words.
- `cd api && npm test` (1792 at base) and `npm run typecheck` stay green. The page has no unit tests; every task ends with a check by hand at phone width (375) and desktop width, with the fake DSM.
- Copy in sentences, Apple's spellings, no exclamation marks. Phone first: nothing may depend on hover or on a wide screen.
- Accessibility holds: the page heading is an `h1` or `h2` in order, the list rows are buttons, focus is managed on every transition, Escape goes Back, `aria-live` on the error slot.

## Reused, not rebuilt

- The Settings page frame and its CSS: the page is `section.set-page.ep` with `div.set-page-head` (Back button `.back` with `icon('back', 'i')`, a focusable heading with `tabIndex = -1`). `.ep*` classes add only what is new.
- The Settings rules: `listScroll` saved on open (null when linked), `window.scrollTo({ top: 0 })` once, focus with `preventScroll: true`, a document Escape listener added while a page is open that ignores `#cat-sec`/`#phone-sec` and targets outside the page, and a `page === envelopePage` guard after every `await`.
- `showReceipts(body, e)` as the Receipts section; `editReceipt` inside it unchanged.
- `goalForm` as the savings form; `showProposal` stays for it and for the receipt editor.
- `panel()` and `showManageProposal` for Add an envelope.
- `approveNow`, `api`, `/api/commit`, `coverMoney`, `exactDollars`, `toCents`, `monthLong`, `basisText` (for the "from $14,400 a year" line only), `PER_WORDS`, `PER_YEAR`, `monthlyOfFigure`, `node`, `textBtn`, `icon`.

## Review Focus

1. **The iOS keyboard.** At 375 × 812 the first field of any form (the question form, Each month's Change form, the funding page, the Remove page) is in the top half of the viewport when it appears. A form that opens lower on the page scrolls its section heading to the top (`scrollIntoView({ block: 'start' })` under a `scroll-margin-top` that clears the sticky bar) before the field takes focus with `preventScroll: true`. Checked in Tasks 2 and 4.
2. **Async replies after Back.** A figure save, a cover tap, a funding proposal, a commit, `goalForm`'s category read or `showReceipts`' read that lands after the person has pressed Back or Escape draws nothing and moves no focus. Every continuation checks `envelopePage === page` (the object captured before the `await`). Checked in Tasks 2, 3 and 4 by throttling the network in devtools and pressing Back mid-request.
3. **A failed save keeps the typed values.** The error goes in the form's own `p.err[aria-live=polite]` slot. The amount, period, source and Why stay as typed, and focus goes to the slot or the field at fault. Nothing redraws. Checked in Tasks 2 and 4 by sending a figure while the planner is stopped.
4. **Deep links on a cold load.** From Today's notices ("needs a figure", "short"), `openBudgetAt` opens the envelope's page directly with focus in the amount or on the first cover button. The same holds after a full reload on Today. `#ta-next` opens the first no-figure envelope's page with focus in the amount. Checked in Tasks 2 and 3.
5. **A closed month's page has no forms.** No question form, no Change, no Adjust, no cover block, no foot links; the card as it stood and the receipts. Checked in Task 3 by closing the month from the month-end section.
6. **A decrease cannot name an envelope.** On the funding page, a lower amount with an envelope chosen under Take it from says so in the live line at once, and Save refuses without calling the server. Checked in Task 4.

---

### Task 1: The figure control, in Add an envelope and the row's figure form

**Files:**
- Modify: `site/index.html` (CSS ~169-248 for `.figure-form`, add `.figure*`; JS ~3112-3160 `FIGURE_PERS`/`figureProblem`/`parseFigure`/`basisText`; `openFigureForm` ~3523-3600; `panel()` ~4578-4640; the `#env-new` handler ~4710-4740)

**Interfaces:**
- Produces: `figureField({ label, amount = '', per = 'month', averages = [], price = false, hint = '', onChange = () => {} })` returning `{ el, value(): { amountCents: number, per: Per } | null, empty(): boolean, focus(): void }`. `Per` is one of `'week' | 'fortnight' | 'month' | 'quarter' | 'half-year' | 'year'`. `value()` is null whenever the amount is not a non-negative number, empty included. The amount input carries `data-key="amount"`.
- Produces: `plainDollars(text: string): string`: `"$14,400.00"` or `"14,400.00"` becomes `"14,400"`, and `"$1,200.50"` becomes `"1,200.50"`. It strips a leading `$` and a trailing `.00`. Used to prefill amounts.
- Produces: `panel()` accepts a field `{ name, control }` where `control` is a `figureField` result: `control.el` is appended in place of a label and input, and `inputs[name]` is the control.

- [ ] **Step 1: Write `figureField` next to `monthlyOfFigure`**

The markup, top to bottom: `div.figure` holding a `label` (text `label`, `htmlFor` the amount's id), then `div.figure-box` holding `span.figure-cur` "$", the `input`, and the `select`. Under the box come `p.figure-live` (`aria-live="polite"`), `div.figure-chips`, and `p.figure-hint`. The ids come from a module counter, as `figure-${n}`. The input has `inputMode = 'decimal'`, `autocomplete = 'off'`, no placeholder, and starts at `amount`. The select has `aria-label="How often"` and these options in this order: `week` "a week", `fortnight` "a fortnight", `month` "a month", `quarter` "a quarter", `half-year` "every six months", `year` "a year" (the labels are `PER_WORDS`). It starts at `per`. The amount is valid when, after removing `$` and spaces, it matches `/^(\d[\d,]*(\.\d{0,2})?|\.\d{1,2})$/`; the cents are `toCents` of it. The live line:
- `= ${coverMoney(monthlyOfFigure(cents, per))} a month` when the amount is valid and the period is not a month;
- nothing when the period is a month or the amount is empty;
- "A number, in dollars." with class `problem` when the amount is not empty and not valid.
Each average `{ months, cents }` becomes a `button.chip-btn` (type button, `aria-pressed="false"`) with the label "Last month" when months is 1 and `${months}-month average` otherwise, followed by `coverMoney(cents)`. A chip sets the amount to `plainDollars(exactDollars(cents))`, sets the period to `month`, and sets its own `aria-pressed="true"` (the others false). Any input on the amount clears every chip's pressed state. When `price` is true, a last chip "Price it from local data" runs `$('bud-seed').click()`. `hint`, when set, goes in `p.figure-hint`; otherwise that paragraph is removed. `onChange(value())` runs on every input, change and chip press. `focus()` is `input.focus({ preventScroll: true })`. Delete `FIGURE_PERS`, `figureProblem` and `parseFigure` in this step.

- [ ] **Step 2: CSS for the control**

`.figure-box` is one bordered field (`--r-control`, the field border token) laid out `auto 1fr auto`. The input inside has no border or background of its own. The select uses `appearance: none`, a sunken background (`--surface-sunken`), a hairline on its left, right padding for a chevron drawn as a `background-image` or `::after` on a wrapping span, and it inherits the font at `--fs-input`. `.figure-box:focus-within` shows the focus ring (`--focus`); the input and select show none of their own. `.figure-live` is `--fs-small` `--ink-soft`, `.figure-live.problem` is `--problem`, `:empty` is hidden. `.figure-chips` is flex, wrapping, with a 6px gap. `.chip-btn[aria-pressed="true"]` uses the accent tint. `.figure-hint` is `--fs-small` `--ink-faint`. Tokens only, so dark and light both read.

- [ ] **Step 3: Add an envelope uses it**

In the `#env-new` handler, replace the `template` field with `{ name: 'figure', control: figureField({ label: 'Funded each month', hint: 'Leave it empty to give it a figure later.' }) }`, and teach `panel()` the `control` field kind. In `onSubmit`: when `i.figure.empty()`, send no figure. Otherwise, when `i.figure.value()` is null, throw `new Error('A number, in dollars.')`. Otherwise send `templateCents` when the period is a month and `basis: { amountCents, per }` when it is not. Delete the comment that says "starts as Action required".

- [ ] **Step 4: The row's figure form uses it**

Inside `openFigureForm`, replace the text input, `showLive`, the `.avgs` buttons and the `parseFigure` call with `figureField({ label: 'From this month on', amount: e.needsFigure ? '' : plainDollars(e.basis?.amount ?? e.templateExact), per: e.basis?.per ?? 'month', averages: e.hint?.averages ?? [] })`. Submit: when `value()` is null, write "A number, in dollars." to the form's `msg` and call `focus()`. Otherwise send `amountCents` for a month and `basis: { amountCents, per }` for any other period, as today. `goToRow` focuses the control's input (`[data-key="amount"]`). This form is deleted in Task 2; it changes here only so that nothing uses `parseFigure`.

- [ ] **Step 5: Check by hand**

Start the fake DSM and the planner with inline env from this worktree's api/ (DSM on 5599, planner on 5579, data under the scratchpad `run-env` folder; the orchestrator's dispatch gives the two commands). At 375 wide and at desktop:
- Add an envelope "Vehicles" with 14400 a year. The live line reads "= $1,200 a month", and the proposal and the row show $1,200 and "from $14,400 a year".
- Add one with the amount empty. It lands with no figure.
- Typing "abc" shows "A number, in dollars." in the problem colour, and the select reads "How often" in VoiceOver or the accessibility tree.
- On a row with receipts, Change shows the average chips. A chip fills the amount and reads as pressed until the amount is edited, and Save sends the figure.
- Tab through the field: the whole box shows the ring.
Stop both servers by pid.

- [ ] **Step 6: Suite, typecheck, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: 1792 pass, typecheck clean (no server change).

```bash
git add site/index.html
git commit   # "A figure is an amount and a period from a list, in Add an envelope and the envelope's own form"
```

---

### Task 2: Rows, the envelope page and its way back

**Files:**
- Modify: `site/index.html`, in these regions:
  - HTML ~1557-1602: wrap `#budget`'s children in `div#budget-list` and add `section#env-page[hidden]` after it.
  - Budget CSS ~133-280 and ~553-562: add `.erow*` and `.ep*`.
  - `loadBudget` ~3170-3285 and `savingsBand`.
  - `envelopeRow` ~3300-3420.
  - `openEnvBody` ~3502, `openFigureForm`, `goToRow`, `#ta-next` and `openBudgetAt` ~3605-3634.
  - `buildEditor` ~3635: only its goal and drop buttons.
  - `goalForm` ~3736.
  - `showReceipts` ~5076: only its head.
  - The `budget-pick` change handler ~4118.
  - `showView` ~10482.

**Interfaces:**
- Consumes: `figureField`, `plainDollars` (Task 1).
- Produces: `let envelopePage = null`, shaped `{ id: string, view: 'envelope' | 'funding' | 'remove', editing: null | 'figure' | 'goal', listScroll: number | null }`.
- Produces: `openEnvelopePage(id: string, { linked = false, focus = null }: { linked?: boolean, focus?: FocusKey | null } = {}): boolean`. False when `month` has no such envelope. Always assigns a fresh object.
- Produces: `closeEnvelopePage({ refocus = true } = {}): void`.
- Produces: `renderEnvelopePage({ focus = null }: { focus?: FocusKey | null } = {}): void`. Draws `envelopePage.view === 'envelope'` from `month`. It focuses `[data-key=focus]`, else the `data-key` that had focus before the redraw, else the heading.
- Produces: `FocusKey`, one of `'heading' | 'amount' | 'change' | 'adjust' | 'goal' | 'remove' | 'cover'`. These are `data-key` values on the page's controls; the heading is `#env-page-h` with `data-key="heading"`.
- Produces: `envFrame({ back: string, onBack: () => void, title: string, line: string }): { section: HTMLElement, body: HTMLElement }`. It builds `section.set-page.ep[aria-labelledby=env-page-h]` with a head (the Back button, then `h1#env-page-h` with `tabIndex = -1` and `data-key="heading"`, then `p.set-line` for `line`) and `body = div.ep-body`, and Tasks 3 and 4 draw into it.
- Produces: `envPageEscape(ev: KeyboardEvent): void`.
- Produces: `goalForm(slot: HTMLElement, e: Envelope, { onCancel }: { onCancel: () => void }): Promise<void>`. It replaces `slot`'s children with the goal form, and it draws nothing when `!slot.isConnected` after its `await categoryList()`.
- Produces: `envSection(title: string, key?: FocusKey): { el: HTMLElement, slot: HTMLElement }`. It builds `section.ep-sec` with `h2.ep-sec-h` (`scroll-margin-top: 72px`) and a slot div.

- [ ] **Step 1: The two boxes and the state**

Add the HTML wrap. Declare `envelopePage` beside `month`. `showView(next)`, for any `next`, sets `envelopePage = null`, removes `envPageEscape`, shows `#budget-list` and hides and empties `#env-page`. The `budget-pick` change handler does the same before `refresh()`. `loadBudget`'s walkthrough return (`fr.step`) does the same. After the bands are drawn, `loadBudget` calls `renderEnvelopePage()` when `envelopePage?.view === 'envelope'`.

- [ ] **Step 2: Rewrite `envelopeRow(e)` as a row**

It returns a `button.erow` (type button, `data-envelope = e.id`, class `needs-figure` or `short` as today's tints `--figure-row` and `--short-row`) that calls `openEnvelopePage(e.id)` on click. It has three columns. On the left, `span.erow-name` and under it `span.bar > span`, the 4px bar filled by today's rule: spent against funded plus carried in, a savings envelope toward its goal, full and `over` when overspent, no fill with no figure. On the right, `span.erow-amt` (bold) and `span.erow-sub`. Last, a chevron (`icon('chevron', 'i sm chev')`, or the glyph `.set-item` uses). Let `F = coverMoney(toCents(e.fundedExact) + toCents(e.carriedIn))`.

| envelope | `.erow-amt` | `.erow-sub` |
|---|---|---|
| no figure (`needsFigure`) | "No figure yet" (class `fig`, `--figure-chip-ink`) | `${e.spent} spent`, or "nothing spent" when `spentExact` is 0 |
| short (`e.short`) | `Short ${coverMoney(e.short.amount)}` (class `over`) | `${e.spent} spent of ${F}` |
| savings (`e.sinking`) | `s.saved` | `of ${s.goal} goal · ${s.byName}` for `by`; `of ${s.goal} of estimates` for `every` with a goal; "no estimates yet" |
| otherwise | `e.left` | `left of ${F}` |

The button's text is its accessible name, so name, amount and state are all read. Minimum height 44px; the mockup's 64px is the guide. Delete the meta, bar-in-row, sub, hint, acts, body, toggle and the row's `coverCard` placement. `savingsBand` keeps using `envelopeRow`.

- [ ] **Step 3: Open, close, Escape, render**

Write `openEnvelopePage`, `closeEnvelopePage` and `envPageEscape` on the model of `openPage`, `closePage` and `pageEscape` (~7482-7590):
- Opening saves `listScroll = linked ? null : window.scrollY`, hides `#budget-list`, shows `#env-page`, renders, scrolls the window to the top once, and adds the listener.
- Closing removes the listener, empties and hides `#env-page`, and shows the list. It then restores `listScroll`, or when that is null calls `row.scrollIntoView({ block: 'center' })`, and focuses `#bands [data-envelope=id]` with `preventScroll`.
- `envPageEscape` returns unless `ev.key === 'Escape'`, `!ev.defaultPrevented`, `#cat-sec` and `#phone-sec` are hidden, and the target is the body, the html element or inside `#env-page`. Then it calls `preventDefault()` and either `closeEnvelopePage()` (view `envelope`) or reopens the envelope view (`funding` and `remove`, Task 4).
- `renderEnvelopePage` closes without refocus when the envelope is gone from `month`. Otherwise it builds `envFrame({ back: 'Budget', onBack: closeEnvelopePage, title: e.label, line: `${e.sinking ? 'Saved in Savings' : e.group} · ${monthLong(month.month)}` })` and appends the sections below, in order.

- [ ] **Step 4: The envelope card (Task 3 adds the cover block and the savings variant)**

`div.ep-card` holds:
- `p.ep-big`: `e.left` with `span` "left" after it in small type, in `--problem` when `e.overspent`.
- `div.ep-meter`, 8px, filled by the same rule as the row's bar.
- `p.ep-sums`: on the left, `${e.funded} funded`, extended to `${e.funded} funded · was ${e.planned}` when `e.adjustedBy && toCents(e.plannedExact) !== 0`, then `${e.carriedIn} carried in` as its own span when `carriedIn` is not 0; on the right, `${e.spent} spent`.
With no figure and an open month, the question form replaces the card:
- `h2` "How much each month?";
- `figureField({ label: 'From this month on', averages: e.hint?.averages ?? [], price: !!e.hint?.price, hint: e.hint?.text ?? '' })`;
- a Save button, type submit, in a `form`;
- `p.err` with `aria-live="polite"`.

- [ ] **Step 5: Each month, This month, Receipts, foot**

All four come from `envSection`.
- **Each month** (left out while the question form shows): `p.ep-line` `${coverMoney(toCents(e.templateExact))} a month`, and under it `span.was` with `from $${basisText(e.basis)}` when there is a basis, else `e.source` when the server gives one, else nothing. Beside it `textBtn('Change', …)` with `data-key="change"` (open month, not savings). Change sets `editing: 'figure'` and swaps the line for a form in the section's slot: `figureField({ label: 'From this month on', amount: plainDollars(e.basis?.amount ?? e.templateExact), per: e.basis?.per ?? 'month', averages, price, hint })`, then Save and Cancel, then `p.err[aria-live=polite]`. It scrolls the section heading to `block: 'start'` and focuses the amount. Cancel restores the line and focuses Change.
- **Saving** (here and in the question form): `value()` null writes "A number, in dollars." to the slot and focuses the amount. Otherwise it captures `page = envelopePage` and runs `approveNow('set_envelope_figure', { budget: month.budget, envelope: e.id, month: month.month, ...(per === 'month' ? { amountCents } : { basis: { amountCents, per } }) })`, then `await loadBudget()`. After every `await`, it returns when `envelopePage !== page`. On success it sets `editing = null` and calls `renderEnvelopePage({ focus: 'change' })`; the question form's success calls it with `{ focus: 'heading' }`. On failure the message goes in the slot, the values stay, Save is enabled again and focus goes to the slot.
- **This month**: `p.ep-line` `${e.funded} funded`, and under it "as planned", or `was ${e.planned}` by the same rule as the card. Beside it Adjust, with `data-key="adjust"`. With no figure, the line is the spent wording from the row and, under it, "Nothing funded yet. Give it a figure first.", with no action. Until Task 4, Adjust mounts the existing `buildEditor(slot, e)` in the section's slot. Delete buildEditor's goal and Remove buttons now, because the foot has them.
- **Receipts**: `div.rcpts` (the `.list` surface) passed to `showReceipts(rcpts, e)`. `showReceipts` draws its head as `h2.ep-sec-h` reading `Receipts` with a `span.count` of the number, in place of `div.h` "Receipts — n". The rest is unchanged, including Edit in a closed month.
- **Foot**: `div.ep-foot` under a hairline, with two link-styled buttons. The first is "Make this a savings goal", or "Change its goal" on a savings envelope, with `data-key="goal"`. It sets `editing: 'goal'` and calls `goalForm(eachMonth.slot, e, { onCancel: () => renderEnvelopePage({ focus: 'goal' }) })`, scrolling that section into view. The second is "Remove this envelope", with `data-key="remove"`. Until Task 4 it runs today's `panel(`Remove ${e.label} from this budget`, …)` call, moved here from `buildEditor`. With a closed month the foot is left out, along with Change and Adjust.
- **Change `goalForm`** to the signature in Interfaces: it fills `slot` and does not insert after a trigger, it adds a Cancel button calling `onCancel`, and it focuses `kind` with `preventScroll`.

- [ ] **Step 6: Deep links**

`openBudgetAt(budget, envelope, cover)` keeps its budget switch and `await showView('budget')`. Then, when `month?.budget === chosenBudget()` and `month.envelopes` has `envelope`, it calls `openEnvelopePage(envelope, { linked: true, focus: cover ? 'cover' : null })`; otherwise it leaves the list. With no figure the page's own focus rule puts focus in the amount (`focus: null` and the question form means `amount`). `#ta-next` calls `openEnvelopePage(month.card.next)`, not linked. Delete `goToRow`, `openEnvBody` and `openFigureForm`.

- [ ] **Step 7: CSS**

- `.erow`: a grid of `minmax(0,1fr) auto auto`, the 16px side gutter at phone width, a hairline between rows, `:active` sunken, and `:focus-visible` with the focus ring inset, as `.set-item` has.
- `.erow-amt.over` and `.erow-amt.fig` use the problem and figure-chip colours. `.erow-sub` is `--fs-micro` `--ink-soft`.
- `.ep-card`: the raised surface with `--r-card`. `.ep-big` is `--fs-headline` with weight 600. `.ep-meter` is 8px. `.ep-sums` is a flex row, space between.
- `.ep-sec-h` uses `--fs-ui` and carries the scroll margin. `.ep-line` is a grid of a text column and an action column. `.ep-foot` has a top hairline and link buttons.
- Leave the old `.env*` and `.figure-form` rules for Task 5.

- [ ] **Step 8: Check by hand**

Start the fake DSM and the planner with inline env from this worktree's api/ (DSM on 5599, planner on 5579, data under the scratchpad `run-env` folder; the orchestrator's dispatch gives the two commands). At 375 × 812 first, then desktop:
- **Rows.** The list shows rows with no buttons, each reading as one phrase with VoiceOver or the accessibility tree.
- **Open and Back.** Scroll down, then tap a row. The page shows from the top with the heading focused. Back, then Escape, return to the same `scrollY` with that row focused. Escape typed inside the search box does not go Back.
- **No-figure envelope.** The page opens on "How much each month?" with focus in the amount, and the field sits in the top half with the keyboard up.
- **Each month.** Save 14400 a year. The page redraws with "$1,200 a month" and "from $14,400 a year", and focus is on Change. Change scrolls its form to the top with the field in the top half.
- **Failed save.** Stop the planner, save a figure, and see the error in the slot with the amount and period kept. Start it again.
- **Late reply.** Throttle to Slow 3G, press Save, and press Back at once. The list shows nothing from the late reply and focus stays on the row.
- **Deep links.** From Today, press a "needs a figure" notice: the right page opens with focus in the amount. Do it again after a reload on Today. `#ta-next` opens the first no-figure envelope.
- **The rest of the page.** Adjust still works through the old editor. Remove still opens its panel. Receipts show their count and Edit.
Stop both servers by pid.

- [ ] **Step 9: Suite, typecheck, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: 1792 pass, typecheck clean.

```bash
git add site/index.html
git commit   # "Budget is a list of envelope rows, and each opens its own page with the envelope first, its figure, this month and its receipts"
```

---

### Task 3: The cover block, the savings envelope and the closed month on the page

**Files:**
- Modify: `site/index.html` (`coverCard` ~3428-3500, `renderEnvelopePage`'s card and Each month section from Task 2, `.cover*` CSS ~146-160)

**Interfaces:**
- Consumes: `envelopePage`, `renderEnvelopePage({ focus })`, `envSection`, `goalForm(slot, e, { onCancel })`, `FocusKey` (Task 2).
- Produces: `coverBlock(e: Envelope): HTMLElement`, the renamed `coverCard`. It is drawn inside `.ep-card` and its first enabled button carries `data-key="cover"`.

- [ ] **Step 1: `coverCard` becomes `coverBlock`**

Same content and the same tool calls: `move_money` with `onlyWhileShort: true` from each donor, and `set_assignment` with `onlyWhileShort: true` while `s.assign` is there. `why` becomes "An envelope never pays what it does not hold, so this one stays short until the shortfall is covered." Each tap captures `page = envelopePage`. After `approveNow` it runs `await loadBudget()`; when `envelopePage !== page` it stops there, and otherwise it calls `renderEnvelopePage({ focus: 'heading' })`. The 409 path reloads the same way and then calls `showProblem`. Any other failure writes to the block's `msg` only when `envelopePage === page`. `renderEnvelopePage` appends `coverBlock(e)` inside `.ep-card` under `.ep-sums` when `e.short && !month.closed`. With the `cover` focus key the first donor button takes focus; with no donor, the assign button does.

- [ ] **Step 2: The savings variant**

When `e.sinking` is set:
- **Card.** `.ep-big` is `s.saved`, followed in small type by `of ${s.goal} by ${s.byName}`. That reads `of ${s.goal} that was due by ${s.byName}` when `s.passed`, `of ${s.goal} of estimates` for `every` with a goal, and "No estimates yet" otherwise. The meter fills toward the goal.
- **Each month line.** `${s.monthly} a month toward ${s.goal} by ${s.byName}`, worded the same way for estimates, or "No estimates yet". Its Change (`data-key="change"`) calls `goalForm(eachMonth.slot, e, { onCancel })`, the same call as the foot's "Change its goal".
- **Head line.** "Saved in Savings · <month>", already set in Task 2.

- [ ] **Step 3: The closed month**

With `month.closed`, `renderEnvelopePage` draws:
- the card as it stood, with no question form even when `needsFigure` (the card's numbers only);
- no cover block;
- Each month and This month as lines with no action;
- the receipts;
- no foot.
Focus goes to the heading.

- [ ] **Step 4: Check by hand**

Start the fake DSM and the planner with inline env from this worktree's api/ (DSM on 5599, planner on 5579, data under the scratchpad `run-env` folder; the orchestrator's dispatch gives the two commands). At 375 wide and at desktop:
- **Short envelope.** Overspend one by importing or sorting a receipt into it. The row says "Short $x". Its page shows a negative left in the problem colour and "Cover the $x" with donors. Tap "Move $x": the page redraws from the new month, covered.
- **Cover link from Today.** Press a "short" notice from Today on a cold load; focus lands on the first cover button.
- **Savings envelope.** Make one with "Make this a savings goal", approve, and see the savings card, the Each month line, and Change opening the goal form at the top. Cancel returns focus to Change.
- **Closed month.** Close the month from the month-end section, open any envelope, and find no form, button or link besides Back and the receipts' Edit. Reopen it.
- **Late reply.** Throttle, tap a cover button, and press Back. Nothing draws on the list.
Stop both servers by pid.

- [ ] **Step 5: Suite, typecheck, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: 1792 pass, typecheck clean.

```bash
git add site/index.html
git commit   # "A short envelope's page carries its cover, a savings envelope's page reads as saved toward its goal, and a closed month's page only reads"
```

---

### Task 4: This month's funding page and the Remove page, with one "This will" review

**Files:**
- Modify: `site/index.html` (`buildEditor` ~3635-3735 deleted; `renderEnvelopePage` and `envPageEscape` from Task 2; Task 2's foot Remove handler; CSS beside `.ep*`)

**Interfaces:**
- Consumes: `envelopePage`, `envFrame`, `openEnvelopePage`, `closeEnvelopePage`, `renderEnvelopePage`, `envPageEscape`, `plainDollars`, `coverMoney` (Tasks 1-2).
- Produces: `openFundingPage(): void` and `openRemovePage(): void`. Each assigns a fresh `envelopePage` (`{ ...envelopePage, view, editing: null }`), draws into `#env-page` through `envFrame({ back: e.label, onBack: () => openEnvelopePage(e.id, { focus: 'adjust' or 'remove' }) … })` while keeping `listScroll`, scrolls to the top and focuses its first field.
- Produces: `reviewState(slot: HTMLElement, proposal: { id, summary, effects: string[] }, why: string, { onChange: () => void, onApproved: () => Promise<void> }): void`. It hides the form in `slot` (the form is kept, not removed) and draws `div.ep-review`, made of:
  - `h2` "This will" (tabIndex -1, focused);
  - `ul.effects` with one effect per line;
  - `p.ep-why` with the reason in curly quotes;
  - "Change it", which removes the review, shows the form again and focuses its first field;
  - Approve, labelled `proposal.summary`. It captures `page`, runs `api('/api/commit', { proposalId })` and then `await loadBudget()`, returns when `envelopePage !== page`, and calls `onApproved()`. On failure it writes the message to the review's `p.err[aria-live=polite]` and enables itself again.

- [ ] **Step 1: The funding page**

The title is "This month's funding" and the head line is `${e.label} has ${e.funded} funded for ${monthLong(month.month)} and ${e.left} of it left.`, or `… and is ${coverMoney(e.short.amount)} short.` when short. One `form`:
- **Funded this month.** An `input` with `inputMode="decimal"`, a label, prefilled with `plainDollars(e.fundedExact)`.
- **The live line under it,** `p.figure-live[aria-live=polite]`. Let `now = toCents(e.fundedExact)`, `delta = target − now`, and `base = e.adjustedBy ? 'now' : 'planned'`:
  - `+${coverMoney(delta)} more than ${base}` when `delta > 0`;
  - `${coverMoney(-delta)} less than ${base}; it goes back to Money not yet assigned` when `delta < 0` and the pool is chosen;
  - "A decrease goes back to Money not yet assigned, not to another envelope." in the problem colour when `delta < 0` and an envelope is chosen;
  - "A number, in dollars." for an amount that is not valid;
  - nothing when unchanged.
- **Take it from.** A `select`: `''` reading `Money not yet assigned · ${month.toAssign}` first, then every other envelope as `${o.label} · ${o.left} left`.
- **Why.** An `input` with the placeholder "e.g. two birthdays this month", and under it `p.note` "One line. It is what gets read next month when someone asks why."
- **Cancel and Save,** then `p.err[aria-live=polite]`.
Save refuses without a call and focuses the field at fault in four cases: the amount is not valid ("A number, in dollars."), the amount is unchanged (focus the amount), Why is empty ("Say why, in one line."), or a decrease names an envelope (focus the select). Otherwise it captures `page` and sends one of:
- `api('/api/tools/move_money', { budget, month, from, to: e.id, amountCents: delta, why })` when `from` is an envelope;
- `api('/api/tools/set_assignment', { budget, month, envelope: e.id, toCents: target, why })` when it is the pool.
It returns when `envelopePage !== page`, then calls `reviewState(…)`. `onApproved` replaces the page body with a done state:
- `p` reading `${e2.label} has ${e2.funded} funded for <month> and ${e2.left} of it left.`, where `e2` is the envelope read from the new `month`;
- a primary button `Back to ${e.label}`, focused, that calls `openEnvelopePage(e.id, { focus: 'adjust' })`.
Adjust on the envelope page calls `openFundingPage()`. Delete `buildEditor`.

- [ ] **Step 2: The Remove page**

The title is `Remove ${e.label}` and the line is "Its receipts stay, but stop belonging to any envelope." One `form`:
- Why, an `input` with the placeholder "e.g. we sold the car";
- a danger Remove button (class `btn danger`, type submit);
- Cancel;
- `p.err`.
An empty Why focuses the field and says "Say why, in one line." Otherwise, guarded the same way, it calls `api('/api/tools/remove_envelope', { budget: month.budget, envelope: e.id, why })` and then `reviewState(…)`. `onApproved`:
1. Find the id of the row after this one in `#bands`, else the one before. This is captured before the commit.
2. Call `closeEnvelopePage({ refocus: false })`.
3. Focus that row, or `#env-new` when there is none.
The foot's "Remove this envelope" calls `openRemovePage()`. Delete the `panel()` remove call.

- [ ] **Step 3: Escape and Back on the two pages**

`envPageEscape` with view `funding` or `remove` calls `openEnvelopePage(id, { focus: 'adjust' | 'remove' })` and keeps the saved `listScroll`, so a later Back still returns to the list where it was. Opening the funding page from the envelope page is not a list visit: `listScroll` is carried over, not re-read.

- [ ] **Step 4: CSS**

`.ep-review` is a grid with a gap. `.ep-review .effects` reuses the existing `.effects` list style. `.ep-why` is `--ink-soft` and italic-free (quotes only). `.btn.danger` reuses the Settings red (`.set-page .btn.danger[type="submit"]` already matches inside `section.set-page`).

- [ ] **Step 5: Check by hand**

Start the fake DSM and the planner with inline env from this worktree's api/ (DSM on 5599, planner on 5579, data under the scratchpad `run-env` folder; the orchestrator's dispatch gives the two commands). At 375 × 812 first, then desktop:
- **Opening.** Adjust opens "This month's funding" with the amount focused in the top half and the keyboard up.
- **Raise from the pool.** Raise the amount by 200: the live line reads "+$200 more than planned". Leave Why empty and Save: the slot says so and Why takes focus. Fill Why and Save: the page shows "This will", the effects, the quoted reason, "Change it" and Approve.
- **Change it.** "Change it" brings the form back with the values kept.
- **Approve.** Approve shows the done state with the new figures. "Back to <name>" shows the envelope page redrawn, focus on Adjust.
- **Decrease.** Lower the amount with Groceries chosen. The live line says a decrease goes back to Money not yet assigned, and Save makes no request (check the network tab).
- **Move.** A move from Groceries proposes a `move_money`.
- **Failed approve.** Stop the planner and Approve: the error shows in the review and nothing else changes.
- **Back and Escape.** Escape on the funding page returns to the envelope page. A second Escape returns to the list at the old scroll.
- **Remove.** Remove an envelope you made for the test. The review shows, and Approve returns to the list without the row, focus on its neighbour.
- **Late proposal.** Throttle, Save, and Escape at once. Nothing draws.
Stop both servers by pid.

- [ ] **Step 6: Suite, typecheck, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: 1792 pass, typecheck clean.

```bash
git add site/index.html
git commit   # "This month's funding and removing an envelope are pages of their own, each read back as This will before Approve"
```

---

### Task 5: The copy sweep, dead CSS, the server string, docs and version 0.6.0

**Files:**
- Modify: `api/test/first-run-tools.test.ts:46`
- Modify: `api/src/tools.ts:2455`
- Modify: `site/index.html` (walkthrough copy ~4440, ~4472, ~4500; dead CSS ~133-280 and ~553-562)
- Modify: `README.md:48-52`
- Modify: `DEPLOY.md:1053`
- Modify: `api/package.json`, `api/package-lock.json` (version lines)

**Interfaces:**
- Consumes: nothing new. This task only removes and renames.

- [ ] **Step 1: Write the failing test**

In `api/test/first-run-tools.test.ts`, test "ticked starter rows become envelopes in their groups, with no figure":

```ts
assert.ok(p.effects.includes('Every one starts without a figure until it is given one'));
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd api && node --test test/first-run-tools.test.ts`
Expected: FAIL on that assertion.

- [ ] **Step 3: Change the string**

api/src/tools.ts:2455: `effects.push('Every one starts without a figure until it is given one');`. Leave the tool descriptions that say "Action required" alone.

- [ ] **Step 4: Run it to see it pass**

Run: `cd api && node --test test/first-run-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: The page's copy**

- ~4440, the walk lead: "… and add your own at the end. Every one starts without a figure until it is given one."
- ~4472, the walk row chip: `node('span', 'chip figure', 'No figure yet')`.
- ~4500, the walk foot: "… Everything else has no figure until you give it one, and the budget says how much is still unassigned."
Then run `grep -n "Action required" site/index.html`. Expected: no output.

- [ ] **Step 6: Dead CSS**

Remove the rules for `.env`, `.env-head` (and its `::after` and `[aria-expanded]` rules), `.env-name`, `.env-left`, `.env-sub`, `.env-hint`, `.env-acts`, `.env-meta`, `.env-body`, `.list > .env`, `.list > .env.short`, `.chip.short`, `.figure-form` and everything under it, and `.bar` only when Task 2 gave the row bar its own `.erow .bar` rules. Run `grep -nE "'(env|env-[a-z]+|figure-form)'|class=\"env|\\benv-(head|sub|hint|acts|meta|body)\\b" site/index.html`. Expected: no JS or HTML use. Keep `.edit`, which `panel()` and `goalForm` still use; `.chip.figure`, which the walkthrough uses; and `.cover*`, which `coverBlock` uses.

- [ ] **Step 7: Docs and version**

- README.md 48-52 becomes this bullet: "**Figures the way the bill is known.** An envelope's figure is an amount and how often it comes: a week, a fortnight, a month, a quarter, every six months or a year. The page shows the monthly it becomes before saving, and the envelope keeps saying where it came from ("from $14,400 a year"). An envelope with categories can also take its figure from the average of its last one, three or six months of receipts." Add one sentence under it: "The Budget screen is a list of envelopes; each opens its own page with what is left, its figure, this month's funding and its receipts."
- DEPLOY.md:1053: "an envelope without a figure says No figure yet."
- Run `cd api && npm version 0.6.0 --no-git-tag-version`. Expected: `v0.6.0`, with the version lines in package.json and package-lock.json reading `0.6.0`.

- [ ] **Step 8: Check by hand**

Start the fake DSM and the planner with inline env from this worktree's api/ (DSM on 5599, planner on 5579, data under the scratchpad `run-env` folder; the orchestrator's dispatch gives the two commands). At 375 wide, in light and dark:
- Make a new budget and go through the walkthrough. Its envelope step reads "No figure yet" on the chips, and its proposal says "Every one starts without a figure until it is given one".
- Open the Budget list, one page of each kind, Add an envelope and the funding page. Nothing lost its styling after the dead CSS went.
Stop both servers by pid.

- [ ] **Step 9: Suite, typecheck, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: 1792 pass, typecheck clean.

```bash
git add site/index.html api/src/tools.ts api/test/first-run-tools.test.ts README.md DEPLOY.md api/package.json api/package-lock.json
git commit   # "Version 0.6.0: each envelope opens as its own page, and a figure is an amount and how often it comes"
```

---

## Rulings where the spec and the code disagree

- **`figureField` takes `label`, and its result has `empty()`.** These go beyond the owner's signature. Add an envelope must tell an empty amount (no figure) from a wrong one, and each of the three uses labels the field differently.
- **`.edit` stays.** The spec lists it as dead, but `panel()` and `goalForm` still use it.
- **Receipts keep Edit in a closed month.** The spec says "no forms anywhere on the page" for a closed month. The code deliberately offers the receipt editor there ("which envelope a receipt belongs to is a fact about the receipt"), so "no forms" is read as no forms that move the month's money.
- **"more than planned" or "more than now".** The funding page's live line measures against what is funded now, because that is what the tool moves. It reads "planned" unless the month was already adjusted, when "planned" would be wrong.
- **`hint.text` shows whenever the server sends it,** as the spec says. When averages exist, the server's sentence ("Your receipts average $X a month …") restates a chip; this is for the owner to judge on the hand check.
- **`.list` keeps its name.** The spec calls the group surface `.rows` and the row `a.row`. This plan keeps `.list`, which other lists share, and uses `button.erow`.
- **The browser's back button is not wired.** The app has no `history` or `popstate` handling, and the spec says "when the app wires it".
