/**
 * Its one job: a plan's dates on the calendar. Its due date as an all-day
 * marker, each block of time set aside as a timed event, on the calendar plans
 * go to, made, changed and taken off with the stored etag. The pieces the other
 * calendar modules share (the household's wall clock, the card's formats, the
 * acting member's session and calendar) live here too.
 *
 * The log says which event is a plan's (`plan.calendar.link`) and the etag the
 * app last saw it with. Every change to an event carries that etag; if the NAS
 * has a newer one, someone changed it on their phone, and that is a
 * `calendar.drift` for a person to settle (drift.ts), never a second try that
 * would overwrite them.
 *
 * Nothing here writes to the log. Each sync calls the NAS and returns the
 * events that say what it did, for the caller to append with the plan's own
 * change in one write: a card's approval (the tools' effects), or a member's
 * edit (plan-edits.ts). Writes go only to the calendar plans go to
 * (`targetCalendar`, the Household one unless the household chose another),
 * which is shared read-write with every member, and are made with the acting
 * member's own DSM session.
 *
 * Its neighbours: drift.ts (noticing and settling a change made on the
 * calendar), appointments.ts (an appointment asked for in words), and
 * calendar-view.ts (what Today's rail and the Calendar screen draw). The names
 * callers and tests import are re-exported from here.
 */

import { liveChildren } from './plan-rules.ts';
import { ensureHouseholdCalendar, targetCalendar } from './settings.ts';
import { ToolError } from './errors.ts';
import { EtagMismatch, SynologyError, createEvent, deleteEvent, getEvent, listCalendars, requireSid, setEvent } from './synology.ts';
import type { CalEvent, CalendarInfo, DsmFetch, NewCalEvent } from './synology.ts';
import type { NewEvent } from './store.ts';
import type { ToolContext } from './tools.ts';
import { sameCalendar, zoneOf } from './types.ts';
import type { Block, CalendarLink, CalendarRef, Day, DriftSide, Plan } from './types.ts';

/**
 * DSM's answer for an event that is not there (or not this account's to see).
 * The fake DSM's code and the client's guess (see NOT_AN_ETAG_REFUSAL in
 * synology.ts); the first real delete on the NAS confirms it.
 */
const NO_SUCH_EVENT = 9009;

export const isGone = (err: unknown): boolean =>
  err instanceof SynologyError && !(err instanceof EtagMismatch) && err.code === NO_SUCH_EVENT;

// ─── the event a plan means ───────────────────────────────────────────────────

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** How far `tz` is ahead of UTC at the instant `ms`, in milliseconds. */
function offsetAt(ms: number, tz: string): number {
  let f = zoneFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFormats.set(tz, f);
  }
  const part = (type: string) => Number(f.formatToParts(new Date(ms)).find((p) => p.type === type)!.value);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** A time on the clock on `day` where the household is, in epoch seconds. */
export function wallTime(day: Day, h: number, min: number, sec: number, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, h, min, sec);
  // Twice: the first guess at the offset is taken at the wrong instant on a day the clocks change.
  const first = wall - offsetAt(wall, tz);
  return (wall - offsetAt(first, tz)) / 1000;
}

/** Midnight at the start of `day` where the household is, in epoch seconds. */
export const midnight = (day: Day, tz: string): number => wallTime(day, 0, 0, 0, tz);

