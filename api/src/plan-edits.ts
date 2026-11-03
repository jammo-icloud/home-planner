/**
 * A member's edits to a plan.
 *
 * Not money, so a member's change is written directly rather than offered.
 * Each helper reads what it was handed (a route passes a request body straight
 * through) with the shared plan rules, the same ones Claude's plan tools use,
 * and leaves the household's rules to the fold, which has the last word; what
 * the fold refuses comes back as a 400 in its own words.
 */

import { placeDates, syncBlock, syncDue, syncNames, undoMade, unsyncAll, unsyncBlock } from './calendar.ts';
import { letPageDriftsGo, raiseDriftCards } from './drift.ts';
import { ToolError } from './errors.ts';
import type { Cents } from './money.ts';
import { offer } from './offers.ts';
import {
  blockTimes, contactLink, envelopeRef, knownArea, livePlan, newBlockId, newPlanId, notOnCalendar, planChecklist, planChips,
  planDue, planEstimate, planNotes, planState, planTitle, required, shelfFor,
} from './plan-rules.ts';
import { ReplayError } from './replay.ts';
import { oneAtATime, planKey } from './settings.ts';
import { NeedsDsm, requireSid } from './synology.ts';
import type { NewEvent } from './store.ts';
import type { ToolContext } from './tools.ts';
import type {
  Actor, BudgetId, ChecklistItem, ContactLink, Day, EnvelopeId, Event, NewEventShape, Plan, PlanId, PlanState,
} from './types.ts';

/** The fields a member edits on a card. Chips and notes are replaced whole. */
export interface PlanFields {
  title: string;
  area: string;
  chips: readonly string[];
  notes: string;
  estimate: Cents | null;
  envelope: { budget: BudgetId; envelope: EnvelopeId } | null;
}

/**
 * The fold refuses what breaks a household rule (a third level, an ask by
 * someone who does not own the plan); that is the member's request being
 * wrong, not the server, so it is a 400 with the fold's reason and without the
 * event id it was stamped with.
 */
async function refusedAs400<T>(writing: Promise<T>): Promise<T> {
  try {
    return await writing;
  } catch (err) {
    if (err instanceof ReplayError) throw new ToolError(err.message.replace(/ \(event .*\)$/, ''), 400);
    throw err;
  }
}

/** Append as the member, the one way every edit here (and every file on a card) writes. */
export const writePlan = (ctx: ToolContext, events: NewEventShape | NewEventShape[]): Promise<Event[]> =>
  refusedAs400(ctx.store.append(ctx.who, events));

/** The plan as it stands after a write. */
export const fresh = (ctx: ToolContext, id: PlanId): Plan => ctx.store.state.plans.get(id)!;

export async function createPlan(ctx: ToolContext, o: { title: string; area: string; parent?: PlanId }): Promise<Plan> {
  const state = ctx.store.state;
  const title = planTitle(o.title);
  const area = knownArea(state, o.area);
  const shelf = shelfFor(state, o.parent, area);
  const plan = newPlanId(title);
  await writePlan(ctx, { op: 'plan.create', plan, title, area, ...(shelf ? { parent: shelf.id } : {}) });
  return fresh(ctx, plan);
}

export async function updatePlan(ctx: ToolContext, id: PlanId, o: Partial<PlanFields>): Promise<Plan> {
  const state = ctx.store.state;
  const p = livePlan(state, id);
  const set: Partial<PlanFields> = {};
  if (o.title !== undefined) set.title = planTitle(o.title);
  if (o.area !== undefined) set.area = knownArea(state, o.area);
  if (o.chips !== undefined) set.chips = planChips(o.chips);
  if (o.notes !== undefined) set.notes = planNotes(o.notes);
  if (o.estimate !== undefined) set.estimate = planEstimate(o.estimate);
  if (o.envelope !== undefined) set.envelope = envelopeRef(state, o.envelope);
  if (!Object.keys(set).length) throw new ToolError('nothing to change: give at least one field');
  // A new title or area goes to its events on the calendar too, in the same write.
  await withCalendar(ctx, p.id, (now) => ({ events: [{ op: 'plan.set', plan: now.id, ...set }], sync: () => syncNames(ctx, now, set) }));
  return fresh(ctx, p.id);
}

