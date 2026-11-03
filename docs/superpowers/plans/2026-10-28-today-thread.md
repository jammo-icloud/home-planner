# Today Thread and Envelope Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Today one shared, permanent thread — briefing, questions, notes, Claude's answers, cards and their decisions, and every direct change — recorded in the household log; and make Import speak in envelopes, with Haiku suggesting matches for what no rule caught.

**Architecture:** Seven new log ops carry the conversation; `replay.ts` folds them into a `thread` slice of state, so the rules (one decision per card, replacement, attribution) hold for every writer. Two new modules sit on top: `offers.ts` (offer, decide, refresh, waiting) and `thread.ts` (the read model the screen pages through). The briefing becomes a section written once per budget per day and recorded as an event. The UI's Today becomes the thread; Activity's tab and screen go away.

**Tech Stack:** Node 26 with type-stripping (no build), `node:test`, `@anthropic-ai/sdk`, single-file vanilla JS in `site/index.html`.

**Spec:** `docs/superpowers/specs/2026-10-28-today-thread-design.md`

## Global Constraints

- Append-only JSONL log per household; state is a replay. Integer cents.
- Every money-moving edit requires a reason. Never floor or clamp a cost estimate.
- Claude never does arithmetic that matters, and never writes: every write is a proposal a member approves, attributed to the member who clicked.
- The actor `claude` may author `thread.briefing`, `thread.answer` and `proposal.offer` only. Replay refuses any other op from it.
- The Anthropic key is optional: without it the fallback briefing, notes and every direct change still work; "Ask Claude" says it is not configured; Import falls back to rules plus manual sorting.
- Haiku is sent payee strings and picker labels only — no amounts, dates or accounts.
- Haiku model: `process.env.CLAUDE_MATCH_MODEL ?? 'claude-haiku-5-5'`.
- No thread op mentions money; another household source must be able to post into the same thread.
- Tabs are built from a list (`TABS`), not hard-coded markup.
- Never commit `api/data/`, `site/budget.jsonl`, `site/transactions.jsonl`, `site/planner.html`, `.env`. Use `/opt/homebrew/bin/git`. Do not push until the owner says so. Run the residue grep before any push.
- Test command (from `api/`): `npm test; echo rc=$?` — never pipe it through grep without keeping the exit code.

## Review Focus

1. **Both members approve the same card within a second of each other** → exactly one approval applies; the second gets "already decided". (Task 1, guard in replay.)
2. **A backup restored with the thread but without months, or the reverse** → it folds cleanly; offers naming a budget that is not present stay readable and can only be declined. (Task 1.)
3. **Claude fails mid-question** → the question stays in the thread with no answer and an "Ask again" control; nothing half-written. (Task 5.)
4. **Haiku returns a value that is not one of the options, or a payee it was not sent** → ignored; the row stays unsorted. (Task 7.)
5. **A note or question containing HTML, or 10,000 characters** → shown as text, never markup; capped at 2,000 characters with a clear refusal. (Tasks 5 and 8.)

---

### Task 1: Thread ops in the log, the fold, and restore

**Files:**
- Modify: `api/src/types.ts` (Event union ~178–340, `Txn` ~62, `State` ~366)
- Modify: `api/src/replay.ts` (`freeze`, `thaw`, `applyTo`, `validate`)
- Modify: `api/src/restore.ts` (`Scope`, `scopeOf`)
- Modify: `site/index.html` (restore scope checkboxes near line 820)
- Test: `api/test/thread.test.ts` (new)

**Interfaces:**
- Produces, in `types.ts`:
  ```ts
  export const CLAUDE: Actor = 'claude';
  export type OfferStatus = 'open' | 'snoozed' | 'approved' | 'declined' | 'replaced';
  export interface OfferPrompt { readonly kind: 'briefing' | 'answer' | 'member'; readonly ref: EventId | null }
  export interface Offer {
    readonly id: EventId; readonly at: string; readonly who: Actor;
    readonly tool: string; readonly args: Record<string, unknown>;
    readonly summary: string; readonly effects: readonly string[];
    readonly events: readonly NewEventShape[];   // the events approval appends
    readonly budget: BudgetId | null; readonly month: Month | null;
    readonly envelopes: readonly EnvelopeId[];   // what it touches, for replacement
    readonly fingerprint: string;
    readonly prompt: OfferPrompt;
    readonly status: OfferStatus;
    readonly decidedBy?: Actor; readonly decidedAt?: string; readonly why?: string;
    readonly replacedBy?: EventId;
  }
  export interface ThreadState {
    readonly offers: ReadonlyMap<EventId, Offer>;
    /** Per member, the flag events they have marked seen. */
    readonly seen: ReadonlyMap<Actor, ReadonlySet<EventId>>;
  }
  ```
  `State` gains `readonly thread: ThreadState`. `NewEventShape` is `DistributiveOmit<Event,'id'|'at'|'who'>` moved here from `store.ts` (store re-exports it as `NewEvent`).
