/**
 * Its one job: an appointment asked for in words. Its times read where the
 * household is, the calendars it is checked against, what clashes and what is
 * free instead, the card's words, and, approved, the event on the calendar.
 */

import { ToolError } from './errors.ts';
import { at, capital, formatsFor, listingFor, makeEvent, midnight, nextDay, wallTime, where } from './calendar.ts';
import { targetCalendar } from './settings.ts';
import { listCalendars, listEvents, requireSid } from './synology.ts';
import type { CalEvent, DsmFetch } from './synology.ts';
import type { NewEvent } from './store.ts';
import type { ToolContext } from './tools.ts';
import { householdDay, sameCalendar, zoneOf } from './types.ts';
import type { Actor, CalendarRef, ContactLink, Day, PlanId } from './types.ts';

/**
 * "2026-11-05T10:00" (seconds optional), or a day alone: a time on the clock
 * where the household is. One with its own offset ("Z", "-07:00") is that
 * instant. Anything else, or a date that is not one, is refused.
 */
const LOCAL = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function localTime(v: unknown, name: string, tz: string): { at: number; day: Day; timed: boolean } {
  const m = typeof v === 'string' ? LOCAL.exec(v.trim()) : null;
  const bad = () => new ToolError(`${name} is a date and time where the household is, such as 2026-11-05T10:00`);
  if (!m) throw bad();
  const [, day, hh, mm, ss, offset] = m as unknown as [string, Day, string?, string?, string?, string?];
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  if (new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10) !== day) throw bad();
  if (hh === undefined) return { at: midnight(day, tz), day, timed: false };
  const h = Number(hh), min = Number(mm), sec = Number(ss ?? 0);
  if (h > 23 || min > 59 || sec > 59) throw bad();
  const instant = offset ? Date.parse(v as string) / 1000 : wallTime(day, h, min, sec, tz);
  if (!Number.isFinite(instant)) throw bad();
  return { at: Math.floor(instant), day: householdDay(tz, at(instant)), timed: true };
}

/** When an appointment is, in epoch seconds: all day runs midnight to the midnight after its last day. */
export interface AppointmentTimes { readonly dtstart: number; readonly dtend: number; readonly allDay: boolean; readonly day: Day }

/**
 * The times asked for, checked before anything else is: an end after the
 * start (an all-day one may end on the day it starts), and nothing already
 * gone, which is any day before today and, today, any time before now.
 */
export function appointmentTimes(start: unknown, end: unknown, allDay: boolean, today: Day, tz: string,
                                 now = Date.now()): AppointmentTimes {
  const s = localTime(start, 'start', tz);
  const e = localTime(end, 'end', tz);
  if (allDay) {
    if (e.day < s.day) throw new ToolError('an appointment must end after it starts');
    if (s.day < today) throw new ToolError(`${s.day} has already gone`);
    return { dtstart: midnight(s.day, tz), dtend: midnight(nextDay(e.day), tz), allDay: true, day: s.day };
  }
  if (!s.timed || !e.timed) throw new ToolError('start and end need a time, such as 2026-11-05T10:00, unless it is all day');
  if (!(e.at > s.at)) throw new ToolError('an appointment must end after it starts');
  if (s.at < midnight(today, tz) || (s.day === today && s.at * 1000 < now)) throw new ToolError('that time has already gone');
  return { dtstart: s.at, dtend: e.at, allDay: false, day: s.day };
}

/**
 * An event on one of the calendars looked at, that calendar's name as the
 * member knows it, whether it is the asker's own calendar, and whether it is
 * the household's (the Household calendar, or the one plans go to) rather
 * than someone's own: only the household's are named by title on a card the
 * household sees.
 */
export type Seen = CalEvent & { readonly label: string; readonly own: boolean; readonly shared: boolean };

