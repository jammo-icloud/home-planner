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
import { carriedInto, categoryIdFor, envelopeIdFor, monthView, latestMonth, openMonths } from './envelopes.ts';
import { billDateWords, billKey, billLine, billsOf, donors, drift, inToSort, monthClock, pace, snapshot, toSort } from './analytics.ts';
import { fundedFor, plannedFor, nameKey, splitProblem, guestEmail } from './replay.ts';
import { filedLabel, ruleProblem } from './match.ts';
import { removedTxn } from './activity.ts';
import { byMonthly, everyMonthly, everyWords, goalFor, savingsCheck, shortDay, sinkingPlan } from './sinking.ts';
import { incomeFor, project, sourcesFor } from './income.ts';
import { lookUp, placeForZip } from './local.ts';
import { missingRules, STARTER_CATEGORIES } from './starter.ts';
import { cardFor, coverFor, hintFor, monthlyOf, perWord } from './figures.ts';
import type { Basis, Cover, Hint } from './figures.ts';
import type { MissingRules } from './starter.ts';
import { board, card } from './plans.ts';
import { SEARCH_KINDS, searchHousehold, searchKind, searchWords } from './search.ts';
import {
  blockTimes, contactLink, envelopeRef, handReason, handTarget, knownArea, livePlan, newBlockId, newPlanId, PLAN_LIMITS, PLAN_STATES,
  planChecklist, planChips, planDue, planEstimate, planGoal, planNotes, planState, planTitle, required, RETIRED,
} from './plan-rules.ts';
import { ToolError } from './errors.ts';
import type { Bill } from './analytics.ts';
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
  areaIndex, DRIFT_CHOICES, emailKey, isDay, isEmail, isGuest, isSpend, monthOf, MONTHS_SHORT, partsOf, PERS, slug, SPLIT, TRANSFER, INCOME, zoneOf,
} from './types.ts';
import type {
  Actor, BillDate, CategoryId, Day, DriftChoice, Envelope, EnvelopeId, Event, Location, Month, Per, Plan, PlanState, SinkingEstimate, SinkingGoal, SplitPart, State, Txn,
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
/** A figure as the bill is known, `{ amountCents, per }`, read from a tool's arguments. */
const basisArg = (v: unknown): Basis => {
  if (typeof v !== 'object' || v === null) throw new ToolError('basis is { amountCents, per }');
  const b = v as { amountCents?: unknown; per?: unknown };
  const amount = money(b.amountCents, 'basis.amountCents');
  if (amount < 0) throw new ToolError('a figure is not less than nothing');
  if (!PERS.includes(b.per as Per)) throw new ToolError(`per is one of ${PERS.join(', ')}`);
  return { amount, per: b.per as Per };
};
/** The same basis as the input schema describes it. */
const BASIS_INPUT = {
  type: 'object',
  properties: {
    amountCents: { type: 'number', description: 'The amount, in cents, once every `per`.' },
    per: { type: 'string', enum: PERS },
  },
  required: ['amountCents', 'per'],
};
/** "$1,200.00 a year": a basis in words. */
const basisWords = (b: Basis): string => `${fmtExact(b.amount)} a ${perWord(b.per)}`;

export { ToolError };

const resolveMonth = (state: State, month: unknown): Month => {
  if (typeof month === 'string' && month) return month;
  const latest = latestMonth(state);
  if (!latest) throw new ToolError('no months are open');
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

/** A bill as the month's wire has it: nothing sent for what the receipts or a member have not said. */
const billView = (b: Bill) => ({
  key: b.key, name: b.name, byHand: b.byHand,
  ...(b.about !== null ? { about: fmt(b.about) } : {}),
  ...(b.lastPaid ? { lastPaid: b.lastPaid.day } : {}),
  ...(b.date ? { date: b.date } : {}),
  line: billLine(b),
});

const getMonth: Tool = {
  name: 'get_month',
  description:
    'How the budget is doing this month: every envelope with planned, funded, spent and left, ' +
    'plus its bills, with any date a member set, pace projections, plan drift, what To sort holds and whether it balances. ' +
    'Envelopes come in category order, each naming its category; categories lists every heading in order, empty ones too. ' +
    'Start here for any "how are we doing" question.',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      month: { type: 'string', description: 'YYYY-MM. Defaults to the latest open month.' },
    },
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const month = resolveMonth(state, args['month']);
    const snap = snapshot(state, month, ctx.today);
    if (!snap) throw new ToolError(`${month} is not open`, 404);
    const billed = billsOf(state);
    return {
      month,
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
      // Every heading in order, empty ones too, with how many live envelopes sit under it.
      categories: [...state.categories.values()].map((c) => ({
        id: c.id, label: c.label, envelopes: [...state.envelopes.values()].filter((e) => e.category === c.id).length,
      })),
      balanced: snap.balanced,
      closed: state.months.get(month)?.closed === true,
      movesThisMonth: snap.view.moveCount,
      envelopes: snap.view.envelopes.map((e) => ({
        id: e.envelope.id,
        label: e.envelope.label,
        category: e.envelope.category,
        // A removed envelope this closed month keeps in its history.
        ...(e.removed ? { removed: true } : {}),
        planned: fmt(e.planned),
        funded: fmt(e.funded),
        spent: fmt(e.activity),
        left: fmt(e.available),
        carriedIn: fmt(e.carried),
        plannedExact: fmtExact(e.planned),
        // What a new month opens it at: the figure "from this month on" starts from.
        templateExact: fmtExact(e.envelope.template),
        fundedExact: fmtExact(e.funded),
        spentExact: fmtExact(e.activity),
        leftExact: fmtExact(e.available),
        adjustedBy: e.adjustedBy === 0 ? null : fmt(e.adjustedBy),
        overspent: e.overspent,
        // Action required while no figure has been given, with what could help give one.
        needsFigure: e.envelope.needsFigure === true,
        source: e.envelope.source ?? null,
        // The figure as it was given, when it was not given as a monthly: exact dollars, no sign.
        basis: e.envelope.basis
          ? { amount: fmtExact(e.envelope.basis.amount).replace('$', ''), per: e.envelope.basis.per }
          : null,
        // So a figure can be changed from its receipts. None for a removed envelope.
        hint: e.removed ? null : hintView(hintFor(state, e.envelope, month)),
        // Short only once it has a figure: a flagged envelope shows Action required, never Short.
        short: e.envelope.needsFigure || e.removed ? null : shortView(coverFor(state, snap.view, e.envelope.id, ctx.today)),
        // Saved in Savings: what it holds so far is what is left in it.
        sinking: sinkingView(state, e.envelope, month, e.available),
        bills: e.envelope.sinking ? [] : (billed.get(e.envelope.id) ?? []).map(billView),
      })),
      // The sinking envelopes against the savings account; null with none.
      savings: savingsView(state, ctx.today),
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
      toSort: {
        count: snap.toSort.count,
        unexplainedSpending: fmt(snap.toSort.outflow),
        moneyIn: fmt(snap.toSort.inflow),
        oldest: snap.toSort.oldest,
      },
      recurringWithoutARule: snap.recurring.map((r) => ({
        payee: r.payee, typical: fmt(r.typical), seenInMonths: r.months,
      })),
    };
  },
};

/**
 * An envelope.define that rewrites `env` with `change`, carrying every field it does not
 * name (needsFigure, source, basis and sinking among them). `figure` means a number was given:
 * the template becomes it, the flag goes, and the source and basis become `figure.source` and
 * `figure.basis` (none when absent: a figure given as a monthly drops an old yearly basis).
 */
