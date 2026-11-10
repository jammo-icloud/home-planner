# Plan by area Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution:** subagent-driven development (chosen): a fresh implementer per task, a reviewer per task, a whole-branch review at the end. Tasks run in order, one at a time, in one worktree. An implementer sees only its own task, the sections above the first task, and the files the task names.

**Goal:** Release 0.7.0: the Plan board becomes one card of rows per area with the state as a glyph, an area opens its own page, a people bar replaces Both / Mine / Theirs for any number of members, a plan is handed on at once, a plan may carry one goal, and shelves are retired into goals.

**Architecture:** Eight ops join the append-only log (`plan.hand`, `plan.goal`, `goal.rename`, `goal.remove`, `areas.add`, `areas.remove`, `areas.move`, `shelves.retire`) and are folded in `api/src/replay.ts`; the app writes `shelves.retire` by itself when it opens a log that still has a shelf, after copying the log beside itself. `board()` and `card()` in `api/src/plans.ts` are reshaped and `GET /api/plans` answers the board whole. On the page the helpers every screen shares move above the screens first, a text test of `site/index.html` (the page ledger) pins what must survive, and then the board, the Area page and the card are rebuilt on the envelope pages' mechanism: page state in a module variable, an opener, a document Escape listener while open, every async continuation guarded.

**Tech Stack:** Node 22.6+ running TypeScript by type stripping (no build), `node:test`, an append-only JSONL log replayed into state, one vanilla-JS page (`site/index.html`) with `site/tokens.css`. No new source file; one new test, `api/test/page-ledger.test.ts`.

**Spec:** `docs/superpowers/specs/2026-11-09-plan-by-area-design.md` (binding; where this plan and the spec disagree the spec wins, except the Rulings at the end). **Inputs carried into tasks:** `docs/superpowers/design/2026-11-10-redesign-gap-outline.md` (what the code lacks), `docs/superpowers/design/2026-11-10-carry-over-ledger.md` (rows P1 to P68 and S1 to S33), `docs/superpowers/design/2026-11-10-visual-audit.md` (tokens, components, the 0.7.0 list).

Line numbers are the tree's at 0.6.0 (`site/index.html` is 11,356 lines). Task 1 moves about 250 lines up the script, so from Task 2 on find things by name.

## Global Constraints

- Commits: `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit`, the message one plain sentence with no conventional-commit prefix, then a blank line and exactly this trailer, whatever model writes the commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push. Never use the `/usr/bin` git shim or suggest Xcode tools.
- Never commit `api/data/`, `site/budget.jsonl`, `site/transactions.jsonl`, `site/planner.html`, `.env` or `.claude/`. The data is not code.
- The repository is public: nothing in code, tests, docs or commit messages names real people, domains, private IPs, banks, utilities or vendors. Stand-ins are Alex, Bob, Casey, `planner.example.com`, "Example Power". (The test suites' accounts are `alice`, `bob`, `carol`; a third member in a test is `casey`.)
- Never use port 5555. Never `pkill`; stop a server by pid from `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`. A DSM session id or password never goes to disk or a log.
- Page work is checked by hand against the fake DSM, started with inline environment variables, not a `.env` (commands under "Running the page by hand").
- The suite and the typecheck pass after every task: `cd api && npm test` and `cd api && npm run typecheck`. Task 1 records the suite's pass count; no later task ends with fewer than the count before it plus the tests it adds. "Suite, typecheck, commit" below always means those two commands, both clean, then the commit as Task 1 shows it.
- The app's conventions: tools return proposals a person approves; a money-moving edit needs a reason; secondary button first and the primary at the right; 44px hit areas; error slots always rendered; Escape cancels an open form before going Back; a committed change always reloads; every async continuation in the page checks the page it started on is still showing.
- Copy (spec, Copy rules): sentences, no exclamation marks, example placeholders. A count is a number and a noun, singular at one, never "both" or "all". A goal is "toward". Handing is "hand it to", taking is "take it", never "assign" or "ask". Members are named as elsewhere; "you" and "yours" only in sentences, never in the people bar.
- Visual (spec, Visual rules): extend what ships and never paste a wireframe's stylesheet; no new class named `.row`, `.rows`, `.line`, `.plan-head`, `.done`, `.money`, `.over` or `.quiet`; selected is never a tint alone; dashed means only that a person still has to say yes, or a provisional date; no opacity on text.
- The release ends with the version at 0.7.0 in `api/package.json` and its lockfile, and the README and DEPLOY.md saying what the upgrade does (Task 16).

## Running the page by hand

`W` is the worktree's root and `S` a scratch folder outside the repository (the dispatch names both). Run each in the background, with absolute paths:

```bash
mkdir -p $S/run/fake-root
DSM_PORT=5598 FAKE_DSM_ACCOUNTS=alice:correct-horse,bob:battery-staple,casey:paper-lantern FAKE_DSM_ROOT=$S/run/fake-root \
  node --experimental-strip-types $W/api/tools/fake-dsm/server.ts
PORT=5577 COOKIE_INSECURE=1 TZ=America/Denver SITE_DIR=$W/site DSM_URL=http://127.0.0.1:5598 PLANNER_ROOT=/Planner \
  LOG_PATH=$S/run/events.jsonl HOUSEHOLDS_DIR=$S/run/households SESSIONS_PATH=$S/run/sessions.json CONNECTORS_PATH=$S/run/connectors.json \
  node --experimental-strip-types $W/api/src/server.ts
```

Open `http://localhost:5577`. The third account is one more `name:password` pair in `FAKE_DSM_ACCOUNTS` (a test value; the fake DSM accepts whatever it is given). The first time, sign in as alice, make the household "Home", and add bob and casey under Settings, in the household's people. **Three members** in a check means: alice signed in, with at least one plan owned by each of alice, bob and casey (made as alice and, until Task 15, moved with `curl -b` and the session cookie, or by signing in as each). Stop both by pid: `kill $(lsof -nP -iTCP:5577 -sTCP:LISTEN -t)` and the same for 5598. A page check is done at 390 wide and at desk width (1280), in dark and in light; where a task says Graphite, set it under Settings, Appearance.

## Reused, not rebuilt

- **The envelope page's mechanism** (`site/index.html` ~3598-3720): `envelopePage`, `openEnvelopePage`, `closeEnvelopePage`, `clearEnvelopePage`, `envPageEscape`. The Area page and the card copy its rules: the scroll saved on open, `window.scrollTo({ top: 0 })` once, focus with `preventScroll: true`, a document Escape listener only while open that ignores `#cat-sec`, `#phone-sec` and targets outside the page, and a `page === <state>` check after every `await`.
- **The envelope page's frame and forms:** `envFrame`, `envSection`, `envLine` (`.ep-line`, `.ep-t`), `epField` (`.ep-f`), `epErr()` giving `{ err, say }`, `.ep-form`, `.ep-acts` (Cancel first, primary last, Cancel carrying `data-cancel`), `.ep-review` with `.effects`, `.ep-foot` with `.link` buttons, `.back`.
- **Shipped components** (visual audit, "Components"): `.list` is the area card; `.erow` the row; `.area-head` the heading; `.seg` the people bar; `.filters button` a goal chip (ink-filled when pressed, `:482`); `.add-row` "A new area"; `.check` the radio list; `.who` the member disc; `.chip` a free chip; `.crumb`, `.page-head`, `.set-line`.
- **Shared page helpers:** `$`, `node`, `api`, `showProblem`, `icon`, `lucide`, `chip`, `textBtn`, `actionButton`, `inlineForm`, `need`, `dueText`, `blockText`, `staleChip`, `showsClock`, `fmtDate`, `nameOf`, `nameIn`, `planPath`, `cardSection`, `cardEdit`, `postFrom`, the household clock (`keyAt`, `todayKey`, `keyWords`, `clockOf`), `reloadView`, `showView`.
- **Server:** `validatePlan`, `validateSettings`, `refusalsFor`, `livePlan`, `lapseAsk`, `refuseUnknownArea`, `markPages` (`replay.ts`); `required`, `planTitle`, `knownArea`, `livePlan`, `PLAN_LIMITS` (`plan-rules.ts`); `writePlan`, `fresh`, `refusedAs400` (`plan-edits.ts`); `cardOf`, `live` (`plans.ts`); `planStamp`, `ctx.proposals.put`, `describe` (`tools.ts`); `scopeOf`, `parseBackup`, `planRestore` (`restore.ts`); `Store.append`, `Store.adopt`; `softwareVersion()`.
- **Tests:** the `store()`, `create()`, `refused()`, `askCard()`, `eventsOf()` helpers of `api/test/plans.test.ts`; `call()`, `make()`, `log()` of `server-plans.test.ts`; the `s` store of `settings-log.test.ts`; `planCtx()` of `tools.test.ts`; `dir()` and `fresh()` of `households.test.ts`.

## Review Focus

Written for the failure the owner named: "there were several UI elements that were not brought over". A reviewer rejects a task for any of these, whatever else is right.

1. **An element dropped.** Every Kept and Changed row of the ledger's Plan section is still drawn. Pinned by `api/test/page-ledger.test.ts` (Task 2, tightened in Tasks 3 and 9 to 16) and by each page task's row checklist, which the reviewer ticks row by row against the running page, not against the diff.
2. **A two-member assumption left in.** Nothing reads "Theirs", "both", "the two of", "each other" or "partner" on Plan, and no code picks "the other member". Pinned by server tests that use a third member, casey (Tasks 4 and 10), by every page check being done with three members, and by the sweep's grep (Task 16).
3. **A selected state shown by tint alone.** A pressed person, a pressed goal chip, a checked radio and a Doing row read in Graphite, light and dark, with no hue. Checked in Tasks 9, 11, 13 and 15.
4. **A control under 44px.** Bar buttons, chips, an area's heading, the done row, Back, crumb links and foot links have a 44px hit area whatever they are drawn at. Measured with the snippet in Task 9, again in Tasks 11 to 16.
5. **An old log or backup that no longer opens.** A 0.6.0 log replays to the same state plus stated defaults (Task 4, `old-log.test.ts`), a log with shelves opens, is copied and is retired once (Task 7), a backup holding 0.7.0's ops restores and one holding an unknown op is refused whole (Task 7), and a 0.6.0 log is upgraded by hand (Task 16).

---

### Task 1: The shared helpers move above the screens, and nothing else changes

**Files:**
- Modify: `site/index.html` (cut from ~6451-6548, ~6664-6690, ~6700-6759, ~10172-10196, ~10213, ~10295-10331; paste before ~2208 and before ~2650)

**Interfaces:**
- Produces: a region headed `// ── shared: what every screen calls ──` immediately above `// ── today ──`. Later tasks add `BUILD`, `memberDisc`, `stateGlyph`, `goalFlag`, `peopleBar`, `pressPerson` and `cancelOpen` to it. No name, body or comment inside a moved block changes.

- [ ] **Step 1: Move these blocks, whole and in this order, into the new region.** Each goes with the comments directly above it. Every move is upward, so no top-level use can come before its declaration.
  1. From the Plan region's top: `members`, `inSandbox`, `attachmentsOn`, `attachmentsWhy`, `keepFilesFrom`, `otherMember`, `planPath`. Leave `planFilter`, `planShowDone`, `planAreas`, `planRows`, `cardId` and `LANES` where they are.
  2. `ICONS`, `icon`, `LUCIDE`, `lucide`, `whoDisc`, `chip`, `thisMonth`, `dueText`, `dayMonth`, `blockText`, `staleChip`, `showsClock`, `dollars`. Leave `laneLabel`.
  3. `inlineForm` and `need`.
  4. From the Calendar region: the comment block "days where the household is", `householdTz`, `zoneFormats`, `inZone`, `keyAt`, `todayKey`, `addDayKey`, `mondayOf`, `keyWords`, `keyDate`, `clockOf`. Leave `zoneOffset`, `wallMs`, `hoursIn` and `SPAN`: they read `CAL_OPEN`.
  5. `filterBeforeDetour` and `openTodayAt`.

  Separately, move `askAnswer` to sit directly above `askCardNode` in Today's region: Today's ask card is its only caller that survives this release (ledger S7).
- [ ] **Step 2: Prove it was only a move.**
```bash
cd $W && diff <(/opt/homebrew/bin/git show HEAD:site/index.html | LC_ALL=C sort) <(LC_ALL=C sort site/index.html)
node -e "const fs=require('fs');const s=fs.readFileSync('$W/site/index.html','utf8');fs.writeFileSync('$S/page.mjs',s.slice(s.indexOf('<script type=\"module\">')+22,s.lastIndexOf('</script>')))" && node --check $S/page.mjs
```
Expected from `diff`: nothing but `>` lines for the new region's heading comment (four at most) and empty lines; any other line is an edit, to be undone. Expected from `node --check`: no output.
- [ ] **Step 3: Check by hand that every screen still boots.** Start both servers. Signed in as alice at 390 and at desk width, with the console open: Today draws with its rail's discs; Plan draws the board, a card opens, "Due date" opens its form and Escape closes it; Calendar draws a week and a day, and an event's time reads in household time; Budget opens an envelope's page; Settings opens. Sign out and in again. Expected: no error in the console on any of them (a `ReferenceError` here is a declaration left below its use). Stop both by pid.
- [ ] **Step 4: Suite, typecheck, commit.** Run `cd api && npm test && npm run typecheck`: all pass, typecheck clean. Put the pass count in the commit's body as "Suite: N tests."
```bash
/opt/homebrew/bin/git add site/index.html
/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit   # "The helpers every screen shares sit in one region above the screens, moved and not changed"
```
Every later task commits the same way, with the trailer from Global Constraints; its last step gives the files and the sentence.

### Task 2: The page ledger test, in a form the page passes today

**Files:**
- Create: `api/test/page-ledger.test.ts`

**Interfaces:**
- Produces: four lists later tasks append to, by name: `KEPT`, `ADDED`, `GONE` (each `readonly [row: string, text: string][]`) and `GONE_FROM_PLAN_MARKUP` (`string[]`). A page task is not done until the entries it is told to add pass. Where a later task lists bare strings to add, each is one entry whose row is the label that task gives.

- [ ] **Step 1: Write the test.**
```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = read('../../site/index.html');
const at = page.indexOf('<script type="module">');
const markup = page.slice(0, at);
const script = page.slice(at, page.lastIndexOf('</script>'));
const server = read('../src/server.ts').replaceAll('\\/', '/');
const tools = read('../src/tools.ts');
/** Plan's own markup: "Mine" and "Theirs" stay in Today's filters until 0.8.0. */
const planMarkup = markup.slice(markup.indexOf('<div id="plan"'), markup.indexOf('<div id="plan-card"'));
type Line = readonly [row: string, text: string];
/** On the page before 0.7.0 and after it: the ledger's Kept rows, and what other screens lean on. */
const KEPT: readonly Line[] = [
  ['P1', '<h1>Plan</h1>'], ['P24', 'Mark done'], ['P29', 'Change the due date'], ['P29', 'Set the due date'], ['P30', 'Block time'], ['P30', 'Block it'],
  ['P31', 'Add a chip'], ['P31', 'e.g. researching'], ['P34', 'What this is, and anything worth remembering about it'], ['P36', 'Add a step'],
  ['P36', 'No steps yet.'], ['P36', 'The next step'], ['P37', 'Take it off'], ['P39', 'Attachments are off.'], ['P40', 'Sign in again to add files.'],
  ['P41', 'Drop files here, or choose them'], ['P42', 'is over 25 MB'], ['P46', 'Nothing from Claude on this card yet.'], ['P47', 'Ask Claude about this card'],
  ['P48', "Claude isn't set up on this server."], ['P49', 'Nothing said about this yet.'], ['P49', 'Leave a note'], ['P52', 'Change the money'],
  ['P53', 'Estimated cost'], ['P53', 'At current funding'], ['P56', 'No one is linked to this card yet.'], ['P56', 'Link someone from Contacts'],
  ['P57', 'Search Contacts by name'], ['P58', 'Sign in again to reach Contacts.'], ['P59', 'Let it go'], ['P60', 'Put it on the calendar'],
  ['P61', "cardSection('History'"], ['P62', 'Remove this plan'], ['P62', 'Why remove it? The log keeps it, and your reason.'],
  ['P64', 'id="loading"'], ['P64', 'id="app-err"'], ['P64', 'Reading the log'], ['S7', 'function askAnswer('], ['S7', 'function askCardNode('],
  ['S7', 'Waiting for you'], ['S9', 'const otherMember'], ['S15', 'async function eventPlans('], ['S18', 'function railChips('], ['S11', 'const clockOf'],
  ['S11', 'const todayKey'], ['S5', 'async function openTodayAt('], ['S2', 'async function reloadView('], ['S6', 'function actionButton('],
  ['shared', 'function icon('], ['shared', 'function lucide('], ['shared', 'function chip('], ['shared', 'function inlineForm('],
  ['card', 'function renderCard('], ['card', 'function checklistSection('], ['card', 'function attachmentsSection('], ['card', 'function claudeSection('],
  ['card', 'function betweenSection('], ['card', 'function moneySection('], ['card', 'function peopleSection('], ['card', 'function whenSection('],
  ['card', 'function factsCard('], ['card', 'async function openCard('],
];
/** What 0.7.0 brings, and what it deletes (the spec's "What is deleted"). Each page task adds its lines before it does the work. */
const ADDED: readonly Line[] = [];
const GONE: readonly Line[] = [];
const GONE_FROM_PLAN_MARKUP: readonly string[] = [];
/** Ids reached for at the top level that a function draws before anything asks for them: each named with who draws it. */
const DRAWN_LATER: readonly string[] = [];

describe('the page ledger: Plan, 0.7.0', () => {
  test('every id the script reaches for at load is in the markup', () => {
    const ids = new Set([...script.matchAll(/^\S.*?\$\('([\w-]+)'\)/gm)].map((m) => m[1]!));
    assert.ok(ids.size >= 10, 'the pattern still finds the top-level lookups');
    assert.deepEqual([...ids].filter((id) => !markup.includes(`id="${id}"`) && !DRAWN_LATER.includes(id)), []);
  });
  for (const [name, list, want] of [['kept', KEPT, true], ['added', ADDED, true], ['gone', GONE, false]] as const) {
    test(`what the ledger marks ${name}`, () => {
      assert.deepEqual(list.filter(([, text]) => page.includes(text) !== want).map(([row, text]) => `${row}: ${text}`), []);
    });
  }
  test("Plan's markup has lost the old board's words", () => {
    assert.deepEqual(GONE_FROM_PLAN_MARKUP.filter((text) => planMarkup.includes(text)), []);
  });
  test('every route the page calls is one the server answers', () => {
    const called = new Set([...script.matchAll(/['"`](\/api\/[a-z0-9_/-]*)/g)].map((m) => m[1]!.replace(/\/$/, '')));
    assert.deepEqual([...called].filter((route) => (route.startsWith('/api/tools/')
      ? !tools.includes(`name: '${route.slice('/api/tools/'.length)}'`) : !server.includes(route))), []);
    const subs = new Set([...script.matchAll(/planPath\([^()]*?, ['`]\/([a-z-]+)/g)].map((m) => m[1]!));
    const answered = (/\((state\|[a-z|-]+)\)/.exec(server)?.[1] ?? '').split('|');
    assert.deepEqual([...subs].filter((sub) => !answered.includes(sub)), []);
  });
});
```
- [ ] **Step 2: Run it against the page as it is.** Run: `cd api && node --test --experimental-strip-types test/page-ledger.test.ts`. Expected: PASS (its patterns were run against the 0.6.0 page while this plan was written and found nothing missing: 15 ids at load, 12 plan sub-routes). If the load test names an id after Task 1, read the line: an id a function draws goes in `DRAWN_LATER` with a comment naming the function; an id that is truly missing is a bug to report, not to list.
- [ ] **Step 3: Prove it can fail.** Add `['P0', 'no such words on this page']` to `KEPT`, run, expect FAIL naming `P0: no such words on this page`; remove it. Add `['P0', 'Mark done']` to `GONE`, run, expect FAIL; remove it.
- [ ] **Step 4: Suite, typecheck, commit** `api/test/page-ledger.test.ts`: "A text test of the page pins what Plan's rebuild must keep, add and delete."

### Task 3: A page from another build is told to reload

**Files:**
- Modify: `api/src/version.ts`, `api/src/server.ts` (~1771), `site/index.html` (`:30`, `api()` ~2062, `showProblem` ~4661), `api/test/server-plans.test.ts`, `api/test/page-ledger.test.ts`

**Interfaces:**
- Produces: `export const STALE = 'Home Planner has been updated. Reload.'` in `api/src/version.ts` (Tasks 8 and 10 answer with it).
- Produces: on the page, `const BUILD = '0.6.0';` as the first line of the shared region, and the stylesheet link `/tokens.css?v=0.6.0`. Task 16 moves all three to 0.7.0 with the package.

- [ ] **Step 1: Write the failing tests.** In `api/test/server-plans.test.ts`, inside `describe('the plan routes')`:
```ts
test('a page from another build is told to reload before any route runs; no build passes', async () => {
  const { softwareVersion } = await import('../src/version.ts');
  const ask = (build?: string, path = '/api/plans') =>
    fetch(base + path, { headers: { cookie: cookies['alice']!, ...(build ? { 'x-hp-build': build } : {}) } });
  const stale = await ask('0.0.1');
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'Home Planner has been updated. Reload.', stale: true });
  assert.equal((await ask(softwareVersion().version)).status, 200);
  assert.equal((await ask()).status, 200);                              // the guest page and scripts send none
  assert.equal((await ask('0.0.1', '/api/no-such-route')).status, 409);  // before the route is even looked for
});
```
In `api/test/page-ledger.test.ts`, add `['build', "'x-hp-build': BUILD"]` to `ADDED` and this test:
```ts
test('the page, its stylesheet and the package are one build', () => {
  const version = (JSON.parse(read('../package.json')) as { version: string }).version;
  assert.equal(/^const BUILD = '([^']+)';$/m.exec(script)?.[1], version);
  assert.equal(/href="\/tokens\.css\?v=([^"]+)"/.exec(markup)?.[1], version);
});
```
Run: `cd api && node --test --experimental-strip-types test/server-plans.test.ts test/page-ledger.test.ts`. Expected: FAIL (200 where 409 is wanted; `undefined !== '0.6.0'`).
- [ ] **Step 2: The server.** In the request handler, directly after `if (!path.startsWith('/api/')) return serveStatic(url.pathname, res);` and before the session is read: when the request has an `x-hp-build` header and it is not `softwareVersion().version`, answer `json(res, 409, { error: STALE, stale: true })`. The guest door, the phone's setup link and static files are above it and never see it.
- [ ] **Step 3: The page.** `api()` sends `'x-hp-build': BUILD` on every request. When an answer has `stale === true` it throws as now, with `stale: true` on the error. `showProblem(ex)`, for an error with `stale`, draws the sentence in `#app-err` (class `err`) followed by one `textBtn('Reload', 'btn', null, () => location.reload())`, and returns. It never reloads by itself: a page whose `BUILD` is wrong would loop. Change the link at `:30` to `/tokens.css?v=0.6.0`.
- [ ] **Step 4: Check by hand.** Start both servers and open the page. Stop the planner, change `"version"` in `$W/api/package.json` to `0.6.1` (do not commit it), start the planner, and press a tab on the page still open. Expected: the error box reads "Home Planner has been updated. Reload." with a Reload button, at 390 and on the desk, dark and light; the button reloads the page, which then shows the same box (its `BUILD` is still 0.6.0). Put the version back, restart, reload: the app works. Stop both by pid.
- [ ] **Step 5: Suite, typecheck, commit** `api/src/version.ts api/src/server.ts site/index.html api/test/server-plans.test.ts api/test/page-ledger.test.ts`: "A page left open across an upgrade is told to reload, and the stylesheet is linked by version."

