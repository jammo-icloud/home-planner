/**
 * Its one job: a plan's event changed on the calendar, or its page changed
 * in Drive, noticed, asked about and settled.
 *
 * `checkDrift` looks at every linked event and writes what it finds: a
 * `calendar.drift`, and the card that asks about it. A drift is only ever
 * settled by a member choosing on that card (`settleDrift`), or let go with
 * its plan when the plan is removed. Only plan-linked due dates and blocks are
 * looked at; an appointment, linked to a plan or not, is not drift-checked yet.
 * The same look puts on the calendar the dates kept on a plan with no event.
 * `checkPages` does the same for the plans' pages in Drive: a `plan.page.drift`,
 * and its card, settled the same way (`settlePageDrift`).
 */

import { ToolError } from './errors.ts';
import { householdFolder, inHousehold, toDocRef, writeDoc } from './docs.ts';
import { byLink, getFile, isNoSuchFile, listChanges, readFile } from './drive.ts';
import type { DriveFile } from './drive.ts';
import { fmtExact } from './money.ts';
import type { Cents } from './money.ts';
import {
  PAGE_NAME, diffPage, lastPagesLook, normalizeNotes, openPageDrift, pageAt, pageBehind, parsePlanPage, rebuildPage,
  rememberPagesLook, renderPlanPage,
} from './pages.ts';
import {
  at, capital, changesOf, driftEvent, eventFor, formatsFor, isGone, lastWritten, listingFor, logDsm, midnight, notShared, placeDates,
  slotOf, syncDue, syncNames, undoMade, unlinkEvent, zoneCarried,
} from './calendar.ts';
import {
  pageView, planChecklist, planDue, planEstimate, planNotes, planState, planTitle, toPlace,
} from './plan-rules.ts';
import { oneAtATime, planKey } from './settings.ts';
import { offer } from './offers.ts';
import { EtagMismatch, NeedsDsm, SessionLost, SynologyError, deleteEvent, getEvent, requireSid, setEvent } from './synology.ts';
import type { CalEvent, DsmFetch } from './synology.ts';
import type { NewEvent } from './store.ts';
import type { ToolContext } from './tools.ts';
import { TAKEABLE, householdDay, zoneOf } from './types.ts';
import type {
  CalendarLink, ChecklistItem, Day, DocRef, Drift, DriftChoice, DriftSide, Event, EventId, PageChange, PageDrift, PageField,
  PageValue, Plan, PlanId, PlanState, State,
} from './types.ts';

// ─── drift: noticed, asked about, settled ─────────────────────────────────────

/** How often Today looks, at most, per household. A drift is noticed up to this late; a check asked for is not. */
export const DRIFT_EVERY_MS = 10 * 60 * 1000;

/** When each household's calendar was last looked at, by store path. In memory: a restart looks again. */
const lastLooked = new Map<string, number>();
/** A look in progress, by store path: a second caller waits for it rather than asking the NAS twice. */
const looking = new Map<string, Promise<Event[]>>();

const openDriftFor = (state: State, evt_id: number): boolean =>
  [...state.drifts.values()].some((d) => d.evt_id === evt_id && d.resolved === null);

/**
 * Look at every due date and block on the calendar (each link on each live
 * plan) and say where the calendar now has one differently: a `calendar.drift`
 * and a card asking what to do about it, appended as the member looking. An
 * event already asked about is not asked about again; one deleted is a drift
 * with nothing on their side. A change to its times or its name is a drift;
 * one that leaves both as the plan has them (a note, a colour) is no
 * disagreement: the version the app knows is brought up to date and nothing
 * is asked. Then every date kept on a plan with no event (set by someone
 * without a NAS session) is put on the calendar (`placeUnlinked`).
 *
 * Never throws for the NAS. A link the NAS refuses is logged without the sid
 * and the look goes on to the next; a session that ended or a NAS that did
 * not answer stops it, since every later call would fail the same way. What
 * was written is the answer. A sign-in with no NAS session has nothing to
 * look with and looks at nothing.
 *
 * The ten minutes Today waits between looks start only from a look that went
 * all the way through: one that stopped looks again on the next load.
 */
export async function checkDrift(ctx: ToolContext, f?: DsmFetch): Promise<Event[]> {
  if (!ctx.sid) return [];
  const key = ctx.store.path;
  const running = looking.get(key);
  if (running) return running;
  const started = Date.now();
  const look = lookForDrift(ctx, ctx.sid, f)
    .then(({ events, stopped }) => {
      if (!stopped) lastLooked.set(key, started);
      return events;
    })
    .finally(() => looking.delete(key));
  looking.set(key, look);
  return look;
}

/** Today's way in: `checkDrift`, at most once per household per `DRIFT_EVERY_MS`. */
export async function checkDriftNowAndThen(ctx: ToolContext, f?: DsmFetch): Promise<Event[]> {
  if (!ctx.sid) return [];
  const last = lastLooked.get(ctx.store.path);
  if (last !== undefined && Date.now() - last < DRIFT_EVERY_MS) return [];
  return checkDrift(ctx, f);
}

/** A failure every later call to the NAS would meet too: the session ended, or the NAS did not answer. */
const stopsTheLook = (err: SynologyError): boolean => err instanceof SessionLost || err.code === 0;


