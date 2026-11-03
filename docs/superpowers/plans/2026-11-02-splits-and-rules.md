# Split Receipts and Model-Written Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A receipt can be divided across several categories by amount and the parts land in their envelopes; Haiku may answer "split" and returns the substring that should become the rule, which the Remember box offers after the server has checked it.

**Architecture:** One new log op, `txn.split`, folds into the existing `Txn` as `category: '__split'` plus `split: SplitPart[]`; `partsOf(t)` is the single join every reader uses. `envelopes.ts` rolls parts into envelopes as `lines`. `match.ts` adds the `__split` option and a `rule` field to Haiku's schema, with `acceptableRule()` guarding what reaches the screen. The UI gains one split editor used by Import and the unsorted queue.

**Tech Stack:** Node 26 with type-stripping (no build), `node:test`, `@anthropic-ai/sdk`, single-file vanilla JS in `site/index.html`.

**Spec:** `docs/superpowers/specs/2026-11-02-splits-and-rules-design.md`

## Global Constraints

- Append-only JSONL log per household; state is a replay. Integer cents. Every appended event is validated and dry-run through the fold before it is written.
- The actor `claude` may never author `txn.split` or `rule.add`; every split and rule is a member's commit or an approved proposal.
- Haiku is sent payee strings and picker labels only: no amounts, dates or accounts. Model from `CLAUDE_MATCH_MODEL`, default `claude-haiku-5-5`. `MATCH_THRESHOLD` stays 0.7.
- The rule language is a case-insensitive substring of payee + memo. No predicate grammar.
- `isSpend('__split')` is false. A reader not taught about splits under-counts; it never double-counts.
- Existing logs replay to the same state. Restore scope `facts` carries `txn.split`.
- Never commit `api/data/`, `site/*.jsonl`, `.env`. Use `/opt/homebrew/bin/git`. Commit as `-c user.name=jammo-icloud -c user.email=241511865+jammo-icloud@users.noreply.github.com` with trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- Test command (from `api/`): `npm test; echo rc=$?` and `npm run typecheck; echo rc=$?`. Both pass at the end of every task.

## Review Focus

1. **A split whose parts sum to one cent off the receipt** → refused at append with a message naming the problem; nothing written. (Task 1.)
2. **A split with a part outside the budget in view** → that part counts in `outside`, the rest in their envelopes, and `activity` equals only the in-envelope parts. (Task 2.)
3. **Haiku answers `rule: "co"` or a rule matching a receipt already filed elsewhere** → the suggestion survives, the rule is dropped, the regex fallback is used on screen. (Task 4.)
4. **A rule whose target is `__split` at import** → the row arrives marked to divide and is not sent to Haiku; committed undivided it lands unsorted, and the server refuses only a `'__split'` row whose parts are missing or do not balance. (Tasks 4, 5.)
5. **Re-categorizing a split receipt to one category** → the parts are gone and the receipt counts once, whole. (Task 1.)

---

### Task 1: The `txn.split` op, the fold, validation, scope and the Activity line

**Files:**
- Modify: `api/src/types.ts` (`Txn` ~line 62, `Assignment`/`isSpend` ~41, Event union ~289)
- Modify: `api/src/replay.ts` (`validate` ~193, `applyTo` `txn.categorize` ~897)
- Modify: `api/src/restore.ts` (`scopeOf` ~28)
- Modify: `api/src/tools.ts` (`describe` ~618, `cat()` ~605)
- Test: `api/test/split.test.ts` (new)

**Interfaces:**
- Produces, in `types.ts`:
  ```ts
  export const SPLIT = '__split' as const;
  export interface SplitPart { readonly category: Assignment; readonly amount: Cents }
  export interface Txn { …; split?: readonly SplitPart[] }
  export const isSplit = (t: Pick<Txn, 'category'>): boolean => t.category === SPLIT;
  export function partsOf(t: Pick<Txn, 'category' | 'amount' | 'split'>): readonly SplitPart[];
  // Event union:
  | { op: 'txn.split'; txn: TxnId; parts: readonly SplitPart[]; why?: string }
  ```
  `isSpend` returns false for `SPLIT`.
- Produces, in `replay.ts`: `export function checkParts(parts: readonly SplitPart[]): string | null` returning the first problem (`'a split has at least two parts'`, `'a part is a whole number of cents, not zero'`, `'a category appears twice in the split'`, `'a part of a split cannot itself be split'`) or null. `validate` and later tasks reuse it.

- [ ] **Step 1: Write the failing tests** in `api/test/split.test.ts`, using the `ev`/`txn`/`world` helpers copied from `api/test/core.test.ts`:

```ts
describe('a split receipt', () => {
  test('partsOf: one line for a category, the parts for a split, nothing when unsorted', () => {
    assert.deepEqual(partsOf(txn({ id: 'a', date: '2026-03-01', amount: -16500, category: 'groceries' })),
      [{ category: 'groceries', amount: cents(-16500) }]);
    assert.deepEqual(partsOf(txn({ id: 'b', date: '2026-03-01', amount: -16500, category: null })), []);
    const parts = [{ category: 'groceries', amount: cents(-12000) }, { category: 'dining', amount: cents(-4500) }];
    assert.deepEqual(partsOf({ category: SPLIT, amount: cents(-16500), split: parts }), parts);
  });
  test('txn.split files the receipt as a split, by hand', () => {
    const s = world([ev({ op: 'txn.add', txns: [txn({ id: 'c', date: '2026-03-02', amount: -16500, payee: 'BIGBOX WHSE #0100' })] }),
      ev({ op: 'txn.split', txn: 'c', parts: [{ category: 'groceries', amount: cents(-12000) }, { category: 'dining', amount: cents(-4500) }] })]);
    const t = s.txns.get('c')!;
    assert.equal(t.category, SPLIT); assert.equal(t.manual, true); assert.equal(t.split!.length, 2);
    assert.equal(isSpend(t.category), false);
  });
  test('parts that do not add up are refused, and nothing changes', () => {
    assert.throws(() => world([…txn.add c…, ev({ op: 'txn.split', txn: 'c', parts: [{ category: 'groceries', amount: cents(-12000) }, { category: 'dining', amount: cents(-4499) }] })]),
      /add up to the receipt/);
  });
  test('validate refuses one part, a zero part, a duplicate category, a nested split, and a split via categorize', () => {
    // one assertion per case using validate(ev({ op: 'txn.split', … })) and validate(ev({ op: 'txn.categorize', txn: 'c', category: SPLIT }))
    // and a txn.add whose row carries category SPLIT: /arrives already split/
  });
  test('a split for a removed receipt is inert', …);  // txn.remove then txn.split: no throw, no txn
  test('categorizing a split receipt again drops the parts', …);  // txn.split then txn.categorize groceries: split undefined, category groceries
  test('scopeOf puts a split with the facts', () => assert.equal(scopeOf(ev({ op: 'txn.split', … })), 'facts'));
  test('the Activity line names each part', () => {
    const d = describe(ev({ op: 'txn.split', txn: 'c', parts: […] }), world([…]));
    assert.equal(d.what, 'split a receipt across Groceries $120.00 and Dining out $45.00');
  });
});
```

- [ ] **Step 2: Run** `node --test --experimental-strip-types test/split.test.ts` from `api/`. Expected: FAIL (`SPLIT`/`partsOf` not exported; `txn.split` not an op).

- [ ] **Step 3: Implement.** `types.ts`: `SPLIT`, `SplitPart`, `Txn.split`, `isSplit`, `partsOf`, the `txn.split` variant, `isSpend` excluding `SPLIT`. `replay.ts`: `checkParts`; in `validate`, `txn.split` → `checkParts`; `txn.categorize` with `SPLIT` → `ReplayError('a split is written with txn.split')`; `txn.add` with a row whose `category === SPLIT` or `split` set → `ReplayError('a receipt cannot arrive already split')`. `applyTo` `txn.split`: no txn → return; sum ≠ `t.amount` → `ReplayError('the parts of a split must add up to the receipt')`; else set `category = SPLIT`, `split = parts`, `manual = true`, `delete suggestedBy`. `txn.categorize`: `delete t.split`. `restore.ts`: add `'txn.split'` to the `facts` case. `tools.ts` `describe`: `case 'txn.split'` → `split a receipt across ${parts.map(p => `${cat(p.category)} ${fmt(Math.abs(p.amount))}`).join(' and ')}` (two parts joined by `and`, more by `, ` with a final `and`); `cat(SPLIT)` → `'a split'`.

- [ ] **Step 4: Run** the split test file, then `npm test; echo rc=$?` and `npm run typecheck; echo rc=$?`. Expected: all pass, rc=0.

- [ ] **Step 5: Commit** `api/src/types.ts api/src/replay.ts api/src/restore.ts api/src/tools.ts api/test/split.test.ts`: "A receipt can be split across categories in the log".

---

### Task 2: Parts roll into envelopes, months, pace and the receipts list

**Files:**
- Modify: `api/src/envelopes.ts` (`matches` 19, `envelopeFor` 36, `EnvelopeView` 66, `monthView` 106, `carriedInto` 175)
- Modify: `api/src/analytics.ts` (`pace` 186–262)
- Modify: `api/src/tools.ts` (`explain_envelope` ~327, `list_transactions` ~441–456, envelope-remove orphan count ~1284, category-archive held count ~1372)
- Test: `api/test/split.test.ts` (extend), `api/test/tools.test.ts` (extend)

