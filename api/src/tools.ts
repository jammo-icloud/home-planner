/**
 * The API surface, shaped as tools.
 *
 * There is no separate "AI layer". These operations are the API, the UI calls
 * them, and Claude calls the same ones. Two rules make that safe:
 *
 *   Reads are shaped like questions people ask, not like tables. Answering
 *   "why is my food envelope almost empty?" is one call, not six.
 *
 *   Writes never execute. They return a PROPOSAL — the events that would be
 *   appended, plus a preview of the effect. Only an explicit commit writes.
 *   The decision cards on the Today screen are exactly these proposals
 *   rendered for approval.
 */

import { ZERO, add, sub, cents, fmt, fmtExact } from './money.ts';
import type { Cents } from './money.ts';
import { carriedInto, monthView, latestMonth, openMonths, overlappingCategories } from './envelopes.ts';
import { donors, drift, monthClock, pace, snapshot, unsorted } from './analytics.ts';
import { fundedFor, plannedFor, categorize, splitProblem, guestEmail } from './replay.ts';
import { filedLabel, ruleProblem } from './match.ts';
import { removedTxn } from './activity.ts';
import { byMonthly, everyMonthly, everyWords, goalFor, savingsCheck, shortDay, sinkingPlan } from './sinking.ts';
import { incomeFor, project, sourcesFor } from './income.ts';
import { lookUp, placeForZip } from './local.ts';
import { groupKind, groupOrder, missingStarter } from './starter.ts';
import { cardFor, coverFor, hintFor } from './figures.ts';
import type { Cover, Hint } from './figures.ts';
import type { MissingStarter } from './starter.ts';
import { board, card } from './plans.ts';
import { SEARCH_KINDS, searchHousehold, searchKind, searchWords } from './search.ts';
import { raiseAskCards } from './plan-edits.ts';
import {
  blockTimes, contactLink, envelopeRef, knownArea, liveChildren, livePlan, newBlockId, newPlanId, PLAN_LIMITS, PLAN_STATES,
  planChecklist, planChips, planDue, planEstimate, planNotes, planState, planTitle, required, shelfFor,
} from './plan-rules.ts';
import { ToolError } from './errors.ts';
import { resolvedEnv } from './connectors.ts';
import { SynologyError, createContact, listAddressbooks, requireSid } from './synology.ts';
import { syncBlock, syncDue, syncNames, undoMade, unsyncAll } from './calendar.ts';
import { oneAtATime, planKey } from './settings.ts';
import { afterPageSettled, driftWords, pageDriftWords, raiseDriftCards, settleDrift, settlePageDrift } from './drift.ts';
import { appointmentNotes, appointmentTimes, appointmentWords, conflictsFor, makeAppointment } from './appointments.ts';
import type { AppointmentAsked } from './appointments.ts';
import type { IncomeSource } from './income.ts';
import {
  checkCard, confirmStay, releasable, releaseStay, requestPrefix, requestWords, stayDates, takeOffReplaced, tellDeclined, unconfirm,
} from './booking.ts';
import type { BookingMail } from './booking.ts';
import {
  DRIFT_CHOICES, emailKey, isEmail, isGuest, isSpend, monthOf, monthKey, MONTHS_SHORT, partsOf, slug, SPLIT, TRANSFER, INCOME, zoneOf,
} from './types.ts';
import type {
  Actor, Assignment, BudgetId, BudgetLocation, Day, DriftChoice, Envelope, Event, Match, Month, Plan, PlanState, SinkingEstimate, SinkingGoal, SplitPart, State, Txn,
} from './types.ts';
import type { Store, NewEvent } from './store.ts';

// ─── proposals ────────────────────────────────────────────────────────────────

export interface Proposal {
  readonly id: string;
  readonly tool: string;
  readonly who: Actor;
  /** One sentence a person can approve without reading the events. */
  readonly summary: string;
  /** What changes if this is committed. Rendered as the decision card's body. */
  readonly effects: readonly string[];
  readonly events: readonly NewEvent[];
  /**
   * The arguments the tool was called with, so approving the proposal can run
   * its effect with the same ones. Recorded by the call sites (`runTool`, and
   * `offer` for a card), never by the tool, so no tool can forget them.
   */
  readonly args?: Record<string, unknown>;
  readonly createdAt: string;
}

export class ProposalStore {
  #map = new Map<string, Proposal>();
  #seq = 0;

  put(p: Omit<Proposal, 'id' | 'createdAt'>, at: string): Proposal {
    const full: Proposal = { ...p, id: `p-${++this.#seq}-${at}`, createdAt: at };
    this.#map.set(full.id, full);
    // keep the map from growing without bound; proposals are short-lived
    if (this.#map.size > 200) {
      const oldest = [...this.#map.keys()][0];
      if (oldest) this.#map.delete(oldest);
    }
    return full;
  }

  /** The same proposal, now carrying the args it was made with. */
  withArgs(p: Proposal, args: Record<string, unknown>): Proposal {
    const full: Proposal = { ...p, args };
    if (this.#map.has(p.id)) this.#map.set(p.id, full);
    return full;
  }

  take(id: string): Proposal | undefined {
    const p = this.#map.get(id);
    if (p) this.#map.delete(id); // single use: approving twice must not double-apply
    return p;
  }
}

// ─── tool definitions ─────────────────────────────────────────────────────────

export interface ToolContext {
  readonly store: Store;
  readonly who: Actor;
  readonly today: Day;
  readonly proposals: ProposalStore;
  /**
   * The DSM session id, for the routes that talk to the NAS. Null for the local
   * sandbox sign-in, which never went through DSM, and for work done with no
   * person present (the briefing); `requireSid` refuses those.
   */
  readonly sid: string | null;
  /**
   * How a guest is told of a decision on their request: on a member's context
   * only in the household friends book with, and only while booking is on.
   */
  readonly mail?: BookingMail;
  /** The open household's id: where its folder is on the NAS. Absent for the sandbox and for work with no household. */
  readonly household?: string;
}

export interface Tool {
  readonly name: string;
  /** Written for Claude to read. Says what it answers, not how it works. */
  readonly description: string;
  readonly kind: 'read' | 'write';
  readonly input: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): unknown;
  /**
   * Work outside the log that approving this must do first: a call to the NAS,
   * a mail to send. Runs once, at decision time, before anything is appended,
   * and returns the events to append with the decision and the stored events in
   * one write. If it throws, nothing is appended and the error is the answer,
   * so the effect undoes whatever it already did before it throws. `events`
   * are the proposal's own stored events, for an effect that needs what the
   * tool's run made up (a new block's id). `card` is the card being approved,
   * when it is one (a confirmation names the request it confirms).
   */
  effect?(args: Record<string, unknown>, ctx: ToolContext, events: readonly NewEvent[], card?: string): Promise<NewEvent[]>;
  /**
   * Work outside the log that declining this must do first: a guest's request
   * declined is mailed the reason. Runs before the decline is appended; if it
   * throws, nothing is appended and the card stays open.
   */
  onDecline?(args: Record<string, unknown>, ctx: ToolContext, why?: string): Promise<void>;
  /**
   * The effect's events are written before the stored ones rather than after:
   * for a tool whose stored event closes something the effect's events must
   * still name (a plan removed, after its events are unlinked from it).
   */
  readonly effectFirst?: boolean;
  /**
   * Undo what a successful effect did, for when the append after it is then
   * refused (two members approving at once): `extra` is what the effect
   * returned. Best effort, and never the answer: the refusal is.
   */
  compensate?(args: Record<string, unknown>, ctx: ToolContext, extra: readonly NewEvent[]): Promise<void>;
  /**
   * What the member must be told when the write after a successful effect is
   * refused, beside the refusal: what the effect did that compensate cannot
   * call back (a confirmation already in the guest's inbox). Null for nothing.
   */
  refusedAfter?(args: Record<string, unknown>, ctx: ToolContext, extra: readonly NewEvent[]): string | null;
  /**
   * Work outside the log that must wait until the decision is written: what
   * the effect could not undo if the write were refused (a changed stay's old
   * event, taken off once the change is recorded). `extra` is what the effect
   * returned. If it throws, the write stands and the error is the answer.
   */
  afterWrite?(args: Record<string, unknown>, ctx: ToolContext, extra: readonly NewEvent[]): Promise<void>;
  /**
   * Arguments a member chooses as they approve the card, and the values each
   * may take: a card with more than one way to say yes (a drift's three
   * choices). Nothing else about a card can be changed at approval.
   */
  readonly chosenOnApproval?: Readonly<Record<string, readonly string[]>>;
  /**
   * The args as they are recorded, from the args a caller gave: what the
   * call sites run the tool with and keep on its proposal or card, for a tool
   * whose card must remember something about the moment it was made (who
   * asked). Whatever a caller sent under the same names is replaced.
   */
  stampArgs?(args: Record<string, unknown>, ctx: ToolContext, before?: Record<string, unknown>): Record<string, unknown>;
}

/**
 * The args a call is run with and recorded with: the tool's stamp on them, if
 * it has one. `before` is the card's args when a card is worked out again or
 * adjusted, so what was stamped on it then stays.
 */
export const recordedArgs = (tool: Tool, args: Record<string, unknown>, ctx: ToolContext,
                             before?: Record<string, unknown>): Record<string, unknown> =>
  tool.stampArgs ? tool.stampArgs(args, ctx, before) : args;

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`${name} is required`);
  return v;
};
const num = (v: unknown, name: string): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`${name} must be a number`);
  return n;
};
const money = (v: unknown, name: string): Cents => cents(Math.round(num(v, name)));

export { ToolError };

const resolveMonth = (state: State, budget: string, month: unknown): Month => {
  if (typeof month === 'string' && month) return month;
  const latest = latestMonth(state, budget);
  if (!latest) throw new ToolError(`no months are open for ${budget}`);
  return latest;
};

// ─── reads ────────────────────────────────────────────────────────────────────

// A hint's figure also goes out to the cent, so a screen that takes it does not round it.
const hintView = (h: Hint | null) =>
  h === null ? null : h.use ? { ...h, use: { ...h.use, exact: fmtExact(h.use.cents) } } : h;

/** A cover for get_month: its cents, and the same as exact dollars. */
const shortView = (c: Cover | null) => c === null ? null : {
  ...c,
  amountExact: fmtExact(c.amount),
  hadLeftExact: fmtExact(c.hadLeft),
  receipt: c.receipt === null ? null : { ...c.receipt, exact: fmtExact(c.receipt.amount) },
  donors: c.donors.map((d) => ({ ...d, spareExact: fmtExact(d.spare) })),
  assignExact: c.assign === null ? null : fmtExact(c.assign),
};

const getMonth: Tool = {
  name: 'get_month',
  description:
    'How a budget is doing this month: every envelope with planned, funded, spent and left, ' +
    'plus pace projections, plan drift, the unsorted queue and whether it balances. ' +
    'Start here for any "how are we doing" question.',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string', description: 'A budget id — see the budgets in this household.' },
      month: { type: 'string', description: 'YYYY-MM. Defaults to the latest open month.' },
    },
    required: ['budget'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const month = resolveMonth(state, budget, args['month']);
    const snap = snapshot(state, budget, month, ctx.today);
    if (!snap) throw new ToolError(`${month} is not open for ${budget}`, 404);
    const budgetRow = state.budgets.get(budget);
    return {
      budget, month,
      dayOfMonth: snap.clock.dayOfMonth,
      daysInMonth: snap.clock.daysInMonth,
      income: fmt(snap.view.income),
      planned: fmt(snap.view.planned),
      funded: fmt(snap.view.funded),
      spent: fmt(snap.view.activity),
      toAssign: fmt(snap.view.toAssign),
      // To the cent, for anything that has to round-trip a figure rather than
      // only display it. The dollar fields round — carry is $893.34 and reads
      // "$893" — so an editor built on those would lose 34c every time it saved.
      // Still dollars, never raw cents: a bare 89334 is what gets misread.
      incomeExact: fmtExact(snap.view.income),
      toAssignExact: fmtExact(snap.view.toAssign),
      card: cardFor(snap.view),
      groups: groupOrder(snap.view.envelopes.map((e) => e.envelope.group)),
      balanced: snap.balanced,
      closed: state.months.get(monthKey(budget, month))?.closed === true,
      movesThisMonth: snap.view.moveCount,
      spentOutsideThisBudget: fmt(snap.view.outside.total),
      envelopes: snap.view.envelopes.map((e) => ({
        id: e.envelope.id,
        label: e.envelope.label,
        group: e.envelope.group,
        planned: fmt(e.planned),
        funded: fmt(e.funded),
        spent: fmt(e.activity),
        left: fmt(e.available),
        carriedIn: fmt(e.carried),
        plannedExact: fmtExact(e.planned),
        fundedExact: fmtExact(e.funded),
        spentExact: fmtExact(e.activity),
        leftExact: fmtExact(e.available),
        adjustedBy: e.adjustedBy === 0 ? null : fmt(e.adjustedBy),
        overspent: e.overspent,
        // Which categories feed it, so its goal can be set from their estimates.
        categories: e.envelope.match.categories,
        // Action required while no figure has been given, with what could help give one.
        needsFigure: e.envelope.needsFigure === true,
        source: e.envelope.source ?? null,
        hint: e.envelope.needsFigure && budgetRow ? hintView(hintFor(state, budgetRow, e.envelope, month)) : null,
        // Short only once it has a figure: a flagged envelope shows Action required, never Short.
        short: e.envelope.needsFigure ? null : shortView(coverFor(state, snap.view, e.envelope.id, ctx.today)),
        // Saved in Savings: what it holds so far is what is left in it.
        sinking: sinkingView(state, budget, e.envelope, month, e.available),
      })),
      // The sinking envelopes against the savings account; null with none.
      savings: savingsView(state, budget, ctx.today),
      pace: snap.pace.filter((p) => p.status !== 'ok').map((p) => ({
        envelope: p.envelope, label: p.label, status: p.status,
        spent: fmt(p.spent), left: fmt(p.available),
        projectedToSpend: fmt(p.projected),
        projectedOverBy: p.projectedOver > 0 ? fmt(p.projectedOver) : null,
      })),
      planDrift: snap.drift.filter((d) => d.toppedUp >= 2).map((d) => ({
        envelope: d.envelope, label: d.label,
        toppedUpInLastMonths: d.toppedUp,
        averagePlanned: fmt(d.averagePlanned),
        averageActuallyFunded: fmt(d.averageFunded),
        months: d.months.map((m) => ({ month: m.month, planned: fmt(m.planned), funded: fmt(m.funded), spent: fmt(m.spent) })),
      })),
      unsorted: {
        count: snap.unsorted.count,
        unexplainedSpending: fmt(snap.unsorted.outflow),
        moneyIn: fmt(snap.unsorted.inflow),
        oldest: snap.unsorted.oldest,
      },
      recurringWithoutARule: snap.recurring.map((r) => ({
        payee: r.payee, typical: fmt(r.typical), seenInMonths: r.months,
      })),
    };
  },
};

/**
 * An envelope.define that rewrites `env` with `change`, carrying every field it does not
 * name (needsFigure, source and sinking among them). `figure` means a number was given:
 * the template becomes it, the flag goes, and the source becomes `figure.source` (none when absent).
 */