async function lookForDrift(ctx: ToolContext, sid: string, f?: DsmFetch): Promise<{ events: Event[]; stopped: boolean }> {
  const out: Event[] = [];
  let stopped = false;
  try {
    out.push(...await askAboutUnasked(ctx, 'calendar'));
    const links = [...ctx.store.state.plans.values()]
      .filter((p) => !p.removed)
      .flatMap((p) => p.links.filter((l) => l.kind !== 'appointment').map((l) => ({ plan: p.id, link: l })));
    // One listing for the whole look: each link is read on its calendar as this member's account knows it.
    const listing = links.length ? await listingFor(sid, f) : null;
    for (const { plan: id, link } of links) {
      if (openDriftFor(ctx.store.state, link.evt_id)) continue;
      const here = listing!.as(link);
      if (!here) {
        // Not a calendar their account lists: what is there cannot be read, so nothing is said about it.
        console.warn(`[calendar] event ${link.evt_id} is on a calendar ${ctx.who}'s account does not list; not looked at`);
        continue;
      }
      let now: CalEvent | null;
      try {
        now = await getEvent(sid, here, f);
      } catch (err) {
        if (!(err instanceof SynologyError)) throw err;
        if (!isGone(err)) {
          if (stopsTheLook(err)) throw err;
          logDsm(`could not look at event ${link.evt_id} on the calendar`, err);
          continue;
        }
        now = null;
      }
      if (now && !now.dav_etag) continue; // an answer without its etag says nothing either way
      // Read again: the plan may have changed while the NAS answered.
      const plan = ctx.store.state.plans.get(id);
      const still = plan && !plan.removed ? plan.links.find((l) => l.evt_id === link.evt_id) : undefined;
      if (!plan || !still || still.dav_etag !== link.dav_etag || openDriftFor(ctx.store.state, link.evt_id)) continue;
      if (now?.dav_etag === still.dav_etag) continue;
      // As written in the zone the event itself carries: one the app wrote before the household
      // changed its zone, touched since only by a note, is still the app's own.
      const ours = lastWritten(plan, slotOf(still), still, zoneCarried(now) ?? zoneOf(ctx.store.state));
      if (now && now.dtstart === ours.dtstart && now.dtend === ours.dtend && now.summary === ours.summary) {
        out.push(...await ctx.store.append(ctx.who,
          { op: 'plan.calendar.etag', plan: plan.id, evt_id: still.evt_id, dav_etag: now.dav_etag }));
        continue;
      }
      const written = await ctx.store.append(ctx.who, driftEvent(plan, still, now, ours));
      out.push(...written, ...await raiseDriftCards(ctx, written));
    }
    out.push(...await placeUnlinked(ctx, f));
  } catch (err) {
    if (!(err instanceof SynologyError)) throw err;
    stopped = true;
    logDsm('stopped looking for changes on the calendar', err);
  }
  return { events: out, stopped };
}

/**
 * Dates kept on a plan while whoever set them had no NAS session: a due date
 * or a block with no event (less any a member let go, `toPlace`). Put on the calendar now, by the member looking,
 * one plan at a time under the lock a member's edit and a card's approval
 * take, reading the plan again after the wait. A plan the NAS refuses is
 * logged and the next tried, as is one whose calendar this member's account
 * does not list (`notShared`: nothing can be placed there as them); one whose
 * write is then refused has the events just made taken back off.
 */
async function placeUnlinked(ctx: ToolContext, f?: DsmFetch): Promise<Event[]> {
  const out: Event[] = [];
  const waiting = [...ctx.store.state.plans.values()].filter((p) => {
    const off = toPlace(p);
    return !p.removed && (off.due || off.blocks.length > 0);
  });
  for (const { id } of waiting) {
    try {
      out.push(...await oneAtATime(planKey(ctx.store.path, id), async () => {
        const plan = ctx.store.state.plans.get(id);
        if (!plan || plan.removed) return [];
        const made = await placeDates(ctx, plan, toPlace(plan), f);
        if (!made.length) return [];
        try {
          return await ctx.store.append(ctx.who, made);
        } catch (err) {
          try { await undoMade(ctx, made, f); } catch { /* best effort: the refusal is the answer */ }
          throw err;
        }
      }));
    } catch (err) {
      if (err instanceof ToolError) {
        // A calendar this member's account does not list (a member added after it was made, until its maker opens the app): this plan waits, the look goes on.
        console.warn(`[calendar] could not put ${id}'s dates on the calendar for ${ctx.who}: ${err.message}`);
        continue;
      }
      if (!(err instanceof SynologyError) || stopsTheLook(err)) throw err;
      logDsm(`could not put ${id}'s dates on the calendar`, err);
    }
  }
  return out;
}

// ─── a plan's page, changed in Drive ──────────────────────────────────────────

/**
 * However still the household folder's cursor, every page is looked at this
 * often at least: the safety net in case neither counter moves on the NAS.
 */
export const PAGES_FULL_EVERY_MS = 60 * 60 * 1000;

/** When each household's pages were last looked at, by store path: `checkPagesNowAndThen` waits on it. */
const pagesLooked = new Map<string, number>();
/** A look at the pages in progress, by store path: a second caller waits for it. */
const pagesLooking = new Map<string, Promise<Event[]>>();

