/**
 * The log is the truth; this turns it into state.
 *
 * Pure — no I/O, no clock, no randomness. Same events in, same state out, always.
 * That property is what lets the cache be thrown away and rebuilt, and what makes
 * every number in the app reproducible when someone asks where it came from.
 */

import { ZERO, add, sub, cents } from './money.ts';
import type { Cents } from './money.ts';
import { DAY_RE, PLAN_LIMITS, PLAN_STATES, pageView } from './plan-rules.ts';
import type { IncomeSource } from './income.ts';
import {
  ARRIVAL_MAX,
  BRIEFING_SOURCES,
  CALENDAR_LINK_KINDS,
  CLAUDE,
  CLAUDE_MAY,
  CONFIG_OPS,
  DEFAULT_AREAS,
  DRIFT_CHOICES,
  emailKey,
  GUEST_MAY,
  GUEST_PREFIX,
  isEmail,
  isDay,
  isGuest,
  isSpend,
  MODES,
  monthKey,
  moveKey,
  PAGE_FIELDS,
  planShaped,
  REQUIRES_WHY,
  sameCalendar,
  SCHEMES,
  segmentProblem,
  SPLIT,
  SYSTEM,
  systemMay,
  THREAD_TEXT_MAX,
} from './types.ts';
import type {
  AccountBalance, Actor, Adjustment, Appearance, Appointment, Assignment, Budget, BudgetLocation, CalendarLink, CalendarRef, Category,
  DocRef, DocumentsFolder, DocumentsState, Drift, Envelope, Event, EventOf, EnvelopeId, EventId, Guest, MonthPlan, MoveFile, Offer, PageDrift,
  Plan, PlanId, Prediction, Rule, State, Stay, SplitPart, StayBlock, Settings, Txn,
} from './types.ts';

export class ReplayError extends Error {
  // Plain field, not a parameter property: Node's strip-only TypeScript support
  // erases types but never generates code, so `constructor(readonly x)` is out.
  readonly event: Event | undefined;
  constructor(message: string, event?: Event) {
    super(event ? `${message} (event ${event.id}, op ${event.op})` : message);
    this.name = 'ReplayError';
    this.event = event;
  }
}

// Mutable mirrors of the readonly public shapes, used only inside the fold.
interface Draft {
  categories: Map<string, Category>;
  budgets: Map<string, { id: string; label: string; archived?: boolean; location?: BudgetLocation; envelopes: Map<EnvelopeId, Envelope> }>;
  txns: Map<string, Txn>;
  rules: Rule[];
  months: Map<string, {
    budget: string; month: string; openedAt: string; closed?: boolean;
    plan: Map<EnvelopeId, Cents>; adjustments: Adjustment[]; income: Cents;
  }>;
  owner: string | null;
  members: Set<string>;
  label: string;
  incomeSources: Map<string, IncomeSource>;
  readCursor: Map<string, string>;
  predictions: Prediction[];
  offers: Map<string, Offer>;
  seen: Map<Actor, Set<string>>;
  areas: readonly string[];
  links: readonly { label: string; url: string }[];
  arrival: string;
  appearance: Map<Actor, Appearance>;
  household: (CalendarRef & { name: string; by: Actor }) | null;
  target: CalendarRef | null;
  conflicts: Map<Actor, readonly (CalendarRef & { label: string })[]>;
  zone: string | null;
  booking: Settings['booking'];
  model: string | null;
  /** Plans are replaced whole on every change, never mutated, so a thaw shares them. */
  plans: Map<PlanId, Plan>;
  /** Replaced whole on every change too, so a thaw shares them as well. */
  drifts: Map<EventId, Drift>;
  pageDrifts: Map<EventId, PageDrift>;
  appointments: Map<number, Appointment>;
  /** Guests, stays and blocks are replaced whole on every change too. */
  guests: Map<string, Guest>;
  stays: Map<EventId, Stay>;
  stayBlocks: Map<EventId, StayBlock>;
  savingsAccount: string | null;
  /** Replaced whole on every change, so a thaw shares them. */
  balances: Map<string, AccountBalance>;
  documents: {
    folder: DocumentsState['folder'];
    previous: DocumentsFolder | null;
    docs: Map<string, Extract<MoveFile, { kind: 'doc' }>>;
    waiting: Map<string, MoveFile>;
    relinked: Map<string, DocRef>;
  };
  lastEventId: string | null;
  count: number;
}

const emptyDraft = (): Draft => ({
  categories: new Map(), budgets: new Map(), txns: new Map(),
  rules: [], months: new Map(), owner: null, members: new Set(), label: 'Household',
  incomeSources: new Map(), readCursor: new Map(), predictions: [],
  offers: new Map(), seen: new Map(),
  areas: DEFAULT_AREAS, links: [], arrival: '', appearance: new Map(),
  household: null, target: null, conflicts: new Map(),
  zone: null, booking: null, model: null,
  plans: new Map(), drifts: new Map(), pageDrifts: new Map(), appointments: new Map(),
  guests: new Map(), stays: new Map(), stayBlocks: new Map(),
  savingsAccount: null, balances: new Map(),
  documents: { folder: null, previous: null, docs: new Map(), waiting: new Map(), relinked: new Map() },
  lastEventId: null, count: 0,
});

export const emptyState = (): State => freeze(emptyDraft());

function freeze(d: Draft): State {
  const budgets = new Map<string, Budget>();
  for (const [id, b] of d.budgets) budgets.set(id, { id: b.id, label: b.label, ...(b.archived ? { archived: true } : {}), ...(b.location ? { location: b.location } : {}), envelopes: b.envelopes });
  const months = new Map<string, MonthPlan>();
  for (const [k, m] of d.months) months.set(k, { ...m });
  return {
    categories: d.categories, budgets, txns: d.txns, rules: d.rules, months,
    owner: d.owner, members: d.members, label: d.label, zone: d.zone,
    incomeSources: d.incomeSources, readCursor: d.readCursor, predictions: d.predictions,
    thread: { offers: d.offers, seen: d.seen },
    settings: { areas: d.areas, links: d.links, arrival: d.arrival, appearance: d.appearance, booking: d.booking, model: d.model },
    calendar: { household: d.household, target: d.target, conflicts: d.conflicts },
    plans: d.plans, drifts: d.drifts, pageDrifts: d.pageDrifts, appointments: d.appointments,
    guests: d.guests, stays: d.stays, stayBlocks: d.stayBlocks,
    savings: { account: d.savingsAccount, balances: d.balances },
    documents: { ...d.documents },
    lastEventId: d.lastEventId, eventCount: d.count,
  };
}

/** Replay a whole log. */
export function replay(events: Iterable<Event>): State {
  const d = emptyDraft();
  for (const e of events) applyTo(d, e);
  return freeze(d);
}

/**
 * Append to an already-replayed state.
 * Rebuilds the immutable wrapper but reuses the underlying maps, so the common
 * case (one new event) doesn't re-fold the entire history.
 */
export function apply(state: State, events: Iterable<Event>): State {
  const d = thaw(state);
  for (const e of events) applyTo(d, e);
  return freeze(d);
}

function thaw(s: State): Draft {
  const budgets = new Map<string, { id: string; label: string; envelopes: Map<EnvelopeId, Envelope> }>();
  for (const [id, b] of s.budgets) budgets.set(id, { id: b.id, label: b.label, ...(b.archived ? { archived: true } : {}), ...(b.location ? { location: b.location } : {}), envelopes: new Map(b.envelopes) });
  const months = new Map<string, Draft['months'] extends Map<string, infer V> ? V : never>();
  for (const [k, m] of s.months) {
    months.set(k, {
      budget: m.budget, month: m.month, openedAt: m.openedAt,
      // Spread the rest too. Listing the fields by hand dropped `closed` on
      // every incremental apply, so a closed month reopened itself the moment
      // anything else was written.
      ...(m.closed ? { closed: true } : {}),
      plan: new Map(m.plan), adjustments: [...m.adjustments], income: m.income,
    });
  }
  return {
    categories: new Map(s.categories), budgets, txns: new Map(s.txns),
    rules: [...s.rules], months, owner: s.owner, members: new Set(s.members), label: s.label,
    incomeSources: new Map(s.incomeSources), readCursor: new Map(s.readCursor),
    predictions: [...s.predictions],
    offers: new Map(s.thread.offers),
    seen: new Map([...s.thread.seen].map(([who, ids]) => [who, new Set(ids)])),
    // Replaced whole, never mutated in place, so the lists are shared as they are.
    areas: s.settings.areas, links: s.settings.links, arrival: s.settings.arrival,
    appearance: new Map(s.settings.appearance),
    household: s.calendar.household, target: s.calendar.target,
    conflicts: new Map(s.calendar.conflicts),
    zone: s.zone, booking: s.settings.booking, model: s.settings.model,
    plans: new Map(s.plans), drifts: new Map(s.drifts), pageDrifts: new Map(s.pageDrifts), appointments: new Map(s.appointments),
    guests: new Map(s.guests), stays: new Map(s.stays), stayBlocks: new Map(s.stayBlocks),
    savingsAccount: s.savings.account, balances: new Map(s.savings.balances),
    // The folders are replaced whole; the maps are copied, since the fold edits them in place.
    documents: {
      folder: s.documents.folder, previous: s.documents.previous,
      docs: new Map(s.documents.docs), waiting: new Map(s.documents.waiting), relinked: new Map(s.documents.relinked),
    },
    lastEventId: s.lastEventId, count: s.eventCount,
  };
}

// ─── validation ───────────────────────────────────────────────────────────────

/**
 * Reject anything that would corrupt the log. Called before append, and again
 * during replay so a hand-edited file can't quietly produce wrong numbers.
 */
/**
 * Enforced when writing, not when replaying.
 *
 * Requiring a reason is a rule about how decisions are made today. Applying it
 * to events already on disk would make history unreplayable the moment the rule
 * changed — five old deletions in the real log stopped loading, and the receipts
 * they removed came back. What is already written is a fact; Activity marks the
 * ones with no reason rather than pretending they cannot exist.
 */
export function requireReason(e: Event): void {
  if (!REQUIRES_WHY.has(e.op)) return;
  const why = (e as { why?: string }).why;
  if (!why || !why.trim()) throw new ReplayError('this change requires a reason', e);
}

/**
 * What is wrong with a split's parts, or null. Shape only: whether they add up
 * to the receipt needs the receipt, so the fold checks that.
 */
export function checkParts(parts: readonly SplitPart[]): string | null {
  if (!Array.isArray(parts)) return 'a split needs a list of parts';
  if (parts.length < 2) return 'a split has at least two parts';
  if (parts.some((p) => p === null || typeof p !== 'object' || typeof p.category !== 'string')) return 'a part names its category';
  if (parts.some((p) => !Number.isInteger(p.amount) || p.amount === 0)) return 'a part is a whole number of cents, not zero';
  if (new Set(parts.map((p) => p.category)).size < parts.length) return 'a category appears twice in the split';
  if (parts.some((p) => p.category === SPLIT)) return 'a part of a split cannot itself be split';
  return null;
}

/**
 * What is wrong with dividing a receipt of `amount` into `parts`, or null: the
 * shape, then that every spend category exists (transfers and income pass), then
 * that the parts add up. Both entry points, the categorize tool and the import
 * commit, ask this, so they cannot disagree about what a split is.
 */
export function splitProblem(
  parts: readonly SplitPart[], amount: Cents,
  categories: { has(c: string): boolean }, noCategory: (c: string) => string,
): string | null {
  const shape = checkParts(parts);
  if (shape) return shape;
  for (const p of parts) if (isSpend(p.category) && !categories.has(p.category)) return noCategory(p.category);
  if (parts.reduce((sum, p) => sum + p.amount, 0) !== amount) return 'the parts of a split must add up to the receipt';
  return null;
}

