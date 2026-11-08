# Settings as drill-in pages: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings stops bouncing. Every setting is one line in a list; tapping it opens that setting's own page with its form at the top, focus on the first field, errors inside the page; Back returns to the list exactly where it was. Nothing but the open page ever redraws.

**Architecture:** Today `renderSettings` (site/index.html ~7613) empties `#settings` and rebuilds every group and row on every state change, then restores `scrollY` as a number; forms open inside rows (`settingsOpen`), some rows open other rows' forms, async loads redraw again, and five actions leave the list for a sheet at the top of `<main>`. The rework replaces that with two renderers: `renderSettingsList()` draws the list once per visit and `renderSettingsPage(key)` draws one page; state is `settingsPage: { key, group } | null` plus the list's saved `scrollY` and the row to refocus. Each row's existing form body (`areasForm`, `linksForm`, `guestsForm`, `hcalForm`, `folderPicker`, `connForm`, `budgetForm`, `conflictsForm`, `schemeTiles`, `zoneForm`, `modelForm`, and the Invite/Remove/Restore panels) becomes that row's page body, drawn into the page's body slot; a page redraws only itself. The server contract and every row key stay exactly as they are, so Today's notices and the first-run deep links keep working. This NAS rows on the household picker use the same page renderer inside `#hh-panel`.

**Tech Stack:** vanilla JS and CSS in one file, no build; node:test only for the server tests that pin the row keys.

**Spec:** James's ruling in chat on 2026-11-07: drill-in pages, as recommended, as its own release. The analysis behind it is summarised under "What is wrong today".

## What is wrong today (measured on 2026-11-07)

- Setup's "No folder chosen" at scrollY 400 opens the form under the Documents row at scrollY 1098; "No Household calendar yet" jumps to 952.
- Every action replaces the whole Settings DOM; Change folder draws three times (open, busy, loaded) and the Drive reply lands focus on a radio after a delay.
- The one error box `#app-err` sits above the list; showing or hiding it shifts every row under a restored `scrollY`; a failed save scrolls to it.
- The calendar's Change opens a menu with no focus and its real input a tap away; Invite, Remove, Restore, Set up your iPhone and the categories editor open a sheet at the top of `<main>`.
- Three form builders (`rowForm`, `selectRowForm`, `arrivalForm`) and two sheets (`panel`, `hhPanel`) do the same job; labels vary (Change, Change folder, Edit, Colours, Set up ›, Show, Restore…, Remove…).

## Global Constraints

- Commit with `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit`. Plain-sentence message, no prefix, ending with a blank line and exactly this trailer, whatever model you are: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- Never commit `api/data/`, `site/budget.jsonl`, `site/transactions.jsonl`, `site/planner.html`, `.env`, or anything under `.claude/`.
- Nothing in the tree may name the household: no real domain, private IP, first name, bank or vendor.
- The server does not change in this plan. Row keys (`appearance`, `conflicts`, `phone`, `setup`, `members`, `areas`, `budget`, `hcal`, `guests`, `documents`, `links`, `backup`, `remove`, the connector ids, and the deep-link keys `zone` and `model`) and groups (`you`, `household`, `nas`) stay, because api/src/setup.ts and four tests pin them.
- `cd api && npm test` (1776 at base) and `npm run typecheck` stay green. The page has no unit tests; every task ends with a check by hand at phone width (375) and desktop width, with the fake DSM.
- Copy in sentences, Apple's spellings, no exclamation marks. Phone first: nothing may depend on hover or on a wide screen.
- Accessibility holds: the page heading is an `h1` or `h2` in order, the list rows are buttons, focus is managed on every transition, Escape goes Back, `aria-live` on the error slot.

## The model, exactly

**The list.** `#settings` holds a page head (Back to where you came from, the title "Settings", Done) and the three groups as today (You, Household, This NAS for an administrator). Each row is one `button.set-item` filling the width: title on the left, a one-line status on the right in muted text, a chevron. A status that needs attention keeps its current wording and gets the existing warning tint. Rows a member may only read are still tappable and their page says, under the heading, `Only ${owner} can change this.` with the form absent. The Setup card's duplicate links go; `Time zone` and `Claude model` become rows of the Household group (keys `zone` and `model`, which the deep links already use). The index nav on wide screens stays as a list of the same rows.