/**
 * Every live plan whose page the app has written: read it where its hash
 * moved, and say what changed. One look at the household's folder first; when
 * its cursor is the one this store last saw and the last whole look was under
 * `PAGES_FULL_EVERY_MS` ago, nothing has changed and no page is asked about.
 * (An open page drift with no card asking about it gets its card first, cursor or not.)
 * Otherwise each page is asked about by its link, one at a time:
 *
 *   gone         nothing is asked: a page holds no decision, so the follow-on
 *                writes it again by its path (`rebuildPage`). So too a link
 *                into a folder that is not this household's, and every page
 *                when the household's folder is not there at all.
 *   as written,  or as the open drift found it: already known, not read.
 *   else         read. Unreadable is a drift with nothing listed; read, it is
 *                diffed three ways against the page as written (`pageAt`) and
 *                the plan now. Nothing that differs is their hash recorded
 *                (`plan.doc`, as the calendar's etag-only update is); something
 *                is a `plan.page.drift`, and the card that asks about it.
 *                A page behind the plan and written at an event the log
 *                cannot replay to has nothing to be diffed against: nothing
 *                is noted, and the follow-on rebuilds it.
 *
 * Never throws for the NAS, as `checkDrift`: a page Drive refuses is logged
 * without the sid and the next asked about; a session that ended or a NAS that
 * did not answer stops the look. What was written is the answer.
 */
export async function checkPages(ctx: ToolContext, f?: DsmFetch): Promise<Event[]> {
  if (!ctx.sid || !ctx.household || householdFolder(ctx.store.state) === null) return [];
  const key = ctx.store.path;
  const running = pagesLooking.get(key);
  if (running) return running;
  const started = Date.now();
  const sid = ctx.sid;
  // The follow-on's key (`schedulePages`): a look and a write never interleave on a page.
  const look = oneAtATime(`${key}|pages`, () => lookAtPages(ctx, sid, f))
    .then(({ events, stopped }) => {
      if (!stopped) pagesLooked.set(key, started);
      return events;
    })
    .finally(() => pagesLooking.delete(key));
  pagesLooking.set(key, look);
  return look;
}

/** Today's way in: `checkPages`, at most once per household per `DRIFT_EVERY_MS`, as the calendar's. */
export async function checkPagesNowAndThen(ctx: ToolContext, f?: DsmFetch): Promise<Event[]> {
  if (!ctx.sid) return [];
  const last = pagesLooked.get(ctx.store.path);
  if (last !== undefined && Date.now() - last < DRIFT_EVERY_MS) return [];
  return checkPages(ctx, f);
}

/** What Drive refused, said without the sid, as `logDsm` says the calendar's. */
const logDrive = (what: string, err: SynologyError | ToolError): void =>
  console.warn(`[pages] ${what}: ${err.message}${err instanceof SynologyError ? ` (${err.api}, code ${err.code})` : ''}`);

/** Whether Drive's file is a version already known: the one written, or the one an open drift asks about. */
function known(state: State, id: PlanId, written: DocRef, hash: string): boolean {
  return hash === written.hash || openPageDrift(state, id)?.drift.theirs.hash === hash;
}