export function redefine(budget: BudgetId, env: Envelope, change: {
  label?: string; group?: string; match?: Match; rollover?: boolean; sinking?: SinkingGoal | null;
  figure?: { template: Cents; source?: string };
} = {}): NewEvent {
  const sinking = change.sinking === undefined ? env.sinking : change.sinking;
  const source = change.figure ? change.figure.source : env.source;
  return {
    op: 'envelope.define', budget, envelope: env.id,
    label: change.label ?? env.label, group: change.group ?? env.group,
    match: change.match ?? env.match, rollover: change.rollover ?? env.rollover,
    template: change.figure?.template ?? env.template, order: env.order,
    ...(sinking !== undefined ? { sinking } : {}),
    ...(env.needsFigure && !change.figure ? { needsFigure: true as const } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

/** A sinking envelope's goal for get_month, as exact dollars: an editor round-trips them. */
function sinkingView(state: State, budget: string, env: Envelope, month: Month, saved: Cents) {
  const g = goalFor(state, budget, env, month);
  if (!g) return null;
  return {
    kind: g.kind,
    monthly: fmt(g.monthly), monthlyExact: fmtExact(g.monthly),
    goal: fmt(g.target), goalExact: fmtExact(g.target),
    saved: fmt(saved), savedExact: fmtExact(saved),
    by: g.by, byName: g.by ? monthName(g.by) : null, monthsLeft: g.monthsLeft, passed: g.passed,
    estimates: g.estimates.map((e) => ({
      category: e.category, label: e.label,
      cost: e.cost === null ? null : fmtExact(e.cost), everyYears: e.everyYears, monthly: fmtExact(e.monthly),
    })),
  };
}

/** The check against Savings for get_month and Settings: the figures, and the words to say them in. */
export function savingsView(state: State, budget: string, today: Day) {
  const c = savingsCheck(state, budget, today);
  if (!c) return null;
  return {
    status: c.status, account: c.account,
    held: fmt(c.held), heldExact: fmtExact(c.held),
    difference: fmt(c.difference), differenceExact: fmtExact(c.difference),
    balance: c.balance ? { exact: fmtExact(c.balance.cents), asOf: c.balance.asOf, source: c.balance.source } : null,
    daysOld: c.daysOld, words: c.words,
  };
}

const explainEnvelope: Tool = {
  name: 'explain_envelope',
  description:
    'Everything needed to explain one envelope in a single call: what was planned, what it is ' +
    'funded at now and why it changed, what has been spent and on what, how it is pacing, and ' +
    'how it has behaved over recent months. Use for "why is my food envelope almost empty?".',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      envelope: { type: 'string', description: 'Envelope id, e.g. daily' },
      month: { type: 'string' },
    },
    required: ['budget', 'envelope'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const envelopeId = str(args['envelope'], 'envelope');
    const month = resolveMonth(state, budget, args['month']);
    const view = monthView(state, budget, month);
    if (!view) throw new ToolError(`${month} is not open for ${budget}`, 404);
    const e = view.envelopes.find((x) => x.envelope.id === envelopeId);
    if (!e) throw new ToolError(`no envelope ${envelopeId} in ${budget}`, 404);

    const clock = monthClock(month, ctx.today);
    const p = pace(view, clock, state).find((x) => x.envelope === envelopeId);
    const d = drift(state, budget, month, 4).find((x) => x.envelope === envelopeId);

    // One entry per part that lands here. A split receipt shows its share as
    // `amount`, and the whole receipt as `of`, so the list adds up to `spent`.
    const txns = e.lines
      .map((line) => ({ line, t: state.txns.get(line.txnId)! }))
      .sort((a, b) => b.t.date.localeCompare(a.t.date))
      .map(({ line, t }) => ({
        date: t.date, payee: t.payee, amount: fmtExact(cents(-line.amount)), category: line.category,
        ...(line.split ? { of: fmtExact(t.amount) } : {}),
        // What an edit needs: the receipt itself, its whole amount, and every part, not just this one's.
        txn: t.id, amountCents: t.amount,
        parts: t.split ? t.split.map((p) => ({ category: p.category as string, amountCents: p.amount as number })) : null,
      }));

    return {
      budget, month,
      envelope: e.envelope.id,
      label: e.envelope.label,
      feedsFrom: e.envelope.match,
      rollsOver: e.envelope.rollover,
      planned: fmt(e.planned),
      funded: fmt(e.funded),
      carriedIn: fmt(e.carried),
      spent: fmt(e.activity),
      left: fmt(e.available),
      // Exact, so "these receipts add up to this number" can actually be
      // checked. Comparing rounded dollars would report a mismatch on any
      // envelope holding a fraction of a cent's worth of rounding.
      fundedExact: fmtExact(e.funded),
      carriedInExact: fmtExact(e.carried),
      spentExact: fmtExact(e.activity),
      leftExact: fmtExact(e.available),
      dayOfMonth: clock.dayOfMonth,
      daysInMonth: clock.daysInMonth,
      pacing: p ? {
        status: p.status,
        projectedToSpend: fmt(p.projected),
        // What the projection is made of. A fixed bill counts once at its known
        // amount; only the variable part is extrapolated at the current rate.
        fixedBillsPaid: fmt(p.committed),
        fixedBillsStillToArrive: fmt(p.stillExpected),
        variableSpendSoFar: fmt(p.discretionary),
        projectedOverBy: p.projectedOver > 0 ? fmt(p.projectedOver) : null,
      } : null,
      adjustmentsThisMonth: e.trail.map((a) => ({
        who: a.who, why: a.why, at: a.at,
        change: `${a.delta > 0 ? '+' : ''}${fmt(a.delta)}`,
        otherSide: a.counterpart ?? null,
      })),
      recentMonths: d?.months.map((m) => ({
        month: m.month, planned: fmt(m.planned), funded: fmt(m.funded), spent: fmt(m.spent),
      })) ?? [],
      toppedUpInRecentMonths: d?.toppedUp ?? 0,
      transactions: txns,
    };
  },
};

const findDonors: Tool = {
  name: 'find_donors',
  description:
    'Which envelopes could spare money for another one, ranked. Spare means left over after ' +
    'allowing for what each is still likely to spend this month, so a fast-burning envelope ' +
    'with a healthy balance is correctly not offered. Use for "what should I pull from?".',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      forEnvelope: { type: 'string', description: 'The envelope that needs money.' },
      month: { type: 'string' },
    },
    required: ['budget', 'forEnvelope'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const target = str(args['forEnvelope'], 'forEnvelope');
    const month = resolveMonth(state, budget, args['month']);
    const view = monthView(state, budget, month);
    if (!view) throw new ToolError(`${month} is not open for ${budget}`, 404);
    const clock = monthClock(month, ctx.today);
    const need = view.envelopes.find((e) => e.envelope.id === target);
    const shortfall = need && need.available < 0 ? cents(-need.available) : ZERO;
    return {
      budget, month,
      forEnvelope: target,
      shortfall: fmt(shortfall),
      donors: donors(view, clock, target, state).map((d) => ({
        envelope: d.envelope, label: d.label,
        left: fmt(d.available), couldSpare: fmt(d.spare),
        coversShortfall: shortfall > 0 && d.spare >= shortfall,
      })),
    };
  },
};

const listTransactions: Tool = {
  name: 'list_transactions',
  description:
    'Search the ledger. Filter by month, category, envelope, payee text, or uncategorized only. ' +
    'Transactions belong to the household, not to a budget — the same transaction is visible ' +
    'from every budget.',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      month: { type: 'string' },
      category: { type: 'string' },
      payeeContains: { type: 'string' },
      uncategorizedOnly: { type: 'boolean' },
      limit: { type: 'number', description: 'Default 50.' },
    },
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const limit = Math.min(args['limit'] ? num(args['limit'], 'limit') : 50, 500);
    const month = args['month'] as string | undefined;
    const category = args['category'] as string | undefined;
    const contains = (args['payeeContains'] as string | undefined)?.toLowerCase();

    let rows = [...state.txns.values()];
    if (month) rows = rows.filter((t) => monthOf(t.date) === month);
    // The marker filter finds the split receipts themselves; any other category finds receipts with a part in it.
    if (category) rows = rows.filter((t) => category === SPLIT ? t.category === SPLIT : partsOf(t).some((p) => p.category === category));
    if (args['uncategorizedOnly']) rows = rows.filter((t) => t.category === null);
    if (contains) rows = rows.filter((t) => `${t.payee} ${t.memo ?? ''}`.toLowerCase().includes(contains));
    rows.sort((a, b) => b.date.localeCompare(a.date));

    // Under a category filter only that category's share of a split counts; the whole receipt would count it twice.
    const share = (t: Txn): number[] => category && category !== SPLIT
      ? partsOf(t).filter((p) => p.category === category).map((p) => p.amount)
      : [t.amount];
    const amounts = rows.flatMap(share);

    return {
      matched: rows.length,
      showing: Math.min(rows.length, limit),
      total: fmt(cents(amounts.reduce((n, a) => n + Math.abs(a), 0))),
      // Apart, because added together an unsorted paycheque reads as spending.
      moneyOut: fmtExact(cents(amounts.reduce((n, a) => n + (a < 0 ? -a : 0), 0))),
      moneyIn: fmtExact(cents(amounts.reduce((n, a) => n + (a > 0 ? a : 0), 0))),
      transactions: rows.slice(0, limit).map((t) => ({
        id: t.id, date: t.date, payee: t.payee, memo: t.memo ?? null,
        amount: fmtExact(t.amount), category: t.category, setByHand: !!t.manual,
        // A split receipt's category is the marker; the parts say where it went.
        parts: t.split ? t.split.map((p) => ({ category: p.category, amount: fmtExact(p.amount) })) : null,
      })),
    };
  },
};

const compareBudgets: Tool = {
  name: 'compare_budgets',
  description:
    'Line up two budgets side by side to show what the move actually costs per month. ' +
    'Compares envelope templates, not a single month, so it answers "what changes when we go?".',
  kind: 'read',
  input: {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'string' } },
    required: ['a', 'b'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const aId = str(args['a'], 'a');
    const bId = str(args['b'], 'b');
    const A = state.budgets.get(aId);
    const B = state.budgets.get(bId);
    if (!A || !B) throw new ToolError('unknown budget', 404);

    const keys = new Set([...A.envelopes.keys(), ...B.envelopes.keys()]);
    const rows = [...keys].map((k) => {
      const ea = A.envelopes.get(k);
      const eb = B.envelopes.get(k);
      const va = ea?.template ?? ZERO;
      const vb = eb?.template ?? ZERO;
      return {
        envelope: k,
        label: eb?.label ?? ea?.label ?? k,
        group: eb?.group ?? ea?.group ?? 'Other',
        [aId]: fmt(va), [bId]: fmt(vb),
        [`${aId}Exact`]: fmtExact(va), [`${bId}Exact`]: fmtExact(vb),
        difference: fmt(sub(vb, va)),
        differenceExact: fmtExact(sub(vb, va)),
        // An envelope that exists in one budget and not the other is a bigger
        // finding than one whose number changed: it means a whole cost either
        // appears or disappears with the move.
        onlyIn: !ea ? bId : !eb ? aId : null,
        raw: sub(vb, va),
      };
    }).sort((x, y) => Math.abs(y.raw) - Math.abs(x.raw));

    const totalA = cents([...A.envelopes.values()].reduce((n, e) => n + e.template, 0));
    const totalB = cents([...B.envelopes.values()].reduce((n, e) => n + e.template, 0));

    /**
     * What each plan costs is only half the question. Whether it fits is the
     * other half, and that needs the income actually recorded for each budget —
     * which may differ, since a move can change what either of you earns.
     */
    const fits = (id: string, total: Cents) => {
      const sources = sourcesFor(state, id);
      if (!sources.length) return { income: null, covered: null, gap: null };
      const months = project(sources, monthOf(ctx.today), 12);
      const lowest = months.reduce((m, x) => (x.total < m.total ? x : m), months[0]!);
      return {
        income: fmt(lowest.total),
        covered: lowest.total >= total,
        gap: lowest.total >= total ? fmt(cents(lowest.total - total)) : fmt(cents(total - lowest.total)),
      };
    };

    return {
      comparing: [aId, bId],
      labels: { [aId]: A.label, [bId]: B.label },
      monthlyTotal: { [aId]: fmt(totalA), [bId]: fmt(totalB) },
      monthlyDifference: fmt(sub(totalB, totalA)),
      // To the cent as well, because the annual figure is twelve times the exact
      // monthly one. Showing only the rounded month invites a reader to multiply
      // it and get a different answer to the one on the same line.
      monthlyDifferenceExact: fmtExact(sub(totalB, totalA)),
      annualDifference: fmt(cents(sub(totalB, totalA) * 12)),
      // Measured against the leanest month in the next year, because a plan
      // that only works in a three-paycheque month does not work.
      affordability: { [aId]: fits(aId, totalA), [bId]: fits(bId, totalB) },
      byEnvelope: rows.map(({ raw, ...r }) => r),
    };
  },
};

const getActivity: Tool = {
  name: 'get_activity',
  description:
    'The log, readable: who changed what, when, and why. Filter to one envelope to see how a ' +
    'plan has been argued with over time. Nothing is ever deleted, so this is complete.',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      sinceEventId: { type: 'string', description: 'Everything after this event. Omit for the most recent.' },
      envelope: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  async run(args, ctx) {
    const limit = Math.min(args['limit'] ? num(args['limit'], 'limit') : 50, 500);
    const since = (args['sinceEventId'] as string | undefined) ?? null;
    let events = await ctx.store.since(since);
    const envelope = args['envelope'] as string | undefined;
    if (envelope) {
      events = events.filter((e) =>
        (e.op === 'assign' && e.envelope === envelope) ||
        (e.op === 'move' && (e.from === envelope || e.to === envelope)));
    }
    const tail = events.slice(-limit);
    return {
      total: events.length,
      showing: tail.length,
      lastEventId: events.at(-1)?.id ?? null,
      events: tail.map((e) => describe(e, ctx.store.state)),
    };
  },
};

/** One human sentence per event. The Activity screen renders these directly. */
/** "2026-10" as "October 2026". */
const monthName = (m: string): string => {
  const [y, mo] = m.split('-').map(Number);
  if (!y || !mo) return m;
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};


/** Nights as a person says them: "12–15 Dec", or "30 Dec – 2 Jan" across a month. */
const dayRange = (from: string, to: string): string => {
  const parse = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    const month = m ? MONTHS_SHORT[Number(m[2]) - 1] : undefined;
    return m && month ? { day: Number(m[3]), month, ym: `${m[1]}-${m[2]}` } : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return `${from} to ${to}`;
  return a.ym === b.ym ? `${a.day}–${b.day} ${b.month}` : `${a.day} ${a.month} – ${b.day} ${b.month}`;
};

export function describe(
  e: Event,
  /** When given, budgets, envelopes, categories and months read by name rather than by id. */
  state?: State,
): { id: string; at: string; who: Actor; what: string; why: string | null } {
  const why = (e as { why?: string }).why ?? null;
  // A name that has since gone falls back to the id: something, never nothing.
  const budget = (id: string) => state?.budgets.get(id)?.label ?? id;
  const env = (b: string, id: string) => state?.budgets.get(b)?.envelopes.get(id)?.label ?? id;
  const cat = (id: string | null) => id === null ? 'uncategorized'
    : !state ? id
    : id === TRANSFER ? 'a transfer' : id === INCOME ? 'income' : id === SPLIT ? 'a split' : state.categories.get(id)?.label ?? id;
  const mon = (m: string) => state ? monthName(m) : m;
  // Without the state, or for a plan it does not know, the id stands in.
  const plan = (id: string) => state?.plans.get(id)?.title ?? id;
  let what: string;
  switch (e.op) {
    case 'assign': what = `set ${env(e.budget, e.envelope)} to ${fmt(e.to)}`; break;
    case 'move': what = `moved ${fmt(e.amount)} from ${env(e.budget, e.from)} to ${env(e.budget, e.to)}`; break;
    case 'income.set': what = `set income to ${fmt(e.amount)}`; break;
    case 'month.open': what = `opened ${mon(e.month)} for ${budget(e.budget)}`; break;
    case 'txn.add': what = `imported ${e.txns.length} transactions${e.source ? ` from ${e.source}` : ''}`; break;
    case 'txn.categorize': what = `categorized a transaction as ${cat(e.category)}`; break;
    case 'txn.split': {
      const parts = e.parts.map((p) => `${cat(p.category)} ${fmtExact(cents(Math.abs(p.amount)))}`);
      const last = parts.pop();
      what = `split a receipt across ${parts.length ? `${parts.join(', ')} and ${last}` : last}`;
      break;
    }
    case 'rule.add': what = `added rule "${e.match}" to ${cat(e.category)}`; break;
    case 'rule.remove': what = 'removed a rule'; break;
    case 'envelope.define':
      what = e.sinking ? `saved ${env(e.budget, e.envelope)} in Savings, in ${budget(e.budget)}`
        : e.sinking === null ? `stopped saving ${env(e.budget, e.envelope)} in Savings, in ${budget(e.budget)}`
        : `defined envelope ${env(e.budget, e.envelope)} in ${budget(e.budget)}`;
      break;
    case 'envelope.remove': what = `removed envelope ${env(e.budget, e.envelope)}`; break;
    case 'budget.create': what = `created budget ${e.label}`; break;
    case 'category.define': what = `defined category ${e.label}`; break;
    case 'category.sinking':
      what = e.sinking
        ? `estimated ${cat(e.category)} at ${fmt(e.sinking.cost)} ${everyWords(e.sinking.everyYears)}`
        : `cleared the estimate on ${cat(e.category)}`;
      break;
    case 'account.balance': what = `noted account ${e.account} showed ${fmt(e.cents)} on ${shortDay(e.asOf)}`; break;
    case 'savings.account': what = e.account ? `chose account ${e.account} as Savings` : 'stopped keeping a savings account'; break;
    case 'txn.remove': what = 'removed a receipt from the ledger'; break;
    case 'budget.rename': what = `renamed budget ${e.budget} to ${e.label}`; break;
    case 'budget.locate':
      what = e.location ? `put ${budget(e.budget)} in ${e.location.label}` : `stopped tying ${budget(e.budget)} to a place`; break;
    case 'budget.archive': what = `${e.archived ? 'archived' : 'brought back'} budget ${budget(e.budget)}`; break;
    case 'category.archive': what = `${e.archived ? 'stopped using' : 'brought back'} category ${cat(e.category)}`; break;
    case 'month.close': what = `${e.closed ? 'closed' : 'reopened'} ${mon(e.month)} for ${budget(e.budget)}`; break;
    case 'month.discard': what = `discarded ${mon(e.month)} for ${budget(e.budget)}`; break;
    case 'income.source.define': what = `recorded income "${e.label}" for ${budget(e.budget)}`; break;
    case 'income.source.remove': what = `removed income ${e.source}`; break;
    case 'household.claim': what = `started the household ${e.label}`; break;
    case 'member.add': what = `shared the household with ${e.member}`; break;
    case 'member.remove': what = `removed ${e.member} from the household`; break;
    case 'briefing.read': what = 'read the briefing'; break;
    case 'prediction.record': what = `forecast ${env(e.budget, e.envelope)} in ${budget(e.budget)} for ${mon(e.month)}`; break;
    case 'thread.briefing': what = `wrote the briefing for ${e.budget ? budget(e.budget) : 'the household'}`; break;
    case 'thread.ask': what = `asked: ${e.question}`; break;
    case 'thread.note': what = `left a note: ${e.text}`; break;
    case 'thread.answer': what = 'answered a question'; break;
    case 'proposal.offer': what = `suggested: ${e.summary}`; break;
    case 'proposal.decide': what = `${e.decision === 'snoozed' ? 'put off' : e.decision} a suggestion`; break;
    case 'flag.seen': what = 'marked a change as seen'; break;
    case 'areas.set': what = `set the areas to ${e.areas.join(', ')}`; break;
    case 'areas.rename': what = `renamed the area ${e.from} to ${e.to}`; break;
    case 'links.set': what = 'set the links'; break;
    // Never what it says: it is how to get in, for a guest's confirmation.
    case 'guests.arrival': what = e.text.trim() ? 'updated the arrival note' : 'cleared the arrival note'; break;
    case 'household.zone': what = `set the household's time zone to ${e.zone}`; break;
    case 'guests.booking':
      what = `turned booking ${e.on ? 'on' : 'off'}${e.calendarGone ? ', because the Household calendar is gone' : ''}`; break;
    case 'envelopes.model': what = e.model ? `chose ${e.model} to suggest envelopes` : 'went back to the default model for envelopes'; break;
    case 'documents.folder': what = `chose ${e.team}/${e.folder} for the household's documents${e.source === 'deployment' ? ', carried over from the deployment' : ''}`; break;
    case 'documents.moved': {
      // A document gone or left alone carries no path, so it has no name to give.
      const name = 'plan' in e.file ? e.file.name : e.file.doc ? e.file.doc.path.slice(e.file.doc.path.lastIndexOf('/') + 1) : 'a document';
      what = e.gone ? `found ${name} gone, so there was nothing to move`
        : 'link' in e.file && !e.file.doc ? `left ${name} where Drive keeps it, outside the old folder`
        : `moved ${name} to the household's new folder`;
      break;
    }
    case 'calendar.household': what = e.replaces ? 'replaced the Household calendar' : `set up the ${e.name} calendar`; break;
    case 'calendar.household.rename': what = `renamed the Household calendar to ${e.name}`; break;
    case 'calendar.target': what = 'chose the calendar plans go on'; break;
    case 'calendar.conflicts': what = 'chose which calendars to check for conflicts'; break;
    case 'scheme.set':
      what = `chose the ${e.scheme.charAt(0).toUpperCase()}${e.scheme.slice(1)} scheme, ${e.mode === 'match' ? 'matching the device' : e.mode}`;
      break;
    // ─── plans ──────────────────────────────────────────────────────────────
    case 'plan.create': what = `made a plan: ${e.title}`; break;
    case 'plan.set': {
      const changed = ([
        ['title', e.title], ['area', e.area], ['chips', e.chips], ['notes', e.notes],
        ['estimate', e.estimate], ['envelope', e.envelope],
      ] as const).filter(([, v]) => v !== undefined).map(([k]) => k);
      const list = changed.length < 2 ? changed.join('') : `${changed.slice(0, -1).join(', ')} and ${changed.at(-1)}`;
      what = changed.length ? `changed the ${list} on ${plan(e.plan)}` : `touched ${plan(e.plan)}`;
      break;
    }
    case 'plan.state': what = `moved ${plan(e.plan)} to ${e.state}`; break;
    case 'plan.ask': what = `asked ${e.to} to take ${plan(e.plan)}`; break;
    case 'plan.ask.accept': what = `took on ${plan(e.plan)}`; break;
    case 'plan.ask.decline': what = `declined ${plan(e.plan)}`; break;
    case 'plan.checklist': what = `updated the checklist on ${plan(e.plan)}`; break;
    case 'plan.attach': what = `attached ${e.name} to ${plan(e.plan)}`; break;
    case 'plan.detach': what = `took ${e.path.split('/').pop() || e.path} off ${plan(e.plan)}`; break;
    case 'plan.contact.link': what = `linked ${e.display} to ${plan(e.plan)}`; break;
    case 'plan.contact.unlink': what = `unlinked a contact from ${plan(e.plan)}`; break;
    case 'plan.due': what = e.due ? `set ${plan(e.plan)} due ${e.due}` : `cleared the due date on ${plan(e.plan)}`; break;
    case 'plan.block': what = `set aside time for ${plan(e.plan)} on ${e.start.slice(0, 10)}`; break;
    case 'plan.unblock': what = `let go of time set aside for ${plan(e.plan)}`; break;
    case 'plan.remove': what = `removed ${plan(e.plan)}`; break;
    case 'plan.calendar.link': what = `put ${plan(e.plan)} on the calendar`; break;
    case 'plan.calendar.unlink': what = `took ${plan(e.plan)} off the calendar`; break;
    case 'plan.calendar.etag': what = `kept ${plan(e.plan)} in step with the calendar`; break;
    case 'plan.doc': what = `kept the page for ${plan(e.plan)} in Drive up to date`; break;
    case 'plan.page.drift': what = `noticed the page for ${plan(e.plan)} was changed in Drive`; break;
    case 'calendar.drift':
      what = e.theirs ? `noted the calendar moved ${plan(e.plan)}` : `noted ${plan(e.plan)} was deleted from the calendar`;
      break;
    case 'calendar.drift.resolve': {
      const page = state?.drifts.has(e.drift) ? undefined : state?.pageDrifts.get(e.drift);
      if (page) {
        const title = plan(page.plan);
        what = e.choice === 'plan' ? `took the change made in Drive to ${title}`
          : e.choice === 'calendar' ? `put the page for ${title} back as planned`
          : `left the page for ${title} as it was edited`;
        break;
      }
      const p = state?.drifts.get(e.drift);
      const title = p ? plan(p.plan) : 'the plan';
      what = e.choice === 'plan' ? `moved ${title} to match the calendar`
        : e.choice === 'calendar' ? `put ${title} back on the calendar as planned`
        : `kept ${title} as planned and let the calendar be`;
      break;
    }
    case 'calendar.appointment': what = `made an appointment: ${e.summary}`; break;
    case 'calendar.appointment.remove': what = `took an appointment off the calendar: ${e.summary}`; break;
    // ─── booking ────────────────────────────────────────────────────────────
    case 'guest.allow': what = `allowed guest ${e.name.trim()} (${e.email.trim().toLowerCase()})`; break;
    case 'guest.revoke': what = `took ${e.email.trim().toLowerCase()} off the guest list`; break;
    case 'booking.block': what = `kept ${dayRange(e.from, e.to)} for the household`; break;
    case 'booking.unblock': {
      const b = state?.stayBlocks.get(e.block);
      what = b ? `opened ${dayRange(b.from, b.to)} to guests again` : 'opened nights kept for the household to guests again';
      break;
    }
    case 'booking.confirm': {
      const name = state?.stays.get(e.id)?.name ?? state?.guests.get(e.email.trim().toLowerCase())?.name ?? e.email.trim().toLowerCase();
      const old = e.replaces !== undefined ? state?.stays.get(e.replaces) : undefined;
      what = `confirmed ${name} for ${dayRange(e.arrive, e.depart)}, ${e.headcount} ${e.headcount === 1 ? 'person' : 'people'}`
        + (e.replaces === undefined ? '' : old ? `, in place of ${dayRange(old.arrive, old.depart)}` : ', in place of the stay they had');
      break;
    }
    case 'booking.cancel': {
      const s = state?.stays.get(e.stay) ?? [...(state?.stays.values() ?? [])].find((x) => x.request === e.stay);
      // A request still waiting is withdrawn, not cancelled: nothing was confirmed.
      const waiting = !s && state?.thread.offers.get(e.stay)?.prompt.kind === 'booking';
      what = s ? `cancelled a stay: ${s.name}, ${dayRange(s.arrive, s.depart)}`
        : waiting ? (e.who.startsWith('guest:') ? 'withdrew a request' : 'cancelled a request')
        : 'cancelled a stay';
      break;
    }

    case 'booking.release': {
      const st = state?.stays.get(e.stay);
      what = st ? `took ${st.name}'s cancelled stay, ${dayRange(st.arrive, st.depart)}, off the calendar`
        : 'took a cancelled stay off the calendar';
      break;
    }
    case 'booking.suggest': {
      const email = e.email.trim().toLowerCase();
      what = `suggested ${dayRange(e.arrive, e.depart)} to ${state?.guests.get(email)?.name ?? email} instead`;
      break;
    }
    default: {
      // Exhaustive: an op added without a sentence fails to typecheck here,
      // rather than reaching the activity list as its raw name.
      const unhandled: never = e;
      what = (unhandled as Event).op;
    }
  }
  return { id: e.id, at: e.at, who: e.who, what, why };
}

