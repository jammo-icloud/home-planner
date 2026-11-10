/**
 * The domain, and the event vocabulary that produces it.
 *
 * Two layers, deliberately separated:
 *
 *   FACTS         transactions, categories, rules, merchants.
 *                 One household reality. Never forked, never budget-scoped.
 *
 *   INTERPRETATIONS   budgets, envelopes, plans, assignments.
 *                     Each budget decides how facts roll up. Freely restructured
 *                     without touching a single categorized transaction.
 *
 * Everything is derived by replaying an append-only log. Nothing is updated in
 * place, so "who changed this and why" is always answerable and two people
 * editing can never collide.
 */

import type { Cents } from './money.ts';
import type { DistributiveOmit } from './util-types.ts';

// ─── identifiers ──────────────────────────────────────────────────────────────

/** A permanent fact: the kind of spending. `groceries`, `electricity`, `septic`. */
export type CategoryId = string;
/** A per-budget bucket. `daily_life`, `util_old`. Scoped to its budget. */
export type EnvelopeId = string;
export type BudgetId = string;
/** `YYYY-MM`. Budget months are calendar months; nothing tries to be clever. */
export type Month = string;
/** `YYYY-MM-DD`. */
export type Day = string;
export type TxnId = string;
export type EventId = string;
/** Synology account name, plus the reserved `claude` and `system`. */
export type Actor = string;

export const TRANSFER = '__transfer' as const;
export const INCOME = '__income' as const;
/** Not spending: moving your own money, or being paid. Excluded from every envelope. */
export type NonSpend = typeof TRANSFER | typeof INCOME;
export type Assignment = CategoryId | NonSpend | typeof SPLIT;

/**
 * One receipt across several categories. The receipt's own category is this
 * marker and the parts live on `Txn.split`, so nothing that reads a single
 * category mistakes a split for spending: it is not any one category.
 */
export const SPLIT = '__split' as const;

export const isSpend = (c: Assignment | null): c is CategoryId =>
  c !== null && c !== TRANSFER && c !== INCOME && c !== SPLIT;

// ─── facts ────────────────────────────────────────────────────────────────────

export interface Category {
  /** Archived categories stay resolvable for old receipts but leave the pickers. */
  readonly archived?: boolean;
  readonly id: CategoryId;
  readonly label: string;
  /** Free-text grouping hint for pickers. Budgets do the real grouping. */
  readonly kind?: string;
  /**
   * Irregular costs are planned as "$9,000 every 10 years" and the monthly
   * set-aside is derived. The estimate belongs to the world, not to a budget,
   * so it lives on the category and every budget can derive from it.
   */
  readonly sinking?: SinkingEstimate;
}

export interface Txn {
  readonly id: TxnId;
  readonly date: Day;
  readonly payee: string;
  readonly memo?: string;
  /** Negative is money out. Matches how every bank export writes it. */
  readonly amount: Cents;
  readonly account?: string;
  /** Bank-assigned id where the export had one, else a content hash. */
  readonly dedupeKey: string;
  category: Assignment | null;
  /** True when a human set the category by hand; rules must not override it. */
  manual?: boolean;
  /** Set when Claude suggested the category and a member accepted it. */
  suggestedBy?: 'claude';
  /** The parts of a split receipt: set exactly when `category` is `SPLIT`. */
  split?: readonly SplitPart[];
}

/** Where a document is in Drive. `link` addresses it; `hash` and `version_id` are what was written; `path` is for people and may go stale. */
export interface DocRef { readonly link: string; readonly file_id: string; readonly hash: string; readonly version_id: string; readonly path: string }

/** The version a page's `planner:` key carries, so a reader can tell a layout it does not know. */
export const PAGE_FORMAT = 1;
/** The documents the app writes to Drive. */
export type PageKind = 'plan' | 'briefing' | 'answer';
/** The frontmatter keys of each page kind, in the order they are written. Nothing outside the set is written. */
export const PAGE_KEYS: Readonly<Record<PageKind, readonly string[]>> = {
  plan: ['planner', 'kind', 'id', 'title', 'area', 'state', 'parent', 'due', 'people', 'envelope', 'estimate', 'event'],
  briefing: ['planner', 'kind', 'day', 'source', 'budget', 'writtenBy'],
  answer: ['planner', 'kind', 'replyTo', 'plan', 'model'],
};
/** What a frontmatter key holds: text, a whole number, nothing, or a list of text. */
export type FrontValue = string | number | null | readonly string[];

/** One slice of a split receipt. Same sign as the receipt; the parts sum to it. */
export interface SplitPart { readonly category: Assignment; readonly amount: Cents }

export const isSplit = (t: Pick<Txn, 'category'>): boolean => t.category === SPLIT;

/** What a receipt is made of: its parts if split, itself if sorted, nothing if not. */
export function partsOf(t: Pick<Txn, 'category' | 'amount' | 'split'>): readonly SplitPart[] {
  if (t.category === SPLIT) return t.split ?? [];
  return t.category === null ? [] : [{ category: t.category, amount: t.amount }];
}

export interface Rule {
  readonly id: string;
  /** Case-insensitive substring of payee + memo. */
  readonly match: string;
  readonly category: Assignment;
}

// ─── interpretations ──────────────────────────────────────────────────────────

/**
 * How a budget decides which transactions land in an envelope.
 *
 * Usually just categories. The `payee` predicate exists for the overlap month,
 * where the old house's power bill and the new one's are both `electricity`
 * but belong in different envelopes — the one case that would otherwise force
 * the fact layer to fork.
 */
export interface Match {
  readonly categories: readonly CategoryId[];
  /** Case-insensitive substring of the payee. Narrows, never widens. */
  readonly payee?: string;
}

export interface Envelope {
  readonly id: EnvelopeId;
  readonly label: string;
  /** Display band: `House`, `People`, `Future`. */
  readonly group: string;
  readonly match: Match;
  /** Unspent money carries into next month unless this is false. */
  readonly rollover: boolean;
  /** Default monthly amount; what a new month is seeded from. */
  readonly template: Cents;
  readonly order: number;
  /**
   * Saved in Savings: money put in every month to be spent later, which lives
   * in the household's savings account. Such an envelope always rolls over.
   * Absent for an ordinary envelope.
   */
  readonly sinking?: SinkingGoal;
  /**
   * No figure has been given yet: the template is a placeholder the household has
   * not looked at. Cleared by a later define that does not carry it. Absent otherwise.
   */
  readonly needsFigure?: true;
  /** Where the figure came from when public data gave it, one line of up to 200 characters. Absent when a person chose it. */
  readonly source?: string;
  /** The figure as the bill is known ("$1,200 a year"); the template is the monthly it becomes. Absent when it was given as a monthly. */
  readonly basis?: Basis;
}

/** How often a figure given as the bill is known comes round. */
export type Per = 'week' | 'fortnight' | 'month' | 'quarter' | 'half-year' | 'year';
export const PERS: readonly Per[] = ['week', 'fortnight', 'month', 'quarter', 'half-year', 'year'];
/** How many of each period come round in a year. */
export const PER_YEAR: Readonly<Record<Per, number>> = { week: 52, fortnight: 26, month: 12, quarter: 4, 'half-year': 2, year: 1 };
/** A figure as it was given: an amount in cents, once every `per`. */
export interface Basis { readonly amount: Cents; readonly per: Per }