**Interfaces:**
- Consumes: `partsOf`, `SPLIT`, `isSplit` from Task 1.
- Produces, in `envelopes.ts`:
  ```ts
  export interface EnvelopeLine { readonly txnId: string; readonly category: CategoryId; readonly amount: Cents /* out, positive */; readonly split: boolean }
  export interface EnvelopeView { …; readonly txnIds: readonly string[]; readonly lines: readonly EnvelopeLine[] }
  export function matches(env: Envelope, t: Pick<Txn, 'payee' | 'memo' | 'category'>): boolean;
  export function envelopeFor(budget: Budget, t: Pick<Txn, 'payee' | 'memo' | 'category'>): Envelope | null;
  ```
  `list_transactions` rows gain `parts: { category: string; amount: string }[] | null`. `explain_envelope.transactions` rows gain `of?: string` (the whole receipt, formatted) and `amount` is the part's share.

- [ ] **Step 1: Write the failing tests.** In `split.test.ts`:

```ts
describe('a split rolls up by part', () => {
  const bigbox = [ev({ op: 'txn.add', txns: [txn({ id: 'c', date: '2026-03-02', amount: -16500, payee: 'BIGBOX WHSE #0100' })] }),
    ev({ op: 'txn.split', txn: 'c', parts: [
      { category: 'groceries', amount: cents(-12000) }, { category: 'dining', amount: cents(-3000) }, { category: 'electricity', amount: cents(-1500) }] })];
  test('each part lands in its envelope; a part with no envelope here is outside', () => {
    const v = monthView(world(bigbox), 'harbor', '2026-03')!;
    const food = v.envelopes.find((e) => e.envelope.id === 'food')!;
    assert.equal(food.activity, parseDollars('120.00'));
    assert.deepEqual(food.lines, [{ txnId: 'c', category: 'groceries', amount: parseDollars('120.00'), split: true }]);
    assert.deepEqual(food.txnIds, ['c']);
    assert.equal(v.envelopes.find((e) => e.envelope.id === 'dine')!.activity, parseDollars('30.00'));
    assert.equal(v.outside.total, parseDollars('15.00')); assert.deepEqual(v.outside.txnIds, ['c']);
    assert.equal(v.activity, parseDollars('150.00'));
  });
  test('a plain receipt is one line, not marked split', …);  // lines[0].split === false, amount === whole
  test('a split part carries over like any spending', …);   // month.open 2026-04 after the March split with rollover on food: carried = 1125 − 120
  test('pace counts the part, not the whole receipt', …);   // pace(view, clock, s): food.spent == 120.00, discretionary includes 120.00 only
});
```
In `tools.test.ts`, after seeding a split of `x4` (amount −10.15 → groceries −6.15, dining −4.00) through `store.append`:
```ts
test('list_transactions shows the parts, and a category filter finds a part', …);  // row.category === '__split', row.parts length 2, filter category:'dining' matches x4
test('explain_envelope shows the share and the whole', …);  // daily's transactions include { payee: 'QUIKSTOP 10001', amount: '-$10.15' split? → amount '-$6.15'? NO: one line per part landing in daily: groceries 6.15 and dining 4.00 both land in daily → expect two lines? See Step 3.
```
Decide in Step 3 and pin here: `lines` are per **part**, so a split whose two parts both feed the same envelope yields two lines with the same `txnId`; `txnIds` lists the id once. The `explain_envelope` test expects two entries for x4 with `amount: '-$6.15'` / `'-$4.00'` and `of: '-$10.15'`.
```ts
test('removing an envelope and archiving a category count a split part as held', …);  // envelope-remove orphan count counts x4 once; archive dining: held includes x4
```

- [ ] **Step 2: Run** `node --test --experimental-strip-types test/split.test.ts test/tools.test.ts`. Expected: FAIL (`lines` undefined, shares wrong).

- [ ] **Step 3: Implement.** `envelopes.ts`: loosen `matches`/`envelopeFor` parameter types; in `monthView`, replace the per-transaction loop body with a loop over `partsOf(t)` filtered by `isSpend(p.category)`, probing `envelopeFor(budget, { payee: t.payee, memo: t.memo, category: p.category })`, accumulating `cents(-p.amount)`; build `lines` per envelope and derive `txnIds` as unique ids in first-seen order; outside gets the part amount and the id once. `carriedInto`: same walk, `if (envelopeFor(budget, probe)?.id !== env) continue`. `analytics.ts` `pace`: iterate `e.lines`; `amount = line.amount`; `key = chargeKey(t.payee, line.category)`; sinking by `line.category`. `tools.ts`: `explain_envelope` maps `e.lines` to `{ date, payee, amount: fmtExact(cents(-line.amount)), category: line.category, ...(line.split ? { of: fmtExact(t.amount) } : {}) }`; `list_transactions` category filter → `partsOf(t).some(p => p.category === category)`, rows add `parts: t.split ? t.split.map(p => ({ category: p.category, amount: fmtExact(p.amount) })) : null`; the two held counts iterate `partsOf(t)`.