export function redefine(env: Envelope, change: {
  label?: string; category?: CategoryId; rollover?: boolean; sinking?: SinkingGoal | null;
  figure?: { template: Cents; source?: string; basis?: Basis };
} = {}): NewEvent {
  const sinking = change.sinking === undefined ? env.sinking : change.sinking;
  const source = change.figure ? change.figure.source : env.source;
  const basis = change.figure ? change.figure.basis : env.basis;
  return {
    op: 'envelope.define', envelope: env.id,
    label: change.label ?? env.label, category: change.category ?? env.category,
    rollover: change.rollover ?? env.rollover,
    template: change.figure?.template ?? env.template, order: env.order,
    ...(sinking !== undefined ? { sinking } : {}),
    ...(env.needsFigure && !change.figure ? { needsFigure: true as const } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(basis !== undefined ? { basis } : {}),
  };
}

/** A sinking envelope's goal for get_month, as exact dollars: an editor round-trips them. */
function sinkingView(state: State, env: Envelope, month: Month, saved: Cents) {
  const g = goalFor(state, env, month);
  if (!g) return null;
  return {
    kind: g.kind,
    monthly: fmt(g.monthly), monthlyExact: fmtExact(g.monthly),
    goal: fmt(g.target), goalExact: fmtExact(g.target),
    saved: fmt(saved), savedExact: fmtExact(saved),
    by: g.by, byName: g.by ? monthName(g.by) : null, monthsLeft: g.monthsLeft, passed: g.passed,
    // An every goal's own estimate, as exact dollars; null without one, and for a goal by a date.
    estimate: g.estimate ? { cost: fmtExact(g.estimate.cost), everyYears: g.estimate.everyYears } : null,
  };
}

/** The check against Savings for get_month and Settings: the figures, and the words to say them in. */
export function savingsView(state: State, today: Day) {
  const c = savingsCheck(state, today);
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
      envelope: { type: 'string', description: 'Envelope id, e.g. daily' },
      month: { type: 'string' },
    },
    required: ['envelope'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const envelopeId = str(args['envelope'], 'envelope');
    const month = resolveMonth(state, args['month']);
    const view = monthView(state, month);
    if (!view) throw new ToolError(`${month} is not open`, 404);
    const e = view.envelopes.find((x) => x.envelope.id === envelopeId);
    if (!e) throw new ToolError(`no envelope ${envelopeId}`, 404);

    const clock = monthClock(month, ctx.today);
    const p = pace(view, clock, state).find((x) => x.envelope === envelopeId);
    const d = drift(state, month, 4).find((x) => x.envelope === envelopeId);

    // One entry per part that lands here. A split receipt shows its share as
    // `amount`, and the whole receipt as `of`, so the list adds up to `spent`.
    const txns = e.lines
      .map((line) => ({ line, t: state.txns.get(line.txnId)! }))
      .sort((a, b) => b.t.date.localeCompare(a.t.date))
      .map(({ line, t }) => ({
        date: t.date, payee: t.payee, amount: fmtExact(cents(-line.amount)), envelope: e.envelope.id,
        ...(line.split ? { of: fmtExact(t.amount) } : {}),
        // What an edit needs: the receipt itself, its whole amount, and every part, not just this one's.
        txn: t.id, amountCents: t.amount,
        parts: t.split ? t.split.map((p) => ({ envelope: p.envelope as string, amountCents: p.amount as number })) : null,
      }));

    return {
      month,
      envelope: e.envelope.id,
      label: e.envelope.label,
      category: e.envelope.category,
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
      forEnvelope: { type: 'string', description: 'The envelope that needs money.' },
      month: { type: 'string' },
    },
    required: ['forEnvelope'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const target = str(args['forEnvelope'], 'forEnvelope');
    const month = resolveMonth(state, args['month']);
    const view = monthView(state, month);
    if (!view) throw new ToolError(`${month} is not open`, 404);
    const clock = monthClock(month, ctx.today);
    const need = view.envelopes.find((e) => e.envelope.id === target);
    const shortfall = need && need.available < 0 ? cents(-need.available) : ZERO;
    return {
      month,
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
    'Search the ledger. Filter by month, envelope (an id, or __split for the split receipts themselves), ' +
    'payee text, or only what To sort holds. Every receipt is here, whichever envelope it is sorted into.',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      month: { type: 'string' },
      envelope: { type: 'string' },
      payeeContains: { type: 'string' },
      toSortOnly: { type: 'boolean' },
      limit: { type: 'number', description: 'Default 50.' },
    },
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const limit = Math.min(args['limit'] ? num(args['limit'], 'limit') : 50, 500);
    const month = args['month'] as string | undefined;
    const envelope = args['envelope'] as string | undefined;
    const contains = (args['payeeContains'] as string | undefined)?.toLowerCase();
    const held = toSort(state).missing;

    let rows = [...state.txns.values()];
    if (month) rows = rows.filter((t) => monthOf(t.date) === month);
    // The marker finds the split receipts themselves; an envelope finds receipts with a part in it.
    if (envelope) rows = rows.filter((t) => envelope === SPLIT ? t.envelope === SPLIT : partsOf(t).some((p) => p.envelope === envelope));
    if (args['toSortOnly']) rows = rows.filter((t) => inToSort(state, t));
    if (contains) rows = rows.filter((t) => `${t.payee} ${t.memo ?? ''}`.toLowerCase().includes(contains));
    rows.sort((a, b) => b.date.localeCompare(a.date));

    // Under an envelope filter only that envelope's share of a split counts; the whole receipt would count it twice.
    const share = (t: Txn): number[] => envelope && envelope !== SPLIT
      ? partsOf(t).filter((p) => p.envelope === envelope).map((p) => p.amount)
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
        amount: fmtExact(t.amount), envelope: t.envelope, setByHand: !!t.manual,
        // A split receipt's envelope is the marker; the parts say where it went.
        parts: t.split ? t.split.map((p) => ({ envelope: p.envelope, amount: fmtExact(p.amount) })) : null,
        // A split To sort holds for a part whose envelope is not here: those envelopes.
        ...(held.has(t.id) ? { missing: held.get(t.id) } : {}),
      })),
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
  /** When given, envelopes, categories and months read by name rather than by id. */
  state?: State,
): { id: string; at: string; who: Actor; what: string; why: string | null } {
  const why = (e as { why?: string }).why ?? null;
  // A name that has since gone falls back to the id: something, never nothing.
  // A removed envelope reads by its record's name.
  const env = (id: string) => state?.envelopes.get(id)?.label ?? state?.removedEnvelopes.get(id)?.label ?? id;
  const cat = (id: string) => state?.categories.get(id)?.label ?? id;
  // Where a rule sorts: an envelope, or money that is not spending.
  const into = (id: string) => id === TRANSFER ? 'a transfer' : id === INCOME ? 'income' : id === SPLIT ? 'a split' : env(id);
  const mon = (m: string) => state ? monthName(m) : m;
  // Without the state, or for a plan it does not know, the id stands in.
  const plan = (id: string) => state?.plans.get(id)?.title ?? id;
  let what: string;
  switch (e.op) {
    case 'assign': what = `set ${env(e.envelope)} to ${fmt(e.to)}`; break;
    case 'move': what = `moved ${fmt(e.amount)} from ${env(e.from)} to ${env(e.to)}`; break;
    case 'income.set': what = `set income to ${fmt(e.amount)}`; break;
    case 'month.open': what = `opened ${mon(e.month)}`; break;
    case 'txn.add': what = `imported ${e.txns.length} transactions${e.source ? ` from ${e.source}` : ''}`; break;
    case 'txn.sort':
      what = e.envelope === null ? 'took a receipt out of its envelope'
        : e.envelope === TRANSFER ? 'marked a receipt as a transfer'
        : e.envelope === INCOME ? 'marked a receipt as income'
        : `sorted a receipt into ${env(e.envelope)}`;
      break;
    case 'txn.split': {
      const parts = e.parts.map((p) => `${into(p.envelope)} ${fmtExact(cents(Math.abs(p.amount)))}`);
      const last = parts.pop();
      what = `split a receipt across ${parts.length ? `${parts.join(', ')} and ${last}` : last}`;
      break;
    }
    case 'rule.add': what = `added the rule "${e.match}" for ${into(e.envelope)}`; break;
    case 'rule.remove': what = 'removed a rule'; break;
    case 'envelope.define':
      what = e.sinking ? `saved ${env(e.envelope)} in Savings`
        : e.sinking === null ? `stopped saving ${env(e.envelope)} in Savings`
        : `set up the envelope ${e.label} under ${cat(e.category)}`;
      break;
    case 'envelope.remove': what = `removed envelope ${env(e.envelope)}`; break;
    case 'bill.set':
      what = e.date ? `set ${e.name} in ${env(e.envelope)} to ${billDateWords(e.date)}`
        : `cleared the date on ${e.name} in ${env(e.envelope)}`;
      break;
    case 'bill.remove': what = `removed the bill ${e.name} from ${env(e.envelope)}`; break;
    case 'category.add': what = `added the category ${e.label}`; break;
    case 'category.rename': what = `renamed a category to ${e.label}`; break;
    case 'category.move': what = `moved the category ${cat(e.category)} to place ${e.to + 1}`; break;
    case 'category.remove': what = `removed the category ${cat(e.category)}`; break;
    case 'account.balance': what = `noted account ${e.account} showed ${fmt(e.cents)} on ${shortDay(e.asOf)}`; break;
    case 'savings.account': what = e.account ? `chose account ${e.account} as Savings` : 'stopped keeping a savings account'; break;
    case 'txn.remove': what = 'removed a receipt from the ledger'; break;
    case 'household.locate':
      what = e.location ? `set where the household is to ${e.location.label}` : 'cleared where the household is'; break;
    case 'month.close': what = `${e.closed ? 'closed' : 'reopened'} ${mon(e.month)}`; break;
    case 'month.discard': what = `discarded ${mon(e.month)}`; break;
    case 'income.source.define': what = `recorded income "${e.label}"`; break;
    case 'income.source.remove': what = `removed income ${e.source}`; break;
    case 'household.claim': what = `started the household ${e.label}`; break;
    case 'member.add': what = `shared the household with ${e.member}`; break;
    case 'member.remove': what = `removed ${e.member} from the household`; break;
    case 'briefing.read': what = 'read the briefing'; break;
    case 'prediction.record': what = `forecast ${env(e.envelope)} for ${mon(e.month)}`; break;
    case 'thread.briefing': what = `wrote the briefing for ${(e.source ?? 'budget') === 'budget' ? 'the budget' : 'the household'}`; break;
    case 'thread.ask': what = `asked: ${e.question}`; break;
    case 'thread.note': what = `left a note: ${e.text}`; break;
    case 'thread.answer': what = 'answered a question'; break;
    case 'proposal.offer': what = `suggested: ${e.summary}`; break;
    case 'proposal.decide': what = `${e.decision === 'snoozed' ? 'put off' : e.decision} a suggestion`; break;
    case 'flag.seen': what = 'marked a change as seen'; break;
    case 'areas.set': what = `set the areas to ${e.areas.join(', ')}`; break;
    case 'areas.rename': what = `renamed the area ${e.from} to ${e.to}`; break;
    case 'areas.add': what = `added the area ${e.area}`; break;
    case 'areas.remove': what = `removed the area ${e.area}`; break;
    case 'areas.move': {
      // The place it reached, not the index asked for: a request past the end lands at the end.
      const list = state?.settings.areas;
      const last = list === undefined ? e.to : list.length - (areaIndex(list, e.area) >= 0 ? 1 : 0);
      what = `moved the area ${e.area} to place ${Math.min(e.to, last) + 1}`;
      break;
    }
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
    case 'plan.hand': {
      const h = state?.hands.get(e.id);
      what = !h ? `handed ${plan(e.plan)} to ${e.to}`
        : h.from === e.who ? `handed ${plan(e.plan)} to ${h.to}`
        : h.to === e.who ? `took ${plan(e.plan)} from ${h.from}`
        : `handed ${plan(e.plan)} from ${h.from} to ${h.to}`;
      break;
    }
    case 'plan.goal': what = e.goal ? `set ${plan(e.plan)} toward ${e.goal}` : `took the goal off ${plan(e.plan)}`; break;
    case 'goal.rename': what = `renamed the goal ${e.from} to ${e.to}`; break;
    case 'goal.remove': what = `removed the goal ${e.goal}`; break;
    case 'shelves.retire': what = 'retired the shelves into goals'; break;
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
    case 'calendar.appointment.change': {
      const w = e.was;
      what = e.start !== w.start || e.end !== w.end || e.allDay !== w.allDay ? `moved ${e.summary}` : `renamed ${w.summary} to ${e.summary}`;
      break;
    }
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
 * What a set of events would touch: which month, and which
 * envelopes. Two cards touching the same envelope in the same month are the
 * same decision asked twice, and only one of them may stand. `envelope` is the
 * one envelope the events define, when they define exactly one: the envelope a
 * press just added or changed, for the page to open.
 */
export function touches(events: readonly NewEvent[]): { month: Month | null; envelopes: string[]; envelope?: EnvelopeId } {
  let month: Month | null = null;
  const envelopes = new Set<string>();
  const defined: EnvelopeId[] = [];
  for (const e of events) {
    if ('month' in e && typeof e.month === 'string') month ??= e.month;
    if (e.op === 'move') { envelopes.add(e.from); envelopes.add(e.to); }
    if (e.op === 'assign') envelopes.add(e.envelope);
    if (e.op === 'envelope.define') defined.push(e.envelope);
  }
  return { month, envelopes: [...envelopes], ...(defined.length === 1 ? { envelope: defined[0]! } : {}) };
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
      month: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      amountCents: { type: 'number', description: 'Whole cents. $96.00 is 9600.' },
      why: { type: 'string', description: 'One line. This is what gets read the next morning.' },
      onlyWhileShort: { type: 'boolean', description: 'Refuse unless the envelope moved to is still short, so a cover is not made twice.' },
    },
    required: ['from', 'to', 'amountCents', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const month = resolveMonth(state, args['month']);
    const from = str(args['from'], 'from');
    const to = str(args['to'], 'to');
    const amount = money(args['amountCents'], 'amountCents');
    const why = str(args['why'], 'why');

    if (from === to) throw new ToolError('cannot move money to the same envelope');
    if (amount <= 0) throw new ToolError('amount must be positive');

    const view = monthView(state, month);
    if (!view) throw new ToolError(`${month} is not open`, 404);
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
      events: [{ op: 'move', month, from, to, amount, why }],
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
      month: { type: 'string' },
      envelope: { type: 'string' },
      toCents: { type: 'number' },
      why: { type: 'string' },
      onlyWhileShort: { type: 'boolean', description: 'Refuse unless the envelope is still short, so a cover assigned from a stale figure is not made twice.' },
    },
    required: ['envelope', 'toCents', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const month = resolveMonth(state, args['month']);
    const envelope = str(args['envelope'], 'envelope');
    const to = money(args['toCents'], 'toCents');
    const why = str(args['why'], 'why');

    const view = monthView(state, month);
    if (!view) throw new ToolError(`${month} is not open`, 404);
    const e = view.envelopes.find((x) => x.envelope.id === envelope);
    if (!e) throw new ToolError(`no envelope ${envelope}`, 404);
    // toCents is absolute and read from the page's figures: once the envelope is covered, a second
    // tap would set it again from a stale number, so it is refused instead (as move_money does).
    if (args['onlyWhileShort'] === true && e.available >= 0) {
      throw new ToolError(`${e.envelope.label} is no longer short`, 409);
    }

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
      // A figure set by hand is a figure, so the flag goes. The template is unchanged and is still
      // the public-data figure, so its source (and any basis) stays with it.
      events: [
        { op: 'assign', month, envelope, to, why },
        ...(e.envelope.needsFigure
          ? [redefine(e.envelope, {
            figure: {
              template: e.envelope.template,
              ...(e.envelope.source !== undefined ? { source: e.envelope.source } : {}),
              ...(e.envelope.basis !== undefined ? { basis: e.envelope.basis } : {}),
            },
          })] : []),
      ],
    }, new Date(`${ctx.today}T00:00:00Z`).toISOString());
  },
};