### Task 4: A plan is handed on: `plan.hand`, the owner fields and `state.hands`

**Files:**
- Modify: `api/src/types.ts` (`Event` ~586, `Plan` ~964, `State` ~1118), `api/src/plan-rules.ts` (`PLAN_LIMITS`), `api/src/replay.ts` (`Draft` ~62, `emptyDraft`, `freeze`, `thaw`, `validatePlan` ~653, `member.remove` ~1282, `plan.create` ~1551, `plan.ask.accept` ~1620), `api/src/tools.ts` (`describe` ~839), `api/src/restore.ts` (`scopeOf` ~57, the outsiders walk ~222), `api/src/thread.ts` (`ThreadEntry` ~45, `PLAN_LINES` ~106, the change entry ~221)
- Test: `api/test/plans.test.ts`, `api/test/old-log.test.ts`, `api/test/households.test.ts`

**Interfaces:**
- Produces: `{ op: 'plan.hand'; plan: PlanId; to: Actor; why?: string }` in `Event`. Not in `REQUIRES_WHY` or `CLAUDE_MAY`.
- Produces: `Plan` gains `readonly goal: string | null` (always null until Task 5), `readonly ownerSince: string`, `readonly ownerFrom: Actor | null`.
- Produces: `export interface Hand { readonly plan: PlanId; readonly from: Actor; readonly to: Actor }` and `State.hands: ReadonlyMap<EventId, Hand>`, keyed by the `plan.hand` event.
- Produces: `PLAN_LIMITS` gains `goal: 60` and `why: 300`. A thread `change` entry gains `hand?: { plan: PlanRef; from: Actor; to: Actor }`.

- [ ] **Step 1: Write the failing tests.** In `api/test/plans.test.ts` (import `thread` from `../src/thread.ts`; add `'plan.hand'` to `PLAN_OPS` and its count):
```ts
describe('handing a plan on', () => {
  const gate = create('gate', { title: 'Fix the fence gate' });
  const LATER = '2026-11-09T10:00:00.000Z';
  const owned = (s: Store, id = 'gate') => { const p = s.state.plans.get(id)!; return [p.owner, p.ownerSince, p.ownerFrom]; };
  test('any member gives one away, takes one, or moves one between two others', async () => {
    const { s, at } = await store();
    await s.append('alice', [{ op: 'member.add', member: 'casey', why: 'moved in' }, gate, { op: 'plan.state', plan: 'gate', state: 'doing' }]);
    assert.deepEqual([...owned(s), s.state.plans.get('gate')!.goal], ['alice', NOW, null, null]);
    at(LATER);
    const [gave] = await s.append('alice', { op: 'plan.hand', plan: 'gate', to: 'bob', why: 'you have the drill' });
    assert.deepEqual(owned(s), ['bob', LATER, 'alice']);
    assert.deepEqual([s.state.plans.get('gate')!.state, s.state.plans.get('gate')!.stateAt], ['doing', NOW]);   // the Doing clock is untouched
    const [took] = await s.append('alice', { op: 'plan.hand', plan: 'gate', to: 'alice' });
    const [moved] = await s.append('casey', { op: 'plan.hand', plan: 'gate', to: 'bob' });
    assert.deepEqual([gave, took, moved].map((e) => s.state.hands.get(e!.id)), [
      { plan: 'gate', from: 'alice', to: 'bob' }, { plan: 'gate', from: 'bob', to: 'alice' }, { plan: 'gate', from: 'alice', to: 'bob' }]);
    assert.deepEqual([gave, took, moved].map((e) => describeEvent(e!, s.state).what), [
      'handed Fix the fence gate to bob', 'took Fix the fence gate from bob', 'handed Fix the fence gate from alice to bob']);
    assert.deepEqual([describeEvent(gave!, s.state).why, scopeOf(gave!)], ['you have the drill', 'plans']);
  });
  test('the fold refuses a hand that moves nothing, an outsider at either end, a long word and a removed plan', async () => {
    const { s } = await store();
    await s.append('alice', gate);
    const hand = (who: string, extra: Record<string, unknown>) => s.append(who, { op: 'plan.hand', plan: 'gate', to: 'bob', ...extra } as NewEventShape);
    await assert.rejects(hand('bob', { to: 'alice' }), refused(/Fix the fence gate is already alice's/));
    await assert.rejects(hand('alice', { to: 'casey' }), refused(/casey is not in this household/));
    await assert.rejects(hand('carol', {}), refused(/carol is not a member of this household/));
    await assert.rejects(hand('alice', { why: 'x'.repeat(301) }), refused(/a reason is longer than 300 characters/));
    await s.append('alice', { op: 'plan.remove', plan: 'gate', why: 'sold the house' });
    await assert.rejects(hand('alice', {}), refused(/has been removed/));
  });
  test('a hand settles an open ask, and is still there after another write and after a reload', async () => {
    const { s } = await store();
    await s.append('alice', [gate, { op: 'plan.ask', plan: 'gate', to: 'bob', why: 'you have the drill' }]);
    await s.append('alice', askCard('gate'));
    const [hand] = await s.append('bob', { op: 'plan.hand', plan: 'gate', to: 'bob' });
    assert.deepEqual([s.state.plans.get('gate')!.asked, [...s.state.thread.offers.values()][0]!.status], [null, 'replaced']);
    await s.append('alice', { op: 'plan.set', plan: 'gate', chips: ['fence'] });      // a thaw and a freeze
    for (const state of [s.state, replay(eventsOf(s))]) assert.deepEqual(state.hands.get(hand!.id), { plan: 'gate', from: 'alice', to: 'bob' });
  });
  test('taking an ask, and losing a member, stamp the owner fields too', async () => {
    const { s, at } = await store();
    await s.append('alice', [gate, create('shed'), { op: 'plan.ask', plan: 'gate', to: 'bob', why: 'yours?' }]);
    at(LATER);
    await s.append('bob', { op: 'plan.ask.accept', plan: 'gate' });
    assert.deepEqual(owned(s), ['bob', LATER, 'alice']);
    await s.append('alice', { op: 'member.remove', member: 'bob', why: 'moved out' });
    assert.deepEqual([owned(s), owned(s, 'shed')], [['alice', LATER, 'bob'], ['alice', NOW, null]]);
  });
  test('Today says a hand in one line that names both ends, with the word as its reason', async () => {
    const { s } = await store();
    await s.append('alice', gate);
    const [hand] = await s.append('alice', { op: 'plan.hand', plan: 'gate', to: 'bob', why: 'you have the drill' });
    const e = (await thread(s, { who: 'bob', budget: null })).entries.find((x) => x.id === hand!.id)!;
    assert.ok(e.kind === 'change');
    assert.deepEqual([e.what, e.why, e.hand], ['handed Fix the fence gate to bob', 'you have the drill',
      { plan: { id: 'gate', title: 'Fix the fence gate' }, from: 'alice', to: 'bob' }]);
  });
});
```
(If `ThreadOptions` wants more than `who` and `budget`, give what `api/test/thread-view.test.ts` gives.) In `api/test/households.test.ts`, inside `describe('plans and settings in a backup')`:
```ts
test('a plan handed to someone who is not a member here is named, and nothing is restored', async () => {
  const hh = new Households(await dir());
  const source = await hh.create('alice', 'Rivera');
  await source.store.append('alice', [{ op: 'member.add', member: 'carol', why: 'sister' },
    { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' }, { op: 'plan.hand', plan: 'gate', to: 'carol' }]);
  const { store } = await fresh();
  const plan = planRestore(store.state, parseBackup(await readFile(source.store.path, 'utf8')), ['plans']);
  assert.deepEqual(plan.collisions.map((c) => [c.kind, c.what]), [['owner', 'carol']]);
  assert.match(plan.collisions[0]!.why, /plans handed to them: add carol as a member first/);
});
```
In `api/test/old-log.test.ts`: add `hands: []` to `ADDED`, and before the snapshot comparison let the plan's new fields through with their stated defaults, leaving the snapshot file untouched:
```ts
for (const [, p] of state['plans'] as [string, Record<string, unknown>][]) {
  assert.deepEqual([p['goal'], p['ownerFrom'], p['ownerSince']], [null, null, p['createdAt']], "a plan from an old log has no goal and was always its maker's");
  for (const key of ['goal', 'ownerFrom', 'ownerSince']) delete p[key];
}
```
Run: `cd api && node --test --experimental-strip-types test/plans.test.ts test/households.test.ts test/old-log.test.ts`. Expected: FAIL (`plan.hand` is an unknown op; `hands` is undefined).
- [ ] **Step 2: Types and validation.** Add the op, the three `Plan` fields, `Hand` and `State.hands` as in Interfaces. `validatePlan` gains `case 'plan.hand'`: `to` is named ("who it is handed to cannot be empty"); `why`, when present, is text of at most `PLAN_LIMITS.why` ("a reason is longer than 300 characters"). `scopeOf` puts `plan.hand` in `plans`.
- [ ] **Step 3: The fold.** `hands: Map<EventId, Hand>` joins `Draft`, `emptyDraft`, `freeze` and `thaw` (all four: a field missed in `thaw` loses every hand on the next append, which the third test catches). `plan.create` sets `goal: null`, `ownerSince: e.at`, `ownerFrom: null`. `plan.hand`, for a live plan: refuse `${p.title} is already ${e.to}'s` when `e.to === p.owner`, and `${e.to} is not in this household` when `e.to` is no member; then record `{ plan, from: p.owner, to: e.to }` under `e.id` and close any ask through `lapseAsk(d, { ...p, owner: e.to, ownerSince: e.at, ownerFrom: p.owner }, e)`. State, `stateAt` and the calendar links are not touched. `plan.ask.accept` and the takeover in `member.remove` set `ownerSince: e.at` and `ownerFrom` to the previous owner in the object they hand `lapseAsk`.
- [ ] **Step 4: The sentence, the thread and restore.** `describe()`, for `plan.hand`, reads `state?.hands.get(e.id)`: "handed T to B" when `from === e.who`, "took T from A" when `to === e.who`, "handed T from A to B" otherwise, and "handed T to B" with no state. `plan.hand` joins `PLAN_LINES`; the change entry for one carries `hand: { plan: { id, title }, from, to }` from `state.hands`. In `planRestore`'s outsiders walk the map's value becomes `'made' | 'asked' | 'handed'`, a `plan.hand` names `e.to` as `'handed'`, and the collision reads "plans handed to them".
- [ ] **Step 5: Run to see them pass, then the suite.** The typecheck names any exhaustive switch still missing the op. Tests elsewhere that compare a whole plan gain the three fields.
- [ ] **Step 6: Commit** the six source files, the three tests and any test adjusted: "Any member hands a plan on at once, and a plan says since when it is its owner's and from whom."

### Task 5: Goals in the log

**Files:**
- Modify: `api/src/types.ts` (`Event`, `planShaped` ~724), `api/src/plan-rules.ts`, `api/src/plans.ts`, `api/src/replay.ts` (`validate` ~327, `validatePlan`, the plan folds), `api/src/tools.ts` (`describe`), `api/src/restore.ts` (`scopeOf`), `api/src/thread.ts` (`PLAN_LINES`)
- Test: `api/test/plans.test.ts`

**Interfaces:**
- Consumes: `Plan.goal`, `PLAN_LIMITS.goal` (Task 4).
- Produces: `{ op: 'plan.goal'; plan: PlanId; goal: string | null }`, `{ op: 'goal.rename'; from: string; to: string }`, `{ op: 'goal.remove'; goal: string }`. `planShaped` is true for the two `goal.` ops by name, so only members write them.
- Produces, in `plan-rules.ts`: `goalLabel(v: unknown): string` (trimmed, inner runs of space made one, 1 to 60 characters, else a `ToolError`: "a goal needs a name", "a goal is longer than 60 characters"); `sameGoal(a: string, b: string): boolean` (equal ignoring case; the one place that rule lives); `goalSpelling(plans: Iterable<Plan>, label: string): string | null` (the spelling on the first plan, not removed, that carries a matching goal).
- Produces, in `plans.ts`: `goalsOf(state: State): { goal: string; plans: number; done: number }[]`, every goal on a live plan in any state, alphabetical ignoring case.