/** What is on the calendars looked at, the day of an appointment. */
export interface Conflicts {
  /** Timed events overlapping the time asked. */
  readonly clashes: readonly Seen[];
  /** The rest of that day: no overlap, or all day. */
  readonly near: readonly Seen[];
  /** The calendars looked at, by name. */
  readonly checked: readonly string[];
  /** The member's own default calendar, if their account has one. */
  readonly mine: CalendarRef | null;
  /** For one going to the household, the name of the calendar it will be made on. */
  readonly goesTo: string | null;
}

/**
 * The calendars an appointment is checked against, and only these: the
 * asker's own default calendar, the Household calendar (and, for one going
 * there, the calendar plans go to when the household chose another), and the
 * calendars the asker chose to be checked against (`calendar.conflicts`).
 * Each is read as the member looking lists it, once each, and one their
 * account does not see is left out rather than asked about. Someone else
 * working the asker's card out again cannot see the asker's own calendar, so
 * it is not looked at. One for the asker's own calendar, when their account
 * has none, is refused here, before any event is read.
 */
async function calendarsToCheck(ctx: ToolContext, sid: string, on: 'mine' | 'household' | undefined,
                                asker: Actor, f?: DsmFetch) {
  const listing = await listingFor(sid, f);
  const listed = listing.calendars;
  const state = ctx.store.state;
  const own = asker === ctx.who;
  const mine = listed.find((c) => c.isDefault) ?? null;
  if (on === 'mine' && own && !mine) {
    throw new ToolError('your account on the NAS has no calendar of its own: put it on the Household calendar', 409);
  }
  const out: (CalendarRef & { label: string; own: boolean; shared: boolean })[] = [];
  const add = (c: CalendarRef | null | undefined, label: string, kind: 'own' | 'shared' | 'theirs') => {
    const seen = c ? listing.as(c) : null;
    if (seen && !out.some((o) => sameCalendar(o, seen))) {
      out.push({ cal_id: seen.cal_id, original_cal_id: seen.original_cal_id, label, own: kind === 'own', shared: kind === 'shared' });
    }
  };
  if (own) add(mine, `${capital(asker)}'s calendar`, 'own');
  const household = state.calendar.household;
  add(household, household?.name ?? 'Household', 'shared');
  const target = targetCalendar(state);
  const targetName = target && household && sameCalendar(target, household)
    ? household.name
    : (target && listed.find((l) => sameCalendar(l, target))?.displayname) || 'the calendar plans go to';
  if (on === 'household' && target) add(target, targetName, 'shared');
  for (const c of state.calendar.conflicts.get(asker) ?? []) add(c, c.label, 'theirs');
  return {
    mine: mine ? { cal_id: mine.cal_id, original_cal_id: mine.original_cal_id } : null,
    calendars: out,
    // With no calendar for plans yet, the Household one is made on approval.
    goesTo: on === 'household' ? (target ? targetName : 'Household') : null,
  };
}

/**
 * What else is on the day of an appointment from `start` to `end` (epoch
 * seconds), on the calendars it is checked against: what clashes with it,
 * and what is near it. An all-day appointment clashes with nothing.
 * Needs the member's DSM session (`NeedsDsm` without one).
 */
export async function conflictsFor(ctx: ToolContext, start: number, end: number,
                                   o: { allDay?: boolean; on?: 'mine' | 'household'; asker?: Actor; f?: DsmFetch } = {}): Promise<Conflicts> {
  const sid = requireSid(ctx);
  const tz = zoneOf(ctx.store.state);
  const { mine, calendars, goesTo } = await calendarsToCheck(ctx, sid, o.on, o.asker ?? ctx.who, o.f);
  const from = midnight(householdDay(tz, at(start)), tz);
  const to = midnight(nextDay(householdDay(tz, at(Math.max(start, end - 1)))), tz);
  const clashes: Seen[] = [];
  const near: Seen[] = [];
  for (const cal of calendars) {
    // One calendar at a time, so each event is named by the calendar it was found on.
    for (const e of await listEvents(sid, { calendars: [cal], start: from, end: to }, o.f)) {
      if (!Number.isFinite(e.dtstart) || !Number.isFinite(e.dtend)) continue;
      const seen: Seen = { ...e, label: cal.label, own: cal.own, shared: cal.shared };
      if (!o.allDay && !e.is_all_day && e.dtstart < end && e.dtend > start) clashes.push(seen);
      else near.push(seen);
    }
  }
  const byStart = (a: Seen, b: Seen) => a.dtstart - b.dtstart;
  return { clashes: clashes.sort(byStart), near: near.sort(byStart), checked: calendars.map((c) => c.label), mine, goesTo };
}