async function lookAtPages(
  ctx: ToolContext, sid: string, f?: DsmFetch,
): Promise<{ events: Event[]; stopped: boolean }> {
  const key = ctx.store.path;
  const out: Event[] = [];
  const started = Date.now();
  try {
    out.push(...await askAboutUnasked(ctx, 'page'));
    // Past the gate a folder is chosen, and a choice is never taken back; read now, so one chosen since is the one looked in.
    const home = householdFolder(ctx.store.state);
    if (home === null) return { events: out, stopped: false };
    let cursor: string;
    try {
      ({ cursor } = await listChanges(sid, home, f));
    } catch (err) {
      if (!isNoSuchFile(err)) throw err;
      // No folder: no page has been written here yet, so there is none to look at. A plan that has
      // a page all the same (a household restored on another NAS, or under a new id) has it in a
      // folder that is not this household's: each is written again by its path, here.
      for (const p of ctx.store.state.plans.values()) if (!p.removed && p.page) rebuildPage(ctx, p.id);
      return { events: out, stopped: false };
    }
    const seen = lastPagesLook(key);
    if (seen && seen.cursor === cursor && started - seen.at < PAGES_FULL_EVERY_MS) return { events: out, stopped: false };

    // The log, read only once a page's hash has moved, and again if it is behind the page asked about.
    let log: readonly Event[] | null = null;
    const writtenAt = async (id: PlanId, at: EventId) => {
      log ??= await ctx.store.since(null);
      const view = pageAt(log, id, at);
      if (view) return view;
      log = await ctx.store.since(null);
      return pageAt(log, id, at);
    };

    let whole = true;
    const pages = [...ctx.store.state.plans.values()].flatMap((p) => (!p.removed && p.page ? [{ id: p.id, doc: p.page.doc }] : []));
    for (const { id, doc } of pages) {
      let file: DriveFile;
      let text: string | null;
      try {
        file = await getFile(sid, byLink(doc.link), f);
        // A link into another household's folder (this one restored as a copy on the same NAS) is
        // not this household's page: never read or diffed, written again by its path, here.
        if (!inHousehold(file, ctx.store.state)) {
          rebuildPage(ctx, id);
          continue;
        }
        if (known(ctx.store.state, id, doc, file.hash)) continue;
        try {
          text = await readFile(sid, byLink(doc.link), f);
        } catch (err) {
          // Too large to be a page the app wrote: it cannot be read as one.
          if (!(err instanceof SynologyError && err.status === 413)) throw err;
          text = null;
        }
      } catch (err) {
        if (!(err instanceof SynologyError)) throw err;
        if (isNoSuchFile(err)) {
          rebuildPage(ctx, id);
          continue;
        }
        if (stopsTheLook(err)) throw err;
        logDrive(`could not look at the page for ${id} in Drive`, err);
        whole = false;
        continue;
      }
      const parsed = text === null ? null : parsePlanPage(text);
      const noted = await oneAtATime(planKey(key, id), async (): Promise<Event[]> => {
        // Read again after Drive answered: the page may have been written since (the next look sees
        // it), or what was found noted by another look.
        const p = ctx.store.state.plans.get(id);
        if (!p || p.removed || !p.page || p.page.doc.link !== doc.link || p.page.doc.hash !== doc.hash) return [];
        if (known(ctx.store.state, id, p.page.doc, file.hash)) return [];
        const theirs = toDocRef(file);
        if (!parsed) return ctx.store.append(ctx.who, { op: 'plan.page.drift', plan: id, theirs, changes: [], unreadable: true });
        const now = pageView(p);
        const written = await writtenAt(id, p.page.event);
        if (!written && pageBehind(p)) {
          // Written at an event the log cannot replay to, and behind: what the app wrote is not known,
          // so no edit can be told from the app's own older page. Rebuilt, not asked about.
          rebuildPage(ctx, id);
          return [];
        }
        // Not behind, the page as written is the plan now.
        const base = written ?? now;
        const changes = diffPage(base, parsed.view, now);
        return ctx.store.append(ctx.who, changes.length
          ? { op: 'plan.page.drift', plan: id, theirs, changes }
          : { op: 'plan.doc', plan: id, doc: theirs, event: p.page.event });
      });
      out.push(...noted, ...await raiseDriftCards(ctx, noted));
    }
    if (whole) rememberPagesLook(key, cursor, started);
  } catch (err) {
    // Drive refusing, or a refusal in words on the way, stops the look.
    if (!(err instanceof SynologyError || err instanceof ToolError)) throw err;
    logDrive('stopped looking for changes to the pages in Drive', err);
    return { events: out, stopped: true };
  }
  return { events: out, stopped: false };
}

/** The card for a drift: in front of everyone, from whoever noticed it. */
async function askAbout(ctx: ToolContext, drift: EventId, plan: string, by: string): Promise<Event[]> {
  const before = ctx.store.state.lastEventId;
  const o = await offer(ctx, {
    tool: 'resolve_drift', args: { drift, plan, choice: 'plan' }, prompt: { kind: 'drift', ref: drift }, by,
  });
  return (await ctx.store.since(before)).filter((e) => e.id === o.id);
}

/**
 * The card for a page's drift: the calendar card's shape (`resolve_drift`, a
 * drift prompt naming the drift), in front of everyone, from whoever noticed
 * it, in the page's words (`pageDriftWords`). Written as it stands, so a look
 * never stops on a card the tool would refuse.
 */
async function askAboutPage(ctx: ToolContext, drift: EventId, plan: PlanId, by: string): Promise<Event[]> {
  const p = ctx.store.state.plans.get(plan);
  const d = ctx.store.state.pageDrifts.get(drift);
  if (!p || !d) return [];
  const { summary, effects } = pageDriftWords(p, d, zoneOf(ctx.store.state));
  return ctx.store.append(by, {
    op: 'proposal.offer', tool: 'resolve_drift', args: { drift, plan, choice: 'plan' }, summary, effects,
    events: [], month: null, envelopes: [], fingerprint: '', prompt: { kind: 'drift', ref: drift },
  });
}

/**
 * Every `calendar.drift` and `plan.page.drift` in what was just written gets
 * its card, whichever door it came through: a look at the calendar or the
 * pages, or a change to the plan that found its event changed. The fold
 * retires the card of a drift it replaces.
 */
export async function raiseDriftCards(ctx: ToolContext, written: readonly Event[]): Promise<Event[]> {
  const out: Event[] = [];
  for (const e of written) {
    if (e.op === 'calendar.drift') out.push(...await askAbout(ctx, e.id, e.plan, e.who));
    if (e.op === 'plan.page.drift') out.push(...await askAboutPage(ctx, e.id, e.plan, e.who));
  }
  return out;
}

/**
 * An open drift with no card still asking about it (one whose card was never
 * raised): asked about now. The calendar's look asks about the calendar's
 * drifts, the pages' look about the pages'.
 */
async function askAboutUnasked(ctx: ToolContext, on: 'calendar' | 'page'): Promise<Event[]> {
  const state = ctx.store.state;
  const asked = new Set([...state.thread.offers.values()]
    .filter((o) => o.prompt.kind === 'drift' && (o.status === 'open' || o.status === 'snoozed'))
    .map((o) => String(o.args['drift'])));
  const open = on === 'calendar' ? state.drifts : state.pageDrifts;
  const out: Event[] = [];
  for (const [id, d] of open) {
    const plan = state.plans.get(d.plan);
    if (d.resolved !== null || asked.has(id) || !plan || plan.removed) continue;
    out.push(...await (on === 'calendar' ? askAbout(ctx, id, d.plan, ctx.who) : askAboutPage(ctx, id, d.plan, ctx.who)));
  }
  return out;
}