export function validate(e: Event): void {
  if (!e.id) throw new ReplayError('event has no id', e);
  if (!e.at || Number.isNaN(Date.parse(e.at))) throw new ReplayError('event has no valid timestamp', e);
  // A string, checked beside empty: every rule below reads it as one.
  if (typeof e.who !== 'string' || !e.who) throw new ReplayError('event has no actor', e);
  // The assistant proposes and explains. Anything else from it would be a
  // change nobody approved, so the fold refuses it whoever wrote the line.
  if (e.who === CLAUDE && !CLAUDE_MAY.has(e.op)) throw new ReplayError(`claude cannot ${e.op}`, e);
  // The app itself writes two of the household's choices and no others. A seed
  // wrote facts as `system` long before these ops, so only these five are limited.
  if (e.who === SYSTEM && CONFIG_OPS.has(e.op) && !systemMay(e)) throw new ReplayError(`system cannot ${e.op}`, e);
  if (e.op === 'guests.booking' && e.calendarGone !== undefined && (e.who !== SYSTEM || e.on !== false || e.calendarGone !== true)) {
    throw new ReplayError('calendarGone is written by system, when it turns booking off', e);
  }
  // A guest asks to stay (for new dates or changed ones), and cancels their
  // own; whether they are on the list, and whose stay it is, the fold says.
  if (isGuest(e.who)) {
    if (!isEmail(e.who.slice(GUEST_PREFIX.length))) throw new ReplayError('a guest is named by their email', e);
    if (!GUEST_MAY.has(e.op)) throw new ReplayError(`a guest cannot ${e.op}`, e);
    if (e.op === 'proposal.offer') refuseGuestCard(e);
  }
  if (e.op === 'thread.ask' || e.op === 'thread.note') {
    const text = e.op === 'thread.ask' ? e.question : e.text;
    if (!text.trim()) throw new ReplayError('a message cannot be empty', e);
    if (text.length > THREAD_TEXT_MAX) throw new ReplayError('keep a message under 2,000 characters', e);
  }
  if (e.op === 'thread.briefing' && e.source !== undefined && !BRIEFING_SOURCES.includes(e.source)) {
    throw new ReplayError(`a briefing's source is one of ${BRIEFING_SOURCES.join(', ')}`, e);
  }
  if (e.op === 'thread.briefing' && e.source === 'household' && e.budget !== null) {
    throw new ReplayError('the household\'s briefing is no one budget\'s: its budget is null', e);
  }
  if (e.op === 'thread.briefing' && (typeof e.body === 'string') === (e.doc !== undefined)) {
    throw new ReplayError('a briefing has its body in the log or a doc in Drive, one or the other', e);
  }
  if ((e.op === 'thread.briefing' || e.op === 'thread.answer') && e.doc !== undefined && !isDocRef(e.doc)) {
    throw new ReplayError('a document is named by its link, file_id, hash, version_id and path', e);
  }
  if (e.op === 'txn.split') {
    const problem = checkParts(e.parts);
    if (problem) throw new ReplayError(problem, e);
  }
  if (e.op === 'txn.categorize' && e.category === SPLIT) throw new ReplayError('a split is written with txn.split', e);
  if (e.op === 'txn.add' && e.txns.some((t) => t.category === SPLIT || t.split !== undefined)) {
    throw new ReplayError('a receipt cannot arrive already split', e);
  }
  if (e.op === 'move') {
    if (e.from === e.to) throw new ReplayError('cannot move money to the same envelope', e);
    if (e.amount <= 0) throw new ReplayError('move amount must be positive', e);
  }
  if (e.op === 'envelope.define' && e.match.categories.length === 0 && !e.match.payee) {
    throw new ReplayError('an envelope must match at least one category', e);
  }
  validateSinking(e);
  validateSettings(e);
  validatePlan(e);
  validateCalendarLines(e);
  validateBooking(e);
}

/** A pointer to a Drive document: all five of its fields, none of them empty. */
const isDocRef = (v: unknown): v is DocRef => {
  const x = v as Record<string, unknown> | null;
  return typeof v === 'object' && x !== null
    && ['link', 'file_id', 'hash', 'version_id', 'path'].every((k) => typeof x[k] === 'string' && x[k] !== '');
};

const named = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * What is wrong with a Team Folder's name, or with a folder in it (`nested`:
 * one or more segments joined by /), or null. Each segment passes the rule a
 * card's file name does, with no spaces around it: the picker trims what is
 * typed, so a line that still has them was not written by it.
 */
function folderProblem(v: unknown, what: string, nested: boolean): string | null {
  if (typeof v !== 'string' || v === '') return `${what} is required`;
  for (const part of nested ? v.split('/') : [v]) {
    if (part === '') return `${what} has an empty name in it: no / at either end, and none doubled`;
    if (part !== part.trim()) return `${what} cannot have spaces around a name`;
    const problem = segmentProblem(part, what);
    if (problem) return problem;
  }
  return null;
}

/** Whole cents, not below zero. */
const wholeCents = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Sinking funds' lines, checked by shape for the same reason the settings ops
 * are: a hand-edited line is refused by name, not met as a NaN in a total.
 */
function validateSinking(e: Event): void {
  const refuse = (message: string) => new ReplayError(message, e);
  switch (e.op) {
    case 'envelope.define': {
      const g: unknown = e.sinking;
      if (g === undefined || g === null) return;
      const goal = g as { kind?: unknown; target?: unknown; by?: unknown };
      if (goal.kind === 'every') return;
      if (goal.kind !== 'by') throw refuse("a sinking envelope's goal is 'every' or 'by'");
      if (!wholeCents(goal.target) || goal.target === 0) throw refuse('a goal by a date needs a target in whole cents');
      if (typeof goal.by !== 'string' || !MONTH_RE.test(goal.by)) throw refuse('a goal by a date names its month, YYYY-MM');
      return;
    }
    case 'category.sinking': {
      if (!named(e.category)) throw refuse('an estimate is for a category');
      const x: unknown = e.sinking;
      if (x === null) return;
      const est = x as { cost?: unknown; everyYears?: unknown } | undefined;
      if (!wholeCents(est?.cost) || est!.cost === 0) throw refuse('an estimate costs something, in whole cents');
      const n = est!.everyYears;
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 100) throw refuse('an estimate comes round every so many years, more than none and at most 100');
      return;
    }
    case 'month.open': {
      const plan: unknown = e.plan;
      if (plan === undefined) return;
      if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) throw refuse("a month's plan is envelope ids to cents");
      if (!Object.values(plan).every(wholeCents)) throw refuse('an envelope is planned at whole cents, not below zero');
      return;
    }
    case 'account.balance':
      if (!named(e.account)) throw refuse('a balance is for an account');
      if (typeof e.cents !== 'number' || !Number.isInteger(e.cents)) throw refuse('a balance is in whole cents');
      if (!isDay(e.asOf)) throw refuse('a balance is as of a day, YYYY-MM-DD');
      if (e.source !== 'statement' && e.source !== 'typed') throw refuse("a balance came from a statement or was typed");
      return;
    case 'savings.account':
      if (e.account !== null && !named(e.account)) throw refuse('the savings account is named, or null for none');
      return;
  }
}

/**
 * A guest's card asks to stay, and carries nothing a member would execute by
 * approving it: approval appends a card's events as the member, so a guest's
 * has none, and what approving it writes, the tool's effect writes. Nor may it
 * retire another card, hang off a plan, or answer something on the thread.
 *
 * The one other card a guest raises is release_stay, answering their own
 * cancel of a confirmed stay: here it must name a stay and the cancel it
 * answers; the fold checks they are that guest's (refuseGuestRelease).
 */
function refuseGuestCard(e: EventOf<'proposal.offer'>): void {
  const refuse = (message: string) => new ReplayError(message, e);
  if (e.prompt?.kind !== 'booking') throw refuse('a guest may only ask to stay, on a booking card (prompt.kind)');
  if (e.tool === 'release_stay') {
    if (!named(e.prompt.ref)) throw refuse("a guest's release_stay answers their own cancel (prompt.ref)");
    if (!named((e.args as Record<string, unknown> | null)?.['stay'])) throw refuse("a guest's release_stay names the stay (args.stay)");
  } else {
    if (e.prompt.ref !== null) throw refuse("a guest's card answers nothing: prompt.ref is null");
    if (e.tool !== 'approve_booking') throw refuse("a guest's card is approve_booking, or release_stay for their own cancel (tool)");
    // For themselves: the address approval mails is the one that signed in.
    const asked = (e.args as Record<string, unknown> | null)?.['email'];
    if (!isEmail(asked) || emailKey(asked) !== guestEmail(e.who)) throw refuse("a guest asks for themselves: args.email is their own address");
    const replaces = (e.args as Record<string, unknown> | null)?.['replacesStay'];
    if (replaces !== undefined && !named(replaces)) throw refuse("a guest's change names the stay it replaces (args.replacesStay)");
  }
  const events: unknown = e.events;
  if (events !== undefined && !(Array.isArray(events) && events.length === 0)) {
    throw refuse("a guest's card carries no events for a member to append");
  }
  if (e.replaces !== undefined) throw refuse("a guest's card replaces nothing (replaces)");
  if (e.plan !== undefined) throw refuse("a guest's card is on no plan (plan)");
  // No money in it: nothing for a newer card to replace it by, nor figures
  // whose moving would stop it being approved.
  const x = e as unknown as Record<string, unknown>;
  if (x['budget'] != null) throw refuse("a guest's card is in no budget (budget)");
  if (x['month'] != null) throw refuse("a guest's card is in no month (month)");
  const envelopes = x['envelopes'];
  if (envelopes !== undefined && !(Array.isArray(envelopes) && envelopes.length === 0)) {
    throw refuse("a guest's card touches no envelopes (envelopes)");
  }
  if (x['fingerprint'] !== undefined && x['fingerprint'] !== '') throw refuse("a guest's card has no figures (fingerprint)");
}

/** Both ids a calendar is addressed by, each a non-empty string. */
const isCalendarRef = (x: unknown): boolean => {
  const r = x as { cal_id?: unknown; original_cal_id?: unknown } | null;
  return named(r?.cal_id) && named(r?.original_cal_id);
};

/**
 * The settings ops, checked here rather than only in their routes: a restored
 * backup or a hand-edited line meets the same rules, and a line of the wrong
 * shape is refused by name instead of failing as a TypeError in the fold. The
 * routes keep their own checks too, for friendlier words and a 400.
 */