- New Event variants:
  ```ts
  | { op: 'thread.briefing'; day: Day; source: 'budget'; budget: BudgetId | null;
      headline: string; body: string; writtenBy: 'claude' | 'fallback'; replaces?: EventId }
  | { op: 'thread.ask'; question: string; budget: BudgetId | null }
  | { op: 'thread.note'; text: string; budget: BudgetId | null }
  | { op: 'thread.answer'; replyTo: EventId; text: string;
      tools: readonly { name: string; args: Record<string, unknown> }[]; model: string }
  | { op: 'proposal.offer'; tool: string; args: Record<string, unknown>; summary: string;
      effects: readonly string[]; events: readonly NewEventShape[];
      budget: BudgetId | null; month: Month | null; envelopes: readonly EnvelopeId[];
      fingerprint: string; prompt: OfferPrompt; replaces?: EventId }
  | { op: 'proposal.decide'; proposal: EventId; decision: 'approved' | 'declined' | 'snoozed'; why?: string }
  | { op: 'flag.seen'; event: EventId }
  ```
- `Txn` and the `txn.categorize` variant gain `suggestedBy?: 'claude'`.
- `Scope` becomes `'facts' | 'budgets' | 'months' | 'people' | 'thread'`; all seven ops map to `'thread'`.

- [ ] **Step 1: Write the failing tests** in `api/test/thread.test.ts`, using the `household()` helper pattern from `starter.test.ts`:
  - `an offer folds into state as open, and a decision closes it` — append `proposal.offer` as `claude`, then `proposal.decide approved` as `alice`; `state.thread.offers.get(id).status === 'approved'`, `decidedBy === 'alice'`.
  - `a second decision on the same card is refused` — two `proposal.decide` on one offer; the second `append` rejects with `/already decided/`; `status` stays `approved`. (Review Focus 1.)
  - `an offer that replaces another marks the old one replaced` — `replaces: oldId` ⇒ old `status === 'replaced'`, `replacedBy === newId`; deciding the old one is refused.
  - `a snoozed offer can still be approved` — decide `snoozed`, then `approved` ⇒ `approved`.
  - `claude may only offer, answer and brief` — `append('claude', { op: 'move', … })` rejects with `/claude cannot/`; `thread.note` from `claude` rejects too.
  - `flag.seen is per member` — `alice` sees `e1`; `state.thread.seen.get('alice').has('e1')`, `bob` has nothing.
  - `thread ops restore as their own scope` — `scopeOf` returns `'thread'` for each of the seven ops.
  - `an offer for a budget that is not here still folds` — offer with `budget: 'gone'` appends cleanly (Review Focus 2).
- [ ] **Step 2: Run** `cd api && npm test; echo rc=$?` — expected: the new file fails (unknown ops / missing `thread`), everything else passes.
- [ ] **Step 3: Implement** the types above; in `replay.ts` add the `thread` draft (Map of offers, Map<Actor, Set>), fold each op, and in `validate()` refuse `who === CLAUDE` for any op outside `thread.briefing | thread.answer | proposal.offer`. `proposal.decide` throws `ReplayError('already decided')` unless the offer exists with status `open` or `snoozed`. `thread.ask`/`thread.note` throw if the text is blank or over 2,000 characters. The approval's money events are not folded here — `decide` appends them in the same batch (Task 2).
- [ ] **Step 4: Run** `npm test; echo rc=$?` — expected: all pass, `rc=0`.
- [ ] **Step 5:** add a `thread` checkbox ("Conversation and decisions") to the restore scope picker in `site/index.html`, next to the existing four.
- [ ] **Step 6: Commit** `git add api/src/types.ts api/src/replay.ts api/src/restore.ts api/src/store.ts api/test/thread.test.ts site/index.html && git commit -m "Record the conversation in the log: thread ops, their fold, and a restore scope"`

