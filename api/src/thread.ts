/**
 * The thread: the household's record, read as a conversation.
 *
 * Every visible thing is an entry of its own: the briefing, a question and
 * Claude's answer, a note, a card (which names what raised it), a decision made
 * on a later day than its card, and every change made directly on a screen as a
 * quiet line. Each carries its lane and the household's day. It is the log,
 * shaped for reading: nothing here is stored that the log does not hold.
 */

import { changes, findRemoved } from './activity.ts';
import type { Removed } from './activity.ts';
import { waiting } from './offers.ts';
import type { Waiting } from './offers.ts';
import type { Store } from './store.ts';
import { blockedOver } from './booking.ts';
import { currentDoc } from './docs.ts';
import { guestEmail } from './replay.ts';
import { cardLane, laneOf } from './lanes.ts';
import type { Lane } from './lanes.ts';
import { householdDay, isGuest, planShaped, sameCalendar, visibleTo, zoneOf } from './types.ts';
import type { Actor, BriefingSource, BudgetId, Day, DriftChoice, EnvelopeId, Event, EventId, Offer, PlanId, State } from './types.ts';

/** What stamps every entry: its lane, the household's day it falls on, and what it asks of the viewer. */
export interface Stamp {
  readonly lane: Lane;
  readonly day: Day;
  /** Written by someone else after what the viewer last read. */
  fresh?: true;
  /** Something on it waits on the viewer. */
  waits?: true;
}

/** What raised a card: a briefing, the question an answer or research replied to, or the card a member adjusted. */
export interface Raised { how: 'briefing' | 'answer' | 'research' | 'member'; entry: EventId; day: Day; at: string; by: Actor }

/** Where a row opens: a live plan's card, an envelope, or a day on the Calendar. */
export type Open = { plan: PlanId } | { budget: BudgetId; envelope: EnvelopeId } | { calendar: Day };

type Body =
  | { kind: 'briefing'; id: EventId; at: string; source: BriefingSource; budget: BudgetId | null; day: Day;
      headline: string; body: string | null; writtenBy: 'claude' | 'fallback';
      /** Kept in Drive: where, and nothing else of it; the words are read back by `GET /api/docs/:event`. */
      doc?: { path: string } }
  | { kind: 'ask' | 'note'; id: EventId; at: string; who: Actor; text: string; budget: BudgetId | null;
      answer?: { id: EventId; at: string; text: string; tools: string[];
                 /** With its whole text in Drive: `text` is the headline, and this is where the rest is. */
                 doc?: { path: string } };
      /** Asked or said on a plan's card. */
      plan?: PlanRef }
  | { kind: 'card'; id: EventId; at: string; who: Actor; offer: Offer;
      /** A guest's name, from the list, to say in place of `guest:<their address>`. */
      name?: string;
      /** Raised by the app itself (a drift, Savings short, a cancelled stay): `who` is only whoever noticed. */
      app?: true;
      raised?: Raised;
      /** On an ask to take a plan: who asked whom, and why, from the `plan.ask` itself. */
      ask?: { by: Actor; to: Actor; why: string };
      /**
       * On a drift card: whether it is about the calendar's event or the
       * plan's page in Drive, how it was settled (null while open), whether the
       * event was deleted, whether a newer change to it is asked about instead,
       * and whether the page could not be read (nothing on it can be taken).
       */
      drift?: { on: 'calendar' | 'page'; resolved: DriftChoice | null; deleted: boolean; replaced: boolean; unreadable: boolean };
      /** On a friend's request still waiting: nights it asks for that have been kept for the household since. */
      blocked?: string;
      /** The removals this card's approval made: flagged here, never as lines of their own. */
      flags?: { event: EventId; removed?: Removed; seenByMe: boolean }[];
      plan?: PlanRef }
  | { kind: 'decision'; id: EventId; at: string; who: Actor; decision: 'approved' | 'declined'; why?: string;
      offer: { id: EventId; summary: string; day: Day } }
  | { kind: 'change'; id: EventId; at: string; who: Actor; what: string; why: string | null;
      count: number; budget: BudgetId | null;
      /** On a plan handed on: which plan, from whom and to whom, from the hand itself. */
      hand?: { plan: PlanRef; from: Actor; to: Actor };
      /** A guest's name, from the list, to say in place of `guest:<their address>`. */
      name?: string;
      plan?: PlanRef;
      /** Where the row opens: a live plan's card, an envelope, or a day on the Calendar. */
      open?: Open;
      /** An appointment made or changed, and what it was before. */
      event?: { summary: string; start: string; end: string; allDay: boolean; on: 'household' | 'own';
                was?: { summary: string; start: string; end: string; allDay: boolean } };
      flag?: { removed?: Removed; seenByMe: boolean } };

