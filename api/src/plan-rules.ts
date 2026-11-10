/**
 * The rules a plan edit meets before it is written, in one place.
 *
 * A member's routes (plan-edits.ts) and Claude's plan tools (tools.ts) both
 * read what they were handed through these, so the same request gets the same
 * answer, in the same words and with the same status, from either door. The
 * fold (replay.ts) has the last word on all of it and checks the shapes again,
 * for the writers that come through neither door: a restore, a hand-edited line.
 */

import { randomUUID } from 'node:crypto';

import { ToolError } from './errors.ts';
import { cents } from './money.ts';
import type { Cents } from './money.ts';
import { slug } from './types.ts';
import type { BudgetId, ChecklistItem, ContactLink, Day, EnvelopeId, PageView, Plan, PlanState, State } from './types.ts';

export const PLAN_STATES: readonly PlanState[] = ['planning', 'doing', 'done'];
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** How long each piece of a card may be. The fold refuses longer, whoever wrote it. */
export const PLAN_LIMITS = { title: 200, chip: 40, item: 500, notes: 20_000, goal: 60, why: 300 } as const;

/** Text that must be there: trimmed, and refused when blank. */
export const required = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`${name} is required`);
  return v.trim();
};

const capped = (v: string, max: number, name: string): string => {
  if (v.length > max) throw new ToolError(`${name} is longer than ${max.toLocaleString('en-US')} characters`);
  return v;
};

const whole = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolError(`${name} must be a whole number`);
  return v;
};

/** A plan that exists and has not been removed; a 404 otherwise. A removed plan is history, not a draft. */
export function livePlan(state: State, id: unknown): Plan {
  if (typeof id !== 'string' || !id) throw new ToolError('plan is required');
  const p = state.plans.get(id);
  if (!p || p.removed) throw new ToolError(`no such plan: ${id}`, 404);
  return p;
}

/**
 * What a plan's page shows: the fields its frontmatter and body are written
 * from, in a fixed order, so two views compare as text. A removed plan's page
 * says so in its state.
 */
export function pageView(p: Plan): PageView {
  return {
    id: p.id, title: p.title, area: p.area, state: p.removed ? 'removed' : p.state,
    parent: p.parent, due: p.due, people: p.contacts.map((c) => `contacts:${c.contact_id}`),
    envelope: p.envelope?.envelope ?? null, estimate: p.estimate, notes: p.notes,
    checklist: p.checklist.map((i) => ({ text: i.text, done: i.done })),
    files: p.attachments.map((a) => a.name),
  };
}

export const liveChildren = (state: State, id: string): Plan[] =>
  [...state.plans.values()].filter((c) => c.parent === id && !c.removed);

/** A fresh id that still says what it is in the raw log. */
/**
 * A plan's dates that are not on the calendar: its due date, or a block,
 * with no event linked to it. Set by someone signed in without a NAS
 * session, it is kept on the plan; the next look at the calendar by someone
 * with one puts it there. Read from the log, so it is the same on every
 * screen, for every member, after any restart.
 */
export function notOnCalendar(p: Plan): { due: boolean; blocks: string[] } {
  return {
    due: p.due !== null && !p.links.some((l) => l.kind === 'due'),
    blocks: p.blocks.filter((b) => !p.links.some((l) => l.kind === 'block' && l.block === b.id)).map((b) => b.id),
  };
}

/**
 * The dates a look at the calendar puts there unasked: those not on it, less
 * any a member let go when its event was deleted ("Leave both"). Those stay
 * off until set again, or put there from the card.
 */
export function toPlace(p: Plan): { due: boolean; blocks: string[] } {
  const off = notOnCalendar(p);
  return { due: off.due && !p.letGo.includes('due'), blocks: off.blocks.filter((b) => !p.letGo.includes(b)) };
}

export const newPlanId = (title: string): string => `${slug(title) || 'plan'}-${randomUUID().slice(0, 6)}`;
export const newItemId = (): string => `item-${randomUUID().slice(0, 8)}`;
export const newBlockId = (): string => `block-${randomUUID().slice(0, 8)}`;

export const planTitle = (v: unknown): string => capped(required(v, 'title'), PLAN_LIMITS.title, 'a title');

export function knownArea(state: State, v: unknown): string {
  const area = required(v, 'area');
  if (!state.settings.areas.includes(area)) {
    throw new ToolError(`"${area}" is not one of this household's areas: ${state.settings.areas.join(', ')}`);
  }
  return area;
}

