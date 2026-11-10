/**
 * The reply box: a question for Claude, or a note for the other members.
 *
 * Both go in the log, because the question that led to a decision is as much
 * the record as the decision. A note costs nothing and works with no key;
 * Claude reads notes but never answers them. A question is recorded before
 * Claude is asked, so if Claude fails the question is still there to ask again.
 */

import { answerHeadline, answerTextFrom, briefingBodyFrom, currentDoc, readDoc, renderAnswerPage, writeDoc } from './docs.ts';
import type { DocAccess } from './docs.ts';
import { SynologyError } from './synology.ts';
import type { DsmFetch } from './synology.ts';
import { ask, claudeConfigured, ClaudeRefused, unavailableReason } from './claude.ts';
import { fmt } from './money.ts';
import { offer } from './offers.ts';
import { card } from './plans.ts';
import type { CardView } from './plans.ts';
import { researchMay, ToolError } from './tools.ts';
import type { Tool, ToolContext } from './tools.ts';
import { CLAUDE, THREAD_TEXT_MAX, zoneOf } from './types.ts';
import type { BudgetId, Day, Event, EventId, EventOf, Offer, PlanId } from './types.ts';

const checked = (text: string): string => {
  const t = text.trim();
  if (!t) throw new ToolError('write something first');
  if (t.length > THREAD_TEXT_MAX) throw new ToolError('keep it under 2,000 characters');
  return t;
};

/** A note for the other members. Left on a plan's card, it carries the plan, and the plan must be there. */
export async function note(ctx: ToolContext, text: string, budget: BudgetId | null, plan?: PlanId): Promise<Event> {
  const t = checked(text);
  if (plan !== undefined) {
    const p = ctx.store.state.plans.get(plan);
    if (!p || p.removed) throw new ToolError(`no such plan: ${plan}`, 404);
  }
  const [e] = await ctx.store.append(ctx.who, { op: 'thread.note', text: t, budget, ...(plan !== undefined ? { plan } : {}) });
  return e!;
}

/**
 * The day's thread as Claude reads it: from the day's first briefing, the
 * events dayContext lists. A briefing another one took the place of is left
 * out, so the same section is not read twice.
 */
export function dayEvents(events: readonly Event[], budget: BudgetId | null, today: Day): Event[] {
  const mine = (b: BudgetId | null) => b === null || budget === null || b === budget;
  const start = events.findIndex((e) => e.op === 'thread.briefing' && e.day === today && mine(e.budget));
  const from = start < 0 ? events.findIndex((e) => e.at.slice(0, 10) >= today) : start;
  if (from < 0) return [];
  const replaced = new Set(events.flatMap((e) => (e.op === 'thread.briefing' && e.replaces ? [e.replaces] : [])));
  return events.slice(from).filter((e) =>
    e.op === 'thread.briefing' ? e.day === today && mine(e.budget) && !replaced.has(e.id)
      : e.op === 'thread.note' || e.op === 'thread.ask' ? mine(e.budget)
      : e.op === 'thread.answer');
}

/**
 * Bodies of the documents among them, read from Drive in parallel. An empty map
 * without a sid; a file that cannot be read is left out, so the thread can say
 * so, rather than this throwing.
 */
export async function readDayDocs(
  a: DocAccess, events: readonly Event[], budget: BudgetId | null, today: Day, f?: DsmFetch,
): Promise<Map<EventId, string>> {
  const bodies = new Map<EventId, string>();
  if (!a.sid) return bodies;
  await Promise.all(dayEvents(events, budget, today).map(async (e) => {
    if ((e.op !== 'thread.briefing' && e.op !== 'thread.answer') || !e.doc) return;
    try {
      const page = await readDoc(a, currentDoc(a.store.state, e.doc), f);
      bodies.set(e.id, e.op === 'thread.briefing' ? briefingBodyFrom(page) : answerTextFrom(page));
    } catch (err) {
      if (!(err instanceof ToolError || err instanceof SynologyError)) throw err;
    }
  }));
  return bodies;
}