export async function setState(ctx: ToolContext, id: PlanId, state: PlanState): Promise<Plan> {
  const p = livePlan(ctx.store.state, id);
  await writePlan(ctx, { op: 'plan.state', plan: p.id, state: planState(state) });
  return fresh(ctx, p.id);
}

/**
 * The one place an ask card is raised. Every `plan.ask` in what was just
 * written gets its card for the member asked, whichever door it came through:
 * a member's own ask (`recordAsk`), an `ask_to_take` proposal committed in
 * the conversation (`commit`), or one approved from a card (`decide`). Take it
 * approves the `plan.ask.accept` the card carries, so even a generic approval
 * can only ever be the asked member's yes; the fold refuses anyone else's
 * decision on it, and settles the card when the ask is answered or lapses.
 */
export async function raiseAskCards(ctx: ToolContext, written: readonly Event[]): Promise<void> {
  for (const e of written) {
    if (e.op !== 'plan.ask') continue;
    await offer(ctx, {
      tool: 'answer_ask', args: { plan: e.plan, answer: 'accept' },
      prompt: { kind: 'ask', ref: e.id }, by: e.who,
    });
  }
}

/** Ask a member to take a plan, and put the card in front of them: two appends, the card naming the ask. */
export async function recordAsk(ctx: ToolContext, plan: PlanId, to: Actor, why: string): Promise<Event> {
  const [asked] = await writePlan(ctx, { op: 'plan.ask', plan, to, why });
  await refusedAs400(raiseAskCards(ctx, [asked!]));
  return asked!;
}

/** The owner asks another member to take it; the fold says who may be asked. */
export async function askToTake(ctx: ToolContext, id: PlanId, to: Actor, why: string): Promise<Plan> {
  const p = livePlan(ctx.store.state, id);
  await recordAsk(ctx, p.id, required(to, 'to'), required(why, 'why'));
  return fresh(ctx, p.id);
}

export async function answerAsk(ctx: ToolContext, id: PlanId, answer: 'accept' | 'decline', why?: string): Promise<Plan> {
  const p = livePlan(ctx.store.state, id);
  if (answer === 'accept') {
    await writePlan(ctx, { op: 'plan.ask.accept', plan: p.id });
  } else if (answer === 'decline') {
    await writePlan(ctx, { op: 'plan.ask.decline', plan: p.id, why: required(why, 'why') });
  } else {
    throw new ToolError('answer must be accept or decline');
  }
  return fresh(ctx, p.id);
}

/** The whole list. An item with no id is new and is given one; an item left out is dropped. */
export async function setChecklist(
  ctx: ToolContext, id: PlanId, items: readonly (Partial<ChecklistItem> & { text: string })[],
): Promise<Plan> {
  const p = livePlan(ctx.store.state, id);
  await writePlan(ctx, { op: 'plan.checklist', plan: p.id, items: planChecklist(items) });
  return fresh(ctx, p.id);
}

/**
 * Set only when a date or a block was kept on the plan but could not go on
 * the calendar: this sign-in has no DSM session (the local sandbox, or one
 * carried over a restart). What the card says afterwards is read from the
 * plan itself (`notOnCalendar`), so it survives a reload.
 */
export interface CalendarNote { calendar?: 'sign in again' }

/**
 * A member's change that has an event on the calendar: the NAS first (the
 * same sync a card's approval runs), then the change and what the NAS said,
 * in one write. If that write is refused, an event the sync made is deleted
 * again. `mayWait` is for a change that only puts something new on the
 * calendar: without a DSM session it is kept on the plan, with no event, and
 * the answer says so; the next look at the calendar by someone with a session
 * puts it there (drift.ts, `placeUnlinked`). Anything that changes or takes off an event already there needs the
 * session, so the calendar is never left saying what the plan no longer does.
 * An event found changed on the calendar is a drift, written with the change,
 * and its card goes up at once.
 *
 * One at a time per plan (`planKey`, the key a card's approval waits on too):
 * `change` is handed the plan as it stands after the wait, so a second change
 * finds the first one's event rather than making another.
 */