/**
 * What a set of events would touch: which budget and month, and which
 * envelopes. Two cards touching the same envelope in the same month are the
 * same decision asked twice, and only one of them may stand.
 */
export function touches(events: readonly NewEvent[]): { budget: string | null; month: Month | null; envelopes: string[] } {
  let budget: string | null = null;
  let month: Month | null = null;
  const envelopes = new Set<string>();
  for (const e of events) {
    if ('budget' in e && typeof e.budget === 'string') budget ??= e.budget;
    if ('month' in e && typeof e.month === 'string') month ??= e.month;
    if (e.op === 'move') { envelopes.add(e.from); envelopes.add(e.to); }
    if (e.op === 'assign') envelopes.add(e.envelope);
  }
  return { budget, month, envelopes: [...envelopes] };
}

// ─── writes: these propose, they never apply ─────────────────────────────────

const moveMoney: Tool = {
  name: 'move_money',
  description:
    'Propose moving money between two envelopes in a month. Zero-sum, so the month total never ' +
    'changes and the original plan is untouched. Returns a proposal for approval — it does not ' +
    'move anything until committed. A reason is required.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      month: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      amountCents: { type: 'number', description: 'Whole cents. $96.00 is 9600.' },
      why: { type: 'string', description: 'One line. This is what gets read the next morning.' },
      onlyWhileShort: { type: 'boolean', description: 'Refuse unless the envelope moved to is still short, so a cover is not made twice.' },
    },
    required: ['budget', 'from', 'to', 'amountCents', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const month = resolveMonth(state, budget, args['month']);
    const from = str(args['from'], 'from');
    const to = str(args['to'], 'to');
    const amount = money(args['amountCents'], 'amountCents');
    const why = str(args['why'], 'why');

    if (from === to) throw new ToolError('cannot move money to the same envelope');
    if (amount <= 0) throw new ToolError('amount must be positive');

    const view = monthView(state, budget, month);
    if (!view) throw new ToolError(`${month} is not open for ${budget}`, 404);
    const src = view.envelopes.find((e) => e.envelope.id === from);
    const dst = view.envelopes.find((e) => e.envelope.id === to);
    if (!src || !dst) throw new ToolError('unknown envelope', 404);
    // A cover is made once: a second tap, or another member's, finds it no longer short.
    if (args['onlyWhileShort'] === true && dst.available >= 0) {
      throw new ToolError(`${dst.envelope.label} is no longer short`, 409);
    }

    const effects = [
      `${src.envelope.label}: ${fmtExact(src.available)} left becomes ${fmtExact(sub(src.available, amount))}`,
      `${dst.envelope.label}: ${fmtExact(dst.available)} left becomes ${fmtExact(add(dst.available, amount))}`,
      `${dst.envelope.label} was planned at ${fmtExact(dst.planned)} and would be funded at ${fmtExact(add(dst.funded, amount))}`,
    ];
    if (sub(src.available, amount) < 0) {
      effects.push(`Warning: this would push ${src.envelope.label} into overspend.`);
    }
    return ctx.proposals.put({
      tool: 'move_money',
      who: ctx.who,
      summary: `Move ${fmtExact(amount)} from ${src.envelope.label} to ${dst.envelope.label}`,
      effects,
      events: [{ op: 'move', budget, month, from, to, amount, why }],
    }, new Date(`${ctx.today}T00:00:00Z`).toISOString());
  },
};

const setAssignment: Tool = {
  name: 'set_assignment',
  description:
    'Propose changing what an envelope is funded at this month. Unlike a move this changes the ' +
    "month's total, so it must come out of what is left to assign. The month's original plan is " +
    'never overwritten — the change is recorded as an adjustment on top of it.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      month: { type: 'string' },
      envelope: { type: 'string' },
      toCents: { type: 'number' },
      why: { type: 'string' },
    },
    required: ['budget', 'envelope', 'toCents', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const month = resolveMonth(state, budget, args['month']);
    const envelope = str(args['envelope'], 'envelope');
    const to = money(args['toCents'], 'toCents');
    const why = str(args['why'], 'why');

    const view = monthView(state, budget, month);
    if (!view) throw new ToolError(`${month} is not open for ${budget}`, 404);
    const e = view.envelopes.find((x) => x.envelope.id === envelope);
    if (!e) throw new ToolError(`no envelope ${envelope}`, 404);

    const delta = sub(to, e.funded);
    const nextToAssign = sub(view.toAssign, delta);
    const effects = [
      `${e.envelope.label}: funded ${fmtExact(e.funded)} becomes ${fmtExact(to)}`,
      `Planned stays ${fmtExact(e.planned)} — the original is never rewritten`,
      `To assign: ${fmtExact(view.toAssign)} becomes ${fmtExact(nextToAssign)}`,
    ];
    if (Math.abs(nextToAssign) >= 100) {
      effects.push(nextToAssign > 0
        ? `This leaves ${fmtExact(nextToAssign)} unassigned — the month would stop balancing.`
        : `This assigns ${fmtExact(cents(-nextToAssign))} more than the income.`);
    }
    return ctx.proposals.put({
      tool: 'set_assignment',
      who: ctx.who,
      summary: `Set ${e.envelope.label} to ${fmtExact(to)}`,
      effects,
      // A figure set by hand is a figure: the flag and the source go, and the template stays.
      events: [
        { op: 'assign', budget, month, envelope, to, why },
        ...(e.envelope.needsFigure || e.envelope.source !== undefined
          ? [redefine(budget, e.envelope, { figure: { template: e.envelope.template } })] : []),
      ],
    }, new Date(`${ctx.today}T00:00:00Z`).toISOString());
  },
};

const categorizeTxn: Tool = {
  name: 'categorize_transactions',
  description:
    'Propose categories for transactions, optionally creating rules so the same merchant is ' +
    'never sorted twice. Categories are permanent facts about the ledger and apply to every ' +
    'budget at once — never propose an envelope here.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      assignments: {
        type: 'array',
        description: 'One entry per transaction.',
        items: {
          type: 'object',
          properties: {
            txnId: { type: 'string' },
            category: { type: 'string', description: 'A category id, or __transfer / __income, or __split to divide the receipt across several (then give parts).' },
            parts: {
              type: 'array',
              description: 'For __split only: at least two { category, amount } parts, amount in integer cents with the receipt\'s sign (spending is negative), adding up exactly to the receipt. A category appears once.',
              items: {
                type: 'object',
                properties: { category: { type: 'string' }, amount: { type: 'integer' } },
                required: ['category', 'amount'],
              },
            },
            alsoAddRuleMatching: { type: 'string', description: 'Optional payee substring to remember, at least 3 characters. With __split the rule means "always ask a person to divide".' },
            suggestedBy: { type: 'string', enum: ['claude'], description: 'Set only when a person is accepting an envelope Claude suggested.' },
          },
          required: ['txnId', 'category'],
        },
      },
    },
    required: ['assignments'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const raw = args['assignments'];
    if (!Array.isArray(raw) || raw.length === 0) throw new ToolError('assignments is required');

    const events: NewEvent[] = [];
    const effects: string[] = [];
    for (const item of raw as Record<string, unknown>[]) {
      const txnId = str(item['txnId'], 'txnId');
      const category = str(item['category'], 'category') as Assignment;
      const t = state.txns.get(txnId);
      if (!t) throw new ToolError(`no transaction ${txnId}`, 404);
      const known = (c: string) => !isSpend(c) || state.categories.has(c);
      const by = item['suggestedBy'];
      if (by !== undefined && by !== 'claude') throw new ToolError('suggestedBy can only be "claude"');
      const missing = (c: string) => new ToolError(`no category ${c} — categories are fixed, pick an existing one`);
      if (category === SPLIT) {
        // A split's amounts are a person's decision; there is nothing for Claude to have suggested.
        if (by) throw new ToolError('suggestedBy cannot be set on a split — its amounts are never Claude\'s');
        const rawParts = item['parts'];
        if (!Array.isArray(rawParts)) throw new ToolError('parts is required for a split');
        // Whole cents only: rounding a stray 6.5 would quietly move money, so checkParts refuses it instead.
        const parts: SplitPart[] = (rawParts as Record<string, unknown>[]).map((p) => {
          const n = num(p['amount'], 'a part\'s amount');
          return { category: str(p['category'], 'a part\'s category') as Assignment, amount: Number.isInteger(n) ? cents(n) : n as Cents };
        });
        const problem = splitProblem(parts, t.amount, state.categories, (c) => missing(c).message);
        if (problem) throw new ToolError(problem);
        events.push({ op: 'txn.split', txn: txnId, parts });
        // A second split replaces the first, so say so rather than pretending it is new.
        effects.push(`${t.date} ${t.payee} ${fmtExact(t.amount)} is ${t.split ? 'divided again' : 'split'}: ` +
          parts.map((p) => `${filedLabel(state, p.category)} ${fmtExact(cents(Math.abs(p.amount)))}`).join(', '));
      } else {
        if (!known(category)) throw missing(category);
        events.push({ op: 'txn.categorize', txn: txnId, category, manual: true, ...(by ? { suggestedBy: 'claude' as const } : {}) });
        // A categorize clears the parts, so a split receipt says that it is no longer one.
        effects.push(`${t.date} ${t.payee} ${fmtExact(t.amount)} ${t.split ? 'is no longer split; becomes' : 'becomes'} ${category}`);
      }

      const ruleMatch = item['alsoAddRuleMatching'];
      if (typeof ruleMatch === 'string' && ruleMatch.trim()) {
        const match = ruleMatch.trim();
        // The match need not be in this receipt's payee — a person may type a broader rule — so only
        // length is refused here; a clash with history is a warning on the card, not a refusal.
        let problem = ruleProblem(state, null, match, category);
        if (problem === 'a rule needs at least 3 characters') throw new ToolError(problem);
        // Re-using a rule's match must not hide a clash with history: scan as if no rule held it.
        const existing = problem === 'already a rule'
          ? state.rules.find((r) => r.match.trim().toLowerCase() === match.toLowerCase())
          : undefined;
        if (existing) problem = ruleProblem({ ...state, rules: [] }, null, match, category);
        const wouldMatch = [...state.txns.values()].filter((x) =>
          `${x.payee} ${x.memo ?? ''}`.toLowerCase().includes(match.toLowerCase())).length;
        events.push({ op: 'rule.add', rule: `r-${match.toLowerCase().replace(/\W+/g, '-')}`, match, category });
        const s = wouldMatch === 1 ? '' : 's';
        effects.push(category === SPLIT
          ? `Rule "${match}" would ask a person to divide ${wouldMatch} receipt${s} from now on`
          : `Rule "${match}" would cover ${wouldMatch} transaction${s} from now on`);
        if (existing) effects.push(`Replaces the rule "${existing.match}" → ${filedLabel(state, existing.category)}`);
        if (problem?.startsWith('already filed under ')) {
          const clash = [...state.txns.values()].filter((x) => x.category !== null && x.category !== category
            && `${x.payee} ${x.memo ?? ''}`.toLowerCase().includes(match.toLowerCase())).length;
          effects.push(`Rule "${match}" also matches ${clash} receipt${clash === 1 ? '' : 's'} filed elsewhere (${problem.slice('already filed under '.length)})`);
        }
      }
    }
    return ctx.proposals.put({
      tool: 'categorize_transactions',
      who: ctx.who,
      summary: `Categorize ${raw.length} transaction${raw.length === 1 ? '' : 's'}`,
      effects,
      events,
    }, new Date(`${ctx.today}T00:00:00Z`).toISOString());
  },
};

const openMonth: Tool = {
  name: 'open_month',
  description:
    "Propose opening a month, seeding every envelope from the budget's template, and each envelope saved " +
    'in Savings at what its goal needs that month. This writes ' +
    'the plan of record, which is then immutable — later changes are adjustments on top of it. ' +
    'The income comes from the recorded income sources by counting their actual paydays in that ' +
    'month, so a fortnightly salary opens a three-paycheque month at the right figure. Pass ' +
    'incomeCents only to override it — a bonus, or a month you already know is different.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      month: { type: 'string' },
      incomeCents: {
        type: 'number',
        description: 'Optional. Overrides what the recorded income sources say this month pays.',
      },
    },
    required: ['budget', 'month'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const month = str(args['month'], 'month');
    const b = state.budgets.get(budget);
    if (!b) throw new ToolError(`no budget ${budget}`, 404);
    if (state.months.has(monthKey(budget, month))) throw new ToolError(`${month} is already open for ${budget}`);

    /**
     * The income is counted, not carried forward.
     *
     * Reusing last month's figure is what makes a three-paycheque month open
     * short by a whole paycheque — the sources know which months those are, and
     * asking a person to remember is asking them to get it wrong twice a year.
     */
    const sources = sourcesFor(state, budget);
    const derived = incomeFor(sources, month);
    const override = args['incomeCents'] != null ? money(args['incomeCents'], 'incomeCents') : null;
    if (override === null && !sources.length) {
      throw new ToolError(
        `No income is recorded for ${b.label}, so there is nothing to open the month at. `
        + 'Record what comes in and how often, and the month will open at whatever that month '
        + 'actually pays.');
    }
    const income = override ?? derived.total;

    // A sinking envelope is proposed at what its goal needs this month, not
    // its template: the goal is the reason it exists. People may fund it
    // differently once the month is open, as they may any envelope.
    const sinking = sinkingPlan(state, budget, month);
    const planned = cents([...b.envelopes.values()].reduce((n, e) => n + (sinking.get(e.id) ?? e.template), 0));
    const clash = overlappingCategories(b);
    const seeded = b.envelopes.size - sinking.size;
    const effects = [
      sinking.size
        ? `${seeded} envelope${seeded === 1 ? '' : 's'} seeded from the ${b.label} template, ${sinking.size} from ${sinking.size === 1 ? 'its goal' : 'their goals'}`
        : `${b.envelopes.size} envelopes seeded from the ${b.label} template`,
      `Planned ${fmtExact(planned)} against income ${fmtExact(income)}`,
      `To assign would be ${fmtExact(sub(income, planned))}`,
    ];

    // Say where the number came from. A figure that appeared by itself is one
    // nobody checks, and this is the one worth checking.
    if (override !== null) {
      effects.push(sources.length
        ? `Using ${fmtExact(income)} rather than the ${fmtExact(derived.total)} the recorded income adds up to`
        : `Using ${fmtExact(income)} for this month only — no income is recorded for ${b.label}`);
    } else {
      for (const line of derived.lines.filter((l) => l.paydays.length)) {
        effects.push(`${line.source.label}: ${line.paydays.length} × ${fmtExact(line.source.amount)}`
          + ` on ${line.paydays.map((d) => d.slice(8)).join(', ')} = ${fmtExact(line.total)}`);
      }
      const extra = derived.lines.some((l) =>
        (l.source.frequency === 'biweekly' && l.paydays.length === 3)
        || (l.source.frequency === 'weekly' && l.paydays.length === 5));
      if (extra) effects.push('This is a month with an extra payday in it');
    }
    for (const [id, amount] of sinking) {
      effects.push(`${b.envelopes.get(id)!.label} planned at ${fmtExact(amount)}, what its goal needs this month`);
    }
    for (const [cat, envs] of clash) {
      effects.push(`Warning: category ${cat} is claimed by ${envs.join(' and ')} — spending would double count.`);
    }
    return ctx.proposals.put({
      tool: 'open_month',
      who: ctx.who,
      summary: `Open ${month} for ${b.label}`,
      effects,
      events: [{ op: 'month.open', budget, month, income, ...(sinking.size ? { plan: Object.fromEntries(sinking) } : {}) }],
    }, new Date(`${ctx.today}T00:00:00Z`).toISOString());
  },
};