/**
 * What a sinking envelope saves toward. `every`: its categories' estimates
 * ("$1,200 every 4 years"), so the goal is the world's and every budget derives
 * the same monthly figure from it. `by`: a target by a month ("$4,000 by March
 * 2027"), the monthly figure being what is left over the months left.
 */
export type SinkingGoal =
  | { readonly kind: 'every' }
  | { readonly kind: 'by'; readonly target: Cents; readonly by: Month };

/** An irregular cost, as a category carries it: what it costs and how often it comes round. */
export interface SinkingEstimate { readonly cost: Cents; readonly everyYears: number }

/** Enough to find a place in public data, and to say it back to a person. */
export interface BudgetLocation {
  /** How it reads on screen, e.g. "Springfield, IL". */
  readonly label: string;
  /** Two-letter state, for state-level series like electricity prices. */
  readonly state?: string;
  /** ZIP, which is what rent indices are keyed on. */
  readonly postal?: string;
  /** Census FIPS, the only reliable key for county-level tables. */
  readonly stateFips?: string;
  readonly countyFips?: string;
  /** The county's name, e.g. "Lake County" — so the place can be checked by eye. */
  readonly county?: string;
}

export interface Budget {
  /** Null for a budget that is a period rather than a place. */
  readonly location?: BudgetLocation;
  /** Archived budgets stay answerable but drop out of the switcher. */
  readonly archived?: boolean;
  readonly id: BudgetId;
  readonly label: string;
  readonly envelopes: ReadonlyMap<EnvelopeId, Envelope>;
}

/** One in-month change to the plan. Ordered, attributed, and never rewritten. */
export interface Adjustment {
  readonly eventId: EventId;
  readonly at: string;
  readonly who: Actor;
  readonly why: string;
  readonly kind: 'assign' | 'move';
  readonly envelope: EnvelopeId;
  /** Signed delta applied to this envelope. */
  readonly delta: Cents;
  /** For a move, the envelope on the other side. */
  readonly counterpart?: EnvelopeId;
}

/**
 * A month of a budget.
 *
 * `plan` is written once when the month opens and is never edited — that's what
 * makes "planned $325, funded $421, three months running" sayable. Everything
 * after is an adjustment layered on top.
 */
export interface MonthPlan {
  /** A closed month is history: nothing in it can be reassigned or moved. */
  readonly closed?: boolean;
  readonly budget: BudgetId;
  readonly month: Month;
  readonly openedAt: string;
  readonly plan: ReadonlyMap<EnvelopeId, Cents>;
  readonly adjustments: readonly Adjustment[];
  readonly income: Cents;
}

// ─── events ───────────────────────────────────────────────────────────────────

interface Meta {
  readonly id: EventId;
  readonly at: string;
  readonly who: Actor;
  /** Required on anything that moves money. This is what makes Activity readable. */
  readonly why?: string;
}