async function withCalendar(
  ctx: ToolContext, id: PlanId,
  change: (p: Plan) => { events: NewEventShape[]; sync: () => Promise<NewEvent[]>; first?: boolean; mayWait?: boolean },
): Promise<CalendarNote> {
  return oneAtATime(planKey(ctx.store.path, id), async () => {
    const o = change(livePlan(ctx.store.state, id));
    let extra: NewEvent[] = [];
    let note: CalendarNote = {};
    try {
      extra = await o.sync();
    } catch (err) {
      if (!(err instanceof NeedsDsm && o.mayWait)) throw err;
      note = { calendar: 'sign in again' };
    }
    let written: Event[];
    try {
      written = await writePlan(ctx, o.first ? [...extra, ...o.events] : [...o.events, ...extra]);
    } catch (err) {
      try { await undoMade(ctx, extra); } catch { /* best effort: the refusal is the answer */ }
      throw err;
    }
    await raiseDriftCards(ctx, written);
    return note;
  });
}

export async function setDue(ctx: ToolContext, id: PlanId, due: Day | null): Promise<{ plan: Plan } & CalendarNote> {
  const p = livePlan(ctx.store.state, id);
  const day = planDue(due);
  const note = await withCalendar(ctx, p.id, (now) => ({
    events: [{ op: 'plan.due', plan: now.id, due: day }],
    sync: () => syncDue(ctx, now, day),
    mayWait: day !== null && !now.links.some((l) => l.kind === 'due'),
  }));
  return { plan: fresh(ctx, p.id), ...note };
}

export async function addBlock(ctx: ToolContext, id: PlanId, start: string, end: string): Promise<{ plan: Plan } & CalendarNote> {
  const p = livePlan(ctx.store.state, id);
  const block = { id: newBlockId(), ...blockTimes(start, end) };
  const note = await withCalendar(ctx, p.id, (now) => ({
    events: [{ op: 'plan.block', plan: now.id, block: block.id, start: block.start, end: block.end }],
    sync: () => syncBlock(ctx, now, block),
    mayWait: true,
  }));
  return { plan: fresh(ctx, p.id), ...note };
}

export async function removeBlock(ctx: ToolContext, id: PlanId, block: string, why: string): Promise<{ plan: Plan }> {
  const p = livePlan(ctx.store.state, id);
  const b = required(block, 'block');
  const reason = required(why, 'why');
  await withCalendar(ctx, p.id, (now) => ({
    events: [{ op: 'plan.unblock', plan: now.id, block: b, why: reason }],
    sync: () => unsyncBlock(ctx, now, b),
  }));
  return { plan: fresh(ctx, p.id) };
}

/**
 * The card's "Put it on the calendar": every date of the plan with no event
 * gets one now, including one a member let go when its event was deleted.
 * Needs the member's NAS session.
 */
export async function putOnCalendar(ctx: ToolContext, id: PlanId): Promise<{ plan: Plan }> {
  const p = livePlan(ctx.store.state, id);
  requireSid(ctx);
  await withCalendar(ctx, p.id, (now) => ({ events: [], sync: () => placeDates(ctx, now, notOnCalendar(now)) }));
  return { plan: fresh(ctx, p.id) };
}

/**
 * Its events come off the calendar first, and are unlinked before it is
 * removed, in the same write. A question still open about its page is settled
 * as left, as the calendar's are, so the page can say it was removed.
 */
export async function removePlan(ctx: ToolContext, id: PlanId, why: string): Promise<void> {
  const p = livePlan(ctx.store.state, id);
  const reason = required(why, 'why');
  await withCalendar(ctx, p.id, (now) => ({
    events: [{ op: 'plan.remove', plan: now.id, why: reason }],
    sync: async () => [...await unsyncAll(ctx, now), ...letPageDriftsGo(ctx.store.state, now)],
    first: true,
  }));
}

export async function linkContact(ctx: ToolContext, id: PlanId, c: ContactLink): Promise<Plan> {
  const p = livePlan(ctx.store.state, id);
  await writePlan(ctx, { op: 'plan.contact.link', plan: p.id, ...contactLink(c) });
  return fresh(ctx, p.id);
}

export async function unlinkContact(ctx: ToolContext, id: PlanId, contact_id: number): Promise<Plan> {
  const p = livePlan(ctx.store.state, id);
  if (typeof contact_id !== 'number' || !Number.isInteger(contact_id)) throw new ToolError('contact_id must be a whole number');
  await writePlan(ctx, { op: 'plan.contact.unlink', plan: p.id, contact_id });
  return fresh(ctx, p.id);
}