export type ThreadEntry = Body & Stamp;

/** The plan an entry is about, by name, so Today can say which card it belongs to. */
export interface PlanRef { readonly id: PlanId; readonly title: string }

export interface ThreadPage {
  /** Oldest first within the page. */
  readonly entries: ThreadEntry[];
  readonly waiting: Waiting[];
  /** The caller's read cursor, for the "new since you last looked" divider. */
  readonly newSince: EventId | null;
  /** Pass back to read further up; null when this page reaches the start. */
  readonly before: EventId | null;
}

export interface ThreadOptions {
  readonly who: Actor;
  /** The budget in view. Household-wide entries show whatever it is. */
  readonly budget: BudgetId | null;
  readonly allBudgets?: boolean;
  readonly filter?: 'everything' | 'mine' | 'theirs' | 'waiting';
  readonly before?: EventId;
  readonly limit?: number;
}

/** Which budget an event belongs to; null for the household's own facts. */
export function budgetOf(e: Event): BudgetId | null {
  const b = (e as { budget?: unknown }).budget;
  return typeof b === 'string' ? b : null;
}

/**
 * The plan changes a member would want to see in the day's thread. The rest
 * (checklist, chips, notes, estimate, the envelope, contact links) are too
 * fine-grained for a conversation and stay on the card's History. The ask and
 * its answer are not here either: `plan.ask` is already a card of its own, and
 * once answered that card settles into one line, "Taken by bob" or "Declined
 * by bob — 'why'", which is the answer's line in Today. A quiet line for
 * `plan.ask.accept` or `plan.ask.decline` beside it would say it twice.
 *
 * The calendar's lines follow the same rule. A drift settled and an
 * appointment made or taken back are decisions a member would want to read; a link, an
 * unlink or an etag is the app keeping the NAS in step with a change already
 * shown as its own line (the due date, the block). A drift itself is said by
 * the card that asks about it, so a line beside it would say it twice.
 */
const PLAN_LINES = new Set<string>([
  'plan.create', 'plan.state', 'plan.remove', 'plan.hand', 'goal.rename', 'goal.remove',
  'plan.due', 'plan.block', 'plan.unblock', 'plan.attach', 'plan.detach',
  'calendar.drift.resolve', 'calendar.appointment', 'calendar.appointment.remove', 'calendar.appointment.change',
]);
const quiet = (e: Event): boolean => !planShaped(e.op) || PLAN_LINES.has(e.op);

/** Who wrote an entry: a briefing is Claude's unless it is the plain fallback; a card the app raised has no author. */
export function authorOf(e: ThreadEntry): Actor | null {
  if (e.kind === 'briefing') return e.writtenBy === 'fallback' ? null : 'claude';
  if (e.kind === 'card' && e.app) return null;
  return 'who' in e ? e.who : null;
}

/**
 * Newest day first; within a day the briefing, then time, then the log's order.
 * Stable, so entries that tie keep the order they were given in.
 */
export function ordered(entries: readonly ThreadEntry[]): ThreadEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      (a.e.day < b.e.day ? 1 : a.e.day > b.e.day ? -1 : 0)
      || (Number(b.e.kind === 'briefing') - Number(a.e.kind === 'briefing'))
      || (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : 0)
      || a.i - b.i)
    .map((x) => x.e);
}