export type Event = Meta &
  (
    | {
        op: 'category.define';
        category: CategoryId;
        label: string;
        kind?: string;
        sinking?: { cost: Cents; everyYears: number };
      }
    | { op: 'budget.create'; budget: BudgetId; label: string }
    | { op: 'budget.rename'; budget: BudgetId; label: string }
    /**
     * Where a budget is for.
     *
     * A budget differs from another budget because it is somewhere else — that
     * is the whole reason electricity, tax and insurance are priced separately
     * while groceries are not. Recording the place makes that explicit, and
     * makes local cost data addressable.
     *
     * Optional, because not every budget is a place: a moving-between budget is
     * a period, and saying so is more honest than giving it a false address.
     */
    | { op: 'budget.locate'; budget: BudgetId; location: BudgetLocation | null; why: string }
    /**
     * Put a budget away without destroying it.
     *
     * Its months, plans and moves are already in the log; deleting the budget
     * would leave events referring to something that no longer exists, and
     * history that cannot be replayed is not history. Archiving takes it out of
     * the way and keeps every answer it could give.
     */
    | { op: 'budget.archive'; budget: BudgetId; archived: boolean; why: string }
    /**
     * Put a category out of use without unmaking it.
     *
     * Receipts name their category, and a receipt whose category cannot be
     * resolved is a worse problem than one in a category nobody uses any more.
     * Archiving takes it out of the pickers and leaves every past answer intact.
     */
    | { op: 'category.archive'; category: CategoryId; archived: boolean; why: string }
    /**
     * Finish a month. Its plan and adjustments become history: no more
     * assigning, moving or changing the income. Carry-over still flows from it,
     * because closing a month does not undo what it left behind.
     */
    | { op: 'month.close'; budget: BudgetId; month: Month; closed: boolean; why: string }
    /**
     * Undo opening a month that should not have been opened.
     *
     * Only ever for an untouched month — one with no receipts against it and no
     * adjustments made. A month that has been lived in is closed, not discarded.
     */
    | { op: 'month.discard'; budget: BudgetId; month: Month; why: string }
    /**
     * A recurring income, as part of a budget's plan.
     *
     * Records what arrives each time and how often, never a monthly equivalent —
     * paid fortnightly is 26 payments a year, and dividing by twelve loses the
     * two months that carry a third paycheque.
     */
    | {
        op: 'income.source.define';
        source: string;
        budget: BudgetId;
        label: string;
        /** Whose income it is. */
        earner: Actor;
        amount: Cents;
        frequency: 'monthly' | 'semimonthly' | 'biweekly' | 'weekly' | 'annual' | 'once';
        /** A real payday; the rest are counted from it. */
        anchor: Day;
        until?: Month;
      }
    | { op: 'income.source.remove'; source: string; why: string }
    | {
        op: 'envelope.define';
        budget: BudgetId;
        envelope: EnvelopeId;
        label: string;
        group: string;
        match: Match;
        rollover?: boolean;
        template: Cents;
        order?: number;
        /** Saved in Savings, toward this goal; null makes it an ordinary envelope again, absent leaves it as it was. */
        sinking?: SinkingGoal | null;
        /**
         * The envelope has no figure yet, and where the figure it has came from. A later
         * define that omits them clears each: only a figure or pricing writes one without
         * them on purpose, every other rewrite carries them (see `redefine` in tools.ts).
         */
        needsFigure?: true;
        source?: string;
        /** The figure as it was given, when not as a monthly; carried and cleared as `source` is. */
        basis?: Basis;
      }
    /**
     * A category's estimate, set or cleared on its own. `category.define`
     * replaces a category whole, so a rename would lose it; this changes only
     * the estimate, and leaves the name and whether it is archived alone.
     */
    | { op: 'category.sinking'; category: CategoryId; sinking: SinkingEstimate | null }
    /**
     * Removing an envelope does not remove its receipts — they fall out of
     * every envelope and stop being accounted for anywhere, which is why this
     * needs a reason like any other decision that hides money.
     */
    | { op: 'envelope.remove'; budget: BudgetId; envelope: EnvelopeId; why: string }
    /**
     * Opens a month by snapshotting the budget's templates. The plan of record.
     * `plan` names an envelope planned at something other than its template:
     * a sinking envelope at what its goal needs that month, worked out when the
     * month was opened and kept, so a later estimate cannot rewrite it.
     */
    | { op: 'month.open'; budget: BudgetId; month: Month; income: Cents; plan?: Readonly<Record<EnvelopeId, Cents>> }
    /** Changes an envelope's funding, and therefore the month's total. */
    | { op: 'assign'; budget: BudgetId; month: Month; envelope: EnvelopeId; to: Cents; why: string }
    /** Zero-sum between two envelopes. Never changes the month's total. */
    | {
        op: 'move';
        budget: BudgetId;
        month: Month;
        from: EnvelopeId;
        to: EnvelopeId;
        amount: Cents;
        why: string;
      }
    | { op: 'income.set'; budget: BudgetId; month: Month; amount: Cents; why: string }
    | { op: 'txn.add'; txns: readonly Txn[]; source?: string }
    | { op: 'txn.categorize'; txn: TxnId; category: Assignment | null; manual?: boolean; suggestedBy?: 'claude' }
    | { op: 'txn.split'; txn: TxnId; parts: readonly SplitPart[]; why?: string }
    /**
     * Removing a receipt is a legitimate thing to do and an easy thing to hide.
     * It requires a reason for the same purpose a move does: the other person
     * finds out by reading, not by noticing an amount has changed.
     */
    | { op: 'txn.remove'; txn: TxnId; why: string }
    /**
     * What an account held on a day, as its statement said (`statement`, an
     * OFX or QFX import's ledger balance) or as a member read it off the bank's
     * page (`typed`). A fact about the world, like a receipt.
     */
    | { op: 'account.balance'; account: string; cents: Cents; asOf: Day; source: 'statement' | 'typed' }
    /** The one account the sinking envelopes' money lives in, chosen from those seen in imports; null for none. */
    | { op: 'savings.account'; account: string | null }
    | { op: 'rule.add'; rule: string; match: string; category: Assignment }
    | { op: 'rule.remove'; rule: string }
    /**
     * How far through the log this person has actually read.
     *
     * Advances on READ, never on delivery — regenerating a briefing more often
     * must never mean seeing less. This is what makes "since you last looked"
     * per-person rather than per-session.
     */
    /**
     * The first person to log in takes ownership of this log.
     *
     * A log is a household: one shared budget, one owner, and the people they
     * invite. Claiming is recorded rather than configured so that "whose budget
     * is this" has an answer with a date and a name on it.
     */
    | { op: 'household.claim'; label: string }
    /**
     * Membership, which is what makes the state shared rather than personal.
     *
     * Both members see the same numbers — there is no per-person view, because
     * two people budgeting from different pictures is the problem this is meant
     * to solve. Anyone not listed here is refused outright.
     */
    | { op: 'member.add'; member: Actor; why: string }
    | { op: 'member.remove'; member: Actor; why: string }
    | { op: 'briefing.read'; upTo: EventId }
    /**
     * A forecast, recorded when it was made so it can be scored later.
     *
     * A tool that predicts your finances has to show its record; storing the
     * claim at the moment it was made is the only way to check it honestly.
     */
    | {
        op: 'prediction.record';
        prediction: string;
        budget: BudgetId;
        month: Month;
        envelope: EnvelopeId;
        /** What it said would be spent by month end. */
        expected: Cents;
        why: string;
      }
    // ─── the thread ─────────────────────────────────────────────────────────
    //
    // The conversation is part of the record: the question that led to a
    // decision is as much history as the decision. None of these mention money,
    // so any household source can post into the same thread.
    /**
     * A section of the day's briefing, as it was shown. Written once per source
     * per day; a `household` one is the whole household's, `budget: null`, and
     * stands in for the others that day.
     */
    | {
        op: 'thread.briefing';
        day: Day;
        source: BriefingSource;
        budget: BudgetId | null;
        headline: string;
        /** Exactly one of `body` and `doc`: the words in the log, or the document in Drive. */
        body?: string;
        doc?: DocRef;
        writtenBy: 'claude' | 'fallback';
        /**
         * A section that took the place of an earlier one that day: Claude's in
         * place of the fallback, or the household's written again with the calendar.
         */
        replaces?: EventId;
        /**
         * The household's, written by someone with no NAS session: the Household
         * calendar was not read for it. The first look that day by someone with a
         * session writes it again, with the calendar, in its place.
         */
        calendarUnread?: true;
      }
    | { op: 'thread.ask'; question: string; budget: BudgetId | null; plan?: PlanId }
    /** A member writing to the household. Claude reads these, and never answers them. */
    | { op: 'thread.note'; text: string; budget: BudgetId | null; plan?: PlanId }
    | {
        op: 'thread.answer';
        replyTo: EventId;
        /** Set when the question was asked from a plan's card, so the card can show what came back. */
        plan?: PlanId;
        /** With a `doc`, the answer's headline. */
        text: string;
        /** What it looked at, so an answer can be checked later. */
        tools: readonly { name: string; args: Record<string, unknown> }[];
        model: string;
        doc?: DocRef;
      }
    /**
     * A proposal put in front of the household, kept until someone decides it.
     * Carries the tool and its arguments so a card whose numbers have moved can
     * be worked out again, and the events so approving it appends exactly what
     * was shown.
     */
    | {
        op: 'proposal.offer';
        tool: string;
        args: Record<string, unknown>;
        summary: string;
        effects: readonly string[];
        events: readonly NewEventShape[];
        budget: BudgetId | null;
        month: Month | null;
        envelopes: readonly EnvelopeId[];
        fingerprint: string;
        prompt: OfferPrompt;
        replaces?: EventId;
        /** Set when the suggestion came from research on a plan's card. */
        plan?: PlanId;
      }
    | {
        op: 'proposal.decide';
        proposal: EventId;
        decision: 'approved' | 'declined' | 'snoozed';
        why?: string;
        /** On "not now": the figures as they stood, so it comes back only once they move again. */
        fingerprint?: string;
      }
    | { op: 'flag.seen'; event: EventId }
    // ─── settings ───────────────────────────────────────────────────────────
    //
    // Recorded like everything else, so "who changed this" has an answer and a
    // restore brings the household back as it was set up.
    /** The household's areas, replaced whole. Never empty. */
    | { op: 'areas.set'; areas: readonly string[] }
    /**
     * One area's new name, where it stood in the list. Every live plan in it
     * moves with it in the same step, which a set cannot do: the old name
     * still holds plans, and a set refuses to drop it.
     */
    | { op: 'areas.rename'; from: string; to: string }
    /** One area added at the end of the list; nothing when one by that name (in any case) is there. */
    | { op: 'areas.add'; area: string }
    /** One area dropped; refused while any plan not removed sits in it, in any state, and for the last one. */
    | { op: 'areas.remove'; area: string }
    /** One area moved to index `to` of the list (held within it). */
    | { op: 'areas.move'; area: string; to: number }
    /** The household's links, replaced whole. */
    | { op: 'links.set'; links: readonly { label: string; url: string }[] }
    /**
     * How a guest gets in (the address, a gate code): replaced whole, '' for
     * none. Sent in a stay's confirmation and nowhere else; at most 1000 characters.
     */
    | { op: 'guests.arrival'; text: string }
    /**
     * The shared calendar the app made. Recorded once; a second is refused
     * unless it names, in `replaces`, the `cal_id` of the one now in the log:
     * the way a Household calendar that is gone from the NAS is replaced.
     */
    | { op: 'calendar.household'; cal_id: string; original_cal_id: string; name: string; replaces?: string }
    /** The Household calendar's new name, once it has been renamed on the NAS. */
    | { op: 'calendar.household.rename'; name: string }
    /** Where plans are put, when it is not the Household calendar. */
    | { op: 'calendar.target'; cal_id: string; original_cal_id: string }
    /** Per member, keyed by the author: the calendars of theirs checked for clashes. */
    | { op: 'calendar.conflicts'; calendars: readonly { cal_id: string; original_cal_id: string; label: string }[] }
    /** Per member, keyed by the author: how the app looks to them. */
    | { op: 'scheme.set'; scheme: Scheme; mode: Mode }
    // ─── the household's choices ───────────────────────────────────────────
    //
    // The owner's, or `system`'s where `systemMay` says so; the fold refuses anyone else.
    /** The household's IANA zone, such as America/Denver. */
    | { op: 'household.zone'; zone: string }
    /** Whether friends may ask to stay with this household. `calendarGone`: written by `system` when the Household calendar was found gone. */
    | { op: 'guests.booking'; on: boolean; calendarGone?: true }
    /** The model that suggests envelopes on import; null for the default. */
    | { op: 'envelopes.model'; model: string | null }
    /** Where the household's documents live in Synology Drive: a Team Folder and a folder in it. */
    | { op: 'documents.folder'; team: string; folder: string; source: 'owner' | 'deployment' }
    /** A document found moved to the household's folder, or left where it was; any member may record it. */
    | { op: 'documents.moved'; file: { link: string; doc?: DocRef } | { plan: PlanId; name: string; path?: string }; gone?: true }
    // ─── plans ──────────────────────────────────────────────────────────────
    //
    // The household's to-do board. Not money, so a member's edit is written
    // directly; Claude reaches the same ops only by offering them.
    /** A new plan, in planning, owned by whoever made it. `parent` puts it on a shelf, until `shelves.retire`. */
    | { op: 'plan.create'; plan: PlanId; title: string; area: string; parent?: PlanId }
    /** Fields given are changed; fields left out are left alone. */
    | {
        op: 'plan.set';
        plan: PlanId;
        title?: string;
        area?: string;
        chips?: readonly string[];
        notes?: string;
        estimate?: Cents | null;
        envelope?: { budget: BudgetId; envelope: EnvelopeId } | null;
      }
    | { op: 'plan.state'; plan: PlanId; state: PlanState }
    /**
     * The owner asks another member to take it. No longer written: a plan is handed on with `plan.hand`.
     * Kept so a log from before 0.7.0 replays, and an ask still open can be answered.
     */
    | { op: 'plan.ask'; plan: PlanId; to: Actor; why: string }
    | { op: 'plan.ask.accept'; plan: PlanId }
    | { op: 'plan.ask.decline'; plan: PlanId; why: string }
    /** Any member hands a plan to any member, at once: to themselves, away, or between two others. */
    | { op: 'plan.hand'; plan: PlanId; to: Actor; why?: string }
    /** A plan's one goal, by name; null takes it off. A goal exists only as the label plans carry. */
    | { op: 'plan.goal'; plan: PlanId; goal: string | null }
    /** Every live plan carrying the goal takes the new name. */
    | { op: 'goal.rename'; from: string; to: string }
    /** Every live plan carrying the goal has none. */
    | { op: 'goal.remove'; goal: string }
    /**
     * Written by `system` alone, when a log that still has a shelf is opened: each shelf's
     * title becomes a goal on it and on its plans, and no plan sits under another after it.
     */
    | { op: 'shelves.retire' }
    /** Replaced whole. */
    | { op: 'plan.checklist'; plan: PlanId; items: readonly ChecklistItem[] }
    /** Keyed by path: attaching the same path again replaces it. */
    | { op: 'plan.attach'; plan: PlanId; path: string; name: string; size: number }
    | { op: 'plan.detach'; plan: PlanId; path: string; why: string }
    /** Keyed by contact. */
    | { op: 'plan.contact.link'; plan: PlanId; contact_id: number; addressbook_id: number; display: string }
    | { op: 'plan.contact.unlink'; plan: PlanId; contact_id: number }
    | { op: 'plan.due'; plan: PlanId; due: Day | null }
    /** Time set aside for it, keyed by block id. */
    | { op: 'plan.block'; plan: PlanId; block: string; start: string; end: string }
    | { op: 'plan.unblock'; plan: PlanId; block: string; why: string }
    /** Kept, and marked. */
    | { op: 'plan.remove'; plan: PlanId; why: string }
    // ─── a plan on the calendar ─────────────────────────────────────────────
    //
    // Written by the app, through effects authored by the member acting, never
    // by Claude: what the NAS said back when an event was made, moved or
    // found changed. Plan-shaped, so only members write them.
    /** The event made for a plan. Keyed by kind and block: linking the same again replaces it. */
    | {
        op: 'plan.calendar.link';
        plan: PlanId;
        kind: CalendarLinkKind;
        /** Set for a block, and only for a block: which one. */
        block?: string;
        cal_id: string;
        original_cal_id: string;
        evt_id: number;
        ical_uid: string;
        dav_etag: string;
      }
    | { op: 'plan.calendar.unlink'; plan: PlanId; kind: CalendarLinkKind; block?: string }
    /** After the app's own successful change to the event, its new etag. */
    | { op: 'plan.calendar.etag'; plan: PlanId; evt_id: number; dav_etag: string }
    // ─── a plan's page in Drive ─────────────────────────────────────────────
    //
    // Written by the app once it has written the page, through effects
    // authored by the member acting, never by Claude.
    /** The page was written; `event` is the plan's pageEvent it shows. A removed plan's last page says so. */
    | { op: 'plan.doc'; plan: PlanId; doc: DocRef; event: EventId }
    /**
     * The page was changed in Drive by someone other than the app: `theirs` is
     * the version found, `changes` what it says that the plan does not. Kept
     * open until a member decides, settled by `calendar.drift.resolve` like the
     * calendar's. `unreadable`: the page could not be read, so nothing is listed.
     */
    | { op: 'plan.page.drift'; plan: PlanId; theirs: DocRef; changes: readonly PageChange[]; unreadable?: true }
    /**
     * The event and the plan disagree: someone changed or deleted it on the
     * calendar (`theirs` null is deleted). Kept open until a member decides.
     * Only about a plan's due date or a block: an appointment, linked to a
     * plan or not, is not drift-checked yet.
     */
    | {
        op: 'calendar.drift'; plan: PlanId; evt_id: number; theirs: DriftSide | null; ours: DriftSide;
        /** Their version's etag, when the event is still there: what "move the plan" and "leave both" settle on. */
        dav_etag?: string;
        /** Who changed it, as the NAS names them, when it says. */
        changedBy?: string;
      }
    | { op: 'calendar.drift.resolve'; drift: EventId; choice: DriftChoice }
    /** A standalone event the app made, perhaps for a plan or with a person. */
    | {
        op: 'calendar.appointment';
        evt_id: number;
        cal_id: string;
        original_cal_id: string;
        ical_uid: string;
        dav_etag: string;
        summary: string;
        start: string;
        end: string;
        allDay: boolean;
        plan?: PlanId;
        contact?: ContactLink;
      }
    /**
     * An appointment the app made, taken off the calendar by a member (the
     * Calendar's form, Delete). A plan it was linked to is unlinked by its
     * own `plan.calendar.unlink` just before. `summary` is for the words.
     */
    | { op: 'calendar.appointment.remove'; evt_id: number; summary: string }
    /**
     * An appointment the app made, renamed or moved by a member (the
     * Calendar's form, Save). `start` and `end` are ISO instants as
     * `calendar.appointment` writes them; `was` is what the NAS had.
     */
    | {
        op: 'calendar.appointment.change'; evt_id: number; summary: string; start: string; end: string; allDay: boolean;
        dav_etag: string; was: { summary: string; start: string; end: string; allDay: boolean };
      }
    // ─── booking ────────────────────────────────────────────────────────────
    //
    // Friends asking to come and stay. The guest list is the household's,
    // kept by members with a reason; a guest, as `guest:<email>`, may only
    // ask (a `booking` card, which is also how they change dates) and cancel
    // their own. Nights run from arrival
    // (inclusive) to departure (exclusive), so one party's departure day is
    // the next one's arrival day.
    /** Someone who may ask to stay. Allowing the same email again replaces the entry. */
    | { op: 'guest.allow'; email: string; name: string; why: string; contact?: ContactLink }
    | { op: 'guest.revoke'; email: string; why: string }
    /** Nights kept for the household, from (inclusive) to (exclusive). Guests see them as taken. */
    | { op: 'booking.block'; from: Day; to: Day; why: string }
    | { op: 'booking.unblock'; block: EventId; why: string }
    /**
     * An approved request, with the event approval wrote on the Household
     * calendar. `replaces`: the guest's stay this change takes the place of,
     * replaced in the same line (its event comes off once this is written).
     */
    | {
        op: 'booking.confirm';
        request: EventId;
        replaces?: EventId;
        email: string;
        arrive: Day;
        depart: Day;
        headcount: number;
        cal_id: string;
        original_cal_id: string;
        evt_id: number;
        ical_uid: string;
        dav_etag: string;
      }
    /** A confirmed stay (by its own id or its request's), or a request still waiting. */
    | { op: 'booking.cancel'; stay: EventId; why: string }

    /** Other dates put to the guest, by a member. Not held. */
    | { op: 'booking.suggest'; request: EventId; email: string; arrive: Day; depart: Day; why: string }
    /** A cancelled stay's event taken off the Household calendar: a member acknowledging the cancel. */
    | { op: 'booking.release'; stay: EventId }
  );

