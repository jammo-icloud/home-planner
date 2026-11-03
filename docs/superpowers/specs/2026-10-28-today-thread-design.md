# Today as the household's thread, and envelopes on import

Status: design, for review. Agreed with the owner in conversation on 2026-10-28.

## Intent

household-budget is meant to be AI-native: the app drafts, a person approves.
The redesign of 127a212 cleaned up the screens but left the app organised
around data — a briefing on one tab, a log of decisions on another, an "ask
Claude" route on the server with no screen at all. This design makes Today the
one place where the household's money is talked about and decided, and makes
the record of that conversation part of the log, because the log is the truth.

The question that led to a decision is as much a part of the record as the
decision. "Move $120 from Travel to Groceries" is half a story; "one of you
asked whether we could cover Groceries, the other left a note that the trip is
paid for, Claude proposed moving $120 from Travel, and it was approved at 8:14pm"
is the whole one.

## Goals

1. **Today is one shared thread** for the household, kept forever, read by both
   members. Each day opens with Claude's briefing as the first message; members
   reply underneath; newest at the bottom beside the reply box. The reply box
   does two things: ask Claude, or leave a note for the other member. Claude
   reads notes but does not answer them.
2. **The thread is the record.** Questions, Claude's answers, proposals, and the
   decision on each (approved, declined, put off — who, when, why) are events in
   the household log. They are backed up and restored with everything else.
3. **Activity folds into the thread.** Changes made directly on Budget or
   Import appear in the thread as quiet one-line entries. The Activity tab is
   removed. Tabs become Today, Budget, Import, Compare.
4. **Nothing waiting gets buried.** Proposals awaiting a decision are reachable
   from a "waiting" tray above the reply box, wherever they sit in the thread.
5. **Import speaks in envelopes.** The picker on Import (and the Unsorted list
   on Budget) offers the envelopes of the budget in view, not categories.
   Receipts no rule caught are matched to an envelope by Haiku, shown as
   suggestions, and accepted by a person.
6. **Small ones:** envelope rows on Budget show they expand; the Import page's
   "Where to get one" links to each bank's sign-in.

## Non-goals

- No change to how money is computed. Claude still never does arithmetic that
  matters; every figure comes from analytics.ts.
- No notifications, email or push.
- No private threads. Everything in the thread is visible to every member.
- No multi-app website work (another session owns that). This design is meant
  to be the spine that work adopts: no thread op mentions money, so other
  household sources can post into the same thread.

## Anti-goals — failures even if it technically works

- **Claude writes something.** Every write is still a proposal a person
  approves, attributed to the person who clicked. Haiku's suggestions are
  suggestions until accepted.
- **A suggestion looks like a decision.** A Haiku match that nobody has
  accepted must never look the same as a receipt someone sorted.
- **A stale figure reads as current.** Claude's answers are text written at a
  moment. In the thread they carry their time and read as "as of then".
- **History is silently rewritten.** Accepting an envelope suggestion does not
  change rules unless a person also approves the rule.
- **The record leaks.** Thread events go in the household's log and nowhere
  else; the admin view still sees that a household exists, never its contents.

## Constraints (unchanged from the project)

- Append-only JSONL log per household, replayed into state. Integer cents.
- Node 26 type-stripping, no build step, single-file vanilla JS UI
  (`site/index.html`), existing tokens and Satoshi.
- Every money-moving edit requires a reason. Never floor or clamp a cost
  estimate.
- The Anthropic key is optional. Without it the thread still shows the plain
  fallback briefing and every direct change; "Ask Claude" says Claude is not
  configured, and notes still work; Import falls back to rules plus manual sorting.
- Payee names already go to Anthropic for briefings; Haiku matching sends payee
  strings and envelope names, nothing else (no amounts, accounts or dates).

## Decided in conversation

### The thread

- **One thread, briefing first, replies underneath.** Not two views.
- **Kept, shared between both members.** Not reset daily.
- **The question and the decision are both part of the record,** with who and
  when.
