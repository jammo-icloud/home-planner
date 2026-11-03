/**
 * An appointment by a member's hand: made from the Calendar's New event form,
 * changed, or taken back, and what the form asks while it is being filled in.
 *
 * A person filling the form and pressing Save is the decision, so none of it
 * is a proposal (those are for what Claude suggests). Saving checks the
 * form with the same rules a proposed appointment meets (`appointmentAsked`),
 * makes the event as an approved one is made (`makeAppointment`), and writes
 * what that returns. The NAS is written first, as everywhere: a log line
 * that the NAS refused is never left behind, and an event the log refused is
 * taken off the NAS again.
 */

import { appointmentTimes, conflictsFor, descriptionOf, freeSlotsNear, makeAppointment, partsOfDescription } from './appointments.ts';
import type { Seen } from './appointments.ts';
import { capital, isGone, listingFor, notShared, undoMade } from './calendar.ts';
import { ToolError } from './errors.ts';
import { writePlan } from './plan-edits.ts';
import { appointmentAsked } from './tools.ts';
import type { ToolContext } from './tools.ts';
import { deleteEvent, getEvent, requireSid, setEvent, SynologyError } from './synology.ts';
import type { CalEvent, DsmFetch } from './synology.ts';
import type { NewEvent } from './store.ts';
import { sameCalendar, zoneOf } from './types.ts';
import type { Appointment, Event } from './types.ts';

/** The form's fields, and only these: the rest of a body (a `for`, a `makePlan`, a contact) is not the form's to set. */
const FORM = ['summary', 'start', 'end', 'allDay', 'on', 'plan', 'notes'] as const;

const formArgs = (body: unknown, keys: readonly string[] = FORM): Record<string, unknown> => {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => b[k] !== undefined && b[k] !== null).map((k) => [k, b[k]]));
};

/** A day before any other, so the times of an event already under way are read without being refused as gone. */
const LONG_AGO = '0000-01-01';

/** Save on a new event: made, linked to its plan if one is chosen, and written. Answers with the log's `calendar.appointment`. */
export async function saveNewEvent(ctx: ToolContext, body: unknown, f?: DsmFetch): Promise<Extract<Event, { op: 'calendar.appointment' }>> {
  const asked = appointmentAsked(formArgs(body), ctx);
  const made = await makeAppointment(ctx, asked, f);
  let written: Event[];
  try {
    written = await writePlan(ctx, made);
  } catch (err) {
    // The log refused what the NAS took: the event is taken off again.
    try { await undoMade(ctx, made, f); } catch { /* the first error is the answer */ }
    throw err;
  }
  return written.find((e): e is Extract<Event, { op: 'calendar.appointment' }> => e.op === 'calendar.appointment')!;
}

/**
 * The appointment the app made with this event id, if the member may change
 * it: anyone in the household for one on the Household calendar, and only
 * its maker for one on their own. Any other event was not made here, and is
 * not the app's to change.
 */
function theirs(ctx: ToolContext, evt_id: number): { appt: Appointment; shared: boolean } {
  const state = ctx.store.state;
  const appt = Number.isInteger(evt_id) ? state.appointments.get(evt_id) : undefined;
  if (!appt) throw new ToolError('that event was not made by Home Planner: change it in Synology Calendar', 404);
  const household = state.calendar.household;
  const shared = household !== null && sameCalendar(appt, household);
  if (!shared && appt.who !== ctx.who) {
    throw new ToolError(`only ${capital(appt.who)} can change what is on their own calendar`, 409);
  }
  return { appt, shared };
}

/** The event as the NAS has it now, addressed by the calendar as this member's account knows it; null once it is gone. */
async function live(ctx: ToolContext, sid: string, appt: Appointment, f?: DsmFetch): Promise<{ here: CalEvent; ref: Pick<CalEvent, 'cal_id' | 'original_cal_id' | 'evt_id'> } | null> {
  const here = (await listingFor(sid, f)).as(appt);
  if (!here) throw notShared(ctx);
  const ref = { cal_id: here.cal_id, original_cal_id: here.original_cal_id, evt_id: appt.evt_id };
  try {
    return { here: await getEvent(sid, ref, f), ref };
  } catch (err) {
    if (isGone(err)) return null;
    throw err;
  }
}

/**
 * Save on one the app made: its name, time and notes written to the NAS on
 * the etag just read, keeping the line that says it is Home Planner's. Its
 * calendar and its plan stay as they are. A time left as it was is not
 * refused for having gone: a past event can be renamed, but not moved.
 * A plan's link to it is kept in step with its new etag.
 */
