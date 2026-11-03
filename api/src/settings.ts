/**
 * The household's shared calendar, made once and kept shared.
 *
 * The calendar lives on the NAS; the fact that it is *the* Household calendar
 * lives in the log. That split is what makes this safe to call on every page
 * load: the log says whether it exists and who made it, and only a missing
 * calendar, or a membership its sharing does not match yet, costs a call to
 * DSM.
 *
 * DSM lets only a calendar's owner change who it is shared with, so the
 * sharing is brought in line with the members (`reconcile`) at two moments,
 * both by the member who made it: when they open the app
 * (`ensureHouseholdCalendar`), and right after they add or remove a member
 * (`reshareHousehold`, from the members routes). A change made by anyone else
 * waits for its maker's next visit.
 */

import { ToolError } from './errors.ts';
import { ReplayError } from './replay.ts';
import { createCalendar, requireSid, shareCalendar, sharingOf } from './synology.ts';
import type { DsmFetch, UserShare } from './synology.ts';
import { resolvedEnv } from './connectors.ts';
import type { ToolContext } from './tools.ts';
import type { Actor, CalendarRef, State } from './types.ts';

const HOUSEHOLD = { displayname: 'Household', color: '#3F6F8C' } as const;

/**
 * DSM's public origin, the address a phone is told to add the NAS's calendar
 * at and the Calendar's link to Synology Calendar leaves for: `DSM_PUBLIC_URL`
 * (`https://nas.example.com:5001`), or null when it is unset or is not an
 * http(s) address with no login in it. Only the origin is kept. It is never
 * guessed from `DSM_URL`, which is usually an address only the container can reach.
 */