// ─── the card's words ─────────────────────────────────────────────────────────

/** "Sun 8 Nov", and "Sun 8 Nov, 10:00" (or "10:00–13:00" with its end) for timed, where the household is. */
function when(s: DriftSide, timed: boolean, withEnd: boolean, tz: string): string {
  const f = formatsFor(tz);
  const day = f.day.format(at(s.dtstart));
  if (!timed) return day;
  return `${day}, ${f.clock.format(at(s.dtstart))}${withEnd ? `–${f.clock.format(at(s.dtend))}` : ''}`;
}

/**
 * What the drift card says: who moved what to when ("on their phone", since
 * the NAS does not say where), or that it was deleted; then the plan's side and
 * the calendar's, in the household's zone. A due date is a day; a block is a
 * time.
 */
export function driftWords(plan: Plan, d: Drift, tz: string): { summary: string; effects: string[] } {
  const link = plan.links.find((l) => l.evt_id === d.evt_id);
  const timed = link ? link.kind !== 'due' : true;
  const planHasIt = !(d.ours.dtstart === 0 && d.ours.dtend === 0);
  const who = capital(d.changedBy ?? 'someone');
  // Renamed, and still when the plan has it: the card is about the name.
  if (d.theirs && planHasIt && d.theirs.dtstart === d.ours.dtstart && d.theirs.dtend === d.ours.dtend) {
    return {
      summary: `${who} renamed ${plan.title} to "${d.theirs.summary}" on their phone`,
      effects: [`The plan calls it ${d.ours.summary}`, `The calendar calls it ${d.theirs.summary}`],
    };
  }
  return {
    summary: d.theirs
      ? `${who} moved ${plan.title} to ${when(d.theirs, timed, false, tz)} on their phone`
      : `${plan.title} was deleted from the calendar`,
    effects: [
      planHasIt ? `The plan says ${when(d.ours, timed, true, tz)}` : 'The plan has no date for it now',
      d.theirs ? `The calendar says ${when(d.theirs, timed, true, tz)}` : 'The calendar has nothing: it was deleted',
    ],
  };
}

/** A page's fields, as the card names them. */
const FIELD_WORDS: Readonly<Record<PageField, string>> = {
  title: 'title', area: 'area', state: 'state', due: 'due date', estimate: 'estimate', notes: 'notes',
  checklist: 'checklist', parent: 'parent', people: 'people', envelope: 'envelope', files: 'files',
};

type PageItems = readonly { readonly text: string; readonly done: boolean }[];

/** The items of a checklist change, matched by trimmed text, each at most once. */
function matched(from: PageItems, to: PageItems): { pairs: [PageItems[number] | null, PageItems[number]][]; gone: number } {
  const unused = [...from];
  const pairs = to.map((i): [PageItems[number] | null, PageItems[number]] => {
    const at = unused.findIndex((x) => x.text.trim() === i.text.trim());
    return [at === -1 ? null : unused.splice(at, 1)[0]!, i];
  });
  return { pairs, gone: unused.length };
}

/** "checklist changed (2 ticked, 1 new)"; only reordered, "checklist changed". */
function checklistWords(from: PageItems, to: PageItems): string {
  const { pairs, gone } = matched(from, to);
  const ticked = pairs.filter(([was, i]) => was && !was.done && i.done).length;
  const unticked = pairs.filter(([was, i]) => was && was.done && !i.done).length;
  const added = pairs.filter(([was]) => !was).length;
  const said = [
    ticked ? `${ticked} ticked` : '', unticked ? `${unticked} unticked` : '', added ? `${added} new` : '', gone ? `${gone} removed` : '',
  ].filter(Boolean);
  return said.length ? `checklist changed (${said.join(', ')})` : 'checklist changed';
}

const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** One side of a change, as the card says it: a day where the household is, money in dollars, a title in quotes. */
function valueWords(field: PageField, v: PageValue, tz: string): string {
  if (v === null || v === '') return field === 'due' ? 'no date' : 'none';
  if (field === 'due' && typeof v === 'string' && isDay(v)) {
    return formatsFor(tz).day.format(at(midnight(v, tz)));
  }
  if (field === 'estimate' && typeof v === 'number') return fmtExact(v as Cents);
  if (field === 'title' || field === 'due') return `"${String(v)}"`;
  return String(v);
}

/** What one change on a page is: "due date Fri 20 Nov → Fri 27 Nov", "notes changed". */
function changeWords(c: PageChange, tz: string): string {
  const name = FIELD_WORDS[c.field];
  switch (c.field) {
    case 'notes': return 'notes changed';
    case 'checklist': return Array.isArray(c.from) && Array.isArray(c.to)
      ? checklistWords(c.from as PageItems, c.to as PageItems) : 'checklist changed';
    case 'people': case 'files': return `${name} changed`;
    default: return `${name} ${valueWords(c.field, c.from, tz)} → ${valueWords(c.field, c.to, tz)}`;
  }
}

