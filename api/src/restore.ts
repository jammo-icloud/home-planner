/**
 * Backups, and taking pieces of one back.
 *
 * A backup is the log. There is no export format to keep in step with the
 * domain, no serialiser to forget a field — the file that is written every day
 * is the file that is restored, which is the whole reason for an append-only
 * log in the first place.
 *
 * What makes a *partial* restore possible is that every event is scoped by
 * exactly one thing: the household, a budget, a budget and month, or a person.
 * So "just the receipts" or "just this budget" is a filter, not a translation.
 *
 * Nothing here writes. It reports what would land and what would collide, and
 * a collision refuses rather than merging: a wrong merge is silent, and a
 * refusal is merely annoying.
 */

import { guestEmail, validate } from './replay.ts';
import { areaIndex, areaMoved, isGuest } from './types.ts';
import type { Event, State } from './types.ts';

export type Scope = 'facts' | 'budgets' | 'months' | 'people' | 'thread' | 'settings' | 'plans' | 'bookings';

/** Which band of the model an event belongs to. Every event belongs to one. */
export function scopeOf(e: Event): Scope {
  switch (e.op) {
    case 'category.define': case 'category.archive': case 'category.sinking':
    case 'txn.add': case 'txn.categorize': case 'txn.split': case 'txn.remove': case 'account.balance':
    case 'rule.add': case 'rule.remove':
      return 'facts';
    case 'budget.create': case 'budget.rename': case 'budget.locate': case 'budget.archive':
    case 'envelope.define': case 'envelope.remove':
    case 'income.source.define': case 'income.source.remove':
      return 'budgets';
    case 'month.open': case 'month.close': case 'month.discard':
    case 'assign': case 'move': case 'income.set': case 'prediction.record':
      return 'months';
    case 'household.claim': case 'member.add': case 'member.remove': case 'briefing.read':
      return 'people';
    // The conversation restores on its own, so the money can be taken without
    // it, or it without the money.
    case 'thread.briefing': case 'thread.ask': case 'thread.note': case 'thread.answer':
    case 'proposal.offer': case 'proposal.decide': case 'flag.seen':
      return 'thread';
    // How the household is set up, apart from its money: areas, links, the
    // calendars and how the app looks.
    case 'areas.set': case 'areas.rename': case 'areas.add': case 'areas.remove': case 'areas.move': case 'links.set': case 'guests.arrival':
    case 'calendar.household': case 'calendar.household.rename': case 'calendar.target': case 'calendar.conflicts':
    case 'scheme.set': case 'savings.account':
    case 'household.zone': case 'guests.booking': case 'envelopes.model':
    case 'documents.folder': case 'documents.moved':
      return 'settings';
    // The board: every plan and everything on its card. Needs nothing else.
    case 'plan.create': case 'plan.set': case 'plan.state':
    case 'plan.ask': case 'plan.ask.accept': case 'plan.ask.decline': case 'plan.hand':
    case 'plan.goal': case 'goal.rename': case 'goal.remove':
    case 'plan.checklist': case 'plan.attach': case 'plan.detach':
    case 'plan.contact.link': case 'plan.contact.unlink':
    case 'plan.due': case 'plan.block': case 'plan.unblock': case 'plan.remove':
    // Its events on the calendar, and what became of them. An appointment
    // need not be a plan's, but it is the board's to keep all the same.
    case 'plan.calendar.link': case 'plan.calendar.unlink': case 'plan.calendar.etag':
    case 'calendar.drift': case 'calendar.drift.resolve': case 'calendar.appointment': case 'calendar.appointment.remove':
    // What was last written of its page in Drive, and what was found changed there.
    case 'plan.doc': case 'plan.page.drift':
      return 'plans';
    // Friends who may come and stay, and the nights kept, confirmed and
    // cancelled. A guest's request is a card, and goes with the thread.
    case 'guest.allow': case 'guest.revoke':
    case 'booking.block': case 'booking.unblock':
    case 'booking.confirm': case 'booking.cancel': case 'booking.suggest': case 'booking.release':
      return 'bookings';
  }
}