const sortReceipts: Tool = {
  name: 'sort_receipts',
  description:
    'Propose sorting receipts into envelopes, optionally adding rules so the same merchant is ' +
    'sorted the same way from now on. Choose an envelope id from the envelopes get_month lists, ' +
    'or __transfer / __income for money that is not spending, or __split to divide a receipt across several.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      assignments: {
        type: 'array',
        description: 'One entry per receipt.',
        items: {
          type: 'object',
          properties: {
            txnId: { type: 'string' },
            envelope: { type: 'string', description: 'An envelope id from get_month, or __transfer / __income, or __split to divide the receipt across several (then give parts).' },
            parts: {
              type: 'array',
              description: 'For __split only: at least two { envelope, amount } parts, amount in integer cents with the receipt\'s sign (spending is negative), adding up exactly to the receipt. An envelope appears once.',
              items: {
                type: 'object',
                properties: { envelope: { type: 'string' }, amount: { type: 'integer' } },
                required: ['envelope', 'amount'],
              },
            },
            alsoAddRuleMatching: { type: 'string', description: 'Optional payee substring to remember, at least 3 characters. With __split the rule means "always ask a person to divide".' },
            suggestedBy: { type: 'string', enum: ['claude'], description: 'Set only when a person is accepting an envelope Claude suggested.' },
          },
          required: ['txnId', 'envelope'],
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
    // A live envelope, or money that is not spending.
    const known = (e: string) => !isSpend(e) || state.envelopes.has(e);
    const missing = (e: string) => new ToolError(`no envelope ${e}`, 404);
    for (const item of raw as Record<string, unknown>[]) {
      const txnId = str(item['txnId'], 'txnId');
      const envelope = str(item['envelope'], 'envelope');
      const t = state.txns.get(txnId);
      if (!t) throw new ToolError(`no transaction ${txnId}`, 404);
      const by = item['suggestedBy'];
      if (by !== undefined && by !== 'claude') throw new ToolError('suggestedBy can only be "claude"');
      if (envelope === SPLIT) {
        // A split's amounts are a person's decision; there is nothing for Claude to have suggested.
        if (by) throw new ToolError('suggestedBy cannot be set on a split — its amounts are never Claude\'s');
        const rawParts = item['parts'];
        if (!Array.isArray(rawParts)) throw new ToolError('parts is required for a split');
        // Whole cents only: rounding a stray 6.5 would quietly move money, so checkParts refuses it instead.
        const parts: SplitPart[] = (rawParts as Record<string, unknown>[]).map((p) => {
          const n = num(p['amount'], 'a part\'s amount');
          return { envelope: str(p['envelope'], 'a part\'s envelope') as EnvelopeId, amount: Number.isInteger(n) ? cents(n) : n as Cents };
        });
        for (const p of parts) if (!known(p.envelope)) throw missing(p.envelope);
        const problem = splitProblem(parts, t.amount, state.envelopes, (e) => missing(e).message);
        if (problem) throw new ToolError(problem);
        events.push({ op: 'txn.split', txn: txnId, parts });
        // A second split replaces the first, so say so rather than pretending it is new.
        effects.push(`${t.date} ${t.payee} ${fmtExact(t.amount)} is ${t.split ? 'divided again' : 'split'}: ` +
          parts.map((p) => `${filedLabel(state, p.envelope)} ${fmtExact(cents(Math.abs(p.amount)))}`).join(', '));
      } else {
        if (!known(envelope)) throw missing(envelope);
        events.push({ op: 'txn.sort', txn: txnId, envelope, manual: true, ...(by ? { suggestedBy: 'claude' as const } : {}) });
        // A sort clears the parts, so a split receipt says that it is no longer one.
        effects.push(`${t.date} ${t.payee} ${fmtExact(t.amount)} ${t.split ? 'is no longer split; goes into' : 'goes into'} ${filedLabel(state, envelope)}`);
      }

      const ruleMatch = item['alsoAddRuleMatching'];
      if (typeof ruleMatch === 'string' && ruleMatch.trim()) {
        const match = ruleMatch.trim();
        // The match need not be in this receipt's payee — a person may type a broader rule — so only
        // length is refused here; a clash with history is a warning on the card, not a refusal.
        let problem = ruleProblem(state, null, match, envelope);
        if (problem === 'a rule needs at least 3 characters') throw new ToolError(problem);
        // Re-using a rule's match must not hide a clash with history: scan as if no rule held it.
        const existing = problem === 'already a rule'
          ? state.rules.find((r) => r.match.trim().toLowerCase() === match.toLowerCase())
          : undefined;
        if (existing) problem = ruleProblem({ ...state, rules: [] }, null, match, envelope);
        const wouldMatch = [...state.txns.values()].filter((x) =>
          `${x.payee} ${x.memo ?? ''}`.toLowerCase().includes(match.toLowerCase())).length;
        events.push({ op: 'rule.add', rule: `r-${match.toLowerCase().replace(/\W+/g, '-')}`, match, envelope });
        const s = wouldMatch === 1 ? '' : 's';
        effects.push(envelope === SPLIT
          ? `Rule "${match}" would ask a person to divide ${wouldMatch} receipt${s} from now on`
          : `Rule "${match}" would cover ${wouldMatch} transaction${s} from now on`);
        if (existing) effects.push(`Replaces the rule "${existing.match}" → ${filedLabel(state, existing.envelope)}`);
        if (problem?.startsWith('already filed under ')) {
          const clash = [...state.txns.values()].filter((x) => x.envelope !== null && x.envelope !== envelope
            && `${x.payee} ${x.memo ?? ''}`.toLowerCase().includes(match.toLowerCase())).length;
          effects.push(`Rule "${match}" also matches ${clash} receipt${clash === 1 ? '' : 's'} filed elsewhere (${problem.slice('already filed under '.length)})`);
        }
      }
    }
    return ctx.proposals.put({
      tool: 'sort_receipts',
      who: ctx.who,
      summary: `Sort ${raw.length} receipt${raw.length === 1 ? '' : 's'}`,
      effects,
      events,
    }, new Date(`${ctx.today}T00:00:00Z`).toISOString());
  },
};

const openMonth: Tool = {
  name: 'open_month',
  description:
    "Propose opening a month, seeding every envelope from its template, and each envelope saved " +
    'in Savings at what its goal needs that month. This writes ' +
    'the plan of record, which is then immutable — later changes are adjustments on top of it. ' +
    'The income comes from the recorded income sources by counting their actual paydays in that ' +
    'month, so a fortnightly salary opens a three-paycheque month at the right figure. Pass ' +
    'incomeCents only to override it — a bonus, or a month you already know is different.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      month: { type: 'string' },
      incomeCents: {
        type: 'number',
        description: 'Optional. Overrides what the recorded income sources say this month pays.',
      },
    },
    required: ['month'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const month = str(args['month'], 'month');
    if (state.months.has(month)) throw new ToolError(`${month} is already open`);

    /**
     * The income is counted, not carried forward.
     *
     * Reusing last month's figure is what makes a three-paycheque month open
     * short by a whole paycheque — the sources know which months those are, and
     * asking a person to remember is asking them to get it wrong twice a year.
     */
    const sources = sourcesFor(state);
    const derived = incomeFor(sources, month);
    const override = args['incomeCents'] != null ? money(args['incomeCents'], 'incomeCents') : null;
    if (override === null && !sources.length) {
      throw new ToolError(
        'No income is recorded, so there is nothing to open the month at. '
        + 'Record what comes in and how often, and the month will open at whatever that month '
        + 'actually pays.');
    }
    const income = override ?? derived.total;

    // A sinking envelope is proposed at what its goal needs this month, not
    // its template: the goal is the reason it exists. People may fund it
    // differently once the month is open, as they may any envelope.
    const sinking = sinkingPlan(state, month);
    const planned = cents([...state.envelopes.values()].reduce((n, e) => n + (sinking.get(e.id) ?? e.template), 0));
    const seeded = state.envelopes.size - sinking.size;
    const effects = [
      sinking.size
        ? `${seeded} envelope${seeded === 1 ? '' : 's'} seeded from the template, ${sinking.size} from ${sinking.size === 1 ? 'its goal' : 'their goals'}`
        : `${state.envelopes.size} envelopes seeded from the template`,
      `Planned ${fmtExact(planned)} against income ${fmtExact(income)}`,
      `To assign would be ${fmtExact(sub(income, planned))}`,
    ];

    // Say where the number came from. A figure that appeared by itself is one
    // nobody checks, and this is the one worth checking.
    if (override !== null) {
      effects.push(sources.length
        ? `Using ${fmtExact(income)} rather than the ${fmtExact(derived.total)} the recorded income adds up to`
        : `Using ${fmtExact(income)} for this month only — no income is recorded`);
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
      effects.push(`${state.envelopes.get(id)!.label} planned at ${fmtExact(amount)}, what its goal needs this month`);
    }
    return ctx.proposals.put({
      tool: 'open_month',
      who: ctx.who,
      summary: `Open ${month}`,
      effects,
      events: [{ op: 'month.open', month, income, ...(sinking.size ? { plan: Object.fromEntries(sinking) } : {}) }],
    }, new Date(`${ctx.today}T00:00:00Z`).toISOString());
  },
};

// ─── registry ─────────────────────────────────────────────────────────────────