/** What "Leave both" on a page's card does next. */
const LEAVE_WORDS = "Leave both: the next change to the plan writes the page again, and the version left stays in Drive's history";

/**
 * What a page's card says: the plan, and the first thing changed on its page;
 * then one line for each change, a field only the planner changes saying that
 * taking the change leaves it. The last line says what leaving both does. No
 * one is named: Drive does not say who.
 */
export function pageDriftWords(plan: Plan, d: PageDrift, tz: string): { summary: string; effects: string[] } {
  if (d.unreadable) {
    return {
      summary: `The page for ${plan.title} was changed in Drive and can no longer be read`,
      effects: ['Nothing on it can be taken: put the page back, or leave both', LEAVE_WORDS],
    };
  }
  const first = d.changes[0];
  return {
    summary: `The page for ${plan.title} was changed in Drive${first ? `: ${changeWords(first, tz)}` : ''}`,
    effects: [...d.changes.map((c) => (TAKEABLE.has(c.field)
      ? capital(changeWords(c, tz))
      : `${capital(FIELD_WORDS[c.field])}: only the planner changes this, so taking the change leaves it`)), LEAVE_WORDS],
  };
}

// ─── settling it: the card's three choices ────────────────────────────────────

/**
 * A link as the acting member's account addresses its calendar; one their
 * account does not list cannot be settled by them, and is never read as gone.
 */
async function addressed(ctx: ToolContext, sid: string, link: CalendarLink, f?: DsmFetch): Promise<CalendarLink> {
  const here = (await listingFor(sid, f)).as(link);
  if (!here) throw notShared(ctx);
  return here;
}

/** The event as the NAS has it now; gone since the drift was noticed is a conflict the card can say. */
async function stillThere(sid: string, plan: Plan, link: CalendarLink, f?: DsmFetch): Promise<CalEvent> {
  try {
    return await getEvent(sid, link, f);
  } catch (err) {
    if (isGone(err)) throw new ToolError(`${plan.title} was deleted from the calendar since: move the plan too, or leave both`, 409);
    throw err;
  }
}

/**
 * The events that settle a drift the way a member chose, each ending in the
 * `calendar.drift.resolve` that closes it:
 *
 *   plan      the plan takes the calendar's date or times, and the version on
 *             the calendar is the one the app knows. Deleted there, the plan
 *             lets its date (or the block) go too, and the event is unlinked.
 *   calendar  the event is changed back to what the plan says, with the etag
 *             it has now; the plan with no date for it any more, the event is
 *             taken off. Not offered for an event that was deleted.
 *   leave     nothing moves; the version on the calendar is the one the app
 *             knows, so it is not asked about again. Deleted there, the plan
 *             keeps its date and the event is unlinked.
 *
 * Only `calendar` needs the NAS. The others settle on the etag the drift
 * noted, and ask the NAS for it only when the drift did not say.
 */
export async function settleDrift(ctx: ToolContext, id: EventId, choice: DriftChoice, f?: DsmFetch): Promise<NewEvent[]> {
  const state = ctx.store.state;
  const d = state.drifts.get(id);
  if (!d) throw new ToolError('there is no such change on the calendar', 404);
  if (d.resolved !== null) throw new ToolError('that change on the calendar was already settled', 409);
  const resolve: NewEvent = { op: 'calendar.drift.resolve', drift: id, choice };
  const plan = state.plans.get(d.plan);
  if (!plan || plan.removed) throw new ToolError('that plan has been removed', 409);
  const link = plan.links.find((l) => l.evt_id === d.evt_id);
  if (!link) {
    if (choice === 'leave') return [resolve];
    throw new ToolError(`that event is no longer ${plan.title}'s: leave both to settle it`, 409);
  }
  const slot = slotOf(link);

  if (d.theirs === null) {
    if (choice === 'calendar') {
      throw new ToolError(`${plan.title} was deleted from the calendar, so there is nothing to put back: move the plan too, or leave both`, 409);
    }
    const unlink = unlinkEvent(plan, slot);
    if (choice === 'leave') return [unlink, resolve];
    const clear: NewEvent[] = slot.kind === 'due'
      ? [{ op: 'plan.due', plan: plan.id, due: null }]
      : plan.blocks.some((b) => b.id === slot.block)
        ? [{ op: 'plan.unblock', plan: plan.id, block: slot.block, why: 'deleted from the calendar' }]
        : [];
    return [unlink, ...clear, resolve];
  }

  if (choice === 'calendar') {
    const sid = requireSid(ctx);
    const here = await addressed(ctx, sid, link, f);
    const now = await stillThere(sid, plan, here, f);
    // Changed again on the phone since the card was raised: not put back over what they did next.
    if (d.dav_etag && now.dav_etag !== d.dav_etag) {
      throw new ToolError('it changed again on the calendar; look at it again', 409);
    }
    const block = slot.kind === 'block' ? plan.blocks.find((b) => b.id === slot.block) ?? null : null;
    if (slot.kind === 'due' ? !plan.due : !block) {
      // The plan has no date for it now: the calendar agrees by having none.
      await deleteEvent(sid, here, f);
      return [unlinkEvent(plan, slot), resolve];
    }
    const want = eventFor(plan, slot.kind, block, zoneOf(ctx.store.state), link);
    let set: CalEvent;
    try {
      set = await setEvent(sid, now, changesOf(want), f);
    } catch (err) {
      if (err instanceof EtagMismatch) throw new ToolError('the calendar changed again just now: look at it again', 409);
      throw err;
    }
    const etag = set.dav_etag || (await getEvent(sid, here, f)).dav_etag;
    if (!etag) throw new SynologyError('the NAS changed the event but did not say its new etag', 'SYNO.Cal.Event', 0);
    return [{ op: 'plan.calendar.etag', plan: plan.id, evt_id: link.evt_id, dav_etag: etag }, resolve];
  }

  const etag = d.dav_etag ?? await (async () => {
    const sid = requireSid(ctx);
    return (await stillThere(sid, plan, await addressed(ctx, sid, link, f), f)).dav_etag;
  })();
  const known: NewEvent = { op: 'plan.calendar.etag', plan: plan.id, evt_id: link.evt_id, dav_etag: etag };
  if (choice === 'leave') return [known, resolve];
  const theirs = d.theirs;
  const out: NewEvent[] = [];
  if (theirs.dtstart !== d.ours.dtstart || theirs.dtend !== d.ours.dtend) {
    out.push(slot.kind === 'due'
      ? { op: 'plan.due', plan: plan.id, due: householdDay(zoneOf(ctx.store.state), new Date(theirs.dtstart * 1000)) }
      : {
          op: 'plan.block', plan: plan.id, block: slot.block,
          start: new Date(theirs.dtstart * 1000).toISOString(), end: new Date(theirs.dtend * 1000).toISOString(),
        });
  }
  // Renamed there: the plan takes the name too.
  if (theirs.summary.trim() && theirs.summary.trim() !== plan.title) {
    out.push({ op: 'plan.set', plan: plan.id, title: planTitle(theirs.summary) });
  }
  return [...out, known, resolve];
}

