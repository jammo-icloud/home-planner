/**
 * The daily briefing.
 *
 * A household shares one budget and its members rarely sit at it together, so each day opens
 * with one briefing for every member: what changed since the last one, and what
 * needs a person today. It is written once a day and kept in the
 * log as the first message of the day's thread. Whatever happens later that day
 * appears in the thread itself, so the briefing never rewrites itself.
 *
 * Everything numeric in here is computed by analytics.ts and handed to Claude
 * already formatted. Claude decides what matters and how to say it; it never
 * works a figure out. The consequence is that two briefings written from the
 * same log always quote the same dollars.
 */

import { fmt, ZERO } from './money.ts';
import type { Cents } from './money.ts';
import { snapshot, monthClock, donors } from './analytics.ts';
import type { Snapshot } from './analytics.ts';
import { monthView } from './envelopes.ts';
import { houseRules, structured, claudeConfigured, ClaudeRefused, unavailableReason } from './claude.ts';
import { describe, ProposalStore, ToolError } from './tools.ts';
import { isChange } from './activity.ts';
import { cardLane } from './lanes.ts';
import { offer, stirred } from './offers.ts';
import { board } from './plans.ts';
import type { BoardCard } from './plans.ts';
import { listEvents, SynologyError } from './synology.ts';
import type { CalEvent, DsmFetch } from './synology.ts';
import { briefingFile, renderBriefingPage, writeDoc } from './docs.ts';
import type { DocAccess } from './docs.ts';
import { moveFirst } from './moves.ts';
import { addDays, capital, listingFor, midnight } from './calendar.ts';
import { CLAUDE, householdDay, householdZone, monthOf } from './types.ts';
import type {
  Actor, BriefingSource, CalendarRef, Day, Event, EventId, Month, Offer, Prediction, State,
} from './types.ts';
import type { Store } from './store.ts';

/** How far back the first-ever briefing looks. A seed import isn't news. */
const FIRST_RUN_EVENTS = 25;

export interface Decision {
  /** The ask, in one line. Rendered as the decision card's title. */
  readonly title: string;
  /** Why it matters and what happens either way. */
  readonly detail: string;
  /** The envelope it concerns, if it concerns one. */
  readonly envelope?: string;
  /** Nothing is written by naming a tool — the person still has to approve it. */
  readonly suggests?: { readonly tool: string; readonly args: Record<string, unknown> };
}

export interface Briefing {
  readonly month: Month;
  readonly day: Day;
  readonly headline: string;
  readonly body: string;
  readonly decisions: readonly Decision[];
  readonly changes: readonly ReturnType<typeof describe>[];
  /** How many changes there really were; `changes` can be the latest of them only. */
  readonly changesTotal: number;
  readonly prediction: { readonly envelope: string; readonly expected: Cents; readonly why: string } | null;
  readonly scored: readonly ScoredPrediction[];
  readonly generatedAt: string;
  readonly writtenBy: 'claude' | 'fallback';
  /**
   * The household's, written without a NAS session: the Household calendar
   * was not read for it, and the first look with a session writes it again.
   */
  readonly calendarUnread?: true;
}

// ─── what changed while you were away ────────────────────────────────────────

type ThreadBriefing = Extract<Event, { op: 'thread.briefing' }>;

/** Which sections: the household's own, or the budget's. */
type Of = { readonly source: 'household' | 'budget' };
const HOUSEHOLD: Of = { source: 'household' };
const BUDGET: Of = { source: 'budget' };

/** A line written before there was a choice of source is the budget's. */
const sourceOf = (e: ThreadBriefing): BriefingSource => e.source ?? 'budget';
const isOf = (e: ThreadBriefing, of: Of): boolean => sourceOf(e) === of.source;

/** Sections from any of these sources, oldest first, leaving out any that were replaced. */
function sections(events: readonly Event[], ...of: Of[]): ThreadBriefing[] {
  const replaced = new Set(events.flatMap((e) => (e.op === 'thread.briefing' && e.replaces ? [e.replaces] : [])));
  return events.filter((e): e is ThreadBriefing =>
    e.op === 'thread.briefing' && !replaced.has(e.id) && of.some((o) => isOf(e, o)));
}

/**
 * Where the previous day's section sits in the log, or -1 when there has never
 * been one. The budget's news runs from the last briefing that covered it: its
 * own section, or the household's, whichever came later.
 */
function previousSection(events: readonly Event[], today: Day): number {
  const before = sections(events, BUDGET, HOUSEHOLD).filter((e) => e.day < today).at(-1);
  return before ? events.indexOf(before) : -1;
}

/**
 * Changes made since the previous day's section, for every member at once.
 *
 * The first section ever looks back only a little way: a seed import is not
 * news. The total is kept beside the list, because a list cut to its latest
 * events and read as the whole is how a briefing comes to count seventeen
 * categories where there are twenty-two.
 */
export async function changesSinceSection(store: Store, today: Day):
  Promise<{ shown: Event[]; total: number }> {
  return changesSince(await store.since(null), today);
}

/**
 * A change the money's briefing is about. Friends staying are not money: the
 * guest list, nights kept and stays are the household's to see on Today and
 * in Activity, and a guest's address or a member's reason for keeping a night
 * never goes to Claude in a briefing's prompt.
 */
const isMoneyChange = (e: Event): boolean =>
  isChange(e) && !e.op.startsWith('guest.') && !e.op.startsWith('booking.') && e.op !== 'guests.arrival';

function changesSince(events: readonly Event[], today: Day): { shown: Event[]; total: number } {
  const from = previousSection(events, today);
  const news = events.slice(from + 1).filter(isMoneyChange);
  return { shown: from < 0 ? news.slice(-FIRST_RUN_EVENTS) : news, total: news.length };
}