function validateSettings(e: Event): void {
  const calendarIds = () => new ReplayError('a calendar is named by cal_id and original_cal_id', e);
  switch (e.op) {
    case 'areas.set': {
      const areas: unknown = e.areas;
      if (!Array.isArray(areas)) throw new ReplayError('areas must be a list', e);
      // Every area-shaped thing in the app hangs off this list; none of it has
      // anywhere to go if the list is empty.
      if (areas.length === 0) throw new ReplayError('keep at least one area', e);
      if (!areas.every((a) => named(a) && a === a.trim())) {
        throw new ReplayError('every area needs a name, with no spaces around it', e);
      }
      if (new Set(areas.map((a: string) => a.toLowerCase())).size !== areas.length) {
        throw new ReplayError('two areas have the same name', e);
      }
      return;
    }
    case 'areas.rename': {
      // The same rule for a name as areas.set; whether `from` is there, and
      // `to` is not, depends on the list, so the fold checks those.
      for (const name of [e.from, e.to] as unknown[]) {
        if (!named(name) || name !== name.trim()) throw new ReplayError('an area needs a name, with no spaces around it', e);
      }
      if (e.from === e.to) throw new ReplayError(`${e.from} is already its name`, e);
      return;
    }
    case 'guests.arrival': {
      const text: unknown = e.text;
      if (typeof text !== 'string') throw new ReplayError('the arrival note is text', e);
      if (text.length > ARRIVAL_MAX) throw new ReplayError('keep the arrival note under 1,000 characters', e);
      return;
    }
    case 'links.set': {
      const links: unknown = e.links;
      if (!Array.isArray(links)) throw new ReplayError('links must be a list', e);
      for (const x of links) {
        const l = x as { label?: unknown; url?: unknown } | null;
        if (!named(l?.label)) throw new ReplayError('every link needs a label', e);
        // Only web addresses: the screen makes these into links, and a
        // javascript: one would run in the page of whoever clicked it.
        let parsed: URL | null = null;
        try { parsed = typeof l?.url === 'string' ? new URL(l.url) : null; } catch { /* refused below */ }
        if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
          throw new ReplayError('a link must be http or https', e);
        }
      }
      return;
    }
    case 'household.zone': {
      const zone: unknown = e.zone;
      // Whether ICU knows the name is the route's to say: a log written on one
      // Node must replay on another, so the fold checks the shape only.
      if (typeof zone !== 'string' || zone === '' || /\s/.test(zone) || zone.length > 64) {
        throw new ReplayError('a time zone is a name such as America/Denver', e);
      }
      return;
    }
    case 'envelopes.model': {
      const model: unknown = e.model;
      if (model !== null && (!named(model) || model.length > 100)) {
        throw new ReplayError('the model is a name of at most 100 characters, or null for the default', e);
      }
      return;
    }
    case 'guests.booking': {
      if (typeof (e.on as unknown) !== 'boolean') throw new ReplayError('booking is on or off', e);
      return;
    }
    case 'documents.folder': {
      const problem = folderProblem(e.team, 'the Team Folder', false) ?? folderProblem(e.folder, 'the folder', true);
      if (problem) throw new ReplayError(problem, e);
      const source: unknown = e.source;
      if (source !== 'owner' && source !== 'deployment') throw new ReplayError("a folder's source is owner or deployment", e);
      // `owner` from system is systemMay's to refuse, above.
      if (source === 'deployment' && e.who !== SYSTEM) throw new ReplayError("the deployment's folder is carried over only by system", e);
      return;
    }
    case 'documents.moved': {
      const shape = 'a moved file is a document by its link, or a card\'s file by its plan and name';
      const file = e.file as unknown as Record<string, unknown> | null;
      if (typeof file !== 'object' || file === null) throw new ReplayError(shape, e);
      const keys = Object.keys(file);
      if ('link' in file) {
        if (!keys.every((k) => k === 'link' || k === 'doc') || !named(file['link'])) throw new ReplayError(shape, e);
        if (file['doc'] !== undefined && !isDocRef(file['doc'])) {
          throw new ReplayError('a document is named by its link, file_id, hash, version_id and path', e);
        }
      } else {
        if (!keys.every((k) => k === 'plan' || k === 'name' || k === 'path') || !named(file['plan']) || !named(file['name'])) {
          throw new ReplayError(shape, e);
        }
        if (file['path'] !== undefined && !named(file['path'])) throw new ReplayError("where a card's file landed is a path", e);
      }
      const gone: unknown = e.gone;
      if (gone !== undefined && gone !== true) throw new ReplayError('gone, when said, is true', e);
      if (gone && file['doc'] !== undefined) throw new ReplayError('a file is moved, with its document, or gone, not both', e);
      return;
    }
    case 'calendar.household':
      if (!isCalendarRef(e)) throw calendarIds();
      if (!named(e.name)) throw new ReplayError('the Household calendar needs a name', e);
      if (e.replaces !== undefined && !named(e.replaces)) {
        throw new ReplayError('replaces names the cal_id of the Household calendar being replaced', e);
      }
      return;
    case 'calendar.household.rename':
      if (!named(e.name) || e.name !== e.name.trim()) {
        throw new ReplayError('the Household calendar needs a name, with no spaces around it', e);
      }
      return;
    case 'calendar.target':
      if (!isCalendarRef(e)) throw calendarIds();
      return;
    case 'calendar.conflicts': {
      const calendars: unknown = e.calendars;
      if (!Array.isArray(calendars)) throw new ReplayError('calendars must be a list', e);
      if (!calendars.every(isCalendarRef)) throw calendarIds();
      if (!calendars.every((c: { label?: unknown }) => typeof c.label === 'string')) {
        throw new ReplayError('every calendar checked for conflicts needs a label', e);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * The plan ops, checked here as the settings ops are: the routes and tools
 * read their input with the shared plan rules first, and this is the same
 * shape again for whatever comes through neither, a restored backup or a
 * hand-edited line. Every refusal is a ReplayError naming what is wrong,
 * never a TypeError from deeper in the fold.
 */
/** A line's refusals, named: `refuse` says what is wrong, `whole` refuses anything but a whole number. */
function refusalsFor(e: Event) {
  const refuse = (message: string) => new ReplayError(message, e);
  const whole = (v: unknown, what: string): void => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw refuse(`${what} must be a whole number`);
  };
  return { refuse, whole };
}

function validatePlan(e: Event): void {
  if (!e.op.startsWith('plan.')) return;
  const x = e as unknown as Record<string, unknown>;
  const { refuse, whole } = refusalsFor(e);
  const text = (v: unknown, what: string, max?: number): void => {
    if (!named(v)) throw refuse(`${what} cannot be empty`);
    if (max !== undefined && v.length > max) throw refuse(`${what} is longer than ${max.toLocaleString('en-US')} characters`);
  };
  const reason = (): void => {
    if (x['why'] !== undefined && typeof x['why'] !== 'string') throw refuse('a reason is text');
  };

  if (!named(x['plan'])) throw refuse('a plan line names its plan');
  switch (e.op) {
    case 'plan.create':
      text(e.title, 'a title', PLAN_LIMITS.title);
      text(e.area, 'an area');
      if (e.parent !== undefined && !named(e.parent)) throw refuse('parent names a plan');
      return;
    case 'plan.set': {
      if (e.title !== undefined) text(e.title, 'a title', PLAN_LIMITS.title);
      if (e.area !== undefined) text(e.area, 'an area');
      const chips: unknown = e.chips;
      if (chips !== undefined) {
        if (!Array.isArray(chips)) throw refuse('chips must be a list');
        for (const c of chips) text(c, 'a chip', PLAN_LIMITS.chip);
      }
      const notes: unknown = e.notes;
      if (notes !== undefined) {
        if (typeof notes !== 'string') throw refuse('notes are text');
        if (notes.length > PLAN_LIMITS.notes) throw refuse(`the notes are longer than ${PLAN_LIMITS.notes.toLocaleString('en-US')} characters`);
      }
      if (e.estimate !== undefined && e.estimate !== null) whole(e.estimate, 'an estimate, in cents,');
      const env: unknown = e.envelope;
      if (env !== undefined && env !== null) {
        const r = env as { budget?: unknown; envelope?: unknown };
        if (typeof env !== 'object' || !named(r.budget) || !named(r.envelope)) {
          throw refuse('an envelope is named by its budget and envelope');
        }
      }
      return;
    }
    case 'plan.state':
      if (!PLAN_STATES.includes(e.state)) throw refuse(`a plan's state is one of ${PLAN_STATES.join(', ')}`);
      return;
    case 'plan.ask':
      text(e.to, 'who is asked');
      reason();
      return;
    case 'plan.ask.decline': case 'plan.remove': case 'plan.detach': case 'plan.unblock':
      reason();
      if (e.op === 'plan.detach') text(e.path, "a file's path");
      if (e.op === 'plan.unblock') text(e.block, 'a block');
      return;
    case 'plan.checklist': {
      const items: unknown = e.items;
      if (!Array.isArray(items)) throw refuse('a checklist is a list');
      const ids = new Set<string>();
      for (const raw of items) {
        const i = (typeof raw === 'object' && raw ? raw : {}) as { id?: unknown; text?: unknown; done?: unknown };
        text(i.id, "an item's id");
        text(i.text, 'an item', PLAN_LIMITS.item);
        if (typeof i.done !== 'boolean') throw refuse('an item is done or not');
        if (ids.has(i.id as string)) throw refuse('each item appears once');
        ids.add(i.id as string);
      }
      return;
    }
    case 'plan.attach':
      text(e.path, "a file's path");
      text(e.name, "a file's name");
      whole(e.size, "a file's size");
      return;
    case 'plan.contact.link':
      whole(e.contact_id, 'contact_id');
      whole(e.addressbook_id, 'addressbook_id');
      text(e.display, "a person's name");
      return;
    case 'plan.contact.unlink':
      whole(e.contact_id, 'contact_id');
      return;
    case 'plan.due': {
      const due: unknown = e.due;
      if (due !== null && (typeof due !== 'string' || !DAY_RE.test(due) || Number.isNaN(Date.parse(due)))) {
        throw refuse('a due date is a day, YYYY-MM-DD, or none');
      }
      return;
    }
    case 'plan.block': {
      text(e.block, 'a block');
      const start = typeof e.start === 'string' ? Date.parse(e.start) : NaN;
      const end = typeof e.end === 'string' ? Date.parse(e.end) : NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw refuse("a block's start and end are dates and times");
      if (!(end > start)) throw refuse('a block must end after it starts');
      return;
    }
    case 'plan.calendar.link': case 'plan.calendar.unlink': {
      if (!CALENDAR_LINK_KINDS.includes(e.kind)) throw refuse(`a calendar link's kind is one of ${CALENDAR_LINK_KINDS.join(', ')}`);
      // A block's event is one of several, so it says which; nothing else has more than one.
      if (e.kind === 'block') text(e.block, "a block's id");
      else if (e.block !== undefined) throw refuse('only a block names a block');
      if (e.op === 'plan.calendar.unlink') return;
      if (!isCalendarRef(e)) throw refuse('a calendar is named by cal_id and original_cal_id');
      whole(e.evt_id, 'evt_id');
      text(e.ical_uid, 'ical_uid');
      text(e.dav_etag, "an event's etag");
      return;
    }
    case 'plan.calendar.etag':
      whole(e.evt_id, 'evt_id');
      text(e.dav_etag, "an event's etag");
      return;
    case 'plan.doc':
      if (!isDocRef(e.doc)) throw refuse('a document is named by its link, file_id, hash, version_id and path');
      text(e.event, 'the event a page shows');
      return;
    case 'plan.page.drift': {
      if (!isDocRef(e.theirs)) throw refuse('theirs is a document, named by its link, file_id, hash, version_id and path');
      if (e.unreadable !== undefined && e.unreadable !== true) throw refuse('unreadable, when said, is true');
      const changes: unknown = e.changes;
      if (!Array.isArray(changes) || (changes.length === 0 && e.unreadable !== true)) {
        throw refuse('a page drift lists its changes, unless the page could not be read');
      }
      for (const c of changes as unknown[]) {
        const ch = c as Record<string, unknown> | null;
        if (typeof c !== 'object' || ch === null || !PAGE_FIELDS.includes(ch['field'] as never)) {
          throw refuse(`a change names a field of the page: one of ${PAGE_FIELDS.join(', ')}`);
        }
        if (!isPageValue(ch['from']) || !isPageValue(ch['to'])) {
          throw refuse("a change's from and to are text, a number, a list, a checklist or nothing");
        }
      }
      return;
    }
    default:
      return;
  }
}

/** What a page's field holds: text, a number, a list of names, a checklist, or nothing. */
const isPageValue = (v: unknown): boolean =>
  v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
  || (Array.isArray(v) && (v.every((x) => typeof x === 'string')
    || v.every((x) => typeof x === 'object' && x !== null && typeof x.text === 'string' && typeof x.done === 'boolean')));

/** An event's side of a drift: two finite times and a title, which may be empty. */
const isDriftSide = (v: unknown): boolean => {
  const x = v as { dtstart?: unknown; dtend?: unknown; summary?: unknown } | null;
  return typeof v === 'object' && x !== null
    && typeof x.dtstart === 'number' && Number.isFinite(x.dtstart)
    && typeof x.dtend === 'number' && Number.isFinite(x.dtend)
    && typeof x.summary === 'string';
};

/**
 * The calendar lines that are not `plan.` ops, checked the way validatePlan
 * checks those: the app writes them, and a restored or hand-edited line meets
 * the same rules, refused by name.
 */
function validateCalendarLines(e: Event): void {
  if (e.op !== 'calendar.drift' && e.op !== 'calendar.drift.resolve' && e.op !== 'calendar.appointment'
      && e.op !== 'calendar.appointment.remove') return;
  const { refuse, whole } = refusalsFor(e);
  switch (e.op) {
    case 'calendar.drift':
      if (!named(e.plan)) throw refuse('a plan line names its plan');
      whole(e.evt_id, 'evt_id');
      if (e.theirs !== null && !isDriftSide(e.theirs)) throw refuse("theirs is the event's dtstart, dtend and summary, or null when it was deleted");
      if (!isDriftSide(e.ours)) throw refuse("ours is the plan's dtstart, dtend and summary");
      if (e.dav_etag !== undefined && (typeof e.dav_etag !== 'string' || !e.dav_etag.trim())) {
        throw refuse("a drift's etag, when it has one, is the etag their version has");
      }
      if (e.dav_etag !== undefined && e.theirs === null) throw refuse('a deleted event has no etag');
      if (e.changedBy !== undefined && (typeof e.changedBy !== 'string' || !e.changedBy.trim() || e.changedBy.length > 100)) {
        throw refuse('who changed it, when said, is a name');
      }
      return;
    case 'calendar.drift.resolve':
      if (!named(e.drift)) throw refuse('a resolve names its drift');
      if (!DRIFT_CHOICES.includes(e.choice)) throw refuse(`a drift's choice is one of ${DRIFT_CHOICES.join(', ')}`);
      return;
    case 'calendar.appointment': {
      whole(e.evt_id, 'evt_id');
      if (!isCalendarRef(e)) throw refuse('a calendar is named by cal_id and original_cal_id');
      if (!named(e.ical_uid)) throw refuse('ical_uid cannot be empty');
      if (!named(e.dav_etag)) throw refuse("an event's etag cannot be empty");
      if (!named(e.summary)) throw refuse('an appointment needs a name (its summary)');
      if (e.summary.length > PLAN_LIMITS.title) throw refuse(`an appointment's summary is longer than ${PLAN_LIMITS.title} characters`);
      const start = typeof e.start === 'string' ? Date.parse(e.start) : NaN;
      const end = typeof e.end === 'string' ? Date.parse(e.end) : NaN;
      if (!Number.isFinite(start)) throw refuse("an appointment's start is a date or a date and time");
      if (!Number.isFinite(end)) throw refuse("an appointment's end is a date or a date and time");
      if (end < start) throw refuse('an appointment cannot end before it starts');
      if (typeof e.allDay !== 'boolean') throw refuse('an appointment is all day (allDay) or not');
      if (e.plan !== undefined && !named(e.plan)) throw refuse('an appointment names its plan, or none');
      const contact: unknown = e.contact;
      if (contact !== undefined) {
        const c = contact as { contact_id?: unknown; addressbook_id?: unknown; display?: unknown } | null;
        if (typeof contact !== 'object' || c === null) throw refuse('a contact is named by contact_id, addressbook_id and display');
        whole(c.contact_id, 'contact_id');
        whole(c.addressbook_id, 'addressbook_id');
        if (!named(c.display)) throw refuse("a person's name cannot be empty");
      }
      return;
    }
    case 'calendar.appointment.remove':
      whole(e.evt_id, 'evt_id');
      if (!named(e.summary)) throw refuse('an appointment taken back names what it was (its summary)');
      return;
  }
}


/**
 * The guest list and the booking lines, checked as the plan lines are: the
 * routes check first, and a restored or hand-edited line meets the same rules,
 * refused by name rather than failing as a TypeError in the fold.
 */
function validateBooking(e: Event): void {
  if (!e.op.startsWith('guest.') && !e.op.startsWith('booking.')) return;
  const x = e as unknown as Record<string, unknown>;
  const refuse = (message: string) => new ReplayError(message, e);
  const email = (v: unknown): void => {
    if (!isEmail(v)) throw refuse('an email address has one @, no spaces, and a dot in its domain');
  };
  const day = (v: unknown, what: string): void => {
    if (!isDay(v)) throw refuse(`${what} is a day, YYYY-MM-DD`);
  };
  /** Nights from the first day (inclusive) to the last (exclusive): at least one. */
  const nights = (from: unknown, to: unknown, first: string, last: string): void => {
    day(from, first);
    day(to, last);
    if (!((to as string) > (from as string))) throw refuse(`${last} must be after ${first}`);
  };
  const headcount = (v: unknown): void => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw refuse('headcount is a whole number, at least one');
  };
  const whole = (v: unknown, what: string): void => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw refuse(`${what} must be a whole number`);
  };
  if (x['why'] !== undefined && typeof x['why'] !== 'string') throw refuse('a reason is text');

  switch (e.op) {
    case 'guest.allow': {
      email(e.email);
      if (!named(e.name)) throw refuse("a guest's name cannot be empty");
      // The fold keeps how the household knows them; a line without it is refused by name.
      if (typeof e.why !== 'string') throw refuse('a guest is allowed with a reason');
      const contact: unknown = e.contact;
      if (contact !== undefined) {
        const c = contact as { contact_id?: unknown; addressbook_id?: unknown; display?: unknown } | null;
        if (typeof contact !== 'object' || c === null) throw refuse('a contact is named by contact_id, addressbook_id and display');
        whole(c.contact_id, 'contact_id');
        whole(c.addressbook_id, 'addressbook_id');
        if (!named(c.display)) throw refuse("a person's name cannot be empty");
      }
      return;
    }
    case 'guest.revoke':
      email(e.email);
      return;
    case 'booking.block':
      nights(e.from, e.to, 'from', 'to');
      return;
    case 'booking.unblock':
      if (!named(e.block)) throw refuse('an unblock names its block');
      return;
    case 'booking.confirm':
      if (!named(e.request)) throw refuse('a confirmation names its request');
      if (e.replaces !== undefined && !named(e.replaces)) throw refuse('a confirmation that replaces a stay names it (replaces)');
      email(e.email);
      nights(e.arrive, e.depart, 'arrive', 'depart');
      headcount(e.headcount);
      if (!isCalendarRef(e)) throw refuse('a calendar is named by cal_id and original_cal_id');
      whole(e.evt_id, 'evt_id');
      if (!named(e.ical_uid)) throw refuse('ical_uid cannot be empty');
      if (!named(e.dav_etag)) throw refuse("an event's etag cannot be empty");
      return;
    case 'booking.cancel':
      if (!named(e.stay)) throw refuse('a cancel names its stay');
      return;

    case 'booking.release':
      if (!named(e.stay)) throw refuse('a release names its stay');
      return;
    case 'booking.suggest':
      if (!named(e.request)) throw refuse('a suggestion names its request');
      email(e.email);
      nights(e.arrive, e.depart, 'arrive', 'depart');
      return;
    default:
      return;
  }
}