export async function changeEvent(ctx: ToolContext, evt_id: number, body: unknown, f?: DsmFetch): Promise<void> {
  const { appt, shared } = theirs(ctx, evt_id);
  const sid = requireSid(ctx);
  const found = await live(ctx, sid, appt, f);
  if (!found) throw new ToolError('that event is no longer on the calendar: it was deleted in Synology Calendar', 404);
  const { here: current } = found;
  const args = { ...formArgs(body, ['summary', 'start', 'end', 'allDay', 'notes']), on: shared ? 'household' : 'mine' };
  const asRead = appointmentAsked(args, { ...ctx, today: LONG_AGO });
  const unchanged = asRead.dtstart === current.dtstart && asRead.dtend === current.dtend && asRead.allDay === current.is_all_day;
  const asked = unchanged ? asRead : appointmentAsked(args, ctx);
  const { line } = partsOfDescription(current.description);
  const now = await setEvent(sid, current, {
    summary: asked.summary, description: descriptionOf(line, asked.notes ?? ''),
    is_all_day: asked.allDay, dtstart: asked.dtstart, dtend: asked.dtend, tz_id: zoneOf(ctx.store.state),
  }, f);
  // A reply without the new etag would leave the plan's link unable to change it again; ask for it.
  const etag = now.dav_etag || (await getEvent(sid, found.ref, f)).dav_etag;
  const plan = appt.plan ? ctx.store.state.plans.get(appt.plan) : undefined;
  if (plan && !plan.removed && etag && plan.links.some((l) => l.evt_id === evt_id)) {
    await writePlan(ctx, { op: 'plan.calendar.etag', plan: plan.id, evt_id, dav_etag: etag });
  }
}

/**
 * Delete on one the app made: off the NAS, then in the log, with its plan
 * unlinked first if it was the one the plan holds. One already gone from the
 * NAS (deleted in Apple Calendar) is still taken off the app's books.
 */
export async function removeEvent(ctx: ToolContext, evt_id: number, f?: DsmFetch): Promise<void> {
  const { appt } = theirs(ctx, evt_id);
  const sid = requireSid(ctx);
  const found = await live(ctx, sid, appt, f);
  if (found) await deleteEvent(sid, found.ref, f);
  const plan = appt.plan ? ctx.store.state.plans.get(appt.plan) : undefined;
  const linked = !!plan && !plan.removed && plan.links.some((l) => l.kind === 'appointment' && l.evt_id === evt_id);
  const lines: NewEvent[] = [
    ...(plan && linked ? [{ op: 'plan.calendar.unlink', plan: plan.id, kind: 'appointment' } as const] : []),
    // Named as it is now, which may not be what it was made as.
    { op: 'calendar.appointment.remove', evt_id, summary: found?.here.summary.trim() || appt.summary },
  ];
  await writePlan(ctx, lines);
}

/** What clashes with the times on the form, and other times of the same length that are free. */
export interface FormConflicts {
  readonly clashes: readonly Pick<Seen, 'evt_id' | 'summary' | 'label' | 'own' | 'shared' | 'is_all_day' | 'dtstart' | 'dtend'>[];
  /** Up to three, as `freeSlotsNear` finds them: epoch seconds. Only when something clashes. */
  readonly slots: readonly { start: number; end: number }[];
  /** The calendars looked at, by name. */
  readonly checked: readonly string[];
}

/**
 * What the form shows under the times as they change. Only looks: unlike the
 * card, the times may be ones already gone (the member is still typing), and
 * an event being changed (`except`) does not clash with itself.
 */
export async function formConflicts(ctx: ToolContext, body: unknown, f?: DsmFetch): Promise<FormConflicts> {
  const b = formArgs(body, ['start', 'end', 'allDay', 'on', 'except']);
  const on = b['on'];
  if (on !== 'mine' && on !== 'household') throw new ToolError("on is 'mine' or 'household'");
  const tz = zoneOf(ctx.store.state);
  const t = appointmentTimes(b['start'], b['end'], b['allDay'] === true, LONG_AGO, tz, 0);
  let seen;
  try {
    seen = await conflictsFor(ctx, t.dtstart, t.dtend, { allDay: t.allDay, on, ...(f ? { f } : {}) });
  } catch (err) {
    if (err instanceof SynologyError) throw new ToolError(err.message, 502);
    throw err;
  }
  const clashes = seen.clashes.filter((c) => c.evt_id !== b['except']);
  const near = seen.near.filter((c) => c.evt_id !== b['except']);
  const notBefore = t.day === ctx.today ? Math.floor(Date.now() / 1000) : 0;
  const slots = clashes.length && !t.allDay ? freeSlotsNear([...clashes, ...near], t.dtstart, t.dtend, tz, notBefore) : [];
  return {
    clashes: clashes.map(({ evt_id, summary, label, own, shared, is_all_day, dtstart, dtend }) =>
      ({ evt_id, summary, label, own, shared, is_all_day, dtstart, dtend })),
    slots,
    checked: seen.checked,
  };
}