/** Notes and questions left since the previous section, so the briefing can take them into account. */
function notesSince(events: readonly Event[], today: Day): { who: Actor; text: string }[] {
  const from = previousSection(events, today);
  return events.slice(from + 1).flatMap((e) => (e.op === 'thread.note' ? [{ who: e.who, text: e.text }] : []));
}

/** Move this person's cursor to the position the briefing was written from. */
export async function markRead(store: Store, who: Actor, upTo: string | null): Promise<void> {
  if (!upTo) return;
  if (store.state.readCursor.get(who) === upTo) return;
  await store.append(who, { op: 'briefing.read', upTo });
}

// ─── scoring what we said last time ──────────────────────────────────────────

export interface ScoredPrediction {
  readonly prediction: Prediction;
  readonly expected: Cents;
  readonly actual: Cents;
  readonly off: Cents;
  readonly within10: boolean;
}

/**
 * Score every prediction whose month has finished.
 *
 * A tool that forecasts your spending has to keep its own record. Scoring is
 * pure arithmetic over closed months, so it happens here rather than being
 * asked of Claude — and it stays honest even about predictions that were wrong.
 */
export function scorePredictions(state: State, today: Day): ScoredPrediction[] {
  const now = monthOf(today);
  const out: ScoredPrediction[] = [];
  for (const p of state.predictions) {
    if (p.month >= now) continue; // still running
    const view = monthView(state, p.month);
    const env = view?.envelopes.find((e) => e.envelope.id === p.envelope);
    if (!env) continue;
    const off = Math.abs(env.activity - p.expected) as Cents;
    out.push({
      prediction: p,
      expected: p.expected,
      actual: env.activity,
      off,
      within10: p.expected === 0 ? off === 0 : off / p.expected <= 0.1,
    });
  }
  return out;
}

// ─── the facts Claude is allowed to quote ────────────────────────────────────

const line = (label: string, value: string): string => `  ${label}: ${value}`;

/** "1 receipt", "3 receipts". */
const receipts = (n: number): string => `${n} receipt${n === 1 ? '' : 's'}`;

/**
 * Render the snapshot as text.
 *
 * Every figure is pre-formatted here on purpose. Handing Claude cents and a
 * currency convention invites it to divide by 100, and a briefing that says
 * $8.61 when the app says $861.00 is worse than no briefing.
 */
export function facts(
  snap: Snapshot,
  state: State,
  changes: readonly Event[],
  scored: readonly ScoredPrediction[],
  today: Day,
  /** How many changes there were in all, when `changes` is only the latest. */
  total: number = changes.length,
  extra: { notes?: readonly { who: Actor; text: string }[]; putOff?: readonly Offer[] } = {},
): string {
  const { view, clock } = snap;
  const parts: string[] = [];

  parts.push(`TODAY IS ${today}.`);
  parts.push(`BUDGET: ${snap.month}`);
  parts.push(`Day ${clock.dayOfMonth} of ${clock.daysInMonth}; ${clock.daysLeft} days left.`);
  parts.push('');
  parts.push('THIS MONTH');
  parts.push(line('income', fmt(view.income)));
  parts.push(line('planned at open', fmt(view.planned)));
  parts.push(line('funded now', fmt(view.funded)));
  parts.push(line('spent', fmt(view.activity)));
  parts.push(line('left to assign', fmt(view.toAssign)));
  parts.push(line('zero-based', snap.balanced ? 'yes, balanced' : 'NO — not balanced'));
  if (view.moveCount) parts.push(line('moves made this month', String(view.moveCount)));

  parts.push('');
  parts.push('ENVELOPES (planned at open / funded now / spent / available / projected by month end)');
  parts.push('The projection counts fixed monthly bills once at their known amount — including any that');
  parts.push('have not arrived yet — and extrapolates only the spending that genuinely varies.');
  for (const p of snap.pace) {
    const env = view.envelopes.find((e) => e.envelope.id === p.envelope);
    const planned = env ? fmt(env.planned) : '—';
    // Say what the projection is made of, so a big number can be read rather
    // than just believed or dismissed.
    const parts2: string[] = [];
    if (p.committed !== ZERO) parts2.push(`${fmt(p.committed)} fixed bills already paid`);
    if (p.stillExpected !== ZERO) parts2.push(`${fmt(p.stillExpected)} of fixed bills still to arrive`);
    if (p.discretionary !== ZERO) parts2.push(`${fmt(p.discretionary)} variable so far, extrapolated`);
    parts.push(`  ${p.label} [${p.envelope}]: planned ${planned}, funded ${fmt(p.funded)}, spent ${fmt(p.spent)}, `
      + `available ${fmt(p.available)}, projected ${fmt(p.projected)} [${p.status}]`
      + (parts2.length ? ` — ${parts2.join('; ')}` : ''));
  }

  const strained = snap.pace.filter((p) => p.status === 'over' || p.status === 'projected-over');
  if (strained.length) {
    parts.push('');
    parts.push('WHERE THE MONEY COULD COME FROM (spare = available after the usual rest-of-month burn)');
    for (const p of strained.slice(0, 3)) {
      const list = donors(view, clock, p.envelope, state).slice(0, 4);
      if (!list.length) { parts.push(`  for ${p.label}: nothing is genuinely spare`); continue; }
      parts.push(`  for ${p.label}: ` + list.map((d) => `${d.label} ${fmt(d.spare)} spare`).join(', '));
    }
  }

  if (snap.drift.length) {
    parts.push('');
    parts.push('PLANS THAT KEEP NEEDING TOPPING UP (this is a wrong-plan signal, not a this-month one)');
    for (const d of snap.drift) {
      parts.push(`  ${d.label}: planned ${fmt(d.averagePlanned)} on average, actually funded ${fmt(d.averageFunded)}; `
        + `topped up in ${d.toppedUp} of the last ${d.months.length} months `
        + `(${d.months.map((m) => `${m.month} planned ${fmt(m.planned)} funded ${fmt(m.funded)} spent ${fmt(m.spent)}`).join('; ')})`);
    }
  }

  if (snap.toSort.count) {
    parts.push('');
    parts.push(`TO SORT: ${receipts(snap.toSort.count)} — ${fmt(snap.toSort.outflow)} out, `
      + `${fmt(snap.toSort.inflow)} in`
      + (snap.toSort.oldest ? `, oldest ${snap.toSort.oldest}` : '')
      + '. Only the outflow is unexplained spending; the inflow is mostly pay and card payments.');
  }

  if (snap.recurring.length) {
    parts.push('');
    parts.push('RECURRING CHARGES WITH NO RULE (possible forgotten subscriptions)');
    for (const r of snap.recurring.slice(0, 8)) {
      parts.push(`  ${r.payee}: about ${fmt(r.typical)} in ${r.months.length} months`);
    }
  }

  if (scored.length) {
    parts.push('');
    parts.push('HOW EARLIER FORECASTS TURNED OUT');
    for (const s of scored.slice(-5)) {
      parts.push(`  ${s.prediction.month} ${s.prediction.envelope}: forecast ${fmt(s.expected)}, actual ${fmt(s.actual)}`
        + ` — ${s.within10 ? 'within 10%' : `off by ${fmt(s.off)}`}`);
    }
  }

  if (extra.putOff?.length) {
    parts.push('');
    parts.push('SUGGESTIONS PUT OFF WHOSE NUMBERS HAVE SINCE MOVED (worth raising again, as they stand now)');
    for (const o of extra.putOff) parts.push(`  ${o.summary}`);
  }

  if (extra.notes?.length) {
    parts.push('');
    parts.push('NOTES THE MEMBERS LEFT EACH OTHER (take these into account; do not reply to them)');
    for (const n of extra.notes) parts.push(`  ${n.who}: "${n.text}"`);
  }

  parts.push('');
  if (changes.length) {
    const listed = changes.slice(-40);
    parts.push(listed.length < total
      ? `WHAT CHANGED SINCE THE LAST BRIEFING — the latest ${listed.length} of ${total}. `
        + 'Earlier changes are not listed, so do not count from this list; say how many changed in all '
        + 'only as the total given here.'
      : 'WHAT CHANGED SINCE THE LAST BRIEFING');
    for (const e of listed) {
      const d = describe(e, state);
      parts.push(`  ${d.at.slice(0, 10)} ${d.who}: ${d.what}${d.why ? ` — "${d.why}"` : ''}`);
    }
  } else {
    parts.push('WHAT CHANGED SINCE THE LAST BRIEFING: nothing.');
  }

  return parts.join('\n');
}