export type Op = Event['op'];

/**
 * The ops that belong to the board: every `plan.` op, and the calendar lines
 * that hang off plans. Only members write them, and the thread shows only the
 * ones a member would want to see.
 */
const BOARD_CALENDAR_OPS: ReadonlySet<string> = new Set<Op>([
  'calendar.drift', 'calendar.drift.resolve', 'calendar.appointment', 'calendar.appointment.remove', 'calendar.appointment.change',
]);
export const planShaped = (op: Op): boolean =>
  op.startsWith('plan.') || op === 'goal.rename' || op === 'goal.remove' || BOARD_CALENDAR_OPS.has(op);

/** An event as a caller writes it: the store stamps id, timestamp and actor. */
export type NewEventShape = DistributiveOmit<Event, 'id' | 'at' | 'who'>;

/**
 * The assistant, as an author. It may brief, answer, offer and forecast — never
 * decide and never change anything. Replay refuses it anything else.
 */
export const CLAUDE: Actor = 'claude';
/** Where a briefing section comes from. A line written before there was a choice is a `budget` one. */
export type BriefingSource = 'budget' | 'plans' | 'calendar' | 'household';
export const BRIEFING_SOURCES: readonly BriefingSource[] = ['budget', 'plans', 'calendar', 'household'];

/** The app itself, as an author: it carries over a folder at boot and turns booking off. */
export const SYSTEM: Actor = 'system';