// ─── registry ─────────────────────────────────────────────────────────────────

const restoreTxn: Tool = {
  name: 'restore_transaction',
  description:
    'Propose putting a deleted receipt back in the ledger, with the category it had. ' +
    'Use when someone deleted a transaction that should have gone into an envelope instead. ' +
    'Returns a proposal for approval — it does not restore anything on its own.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      txnId: { type: 'string', description: 'The receipt id, as shown in the activity entry.' },
      category: { type: 'string', description: 'Optional. The envelope category to give it on the way back in.' },
      why: { type: 'string', description: 'One line. Why it belongs in the ledger after all.' },
    },
    required: ['txnId', 'why'],
  },
  async run(args, ctx) {
    const state = ctx.store.state;
    const txnId = str(args['txnId'], 'txnId');
    const why = str(args['why'], 'why');
    if (state.txns.has(txnId)) throw new ToolError('that receipt is already in the ledger');

    const original = await removedTxn(ctx.store, txnId);
    if (!original) throw new ToolError(`no record of a receipt ${txnId}`, 404);

    const category = typeof args['category'] === 'string' && args['category']
      ? args['category'] as Assignment
      : original.category;
    if (category === SPLIT) throw new ToolError('restore it first, then split it');
    if (category !== null && isSpend(category) && !state.categories.has(category)) {
      throw new ToolError(`no category ${category}`);
    }

    // Same id, so putting it back cannot create a second copy of the receipt.
    const txn: Txn = { ...original, category };
    return ctx.proposals.put({
      tool: 'restore_transaction',
      who: ctx.who,
      summary: `Put back ${original.payee} ${fmtExact(original.amount)}`,
      effects: [
        `${original.date} ${original.payee} ${fmtExact(original.amount)} returns to the ledger`,
        category === null
          ? 'It will have no envelope until someone sorts it'
          : `It lands in ${category}`,
      ],
      events: [{ op: 'txn.add', txns: [txn], source: 'restored' }],
    }, ctx.today);
  },
};

// ─── shaping the budgets themselves ──────────────────────────────────────────

const createBudget: Tool = {
  name: 'create_budget',
  description:
    'Propose a new budget — another way of grouping the same categories into envelopes, ' +
    'priced for a different place or circumstance. It shares the household ledger; only the ' +
    'envelopes and their funding differ. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'What to call it, usually where it is for.' },
      copyFrom: { type: 'string', description: 'Optional. Start with another budget\'s envelopes.' },
    },
    required: ['label'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const label = str(args['label'], 'label');
    const id = slug(label);
    if (!id) throw new ToolError('that name has no letters or numbers in it');
    // Compare the name people actually see, not the slug. "Lakeside" already
    // existed under the id "lake", so a slug check waved the duplicate through.
    if (state.budgets.has(id)) throw new ToolError(`${label} already exists`);
    for (const b of state.budgets.values()) {
      if (b.label.toLowerCase() === label.toLowerCase()) throw new ToolError(`${label} already exists`);
    }

    const events: NewEvent[] = [{ op: 'budget.create', budget: id, label }];
    const effects = [`A new budget "${label}" over the same categories`];

    const from = typeof args['copyFrom'] === 'string' ? args['copyFrom'] : '';
    if (from) {
      const source = state.budgets.get(from);
      if (!source) throw new ToolError(`no budget ${from}`, 404);
      for (const env of source.envelopes.values()) {
        events.push(redefine(id, env));
      }
      effects.push(`${source.envelopes.size} envelopes copied from ${source.label}, `
        + 'which you can then price differently');
    }
    return ctx.proposals.put({
      tool: 'create_budget', who: ctx.who,
      summary: `Create the ${label} budget`, effects, events,
    }, ctx.today);
  },
};

const renameBudget: Tool = {
  name: 'rename_budget',
  description: 'Propose renaming a budget. The id and all its history stay as they are.',
  kind: 'write',
  input: {
    type: 'object',
    properties: { budget: { type: 'string' }, label: { type: 'string' } },
    required: ['budget', 'label'],
  },
  run(args, ctx) {
    const budget = str(args['budget'], 'budget');
    const label = str(args['label'], 'label');
    const b = ctx.store.state.budgets.get(budget);
    if (!b) throw new ToolError(`no budget ${budget}`, 404);
    return ctx.proposals.put({
      tool: 'rename_budget', who: ctx.who,
      summary: `Rename ${b.label} to ${label}`,
      effects: [`"${b.label}" becomes "${label}"`, 'Nothing else changes'],
      events: [{ op: 'budget.rename', budget, label }],
    }, ctx.today);
  },
};

const archiveBudget: Tool = {
  name: 'archive_budget',
  description:
    'Propose putting a budget away, or bringing it back. Archiving hides it without ' +
    'destroying anything — its months and moves stay in the log and stay answerable. ' +
    'There is no way to delete a budget, and that is deliberate.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      archived: { type: 'boolean', description: 'false brings it back' },
      why: { type: 'string', description: 'One line. Read the next time someone wonders where it went.' },
    },
    required: ['budget', 'archived', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const why = str(args['why'], 'why');
    const archived = args['archived'] !== false;
    const b = state.budgets.get(budget);
    if (!b) throw new ToolError(`no budget ${budget}`, 404);

    const months = [...state.months.values()].filter((m) => m.budget === budget).length;
    const live = [...state.budgets.values()].filter((x) => !x.archived && x.id !== budget).length;
    if (archived && live === 0) throw new ToolError('that is the only budget left');

    return ctx.proposals.put({
      tool: 'archive_budget', who: ctx.who,
      summary: archived ? `Archive ${b.label}` : `Bring ${b.label} back`,
      effects: archived
        ? [`${b.label} disappears from the switcher`,
           `Its ${months} month${months === 1 ? '' : 's'} of history stay in the log and stay readable`,
           'Nothing is deleted, and you can bring it back']
        : [`${b.label} returns to the switcher`],
      events: [{ op: 'budget.archive', budget, archived, why }],
    }, ctx.today);
  },
};

const defineEnvelope: Tool = {
  name: 'define_envelope',
  description:
    'Propose adding an envelope, or changing one — its name, which categories feed it, ' +
    'or what the template funds it at. Changing an envelope changes only this budget\'s ' +
    'reading of the ledger; the receipts underneath are untouched.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      envelope: { type: 'string', description: 'The id. A new one creates; an existing one edits.' },
      label: { type: 'string' },
      group: { type: 'string', description: 'The group it shows under, e.g. Home or Food' },
      categories: { type: 'array', items: { type: 'string' }, description: 'Which categories feed it.' },
      templateCents: {
        type: 'number',
        description: 'What a new month opens it at. Leaving it out keeps the figure the envelope has; a new envelope then starts with no figure.',
      },
      rollover: { type: 'boolean' },
    },
    required: ['budget', 'envelope', 'label', 'categories'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const b = state.budgets.get(budget);
    if (!b) throw new ToolError(`no budget ${budget}`, 404);

    const id = str(args['envelope'], 'envelope');
    const label = str(args['label'], 'label');
    const raw = args['categories'];
    if (!Array.isArray(raw) || raw.length === 0) throw new ToolError('an envelope needs at least one category');
    const categories = raw.map((c) => String(c));
    for (const c of categories) {
      if (!state.categories.has(c)) throw new ToolError(`no category ${c} — categories are shared and fixed`);
    }
    // Two envelopes claiming a category would make a receipt land in whichever
    // was defined last, silently.
    for (const other of b.envelopes.values()) {
      if (other.id === id) continue;
      const clash = categories.find((c) => other.match.categories.includes(c));
      if (clash) throw new ToolError(`${clash} already feeds ${other.label} in this budget`);
    }

    const existing = b.envelopes.get(id);
    const given = args['templateCents'] === undefined || args['templateCents'] === null
      ? null : money(args['templateCents'], 'templateCents');
    if (given !== null && given < 0) throw new ToolError('a figure is not less than nothing');
    const group = typeof args['group'] === 'string' && args['group'] ? args['group'] : existing?.group ?? 'People';
    const rollover = typeof args['rollover'] === 'boolean' ? args['rollover'] : existing?.rollover ?? true;
    const match = { categories };

    // With a template the define is a figure (flag and source go); without one an existing
    // envelope keeps all three, and a new one starts at nothing, flagged as having no figure.
    const event: NewEvent = existing
      ? redefine(budget, existing, { label, group, match, rollover, ...(given !== null ? { figure: { template: given } } : {}) })
      : {
        op: 'envelope.define', budget, envelope: id, label, group, match,
        template: given ?? cents(0), rollover, order: b.envelopes.size,
        ...(given === null ? { needsFigure: true as const } : {}),
      };
    const figureWords = given !== null ? `funded at ${fmtExact(given)} a month`
      : existing ? (existing.needsFigure ? 'still with no figure' : `funded at ${fmtExact(existing.template)} a month`)
      : 'with no figure yet';

    return ctx.proposals.put({
      tool: 'define_envelope', who: ctx.who,
      summary: existing ? `Update ${existing.label}` : `Add the ${label} envelope`,
      effects: [
        existing
          ? `${existing.label} becomes "${label}", ${figureWords}`
          : `A new envelope "${label}" in ${group}, ${figureWords}`,
        `Fed by ${categories.join(', ')}`,
        // The plan of record is a snapshot; changing the template cannot reach
        // back into a month that has already opened.
        'Months already open keep the plan they opened with',
      ],
      events: [event],
    }, ctx.today);
  },
};

/** An estimate as a caller gives it: null or no cost clears it. */
function estimateArg(x: unknown, env: Envelope): { category: string; sinking: SinkingEstimate | null } {
  const e = x as { category?: unknown; costCents?: unknown; everyYears?: unknown } | null;
  const category = str(e?.category, 'each estimate\'s category');
  if (!env.match.categories.includes(category)) throw new ToolError(`${category} does not feed ${env.label}`);
  if (e?.costCents == null || num(e.costCents, 'costCents') === 0) return { category, sinking: null };
  const cost = money(e.costCents, 'costCents');
  if (cost < 0) throw new ToolError('an estimate costs something, not less than nothing');
  const everyYears = num(e.everyYears, 'everyYears');
  if (everyYears <= 0 || everyYears > 100) throw new ToolError('how often it comes round is more than none and at most every 100 years');
  return { category, sinking: { cost, everyYears } };
}

const setSinkingGoal: Tool = {
  name: 'set_sinking_goal',
  description:
    'Propose saving an envelope in Savings toward a goal, changing its goal, or making it an ordinary envelope ' +
    "again. Goal 'every': every so often, set aside from its categories' estimates, each a cost and how many years " +
    "until it comes round (tyres $1,200 every 4 years is $25 a month); the estimates belong to the categories, so " +
    "every budget derives the same figure, and any given here are set or changed (costCents null clears one). Goal " +
    "'by': a target by a month (targetCents, by YYYY-MM), set aside as what is left over the months left. Such an " +
    'envelope always rolls over, and each new month is planned at what its goal needs. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      envelope: { type: 'string' },
      goal: { type: 'string', enum: ['every', 'by', 'none'] },
      targetCents: { type: 'number', description: "For 'by': what to have saved." },
      by: { type: 'string', description: "For 'by': the month to have it by, YYYY-MM." },
      estimates: {
        type: 'array',
        description: "For 'every': estimates to set on its categories.",
        items: {
          type: 'object',
          properties: {
            category: { type: 'string' },
            costCents: { type: ['number', 'null'] },
            everyYears: { type: 'number' },
          },
          required: ['category'],
        },
      },
    },
    required: ['budget', 'envelope', 'goal'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const b = state.budgets.get(budget);
    const env = b?.envelopes.get(str(args['envelope'], 'envelope'));
    if (!b || !env) throw new ToolError(`no envelope ${String(args['envelope'])} in ${budget}`, 404);
    const kind = args['goal'];
    if (kind !== 'every' && kind !== 'by' && kind !== 'none') throw new ToolError("goal is 'every', 'by' or 'none'");
    // This month if it is open, else the latest that is: what the goal is worked out against.
    const month = state.months.has(monthKey(budget, monthOf(ctx.today))) ? monthOf(ctx.today)
      : latestMonth(state, budget) ?? monthOf(ctx.today);

    let goal: SinkingGoal | null = null;
    if (kind === 'by') {
      const target = money(args['targetCents'], 'targetCents');
      if (target <= 0) throw new ToolError('a goal by a date needs a target');
      const by = str(args['by'], 'by');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(by)) throw new ToolError('by is a month, YYYY-MM');
      if (by < month) throw new ToolError(`${monthName(by)} has already gone by`);
      goal = { kind: 'by', target, by };
    } else if (kind === 'every') goal = { kind: 'every' };
    const raw = args['estimates'];
    if (raw !== undefined && !Array.isArray(raw)) throw new ToolError('estimates must be a list');
    if (raw?.length && kind !== 'every') throw new ToolError("estimates are for a goal of 'every'");
    const asked = (raw ?? []).map((x) => estimateArg(x, env));

    const events: NewEvent[] = [];
    if (JSON.stringify(goal ?? null) !== JSON.stringify(env.sinking ?? null)) {
      events.push(redefine(budget, env, { sinking: goal }));
    }
    const after = new Map(env.match.categories.map((c) => [c, state.categories.get(c)?.sinking ?? null]));
    for (const a of asked) {
      if (JSON.stringify(a.sinking) === JSON.stringify(after.get(a.category))) continue;
      after.set(a.category, a.sinking);
      events.push({ op: 'category.sinking', category: a.category, sinking: a.sinking });
    }
    if (!events.length) throw new ToolError('nothing would change');

    const label = (c: string) => state.categories.get(c)?.label ?? c;
    const effects: string[] = [];
    if (!goal) {
      effects.push(`${env.label} becomes an ordinary envelope; what it holds stays in it`);
    } else if (goal.kind === 'every') {
      const known = [...after.values()].filter((x): x is SinkingEstimate => x !== null);
      const total = cents(known.reduce((n, e) => n + e.cost, 0));
      effects.push(`${env.label} is saved in Savings: ${fmtExact(everyMonthly(known))} a month, toward ${fmtExact(total)} of estimates`);
      for (const [c, e] of after) {
        effects.push(e ? `${label(c)}: ${fmtExact(e.cost)} ${everyWords(e.everyYears)}, ${fmtExact(everyMonthly([e]))} a month`
          : `${label(c)}: no estimate, so nothing is set aside for it`);
      }
    } else {
      const saved = carriedInto(state, budget, month, env.id);
      const { monthly, monthsLeft } = byMonthly(goal.target, saved, month, goal.by);
      effects.push(`${env.label} is saved in Savings: ${fmtExact(goal.target)} by ${monthName(goal.by)}`,
        `${fmtExact(monthly)} a month, over ${monthsLeft} month${monthsLeft === 1 ? '' : 's'} from ${monthName(month)}, worked out again each month`);
    }
    if (goal) effects.push('It always rolls over', 'Months already open keep their plan; the next one opens at what the goal needs');

    return ctx.proposals.put({
      tool: 'set_sinking_goal', who: ctx.who,
      summary: !goal ? `Stop saving ${env.label} in Savings`
        : env.sinking ? `Change ${env.label}'s goal` : `Save ${env.label} in Savings`,
      effects, events,
    }, ctx.today);
  },
};

const removeEnvelope: Tool = {
  name: 'remove_envelope',
  description:
    'Propose removing an envelope from a budget. Its receipts are not deleted — they stop ' +
    'belonging to any envelope, which means they stop being accounted for. The proposal says ' +
    'how many and how much. Requires a reason.',
  kind: 'write',
  input: {
    type: 'object',
    properties: { budget: { type: 'string' }, envelope: { type: 'string' }, why: { type: 'string' } },
    required: ['budget', 'envelope', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const envelope = str(args['envelope'], 'envelope');
    const why = str(args['why'], 'why');
    const b = state.budgets.get(budget);
    const env = b?.envelopes.get(envelope);
    if (!b || !env) throw new ToolError(`no envelope ${envelope} in ${budget}`, 404);

    // What stops being accounted for. This is the number that matters, and it
    // is the reason this is a proposal rather than a button.
    // A split receipt counts once, however many of its parts were in here.
    let orphaned = 0;
    let total = ZERO;
    for (const t of state.txns.values()) {
      const here = partsOf(t).filter((p) => isSpend(p.category) && env.match.categories.includes(p.category));
      if (!here.length) continue;
      orphaned++;
      for (const p of here) total = add(total, cents(Math.abs(p.amount)));
    }

    return ctx.proposals.put({
      tool: 'remove_envelope', who: ctx.who,
      summary: `Remove ${env.label} from ${b.label}`,
      effects: [
        `${env.label} disappears from ${b.label}`,
        orphaned
          ? `${orphaned} receipts totalling ${fmtExact(total)} stop belonging to any envelope in this budget`
          : 'No receipts are affected',
        'The receipts themselves are untouched, and other budgets are unaffected',
      ],
      events: [{ op: 'envelope.remove', budget, envelope, why }],
    }, ctx.today);
  },
};

const defineCategory: Tool = {
  name: 'define_category',
  description:
    'Propose adding a category, or renaming one. Categories are household facts shared by every ' +
    'budget — a receipt is groceries whichever budget is reading it — so this changes what things ' +
    'are called everywhere at once. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'The id. A new one creates; an existing one renames.' },
      label: { type: 'string' },
      kind: { type: 'string', description: 'House | People | Future' },
    },
    required: ['category', 'label'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const id = slug(str(args['category'], 'category'));
    if (!id) throw new ToolError('that id has no letters or numbers in it');
    const label = str(args['label'], 'label');
    const existing = state.categories.get(id);
    const kind = typeof args['kind'] === 'string' && args['kind'] ? args['kind'] : existing?.kind ?? 'People';

    for (const c of state.categories.values()) {
      if (c.id !== id && c.label.toLowerCase() === label.toLowerCase()) {
        throw new ToolError(`${label} already exists`);
      }
    }
    return ctx.proposals.put({
      tool: 'define_category', who: ctx.who,
      summary: existing ? `Rename ${existing.label} to ${label}` : `Add the ${label} category`,
      effects: existing
        ? [`"${existing.label}" becomes "${label}" in every budget`,
           'Receipts already in it are unaffected — only the name changes']
        : [`A new category "${label}" under ${kind}`,
           'It belongs to no envelope yet, so put it in one before spending lands in it'],
      // A rename keeps the estimate: category.define replaces the category whole.
      events: [{ op: 'category.define', category: id, label, kind, ...(existing?.sinking ? { sinking: existing.sinking } : {}) }],
    }, ctx.today);
  },
};

