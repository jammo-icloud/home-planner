# Removing a household for good: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner of a household can remove it entirely, log and all, so that everyone in it lands back on Choose a household and the owner can start again from the first sign-in.

**Architecture:** A household is one directory under the households folder holding its log; the app keeps no registry. Removal is therefore: forget the cached replay, remove the directory, and clear the household from every live session that had it open. One new route does that for the owner, after the household's name is typed back. The page offers it as the last row of Settings › Household and returns to the picker. Drive documents, the Synology calendar and the NAS-wide settings are outside the app and are not touched.

**Tech Stack:** Node 22+ native TypeScript (`--experimental-strip-types`), `node:test`, vanilla JS page.

**Spec:** James's rulings in chat on 2026-11-05: option 2 of three (back to Choose a household), the log deleted for good, owner only.

## Global Constraints

- Commit with `/opt/homebrew/bin/git -c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com commit`. The message is a plain sentence, no conventional-commit prefix, ending with a blank line and exactly this trailer, whatever model you are: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- Never commit `api/data/`, `site/budget.jsonl`, `site/transactions.jsonl`, `site/planner.html`, `.env`, or anything under `.claude/`.
- Nothing in the tree may name the household: no real domain, no private IP, no first names, no banks or vendors. Examples use `planner.example.com`, `alex`, `bob` and `alice`.
- No new npm dependencies.
- Tests: `cd api && npm test` (1764 pass at the base commit) and `npm run typecheck` stay green after every task.
- Copy is in sentences in the voice of the rest of Settings: plain words, no exclamation marks, nothing softened. A delete says delete.

## The contract between the tasks

`POST /api/households/remove` with body `{ household: string, label: string }`.

- 200 `{ removed: id }` when `who` owns `household` and `label` equals the household's current label exactly (case and spaces included).
- 403 `'only the owner can remove a household'` when `who` is a member but not the owner.
- 403 `'you do not have access to that household'` when `who` is not a member, or the id does not exist (the same answer as `/api/households/select`, so a stranger learns nothing).
- 400 `"type the household's name exactly to remove it"` when the label does not match.
- A sandbox (local) session gets 409 `'the local sandbox has no household to remove'`.
- After 200: the directory is gone; `GET /api/households` no longer lists it for anyone; every session that had it open (the owner's and each member's) has `household: null`, so their next household request answers 409 `'no household is open — choose or create one'`.

The settings payload already carries `setup.owner`, `setup.youOwn`, `members`, and the page knows the open household's id from `GET /api/households` (`current`) and its label from the picker's list.

## Review Focus

1. **Two owners' households with similar names.** The label check is against the household the id names, never a search by label. Pinned in Task 1's wrong-name test.
2. **A member with the household open while the owner removes it.** Their session is cleared on the server; their next click gets 409 and the page shows the picker, not a stack of errors. Pinned in Task 1's member-session test and Task 2's handling of 409 after removal.
3. **The id is a directory name.** Only `isValidId` ids are ever joined to the households folder, and the removal uses the `Households` class's own path, never a path from the request. Pinned in Task 1 by refusing an invalid id with the 403 above.
4. **The cached replay.** A removed household must not be served from the cache afterwards, and a new household created with the same name (same slug) must start empty. Pinned in Task 1's "same name again starts empty" test.
5. **The booking household.** If booking pointed at the removed household, the booking page must still load (as off) rather than crash. Pinned in Task 1 with a test only if `bookingNow` resolves the household by id at request time; otherwise note in the ledger why not.

---

### Task 1: The server removes a household for its owner

**Files:**
- Modify: `api/src/households.ts` (the `Households` class), `api/src/auth.ts` (the sessions store, `select` is at ~113), `api/src/server.ts` (the `/api/households` routes ~1775-1800 and the route comment block near line 52)
- Modify: `api/test/households.test.ts`
- Create: `api/test/server-households.test.ts` (copy the harness shape of `api/test/server-phone-setup.test.ts`: fake DSM, `alex` and `bob`, env set before importing `../src/server.ts`)

**Interfaces:**
- Produces: `Households.remove(id: string): Promise<void>` — forgets the cache, then `rm` of `join(this.dir, id)` recursively; throws if `!isValidId(id)`. Ownership is the route's check, not the class's, matching how `create` and `open` work.
- Produces: `Sessions.leave(household: string): number` in `auth.ts` — sets `household: null` on every live session (local ones excluded) whose household is that id, persists as `select` does, returns how many it cleared.

- [ ] **Step 1: Failing tests in `api/test/households.test.ts`**

```ts
test('removing a household deletes its directory and forgets its replay', ...)
// create alex "Wren"; open it; remove('wren'); ids() no longer includes it; existsSync(dir/wren) is false;
// open('wren') now loads an empty store (no claim) — assert state.owner === null; or that ids() stays empty afterwards.
test('a household made again under the same name starts empty', ...)
// create alex "Wren", append a budget.create (or any event), remove, create alex "Wren" again → state.budgets.size === 0, owner alex.
test('an id that is not a directory name is refused before anything is touched', ...)
// assert.rejects(remove('../x')) ; assert.rejects(remove('A B'))
```

- [ ] **Step 2: Failing tests in `api/test/server-households.test.ts`**