export const CLAUDE_MAY: ReadonlySet<Op> = new Set<Op>(['thread.briefing', 'thread.answer', 'proposal.offer', 'prediction.record']);

/** The five ops of this design. Only the owner (and, for two of them, `system`) writes four; any member may record `documents.moved`. */
export const CONFIG_OPS: ReadonlySet<Op> = new Set<Op>(
  ['documents.folder', 'documents.moved', 'household.zone', 'guests.booking', 'envelopes.model']);

/** What `system` may write among CONFIG_OPS. Facts a seed wrote as `system` are not limited by this. */
export const systemMay = (e: NewEventShape): boolean =>
  (e.op === 'documents.folder' && e.source === 'deployment') || (e.op === 'guests.booking' && !e.on);

/**
 * A friend of the household, as an author: `guest:` and their email. They may
 * ask to stay (a `booking` card, for new dates or changed ones), and cancel their own; replay
 * refuses them anything else, and refuses them altogether once off the list.
 */
export const GUEST_PREFIX = 'guest:';
export const isGuest = (who: Actor): boolean => who.startsWith(GUEST_PREFIX);
export const GUEST_MAY: ReadonlySet<Op> = new Set<Op>(['proposal.offer', 'booking.cancel']);

/** Notes and questions are read by people; past this they stop being read. */
export const THREAD_TEXT_MAX = 2000;
/** The arrival note: an address and how to get in, not a guidebook. */
export const ARRIVAL_MAX = 1000;

export type OfferStatus = 'open' | 'snoozed' | 'approved' | 'declined' | 'replaced';

/**
 * What raised a card: a briefing section, an answer, research asked from a
 * plan's card (an answer too, and hung under it the same way), a member
 * adjusting one, a member asking another to take a plan (`ref` is the
 * `plan.ask`), the app finding a plan's event changed on the calendar
 * (`ref` is the `calendar.drift`), a guest asking to stay, or a savings
 * balance short of the sinking envelopes (`ref` is the `account.balance`).
 */
export interface OfferPrompt { readonly kind: 'briefing' | 'answer' | 'research' | 'member' | 'ask' | 'drift' | 'booking' | 'savings'; readonly ref: EventId | null }

export interface Offer {
  readonly id: EventId;
  readonly at: string;
  readonly who: Actor;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly summary: string;
  readonly effects: readonly string[];
  readonly events: readonly NewEventShape[];
  readonly budget: BudgetId | null;
  readonly month: Month | null;
  readonly envelopes: readonly EnvelopeId[];
  readonly fingerprint: string;
  readonly prompt: OfferPrompt;
  readonly status: OfferStatus;
  readonly decidedBy?: Actor;
  readonly decidedAt?: string;
  readonly why?: string;
  readonly replacedBy?: EventId;
  /** The figures when it was last put off. It waits again once they move. */
  readonly snoozedAt?: string;
  /** The plan whose research raised it. */
  readonly plan?: PlanId;
}

