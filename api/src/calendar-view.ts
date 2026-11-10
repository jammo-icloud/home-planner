/**
 * Its one job: what is on the viewer's calendars, as the screens draw it.
 * Today's rail (today and tomorrow) and the Calendar screen's week, with the
 * plans' due dates and the open appointment cards beside what the NAS has.
 * Reads only; the NAS's refusals are a line, never a failure.
 */

import { ToolError } from './errors.ts';
import { addDays, capital, listingFor, logDsm, midnight, nextDay } from './calendar.ts';
import { appointmentTimes } from './appointments.ts';
import type { AppointmentTimes } from './appointments.ts';
import { NeedsDsm, SessionLost, SynologyError, listEvents, requireSid } from './synology.ts';
import type { CalEvent, DsmFetch } from './synology.ts';
import type { ToolContext } from './tools.ts';
import { goalsOf } from './plans.ts';
import { build, daysOf, ordered } from './thread.ts';
import type { DayRow } from './thread.ts';
import { isDay, sameCalendar, visibleTo, zoneOf } from './types.ts';
import type { Actor, CalendarLink, CalendarRef, Day, EventId, Plan, PlanId, PlanState, State } from './types.ts';

/** Whose calendar an event is on, as the viewer sees it: their own, the household's, or one they chose to check. */
export type EventSource = 'mine' | 'household' | 'partner';

/** The plan an event is for, as the Calendar draws it. Not thread.ts's `PlanRef` (`{ id, title }`). */
export interface PlanRef {
  readonly id: PlanId; readonly title: string; readonly state: PlanState; readonly owner: Actor;
  readonly goal: string | null; readonly area: string;
}
export const planRef = (p: Plan): PlanRef => ({ id: p.id, title: p.title, state: p.state, owner: p.owner, goal: p.goal, area: p.area });

/**
 * An event on one of the viewer's calendars: whose calendar it is on and
 * that calendar's name, and, when it is a plan's due date, block or
 * appointment, which plan.
 */
export type ViewerEvent = CalEvent & {
  readonly calendar: EventSource;
  readonly label: string;
  /** Whose calendar it is: the viewer for their own, null for the Household's, a member for one they check, else null. */
  readonly owner: Actor | null;
  readonly plan?: PlanRef;
};

/**
 * What is on the viewer's calendars from `from` to `to` (epoch seconds), and
 * only these: their own default calendar, the Household calendar, and the
 * calendars they chose to be checked against (`calendar.conflicts`), each read
 * once, as their account lists it; one it does not list is left out. Each
 * event says which of the three it came from, and which plan it is when a
 * plan's link has its `evt_id`. In time order. Needs the member's DSM session
 * (`NeedsDsm` without one); the NAS's refusals are the caller's to word.
 */