Set up: alex signs in, creates "Wren" (`POST /api/households`), adds bob (`POST /api/members { member: 'bob' }`), bob signs in and selects it. Then:

```ts
test('a member who is not the owner is refused', ...)            // bob → 403 'only the owner can remove a household'
test('a stranger learns nothing', ...)                            // a third account, or alex with an id that does not exist → 403 'you do not have access to that household'
test('the name must be typed exactly', ...)                       // alex with label 'wren' → 400 "type the household's name exactly to remove it"; the household still lists
test('the owner removes it, and every session that had it open is cleared', ...)
// alex with label 'Wren' → 200 { removed: 'wren' }; GET /api/households for alex and for bob no longer lists it;
// GET /api/today for alex → 409 'no household is open — choose or create one'; the same for bob.
test('a sandbox session has nothing to remove', ...)              // only if the harness can make a local session cheaply (DEV_USER); else skip with a note
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd api && node --test --experimental-strip-types test/households.test.ts test/server-households.test.ts`
Expected: FAIL (`remove` is not a function; 404 from the route).

- [ ] **Step 4: Implement**

`households.ts`: `remove` as in Interfaces, with a comment saying this is the one place the app deletes anything and why it is allowed to (the owner asked, by name). `auth.ts`: `leave`. `server.ts`: the route in the contract, placed after `/api/households/select`; order of checks: valid id and membership (403, same words as select), then owner (403), then label (400), then `households.remove`, then `sessions.leave`, then 200. Log one line: `[budget] household <id> removed by <who>`. Add the route to the comment block at the top. Do not touch `archive_budget`'s guard.

- [ ] **Step 5: Suite, typecheck, commit**

Run: `cd api && npm test && npm run typecheck`
Expected: pass.

```bash
git add api/src/households.ts api/src/auth.ts api/src/server.ts api/test/households.test.ts api/test/server-households.test.ts
git commit   # "The owner of a household can remove it for good, and everyone who had it open lands on the picker"
```

---

### Task 2: The page offers it, and the docs say what it is

**Files:**
- Modify: `site/index.html` (Settings › Household's row list ~7624; `backupRow` ~8911 is the model for a row; `panel()` ~4682 with the `direct:` form seen near line 2317; `showHouseholds` ~10200 and `openHousehold`/`enterApp`), `README.md` (Households and sign-in, ~92), `DEPLOY.md` (Who owns the budget, ~138, and A fresh install starts empty, ~802), `api/package.json` and `api/package-lock.json` (0.3.2)

**Interfaces:**
- Consumes: the route in the contract above. Do not wait for Task 1 to exist; code to the contract.

- [ ] **Step 1: The row**

`removeRow()` returned last in the Household group's rows, only when `settingsData.setup.youOwn`:
- key `remove`, title `Remove this household`
- status: `Everything in it goes, for everyone in it, for good. A backup from the row above is the only way back.`
- one action `Remove…` that opens the panel below.

- [ ] **Step 2: The panel**

`panel()` with title `Remove ${label} for good`, where `label` is the open household's label (from the picker's list, matched by `current` id; fall back to the id). Above the field, two short paragraphs, exactly:
- `This deletes the household's log: its budgets, receipts, plans, rules, members and history. Everyone in it is signed out of it and lands on Choose a household.`
- `It does not touch your files in Drive, the calendar in Synology Calendar, other households, or the NAS's own settings.`
One field, name `label`, label `Type the household's name`, placeholder the label itself. The submit button reads `Remove ${label} for good` and uses the `direct:` form to `POST /api/households/remove` with `{ household: id, label: typed }`. On a 400 or 403 the panel shows the server's words beside the field and stays open. On 200: clear `localStorage` keys that name the household's budget (`budget`), leave Settings, fetch `GET /api/households` and call `showHouseholds` with the answer, so the owner sees Choose a household, or Nothing here yet with Start a new household.

- [ ] **Step 3: The other members**

Find where the page handles a 409 `no household is open` from a request made while the app is showing (search `no household is open` and `enterApp`). If it already returns to the picker, leave it; if it shows an error, make that one message route to `showHouseholds` after a `GET /api/households`. One sentence of comment on why.

- [ ] **Step 4: Docs and version**

README, Households and sign-in: one paragraph, that the owner can remove a household under Settings › Household, that it deletes the log for everyone in it, that a backup is the only way back, and that it is how to start again from the first sign-in. DEPLOY.md, Who owns the budget: the same in the administrator's register, adding that an administrator who does not own a household cannot remove it (they see that households exist, never what is in them), and that the `data` folder's other households and `connectors.json` are untouched. A fresh install starts empty: one sentence pointing at removal as the way to get back there. Version: `cd api && npm version 0.3.2 --no-git-tag-version`.

- [ ] **Step 5: Suite, typecheck, sweep, commit**

Run: `cd api && npm test && npm run typecheck`
Run: `grep -rniE 'mofamily|motown|192\.168\.|jamesmorris' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude . | grep -v 'api/data\|\.jsonl'` — expected no output.

```bash
git add site/index.html README.md DEPLOY.md api/package.json api/package-lock.json
git commit   # "Version 0.3.2: Settings lets the owner remove the household for good"
```