---

### Task 2: Offers — offer, decide, refresh, adjust, waiting

**Files:**
- Create: `api/src/offers.ts`
- Modify: `api/src/tools.ts` (export `touches()` helper beside `describe`)
- Test: `api/test/offers.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `toolByName`, `ToolContext`, `ToolError`, `Proposal` from `tools.ts`; `monthView` from `envelopes.ts`.
- Produces:
  ```ts
  export function fingerprint(state: State, budget: BudgetId | null, month: Month | null,
                              envelopes: readonly EnvelopeId[]): string;
  export async function offer(ctx: ToolContext,
    o: { tool: string; args: Record<string, unknown>; prompt: OfferPrompt; by?: Actor }): Promise<Offer>;
  export async function decide(ctx: ToolContext, offerId: EventId,
    decision: 'approved' | 'declined' | 'snoozed', why?: string): Promise<Event[]>;
  export async function refresh(ctx: ToolContext, offerId: EventId): Promise<Offer>;
  export async function adjust(ctx: ToolContext, offerId: EventId, args: Record<string, unknown>): Promise<Offer>;
  export type Waiting =
    | { kind: 'offer'; offer: Offer; moved: boolean }
    | { kind: 'flag'; event: EventId }
    | { kind: 'unsorted'; count: number };
  export function waiting(state: State, who: Actor, events: readonly Event[]): Waiting[];
  ```
  In `tools.ts`: `export function touches(events: readonly NewEvent[]): { budget: BudgetId | null; month: Month | null; envelopes: EnvelopeId[] }` — reads `move.from/to`, `assign.envelope`, `income.set`, `month.*`.

- [ ] **Step 1: Write the failing tests** (`offers.test.ts`, seeded with a budget, an open month and two envelopes as `tools.test.ts` does):
  - `offer runs the write tool and records what approval would append` — `offer(ctx,{tool:'move_money', args:{…, amountCents:12000, why:'trip paid'}, prompt:{kind:'briefing',ref:null}})` ⇒ an `Offer` whose `events[0].op === 'move'`, `envelopes` contains both ids, `who === 'claude'`.
  - `approving appends the decision and its effect in one write` — after `decide(…,'approved','trip paid')`, the last two events are `proposal.decide` then `move`, same `at`, both by `alice`.
  - `a new offer touching the same envelope in the same month replaces the waiting one` — second `offer` for the same envelopes ⇒ first `status === 'replaced'`.
  - `an offer on other envelopes leaves the first alone`.
  - `approving after the numbers moved is refused` — offer, then import a receipt into one named envelope, then `decide approved` rejects with ToolError 409 `/numbers have moved/`.
  - `refresh re-runs the stored tool and replaces the card` — new offer with the current fingerprint, old `replaced`.
  - `adjust makes a member's offer that replaces the original` — `who === 'alice'`, `prompt.kind === 'member'`.
  - `a snoozed card is waiting again only once its numbers change` — snooze ⇒ absent from `waiting`; change a figure ⇒ present with `moved: true`.
  - `a card whose month has closed is not waiting` — close the month ⇒ absent.
  - `a removed receipt waits for the other member, not the one who removed it` — `waiting(state,'alice')` lacks it when alice removed it; `waiting(state,'bob')` has it until `flag.seen` by bob.
  - `unsorted receipts wait as one item with a count`.
- [ ] **Step 2: Run** `npm test; echo rc=$?` — the new file fails.
- [ ] **Step 3: Implement.** `fingerprint` = `JSON.stringify` of `[toAssign, ...envelopes.map(id => [id, available, activity])]` from `monthView`, or `''` when there is no budget/month. `offer` runs the tool with a fresh `ProposalStore`, rejects read tools, computes `touches`, finds an `open|snoozed` offer with the same budget+month and any shared envelope and sets `replaces`, then appends `proposal.offer` as `o.by ?? CLAUDE`. `decide('approved')` recomputes the fingerprint and throws `ToolError('the numbers have moved since this was suggested', 409)` on mismatch, else appends `[proposal.decide, ...offer.events]` in one `store.append(ctx.who, …)`. An offer whose budget no longer exists can only be declined (`ToolError 409`). `waiting` excludes offers whose month is closed (from `state.months`).
- [ ] **Step 4: Run** `npm test; echo rc=$?` — all pass.
- [ ] **Step 5: Commit** `git add api/src/offers.ts api/src/tools.ts api/test/offers.test.ts && git commit -m "Cards that remember what they were based on, and one decision each"`