- [ ] **Step 1: Write the failing tests** in `api/test/plans.test.ts` (import `goalsOf`; add the three ops to the scope test's list):
```ts
describe('goals', () => {
  const toward = (plan: string, goal: string | null): NewEventShape => ({ op: 'plan.goal', plan, goal });
  const goalOf = (s: Store, ...ids: string[]) => ids.map((id) => s.state.plans.get(id)!.goal);
  test('a goal begins when a plan carries it, keeps its first spelling, and is allowed in any state', async () => {
    const { s } = await store();
    await s.append('alice', [create('p1'), create('p2'), toward('p1', 'New roof'), toward('p2', 'new ROOF')]);
    assert.deepEqual(goalOf(s, 'p1', 'p2'), ['New roof', 'New roof']);
    const was = s.state.plans.get('p1');
    await s.append('alice', [toward('p1', 'New roof'), create('p3'), toward('p3', null)]);   // the same again, and none off none
    assert.equal(s.state.plans.get('p1'), was);
    await s.append('bob', [{ op: 'plan.state', plan: 'p2', state: 'done' }, toward('p2', null), toward('p2', 'New roof')]);
    assert.deepEqual(goalsOf(s.state), [{ goal: 'New roof', plans: 2, done: 1 }]);
    for (const bad of [' New roof', 'New  roof', '', 'x'.repeat(61)]) {
      await assert.rejects(s.append('alice', toward('p3', bad)), refused(/a goal is 1 to 60 characters, with single spaces and none around it/));
    }
    await s.append('alice', { op: 'plan.remove', plan: 'p1', why: 'sold the house' });
    await assert.rejects(s.append('alice', toward('p1', null)), refused(/has been removed/));
    assert.deepEqual(goalsOf(s.state), [{ goal: 'New roof', plans: 1, done: 1 }]);     // a removed plan's goal counts for nothing
  });
  test('a goal is renamed and removed on every plan that carries it, and never merged', async () => {
    const { s } = await store();
    await s.append('alice', [create('p1'), create('p2'), create('p3'), toward('p1', 'New roof'), toward('p2', 'New roof'), toward('p3', 'Summer trip')]);
    const rename = (who: string, from: string, to: string) => s.append(who, { op: 'goal.rename', from, to });
    await assert.rejects(rename('alice', 'Old roof', 'Roof'), refused(/there is no goal called Old roof/));
    await assert.rejects(rename('alice', 'New roof', 'summer trip'), refused(/"Summer trip" is already a goal/));
    await assert.rejects(rename('alice', 'new roof', 'New roof'), refused(/New roof is already its name/));
    await assert.rejects(rename('carol', 'New roof', 'Roof'), refused(/carol is not a member of this household/));
    const [renamed] = await rename('bob', 'new roof', 'NEW ROOF');                       // a change of case alone is a rename
    assert.deepEqual(goalsOf(s.state), [{ goal: 'NEW ROOF', plans: 2, done: 0 }, { goal: 'Summer trip', plans: 1, done: 0 }]);
    const [removed] = await s.append('bob', { op: 'goal.remove', goal: 'new roof' });
    assert.deepEqual(goalOf(s, 'p1', 'p2', 'p3'), [null, null, 'Summer trip']);
    await assert.rejects(s.append('bob', { op: 'goal.remove', goal: 'New roof' }), refused(/there is no goal called New roof/));
    const said = ['renamed the goal new roof to NEW ROOF', 'removed the goal new roof'];
    assert.deepEqual([renamed, removed].map((e) => describeEvent(e!, s.state).what), said);
    const lines = (await thread(s, { who: 'alice', budget: null })).entries.flatMap((e) => (e.kind === 'change' ? [e.what] : []));
    assert.deepEqual(lines.filter((w) => /goal/.test(w)), said);                          // and setting one on a plan is no line
  });
});
```
Run: `cd api && node --test --experimental-strip-types test/plans.test.ts`. Expected: FAIL (`goalsOf` is not exported; unknown op).
- [ ] **Step 2: The rule and validation.** Write the three functions in `plan-rules.ts` and `goalsOf` in `plans.ts`. `validatePlan` gains `case 'plan.goal'`: `goal` is null, or text already in the form `goalLabel` gives, else a `ReplayError` "a goal is 1 to 60 characters, with single spaces and none around it". A new `validateGoals(e)`, called from `validate()` beside `validatePlan`, holds `goal.rename` (`from` and `to`) and `goal.remove` (`goal`) to the same form and sentence. The doors (Task 8) tidy what a person typed with `goalLabel`; the fold never tidies.
- [ ] **Step 3: The folds, the sentences, the scope and the thread.** `plan.goal`: a live plan; a label that matches an existing goal takes `goalSpelling`'s answer; the plan is left as the same object when nothing changes. `goal.rename`: refuse "there is no goal called F" when none matches `from`; `"G" is already a goal` when `to` matches a different goal; "G is already its name" when `to` is exactly the stored spelling; else every live plan carrying it takes `to`. `goal.remove`: refuse when none matches; else every live plan carrying it has none. `describe()`: "set T toward G", "took the goal off T", "renamed the goal F to G", "removed the goal G" (F and G as the event wrote them). All three are in the `plans` scope. `goal.rename` and `goal.remove` join `PLAN_LINES`; `plan.goal` does not (it shows on the card's History, as chips do).
- [ ] **Step 4: Run to see them pass; suite, typecheck, commit** the seven source files and the test: "A plan may carry one goal, and a goal is renamed or removed for every plan that carries it."

### Task 6: An area is added, moved and removed by name

**Files:**
- Modify: `api/src/types.ts` (`Event` ~532), `api/src/replay.ts` (`validateSettings` ~482, the folds ~1393), `api/src/tools.ts` (`describe` ~803), `api/src/restore.ts` (`scopeOf` ~48, the area walk ~262), `api/src/activity.ts` (`NOT_A_CHANGE` ~30), `api/src/server.ts` (~2273, and the route list in its header comment)
- Test: `api/test/settings-log.test.ts`, `api/test/server-settings.test.ts`, `api/test/households.test.ts`

**Interfaces:**
- Produces: `{ op: 'areas.add'; area: string }`, `{ op: 'areas.remove'; area: string }`, `{ op: 'areas.move'; area: string; to: number }` (`to` is the index it ends at). `areas.set` and `areas.rename` stay exactly as they are.
- Produces: `POST /api/settings/areas/add { area }`, `.../remove { area }`, `.../move { area, to }`, each answering `{ areas: string[] }`.

- [ ] **Step 1: Write the failing tests.** `api/test/settings-log.test.ts`:
```ts
describe('areas, one at a time', () => {
  const areas = () => [...s.state.settings.areas];
  test('add, move and remove change the list, and nothing when it is already so', async () => {
    await s.append('alice', { op: 'areas.set', areas: ['House', 'Money', 'Trips'] });
    await s.append('bob', { op: 'areas.add', area: 'Garden' });
    assert.deepEqual(areas(), ['House', 'Money', 'Trips', 'Garden']);
    await s.append('bob', [{ op: 'areas.add', area: 'garden' }, { op: 'areas.remove', area: 'Attic' }, { op: 'areas.move', area: 'Garden', to: 99 }]);
    assert.deepEqual(areas(), ['House', 'Money', 'Trips', 'Garden']);
    await s.append('bob', { op: 'areas.move', area: 'Garden', to: 0 });
    assert.deepEqual(areas(), ['Garden', 'House', 'Money', 'Trips']);
    await s.append('bob', { op: 'areas.remove', area: 'Garden' });
    assert.deepEqual(areas(), ['House', 'Money', 'Trips']);
  });
  test('the fold refuses an area that holds a plan in any state, the last area, a bad name and a move of nothing', async () => {
    await s.append('alice', [{ op: 'areas.set', areas: ['House', 'Money'] },
      { op: 'plan.create', plan: 'p1', title: 'Paint', area: 'House' }, { op: 'plan.state', plan: 'p1', state: 'done' }]);
    const refuses = (e: NewEventShape, re: RegExp) => assert.rejects(() => s.append('alice', e), re);
    await refuses({ op: 'areas.remove', area: 'House' }, /"House" still has plans in it/);
    await s.append('alice', [{ op: 'areas.remove', area: 'Money' }, { op: 'plan.remove', plan: 'p1', why: 'painted' }]);
    await refuses({ op: 'areas.remove', area: 'House' }, /keep at least one area/);
    await refuses({ op: 'areas.add', area: ' Garden' }, /an area needs a name, with no spaces around it/);
    await refuses({ op: 'areas.add', area: 'x'.repeat(61) }, /an area's name is at most 60 characters/);
    await refuses({ op: 'areas.move', area: 'Attic', to: 0 }, /there is no area called Attic/);
    await refuses({ op: 'areas.move', area: 'House', to: -1 }, /must be a whole number/);
  });
  test('they are settings; an add and a remove are lines in Today, a move is not', async () => {
    const written = await s.append('alice', [{ op: 'areas.add', area: 'Garden' }, { op: 'areas.move', area: 'Garden', to: 0 }, { op: 'areas.remove', area: 'Garden' }]);
    for (const e of written) assert.equal(scopeOf(e), 'settings');
    assert.equal(describeEvent(written[1]!, s.state).what, 'moved the area Garden to place 1');
    const lines = (await thread(s, { who: 'bob', budget: null })).entries.flatMap((e) => (e.kind === 'change' ? [e.what] : []));
    assert.deepEqual(lines.filter((w) => /Garden/.test(w)), ['added the area Garden', 'removed the area Garden']);
  });
});
```
`api/test/server-settings.test.ts`, with alice's household (if Home already holds a plan in another area, keep that area in the first list):
```ts
test('an area is added, moved and removed by name, and a refusal is a 400 in words', async () => {
  const post = (sub: string, body: unknown) => call(alice, 'POST', `/api/settings/areas${sub}`, body);
  assert.equal((await post('', { areas: ['House', 'Money'] })).status, 200);
  assert.deepEqual((await post('/add', { area: ' Garden ' })).json, { areas: ['House', 'Money', 'Garden'] });
  const again = await post('/add', { area: 'garden' });
  assert.deepEqual([again.status, again.json.error], [400, '"Garden" is already an area']);
  assert.deepEqual((await post('/move', { area: 'Garden', to: 0 })).json, { areas: ['Garden', 'House', 'Money'] });
  assert.deepEqual((await post('/remove', { area: 'Garden' })).json, { areas: ['House', 'Money'] });
  const none = await post('/remove', { area: 'Garden' });
  assert.deepEqual([none.status, none.json.error], [400, 'there is no area called Garden']);
  assert.deepEqual([(await post('/move', { area: 'House', to: 'first' })).status, (await post('/add', {})).status], [400, 400]);
});
```
`api/test/households.test.ts`, in `describe('plans and settings in a backup')`:
```ts
test('a plan in an area that areas.add made needs Settings taken with it, and then restores', async () => {
  const source = await new Households(await dir()).create('alice', 'Rivera');
  await source.store.append('alice', [{ op: 'areas.add', area: 'Garden' }, { op: 'areas.move', area: 'Garden', to: 0 },
    { op: 'plan.create', plan: 'beds', title: 'Dig the beds', area: 'Garden' }]);
  const backup = parseBackup(await readFile(source.store.path, 'utf8'));
  const { store } = await fresh();
  assert.match(planRestore(store.state, backup, ['plans']).missingPrerequisites.join('\n'), /"Garden" need that area, which is in the backup but not selected/);
  const plan = planRestore(store.state, backup, ['settings', 'plans']);
  assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);
  await store.adopt(eventsToApply(plan));
  assert.deepEqual([store.state.settings.areas[0], store.state.plans.get('beds')!.area], ['Garden', 'Garden']);
});
```
Run: `cd api && node --test --experimental-strip-types test/settings-log.test.ts test/server-settings.test.ts test/households.test.ts`. Expected: FAIL (unknown op; 404 on the routes).
- [ ] **Step 2: Validation and the folds.** `validateSettings`: `area` follows `areas.rename`'s rule and its sentence, and is at most 60 characters ("an area's name is at most 60 characters"); `to` is a whole number, zero or more ("where it moves to must be a whole number"). Folds: `areas.add` appends unless an area matches ignoring case. `areas.remove` does nothing when the area is not there; else refuses "keep at least one area" when it is the only one and `"${area}" still has plans in it` while any plan not removed sits in it, in any state. `areas.move` refuses "there is no area called A" for an unknown area; else it moves it to `to`, held within the list, and changes nothing when that is where it stands.
- [ ] **Step 3: The sentences, the scope, the quiet move, the walk and the routes.** `describe()`: "added the area A", "removed the area A", "moved the area A to place N" (N counts from 1). All three are `settings`. `areas.move` joins `NOT_A_CHANGE`. `planRestore`'s area walk follows the three ops (an add appends, a remove drops, a move reorders) and `inBackup` counts `areas.add`. The three routes sit beside `/api/settings/areas/rename`: each trims the name; `/add` refuses `"${existing}" is already an area` and `/remove` and `/move` refuse "there is no area called A" before writing; a fold refusal is a 400 in the fold's words, as the rename route does it; each answers `{ areas }`.
- [ ] **Step 4: Run to see them pass; suite, typecheck, commit** the six source files and three tests: "An area is added, moved and removed by name, each its own line in the log."

### Task 7: Shelves are retired, and a backup says when it is too new

**Files:**
- Modify: `api/src/types.ts` (`Event`), `api/src/replay.ts` (`validate`, `applyTo` ~1029, the five refusals at ~1557, ~1559, ~1578, ~1601, ~1688, `hasLiveChildren` ~2005), `api/src/households.ts` (~117, ~141, ~181), `api/src/server.ts` (~1273, ~1845, ~1866, ~1885), `api/src/restore.ts` (`scopeOf`, `parseBackup` ~92, the outsiders walk), `api/src/activity.ts`, `api/src/tools.ts` (`describe`)
- Test: `api/test/plans.test.ts`, `api/test/households.test.ts`

**Interfaces:**
- Consumes: `goalLabel`, `goalSpelling` (Task 5); the area walk (Task 6); the hand's outsider (Task 4).
- Produces: `{ op: 'shelves.retire' }`, written only by `SYSTEM`, in the `plans` scope, not plan-shaped, in `NOT_A_CHANGE`.
- Produces: `export async function retireShelves(store: Store, copy: typeof copyFile = copyFile): Promise<boolean>` in `api/src/households.ts`: true when it appended the line.
- Produces: `ParsedBackup.unknown: readonly string[]` (op names this build does not know, each once) and `export function newerBackup(b: ParsedBackup): string | null` in `restore.ts`.