/**
 * Who alone may see a card: the asker of an appointment for their own
 * calendar, which is theirs to approve and nobody else's to read. Null when
 * the household may see it, as it may every other card.
 */
export function privateTo(o: Pick<Offer, 'tool' | 'args' | 'who'>): Actor | null {
  if (o.tool !== 'propose_event' || o.args['on'] !== 'mine') return null;
  const asker = o.args['for'];
  return typeof asker === 'string' && asker ? asker : o.who;
}

/** Whether `who` may see this card: anyone, unless it is someone else's own. */
export const visibleTo = (o: Pick<Offer, 'tool' | 'args' | 'who'>, who: Actor): boolean => {
  const only = privateTo(o);
  return only === null || only === who;
};

export interface ThreadState {
  readonly offers: ReadonlyMap<EventId, Offer>;
  /** Per member, the flagged events they have marked seen. */
  readonly seen: ReadonlyMap<Actor, ReadonlySet<EventId>>;
}
export type EventOf<K extends Op> = Extract<Event, { op: K }>;

// ─── settings ─────────────────────────────────────────────────────────────────

export type Scheme = 'quartz' | 'lapis' | 'iolite' | 'graphite';
export type Mode = 'light' | 'dark' | 'match';
export const SCHEMES: ReadonlySet<string> = new Set<Scheme>(['quartz', 'lapis', 'iolite', 'graphite']);
export const MODES: ReadonlySet<string> = new Set<Mode>(['light', 'dark', 'match']);

export interface Appearance { readonly scheme: Scheme; readonly mode: Mode }

/**
 * Where an area stands in a list, found ignoring case (-1 when it is not there).
 * The one way areas.add, areas.remove and areas.move find an area, in the fold
 * and in the restore walk; the list keeps the household's own spelling.
 */
export const areaIndex = (areas: readonly string[], name: string): number => {
  const lower = name.toLowerCase();
  return areas.findIndex((a) => a.toLowerCase() === lower);
};

/** The list with the area at index `from` moved to `to`, held within the list. */
export const areaMoved = (areas: readonly string[], from: number, to: number): string[] => {
  const rest = areas.filter((_, i) => i !== from);
  rest.splice(Math.min(to, rest.length), 0, areas[from]!);
  return rest;
};

/** What a new household starts with, until someone sets its areas. */
export const DEFAULT_AREAS: readonly string[] = ['House', 'Money', 'People', 'Trips'];

export interface Settings {
  readonly areas: readonly string[];
  readonly links: readonly { label: string; url: string }[];
  /** How a guest gets in, for a stay's confirmation; '' when there is none. */
  readonly arrival: string;
  /** Per member. Absent until they choose; the client decides the default. */
  readonly appearance: ReadonlyMap<Actor, Appearance>;
  /** Whether friends may ask to stay; null until the owner chooses. `calendarGone`: the app turned it off because the Household calendar was found gone. */
  readonly booking: { readonly on: boolean; readonly by: Actor; readonly at: string; readonly calendarGone: boolean } | null;
  /** The model that suggests envelopes on import; null for the default. */
  readonly model: string | null;
}

/**
 * The pair of ids every DSM calendar call is addressed with. Here rather than
 * in the client, so the log's shapes do not depend on how the NAS is called.
 */
export interface CalendarRef { cal_id: string; original_cal_id: string }

/**
 * Whether two refs name the same calendar. Either id matching counts: a
 * calendar shared with someone may be listed for them under a `cal_id` of
 * their own while its `original_cal_id` stays the owner's (DSM does not say),
 * and the log holds the ids as its maker saw them.
 */
export const sameCalendar = (a: CalendarRef, b: CalendarRef): boolean =>
  a.cal_id === b.cal_id || a.original_cal_id === b.original_cal_id;

export interface CalendarState {
  /** `by` is the member who made it, whose calendar it is in DSM. */
  readonly household: CalendarRef & { name: string; by: Actor } | null;
  readonly target: CalendarRef | null;
  /** Per member, the calendars of theirs that plans are checked against. */
  readonly conflicts: ReadonlyMap<Actor, readonly (CalendarRef & { label: string })[]>;
}

// ─── plans ────────────────────────────────────────────────────────────────────

export type PlanId = string;
/** `planning` and `doing` are the board's columns; `done` leaves it. */
export type PlanState = 'planning' | 'doing' | 'done';
export interface ChecklistItem { readonly id: string; readonly text: string; readonly done: boolean }
export interface Attachment { readonly path: string; readonly name: string; readonly size: number; readonly who: Actor; readonly at: string }
export interface ContactLink { readonly contact_id: number; readonly addressbook_id: number; readonly display: string }
export interface Block { readonly id: string; readonly start: string /* ISO */; readonly end: string }

export type CalendarLinkKind = 'due' | 'block' | 'appointment';
export const CALENDAR_LINK_KINDS: readonly CalendarLinkKind[] = ['due', 'block', 'appointment'];
/** The event the app made for a plan, as the NAS knows it: where it is and the etag it was last seen with. */
export interface CalendarLink {
  readonly kind: CalendarLinkKind;
  /** Set for a block, and only for a block. */
  readonly block?: string;
  readonly cal_id: string;
  readonly original_cal_id: string;
  readonly evt_id: number;
  readonly ical_uid: string;
  readonly dav_etag: string;
}

/** One side of a drift: the event's times, in epoch seconds as DSM gives them, and its title. */
export interface DriftSide { readonly dtstart: number; readonly dtend: number; readonly summary: string }
export type DriftChoice = 'plan' | 'calendar' | 'leave';
export const DRIFT_CHOICES: readonly DriftChoice[] = ['plan', 'calendar', 'leave'];
/**
 * A plan's event that was changed on the calendar. Open while `resolved` is
 * null. A newer drift for the same event settles this one as `leave`, and
 * names itself in `replacedBy`.
 */
export interface Drift {
  readonly plan: PlanId;
  readonly evt_id: number;
  /** Null when the event was deleted. */
  readonly theirs: DriftSide | null;
  readonly ours: DriftSide;
  readonly resolved: DriftChoice | null;
  readonly replacedBy?: EventId;
  /** Their version's etag, when the event is still there and the NAS said it. */
  readonly dav_etag?: string;
  /** Who changed it, as the NAS names them. */
  readonly changedBy?: string;
  /** Which of the plan's dates the event was: 'due', or a block's id. */
  readonly slot?: string;
}

/** A field of a plan's page (`PageView`), as a change found in Drive names it. */
export type PageField = 'title' | 'area' | 'state' | 'due' | 'estimate' | 'notes' | 'checklist' | 'parent' | 'people' | 'envelope' | 'files';
export const PAGE_FIELDS: readonly PageField[] = [
  'title', 'area', 'state', 'due', 'estimate', 'notes', 'checklist', 'parent', 'people', 'envelope', 'files',
];
/** What may be taken from a page; the rest are the planner's to change and are said, never taken. */
export const TAKEABLE: ReadonlySet<PageField> = new Set(['title', 'area', 'state', 'due', 'estimate', 'notes', 'checklist']);
export type PageValue = string | number | null | readonly string[] | readonly { readonly text: string; readonly done: boolean }[];
export interface PageChange { readonly field: PageField; readonly from: PageValue; readonly to: PageValue }
/**
 * A plan's page that was changed in Drive. Open while `resolved` is null. A
 * newer drift for the same plan settles this one as `leave`, and names itself
 * in `replacedBy`, as the calendar's do.
 */