/** `day` moved by `n` days, as days on the calendar (never 24-hour steps). */
export function addDays(day: Day, n: number): Day {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function nextDay(day: Day): Day {
  return addDays(day, 1);
}

const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/**
 * The event for a plan's due date (all day, from midnight on the day to
 * midnight after it, where the household is) or for one of its blocks (the
 * time it sets aside). Titled as the plan, and saying where it came from in
 * words, since the planner has no address a phone could open.
 */
export function eventFor(plan: Plan, kind: 'due' | 'block', block: Block | null, tz: string, cal: CalendarRef): NewCalEvent {
  const base = {
    cal_id: cal.cal_id, original_cal_id: cal.original_cal_id,
    summary: plan.title,
    description: `From Home Planner · Plan › ${plan.area} › ${plan.title}`,
    tz_id: tz,
  };
  if (kind === 'due') {
    if (!plan.due) throw new Error(`${plan.id} has no due date to put on the calendar`);
    return { ...base, is_all_day: true, dtstart: midnight(plan.due, tz), dtend: midnight(nextDay(plan.due), tz) };
  }
  if (!block) throw new Error(`a block event for ${plan.id} needs its block`);
  return { ...base, is_all_day: false, dtstart: seconds(block.start), dtend: seconds(block.end) };
}

export const side = (e: { dtstart: number; dtend: number; summary: string }): DriftSide =>
  ({ dtstart: e.dtstart, dtend: e.dtend, summary: e.summary });

/**
 * An event as the NAS answered for it is only kept when it says where it is
 * and what it is: a whole `evt_id`, its uid and etag, and both calendar ids.
 * A reply or a listed row missing any of these is malformed, and is never
 * linked or written back (its `cal_id` would reach DSM as the word "undefined").
 */
export const wellFormed = (e: Partial<CalEvent>): boolean =>
  Number.isInteger(e.evt_id) && !!e.ical_uid && !!e.dav_etag && !!e.cal_id && !!e.original_cal_id;

/**
 * The fields of `want` to send with a set: only those with a value. DSM is
 * sent what is here as text, and an undefined would arrive as "undefined".
 */
export function changesOf(want: NewCalEvent): Partial<Pick<CalEvent, 'summary' | 'description' | 'is_all_day' | 'dtstart' | 'dtend' | 'tz_id'>> {
  const out: Record<string, unknown> = {};
  for (const k of ['summary', 'description', 'is_all_day', 'dtstart', 'dtend', 'tz_id'] as const) {
    if (want[k] !== undefined && want[k] !== null) out[k] = want[k];
  }
  return out;
}

// ─── links ────────────────────────────────────────────────────────────────────

export type Slot = { kind: 'due' } | { kind: 'block'; block: string };

/** The slot a due or block link fills. */
export const slotOf = (link: CalendarLink): Slot =>
  link.kind === 'block' ? { kind: 'block', block: link.block! } : { kind: 'due' };

export const linkFor = (plan: Plan, slot: Slot): CalendarLink | undefined =>
  plan.links.find((l) => l.kind === slot.kind && (slot.kind !== 'block' || l.block === slot.block));

const slotFields = (slot: Slot) => (slot.kind === 'block' ? { kind: slot.kind, block: slot.block } : { kind: slot.kind });

const linkEvent = (plan: Plan, slot: Slot, e: CalEvent): NewEvent => ({
  op: 'plan.calendar.link', plan: plan.id, ...slotFields(slot),
  // The ids as the NAS answered the member who made it, which for a sharee may
  // differ from the owner's: compared later with sameCalendar, never ===.
  cal_id: e.cal_id, original_cal_id: e.original_cal_id,
  evt_id: e.evt_id, ical_uid: e.ical_uid, dav_etag: e.dav_etag,
});

export const unlinkEvent = (plan: Plan, slot: Slot): NewEvent => ({ op: 'plan.calendar.unlink', plan: plan.id, ...slotFields(slot) });

/**
 * A plan's event that the calendar has differently: what is there now (null
 * when it is gone), what the plan means, and, from the NAS, the etag their
 * version has and who changed it, for the card to name and settle on.
 */
export const driftEvent = (plan: Plan, link: CalendarLink, theirs: CalEvent | null, ours: DriftSide): NewEvent => ({
  op: 'calendar.drift', plan: plan.id, evt_id: link.evt_id, theirs: theirs ? side(theirs) : null, ours,
  ...(theirs?.dav_etag ? { dav_etag: theirs.dav_etag } : {}),
  ...(theirs?.last_modify_user ? { changedBy: theirs.last_modify_user } : {}),
});

/** The linked event as the app last wrote it: where it is and its etag, with the fields it means now. */
const asStored = (link: CalendarLink, want: NewCalEvent): CalEvent => ({
  ...want, cal_id: link.cal_id, original_cal_id: link.original_cal_id,
  evt_id: link.evt_id, ical_uid: link.ical_uid, dav_etag: link.dav_etag, color: '',
});

// ─── the NAS ──────────────────────────────────────────────────────────────────

/**
 * The calendars as the acting member's own account lists them, read once per
 * sync or look. The log keeps a calendar's ids as its maker saw them, and DSM
 * may list a calendar shared with someone else under a `cal_id` of their own
 * (`sameCalendar`), so every call to the NAS about an event addresses its
 * calendar as this member's account knows it (`as`), never by the log's ids.
 * `as` is null for a calendar their account does not list at all.
 */
export interface Listing {
  readonly calendars: readonly CalendarInfo[];
  as<T extends CalendarRef>(ref: T): T | null;
}

export async function listingFor(sid: string, f?: DsmFetch): Promise<Listing> {
  const calendars = await listCalendars(sid, f);
  return {
    calendars,
    as: (ref) => {
      const seen = calendars.find((c) => sameCalendar(c, ref));
      return seen ? { ...ref, cal_id: seen.cal_id, original_cal_id: seen.original_cal_id } : null;
    },
  };
}

/** A calendar the acting member's account does not list: nothing can be read or changed on it as them. */
export const notShared = (ctx: ToolContext) =>
  new ToolError(`that calendar is not shared with ${ctx.who} on the NAS: its maker shares it the next time they open the app`, 409);

/**
 * The acting member's session, how their account lists the calendars, and the
 * calendar plans go to as they address it. If there is no Household calendar
 * yet, the owner's first due date or event makes it; anyone else is told it is
 * the owner's to choose.
 */
export async function where(ctx: ToolContext, f?: DsmFetch): Promise<{ sid: string; cal: CalendarRef; listing: Listing }> {
  const sid = requireSid(ctx);
  await ensureHouseholdCalendar(ctx, [...ctx.store.state.members], f);
  const target = targetCalendar(ctx.store.state);
  if (!target) throw new Error('there is still no calendar for plans after the Household one was made');
  const listing = await listingFor(sid, f);
  const cal = listing.as(target);
  if (!cal) throw notShared(ctx);
  return { sid, cal, listing };
}

/** Make the event, and keep it only if the NAS's answer is one the app can link. Booking's stays are made this way too. */
export async function makeEvent(sid: string, want: NewCalEvent, f?: DsmFetch): Promise<CalEvent> {
  const made = await createEvent(sid, want, f);
  if (wellFormed(made)) return made;
  // Malformed: take it back off the calendar if there is enough to name it by.
  if (Number.isInteger(made.evt_id)) {
    try { await deleteEvent(sid, { ...want, evt_id: made.evt_id }, f); } catch { /* the error below is the answer */ }
  }
  throw new SynologyError('the NAS made the event but did not say which it was', 'SYNO.Cal.Event', 0);
}

/**
 * The zone an event says it was written in, if it says one ICU knows: a name
 * from a phone this server cannot read is no reason to stop the look.
 */
export function zoneCarried(e: CalEvent | null): string | null {
  const tz = e?.tz_id?.trim();
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * Put the plan's event where it should be: made and linked when there is
 * none, changed (with the stored etag) when there is. A refused change is
 * drift: what the NAS has now is `theirs`, and nothing is written.
 *
 * Unless what the NAS has now is still what the app last wrote (`before`) in
 * everything the plan holds: someone changed only a note or a colour. That
 * is no disagreement. The change is made again on the etag it has now,
 * sending only what the plan itself changed, so their note stays. `before` is
 * written in the zone the event itself carries: one the app wrote before the
 * household changed its zone is still the app's own.
 */
async function place(ctx: ToolContext, plan: Plan, slot: Slot, block: Block | null, f?: DsmFetch,
                     beforeIn?: (tz: string) => NewCalEvent | undefined): Promise<NewEvent[]> {
  const { sid, cal, listing } = await where(ctx, f);
  const link = linkFor(plan, slot);
  const want = eventFor(plan, slot.kind, block, zoneOf(ctx.store.state), cal);
  if (!link) return [linkEvent(plan, slot, await makeEvent(sid, want, f))];
  // The link's calendar as this member's account addresses it.
  const here = listing.as(link);
  if (!here) throw notShared(ctx);
  if (!sameCalendar(link, cal)) return move(sid, plan, slot, link, here, want, f);
  try {
    const now = await setEvent(sid, asStored(here, want), changesOf(want), f);
    // A reply without the new etag would leave the link unable to change it again; ask for it.
    const etag = now.dav_etag || (await getEvent(sid, here, f)).dav_etag;
    if (!etag) throw new SynologyError('the NAS changed the event but did not say its new etag', 'SYNO.Cal.Event', 0);
    return [{ op: 'plan.calendar.etag', plan: plan.id, evt_id: link.evt_id, dav_etag: etag }];
  } catch (err) {
    const current = err instanceof EtagMismatch ? err.current : null;
    const before = current ? beforeIn?.(zoneCarried(current) ?? zoneOf(ctx.store.state)) : undefined;
    if (!current || !before || !sameSide(current, side(before))) return [driftEvent(plan, link, theirsFrom(err), side(want))];
    const ours = changesOf(want) as Record<string, unknown>;
    const changed = Object.fromEntries(Object.entries(ours).filter(([k, v]) => (before as unknown as Record<string, unknown>)[k] !== v));
    try {
      const again = Object.keys(changed).length
        ? await setEvent(sid, { ...current, cal_id: here.cal_id, original_cal_id: here.original_cal_id }, changed, f)
        : current;
      const etag = again.dav_etag || (await getEvent(sid, here, f)).dav_etag;
      if (!etag) throw new SynologyError('the NAS changed the event but did not say its new etag', 'SYNO.Cal.Event', 0);
      return [{ op: 'plan.calendar.etag', plan: plan.id, evt_id: link.evt_id, dav_etag: etag }];
    } catch (again) {
      return [driftEvent(plan, link, theirsFrom(again), side(want))];
    }
  }
}

/** Two versions of an event that agree on everything the plan holds: when, and its name. */
const sameSide = (a: DriftSide, b: DriftSide): boolean => a.dtstart === b.dtstart && a.dtend === b.dtend && a.summary === b.summary;

/**
 * What the calendar holds instead, from a refused change: the event as it is
 * now, or null when it is gone. Anything else (a session that ended, a NAS
 * that did not answer, a mismatch whose event could not be read) is not drift
 * and is the answer as it is.
 */
function theirsFrom(err: unknown): CalEvent | null {
  if (err instanceof EtagMismatch && err.current) return err.current;
  if (isGone(err)) return null;
  throw err;
}

/**
 * The household chose another calendar for plans since this event was made:
 * the event goes to it. Checked first (a changed event is drift and stays),
 * made on the new calendar, then taken off the old one; if that fails, the new
 * one is taken back and the error is the answer. `here` is the link as the
 * acting member addresses it.
 */
async function move(sid: string, plan: Plan, slot: Slot, link: CalendarLink, here: CalendarLink,
                    want: NewCalEvent, f?: DsmFetch): Promise<NewEvent[]> {
  let gone = false;
  try {
    const now = await getEvent(sid, here, f);
    if (now.dav_etag !== link.dav_etag) return [driftEvent(plan, link, now, side(want))];
  } catch (err) {
    if (!isGone(err)) throw err;
    gone = true;
  }
  const made = await makeEvent(sid, want, f);
  if (!gone) {
    try {
      await deleteEvent(sid, here, f);
    } catch (err) {
      try { await deleteEvent(sid, made, f); } catch { /* the first error is the answer */ }
      throw err;
    }
  }
  return [linkEvent(plan, slot, made)];
}

/**
 * Take the plan's event off the calendar. Deleting carries no etag in DSM, so
 * the etag is checked first: an event someone changed is not deleted from
 * under them. While the plan stands that is drift (`ifChanged: 'drift'`); for a
 * plan being removed it is simply let go, unlinked and left on the calendar as
 * theirs (`'release'`), since a removed plan can have no question open on it.
 * An event already gone is just unlinked; "gone" is only ever read from a
 * calendar the acting member's account lists, so a calendar they cannot see
 * is never taken for an event deleted.
 */
async function takeOff(ctx: ToolContext, plan: Plan, slot: Slot, link: CalendarLink, ours: DriftSide,
                       ifChanged: 'drift' | 'release', f?: DsmFetch): Promise<NewEvent[]> {
  const { sid, listing } = await where(ctx, f);
  const here = listing.as(link);
  if (!here) throw notShared(ctx);
  let now: CalEvent;
  try {
    now = await getEvent(sid, here, f);
  } catch (err) {
    if (isGone(err)) return [unlinkEvent(plan, slot)];
    throw err;
  }
  if (now.dav_etag !== link.dav_etag) {
    return ifChanged === 'drift' ? [driftEvent(plan, link, now, ours)] : [unlinkEvent(plan, slot)];
  }
  await deleteEvent(sid, here, f);
  return [unlinkEvent(plan, slot)];
}

/** The event a link was last written as, from the plan as it stood, in `tz`; null when the plan has no date for it. */
function lastWrittenEvent(plan: Plan, slot: Slot, link: CalendarLink, tz: string): NewCalEvent | null {
  const block = slot.kind === 'block' ? plan.blocks.find((b) => b.id === slot.block) ?? null : null;
  if (slot.kind === 'due' ? !plan.due : !block) return null;
  return eventFor(plan, slot.kind, block, tz, link);
}

/** The side a link's event was last written with, in `tz`, for a drift found while taking it off or looking. */
export function lastWritten(plan: Plan, slot: Slot, link: CalendarLink, tz: string): DriftSide {
  const e = lastWrittenEvent(plan, slot, link, tz);
  return e ? side(e) : { dtstart: 0, dtend: 0, summary: plan.title };
}

/** What `place` compares a refused change against: the plan's slot as it stood, if it was on the calendar, in a zone. */
const beforeOf = (plan: Plan, slot: Slot) => (tz: string): NewCalEvent | undefined => {
  const link = linkFor(plan, slot);
  return (link && lastWrittenEvent(plan, slot, link, tz)) ?? undefined;
};

// ─── what the plan edits and the tools call ───────────────────────────────────

/**
 * The plan's due date on the calendar: made, moved, or (null) taken off. Takes
 * the plan as it stands before the change. Nothing to do (no date, and none on
 * the calendar) asks nothing of the NAS; anything else needs the member's DSM
 * session (`NeedsDsm` without one).
 */
export async function syncDue(ctx: ToolContext, plan: Plan, due: Day | null, f?: DsmFetch): Promise<NewEvent[]> {
  const slot: Slot = { kind: 'due' };
  const link = linkFor(plan, slot);
  const tz = zoneOf(ctx.store.state);
  if (due === null) return link ? takeOff(ctx, plan, slot, link, lastWritten(plan, slot, link, tz), 'drift', f) : [];
  return place(ctx, { ...plan, due }, slot, null, f, beforeOf(plan, slot));
}

/** A block of time on the calendar: made, or moved to the block's times. */
export async function syncBlock(ctx: ToolContext, plan: Plan, block: Block, f?: DsmFetch): Promise<NewEvent[]> {
  const slot: Slot = { kind: 'block', block: block.id };
  return place(ctx, plan, slot, block, f, beforeOf(plan, slot));
}

/** A block let go: its event taken off the calendar. */
export async function unsyncBlock(ctx: ToolContext, plan: Plan, blockId: string, f?: DsmFetch): Promise<NewEvent[]> {
  const slot: Slot = { kind: 'block', block: blockId };
  const link = linkFor(plan, slot);
  return link ? takeOff(ctx, plan, slot, link, lastWritten(plan, slot, link, zoneOf(ctx.store.state)), 'drift', f) : [];
}

/**
 * A plan's dates with no event, put on the calendar: an event made and linked
 * for the due date (`off.due`) and for each block named in `off.blocks`. If
 * one fails, any made before it are taken off again and the error is the answer.
 */
export async function placeDates(ctx: ToolContext, plan: Plan, off: { due: boolean; blocks: readonly string[] },
                                 f?: DsmFetch): Promise<NewEvent[]> {
  const out: NewEvent[] = [];
  try {
    if (off.due && plan.due) out.push(...await place(ctx, plan, { kind: 'due' }, null, f));
    for (const b of plan.blocks) {
      if (off.blocks.includes(b.id)) out.push(...await place(ctx, plan, { kind: 'block', block: b.id }, b, f));
    }
  } catch (err) {
    try { await undoMade(ctx, out, f); } catch { /* the first error is the answer */ }
    throw err;
  }
  return out;
}

/**
 * Before a plan is removed: its due date and blocks off the calendar, one
 * unlink each, to be written before the `plan.remove` (the log refuses an
 * unlink on a removed plan). An event someone changed is left where they put
 * it, and any question still open about one is settled as left alone: a
 * removed plan has nothing to move, and its card lapses with it. An
 * appointment made for the plan is a real one and stands. A plan already
 * removed has nothing to unlink.
 */
export async function unsyncAll(ctx: ToolContext, plan: Plan, f?: DsmFetch): Promise<NewEvent[]> {
  if (plan.removed) return [];
  const out: NewEvent[] = [];
  const tz = zoneOf(ctx.store.state);
  for (const link of plan.links) {
    if (link.kind === 'appointment') continue;
    out.push(...await takeOff(ctx, plan, slotOf(link), link, lastWritten(plan, slotOf(link), link, tz), 'release', f));
  }
  for (const [id, d] of ctx.store.state.drifts) {
    if (d.plan === plan.id && d.resolved === null) out.push({ op: 'calendar.drift.resolve', drift: id, choice: 'leave' });
  }
  return out;
}

/**
 * Undo a sync whose write was then refused: every event it made (a link, or
 * an appointment) is deleted again, once each. A change or a delete cannot be
 * undone, and is left; the next sync sees what is there.
 */
export async function undoMade(ctx: ToolContext, extra: readonly NewEvent[], f?: DsmFetch): Promise<void> {
  const made = new Map<number, CalendarRef & { evt_id: number }>();
  for (const e of extra) {
    if ((e.op === 'plan.calendar.link' || e.op === 'calendar.appointment') && !made.has(e.evt_id)) made.set(e.evt_id, e);
  }
  if (!made.size) return;
  const sid = requireSid(ctx);
  for (const ref of made.values()) await deleteEvent(sid, ref, f);
}

// ─── words, where the household is ───────────────────────────────────────────

type Formats = { day: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat; clock: Intl.DateTimeFormat };
const formats = new Map<string, Formats>();

/** "Sun 8 Nov", "Sun" and "10:00", where the household is: one set per zone, made once and kept. */
export function formatsFor(tz: string): Formats {
  let f = formats.get(tz);
  if (!f) {
    f = {
      day: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }),
      weekday: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }),
      clock: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }),
    };
    formats.set(tz, f);
  }
  return f;
}

