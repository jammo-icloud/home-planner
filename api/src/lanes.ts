/**
 * Which lane of the household an entry belongs to.
 *
 * Every op that can show on Today has one; the rest are bookkeeping (a read
 * cursor, a prediction, a plan's page) and have none. `laneOf` is exhaustive
 * with no default, the shape of `scopeOf` in restore.ts, so a new op without a
 * case fails the typecheck. Cards take their lane from the tool that raised
 * them.
 */

import type { Event, NewEventShape, Offer, State } from './types.ts';

export type Lane = 'budget' | 'calendar' | 'plans' | 'claude' | 'notes';

export const LANES: readonly Lane[] = ['budget', 'calendar', 'plans', 'claude', 'notes'];

export const isLane = (v: unknown): v is Lane => typeof v === 'string' && (LANES as readonly string[]).includes(v);

export function laneOf(e: Event | NewEventShape, state: Pick<State, 'pageDrifts'>): Lane | null {
  switch (e.op) {
    case 'assign': case 'move': case 'income.set': case 'month.open': case 'month.close': case 'month.discard':
    case 'txn.add': case 'txn.categorize': case 'txn.split': case 'txn.remove': case 'rule.add': case 'rule.remove':
    case 'envelope.define': case 'envelope.remove': case 'envelopes.model':
    case 'budget.create': case 'budget.rename': case 'budget.locate': case 'budget.archive':
    case 'category.define': case 'category.archive': case 'category.sinking':
    case 'income.source.define': case 'income.source.remove':
    case 'account.balance': case 'savings.account':
      return 'budget';
    case 'calendar.appointment': case 'calendar.appointment.remove': case 'calendar.appointment.change':
    case 'calendar.household': case 'calendar.household.rename': case 'calendar.target':
    case 'guest.allow': case 'guest.revoke': case 'guests.arrival': case 'guests.booking':
    case 'booking.block': case 'booking.unblock': case 'booking.confirm': case 'booking.cancel':
    case 'booking.suggest': case 'booking.release':
      return 'calendar';
    case 'plan.create': case 'plan.state': case 'plan.remove': case 'plan.due': case 'plan.block': case 'plan.unblock':
    case 'plan.attach': case 'plan.detach': case 'plan.hand':
    case 'areas.set': case 'areas.rename': case 'areas.add': case 'areas.remove':
    case 'goal.rename': case 'goal.remove':
      return 'plans';
    case 'calendar.drift.resolve':
      return state.pageDrifts.has(e.drift) ? 'plans' : 'calendar';
    case 'thread.briefing': case 'thread.ask':
      return 'claude';
    case 'household.claim': case 'member.add': case 'member.remove': case 'household.zone':
    case 'links.set': case 'documents.folder': case 'thread.note':
      return 'notes';
    case 'briefing.read': case 'prediction.record': case 'flag.seen': case 'scheme.set': case 'calendar.conflicts':
    case 'plan.doc': case 'documents.moved': case 'thread.answer': case 'proposal.offer': case 'proposal.decide':
    case 'plan.set': case 'plan.checklist': case 'plan.contact.link': case 'plan.contact.unlink':
    case 'plan.calendar.link': case 'plan.calendar.unlink': case 'plan.calendar.etag':
    case 'plan.page.drift': case 'calendar.drift': case 'plan.ask': case 'plan.ask.accept': case 'plan.ask.decline':
    case 'plan.goal': case 'areas.move': case 'shelves.retire':
      return null;
  }
}

/** The lane of every tool that writes. A test holds this to the tool table. */
export const TOOL_LANES: Readonly<Record<string, Lane>> = {
  create_plan: 'plans', update_plan: 'plans', set_plan_state: 'plans', set_checklist: 'plans', set_plan_due: 'plans',
  block_plan_time: 'plans', remove_plan: 'plans', hand_plan: 'plans', set_plan_goal: 'plans', ask_to_take: 'plans',
  answer_ask: 'plans', link_contact: 'plans', create_contact: 'plans',
  propose_event: 'calendar', approve_booking: 'calendar', release_stay: 'calendar', resolve_drift: 'calendar',
  move_money: 'budget', set_assignment: 'budget', set_envelope_figure: 'budget', set_month_income: 'budget',
  set_sinking_goal: 'budget', categorize_transactions: 'budget', restore_transaction: 'budget',
  open_month: 'budget', close_month: 'budget', discard_month: 'budget', create_budget: 'budget',
  rename_budget: 'budget', archive_budget: 'budget', set_budget_location: 'budget', seed_from_location: 'budget',
  define_envelope: 'budget', remove_envelope: 'budget', add_starter_set: 'budget', make_starter_envelopes: 'budget',
  define_category: 'budget', archive_category: 'budget', define_income_source: 'budget',
  remove_income_source: 'budget', savings_short: 'budget', set_bill: 'budget',
};

/** The lane a card is drawn in: its drift's, else its tool's, else its first event's, else the money. */
export function cardLane(o: Pick<Offer, 'tool' | 'events' | 'prompt'>, state: Pick<State, 'pageDrifts'>): Lane {
  if (o.tool === 'resolve_drift' && o.prompt.ref !== null && state.pageDrifts.has(o.prompt.ref)) return 'plans';
  return TOOL_LANES[o.tool] ?? (o.events[0] ? laneOf(o.events[0], state) : null) ?? 'budget';
}