/** Every entry, in the log's order, before any filter. */
export function build(events: readonly Event[], state: State, who: Actor): ThreadEntry[] {
  const tz = zoneOf(state);
  const byId = new Map(events.map((e) => [e.id, e]));
  // A section that was replaced later that day hands its cards to its replacement.
  const replacedBy = new Map<EventId, EventId>();
  for (const e of events) if (e.op === 'thread.briefing' && e.replaces) replacedBy.set(e.replaces, e.id);
  // A day with the household's briefing shows that one alone: a budget's own
  // section that day (written before the household's, or while it could not
  // be) stands aside, and hands it its cards.
  const householdOn = new Map<Day, EventId>();
  for (const e of events) {
    if (e.op === 'thread.briefing' && e.source === 'household' && !replacedBy.has(e.id)) householdOn.set(e.day, e.id);
  }
  const standsAside = new Map<EventId, EventId>();
  for (const e of events) {
    if (e.op !== 'thread.briefing' || e.source === 'household' || replacedBy.has(e.id)) continue;
    const opener = householdOn.get(e.day);
    if (opener) standsAside.set(e.id, opener);
  }
  const settle = (id: EventId): EventId => {
    let at = id;
    while (replacedBy.has(at)) at = replacedBy.get(at)!;
    return standsAside.get(at) ?? at;
  };

  const seen = state.thread.seen.get(who);
  // An approval appends its effect in the same write as the decision. That
  // effect is already on the card, as "approved by"; showing it again as a
  // direct change would say the same thing twice. Effect to the card.
  const appliedBy = new Map<EventId, EventId>();
  events.forEach((e, i) => {
    if (e.op !== 'proposal.decide' || e.decision !== 'approved') return;
    for (let j = i + 1; j < events.length && events[j]!.at === e.at && events[j]!.who === e.who; j++) {
      appliedBy.set(events[j]!.id, e.proposal);
    }
  });
  // A drift let go because its plan was removed is said by the removal, in the same write.
  const removals = new Set(events.filter((e) => e.op === 'plan.remove').map((e) => `${e.at}|${e.who}`));
  for (const e of events) {
    if (e.op !== 'calendar.drift.resolve' || !removals.has(`${e.at}|${e.who}`)) continue;
    const card = [...state.thread.offers.values()].find((o) => o.prompt.kind === 'drift' && o.prompt.ref === e.drift);
    appliedBy.set(e.id, card?.id ?? e.id);
  }
  const changeById = new Map(changes(events.filter((e) => !appliedBy.has(e.id) && quiet(e)), state).map((c) => [c.id, c]));
  const answers = new Map<EventId, Extract<Event, { op: 'thread.answer' }>>();
  const answerById = new Map<EventId, Extract<Event, { op: 'thread.answer' }>>();
  for (const e of events) if (e.op === 'thread.answer') { answers.set(e.replyTo, e); answerById.set(e.id, e); }
  const asks = new Map<EventId, Extract<Event, { op: 'plan.ask' }>>();
  for (const e of events) if (e.op === 'plan.ask') asks.set(e.id, e);
  const planRef = (id: PlanId): { plan: PlanRef } | Record<never, never> => {
    const p = state.plans.get(id);
    return p ? { plan: { id: p.id, title: p.title } } : {};
  };

  const handOf = (id: EventId): { hand: { plan: PlanRef; from: Actor; to: Actor } } | Record<never, never> => {
    const h = state.hands.get(id);
    const p = h && state.plans.get(h.plan);
    return h && p ? { hand: { plan: { id: p.id, title: p.title }, from: h.from, to: h.to } } : {};
  };

  /** What raised a card, where it can be found: the briefing it settled on, the question, or the card adjusted. */
  const raisedOf = (o: Offer): Raised | undefined => {
    const ref = o.prompt.ref;
    if (!ref) return undefined;
    switch (o.prompt.kind) {
      case 'briefing': {
        const id = settle(ref);
        const b = byId.get(id);
        return b && b.op === 'thread.briefing' ? { how: 'briefing', entry: id, day: b.day, at: b.at, by: 'claude' } : undefined;
      }
      case 'answer': case 'research': {
        const a = answerById.get(ref);
        const q = a && byId.get(a.replyTo);
        return q ? { how: o.prompt.kind, entry: q.id, day: householdDay(tz, q.at), at: q.at, by: q.who } : undefined;
      }
      case 'member': {
        const was = byId.get(ref);
        return was ? { how: 'member', entry: ref, day: householdDay(tz, was.at), at: was.at, by: o.who } : undefined;
      }
      default: return undefined;
    }
  };

  /** The plan an op names: its own, the hand's, or the page drift's. */
  const planOfOp = (e: Event): PlanId | undefined => {
    if (e.op === 'plan.hand') return state.hands.get(e.id)?.plan ?? e.plan;
    if (e.op === 'calendar.drift.resolve') return state.pageDrifts.get(e.drift)?.plan;
    return 'plan' in e && typeof e.plan === 'string' ? e.plan : undefined;
  };
  const dayOfSeconds = (s: number): Day => householdDay(tz, new Date(s * 1000));
  /** Where a row opens, for the ops that name something to open. */
  const openOf = (e: Event, lane: Lane): Open | undefined => {
    switch (e.op) {
      case 'assign': case 'envelope.define': return { budget: e.budget, envelope: e.envelope };
      case 'move': return { budget: e.budget, envelope: e.to };
      case 'calendar.appointment': case 'calendar.appointment.change': return { calendar: householdDay(tz, e.start) };
      case 'booking.block': return { calendar: e.from };
      case 'booking.confirm': return { calendar: e.arrive };
      case 'calendar.drift.resolve': {
        const d = state.drifts.get(e.drift);
        if (d) return { calendar: dayOfSeconds(e.choice === 'plan' ? d.ours.dtstart : (d.theirs ?? d.ours).dtstart) };
        break;
      }
      default: break;
    }
    if (lane === 'plans') {
      const id = planOfOp(e);
      const p = id ? state.plans.get(id) : undefined;
      if (p && !p.removed) return { plan: p.id };
    }
    return undefined;
  };
  const household = state.calendar.household;
  const eventOf = (e: Event): Extract<ThreadEntry, { kind: 'change' }>['event'] => {
    if (e.op === 'calendar.appointment') {
      return { summary: e.summary, start: e.start, end: e.end, allDay: e.allDay,
        on: household && sameCalendar(e, household) ? 'household' : 'own' };
    }
    if (e.op === 'calendar.appointment.change') {
      const made = state.appointments.get(e.evt_id);
      return { summary: e.summary, start: e.start, end: e.end, allDay: e.allDay,
        on: made && household && sameCalendar(made, household) ? 'household' : 'own', was: e.was };
    }
    return undefined;
  };

  const out: ThreadEntry[] = [];
  const add = (body: Body, lane: Lane, day: Day): void => { out.push({ ...body, lane, day } as ThreadEntry); };
  for (const e of events) {
    switch (e.op) {
      case 'thread.briefing':
        if (replacedBy.has(e.id) || standsAside.has(e.id)) break;
        add({ kind: 'briefing', id: e.id, at: e.at, source: e.source ?? 'budget', budget: e.budget, day: e.day,
          headline: e.headline, body: e.body ?? null, writtenBy: e.writtenBy,
          ...(e.doc ? { doc: { path: currentDoc(state, e.doc).path } } : {}) }, 'claude', e.day);
        break;
      case 'thread.ask':
      case 'thread.note': {
        const a = e.op === 'thread.ask' ? answers.get(e.id) : undefined;
        add({
          kind: e.op === 'thread.ask' ? 'ask' : 'note', id: e.id, at: e.at, who: e.who,
          text: e.op === 'thread.ask' ? e.question : e.text, budget: e.budget,
          ...(e.plan ? planRef(e.plan) : {}),
          ...(a ? { answer: { id: a.id, at: a.at, text: a.text, tools: a.tools.map((t) => t.name),
                             ...(a.doc ? { doc: { path: currentDoc(state, a.doc).path } } : {}) } } : {}),
        }, e.op === 'thread.ask' ? 'claude' : 'notes', householdDay(tz, e.at));
        break;
      }
      case 'proposal.offer': {
        const offer = state.thread.offers.get(e.id)!;
        if (!visibleTo(offer, who)) break;
        const asked = e.prompt.kind === 'ask' && e.prompt.ref ? asks.get(e.prompt.ref) : undefined;
        const ref = e.prompt.kind === 'drift' ? e.prompt.ref : undefined;
        const calDrift = ref ? state.drifts.get(ref) : undefined;
        const pageDrift = ref && !calDrift ? state.pageDrifts.get(ref) : undefined;
        const drift = calDrift ?? pageDrift;
        const argPlan = typeof offer.args['plan'] === 'string' ? offer.args['plan'] : undefined;
        const on = asked?.plan ?? drift?.plan ?? e.plan ?? argPlan;
        const blocked = offer.tool === 'approve_booking' && (offer.status === 'open' || offer.status === 'snoozed')
          ? blockedOver(state, offer.args, householdDay(zoneOf(state))) : null;
        const raised = raisedOf(offer);
        add({
          kind: 'card', id: e.id, at: e.at, who: e.who, offer,
          ...(isGuest(e.who) ? { name: state.guests.get(guestEmail(e.who))?.name ?? 'A guest' } : {}),
          ...(e.prompt.kind === 'drift' || e.prompt.kind === 'savings' || e.tool === 'release_stay' ? { app: true as const } : {}),
          ...(raised ? { raised } : {}),
          ...(asked ? { ask: { by: asked.who, to: asked.to, why: asked.why } } : {}),
          ...(drift ? { drift: {
            on: pageDrift ? 'page' as const : 'calendar' as const, resolved: drift.resolved,
            deleted: calDrift?.theirs === null, replaced: drift.replacedBy !== undefined,
            unreadable: pageDrift?.unreadable === true,
          } } : {}),
          ...(blocked ? { blocked } : {}),
          ...(on ? planRef(on) : {}),
        }, cardLane(offer, state), householdDay(tz, e.at));
        break;
      }
      case 'proposal.decide': {
        const offer = state.thread.offers.get(e.proposal);
        if ((e.decision !== 'approved' && e.decision !== 'declined') || !offer || !visibleTo(offer, who)) break;
        const offered = householdDay(tz, offer.at);
        const decided = householdDay(tz, e.at);
        if (offered === decided) break;
        add({ kind: 'decision', id: e.id, at: e.at, who: e.who, decision: e.decision,
          ...(e.why ? { why: e.why } : {}), offer: { id: offer.id, summary: offer.summary, day: offered } },
        cardLane(offer, state), decided);
        break;
      }
      default: {
        // Bookkeeping has no line: activity.ts's NOT_A_CHANGE keeps a page
        // written or a file moved to the new folder out of `changes`. How many
        // files are left to move is read from state, not from these lines.
        const c = changeById.get(e.id);
        if (!c) break;
        const lane = laneOf(e, state) ?? 'notes';
        const open = openOf(e, lane);
        const event = eventOf(e);
        const named = planOfOp(e);
        add({
          kind: 'change', id: c.id, at: c.at, who: c.who, what: c.what, why: c.why,
          count: c.count, budget: budgetOf(e),
          ...(e.op === 'plan.hand' ? handOf(e.id) : {}),
          ...(named ? planRef(named) : {}),
          ...(open ? { open } : {}),
          ...(event ? { event } : {}),
          ...(isGuest(e.who) ? { name: state.guests.get(guestEmail(e.who))?.name ?? 'A guest' } : {}),
          ...(e.op === 'txn.remove'
            ? { flag: { ...(c.removed ? { removed: c.removed } : {}), seenByMe: c.who === who || !!seen?.has(e.id) } }
            : {}),
        }, lane, householdDay(tz, c.at));
      }
    }
  }

  // A receipt an approved card removed is flagged on that card, which has no line of its own for it.
  const cards = new Map<EventId, Extract<ThreadEntry, { kind: 'card' }>>();
  for (const e of out) if (e.kind === 'card') cards.set(e.id, e);
  for (const [effect, offerId] of appliedBy) {
    const e = byId.get(effect);
    const card = cards.get(offerId);
    if (!e || e.op !== 'txn.remove' || !card) continue;
    const removed = findRemoved(events, e.txn, state);
    (card.flags ??= []).push({ event: e.id, ...(removed ? { removed } : {}), seenByMe: e.who === who || !!seen?.has(e.id) });
  }

  // What waits on the viewer: an offer by its id, a flag by its change or, through the card that made it, the card.
  const waitsOn = new Set<EventId>();
  for (const w of waiting(state, who, events)) {
    if (w.kind === 'offer') waitsOn.add(w.offer.id);
    else if (w.kind === 'flag') waitsOn.add(appliedBy.get(w.event) ?? w.event);
  }
  // Fresh: placed after what the viewer last read, by someone else. With no cursor, or one the log no longer holds, nothing is.
  const place = new Map(events.map((e, i) => [e.id, i]));
  const cursor = state.readCursor.get(who);
  const read = cursor === undefined ? undefined : place.get(cursor);
  for (const e of out) {
    if (waitsOn.has(e.id)) e.waits = true;
    if (read !== undefined && (place.get(e.id) ?? -1) > read && authorOf(e) !== who) e.fresh = true;
  }
  return out;
}