const archiveCategory: Tool = {
  name: 'archive_category',
  description:
    'Propose taking a category out of use, or bringing it back. Archiving hides it from the ' +
    'pickers without unmaking it, because receipts name their category and one that cannot be ' +
    'resolved is worse than one nobody uses. There is no way to delete a category.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      category: { type: 'string' },
      archived: { type: 'boolean', description: 'false brings it back' },
      why: { type: 'string' },
    },
    required: ['category', 'archived', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const id = str(args['category'], 'category');
    const why = str(args['why'], 'why');
    const archived = args['archived'] !== false;
    const c = state.categories.get(id);
    if (!c) throw new ToolError(`no category ${id}`, 404);

    const held = [...state.txns.values()].filter((t) => partsOf(t).some((p) => p.category === id)).length;
    const envelopes = [...state.budgets.values()]
      .flatMap((b) => [...b.envelopes.values()].filter((e) => e.match.categories.includes(id))
        .map((e) => `${e.label} in ${b.label}`));

    return ctx.proposals.put({
      tool: 'archive_category', who: ctx.who,
      summary: archived ? `Stop using ${c.label}` : `Start using ${c.label} again`,
      effects: archived
        ? [`${c.label} disappears from the pickers`,
           held ? `${held} receipts stay in it and still read as ${c.label}` : 'No receipts are in it',
           envelopes.length
             ? `Still fed into: ${envelopes.join(', ')} — remove it there if you want it gone from the plan`
             : 'It is not in any envelope']
        : [`${c.label} is available again`],
      events: [{ op: 'category.archive', category: id, archived, why }],
    }, ctx.today);
  },
};

const closeMonth: Tool = {
  name: 'close_month',
  description:
    'Propose finishing a month, or reopening one. A closed month takes no more assignments, ' +
    'moves or income changes — its plan and what happened to it become history. Carry-over ' +
    'still flows out of it. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      month: { type: 'string' },
      closed: { type: 'boolean', description: 'false reopens it' },
      why: { type: 'string' },
    },
    required: ['budget', 'month', 'closed', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const month = str(args['month'], 'month');
    const why = str(args['why'], 'why');
    const closed = args['closed'] !== false;
    const plan = state.months.get(monthKey(budget, month));
    if (!plan) throw new ToolError(`${month} is not open for ${budget}`, 404);
    if (!!plan.closed === closed) {
      throw new ToolError(closed ? 'that month is already closed' : 'that month is already open');
    }

    const view = monthView(state, budget, month);
    const unsorted = [...state.txns.values()]
      .filter((t) => t.category === null && monthOf(t.date) === month).length;

    return ctx.proposals.put({
      tool: 'close_month', who: ctx.who,
      summary: closed ? `Close ${month}` : `Reopen ${month}`,
      effects: closed
        ? [`${month} takes no more assignments, moves or income changes`,
           view ? `It finishes with ${fmtExact(view.activity)} spent and ${fmtExact(view.toAssign)} unassigned` : '',
           unsorted ? `${unsorted} receipts in it still have no envelope — sort them first if you want them counted`
                    : 'Every receipt in it has an envelope',
           'Whatever is left still carries into next month',
          ].filter(Boolean)
        : [`${month} can be changed again`],
      events: [{ op: 'month.close', budget, month, closed, why }],
    }, ctx.today);
  },
};

const discardMonth: Tool = {
  name: 'discard_month',
  description:
    'Propose undoing the opening of a month that should never have been opened. Only possible ' +
    'while nothing has happened in it — no receipts against it, no adjustments. A month that ' +
    'has been used is closed, not discarded.',
  kind: 'write',
  input: {
    type: 'object',
    properties: { budget: { type: 'string' }, month: { type: 'string' }, why: { type: 'string' } },
    required: ['budget', 'month', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const month = str(args['month'], 'month');
    const why = str(args['why'], 'why');
    const plan = state.months.get(monthKey(budget, month));
    if (!plan) throw new ToolError(`${month} is not open for ${budget}`, 404);
    if (plan.adjustments.length) {
      throw new ToolError(`${month} has been adjusted ${plan.adjustments.length} times — close it instead`);
    }

    // Deliberately not a spending check. Receipts are shared by every budget, so
    // a freshly opened month in a second budget already "has spending against
    // it" — the same receipts the first reads. What makes a month lived in is what was
    // decided in it, and that is the adjustments above.
    const later = [...state.months.values()]
      .filter((m) => m.budget === budget && m.month > month).map((m) => m.month);
    if (later.length) {
      // A later month may be carrying a balance out of this one.
      throw new ToolError(`${later.join(', ')} come after it — discard those first`);
    }

    return ctx.proposals.put({
      tool: 'discard_month', who: ctx.who,
      summary: `Discard ${month}`,
      effects: [
        `${month} stops being open for ${budget}, as though it had never been opened`,
        'No money was assigned or moved in it, so no decision is lost',
        'Every receipt stays exactly where it is — other budgets still read them',
        'The record that it was opened, and discarded, stays in the log',
      ],
      events: [{ op: 'month.discard', budget, month, why }],
    }, ctx.today);
  },
};

// ─── income ──────────────────────────────────────────────────────────────────

const FREQ = ['monthly', 'semimonthly', 'biweekly', 'weekly', 'annual', 'once'] as const;

const planIncome: Tool = {
  name: 'plan_income',
  description:
    'What income a budget expects over the coming months, and what a change would do. Pass ' +
    '`imagine` to add a hypothetical job or raise without recording anything — this is a ' +
    'calculation, not a change, and it writes nothing. Counts real paydays, so a fortnightly ' +
    'salary shows the months that carry a third paycheque.',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      from: { type: 'string', description: 'YYYY-MM. Defaults to this month.' },
      months: { type: 'number', description: 'How far ahead. Default 6.' },
      imagine: {
        type: 'array',
        description: 'Hypothetical incomes to add on top. Nothing here is recorded.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            earner: { type: 'string' },
            amountCents: { type: 'number', description: 'What arrives each payday, not a monthly figure.' },
            frequency: { type: 'string', enum: [...FREQ] },
            anchor: { type: 'string', description: 'YYYY-MM-DD of a real payday.' },
            until: { type: 'string' },
          },
          required: ['label', 'amountCents', 'frequency', 'anchor'],
        },
      },
    },
    required: ['budget'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    if (!state.budgets.has(budget)) throw new ToolError(`no budget ${budget}`, 404);
    const from = typeof args['from'] === 'string' && args['from'] ? args['from'] : monthOf(ctx.today);
    const howMany = Math.min(24, Math.max(1, Number(args['months'] ?? 6)));

    const real = sourcesFor(state, budget);
    const imagined: IncomeSource[] = (Array.isArray(args['imagine']) ? args['imagine'] : [])
      .map((raw, i) => {
        const r = raw as Record<string, unknown>;
        const frequency = str(r['frequency'], 'frequency');
        if (!(FREQ as readonly string[]).includes(frequency)) throw new ToolError(`unknown frequency ${frequency}`);
        return {
          id: `imagined-${i}`, budget, label: str(r['label'], 'label'),
          who: typeof r['earner'] === 'string' && r['earner'] ? r['earner'] : ctx.who,
          amount: money(r['amountCents'], 'amountCents'),
          frequency: frequency as IncomeSource['frequency'],
          anchor: str(r['anchor'], 'anchor'),
          ...(typeof r['until'] === 'string' && r['until'] ? { until: r['until'] } : {}),
        };
      });

    const now = project(real, from, howMany);
    const withIt = imagined.length ? project([...real, ...imagined], from, howMany) : null;

    // What the plan costs, so the projection can answer "does this cover it"
    // rather than only "how much comes in".
    const b = state.budgets.get(budget)!;
    const planned = [...b.envelopes.values()].reduce((n, e) => add(n, e.template), ZERO);

    return {
      budget, from, months: howMany,
      plannedEachMonth: fmt(planned),
      recorded: real.map((s) => ({
        id: s.id, label: s.label, earner: s.who, frequency: s.frequency,
        eachPayday: fmt(s.amount), anchor: s.anchor, ...(s.until ? { until: s.until } : {}),
      })),
      projection: now.map((m, i) => {
        const scenario = withIt?.[i];
        return {
          month: m.month,
          income: fmt(m.total),
          coversThePlan: m.total >= planned,
          shortBy: m.total >= planned ? null : fmt(cents(planned - m.total)),
          thirdPaydayMonth: m.extraPayday,
          paidBy: m.lines.map((l) => `${l.label}: ${l.paydays} × ${fmt(cents(l.total / l.paydays))} = ${fmt(l.total)}`),
          ...(scenario ? {
            ifImagined: fmt(scenario.total),
            // From the scenario, not the recorded sources. A fortnightly job
            // that has not been recorded yet is exactly the thing whose third
            // paycheque you are trying to see.
            ifImaginedThirdPaydayMonth: scenario.extraPayday,
            ifImaginedCoversThePlan: scenario.total >= planned,
            ifImaginedSpare: scenario.total >= planned ? fmt(cents(scenario.total - planned)) : null,
          } : {}),
        };
      }),
    };
  },
};

const defineIncome: Tool = {
  name: 'define_income_source',
  description:
    'Propose recording an income — a salary or any regular payment — as part of a budget\'s plan. ' +
    'Give what arrives each payday and how often, never a monthly equivalent: dividing a ' +
    'fortnightly wage by twelve loses the months that carry a third payment.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      label: { type: 'string' },
      earner: { type: 'string', description: 'Whose income it is.' },
      amountCents: { type: 'number', description: 'What arrives each payday.' },
      frequency: { type: 'string', enum: [...FREQ] },
      anchor: { type: 'string', description: 'YYYY-MM-DD of a real payday.' },
      until: { type: 'string', description: 'Optional YYYY-MM, when it is known to stop.' },
    },
    required: ['budget', 'label', 'amountCents', 'frequency', 'anchor'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    if (!state.budgets.has(budget)) throw new ToolError(`no budget ${budget}`, 404);
    const label = str(args['label'], 'label');
    const frequency = str(args['frequency'], 'frequency');
    if (!(FREQ as readonly string[]).includes(frequency)) throw new ToolError(`unknown frequency ${frequency}`);
    const anchor = str(args['anchor'], 'anchor');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new ToolError('anchor must be a date, YYYY-MM-DD');
    const amount = money(args['amountCents'], 'amountCents');
    if (amount <= 0) throw new ToolError('an income has to be positive');

    const earner = typeof args['earner'] === 'string' && args['earner'] ? args['earner'] : ctx.who;
    const id = `inc-${slug(label)}-${anchor}`;
    const source: IncomeSource = {
      id, budget, label, who: earner, amount,
      frequency: frequency as IncomeSource['frequency'], anchor,
      ...(typeof args['until'] === 'string' && args['until'] ? { until: args['until'] } : {}),
    };

    // Show the next few months rather than a monthly average, because that is
    // the difference this records and the reason it is recorded this way.
    const ahead = project([source], monthOf(ctx.today), 4);
    return ctx.proposals.put({
      tool: 'define_income_source', who: ctx.who,
      summary: `Record ${label}`,
      effects: [
        `${fmtExact(amount)} ${frequency}, first counted from ${anchor}`,
        ...ahead.map((m) => `${m.month}: ${m.lines[0]?.paydays ?? 0} payday(s), ${fmtExact(m.total)}`
          + (m.extraPayday ? '  ← a third paycheque lands this month' : '')),
      ],
      events: [{
        op: 'income.source.define', source: id, budget, label, earner, amount,
        frequency: frequency as IncomeSource['frequency'], anchor,
        ...(source.until ? { until: source.until } : {}),
      }],
    }, ctx.today);
  },
};

const removeIncome: Tool = {
  name: 'remove_income_source',
  description:
    'Propose removing a recorded income — a job that ended, or one entered by mistake. ' +
    'Months already open keep the income they opened with, so this changes what is expected ' +
    'from here on rather than rewriting the past. Requires a reason.',
  kind: 'write',
  input: {
    type: 'object',
    properties: { source: { type: 'string' }, why: { type: 'string' } },
    required: ['source', 'why'],
  },
  run(args, ctx) {
    const id = str(args['source'], 'source');
    const why = str(args['why'], 'why');
    const s = ctx.store.state.incomeSources.get(id);
    if (!s) throw new ToolError(`no income source ${id}`, 404);
    return ctx.proposals.put({
      tool: 'remove_income_source', who: ctx.who,
      summary: `Remove ${s.label}`,
      effects: [
        `${s.label} stops counting towards what ${s.budget} expects`,
        'Months already open keep the income they opened with',
      ],
      events: [{ op: 'income.source.remove', source: id, why }],
    }, ctx.today);
  },
};

const locateBudget: Tool = {
  name: 'set_budget_location',
  description:
    'Propose recording where a budget is for. A budget differs from another because it is somewhere ' +
    'else — that is why electricity and property tax are priced separately while groceries are not. ' +
    'Recording the place also makes public cost data addressable. Pass location as null for a budget ' +
    'that is a period rather than a place.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      label: { type: 'string', description: 'The place, e.g. "Springfield, IL". Omit to clear the location.' },
      state: { type: 'string', description: 'Two-letter state code.' },
      postal: { type: 'string', description: 'ZIP — what rent indices are keyed on.' },
      stateFips: { type: 'string', description: 'Census state FIPS, e.g. 35 for New Mexico.' },
      countyFips: { type: 'string', description: 'Census county FIPS, e.g. 043 for Sandoval.' },
      why: { type: 'string' },
    },
    required: ['budget', 'why'],
  },
  async run(args, ctx) {
    const budget = str(args['budget'], 'budget');
    const why = str(args['why'], 'why');
    const b = ctx.store.state.budgets.get(budget);
    if (!b) throw new ToolError(`no budget ${budget}`, 404);

    const label = typeof args['label'] === 'string' ? args['label'].trim() : '';
    let location: BudgetLocation | null = label ? {
      label,
      ...(args['state'] ? { state: String(args['state']).toUpperCase() } : {}),
      ...(args['postal'] ? { postal: String(args['postal']).trim() } : {}),
      ...(args['stateFips'] ? { stateFips: String(args['stateFips']) } : {}),
      ...(args['countyFips'] ? { countyFips: String(args['countyFips']) } : {}),
    } : null;

    // The state and county come from the ZIP. Nobody knows their Census codes,
    // and without a state the electricity figure could never be reached. A code
    // typed by hand is kept; only what is missing is looked up.
    const found: string[] = [];
    if (location?.postal && (!location.state || !location.stateFips || !location.countyFips)) {
      const postal = location.postal;
      try {
        const place = await placeForZip(postal);
        if (place) {
          location = {
            ...location,
            state: location.state ?? place.state,
            stateFips: location.stateFips ?? place.stateFips,
            ...(location.countyFips ? {} : { countyFips: place.countyFips, county: place.county }),
          };
          found.push(place.share < 1
            ? `ZIP ${postal} is mostly in ${place.county}, ${place.state} (${Math.round(place.share * 100)}% of its land); `
              + `it also reaches ${place.others.join(', ')}`
            : `ZIP ${postal} is in ${place.county}, ${place.state}`);
        } else {
          found.push(`ZIP ${postal} is not in the Census ZIP-to-county file — a PO-box ZIP has no area `
            + 'of its own — so state and county figures cannot be looked up unless the codes are entered');
        }
      } catch (err) {
        found.push(`Could not reach the Census to find which county ZIP ${postal} is in `
          + `(${(err as Error).message}); the place is recorded without it`);
      }
    }

    return ctx.proposals.put({
      tool: 'set_budget_location', who: ctx.who,
      summary: location ? `Put ${b.label} in ${location.label}` : `Clear ${b.label}'s location`,
      effects: location
        ? [`${b.label} is a budget for ${location.label}`,
           ...found,
           location.postal ? `Rent data can be looked up for ZIP ${location.postal}`
                           : 'No ZIP recorded, so rent data cannot be looked up',
           location.countyFips ? 'County recorded, so Census figures can be looked up'
                               : 'No county recorded, so Census figures cannot be looked up',
           location.state ? `State recorded, so the electricity figure for ${location.state} can be looked up`
                          : 'No state recorded, so the electricity figure cannot be looked up']
        : [`${b.label} stops being tied to a place`,
           'Right for a budget that is a period rather than a location'],
      events: [{ op: 'budget.locate', budget, location, why }],
    }, ctx.today);
  },
};

const localCosts: Tool = {
  name: 'look_up_local_costs',
  description:
    'What public data says things cost where a budget is. Reads Zillow\'s rent index and, when a ' +
    'Census key is configured, county figures for rent and property tax. Every figure comes back ' +
    'with its source, the area it was measured over, when, and what it cannot tell you. These are ' +
    'measurements of a place, never a prediction about this household — read them as evidence.',
  kind: 'read',
  async run(args, ctx) {
    const budget = str(args['budget'], 'budget');
    const b = ctx.store.state.budgets.get(budget);
    if (!b) throw new ToolError(`no budget ${budget}`, 404);
    if (!b.location) {
      throw new ToolError(`${b.label} has no location recorded, so there is nowhere to look up`);
    }
    const found = await lookUp(b.location, {
      censusKey: resolvedEnv()['CENSUS_API_KEY'], eiaKey: resolvedEnv()['EIA_API_KEY'],
    });
    return {
      budget, location: b.location.label,
      found: found.estimates.map((e) => ({
        category: e.category,
        label: e.label,
        monthly: fmt(e.monthly),
        monthlyCents: e.monthly,
        source: e.source,
        measuredOver: e.measuredOver,
        asOf: e.asOf,
        caveat: e.caveat,
      })),
      // Named rather than dropped: knowing a source has nothing for a rural ZIP
      // is worth reading, and stops silence being mistaken for zero.
      couldNotFind: found.missing,
    };
  },
  input: {
    type: 'object',
    properties: { budget: { type: 'string' } },
    required: ['budget'],
  },
};

