/**
 * The household's to-do board, read from the log.
 *
 * Nothing here is stored: a card is a plan from the replayed state, the money
 * on it is the envelope's own figure for the month, and its history is the
 * log's sentences about it. Reading never writes.
 */

import { currentDoc } from './docs.ts';
import { fmt } from './money.ts';
import { monthView } from './envelopes.ts';
import { ToolError } from './errors.ts';
import { describe } from './tools.ts';
import { goalSpelling, notOnCalendar, sameGoal } from './plan-rules.ts';
import { householdDay, householdZone, monthOf, visibleTo } from './types.ts';
import type {
  Actor, Block, Day, EnvelopeId, Event, EventId, Offer, Plan, PlanId, PlanState, State,
} from './types.ts';

export interface BoardCard {
  id: PlanId; title: string; area: string; goal: string | null; state: PlanState; owner: Actor; asked: Plan['asked'];
  chips: readonly string[]; due: Day | null; blocks: readonly Block[];
  envelope: { envelope: EnvelopeId; label: string; left: string } | null;
  /** Whole days in Doing. Null in Planning and once done: the clock only runs in Doing. */
  daysInState: number | null;
  /** A `thread.answer` for this plan exists. */
  hasResearch: boolean;
  /** Its due date or a block is kept on the plan but not yet on the calendar. */
  notOnCalendar: boolean;
  /** When a finished plan was finished (`stateAt`); null while it is open. */
  doneAt: string | null;
}

/**
 * One area. `plans` and `done` are what the board's filters leave of it; `all`
 * counts the whole area and ignores both filters: its open plans (Planning and
 * Doing), those in Doing, and the finished ones.
 */
export interface BoardRow {
  area: string;
  all: { plans: number; doing: number; done: number };
  plans: BoardCard[];
  done: BoardCard[];
}

/** The board whole: every area, who is pressed, the goal in its stored spelling (null for none), and the counts beside. */
export interface Board {
  who: Actor | 'everyone';
  goal: string | null;
  areas: string[];
  rows: BoardRow[];
  members: { member: Actor; plans: number }[];
  goals: { goal: string; plans: number; done: number }[];
}

/**
 * A plan's card. Its page is said by where it is, and nothing else of it: the
 * link, file id, hash and version are the app's bookkeeping and never leave
 * the server.
 */
export interface CardView extends Omit<Plan, 'page' | 'pageEvent'> {
  page: { path: string } | null;
  /** Shelves are retired into goals: always null, kept so an older reader finds the field. */
  shelf: null;
  /** Always empty, for the same reason. */
  children: [];
  /** Every goal the household has, as the board lists them. */
  goals: { goal: string; plans: number; done: number }[];
  /** As on the board: whole days in Doing, and null anywhere else. */
  daysInState: number | null;
  money: { label: string; left: string; estimate: string | null; monthsAtFunding: number | null } | null;
  /** `text` is the answer, or its headline when `doc` says where the whole of it is kept. */
  research: { id: EventId; at: string; text: string; suggestions: Offer[]; doc?: { path: string } }[];
  between: { id: EventId; at: string; who: Actor; text: string }[];
  history: { at: string; who: Actor; what: string }[];
  /** Which of its dates are not on the calendar yet: the due date, and the blocks by id. */
  notOnCalendar: { due: boolean; blocks: string[] };
}

const DAY_MS = 86_400_000;

/**
 * Whole calendar days from when a plan entered its state to `today`; 0 on the
 * day, never negative. Both ends are the household's days: `today` already is,
 * and `at` is an instant, read in the household's zone.
 */
const daysSince = (at: string, today: Day, tz: string): number =>
  Math.max(0, Math.round((Date.parse(today.slice(0, 10)) - Date.parse(householdDay(tz, at))) / DAY_MS));

/**
 * The board's one clock: how long a plan has been in Doing. Nothing in
 * Planning has an age, and a finished plan's clock has stopped, so neither
 * carries one for anything to show or for Claude to bring up.
 */
const doingFor = (p: Plan, today: Day, tz: string): number | null =>
  p.state === 'doing' ? daysSince(p.stateAt, today, tz) : null;

/**
 * The envelope a plan points at, for this month: its label and what is left,
 * straight from the month's own rollup. Null when the plan has none, or the
 * month is not open, rather than a figure from some other month.
 */
function envelopeFigures(state: State, p: Plan, today: Day) {
  if (!p.envelope) return null;
  const view = monthView(state, monthOf(today));
  const row = view?.envelopes.find((e) => e.envelope.id === p.envelope);
  return row ? { label: row.envelope.label, left: fmt(row.available), planned: row.planned } : null;
}

const researchedPlans = (events: readonly Event[]): Set<PlanId> => {
  const out = new Set<PlanId>();
  for (const e of events) if (e.op === 'thread.answer' && e.plan) out.add(e.plan);
  return out;
};

function cardOf(state: State, p: Plan, today: Day, tz: string, researched: ReadonlySet<PlanId>): BoardCard {
  const money = envelopeFigures(state, p, today);
  return {
    id: p.id, title: p.title, area: p.area, goal: p.goal, state: p.state, owner: p.owner, asked: p.asked,
    chips: p.chips, due: p.due, blocks: p.blocks,
    envelope: p.envelope && money ? { envelope: p.envelope, label: money.label, left: money.left } : null,
    daysInState: doingFor(p, today, tz),
    hasResearch: researched.has(p.id),
    notOnCalendar: (({ due, blocks }) => due || blocks.length > 0)(notOnCalendar(p)),
    doneAt: p.state === 'done' ? p.stateAt : null,
  };
}