const UNREAD = "Some of today's earlier texts could not be read from the NAS, only their headlines: "
  + 'if an answer leans on them, say so rather than guessing.';

/**
 * Today's thread so far, as Claude reads it before answering: the day's
 * briefing, then every note, question and answer since, oldest first. A
 * briefing or answer kept in Drive is read whole from `bodies`; one that was
 * not read gives its headline, and the last line says so.
 */
export function dayContext(
  events: readonly Event[], budget: BudgetId | null, today: Day, bodies: ReadonlyMap<EventId, string> = new Map(),
): string {
  let missed = false;
  const lines: string[] = [];
  for (const e of dayEvents(events, budget, today)) {
    const when = e.at.slice(11, 16);
    if (e.op === 'thread.briefing') {
      const body = e.doc ? bodies.get(e.id) : e.body;
      if (e.doc && body === undefined) {
        missed = true;
        lines.push(`[briefing] ${e.headline} (only the headline was read)`);
      } else {
        lines.push(`[briefing] ${e.headline}\n${body}`);
      }
    } else if (e.op === 'thread.note') {
      lines.push(`[${when}] ${e.who} left a note: "${e.text}"`);
    } else if (e.op === 'thread.ask') {
      lines.push(`[${when}] ${e.who} asked: "${e.question}"`);
    } else if (e.op === 'thread.answer') {
      const text = e.doc ? bodies.get(e.id) : e.text;
      if (e.doc && text === undefined) {
        missed = true;
        lines.push(`[${when}] you answered (only its headline was read): "${e.text}"`);
      } else {
        lines.push(`[${when}] you answered: "${text}"`);
      }
    }
  }
  if (!lines.length) return '';
  return `TODAY'S THREAD SO FAR\n\n${lines.join('\n\n')}${missed ? `\n\n${UNREAD}` : ''}`;
}

/**
 * A plan's card, as Claude reads it before researching it: what it is, what
 * has been written on it, and what it means for the money. The id is there so
 * that anything it suggests names the plan rather than guessing at it.
 */
export function planContext(c: CardView): string {
  const checklist = c.checklist.length
    ? `Checklist:\n${c.checklist.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n')}`
    : 'Checklist: none';
  let money: string;
  if (c.money) {
    const m = c.money;
    const months = m.monthsAtFunding === null ? ''
      : `, about ${m.monthsAtFunding} month${m.monthsAtFunding === 1 ? '' : 's'} of what it is funded at`;
    money = `Money: the ${m.label} envelope, ${m.left} left this month; `
      + (m.estimate === null ? 'no estimate yet' : `estimated at ${m.estimate}${months}`);
  } else if (c.envelope) {
    money = `Money: linked to ${c.envelope.envelope} in ${c.envelope.budget}, which has no open month to read`
      + (c.estimate === null ? '' : `; estimated at ${fmt(c.estimate)}`);
  } else {
    money = c.estimate === null ? 'Money: no envelope and no estimate' : `Money: estimated at ${fmt(c.estimate)}; no envelope linked`;
  }
  return [
    `PLAN: ${c.title} (${c.area}, ${c.state})`,
    `Notes: ${c.notes.trim() || 'none'}`,
    checklist,
    `Chips: ${c.chips.join(', ') || 'none'}`,
    money,
    `Its id is "${c.id}" and it is ${c.owner}'s. `
      + 'This question was asked from its card. Anything concrete you find for it (an item, a due date, '
      + 'a contact, a change to its notes) goes through the plan tools with that id, as a suggestion for '
      + 'them to approve. You may read the budget and say what a cost means for an envelope; do not move money.',
  ].join('\n');
}

export interface Asked {
  readonly question: EventOf<'thread.ask'>;
  readonly answer: EventOf<'thread.answer'> | null;
  readonly offers: Offer[];
  /** Why there is no answer, when there is none. */
  readonly error?: string;
}