/**
 * Up to three other times of the same length on the same day, between 07:00
 * and 21:00 where the household is, on the half hour, that overlap nothing
 * timed in `busy` (an all-day event is in nobody's way), none before
 * `notBefore` (epoch seconds) and none overlapping another offered: nearest
 * the time asked first, the earlier of two as near.
 */
export function freeSlotsNear(busy: readonly Pick<CalEvent, 'dtstart' | 'dtend' | 'is_all_day'>[],
                              start: number, end: number, tz: string, notBefore: number): { start: number; end: number }[] {
  const len = end - start;
  const day = householdDay(tz, at(start));
  const open = wallTime(day, 7, 0, 0, tz);
  const close = wallTime(day, 21, 0, 0, tz);
  const timed = busy.filter((b) => !b.is_all_day);
  const overlaps = (a: number, b: number) => (x: { dtstart: number; dtend: number }) => x.dtstart < b && x.dtend > a;
  const free: number[] = [];
  for (let t = open; t + len <= close; t += 30 * 60) {
    if (t !== start && t >= notBefore && !timed.some(overlaps(t, t + len))) free.push(t);
  }
  free.sort((a, b) => Math.abs(a - start) - Math.abs(b - start) || a - b);
  const out: { start: number; end: number }[] = [];
  for (const t of free) {
    if (out.length === 3) break;
    if (!out.some((s) => overlaps(t, t + len)({ dtstart: s.start, dtend: s.end }))) out.push({ start: t, end: t + len });
  }
  return out;
}

/** An appointment as asked for and checked: what it is, when, where it goes, and what it is for. */
export interface AppointmentAsked extends AppointmentTimes {
  readonly summary: string;
  readonly on: 'mine' | 'household';
  /** Who asked for it: on their own calendar (`mine`), only they may approve it. */
  readonly asker: Actor;
  /** The plan it is for: one they have, or (`isNew`) one made with it. */
  readonly plan?: { readonly id: PlanId; readonly title: string; readonly area: string; readonly isNew: boolean };
  readonly contact?: ContactLink;
  /** What the member wrote to go with it (the New event form's Notes): kept in the event's description. */
  readonly notes?: string;
}

/** The longest Notes on an appointment. */
export const NOTES_MAX = 2000;

/** The Notes on an appointment as given: text at most `NOTES_MAX` long, trimmed, or none. */
export function appointmentNotes(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new ToolError('notes are text');
  const notes = v.trim();
  if (notes.length > NOTES_MAX) throw new ToolError(`notes are at most ${NOTES_MAX} characters`);
  return notes;
}

/** The line every event the app makes starts its description with. */
export const MADE_BY = 'From Home Planner';

/**
 * An event's description: the line that says where it came from, then the
 * member's notes after a blank line. `line` is null for an event whose
 * description someone rewrote without it, which then holds the notes alone.
 */
export const descriptionOf = (line: string | null, notes: string): string =>
  [line, notes].filter((x) => x).join('\n\n');

/** An event's description taken apart again: the line that says it is the app's (null if it no longer starts so), and the notes. */
export function partsOfDescription(description: string): { line: string | null; notes: string } {
  if (!description.startsWith(MADE_BY)) return { line: null, notes: description.trim() };
  const [line = '', ...rest] = description.split('\n\n');
  return { line, notes: rest.join('\n\n').trim() };
}