const live = (state: State): Plan[] => [...state.plans.values()].filter((p) => !p.removed);

/** Every goal a live plan carries, in any state, with its plans and how many are done; alphabetical ignoring case. */
export function goalsOf(state: State): { goal: string; plans: number; done: number }[] {
  const found: { goal: string; plans: number; done: number }[] = [];
  for (const p of live(state)) {
    if (p.goal === null) continue;
    const g = p.goal;
    let row = found.find((r) => sameGoal(r.goal, g));
    if (!row) found.push(row = { goal: g, plans: 0, done: 0 });
    row.plans += 1;
    if (p.state === 'done') row.done += 1;
  }
  return found.sort((a, b) => a.goal.toLowerCase().localeCompare(b.goal.toLowerCase()));
}

/**
 * The board, whole: one row per area, in the household's order, whatever the
 * filters leave in it. `who` keeps what that member owns, strictly: an open
 * ask puts nothing in their view, and a member who owns nothing gets nothing
 * (it is the route that falls back to everyone, not this). `goal`, when it
 * names a goal (ignoring case), keeps the plans carrying it and is answered in
 * its stored spelling; a goal nobody has filters nothing and is answered as
 * null. `plans` are the open plans in view, Doing first and then in the log's
 * order; `done` the finished ones in view, newest first. `members` counts each
 * member's cards in view ignoring `who` (open ones, and under a goal the done
 * ones too), leaving out a member with none. `tz` is the household's zone,
 * which `today` is a day in; the deployment's TZ when not given.
 */
export function board(
  state: State,
  events: readonly Event[],
  o: { who: Actor | 'everyone'; goal?: string | null; today: Day; tz?: string },
): Board {
  const plans = live(state);
  const researched = researchedPlans(events);
  const tz = householdZone(o.tz);
  const goal = o.goal ? goalSpelling(plans, o.goal) : null;
  const onGoal = (p: Plan) => goal === null || (p.goal !== null && sameGoal(p.goal, goal));
  const byWho = (p: Plan) => o.who === 'everyone' || p.owner === o.who;
  const cardFor = (p: Plan) => cardOf(state, p, o.today, tz, researched);
  const areas = state.settings.areas;

  const rows = areas.map((area): BoardRow => {
    const here = plans.filter((p) => p.area === area);
    const open = here.filter((p) => p.state !== 'done');
    const seen = here.filter((p) => byWho(p) && onGoal(p));
    return {
      area,
      all: { plans: open.length, doing: open.filter((p) => p.state === 'doing').length, done: here.length - open.length },
      plans: [...seen.filter((p) => p.state === 'doing'), ...seen.filter((p) => p.state === 'planning')].map(cardFor),
      done: seen.filter((p) => p.state === 'done').sort((x, y) => y.stateAt.localeCompare(x.stateAt)).map(cardFor),
    };
  });

  const inView = plans.filter((p) => areas.includes(p.area) && onGoal(p) && (p.state !== 'done' || goal !== null));
  const members = [...state.members].map((member) => ({ member, plans: inView.filter((p) => p.owner === member).length }))
    .filter((m) => m.plans > 0);

  return { who: o.who, goal, areas: [...areas], rows, members, goals: goalsOf(state) };
}

/** Everything about one plan: itself, its goals, its money, what Claude found, what was said, what happened. */
export function card(state: State, events: readonly Event[], id: PlanId, o: { who: Actor; today: Day; tz?: string }): CardView {
  const p = state.plans.get(id);
  if (!p || p.removed) throw new ToolError(`no such plan: ${id}`, 404);

  const researched = researchedPlans(events);
  const figures = envelopeFigures(state, p, o.today);
  const estimate = p.estimate;
  const money: CardView['money'] = figures && {
    label: figures.label,
    left: figures.left,
    estimate: estimate === null ? null : fmt(estimate),
    // How many months of this envelope's funding the estimate asks for.
    monthsAtFunding: estimate === null || figures.planned <= 0 ? null : Math.ceil(estimate / figures.planned),
  };

  // An appointment for someone else's own calendar is theirs alone, here as in the thread.
  const offers = [...state.thread.offers.values()].filter((x) => visibleTo(x, o.who));
  const hidden = new Set([...state.thread.offers.values()].filter((x) => !visibleTo(x, o.who)).map((x) => x.id));
  const research = events.flatMap((e) => e.op === 'thread.answer' && e.plan === id
    ? [{ id: e.id, at: e.at, text: e.text, suggestions: offers.filter((x) => x.prompt.ref === e.id),
         ...(e.doc ? { doc: { path: currentDoc(state, e.doc).path } } : {}) }] : []);
  const between = events.flatMap((e) => e.op === 'thread.note' && e.plan === id
    ? [{ id: e.id, at: e.at, who: e.who, text: e.text }] : []);
  // A page written to Drive is the app's bookkeeping, not something done to the plan.
  const history = events.filter((e) => 'plan' in e && e.plan === id && e.op !== 'plan.doc' && !hidden.has(e.id))
    .map((e) => { const d = describe(e, state); return { at: d.at, who: d.who, what: d.what }; });

  const { page, pageEvent: _pageEvent, ...plan } = p;
  return {
    ...plan,
    page: page ? { path: page.doc.path } : null,
    shelf: null,
    children: [],
    goals: goalsOf(state),
    daysInState: doingFor(p, o.today, householdZone(o.tz)),
    money, research, between, history,
    notOnCalendar: notOnCalendar(p),
  };
}