export async function viewerEvents(ctx: ToolContext, range: { from: number; to: number }, f?: DsmFetch):
  Promise<{ events: ViewerEvent[]; missed: string[]; mine: boolean }> {
  const sid = requireSid(ctx);
  const state = ctx.store.state;
  const listing = await listingFor(sid, f);
  const cals: (CalendarRef & { calendar: EventSource; label: string; owner: Actor | null })[] = [];
  const add = (c: CalendarRef | null | undefined, calendar: EventSource, label: string) => {
    const seen = c ? listing.as(c) : null;
    if (seen && !cals.some((o) => sameCalendar(o, seen))) {
      const owner = calendar === 'mine' ? ctx.who : calendar === 'household' ? null : ownerOf(seen, state);
      cals.push({ cal_id: seen.cal_id, original_cal_id: seen.original_cal_id, calendar, label, owner });
    }
  };
  add(listing.calendars.find((c) => c.isDefault), 'mine', `${capital(ctx.who)}'s calendar`);
  add(state.calendar.household, 'household', state.calendar.household?.name ?? 'Household');
  // One they check that is their own (a second calendar of theirs) is theirs, whatever list it is on.
  for (const c of state.calendar.conflicts.get(ctx.who) ?? []) add(c, ownedBy(listing.as(c) ?? c, ctx.who) ? 'mine' : 'partner', c.label);

  const plans = new Map<number, PlanRef>();
  for (const p of state.plans.values()) {
    if (!p.removed) for (const l of p.links) plans.set(l.evt_id, planRef(p));
  }
  const out: ViewerEvent[] = [];
  const missed: string[] = [];
  for (const cal of cals) {
    // One calendar at a time, so each event is named by the calendar it was found on,
    // and one that cannot be read just now is left out without the others.
    let rows: Awaited<ReturnType<typeof listEvents>>;
    try {
      rows = await listEvents(sid, { calendars: [cal], start: range.from, end: range.to }, f);
    } catch (err) {
      if (!(err instanceof SynologyError) || err instanceof SessionLost || err.code === 0) throw err;
      logDsm(`could not read ${cal.label}`, err);
      missed.push(cal.label);
      continue;
    }
    for (const e of rows) {
      if (!Number.isFinite(e.dtstart) || !Number.isFinite(e.dtend)) continue;
      const plan = Number.isInteger(e.evt_id) ? plans.get(e.evt_id) : undefined;
      out.push({ ...e, cal_id: e.cal_id || cal.cal_id, original_cal_id: e.original_cal_id || cal.original_cal_id,
        calendar: cal.calendar, label: cal.label, owner: cal.owner, ...(plan ? { plan } : {}) });
    }
  }
  return { events: out.sort((a, b) => a.dtstart - b.dtstart || a.dtend - b.dtend), missed, mine: listing.calendars.some((c) => c.isDefault) };
}

/**
 * Whether a calendar is `who`'s own, read from its id: DSM's ids begin with
 * the account they belong to ("/alice/…"), as the Settings screen reads them.
 * The original id is the owner's whatever the account lists a shared calendar
 * under, so it is read first (a sharee's alias begins with the sharee's name).
 */
const accountOf = (c: CalendarRef): string | undefined =>
  /^\/([^/]+)\//.exec(c.original_cal_id || c.cal_id)?.[1]?.toLowerCase();
const ownedBy = (c: CalendarRef, who: string): boolean => accountOf(c) === who.toLowerCase();

/** The member whose calendar this is, by the account its id begins with (case aside); null when that is no member. */
export function ownerOf(c: CalendarRef, state: State): Actor | null {
  const account = accountOf(c);
  return account === undefined ? null : [...state.members].find((m) => m.toLowerCase() === account) ?? null;
}

/**
 * Today's calendar rail: today's events, tomorrow's, or why neither can be
 * shown; `missed` names a calendar that could not be read just now while the
 * rest were.
 */
export interface TodayCalendar {
  readonly today: readonly ViewerEvent[];
  readonly tomorrow: readonly ViewerEvent[];
  readonly unavailable?: string;
  readonly missed?: readonly string[];
}

/**
 * The viewer's events today and tomorrow, where the household is. An event
 * running into both days is in both. A sign-in with no NAS session, or one
 * that ended, is asked to sign in again; any other refusal from the NAS is
 * its reason, in a line; neither is ever a failure of Today.
 */
export async function todayEvents(ctx: ToolContext, f?: DsmFetch): Promise<TodayCalendar> {
  const tz = zoneOf(ctx.store.state);
  const tomorrow = nextDay(ctx.today);
  const [t0, t1, t2] = [midnight(ctx.today, tz), midnight(tomorrow, tz), midnight(nextDay(tomorrow), tz)];
  let events: ViewerEvent[];
  let missed: string[];
  try {
    ({ events, missed } = await viewerEvents(ctx, { from: t0, to: t2 }, f));
  } catch (err) {
    const none = { today: [], tomorrow: [] };
    if (err instanceof NeedsDsm || err instanceof SessionLost) return { ...none, unavailable: 'sign in again to see your calendars' };
    if (!(err instanceof SynologyError)) throw err;
    logDsm('could not read the calendars for Today', err);
    return { ...none, unavailable: err.message };
  }
  return {
    today: events.filter((e) => e.dtstart < t1 && e.dtend > t0),
    tomorrow: events.filter((e) => e.dtstart < t2 && e.dtend > t1),
    ...(missed.length ? { missed } : {}),
  };
}