- **Direct changes appear in the thread**, and Activity goes away as a tab.
- **"Not now" comes back when its numbers change.** A put-off proposal returns
  to the waiting tray (and is re-raised in the next briefing) as soon as any
  figure it was based on has changed.

- **The reply box carries notes between members too**, and Claude reads them.

### Entries in the thread

| Kind | Looks like | Comes from |
|---|---|---|
| Briefing | Claude's message: headline, folded write-up, cards | once a day, the first time anyone opens Today |
| Question | the member's words, name and time | the reply box, "Ask Claude" |
| Note | the member's words, name and time, addressed to the other member | the reply box, "Leave a note" |
| Answer | Claude's words, time, "as of" | /api/ask |
| Card | a proposal: what it does, why, Approve / Not now / Adjust | the briefing, an answer, or a flag (below) |
| Decided card | one line: approved / declined / put off, by whom, when, reason | a member's click |
| Direct change | a quiet line, as Activity shows today | any event not made through the thread |
| Flag | a direct change marked for a second look, with "Put it back" / "Seen it" | a removed receipt — the one thing Activity flags today (see call 9) |

Filters above the thread: **Everything, Mine, Theirs, Waiting.** The old "Needs
a look" filter becomes Waiting, which includes flags not yet seen.

### Import

- Picker options are the budget-in-view's envelopes, grouped by band, plus
  Transfer / ignore and Income. A category feeds at most one envelope per budget
  (define_envelope enforces this), so an envelope choice resolves to a category.
  An envelope fed by several categories is offered as one option per category,
  reading "Utilities · Electricity". See call 10 for categories with no
  envelope in this budget, and envelopes narrowed by payee.
- Order: rules first (free, exact). Haiku only sees what is left.
- Haiku returns, per payee, an envelope option and a confidence. Low-confidence
  rows stay unsorted. Suggested rows are visibly suggestions, with "Accept all
  suggestions" alongside per-row acceptance.
- Accepted suggestions offer to become rules, in one batch, through the normal
  proposal path, so the household asks Haiku less over time.
- The record says where a receipt's envelope came from: "suggested by Claude,
  accepted by" whoever accepted it.
- The same matching is available on the Unsorted list on Budget.

## Calls I made (the owner to check)

1. **Which proposals go in the thread.** Only proposals the thread raises: from
   a briefing, from Claude's answer to a question, or from a flag. Edits made
   directly on Budget and Import keep today's preview-then-approve flow and are
   not logged as offers; the events they produce appear in the thread as quiet
   lines. A preview someone closes on Budget leaves nothing behind.
2. **New event ops**, all replay-neutral for money except where noted:
   - `thread.briefing` — the day's briefing as shown (headline, body, whether
     Claude or the fallback wrote it). Its cards point back at it, rather than
     it listing them, so it can be written before they are.
   - `thread.ask` — `{ question, budget }`, by the member.
   - `thread.note` — `{ text, budget }`, by the member. Costs no API call and
     works with no key configured. The reply box has two buttons, "Ask Claude"
     and "Leave a note", rather than Claude deciding whether to answer: a note
     should never get an unasked-for reply, and should never cost a call.
   - `thread.answer` — `{ replyTo, text, tools: [{name, args}], model }`, by
     the actor `claude`. Not a member; never approves anything.
   - `proposal.offer` — `{ tool, args, summary, effects, events, fingerprint,
     prompt: briefing | answer | member, replaces? }`, by `claude`, or by the
     member for an adjusted card. Storing the
     tool and its arguments is what lets a stale card be re-run (call 4).
   - `proposal.decide` — `{ proposal, decision: approved | declined | snoozed,
     why }`, by the member. An approval appends the proposal's events in the
     same write, so the decision and its effect cannot be separated.
   - `flag.seen` — `{ event }`, by the member.
   - `txn.add` and `txn.categorize` gain an optional `suggestedBy: 'claude'`.
3. **One open card per thing (so money is never moved twice).** A new offer
   that touches any of the same envelopes in the same month as an undecided or
   snoozed one *replaces* it: the old card collapses to "replaced by today's",
   and only the new one can be approved. Untouched and snoozed offers expire
   when their month closes. **Adjust** opens the card's tool with its arguments
   filled in; what the member submits is a new offer, by the member, that
   replaces the original.