---

### Task 3: The thread read model (Activity folded in)

**Files:**
- Create: `api/src/thread.ts`
- Modify: `api/src/activity.ts` (extract the entry builder; keep `removedTxn`)
- Test: `api/test/thread.test.ts` (extend); keep `api/test/activity.test.ts` passing or move its cases

**Interfaces:**
- Consumes: Task 1 state; `waiting()` from Task 2; `describe` from `tools.ts`.
- Produces:
  ```ts
  export type ThreadEntry =
    | { kind: 'briefing'; id: EventId; at: string; budget: BudgetId | null; day: Day;
        headline: string; body: string; writtenBy: 'claude' | 'fallback'; cards: Offer[] }
    | { kind: 'ask' | 'note'; id: EventId; at: string; who: Actor; text: string; budget: BudgetId | null;
        answer?: { id: EventId; at: string; text: string; tools: string[]; cards: Offer[] } }
    | { kind: 'card'; id: EventId; at: string; offer: Offer }      // a member's adjusted card
    | { kind: 'change'; id: EventId; at: string; who: Actor; what: string; why: string | null;
        count: number; budget: BudgetId | null;
        flag?: { removed?: Removed; seenByMe: boolean } };
  export interface ThreadPage {
    entries: ThreadEntry[];          // oldest first within the page
    waiting: Waiting[];
    newSince: EventId | null;        // the caller's read cursor, for the divider
    before: EventId | null;          // pass back to page further up; null at the start
  }
  export async function thread(store: Store, o: {
    who: Actor; budget: BudgetId | null; allBudgets?: boolean;
    filter?: 'everything' | 'mine' | 'theirs' | 'waiting'; before?: EventId; limit?: number;
  }): Promise<ThreadPage>;
  export function budgetOf(e: Event): BudgetId | null;   // null = household-wide
  ```
- `activity.ts` exports `changeEntries(events: readonly Event[], state: State): Extract<ThreadEntry,{kind:'change'}>[]` (the existing collapse/never-collapse-removals logic, unchanged in behaviour). `activity()` is deleted with its route in Task 6.

- [ ] **Step 1: Write the failing tests:**
  - `answers attach to their question, and cards to what prompted them`.
  - `a briefing replaced by a later one that day shows only the newer`.
  - `direct changes appear as change entries, collapsed as Activity collapsed them; removals never collapse`.
  - `bookkeeping ops never appear` — `briefing.read`, `prediction.record`, `proposal.decide`, `flag.seen`, `proposal.offer` (the card shows on its prompt instead).
  - `the default view is the budget in view plus household-wide entries` — an `assign` on budget B is hidden when viewing A; a `txn.add` is shown; `allBudgets: true` shows both.
  - `mine and theirs filter by who; waiting returns only entries with something waiting`.
  - `paging returns the newest page first and a cursor to go further up` — 250 events, `limit: 100` ⇒ 100 entries, `before` set; following it reaches the start with `before === null`.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.** `budgetOf` reads `e.budget` where the op has one (including thread ops and `proposal.offer`), else `null`. Page by walking `store.since(null)` from the end.
- [ ] **Step 4: Run** — all pass.
- [ ] **Step 5: Commit** `git commit -m "One thread: what was said, what was decided, and what was done directly"`

---

### Task 4: The briefing becomes a recorded section

**Files:**
- Modify: `api/src/briefing.ts` (`brief`, cache, `facts`)
- Test: `api/test/briefing.test.ts` (update)

**Interfaces:**
- Consumes: `offer()` from Task 2; Task 1 ops.
- Produces:
  ```ts
  export interface Section { readonly event: EventId; readonly budget: BudgetId; readonly day: Day; readonly writtenBy: 'claude' | 'fallback' }
  /** The day's section for this budget: returned if recorded, written and recorded if not. */
  export async function ensureSection(store: Store, o: { who: Actor; budget: BudgetId; today: Day; month?: Month }): Promise<Section>;
  export type SectionSource = (store: Store, o: { who: Actor; budget: BudgetId; today: Day }) => Promise<Section | null>;
  export const SOURCES: readonly SectionSource[];  // [ensureSection], so another source is one more entry
  ```
  The `Briefing` type and `/api/briefing` route stay only as long as Task 8 needs them, then go.