const restoreTxn: Tool = {
  name: 'restore_transaction',
  description:
    'Propose putting a deleted receipt back in the ledger, in the envelope it had or another. ' +
    'Use when someone deleted a transaction that should have gone into an envelope instead. ' +
    'Returns a proposal for approval — it does not restore anything on its own.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      txnId: { type: 'string', description: 'The receipt id, as shown in the activity entry.' },
      envelope: { type: 'string', description: 'Optional. The envelope id to put it in on the way back, or __transfer / __income.' },
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

    const given = typeof args['envelope'] === 'string' && args['envelope'] ? args['envelope'] : null;
    if (given === SPLIT) throw new ToolError('restore it first, then split it');
    if (given !== null && isSpend(given) && !state.envelopes.has(given)) throw new ToolError(`no envelope ${given}`, 404);
    // Put back whole: the envelope given, else the one it arrived with (To sort holds it if that has gone).
    const envelope = given ?? (original.envelope === SPLIT ? null : original.envelope);

    // Same id, so putting it back cannot create a second copy of the receipt.
    const { split: _split, ...whole } = original;
    const txn: Txn = { ...whole, envelope };
    return ctx.proposals.put({
      tool: 'restore_transaction',
      who: ctx.who,
      summary: `Put back ${original.payee} ${fmtExact(original.amount)}`,
      effects: [
        `${original.date} ${original.payee} ${fmtExact(original.amount)} returns to the ledger`,
        envelope === null || (isSpend(envelope) && !state.envelopes.has(envelope))
          ? 'It will have no envelope until someone sorts it'
          : `It lands in ${filedLabel(state, envelope)}`,
      ],
      events: [{ op: 'txn.add', txns: [txn], source: 'restored' }],
    }, ctx.today);
  },
};

// ─── shaping the budget itself ───────────────────────────────────────────────

/**
 * Where an envelope goes: a category that is here (`category`, its id), or a new one by name
 * (`newCategory`), with the `category.add` that makes it. Exactly one of the two; with
 * `optional`, neither is none. A name a category here already has is refused, never merged.
 */
function placeArg(state: State, args: Record<string, unknown>, optional = false):
  { id: CategoryId; label: string; add: NewEvent | null } | null {
  const given = (k: string) => typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string) : null;
  const id = given('category');
  const typed = given('newCategory');
  if (!id && !typed && optional) return null;
  if (!id === !typed) throw new ToolError('Choose a category, or name a new one.');
  if (id) {
    const c = state.categories.get(id);
    if (!c) throw new ToolError(`no category ${id}`, 404);
    return { id, label: c.label, add: null };
  }
  const label = typed!.trim();
  const taken = [...state.categories.values()].find((c) => nameKey(c.label) === nameKey(label));
  if (taken) throw new ToolError(`There is already a category called ${taken.label}. Choose it from the list.`, 409);
  const made = categoryIdFor(state, label);
  return { id: made, label, add: { op: 'category.add', category: made, label } };
}

/** Refused when another live envelope (not `id`) has this name, case and spaces ignored. */
function envelopeNameFree(state: State, label: string, id?: EnvelopeId): void {
  const taken = [...state.envelopes.values()].find((x) => x.id !== id && nameKey(x.label) === nameKey(label));
  if (taken) throw new ToolError(`There is already an envelope called ${taken.label}.`, 409);
}

/** Refused when another category (not `id`) has this name, case and spaces ignored. */
function categoryNameFree(state: State, label: string, id?: CategoryId): void {
  const taken = [...state.categories.values()].find((x) => x.id !== id && nameKey(x.label) === nameKey(label));
  if (taken) throw new ToolError(`There is already a category called ${taken.label}.`, 409);
}

const categoryOr404 = (state: State, id: string) => {
  const c = state.categories.get(id);
  if (!c) throw new ToolError(`no category ${id}`, 404);
  return c;
};

const CATEGORY_INPUT = {
  category: { type: 'string', description: 'The id of a category heading get_month lists. Give this or newCategory.' },
  newCategory: { type: 'string', description: 'The name of a new category heading, added in the same step. Give this or category.' },
};