export interface PageDrift {
  readonly plan: PlanId; readonly theirs: DocRef; readonly changes: readonly PageChange[]; readonly unreadable: boolean;
  readonly resolved: DriftChoice | null; readonly replacedBy?: EventId;
}

/** A standalone event the app made, and who made it. */
export interface Appointment {
  readonly evt_id: number;
  readonly cal_id: string;
  readonly original_cal_id: string;
  readonly ical_uid: string;
  readonly dav_etag: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly plan?: PlanId;
  readonly contact?: ContactLink;
  readonly who: Actor;
  readonly at: string;
}

/** A plan handed on: whose it was and whose it became. */
export interface Hand { readonly plan: PlanId; readonly from: Actor; readonly to: Actor }

/**
 * A plan. Plans no longer sit under one another: `parent` is only ever set on a plan
 * from a log that still had shelves, and `shelves.retire` clears it (on a removed plan
 * it stays as history). Every plan has a state of its own. `stateAt` is when it entered its current state, which
 * is the only clock on the board, and it only shows in `doing`.
 */
export interface Plan {
  readonly id: PlanId; readonly title: string; readonly area: string; readonly parent: PlanId | null;
  readonly state: PlanState; readonly stateAt: string; readonly owner: Actor;
  /** The plan's one goal, by name; null for none. */
  readonly goal: string | null;
  /** When the plan became its owner's, and whose it was before; null from, for a maker's own. */
  readonly ownerSince: string; readonly ownerFrom: Actor | null;
  /** An open ask. One at a time; answered only by the member asked. */
  readonly asked: { readonly to: Actor; readonly at: string; readonly why: string } | null;
  /** Free text. Never moves it between columns. */
  readonly chips: readonly string[]; readonly notes: string;
  readonly estimate: Cents | null; readonly envelope: { readonly budget: BudgetId; readonly envelope: EnvelopeId } | null;
  readonly checklist: readonly ChecklistItem[]; readonly attachments: readonly Attachment[];
  readonly contacts: readonly ContactLink[]; readonly due: Day | null; readonly blocks: readonly Block[];
  /** Its events on the calendar: one per kind, one per block. */
  readonly links: readonly CalendarLink[];
  /**
   * Dates whose event was deleted on the calendar and left that way ("Leave
   * both"): 'due', or a block's id. Kept on the plan, off the calendar by a
   * member's choice, so a look at the calendar does not put them back. Setting
   * the date again, or putting it on the calendar from the card, clears it.
   */
  readonly letGo: readonly string[];
  readonly createdAt: string; readonly createdBy: Actor; readonly removed: boolean;
  /** The last event that changed what the plan's page shows. */
  readonly pageEvent: EventId;
  /** What the app last wrote to Drive for it, and which pageEvent that was. Null until a page is written. */
  readonly page: { readonly doc: DocRef; readonly event: EventId } | null;
}

/**
 * What a plan's page in Drive shows, and nothing else: a change to any of it
 * is a change to the page (`Plan.pageEvent`); a change to anything outside it
 * (an etag, a calendar link, an ask) is not.
 */
export interface PageView {
  readonly id: PlanId; readonly title: string; readonly area: string; readonly state: PlanState | 'removed';
  readonly parent: PlanId | null; readonly due: Day | null;
  /** `contacts:<contact_id>`, in the order they were linked. */
  readonly people: readonly string[];
  readonly envelope: EnvelopeId | null; readonly estimate: Cents | null; readonly notes: string;
  readonly checklist: readonly { readonly text: string; readonly done: boolean }[];
  /** Attachment names, in order. */
  readonly files: readonly string[];
}

/** Ops that require a reason. Enforced at append time, not left to the caller. */
export const REQUIRES_WHY: ReadonlySet<Op> = new Set<Op>(
  ['assign', 'move', 'income.set', 'member.add', 'member.remove', 'txn.remove',
   'envelope.remove', 'budget.archive', 'category.archive', 'month.close', 'month.discard',
   'income.source.remove', 'budget.locate',
   'plan.remove', 'plan.ask', 'plan.ask.decline', 'plan.detach', 'plan.unblock',
   'guest.allow', 'guest.revoke', 'booking.block', 'booking.unblock', 'booking.cancel', 'booking.suggest']);

// ─── booking ──────────────────────────────────────────────────────────────────

/** Someone on the household's guest list, keyed by their email, lowercased. */
export interface Guest {
  readonly name: string;
  /** How the household knows them, as the member who added them put it. */
  readonly why: string;
  readonly allowedBy: Actor;
  readonly at: string;
  readonly contact?: ContactLink;
}

/** A confirmed stay, keyed by its `booking.confirm`. Kept when cancelled, and marked. */
export interface Stay {
  /** The `proposal.offer` that asked for it. */
  readonly request: EventId;
  readonly email: string;
  readonly name: string;
  readonly arrive: Day;
  readonly depart: Day;
  readonly headcount: number;
  readonly cal_id: string;
  readonly original_cal_id: string;
  readonly evt_id: number;
  readonly ical_uid: string;
  readonly dav_etag: string;
  /** Holds no nights any more: cancelled, or replaced by a change (`replacedBy`). */
  readonly cancelled: boolean;
  /** The `booking.confirm` of the change that took its place; its event came off with that. */
  readonly replacedBy?: EventId;
  /** Who cancelled it, and the `booking.cancel` that did. */
  readonly cancelledBy?: Actor;
  readonly cancelledIn?: EventId;
  /** Cancelled, and its event taken off the Household calendar since. */
  readonly released?: true;
  readonly confirmedBy: Actor;
  readonly at: string;
}

/** Nights kept for the household, keyed by its `booking.block`; gone once unblocked. */
export interface StayBlock {
  readonly from: Day;
  readonly to: Day;
  readonly why: string;
  readonly by: Actor;
  readonly at: string;
}

// ─── replayed state ───────────────────────────────────────────────────────────

export interface Prediction {
  readonly id: string;
  readonly at: string;
  readonly who: Actor;
  readonly budget: BudgetId;
  readonly month: Month;
  readonly envelope: EnvelopeId;
  readonly expected: Cents;
  readonly why: string;
}

/** An account's balance on a day, and who recorded it where from. */
export interface AccountBalance {
  readonly account: string;
  readonly cents: Cents;
  readonly asOf: Day;
  readonly source: 'statement' | 'typed';
  /** The `account.balance` that recorded it. */
  readonly event: EventId;
  readonly who: Actor;
  readonly at: string;
}

export interface SavingsState {
  /** The account the sinking envelopes' money lives in. Null until someone chooses. */
  readonly account: string | null;
  /** Each account's latest balance: the latest day, and of one day the last recorded. */
  readonly balances: ReadonlyMap<string, AccountBalance>;
}

/** A Team Folder and a folder in it, one or more segments: Drive's /team-folders/<team>/<folder>, File Station's /<team>/<folder>. */
export interface DocumentsFolder { readonly team: string; readonly folder: string }