// ─── the fold ─────────────────────────────────────────────────────────────────

/**
 * Enforced here, in the fold, rather than only in the API.
 *
 * A rule that lives in a route handler is true of one door; a rule that lives
 * in the replay is true of the log. Anything that ever writes an event — a
 * tool, a script, a restored backup — meets the same answer.
 */
function refuseIfClosed(d: Draft, e: Event): void {
  if (e.op !== 'assign' && e.op !== 'move' && e.op !== 'income.set') return;
  const m = d.months.get(monthKey(e.budget, e.month));
  if (m?.closed) throw new ReplayError(`${e.month} is closed for ${e.budget}`, e);
}

/**
 * The board and what is said on it belong to the household's members. A plan
 * line, or a question or note on a plan, from anyone else (a guest, a member
 * since removed, an account on a backup from another household) is refused
 * here, beside the rule that keeps Claude to proposing: the routes check
 * membership too, but they are one door and this is the log.
 */
function refuseNonMember(d: Draft, e: Event): void {
  if (e.who === CLAUDE) return; // CLAUDE_MAY already says what it may write
  const onPlan = planShaped(e.op)
    || ((e.op === 'thread.ask' || e.op === 'thread.note') && e.plan !== undefined);
  // The guest list and the household's nights are the members' to keep. A
  // guest's own cancel is the one way in from outside, and
  // refuseGuest has its say on that.
  const booking = e.op.startsWith('guest.') || e.op.startsWith('booking.');
  if ((onPlan || (booking && !isGuest(e.who))) && !d.members.has(e.who)) {
    throw new ReplayError(`${e.who} is not a member of this household`, e);
  }
}

/** The guest's email, from `guest:<email>`, as the log keys it. */
export const guestEmail = (who: string): string => emailKey(who.slice(GUEST_PREFIX.length));

/**
 * A guest writes only while on the household's list: validate() has kept them
 * to the two ops they may write, and this keeps them out once revoked. What
 * they wrote before stays, attributed, and readable.
 */
function refuseGuest(d: Draft, e: Event): void {
  if (!isGuest(e.who)) return;
  const email = guestEmail(e.who);
  if (!d.guests.has(email)) throw new ReplayError(`${email} is not on the list`, e);
}

/**
 * What a cancel or a change is about: a confirmed stay, by its own id or its
 * request's, or a guest's request still on the thread. A guest may name only
 * their own; a member, anyone's.
 */
function stayOrRequest(d: Draft, id: EventId, e: Event):
  { kind: 'stay'; id: EventId; stay: Stay } | { kind: 'request'; offer: Offer } {
  let found: { kind: 'stay'; id: EventId; stay: Stay } | { kind: 'request'; offer: Offer } | null = null;
  const direct = d.stays.get(id);
  if (direct) found = { kind: 'stay', id, stay: direct };
  else {
    // The latest confirmation of that request, if it was approved.
    for (const [sid, s] of d.stays) if (s.request === id) found = { kind: 'stay', id: sid, stay: s };
  }
  if (!found) {
    const o = d.offers.get(id);
    if (o && o.prompt.kind === 'booking') found = { kind: 'request', offer: o };
  }
  if (!found) throw new ReplayError(`no such stay: ${id}`, e);
  if (isGuest(e.who)) {
    const mine = found.kind === 'stay'
      ? found.stay.email === guestEmail(e.who)
      : isGuest(found.offer.who) && guestEmail(found.offer.who) === guestEmail(e.who);
    if (!mine) throw new ReplayError('that stay is not yours', e);
  }
  if (found.kind === 'stay' && found.stay.cancelled) throw new ReplayError('that stay is already cancelled', e);
  if (found.kind === 'request' && found.offer.status !== 'open' && found.offer.status !== 'snoozed') {
    throw new ReplayError('that request is no longer waiting', e);
  }
  return found;
}

/**
 * A card asking for a cancelled stay's event to come off the calendar: one per
 * stay, from anyone. From a guest only as the answer to their own cancel of
 * that stay: `prompt.ref` is the cancel, and the stay is the one it cancelled.
 */