// ─── generation ──────────────────────────────────────────────────────────────

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'body', 'decisions'],
  properties: {
    headline: {
      type: 'string',
      description: 'One sentence, under 90 characters, naming the single most important thing. '
        + 'If nothing needs attention, say so plainly rather than inventing a concern.',
    },
    body: {
      type: 'string',
      description: 'Two to five plain sentences. What changed since they last looked, and what it means. '
        + 'Every dollar figure copied verbatim from the facts. No headers, no bullets, no emoji.',
    },
    decisions: {
      type: 'array',
      // No maxItems — structured outputs reject array constraints, so the cap
      // lives in the description and is enforced when the briefing is built.
      description: 'At most three things needing a person today, most important first. Empty is a valid '
        + 'and common answer — do not manufacture a decision on a quiet day.',
      items: {
        type: 'object',
        additionalProperties: false,
        // envelope is required: structured outputs enforce it, and left
        // optional it was simply omitted — leaving decisions about a real
        // shortfall with nothing to act on.
        required: ['title', 'detail', 'envelope'],
        properties: {
          title: { type: 'string', description: 'The ask in one line, under 80 characters.' },
          detail: { type: 'string', description: 'Why it matters and what happens either way. Two sentences at most.' },
          envelope: {
            type: 'string',
            description: 'The envelope id this concerns, copied exactly from the facts. For a decision '
              + 'about the month as a whole, name the envelope most responsible for it.',
          },
          tool: {
            type: 'string',
            enum: ['move_money', 'set_assignment', 'sort_receipts', 'open_month'],
            description: 'The tool that would carry this out, if one would. Naming it changes nothing on its own.',
          },
        },
      },
    },
    predictEnvelope: {
      type: 'string',
      description: 'Optional. The envelope id whose month-end projection is worth recording as a forecast to be '
        + 'scored later. Choose one only when the projection is genuinely informative; leave it out otherwise. '
        + 'Do not state a number — the projection already in the facts is what gets recorded.',
    },
    predictWhy: { type: 'string', description: 'One sentence on why that forecast is worth holding to.' },
  },
} as const;

interface Drafted {
  headline: string;
  body: string;
  decisions: { title: string; detail: string; envelope?: string; tool?: string }[];
  predictEnvelope?: string;
  predictWhy?: string;
}

export interface BriefingOptions {
  /** Who is looking. Used only to run the tools that build suggestions. */
  readonly who: Actor;
  /** How long a fallback section waits before Claude is tried again. */
  readonly retryEvery?: number;
  readonly today: Day;
  readonly month?: Month;
}

/** The budget's month as the briefing reads it: the facts, and what they were made from. */
interface MonthPart {
  readonly month: Month;
  readonly snap: Snapshot;
  readonly text: string;
  readonly changes: Event[];
  readonly changesTotal: number;
  readonly scored: ScoredPrediction[];
}