// ─── settling a page's card ───────────────────────────────────────────────────

/** Why a change taken from a page was made: the log says it was the page, the author says who took it. */
const FROM_DRIVE = 'edited in Drive';

/** The page's checklist, keeping each item's id by its first unused trimmed-text match; new ones get new ids. */
function keepIds(have: readonly ChecklistItem[], to: PageValue): ChecklistItem[] {
  if (!Array.isArray(to)) throw new ToolError('the checklist on the page is not a list');
  const unused = [...have];
  return planChecklist((to as PageItems).map((i) => {
    const at = unused.findIndex((x) => x.text.trim() === i.text.trim());
    const was = at === -1 ? undefined : unused.splice(at, 1)[0];
    return { ...(was ? { id: was.id } : {}), text: i.text.trim(), done: i.done };
  }));
}

/** The plan with what a sync just said of its events: new etags, and events made or moved. */
function synced(p: Plan, extra: readonly NewEvent[]): Plan {
  let links = p.links;
  for (const e of extra) {
    if (e.op === 'plan.calendar.etag') links = links.map((l) => (l.evt_id === e.evt_id ? { ...l, dav_etag: e.dav_etag } : l));
    if (e.op === 'plan.calendar.link') {
      const { op: _op, plan: _plan, why: _why, ...link } = e;
      links = [...links.filter((l) => !(l.kind === e.kind && l.block === e.block)), link];
    }
  }
  return { ...p, links };
}

/**
 * The events that take what the page says (only `TAKEABLE` fields), each for
 * `edited in Drive`, and the calendar brought along first, as a member's own
 * edit does: a new title or area renames its events (`syncNames`), then a new
 * due date moves its event (`syncDue`), unless that event was just found
 * changed on the calendar, which is a drift of its own. A date set while the
 * member has no NAS session is kept on the plan, as `setDue` keeps it.
 */
async function takeFromPage(ctx: ToolContext, plan: Plan, changes: readonly PageChange[], f?: DsmFetch): Promise<NewEvent[]> {
  const set: { title?: string; area?: string; estimate?: Cents | null; notes?: string } = {};
  let next: PlanState | undefined;
  let due: Day | null | undefined;
  let items: ChecklistItem[] | undefined;
  for (const c of changes) {
    switch (c.field) {
      case 'title': set.title = planTitle(c.to); break;
      case 'area': {
        const area = String(c.to ?? '');
        // In the fold's own words.
        if (!ctx.store.state.settings.areas.includes(area)) throw new ToolError(`"${area}" is not one of this household's areas`, 400);
        set.area = area;
        break;
      }
      case 'estimate': set.estimate = planEstimate(c.to); break;
      case 'notes': set.notes = planNotes(normalizeNotes(String(c.to ?? ''))); break;
      case 'state': next = planState(c.to); break;
      case 'due': due = planDue(c.to); break;
      case 'checklist': items = keepIds(plan.checklist, c.to); break;
      default: break; // the planner's own: said on the card, never taken
    }
  }
  const events: NewEvent[] = [];
  if (Object.keys(set).length) events.push({ op: 'plan.set', plan: plan.id, ...set, why: FROM_DRIVE });
  if (next !== undefined) events.push({ op: 'plan.state', plan: plan.id, state: next, why: FROM_DRIVE });
  if (due !== undefined) events.push({ op: 'plan.due', plan: plan.id, due, why: FROM_DRIVE });
  if (items) events.push({ op: 'plan.checklist', plan: plan.id, items, why: FROM_DRIVE });

  const extra: NewEvent[] = [];
  if (set.title !== undefined || set.area !== undefined) extra.push(...await syncNames(ctx, plan, set, f));
  const dueLink = plan.links.find((l) => l.kind === 'due');
  const driftedHere = dueLink !== undefined && extra.some((e) => e.op === 'calendar.drift' && e.evt_id === dueLink.evt_id);
  if (due !== undefined && !driftedHere) {
    const renamed = synced({ ...plan, title: set.title ?? plan.title, area: set.area ?? plan.area }, extra);
    try {
      extra.push(...await syncDue(ctx, renamed, due, f));
    } catch (err) {
      if (!(err instanceof NeedsDsm && due !== null && !dueLink)) throw err;
    }
  }
  return [...events, ...extra];
}