// ─── the week on screen ───────────────────────────────────────────────────────

/** What an event on the Calendar screen is for: a plan's appointment, due date or block, or none of the app's. */
export type WeekKind = 'appointment' | 'due' | 'block' | 'other';

/**
 * An event on the Calendar screen. One on the NAS is a `ViewerEvent`; one only
 * asked for (`proposed`, the open card's id) or a due date the calendar could
 * not show has no ids of its own. `drift` is the open `calendar.drift` about
 * it; `clash` marks a timed event overlapping another timed one;
 * `offCalendar` a due date or block kept on its plan with no event yet.
 */
export type WeekEvent = Partial<ViewerEvent> & Pick<ViewerEvent, 'summary' | 'is_all_day' | 'dtstart' | 'dtend' | 'calendar' | 'label'> & {
  readonly kind: WeekKind;
  readonly drift?: EventId;
  readonly proposed?: EventId;
  readonly clash?: true;
  readonly offCalendar?: true;
  /**
   * Held nights: a friend's confirmed stay (by its `booking.confirm`) or nights
   * a member kept for the household (by its `booking.block`, and who kept them).
   * Drawn hatched, all day, across the nights.
   */
  readonly held?: { readonly kind: 'stay'; readonly id: EventId; readonly request: EventId; readonly name: string; readonly headcount: number } | { readonly kind: 'block'; readonly id: EventId; readonly by: string };
};

export interface WeekCalendar {
  readonly events: readonly WeekEvent[];
  readonly unavailable?: string;
  /** Calendars that could not be read just now while the rest were. */
  readonly missed?: readonly string[];
  /** Whether the account has a calendar of its own; absent when the calendars could not be read. */
  readonly mine?: boolean;
  /** Every goal a live plan carries, with its plans and how many are done. */
  readonly goals: ReturnType<typeof goalsOf>;
  /** The record's numbers for each day of the window that has entries, as a day card's, unnarrowed. */
  readonly thread: readonly { day: Day; entries: number; by: DayRow['by']; waiting: number }[];
}

/**
 * Mark each timed event that overlaps another timed one, on any of the
 * viewer's calendars: a clash. Back to back is not one, nor is one event the
 * NAS lists on two calendars (the same `evt_id`). A sweep in start order:
 * each event is compared only with those still running when it starts.
 */
export function markClashes(events: readonly WeekEvent[]): WeekEvent[] {
  const timed = events.filter((e) => !e.is_all_day).sort((a, b) => a.dtstart - b.dtstart);
  const clashing = new Set<WeekEvent>();
  let running: WeekEvent[] = [];
  for (const e of timed) {
    running = running.filter((r) => r.dtend > e.dtstart);
    for (const r of running) {
      if (r.evt_id !== undefined && r.evt_id === e.evt_id) continue;
      clashing.add(r);
      clashing.add(e);
    }
    running.push(e);
  }
  return events.map((e) => (clashing.has(e) ? { ...e, clash: true as const } : e));
}

/** The most days the screen asks for at once: a week, or the picker's 42 days. */
export const WEEK_MAX_DAYS = 42;


const dayNumber = (day: Day): number => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};


/**
 * The window asked for, as days where the household is: `start` the first,
 * `end` the day after the last, from one day to `WEEK_MAX_DAYS`. Anything
 * else is the caller's mistake.
 */
export function weekWindow(start: unknown, end: unknown): { start: Day; end: Day } {
  if (!isDay(start) || !isDay(end)) throw new ToolError('start and end are days, such as 2026-11-02');
  const days = dayNumber(end) - dayNumber(start);
  if (days < 1 || days > WEEK_MAX_DAYS) throw new ToolError(`end is after start, and at most ${WEEK_MAX_DAYS} days after it`);
  return { start, end };
}