/** The facts for the budget's month, or null when that month is not open. */
async function monthPart(store: Store, today: Day, month: Month): Promise<MonthPart | null> {
  const state = store.state;
  const snap = snapshot(state, month, today);
  if (!snap) return null;
  const events = await store.since(null);
  const { shown: changes, total: changesTotal } = changesSince(events, today);
  const scored = scorePredictions(state, today);
  const putOff = [...state.thread.offers.values()]
    .filter((o) => o.status === 'snoozed' && cardLane(o, state) === 'budget' && stirred(state, o));
  const text = facts(snap, state, changes, scored, today, changesTotal,
    { notes: notesSince(events, today), putOff });
  return { month, snap, text, changes, changesTotal, scored };
}

/**
 * The one Claude call a briefing makes, with no tools: it composes, and
 * anything it suggests is built into a card by the engine afterwards.
 *
 * A refusal is Claude's answer and surfaces as one. Anything else — no credit,
 * a revoked key, an outage — is Claude being unavailable, and the morning
 * screen still says what is true rather than showing the API's error.
 */
async function compose(state: State, task: string, body: string, schema: unknown, plain: (why: string) => Drafted):
  Promise<{ drafted: Drafted; writtenBy: Briefing['writtenBy'] }> {
  if (!claudeConfigured()) return { drafted: plain('no API key is configured'), writtenBy: 'fallback' };
  try {
    const { value } = await structured<Drafted>(houseRules(state) + '\n\n' + task, body, schema as Record<string, unknown>);
    return { drafted: value, writtenBy: 'claude' };
  } catch (err) {
    if (err instanceof ClaudeRefused) throw err;
    const why = unavailableReason(err);
    console.warn(`[budget] briefing written without Claude: ${why}`);
    return { drafted: plain(`Claude could not be reached: ${why}`), writtenBy: 'fallback' };
  }
}

/**
 * Claude picks which projection is worth committing to; the number itself
 * comes from the projection it was shown, never from the model.
 */
async function forecast(store: Store, drafted: Drafted, m: MonthPart): Promise<Briefing['prediction']> {
  if (!drafted.predictEnvelope) return null;
  const p = m.snap.pace.find((x) => x.envelope === drafted.predictEnvelope);
  if (!p) return null;
  const prediction = { envelope: p.envelope, expected: p.projected, why: drafted.predictWhy ?? 'projected at the current rate' };
  await store.append(CLAUDE, {
    op: 'prediction.record',
    prediction: `${m.month}:${p.envelope}`,
    month: m.month, envelope: p.envelope,
    expected: p.projected, why: prediction.why,
  });
  return prediction;
}

/** At most three decisions, each with the runnable suggestion the engine can build for it, if any. */
function decisionsOf(drafted: Drafted, state: State, m: MonthPart | null): Decision[] {
  return drafted.decisions.slice(0, 3).map((d) => ({
    title: d.title,
    detail: d.detail,
    ...(d.envelope ? { envelope: d.envelope } : {}),
    ...(m ? suggestion(d, m.snap, state, m.month) : {}),
  }));
}

/**
 * Draft a section of the briefing. Writes nothing but a forecast, if Claude
 * picks one; ensureSection is what records it.
 */
export async function brief(store: Store, opts: BriefingOptions): Promise<Briefing> {
  const state = store.state;
  const month = opts.month ?? monthOf(opts.today);
  const m = await monthPart(store, opts.today, month);
  if (!m) throw new ToolError(`${month} is not open`, 409);

  const { drafted, writtenBy } = await compose(state, BRIEFING_TASK, m.text, SCHEMA,
    (why) => fallback(m.snap, m.changesTotal, why));
  return {
    month, day: opts.today,
    headline: drafted.headline,
    body: drafted.body,
    decisions: decisionsOf(drafted, state, m),
    changes: m.changes.map((e) => describe(e, state)),
    changesTotal: m.changesTotal,
    prediction: await forecast(store, drafted, m),
    scored: m.scored,
    generatedAt: new Date().toISOString(),
    writtenBy,
  };
}

// ─── one briefing for the household ──────────────────────────────────────────

export interface HouseholdOptions {
  /** Who is looking. Used only to run the tools that build suggestions. */
  readonly who: Actor;
  readonly today: Day;
  /** The looker's NAS session, which the Household calendar is read with. Null reads nothing. */
  readonly sid: string | null;
  /** The household's zone; the deployment's when not given. */
  readonly tz?: string;
  /** How long a fallback briefing waits before Claude is tried again. */
  readonly retryEvery?: number;
  /** The household whose Drive folder the briefing's page goes in. With none, or no `sid`, the words stay in the log. */
  readonly household?: string;
  /** DSM, for tests; the real one otherwise. */
  readonly f?: DsmFetch;
}

/** One block of the household's facts: what Claude is shown, and the same in plain words for the fallback. */
interface Block { readonly lines: string[]; readonly plain: string; readonly had: boolean }

interface Gathered {
  readonly text: string;
  readonly sources: ('budget' | 'plans' | 'calendar')[];
  readonly missing: string[];
  readonly month: MonthPart | null;
  readonly plans: Block & { readonly overdue: readonly string[] };
  /** `unread` is why it was not read, for the log; `noSession` that a look with a session would read it. */
  readonly calendar: Block & { readonly unread: string | null; readonly noSession: boolean };
}

/** "Mon 17 Aug", for a day; the weekday saves the reader counting. */
const dayWords = (day: Day): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .replace(',', '');

/**
 * The board, as facts: what is overdue, what is due this week, what has been
 * in Doing a fortnight or more, and every ask still waiting on a member.
 *
 * A plan in Planning is still being thought about. It is listed when its due
 * date makes it news, and never with an age: the only clock the briefing reads
 * is the one that runs in Doing. Due and overdue are facts, not reproaches.
 */