/**
 * Whether Drive still has the page that was edited; gone, the follow-on
 * writes it again by its path (`rebuildPage`). Best effort: the log is the
 * record, so a choice that needs nothing from Drive is never held up by it.
 */
async function rebuildIfGone(ctx: ToolContext, id: PlanId, theirs: DocRef, f?: DsmFetch): Promise<void> {
  if (!ctx.sid) return;
  try {
    await getFile(ctx.sid, byLink(theirs.link), f);
  } catch (err) {
    if (isNoSuchFile(err)) rebuildPage(ctx, id);
    else if (err instanceof SynologyError || err instanceof ToolError) logDrive(`could not look at the page for ${id} in Drive`, err);
    else throw err;
  }
}

/**
 * The events that settle a page's drift the way a member chose, each ending
 * in the `calendar.drift.resolve` that closes it:
 *
 *   plan      the plan takes what the page says, field by field (the
 *             planner's own fields are left), for `edited in Drive`, by the
 *             member who chose. Refused for a page that cannot be read. The
 *             version in Drive is then the one on record, at the event the
 *             page showed: the page is behind, and the follow-on writes it.
 *   calendar  the page is put back: written by its path as the plan has it
 *             now, and `plan.doc` names the new version. Drive refusing it
 *             is a 502, and nothing is written.
 *   leave     the version in Drive is the one the app knows, at the event the
 *             page showed (as `plan`): not asked about again. A page that was
 *             behind, or whose plan changed while the card waited, stays
 *             behind and the follow-on writes it; otherwise the next change
 *             to the plan does. The version left stays in Drive's history.
 *
 * A page gone from Drive is settled all the same, and written again by its path.
 */
export async function settlePageDrift(ctx: ToolContext, id: EventId, choice: DriftChoice, f?: DsmFetch): Promise<NewEvent[]> {
  const state = ctx.store.state;
  const d = state.pageDrifts.get(id);
  if (!d) throw new ToolError('there is no such change to a page', 404);
  if (d.resolved !== null) throw new ToolError('that change to the page was already settled', 409);
  const plan = state.plans.get(d.plan);
  if (!plan || plan.removed) throw new ToolError('that plan has been removed', 409);
  const resolve: NewEvent = { op: 'calendar.drift.resolve', drift: id, choice };

  if (choice === 'calendar') {
    requireSid(ctx);
    const doc = await writeDoc(ctx, [plan.id, PAGE_NAME], renderPlanPage(state, plan.id), f);
    if (!doc) throw new ToolError('Drive did not take the page; try again', 502);
    return [{ op: 'plan.doc', plan: plan.id, doc, event: plan.pageEvent }, resolve];
  }
  // The event the page in Drive showed: what it shows of the plan since then is not on it.
  const shown = plan.page?.event ?? plan.pageEvent;
  if (choice === 'leave') {
    await rebuildIfGone(ctx, plan.id, d.theirs, f);
    return [{ op: 'plan.doc', plan: plan.id, doc: d.theirs, event: shown }, resolve];
  }
  if (d.unreadable) throw new ToolError('nothing on it can be taken: put the page back, or leave both', 409);
  const taken = await takeFromPage(ctx, plan, d.changes.filter((c) => TAKEABLE.has(c.field)), f);
  await rebuildIfGone(ctx, plan.id, d.theirs, f);
  return [...taken, { op: 'plan.doc', plan: plan.id, doc: d.theirs, event: shown }, resolve];
}

/**
 * After "take the change" is written: a page that took nothing it shows (only
 * the planner's own fields were changed there) is not behind, so it is
 * written again by its path, the planner's fields as the plan has them.
 */
export function afterPageSettled(ctx: ToolContext, id: EventId): void {
  const d = ctx.store.state.pageDrifts.get(id);
  const p = d ? ctx.store.state.plans.get(d.plan) : undefined;
  if (d?.resolved === 'plan' && p && !p.removed && !pageBehind(p)) rebuildPage(ctx, p.id);
}

/** A plan being removed: each question still open about its page settled as left, the version in Drive the one on record. */
export function letPageDriftsGo(state: State, plan: Plan): NewEvent[] {
  const out: NewEvent[] = [];
  for (const [id, d] of state.pageDrifts) {
    if (d.plan !== plan.id || d.resolved !== null) continue;
    out.push({ op: 'plan.doc', plan: plan.id, doc: d.theirs, event: plan.pageEvent },
      { op: 'calendar.drift.resolve', drift: id, choice: 'leave' });
  }
  return out;
}