export interface ParsedBackup {
  readonly events: readonly Event[];
  readonly counts: Readonly<Record<Scope, number>>;
  /** Lines that were not usable events. Never silently dropped. */
  readonly skipped: readonly string[];
  readonly label: string | null;
  readonly owner: string | null;
}

export function parseBackup(text: string): ParsedBackup {
  const events: Event[] = [];
  const skipped: string[] = [];
  let label: string | null = null;
  let owner: string | null = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    let e: Event;
    try { e = JSON.parse(raw) as Event; } catch { skipped.push(`line ${i + 1}: not JSON`); continue; }
    try { validate(e); } catch (err) { skipped.push(`line ${i + 1}: ${(err as Error).message}`); continue; }
    if (e.op === 'household.claim') { label = e.label; owner = e.who; }
    events.push(e);
  }

  const counts = { facts: 0, budgets: 0, months: 0, people: 0, thread: 0, settings: 0, plans: 0, bookings: 0 } as Record<Scope, number>;
  for (const e of events) counts[scopeOf(e)]++;
  return { events, counts, skipped, label, owner };
}

export interface Collision {
  readonly kind: 'category' | 'budget' | 'transaction' | 'envelope-category' | 'plan' | 'calendar' | 'owner';
  readonly what: string;
  readonly why: string;
}

export interface RestorePlan {
  readonly take: readonly Event[];
  readonly counts: Readonly<Record<Scope, number>>;
  readonly collisions: readonly Collision[];
  /** Scopes asked for whose prerequisites are not present. */
  readonly missingPrerequisites: readonly string[];
  readonly summary: readonly string[];
}

/** Where documents live, and what moved there: settings, but never restored in place. */
const FOLDER_OPS: ReadonlySet<Event['op']> = new Set(['documents.folder', 'documents.moved']);

/**
 * What would happen, without doing it.
 *
 * The dependency runs one way — facts, then budgets, then months — so asking
 * for months without the budget they belong to is not a collision but a
 * nonsense, and is reported separately.
 */