4. **Approving a card whose numbers moved.** Each offer stores a fingerprint of
   the figures it cites: available and spent for each envelope it names in its
   month, plus that month's to-assign. If the fingerprint has changed since the
   offer, the card cannot be approved in one click: it says "the numbers have
   moved since this was suggested" and offers to refresh, which re-runs the
   stored tool with the stored arguments and makes a new offer replacing the
   old one. Approval appends the events as offered only when the fingerprint
   still matches; replay's existing checks still apply.
5. **"Not now" returns** to Waiting when that same fingerprint changes, and is
   mentioned in the next briefing.
6. **One briefing per household per day, shared by both members, composed from
   sections.** The budget writes its section per budget (today the only
   source); the generator is "compose sections from sources", not "write the
   budget briefing", so a Plans or Calendar source can add a section later
   without a rewrite. Today it is per person; the per-person part becomes a
   "new since you last looked" divider, driven by the existing `briefing.read`
   cursor. If the day's first briefing was the plain fallback (Claude
   unreachable), the next look tries Claude again, and a Claude-written
   briefing replaces the fallback for that day.
7. **What Claude sees when you reply:** that day's briefing and every question,
   answer and note in the thread since it, plus the tools. The next day's
   briefing also reads the notes left since the last one, so "the trip is paid
   for" can change what it suggests. Earlier days are reachable
   through `get_activity`, not pasted in.
8. **Scope and filters.** One thread per household. By default it shows the
   budget in view plus household-wide entries (receipts, rules, categories,
   members, households). Everything / Mine / Theirs / Waiting filter within
   that; a separate "All budgets" switch widens it.
9. **Flags are what the code flags today: a removed receipt.** "Put it back"
   proposes restoring it (restore_transaction, as Activity offers now). A flag
   waits for every member except the one who made the change; "Seen it" clears
   it for the person who clicked. Unsorted receipts are not a flag — they get
   their own card ("14 receipts to sort") that links to the Unsorted list. The
   "made without a reason" idea from the conversation is dropped: every
   money-moving op already requires a reason.
10. **The envelope picker, per receipt.** Each option is labelled with the
    envelope that receipt would actually land in for the budget in view, using
    `envelopeFor` — so payee-narrowed envelopes (the moving-between budget) say
    where this payee goes, not where the category usually goes. Categories with
    no envelope in this budget stay choosable under "Not in this budget".
11. **Bank links** are the public sign-in pages (downloads sit behind the
    login): Example Bank `https://bank.example.com/`, Example Credit Union
    `https://cu.example.com/`. Checked at build time.
12. **Haiku model** from `CLAUDE_MATCH_MODEL`, defaulting to the current Haiku.
    One request per import, payees de-duplicated.
13. **A fifth restore scope, `thread`.** `scopeOf()` in restore.ts sorts every
    op into facts / budgets / months / people; thread ops (`thread.*`,
    `proposal.*`, `flag.seen`) get their own scope, so a restore can take or
    leave the conversation independently of the money. The money events an
    approval appends stay in their own scopes.
14. **Tabs are a list, not markup.** The thread lives inside a shell that may
    later be shared with other household apps (Today / Plan / Calendar /
    Budget, with Import and Compare inside Budget). The tab list is built from
    data so that nesting is a change to the list, not a rewrite.
15. **Budget envelope rows** get a chevron that turns on open; the whole head is
    the target (it already is for keyboard).

## Left to the builder

- Thread layout, card visuals, the tray, how far back the thread loads at once
  (it will grow; page it).
- Exact copy, within the voice of the existing app.
- How tool calls on an answer are shown (collapsed by default is fine).
- The confidence threshold for Haiku suggestions, and how it is tuned.
- Migration: existing logs have no thread events; the thread starts with what
  replay already knows (direct changes) and the first briefing after upgrade.
- Test shape, following the existing `api/test/*.test.ts` style.
