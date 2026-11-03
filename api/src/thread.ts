/**
 * The thread: the household's record, read as a conversation.
 *
 * Each day opens with the briefing; questions, notes and Claude's answers sit
 * where they were written; cards hang off whatever raised them; and every
 * change made directly on a screen appears as a quiet line. It is the log,
 * shaped for reading — nothing here is stored that the log does not hold.
 */

import { changes } from './activity.ts';
import type { Removed } from './activity.ts';
import { waiting } from './offers.ts';
import type { Waiting } from './offers.ts';
import type { Store } from './store.ts';
import { blockedOver } from './booking.ts';
import { currentDoc } from './docs.ts';
import { guestEmail } from './replay.ts';
import { householdDay, isGuest, planShaped, visibleTo, zoneOf } from './types.ts';
import type { Actor, BriefingSource, BudgetId, Day, DriftChoice, Event, EventId, Offer, OfferPrompt, PlanId, State } from './types.ts';

export type ThreadEntry =
  | { kind: 'briefing'; id: EventId; at: string; source: BriefingSource; budget: BudgetId | null; day: Day;
      headline: string; body: string | null; writtenBy: 'claude' | 'fallback'; cards: Offer[];
      /** Kept in Drive: where, and nothing else of it; the words are read back by `GET /api/docs/:event`. */
      doc?: { path: string } }
  | { kind: 'ask' | 'note'; id: EventId; at: string; who: Actor; text: string; budget: BudgetId | null;
      answer?: { id: EventId; at: string; text: string; tools: string[]; cards: Offer[];
                 /** With its whole text in Drive: `text` is the headline, and this is where the rest is. */
                 doc?: { path: string } };
      /** Asked or said on a plan's card. */
      plan?: PlanRef }
  | { kind: 'card'; id: EventId; at: string; who: Actor; offer: Offer;
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
      plan?: PlanRef }
  | { kind: 'change'; id: EventId; at: string; who: Actor; what: string; why: string | null;
      count: number; budget: BudgetId | null;
      /** A guest's name, from the list, to say in place of `guest:<their address>`. */
      name?: string;
      flag?: { removed?: Removed; seenByMe: boolean } };

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
 * A card that stands on its own in the thread rather than hanging under what
 * raised it: a member's own version of one, an ask to take a plan, whose
 * `plan.ask` is a direct change, not something a card hangs under, a
 * drift, which the card says (the `calendar.drift` is never a line), a
 * friend's request to stay, which nothing on the thread raised, and Savings
 * short of the sinking funds, which a balance raised.
 */
const standalone = (kind: OfferPrompt['kind']): boolean =>
  kind === 'member' || kind === 'ask' || kind === 'drift' || kind === 'booking' || kind === 'savings';

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
  'plan.create', 'plan.state', 'plan.remove',
  'plan.due', 'plan.block', 'plan.unblock', 'plan.attach', 'plan.detach',
  'calendar.drift.resolve', 'calendar.appointment', 'calendar.appointment.remove',
]);
const quiet = (e: Event): boolean => !planShaped(e.op) || PLAN_LINES.has(e.op);