export async function thread(store: Store, o: ThreadOptions): Promise<ThreadPage> {
  const events = await store.since(null);
  const state = store.state;
  // What is waiting, as far as this view goes: a card for another budget is
  // counted when that budget is in view, so the count and the Waiting filter agree.
  const pending = waiting(state, o.who, events).filter((w) =>
    o.allBudgets || w.kind !== 'offer' || w.offer.budget === null || w.offer.budget === o.budget);

  const inView = (e: ThreadEntry): boolean => {
    if (o.allBudgets || e.kind === 'decision') return true;
    const b = e.kind === 'card' ? e.offer.budget : e.budget;
    return b === null || b === o.budget;
  };
  const filter = o.filter ?? 'everything';
  const shown = build(events, state, o.who).filter(inView).filter((e) => {
    if (filter === 'mine') return authorOf(e) === o.who;
    if (filter === 'theirs') { const a = authorOf(e); return a !== null && a !== o.who && a !== 'claude'; }
    if (filter === 'waiting') return e.waits === true;
    return true;
  });

  const end = o.before ? shown.findIndex((e) => e.id === o.before) : shown.length;
  const stop = end < 0 ? shown.length : end;
  const limit = o.limit ?? 100;
  const start = Math.max(0, stop - limit);
  return {
    entries: shown.slice(start, stop),
    waiting: pending,
    newSince: state.readCursor.get(o.who) ?? null,
    before: start > 0 ? shown[start]!.id : null,
  };
}