function refuseRelease(d: Draft, e: Event): void {
  if (e.op !== 'proposal.offer' || e.tool !== 'release_stay') return;
  const stay = String((e.args as Record<string, unknown> | null)?.['stay'] ?? '');
  const already = [...d.offers.values()].some((o) => o.tool === 'release_stay' && o.status !== 'replaced' && o.args?.['stay'] === stay);
  if (already) throw new ReplayError('that stay already has a card to take it off the calendar', e);
  if (!isGuest(e.who)) return;
  const s = d.stays.get(stay);
  if (!s || !s.cancelled || s.cancelledIn !== e.prompt.ref || s.cancelledBy !== e.who) {
    throw new ReplayError('a guest may only ask to take off the calendar a stay they cancelled, answering that cancel', e);
  }
}

/**
 * A guest's request that changes a confirmed stay names it (`replacesStay`):
 * one of their own, still standing. The stay holds its nights until the
 * change is decided, and a confirmation of the change replaces it.
 */
function refuseGuestChange(d: Draft, e: Event): void {
  if (e.op !== 'proposal.offer' || e.tool !== 'approve_booking' || !isGuest(e.who)) return;
  const id = (e.args as Record<string, unknown> | null)?.['replacesStay'];
  if (id === undefined) return;
  const s = d.stays.get(String(id));
  if (!s || s.cancelled || s.email !== guestEmail(e.who)) {
    throw new ReplayError("a guest's change replaces a stay of their own that stands (args.replacesStay)", e);
  }
}

function applyTo(d: Draft, e: Event): void {
  validate(e);
  refuseIfClosed(d, e);
  refuseNonMember(d, e);
  refuseGuest(d, e);
  refuseRelease(d, e);
  refuseGuestChange(d, e);
  d.lastEventId = e.id;
  d.count += 1;

  // What every plan's page showed, for the ops that can change one: a plan
  // line, or an area renamed under its plans. A copy of the map, not of the
  // plans; the fold replaces a plan it changes, so the old object is the old view.
  const before = planShaped(e.op) || e.op === 'areas.rename' ? new Map(d.plans) : null;
  fold(d, e);
  if (before) markPages(d, e, before);
}

/**
 * Every plan this event changed the page of gets it as its `pageEvent`. Not a
 * list of ops: a plan whose object the fold replaced is compared, view to
 * view, with what it was, so an area renamed or a shelf moved under a plan
 * counts, and an etag, a calendar link or an ask, which the page does not
 * show, does not. A plan untouched is the same object, and is not compared.
 */
function markPages(d: Draft, e: Event, before: ReadonlyMap<PlanId, Plan>): void {
  for (const [id, p] of d.plans) {
    const was = before.get(id);
    if (was === p || p.pageEvent === e.id) continue;
    if (was && JSON.stringify(pageView(was)) === JSON.stringify(pageView(p))) continue;
    d.plans.set(id, { ...p, pageEvent: e.id });
  }
}