/**
 * The shelf a new plan goes on, or null. Left out, null or empty is no shelf;
 * anything else must be a live plan that is not itself on a shelf, in the
 * area the new plan is in.
 */
export function shelfFor(state: State, parent: unknown, area: string): Plan | null {
  if (parent === undefined || parent === null || parent === '') return null;
  if (typeof parent !== 'string') throw new ToolError('parent must be a plan id');
  const shelf = livePlan(state, parent);
  if (shelf.parent !== null) throw new ToolError('plans go two levels deep, no more: a plan can hold items; an item cannot');
  if (shelf.area !== area) throw new ToolError(`an item lives in its shelf's area: ${shelf.title} is in ${shelf.area}`);
  return shelf;
}

/** The whole set of chips: each trimmed, blanks dropped. */
export function planChips(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((c) => typeof c === 'string')) throw new ToolError('chips must be a list of words');
  return (v as string[]).map((c) => c.trim()).filter(Boolean).map((c) => capped(c, PLAN_LIMITS.chip, 'a chip'));
}

export function planNotes(v: unknown): string {
  if (typeof v !== 'string') throw new ToolError('notes must be text');
  return capped(v, PLAN_LIMITS.notes, 'the notes');
}

/** Whole cents, or null to clear it. A string is refused, never read as a number. */
export function planEstimate(v: unknown): Cents | null {
  if (v === null) return null;
  const n = whole(v, 'the estimate, in cents,');
  if (n < 0) throw new ToolError('an estimate cannot be negative');
  return cents(n);
}

/** The envelope a plan is paid from, which must exist; null unlinks it. */
export function envelopeRef(state: State, v: unknown): { budget: BudgetId; envelope: EnvelopeId } | null {
  if (v === null) return null;
  const o = (typeof v === 'object' && v ? v : {}) as Record<string, unknown>;
  const budget = required(o['budget'], 'envelope.budget');
  const envelope = required(o['envelope'], 'envelope.envelope');
  const b = state.budgets.get(budget);
  if (!b) throw new ToolError(`no budget ${budget}`, 404);
  if (!b.envelopes.has(envelope)) throw new ToolError(`no envelope ${envelope} in ${b.label}`, 404);
  return { budget, envelope };
}

export function planState(v: unknown): PlanState {
  if (!PLAN_STATES.includes(v as PlanState)) throw new ToolError(`state must be one of ${PLAN_STATES.join(', ')}`);
  return v as PlanState;
}

/** The whole list. An item with no id is new and is given one; each id appears once. */
export function planChecklist(v: unknown): ChecklistItem[] {
  if (!Array.isArray(v)) throw new ToolError('items must be a list');
  const list = v.map((raw): ChecklistItem => {
    const i = (typeof raw === 'object' && raw ? raw : {}) as Record<string, unknown>;
    if (i['id'] !== undefined && (typeof i['id'] !== 'string' || !i['id'])) throw new ToolError('an item\'s id must be text');
    if (i['done'] !== undefined && typeof i['done'] !== 'boolean') throw new ToolError('done must be true or false');
    return {
      id: (i['id'] as string | undefined) ?? newItemId(),
      text: capped(required(i['text'], 'each item\'s text'), PLAN_LIMITS.item, 'an item'),
      done: i['done'] === true,
    };
  });
  if (new Set(list.map((i) => i.id)).size !== list.length) throw new ToolError('each item appears once');
  return list;
}

/** A calendar day, or null to clear it. */
export function planDue(v: unknown): Day | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !DAY_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ToolError('due must be a date as YYYY-MM-DD, or null to clear it');
  }
  return v;
}

/** A stretch of time: two instants, the second after the first. */
export function blockTimes(start: unknown, end: unknown): { start: string; end: string } {
  if (typeof start !== 'string' || typeof end !== 'string'
      || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
    throw new ToolError('start and end must be ISO 8601 dates and times');
  }
  if (!(Date.parse(end) > Date.parse(start))) throw new ToolError('a block must end after it starts');
  return { start, end };
}

/** A person from the address book, by the ids Contacts gave them. */
export function contactLink(v: unknown): ContactLink {
  const o = (typeof v === 'object' && v ? v : {}) as Record<string, unknown>;
  return {
    contact_id: whole(o['contact_id'], 'contact_id'),
    addressbook_id: whole(o['addressbook_id'], 'addressbook_id'),
    display: required(o['display'], 'display'),
  };
}