export function planRestore(
  target: State,
  backup: ParsedBackup,
  scopes: readonly Scope[],
): RestorePlan {
  const wanted = new Set(scopes);
  // The folder for documents is never taken from a backup: it is chosen here,
  // where the check against every other household's folder runs, and a move
  // starts only from that choice.
  const take = backup.events.filter((e) => wanted.has(scopeOf(e)) && !FOLDER_OPS.has(e.op));

  const collisions: Collision[] = [];
  const missingPrerequisites: string[] = [];

  // ── facts ────────────────────────────────────────────────────────────────
  if (wanted.has('facts')) {
    for (const e of take) {
      if (e.op === 'category.define' && target.categories.has(e.category)) {
        const here = target.categories.get(e.category)!;
        if (here.label !== e.label) {
          collisions.push({
            kind: 'category', what: e.category,
            why: `this household already calls "${e.category}" ${here.label}; the backup calls it ${e.label}`,
          });
        }
      }
      if (e.op === 'txn.add') {
        for (const t of e.txns) {
          if (target.txns.has(t.id)) {
            collisions.push({
              kind: 'transaction', what: `${t.date} ${t.payee}`,
              why: 'a receipt with that identity is already in this ledger',
            });
          }
        }
      }
    }
  }

  // ── budgets ──────────────────────────────────────────────────────────────
  if (wanted.has('budgets')) {
    for (const e of take) {
      if (e.op === 'budget.create' && target.budgets.has(e.budget)) {
        collisions.push({
          kind: 'budget', what: e.label,
          why: `a budget called "${e.budget}" already exists here`,
        });
      }
      // An envelope arriving from a backup may claim a category that something
      // here already feeds on — the same guard that stops two envelopes sharing
      // a category, which would make a receipt land in whichever was defined last.
      if (e.op === 'envelope.define') {
        for (const b of target.budgets.values()) {
          if (b.id !== e.budget) continue;
          for (const env of b.envelopes.values()) {
            if (env.id === e.envelope) continue;
            const clash = e.match.categories.find((c) => env.match.categories.includes(c));
            if (clash) {
              collisions.push({
                kind: 'envelope-category', what: `${e.label} → ${clash}`,
                why: `${clash} already feeds ${env.label} in ${b.label}`,
              });
            }
          }
        }
      }
    }
  }

  // ── plans ────────────────────────────────────────────────────────────────
  // A plan id already on this board means something here; which of the two is
  // meant is not for a restore to decide.
  if (wanted.has('plans')) {
    for (const e of take) {
      if (e.op === 'plan.create' && target.plans.has(e.plan)) {
        collisions.push({
          kind: 'plan', what: e.title,
          why: `there is already a plan "${e.plan}" here, called ${target.plans.get(e.plan)!.title}`,
        });
      }
    }
  }

  // Whose they are. The fold takes a plan line only from a member, and asks
  // only of a member, so a plan made by (or asked of) an account that is not
  // in this household would stop the restore part-way. Named here instead, one
  // line per account: add them as a member first, or restore these where they
  // are one. Members the backup's own people bring, when taken too, count.
  if (wanted.has('plans')) {
    const members = new Set(target.members);
    const outsiders = new Map<string, 'made' | 'asked' | 'handed'>();
    const outside = (who: string, how: 'made' | 'asked' | 'handed') => {
      if (!members.has(who) && !outsiders.has(who)) outsiders.set(who, how);
    };
    for (const e of take) {
      if (e.op === 'household.claim') members.add(e.who);
      else if (e.op === 'member.add') members.add(e.member);
      else if (e.op === 'member.remove') members.delete(e.member);
      else if (scopeOf(e) === 'plans') {
        outside(e.who, 'made');
        if (e.op === 'plan.ask') outside(e.to, 'asked');
        if (e.op === 'plan.hand') outside(e.to, 'handed');
      } else if ((e.op === 'thread.ask' || e.op === 'thread.note') && e.plan !== undefined) outside(e.who, 'made');
    }
    for (const [who, how] of outsiders) {
      collisions.push({
        kind: 'owner', what: who,
        why: `${who} is not a member of this household, and the backup has plans ${how === 'made' ? 'of theirs' : how === 'asked' ? 'asked of them' : 'handed to them'}: `
          + `add ${who} as a member first, or restore these where ${who} is one`,
      });
    }
  }

  // ── settings ─────────────────────────────────────────────────────────────
  // One Household calendar per household. The backup's first one has no
  // `replaces`, so it cannot take the place of one that is already set.
  if (wanted.has('settings') && target.calendar.household) {
    for (const e of take) {
      if (e.op === 'calendar.household' && e.replaces === undefined) {
        collisions.push({
          kind: 'calendar', what: e.name,
          why: `this household already has a Household calendar, ${target.calendar.household.name}`,
        });
      }
    }
  }

  // ── prerequisites ────────────────────────────────────────────────────────
  if (wanted.has('plans') || wanted.has('settings')) {
    // A plan's area must be one of the household's when it is made. Walk the
    // events as they will be written, so areas the backup's own settings bring
    // (when taken too) count, and areas only the backup knows are named. The
    // same walk keeps the live plans by area, for an area removed under them.
    let areas = target.settings.areas;
    const livePlans = new Map<string, string>();
    const parents = new Map<string, string>();
    for (const p of target.plans.values()) {
      if (p.removed) continue;
      livePlans.set(p.id, p.area);
      if (p.parent !== null) parents.set(p.id, p.parent);
    }
    const inBackup = new Set(backup.events.flatMap((e) =>
      e.op === 'areas.set' ? e.areas : e.op === 'areas.rename' ? [e.to] : e.op === 'areas.add' ? [e.area] : []));
    const said = new Set<string>();
    for (const e of take) {
      if (e.op === 'areas.set') { areas = e.areas; continue; }
      if (e.op === 'areas.rename') {
        areas = areas.map((a) => (a === e.from ? e.to : a));
        for (const [id, a] of livePlans) if (a === e.from) livePlans.set(id, e.to);
        continue;
      }
      if (e.op === 'areas.add') {
        if (areaIndex(areas, e.area) < 0) areas = [...areas, e.area];
        continue;
      }
      // The three ops find an area as the fold does, ignoring case. Each way the
      // fold would refuse one is named here, once, instead of failing at adopt.
      if (e.op === 'areas.remove' || e.op === 'areas.move') {
        const at = areaIndex(areas, e.area);
        const name = at < 0 ? e.area : areas[at]!;
        if (e.op === 'areas.move') {
          if (at >= 0) areas = areaMoved(areas, at, Math.min(e.to, areas.length - 1));
          else if (!said.has(`move ${name}`)) {
            said.add(`move ${name}`);
            missingPrerequisites.push(`the area "${name}" cannot be moved: it does not exist here at that point`);
          }
        } else if (at >= 0) {
          const why = areas.length === 1 ? 'it would leave no area'
            : [...livePlans.values()].some((a) => a === name) ? 'plans are still in it' : null;
          if (why !== null) {
            if (!said.has(`remove ${name}`)) {
              said.add(`remove ${name}`);
              missingPrerequisites.push(`the area "${name}" cannot be removed: ${why}`);
            }
          } else areas = areas.filter((_, i) => i !== at);
        }
        continue;
      }
      // Which plans are live, by area, as the walk goes: a remove is refused while any is in the area.
      if (e.op === 'plan.create') livePlans.set(e.plan, e.area);
      else if (e.op === 'plan.set' && e.area !== undefined) {
        livePlans.set(e.plan, e.area);
        for (const [id, parent] of parents) if (parent === e.plan && livePlans.has(id)) livePlans.set(id, e.area);
      } else if (e.op === 'plan.remove') livePlans.delete(e.plan);
      if (e.op === 'plan.create' && e.parent !== undefined) parents.set(e.plan, e.parent);
      const area = wanted.has('plans') && (e.op === 'plan.create' || e.op === 'plan.set') ? e.area : undefined;
      if (area === undefined || areas.includes(area) || said.has(area)) continue;
      said.add(area);
      missingPrerequisites.push(inBackup.has(area)
        ? `plans in "${area}" need that area, which is in the backup but not selected (Settings)`
        : `plans in "${area}" need that area, which does not exist here`);
    }
  }
  // Friends staying and the conversation lean on each other: a guest's
  // request is a card (the conversation), from someone on the guest list
  // (bookings), and a request withdrawn is a cancel (bookings) of that card.
  // Either without the other, where the other is needed, would stop the
  // restore part-way in the fold; it is named here instead.
  if (wanted.has('bookings') && !wanted.has('thread')) {
    const stays = new Set([...target.stays.keys(), ...take.filter((e) => e.op === 'booking.confirm').map((e) => e.id)]);
    const requestsOfStays = new Set([...[...target.stays.values()].map((s) => s.request),
      ...take.flatMap((e) => (e.op === 'booking.confirm' ? [e.request] : []))]);
    const cardsInBackup = new Set(backup.events.filter((e) => e.op === 'proposal.offer').map((e) => e.id));
    let inBackup = 0;
    let nowhere = 0;
    for (const e of take) {
      if (e.op !== 'booking.cancel' || stays.has(e.stay) || requestsOfStays.has(e.stay) || target.thread.offers.has(e.stay)) continue;
      if (cardsInBackup.has(e.stay)) inBackup++; else nowhere++;
    }
    const cards = (n: number) => (n === 1 ? 'a withdrawn request needs its card' : `${n} withdrawn requests need their cards`);
    if (inBackup) missingPrerequisites.push(`${cards(inBackup)}, from the conversation, which is in the backup but not selected`);
    if (nowhere) missingPrerequisites.push(`${cards(nowhere)}, which is not here and not in the backup`);
  }
  if (wanted.has('thread') && !wanted.has('bookings')) {
    const listed = new Set(backup.events.flatMap((e) => (e.op === 'guest.allow' ? [e.email.trim().toLowerCase()] : [])));
    const said = new Set<string>();
    for (const e of take) {
      if (e.op !== 'proposal.offer' || !isGuest(e.who)) continue;
      const email = guestEmail(e.who);
      if (target.guests.has(email) || said.has(email)) continue;
      said.add(email);
      missingPrerequisites.push(listed.has(email)
        ? `requests from ${email} need them on the guest list, from bookings, which is in the backup but not selected`
        : `requests from ${email} need them on the guest list, which is not here and not in the backup`);
    }
  }
  if (wanted.has('months') && !wanted.has('budgets')) {
    const budgetsInBackup = new Set(
      backup.events.filter((e) => e.op === 'budget.create').map((e) => (e as { budget: string }).budget));
    const needed = new Set(take.filter((e) => 'budget' in e).map((e) => (e as { budget: string }).budget));
    for (const b of needed) {
      if (!target.budgets.has(b) && budgetsInBackup.has(b)) {
        missingPrerequisites.push(
          `months for "${b}" need that budget, which is in the backup but not selected`);
      } else if (!target.budgets.has(b)) {
        missingPrerequisites.push(`months for "${b}" need a budget that is not here and not in the backup`);
      }
    }
  }
  if (wanted.has('budgets') && !wanted.has('facts')) {
    const known = target.categories;
    const fromBackup = new Set(
      backup.events.filter((e) => e.op === 'category.define').map((e) => (e as { category: string }).category));
    const needed = new Set(take.flatMap((e) => e.op === 'envelope.define' ? e.match.categories : []));
    for (const c of needed) {
      if (!known.has(c)) {
        missingPrerequisites.push(fromBackup.has(c)
          ? `envelopes feed on category "${c}", which is in the backup but not selected`
          : `envelopes feed on category "${c}", which does not exist here`);
      }
    }
  }

  const counts = { facts: 0, budgets: 0, months: 0, people: 0, thread: 0, settings: 0, plans: 0, bookings: 0 } as Record<Scope, number>;
  for (const e of take) counts[scopeOf(e)]++;

  const summary: string[] = [];
  if (counts.facts) {
    const receipts = take.reduce((n, e) => n + (e.op === 'txn.add' ? e.txns.length : 0), 0);
    summary.push(`${receipts} receipts, plus the categories and rules that sort them`);
  }
  if (counts.budgets) {
    const budgets = take.filter((e) => e.op === 'budget.create').length;
    const envelopes = take.filter((e) => e.op === 'envelope.define').length;
    summary.push(`${budgets} budget${budgets === 1 ? '' : 's'} and ${envelopes} envelope definitions`);
  }
  if (counts.months) {
    const opened = take.filter((e) => e.op === 'month.open').length;
    summary.push(`${opened} opened month${opened === 1 ? '' : 's'} and everything adjusted in them`);
  }
  if (counts.thread) {
    const said = take.filter((e) => e.op !== 'proposal.decide' && e.op !== 'flag.seen').length;
    summary.push(`${said} messages and suggestions from the conversation, with what was decided`);
  }
  if (counts.settings) {
    summary.push('the household\'s settings: areas, links, calendars, the arrival note, appearance, the time zone, booking and the envelope model');
  }
  if (wanted.has('settings') && backup.events.some((e) => FOLDER_OPS.has(e.op))) {
    summary.push('This household keeps its own folder for documents: no two households share a folder.');
  }
  if (counts.plans) {
    const plans = take.filter((e) => e.op === 'plan.create').length;
    summary.push(`${plans} plan${plans === 1 ? '' : 's'} and everything on their cards`);
  }
  if (counts.bookings) {
    const stays = take.filter((e) => e.op === 'booking.confirm').length;
    summary.push(`the guest list, ${stays} confirmed stay${stays === 1 ? '' : 's'} and the nights kept for the household`);
    // Not needed to restore them, but a confirmation carries it.
    if (!wanted.has('settings') && backup.events.some((e) => e.op === 'guests.arrival')) {
      summary.push('the arrival note is in Settings, which is not selected: confirmations go without it until one is written here');
    }
  }

  return { take, counts, collisions, missingPrerequisites, summary };
}

/**
 * The events to append, once a plan has come back clean.
 *
 * Refuses on any collision or missing prerequisite. Merging would mean deciding
 * which of two meanings for one id is right, and getting that wrong is silent —
 * the receipt simply lands in the wrong envelope forever.
 */
export function eventsToApply(plan: RestorePlan): Event[] {
  if (plan.collisions.length) {
    throw new Error(`${plan.collisions.length} collision(s) — nothing was restored`);
  }
  if (plan.missingPrerequisites.length) {
    throw new Error(`${plan.missingPrerequisites.length} missing prerequisite(s) — nothing was restored`);
  }
  return [...plan.take];
}