**The page.** Tapping a row saves `window.scrollY` and the row key, replaces the list (same `#settings` box) with: a head (`‹ Settings` button, the row's title as the heading, no Done), one line saying what the setting is, the body slot, the actions (Save / Cancel or the form's own), and an error slot (`p.set-err[aria-live=polite]`) under the actions. The window scrolls to the top once. Focus goes to the first field with `preventScroll: true` (or to the heading when there is no field). Async loads (Drive folders, DSM calendars, accounts) draw only inside the body slot and never move focus unless the field focus was on is gone. Back, Escape, or a successful single-value save returns to the list, restores `scrollY`, and focuses the row that was opened; list-editor pages (areas, links, guests, conflicts, appearance) stay open after each save, as today, until Back. Errors from `saveSettings` go in the page's slot; `#app-err` is no longer used by Settings.

**Deep links.** `openSettings(group, row)` opens the list and then that row's page directly (no simulated click). Keys `zone` and `model` open their own pages. A key the person does not have shows the list at the top with no error, as today.

**This NAS on the household picker.** `renderNasPanel` draws the same list rows into `#hh-panel`; tapping one draws that connector's page in `#hh-panel` with the same head and slots. The `#hh-panel` CSS overrides go once the shared styles cover it.

**Sheets that stay.** Set up your iPhone (`#phone-sec`) and the categories editor (`#cat-sec`) are already full screens with their own heading; they open as today from their rows and from the person menu, and their Back returns to the Settings list at the saved scroll when that is where they came from.

## Review Focus

1. **The iOS keyboard.** A page's first field must be in the top half of the viewport when it opens, so the keyboard cannot hide it; the implementer checks at 375 × 812 with the field focused.
2. **Async after Back.** A Drive or DSM reply that arrives after the person has gone Back must not draw into the list or steal focus. Each async draw checks that its page is still the open one (`settingsPage?.key === key`, as `folderPick === pick` does today).
3. **A save failure keeps the typed values.** The error appears in the page's slot, the form stays as it was, focus goes to the slot or the first invalid field, and the list is untouched.
4. **Deep links from Today.** "Choose a folder", "Choose a calendar" and "Open This NAS" from Today's notices land on the right page with the form ready, from a cold load of the page.
5. **Nothing else uses `#app-err` wrongly afterwards.** The box stays for the rest of the app; only Settings stops writing to it.

---

### Task 1: The list and the page, with every in-place form moved over

**Files:**
- Modify: `site/index.html` (CSS ~1141-1285 for `.set-*` and `#hh-panel`; JS ~7230-9300: state, `loadSettings`, `saveSettings`, `openSettings`, `settingRow`, `openRow`/`closeRow`, `editRows`/`cancelEdit`, `rowForm`/`selectRowForm`/`arrivalForm`, `renderSettings`, `refocus`, `redrawRows`, `pickerAsk`, `openFolderPicker`, the row builders, `renderNasPanel`; and `showView` ~10168-10209 where Settings is entered)

- [ ] **Step 1: State and renderers**