function plansBlock(state: State, events: readonly Event[], today: Day, tz: string): Gathered['plans'] {
  const cards = board(state, events, { who: 'everyone', today, tz }).rows.flatMap((r) => r.plans);
  const weekOut = addDays(today, 7);
  const where = (c: BoardCard) => `${c.area}, ${c.state === 'doing' ? 'in Doing' : 'in Planning'}, ${c.owner}'s`;
  const overdue = cards.filter((c) => c.due !== null && c.due < today).sort((a, b) => a.due!.localeCompare(b.due!));
  const soon = cards.filter((c) => c.due !== null && c.due >= today && c.due <= weekOut).sort((a, b) => a.due!.localeCompare(b.due!));
  const long = cards.filter((c) => c.state === 'doing' && (c.daysInState ?? 0) >= 14)
    .sort((a, b) => (b.daysInState ?? 0) - (a.daysInState ?? 0));
  const asks = cards.filter((c) => c.asked !== null);

  const lines: string[] = [];
  const plain: string[] = [];
  for (const c of overdue) {
    lines.push(`  overdue: "${c.title}" (${where(c)}), was due ${c.due} (${dayWords(c.due!)})`);
    plain.push(`${c.title} was due ${dayWords(c.due!)}.`);
  }
  for (const c of soon) {
    lines.push(`  due within the week: "${c.title}" (${where(c)}), due ${c.due} (${dayWords(c.due!)})`);
    plain.push(`${c.title} is due ${c.due === today ? 'today' : dayWords(c.due!)}.`);
  }
  for (const c of long) {
    lines.push(`  in Doing for 14 days or more: "${c.title}" (${c.area}, ${c.owner}'s), ${c.daysInState} days in Doing`);
    plain.push(`${c.title} has been in Doing for ${c.daysInState} days.`);
  }
  for (const c of asks) {
    lines.push(`  waiting on ${c.asked!.to}: ${c.owner} asked them to take "${c.title}" — "${c.asked!.why}"`);
    plain.push(`${capital(c.owner)} asked ${capital(c.asked!.to)} to take ${c.title}.`);
  }
  const had = lines.length > 0;
  return {
    lines: [
      '  A plan in Planning is still being thought about: say it only as listed here, never press on it.',
      ...(had ? lines : ['  nothing is overdue, due this week, long in Doing or waiting on an ask.']),
    ],
    plain: had ? plain.join(' ') : 'Nothing on the board is overdue, due this week or waiting on anyone.',
    had,
    overdue: overdue.map((c) => c.title),
  };
}

/** The most the calendar block lists; it is a reminder of the week, not the week. */
const CALENDAR_LINES = 12;

/** What the briefing says when the Household calendar was not read for it: said once, of the briefing. */
const CALENDAR_UNREAD = 'The Household calendar was not read for this briefing.';