const seedFromLocation: Tool = {
  name: 'seed_from_location',
  description:
    'Propose starting figures for the envelopes that public data can speak to, using the ' +
    'budget\'s location. Covers only what is actually measured — rent, and property tax where a ' +
    'Census key is configured — so it is a starting point for a few place-bound envelopes, not a ' +
    'budget. Every figure comes with its source. Nothing is applied until you approve it.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      only: {
        type: 'array', items: { type: 'string' },
        description: 'Optional. Limit to these categories.',
      },
    },
    required: ['budget'],
  },
  async run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const b = state.budgets.get(budget);
    if (!b) throw new ToolError(`no budget ${budget}`, 404);
    if (!b.location) {
      throw new ToolError(`${b.label} has no location recorded, so there is nothing to look up`);
    }

    const found = await lookUp(b.location, {
      censusKey: resolvedEnv()['CENSUS_API_KEY'], eiaKey: resolvedEnv()['EIA_API_KEY'],
    });
    const wanted = Array.isArray(args['only']) ? args['only'].map(String) : null;
    const useful = found.estimates.filter((e) => !wanted || wanted.includes(e.category));
    if (!useful.length) {
      throw new ToolError(
        `No public data was found for ${b.location.label}. `
        + found.missing.join('; '));
    }

    const events: NewEvent[] = [];
    const effects: string[] = [];
    const month = monthOf(ctx.today);
    const plan = state.months.get(monthKey(budget, month));
    const open = plan !== undefined && !plan.closed;
    let applied = 0;

    for (const e of useful) {
      // Pricing only fills envelopes that are there. It used to make a lowercase category and
      // envelope for evidence with nowhere to go, which put names nobody chose into the budget.
      const existing = [...b.envelopes.values()]
        .find((env) => env.match.categories.includes(e.category));
      if (!existing) {
        effects.push(`Not applied: no envelope for ${e.label}`);
        continue;
      }
      applied++;

      // Never a silent overwrite. Someone who has already priced this from
      // their own bill should see their number and the measured one together.
      effects.push(existing.template === e.monthly
        ? `${existing.label}: already ${fmtExact(e.monthly)}, unchanged`
        : `${existing.label}: ${fmtExact(existing.template)} would become ${fmtExact(e.monthly)}`);
      events.push(redefine(budget, existing, {
        figure: { template: e.monthly, source: `${e.source}, ${e.measuredOver}, ${e.asOf}` },
      }));
      if (open) {
        events.push({ op: 'assign', budget, month, envelope: existing.id, to: e.monthly, why: 'priced from local data' });
      }

      // The provenance travels with the number. A figure whose origin is not on
      // screen at the moment of approval is a figure nobody checks.
      effects.push(`   ${fmtExact(e.monthly)} a month — ${e.source}, ${e.measuredOver}, ${e.asOf}`);
      effects.push(`   ${e.caveat}`);
    }

    if (!applied) {
      throw new ToolError(
        `Nothing in ${b.label} is fed by what public data prices (${useful.map((e) => e.label).join(', ')}). `
        + 'Make an envelope for one and price it again.', 409);
    }

    // Say what this does not cover. Two envelopes out of a household's forty is
    // a starting point, and calling it anything more would be a lie.
    const untouched = b.envelopes.size - applied;
    effects.push(`This is measured data for ${applied} envelope${applied === 1 ? '' : 's'}. `
      + `${untouched > 0 ? `The other ${untouched} ` : 'Everything else '}has no public figure and is still yours to set.`);
    for (const m of found.missing) effects.push(`Not found: ${m}`);

    return ctx.proposals.put({
      tool: 'seed_from_location', who: ctx.who,
      summary: `Set ${applied} envelope${applied === 1 ? '' : 's'} from ${b.location.label} data`,
      effects, events,
    }, ctx.today);
  },
};

/**
 * The lines that say what a starter set adds. `fed` is true when envelopes made in the same
 * proposal cover the categories, so the warning that they belong to no envelope would be wrong.
 */
function starterEffects(missing: MissingStarter, fed: boolean): string[] {
  const effects: string[] = [];
  for (const kind of ['House', 'People', 'Future'] as const) {
    const here = missing.categories.filter((c) => c.kind === kind);
    if (here.length) effects.push(`${kind}: ${here.map((c) => c.label).join(', ')}`);
  }
  if (missing.categories.length && !fed) {
    effects.push('Categories belong to no envelope yet — spending in them shows as outside every envelope until one covers it');
  }
  for (const r of missing.rules) {
    effects.push(`Rule "${r.match}" files a receipt as ${r.category === TRANSFER ? 'a transfer' : 'income'} — ${r.why}`);
  }
  if (missing.rules.length) {
    effects.push('Rules sort receipts imported from now on; receipts already here are not changed');
  }
  if (missing.skippedCategories.length) {
    effects.push(`Already here, so skipped: ${missing.skippedCategories.join(', ')}`);
  }
  for (const r of missing.skippedRules) effects.push(`Not added: ${r}`);
  return effects;
}

const addStarterSet: Tool = {
  name: 'add_starter_set',
  description:
    'Propose the common starting categories for a household, and the rules that keep a card ' +
    'payment and a paycheque out of spending. Adds only what this household does not already ' +
    'have: a category it has by id or by name is skipped and never renamed, and a rule that ' +
    'overlaps one of its own is skipped. Rules sort receipts imported from now on.',
  kind: 'write',
  input: { type: 'object', properties: {} },
  run(_args, ctx) {
    const missing = missingStarter(ctx.store.state);
    if (!missing.categories.length && !missing.rules.length) {
      throw new ToolError('this household already has everything in the starter set', 409);
    }
    const events: NewEvent[] = [
      ...missing.categories.map((c) => ({ op: 'category.define' as const, category: c.id, label: c.label, kind: c.kind })),
      ...missing.rules.map((r) => ({ op: 'rule.add' as const, rule: r.id, match: r.match, category: r.category })),
    ];
    const effects = starterEffects(missing, false);

    const n = missing.categories.length;
    const m = missing.rules.length;
    return ctx.proposals.put({
      tool: 'add_starter_set',
      who: ctx.who,
      summary: `Add ${n} categor${n === 1 ? 'y' : 'ies'} and ${m} rule${m === 1 ? '' : 's'}`,
      effects, events,
    }, new Date(`${ctx.today}T00:00:00Z`).toISOString());
  },
};

const makeStarterEnvelopes: Tool = {
  name: 'make_starter_envelopes',
  description:
    'Propose the envelopes a new budget starts with, in one step: the rows a person ticked in the ' +
    'budget walkthrough. Each row is a label, a group and, for a starter row, the category that ' +
    'feeds it; a row with no category is one of their own and gets a category made from its name ' +
    '(or reuses one with that name). The starter categories and rules this household lacks are ' +
    'added in the same proposal. Every envelope opens with no figure yet, as Action required, ' +
    'so nothing is funded until someone gives it a number.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      envelopes: {
        type: 'array',
        description: 'The rows to make, in the order to show them.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'What the envelope is called. A starter row may be renamed.' },
            group: { type: 'string', description: 'Which group it sits in, e.g. Home or Food.' },
            category: { type: 'string', description: 'The starter category id that feeds it. Leave out for a row of their own.' },
          },
          required: ['label', 'group'],
        },
      },
    },
    required: ['budget', 'envelopes'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const b = state.budgets.get(budget);
    if (!b) throw new ToolError(`no budget ${budget}`, 404);
    const raw = args['envelopes'];
    if (!Array.isArray(raw) || raw.length === 0) throw new ToolError('make at least one envelope');

    const missing = missingStarter(state);
    // Categories this same proposal defines count as present, so a row can feed a starter
    // category the household does not have yet, or reuse one by its name.
    const defined = new Map<string, string>(); // id -> label, for what this proposal adds
    for (const c of missing.categories) defined.set(c.id, c.label);
    const known = (id: string): boolean => state.categories.has(id) || defined.has(id);
    const labelOf = (id: string): string => state.categories.get(id)?.label ?? defined.get(id) ?? id;
    const own: NewEvent[] = [];

    const rows: { label: string; group: string; category: string }[] = [];
    const fedBy = new Map<string, string>(); // category -> the label of the row it feeds
    for (const item of raw) {
      const r = (item ?? {}) as Record<string, unknown>;
      const label = typeof r['label'] === 'string' ? r['label'].trim() : '';
      if (!label) throw new ToolError('every envelope needs a name');
      const group = typeof r['group'] === 'string' ? r['group'].trim() : '';
      if (!group) throw new ToolError(`${label} needs a group`);

      let category: string;
      if (typeof r['category'] === 'string' && r['category']) {
        category = r['category'];
        if (!known(category)) throw new ToolError(`no category ${category} — a row of your own leaves category out`);
      } else {
        // A row of one's own takes a category that already says the same thing before it
        // makes another: two categories called Pets would split one thing's receipts.
        const id = slug(label);
        if (!id) throw new ToolError('that name has no letters or numbers in it');
        const wanted = label.toLowerCase();
        const same = [...state.categories.keys(), ...defined.keys()]
          .find((k) => k === id || labelOf(k).trim().toLowerCase() === wanted);
        if (same) category = same;
        else {
          category = id;
          defined.set(id, label);
          own.push({ op: 'category.define', category: id, label, kind: groupKind(group) });
        }
      }

      const earlier = fedBy.get(category);
      if (earlier !== undefined) throw new ToolError(`${earlier} and ${label} would both be fed by ${category}`);
      fedBy.set(category, label);
      // One envelope per category, or a receipt lands in whichever was defined last.
      for (const other of b.envelopes.values()) {
        if (other.match.categories.includes(category)) throw new ToolError(`${category} already feeds ${other.label} in ${b.label}`);
      }
      // An envelope's id is its category's, and a define on an existing id would rewrite that envelope.
      if (b.envelopes.has(category)) throw new ToolError(`${b.label} already has an envelope called ${category}`);
      rows.push({ label, group, category });
    }

    const events: NewEvent[] = [
      ...missing.categories.map((c) => ({ op: 'category.define' as const, category: c.id, label: c.label, kind: c.kind })),
      ...missing.rules.map((r) => ({ op: 'rule.add' as const, rule: r.id, match: r.match, category: r.category })),
      ...own,
      ...rows.map((r, i): NewEvent => ({
        op: 'envelope.define', budget, envelope: r.category, label: r.label, group: r.group,
        match: { categories: [r.category] }, template: ZERO, rollover: true, needsFigure: true,
        order: b.envelopes.size + i,
      })),
    ];

    const effects = groupOrder(rows.map((r) => r.group))
      .map((g) => `${g}: ${rows.filter((r) => r.group === g).map((r) => r.label).join(', ')}`);
    effects.push('Every one starts as Action required until it has a figure');
    if (missing.categories.length || missing.rules.length) effects.push(...starterEffects(missing, true));

    return ctx.proposals.put({
      tool: 'make_starter_envelopes', who: ctx.who,
      summary: `Make ${rows.length} envelope${rows.length === 1 ? '' : 's'} in ${b.label}`,
      effects, events,
    }, ctx.today);
  },
};

const setEnvelopeFigure: Tool = {
  name: 'set_envelope_figure',
  description:
    "Propose giving an envelope its figure: what a month opens it at from now on, and this month's " +
    'funding set to the same. A figure, zero included, is the only thing that clears an envelope\'s ' +
    'Action required, and it drops any source the old figure had. `month` is YYYY-MM and defaults to ' +
    'the current month; when it is not open or is closed only the template is written. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      envelope: { type: 'string' },
      amountCents: { type: 'number', description: 'The figure a month, in cents. Zero is allowed.' },
      month: { type: 'string', description: 'YYYY-MM. Defaults to this month.' },
    },
    required: ['budget', 'envelope', 'amountCents'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const b = state.budgets.get(budget);
    if (!b) throw new ToolError(`no budget ${budget}`, 404);
    const id = str(args['envelope'], 'envelope');
    const env = b.envelopes.get(id);
    if (!env) throw new ToolError(`no envelope ${id}`, 404);
    const amount = money(args['amountCents'], 'amountCents');
    if (amount < 0) throw new ToolError('a figure is not less than nothing');
    const month = typeof args['month'] === 'string' && args['month'] ? args['month'] : monthOf(ctx.today);
    const plan = state.months.get(monthKey(budget, month));
    const open = plan !== undefined && !plan.closed;

    const events: NewEvent[] = [redefine(budget, env, { figure: { template: amount } })];
    if (open) events.push({ op: 'assign', budget, month, envelope: id, to: amount, why: 'gave it a figure' });
    return ctx.proposals.put({
      tool: 'set_envelope_figure', who: ctx.who,
      summary: `${env.label}: ${fmtExact(amount)} a month`,
      effects: [
        `From this month on: ${env.label} is planned at ${fmtExact(amount)} a month`,
        open ? `${env.label} is funded at ${fmtExact(amount)} in ${month}`
          : 'This month is not open or is closed, so only the months to come change',
      ],
      events,
    }, ctx.today);
  },
};

const setMonthIncome: Tool = {
  name: 'set_month_income',
  description:
    "Propose setting what one month's income is, as a single figure, without touching the " +
    'recorded income sources. Used when a person changes the income the budget walkthrough ' +
    'shows. The month must be open and not closed. `month` is YYYY-MM and defaults to the ' +
    'current month. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      budget: { type: 'string' },
      month: { type: 'string', description: 'YYYY-MM. Defaults to this month.' },
      amountCents: { type: 'number', description: 'What the month brings in, in cents.' },
      why: { type: 'string', description: "Optional. Defaults to set this month's income." },
    },
    required: ['budget', 'amountCents'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const budget = str(args['budget'], 'budget');
    const b = state.budgets.get(budget);
    if (!b) throw new ToolError(`no budget ${budget}`, 404);
    const month = typeof args['month'] === 'string' && args['month'] ? args['month'] : monthOf(ctx.today);
    const amount = money(args['amountCents'], 'amountCents');
    if (amount < 0) throw new ToolError('an income is not less than nothing');
    const plan = state.months.get(monthKey(budget, month));
    if (!plan) throw new ToolError(`${month} is not open for ${b.label}`, 404);
    if (plan.closed) throw new ToolError(`${month} is closed for ${b.label}, so its income stays as it was`);
    const why = typeof args['why'] === 'string' && args['why'].trim() ? args['why'].trim() : "set this month's income";

    // The month's own name, read as UTC so the zone of the server cannot move it a month.
    const name = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(new Date(`${month}-01T00:00:00Z`));
    return ctx.proposals.put({
      tool: 'set_month_income', who: ctx.who,
      summary: `Set ${name} income to ${fmtExact(amount)}`,
      effects: [
        `${name} income goes from ${fmtExact(plan.income)} to ${fmtExact(amount)}`,
        'The recorded income sources are not changed; this is the figure for this month only',
      ],
      events: [{ op: 'income.set', budget, month, amount, why }],
    }, ctx.today);
  },
};

// ─── plans: the household's to-do board ──────────────────────────────────────
//
// A member changes a plan directly; Claude reaches the same ops only through
// these, as suggestions. None of them touch money, so a plan card has no
// figures to go stale and never needs working out again.

const planStamp = (ctx: ToolContext): string => new Date(`${ctx.today}T00:00:00Z`).toISOString();

// What they were handed is read with the shared plan rules (plan-rules.ts), the
// same ones a member's own edit meets, so a tool and a route never disagree.
const stateName = (s: PlanState): string => s.charAt(0).toUpperCase() + s.slice(1);

const createPlan: Tool = {
  name: 'create_plan',
  description:
    'Propose a new plan on the household board: something to do, buy or sort out, in one of the ' +
    "household's areas. It starts in Planning and belongs to whoever approves it. Give a parent to " +
    'put it on a shelf — a plan that holds items, such as each job in a kitchen remodel. Shelves go ' +
    'one level only: an item cannot hold items, and an item sits in its shelf\'s area. Read ' +
    'list_plans first, so you do not suggest a plan they already have. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short, as it would read on a card: "Replace the water heater".' },
      area: { type: 'string', description: "One of the household's areas, exactly as list_plans names them." },
      parent: { type: 'string', description: 'Optional. The id of the plan whose shelf this goes on.' },
    },
    required: ['title', 'area'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const title = planTitle(args['title']);
    const area = knownArea(state, args['area']);
    const parent = shelfFor(state, args['parent'], area);

    const plan = newPlanId(title);
    const effects = [`A new plan in ${area}, in Planning`, 'It belongs to whoever approves it'];
    if (parent) {
      effects.push(liveChildren(state, parent.id).length
        ? `It goes on the ${parent.title} shelf`
        : `${parent.title} becomes a shelf, with this as its first item`);
    }
    return ctx.proposals.put({
      tool: 'create_plan', who: ctx.who,
      summary: `Make a plan: ${title}`,
      effects,
      events: [{ op: 'plan.create', plan, title, area, ...(parent ? { parent: parent.id } : {}) }],
    }, planStamp(ctx));
  },
};

const updatePlan: Tool = {
  name: 'update_plan',
  description:
    "Propose changes to a plan's card: its title, area, chips, notes, estimated cost, or the budget " +
    'envelope it is paid from. Only the fields given change. Chips are free-text labels such as ' +
    '"researching" or "waiting on a quote"; they never move a plan between columns, and chips and ' +
    'notes are replaced whole, so read get_plan and send the full list. Linking an envelope moves no ' +
    "money — it only lets the card say what the cost means. Moving a shelf's area moves its items " +
    'with it; an item stays in its shelf\'s area. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      title: { type: 'string' },
      area: { type: 'string', description: "One of the household's areas." },
      chips: { type: 'array', items: { type: 'string' }, description: 'The whole set. An empty list clears them.' },
      notes: { type: 'string', description: 'The whole notes. Keep what is there unless asked to replace it.' },
      estimateCents: { type: ['number', 'null'], description: 'Whole cents. $1,800.00 is 180000. null clears it.' },
      envelope: {
        type: ['object', 'null'],
        properties: { budget: { type: 'string' }, envelope: { type: 'string' } },
        required: ['budget', 'envelope'],
        description: 'The envelope it is paid from. null unlinks it.',
      },
    },
    required: ['plan'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const p = livePlan(state, args['plan']);
    const effects: string[] = [];
    const set: {
      title?: string; area?: string; chips?: string[]; notes?: string; estimate?: Cents | null;
      envelope?: { budget: string; envelope: string } | null;
    } = {};

    if (args['title'] !== undefined) {
      set.title = planTitle(args['title']);
      effects.push(`Title: "${p.title}" becomes "${set.title}"`);
    }
    if (args['area'] !== undefined) {
      set.area = knownArea(state, args['area']);
      const shelf = p.parent ? state.plans.get(p.parent) : undefined;
      if (shelf && shelf.area !== set.area) {
        throw new ToolError(`an item lives in its shelf's area: move ${shelf.title} instead`);
      }
      const n = liveChildren(state, p.id).length;
      effects.push(`Area: ${p.area} becomes ${set.area}${n ? `, and its ${n} item${n === 1 ? '' : 's'} move with it` : ''}`);
    }
    if (args['chips'] !== undefined) {
      set.chips = planChips(args['chips']);
      effects.push(set.chips.length ? `Chips: ${set.chips.join(', ')}` : 'Chips cleared');
    }
    if (args['notes'] !== undefined) {
      set.notes = planNotes(args['notes']);
      effects.push(set.notes.trim() ? 'The notes are replaced' : 'The notes are cleared');
    }
    if (args['estimateCents'] !== undefined) {
      set.estimate = planEstimate(args['estimateCents']);
      effects.push(set.estimate === null ? 'Estimate cleared' : `Estimated at ${fmtExact(set.estimate)}`);
    }
    if (args['envelope'] !== undefined) {
      set.envelope = envelopeRef(state, args['envelope']);
      if (set.envelope === null) effects.push('No envelope linked');
      else {
        const b = state.budgets.get(set.envelope.budget)!;
        effects.push(`Paid from ${b.envelopes.get(set.envelope.envelope)!.label} in ${b.label} — no money moves`);
      }
    }
    if (!effects.length) throw new ToolError('nothing to change: give at least one field');
    // A new name or area goes to its due date and blocks on the calendar (an item's too, when a shelf moves).
    const renamed = (set.title !== undefined && set.title !== p.title) || (set.area !== undefined && set.area !== p.area);
    const named = [p, ...(set.area !== undefined && set.area !== p.area ? liveChildren(state, p.id) : [])];
    if (renamed && named.some((x) => x.links.some((l) => l.kind === 'due' || l.kind === 'block'))) {
      effects.push('Renames its calendar events too');
    }

    return ctx.proposals.put({
      tool: 'update_plan', who: ctx.who,
      summary: `Update ${p.title}`,
      effects,
      events: [{ op: 'plan.set', plan: p.id, ...set }],
    }, planStamp(ctx));
  },
  // A new title or area goes to its events on the calendar too, with the stored etag.
  async effect(args, ctx, events) {
    const set = events.find((e) => e.op === 'plan.set');
    if (set?.op !== 'plan.set') return [];
    return syncNames(ctx, livePlan(ctx.store.state, args['plan']), set);
  },
  compensate: (_args, ctx, extra) => undoMade(ctx, extra),
};