const addEnvelope: Tool = {
  name: 'add_envelope',
  description:
    'Propose adding an envelope under a category heading: one get_month lists, or a new one named here and ' +
    'added with it. It starts at $0 planned and $0 funded, and every month after opens it at $0 until it is given ' +
    'a figure with set_envelope_figure. Its id is made from its name and never changes; a name another envelope has, ' +
    'case ignored, is refused.',
  kind: 'write',
  input: {
    type: 'object',
    properties: { label: { type: 'string', description: 'Its name, as the household reads it.' }, ...CATEGORY_INPUT },
    required: ['label'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const label = str(args['label'], 'label').trim();
    envelopeNameFree(state, label);
    const place = placeArg(state, args)!;
    const envelope = envelopeIdFor(state, label);
    // Last in its category, and after every envelope there is, so no two share a place.
    const order = Math.max(-1, ...[...state.envelopes.values()].map((e) => e.order)) + 1;
    return ctx.proposals.put({
      tool: 'add_envelope', who: ctx.who,
      summary: `Add ${label} under ${place.label}`,
      effects: [
        ...(place.add ? [`A new category, ${place.label}`] : []),
        `A new envelope, ${label}, last under ${place.label}, at $0 until it is given a figure`,
      ],
      events: [
        ...(place.add ? [place.add] : []),
        { op: 'envelope.define', envelope, label, category: place.id, template: cents(0), rollover: true, order },
      ],
    }, ctx.today);
  },
};

const changeEnvelope: Tool = {
  name: 'change_envelope',
  description:
    'Propose renaming an envelope, putting it under another category heading, or both. Its id, figure, funding, ' +
    'goal, bills and receipts stay as they are: a rename changes only the name. A new heading can be named with ' +
    'newCategory and is added in the same step.',
  kind: 'write',
  input: {
    type: 'object',
    properties: { envelope: { type: 'string' }, label: { type: 'string', description: 'Its new name.' }, ...CATEGORY_INPUT },
    required: ['envelope'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const id = str(args['envelope'], 'envelope');
    const env = state.envelopes.get(id);
    if (!env) throw new ToolError(`no envelope ${id}`, 404);
    const label = typeof args['label'] === 'string' && args['label'].trim() ? args['label'].trim() : env.label;
    envelopeNameFree(state, label, id);
    const place = placeArg(state, args, true) ?? { id: env.category, label: state.categories.get(env.category)?.label ?? env.category, add: null };
    const renamed = label !== env.label;
    const moved = place.id !== env.category;
    if (!renamed && !moved) throw new ToolError('nothing would change');
    return ctx.proposals.put({
      tool: 'change_envelope', who: ctx.who,
      summary: renamed && moved ? `Rename ${env.label} to ${label} and move it under ${place.label}`
        : renamed ? `Rename ${env.label} to ${label}` : `Move ${env.label} under ${place.label}`,
      effects: [
        ...(place.add ? [`A new category, ${place.label}`] : []),
        ...(renamed ? [`${env.label} is called ${label} from now on`] : []),
        ...(moved ? [`${label} sits under ${place.label}`] : []),
        'Its figure, its money and its receipts stay as they are',
      ],
      events: [...(place.add ? [place.add] : []), redefine(env, { label, category: place.id })],
    }, ctx.today);
  },
};

const addCategory: Tool = {
  name: 'add_category',
  description:
    'Propose adding a category: a heading envelopes sit under, added last. It starts empty. ' +
    'A name another category has, case ignored, is refused.',
  kind: 'write',
  input: { type: 'object', properties: { label: { type: 'string', description: 'Its name.' } }, required: ['label'] },
  run(args, ctx) {
    const state = ctx.store.state;
    const label = str(args['label'], 'label').trim();
    categoryNameFree(state, label);
    return ctx.proposals.put({
      tool: 'add_category', who: ctx.who,
      summary: `Add the category ${label}`,
      effects: [`${label} is added last, with no envelopes yet`],
      events: [{ op: 'category.add', category: categoryIdFor(state, label), label }],
    }, ctx.today);
  },
};

const renameCategory: Tool = {
  name: 'rename_category',
  description:
    'Propose renaming a category heading. The envelopes under it stay under it, and no money moves.',
  kind: 'write',
  input: {
    type: 'object',
    properties: { category: { type: 'string', description: 'The id get_month lists.' }, label: { type: 'string', description: 'Its new name.' } },
    required: ['category', 'label'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const c = categoryOr404(state, str(args['category'], 'category'));
    const label = str(args['label'], 'label').trim();
    if (label === c.label) throw new ToolError('nothing would change');
    categoryNameFree(state, label, c.id);
    return ctx.proposals.put({
      tool: 'rename_category', who: ctx.who,
      summary: `Rename ${c.label} to ${label}`,
      effects: [`${c.label} is called ${label} from now on; its envelopes stay under it`],
      events: [{ op: 'category.rename', category: c.id, label }],
    }, ctx.today);
  },
};

const moveCategory: Tool = {
  name: 'move_category',
  description:
    'Propose moving a category heading one place up or down the list, its envelopes with it. ' +
    'The first cannot go up and the last cannot go down.',
  kind: 'write',
  input: {
    type: 'object',
    properties: { category: { type: 'string', description: 'The id get_month lists.' }, direction: { type: 'string', enum: ['up', 'down'] } },
    required: ['category', 'direction'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const c = categoryOr404(state, str(args['category'], 'category'));
    const direction = args['direction'];
    if (direction !== 'up' && direction !== 'down') throw new ToolError("direction is 'up' or 'down'");
    const at = [...state.categories.keys()].indexOf(c.id);
    if (direction === 'up' && at === 0) throw new ToolError(`${c.label} is already first.`, 409);
    if (direction === 'down' && at === state.categories.size - 1) throw new ToolError(`${c.label} is already last.`, 409);
    const to = direction === 'up' ? at - 1 : at + 1;
    return ctx.proposals.put({
      tool: 'move_category', who: ctx.who,
      summary: `Move ${c.label} ${direction}`,
      effects: [`${c.label} becomes number ${to + 1} of ${state.categories.size}, its envelopes with it`],
      events: [{ op: 'category.move', category: c.id, to }],
    }, ctx.today);
  },
};

const removeCategory: Tool = {
  name: 'remove_category',
  description:
    'Propose removing a category heading that has no envelopes under it. One that still has envelopes is refused: ' +
    'move them under another category, or remove them, first.',
  kind: 'write',
  input: { type: 'object', properties: { category: { type: 'string', description: 'The id get_month lists.' } }, required: ['category'] },
  run(args, ctx) {
    const state = ctx.store.state;
    const c = categoryOr404(state, str(args['category'], 'category'));
    if ([...state.envelopes.values()].some((e) => e.category === c.id)) throw new ToolError('Move its envelopes first.', 409);
    return ctx.proposals.put({
      tool: 'remove_category', who: ctx.who,
      summary: `Remove the category ${c.label}`,
      effects: [`${c.label} goes from the list`],
      events: [{ op: 'category.remove', category: c.id }],
    }, ctx.today);
  },
};

/** ruleProblem's words that are about the request itself; the rest are about what is already here. */
const RULE_INPUT_PROBLEMS: ReadonlySet<string> = new Set(['a rule needs at least 3 characters', 'not in the payee']);

const addRule: Tool = {
  name: 'add_rule',
  description:
    'Propose a rule: a receipt imported from now on whose payee or memo contains `match` (case ignored) is sorted ' +
    'into `envelope`, an envelope id get_month lists, or __transfer / __income, or __split to have a person divide ' +
    'it. Receipts already here stay where they are. Give txnId when the rule comes from one receipt, and the match ' +
    'must then be in its payee. Refused when a rule already has the match, or when it would have caught receipts ' +
    'sorted somewhere else.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      match: { type: 'string', description: 'Text in the payee, at least 3 characters.' },
      envelope: { type: 'string' },
      txnId: { type: 'string', description: 'Optional. The receipt the rule was seen on.' },
    },
    required: ['match', 'envelope'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const match = str(args['match'], 'match').trim();
    const envelope = str(args['envelope'], 'envelope');
    if (isSpend(envelope) && !state.envelopes.has(envelope)) throw new ToolError(`no envelope ${envelope}`, 404);
    const txnId = typeof args['txnId'] === 'string' && args['txnId'] ? args['txnId'] : null;
    const t = txnId === null ? null : state.txns.get(txnId);
    if (t === undefined) throw new ToolError(`no transaction ${txnId}`, 404);
    const problem = ruleProblem(state, t?.payee ?? null, match, envelope);
    if (problem) throw new ToolError(problem, RULE_INPUT_PROBLEMS.has(problem) ? 400 : 409);

    const base = `r-${match.toLowerCase().replace(/\W+/g, '-')}`;
    let rule = base;
    for (let n = 2; state.rules.some((r) => r.id === rule); n++) rule = `${base}-${n}`;
    const already = [...state.txns.values()].filter((x) =>
      `${x.payee} ${x.memo ?? ''}`.toLowerCase().includes(match.toLowerCase())).length;
    const into = filedLabel(state, envelope);
    return ctx.proposals.put({
      tool: 'add_rule', who: ctx.who,
      summary: envelope === SPLIT ? `Always ask to divide "${match}"` : `Remember "${match}" for ${into}`,
      effects: [
        envelope === SPLIT
          ? `From now on, a receipt matching "${match}" waits for a person to divide it`
          : `From now on, a receipt matching "${match}" goes into ${into}`,
        already
          ? `${already} receipt${already === 1 ? '' : 's'} here already match${already === 1 ? 'es' : ''} it and stay${already === 1 ? 's' : ''} where ${already === 1 ? 'it is' : 'they are'}`
          : 'No receipt here matches it yet',
      ],
      events: [{ op: 'rule.add', rule, match, envelope }],
    }, ctx.today);
  },
};

/** An estimate as a caller gives it: null, or no cost, is none. */
function estimateArg(x: unknown): SinkingEstimate | null {
  if (x === null) return null;
  if (typeof x !== 'object' || Array.isArray(x)) throw new ToolError('estimate is { costCents, everyYears }, or null for none');
  const e = x as { costCents?: unknown; everyYears?: unknown };
  if (e.costCents == null || num(e.costCents, 'costCents') === 0) return null;
  const cost = money(e.costCents, 'costCents');
  if (cost < 0) throw new ToolError('an estimate costs something, not less than nothing');
  const everyYears = num(e.everyYears, 'everyYears');
  if (everyYears <= 0 || everyYears > 100) throw new ToolError('how often it comes round is more than none and at most every 100 years');
  return { cost, everyYears };
}

const setSinkingGoal: Tool = {
  name: 'set_sinking_goal',
  description:
    'Propose saving an envelope in Savings toward a goal, changing its goal, or making it an ordinary envelope ' +
    "again. Goal 'every': every so often, set aside from its own estimate, a cost and how many years " +
    "until it comes round (tyres $1,200 every 4 years is $25 a month); leaving estimate out keeps the one it has, " +
    "and null (or costCents null) is none. Goal " +
    "'by': a target by a month (targetCents, by YYYY-MM), set aside as what is left over the months left. Such an " +
    'envelope always rolls over, and each new month is planned at what its goal needs. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      envelope: { type: 'string' },
      goal: { type: 'string', enum: ['every', 'by', 'none'] },
      targetCents: { type: 'number', description: "For 'by': what to have saved." },
      by: { type: 'string', description: "For 'by': the month to have it by, YYYY-MM." },
      estimate: {
        type: ['object', 'null'],
        description: "For 'every': what it costs and how often it comes round. Null for none.",
        properties: {
          costCents: { type: ['number', 'null'] },
          everyYears: { type: 'number' },
        },
      },
    },
    required: ['envelope', 'goal'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const env = state.envelopes.get(str(args['envelope'], 'envelope'));
    if (!env) throw new ToolError(`no envelope ${String(args['envelope'])}`, 404);
    const kind = args['goal'];
    if (kind !== 'every' && kind !== 'by' && kind !== 'none') throw new ToolError("goal is 'every', 'by' or 'none'");
    // This month if it is open, else the latest that is: what the goal is worked out against.
    const month = state.months.has(monthOf(ctx.today)) ? monthOf(ctx.today)
      : latestMonth(state) ?? monthOf(ctx.today);

    let goal: SinkingGoal | null = null;
    if (kind === 'by') {
      const target = money(args['targetCents'], 'targetCents');
      if (target <= 0) throw new ToolError('a goal by a date needs a target');
      const by = str(args['by'], 'by');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(by)) throw new ToolError('by is a month, YYYY-MM');
      if (by < month) throw new ToolError(`${monthName(by)} has already gone by`);
      goal = { kind: 'by', target, by };
    } else if (kind === 'every') {
      const raw = args['estimate'];
      // Left out, an every goal keeps the estimate it has.
      const estimate = raw === undefined ? (env.sinking?.kind === 'every' ? env.sinking.estimate : null) : estimateArg(raw);
      goal = { kind: 'every', estimate };
    }
    if (args['estimate'] !== undefined && kind !== 'every') throw new ToolError("an estimate is for a goal of 'every'");

    if (JSON.stringify(goal ?? null) === JSON.stringify(env.sinking ?? null)) throw new ToolError('nothing would change');
    const events: NewEvent[] = [redefine(env, { sinking: goal })];

    const effects: string[] = [];
    if (!goal) {
      effects.push(`${env.label} becomes an ordinary envelope; what it holds stays in it`);
    } else if (goal.kind === 'every') {
      const e = goal.estimate;
      effects.push(e
        ? `${env.label} is saved in Savings: ${fmtExact(everyMonthly([e]))} a month, toward ${fmtExact(e.cost)} ${everyWords(e.everyYears)}`
        : `${env.label} is saved in Savings, with no estimate yet, so nothing is set aside for it`);
    } else {
      const saved = carriedInto(state, month, env.id);
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

/**
 * What removing an envelope does to its receipts and rules, in one sentence: "Its 12 receipts
 * from this month go back to To sort, and the rule "EXAMPLE GYM" goes with it."
 */
function removeWords(n: number, allThisMonth: boolean, rules: readonly string[]): string {
  const named = rules.map((m) => `"${m}"`);
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)!}` : named[0] ?? '';
  const ruleWords = !rules.length ? '' : rules.length === 1 ? `the rule ${list} goes with it` : `the rules ${list} go with it`;
  if (!n) return ruleWords ? `No receipts go back to To sort, and ${ruleWords}.` : 'No receipts go back to To sort.';
  const when = allThisMonth ? 'from this month' : 'from months not yet closed';
  const receipts = `Its ${n} receipt${n === 1 ? '' : 's'} ${when} ${n === 1 ? 'goes' : 'go'} back to To sort`;
  return ruleWords ? `${receipts}, and ${ruleWords}.` : `${receipts}.`;
}

const removeEnvelope: Tool = {
  name: 'remove_envelope',
  description:
    'Propose removing an envelope from the budget. Its receipts are not deleted: those in months ' +
    'already closed stay in that history under its name, and the rest go back to To sort. The rules ' +
    'that sort into it and its bills go with it, and its id is never given again. Requires a reason.',
  kind: 'write',
  input: {
    type: 'object',
    properties: { envelope: { type: 'string' }, why: { type: 'string' } },
    required: ['envelope', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const envelope = str(args['envelope'], 'envelope');
    const why = str(args['why'], 'why');
    const env = state.envelopes.get(envelope);
    if (!env) throw new ToolError(`no envelope ${envelope}`, 404);

    // The receipts that go back to To sort: those with a part in it, in a month not closed now.
    // A split receipt counts once, however many of its parts were in here.
    const back = [...state.txns.values()].filter((t) =>
      partsOf(t).some((p) => p.envelope === env.id) && state.months.get(monthOf(t.date))?.closed !== true);
    const thisMonth = monthOf(ctx.today);
    const rules = state.rules.filter((r) => r.envelope === env.id);
    const bills = [...state.bills.values()].filter((b) => b.envelope === env.id);

    return ctx.proposals.put({
      tool: 'remove_envelope', who: ctx.who,
      summary: `Remove ${env.label}`,
      effects: [
        `${env.label} disappears from the budget`,
        removeWords(back.length, back.every((t) => monthOf(t.date) === thisMonth), rules.map((r) => r.match)),
        ...bills.map((b) => `Its bill ${b.name} goes with it.`),
        'Months already closed keep its receipts under its name',
      ],
      events: [
        ...rules.map((r): NewEvent => ({ op: 'rule.remove', rule: r.id })),
        { op: 'envelope.remove', envelope, why },
      ],
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
      month: { type: 'string' },
      closed: { type: 'boolean', description: 'false reopens it' },
      why: { type: 'string' },
    },
    required: ['month', 'closed', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const month = str(args['month'], 'month');
    const why = str(args['why'], 'why');
    const closed = args['closed'] !== false;
    const plan = state.months.get(month);
    if (!plan) throw new ToolError(`${month} is not open`, 404);
    if (!!plan.closed === closed) {
      throw new ToolError(closed ? 'that month is already closed' : 'that month is already open');
    }

    const view = monthView(state, month);
    const unsorted = [...state.txns.values()]
      .filter((t) => monthOf(t.date) === month && inToSort(state, t)).length;

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
      events: [{ op: 'month.close', month, closed, why }],
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
    properties: { month: { type: 'string' }, why: { type: 'string' } },
    required: ['month', 'why'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const month = str(args['month'], 'month');
    const why = str(args['why'], 'why');
    const plan = state.months.get(month);
    if (!plan) throw new ToolError(`${month} is not open`, 404);
    if (plan.adjustments.length) {
      throw new ToolError(`${month} has been adjusted ${plan.adjustments.length} times — close it instead`);
    }

    // Deliberately not a spending check. Receipts land in a month whether it is
    // open or not, so a freshly opened month already "has spending against it".
    // What makes a month lived in is what was decided in it, and that is the
    // adjustments above.
    const later = [...state.months.keys()].filter((m) => m > month).sort();
    if (later.length) {
      // A later month may be carrying a balance out of this one.
      throw new ToolError(`${later.join(', ')} come after it — discard those first`);
    }

    return ctx.proposals.put({
      tool: 'discard_month', who: ctx.who,
      summary: `Discard ${month}`,
      effects: [
        `${month} stops being open, as though it had never been opened`,
        'No money was assigned or moved in it, so no decision is lost',
        'Every receipt stays exactly where it is',
        'The record that it was opened, and discarded, stays in the log',
      ],
      events: [{ op: 'month.discard', month, why }],
    }, ctx.today);
  },
};

// ─── income ──────────────────────────────────────────────────────────────────

const FREQ = ['monthly', 'semimonthly', 'biweekly', 'weekly', 'annual', 'once'] as const;

const planIncome: Tool = {
  name: 'plan_income',
  description:
    'What income the budget expects over the coming months, and what a change would do. Pass ' +
    '`imagine` to add a hypothetical job or raise without recording anything — this is a ' +
    'calculation, not a change, and it writes nothing. Counts real paydays, so a fortnightly ' +
    'salary shows the months that carry a third paycheque.',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
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
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const from = typeof args['from'] === 'string' && args['from'] ? args['from'] : monthOf(ctx.today);
    const howMany = Math.min(24, Math.max(1, Number(args['months'] ?? 6)));

    const real = sourcesFor(state);
    const imagined: IncomeSource[] = (Array.isArray(args['imagine']) ? args['imagine'] : [])
      .map((raw, i) => {
        const r = raw as Record<string, unknown>;
        const frequency = str(r['frequency'], 'frequency');
        if (!(FREQ as readonly string[]).includes(frequency)) throw new ToolError(`unknown frequency ${frequency}`);
        return {
          id: `imagined-${i}`, label: str(r['label'], 'label'),
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
    const planned = [...state.envelopes.values()].reduce((n, e) => add(n, e.template), ZERO);

    return {
      from, months: howMany,
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
    'Propose recording an income — a salary or any regular payment — as part of the budget\'s plan. ' +
    'Give what arrives each payday and how often, never a monthly equivalent: dividing a ' +
    'fortnightly wage by twelve loses the months that carry a third payment.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      earner: { type: 'string', description: 'Whose income it is.' },
      amountCents: { type: 'number', description: 'What arrives each payday.' },
      frequency: { type: 'string', enum: [...FREQ] },
      anchor: { type: 'string', description: 'YYYY-MM-DD of a real payday.' },
      until: { type: 'string', description: 'Optional YYYY-MM, when it is known to stop.' },
    },
    required: ['label', 'amountCents', 'frequency', 'anchor'],
  },
  run(args, ctx) {
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
      id, label, who: earner, amount,
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
        op: 'income.source.define', source: id, label, earner, amount,
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
        `${s.label} stops counting towards what the budget expects`,
        'Months already open keep the income they opened with',
      ],
      events: [{ op: 'income.source.remove', source: id, why }],
    }, ctx.today);
  },
};

const setLocation: Tool = {
  name: 'set_location',
  description:
    'Propose recording where the household is. Electricity and property tax are priced by place ' +
    'while groceries are not, and recording the place makes public cost data addressable. Leave ' +
    'label out to clear it.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'The place, e.g. "Springfield, IL". Omit to clear the location.' },
      state: { type: 'string', description: 'Two-letter state code.' },
      postal: { type: 'string', description: 'ZIP — what rent indices are keyed on.' },
      stateFips: { type: 'string', description: 'Census state FIPS, e.g. 35 for New Mexico.' },
      countyFips: { type: 'string', description: 'Census county FIPS, e.g. 043 for Sandoval.' },
      why: { type: 'string' },
    },
    required: ['why'],
  },
  async run(args, ctx) {
    const why = str(args['why'], 'why');

    const label = typeof args['label'] === 'string' ? args['label'].trim() : '';
    let location: Location | null = label ? {
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
      tool: 'set_location', who: ctx.who,
      summary: location ? `Say the household is in ${location.label}` : 'Clear where the household is',
      effects: location
        ? [`The household is in ${location.label}`,
           ...found,
           location.postal ? `Rent data can be looked up for ZIP ${location.postal}`
                           : 'No ZIP recorded, so rent data cannot be looked up',
           location.countyFips ? 'County recorded, so Census figures can be looked up'
                               : 'No county recorded, so Census figures cannot be looked up',
           location.state ? `State recorded, so the electricity figure for ${location.state} can be looked up`
                          : 'No state recorded, so the electricity figure cannot be looked up']
        : ['The household stops being tied to a place',
           'Local costs cannot be looked up until a place is given again'],
      events: [{ op: 'household.locate', location, why }],
    }, ctx.today);
  },
};

const localCosts: Tool = {
  name: 'look_up_local_costs',
  description:
    'What public data says things cost where the household is. Reads Zillow\'s rent index and, when a ' +
    'Census key is configured, county figures for rent and property tax. Every figure comes back ' +
    'with its source, the area it was measured over, when, and what it cannot tell you. These are ' +
    'measurements of a place, never a prediction about this household — read them as evidence.',
  kind: 'read',
  async run(args, ctx) {
    const location = ctx.store.state.location;
    if (!location) throw new ToolError('the household has no location recorded, so there is nowhere to look up');
    const found = await lookUp(location, {
      censusKey: resolvedEnv()['CENSUS_API_KEY'], eiaKey: resolvedEnv()['EIA_API_KEY'],
    });
    return {
      location: location.label,
      found: found.estimates.map((e) => ({
        envelope: e.envelope,
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
  input: { type: 'object', properties: {} },
};

const seedFromLocation: Tool = {
  name: 'seed_from_location',
  description:
    'Propose starting figures for the envelopes that public data can speak to, using where the ' +
    'household is. Covers only what is actually measured — rent, and property tax where a ' +
    'Census key is configured — so it is a starting point for a few place-bound envelopes, not a ' +
    'budget. Every figure comes with its source. Nothing is applied until you approve it.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      only: {
        type: 'array', items: { type: 'string' },
        description: 'Optional. Limit to these envelope ids: rent, tax, elec.',
      },
    },
  },
  async run(args, ctx) {
    const state = ctx.store.state;
    const location = state.location;
    if (!location) throw new ToolError('the household has no location recorded, so there is nothing to look up');

    const found = await lookUp(location, {
      censusKey: resolvedEnv()['CENSUS_API_KEY'], eiaKey: resolvedEnv()['EIA_API_KEY'],
    });
    const wanted = Array.isArray(args['only']) ? args['only'].map(String) : null;
    const useful = found.estimates.filter((e) => !wanted || wanted.includes(e.envelope));
    if (!useful.length) {
      throw new ToolError(
        `No public data was found for ${location.label}. `
        + found.missing.join('; '));
    }

    const events: NewEvent[] = [];
    const effects: string[] = [];
    const month = monthOf(ctx.today);
    const plan = state.months.get(month);
    const open = plan !== undefined && !plan.closed;
    let applied = 0;

    for (const e of useful) {
      // Pricing only fills envelopes that are there, by the starter id the evidence is about.
      const existing = state.envelopes.get(e.envelope);
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
      events.push(redefine(existing, {
        figure: { template: e.monthly, source: `${e.source}, ${e.measuredOver}, ${e.asOf}` },
      }));
      if (open) {
        events.push({ op: 'assign', month, envelope: existing.id, to: e.monthly, why: 'priced from local data' });
      }

      // The provenance travels with the number. A figure whose origin is not on
      // screen at the moment of approval is a figure nobody checks.
      effects.push(`   ${fmtExact(e.monthly)} a month — ${e.source}, ${e.measuredOver}, ${e.asOf}`);
      effects.push(`   ${e.caveat}`);
    }

    if (!applied) {
      throw new ToolError(
        `No envelope here is one public data prices (${useful.map((e) => e.label).join(', ')}). `
        + 'Make an envelope for one and price it again.', 409);
    }

    // Say what this does not cover. Two envelopes out of a household's forty is
    // a starting point, and calling it anything more would be a lie.
    const untouched = state.envelopes.size - applied;
    const rest = untouched === 0 ? 'Everything else has no public figure and is still yours to set.'
      : untouched === 1 ? 'The other 1 has no public figure and is still yours to set.'
      : `The other ${untouched} have no public figure and are still yours to set.`;
    effects.push(`This is measured data for ${applied} envelope${applied === 1 ? '' : 's'}. ${rest}`);
    for (const m of found.missing) effects.push(`Not found: ${m}`);

    return ctx.proposals.put({
      tool: 'seed_from_location', who: ctx.who,
      summary: `Set ${applied} envelope${applied === 1 ? '' : 's'} from ${location.label} data`,
      effects, events,
    }, ctx.today);
  },
};

/** The lines that say which starter rules are added, and which are left out. */
function rulesEffects(missing: MissingRules): string[] {
  const effects: string[] = [];
  for (const r of missing.rules) {
    effects.push(`Rule "${r.match}" files a receipt as ${r.envelope === TRANSFER ? 'a transfer' : 'income'} — ${r.why}`);
  }
  if (missing.rules.length) {
    effects.push('Rules sort receipts imported from now on; receipts already here are not changed');
  }
  for (const r of missing.skippedRules) effects.push(`Not added: ${r}`);
  return effects;
}

const makeStarterEnvelopes: Tool = {
  name: 'make_starter_envelopes',
  description:
    'Propose the envelopes the budget starts with, in one step: the rows a person ticked in the ' +
    'budget walkthrough. Each row is a label, its envelope id for a starter row (kept when it is free), ' +
    'and where it sits: `category`, a category id that is here or a starter category id, or ' +
    '`newCategory`, the name of a category to make. The starter categories rows name and the starter ' +
    'rules this household lacks are added in the same proposal. Every envelope opens with no figure ' +
    'yet, as Action required, so nothing is funded until someone gives it a number.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      envelopes: {
        type: 'array',
        description: 'The rows to make, in the order to show them.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'What the envelope is called. A starter row may be renamed.' },
            id: { type: 'string', description: 'A starter row\'s envelope id, kept when free. Leave out for a row of their own.' },
            category: { type: 'string', description: 'The category it sits under: one here, or a starter category id.' },
            newCategory: { type: 'string', description: 'In place of category: the name of a new category to make for it.' },
          },
          required: ['label'],
        },
      },
    },
    required: ['envelopes'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const raw = args['envelopes'];
    if (!Array.isArray(raw) || raw.length === 0) throw new ToolError('make at least one envelope');

    // Categories this proposal adds, in the order they are written: starter ones in starter order, then typed ones.
    const starterAdds = new Map<CategoryId, string>();
    const typed = new Map<string, { id: CategoryId; label: string }>(); // by nameKey
    const madeCategories = new Set<CategoryId>();
    const categoryTaken = { has: (id: string) => state.categories.has(id) || madeCategories.has(id) };
    const madeEnvelopes = new Set<string>();
    const envelopeTaken = { envelopes: { has: (id: string) => state.envelopes.has(id) || madeEnvelopes.has(id) }, removedEnvelopes: state.removedEnvelopes };
    const labels = new Set([...state.envelopes.values()].map((e) => nameKey(e.label)));
    const starterOf = (id: string) => STARTER_CATEGORIES.find((c) => c.id === id);

    const rows: { id: EnvelopeId; label: string; category: CategoryId }[] = [];
    for (const item of raw) {
      const r = (item ?? {}) as Record<string, unknown>;
      const label = typeof r['label'] === 'string' ? r['label'].trim() : '';
      if (!label) throw new ToolError('every envelope needs a name');
      if (labels.has(nameKey(label))) {
        const here = [...state.envelopes.values()].find((e) => nameKey(e.label) === nameKey(label));
        throw new ToolError(here ? `There is already an envelope called ${here.label}.` : `${label} is named twice`, 409);
      }
      labels.add(nameKey(label));

      const given = typeof r['category'] === 'string' && r['category'] ? r['category'] : null;
      const fresh = typeof r['newCategory'] === 'string' && r['newCategory'].trim() ? r['newCategory'].trim() : null;
      if (given && fresh) throw new ToolError(`${label} names a category and a new one; give one`);
      let category: CategoryId;
      if (given) {
        if (state.categories.has(given)) category = given;
        else {
          const starter = starterOf(given);
          if (!starter) throw new ToolError(`no category ${given}`, 404);
          // A category typed new in an earlier row, under this id or this name, would be written twice.
          const twice = [...typed.values()].find((c) => c.id === given || nameKey(c.label) === nameKey(starter.label));
          if (twice) throw new ToolError(`${twice.label} is named as a new category and as the starter category ${starter.label}: choose it once`, 409);
          // A starter category whose name is here already under another id is that one.
          const same = [...state.categories.values()].find((c) => nameKey(c.label) === nameKey(starter.label));
          if (same) category = same.id;
          else {
            if (!starterAdds.has(given)) { starterAdds.set(given, starter.label); madeCategories.add(given); }
            category = given;
          }
        }
      } else if (fresh) {
        const here = [...state.categories.values()].find((c) => nameKey(c.label) === nameKey(fresh));
        if (here) throw new ToolError(`There is already a category called ${here.label}.`, 409);
        const starter = [...starterAdds].find(([, l]) => nameKey(l) === nameKey(fresh));
        if (starter) category = starter[0];
        else {
          let made = typed.get(nameKey(fresh));
          if (!made) {
            made = { id: categoryIdFor({ categories: categoryTaken }, fresh), label: fresh };
            typed.set(nameKey(fresh), made);
            madeCategories.add(made.id);
          }
          category = made.id;
        }
      } else throw new ToolError(`${label} needs a category`);

      const base = typeof r['id'] === 'string' && r['id'] ? slug(r['id']) || undefined : undefined;
      const id = envelopeIdFor(envelopeTaken, label, base);
      madeEnvelopes.add(id);
      rows.push({ id, label, category });
    }

    const missing = missingRules(state);
    const starterInOrder = STARTER_CATEGORIES.filter((c) => starterAdds.has(c.id));
    const events: NewEvent[] = [
      ...starterInOrder.map((c): NewEvent => ({ op: 'category.add', category: c.id, label: c.label })),
      ...[...typed.values()].map((c): NewEvent => ({ op: 'category.add', category: c.id, label: c.label })),
      ...missing.rules.map((r): NewEvent => ({ op: 'rule.add', rule: r.id, match: r.match, envelope: r.envelope })),
      ...rows.map((r, i): NewEvent => ({
        op: 'envelope.define', envelope: r.id, label: r.label, category: r.category,
        template: ZERO, rollover: true, needsFigure: true, order: state.envelopes.size + i,
      })),
    ];

    const labelOf = (id: CategoryId) => state.categories.get(id)?.label ?? starterAdds.get(id)
      ?? [...typed.values()].find((c) => c.id === id)?.label ?? id;
    const order = [...state.categories.keys(), ...starterInOrder.map((c) => c.id), ...[...typed.values()].map((c) => c.id)];
    const effects = order.filter((c) => rows.some((r) => r.category === c))
      .map((c) => `${labelOf(c)}: ${rows.filter((r) => r.category === c).map((r) => r.label).join(', ')}`);
    effects.push('Every one starts without a figure until it is given one');
    effects.push(...rulesEffects(missing));

    return ctx.proposals.put({
      tool: 'make_starter_envelopes', who: ctx.who,
      summary: `Make ${rows.length} envelope${rows.length === 1 ? '' : 's'}`,
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
    'the current month; when it is not open or is closed only the template is written. A figure known by the ' +
    'year, quarter, fortnight or week is given as `basis` instead of amountCents: the monthly is worked out ' +
    'from it and the basis is kept, while a figure given as amountCents drops any basis. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      envelope: { type: 'string' },
      amountCents: { type: 'number', description: 'The figure a month, in cents. Zero is allowed. Give this or basis.' },
      basis: { ...BASIS_INPUT, description: 'The figure as the bill is known, e.g. { amountCents: 120000, per: "year" }. Give this or amountCents.' },
      month: { type: 'string', description: 'YYYY-MM. Defaults to this month.' },
    },
    required: ['envelope'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const id = str(args['envelope'], 'envelope');
    const env = state.envelopes.get(id);
    if (!env) throw new ToolError(`no envelope ${id}`, 404);
    const hasAmount = args['amountCents'] !== undefined && args['amountCents'] !== null;
    const hasBasis = args['basis'] !== undefined && args['basis'] !== null;
    if (hasAmount && hasBasis) throw new ToolError('give amountCents or basis, not both');
    if (!hasAmount && !hasBasis) throw new ToolError('a figure needs amountCents or basis');
    const basis = hasBasis ? basisArg(args['basis']) : undefined;
    const amount = basis ? monthlyOf(basis) : money(args['amountCents'], 'amountCents');
    if (amount < 0) throw new ToolError('a figure is not less than nothing');
    const month = typeof args['month'] === 'string' && args['month'] ? args['month'] : monthOf(ctx.today);
    const plan = state.months.get(month);
    const open = plan !== undefined && !plan.closed;

    const events: NewEvent[] = [redefine(env, { figure: { template: amount, ...(basis ? { basis } : {}) } })];
    if (open) events.push({ op: 'assign', month, envelope: id, to: amount, why: 'gave it a figure' });
    return ctx.proposals.put({
      tool: 'set_envelope_figure', who: ctx.who,
      summary: basis
        ? `${env.label}: ${basisWords(basis)} (${fmtExact(amount)} a month)`
        : `${env.label}: ${fmtExact(amount)} a month`,
      effects: [
        `From this month on: ${env.label} is planned at ${fmtExact(amount)} a month${basis ? `, from ${basisWords(basis)}` : ''}`,
        open ? `${env.label} is funded at ${fmtExact(amount)} in ${month}`
          : 'This month is not open or is closed, so only the months to come change',
      ],
      events,
    }, ctx.today);
  },
};

const DATE_WORDS = 'a date needs its kind, how often, and a day of the month or a next date';

const setBill: Tool = {
  name: 'set_bill',
  description:
    "Propose setting, clearing or removing a bill's date in an envelope: a Due, Auto Pay or Pay by date, " +
    'every month (`day`, 1 to 31) or every quarter, half-year or year (`on`, the next date, YYYY-MM-DD). ' +
    '`bill` is a key from the envelope\'s bills in get_month; a `name` may be part of a bill\'s name, and a ' +
    'name that matches none makes a new bill by hand. `clear` takes the date off, so its day comes from its ' +
    'last receipt again; `remove` deletes a bill made by hand that no receipt has found. No money moves. ' +
    'Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      envelope: { type: 'string', description: 'The envelope the bill is listed in.' },
      bill: { type: 'string', description: "The bill's key, as get_month lists it." },
      name: { type: 'string', description: "A bill's name, or part of it; a new name makes a bill by hand. 60 characters at most." },
      kind: { type: 'string', enum: ['due', 'autopay', 'payby'] },
      per: { type: 'string', enum: ['month', 'quarter', 'half-year', 'year'] },
      day: { type: 'number', description: 'The day of the month, 1 to 31, for per: month.' },
      on: { type: 'string', description: 'The next date, YYYY-MM-DD, for any other per.' },
      clear: { type: 'boolean', description: 'Take the date off.' },
      remove: { type: 'boolean', description: 'Remove a bill made by hand.' },
    },
    required: ['envelope'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const id = str(args['envelope'], 'envelope');
    const env = state.envelopes.get(id);
    if (!env) throw new ToolError(`no envelope ${id}`, 404);
    if (env.sinking) throw new ToolError('a savings envelope has no bills');
    const listed = billsOf(state).get(id) ?? [];
    const noBill = (x: string) => new ToolError(`no bill ${x} in ${env.label}`, 404);

    // the target
    let target: Bill | null = null;
    let key = '';
    let name = '';
    const given = (k: string): boolean => typeof args[k] === 'string' && (args[k] as string).trim() !== '';
    if (given('bill')) {
      const want = (args['bill'] as string).trim();
      target = listed.find((x) => x.key === want) ?? null;
      if (!target) throw noBill(want);
      key = target.key;
      name = target.name;
    } else if (given('name')) {
      name = (args['name'] as string).trim();
      if (name.length > 60) throw new ToolError('a name is 60 characters at most');
      key = billKey(name);
      if (key === '') throw new ToolError("say the bill's name in letters");
      const exact = listed.find((x) => x.key === key);
      if (exact) target = exact;
      else {
        const near = listed.filter((x) => x.key !== '' && (key.includes(x.key) || x.key.includes(key)));
        if (near.length > 1) throw new ToolError('two bills match that name: say more of it');
        target = near[0] ?? null;
      }
      if (target) { key = target.key; name = target.name; }
    } else {
      throw new ToolError('say which bill, or name a new one');
    }
    const byHand = target ? target.byHand : true;
    const label = env.label;
    // a bill that follows its receipts keeps one record, under its own envelope: write there, never a second
    const home = target?.home && state.envelopes.has(target.home) ? target.home : id;
    // a new name that some other envelope's receipts already hold would be listed there at once
    if (!target && args['remove'] !== true && args['clear'] !== true) {
      for (const [other, there] of billsOf(state)) {
        if (other === id) continue;
        const hit = there.find((x) => x.receipts.length > 0 && x.key.includes(key));
        if (hit) throw new ToolError(`${name} is already a bill in ${state.envelopes.get(other)?.label ?? other}: set its date there`);
      }
    }

    if (args['remove'] === true) {
      if (!target) throw noBill(given('bill') ? (args['bill'] as string).trim() : name);
      if (!target.byHand || target.receipts.length > 0) throw new ToolError('that bill comes from the receipts: clear its date instead');
      return ctx.proposals.put({
        tool: 'set_bill', who: ctx.who,
        summary: `Remove the bill ${name}`,
        effects: [`It leaves ${label}'s page`, 'No money moves'],
        events: [{ op: 'bill.remove', envelope: home, bill: key, name }],
      }, ctx.today);
    }
    if (args['clear'] === true) {
      if (!target || !target.date) throw new ToolError('that bill has no date to clear');
      return ctx.proposals.put({
        tool: 'set_bill', who: ctx.who,
        summary: `${name}: date cleared`,
        effects: ['Its day comes from its last receipt again', 'No money moves'],
        events: [{ op: 'bill.set', envelope: home, bill: key, name, ...(byHand ? { byHand: true as const } : {}), date: null }],
      }, ctx.today);
    }

    const kind = args['kind'];
    const per = args['per'];
    if (kind !== 'due' && kind !== 'autopay' && kind !== 'payby') throw new ToolError(DATE_WORDS);
    if (per !== 'month' && per !== 'quarter' && per !== 'half-year' && per !== 'year') throw new ToolError(DATE_WORDS);
    const has = (k: string) => args[k] !== undefined && args[k] !== null;
    let date: BillDate;
    if (per === 'month') {
      if (!has('day') || has('on')) throw new ToolError(DATE_WORDS);
      const day = args['day'];
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) throw new ToolError('a day of the month is from 1 to 31');
      date = { kind, per, day };
    } else {
      const on = args['on'];
      if (has('day') || !isDay(on)) throw new ToolError(DATE_WORDS);
      date = { kind, per, on };
    }
    return ctx.proposals.put({
      tool: 'set_bill', who: ctx.who,
      summary: `${name}: ${billDateWords(date)}`,
      effects: [`Shows ${billDateWords(date)} on ${label}'s page`, 'No money moves'],
      events: [{ op: 'bill.set', envelope: home, bill: key, name, ...(byHand ? { byHand: true as const } : {}), date }],
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
      month: { type: 'string', description: 'YYYY-MM. Defaults to this month.' },
      amountCents: { type: 'number', description: 'What the month brings in, in cents.' },
      why: { type: 'string', description: "Optional. Defaults to set this month's income." },
    },
    required: ['amountCents'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const month = typeof args['month'] === 'string' && args['month'] ? args['month'] : monthOf(ctx.today);
    const amount = money(args['amountCents'], 'amountCents');
    if (amount < 0) throw new ToolError('an income is not less than nothing');
    const plan = state.months.get(month);
    if (!plan) throw new ToolError(`${month} is not open`, 404);
    if (plan.closed) throw new ToolError(`${month} is closed, so its income stays as it was`);
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
      events: [{ op: 'income.set', month, amount, why }],
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
    "household's areas. It starts in Planning and belongs to whoever approves it. To gather plans " +
    'under one aim, propose set_plan_goal after it is made. Read ' +
    'list_plans first, so you do not suggest a plan they already have. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short, as it would read on a card: "Replace the water heater".' },
      area: { type: 'string', description: "One of the household's areas, exactly as list_plans names them." },
    },
    required: ['title', 'area'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const title = planTitle(args['title']);
    const area = knownArea(state, args['area']);
    // There are no shelves: a card from before 0.7.0 that carries one is refused in the same words.
    if (args['parent'] !== undefined) throw new ToolError(RETIRED.shelf, 400);

    const plan = newPlanId(title);
    return ctx.proposals.put({
      tool: 'create_plan', who: ctx.who,
      summary: `Make a plan: ${title}`,
      effects: [`A new plan in ${area}, in Planning`, 'It belongs to whoever approves it'],
      events: [{ op: 'plan.create', plan, title, area }],
    }, planStamp(ctx));
  },
};