/**
 * Everything the Calendar screen draws from `start` to `end` (days, the end
 * not included): the viewer's events as Today reads them (their own, the
 * Household calendar, the ones they check), each saying what kind it is from
 * the plan link that has it; every live plan's due date that the calendar did
 * not show (one signed in without the NAS still has its dates); and what open
 * appointment cards ask for, which is on no calendar yet: one for the
 * household's, or for the viewer's own that they asked for. One for the
 * another member's own calendar is theirs, and not drawn. An open drift and a
 * clash between two timed events are marked. In time order. The NAS's
 * refusals are a line, as on Today, never a failure.
 */
export async function weekEvents(ctx: ToolContext, window: { start: Day; end: Day }, f?: DsmFetch): Promise<WeekCalendar> {
  const tz = zoneOf(ctx.store.state);
  const state = ctx.store.state;
  const from = midnight(window.start, tz);
  const to = midnight(window.end, tz);
  let seen: ViewerEvent[] = [];
  let missed: string[] = [];
  let mine = false;
  let unavailable: string | undefined;
  try {
    ({ events: seen, missed, mine } = await viewerEvents(ctx, { from, to }, f));
  } catch (err) {
    if (err instanceof NeedsDsm || err instanceof SessionLost) unavailable = 'sign in again to see your calendars';
    else if (err instanceof SynologyError) {
      logDsm('could not read the calendars for the week', err);
      unavailable = err.message;
    } else throw err;
  }

  const links = new Map<number, CalendarLink>();
  const live = [...state.plans.values()].filter((p) => !p.removed);
  for (const p of live) for (const l of p.links) links.set(l.evt_id, l);
  const drifts = new Map<number, EventId>();
  for (const [id, d] of state.drifts) if (d.resolved === null) drifts.set(d.evt_id, id);
  const driftOf = (evt_id: number | undefined) => (evt_id !== undefined && drifts.has(evt_id) ? { drift: drifts.get(evt_id)! } : {});

  // A confirmed stay's own event on the Household calendar is drawn once, as
  // the held nights below, not a second time as a plain all-day event; a
  // cancelled one's, still there until a member takes it off from its card on
  // Today, is not drawn at all: its nights are open. Once a member has
  // declined that card (left it on the calendar), or the event was meant to be
  // off already (released, or replaced by a change) and is still there, it is
  // the household's event like any other, and drawn as one.
  const leftAlone = new Set<EventId>();
  for (const o of state.thread.offers.values()) {
    if (o.tool === 'release_stay' && o.status === 'declined') leftAlone.add(String(o.args['stay']));
  }
  const stayEvents = new Set<number>();
  for (const [id, st] of state.stays) {
    if (!st.cancelled || (!st.released && !leftAlone.has(id))) stayEvents.add(st.evt_id);
  }
  const out: WeekEvent[] = seen.filter((e) => !(e.calendar === 'household' && stayEvents.has(e.evt_id))).map((e) => {
    const link = links.get(e.evt_id);
    const kind: WeekKind = link ? link.kind : state.appointments.has(e.evt_id) ? 'appointment' : 'other';
    return { ...e, kind, ...driftOf(e.evt_id) };
  });

  const marked: WeekEvent[] = markClashes(out);

  // Due dates the calendar did not show: not linked, not on a calendar the viewer reads, or no NAS to ask.
  // One with no event at all is not on the calendar yet, and is drawn as that.
  const shown = new Set(out.filter((e) => e.kind === 'due').map((e) => e.evt_id));
  const household = state.calendar.household?.name ?? 'Household';
  for (const p of live) {
    if (!p.due || p.due < window.start || p.due >= window.end) continue;
    const link = p.links.find((l) => l.kind === 'due');
    if (link && shown.has(link.evt_id)) continue;
    marked.push({
      summary: p.title, is_all_day: true, dtstart: midnight(p.due, tz), dtend: midnight(nextDay(p.due), tz),
      calendar: 'household', label: household, kind: 'due', plan: planRef(p), ...driftOf(link?.evt_id),
      ...(link ? {} : { offCalendar: true as const }),
    });
  }
  // Blocks the calendars did not show: not linked (no event yet), or linked to an event the viewer does not read.
  // The time is still set aside, so the plan draws it.
  const shownBlocks = new Set(out.filter((e) => e.kind === 'block').map((e) => e.evt_id));
  for (const p of live) {
    for (const b of p.blocks) {
      const link = p.links.find((l) => l.kind === 'block' && l.block === b.id);
      if (link && shownBlocks.has(link.evt_id)) continue;
      const [s, e] = [Date.parse(b.start) / 1000, Date.parse(b.end) / 1000];
      if (!(s < to && e > from)) continue;
      marked.push({
        summary: p.title, is_all_day: false, dtstart: s, dtend: e,
        calendar: 'household', label: household, kind: 'block', plan: planRef(p),
        ...driftOf(link?.evt_id), ...(link ? {} : { offCalendar: true as const }),
      });
    }
  }

  // Held nights, from the log, whether or not the NAS can be read: each
  // confirmed stay as the guest staying, by the name the household has for
  // them and how many (never their address), and each block by its reason.
  for (const [id, st] of state.stays) {
    if (st.cancelled || !(st.arrive < window.end && window.start < st.depart)) continue;
    marked.push({
      summary: `${st.name} staying (${st.headcount})`, is_all_day: true, dtstart: midnight(st.arrive, tz), dtend: midnight(st.depart, tz),
      calendar: 'household', label: household, kind: 'other', held: { kind: 'stay', id, request: st.request, name: st.name, headcount: st.headcount },
    });
  }
  for (const [id, b] of state.stayBlocks) {
    if (!(b.from < window.end && window.start < b.to)) continue;
    marked.push({
      summary: b.why, is_all_day: true, dtstart: midnight(b.from, tz), dtend: midnight(b.to, tz),
      calendar: 'household', label: household, kind: 'other', held: { kind: 'block', id, by: b.by },
    });
  }

  // What open appointment cards ask for: not on a calendar until someone approves.
  for (const o of state.thread.offers.values()) {
    if (o.tool !== 'propose_event' || o.status !== 'open') continue;
    const a = o.args;
    const on = a['on'];
    if ((on !== 'household' && on !== 'mine') || !visibleTo(o, ctx.who)) continue;
    let t: AppointmentTimes;
    try {
      // Read as asked; whether the time has gone is the card's to say, not the week's.
      t = appointmentTimes(a['start'], a['end'], a['allDay'] === true, '0000-01-01', tz, 0);
    } catch {
      continue;
    }
    if (!(t.dtstart < to && t.dtend > from)) continue;
    const p = typeof a['plan'] === 'string' ? state.plans.get(a['plan']) : undefined;
    marked.push({
      summary: typeof a['summary'] === 'string' ? a['summary'].trim() : 'Appointment',
      is_all_day: t.allDay, dtstart: t.dtstart, dtend: t.dtend,
      calendar: on === 'household' ? 'household' : 'mine',
      label: on === 'household' ? household : `${capital(ctx.who)}'s calendar`,
      kind: 'appointment', proposed: o.id,
      ...(on === 'mine' ? { owner: ctx.who } : {}),
      ...(p && !p.removed ? { plan: planRef(p) } : {}),
    });
  }

  const events = marked
    .filter((e) => e.dtstart < to && e.dtend > from)
    .sort((a, b) => a.dtstart - b.dtstart || a.dtend - b.dtend);
  return {
    events, ...(unavailable !== undefined ? {} : { mine }), ...(unavailable !== undefined ? { unavailable } : {}),
    ...(missed.length ? { missed } : {}), goals: goalsOf(state),
    thread: daysOf(ordered(build(await ctx.store.since(null), state, ctx.who)), state, ctx.who, { from: window.start, to: addDays(window.end, -1) })
      .map((r) => ({ day: r.day, entries: r.total, by: r.by, waiting: r.waiting })),
  };
}