const setPlanState: Tool = {
  name: 'set_plan_state',
  description:
    'Propose moving a plan between Planning and Doing, or marking it done. Done takes it off the ' +
    'board and keeps it. A shelf has no state of its own — its items do — so propose this for an ' +
    'item, never the shelf. Only suggest it when they have said where it stands; do not infer ' +
    'progress from chips or a checklist. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      state: { type: 'string', enum: [...PLAN_STATES] },
    },
    required: ['plan', 'state'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const p = livePlan(state, args['plan']);
    const to = planState(args['state']);
    if (liveChildren(state, p.id).length) {
      throw new ToolError(`${p.title} is a shelf; its plans have states, it does not`);
    }
    if (p.state === to) throw new ToolError(`${p.title} is already in ${stateName(to)}`, 409);
    return ctx.proposals.put({
      tool: 'set_plan_state', who: ctx.who,
      summary: to === 'done' ? `Mark ${p.title} done` : `Move ${p.title} to ${stateName(to)}`,
      effects: to === 'done'
        ? [`${stateName(p.state)} becomes Done`, 'It leaves the board, and is kept']
        : [`${stateName(p.state)} becomes ${stateName(to)}`],
      events: [{ op: 'plan.state', plan: p.id, state: to }],
    }, planStamp(ctx));
  },
};

const askToTake: Tool = {
  name: 'ask_to_take',
  description:
    "Propose that a plan's owner ask another member to take it on. Nobody is handed a plan: the " +
    'other member is asked, and it only becomes theirs if they say yes. Only the owner can ask, so ' +
    'suggest this only to the person who owns the plan, and only when they have said they want ' +
    'to hand it over. One ask at a time. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      to: { type: 'string', description: 'The member to ask, by account name.' },
      why: { type: 'string', description: 'One line, read by the person asked.' },
    },
    required: ['plan', 'to', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const p = livePlan(state, args['plan']);
    const to = required(args['to'], 'to');
    const why = required(args['why'], 'why');
    if (ctx.who !== p.owner) throw new ToolError(`only the owner, ${p.owner}, can ask someone to take ${p.title}`);
    if (p.asked) throw new ToolError(`${p.asked.to} has already been asked to take ${p.title}`, 409);
    if (to === p.owner) throw new ToolError(`${p.title} is already ${to}'s`);
    if (!state.members.has(to)) throw new ToolError(`${to} is not in this household`);
    return ctx.proposals.put({
      tool: 'ask_to_take', who: ctx.who,
      summary: `Ask ${to} to take ${p.title}`,
      effects: [`${to} is asked to take it on`, `It stays ${p.owner}'s unless ${to} says yes`],
      events: [{ op: 'plan.ask', plan: p.id, to, why }],
    }, planStamp(ctx));
  },
};

const answerAsk: Tool = {
  name: 'answer_ask',
  description:
    'Propose an answer to an open ask: taking the plan on, or declining it with a reason. Only the ' +
    'member who was asked can approve it, and a plan has at most one open ask. Do not answer for ' +
    'someone — suggest it only when the person asked has said what they want. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      answer: { type: 'string', enum: ['accept', 'decline'] },
      why: { type: 'string', description: 'Required to decline. Read by the person who asked.' },
    },
    required: ['plan', 'answer'],
  },
  run(args, ctx) {
    const p = livePlan(ctx.store.state, args['plan']);
    const answer = args['answer'];
    if (answer !== 'accept' && answer !== 'decline') throw new ToolError('answer must be accept or decline');
    if (!p.asked) throw new ToolError(`nobody has been asked to take ${p.title}`, 409);
    const to = p.asked.to;
    if (answer === 'accept') {
      return ctx.proposals.put({
        tool: 'answer_ask', who: ctx.who,
        summary: `${to} takes ${p.title}`,
        effects: [`${p.title} becomes ${to}'s`, `Only ${to} can approve this`],
        events: [{ op: 'plan.ask.accept', plan: p.id }],
      }, planStamp(ctx));
    }
    const why = required(args['why'], 'why');
    return ctx.proposals.put({
      tool: 'answer_ask', who: ctx.who,
      summary: `${to} declines ${p.title}`,
      effects: [`${p.title} stays ${p.owner}'s`, `Only ${to} can approve this`],
      events: [{ op: 'plan.ask.decline', plan: p.id, why }],
    }, planStamp(ctx));
  },
};

const setChecklist: Tool = {
  name: 'set_checklist',
  description:
    "Propose a plan's checklist: the steps to get it done, each ticked or not. The list is replaced " +
    'whole, so read get_plan first and send every item you mean to keep, with its id; an item left ' +
    'out is dropped. Leave the id off a new item. Tick an item only when they have said it is done. ' +
    'Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      items: {
        type: 'array',
        description: 'The whole checklist, in order.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The existing item\'s id. Omit for a new one.' },
            text: { type: 'string' },
            done: { type: 'boolean' },
          },
          required: ['text'],
        },
      },
    },
    required: ['plan', 'items'],
  },
  run(args, ctx) {
    const p = livePlan(ctx.store.state, args['plan']);
    const items = planChecklist(args['items']);
    const kept = new Set(items.map((i) => i.id));
    const dropped = p.checklist.filter((i) => !kept.has(i.id));
    const done = items.filter((i) => i.done).length;
    const effects = items.map((i) => `[${i.done ? 'x' : ' '}] ${i.text}`);
    effects.push(`${items.length} item${items.length === 1 ? '' : 's'}, ${done} done`);
    if (dropped.length) effects.push(`Dropped: ${dropped.map((i) => i.text).join(', ')}`);
    return ctx.proposals.put({
      tool: 'set_checklist', who: ctx.who,
      summary: `Update the checklist on ${p.title}`,
      effects,
      events: [{ op: 'plan.checklist', plan: p.id, items }],
    }, planStamp(ctx));
  },
};

const setPlanDue: Tool = {
  name: 'set_plan_due',
  description:
    'Propose a date a plan should be done by, or clear it. Suggest one only for a real deadline ' +
    'they have mentioned or a date that matters to the plan, such as before the cold sets in; ' +
    'never invent urgency. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      due: { type: ['string', 'null'], description: 'YYYY-MM-DD. null clears it.' },
    },
    required: ['plan', 'due'],
  },
  run(args, ctx) {
    const p = livePlan(ctx.store.state, args['plan']);
    const due = planDue(args['due']);
    return ctx.proposals.put({
      tool: 'set_plan_due', who: ctx.who,
      summary: due ? `Set ${p.title} due ${due}` : `Clear the due date on ${p.title}`,
      effects: due
        ? [p.due ? `Due ${p.due} becomes ${due}` : `Due ${due}`]
        : [p.due ? `No longer due ${p.due}` : 'It has no due date already'],
      events: [{ op: 'plan.due', plan: p.id, due }],
    }, planStamp(ctx));
  },
  // On approval the date goes on the calendar as an all-day event (or, cleared, comes off it).
  effect: (args, ctx) => syncDue(ctx, livePlan(ctx.store.state, args['plan']), planDue(args['due'])),
  compensate: (_args, ctx, extra) => undoMade(ctx, extra),
};

const blockPlanTime: Tool = {
  name: 'block_plan_time',
  description:
    'Propose setting aside a stretch of time for a plan, such as a Saturday morning to fit the ' +
    'shelves. Suggest a time only when they have said when they mean to do it; you cannot see ' +
    'their calendars, so never assume a slot is free. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      start: { type: 'string', description: 'ISO 8601 date and time.' },
      end: { type: 'string', description: 'ISO 8601 date and time, after the start.' },
    },
    required: ['plan', 'start', 'end'],
  },
  run(args, ctx) {
    const p = livePlan(ctx.store.state, args['plan']);
    const { start, end } = blockTimes(args['start'], args['end']);
    return ctx.proposals.put({
      tool: 'block_plan_time', who: ctx.who,
      summary: `Set aside time for ${p.title}`,
      effects: [`From ${start} to ${end}`],
      events: [{ op: 'plan.block', plan: p.id, block: newBlockId(), start, end }],
    }, planStamp(ctx));
  },
  // On approval the time goes on the calendar, linked by the block id the proposal made up.
  async effect(args, ctx, events) {
    const b = events.find((e) => e.op === 'plan.block');
    if (b?.op !== 'plan.block') return [];
    return syncBlock(ctx, livePlan(ctx.store.state, args['plan']), { id: b.block, start: b.start, end: b.end });
  },
  compensate: (_args, ctx, extra) => undoMade(ctx, extra),
};

const removePlan: Tool = {
  name: 'remove_plan',
  description:
    'Propose taking a plan off the board for good, because it is no longer wanted. It is kept in ' +
    'the log, marked removed. A finished plan is marked done, not removed. A shelf with items on ' +
    'it cannot be removed until they are. A reason is required. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      why: { type: 'string', description: 'One line. Read the next time someone wonders where it went.' },
    },
    required: ['plan', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const p = livePlan(state, args['plan']);
    const why = required(args['why'], 'why');
    if (liveChildren(state, p.id).length) throw new ToolError(`${p.title} still has plans on it`, 409);
    const effects = [`${p.title} leaves the board`, 'It stays in the log, marked removed'];
    if (p.asked) effects.push(`The ask to ${p.asked.to} lapses`);
    return ctx.proposals.put({
      tool: 'remove_plan', who: ctx.who,
      summary: `Remove ${p.title}`,
      effects,
      events: [{ op: 'plan.remove', plan: p.id, why }],
    }, planStamp(ctx));
  },
  // Its events come off the calendar, and are unlinked before it is removed: a
  // removed plan can no longer be unlinked. A deleted event cannot be undone.
  effect: (args, ctx) => unsyncAll(ctx, livePlan(ctx.store.state, args['plan'])),
  effectFirst: true,
};

const linkContact: Tool = {
  name: 'link_contact',
  description:
    "Propose putting a person or business from the household's address book on a plan, such as " +
    'the plumber quoting for it. Use the contact and address book ids exactly as a contact lookup ' +
    'returned them; never make one up, and never link someone who is not in the address book. ' +
    'Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      contact_id: { type: 'number' },
      addressbook_id: { type: 'number' },
      display: { type: 'string', description: 'The name as it shows on the card.' },
    },
    required: ['plan', 'contact_id', 'addressbook_id', 'display'],
  },
  run(args, ctx) {
    const p = livePlan(ctx.store.state, args['plan']);
    const { contact_id, addressbook_id, display } = contactLink(args);
    const already = p.contacts.some((c) => c.contact_id === contact_id);
    return ctx.proposals.put({
      tool: 'link_contact', who: ctx.who,
      summary: `Link ${display} to ${p.title}`,
      effects: [already ? `${display} is already on it, and is updated` : `${display} goes on the card`],
      events: [{ op: 'plan.contact.link', plan: p.id, contact_id, addressbook_id, display }],
    }, planStamp(ctx));
  },
};

/** The most phone numbers or emails a suggestion may carry, and the longest any one word of it. */
const CONTACT_VALUES = 5;
const CONTACT_WORD = 200;

/** What a contact suggestion asks for, read and checked: the same way when it is proposed and when it is approved. */
interface ContactAsked {
  readonly full_name: string;
  readonly phones: string[];
  readonly emails: string[];
  readonly org: string;
  readonly plan: Plan | null;
}

const contactWord = (v: string, name: string): string => {
  if (v.length > CONTACT_WORD) throw new ToolError(`${name} is longer than ${CONTACT_WORD} characters`);
  return v;
};

/** An optional list of non-empty words, at most `CONTACT_VALUES` of them. */
function contactList(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ToolError(`${name} is a list of words`);
  if (v.length > CONTACT_VALUES) throw new ToolError(`${name} may hold at most ${CONTACT_VALUES}`);
  return v.map((x) => {
    if (typeof x !== 'string' || !x.trim()) throw new ToolError(`${name} holds words, none of them empty`);
    return contactWord(x.trim(), name);
  });
}

function contactAsked(args: Record<string, unknown>, ctx: ToolContext): ContactAsked {
  const full_name = contactWord(required(args['full_name'], 'full_name'), 'full_name');
  const org = args['org'];
  if (org !== undefined && org !== null && typeof org !== 'string') throw new ToolError('org is a word');
  const given = args['plan'] !== undefined && args['plan'] !== null && args['plan'] !== '';
  return {
    full_name,
    phones: contactList(args['phones'], 'phones'),
    emails: contactList(args['emails'], 'emails'),
    org: contactWord((org ?? '').trim(), 'org'),
    plan: given ? livePlan(ctx.store.state, args['plan']) : null,
  };
}

/**
 * A new person in the household's address book, for when research turns up
 * someone who is not there yet. A proposal with no events of its own: what it
 * does happens on the NAS at the moment it is approved, in the effect, which
 * returns the link to the plan (the log's only record of it) when a plan is
 * given. Needs a DSM session already when it is proposed, so nothing is
 * offered that approving could not carry out.
 */
const createContactTool: Tool = {
  name: 'create_contact',
  description:
    "Propose adding a person or business to the household's address book in Synology Contacts, " +
    'such as an installer research turned up, and linking them to a plan. Only for someone the ' +
    'member will plausibly contact again, not for every name research mentions; if they are ' +
    'already in the address book, use link_contact to put them on the plan instead. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      full_name: { type: 'string', description: 'The name as it should appear in Contacts.' },
      phones: { type: 'array', items: { type: 'string' } },
      emails: { type: 'array', items: { type: 'string' } },
      org: { type: 'string' },
      plan: { type: 'string', description: 'A plan to link them to once they are added.' },
    },
    required: ['full_name'],
  },
  run(args, ctx) {
    const a = contactAsked(args, ctx);
    requireSid(ctx);
    return ctx.proposals.put({
      tool: 'create_contact', who: ctx.who,
      summary: `Add ${a.full_name} to Contacts`,
      effects: ['A new contact in the household address book', ...(a.plan ? [`Linked to ${a.plan.title}`] : [])],
      events: [],
    }, planStamp(ctx));
  },
  // The first address book is the household's: the NAS lists it first, and the household has one.
  async effect(args, ctx) {
    const a = contactAsked(args, ctx);
    const sid = requireSid(ctx);
    const [book] = await listAddressbooks(sid);
    if (!book) throw new ToolError('the NAS has no address book', 502);
    const made = await createContact(sid, {
      addressbook_id: book.id, full_name: a.full_name, phones: a.phones, emails: a.emails, org: a.org,
    });
    return a.plan
      ? [{ op: 'plan.contact.link', plan: a.plan.id, contact_id: made.id, addressbook_id: made.addressbook_id, display: a.full_name }]
      : [];
  },
  // Nothing to undo: the Contacts API has no documented way to delete a contact, so one made before a
  // refused write is left in the address book, where it is harmless and can be removed in Contacts.
  async compensate() {},
};

/**
 * The appointment the args ask for, read and checked, the same way when it
 * is proposed and again when it is approved: the times (none already gone,
 * none ending before they start), where it goes, and the plan or person it
 * is for. Asks nothing of the NAS. The Calendar's form is read through this
 * too (appointment-edits.ts).
 */
export function appointmentAsked(args: Record<string, unknown>, ctx: ToolContext): AppointmentAsked {
  const state = ctx.store.state;
  const summary = required(args['summary'], 'summary').trim();
  if (summary.length > PLAN_LIMITS.title) throw new ToolError(`summary is longer than ${PLAN_LIMITS.title} characters`);
  const on = args['on'];
  if (on !== 'mine' && on !== 'household') throw new ToolError("on is 'mine' or 'household'");
  const times = appointmentTimes(args['start'], args['end'], args['allDay'] === true, ctx.today, zoneOf(state));
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  if (given(args['plan']) && given(args['makePlan'])) {
    throw new ToolError('an appointment is for a plan they have (plan) or a new one (makePlan), not both');
  }
  let plan: AppointmentAsked['plan'];
  if (given(args['plan'])) {
    const p = livePlan(state, args['plan']);
    plan = { id: p.id, title: p.title, area: p.area, isNew: false };
  } else if (given(args['makePlan'])) {
    const m = args['makePlan'];
    const area = knownArea(state, typeof m === 'object' && m ? (m as Record<string, unknown>)['area'] : undefined);
    plan = { id: newPlanId(summary), title: summary, area, isNew: true };
  }
  // Who asked, as stamped when it was proposed; a card with none is the approver's own.
  const asker = typeof args['for'] === 'string' && args['for'] ? args['for'] : ctx.who;
  const notes = appointmentNotes(args['notes']);
  return {
    ...times, summary, on, asker,
    ...(notes ? { notes } : {}),
    ...(plan ? { plan } : {}),
    ...(given(args['contact']) ? { contact: contactLink(args['contact']) } : {}),
  };
}

const proposeEvent: Tool = {
  name: 'propose_event',
  description:
    'Propose putting an appointment on a calendar: the dentist at 10 on Thursday. Work out the day ' +
    'from today, in the household\'s time zone, and give the time exactly as they said it; the card ' +
    'is for that time. It is checked against their own calendar, the Household one and the ' +
    'calendars they chose, and the card names any clash and offers free times instead. ' +
    "on is 'mine' for their own calendar, 'household' for the shared one. Give plan for a plan they " +
    'have; give makePlan only when they asked for a plan as well. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What it is, as it reads on the calendar: "Dentist".' },
      start: { type: 'string', description: 'Local time where the household is: 2026-11-05T10:00. A date alone when allDay.' },
      end: { type: 'string', description: 'Local time, after the start: 2026-11-05T11:00. When allDay, the last day.' },
      allDay: { type: 'boolean' },
      on: { type: 'string', enum: ['mine', 'household'] },
      plan: { type: 'string', description: 'Optional. The id of a plan it is for.' },
      contact: {
        type: 'object', description: 'Optional. A person from the address book, ids exactly as a lookup gave them.',
        properties: { contact_id: { type: 'number' }, addressbook_id: { type: 'number' }, display: { type: 'string' } },
        required: ['contact_id', 'addressbook_id', 'display'],
      },
      makePlan: {
        type: 'object', description: 'Optional. Make a plan with it, in this area, titled as the appointment.',
        properties: { area: { type: 'string' } }, required: ['area'],
      },
    },
    required: ['summary', 'start', 'end', 'on'],
  },
  // One for the asker's own calendar remembers who asked: only they may approve it.
  // Kept as it was when the card is worked out again or adjusted, by whoever does it.
  stampArgs(args, ctx, before) {
    const { for: _given, ...rest } = args;
    if (rest['on'] !== 'mine') return rest;
    const asker = before?.['on'] === 'mine' && typeof before['for'] === 'string' && before['for'] ? before['for'] : ctx.who;
    return { ...rest, for: asker };
  },
  async run(args, ctx) {
    const a = appointmentAsked(args, ctx);
    let seen;
    try {
      seen = await conflictsFor(ctx, a.dtstart, a.dtend, { allDay: a.allDay, on: a.on, asker: a.asker });
    } catch (e) {
      if (e instanceof SynologyError) throw new ToolError(e.message, 502);
      throw e;
    }
    const { summary, effects } = appointmentWords(a, seen, ctx.today, zoneOf(ctx.store.state));
    // No events of its own: the effect makes them, with the ids the NAS answers.
    return ctx.proposals.put({ tool: 'propose_event', who: ctx.who, summary, effects, events: [] }, planStamp(ctx));
  },
  // Checked again on approval (a time may have gone since), then made on the NAS.
  effect: (args, ctx) => makeAppointment(ctx, appointmentAsked(args, ctx)),
  compensate: (_args, ctx, extra) => undoMade(ctx, extra),
};