const updatePlan: Tool = {
  name: 'update_plan',
  description:
    "Propose changes to a plan's card: its title, area, chips, notes, estimated cost, or the " +
    'envelope it is paid from. Only the fields given change. Chips are free-text labels such as ' +
    '"researching" or "waiting on a quote"; they never change the state of a plan (Planning, Doing or Done), and chips and ' +
    'notes are replaced whole, so read get_plan and send the full list. Linking an envelope moves no ' +
    'money — it only lets the card say what the cost means. Returns a proposal.',
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
      envelope: { type: ['string', 'null'], description: 'The id of the envelope it is paid from. null unlinks it.' },
    },
    required: ['plan'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const p = livePlan(state, args['plan']);
    const effects: string[] = [];
    const set: {
      title?: string; area?: string; chips?: string[]; notes?: string; estimate?: Cents | null;
      envelope?: string | null;
    } = {};

    if (args['title'] !== undefined) {
      set.title = planTitle(args['title']);
      effects.push(`Title: "${p.title}" becomes "${set.title}"`);
    }
    if (args['area'] !== undefined) {
      set.area = knownArea(state, args['area']);
      effects.push(`Area: ${p.area} becomes ${set.area}`);
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
      else effects.push(`Paid from ${state.envelopes.get(set.envelope)!.label} — no money moves`);
    }
    if (!effects.length) throw new ToolError('nothing to change: give at least one field');
    // A new name or area goes to its due date and blocks on the calendar.
    const renamed = (set.title !== undefined && set.title !== p.title) || (set.area !== undefined && set.area !== p.area);
    if (renamed && p.links.some((l) => l.kind === 'due' || l.kind === 'block')) {
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
    'Propose moving a plan between Planning and Doing, or marking it done. Done keeps it on the page ' +
    'of its area. Only suggest it when they have said where it stands; do not infer ' +
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

const handPlan: Tool = {
  name: 'hand_plan',
  description:
    'Propose handing a plan to a household member at once: any member may hand any plan to any ' +
    'member, themselves included, and it is theirs and shows in their Today as soon as it is ' +
    'approved. Suggest this only when they have said who should have it. A short reason is read ' +
    'by the member it goes to. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      to: { type: 'string', description: 'The member to hand it to, by account name.' },
      why: { type: 'string', description: 'Optional. One line, read by the member it goes to.' },
    },
    required: ['plan', 'to'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const p = livePlan(state, args['plan']);
    const to = handTarget(state, p, args['to']);
    const why = handReason(args['why']);
    return ctx.proposals.put({
      tool: 'hand_plan', who: ctx.who,
      summary: `Hand ${p.title} from ${p.owner} to ${to}`,
      effects: [`It becomes ${to}'s at once and shows in Today`],
      events: [{ op: 'plan.hand', plan: p.id, to, ...(why ? { why } : {}) }],
    }, planStamp(ctx));
  },
};

const setPlanGoal: Tool = {
  name: 'set_plan_goal',
  description:
    "Propose setting a plan toward a goal, or taking it off its goal with null. A goal is a short name " +
    'for what several plans are for, such as "New roof"; a plan has at most one. A name that matches ' +
    'an existing goal ignoring case joins that goal, in its spelling. Read list_plans first so you ' +
    'use the goals they already have. Returns a proposal.',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      plan: { type: 'string' },
      goal: { type: ['string', 'null'], description: 'The goal, up to 60 characters. null takes the plan off its goal.' },
    },
    required: ['plan', 'goal'],
  },
  run(args, ctx) {
    const state = ctx.store.state;
    const p = livePlan(state, args['plan']);
    const goal = planGoal(state, args['goal']);
    if (goal === null && p.goal === null) throw new ToolError(`${p.title} has no goal`, 409);
    if (goal !== null && p.goal === goal) throw new ToolError(`${p.title} is already toward ${goal}`, 409);
    return ctx.proposals.put({
      tool: 'set_plan_goal', who: ctx.who,
      summary: goal === null ? `Take ${p.title} off ${p.goal}` : `Set ${p.title} toward ${goal}`,
      effects: [goal === null ? `${p.title} has no goal` : `${p.title} is toward ${goal}`],
      events: [{ op: 'plan.goal', plan: p.id, goal }],
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
    'Propose setting aside a stretch of time for a plan, such as a Saturday morning to paint ' +
    'the fence. Suggest a time only when they have said when they mean to do it; you cannot see ' +
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
    'the log, marked removed. A finished plan is marked done, not removed. A reason is required. ' +
    'Returns a proposal.',
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
    properties: { account: { type: 'string' } },
    required: ['account'],
  },
  run(_args, ctx) {
    const c = savingsCheck(ctx.store.state, ctx.today);
    if (!c) throw new ToolError('no envelopes are saved in Savings');
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
    "The household's board: a row per area, each with its open plans (Doing first, then Planning) and its " +
    'finished ones apart. Each plan has who owns it, the one goal it is toward if any, any open ask left over ' +
    'from before, chips, due date, the envelope it is paid from and what is left in it, and, for a plan in ' +
    'Doing only, how many days it has been there. Nothing in Planning has an age, and a finished plan has ' +
    'none: daysInState is null for both, so never say how long something has waited to be started. ' +
    "Each row's `all` counts the whole area whatever you filtered. The answer also lists the household's " +
    'goals (each with how many plans are toward it and how many are done) and how many open plans each member owns (with the finished ones of a goal, when a goal is asked for). ' +
    'Use it to find a plan and its id before suggesting anything about one.',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      who: {
        type: 'string',
        description: 'A member: only the plans they own, and nothing at all if they own none. Default everyone.',
      },
      goal: {
        type: 'string',
        description: 'A goal, in any case: only the plans toward it, finished ones included. A goal nobody has filters nothing.',
      },
    },
  },
  async run(args, ctx) {
    const who = args['who'];
    if (who !== undefined && who !== 'everyone' && (typeof who !== 'string' || !ctx.store.state.members.has(who))) {
      throw new ToolError('who must be a member of this household, or everyone');
    }
    const goal = typeof args['goal'] === 'string' && args['goal'].trim() ? args['goal'].trim() : null;
    return board(ctx.store.state, await ctx.store.since(null), { who: who ?? 'everyone', goal, today: ctx.today });
  },
};