/** One event into the draft: today's switch, with the guards already passed. */
function fold(d: Draft, e: Event): void {
  switch (e.op) {
    case 'category.define': {
      d.categories.set(e.category, {
        id: e.category, label: e.label,
        ...(e.kind !== undefined ? { kind: e.kind } : {}),
        ...(e.sinking !== undefined ? { sinking: e.sinking } : {}),
      });
      return;
    }

    case 'budget.create': {
      if (!d.budgets.has(e.budget)) d.budgets.set(e.budget, { id: e.budget, label: e.label, envelopes: new Map() });
      else d.budgets.set(e.budget, { ...d.budgets.get(e.budget)!, label: e.label });
      return;
    }

    case 'envelope.define': {
      const b = budgetOrThrow(d, e.budget, e);
      const prev = b.envelopes.get(e.envelope);
      const env: Envelope = {
        id: e.envelope,
        label: e.label,
        group: e.group,
        match: e.match,
        rollover: e.rollover ?? prev?.rollover ?? true,
        template: e.template,
        order: e.order ?? prev?.order ?? b.envelopes.size,
      };
      // Absent leaves it as it was; null makes it ordinary again. A sinking
      // envelope always rolls over: money kept for later that vanished at the
      // end of a month would never add up to anything.
      const sinking = e.sinking === undefined ? prev?.sinking : e.sinking ?? undefined;
      b.envelopes.set(e.envelope, sinking ? { ...env, rollover: true, sinking } : env);
      return;
    }

    case 'category.sinking': {
      const c = d.categories.get(e.category);
      if (!c) throw new ReplayError(`no category ${e.category}`, e);
      d.categories.set(e.category, e.sinking
        ? { ...c, sinking: { cost: e.sinking.cost, everyYears: e.sinking.everyYears } }
        : (() => { const { sinking, ...rest } = c; return rest; })());
      return;
    }

    case 'budget.rename': {
      budgetOrThrow(d, e.budget, e).label = e.label;
      return;
    }

    case 'category.archive': {
      const c = d.categories.get(e.category);
      if (!c) throw new ReplayError(`no category ${e.category}`, e);
      d.categories.set(e.category, e.archived
        ? { ...c, archived: true }
        : (() => { const { archived, ...rest } = c; return rest; })());
      return;
    }

    case 'month.close': {
      const m = d.months.get(monthKey(e.budget, e.month));
      if (!m) throw new ReplayError(`${e.month} is not open for ${e.budget}`, e);
      if (e.closed) m.closed = true; else delete m.closed;
      return;
    }

    case 'month.discard': {
      // Guarded in the tool, checked again here: a month with adjustments has
      // been lived in, and losing that is not something a reason can justify.
      const key = monthKey(e.budget, e.month);
      const m = d.months.get(key);
      if (!m) return; // discarding a month that is not there is inert, not fatal
      if (m.adjustments.length) throw new ReplayError('that month has been adjusted — close it instead', e);
      d.months.delete(key);
      return;
    }

    case 'budget.locate': {
      const b = budgetOrThrow(d, e.budget, e);
      if (e.location) b.location = e.location; else delete b.location;
      return;
    }

    case 'budget.archive': {
      // Absent means live. Bringing one back removes the flag rather than
      // leaving a false behind, so "archived" only ever appears when it is true.
      const b = budgetOrThrow(d, e.budget, e);
      if (e.archived) b.archived = true; else delete b.archived;
      return;
    }

    case 'envelope.remove': {
      budgetOrThrow(d, e.budget, e).envelopes.delete(e.envelope);
      return;
    }

    case 'month.open': {
      const b = budgetOrThrow(d, e.budget, e);
      const key = monthKey(e.budget, e.month);
      if (d.months.has(key)) return; // opening twice is a no-op, never a re-plan
      const plan = new Map<EnvelopeId, Cents>();
      // The plan of record: a snapshot of the templates at the moment it opened,
      // or of what the opener planned an envelope at instead (a sinking goal's).
      for (const env of b.envelopes.values()) plan.set(env.id, e.plan?.[env.id] ?? env.template);
      d.months.set(key, {
        budget: e.budget, month: e.month, openedAt: e.at,
        plan, adjustments: [], income: e.income,
      });
      return;
    }

    case 'assign': {
      const m = monthOrThrow(d, e.budget, e.month, e);
      const current = fundedFor(m, e.envelope);
      const delta = sub(e.to, current);
      if (delta === 0) return;
      m.adjustments.push({
        eventId: e.id, at: e.at, who: e.who, why: e.why,
        kind: 'assign', envelope: e.envelope, delta,
      });
      return;
    }

    case 'move': {
      const m = monthOrThrow(d, e.budget, e.month, e);
      const base = { eventId: e.id, at: e.at, who: e.who, why: e.why, kind: 'move' as const };
      // Two entries so a per-envelope filter shows both sides of the transfer.
      m.adjustments.push({ ...base, envelope: e.from, delta: cents(-e.amount), counterpart: e.to });
      m.adjustments.push({ ...base, envelope: e.to, delta: e.amount, counterpart: e.from });
      return;
    }

    case 'income.set': {
      monthOrThrow(d, e.budget, e.month, e).income = e.amount;
      return;
    }

    case 'txn.add': {
      for (const t of e.txns) {
        if (d.txns.has(t.id)) continue;
        d.txns.set(t.id, { ...t });
      }
      return;
    }

    case 'txn.categorize': {
      const t = d.txns.get(e.txn);
      if (!t) return; // a categorize for a transaction since removed is inert, not fatal
      // Where the choice came from changes only when the choice does:
      // re-confirming the same category keeps "suggested by Claude".
      if (e.suggestedBy) t.suggestedBy = e.suggestedBy;
      else if (t.category !== e.category) delete t.suggestedBy;
      t.category = e.category;
      delete t.split; // a receipt sorted whole is no longer in parts
      if (e.manual) t.manual = true;
      return;
    }

    case 'txn.split': {
      const t = d.txns.get(e.txn);
      if (!t) return; // a split for a receipt since removed is inert, like a categorize
      if (e.parts.reduce((total, p) => add(total, p.amount), ZERO) !== t.amount) {
        throw new ReplayError('the parts of a split must add up to the receipt', e);
      }
      t.category = SPLIT;
      t.split = e.parts;
      t.manual = true; // a split is always a human's call; rules must not override it
      delete t.suggestedBy;
      return;
    }

    case 'txn.remove': {
      d.txns.delete(e.txn);
      return;
    }

    case 'account.balance': {
      const before = d.balances.get(e.account);
      // The latest day wins; of one day, the last recorded. An older statement
      // imported late is still a fact in the log, but it is not what the account holds now.
      if (!before || e.asOf >= before.asOf) {
        d.balances.set(e.account, {
          account: e.account, cents: e.cents, asOf: e.asOf, source: e.source, event: e.id, who: e.who, at: e.at,
        });
        // A card about the last balance is answered by this one: one card per balance, never a pile.
        for (const o of d.offers.values()) {
          if (o.prompt.kind === 'savings' && (o.status === 'open' || o.status === 'snoozed') && o.args['account'] === e.account) {
            d.offers.set(o.id, { ...o, status: 'replaced', replacedBy: e.id });
          }
        }
      }
      return;
    }

    case 'savings.account': {
      d.savingsAccount = e.account;
      return;
    }

    case 'rule.add': {
      d.rules = d.rules.filter((r) => r.id !== e.rule && r.match.toLowerCase() !== e.match.toLowerCase());
      d.rules.push({ id: e.rule, match: e.match, category: e.category });
      return;
    }

    case 'rule.remove': {
      d.rules = d.rules.filter((r) => r.id !== e.rule);
      return;
    }

    case 'household.claim': {
      // Claiming twice would silently transfer a household to whoever restarted
      // the container last. It happens once, or it fails loudly.
      if (d.owner) throw new ReplayError(`already claimed by ${d.owner}`, e);
      d.owner = e.who;
      d.members.add(e.who);
      d.label = e.label;
      return;
    }

    case 'member.add': {
      if (e.who !== d.owner) throw new ReplayError('only the owner can add a member', e);
      d.members.add(e.member);
      return;
    }

    case 'member.remove': {
      if (e.who !== d.owner) throw new ReplayError('only the owner can remove a member', e);
      // Removing the owner would leave a household nobody can administer.
      if (e.member === d.owner) throw new ReplayError('the owner cannot be removed', e);
      d.members.delete(e.member);
      // Nobody is left to answer their asks, so they lapse and the owner may ask again.
      for (const p of d.plans.values()) if (p.asked?.to === e.member) lapseAsk(d, p, e);
      // Nor to carry their plans, so the member who removed them takes them on
      // rather than leave a plan owned by someone who cannot be asked for it.
      // Any ask the removed member put goes with them: the new owner starts
      // clean and may ask again. A removed plan is history and keeps the name
      // it was removed under.
      for (const p of d.plans.values()) {
        if (p.owner === e.member && !p.removed) lapseAsk(d, { ...p, owner: e.who }, e);
      }
      return;
    }

    case 'income.source.define': {
      d.incomeSources.set(e.source, {
        id: e.source, budget: e.budget, label: e.label, who: e.earner,
        amount: e.amount, frequency: e.frequency, anchor: e.anchor,
        ...(e.until ? { until: e.until } : {}),
      });
      return;
    }

    case 'income.source.remove': {
      d.incomeSources.delete(e.source);
      return;
    }

    case 'briefing.read': {
      d.readCursor.set(e.who, e.upTo);
      return;
    }

    case 'prediction.record': {
      d.predictions.push({
        id: e.prediction, at: e.at, who: e.who, budget: e.budget, month: e.month,
        envelope: e.envelope, expected: e.expected, why: e.why,
      });
      return;
    }

    case 'thread.briefing': case 'thread.answer':
      // Words, not state: the thread reads them from the log. A document in
      // Drive is tracked, so a change of folder knows to move it; a briefing
      // written again the same day has the same link, so the same key.
      if (e.doc) trackDoc(d, e.doc, e.op === 'thread.briefing' ? 'today' : 'answers');
      return;

    case 'thread.ask': case 'thread.note':
      return; // words, not state: the thread reads them from the log

    case 'proposal.offer': {
      // A replacement retires what it replaces, so only one card for the same
      // money can ever be approved.
      if (e.replaces) {
        const old = d.offers.get(e.replaces);
        if (old && (old.status === 'open' || old.status === 'snoozed')) {
          d.offers.set(old.id, { ...old, status: 'replaced', replacedBy: e.id });
        }
      }
      d.offers.set(e.id, {
        id: e.id, at: e.at, who: e.who, tool: e.tool, args: e.args, summary: e.summary,
        // A guest's card may leave its events and money out; the card has none either way.
        effects: e.effects, events: e.events ?? [], budget: e.budget ?? null, month: e.month ?? null,
        envelopes: e.envelopes ?? [], fingerprint: e.fingerprint ?? '', prompt: e.prompt, status: 'open',
        ...(e.plan ? { plan: e.plan } : {}),
      });
      return;
    }

    case 'proposal.decide': {
      // In the fold rather than the route, so two people approving at once meet
      // the same answer: the second append is refused and nothing applies twice.
      const o = d.offers.get(e.proposal);
      if (!o) throw new ReplayError('no such card', e);
      if (o.status !== 'open' && o.status !== 'snoozed') throw new ReplayError('that card was already decided', e);
      // An ask is answered by the member asked, and only answered: never put off.
      if (o.prompt.kind === 'ask') {
        const to = d.plans.get(String(o.args['plan']))?.asked?.to;
        if (to !== undefined && e.who !== to) throw new ReplayError(`only ${to} can answer that ask`, e);
        if (e.decision === 'snoozed') throw new ReplayError('an ask is answered, not put off', e);
      }
      d.offers.set(o.id, {
        ...o, status: e.decision, decidedBy: e.who, decidedAt: e.at,
        ...(e.why ? { why: e.why } : {}),
        ...(e.decision === 'snoozed' && e.fingerprint !== undefined ? { snoozedAt: e.fingerprint } : {}),
      });
      return;
    }

    case 'flag.seen': {
      const mine = d.seen.get(e.who) ?? new Set<string>();
      mine.add(e.event);
      d.seen.set(e.who, mine);
      return;
    }

    case 'areas.set': {
      // Never empty, never a blank or repeated name: validate() saw to that.
      // An area is removed only once it is empty: its plans would have no row to sit in.
      const dropped = d.areas.find((a) => !e.areas.includes(a)
        && [...d.plans.values()].some((p) => p.area === a && !p.removed));
      if (dropped !== undefined) throw new ReplayError(`"${dropped}" still has plans in it`, e);
      d.areas = [...e.areas];
      return;
    }

    case 'areas.rename': {
      if (!d.areas.includes(e.from)) throw new ReplayError(`there is no area called ${e.from}`, e);
      // Another area by the new name, in any case, would be two rows that read the same.
      // The area itself does not count, so a change of case alone is a rename.
      const clash = d.areas.find((a) => a !== e.from && a.toLowerCase() === e.to.toLowerCase());
      if (clash !== undefined) throw new ReplayError(`"${clash}" is already an area`, e);
      d.areas = d.areas.map((a) => (a === e.from ? e.to : a));
      // Every live plan goes with it, shelves and their items alike. A removed
      // plan is history and keeps the area it was removed from.
      for (const p of d.plans.values()) {
        if (p.area === e.from && !p.removed) d.plans.set(p.id, { ...p, area: e.to });
      }
      return;
    }

    case 'links.set': {
      d.links = e.links.map((l) => ({ label: l.label, url: l.url }));
      return;
    }

    case 'guests.arrival': {
      d.arrival = e.text.trim();
      return;
    }

    // ─── the household's choices ────────────────────────────────────────────
    // The owner's, or the app's where `systemMay` allowed it in validate.

    case 'household.zone': {
      mustBeOwner(d, e);
      d.zone = e.zone;
      return;
    }

    case 'guests.booking': {
      mustBeOwner(d, e);
      d.booking = { on: e.on, by: e.who, at: e.at, calendarGone: e.calendarGone === true };
      return;
    }

    case 'envelopes.model': {
      mustBeOwner(d, e);
      d.model = e.model;
      return;
    }

    case 'documents.folder': {
      mustBeOwner(d, e);
      const docs = d.documents;
      // The carry-over is a first choice only: it can never start a move.
      if (e.source === 'deployment' && docs.folder) throw new ReplayError("the deployment's folder is carried over only before a choice", e);
      // One move at a time: a second would leave files the first had not reached in neither folder.
      if (docs.waiting.size) throw new ReplayError(`Wait until the ${docs.waiting.size} documents have moved.`, e);
      if (docs.folder && docs.folder.team === e.team && docs.folder.folder === e.folder) {
        throw new ReplayError(`documents already live in ${e.team}/${e.folder}`, e);
      }
      // Worked out here, from the log as it stood, so a replay or a restore
      // lists the same files. A first choice has nothing in a folder to leave.
      if (docs.folder) {
        docs.previous = { team: docs.folder.team, folder: docs.folder.folder };
        docs.waiting = new Map<string, MoveFile>(docs.docs);
        for (const p of d.plans.values()) {
          if (p.removed) continue;
          for (const a of p.attachments) docs.waiting.set(moveKey({ plan: p.id, name: a.name }), { kind: 'card', plan: p.id, name: a.name });
        }
      }
      docs.folder = { team: e.team, folder: e.folder, source: e.source, event: e.id, by: e.who, at: e.at };
      return;
    }

    case 'documents.moved': {
      // Any member's: whoever's session moved the file says so, as plan.doc is written.
      if (!d.members.has(e.who)) throw new ReplayError(`${e.who} is not a member of this household`, e);
      const docs = d.documents;
      const key = moveKey(e.file);
      const was = docs.waiting.get(key);
      // Two members moving at once: the second record of the same file is refused here.
      if (!was) throw new ReplayError('that file is not waiting to move', e);
      if (!('link' in e.file)) {
        const { plan, name, path } = e.file;
        // A card's file that landed: the card points at where it is now, so a read, and the next move, start there.
        if (path !== undefined) {
          const home = docs.folder!;
          if (path !== `/${home.team}/${home.folder}/${plan}/${name}`) {
            throw new ReplayError("a card's file lands in its plan's folder, in the household's folder", e);
          }
          const p = d.plans.get(plan);
          if (p) d.plans.set(p.id, { ...p, attachments: p.attachments.map((a) => (a.name === name ? { ...a, path } : a)) });
        }
        docs.waiting.delete(key);
        return;
      }
      docs.waiting.delete(key);
      if (was.kind !== 'doc') return;
      const old = e.file.link;
      // A plan's page written again since the choice is tracked by its new link already.
      const tracked = docs.docs.delete(key);
      // Gone, or left where Drive keeps it outside the old folder: nothing points at it now.
      if (!e.file.doc) return;
      const doc = docRef(e.file.doc);
      docs.relinked.set(old, doc);
      for (const [from, to] of docs.relinked) if (to.link === old) docs.relinked.set(from, doc);
      // Moved, not renamed: it keeps its parent and its name.
      if (tracked) trackDoc(d, doc, was.parent, was.name);
      for (const p of d.plans.values()) {
        if (p.page?.doc.link === old) d.plans.set(p.id, { ...p, page: { doc, event: p.page.event } });
      }
      return;
    }

    case 'calendar.household': {
      // One shared calendar. A second would split the household's plans across
      // two places, and whichever was recorded last would quietly win. A new
      // one takes the old one's place only by naming it, so two members
      // replacing a lost calendar at once cannot both win.
      if (d.household) {
        if (e.replaces !== d.household.cal_id) throw new ReplayError('the household calendar is already set', e);
        // Plans that went on the old calendar go on the new one; a calendar
        // someone chose instead stays chosen.
        if (d.target && sameCalendar(d.target, d.household)) d.target = null;
      } else if (e.replaces !== undefined) {
        throw new ReplayError('there is no household calendar to replace', e);
      }
      d.household = { cal_id: e.cal_id, original_cal_id: e.original_cal_id, name: e.name, by: e.who };
      // A calendar chosen again is no longer gone, and booking can be turned on.
      if (d.booking) d.booking = { ...d.booking, calendarGone: false };
      return;
    }

    case 'calendar.household.rename': {
      // A name for the calendar the log already has; there is nothing to name before it is made.
      if (!d.household) throw new ReplayError('there is no Household calendar to rename', e);
      d.household = { ...d.household, name: e.name };
      return;
    }

    case 'calendar.target': {
      d.target = { cal_id: e.cal_id, original_cal_id: e.original_cal_id };
      return;
    }

    case 'calendar.conflicts': {
      d.conflicts.set(e.who, e.calendars.map((c) =>
        ({ cal_id: c.cal_id, original_cal_id: c.original_cal_id, label: c.label })));
      return;
    }

    case 'scheme.set': {
      // Checked here because the client is not the only writer: a hand-edited
      // line naming a scheme that does not exist would leave nothing to draw.
      if (!SCHEMES.has(e.scheme)) throw new ReplayError(`no such scheme: ${e.scheme}`, e);
      if (!MODES.has(e.mode)) throw new ReplayError(`no such mode: ${e.mode}`, e);
      d.appearance.set(e.who, { scheme: e.scheme, mode: e.mode });
      return;
    }

    // ─── plans ──────────────────────────────────────────────────────────────

    case 'plan.create': {
      if (d.plans.has(e.plan)) throw new ReplayError(`there is already a plan ${e.plan}`, e);
      refuseUnknownArea(d, e.area, e);
      if (e.parent !== undefined) {
        // Two levels and no more: a shelf of plans, never a shelf of shelves.
        const parent = livePlan(d, e.parent, e);
        if (parent.parent !== null) throw new ReplayError('plans go two levels deep, no more', e);
        // A shelf sits in one row, so everything on it sits there too.
        if (e.area !== parent.area) throw new ReplayError("an item lives in its shelf's area", e);
      }
      d.plans.set(e.plan, {
        id: e.plan, title: e.title, area: e.area, parent: e.parent ?? null,
        state: 'planning', stateAt: e.at, owner: e.who, asked: null,
        chips: [], notes: '', estimate: null, envelope: null,
        checklist: [], attachments: [], contacts: [], due: null, blocks: [], links: [], letGo: [],
        createdAt: e.at, createdBy: e.who, removed: false,
        pageEvent: e.id, page: null,
      });
      return;
    }

    case 'plan.set': {
      const p = livePlan(d, e.plan, e);
      if (e.area !== undefined) refuseUnknownArea(d, e.area, e);
      // An item moves only with its shelf; on its own it would need a new shelf,
      // and nothing re-parents a plan yet. Naming the area it already has is no move.
      if (e.area !== undefined && p.parent !== null && e.area !== p.area) {
        throw new ReplayError("an item lives in its shelf's area", e);
      }
      d.plans.set(p.id, {
        ...p,
        ...(e.title !== undefined ? { title: e.title } : {}),
        ...(e.area !== undefined ? { area: e.area } : {}),
        ...(e.chips !== undefined ? { chips: [...e.chips] } : {}),
        ...(e.notes !== undefined ? { notes: e.notes } : {}),
        ...(e.estimate !== undefined ? { estimate: e.estimate } : {}),
        ...(e.envelope !== undefined ? { envelope: e.envelope && { budget: e.envelope.budget, envelope: e.envelope.envelope } } : {}),
      });
      // A shelf moves with everything on it, so no item is left in a row its shelf has left.
      if (e.area !== undefined) {
        for (const c of d.plans.values()) {
          if (c.parent === p.id && !c.removed) d.plans.set(c.id, { ...c, area: e.area });
        }
      }
      return;
    }

    case 'plan.state': {
      const p = livePlan(d, e.plan, e);
      // A shelf is where its plans are, never what stage they are at.
      if (hasLiveChildren(d, p.id)) throw new ReplayError(`${p.title} is a shelf; its plans have states, it does not`, e);
      // Saying the same state again does not restart the clock.
      if (p.state === e.state) return;
      d.plans.set(p.id, { ...p, state: e.state, stateAt: e.at });
      return;
    }

    case 'plan.ask': {
      const p = livePlan(d, e.plan, e);
      // Asked, not assigned: nothing lands on another member's board unless
      // its owner asks and they say yes.
      if (e.who !== p.owner) throw new ReplayError(`only the owner, ${p.owner}, can ask someone to take ${p.title}`, e);
      if (p.asked) throw new ReplayError(`already asked ${p.asked.to} to take ${p.title}`, e);
      if (e.to === p.owner) throw new ReplayError(`${p.title} is already ${e.to}'s`, e);
      if (!d.members.has(e.to)) throw new ReplayError(`${e.to} is not in this household`, e);
      d.plans.set(p.id, { ...p, asked: { to: e.to, at: e.at, why: e.why } });
      return;
    }

    case 'plan.ask.accept': case 'plan.ask.decline': {
      const p = livePlan(d, e.plan, e);
      if (!p.asked) throw new ReplayError(`nobody has been asked to take ${p.title}`, e);
      if (e.who !== p.asked.to) throw new ReplayError(`only ${p.asked.to} can answer that ask`, e);
      // The card that put the question is answered, so it cannot be answered twice.
      lapseAsk(d, e.op === 'plan.ask.accept' ? { ...p, owner: e.who } : p, e);
      return;
    }

    case 'plan.checklist': {
      const p = livePlan(d, e.plan, e);
      d.plans.set(p.id, { ...p, checklist: e.items.map((i) => ({ id: i.id, text: i.text, done: i.done })) });
      return;
    }

    case 'plan.attach': {
      const p = livePlan(d, e.plan, e);
      const a = { path: e.path, name: e.name, size: e.size, who: e.who, at: e.at };
      d.plans.set(p.id, { ...p, attachments: upsert(p.attachments, a, (x) => x.path === e.path) });
      return;
    }

    case 'plan.detach': {
      const p = livePlan(d, e.plan, e);
      if (!p.attachments.some((a) => a.path === e.path)) throw new ReplayError(`no attachment ${e.path} on ${p.title}`, e);
      d.plans.set(p.id, { ...p, attachments: p.attachments.filter((a) => a.path !== e.path) });
      return;
    }

    case 'plan.contact.link': {
      const p = livePlan(d, e.plan, e);
      const c = { contact_id: e.contact_id, addressbook_id: e.addressbook_id, display: e.display };
      d.plans.set(p.id, { ...p, contacts: upsert(p.contacts, c, (x) => x.contact_id === e.contact_id) });
      return;
    }

    case 'plan.contact.unlink': {
      const p = livePlan(d, e.plan, e);
      if (!p.contacts.some((c) => c.contact_id === e.contact_id)) throw new ReplayError(`that person is not on ${p.title}`, e);
      d.plans.set(p.id, { ...p, contacts: p.contacts.filter((c) => c.contact_id !== e.contact_id) });
      return;
    }

    case 'plan.due': {
      const p = livePlan(d, e.plan, e);
      // A date set again is one to put on the calendar, whatever became of the last one's event.
      d.plans.set(p.id, { ...p, due: e.due, letGo: without(p.letGo, 'due') });
      return;
    }

    case 'plan.block': {
      const p = livePlan(d, e.plan, e);
      // validate() has seen that it ends after it starts.
      const b = { id: e.block, start: e.start, end: e.end };
      d.plans.set(p.id, { ...p, blocks: upsert(p.blocks, b, (x) => x.id === e.block), letGo: without(p.letGo, e.block) });
      return;
    }

    case 'plan.unblock': {
      const p = livePlan(d, e.plan, e);
      if (!p.blocks.some((b) => b.id === e.block)) throw new ReplayError(`no block ${e.block} on ${p.title}`, e);
      d.plans.set(p.id, { ...p, blocks: p.blocks.filter((b) => b.id !== e.block), letGo: without(p.letGo, e.block) });
      return;
    }

    case 'plan.remove': {
      const p = livePlan(d, e.plan, e);
      // Removing a shelf would orphan its plans; they go first, by name.
      if (hasLiveChildren(d, p.id)) throw new ReplayError(`${p.title} still has plans on it`, e);
      // A removed plan cannot be taken on, so an open ask on it lapses; nor
      // changed, so every card still waiting to change it lapses too.
      lapseAsk(d, { ...p, removed: true }, e);
      lapseOffers(d, p.id, e);
      return;
    }

    // ─── a plan on the calendar ─────────────────────────────────────────────

    case 'plan.calendar.link': {
      const p = livePlan(d, e.plan, e);
      // validate() has seen that only a block names a block.
      const l: CalendarLink = {
        kind: e.kind, ...(e.block !== undefined ? { block: e.block } : {}),
        cal_id: e.cal_id, original_cal_id: e.original_cal_id,
        evt_id: e.evt_id, ical_uid: e.ical_uid, dav_etag: e.dav_etag,
      };
      const slot = e.kind === 'block' ? e.block! : e.kind;
      d.plans.set(p.id, { ...p, links: upsert(p.links, l, sameLink(e.kind, e.block)), letGo: without(p.letGo, slot) });
      return;
    }

    case 'plan.calendar.unlink': {
      const p = livePlan(d, e.plan, e);
      const same = sameLink(e.kind, e.block);
      if (!p.links.some(same)) throw new ReplayError(`that ${e.kind} is not on the calendar for ${p.title}`, e);
      d.plans.set(p.id, { ...p, links: p.links.filter((l) => !same(l)) });
      return;
    }

    case 'plan.calendar.etag': {
      const p = livePlan(d, e.plan, e);
      if (!p.links.some((l) => l.evt_id === e.evt_id)) throw new ReplayError(`event ${e.evt_id} is not on the calendar for ${p.title}`, e);
      d.plans.set(p.id, { ...p, links: p.links.map((l) => (l.evt_id === e.evt_id ? { ...l, dav_etag: e.dav_etag } : l)) });
      return;
    }

    // ─── a plan's page in Drive ─────────────────────────────────────────────

    case 'plan.doc': {
      // A removed plan too: its last page says it was removed.
      const p = d.plans.get(e.plan);
      if (!p) throw new ReplayError(`no such plan: ${e.plan}`, e);
      // validate() has seen the five fields; only they are kept.
      const doc = docRef(e.doc);
      // The plan's earlier page, under another link, is no longer one the log points to.
      if (p.page && p.page.doc.link !== doc.link) d.documents.docs.delete(moveKey(p.page.doc));
      trackDoc(d, doc, p.id, PLAN_PAGE);
      // What was written, not what the page shows: pageEvent is left alone.
      d.plans.set(p.id, { ...p, page: { doc, event: e.event } });
      return;
    }

    case 'plan.page.drift': {
      const p = livePlan(d, e.plan, e);
      // One open question per page: a newer drift says what the page holds now,
      // so the older one is settled as left alone, and says by what. Its card
      // goes with it, as the calendar's does.
      for (const [id, x] of d.pageDrifts) {
        if (x.plan === p.id && x.resolved === null) {
          d.pageDrifts.set(id, { ...x, resolved: 'leave', replacedBy: e.id });
          retireDriftCards(d, id, e);
        }
      }
      // validate() has seen the fields; only they are kept. Nothing the page shows changed.
      const { link, file_id, hash, version_id, path } = e.theirs;
      d.pageDrifts.set(e.id, {
        plan: p.id, theirs: { link, file_id, hash, version_id, path },
        changes: e.changes.map(({ field, from, to }) => ({ field, from, to })),
        unreadable: e.unreadable === true, resolved: null,
      });
      return;
    }

    case 'calendar.drift': {
      const p = livePlan(d, e.plan, e);
      // A drift is about an event the app made for this plan; any other is not its to note.
      if (!p.links.some((l) => l.evt_id === e.evt_id)) throw new ReplayError(`event ${e.evt_id} is not on the calendar for ${p.title}`, e);
      // One open question per event: a newer drift says what the calendar holds
      // now, so the older one is settled as left alone, and says by what.
      // Its card goes with it: one card per event, asking about what it holds now.
      for (const [id, x] of d.drifts) {
        if (x.evt_id === e.evt_id && x.resolved === null) {
          d.drifts.set(id, { ...x, resolved: 'leave', replacedBy: e.id });
          retireDriftCards(d, id, e);
        }
      }
      const link = p.links.find((l) => l.evt_id === e.evt_id)!;
      const slot = link.kind === 'block' ? link.block : link.kind === 'due' ? 'due' : undefined;
      d.drifts.set(e.id, {
        plan: p.id, evt_id: e.evt_id, theirs: e.theirs, ours: e.ours, resolved: null,
        ...(slot !== undefined ? { slot } : {}),
        ...(e.dav_etag !== undefined ? { dav_etag: e.dav_etag } : {}),
        ...(e.changedBy !== undefined ? { changedBy: e.changedBy } : {}),
      });
      return;
    }

    case 'calendar.drift.resolve': {
      // In the fold, so two members answering at once meet the same answer: the second is refused.
      const x = d.drifts.get(e.drift);
      if (!x) {
        // A page's drift is settled the same way; what each choice does is the card's, not the fold's.
        const pd = d.pageDrifts.get(e.drift);
        if (!pd) throw new ReplayError('no such drift', e);
        if (pd.resolved !== null) throw new ReplayError('that drift was already settled', e);
        d.pageDrifts.set(e.drift, { ...pd, resolved: e.choice });
        retireDriftCards(d, e.drift, e);
        return;
      }
      if (x.resolved !== null) throw new ReplayError('that drift was already settled', e);
      d.drifts.set(e.drift, { ...x, resolved: e.choice });
      // Deleted on the calendar and left that way: the plan keeps the date, off the calendar by choice.
      const p = d.plans.get(x.plan);
      if (e.choice === 'leave' && x.theirs === null && x.slot !== undefined && p && !p.removed && !p.letGo.includes(x.slot)) {
        d.plans.set(p.id, { ...p, letGo: [...p.letGo, x.slot] });
      }
      // Settled some other way than its card (its plan removed): the card has nothing left to ask.
      // Approved through the card, the decision came first in the same write and it is no longer open.
      retireDriftCards(d, e.drift, e);
      return;
    }

    case 'calendar.appointment': {
      if (d.appointments.has(e.evt_id)) throw new ReplayError(`appointment ${e.evt_id} is already recorded`, e);
      if (e.plan !== undefined) livePlan(d, e.plan, e);
      d.appointments.set(e.evt_id, {
        evt_id: e.evt_id, cal_id: e.cal_id, original_cal_id: e.original_cal_id,
        ical_uid: e.ical_uid, dav_etag: e.dav_etag, summary: e.summary,
        start: e.start, end: e.end, allDay: e.allDay,
        ...(e.plan !== undefined ? { plan: e.plan } : {}),
        ...(e.contact !== undefined
          ? { contact: { contact_id: e.contact.contact_id, addressbook_id: e.contact.addressbook_id, display: e.contact.display } }
          : {}),
        who: e.who, at: e.at,
      });
      return;
    }

    case 'calendar.appointment.remove': {
      if (!d.appointments.has(e.evt_id)) throw new ReplayError(`appointment ${e.evt_id} is not recorded`, e);
      d.appointments.delete(e.evt_id);
      return;
    }

    // ─── booking ────────────────────────────────────────────────────────────

    case 'guest.allow': {
      // Keyed by the address as typed anywhere: trimmed, lowercased. Allowing
      // again replaces the entry, so a re-allow after a revoke is just that.
      d.guests.set(emailKey(e.email), {
        name: e.name.trim(), why: e.why.trim(), allowedBy: e.who, at: e.at,
        ...(e.contact !== undefined
          ? { contact: { contact_id: e.contact.contact_id, addressbook_id: e.contact.addressbook_id, display: e.contact.display } }
          : {}),
      });
      return;
    }

    case 'guest.revoke': {
      const email = emailKey(e.email);
      if (!d.guests.has(email)) throw new ReplayError(`${email} is not on the list`, e);
      d.guests.delete(email);
      return;
    }

    case 'booking.block': {
      // validate() has seen that it ends after it starts.
      d.stayBlocks.set(e.id, { from: e.from, to: e.to, why: e.why, by: e.who, at: e.at });
      return;
    }

    case 'booking.unblock': {
      if (!d.stayBlocks.has(e.block)) throw new ReplayError(`no such block: ${e.block}`, e);
      d.stayBlocks.delete(e.block);
      return;
    }

    case 'booking.confirm': {
      const email = emailKey(e.email);
      // A change approved: the stay it replaces is the same guest's, and still stands.
      const old = e.replaces === undefined ? undefined : d.stays.get(e.replaces);
      if (e.replaces !== undefined && (!old || old.cancelled || old.email !== email)) {
        throw new ReplayError('a confirmation replaces a stay of the same guest that stands (replaces)', e);
      }
      // One party at a time: two confirmed stays never share a night, however
      // the second came to be approved. Departure day is the next arrival day.
      const clash = [...d.stays.entries()].find(([id, s]) => id !== e.replaces && !s.cancelled && s.arrive < e.depart && e.arrive < s.depart)?.[1];
      if (clash) throw new ReplayError(`those nights are taken: a stay from ${clash.arrive} to ${clash.depart} is confirmed`, e);
      // Replaced in the same line: its nights are free, and its event comes off with this approval.
      if (old) d.stays.set(e.replaces!, { ...old, cancelled: true, released: true, replacedBy: e.id });
      // The name the request was made under, else the list's, else the address.
      const asked = d.offers.get(e.request)?.args?.['name'];
      const name = typeof asked === 'string' && asked.trim() ? asked.trim() : d.guests.get(email)?.name ?? email;
      d.stays.set(e.id, {
        request: e.request, email, name, arrive: e.arrive, depart: e.depart, headcount: e.headcount,
        cal_id: e.cal_id, original_cal_id: e.original_cal_id, evt_id: e.evt_id, ical_uid: e.ical_uid, dav_etag: e.dav_etag,
        cancelled: false, confirmedBy: e.who, at: e.at,
      });
      return;
    }

    case 'booking.cancel': {
      // A confirmed stay is kept and marked: its nights are free from here.
      // A request still waiting is withdrawn by the proposal machinery.
      const found = stayOrRequest(d, e.stay, e);
      if (found.kind === 'request') {
        // A request still waiting is withdrawn: it stops holding its nights and
        // stops waiting on Today. Nobody decided it, so it is not declined.
        d.offers.set(found.offer.id, { ...found.offer, status: 'replaced' });
        return;
      }
      d.stays.set(found.id, { ...found.stay, cancelled: true, cancelledBy: e.who, cancelledIn: e.id });
      // A change still waiting on it goes with it: there is nothing left for it to replace.
      for (const o of d.offers.values()) {
        if (o.tool === 'approve_booking' && o.args?.['replacesStay'] === found.id && (o.status === 'open' || o.status === 'snoozed')) {
          d.offers.set(o.id, { ...o, status: 'replaced' });
        }
      }
      return;
    }

    case 'booking.release': {
      // Its event is off the calendar: only once, and only for a stay that was cancelled.
      const s = d.stays.get(e.stay);
      if (!s) throw new ReplayError(`no such stay: ${e.stay}`, e);
      if (!s.cancelled) throw new ReplayError('that stay is not cancelled', e);
      if (s.released) throw new ReplayError('that stay was already taken off the calendar', e);
      d.stays.set(e.stay, { ...s, released: true });
      return;
    }


    case 'booking.suggest':
      return; // words to the guest: the dates are not held

    default: {
      const never: never = e;
      throw new ReplayError(`unknown op: ${(never as Event).op}`);
    }
  }
}