Replace `settingsOpen`/`settingsEdit`/`settingsOpener`/`settingsFocus` with `settingsPage` (`{ key, group, listScroll, returnTo }`), `settingsEditing` (the sub-edit a list page is in, same role as today's `settingsEdit`). Write `renderSettingsList()` and `renderSettingsPage(key)`, a `pageFor(key)` registry mapping each key to `{ title, line, body(page), owner?: true }` built from the existing form functions, and `openPage(key)` / `closePage({ refocus })`. One form builder `fieldsForm({ fields, submit, onSave, cancel })` replaces `rowForm`, `selectRowForm`, `arrivalForm` and the hand-made selects. `saveSettings` keeps its signature but draws only the open page and writes errors to the page slot.

- [ ] **Step 2: Move the rows**

appearance, conflicts, phone (row → opens `#phone-sec`), zone, model, members (list only: Invite comes in Task 2), areas, budget (Savings and balance in place; categories → `#cat-sec`), hcal (the page opens with its choices showing, not a menu: the household calendar select with "Use another calendar" as the select's own option, Rename beneath), guests, documents (the three-step picker as the page body, with its busy line inside the body; focus on the checked radio only on the first draw), links, backup (two actions, no form), remove (Task 2), This NAS rows (`connForm`, with Who may sign in loading its accounts inside the body).

- [ ] **Step 3: Deep links and the picker screen**

`openSettings(group, row)` as the model says; `renderNasPanel` uses the same list and page renderers in `#hh-panel`; delete the `#hh-panel .set-*` CSS overrides when the shared styles cover it.

- [ ] **Step 4: CSS**

`.set-item` (button, full width, title / status / chevron grid, 44px minimum tap height, 16px side gutter at phone width), `.set-page` head and slots, `.set-err`. Remove `.set-row`, `.set-acts`, `.set-form` once nothing uses them. Keep the dark-mode guard pattern the file uses (`data-mode`).

- [ ] **Step 5: Check by hand**

Start the fake DSM and the planner with inline env from this worktree's api/ (DSM on 5599, planner on 5579, data under the scratchpad `run-set` folder; the orchestrator's dispatch gives the two commands). At 375 wide and at desktop: open Settings; tap Documents, see the page from the top with the first radio focused and the keyboard-safe position; Back returns to the list at the same scroll with Documents focused; tap Household calendar, see the select focused; make a save fail (an empty required field) and see the error in the slot with the typed values kept; from Today, press a notice's "Choose a folder" and land on the Documents page; sign in as the administrator and open This NAS rows from the household picker. Stop both servers by pid.

- [ ] **Step 6: Suite, typecheck, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: pass (no server change; the page is not under test).

```bash
git add site/index.html
git commit   # "Settings is a list of pages: one page draws at a time, its form at the top, and Back returns to the list where it was"
```

---

### Task 2: The sheets become pages, labels settle, docs and version

**Files:**
- Modify: `site/index.html` (Invite `panel()` ~2307, Remove `panel()` ~4945, Restore `takeFromBackup` ~2121, `hhPanel` ~10413, the person menu's Settings/phone entries, labels), `README.md` (Settings paragraph where it describes Settings), `api/package.json` + lock (0.5.0)

- [ ] **Step 1: Invite, Remove, Restore as pages**

`members` page: the member list with Remove beside each (owner only) and an Invite form at the foot (name field, Invite button), replacing the `panel()`. `remove` page: the two intro paragraphs, the typed-name field and the red button, exactly the copy that exists today, replacing the `panel()`. `backup` page: Download as a link-styled action and the Restore flow (file field, preview, confirm) as the page body, replacing `takeFromBackup`'s top-of-page card. Delete `hhPanel()` and `#hh-restore` once nothing uses them; `panel()` stays for the Budget screen's own uses.

- [ ] **Step 2: Labels and silent rows**

List statuses are nouns or states (`alex · bob`, `Not chosen`, `Planner/Household`, `On`, `Off`, `Not set`), never verbs; the chevron is the only call to action. Pages' primary buttons are verbs (`Save`, `Choose`, `Invite`, `Remove Wren for good`). Rows a member cannot change open a page that says so under the heading.

- [ ] **Step 3: README and version**

README's Settings mention: one paragraph, that each setting opens as its own page and that Today's reminders open the page they are about. `cd api && npm version 0.5.0 --no-git-tag-version`.

- [ ] **Step 4: Check by hand, suite, commit**

Repeat Task 1's hand check for Members (invite bob, remove bob), Remove (wrong name refused in the slot; do not remove the only household you are testing with unless you made a spare), Restore (preview a backup file you downloaded from the same page). Phone width first.

Run: `cd api && npm test && npm run typecheck`

```bash
git add site/index.html README.md api/package.json api/package-lock.json
git commit   # "Version 0.5.0: Settings opens each setting as its own page, including inviting, restoring and removing"
```