/** Every entry, oldest first, before any filter. */
function build(events: readonly Event[], state: State, who: Actor): ThreadEntry[] {
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

  // An answer's cards hang under it, and research asked from a plan is an
  // answer like any other: its cards hang under it the same way.
  const cardsFor = new Map<EventId, Offer[]>();
  for (const o of state.thread.offers.values()) {
    // An appointment for someone's own calendar is theirs alone: the rest of the household never sees it.
    if (standalone(o.prompt.kind) || !o.prompt.ref || !visibleTo(o, who)) continue;
    const ref = o.prompt.kind === 'briefing' ? settle(o.prompt.ref) : o.prompt.ref;
    cardsFor.set(ref, [...(cardsFor.get(ref) ?? []), o]);
  }

  const seen = state.thread.seen.get(who);
  // An approval appends its effect in the same write as the decision. That
  // effect is already on the card, as "approved by"; showing it again as a
  // direct change would say the same thing twice.
  const applied = new Set<EventId>();
  events.forEach((e, i) => {
    if (e.op !== 'proposal.decide' || e.decision !== 'approved') return;
    for (let j = i + 1; j < events.length && events[j]!.at === e.at && events[j]!.who === e.who; j++) {
      applied.add(events[j]!.id);
    }
  });
  // A drift let go because its plan was removed is said by the removal, in the same write.
  const removals = new Set(events.filter((e) => e.op === 'plan.remove').map((e) => `${e.at}|${e.who}`));
  for (const e of events) if (e.op === 'calendar.drift.resolve' && removals.has(`${e.at}|${e.who}`)) applied.add(e.id);
  const changeById = new Map(changes(events.filter((e) => !applied.has(e.id) && quiet(e)), state).map((c) => [c.id, c]));
  const answers = new Map<EventId, Extract<Event, { op: 'thread.answer' }>>();
  for (const e of events) if (e.op === 'thread.answer') answers.set(e.replyTo, e);
  const asks = new Map<EventId, Extract<Event, { op: 'plan.ask' }>>();
  for (const e of events) if (e.op === 'plan.ask') asks.set(e.id, e);
  const planRef = (id: PlanId): { plan: PlanRef } | Record<never, never> => {
    const p = state.plans.get(id);
    return p ? { plan: { id: p.id, title: p.title } } : {};
  };

  const out: ThreadEntry[] = [];
  for (const e of events) {
    switch (e.op) {
      case 'thread.briefing':
        if (replacedBy.has(e.id) || standsAside.has(e.id)) break;
        out.push({ kind: 'briefing', id: e.id, at: e.at, source: e.source ?? 'budget', budget: e.budget, day: e.day,
          headline: e.headline, body: e.body ?? null, writtenBy: e.writtenBy, cards: cardsFor.get(e.id) ?? [],
          ...(e.doc ? { doc: { path: currentDoc(state, e.doc).path } } : {}) });
        break;
      case 'thread.ask':
      case 'thread.note': {
        const a = e.op === 'thread.ask' ? answers.get(e.id) : undefined;
        out.push({
          kind: e.op === 'thread.ask' ? 'ask' : 'note', id: e.id, at: e.at, who: e.who,
          text: e.op === 'thread.ask' ? e.question : e.text, budget: e.budget,
          ...(e.plan ? planRef(e.plan) : {}),
          ...(a ? { answer: { id: a.id, at: a.at, text: a.text, tools: a.tools.map((t) => t.name),
                             cards: cardsFor.get(a.id) ?? [], ...(a.doc ? { doc: { path: currentDoc(state, a.doc).path } } : {}) } } : {}),
        });
        break;
      }
      case 'proposal.offer':
        if (standalone(e.prompt.kind) && visibleTo(state.thread.offers.get(e.id)!, who)) {
          const asked = e.prompt.kind === 'ask' && e.prompt.ref ? asks.get(e.prompt.ref) : undefined;
          const ref = e.prompt.kind === 'drift' ? e.prompt.ref : undefined;
          const calDrift = ref ? state.drifts.get(ref) : undefined;
          const pageDrift = ref && !calDrift ? state.pageDrifts.get(ref) : undefined;
          const drift = calDrift ?? pageDrift;
          const on = asked?.plan ?? drift?.plan ?? e.plan;
          const offer = state.thread.offers.get(e.id)!;
          const blocked = offer.tool === 'approve_booking' && (offer.status === 'open' || offer.status === 'snoozed')
            ? blockedOver(state, offer.args, householdDay(zoneOf(state))) : null;
          out.push({
            kind: 'card', id: e.id, at: e.at, who: e.who, offer,
            ...(asked ? { ask: { by: asked.who, to: asked.to, why: asked.why } } : {}),
            ...(drift ? { drift: {
              on: pageDrift ? 'page' as const : 'calendar' as const, resolved: drift.resolved,
              deleted: calDrift?.theirs === null, replaced: drift.replacedBy !== undefined,
              unreadable: pageDrift?.unreadable === true,
            } } : {}),
            ...(blocked ? { blocked } : {}),
            ...(on ? planRef(on) : {}),
          });
        }
        break;
      default: {
        // Bookkeeping has no line: activity.ts's NOT_A_CHANGE keeps a page
        // written or a file moved to the new folder out of `changes`. How many
        // files are left to move is read from state, not from these lines.
        const c = changeById.get(e.id);
        if (!c) break;
        out.push({
          kind: 'change', id: c.id, at: c.at, who: c.who, what: c.what, why: c.why,
          count: c.count, budget: budgetOf(e),
          ...(isGuest(e.who) ? { name: state.guests.get(guestEmail(e.who))?.name ?? 'A guest' } : {}),
          ...(e.op === 'txn.remove'
            ? { flag: { ...(c.removed ? { removed: c.removed } : {}), seenByMe: c.who === who || !!seen?.has(e.id) } }
            : {}),
        });
      }
    }
  }
  return opensItsDay(out, new Set(householdOn.values()), zoneOf(state));
}

/**
 * The household's briefing opens its day: it moves up to sit before whatever
 * that day had already written by the time someone first looked, and never
 * further. Days are the household's, read in its zone as the server's are.
 */
function opensItsDay(entries: ThreadEntry[], openers: ReadonlySet<EventId>, tz: string): ThreadEntry[] {
  if (!openers.size) return entries;
  const out = [...entries];
  for (let i = 0; i < out.length; i++) {
    const e = out[i]!;
    if (e.kind !== 'briefing' || !openers.has(e.id)) continue;
    let to = i;
    while (to > 0 && householdDay(tz, out[to - 1]!.at) === e.day) to--;
    if (to < i) { out.splice(i, 1); out.splice(to, 0, e); }
  }
  return out;
}

const author = (e: ThreadEntry): Actor | null => ('who' in e ? e.who : null);

export async function thread(store: Store, o: ThreadOptions): Promise<ThreadPage> {
  const events = await store.since(null);
  const state = store.state;
  // What is waiting, as far as this view goes: a card for another budget is
  // counted when that budget is in view, so the count and the Waiting filter agree.
  const pending = waiting(state, o.who, events).filter((w) =>
    o.allBudgets || w.kind !== 'offer' || w.offer.budget === null || w.offer.budget === o.budget);

  const waitingOffers = new Set(pending.flatMap((w) => (w.kind === 'offer' ? [w.offer.id] : [])));
  const waitingFlags = new Set(pending.flatMap((w) => (w.kind === 'flag' ? [w.event] : [])));
  const hasWaiting = (e: ThreadEntry): boolean => {
    switch (e.kind) {
      case 'briefing': return e.cards.some((c) => waitingOffers.has(c.id));
      case 'ask': case 'note': return !!e.answer?.cards.some((c) => waitingOffers.has(c.id));
      case 'card': return waitingOffers.has(e.offer.id);
      case 'change': return waitingFlags.has(e.id);
    }
  };

  const inView = (e: ThreadEntry): boolean => {
    if (o.allBudgets) return true;
    const b = e.kind === 'card' ? e.offer.budget : e.budget;
    return b === null || b === o.budget;
  };
  const filter = o.filter ?? 'everything';
  const shown = build(events, state, o.who).filter(inView).filter((e) => {
    if (filter === 'mine') return author(e) === o.who;
    if (filter === 'theirs') { const a = author(e); return a !== null && a !== o.who && a !== 'claude'; }
    if (filter === 'waiting') return hasWaiting(e);
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