export function dsmPublicUrl(raw: string | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  try {
    const u = new URL(text);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

/** DSM's public origin as it stands now: saved, else DSM_PUBLIC_URL, else null. Read per use. */
export const currentPublicUrl = (): string | null => dsmPublicUrl(resolvedEnv()['DSM_PUBLIC_URL']);

/**
 * One at a time per key. Two members opening the app in the same second must
 * not make two calendars, so each call waits for the one before it and then
 * reads the log afresh: the second finds the first one's calendar. Keyed by
 * the store's path for the Household calendar, and by store and plan
 * (`planKey`) for a change to a plan's events on the calendar. A key must
 * never be taken again inside its own run: that run would wait on itself.
 */
const inFlight = new Map<string, Promise<unknown>>();

export function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = inFlight.get(key) ?? Promise.resolve();
  const work = before.then(run);
  const settled = work.catch(() => undefined);
  inFlight.set(key, settled);
  void settled.then(() => { if (inFlight.get(key) === settled) inFlight.delete(key); });
  return work;
}

/**
 * The key a change to one plan's events on the calendar waits on: a member's
 * edit (plan-edits.ts) and a card's approval (offers.ts, tools.ts) take the
 * same one, so two of them on one plan never both find it unlinked and both
 * make an event. Read the plan again after the wait, never before it.
 */
export const planKey = (path: string, plan: string): string => `${path}|plan|${plan}`;

/**
 * Who this process has last shared each calendar with, keyed by
 * `${store.path}|${cal_id}`, as lower-case names. Without it every page load
 * would ask DSM; with it only a membership that differs from it does. A
 * restart forgets it, and the next call asks DSM once.
 */
const sharedWith = new Map<string, ReadonlySet<string>>();

const refOf = (c: CalendarRef): CalendarRef => ({ cal_id: c.cal_id, original_cal_id: c.original_cal_id });

/** Where plans go: the calendar someone chose, else the Household one, else nowhere yet. */
export const targetCalendar = (state: State): CalendarRef | null =>
  state.calendar.target ?? (state.calendar.household ? refOf(state.calendar.household) : null);

/**
 * The Household calendar: made and recorded if it is not in the log, and
 * shared read-write with every member but the person who made it. Only the
 * household's owner makes it; anyone else asking before it exists is refused.
 */
export async function ensureHouseholdCalendar(
  ctx: ToolContext,
  members: readonly Actor[],
  f?: DsmFetch,
): Promise<CalendarRef> {
  const sid = requireSid(ctx);
  return oneAtATime(ctx.store.path, () => ensure(ctx, sid, members, f));
}

async function ensure(ctx: ToolContext, sid: string, members: readonly Actor[], f?: DsmFetch): Promise<CalendarRef> {
  // Read after the wait, never before it: the call ahead may have just made it.
  const existing = ctx.store.state.calendar.household;
  if (existing) {
    // Only the member who made it can change its sharing. Anyone else just
    // gets the calendar: a newcomer is shared the next time its maker opens
    // the app.
    if (ctx.who === existing.by) await reconcile(ctx, sid, existing, existing.by, members, f);
    return refOf(existing);
  }
  // Which calendar the household uses is the owner's choice: no one else makes it by using it.
  const owner = ctx.store.state.owner;
  if (ctx.who !== owner) throw new ToolError(`only ${owner} can choose the household's calendar`, 403);
  return make(ctx, sid, members, f);
}

/**
 * A new Household calendar in place of the one in the log, for when that one
 * is gone from the NAS (deleted in Synology Calendar, or its maker's account
 * removed). Whoever asks makes it, so it is theirs to share; it is recorded as
 * replacing the old one by its `cal_id`, and shared with every other member.
 * With no calendar in the log yet, it is simply the first.
 */
export async function replaceHouseholdCalendar(
  ctx: ToolContext,
  members: readonly Actor[],
  f?: DsmFetch,
): Promise<CalendarRef> {
  const sid = requireSid(ctx);
  return oneAtATime(ctx.store.path, () => {
    const old = ctx.store.state.calendar.household;
    return old ? make(ctx, sid, members, f, old.cal_id) : ensure(ctx, sid, members, f);
  });
}

/** Make the calendar on the NAS, record it (as replacing `replaces`, if given), and share it. */
async function make(
  ctx: ToolContext, sid: string, members: readonly Actor[], f: DsmFetch | undefined, replaces?: string,
): Promise<CalendarRef> {
  const made = await createCalendar(sid, HOUSEHOLD, f);
  try {
    // Recorded before it is shared: if sharing fails, the next call finds the
    // calendar in the log and shares it, rather than making another.
    await ctx.store.append(ctx.who, {
      op: 'calendar.household', cal_id: made.cal_id, original_cal_id: made.original_cal_id, name: made.displayname || HOUSEHOLD.displayname,
      ...(replaces ? { replaces } : {}),
    });
  } catch (err) {
    // Another writer recorded one first (or replaced the lost one first).
    // Theirs stands; this one is left unused.
    const theirs = ctx.store.state.calendar.household;
    if (err instanceof ReplayError && theirs && theirs.cal_id !== replaces) return refOf(theirs);
    throw err;
  }
  const others = members.filter((m) => m !== ctx.who);
  if (others.length) await shareCalendar(sid, made.cal_id, { users: others.map((name) => ({ name, privilege: 'RW' as const })) }, f);
  sharedWith.set(`${ctx.store.path}|${made.cal_id}`, new Set(others.map((m) => m.toLowerCase())));
  return refOf(made);
}

/**
 * After the acting member changed who is in the household: if they made the
 * Household calendar, share it with exactly the members there are now.
 *
 * Best effort. The membership change is already in the log and stands either
 * way, and the same reconcile runs again the next time the calendar's maker
 * opens the app, so a refusal here is swallowed rather than failing the
 * route. Nothing is logged: the error would say nothing actionable, and what
 * reaches a log must never carry the sid.
 */
export async function reshareHousehold(ctx: ToolContext, f?: DsmFetch): Promise<void> {
  const cal = ctx.store.state.calendar.household;
  if (!cal || ctx.who !== cal.by || !ctx.sid) return;
  const sid = ctx.sid;
  try {
    await oneAtATime(ctx.store.path, async () => {
      // Read after the wait: the household may have changed in the meantime.
      const now = ctx.store.state.calendar.household;
      if (now && now.by === ctx.who) await reconcile(ctx, sid, now, now.by, [...ctx.store.state.members], f);
    });
  } catch {
    // Best effort; see above.
  }
}

/**
 * Make the calendar's sharing match the household: every member but its maker
 * read-write, and no one the log does not count as a member. `Sharing.set`
 * replaces the whole list, so the set sent is the members already there at the
 * privilege they have, plus the newcomers read-write, plus every group exactly
 * as DSM listed it. Names are compared case-blind, since DSM keeps its own
 * spelling of an account name and the log keeps it lower-case.
 */
async function reconcile(
  ctx: ToolContext, sid: string, cal: CalendarRef, creator: Actor,
  members: readonly Actor[], f?: DsmFetch,
): Promise<void> {
  const key = `${ctx.store.path}|${cal.cal_id}`;
  const wanted = [...new Set(members.filter((m) => m !== creator).map((m) => m.toLowerCase()))];
  const known = sharedWith.get(key);
  if (known && known.size === wanted.length && wanted.every((m) => known.has(m))) return;

  const current = await sharingOf(sid, cal.cal_id, f);
  const kept = current.users.filter((u) => wanted.includes(u.name.toLowerCase()));
  const have = new Set(kept.map((u) => u.name.toLowerCase()));
  const missing = wanted.filter((m) => !have.has(m));
  if (missing.length || kept.length !== current.users.length) {
    const users: UserShare[] = [...kept, ...missing.map((name) => ({ name, privilege: 'RW' as const }))];
    await shareCalendar(sid, cal.cal_id, { users, groups: current.groups }, f);
  }
  sharedWith.set(key, new Set(wanted));
}