const getPlan: Tool = {
  name: 'get_plan',
  description:
    "Everything on one plan's card: notes, checklist with item ids, chips, people, due date and " +
    'time set aside, the goal it is toward (and every goal the household has), the money it means for its ' +
    'envelope, what you found for it before, what the members said to each other about it, and its history.',
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
  getMonth, explainEnvelope, findDonors, listTransactions, getActivity,
  makeStarterEnvelopes, setMonthIncome, setEnvelopeFigure, setBill,
  moveMoney, setAssignment, sortReceipts, openMonth, restoreTxn,
  addEnvelope, changeEnvelope, addCategory, renameCategory, moveCategory, removeCategory, addRule,
  setSinkingGoal, removeEnvelope,
  closeMonth, discardMonth,
  planIncome, defineIncome, removeIncome, setLocation, localCosts, seedFromLocation,
  listPlans, getPlan, searchTool, createPlan, updatePlan, setPlanState, handPlan, setPlanGoal, answerAsk, setChecklist,
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

/**
 * The tools the walkthrough and the budget's one-tap actions approve in the same
 * request, with ?approve=1: sorting a receipt, and adding, renaming and moving
 * envelopes and categories, move no money behind a person's back. seed_from_location
 * is not here: its proposal, with its sources and caveats, is shown before anyone
 * approves it. Nor is add_rule: a rule is shown before it is kept, and sort_receipts
 * is approved in one only without one (the route refuses alsoAddRuleMatching).
 */
export const APPROVE_IN_ONE: ReadonlySet<string> = new Set([
  'sort_receipts', 'add_envelope', 'change_envelope', 'add_category', 'rename_category', 'move_category', 'remove_category',
  'set_location', 'open_month', 'set_month_income', 'define_income_source',
  'make_starter_envelopes', 'set_envelope_figure', 'set_bill', 'move_money', 'set_assignment',
]);

/**
 * Why a call approved in one is refused before it runs, or null: sorting by a press never
 * adds a rule, which is shown first (add_rule). Claude's sort_receipts cards keep theirs.
 */
export function refusedInOne(name: string, args: Record<string, unknown>): string | null {
  if (name !== 'sort_receipts' || !Array.isArray(args['assignments'])) return null;
  const withRule = (args['assignments'] as unknown[]).some((a) => {
    const m = typeof a === 'object' && a !== null ? (a as Record<string, unknown>)['alsoAddRuleMatching'] : undefined;
    return typeof m === 'string' && m.trim() !== '';
  });
  return withRule ? 'A rule is shown before it is added.' : null;
}

/** Whether Claude may call it: the ones in TOOLS. */
export const forClaude = (t: Tool): boolean => TOOLS.includes(t);

/**
 * The writes research on a plan may suggest: the plan tools, whose events
 * touch no month or envelope. Research may read the budget and say
 * what a cost means for an envelope; moving money is decided in the budget,
 * never from a card. create_contact is one: it only adds someone to Contacts,
 * and nothing happens until a member approves the card.
 */
export const RESEARCH_WRITES: ReadonlySet<string> = new Set([
  createPlan, updatePlan, setPlanState, handPlan, setPlanGoal, answerAsk, setChecklist,
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
  // A drift the effect found has its card put in front of everyone.
  await raiseDriftCards(ctx, committed);
  return { committed, summary: p.summary };
}