- [ ] **Step 1: Update/write the tests:**
  - `a section is written once per budget per day and shared by both members` — `ensureSection` as alice then as bob ⇒ one `thread.briefing`, one Claude call.
  - `the next day writes a new one`.
  - `a fallback section is retried, and a Claude-written one replaces it that day` — first call with a failing fake ⇒ `writtenBy: 'fallback'`; second with a working fake ⇒ new event with `replaces`.
  - `each decision that names a runnable tool becomes an offer prompted by the section` — `prompt.kind === 'briefing'`, `ref` is the section's id.
  - `the facts include notes left since the last section` — append `thread.note 'trip is paid for'`; the request Claude receives contains it.
  - `the facts list changes since the previous section, not since this person last read`.
  - `a snoozed card whose numbers moved is mentioned in the next section` — snooze, change a figure, next day's request contains the card's summary.
  - Keep: `a refusal still surfaces as a refusal`; prediction recording; the change-list count wording.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.** Write the `thread.briefing` as `CLAUDE` (also for the fallback, with `writtenBy: 'fallback'`), then `offer()` each decision's `suggests`. Drop the per-person cache key; the recorded event is the cache.
- [ ] **Step 4: Run** — all pass.
- [ ] **Step 5: Commit** `git commit -m "Write the day's briefing once, for both of you, and keep it"`

---

### Task 5: Ask Claude, and leave a note

**Files:**
- Modify: `api/src/claude.ts` (`AskResult` gains `calls`)
- Create: `api/src/conversation.ts`
- Test: `api/test/conversation.test.ts`

**Interfaces:**
- Produces in `claude.ts`: `AskResult.calls: readonly { name: string; args: Record<string, unknown>; kind: 'read' | 'write' }[]`; `ask()` accepts `opts.history?: Anthropic.Beta.BetaMessageParam[]` placed before the question.
- Produces in `conversation.ts`:
  ```ts
  export async function note(ctx: ToolContext, text: string, budget: BudgetId | null): Promise<Event>;
  export async function askInThread(ctx: ToolContext, question: string, budget: BudgetId | null):
    Promise<{ question: Event; answer: Event | null; offers: Offer[]; error?: string }>;
  export function dayContext(events: readonly Event[], budget: BudgetId | null, today: Day): string;
  ```

- [ ] **Step 1: Write the failing tests** (FakeClaude from `briefing.test.ts`, moved to `api/test/fake-claude.ts` and imported by both):
  - `a note is recorded and costs no call` — fake records zero calls.
  - `a note works with no key configured`.
  - `a question and its answer are both recorded; the answer is by claude and lists its tools`.
  - `Claude sees today's briefing, notes and earlier questions` — the first request's text contains the section headline, the note text and the earlier question.
  - `a write Claude proposes becomes a card prompted by the answer` — fake calls `move_money` ⇒ one offer, `prompt.ref === answer.id`.
  - `when Claude fails, the question stays and no answer is written` — fake throws ⇒ `answer === null`, `error` set, one `thread.ask` in the log (Review Focus 3).
  - `text over 2,000 characters is refused before anything is written` (Review Focus 5).
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.** `askInThread` appends `thread.ask` first, calls `ask()` with `context` from the server's existing string plus `dayContext(...)`, then appends `thread.answer` as `CLAUDE` and `offer()`s each write call by name and args (not the in-memory proposal). Refusal ⇒ rethrow `ClaudeRefused` after the question is recorded.
- [ ] **Step 4: Run** — all pass.
- [ ] **Step 5: Commit** `git commit -m "Ask Claude in the thread, or leave the other a note"`

---

### Task 6: Routes

**Files:**
- Modify: `api/src/server.ts` (route table comment at top; new routes; delete `/api/activity`)
- Test: `api/test/server-thread.test.ts` (start the server on port 0 with a temp `HOUSEHOLDS_DIR` and the fake DSM pattern used in `auth.test.ts`)