- [ ] **Step 1: Write the failing tests.** In `api/test/plans.test.ts` (import `SYSTEM`), delete the three tests whose rule is going ('two levels and no more', 'a shelf has no state', 'removing a shelf with live children is refused') and the shelf refusals inside `describe('the fold owns the plan rules')`, and add:
```ts
describe('shelves are retired', () => {
  test('old shelf lines still fold, and only a parent that is no live plan is refused', async () => {
    const { s } = await store();
    await s.append('alice', [{ op: 'areas.set', areas: ['House', 'Garden'] }, create('p1'), create('p2', { parent: 'p1' }),
      create('p3', { parent: 'p2' }), create('p4', { parent: 'p1', area: 'Garden' }), { op: 'plan.state', plan: 'p1', state: 'doing' },
      { op: 'plan.set', plan: 'p2', area: 'Garden' }, { op: 'plan.set', plan: 'p1', area: 'Garden' }]);
    assert.equal(s.state.plans.get('p3')!.area, 'Garden');                 // plans under a plan still move with it
    await s.append('alice', { op: 'plan.remove', plan: 'p1', why: 'done with it' });
    await assert.rejects(s.append('alice', create('p5', { parent: 'nope' })), refused(/no such plan: nope/));
  });
  test('one line from system turns each shelf into a goal on it and on its plans', async () => {
    const { s } = await store();
    const plan = (id: string) => s.state.plans.get(id)!;
    await s.append('alice', [create('kitchen', { title: 'Kitchen refresh' }), create('hinge', { parent: 'kitchen' }), create('tap', { parent: 'kitchen' }),
      create('gone', { parent: 'kitchen' }), { op: 'plan.remove', plan: 'gone', why: 'not needed' }, create('alone'),
      { op: 'plan.goal', plan: 'tap', goal: 'Summer trip' }, { op: 'plan.state', plan: 'hinge', state: 'doing' },
      create('long', { title: 'A'.repeat(70) }), create('long1', { parent: 'long' }),            // the label is cut to its first 60
      create('roof', { title: 'new  ROOF' }), create('roof1', { parent: 'roof' }), create('c'), { op: 'plan.goal', plan: 'c', goal: 'New roof' }]);
    await assert.rejects(s.append('alice', { op: 'shelves.retire' }), refused(/shelves\.retire is written by system/));
    const [retired] = await s.append(SYSTEM, { op: 'shelves.retire' });
    assert.deepEqual(['kitchen', 'hinge', 'tap', 'alone', 'long1', 'roof', 'roof1'].map((id) => plan(id).goal),
      ['Kitchen refresh', 'Kitchen refresh', 'Summer trip', null, 'A'.repeat(60), 'New roof', 'New roof']);   // a goal that matches gives its spelling
    assert.deepEqual([...s.state.plans.values()].filter((p) => !p.removed && p.parent !== null), []);
    assert.deepEqual([plan('hinge').state, plan('kitchen').owner, scopeOf(retired!)], ['doing', 'alice', 'plans']);
    assert.deepEqual([...s.state.plans.values()].filter((p) => p.pageEvent === retired!.id).map((p) => p.id).sort(), ['hinge', 'long1', 'roof1', 'tap']);
    await s.append('alice', { op: 'plan.state', plan: 'kitchen', state: 'doing' });         // an ordinary plan now
    await s.append('bob', { op: 'goal.rename', from: 'Kitchen refresh', to: 'Kitchen' });   // later goal lines win on every replay
    assert.equal(replay(eventsOf(s)).plans.get('hinge')!.goal, 'Kitchen');
    assert.ok(!(await thread(s, { who: 'bob', budget: null })).entries.some((e) => e.id === retired!.id));
  });
});
```
In `api/test/households.test.ts` (import `retireShelves`, `newerBackup`, and `apply` from `../src/replay.ts`; move `fresh` out of `describe('plans and settings in a backup')` to the file's top level, unchanged, so these can call it):
```ts
describe('a log with shelves is retired when it is opened', () => {
  const shelved = async () => {
    const hh = new Households(await dir());
    const made = await hh.create('alice', 'Rivera');
    await made.store.append('alice', [{ op: 'plan.create', plan: 'kitchen', title: 'Kitchen refresh', area: 'House' },
      { op: 'plan.create', plan: 'hinge', title: 'Fix the hinge', area: 'House', parent: 'kitchen' }]);
    return { hh, ...made, before: await readFile(made.store.path, 'utf8') };
  };
  const linesOf = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  test('the first open copies the log beside itself and appends one line from system; the next does neither', async () => {
    const { hh, id, store, before } = await shelved();
    const opened = await new Households(hh.dir).open(id);              // another process
    assert.equal(await readFile(`${store.path}.before-0.7.0`, 'utf8'), before);
    const lines = await linesOf(store.path);
    assert.deepEqual([lines.length, lines.at(-1).op, lines.at(-1).who], [before.trim().split('\n').length + 1, 'shelves.retire', 'system']);
    assert.equal(opened.state.plans.get('hinge')!.goal, 'Kitchen refresh');
    await new Households(hh.dir).open(id);
    assert.equal((await linesOf(store.path)).length, lines.length);
    assert.equal(await readFile(`${store.path}.before-0.7.0`, 'utf8'), before);   // never overwritten
  });
  test('a copy that cannot be made fails loudly and appends nothing; a copy already there stands; no shelf, no line and no copy', async () => {
    const { hh, store, before } = await shelved();
    const failing = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };
    await assert.rejects(retireShelves(store, failing('EACCES')), /EACCES/);
    assert.equal(await readFile(store.path, 'utf8'), before);
    assert.deepEqual([await retireShelves(store, failing('EEXIST')), await retireShelves(store)], [true, false]);
    const plain = (await hh.create('alice', 'Elsewhere')).store;
    await plain.append('alice', { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' });
    assert.equal(await retireShelves(plain), false);
    await assert.rejects(readFile(`${plain.path}.before-0.7.0`), /ENOENT/);
  });
});

describe('a backup made by 0.7.0', () => {
  test('restores into a fresh household, and reads cleanly against its own', async () => {
    const source = await new Households(await dir()).create('alice', 'Rivera');
    await source.store.append('alice', [{ op: 'member.add', member: 'bob', why: 'my partner' }, { op: 'areas.add', area: 'Garden' },
      { op: 'plan.create', plan: 'beds', title: 'Dig the beds', area: 'Garden' }, { op: 'plan.hand', plan: 'beds', to: 'bob', why: 'your spade' },
      { op: 'plan.goal', plan: 'beds', goal: 'New garden' }, { op: 'plan.create', plan: 'kitchen', title: 'Kitchen refresh', area: 'House' },
      { op: 'plan.create', plan: 'hinge', title: 'Fix the hinge', area: 'House', parent: 'kitchen' }]);
    assert.equal(await retireShelves(source.store), true);
    await source.store.append('bob', { op: 'goal.rename', from: 'Kitchen refresh', to: 'Kitchen' });
    const backup = parseBackup(await readFile(source.store.path, 'utf8'));
    assert.deepEqual([backup.skipped, backup.unknown], [[], []]);
    const { store } = await fresh();                                               // bob's, with alice a member
    const plan = planRestore(store.state, backup, ['settings', 'plans']);
    assert.deepEqual([plan.collisions, plan.missingPrerequisites], [[], []]);       // system is no outsider
    await store.adopt(eventsToApply(plan));
    const beds = store.state.plans.get('beds')!;
    assert.deepEqual([beds.owner, beds.ownerFrom, beds.goal, store.state.plans.get('hinge')!.goal, store.state.hands.size], ['bob', 'alice', 'New garden', 'Kitchen', 1]);
    const own = planRestore(source.store.state, backup, ['settings']);
    assert.deepEqual([own.collisions, own.missingPrerequisites], [[], []]);
    assert.doesNotThrow(() => apply(source.store.state, own.take));                 // an area already there changes nothing
  });
  test('a backup holding an op this build does not know is refused whole, never read as if the line were absent', () => {
    const line = (e: object) => JSON.stringify({ at: '2026-12-01T09:00:00.000Z', who: 'alice', ...e });
    const claim = line({ id: 'x1', op: 'household.claim', label: 'Home' });
    const backup = parseBackup([claim, line({ id: 'x2', op: 'bill.set', budget: 'b' }), line({ id: 'x3', op: 'bill.set', budget: 'b' }),
      line({ id: 'x4', op: 'bill.remove', budget: 'b' })].join('\n'));
    assert.deepEqual(backup.skipped.slice(0, 2), ['line 2: unknown op bill.set', 'line 3: unknown op bill.set']);
    assert.deepEqual(backup.unknown, ['bill.set', 'bill.remove']);
    assert.equal(newerBackup(backup), 'This backup was made by a newer Home Planner. It holds bill.set and bill.remove, which this version cannot read.');
    assert.equal(newerBackup(parseBackup(claim)), null);
  });
});
```
Run: `cd api && node --test --experimental-strip-types test/plans.test.ts test/households.test.ts`. Expected: FAIL (the old refusals still fire; `retireShelves` is not exported).
- [ ] **Step 2: The fold.** `validate()`: `shelves.retire` from anyone but `SYSTEM` is refused, "shelves.retire is written by system". Delete the five shelf refusals and `hasLiveChildren`; keep `plan.create`'s `livePlan(d, e.parent, e)` and `plan.set`'s move of the plans under a plan. Fold `shelves.retire` as the spec's Replay section says: for each live plan with live plans under it, in the log's order, the label is the title put through the goal rule and cut to its first 60 characters, or the spelling `goalSpelling` gives when a goal already matches; that plan and each live plan under it take it unless they carry a goal; then every live plan's `parent` is null. `applyTo` takes the "before" copy for `shelves.retire` too, so `markPages` marks each plan whose page showed a parent. `describe()`: "retired the shelves into goals". Scope `plans`; `NOT_A_CHANGE` gains it.
- [ ] **Step 3: `retireShelves`, and where it is called.** When no live plan has a `parent` it returns false. Otherwise it copies `store.path` to `${store.path}.before-0.7.0` with `constants.COPYFILE_EXCL` (an `EEXIST` means an earlier copy stands and is not an error; anything else is thrown), appends `{ op: 'shelves.retire' }` as `SYSTEM`, and returns true. Call it after each of the four loads, before the store is cached or returned (`open`, `create` and `createFromLog` in `households.ts`; the sandbox's `devStore.load()` in `server.ts`), and after `active.adopt(events)` in `POST /api/restore`. A throw there is the open failing: do not catch it.
- [ ] **Step 4: Restore.** `parseBackup` treats a line whose op `scopeOf` does not know as unreadable: `line N: unknown op X` in `skipped`, the op in `unknown` once, the event left out. `newerBackup` builds the sentence (ops joined with commas and "and"). `POST /api/restore/preview` and `POST /api/restore` both throw `new ToolError(newerBackup(backup), 400)` when it is not null, before anything else is worked out. In the outsiders walk, a `shelves.retire` from `SYSTEM` names nobody.
- [ ] **Step 5: Run to see them pass; suite, typecheck, commit.** Tests elsewhere that asserted a shelf refusal are rewritten to the new rule or deleted, each named in the commit body. Commit: "Shelves are retired into goals by one line the app writes after copying the log, and a backup from a newer build is refused whole."

### Task 8: The doors: hand and goal routes, two tools, and every way to ask closed

Between this task and Task 15 the 0.6.0 page's "Ask ... to take it" answers 410. Nothing is deployed from the branch in between.

**Files:**
- Modify: `api/src/plan-rules.ts` (`shelfFor` ~111 goes), `api/src/plan-edits.ts` (~61-124), `api/src/server.ts` (~2875-2927 and its header comment), `api/src/tools.ts` (~2580-2960, `TOOLS` ~3455, `RESEARCH_WRITES` ~3496, `commit` ~3597), `api/src/offers.ts` (`decide` ~141, `refresh` ~263, `adjust` ~271), `api/src/calendar.ts` (`:28`, `:520`), `api/src/briefing.ts` (`:297`, `:925`), `api/src/conversation.ts` (~151, `:208`)
- Test: `api/test/server-plans.test.ts`, `api/test/tools.test.ts`, `api/test/offers.test.ts`

**Interfaces:**
- Consumes: the three goal functions (Task 5), `STALE` (Task 3).
- Produces, in `plan-rules.ts`: `export const RETIRED = { ask: 'Nobody is asked to take a plan any more. Hand it from its card.', shelf: 'Plans no longer sit on shelves. Give it a goal instead.' } as const`.
- Produces, in `plan-edits.ts`: `createPlan(ctx, o: { title: string; area: string; owner?: unknown; goal?: unknown; parent?: unknown }): Promise<Plan>`; `handPlan(ctx, id: PlanId, to: unknown, why?: unknown): Promise<Plan>`; `setGoal(ctx, id: PlanId, goal: unknown): Promise<Plan>`; `renameGoal(ctx, from: unknown, to: unknown): Promise<number>`; `removeGoal(ctx, goal: unknown): Promise<number>` (how many plans carried it). `askToTake`, `recordAsk` and `raiseAskCards` are deleted.
- Produces: `POST /api/plans/:id/hand { to, why? }` and `POST /api/plans/:id/goal { goal }` answering `{ plan }`; `POST /api/goals/rename { from, to }` and `POST /api/goals/remove { goal }` answering `{ plans }`; `POST /api/plans` taking `owner?` and `goal?`.
- Produces: tools `hand_plan { plan, to, why? }` and `set_plan_goal { plan, goal }`; `ask_to_take` is gone.

- [ ] **Step 1: Write the failing tests.** `api/test/server-plans.test.ts`, in `describe('the plan routes')`:
```ts
test('a plan is made for someone, toward a goal, in one write; a shelf is refused', async () => {
  const r = await call('alice', 'POST', '/api/plans', { title: 'Fix the fence gate', area: 'House', owner: 'bob', goal: ' New   roof ' });
  assert.deepEqual([r.status, r.json.plan.owner, r.json.plan.ownerFrom, r.json.plan.createdBy, r.json.plan.goal], [200, 'bob', 'alice', 'alice', 'New roof']);
  const tail = (await log()).slice(-3);
  assert.deepEqual([tail.map((e) => e.op), new Set(tail.map((e) => e.at)).size], [['plan.create', 'plan.hand', 'plan.goal'], 1]);
  const mine = await call('alice', 'POST', '/api/plans', { title: 'Oil the hinges', area: 'House', owner: 'alice', goal: '' });
  assert.deepEqual([(await log()).at(-1).op, mine.json.plan.goal], ['plan.create', null]);
  const shelf = await call('alice', 'POST', '/api/plans', { title: 'Hinge', area: 'House', parent: r.json.plan.id });
  assert.deepEqual([shelf.status, shelf.json.error], [400, 'Plans no longer sit on shelves. Give it a goal instead.']);
});
test("any member hands a plan on at once; a refusal is a 400 in the fold's words; asking is gone", async () => {
  const id = await make('Clear the gutters');
  const took = await call('bob', 'POST', `/api/plans/${id}/hand`, { to: 'bob', why: 'I have the ladder' });
  assert.deepEqual([took.status, took.json.plan.owner, took.json.plan.ownerFrom], [200, 'bob', 'alice']);
  const same = await call('alice', 'POST', `/api/plans/${id}/hand`, { to: 'bob' });
  assert.deepEqual([same.status, same.json.error], [400, "Clear the gutters is already bob's"]);
  const out = await call('alice', 'POST', `/api/plans/${id}/hand`, { to: 'carol' });
  assert.deepEqual([out.status, out.json.error], [400, 'carol is not in this household']);
  const old = await call('alice', 'POST', `/api/plans/${id}/ask-to-take`, { to: 'bob', why: 'please' });
  assert.deepEqual([old.status, old.json.error], [410, 'Home Planner has been updated. Reload.']);
});
test('a goal is set, renamed and removed, and the pair answer how many plans', async () => {
  const a = await make('Strip the old shingles', { goal: 'Reroof' });
  const b = await make('Order the shingles');
  assert.equal((await call('alice', 'POST', `/api/plans/${b}/goal`, { goal: 'reroof' })).json.plan.goal, 'Reroof');
  assert.deepEqual((await call('bob', 'POST', '/api/goals/rename', { from: 'Reroof', to: ' New shingles ' })).json, { plans: 2 });
  const none = await call('bob', 'POST', '/api/goals/rename', { from: 'Reroof', to: 'Roof' });
  assert.deepEqual([none.status, none.json.error], [400, 'there is no goal called Reroof']);
  assert.equal((await call('alice', 'POST', `/api/plans/${a}/goal`, { goal: null })).json.plan.goal, null);
  assert.deepEqual((await call('bob', 'POST', '/api/goals/remove', { goal: 'new shingles' })).json, { plans: 1 });
  assert.equal((await call('bob', 'POST', `/api/plans/${b}/goal`, { goal: 'x'.repeat(61) })).status, 400);
});
```
`api/test/tools.test.ts`, in `describe('plan tools')`: in 'every plan tool is there', replace `ask_to_take` with `hand_plan: ['plan', 'to']` and `set_plan_goal: ['plan', 'goal']`, and add:
```ts
test('hand_plan names both ends in its summary; set_plan_goal takes an existing spelling; shelves and asks are closed', async () => {
  const c = await planCtx();
  const run = (name: string, args: Record<string, unknown>) => runTool(toolByName.get(name)!, args, c) as Promise<Proposal>;
  const hand = await run('hand_plan', { plan: 'p3', to: 'bob', why: 'you know a plumber' });
  assert.deepEqual([hand.summary, hand.events], ['Hand Water heater from alice to bob', [{ op: 'plan.hand', plan: 'p3', to: 'bob', why: 'you know a plumber' }]]);
  await assert.rejects(run('hand_plan', { plan: 'p3', to: 'alice' }), /Water heater is already alice's/);
  await c.store.append('alice', { op: 'plan.goal', plan: 'p1', goal: 'New kitchen' });
  const goal = await run('set_plan_goal', { plan: 'p3', goal: ' new  kitchen ' });
  assert.deepEqual([goal.summary, goal.events], ['Set Water heater toward New kitchen', [{ op: 'plan.goal', plan: 'p3', goal: 'New kitchen' }]]);
  assert.equal((await run('set_plan_goal', { plan: 'p1', goal: null })).summary, 'Take Kitchen off New kitchen');
  await assert.rejects(run('create_plan', { title: 'Hinge', area: 'House', parent: 'p1' }), /Plans no longer sit on shelves\. Give it a goal instead\./);
  assert.ok(!toolByName.has('ask_to_take') && toolByName.has('answer_ask'));
  assert.ok(RESEARCH_WRITES.has('hand_plan') && RESEARCH_WRITES.has('set_plan_goal'));
  await run('set_plan_state', { plan: 'p1', state: 'doing' });            // a former shelf has a state like any plan
});
```
`api/test/offers.test.ts`: the tests in `describe('an ask to take a plan')` that raised an ask through `ask_to_take` seed the log instead (a `plan.ask`, then the card as `plans.test.ts`'s `askCard` writes it), and one is added:
```ts
test('a card from before 0.7.0 that would ask, or put a plan on a shelf, can only be declined', async () => {
  const c = await ctx();
  await c.store.append('alice', { op: 'plan.create', plan: 'p1', title: 'Kitchen', area: 'House' });
  const card = (tool: string, events: NewEvent[]): NewEvent => ({ op: 'proposal.offer', tool, args: { plan: 'p1' }, summary: 's', effects: [],
    events, budget: null, month: null, envelopes: [], fingerprint: '', prompt: BRIEFING } as NewEvent);
  const [ask, shelf] = await c.store.append('claude', [card('ask_to_take', [{ op: 'plan.ask', plan: 'p1', to: 'bob', why: 'w' }]),
    card('create_plan', [{ op: 'plan.create', plan: 'p2', title: 'Hinge', area: 'House', parent: 'p1' }])]);
  const closed = (message: string) => (e: unknown) => e instanceof ToolError && e.status === 409 && e.message === message;
  await assert.rejects(decide(c, ask!.id, 'approved'), closed('Nobody is asked to take a plan any more. Hand it from its card.'));
  await assert.rejects(refresh(c, ask!.id), closed('Nobody is asked to take a plan any more. Hand it from its card.'));
  await assert.rejects(decide(c, shelf!.id, 'approved'), closed('Plans no longer sit on shelves. Give it a goal instead.'));
  await decide(c, ask!.id, 'declined', 'not needed');
  assert.equal(c.store.state.thread.offers.get(ask!.id)!.status, 'declined');
});
```
Run: `cd api && node --test --experimental-strip-types test/server-plans.test.ts test/tools.test.ts test/offers.test.ts`. Expected: FAIL.
- [ ] **Step 2: `plan-edits.ts` and the routes.** `createPlan` refuses any `parent` that is not undefined with `RETIRED.shelf`; an `owner` other than the sender must be a member (the fold's sentence) and becomes a `plan.hand` with no `why`; a `goal` that is not blank becomes a `plan.goal`, tidied by `goalLabel`, in the spelling `goalSpelling` gives when one exists; all through one `writePlan`. `handPlan` requires `to`, and passes `why` only when it has words. `setGoal` takes null, or `goalLabel` of what it was given. `renameGoal` and `removeGoal` read the count from `goalsOf` before they write and answer it. The plan sub-route pattern gains `hand` and `goal`; `POST ask-to-take` throws `new ToolError(STALE, 410)`; the two `/api/goals/` routes sit beside `POST /api/plans`. Delete `shelfFor`.
- [ ] **Step 3: The tools and the cards.** `hand_plan`: refuses as the fold does, before proposing; summary `Hand ${title} from ${owner} to ${to}`; effects `[`It becomes ${to}'s at once and shows in Today`]`. `set_plan_goal`: `goal` is text or null; summaries "Set T toward G" and "Take T off G"; a no-op is refused ("T is already toward G", "T has no goal"). Both join `TOOLS` and `RESEARCH_WRITES`. `ask_to_take` is deleted from the file, `TOOLS` and `RESEARCH_WRITES`. `create_plan` loses `parent` from its input and description and refuses one given with `RETIRED.shelf`; `update_plan`, `set_plan_state` and `remove_plan` lose their shelf checks and shelf words. `liveChildren` then has one caller left, `syncNames` (`api/src/calendar.ts:520`): delete that one line of `syncNames` (the function stays) and then `liveChildren` itself, since no plan has plans under it once `shelves.retire` has run, which is before the first request. `commit()` and `decide()` no longer call `raiseAskCards`. In `offers.ts`, `closedCard(o: Offer): string | null` answers `RETIRED.ask` when `o.tool === 'ask_to_take'` or an event's op is exactly `plan.ask`, `RETIRED.shelf` when an event carries `parent`; `decide` (when approving), `refresh` and `adjust` throw it as a 409. An `answer_ask` card is not closed: an old ask is still answered.
- [ ] **Step 4: Claude's words for three.** `briefing.ts`: "NOTES THE TWO OF THEM LEFT EACH OTHER" becomes "NOTES THE MEMBERS LEFT EACH OTHER"; "Both of them read it" becomes "Every member reads it". `conversation.ts`: "Notes are between the two of them" becomes "Notes are between the members"; `planContext` drops ", on the ... shelf". Tests that quote the old words follow.
- [ ] **Step 5: Run to see them pass; suite, typecheck, commit:** "Plans are handed and given goals through routes and two tools, and nothing can ask a member to take a plan any more."

### Task 9: Tokens, the hit area, and the four helpers every screen will call

**Files:**
- Modify: `site/tokens.css` (after the schemes ~540; `:175-187`, `:253`, `:287`; the comments at `:83`, `:86`, `:108`, `:172`, `:214`, `:215`), `docs/superpowers/design/tools/contrast.py`, `site/index.html` (CSS `:47-53`, `:781-835`; the shared region; `sourceDisc` ~2467; `planChips` ~6628; the card's owner ~6948; `betweenSection` ~7447; `enterApp`, `backToPicker`, both sign-out handlers), `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: the shared region (Task 1), `members`, `myName`.
- Produces, all in the shared region:
  - `memberDisc(name: string, { small = false } = {}): HTMLElement`, a `span.who` with `mine`, or `other partner`, plus `sm` when small. `whoDisc` is deleted and its four callers call this.
  - `const STATE_WORDS = { planning: 'Planning', doing: 'Doing', done: 'Done' }` and `stateGlyph(state, { small = false } = {}): SVGElement`, an `svg.st.st-<state>` (plus `sm`), `role="img"`, `aria-label` the word.
  - `goalFlag(label: string): HTMLElement`, a `span.flag` holding the flag at 12px and the whole label in a `span`, `title` the label.
  - `peopleBar(host: HTMLElement, { label, people, pressed, onPress }: { label: string; people: { key: string; label: string; n: number }[]; pressed: string | null; onPress: (key: string | null) => void }): void`.
  - `let personPressed = null`, `pressPerson(member: string | null): void`, `restorePerson(): void`, `peopleOrder(): string[]` (you first, then `members` in their order).
  - CSS: `.hit`, `.seg.people`, `.who.other`, `.who.sm`, `.st`, `.flag`.

- [ ] **Step 1: Tighten the ledger first.** Add to `ADDED`: `['S8', 'function memberDisc(']`, `['S33', 'function stateGlyph(']`, `['bar', 'function goalFlag(']`, `['bar', 'function peopleBar(']`, `['P17', 'function pressPerson(']`, `['P17', "'hp.person'"]`; to `GONE`: `['S8', 'whoDisc(']`. Run it: expected FAIL on all seven.
- [ ] **Step 2: Tokens.** Add a block "3c. Roles" after the schemes, under the selector section 5 uses (`:where(:root, [data-mode], [data-scheme])`), so a scoped scheme re-resolves them: `--state-planning: var(--ink-faint)`, `--state-doing: var(--accent)`, `--state-done: var(--good)`, `--mark-fill: var(--accent-line)`, `--hatch: repeating-linear-gradient(135deg, var(--hatch-line) 0 2px, transparent 2px 7px)`. In section 1 beside their families: `--tracking-headline: -0.02em`, `--tracking-caps: 0.02em`, `--r-inner: 7px`, `--stroke-rail: 3px`, `--disc: 22px`, `--disc-small: 18px`, `--row: 56px`, `--control: 36px`. Rename the three `--src-partner-*` to `--src-other-fill`, `-line`, `-ink` wherever they are given a value (light `#F4E9F8`, `#9A55B7`, `#5B2675`; dark `#2C2035`, `#C18BDC`, `#EBD3F5`) and add the old names in section 5 as aliases of the new. Reword the comment at `:175-182` to "another member's", adding "every member but the viewer shares this treatment", and correct the six comments the visual audit lists as untrue.
- [ ] **Step 3: `contrast.py`.** It reads hex values only, so each new pair is written against the token its role points at: `--accent` on `--surface`, `--surface-raised` and `--surface-sunken` at 3.0 ("state doing"); `--ink-faint` on `--accent-tint` at 4.5; `--ink` on `--accent-line` at 4.5 ("mark fill"); `--line-strong` on `--surface` at 3.0; and `--src-other-*` in place of every `--src-partner-*`. Run: `python3 docs/superpowers/design/tools/contrast.py site/tokens.css`. Expected: exit 0, no failures.
- [ ] **Step 4: CSS in the page, extending shipped rules.**
  - `.hit{position:relative}` with a `::after` that is absolutely placed, centred on the control, `min-height:var(--tap)` and `min-width:var(--tap)`, never smaller than the control. This is the one hit-area helper.
  - `.btn`: `--fs-ui`, weight 500; `min-height:var(--tap)` under `@container page (max-width: 759px)`; the literal `.15s` at `:49` becomes `var(--t-fast)`.
  - `.who`: the size rule reads `--disc`; `.who.sm` is `--disc-small` with a 10px initial; `.who.other` takes `.who.partner`'s rule (both selectors on it), reading `--src-other-*`.
  - `.seg.people`: `--control` high, scrolls sideways with no scrollbar, never wraps; each button is `.hit`; `.n` is the count after the name in `--ink-faint`. The pressed button keeps `.seg`'s raised fill and strong border.
  - `.st`: `--disc` square, `--disc-small` with `.sm`; stroke `currentColor`, coloured by `.st-planning`, `.st-doing`, `.st-done` from the three `--state-*` tokens; inside `.ev` it takes the box's ink (`color:inherit`).
  - `.flag`: inline-flex, one line, the label cut with an ellipsis, `--ink-soft`, the icon 12px.
- [ ] **Step 5: The helpers.**
  - `memberDisc`: the initial, upper case; when another entry of `members` that is neither `name` nor you shares that initial, the first two letters, the second in lower case ("Bo", "Be"); `title` and `aria-label` the name; `role="img"`.
  - `stateGlyph`: built as `lucide()` builds (24 box, stroke 2, round caps). Add to `LUCIDE` (lucide.dev, ISC, as the tab icons are): `'circle-dashed'`: `<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>`; `'circle-check'`: `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`; `flag`: `<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>`. Doing is the app's own: `<circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor"/>`.
  - `peopleBar`: empties `host`, then draws `div.seg.people[role=group][aria-label=label]`: a button "Everyone" (key null) first, then one per entry in the order given, each `type=button`, `aria-pressed`, the label then `span.n`. A press calls `onPress(key)`. It scrolls the pressed button into view.
  - `pressPerson(member)`: sets `personPressed` and mirrors it to `sessionStorage['hp.person']` (removing the key for null), in `try`/`catch` as `hp.addHome` is. `restorePerson()`: reads the key; a name that is not in `members` is dropped and the key removed. `enterApp` calls `restorePerson()` after `members` is set; `backToPicker` and the two sign-out handlers call `pressPerson(null)`.
  - Replace `whoDisc` at its four callers (Today's `sourceDisc`, `planChips`, the card's owner, Between us) and delete it. `otherMember` stays: the Calendar and `sourceDisc` still call it.
- [ ] **Step 6: Check by hand.** Start both servers; three members. At 390 and on the desk, dark and light:
  - All four tabs, a plan's card and Settings draw; buttons across the app are one size and, on the phone, 44px high; nothing wraps or overflows that did not before.
  - Today's rail, the board's cards, the card's owner and Between us draw discs: alice solid, bob and casey each a plum ring with one letter. In the console, `members.push('beth'); [memberDisc('bob').textContent, memberDisc('beth').textContent, memberDisc('casey').textContent]` answers `['Bo', 'Be', 'C']`.
  - In the console: `document.body.append(stateGlyph('planning'), stateGlyph('doing'), stateGlyph('done'), goalFlag('New roof'))` draws a dashed circle, a half-filled circle, a ticked circle and a flag with its label; in Graphite the three states differ by shape, not hue.
  - In the console: `const h = document.createElement('div'); document.querySelector('#plan .page-head').after(h); peopleBar(h, { label: 'Whose plans', people: [{ key: 'alice', label: 'alice', n: 2 }, { key: 'bob', label: 'bob', n: 1 }], pressed: 'bob', onPress: console.log })` draws the bar with bob pressed, readable as pressed in Graphite light and dark.
  - The hit-area snippet, used in every later page task: `[...document.querySelectorAll('.hit')].filter((el) => el.offsetParent).map((el) => [el.textContent.trim().slice(0, 20), getComputedStyle(el, '::after').height, getComputedStyle(el, '::after').width]).filter(([, h, w]) => parseFloat(h) < 44 || parseFloat(w) < 44)` answers `[]`.
  - `pressPerson('bob')`, reload: `personPressed` is `'bob'`. Sign out and in: it is null. `sessionStorage['hp.person'] = 'nobody'`, reload: null and the key gone.

  Stop both by pid.
- [ ] **Step 7: Ledger, suite, typecheck, commit** `site/tokens.css site/index.html docs/superpowers/design/tools/contrast.py api/test/page-ledger.test.ts`: "The tokens name the plan states and every other member, and the disc, glyph, flag and people bar are written once for all three screens."

### Task 10: The board and the card are read in their new shape

After this task the Plan tab shows the shared error box until Task 11 lands; the card, Today, the Calendar and Settings work. Nothing is deployed in between.

**Files:**
- Modify: `api/src/plans.ts` (whole), `api/src/server.ts` (`plansRail` ~904, `GET /api/plans` ~2865, the header comment ~20), `api/src/briefing.ts` (`plansBlock` ~551), `api/src/tools.ts` (`list_plans` ~3385, `get_plan`'s description ~3415), `site/index.html` (`eventPlans` ~10697; Settings: `areaCounts` ~7660, `loadSettings` ~7759-7770, the group list ~7893, `areasItem` and `areasForm` ~8714-8776), `api/test/page-ledger.test.ts`
- Test: `api/test/plans.test.ts`, `api/test/server-plans.test.ts`, `api/test/briefing.test.ts`, `api/test/tools.test.ts`

**Interfaces:**
- Consumes: `goalsOf`, `sameGoal`, `goalSpelling` (Task 5), `STALE` (Task 3).
- Produces:
```ts
export interface BoardCard { /* as now, plus */ goal: string | null; doneAt: string | null; /* and no `parent` */ }
export interface BoardRow { area: string; all: { plans: number; doing: number; done: number }; plans: BoardCard[]; done: BoardCard[] }
export interface Board { who: Actor | 'everyone'; goal: string | null; areas: string[]; rows: BoardRow[];
  members: { member: Actor; plans: number }[]; goals: { goal: string; plans: number; done: number }[] }
export function board(state: State, events: readonly Event[], o: { who: Actor | 'everyone'; goal?: string | null; today: Day; tz?: string }): Board
```
  `rows` holds every area, in the household's order, whatever the filters leave in it. `all.plans` counts the area's open plans (Planning and Doing), `all.doing` those in Doing, `all.done` the finished ones, ignoring both filters. `CardView` gains `goals` (from `goalsOf`); its `shelf` is always null and `children` always `[]`.
- Produces: `GET /api/plans?who=<member>|everyone&goal=<label>` answering the `Board` whole.

- [ ] **Step 1: Write the failing tests.** `api/test/plans.test.ts`, in `describe('board and card')`; the tests there that pass `filter` or `showDone` or read `planning`, `doing` or `shelves` are rewritten on this fixture or deleted:
```ts
/** House and Money. alice: p1 (Planning), p2 (Doing), p5 (done), all toward New roof. bob: p3 (Doing), and p4 in Money toward New roof. casey: nothing. */
async function roofBoard() {
  const { s } = await store();
  await s.append('alice', [{ op: 'member.add', member: 'casey', why: 'moved in' }, { op: 'areas.set', areas: ['House', 'Money'] },
    create('p1'), create('p2'), create('p3'), create('p4', { area: 'Money' }), create('p5'),
    ...['p1', 'p2', 'p4', 'p5'].map((plan): NewEventShape => ({ op: 'plan.goal', plan, goal: 'New roof' })),
    { op: 'plan.state', plan: 'p2', state: 'doing' }, { op: 'plan.state', plan: 'p3', state: 'doing' }, { op: 'plan.state', plan: 'p5', state: 'done' },
    { op: 'plan.hand', plan: 'p3', to: 'bob' }, { op: 'plan.hand', plan: 'p4', to: 'bob' }]);
  const see = (o: { who: string; goal?: string | null }) => board(s.state, eventsOf(s), { today: '2026-10-29', tz: 'UTC', ...o });
  return { s, see };
}
const ids = (cards: readonly { id: string }[]) => cards.map((c) => c.id);
test("everyone: every area, open plans Doing first then in the log's order, done apart, the counts beside", async () => {
  const { see } = await roofBoard();
  const b = see({ who: 'everyone' });
  assert.deepEqual([b.who, b.goal, b.areas], ['everyone', null, ['House', 'Money']]);
  assert.deepEqual(b.rows.map((r) => [r.area, r.all, ids(r.plans), ids(r.done)]), [
    ['House', { plans: 3, doing: 2, done: 1 }, ['p2', 'p3', 'p1'], ['p5']], ['Money', { plans: 1, doing: 0, done: 0 }, ['p4'], []]]);
  assert.deepEqual(b.members, [{ member: 'alice', plans: 2 }, { member: 'bob', plans: 2 }]);
  assert.deepEqual(b.goals, [{ goal: 'New roof', plans: 4, done: 1 }]);
  const p5 = b.rows[0]!.done[0]!;
  assert.deepEqual([p5.goal, p5.doneAt, 'parent' in p5, b.rows[0]!.plans[0]!.doneAt], ['New roof', NOW, false, null]);
});
test('a member: strictly what they own, even when that is nothing; an old ask puts nothing in their view', async () => {
  const { s, see } = await roofBoard();
  const bob = see({ who: 'bob' });
  assert.deepEqual([bob.who, bob.rows.map((r) => ids(r.plans)), bob.rows[0]!.all], ['bob', [['p3'], ['p4']], { plans: 3, doing: 2, done: 1 }]);
  await s.append('alice', { op: 'plan.ask', plan: 'p1', to: 'casey', why: 'you offered' });
  const casey = see({ who: 'casey' });
  assert.deepEqual([casey.who, casey.rows.flatMap((r) => [...r.plans, ...r.done])], ['casey', []]);
  assert.deepEqual(casey.members, [{ member: 'alice', plans: 2 }, { member: 'bob', plans: 2 }]);    // the counts ignore who is pressed
  assert.equal(see({ who: 'everyone' }).rows[0]!.plans.find((c) => c.id === 'p1')!.asked!.to, 'casey');   // the briefing still reads it
});
test('a goal: its stored spelling, done plans counted, members with none left out; a goal nobody has filters nothing', async () => {
  const { see } = await roofBoard();
  const g = see({ who: 'everyone', goal: 'new roof' });
  assert.equal(g.goal, 'New roof');
  assert.deepEqual(g.rows.map((r) => [ids(r.plans), ids(r.done)]), [[['p2', 'p1'], ['p5']], [['p4'], []]]);
  assert.deepEqual(g.members, [{ member: 'alice', plans: 3 }, { member: 'bob', plans: 1 }]);
  assert.deepEqual(see({ who: 'bob', goal: 'New roof' }).rows.map((r) => ids(r.plans)), [[], ['p4']]);
  const none = see({ who: 'everyone', goal: 'Old roof' });
  assert.deepEqual([none.goal, none.rows[0]!.plans.length], [null, 3]);
});
test('the card carries its owner fields and every goal, and no shelf', async () => {
  const { s } = await roofBoard();
  const v = card(s.state, eventsOf(s), 'p3', { who: 'alice', today: '2026-10-29', tz: 'UTC' });
  assert.deepEqual([v.owner, v.ownerFrom, v.ownerSince, v.createdBy, v.goal], ['bob', 'alice', NOW, 'alice', null]);
  assert.deepEqual([v.goals, v.shelf, v.children], [[{ goal: 'New roof', plans: 4, done: 1 }], null, []]);
  assert.ok(v.history.some((h) => h.what === 'handed Plan p3 to bob'));
});
```
`api/test/server-plans.test.ts`:
```ts
test("GET /api/plans answers the whole board by who and goal, and refuses an older page's words", async () => {
  assert.equal((await call('alice', 'POST', '/api/members', { member: 'casey', why: 'moved in' })).status, 200);
  const all = await call('alice', 'GET', '/api/plans');
  assert.deepEqual([all.status, all.json.who, Object.keys(all.json).sort()], [200, 'everyone', ['areas', 'goal', 'goals', 'members', 'rows', 'who']]);
  assert.equal((await call('alice', 'GET', '/api/plans?who=alice')).json.who, 'alice');
  assert.equal((await call('alice', 'GET', '/api/plans?who=casey')).json.who, 'everyone');     // only the route falls back
  assert.equal((await call('alice', 'GET', '/api/plans?who=everyone&goal=Nothing')).json.goal, null);
  assert.equal((await call('alice', 'GET', '/api/plans?who=dana')).status, 400);
  for (const old of ['filter=mine', 'showDone=1']) {
    const r = await call('alice', 'GET', `/api/plans?${old}`);
    assert.deepEqual([r.status, r.json.error], [400, 'Home Planner has been updated. Reload.']);
  }
});
```
In `api/test/tools.test.ts`: `list_plans` with `{ who: 'bob' }` answers a `Board` whose `who` is `'bob'` and whose rows hold only bob's plans, and its input has `who` and `goal` and neither `filter` nor `showDone`. Run: `cd api && node --test --experimental-strip-types test/plans.test.ts test/server-plans.test.ts test/tools.test.ts`. Expected: FAIL.
- [ ] **Step 2: `board()` and `card()`.** `board()` is strict: `who: <member>` keeps only what that member owns, and an open ask adds nothing. `goal`, when it matches a goal (`goalSpelling`), keeps the plans carrying it and is answered in its stored spelling; when none matches it filters nothing and is answered as null. `plans`: open plans in view, Doing first, then the log's order. `done`: finished plans in view, newest first by `stateAt`. `members`: for each member in the household's order, their cards in view ignoring `who` (open; under a goal, done too), members with none left out. `goals`: `goalsOf(state)`. `cardOf` adds `goal` and `doneAt` (`stateAt` when done, else null) and drops `parent`. `card()` adds `goals` and answers `shelf: null`, `children: []`.
- [ ] **Step 3: The route and the other three readers.** `GET /api/plans`: `filter` or `showDone` in the query is a 400 with `STALE`; `who` absent means everyone; a `who` that is neither a member nor `everyone` is a 400 ("who must be a member of this household, or everyone"); when a member has nothing in view (no card in any row's `plans` or `done`) the route calls `board()` again as everyone and answers that. `plansRail` and `list_plans` call `board()` strictly with the viewer; `plansBlock` asks for everyone; each reads `rows.flatMap((r) => r.plans)`. `list_plans` takes `who` and `goal`; its description and `get_plan`'s lose the shelf words and say goals.
- [ ] **Step 4: The page's two other readers, in the same change.** Add to the ledger's `GONE`: `['S16', '/api/plans?showDone=1']`, `['spec', 'areaCounts']`, `['spec', 'areasItem']`, `['spec', 'areasForm']`; run it, expect FAIL. Then: `eventPlans` reads `rows.flatMap((r) => r.plans)` (ledger S15). In Settings delete `areasItem`, `areasForm`, `areaCounts`, the `/api/plans?showDone=1` read in `loadSettings` and `areasItem()` from the Household group (S16): areas leave Settings entirely, with no row and no pointer.
- [ ] **Step 5: Check by hand.** Start both servers. Expected: Settings opens and has no Areas row; the rest of the Household group is in the order it was. Calendar, New event: "For a plan" lists the open plans. A plan's card opens from Today's rail and draws as before. The Plan tab shows the error box: that is Task 11's. Stop both by pid.
- [ ] **Step 6: Run to see them pass; suite, typecheck, commit:** "The board is read whole by who and goal, a card carries its goals, and areas leave Settings."

### Task 11: The board

**Files:**
- Modify: `site/index.html`: markup ~1726-1745; CSS `:157-172` (`.erow`), `:619` (`.list`), `:634` (`.add-row`), `:884-932` (the board's rules); script: the Plan region's state, `loadBoard`, `renderBoard`, `planChips`, `boardCard`, the `#plan-filters` and `#plan-new` listeners, `newPlan`, `laneLabel`, `LANES`; in `renderCard`: `isShelf` and its uses, the crumb's shelf, "On this shelf", the state buttons' words; `ICONS.shelf`
- Modify: `api/test/page-ledger.test.ts`

**Extends, and pastes nothing from the wireframe:** `.list` (the area card), `.erow` (rows, with a new leading slot), `.area-head` (the heading), `.seg.people` and `peopleBar` (Task 9), `.add-row` ("A new area"), `.ep-form`, `.ep-f`, `.ep-acts`, `epErr` (the add forms), `stateGlyph`, `memberDisc`, `goalFlag`, `chip`.

**Interfaces:**
- Consumes: `GET /api/plans` (Task 10), `POST /api/plans` with `owner` and `goal` (Task 8), `POST /api/settings/areas/add` (Task 6), Task 9's helpers, `STATE_WORDS`.
- Produces: this markup inside `#plan`, replacing all of it:
```html
<div id="plan-board">
  <div class="page-head"><h1>Plan</h1><p class="set-line" id="plan-count" aria-live="polite"></p></div>
  <div id="plan-people"></div>
  <div class="filters" id="plan-goals" role="group" aria-label="Goals" hidden></div>
  <div id="plan-areas"></div>
  <p class="hint" id="plan-quiet" aria-live="polite" hidden></p>
  <div id="plan-foot"></div>
</div>
<section id="area-page" hidden></section>
```
- Produces: `let planData = null` (the last `Board`), `let planGoal = null` (always null until Task 13), `let areaPage = null` (Task 12 gives it its shape); `loadBoard(): Promise<void>`; `renderPlan(b: Board): void`; `planRow(c: BoardCard, { underGoal = false } = {}): HTMLButtonElement` (a `button.erow.plan` with `data-plan`); `planMeta(c, { flag = true } = {}): HTMLElement`; `addPlanRow(area: string, { owner = null, goal = null, after }: { owner?: string | null; goal?: string | null; after: () => Promise<void> }): HTMLElement`; `planCountLine(b)`, `planQuietLine(b)`: strings.
- Produces: focus keys on the board: an area's heading button `data-key="area:<area>"`, its add row `data-key="add:<area>"`, its done row `data-key="done:<area>"`, the last card `data-key="new-area"`.
- Produces: `function openArea(area, o = {}) {}`, an empty stand-in Task 12 replaces. Until then a heading and a done row do nothing.

- [ ] **Step 1: Tighten the ledger first.** `ADDED`: `['P2', 'Whose plans']`, `['P4', 'A new plan in ']`, `['P5', 'The new plan']`, `['P5', 'e.g. Fix the fence gate']`, `['P5', 'Give it a name']`, `['P7', 'Nothing is planned yet. Anything the household means to do goes here.']`, `['P9', 'No plans']`, `['P11', 'function planRow(']`; with the row `'board'`: `A new area`, `The new area`, `e.g. Garden`, `It joins the board at the bottom. Rename it, move it or remove it from its own page.`, `/api/settings/areas/add`, `function renderPlan(`; with the row `'markup'`: `id="plan-board"`, `id="plan-count"`, `id="plan-people"`, `id="plan-goals"`, `id="plan-areas"`, `id="plan-quiet"`, `id="plan-foot"`, `id="area-page"`.
  `GONE`, with the row `'spec'`: `planFilter`, `planShowDone`, `LANES`, `laneLabel`, `renderBoard`, `boardCard`, `function planChips(`, `newPlan(`, `isShelf`, `plan-form`, `plan-filters`, `plan-new`, `plan-empty`, `plan-theirs`, `plan-done`, `'Theirs'`, `Show done`, `New plan`, `the two of you`, `the clock runs`, `no clock`, `On a shelf`, `Not on a shelf`, `On this shelf`, `Add an item`, `The item`, `· holds `, `shelf:`, `.board`, `.lane`, `.bcard`, `.shelf`, `.ask-line`.
  `GONE_FROM_PLAN_MARKUP`: `'Both'`, `'Mine'`, `'Theirs'`. Run it: expected FAIL.
- [ ] **Step 2: Markup and reading.** Replace `#plan`'s children with the markup above, and reword the HTML comment over it; delete the two load-time listeners with the elements they were bound to (S3). `loadBoard` asks `/api/plans?who=${personPressed ?? 'everyone'}` plus `&goal=` when `planGoal` is set, shows the shared loading line (`#loading`), sends a failed read to `showProblem` (P64), and draws only when `view === 'plan'` still holds and `areaPage` is null. It keeps the answer in `planData`.
- [ ] **Step 3: The head and the people bar.** `planCountLine`: with `P` the cards in every `rows[].plans`, `A` the rows that have any, `D` those in Doing: "12 plans in 4 areas · 5 doing" (the doing part left off at 0; "1 plan in 1 area"); no plans at all with no filter: "Nothing is planned yet. Anything the household means to do goes here."; a person pressed: "Bob's · 4 plans in 3 areas · 2 doing", and "Yours · ..." for yourself. The bar: `peopleBar($('plan-people'), { label: 'Whose plans', people, pressed: b.who === 'everyone' ? null : b.who, onPress })` where `people` is `b.members` in `peopleOrder()`'s order as `{ key: member, label: member, n: plans }`, and `onPress` calls `pressPerson(key)` then `loadBoard()`. `#plan-people` is hidden while `members.length < 2`. The pressed button comes from the answer's `who`, never from `personPressed`: when the route fell back, Everyone reads pressed and `personPressed` is left alone.
- [ ] **Step 4: An area.** For each row, a `section`: `h2.area-head` holding one `button.hit` (`data-key="area:<area>"`) with the name in title weight, `span.count`, and the chevron (`icon('go', 'i sm chev')`); it calls `openArea(area)`. The count: "5 plans · 2 doing" with no filter (from `row.all`; "No plans" at 0; the doing part left off at 0); "2 of 5 plans" under a person (`row.plans.length` of `row.all.plans`). With no filter every area is drawn. Under a person an area with nothing in view is not drawn, and `#plan-quiet` names them after the last area: "Nothing of Bob's in People.", "Nothing of yours in People or Trips." (names joined with commas and a final "or"). Then a `div.list` holding, in order:
  1. `planRow(c)` for each of `row.plans`. A row is a button: `stateGlyph(c.state)` in the leading slot, the title (`.erow-name`), `planMeta(c)` under it, the chevron; a Doing row has an inset rail (`box-shadow: inset var(--stroke-rail) 0 0 var(--state-doing)`). It calls `openCard(c.id)`. Its `aria-label` is the title, the state's word, whose it is and the due day: "Fix the fence gate, Doing, Bob's, due Sat 14 Nov".
  2. The add row: `button.erow.add` (`data-key="add:<area>"`), a plus and "A new plan in House"; with another member pressed, "A new plan in House, for Bob".
  3. The done row, when `row.done.length`: `button.erow.fold.hit` (`data-key="done:<area>"`), sunken, `stateGlyph('done', { small: true })`, "3 done" ("1 done"), the chevron; it calls `openArea(area, { focus: 'done' })`.

  `planMeta`, in this order, each only when it applies: `memberDisc(c.owner, { small: true })`; each free chip (`chip('', t)`); the clock, "2 wks", when `showsClock(c)`; the due day (`dueText`) with the calendar icon; each block (`blockText`) with the clock icon; "research" with Claude's mark; the envelope, "$ Groceries · $40 left", in `--problem` when `toCents(c.envelope.left) < 0` (P13); `goalFlag(c.goal)` unless `flag` is false. The due day, blocks, clock, research and envelope are an icon and words with no box: one `span.pm` rule with `.pm-clock`, `.pm-due`, `.pm-block`, `.pm-research`, `.pm-env` (and `.pm-env.neg` for the problem colour). The "asked" chip is not drawn (P14); a plan asked of you is an ordinary row (P15).
- [ ] **Step 5: The add form and "A new area".** `addPlanRow` returns the add row; pressed, it puts a `form.ep-form` where the row was: `epField('The new plan', input)` (placeholder "e.g. Fix the fence gate", 200 characters), one `p.note` saying what the filter adds ("It will be Bob's." here; Task 13 adds the goal's half) and left out when it adds nothing, the error slot from `epErr()`, then Cancel (`data-cancel`) and **Add it**. An empty name says "Give it a name" in the slot and keeps focus in the field. It posts `/api/plans` with `{ title, area }`, plus `owner` when another member is pressed. A refusal goes in the slot with what was typed kept. On success it awaits `after()` (here `loadBoard`) and puts focus on `[data-key="add:<area>"]`; Cancel and Escape put the row back with focus on it. Every continuation returns when `view !== 'plan'`.
  After the last area, with no goal pressed: `button.add-row` (`data-key="new-area"`) "A new area". It opens in place: `epField('The new area', input)` (placeholder "e.g. Garden", 60), the hint "It joins the board at the bottom. Rename it, move it or remove it from its own page.", the error slot, Cancel and **Add it**; it posts `/api/settings/areas/add`. Until Task 12 a new area reloads the board and takes focus on its heading.
- [ ] **Step 6: CSS, and what is deleted.** `.erow.plan`, `.erow.add` and `.erow.fold` vary `.erow`: a grid of `var(--disc) minmax(0,1fr) auto`, `min-height: var(--row)` (the fold 44px and `--surface-sunken`), a hairline between rows inside `.list`. A finished row (`.erow.plan.finished`, used from Task 12) softens its title with `--ink-soft` only: no opacity, no strike. `.area-head` becomes the one-link heading. On the desk, `@container page (min-width: 1040px)`: `#plan-areas` is a grid of columns that wrap (`repeat(auto-fill, minmax(280px, 1fr))`, gap `--sp-5`), each area the same card, "A new area" a solid column at the end; the add row may read "A new plan" there with its `aria-label` whole. Delete `.board`, `.board-head`, `.lane` and its two, `.lane-label`, `.lane-empty`, `.bcard` and its variants, `.shelf`, `.ask-line`, `.area > .shelf`, `#plan-form`, `#plan-empty`. Keep `.provisional` and `.chip.asked` (Today's rail still draws it, S18).
  Delete from the script: `planFilter`, `planShowDone`, `planRows`, `planAreas`, `LANES`, `laneLabel`, `renderBoard`, `planChips`, `boardCard`, `newPlan`, `ICONS.shelf`. In `renderCard`: delete `isShelf` (the state buttons and Mark done are always drawn), the crumb's shelf and the "On this shelf" section (the server answers no children since Task 10), and take the state buttons' words from `STATE_WORDS` (S33). Leave the card's "Waiting for you" block and its ask button for Tasks 14 and 15.
- [ ] **Step 7: Check by hand.** Start both servers; three members, with plans in two areas, one in Doing, one done, one with a due date, one with an envelope. At 390 first, then the desk; dark, then light:
  - The head reads the count line; count the rows by eye: the numbers match.
  - The bar reads Everyone, alice, bob, casey with counts, you first; it scrolls sideways and nothing else does. Press bob: the head reads "Bob's · ...", areas with nothing of bob's are gone and named in the quiet line, each area's count reads "N of M plans", the add row reads "..., for Bob". Add a plan there: it appears in the view and is bob's.
  - Switch to Today and back: bob is still pressed. Reload: still pressed. Hand bob's last plan away with `curl`: the board shows Everyone pressed, and `personPressed` is still `'bob'`.
  - A Doing row has its rail and half-filled glyph; in Graphite, light and dark, Planning, Doing and the pressed person are told apart with no hue. An over-spent envelope's words are in the problem colour.
  - The add row opens where it was, focus in the field, the field in the top half of the screen at 390 × 812; Escape closes it and focus is on the row; an empty name says "Give it a name"; stop the planner and add: the refusal is in the form's slot, the words kept, and the shared box is empty. Start it again.
  - "A new area" adds Garden at the bottom; a duplicate says `"Garden" is already an area` in its slot. With one member (a second household of alice alone): no people bar.
  - A plan's card opens: its state buttons read Planning and Doing; nothing mentions a shelf. The hit-area snippet answers `[]`. The other three tabs and Settings still draw.

  Acceptance, ticked by the reviewer against the running page: **P1, P2, P3 (the done row), P4, P5, P6, P7, P8, P9, P10, P11, P12, P13, P14, P15, P16, P17, P20, P26, P35, P64 (the board)**; S3, S7, S18, S33. Stop both by pid.
- [ ] **Step 8: Ledger, suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "The Plan board is one card of rows per area, with a people bar for any number of members and adding as the last row."

### Task 12: The Area page

**Files:**
- Modify: `site/index.html`: `envFrame` ~3681; the shared region; the Plan region; `reloadView` ~3019; `refresh` ~4651; `showView` ~11000; `backToPicker` ~11121; `enterApp` ~11291; CSS near `.ep`
- Modify: `api/test/page-ledger.test.ts`

**Extends, and pastes nothing from the wireframe:** the envelope page whole: `envFrame` (`section.set-page.ep`, `.back`), `envSection`, `.ep-form`, `.ep-f`, `.ep-acts`, `.ep-foot` with `.link` buttons, `epErr`; `.list` and Task 11's `planRow` and `addPlanRow`.

**Interfaces:**
- Consumes: `planRow`, `addPlanRow`, `areaPage`, the focus keys and `#area-page` (Task 11); the three area routes (Task 6) and `POST /api/settings/areas/rename`.
- Produces: `areaPage`, shaped `{ area: string, boardScroll: number | null, from: { key: string | null, view: string | null }, doneOpen: boolean }`.
- Produces: `openArea(area: string, { linked = false, focus = null, said = '', restore = null } = {}): Promise<boolean>` (false for an unknown area, which leaves the board showing); `closeArea({ refocus = true, key = null } = {}): void`; `areaEscape(ev: KeyboardEvent): void`; `clearAreaPage(): void`; `loadAreaPage({ focus = null, said = '' } = {}): Promise<void>`.
- Produces: `envFrame` takes `id = 'env-page-h'` for its heading; the Area page passes `'area-page-h'`.
- Produces, in the shared region: `cancelMark(el: HTMLElement, close: () => void): void` and `cancelOpen(host: HTMLElement): boolean`.

- [ ] **Step 1: Tighten the ledger first.** `ADDED`, with the row `'area'`: `async function openArea(`, `function closeArea(`, `function areaEscape(`, `function clearAreaPage(`, `function cancelOpen(`, `Rename this area`, `Move up`, `Move down`, `Remove this area`, `Its plans go with it.`, `Rename it`, `A household keeps at least one area.`, `Nothing is in it, so removing it loses nothing.`, `An area is removed once it holds nothing.`, `Nothing planned yet`, `on the board`, `/api/settings/areas/rename`, `/api/settings/areas/move`, `/api/settings/areas/remove`; and `['P3', "focus: 'done'"]`. Run it: expected FAIL.
- [ ] **Step 2: Open, close, Escape, clear,** on the model of the envelope page's four functions.
  - `openArea` reads an unfiltered `GET /api/plans`; an area not in its `areas` returns false and shows the board. Otherwise it sets `areaPage` (a fresh object; `boardScroll` is `window.scrollY`, or null when `linked`; `from.key` the `data-key` of the board control that had focus; `from.view` the view showing when `linked`; `restore`, an earlier `areaPage`, gives `boardScroll` and `from` back), hides `#plan-board`, shows `#area-page`, draws, scrolls the window to the top once, focuses the heading (or the first field when it opens on a form, or the Done heading when `focus` is `'done'`, which also opens Done) with `preventScroll`, and adds the listener.
  - `closeArea` removes the listener, empties and hides the page, and shows the board redrawn from a fresh `loadBoard()` at `boardScroll`, focus on `[data-key=key ?? from.key]`. Opened `linked`, it calls `showView(from.view)` instead.
  - `areaEscape`: Escape only, not `defaultPrevented`, not while `#cat-sec` or `#phone-sec` shows, the target the body or inside `#area-page`; first `cancelOpen($('area-page'))`, and only when nothing was open, `closeArea()`.
  - `clearAreaPage` is called wherever `clearEnvelopePage()` is called in `showView`, `backToPicker` and `enterApp`.
  - `cancelMark` sets `data-cancel` on `el` and remembers `close` for it in a `WeakMap`; `cancelOpen` finds the first `[data-cancel]` in `host`, runs its remembered `close`, or clicks it when it has none (a Cancel button), and answers whether it found one.
  - `reloadView()` and `refresh()`: with `view === 'plan'` and `areaPage` set they call `loadAreaPage()`, not `loadBoard()`.
- [ ] **Step 3: The page, top to bottom,** drawn from the row for `areaPage.area` in the unfiltered answer, whatever is pressed on the board.
  1. **Head**: `envFrame({ id: 'area-page-h', back: 'Plan', onBack: closeArea, title: area, line })`. The line: "5 plans · 2 doing · 3 done · first on the board" from `row.all` and the area's place in `areas` ("first", "last" or "2 of 4"; the place left off with one area; a part left off at 0); an empty area reads "Nothing planned yet · last on the board".
  2. **A slot** (`div.ep-slot`) for the rename form, and a status line `p.set-line[aria-live=polite]` that shows `said`.
  3. **Plans**: a `.list` of `planRow(c)` for the area's open plans, then `addPlanRow(area, { after: loadAreaPage })`, reading "A new plan in House".
  4. **Done · 3**, when `row.done.length`: `envSection` with the count in the heading and a `textBtn` "Show" / "Hide" (`aria-expanded`); folded unless `areaPage.doneOpen`. Its `.list` holds the done plans newest first, each `planRow` in its finished variant (`.finished`): the done glyph, the title in `--ink-soft`, the owner's small disc, "done Tue 3 Nov" (from `doneAt`, in household time through `keyAt` and `keyWords`), the goal flag.
  5. **Foot** (`div.ep-foot`, `.link` buttons, each `.hit`): "Rename this area", "Move up", "Move down", "Remove this area", then one line. A move that cannot happen is not drawn.
     - Rename opens in the slot with focus in it: `epField('Call it', input)` prefilled, 60 characters, the hint "Its plans go with it.", the error slot, Cancel and **Rename it**. An unchanged name closes without a write. It posts `/api/settings/areas/rename { from, to }`; on success `areaPage.area` takes the new name before `loadAreaPage()`.
     - A move posts `/api/settings/areas/move { area, to }` with the index one up or one down, redraws, and says "House is now 2 of 4." in the status line, focus kept on the button pressed or on its neighbour when it is gone.
     - Remove is live only when the area holds nothing, under "Nothing is in it, so removing it loses nothing."; it posts `/api/settings/areas/remove` and calls `closeArea({ key: 'new-area' })`. Otherwise it is `aria-disabled="true"` under "House holds 8 plans, 3 of them done. An area is removed once it holds nothing." (open plus done from `row.all`; no middle clause at 0 done; "1 plan"). The last area: `aria-disabled` under "A household keeps at least one area."

  A form's refusal goes in its own slot; a failed read or a failed move goes in the shared box; never both. Every continuation checks `areaPage === page`. A committed change redraws the page and never goes Back, except Remove.
- [ ] **Step 4: Wire the board to it.** Delete Task 11's stand-in. "A new area", once added, calls `openArea(name, { said })` with `said` reading "Garden is on the board, under Trips." (the area before it).
- [ ] **Step 5: Check by hand.** Start both servers; three members. At 390 first, then the desk; dark and light:
  - Scroll the board down and press an area's name: the page shows from the top, focus on the heading, the line counts what the page shows. Back, then Escape: the board at the same scroll, focus on that heading.
  - Press bob on the board, open House: the page shows everyone's plans. Back: bob is still pressed.
  - A done row opens the page with Done open and focus on its heading; rows are newest first and read "done Tue 3 Nov"; Hide folds it; a redraw keeps it as it was.
  - Rename: focus in the field, the field in the top half at 390 × 812; Escape cancels it, the next Escape goes Back. Rename to another area's name: the refusal is in the form's slot. Rename it: the heading changes and the page stays.
  - Move up, Move down: the status says "House is now 2 of 4."; the first area offers no Move up.
  - Remove on an area with plans is greyed, says how many, and does nothing when pressed; on an empty one it returns to the board with focus on "A new area"; with one area left it says "A household keeps at least one area."
  - "A new area" on the board opens Garden's page saying "Garden is on the board, under Trips." Add a plan on the page: it appears, focus on the add row.
  - Throttle to Slow 3G, press Move down and Back at once: the board is not drawn over and focus stays put. The search box's Escape does not go Back. The hit-area snippet answers `[]`. The other tabs still draw.

  Acceptance: **P3 (Done on the Area page), P64 (the Area page)**; spec sections "The Area page" and "Pages". Stop both by pid.
- [ ] **Step 6: Ledger, suite, typecheck, commit** `site/index.html api/test/page-ledger.test.ts`: "An area's name opens its own page, where it is renamed, moved and removed and where its done plans live."

### Task 13: Goals on the board

**Files:**
- Modify: `site/index.html` (the Plan region: `loadBoard`, `renderPlan`, `planCountLine`, `planQuietLine`, the area's count and done row, `addPlanRow`'s note; CSS `:479-482`), `api/test/page-ledger.test.ts`

**Extends, and pastes nothing from the wireframe:** `.filters button` for a goal chip (the pressed one is the ink-filled pill at `:482`, never a tint, never `.chip.on`), `goalFlag`, `.ep-form`, `.ep-review` with `.effects` (solid and sunken), `.ep-foot`.

**Interfaces:**
- Consumes: `planGoal`, `planData`, `#plan-goals`, `#plan-foot`, `planRow`, `addPlanRow` (Task 11); `POST /api/goals/rename`, `POST /api/goals/remove` (Task 8).
- Produces: `pressGoal(goal: string | null): void` (sets `planGoal`, reloads the board); `goalFoot(b: Board): void`.

- [ ] **Step 1: Tighten the ledger first.** `ADDED`, with the row `'goals'`: `All goals`, `Rename this goal`, `Remove this goal`, `Both act on all `, `The new name goes on all `, `Rename it on `, `Leave the plans as they are`, `The goal ends here: it leaves the filter row. Putting the same words on a plan later starts it again.`, `Remove the goal`, ` toward it`, `toward this goal`, `Toward `, `/api/goals/rename`, `/api/goals/remove`, `function pressGoal(`. Run it: expected FAIL. ("Both act on all" is the spec's sentence; `GONE_FROM_PLAN_MARKUP` reads markup only.)
- [ ] **Step 2: The goal row.** `#plan-goals` is shown only when `b.goals.length`: "All goals" first, then a chip per goal in the answer's order, each a `button.hit` with `aria-pressed`, the flag and the whole label; one row that scrolls sideways and brings the pressed chip into view. The pressed chip is whichever matches the answer's `goal`: when the answer's `goal` is null while `planGoal` was set (renamed or removed elsewhere), `planGoal` becomes null and All goals reads pressed. `planGoal` is Plan's own: not shared with other tabs, and cleared on a household switch and sign-out.
- [ ] **Step 3: What a pressed goal changes on the board.**
  - Head: "Toward New roof · 4 plans in 2 areas · 2 doing · 1 done": `P` and `A` count `rows[].done` too, and "· N done" follows when N is not 0. With a person pressed as well: "Bob's · toward New roof · ...".
  - An area's count: "3 toward it" (plans and done together). An area with nothing in view is not drawn; the quiet line: "Nothing toward this goal in People or Trips yet.", and with a person, "Nothing of Bob's toward this goal in People or Trips."
  - A plan row's meta leaves the flag out (`planMeta(c, { flag: false })`).
  - The done row reads "1 done toward this goal". An area with no open plan toward it draws its done plans as rows in place of the fold (finished variant, "done Mon 12 Oct").
  - The add row: "A new plan in House, toward this goal"; with another member pressed too, "A new plan in House, for Bob, toward this goal". Its form's note: "It will be toward New roof.", or "It will be Bob's, toward New roof."; it sends `goal`.
  - The people bar's counts are the answer's (under a goal only members with plans toward it are listed). "A new area" is not drawn; the foot is.
- [ ] **Step 4: The foot.** In `#plan-foot`, with a goal pressed: "Rename this goal", "Remove this goal" (`.link.hit`), and one line: "Both act on all 4 plans that carry it, done ones included." (the last three words only when that goal's `done` is not 0; "the 1 plan that carries it" at one; figures from the goal's entry in `b.goals`). Each opens where the buttons were, and Cancel or Escape brings the buttons back with focus on the one pressed.
  - **Rename**: `epField('Call it', input)` prefilled, 60 characters; the hint "The new name goes on all 4 plans that carry it."; the error slot; Cancel and **Rename it on 4 plans**. On success `planGoal` is the new name and the board reloads pressed on it.
  - **Remove**: a `div.ep-review`, solid: the heading "This will", an `ul.effects` of "Take **New roof** off 4 plans, 1 of them done" and "Leave the plans as they are", and small: "The goal ends here: it leaves the filter row. Putting the same words on a plan later starts it again."; the error slot; Cancel and **Remove the goal**. Then All goals pressed, and the quiet line says "New roof is off 4 plans."
- [ ] **Step 5: Check by hand.** Start both servers; three members; give four plans in two areas the goal "New roof" with `curl -X POST .../api/plans/<id>/goal` (one of them done, one bob's), and one plan "Summer trip". At 390 and the desk, dark and light, and once in Graphite:
  - The goal row reads All goals, New roof, Summer trip; the pressed chip is ink-filled in every scheme and mode, and never told by a tint.
  - Press New roof: head, counts, rows, the done row or done rows, the quiet line and the add row read as Step 3 says; count rows by eye against the head. Press bob as well. Add a plan under both: it is bob's and toward New roof, and it is in the view.
  - Rename it on 4 plans: the chip reads the new name, still pressed. Rename onto "summer trip": `"Summer trip" is already a goal` in the form's slot.
  - Remove: the read-back is solid, not dashed; Remove the goal returns to All goals with "New roof is off 4 plans."
  - In a second tab remove a pressed goal, then press a person in the first: All goals reads pressed and nothing breaks. With no goals in the household the row is not drawn. The hit-area snippet answers `[]`.

  Acceptance: spec section "Goals on the board", and anti-goals "a count the reader cannot reproduce" and "a goal drawn as finished". Stop both by pid.
- [ ] **Step 6: Ledger, suite, typecheck, commit:** "Goals filter the board, and a goal is renamed or removed from the foot under it."

### Task 14: The card's head, its way back, and one Escape at a time

**Files:**
- Modify: `site/index.html`: `openCard` ~6782, `loadCard`, `renderCard`'s head ~6852-7019 and its Remove ~7068-7076, `betweenSection` ~7441-7467, `inlineForm` ~6705-6754, `contactSearch` ~7314, `checklistSection` ~7357, `moneyForm` ~7571, `showView` ~11000, CSS `:995-996`
- Modify: `api/test/page-ledger.test.ts`

**Extends, and pastes nothing from the wireframe:** the card as it is (`.plan-head`, `.crumb`, `.back`, `.seg`, `.chips`, `cardSection`); `stateGlyph`; `cancelMark`, `cancelOpen` (Task 12).

**Interfaces:**
- Consumes: `openArea(area, { restore })`, `areaPage` (Task 12); `stateGlyph`, `STATE_WORDS`, `memberDisc` (Task 9).
- Produces: `let cardFrom = null`, shaped `{ view: 'plan' | 'today' | 'calendar', area: object | null, scroll: number, row: string | null }` (`area` is a copy of `areaPage` when the card was opened from an Area page).
- Produces: `openCard(id: string): Promise<void>` (same callers as now; it records `cardFrom` unless a card is already showing); `closeCard({ removed = false } = {}): Promise<void>`; `cardEscape(ev: KeyboardEvent): void`.

- [ ] **Step 1: Tighten the ledger first.** `ADDED`: `['card', 'function cardEscape(']`, `['card', 'async function closeCard(']`, `['card', 'let cardFrom']`, `['P51', 'Also in Today']`, `['P50', 'Leave a note about this']`. `GONE`: `['P51', "Also in Today's thread"]`, `['P50', 'Leave a note for ']`, `['P50', 'betweenSection(v, theirs)']`, `['P32', 'asked ${v.asked.to}']`. Run it: expected FAIL.
- [ ] **Step 2: Where the card was opened from, and the way back.** `openCard`, when `view !== 'plan-card'`, records `cardFrom`: `view` is `'today'` or `'calendar'` when that is showing and `'plan'` otherwise; `area` a copy of `areaPage` or null; `scroll` the window's; `row` the plan's id when the control that had focus is a `[data-plan]` row. Opened from another card, `cardFrom` is kept. `closeCard`: for `'today'` and `'calendar'` it is `showView(cardFrom.view)`, the screen as it opens. For `'plan'` with an `area` it shows Plan and awaits `openArea(area.area, { restore: area })`; without one it awaits `showView('plan')`; then, only if that is still what is showing, it scrolls to `cardFrom.scroll` and focuses `[data-plan=row]` with `preventScroll`. With `removed`, focus goes to the area's heading instead (the Area page's `h1`, or `[data-key="area:<area>"]` on the board) (P63). Remove this plan's `after` is `() => closeCard({ removed: true })`.
- [ ] **Step 3: The head.**
  - **Back** says where it returns: "Plan", the area's name when it was opened from an Area page, "Today" or "Calendar". It calls `closeCard()`, is `.hit`, and shows at every width: delete `#plan-card .back{display:none}` at `:996`.
  - **The crumb** reads Plan › House: "Plan" shows the board (`showView('plan')`), the area opens its page (`showView('plan')` then `openArea(v.area)`), each `.hit`.
  - **The title** renames in place exactly as now (P21); its Escape handler also calls `preventDefault()`.
  - The **"Waiting for you"** block and its `askAnswer` call go from the head (P22); Today's ask card is where an old ask is answered.
  - **The state buttons** each carry `stateGlyph(s, { small: true })` before the word; **Mark done** carries the check. A finished plan shows the "Done" chip in Mark done's place, neither button pressed, and either opens it again (P25), as now.
  - The head's owner span goes (Task 15 draws Owner as a section). The "asked" chip goes from the chips row (P32). The chips row, "Add a chip" and "2 wks" stay as they are (P31, P33). "Due date" and "Block time" stay (P29, P30). The ask button stays until Task 15.
- [ ] **Step 4: One Escape closes a form, the next goes Back.** While a card shows, `cardEscape` is on the document (added when a card is drawn, removed in `showView` when the view is no longer `plan-card`): Escape only, not `defaultPrevented`, not while `#cat-sec` or `#phone-sec` shows, the target the body or inside `#plan-card`; first `cancelOpen($('plan-card'))`, and only when nothing was open, `closeCard()`. Each small form on the card says it is open and stops its own Escape from also going Back: `inlineForm`'s Cancel carries `data-cancel` and its keydown handler calls `preventDefault()` (that covers due, block, remove and a file's reason); `moneyForm`'s and `contactSearch`'s Cancel carry `data-cancel` and their handlers call `preventDefault()`; the chip box and the step row, which have no Cancel, are marked with `cancelMark(el, close)` using the close they already run, and their handlers call `preventDefault()` (S30, P68).
- [ ] **Step 5: Between us.** `betweenSection(v)` takes no second argument; its placeholder and accessible name read "Leave a note about this"; its note reads "Also in Today"; its discs are `memberDisc`.
- [ ] **Step 6: Check by hand.** Start both servers; three members. At 390 first, then the desk; dark and light:
  - From the board, scrolled down: open a row. The card is at its top. Back reads "Plan" and returns to the same scroll with focus on that row. From an Area page: Back reads the area's name and returns to the page at its scroll, focus on the row; that page's own Back still returns to the board where it was left.
  - From Today's plans rail and from a Calendar event: Back reads "Today" and "Calendar" and returns to that screen. From the search box while on Budget: Back reads "Plan". The crumb: Plan opens the board, House opens its page.
  - Escape with nothing open goes Back. Open each small form in turn (Due date, Block time, Remove this plan, a file's Remove, Change the money, Link someone, Add a chip, Add a step) and press Escape with focus in it, then again with focus clicked onto the page's background: each time the form closes and the card stays; the next Escape goes Back. Escape in the title box puts the title back and stays.
  - Remove a plan opened from the board: the board, focus on its area's heading. From an Area page: that page, focus on its heading.
  - A removed plan's id opened from Today's old line: "no such plan" in the error box (P65). Stop the planner and tick a step: the refusal is in the error box and the card is as it was (P66).
  - Throttle to Slow 3G, press Mark done and Back at once: the board is not drawn over. The hit-area snippet answers `[]`.
  - Walk the card top to bottom against the ledger. Acceptance, ticked row by row: **P18, P19, P21, P22, P23, P24, P25, P29, P30, P31, P32, P33, P34, P36, P37, P38, P39, P40, P41, P42, P43, P44, P45, P46, P47, P48, P49, P50, P51, P52, P53, P54, P55, P56, P57, P58, P59, P60, P61, P62, P63, P64 (the card), P65, P66, P67, P68**; S6, S13, S22, S30. P38 to P40 and P58 need a sign-in with no NAS session or no folder chosen: say in the report which were seen and which were read in the code.

  Stop both by pid.
- [ ] **Step 7: Ledger, suite, typecheck, commit:** "A plan's card goes back to where it was opened, its Back says where, and one Escape closes a form before the next goes Back."

### Task 15: Owner and Goal on the card

**Files:**
- Modify: `site/index.html` (`renderCard`: the head's ask button ~6951-6963, the body ~7040; new `ownerSection`, `goalSection`, `radioList`; CSS `:815-819` for the radio variant), `api/test/page-ledger.test.ts`

**Extends, and pastes nothing from the wireframe:** `envLine` (`.ep-line`, `.ep-t`) for the one line of each section; `.ep-form`, `.ep-f`, `.ep-acts`, `epErr`; `.check` for the radio list, as a variant that is filled in `--accent-fill` when checked; `memberDisc`, `goalFlag`; `cardSection`.

**Interfaces:**
- Consumes: `GET /api/plans/:id` with `goal`, `ownerSince`, `ownerFrom`, `createdBy`, `asked`, `goals` (Tasks 4, 10); `POST /api/plans/:id/hand`, `POST /api/plans/:id/goal` (Task 8); `members`, `peopleOrder`, `cancelMark`.
- Produces: `ownerSection(v): HTMLElement`, `goalSection(v): HTMLElement`, both drawn above Notes in the card's main column, Owner first; `radioList({ legend, name, options, value, onChange }): { el: HTMLElement; value(): string }` (a real `fieldset` of radios); `let cardSaid = null`, shaped `{ key: 'owner' | 'goal', text: string }`, set before `loadCard()` and shown once in that section's status line.

- [ ] **Step 1: Tighten the ledger first.** `ADDED`, with the row `'P27'`: `function ownerSection(`, `Who owns it?`, `Why them, or what to know first`, `Hand it to `, ` can hand it back.`, `It becomes yours at once and shows in Today.`, `A word about why (optional)`, `; nothing moves.`, ` has it.`, `It is yours.`, `It is answered on Today; handing it to anyone settles it.`, `'/hand'`; with the row `'goal'`: `function goalSection(`, `Set a goal`, `this plan stands on its own`, `the only plan toward it`, `What is it toward?`, `A new goal…`, `e.g. New roof`, `A goal begins when a plan carries it. This plan will be its first.`, `ends here: no other plan carries it.`, `is already a goal; this plan joins it.`, `'/goal'`. `GONE`, with the row `'P28'`: `/ask-to-take`, `Asking needs a reason`, `They read this on the card`, and the old button's template, `Ask ${theirs}` (Today's "asked you to take it" stays). Run it: expected FAIL.
- [ ] **Step 2: Owner.** Delete the head's ask button and form. The section's line (`envLine`): the disc, then "You own it" or "Bob owns it", over "since Wed 21 Oct · you made it", "since Wed 21 Oct · Alex made it" (a plan never handed: `ownerFrom` null, the day from `ownerSince`, the maker from `createdBy`), or "since Mon 9 Nov · from Alex" (`ownerFrom`; "from you" for yourself); beside it **Change**, shown to every member. While `v.asked` is set, a quiet line under it: "Bob was asked to take it on Mon 2 Nov. It is answered on Today; handing it to anyone settles it." (from `v.asked.to` and `v.asked.at`). Days are the household's (`keyAt`, `keyWords`).
  **Change** opens a form in the section: `radioList` "Who owns it?" with every member in `peopleOrder()`'s order, each with a small disc and the name ("You" for yourself), the owner checked; one live line (`aria-live="polite"`); a word (`epField`, 300 characters, placeholder "Why them, or what to know first", sent as `why`); the error slot; Cancel (`data-cancel`) and the primary. By what is picked:

  | Picked | Live line | The word's label | Primary | Status after |
  |---|---|---|---|---|
  | the owner still | "It stays yours; nothing moves." or "It stays Bob's; nothing moves." | (hidden) | `aria-disabled="true"`, reading "Hand it on" | none |
  | another member, and you own it | "It becomes Bob's at once and shows in Today. Bob can hand it back." | "A word for Bob (optional)" | **Hand it to Bob** | "Bob has it." |
  | yourself, and someone else owns it | "It becomes yours at once and shows in Today." | "A word about why (optional)" | **Take it** | "It is yours." |
  | another member, and a third owns it | "It becomes Casey's at once and shows in Today." | "A word for Casey (optional)" | **Hand it to Casey** | "Casey has it." |

  It posts `planPath(v.id, '/hand')` with `{ to }` and `why` when it has words. A refusal goes in the form's slot with the choice and the word kept. On success `cardSaid = { key: 'owner', text }` and `loadCard()`; the section shows the status once, focus on Change.
- [ ] **Step 3: Goal.** The line: "No goal" over "this plan stands on its own", with **Set a goal**; or `goalFlag(v.goal)` over "one of 4 plans toward it · 1 done" ("the only plan toward it" at 1; the done part left off at 0; figures from this goal's entry in `v.goals`), with **Change**. The form asks "What is it toward?" with `radioList`: "No goal"; each of `v.goals` with "4 plans · 1 done" after it; then "A new goal…", which shows `epField('Call it', input)` (60 characters, placeholder "e.g. New roof") and puts focus in it. One live line, by what is picked:
  - the goal it has: "It stays toward New roof."
  - another goal: "It moves to Summer trip. New roof keeps 3 other plans." (when it carried the last: "It moves to Summer trip. New roof ends here: no other plan carries it."; from no goal: "It joins Summer trip.")
  - No goal: "It comes off New roof, which keeps 3 other plans.", or "New roof ends here: no other plan carries it."
  - a new name: "A goal begins when a plan carries it. This plan will be its first.", or, when the words match a goal in use ignoring case, "Summer trip is already a goal; this plan joins it."

  Then the error slot, Cancel (`data-cancel`) and **Save**. No change is no write: the form closes. It posts `planPath(v.id, '/goal')` with `{ goal }` (null for No goal). On success `cardSaid = { key: 'goal', text: '' }` and `loadCard()`, focus on the section's button. A goal is never drawn ticked, struck or greyed because its plans are done.
- [ ] **Step 4: Check by hand.** Start both servers; three members. At 390 first (each form's first field in the top half at 390 × 812), then the desk; dark and light, and the radio lists once in Graphite:
  - As alice on her own plan: Owner reads "You own it", "since ... · you made it". Change lists You, bob, casey with You checked and the primary greyed under "It stays yours; nothing moves." Pick bob: the line, the word's label and **Hand it to Bob** read as the table says. Send it with a word: "Bob has it.", the section reads "Bob owns it", "since ... · from you". Open Today: one line, "handed ... to bob", the word quoted under it.
  - On bob's plan: pick yourself, **Take it**, "It is yours." Today: "took ... from bob". Pick casey on bob's plan: **Hand it to Casey**, "Casey has it." Today: "handed ... from bob to casey".
  - A checked radio is filled, not tinted, in Graphite light and dark. Tab reaches the group once and arrows move within it.
  - An old ask: with the planner stopped, append a `plan.ask` line for one of alice's plans to the household's log under `$S/run/households/` (`{"id":"zz-000001","at":"2026-11-02T09:00:00.000Z","who":"alice","op":"plan.ask","plan":"<id>","to":"bob","why":"yours?"}`), start it: the card shows the quiet line, and handing the plan to anyone clears it.
  - Goal: Set a goal lists the goals in use with their counts; each choice reads its live line; "A new goal…" shows the field; typing "new ROOF" says it is already a goal; Save joins it in its stored spelling. Change to No goal on the only plan toward a goal: "... ends here ...", and the board's goal row loses it.
  - Escape closes either form and the card stays; the next goes Back. Stop the planner and press Hand it to Bob: the refusal is in the form's slot, the choice and word kept, the shared box empty.
  - The card's History shows the hand and the goal change. The hit-area snippet answers `[]`.

  Acceptance: **P27, P28**, and the quiet line that stands in for P22 and P32; spec section "The plan's card", Owner and Goal; the anti-goal "a third member ... missing from Hand it to". Stop both by pid.
- [ ] **Step 5: Ledger, suite, typecheck, commit:** "A plan's card says who owns it and since when, any member hands it on or takes it, and it may be set toward a goal."

### Task 16: The sweep, the notes and version 0.7.0

**Files:**
- Modify: `site/index.html` (dead CSS and names, `BUILD`, the stylesheet link, comments), `docs/superpowers/design/components.css`, `docs/superpowers/design/2026-10-28-design-language.md`, `api/src/*.ts` (comments only), `README.md` (~68-78), `DEPLOY.md` (~889-907), `api/package.json`, `api/package-lock.json`, `api/test/page-ledger.test.ts`

**Interfaces:**
- Consumes: everything above. Produces: release 0.7.0.

- [ ] **Step 1: The ledger says the whole of "What is deleted".** Read the spec's "What is deleted" beside the test's `GONE` and add any page name still missing. Do not add `.chip.asked`, `.provisional`, `otherMember`, `askAnswer` or `askCardNode`: the spec keeps them. Run the ledger: expected PASS, or a FAIL that names something to delete now.
- [ ] **Step 2: Two members, nowhere on Plan.** Run `grep -nE "otherMember|[Tt]heirs|the two of|each other|[Bb]oth of|partner" $W/site/index.html`. Expected: `otherMember` only at its declaration, in `sourceDisc` and in the Calendar region; "Theirs" only in Today's `#t-filters`; "each other" only in Today's composer placeholder; `partner` only as the `.who.partner` alias, the Calendar's `calendar === 'partner'` and the member form's placeholder. Anything in the Plan region, the card or the shared region is a miss: fix it. In `api/src`, reword the comments the gap outline lists ("the other member", "the two of you": `types.ts:476`, `activity.ts:2-7`, `conversation.ts:2`, `:31`, `server.ts:14`, `:35`) and the route list at the top of `server.ts` (the new routes; `ask-to-take` gone; `GET /api/plans` by `who` and `goal`).
- [ ] **Step 3: Dead CSS and the reference.** Delete any rule left for a class the ledger's `GONE` names, and `.chip.money` with its `.over` rule if nothing draws it now. In `docs/superpowers/design/components.css` mark `.board`, `.board-head`, `.lane` and its two, `.area-head` as it was, `.bcard` and its variants, `.shelf` and `.ask-line` with the comment `/* superseded 2026-11-09: see specs/2026-11-09-plan-by-area-design.md */` above each block. In the design language apply, word for word, the amendments the visual audit gives under "Design-language amendments" for lines 12, 14, 15, 105 to 111, 221, 229 and 246 (read that section of `docs/superpowers/design/2026-11-10-visual-audit.md`). Run `python3 docs/superpowers/design/tools/contrast.py site/tokens.css`: exit 0.
- [ ] **Step 4: README and DEPLOY.** README, "Plans and documents": replace its first two sentences with: "Plan is the household's board: one card of rows per area, each plan's state a mark on its row, and finished plans kept on the area's own page. An area's name opens its page, where it is renamed, moved and removed. Any member hands a plan to another, or takes one, at once, and Today says who moved it, from whom, to whom and why. A plan may carry one goal; pressing a goal on Plan shows every plan toward it." After that paragraph add: "**Upgrading to 0.7.0.** Shelves are gone. Each is now an ordinary plan, and it and the plans that sat on it carry a goal with its name: press that goal on Plan to see them together. Back up first (see DEPLOY.md)."
  DEPLOY.md, after the paragraph that ends the three upgrade steps, a section "### Upgrading to 0.7.0": "Back up first: download each household's backup from Settings, and copy the `data` folder. The first time 0.7.0 opens a household that has a shelf, it copies that household's log beside itself, under the log's own name with `.before-0.7.0` added, and then writes one line that turns each shelf into a goal. The copy is made once and never overwritten. An older build cannot open a log that holds that line, or any of this release's new lines: to go back, stop the container, put the copy back under the log's name, and start the old image; whatever was written after the upgrade is lost. A backup made by 0.7.0 is refused by an older build, and a backup from a newer build is refused by this one, in words. A page left open on a phone across the upgrade says "Home Planner has been updated. Reload.""
- [ ] **Step 5: The version.** Run `cd api && npm version 0.7.0 --no-git-tag-version`. Expected: `v0.7.0`, in `package.json` and `package-lock.json`. On the page: `const BUILD = '0.7.0';` and `/tokens.css?v=0.7.0`. The ledger's build test passes again.
- [ ] **Step 6: The release, by hand.** Start both servers with a fresh `$S/run`. Then:
  - **A 0.6.0 log.** Sign in as alice, make Home, add bob and casey. Stop the planner. Append two lines to Home's log under `$S/run/households/`: `{"id":"zz-000001","at":"2026-11-01T09:00:00.000Z","who":"alice","op":"plan.create","plan":"kitchen","title":"Kitchen refresh","area":"House"}` and `{"id":"zz-000002","at":"2026-11-01T09:00:01.000Z","who":"alice","op":"plan.create","plan":"hinge","title":"Fix the hinge","area":"House","parent":"kitchen"}`. Start the planner and open Plan. Expected: a file beside the log named as the log with `.before-0.7.0`, holding the log as it was; the log's last line `shelves.retire` from `system`; Kitchen refresh and Fix the hinge both rows in House, both flagged "Kitchen refresh"; the goal row shows it; Today shows no line from "system". Restart the planner: no second line, the copy unchanged.
  - **Going back.** Stop the planner, copy the `.before-0.7.0` file over the log, start: the shelf is retired again and the copy still stands.
  - **A backup.** Download Home's backup from Settings. Make a second household, add the members, and restore Settings and Plans from the file: the preview is clean and the plans arrive with their goals and owners. Edit a copy of the file so one line's op reads `bill.set`: the preview says "This backup was made by a newer Home Planner. It holds bill.set, which this version cannot read."
  - **Every ledger row.** With three members, at 390 and on the desk, dark and light: walk the board, an Area page and a card against rows P1 to P68 of the ledger, using the table at the end of this plan. Then Today, the Calendar, Budget and Settings: each draws, and Today's ask card for an old ask still shows Take it and Decline.
  - The hit-area snippet answers `[]` on the board, an Area page and a card. Graphite, light and dark, at 375 wide: every pressed, chosen and Doing state reads with no hue.

  Stop both by pid.
- [ ] **Step 7: Suite, typecheck, commit** `site/index.html docs/superpowers/design/components.css docs/superpowers/design/2026-10-28-design-language.md README.md DEPLOY.md api/package.json api/package-lock.json api/test/page-ledger.test.ts` and the `api/src` files whose comments changed: "Version 0.7.0: Plan by area, with goals in place of shelves and plans handed on at once."

## Rulings

One line each: the ruling, why, and what it costs if wrong.

1. **`Store.adopt` refuses any event id already in the log, so "restores into its own" cannot pass through it.** Task 7's test restores into a fresh household through `adopt`, and against its own household checks the preview and a dry-run `apply` only. Cost: the spec's sentence promises more than the code does; the owner should rule whether a household's own backup is meant to restore over itself.
2. **"Theirs" and "Mine" stay in Today's filter markup until 0.8.0**, so the ledger checks those words in Plan's markup only, not page-wide as the spec's test list reads. Cost: none on Plan; Today still says "Theirs" for one release.
3. **Between Task 8 and Task 15 the old page's ask button answers 410, and between Task 10 and Task 11 the Plan tab shows the error box.** The branch is never deployed mid-way. Cost: Plan cannot be demonstrated at those two points.
4. **The card's Back shows on the desk too** (`#plan-card .back{display:none}` is deleted): it is now the only way back to Today, the Calendar or an Area page. Cost: one more control on the desk card's head.
5. **A copy that already exists is not a failure** (`EEXIST` from `COPYFILE_EXCL`): "never overwritten" wins over "if either fails". Cost: after a later restore of an old backup, the copy beside the log predates that restore.
6. **A backup holding an unknown op is a 400 from both restore routes**, in the spec's sentence; the Backup page shows it in the slot it already has. Cost: the preview shows nothing else about that file.
7. **`BUILD` and `?v=` start at 0.6.0 in Task 3 and move to 0.7.0 with the package in Task 16**, so the ledger's build test holds after every task. Cost: none.
8. **The fold refuses a goal that is not already tidy** (trimmed, single spaces, 1 to 60); the routes and tools tidy what was typed. The same division `areas.set` has. Cost: a hand-edited log line with a stray space is refused, loudly.
9. **A goal nobody carries filters nothing** in `board()` and is answered `goal: null`. Cost: a chip pressed in a stale tab shows the whole board, not an empty one.
10. **`all.plans` counts open plans; `all.done` is apart.** The spec's "House holds 8 plans, 3 of them done" is `all.plans + all.done`. Cost: a wrong count on the Area page if misread.
11. **A rename is refused when `to` is exactly the stored spelling** ("New roof is already its name"), whatever case `from` was typed in. Cost: none seen.
12. **The fold refuses `areas.move` of an area that is not there**; only add, remove and a move to where it stands are "already true". Cost: a backup that moves an area the target never had is refused whole, as a plan in a missing area already is.
13. **`retireShelves` lives in `households.ts` and takes the copy function as a parameter**, so the failing copy can be tested. Cost: none.
14. **Small forms are closed through `cancelMark` and `cancelOpen`**, and each form's own Escape handler calls `preventDefault()`: the chip box and the step row have no Cancel button to click. Cost: a `WeakMap` beside the `[data-cancel]` mark the spec names.
15. **The crumb's links are navigation, not deep links**: Back from an Area page opened from the crumb returns to the board. `linked` is for Today's and the Calendar's callers in later releases. Cost: one more press to return to the card.
16. **Opened from Budget, Settings or search elsewhere, the card's Back reads "Plan"** and returns to the board. Cost: Back does not return to Budget.
17. **Task 1 also moves `askAnswer` beside `askCardNode`, and leaves `reloadView`, `actionButton`, `textBtn` and `envFrame` where they are**: they are function declarations outside the regions 0.7.0 rebuilds. Cost: 0.8.0's plan moves them.
18. **Task 11 deletes the card's shelf block**, since `boardCard` and `newPlan` go there and the server answers no children from Task 10. Cost: none.
19. **The status after a hand or a goal change survives the card's reload through `cardSaid`.** Cost: one more module variable.
20. **`POST /api/plans` with `owner` equal to the sender writes no hand, and a blank `goal` is no goal.** Cost: none.
21. **The words for the new lines**: "handed", "took", "set T toward G", "took the goal off T", "renamed the goal", "removed the goal", "added the area", "removed the area", "moved the area A to place N", "retired the shelves into goals". The spec leaves them to the builder. Cost: copy the owner may want changed.
22. **`.btn` changes size across the whole app** (the visual audit's list), checked on every tab in Task 9. Cost: a button elsewhere that wraps.
23. **Two members whose initials match show their first two letters** ("Bo", "Be"); two whose first two letters also match still look alike. The spec says "two letters" and no more. Cost: a rare pair of identical discs, told apart by their `title`.
24. **The third fake account is `casey:paper-lantern`**, a test value added to `FAKE_DSM_ACCOUNTS`. Cost: none.
25. **`contrast.py` checks each role against the hex token it points at**, since it cannot resolve `var()`. Cost: a role re-pointed later is not re-checked until its pair is.
26. **The stale-build check sits after static files, the guest door and the phone's setup link, and before the session is read**; `envFrame` gains an `id` because it hard-codes `env-page-h`. Cost: none.

## Every Plan row of the ledger, and the task that owns it

Fate: K kept, C changed, D deleted on purpose. The eight rows the ledger marked "No home" (P13, P21, P25, P31, P33, P51, P63, P64) are kept by the spec as amended and are marked K or C here. A "+" names a second task that draws part of the row.

| Row | Fate | Task | Row | Fate | Task | Row | Fate | Task | Row | Fate | Task |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P1 | K | 11 | P18 | C | 14 | P35 | D | 11 | P52 | K | 14 |
| P2 | C | 11 | P19 | C | 14 | P36 | K | 14 | P53 | K | 14 |
| P3 | C | 11 +12 | P20 | D | 11 | P37 | K | 14 | P54 | K | 14 |
| P4 | C | 11 | P21 | K | 14 | P38 | K | 14 | P55 | K | 14 |
| P5 | C | 11 | P22 | D | 14 +15 | P39 | K | 14 | P56 | K | 14 |
| P6 | D | 11 | P23 | K | 14 | P40 | K | 14 | P57 | K | 14 |
| P7 | C | 11 | P24 | K | 14 | P41 | K | 14 | P58 | K | 14 |
| P8 | D | 11 | P25 | K | 14 | P42 | K | 14 | P59 | K | 14 |
| P9 | C | 11 | P26 | D | 11 | P43 | K | 14 | P60 | K | 14 |
| P10 | D | 11 | P27 | C | 15 | P44 | K | 14 | P61 | K | 14 |
| P11 | C | 11 | P28 | C | 15 | P45 | K | 14 | P62 | K | 14 |
| P12 | C | 11 | P29 | K | 14 | P46 | K | 14 | P63 | C | 14 |
| P13 | K | 11 | P30 | K | 14 | P47 | K | 14 | P64 | K | 11 +12, 14 |
| P14 | D | 11 | P31 | K | 14 | P48 | K | 14 | P65 | K | 14 |
| P15 | D | 11 | P32 | D | 14 | P49 | K | 14 | P66 | K | 14 |
| P16 | D | 11 | P33 | K | 14 | P50 | C | 14 | P67 | K | 14 |
| P17 | C | 9 +11 | P34 | K | 14 | P51 | C | 14 | P68 | K | 14 |

Sixty-eight rows: Task 9 owns 1, Task 11 owns 20, Task 14 owns 45, Task 15 owns 2. None is left over.