const listed = (names: readonly string[], conj: string): string =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${conj} ${names[names.length - 1]}`;

/** "the Household calendar", or a name that already says it is one as it is. */
const calendarNamed = (name: string): string => (/\bcalendar\b/i.test(name) ? name : `the ${name} calendar`);

const partOfDay = (sec: number, tz: string): string => {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(at(sec)));
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
};

/**
 * What the card for an appointment says. The summary is the time asked, and
 * never another: each clash leads the effects by calendar and time, then up
 * to three free times instead (each one saying so), then where it was looked
 * for when nothing clashes, then what else is on that day, then what it is for.
 *
 * A card for the household's calendar is one the whole household sees, so an
 * event from someone's own calendar (or one they chose to check against) is
 * named by whose it is and when, never by its title: "Alice is busy
 * 10:00–11:00". A card for the asker's own calendar is theirs alone, and
 * names what they can see.
 */
export function appointmentWords(a: AppointmentAsked, seen: Conflicts, today: Day, tz: string,
                                 now = Date.now()): { summary: string; effects: string[] } {
  const f = formatsFor(tz);
  const clock = (sec: number) => f.clock.format(at(sec));
  const lastDay = householdDay(tz, at(a.dtend - 1));
  const span = a.allDay
    ? (lastDay === a.day ? `${f.day.format(at(a.dtstart))}, all day` : `${f.day.format(at(a.dtstart))} to ${f.day.format(at(a.dtend - 1))}, all day`)
    : (householdDay(tz, at(a.dtend)) === a.day || clock(a.dtend) === '0:00'
        ? `${f.day.format(at(a.dtstart))}, ${clock(a.dtstart)}–${clock(a.dtend)}`
        : `${f.day.format(at(a.dtstart))}, ${clock(a.dtstart)} to ${f.day.format(at(a.dtend))}, ${clock(a.dtend)}`);
  // An event that starts on another day (one running over midnight) says which.
  const startsAt = (e: Seen) => (householdDay(tz, at(e.dtstart)) === a.day ? clock(e.dtstart) : `${f.day.format(at(e.dtstart))}, ${clock(e.dtstart)}`);
  // Whose an event is, for a card the household sees: the asker by name, else the calendar's.
  const open = a.on === 'household';
  const hidden = (e: Seen) => open && !e.shared;
  const whose = (e: Seen) => (e.own ? capital(a.asker) : capital(e.label));
  const busy = (e: Seen) => `${startsAt(e)}–${clock(e.dtend)}`;
  const effects: string[] = [];
  for (const c of seen.clashes) {
    effects.push(hidden(c)
      ? `Clashes: ${whose(c)} is busy ${busy(c)}`
      : `Clashes with ${c.label} · ${c.summary || 'something'} ${startsAt(c)}`);
  }
  if (seen.clashes.length) {
    const notBefore = a.day === today ? Math.floor(now / 1000) : 0;
    for (const s of freeSlotsNear([...seen.clashes, ...seen.near], a.dtstart, a.dtend, tz, notBefore)) {
      effects.push(`Free instead: ${f.weekday.format(at(s.start))} ${clock(s.start)}–${clock(s.end)}`);
    }
  } else if (!seen.checked.length) {
    effects.push('There is no calendar to check it against yet');
  } else {
    effects.push(a.allDay
      ? `Looked at ${listed(seen.checked, 'and')} for that day`
      : `Nothing at that time on ${listed(seen.checked, 'or')}`);
  }
  for (const n of seen.near) {
    if (hidden(n)) {
      effects.push(n.is_all_day
        ? `${whose(n)} is busy all day — not a clash`
        : householdDay(tz, at(n.dtstart)) === a.day
          ? `${whose(n)} is busy ${busy(n)} the same ${partOfDay(n.dtstart, tz)} — not a clash`
          : `${whose(n)} is busy from ${startsAt(n)} — not a clash`);
      continue;
    }
    const has = n.own ? 'You have' : `${capital(n.label)} has`;
    const what = n.summary || 'something';
    effects.push(n.is_all_day
      ? `${has} ${what} all day — not a clash`
      : householdDay(tz, at(n.dtstart)) === a.day
        ? `${has} ${what} at ${clock(n.dtstart)} the same ${partOfDay(n.dtstart, tz)} — not a clash`
        : `${has} ${what} from ${startsAt(n)} — not a clash`);
  }
  if (a.plan) effects.push(a.plan.isNew ? `A new plan in ${a.plan.area}: ${a.plan.title}` : `For ${a.plan.title}`);
  if (a.contact) effects.push(`With ${a.contact.display}`);
  return {
    summary: `${a.summary} · ${span} · on ${a.on === 'mine' ? `${capital(a.asker)}'s calendar` : calendarNamed(seen.goesTo ?? 'Household')}`,
    effects,
  };
}

/**
 * Put an approved appointment on the calendar and say so: made on the
 * member's own default calendar (`mine`) or on the calendar plans go to,
 * making the Household one first if there is none. Returns, in the order
 * the log takes them, the new plan (if one is made with it), the
 * `calendar.appointment` with the ids the NAS answered, and the new plan's
 * link to it. Nothing is written here; `undoMade` takes it back off.
 */
export async function makeAppointment(ctx: ToolContext, a: AppointmentAsked, f?: DsmFetch): Promise<NewEvent[]> {
  // The app never writes a partner's own calendar: one for the asker's is theirs to approve.
  if (a.on === 'mine' && a.asker !== ctx.who) {
    throw new ToolError(`only ${capital(a.asker)} can put this on their own calendar`, 409);
  }
  let sid: string;
  let cal: CalendarRef;
  if (a.on === 'household') {
    ({ sid, cal } = await where(ctx, f));
  } else {
    sid = requireSid(ctx);
    const mine = (await listCalendars(sid, f)).find((c) => c.isDefault);
    if (!mine) throw new ToolError('your account on the NAS has no calendar of its own: put it on the Household calendar', 409);
    cal = mine;
  }
  const tz = zoneOf(ctx.store.state);
  const made = await makeEvent(sid, {
    cal_id: cal.cal_id, original_cal_id: cal.original_cal_id, summary: a.summary,
    description: descriptionOf([MADE_BY, ...(a.plan ? [`Plan › ${a.plan.area} › ${a.plan.title}`] : []),
      ...(a.contact ? [`With ${a.contact.display}`] : [])].join(' · '), a.notes ?? ''),
    is_all_day: a.allDay, dtstart: a.dtstart, dtend: a.dtend, tz_id: tz,
  }, f);
  const ids = {
    cal_id: made.cal_id, original_cal_id: made.original_cal_id,
    evt_id: made.evt_id, ical_uid: made.ical_uid, dav_etag: made.dav_etag,
  };
  const appointment: NewEvent = {
    op: 'calendar.appointment', ...ids, summary: a.summary,
    start: at(a.dtstart).toISOString(), end: at(a.dtend).toISOString(), allDay: a.allDay,
    ...(a.plan ? { plan: a.plan.id } : {}),
    ...(a.contact ? { contact: a.contact } : {}),
  };
  if (!a.plan) return [appointment];
  // Linked to its plan, which replaces any appointment linked to it before. The
  // link says which plan it is for; it is not drift-checked yet (drift.ts looks
  // at due dates and blocks only), so a change made to it on a phone is not asked about.
  const link: NewEvent = { op: 'plan.calendar.link', plan: a.plan.id, kind: 'appointment', ...ids };
  if (!a.plan.isNew) return [appointment, link];
  return [{ op: 'plan.create', plan: a.plan.id, title: a.plan.title, area: a.plan.area }, appointment, link];
}