/**
 * Research belongs to its card: a plan write Claude calls while researching a
 * plan is for that plan, whatever id it gave or left out. The plan the card is
 * for replaces `plan` in the args, before the tool runs and so before any
 * proposal or card exists; a differing id is replaced, not refused.
 */
const boundTo = (plan: PlanId) => (t: Tool, args: Record<string, unknown>): Record<string, unknown> =>
  t.kind === 'write' && 'plan' in (t.input['properties'] as object) ? { ...args, plan } : args;

/**
 * The day by name and the time where the household is: "Today is Thursday 29
 * October 2026; it is 20:14 in America/Denver." Asked for "Thursday" or "this
 * evening", Claude needs the weekday and the hour, and both in the
 * household's zone, which is the one its calendars and due dates are in.
 */
export function nowContext(today: Day, tz: string, now = new Date()): string {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(`${today}T12:00:00Z`)).replace(',', '');
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return `Today is ${day}; it is ${time} in ${tz}.`;
}

/**
 * Ask Claude in the thread. Asked from a plan's card, Claude reads the card
 * first, and the question, the answer and every card the answer raises carry
 * the plan, so the plan's card can show what came back.
 */
export async function askInThread(ctx: ToolContext, question: string, budget: BudgetId | null, plan?: PlanId): Promise<Asked> {
  const q = checked(question);
  if (!claudeConfigured()) throw new ToolError('Claude is not set up on this server', 503);
  // Read before anything is written, so a plan that is not there leaves no question behind.
  const facing = plan
    ? planContext(card(ctx.store.state, await ctx.store.since(null), plan, { who: ctx.who, today: ctx.today }))
    : '';
  const onPlan = plan ? { plan } : {};

  const [asked] = await ctx.store.append(ctx.who, { op: 'thread.ask', question: q, budget, ...onPlan });
  const events = await ctx.store.since(null);
  const day = dayContext(events, budget, ctx.today, await readDayDocs(ctx, events, budget, ctx.today));
  const context = (facing ? `${facing}\n\n` : '')
    + `${nowContext(ctx.today, zoneOf(ctx.store.state))} You are speaking to ${ctx.who}. `
    + (budget ? `The budget in view is ${budget}. ` : '')
    + 'Call tools for every figure you state. Notes are between the members: read them, never answer them.'
    + (day ? `\n\n${day}` : '');

  let result;
  try {
    // Research reads the budget but never moves money, so it is not handed the tools that would.
    result = await ask(q, ctx, { context, ...(plan ? { tools: researchMay, bind: boundTo(plan) } : {}) });
  } catch (err) {
    if (err instanceof ClaudeRefused) throw err;
    return { question: asked as EventOf<'thread.ask'>, answer: null, offers: [], error: unavailableReason(err) };
  }

  // The page first, then the log: the log says where the answer is only once it is there. With no
  // page (no session, no household, Drive refused) the log keeps the whole answer.
  const doc = await writeDoc(ctx, ['answers', `${asked!.id}.md`], renderAnswerPage({
    replyTo: asked!.id, plan: plan ?? null, model: result.model, question: q, text: result.text,
    tools: result.calls.map((c) => c.name),
  }));
  const [answer] = await ctx.store.append(CLAUDE, {
    op: 'thread.answer', replyTo: asked!.id, ...onPlan,
    text: doc ? answerHeadline(result.text) : result.text, ...(doc ? { doc } : {}), model: result.model,
    tools: result.calls.map((c) => ({ name: c.name, args: c.args })),
  });
  const prompt = { kind: plan ? 'research' as const : 'answer' as const, ref: answer!.id };
  const offers: Offer[] = [];
  for (const c of result.calls) {
    if (c.kind !== 'write') continue;
    try {
      offers.push(await offer(ctx, { tool: c.name, args: c.args, prompt, ...onPlan }));
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
    }
  }
  return { question: asked as EventOf<'thread.ask'>, answer: answer as EventOf<'thread.answer'>, offers };
}