/** A file the log says the app wrote: a Drive document by its link, under its parent (`today`, `answers` or a plan's id), or a file on a card. */
export type MoveFile =
  | { readonly kind: 'doc'; readonly link: string; readonly parent: string; readonly name: string }
  | { readonly kind: 'card'; readonly plan: PlanId; readonly name: string };

/** One key per file, whichever shape names it: `link:<link>`, or `card:<plan>/<name>`. */
export const moveKey = (f: { link: string } | { plan: PlanId; name: string }): string =>
  'link' in f ? `link:${f.link}` : `card:${f.plan}/${f.name}`;

export interface DocumentsState {
  readonly folder: (DocumentsFolder & { readonly source: 'owner' | 'deployment'; readonly event: EventId; readonly by: Actor; readonly at: string }) | null;
  /** The folder before this one; null for the first choice. */
  readonly previous: DocumentsFolder | null;
  /** Every Drive document the app wrote that the log still points to, by moveKey. */
  readonly docs: ReadonlyMap<string, Extract<MoveFile, { kind: 'doc' }>>;
  /** The files still to move out of `previous`, by moveKey. Empty when no move is pending. */
  readonly waiting: ReadonlyMap<string, MoveFile>;
  /** A moved document's link before the move, to its DocRef now. */
  readonly relinked: ReadonlyMap<string, DocRef>;
}

export interface State {
  /** Who claimed this log. Null until someone does. */
  readonly owner: Actor | null;
  /** Everyone permitted to use it, owner included. */
  readonly members: ReadonlySet<Actor>;
  readonly label: string;
  /** The household's IANA zone, as its owner chose it; null until then. */
  readonly zone: string | null;
  readonly categories: ReadonlyMap<CategoryId, Category>;
  readonly budgets: ReadonlyMap<BudgetId, Budget>;
  readonly txns: ReadonlyMap<TxnId, Txn>;
  readonly rules: readonly Rule[];
  /** Keyed `${budget}:${month}`. */
  readonly months: ReadonlyMap<string, MonthPlan>;
  /** Per-person read cursor, keyed by actor. */
  readonly readCursor: ReadonlyMap<Actor, EventId>;
  readonly incomeSources: ReadonlyMap<string, import('./income.ts').IncomeSource>;
  readonly predictions: readonly Prediction[];
  readonly thread: ThreadState;
  readonly settings: Settings;
  readonly calendar: CalendarState;
  /** Every plan ever made, removed ones included and marked. */
  readonly plans: ReadonlyMap<PlanId, Plan>;
  /** Every hand of a plan, keyed by the `plan.hand` that made it. */
  readonly hands: ReadonlyMap<EventId, Hand>;
  /** Every drift ever noted, keyed by the `calendar.drift` that noted it. */
  readonly drifts: ReadonlyMap<EventId, Drift>;
  /** Every change found to a plan's page in Drive, keyed by the `plan.page.drift` that noted it. */
  readonly pageDrifts: ReadonlyMap<EventId, PageDrift>;
  /** Standalone events the app made, keyed by `evt_id`. */
  readonly appointments: ReadonlyMap<number, Appointment>;
  /** Who may ask to stay, keyed by email, lowercased. */
  readonly guests: ReadonlyMap<string, Guest>;
  /** Every confirmed stay, cancelled ones included and marked. */
  readonly stays: ReadonlyMap<EventId, Stay>;
  readonly stayBlocks: ReadonlyMap<EventId, StayBlock>;
  readonly savings: SavingsState;
  /** Where the household's documents live, and what is still to move there. */
  readonly documents: DocumentsState;
  readonly lastEventId: EventId | null;
  readonly eventCount: number;
}

/** How many files are still to move into the household's folder. */
export const movesLeft = (s: Pick<State, 'documents'>): number => s.documents.waiting.size;

export const monthKey = (budget: BudgetId, month: Month): string => `${budget}:${month}`;
export const monthOf = (date: Day): Month => date.slice(0, 7);

/**
 * The household's zone: the one given, or the deployment's TZ, which is where
 * the household is (DEPLOY.md); each trimmed, and UTC when neither is set,
 * because a default is a guess about somebody else's life. Read when asked.
 * Anything that has a household passes its choice, through `zoneOf`.
 */
export const householdZone = (tz?: string | null): string => tz?.trim() || process.env['TZ']?.trim() || 'UTC';

/** The zone a household's days and times are read in: its own choice, else the deployment's. */
export const zoneOf = (s: Pick<State, 'zone'>): string => householdZone(s.zone);

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * The household's calendar day an instant falls on: now, unless told when.
 * The one way the app turns an instant into a day, for the server's `today`
 * and the board's clock alike; one formatter per zone, made once and kept.
 */
export function householdDay(tz?: string | null, at: Date | string = new Date()): Day {
  const zone = householdZone(tz);
  let f = dayFormats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(zone, f);
  }
  return f.format(typeof at === 'string' ? new Date(at) : at);
}

/**
 * Plausibly an email address: one `@`, no spaces, a dot in the domain, none of
 * the characters the mailer refuses to put in a command line (`<>"\,;()`,
 * mail.ts addressOf), and at most 254 characters. Enough to catch a typo on
 * the guest list, and never an address the app could list but not mail;
 * whether it reaches anyone is the inbox's to say.
 */
export const isEmail = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length <= 254
  && /^[^\s@<>"\\,;()]+@[^\s@.<>"\\,;()]+(\.[^\s@.<>"\\,;()]+)+$/.test(v.trim());

/** An email as the log keys it: trimmed and lowercased. */
export const emailKey = (email: string): string => email.trim().toLowerCase();

/**
 * A real day, `YYYY-MM-DD`: one the calendar has, not just one shaped like it.
 * `2026-13-45` has the shape and is no day; a guest's words and a hand-edited
 * line are both refused by this, not thrown as a RangeError later.
 */
export const isDay = (v: unknown): v is Day => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};

/** The months as the app writes them short, in a date range or on a card. */
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** An id from a name: lower case, letters and digits joined by dashes, short enough to read in the log. */
export const slug = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

const SEGMENT_MAX = 200;

/**
 * What is wrong with one path segment, or null. Refused if it could be anything
 * else: a separator, a step up, a control character, a comma, which File
 * Station reads as a second path where it takes a list (so a file named with
 * one could not be read back), or a percent sign, which a path decoded once
 * more on the way could read as an escape for any of those. Pure, so the fold
 * checks a folder in the log by the same rule `attachments.ts`'s `segment`
 * applies to a file on a card.
 */
export function segmentProblem(value: unknown, what: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return `${what} is required`;
  if (value.length > SEGMENT_MAX) return `${what} is longer than ${SEGMENT_MAX} characters`;
  if (/[/\\]/.test(value)) return `${what} cannot contain / or \\`;
  if (value.includes('..') || value === '.') return `${what} cannot be . or contain ..`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return `${what} cannot contain a control character`;
  if (value.includes(',')) return `${what} cannot contain a comma: the NAS could not hand it back`;
  if (value.includes('%')) return `${what} cannot contain %: it could be read as an escape for another character`;
  return null;
}

/** Previous calendar month. Rollover walks backwards with this. */
export function prevMonth(month: Month): Month {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`;
}