/** A plan's page in Drive, by name: pages.ts's PAGE_NAME, which imports this module and so cannot be imported here. */
const PLAN_PAGE = 'plan.md';

/** The five fields of a document, and nothing else a line carried. */
const docRef = ({ link, file_id, hash, version_id, path }: DocRef): DocRef => ({ link, file_id, hash, version_id, path });

/** A Drive document the log now points to, under its parent: `today`, `answers` or a plan's id. */
function trackDoc(d: Draft, doc: DocRef, parent: string, name = doc.path.slice(doc.path.lastIndexOf('/') + 1)): void {
  d.documents.docs.set(moveKey(doc), { kind: 'doc', link: doc.link, parent, name });
}

/** The household's choices are the owner's, or the app's where validate let it through. */
function mustBeOwner(d: Draft, e: Event): void {
  if (e.who !== d.owner && e.who !== SYSTEM) throw new ReplayError(`only the owner, ${d.owner}, can choose this`, e);
}

function budgetOrThrow(d: Draft, id: string, e: Event) {
  const b = d.budgets.get(id);
  if (!b) throw new ReplayError(`no such budget: ${id}`, e);
  return b;
}

/** A plan that exists and has not been removed. A removed plan is history, not a draft. */
function livePlan(d: Draft, id: PlanId, e: Event): Plan {
  const p = d.plans.get(id);
  if (!p) throw new ReplayError(`no such plan: ${id}`, e);
  if (p.removed) throw new ReplayError(`${p.title} has been removed`, e);
  return p;
}