const driftChoice = (v: unknown): DriftChoice => {
  if (!DRIFT_CHOICES.includes(v as DriftChoice)) throw new ToolError(`choice is one of ${DRIFT_CHOICES.join(', ')}`);
  return v as DriftChoice;
};

/** Whether a drift is a page's (`plan.page.drift`) rather than the calendar's. */
const onPage = (ctx: ToolContext, args: Record<string, unknown>): boolean =>
  ctx.store.state.pageDrifts.has(String(args['drift'] ?? ''));

/**
 * A plan's event changed on the calendar, or its page changed in Drive (a
 * drift): what to do about it. The app raises this card itself when it
 * notices (drift.ts, checkDrift and checkPages), and a member settles it by
 * choosing as they approve. Its events are all made at that moment, by the
 * effect, since which they are depends on the choice; the card stores none.
 * Each step reads whichever of the two the drift is. Not offered to Claude:
 * drift is settled by a person.
 */
const resolveDrift: Tool = {
  name: 'resolve_drift',
  description:
    "Settle a plan whose event was changed or deleted on the calendar, or whose page was changed in Drive: " +
    "move the plan to match it ('plan'), put the calendar or the page back as the plan has it ('calendar'), " +
    "or leave both as they are ('leave'). Raised by the app when it notices; a member chooses as they approve. " +
    'Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      drift: { type: 'string', description: 'The calendar.drift or plan.page.drift event id.' },
      plan: { type: 'string', description: 'The plan the drift is on.' },
      choice: { type: 'string', enum: [...DRIFT_CHOICES] },
    },
    required: ['drift', 'plan', 'choice'],
  },
  chosenOnApproval: { choice: DRIFT_CHOICES },
  run(args, ctx) {
    const state = ctx.store.state;
    const id = required(args['drift'], 'drift');
    const d = state.drifts.get(id) ?? state.pageDrifts.get(id);
    const where = state.pageDrifts.has(id) ? 'to the page' : 'on the calendar';
    if (!d) throw new ToolError('there is no such change on the calendar', 404);
    if (d.resolved !== null) throw new ToolError(`that change ${where} was already settled`, 409);
    driftChoice(args['choice']);
    // Named on the card so that removing the plan retires it (lapseOffers reads args.plan).
    if (args['plan'] !== d.plan) throw new ToolError(`that change is on ${d.plan}, not ${String(args['plan'])}`);
    const p = livePlan(state, d.plan);
    const page = state.pageDrifts.get(id);
    const { summary, effects } = page ? pageDriftWords(p, page, zoneOf(state)) : driftWords(p, state.drifts.get(id)!, zoneOf(state));
    return ctx.proposals.put({ tool: 'resolve_drift', who: ctx.who, summary, effects, events: [] }, planStamp(ctx));
  },
  effect: (args, ctx) => {
    const id = required(args['drift'], 'drift');
    const choice = driftChoice(args['choice']);
    return onPage(ctx, args) ? settlePageDrift(ctx, id, choice) : settleDrift(ctx, id, choice);
  },
  // "Take the change" of a page may only have changed what the page does not show: then it is written again.
  afterWrite: async (args, ctx) => { if (onPage(ctx, args)) afterPageSettled(ctx, required(args['drift'], 'drift')); },
  // For the calendar, only "put the calendar back" did anything outside the
  // log, and putting it back is the same however often it is done: nothing to
  // undo. A page's "take the change" may have put its new date on the
  // calendar: that event is taken off again (best effort).
  compensate: async (args, ctx, extra) => { if (onPage(ctx, args)) await undoMade(ctx, extra); },
};

/**
 * A friend's request to stay, decided on its card. Only a guest raises it
 * (booking.ts, request) and only a member decides it; Claude is never handed
 * it, and the tools route refuses it, so there is no way to it but a guest's
 * own request. The card stores no events: what approving it writes, the event
 * on the Household calendar and the stay, its effect writes.
 *
 * `run` is the check made when the card is raised: the guest is still on the
 * list, the card is in shape, and every night is open (or held by a request
 * of the guest's own). Approving does not run it again; the effect makes the
 * same checks at that moment, letting through only this card's own nights,
 * before anything is called. Declining mails the guest the reason first.
 */
const approveBooking: Tool = {
  name: 'approve_booking',
  description:
    "A guest's request to stay: their email and the guest list's name for them, arrival and departure " +
    '(YYYY-MM-DD, nights from arrival up to departure), how many, and their note. Raised by the guest from ' +
    'the booking page; a member approves it. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      email: { type: 'string' },
      name: { type: 'string' },
      arrive: { type: 'string' },
      depart: { type: 'string' },
      headcount: { type: 'number' },
      note: { type: 'string' },
    },
    required: ['email', 'name', 'arrive', 'depart', 'headcount'],
  },
  run(args, ctx) {
    // A guest's card is their own, never another's.
    if (isGuest(ctx.who) && isEmail(args['email']) && guestEmail(ctx.who) !== emailKey(args['email'])) {
      throw new ToolError('a guest asks for themselves', 403);
    }
    const a = checkCard(ctx.store.state, args, { today: ctx.today, voice: isGuest(ctx.who) ? 'guest' : 'member', ownPending: true });
    const { summary, effects } = requestWords(a, ctx.today);
    const old = a.replacing?.stay;
    return ctx.proposals.put({
      tool: 'approve_booking', who: ctx.who, summary: requestPrefix(args, ctx.today) + summary,
      effects: old ? [...effects, `The event for ${stayDates(old.arrive, old.depart, ctx.today)} comes off the Household calendar`] : effects,
      events: [],
    }, planStamp(ctx));
  },
  // The calendar, then the mail, then (by decide) the log.
  effect: (args, ctx, _events, card) => confirmStay(ctx, args, card),
  // The write was refused after all that: the event comes off. The mail has gone and cannot be called back,
  // so the member is told the guest holds a confirmation, by the list's name for them and never their address.
  compensate: (_args, ctx, extra) => unconfirm(ctx, extra),
  refusedAfter: (args, ctx, extra) => {
    const c = extra.find((e) => e.op === 'booking.confirm');
    if (!c || c.op !== 'booking.confirm') return null;
    const name = typeof args['name'] === 'string' && args['name'].trim() ? args['name'].trim() : 'the guest';
    return `${name} already holds a confirmation for ${stayDates(c.arrive, c.depart, ctx.today)} (its email went), `
      + 'and its event is off the calendar again: tell them where they stand';
  },
  // A change, written: the stay it replaced takes its event off the calendar with it.
  afterWrite: (_args, ctx, extra) => takeOffReplaced(ctx, extra),
  onDecline: (args, ctx, why) => tellDeclined(ctx, args, why),
};

/**
 * A confirmed stay the guest cancelled, whose event is still on the Household
 * calendar. The app raises it as the guest cancels (booking.ts, cancelStay):
 * the nights are free from that moment, and a member acknowledges by
 * approving, which takes the event off. Not offered to Claude; a guest raises
 * it only as the answer to their own cancel of that stay (the fold checks it:
 * replay.ts, refuseRelease).
 */
const releaseStayTool: Tool = {
  name: 'release_stay',
  description:
    "A guest cancelled a confirmed stay: approving takes its event off the Household calendar. Raised by the app " +
    'when the guest cancels. Returns a proposal.',
  kind: 'write',
  input: { type: 'object', properties: { stay: { type: 'string' } }, required: ['stay'] },
  run(args, ctx) {
    const st = releasable(ctx.store.state, args['stay']);
    const dates = stayDates(st.arrive, st.depart, ctx.today);
    return ctx.proposals.put({
      tool: 'release_stay', who: ctx.who,
      summary: `${st.name} cancelled ${dates}: the nights are open again`,
      effects: [`The event comes off the Household calendar, ${dates}`],
      events: [],
    }, planStamp(ctx));
  },
  effect: (args, ctx) => releaseStay(ctx, args),
  // A deleted event is not put back: the stay is cancelled either way, and a refused write leaves it to approve again.
  compensate: async () => {},
};

/**
 * Savings showed less than the sinking envelopes held on the same day. Raised
 * by the app when such a balance is recorded (offers.ts, raiseSavingsCard),
 * from whoever recorded it; no Claude in it. Approving says it was seen and
 * moves nothing: money goes between checking and Savings by hand, and the app
 * does not tell anyone to move it. A newer balance retires it in the fold.
 */
const savingsShort: Tool = {
  name: 'savings_short',
  description:
    'Savings showed less than the sinking envelopes held that day. Raised by the app when a balance is recorded; ' +
    'approving says it was seen, and moves nothing. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: { budget: { type: 'string' }, account: { type: 'string' } },
    required: ['budget', 'account'],
  },
  run(args, ctx) {
    const c = savingsCheck(ctx.store.state, str(args['budget'], 'budget'), ctx.today);
    if (!c) throw new ToolError('that budget has no envelopes saved in Savings');
    return ctx.proposals.put({
      tool: 'savings_short', who: ctx.who,
      summary: c.status === 'short' ? c.words.verdict.replace(/\.$/, '') : 'Savings covers the sinking funds now',
      effects: [c.words.held, ...(c.words.showed ? [c.words.showed] : []),
        'Nothing moves: money goes between checking and Savings by hand'],
      events: [],
    }, planStamp(ctx));
  },
};

const listPlans: Tool = {
  name: 'list_plans',
  description:
    "The household's board: a row per area, each with its shelves (and how many items they hold) " +
    'and its plans in Planning and Doing — who owns each, any open ask, chips, due date, the ' +
    'envelope it is paid from and what is left in it, and, for a plan in Doing only, how many days it ' +
    'has been there. Nothing in Planning has an age, and a finished plan has none: daysInState is null ' +
    'for both, so never say how long something has waited to be started. ' +
    'Use it to find a plan and its id before suggesting anything about one.',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      filter: {
        type: 'string', enum: ['both', 'mine', 'theirs'],
        description: 'mine: what the person you are speaking to owns or has been asked to take. Default both.',
      },
      showDone: { type: 'boolean', description: 'Include finished plans. Default false.' },
    },
  },
  async run(args, ctx) {
    const f = args['filter'];
    const filter = f === 'mine' || f === 'theirs' ? f : 'both';
    return board(ctx.store.state, await ctx.store.since(null),
      { who: ctx.who, filter, today: ctx.today, showDone: args['showDone'] === true });
  },
};

const getPlan: Tool = {
  name: 'get_plan',
  description:
    "Everything on one plan's card: notes, checklist with item ids, chips, people, due date and " +
    'time set aside, its shelf or its items, the money it means for its envelope, what you found ' +
    'for it before, what the members said to each other about it, and its history.',
  kind: 'read',
  input: {
    type: 'object',
    properties: { plan: { type: 'string' } },
    required: ['plan'],
  },
  async run(args, ctx) {
    const id = livePlan(ctx.store.state, args['plan']).id;
    return card(ctx.store.state, await ctx.store.since(null), id, { who: ctx.who, today: ctx.today });
  },
};

const searchTool: Tool = {
  name: 'search',
  description:
    'Find plans, briefings, answers and files by words in them, scoped to this household: a plan by its page, ' +
    'title or notes, a briefing or one of your earlier answers by its text, a file on a plan\'s card by its name or ' +
    'what is in it, and what members asked or wrote in the thread. Each hit has the passage that matched and the ids ' +
    'to open it with (a plan id for get_plan, a day and event id, or a plan and a file name). ' +
    'Says documents: "not searched" when it could not reach the NAS; then only plans and the thread were searched.',
  kind: 'read',
  // Read when asked for, not when this module loads: search.ts reaches this
  // module again through docs.ts, so loaded first it is not finished yet then.
  get input() {
    return {
      type: 'object',
      properties: {
        words: { type: 'string', description: 'What to look for: at least two letters, any case.' },
        kind: { type: 'string', enum: SEARCH_KINDS, description: 'Only this kind of hit. Default: every kind.' },
      },
      required: ['words'],
    };
  },
  run: (args, ctx) => searchHousehold(ctx, searchWords(args['words']), searchKind(args['kind'])),
};

export const TOOLS: readonly Tool[] = [
  getMonth, explainEnvelope, findDonors, listTransactions, compareBudgets, getActivity, addStarterSet,
  makeStarterEnvelopes, setMonthIncome, setEnvelopeFigure,
  moveMoney, setAssignment, categorizeTxn, openMonth, restoreTxn,
  createBudget, renameBudget, archiveBudget, defineEnvelope, setSinkingGoal, removeEnvelope,
  defineCategory, archiveCategory, closeMonth, discardMonth,
  planIncome, defineIncome, removeIncome, locateBudget, localCosts, seedFromLocation,
  listPlans, getPlan, searchTool, createPlan, updatePlan, setPlanState, askToTake, answerAsk, setChecklist,
  setPlanDue, blockPlanTime, removePlan, linkContact, createContactTool, proposeEvent,
];

/**
 * Every tool by name, for running a card: Claude's, and the ones only the app
 * raises (resolve_drift; approve_booking, a guest's; release_stay; savings_short), which are not in TOOLS
 * and so never offered to Claude.
 */
export const toolByName = new Map([...TOOLS, resolveDrift, approveBooking, releaseStayTool, savingsShort].map((t) => [t.name, t]));

/** Raised by the app, or a guest, and answered on their cards: never run from the tools route. */
export const CARD_ONLY: ReadonlySet<string> = new Set([resolveDrift.name, approveBooking.name, releaseStayTool.name, savingsShort.name]);

/** Whether Claude may call it: the ones in TOOLS. */
export const forClaude = (t: Tool): boolean => TOOLS.includes(t);

/**
 * The writes research on a plan may suggest: the plan tools, whose events
 * touch no budget, month or envelope. Research may read the budget and say
 * what a cost means for an envelope; moving money is decided in the budget,
 * never from a card. create_contact is one: it only adds someone to Contacts,
 * and nothing happens until a member approves the card.
 */
export const RESEARCH_WRITES: ReadonlySet<string> = new Set([
  createPlan, updatePlan, setPlanState, askToTake, answerAsk, setChecklist,
  setPlanDue, blockPlanTime, removePlan, linkContact, createContactTool,
].map((t) => t.name));

/** What research on a plan may call: every read, and the plan writes. */
export const researchMay = (t: Tool): boolean => t.kind === 'read' || RESEARCH_WRITES.has(t.name);

/** The definitions handed to Claude. Same list the UI drives itself from. */
export const toolSchemas = () =>
  TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input }));

/**
 * Run a tool's effect, if it has one, and hand back the events it adds. A DSM
 * refusal reaches the person with the status it carries: a session that ended
 * is the 409 that says sign in again, an account not allowed a 403, anything
 * else the NAS said a 502. A ToolError keeps its status.
 */
export async function runEffect(
  tool: Tool, args: Record<string, unknown>, ctx: ToolContext, events: readonly NewEvent[] = [], card?: string,
): Promise<NewEvent[]> {
  if (!tool.effect) return [];
  try {
    return await tool.effect(args, ctx, events, card);
  } catch (e) {
    if (e instanceof SynologyError) throw new ToolError(e.message, e.status);
    throw e;
  }
}

/**
 * An effect and the write after it, one at a time: per plan when the tool's
 * args name one (the same key a member's own edit to that plan waits on), else
 * per card. Two approvals on one plan, or an approval and a member's edit,
 * would otherwise both find it unlinked and both make an event.
 */
export function oneEffectAtATime<T>(ctx: ToolContext, args: Record<string, unknown>, card: string,
                                    run: () => Promise<T>): Promise<T> {
  const plan = typeof args['plan'] === 'string' && args['plan'] ? args['plan'] : null;
  return oneAtATime(plan ? planKey(ctx.store.path, plan) : `${ctx.store.path}|offer|${card}`, run);
}

/** The stored events and the effect's, in the order the tool writes them. */
export const inOrder = (tool: Tool | undefined, events: readonly NewEvent[], extra: readonly NewEvent[]): NewEvent[] =>
  tool?.effectFirst ? [...extra, ...events] : [...events, ...extra];

/**
 * Write what an effect made possible; if the write is refused, give the tool
 * the chance to undo its effect, then answer with the refusal, and with what
 * could not be undone (refusedAfter), which the log is told too. A failed undo
 * is swallowed, and nothing about it is logged: the error could carry a sid.
 */
export async function appendAfterEffect<T>(
  tool: Tool | undefined, args: Record<string, unknown>, ctx: ToolContext,
  extra: readonly NewEvent[], write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (tool?.compensate && tool.effect) {
      try { await tool.compensate(args, ctx, extra); } catch { /* best effort; see above */ }
    }
    const left = tool?.effect ? tool.refusedAfter?.(args, ctx, extra) ?? null : null;
    if (left) {
      console.warn(`[booking] ${tool!.name} was refused after its effect: ${(err as Error)?.message ?? String(err)}; ${left}`);
      if (err instanceof ToolError) throw new ToolError(`${err.message}; but ${left}`, err.status);
    }
    throw err;
  }
}

/** A proposal only reports what it would do. Recognised by the shape `ProposalStore.put` gives it. */
const isProposal = (v: unknown): v is Proposal =>
  typeof v === 'object' && v !== null && typeof (v as Proposal).id === 'string'
  && typeof (v as Proposal).tool === 'string' && Array.isArray((v as Proposal).events);

/**
 * Run a tool for a caller (Claude, or the tools route) and, for a write, record
 * on its proposal the args it was made with, so its effect can run on approval.
 */
export async function runTool(tool: Tool, given: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const args = recordedArgs(tool, given, ctx);
  const result = await tool.run(args, ctx);
  return tool.kind === 'write' && isProposal(result) ? ctx.proposals.withArgs(result, args) : result;
}

/** Approve a proposal: this is the only path that writes. */
export async function commit(id: string, ctx: ToolContext): Promise<{ committed: Event[]; summary: string }> {
  const p = ctx.proposals.take(id);
  if (!p) throw new ToolError('that proposal has expired or was already approved', 404);
  const tool = toolByName.get(p.tool);
  if (tool?.effect && !p.args) throw new Error(`the ${p.tool} proposal carries no args, so its effect cannot run`);
  const args = p.args ?? {};
  const committed = await oneEffectAtATime(ctx, args, p.id, async () => {
    const extra = tool ? await runEffect(tool, args, ctx, p.events) : [];
    const written = await appendAfterEffect(tool, args, ctx, extra, () => ctx.store.append(ctx.who, inOrder(tool, p.events, extra)));
    await tool?.afterWrite?.(args, ctx, extra);
    return written;
  });
  // An ask committed here puts its card in front of the member asked, as any
  // ask does; a drift the effect found, its card in front of everyone.
  await raiseAskCards(ctx, committed);
  await raiseDriftCards(ctx, committed);
  return { committed, summary: p.summary };
}