**Interfaces (all JSON, all for the signed-in member's open household):**
- `GET  /api/thread?budget=&all=1&filter=&before=` → `ThreadPage`; ensures today's section for `budget` exists first.
- `POST /api/thread/ask { question, budget }` → `{ question, answer, offers, error? }` (503 when no key, 422 on refusal)
- `POST /api/thread/note { text, budget }` → `{ event }`
- `POST /api/thread/decide { offer, decision, why? }` → `{ committed }` (409 "numbers have moved" / "already decided")
- `POST /api/thread/refresh { offer }` → `{ offer }`
- `POST /api/thread/adjust { offer, args }` → `{ offer }`
- `POST /api/thread/seen { event }` → `{ ok: true }`
- `POST /api/match { budget, txnIds }` → see Task 7.

- [ ] **Step 1: Write the failing tests:** one happy path per route, plus `decide` returning 409 for a second approval and for moved numbers, and `GET /api/activity` returning 404.
- [ ] **Step 2–4:** run, implement (thin: parse, call Tasks 2–5, `json()`), run.
- [ ] **Step 5: Commit** `git commit -m "Routes for the thread"`

---

### Task 7: Import and Unsorted speak in envelopes, with Haiku suggesting

**Files:**
- Create: `api/src/match.ts`
- Modify: `api/src/server.ts` (`/api/import/preview`, `/api/import/commit`, `/api/match`)
- Modify: `api/src/claude.ts` (a `classify<T>(model, system, user, schema)` call alongside `structured`, no tools)
- Test: `api/test/match.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PickerOption { value: string; label: string; group: string }   // value: category id | '__transfer' | '__income'
  export function pickerOptions(state: State, budget: BudgetId, t: Pick<Txn,'payee'|'memo'> | null): PickerOption[];
  export interface Suggestion { value: string; confidence: number }
  export const MATCH_THRESHOLD = 0.7;
  export async function suggest(payees: readonly string[], options: readonly PickerOption[]): Promise<Map<string, Suggestion>>;
  ```
- Preview response gains `options: PickerOption[]`, per row `options?` (only when it differs from the shared list) and `suggested?: string`; `suggestError?: string` when Haiku failed. Commit rows accept `suggestedBy?: 'claude'`, stored on the `Txn`.

- [ ] **Step 1: Load the `claude-api` skill** and confirm which request fields Haiku 5.5 accepts (thinking, effort, structured output) before writing `classify`.
- [ ] **Step 2: Write the failing tests:**
  - `an envelope fed by one category is labelled with the envelope` — `"Groceries"`, group `"People"`.
  - `an envelope fed by several is labelled envelope · category` — `"Utilities · Electricity"`.
  - `a payee-narrowed envelope labels the receipt where it will land` — a budget with `electricity` broad plus `electricity`+payee `EXAMPLE POWER`; for payee `EXAMPLE POWER BILLPAY` the electricity option reads the narrowed envelope's label.
  - `a category with no envelope here is offered under "Not in this budget"`.
  - `transfer and income are always offered`.
  - `Haiku is sent only payees and labels` — the fake's request contains no `$`, no date pattern, no account.
  - `payees are de-duplicated into one request`.
  - `a low-confidence or unknown answer is dropped` — confidence 0.4 ⇒ absent; value `'nope'` ⇒ absent; payee not sent ⇒ absent (Review Focus 4).
  - `preview still returns when Haiku fails, saying why`.
  - `rows a rule sorted are never sent to Haiku`.
  - `no key ⇒ no call and no suggestions`.
- [ ] **Step 3–4:** run (fails), implement, run (passes).
- [ ] **Step 5: Commit** `git commit -m "Sort imports by envelope, with Claude suggesting what no rule caught"`

---

### Task 8: The Today screen is the thread

**Files:**
- Modify: `site/index.html` — replace `#briefing` (~540–566) and its functions (`load`, `renderDecisions`, `renderChanges`, `previewProposal`, `renderScored` ~1000–1190) with the thread; delete `#activity` (~646–653) and `loadActivity`/`activityCard` (~2571–2735), keeping `removedBlock`/`askToRestore` for flags; build tabs from `const TABS = [{view:'today',label:'Today'},{view:'budget',label:'Budget'},{view:'import',label:'Import'},{view:'compare',label:'Compare'}]`.

**Interfaces:** consumes the Task 6 routes only.

Decided here, for the builder:
- Layout top to bottom: filters (Everything · Mine · Theirs · Waiting, plus an "All budgets" switch) → the thread → the waiting tray (`N waiting`, jumps to the oldest) → the reply box (textarea, **Ask Claude**, **Leave a note**). The reply box sticks to the bottom of the viewport; on phone it sits above the bottom tab bar.
- On open: fetch the newest page, scroll to the bottom; "Earlier" at the top loads `before`.
- Each day starts with a date divider. The "New since you last looked" divider sits at `newSince`; reaching the bottom posts `/api/briefing/read`.
- Card controls: **Approve** (asks for a reason, prefilled from the card's `why` arg when there is one), **Not now**, **Adjust** (opens the tool's form prefilled), and when `moved`: "The numbers have moved since this was suggested" + **Work it out again** (refresh) instead of Approve.
- An answer shows its time as "as of 7:52pm" (and the date once it is not today), so its figures read as then, not now.
- The unsorted waiting item reads "N receipts to sort" and links to the Unsorted list on Budget.
- Decided cards collapse to one line: "Approved by alice, 8:14pm — trip is paid for".
- Flags: the existing removed-receipt block, **Put it back** (the existing restore flow) and **Seen it**.
- An unanswered question shows "Claude didn't answer: {error}" and **Ask again**.
- Every member- or Claude-authored string is set with `textContent`. Never `innerHTML` (Review Focus 5).
- Without a key, **Ask Claude** is disabled with "Claude isn't set up on this server"; notes work.
- Refresh the thread on `visibilitychange` to visible and after every action. No polling.

- [ ] **Step 1:** Build it against the local container (`docker compose up -d --build budget-api`), signed in as the test account at `127.0.0.1:8090` on a test household — never the owner's household.
- [ ] **Step 2: Verify in the browser pane, at phone (375) and desktop width:** ask a question (fake-free, real key), leave a note, approve a card, snooze one then change its numbers and see it return, approve a moved card (refused, refresh offered), filters, paging, a removed receipt flagged for the other account only, no horizontal scroll, keyboard reachability of every control.
- [ ] **Step 3: Commit** `git commit -m "Today is the thread"`

---

### Task 9: Import picker, Unsorted suggestions, chevrons, bank links

**Files:** `site/index.html` — `categorySelect` → `envelopeSelect(options, value)` with `<optgroup>` per group; `renderPreview` / `updateCommit`; `loadUnsorted`; `envelopeRow` (~1270); the "Where to get one" list (~620).

Decided here:
- Suggested rows: the select is preset, the row has a `suggested` class (dashed ion left border) and a "Suggested" tag; **Accept** per row and **Accept all suggestions** above the table. Only accepted rows commit with a category (and `suggestedBy: 'claude'`); unaccepted suggestions commit unsorted.
- After an import with accepted suggestions: "Remember these N as rules" → `categorize_transactions` with `alsoAddRuleMatching: ruleSuggestion(payee)`, previewed and approved as now.
- Unsorted on Budget: **Suggest envelopes** → `POST /api/match` → same presentation.
- Envelope rows: the `.inc-toggle` chevron (CSS ~359–362) on `.env-head`, rotating with `aria-expanded`.
- Bank links, opened in a new tab with `rel="noopener"`: "Sign in to Example Bank" → `https://bank.example.com/`, "Sign in to Example Credit Union" → `https://cu.example.com/`. Load both in the browser pane once before committing to confirm they resolve to the sign-in pages.

- [ ] **Step 1–2:** Build and verify as in Task 8 with a small CSV (rule hit, Haiku hit, Haiku miss, a transfer).
- [ ] **Step 3: Commit** `git commit -m "Pick envelopes, accept suggestions, see which rows open, and reach your bank"`

---

### Task 10: Documents, and the whole-branch check

**Files:** `README.md` (Claude section, Getting transactions in), `DEPLOY.md` (env table: `CLAUDE_MATCH_MODEL`; failure table: Haiku unavailable at import), `.env.example` (`CLAUDE_MATCH_MODEL=` blank).

- [ ] **Step 1:** Update the three files: the thread is the record and is backed up; notes cost nothing; what Haiku is sent.
- [ ] **Step 2: Run** `cd api && npm test; echo rc=$?` then `npm run typecheck; echo rc=$?` — all `rc=0`.
- [ ] **Step 3: Residue check** — run the personal-names grep from the original handover brief; it must print nothing. It is not copied here because the pattern would match itself.
- [ ] **Step 4: Commit** `git commit -m "Document the thread and envelope matching"`. Do not push.