/**
 * Close a plan's open ask, writing `p` back with `asked` cleared, and settle
 * the card that put it. Answered, the card says so: taken is approved and
 * declined is declined, by the member who answered, with their reason, however
 * they answered. Lapsed (the plan removed, a member gone), it is retired the way
 * a replacement offer retires the one it replaces, as is any other card still
 * proposing an answer to it.
 */
function lapseAsk(d: Draft, p: Plan, e: Event): void {
  d.plans.set(p.id, { ...p, asked: null });
  for (const o of d.offers.values()) {
    if (o.tool !== 'answer_ask' || o.args['plan'] !== p.id || (o.status !== 'open' && o.status !== 'snoozed')) continue;
    const answered = o.prompt.kind === 'ask' && (e.op === 'plan.ask.accept' || e.op === 'plan.ask.decline');
    d.offers.set(o.id, answered
      ? { ...o, status: e.op === 'plan.ask.accept' ? 'approved' : 'declined', decidedBy: e.who, decidedAt: e.at,
          ...(e.op === 'plan.ask.decline' ? { why: e.why } : {}) }
      : { ...o, status: 'replaced', replacedBy: e.id });
  }
}

/** Whether a card would change this plan: its events name it, or its research raised it. */
const offerTouches = (o: Offer, id: PlanId): boolean =>
  o.plan === id || o.args['plan'] === id
  || o.events.some((x) => (x as { plan?: unknown }).plan === id || (x as { parent?: unknown }).parent === id);

/** Retire the card still asking about a drift that is settled, or asked about again. */
function retireDriftCards(d: Draft, drift: EventId, e: Event): void {
  for (const o of d.offers.values()) {
    if ((o.status === 'open' || o.status === 'snoozed') && o.prompt.kind === 'drift' && o.args['drift'] === drift) {
      d.offers.set(o.id, { ...o, status: 'replaced', replacedBy: e.id });
    }
  }
}

/** Retire every card still waiting that would change a plan that is gone. */
function lapseOffers(d: Draft, id: PlanId, e: Event): void {
  for (const o of d.offers.values()) {
    if ((o.status === 'open' || o.status === 'snoozed') && offerTouches(o, id)) {
      d.offers.set(o.id, { ...o, status: 'replaced', replacedBy: e.id });
    }
  }
}

const hasLiveChildren = (d: Draft, id: PlanId): boolean =>
  [...d.plans.values()].some((c) => c.parent === id && !c.removed);

function refuseUnknownArea(d: Draft, area: string, e: Event): void {
  if (!d.areas.includes(area)) throw new ReplayError(`"${area}" is not one of this household's areas`, e);
}

/** A plan has one event per kind, and one per block: the key a link is replaced and removed by. */
const sameLink = (kind: CalendarLink['kind'], block: string | undefined) =>
  (l: CalendarLink): boolean => l.kind === kind && l.block === block;

/** Replace the item `same` finds, in place, or add it at the end. */
/** The list without one value; the same list when it was not there. */
const without = (list: readonly string[], v: string): readonly string[] => (list.includes(v) ? list.filter((x) => x !== v) : list);

function upsert<T>(list: readonly T[], item: T, same: (x: T) => boolean): T[] {
  return list.some(same) ? list.map((x) => same(x) ? item : x) : [...list, item];
}

function monthOrThrow(d: Draft, budget: string, month: string, e: Event) {
  const m = d.months.get(monthKey(budget, month));
  if (!m) throw new ReplayError(`month ${month} is not open for budget ${budget}`, e);
  return m;
}

// ─── derived reads ────────────────────────────────────────────────────────────

type MonthLike = Pick<MonthPlan, 'plan' | 'adjustments'>;

/** What was planned when the month opened. Immutable. */
export const plannedFor = (m: MonthLike, env: EnvelopeId): Cents => m.plan.get(env) ?? ZERO;

/** What the envelope is funded at now: the plan plus every adjustment since. */
export function fundedFor(m: MonthLike, env: EnvelopeId): Cents {
  let total = plannedFor(m, env);
  for (const a of m.adjustments) if (a.envelope === env) total = add(total, a.delta);
  return total;
}

/** The adjustment trail for one envelope, in order. Drives the UI's "was $325" line. */
export const trailFor = (m: MonthLike, env: EnvelopeId): Adjustment[] =>
  m.adjustments.filter((a) => a.envelope === env);

/** Total planned across the month. Moves never change this; assignments do. */
export function plannedTotal(m: MonthLike): Cents {
  let total = ZERO;
  for (const v of m.plan.values()) total = add(total, v);
  return total;
}

export function fundedTotal(m: MonthLike): Cents {
  let total = plannedTotal(m);
  for (const a of m.adjustments) total = add(total, a.delta);
  return total;
}

/** Rules are last-match-wins, so later rules can narrow earlier ones. */
export function categorize(rules: readonly Rule[], t: Pick<Txn, 'payee' | 'memo'>): Assignment | null {
  const hay = `${t.payee ?? ''} ${t.memo ?? ''}`.toLowerCase();
  let hit: Assignment | null = null;
  for (const r of rules) if (r.match && hay.includes(r.match.toLowerCase())) hit = r.category;
  return hit;
}

export type { Actor };