export const at = (sec: number) => new Date(sec * 1000);

export const capital = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/** The message and where DSM said it; never the call, which carries the sid. */
export const logDsm = (what: string, err: SynologyError): void =>
  console.warn(`[calendar] ${what}: ${err.message} (${err.api}, code ${err.code})`);

// ─── a plan renamed ───────────────────────────────────────────────────────────

/**
 * A plan given a new title or area: its due date and blocks on the calendar
 * take the new name and description (which names the area), through the same
 * sync as a new date, with the stored etag. An event changed on the calendar
 * since is a drift, as ever, and nothing is retried. Moving a shelf's area
 * moves its items, so theirs follow too. An appointment keeps its own name.
 * Takes the plan as it stands before the change; nothing to rename asks
 * nothing of the NAS.
 */
export async function syncNames(ctx: ToolContext, plan: Plan, set: { title?: string; area?: string },
                                f?: DsmFetch): Promise<NewEvent[]> {
  const title = set.title ?? plan.title;
  const area = set.area ?? plan.area;
  if (title === plan.title && area === plan.area) return [];
  // Each plan as it was, and as it will be.
  const renamed: [Plan, Plan][] = [[plan, { ...plan, title, area }]];
  if (area !== plan.area) renamed.push(...liveChildren(ctx.store.state, plan.id).map((c): [Plan, Plan] => [c, { ...c, area }]));
  const out: NewEvent[] = [];
  for (const [was, p] of renamed) {
    for (const link of p.links) {
      if (link.kind === 'due' && p.due) out.push(...await place(ctx, p, { kind: 'due' }, null, f, beforeOf(was, { kind: 'due' })));
      if (link.kind === 'block') {
        const block = p.blocks.find((b) => b.id === link.block);
        if (block) out.push(...await place(ctx, p, slotOf(link), block, f, beforeOf(was, slotOf(link))));
      }
    }
  }
  return out;
}

export { DRIFT_EVERY_MS, checkDrift, checkDriftNowAndThen, driftWords, raiseDriftCards, settleDrift } from './drift.ts';
export { appointmentTimes, appointmentWords, conflictsFor, freeSlotsNear, makeAppointment } from './appointments.ts';
export type { AppointmentAsked, AppointmentTimes, Conflicts, Seen } from './appointments.ts';
export { WEEK_MAX_DAYS, todayEvents, viewerEvents, weekEvents, weekWindow } from './calendar-view.ts';
export type { EventSource, TodayCalendar, ViewerEvent, WeekCalendar, WeekEvent, WeekKind } from './calendar-view.ts';