- [ ] **Step 4: Run** `npm test; echo rc=$?` and `npm run typecheck; echo rc=$?`. Expected: rc=0 both.

- [ ] **Step 5: Commit** "A split's parts land in their envelopes and months".

---

### Task 3: `categorize_transactions` splits, and a rule may target split

**Files:**
- Modify: `api/src/tools.ts` (`categorize_transactions` ~874–940; `describe` `rule.add` line)
- Test: `api/test/tools.test.ts` (extend)

**Interfaces:**
- Consumes: `checkParts` (Task 1), `SPLIT`, `partsOf`.
- Produces, in `api/src/match.ts` (this task adds it; Task 4 reuses it and adds the ledger-conflict tests there):
  ```ts
  /** Why a rule string may not be offered, or null when it may: empty, under 3 characters, not in the payee (when `payee` is given), already a rule, or already filed elsewhere. */
  export function ruleProblem(state: State, payee: string | null, rule: string, target: string): string | null;
  ```
  With `payee` null the substring check is skipped (the tool's path); the other checks run in the order listed, returning the first problem. Messages: `'a rule needs at least 3 characters'`, `'not in the payee'`, `'already a rule'`, `'already filed under ${labels}'` (distinct other categories by label, joined with `, `; a split receipt reads `a split`).
- Produces: an assignment entry `{ txnId, category: '__split', parts: [{ category, amount }] , alsoAddRuleMatching? }` with `amount` in integer cents; emits `txn.split` (and `rule.add` with `category: '__split'`). Effect lines: `"${date} ${payee} ${fmtExact(amount)} is split: Groceries $120.00, Dining out $45.00"` and, for a split rule, `"Rule \"bigbox\" would ask a person to divide N receipts from now on"` (singular `receipt` when 1). Input schema documents `parts`.
- Also produces, for every rule (split or not): `ToolError` when the match is empty or under 3 characters (`'a rule needs at least 3 characters'`); and when `ruleProblem(state, t.payee, match, category)` reports an already-filed conflict, an extra effect `"Rule \"co\" also matches N receipts filed elsewhere (Dining out, Electricity)"` listing the distinct other categories by label (a split counts as `a split`). The proposal is still made.

- [ ] **Step 1: Write the failing tests** in `tools.test.ts`:

```ts
test('a split entry proposes txn.split and says each part', async () => {
  const c = await ctx();
  const p = call('categorize_transactions', { assignments: [{ txnId: 'x4', category: '__split',
    parts: [{ category: 'groceries', amount: -615 }, { category: 'dining', amount: -400 }] }] }, c) as Proposal;
  assert.equal(p.events[0]!.op, 'txn.split');
  assert.ok(p.effects.some((e) => /is split: Groceries \$6\.15, Dining out \$4\.00/.test(e)));
  await commit(p.id, c);
  assert.equal(c.store.state.txns.get('x4')!.category, '__split');
});
test('a split that does not add up, has one part, or names a missing category is refused', …);  // /add up/, /at least two/, /categories are fixed/
test('a split cannot be credited to Claude', …);  // suggestedBy:'claude' on a split entry → /suggestedBy/
test('a rule can target split, and says it will ask a person', async () => {
  // alsoAddRuleMatching: 'QUIK' on the split entry → events[1] is rule.add with category '__split';
  // effect /would ask a person to divide 1 receipt\b/; describe(rule.add) → 'added rule "QUIK" to a split'
});
test('a two-letter rule is refused; a rule that contradicts history warns on the card', async () => {
  // alsoAddRuleMatching: 'AL' → /at least 3 characters/
  // x4 → dining with alsoAddRuleMatching: 'S' is refused too; x4 → dining with 'VALLEY' (x1 is VALLEY MARKET, groceries) → effect /also matches 1 receipt filed elsewhere \(Groceries\)/ and the proposal still has 2 events.
  // The tool does not require the match to be in this receipt's payee: a person may type a broader rule. Only suggest() requires that.
});
```

- [ ] **Step 2: Run** `node --test --experimental-strip-types test/tools.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** in `categorizeTxn.run`: when `category === SPLIT`, read `item['parts']` (array of `{ category, amount }`), map amounts through `cents()`, refuse via `ToolError` on `checkParts` problems, on a sum ≠ `t.amount` (`'the parts of a split must add up to the receipt'`), on any spend category not in `state.categories`, and on `suggestedBy`; push `{ op: 'txn.split', txn, parts }`. The rule branch stays shared; its effect wording switches on `category === SPLIT`. Add `parts` to the input schema with a description.

- [ ] **Step 4: Run** `npm test; echo rc=$?` and `npm run typecheck; echo rc=$?`. Expected: rc=0.

- [ ] **Step 5: Commit** "The categorize tool can split a receipt, and a rule can mean 'ask a person'".

---

### Task 4: Haiku may answer split and writes the rule; the server checks it

**Files:**
- Modify: `api/src/match.ts` (whole file)
- Modify: `api/src/server.ts` (`/api/import/preview` 1578–1645, `/api/match` 1686–1700)
- Test: `api/test/match.test.ts` (extend), `api/test/server-thread.test.ts` (extend)

**Interfaces:**
- Consumes: `SPLIT`, `partsOf`, `isSplit`.
- Produces, in `match.ts`:
  ```ts
  export interface Suggestion { readonly value: string; readonly confidence: number; readonly rule?: string; readonly parts?: readonly string[] }
  export const SPLIT_OPTION: PickerOption = { value: SPLIT, label: 'Split across envelopes…', group: 'Several envelopes' };  // appended last by pickerOptions
  // ruleProblem(state, payee, rule, target) from Task 3, called here with the payee
  export async function suggest(state: State, payees: readonly string[], options: readonly PickerOption[]): Promise<Map<string, Suggestion>>;
  ```
  Schema: `matches[].rule: string` required; `matches[].parts?: string[]`.
  ```ts
  export async function suggestForRows(state: State, budget: BudgetId | null,
    rows: readonly { id: string; payee: string; memo?: string; category: Assignment | string | null }[]):
    Promise<{ suggested: Map<string, Suggestion>; toDivide: Set<string>; error?: string }>;
  ```
  Rows with `category === SPLIT` are not sent; open rows for which `categorize(state.rules, row) === SPLIT` are not sent either and come back in `toDivide`.
- Produces, in `server.ts`: preview rows gain `rule?: string`, `parts?: string[]`; response gains `toDivide: number` and `ruled` counts single-category rules only. `/api/match` returns `suggestions: { [id]: { choice: string; rule?: string; parts?: string[] } }` and `toDivide: string[]`; its rows pass `memo` through.

- [ ] **Step 1: Write the failing tests** in `match.test.ts` (household fixture: add a sorted `txn.add` of `BIGBOX WHSE #0100` as a split, `HILLTOP FOODS #12` as groceries, and `rule.add r-power EXAMPLE POWER → electricity`):

```ts
test('the picker ends with the split option, and the model is offered it', …);  // pickerOptions last === SPLIT_OPTION; sent envelopes include id '__split'
test('a split answer keeps only known, non-split parts', …);  // reply choice '__split', parts ['groceries','nope','__split','groceries'] → parts ['groceries']
test('the rule is kept only when it is at least 3 letters, in the payee, and contradicts nothing', () => {
  // ruleProblem(state, 'HILLTOP FOODS #12 SPRINGFIELD', 'hilltop foods', 'groceries') === null
  // 'ki' → /3 characters/; 'walmart' → /not in the payee/; 'bigbox' with target 'groceries' → /already filed/ (c is a split, target is not)
  // 'bigbox' with target '__split' → null; 'EXAMPLE POWER' → /already a rule/; '' → /empty/
});
test('a suggestion survives a bad rule; the rule does not', …);  // reply rule 'ki' → Suggestion has value and no rule
test('rows a split rule caught are never sent, from either screen', …);  // suggestForRows with { category: '__split' } → no call; and an open row { id:'q', payee:'BIGBOX WHSE', category:null } with rule.add 'BIGBOX' → '__split' in state → no call, toDivide has 'q'
```
In `server-thread.test.ts`:
```ts
test('the import preview marks rows a split rule caught as to-divide, not ruled', …);  // seed rule.add match 'BIGBOX' category '__split'; csv with BIGBOX and HILLTOP FOODS; row.category === '__split'; json.toDivide === 1; json.ruled === 0 (HILLTOP FOODS has no rule in this fixture)
test('/api/match returns a suggestion object with its rule, and the rows a split rule covers', …);  // fake Claude reply with rule 'hilltop foods' → suggestions[id] deepEqual { choice: 'groceries', rule: 'hilltop foods' }; an unsorted BIGBOX receipt in the ledger → toDivide includes its id and the fake was not sent 'BIGBOX'
```

- [ ] **Step 2: Run** `node --test --experimental-strip-types test/match.test.ts test/server-thread.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `match.ts`: append `SPLIT_OPTION` in `pickerOptions`; extend `SYSTEM` with the two paragraphs from the spec (split, and rule with the two examples); extend `SCHEMA`; `suggest(state, …)` validates `parts` and runs `ruleProblem` (drop the rule, keep the suggestion); `ruleProblem` checks in order: empty, `< 3` chars, not a substring (case-insensitive), already a rule, then scans `state.txns` with the same haystack `categorize()` uses and returns `'already filed under ${other}'` when a receipt's `category` is non-null and differs from `target` (a split receipt counts as "different" unless `target === SPLIT`). `server.ts`: pass `state` through; preview counts `ruled` as `category !== null && category !== SPLIT`, `toDivide` as `category === SPLIT`; rows spread `rule` and `parts`; `/api/match` maps to objects. Update existing `match.test.ts` call sites for the new `suggest` signature.

- [ ] **Step 4: Run** `npm test; echo rc=$?` and `npm run typecheck; echo rc=$?`. Expected: rc=0.

- [ ] **Step 5: Commit** "Haiku may answer split, and writes the rule the server checks".

---

### Task 5: Import commit accepts split rows

**Files:**
- Modify: `api/src/server.ts` (`/api/import/commit` 1647–1684)
- Test: `api/test/server-thread.test.ts` (extend)

**Interfaces:**
- Consumes: `checkParts`, `SPLIT`.
- Produces: commit rows accept `split?: { category: string; amountCents: number }[]`; a row with `category: '__split'` and no balanced `split` is refused `400` with `'${payee} is marked to divide but is not divided'` (the client sends `category: null` for an undivided row, so this only catches a client fault); the append is one batch `[txn.add (split rows with category null), ...txn.split]`. Response gains `divided: number`.

- [ ] **Step 1: Write the failing tests:**
```ts
test('a split row is imported as a receipt and its split, in one batch', …);  // commit BIGBOX row with category '__split', split [{groceries,-12000},{travel,-4500}] (amountCents -16500) → 200, divided 1; state txn category '__split', split length 2
test('a split row that is not divided, or not balanced, is refused and nothing lands', …);  // 400 /not divided/ and 400 /add up/; state.txns lacks the id
```

- [ ] **Step 2: Run** the server test file. Expected: FAIL.

- [ ] **Step 3: Implement** in the commit route: validate each split row (`checkParts`, sum vs `amountCents`, categories exist or non-spend), build the txn with `category: null`, collect `{ op: 'txn.split', txn: id, parts }`, `append(who, [add, ...splits])`.

- [ ] **Step 4: Run** `npm test; echo rc=$?` and `npm run typecheck; echo rc=$?`. Expected: rc=0.

- [ ] **Step 5: Commit** "An import can land a receipt already divided".

---

### Task 6: The split editor on Import and the unsorted queue; the Remember box takes the model's rule

**Files:**
- Modify: `site/index.html` (`ruleSuggestion` ~2848, `loadUnsorted` 2852–2975, `envelopeSelect` ~3870, `suggestionTag` ~3895, `renderPreview` 3920–3995, `updateCommit` 3996–4008, commit handler 4010–4030, `offerRules` 4035–4085, `showReceipts` ~3773; CSS near `.remember`/`table.rows`)
- Test: none automated (single-file vanilla UI); verify in the browser against a dev server with a seeded household, using the fake DSM (`npm run fake-dsm`) as the existing README describes, or by driving `renderPreview` with a hand-built preview object in the console.

**Interfaces:**
- Consumes: preview rows `{ …, suggested?, confidence?, rule?, parts?, category }`, `/api/match` suggestion objects, `categorize_transactions` split entries, `explain_envelope` lines with `of`, commit rows with `split`.
- Produces: `function splitEditor(options, amountCents, initialParts, onChange)` returning `{ el, parts(), balanced() }` where `parts()` is `[{ category, amountCents }]`; `envelopeSelect(options, value, { allowSplit = true } = {})`; `ruleFor(row)` = `row.rule || ruleSuggestion(row.payee)`.

- [ ] **Step 1: Build `splitEditor`.** Lines of `envelopeSelect(options.filter(o => o.value !== '__split'), …)` plus a dollars input, typed unsigned, parsed with `toCents` and given the receipt's sign (`Math.sign(amountCents)`); `+ another line`; footer text `"$X still to place"`, `"$X over"`, or `"balanced"`; a blank last amount takes the remainder on blur; `onChange` fires on every edit.

- [ ] **Step 2: Import screen.** In `renderPreview`, when `sel.value === '__split'` (chosen, suggested-and-accepted, or arrived from a split rule) mount the editor under the picker with `r.parts` as initial envelopes; while balanced keep `r.category = '__split'` and `r.split = editor.parts()`; while unbalanced set `r.category = null` and `delete r.split` so an undivided row commits unsorted (the import is never blocked by it); a non-split choice removes the editor. A row that arrived with `category: '__split'` renders as `unsorted` with the editor open and empty until balanced. `updateCommit`: note reads `"N will land with no envelope until you sort them, M of them to divide."`. The accept-all bar skips split suggestions (they need a person); accepting a split suggestion sets `r.keptSuggestion = true`. The commit sends `split` rows with `amountCents` per part.

- [ ] **Step 3: Unsorted queue.** Same editor under the picker; the Remember label on a split row reads `remember: always ask to divide`; `Show what this would do` sends `{ txnId, category: '__split', parts: [{ category, amount: amountCents }], alsoAddRuleMatching? }` only for balanced rows. When a suggestion arrives with a `rule`, set `row.match.value = rule`. A `__split` suggestion's Accept opens the editor with `parts` pre-filled. Rows in `/api/match`'s `toDivide` (fetched on load, with the picker) get the picker set to `__split`, the editor open and empty, and a `.sugg` tag reading `a rule says: divide this` with no Accept button.

- [ ] **Step 4: Remember box.** After commit, `kept` is the rows with `suggestedBy === 'claude' && category` plus the rows with `keptSuggestion && category === '__split' && split`. `offerRules` groups by `ruleFor(r)`; a split row's entry is `{ txnId, category: '__split', parts: r.split.map(p => ({ category: p.category, amount: p.amountCents })), alsoAddRuleMatching }`.

- [ ] **Step 5: Receipts list.** In `showReceipts`, when `t.of` is present render `"${t.amount} of ${t.of}"`.

- [ ] **Step 6: Verify in the browser.** Start the API against a temp household with a budget, two envelopes and an open month; import a CSV with a BIGBOX line; choose *Split across envelopes…*, enter one amount, see the remainder fill, commit, open the envelope and see `"$120.00 of $165.00"`; then with a split rule in the log, re-import and see the row marked to divide and the commit button disabled until balanced. Note what was checked in the commit message.

- [ ] **Step 7: Commit** `site/index.html`: "A member can divide a receipt on Import and the queue, and Remember takes the model's rule".

---

### Task 7: Docs and final verification

**Files:**
- Modify: `README.md` or `docs/` only where the import flow or rules are already described (grep `ruleSuggestion|Remember|rule` first; change nothing that does not describe them).

- [ ] **Step 1:** `npm test; echo rc=$?` and `npm run typecheck; echo rc=$?` from `api/`. Expected rc=0.
- [ ] **Step 2:** `git status` shows no `api/data/`, `site/*.jsonl` or `.env`.
- [ ] **Step 3:** Commit any doc touch: "The docs say a receipt can be split and a rule can mean 'ask'".

---

## Addendum: editing a split (2026-11-02, after the owner's read)

The owner read the first build and said leaving full CRUD out of the split
will not work. The spec's "Editing a split" section is the authority for the
two tasks below. The event shape is settled there: an edit is a replacement
`txn.split` with the whole parts list; undo is a `txn.categorize`. The fold
already does both (`replay.ts`, `case 'txn.split'` sets `t.split = e.parts`;
`case 'txn.categorize'` deletes `t.split`), and `split.test.ts` already pins
"splitting again replaces the parts" and "categorizing a split receipt again
drops the parts". These tasks add the restore chain, the tool wording, the
data the screen needs, and the screen.

### Task 8: The tool says "divided again" and "no longer split"; `explain_envelope` carries what the screen needs; the edit chain restores

**Files:**
- Modify: `api/src/tools.ts` (`categorize_transactions` run ~946–965; `explain_envelope` entries ~330–336)
- Test: `api/test/tools.test.ts`, `api/test/households.test.ts`

**Interfaces:**
- Consumes: `Txn.split`, `partsOf`, `splitProblem`, `filedLabel`.
- Produces: `explain_envelope` entries gain `txn: TxnId`, `amountCents: number` (the whole receipt, signed, as a number) and `parts: { category: string; amountCents: number }[] | null` (null for a receipt sorted whole), beside the existing `date, payee, amount, category, of?`. Effect lines: a split entry for a receipt already split reads `"<date> <payee> <amount> is divided again: <label> $x, <label> $y"`; a category entry for a split receipt reads `"<date> <payee> <amount> is no longer split; becomes <category>"`. The first split and a plain categorize keep their current wording.

- [ ] **Step 1: Failing tests in `tools.test.ts`.** (a) `categorize_transactions` on a receipt already split, with new parts (three where there were two), proposes exactly one `txn.split` event carrying the three parts and an effect matching `/is divided again: /`; approved, `state.txns.get(id).split` has three parts. (b) a category entry on a split receipt proposes one `txn.categorize` and an effect matching `/is no longer split; becomes groceries/`; approved, `split` is undefined. (c) parts that no longer add up on a re-split are refused with `the parts of a split must add up to the receipt` and nothing is proposed. (d) `explain_envelope` entries for a split receipt carry `txn`, `amountCents` equal to the receipt's cents, and `parts` with `amountCents` per part; a whole receipt's entry has `parts: null`.
- [ ] **Step 2: Failing test in `households.test.ts`**, beside the existing "a backup with a divided receipt restores under facts": a log with `txn.add`, `txn.split` (two parts), `txn.split` (three parts), restored under `facts` into an empty household, replays to the three-part split; a second log where the chain ends in `txn.categorize` restores to a whole receipt with no `split`.
- [ ] **Step 3: Run**: `node --test test/tools.test.ts test/households.test.ts` from `api/`. Expected: the new tests fail, the rest pass.
- [ ] **Step 4: Implement.** In `categorize_transactions`, read `t.split` before pushing the event and choose the effect wording per the Interfaces block. In `explain_envelope`, add the three fields to each entry.
- [ ] **Step 5: Run** `npm test; echo rc=$?` and `npm run typecheck; echo rc=$?`. Expected rc=0 both.
- [ ] **Step 6: Commit** `api/src/tools.ts api/test/tools.test.ts api/test/households.test.ts`: "A split can be divided again or sorted whole, and the envelope list says what it is made of".

### Task 9: Edit any receipt from the envelope's receipts list; editor lines can be removed and come pre-filled

**Files:**
- Modify: `site/index.html` (`showReceipts` ~3839, `splitEditor` ~3991, `loadUnsorted` ~2852 for the options fetch pattern; CSS near `.split-line` ~468 and `.tie` ~174)
- Test: none automated; verify in the browser as Task 6 did.

**Interfaces:**
- Consumes: `explain_envelope` entries with `txn`, `amountCents`, `parts` (Task 8); `/api/match { budget, txnIds: [] }` → `{ options }` for the picker; `categorize_transactions` entries `{ txnId, category }` and `{ txnId, category: '__split', parts: [{ category, amount }] }`; `showProposal(body, proposal, trigger)`.
- Produces: `splitEditor(options, amountCents, initialParts, onChange)` where each entry of `initialParts` is either a category string (as today) or `{ category, amountCents }`, in which case the line's amount is filled in as unsigned dollars; each line has a remove button (`aria-label="Remove this line"`, text `×`) that drops the line and re-runs the balance check; the footer's existing messages cover the result (`a split needs two envelopes` when one line is left). The editor's return shape is unchanged.

- [ ] **Step 1: Editor.** Extend `addLine` to take a string or `{ category, amountCents }`; add the remove button per line; removing splices the line out of `lines` and calls `changed()`.
- [ ] **Step 2: Receipts list.** In `showReceipts`, fetch `/api/match { budget: month.budget, txnIds: [] }` once alongside `explain_envelope` for `options`. Each receipt row gets an `Edit` button (class `btn`, `aria-label` naming the payee). Clicking it mounts, under the row, an `envelopeSelect(options, t.parts ? '__split' : t.category)`; when the select reads `__split` mount `splitEditor(options, t.amountCents, t.parts ?? [], …)` pre-filled; otherwise none. A `Save` button (class `btn primary`, disabled while a split is unbalanced) posts `categorize_transactions` with one entry: `{ txnId: t.txn, category }` or `{ txnId: t.txn, category: '__split', parts: editor.parts().map(p => ({ category: p.category, amount: p.amountCents })) }`, then `showProposal(rowBox, proposal, save)`. The proposal's approve button already calls `loadBudget()`, which rebuilds the envelope list. A `Cancel` button removes the editor. Only one receipt's editor is open at a time in one envelope's list. The control is offered whether or not the month is closed (spec assumption 14).
- [ ] **Step 3: Verify in the browser** against a sandbox server (Task 6's recipe): split a receipt on the queue, open the envelope, Edit → add a third line, Save, approve, see the part lines change; Edit → pick one envelope, Save, approve, see the receipt whole; Edit a whole receipt → *Split across envelopes…*, remove a line, see `a split needs two envelopes`, add it back, Save. Note what was checked in the commit message.
- [ ] **Step 4: README.** In "Getting transactions in", after the split paragraph, add one sentence: a split can be changed later from the envelope's receipts list, parts added, removed or re-divided, or the receipt sorted whole again, and each change is one more decision in the log.
- [ ] **Step 5: Commit** `site/index.html README.md`: "A receipt's split can be edited or undone from the envelope's receipts list".