/** Whether a draft already says the calendar was not read, in Claude's words or the engine's. */
const saysUnread = (body: string): boolean => /calendar[^.]*(?:\bnot\b|n['\u2019]t\b)[^.]*\bread\b/i.test(body);

/**
 * The Household calendar from the start of today to the end of the seventh
 * day after it, where the household is. Only that calendar: never anyone's
 * own, nor one the household chose for plans or for checking clashes.
 *
 * It never fails the briefing. Without a NAS session, or when the NAS says
 * no, the block says the calendar was not read for this briefing, in words
 * that are the briefing's and not the looker's: every member reads it. Why is
 * kept for `missing` and the server's log.
 */
async function calendarBlock(state: State, o: HouseholdOptions, tz: string): Promise<Gathered['calendar']> {
  const cal = state.calendar.household;
  if (!cal) {
    return { lines: ['  no Household calendar yet.'], plain: 'There is no Household calendar yet.', had: false, unread: null, noSession: false };
  }
  let rows: CalEvent[] | null = null;
  let unread: string | null = null;
  if (!o.sid) {
    unread = 'this sign-in has no NAS session';
  } else {
    try {
      // Addressed as the looker's own account lists it, as every call about
      // the calendar is (calendar.ts, listingFor): its maker by the log's ids,
      // anyone else perhaps by a cal_id of their own.
      const ref: CalendarRef | null = (await listingFor(o.sid, o.f)).as({ cal_id: cal.cal_id, original_cal_id: cal.original_cal_id });
      if (!ref) unread = `the Household calendar is not shared with ${o.who} on the NAS`;
      if (ref) {
        rows = await listEvents(o.sid, {
          calendars: [ref], start: midnight(o.today, tz), end: midnight(addDays(o.today, 8), tz),
        }, o.f);
      }
    } catch (err) {
      // Never the sid: a SynologyError's message names the call, not the session.
      unread = err instanceof SynologyError ? err.message : 'the NAS did not answer';
      console.warn(`[briefing] reading the Household calendar failed: ${(err as Error).message}`);
    }
  }
  if (!rows) {
    return { lines: [`  ${CALENDAR_UNREAD}`], plain: CALENDAR_UNREAD, had: false, unread: unread ?? 'not read', noSession: !o.sid };
  }

  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const when = (e: CalEvent): string => {
    const day = dayWords(householdDay(tz, new Date(e.dtstart * 1000)));
    return e.is_all_day ? `${day}, all day` : `${day} ${time.format(e.dtstart * 1000)}–${time.format(e.dtend * 1000)}`;
  };
  const events = rows.filter((e) => Number.isFinite(e.dtstart) && Number.isFinite(e.dtend))
    .sort((a, b) => a.dtstart - b.dtstart);
  const listed = events.slice(0, CALENDAR_LINES);
  const shown = listed.map((e) => `${when(e)}: ${e.summary.trim() || '(no title)'}`);
  // In the plain words, what before when: one colon, after the heading.
  const plainly = listed.map((e) => `${e.summary.trim() || 'something untitled'} (${when(e)})`);
  const more = events.length - shown.length;
  if (!shown.length) {
    return { lines: ['  nothing on it this week.'], plain: 'Nothing is on the Household calendar this week.', had: false, unread: null, noSession: false };
  }
  return {
    lines: ['  The shared calendar, today and the seven days after it, in the household\'s time:',
            ...shown.map((l) => `  ${l}`), ...(more > 0 ? [`  and ${more} more`] : [])],
    plain: `This week on the Household calendar: ${plainly.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`,
    had: true,
    unread: null,
    noSession: false,
  };
}

async function gather(store: Store, o: HouseholdOptions): Promise<Gathered> {
  const state = store.state;
  const tz = householdZone(o.tz);
  const events = await store.since(null);
  const month = await monthPart(store, o.today, monthOf(o.today));
  const plans = plansBlock(state, events, o.today, tz);
  const calendar = await calendarBlock(state, o, tz);

  const text = [
    month ? month.text : `TODAY IS ${o.today}.\n\nTHIS MONTH\n  ${monthOf(o.today)} is not open yet.`,
    ['PLANS', ...plans.lines].join('\n'),
    ['HOUSEHOLD CALENDAR', ...calendar.lines].join('\n'),
  ].join('\n\n');
  return {
    text,
    sources: [...(month ? ['budget' as const] : []), ...(plans.had ? ['plans' as const] : []),
              ...(calendar.had ? ['calendar' as const] : [])],
    missing: calendar.unread ? [`calendar: ${calendar.unread}`] : [],
    month, plans, calendar,
  };
}

/**
 * The household's facts in three blocks: THIS MONTH (the budget's own facts
 * for it, or that it is not open), PLANS, and HOUSEHOLD CALENDAR. `sources` is
 * the blocks that had something to say; `missing` what could not be read.
 */
export async function householdFacts(store: Store, o: HouseholdOptions):
  Promise<{ text: string; sources: ('budget' | 'plans' | 'calendar')[]; missing: string[] }> {
  const g = await gather(store, o);
  return { text: g.text, sources: g.sources, missing: g.missing };
}

/**
 * Draft the household's briefing: one Claude call over all three blocks.
 * Writes nothing but a forecast, if Claude picks one; ensureHousehold is what
 * records it.
 */
export async function briefHousehold(store: Store, o: HouseholdOptions): Promise<Briefing> {
  const state = store.state;
  const g = await gather(store, o);
  let composed: Awaited<ReturnType<typeof compose>>;
  try {
    composed = await compose(state, BRIEFING_TASK + '\n\n' + HOUSEHOLD_TASK, g.text, HOUSEHOLD_SCHEMA,
      (why) => householdFallback(g, why));
  } catch (err) {
    // A refusal is written as the plain briefing, retried like any fallback:
    // left unwritten, every load of Today would ask Claude again.
    if (!(err instanceof ClaudeRefused)) throw err;
    console.warn('[briefing] Claude declined to write the household\'s briefing; written plainly');
    composed = { drafted: householdFallback(g, 'Claude declined to write it'), writtenBy: 'fallback' };
  }
  const { drafted, writtenBy } = composed;
  // What could not be read is said whoever wrote the rest, once: in the
  // engine's words, unless Claude already said it.
  const unread = writtenBy === 'claude' && g.calendar.unread && !saysUnread(drafted.body) ? `\n\n${CALENDAR_UNREAD}` : '';
  return {
    month: monthOf(o.today), day: o.today,
    headline: drafted.headline,
    body: drafted.body + unread,
    decisions: decisionsOf(drafted, state, g.month),
    changes: (g.month?.changes ?? []).map((e) => describe(e, state)),
    changesTotal: g.month?.changesTotal ?? 0,
    prediction: g.month ? await forecast(store, drafted, g.month) : null,
    scored: g.month?.scored ?? scorePredictions(state, o.today),
    generatedAt: new Date().toISOString(),
    writtenBy,
    ...(g.calendar.noSession ? { calendarUnread: true as const } : {}),
  };
}

export interface Section {
  readonly event: EventId;
  readonly day: Day;
  readonly writtenBy: 'claude' | 'fallback';
}

/** One draft at a time a day, so two members opening at once write one section. */
const inFlight = new Map<string, Promise<Section>>();
/**
 * When Claude was last tried for a day that has only the fallback. The thread
 * reloads after every note and decision; during an outage each of those must
 * not wait on Claude again.
 */
const lastTried = new Map<string, number>();
/** The same two for the household's briefing, kept apart from the budget's. */
const householdInFlight = new Map<string, Promise<Section>>();
const householdTried = new Map<string, number>();
const RETRY_EVERY = 10 * 60 * 1000;

/**
 * The day's section for the budget: returned if it is recorded, written and
 * recorded if not.
 *
 * A section the fallback wrote because Claude was unreachable is retried on
 * the next look, and a Claude-written one replaces it for the rest of the day.
 * Each runnable suggestion becomes a card raised by the section.
 */
export function ensureSection(store: Store, o: BriefingOptions): Promise<Section> {
  const key = `${store.path}|budget|${o.today}`;
  return once(inFlight, key, () => record(store, {
    key, tried: lastTried, of: BUDGET, who: o.who, today: o.today,
    ...(o.retryEvery !== undefined ? { retryEvery: o.retryEvery } : {}),
    draft: () => brief(store, o),
  }));
}

/**
 * The household's briefing for the day, one for every member whichever of
 * them looks first: returned if it is recorded, written and recorded if not,
 * under the same rules as the budget's section.
 */
export function ensureHousehold(store: Store, o: HouseholdOptions): Promise<Section> {
  const key = `${store.path}|household|${o.today}`;
  return once(householdInFlight, key, () => record(store, {
    key, tried: householdTried, of: HOUSEHOLD, who: o.who, today: o.today, canReadCalendar: !!o.sid,
    access: { sid: o.sid, store, ...(o.household !== undefined ? { household: o.household } : {}) },
    ...(o.f ? { f: o.f } : {}),
    ...(o.retryEvery !== undefined ? { retryEvery: o.retryEvery } : {}),
    draft: () => briefHousehold(store, o),
  }));
}

function once(running: Map<string, Promise<Section>>, key: string, run: () => Promise<Section>): Promise<Section> {
  const now = running.get(key);
  if (now) return now;
  const work = run().finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

interface Recording {
  readonly key: string;
  readonly tried: Map<string, number>;
  readonly of: Of;
  readonly who: Actor;
  readonly today: Day;
  readonly retryEvery?: number;
  /** The looker has a NAS session: a briefing written without the calendar is written again, with it. */
  readonly canReadCalendar?: boolean;
  /** Where the page goes: the household's chosen Drive folder, as the looker's session sees it. None, or no folder, keeps the words in the log. */
  readonly access?: DocAccess;
  /** DSM, for tests; the real one otherwise. */
  readonly f?: DsmFetch;
  readonly draft: () => Promise<Briefing>;
}

async function record(store: Store, r: Recording): Promise<Section> {
  const today = sections(await store.since(null), r.of).filter((e) => e.day === r.today).at(-1);
  const as = (e: ThreadBriefing): Section =>
    ({ event: e.id, day: e.day, writtenBy: e.writtenBy });
  // Written without the calendar, and this look can read it: written again, once.
  const withoutCalendar = today?.calendarUnread === true && r.canReadCalendar === true;
  if (today && !withoutCalendar && (today.writtenBy === 'claude' || !claudeConfigured())) return as(today);

  if (today && !withoutCalendar && Date.now() - (r.tried.get(r.key) ?? 0) < (r.retryEvery ?? RETRY_EVERY)) return as(today);
  r.tried.set(r.key, Date.now());

  const b = await r.draft();
  // Still unreachable: the fallback already on the page says so.
  if (today && !withoutCalendar && b.writtenBy === 'fallback') return as(today);

  // The effect first, then the line that names it. A page that did not get
  // written (no session, no household, Drive refusing) leaves the words in the
  // log, and nobody is told. A replaced briefing's event keeps the version it
  // described: this write is a new version of the same file.
  // A briefing written again mid-move: its file moves first, so this is a new version of it in the new folder.
  const rel = ['today', briefingFile(r.today, r.of.source)] as const;
  if (r.access) await moveFirst({ ...r.access, store, who: r.who }, rel, r.f);
  const doc = r.access ? await writeDoc(r.access, rel,
    renderBriefingPage({ day: r.today, source: r.of.source, writtenBy: b.writtenBy, headline: b.headline, body: b.body }), r.f) : null;
  const [e] = await store.append(CLAUDE, {
    op: 'thread.briefing', day: r.today, source: r.of.source,
    headline: b.headline, ...(doc ? { doc } : { body: b.body }), writtenBy: b.writtenBy,
    ...(today ? { replaces: today.id } : {}),
    ...(b.calendarUnread ? { calendarUnread: true as const } : {}),
  });
  const ctx = { store, who: r.who, today: r.today, proposals: new ProposalStore(), sid: null };
  for (const d of b.decisions) {
    if (!d.suggests) continue;
    try {
      await offer(ctx, { tool: d.suggests.tool, args: d.suggests.args, prompt: { kind: 'briefing', ref: e!.id } });
    } catch (err) {
      // A suggestion that cannot be built is still worth reading in the
      // section; it just gets no card.
      if (!(err instanceof ToolError)) throw err;
    }
  }
  return as(e as ThreadBriefing);
}

/**
 * Turn "this envelope needs help" into a complete, runnable proposal.
 *
 * Claude names the envelope; every figure in the call comes from analytics.ts —
 * the shortfall from the envelope's own position, the source from the ranked
 * donors. Asking Claude for the amount would have it doing arithmetic, and
 * passing a partial call leaves a button on screen that can only ever fail.
 *
 * When a complete call cannot be derived, no button is offered at all. A card
 * with only words on it is still worth reading; a control that errors is not.
 */
function suggestion(
  d: { title: string; tool?: string; envelope?: string },
  snap: Snapshot,
  state: State,
  month: Month,
): Record<string, never> | { suggests: NonNullable<Decision['suggests']> } {
  const common = { month };

  if (d.tool === 'open_month' || d.tool === 'sort_receipts') {
    return { suggests: { tool: d.tool, args: common } };
  }

  // Accept the label as well as the id. The facts block leads with the label,
  // and a decision that names "Personal & fun" instead of "pers" is right about
  // the envelope and wrong only about which string identifies it.
  const want = (d.envelope ?? '').trim().toLowerCase();
  const p = want
    ? snap.pace.find((x) => x.envelope.toLowerCase() === want || x.label.toLowerCase() === want)
    : undefined;
  if (!p) return {};

  // What it is short by: already overspent, or on course to be.
  const short = p.available < 0 ? (-p.available as Cents)
    : p.projectedOver > 0 ? p.projectedOver
    : ZERO;
  if (short <= 0) return {};

  // The tool is derived, not taken on trust. Claude leaves the field out often
  // enough that depending on it meant a card with a real shortfall and no way
  // to act on it — and naming an envelope that is short already says what the
  // useful proposal is.
  if (d.tool === 'move_money' || d.tool === undefined) {
    const from = donors(snap.view, snap.clock, p.envelope, state)[0];
    if (!from) return {};
    // Never take more than the source can actually spare.
    const amount = (short < from.spare ? short : from.spare) as Cents;
    if (amount <= 0) return {};
    return { suggests: { tool: 'move_money', args: {
      ...common, from: from.envelope, to: p.envelope, amountCents: amount,
      why: d.title,
    } } };
  }

  if (d.tool === 'set_assignment') {
    return { suggests: { tool: 'set_assignment', args: {
      ...common, envelope: p.envelope, toCents: (p.funded + short) as Cents, why: d.title,
    } } };
  }
  return {};
}

const BRIEFING_TASK = `TODAY'S TASK

Write the household's daily briefing from the facts below. Every member reads it, every morning; most
mornings nothing is wrong, and it has to stay worth opening on those mornings too. If members left
notes, take them into account — a note can mean a concern is already handled.

A quiet day is a real answer. Say so, and use the space for something forward-looking instead — a
plan that looks thin for next month, a habit worth naming, how an earlier forecast turned out. Never
invent a concern to fill the page, and never pad.

Lead with what changed since the last briefing, because that is the part only this briefing can tell
them. Then whatever needs a person today.

Every dollar figure must be copied character-for-character from the facts. Do not compute, combine or
round anything.`;

const HOUSEHOLD_TASK = `THE WHOLE HOUSEHOLD

This briefing is the whole household's, and the facts come in three blocks: THIS MONTH (the money),
PLANS (their board of things to do) and HOUSEHOLD CALENDAR (the shared calendar, the coming week).
Write one briefing from all three. What changed since the last briefing still comes first; then whatever
matters most today, whichever block it is in.

A plan in Planning is still being thought about. Mention one only as the facts list it, never press on
it, and never say how long it has been there. Overdue, due this week, and a fortnight or more in Doing
are facts to say plainly, not reproaches. An ask waiting on someone is worth naming them for.

If the HOUSEHOLD CALENDAR block says it was not read, leave that out: the briefing says so itself, once.
Carry on with the rest. Copy dates and times as the facts give them. A decision about a plan or the
calendar names no envelope.`;

/** The briefing's schema, with decisions that may concern a plan or the calendar rather than money. */
const HOUSEHOLD_SCHEMA = {
  ...SCHEMA,
  properties: {
    ...SCHEMA.properties,
    decisions: {
      ...SCHEMA.properties.decisions,
      items: {
        ...SCHEMA.properties.decisions.items,
        properties: {
          ...SCHEMA.properties.decisions.items.properties,
          envelope: {
            type: 'string',
            description: 'The envelope id this concerns, copied exactly from the facts; for a decision about the '
              + 'month as a whole, the envelope most responsible for it. An empty string when it concerns a plan '
              + 'or the calendar rather than money.',
          },
        },
      },
    },
  },
} as const;

/**
 * A briefing without Claude.
 *
 * Not a placeholder: if the API key is missing or the account is out of credit,
 * the morning screen still has to say something true. Terse and mechanical
 * beats empty.
 */
function fallback(snap: Snapshot, changeCount: number, why: string): Drafted {
  const plain = plainMonth(snap, changeCount);
  return { ...plain, body: `${plain.body} (Written without Claude — ${why}.)` };
}

/** The month in plain words, without saying who wrote it. */
export function plainMonth(snap: Snapshot, changeCount: number): Drafted {
  const over = snap.pace.filter((p) => p.status === 'over');
  const heading = over.length
    ? `${over.length} envelope${over.length > 1 ? 's are' : ' is'} over: ${over.map((p) => p.label).join(', ')}`
    : !snap.balanced
      ? `${fmt(snap.view.toAssign)} still needs assigning`
      : snap.toSort.count
        ? `${receipts(snap.toSort.count)} to sort`
        : 'Nothing needs attention today.';
  return {
    headline: heading,
    body: `Day ${snap.clock.dayOfMonth} of ${snap.clock.daysInMonth}. Funded ${fmt(snap.view.funded)}, `
      + `spent ${fmt(snap.view.activity)}, ${fmt(snap.view.toAssign)} left to assign. `
      // Unsorted receipts are in no envelope, so "spent" leaves them out.
      + (snap.toSort.count
        ? `${receipts(snap.toSort.count)} `
          + `(${fmt(snap.toSort.outflow)} out) ${snap.toSort.count === 1 ? 'is' : 'are'} not in an envelope yet. `
        : '')
      + `${changeCount} change${changeCount === 1 ? '' : 's'} since the last briefing.`,
    decisions: over.slice(0, 3).map((p) => ({
      title: `${p.label} is over by ${fmt(Math.abs(p.available) as Cents)}`,
      detail: `Funded ${fmt(p.funded)}, spent ${fmt(p.spent)}, ${snap.clock.daysLeft} days left.`,
      envelope: p.envelope, tool: 'move_money',
    })),
  };
}

const QUIET = 'Nothing needs attention today.';

/**
 * The household's briefing without Claude: the three blocks' plain summaries,
 * one paragraph each, in the order Claude is shown them. The headline is the
 * month's, unless the month is quiet and a plan is overdue.
 */
function householdFallback(g: Gathered, why: string): Drafted {
  const money = g.month ? plainMonth(g.month.snap, g.month.changesTotal) : null;
  const headline = money && money.headline !== QUIET ? money.headline
    : g.plans.overdue.length
      ? `${g.plans.overdue.length === 1 ? 'A plan is' : `${g.plans.overdue.length} plans are`} past due: ${g.plans.overdue.join(', ')}`
      : QUIET;
  return {
    headline,
    body: [
      money ? money.body : 'This month is not open yet.',
      g.plans.plain,
      g.calendar.plain,
      `(Written without Claude — ${why}.)`,
    ].join('\n\n'),
    decisions: money?.decisions ?? [],
  };
}

export { monthClock };
