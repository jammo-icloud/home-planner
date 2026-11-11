/**
 * Cards: suggestions put in front of the household and kept until decided.
 *
 * A card is a write tool's proposal, recorded in the log with the tool and its
 * arguments. Three rules make that safe to leave lying around for days:
 *
 *   One card per decision. A new card touching the same envelope in the same
 *   month replaces the one still waiting, so the same money can never be moved
 *   twice by approving yesterday's suggestion and today's.
 *
 *   A card remembers the figures it was based on. If they have moved, it cannot
 *   be approved as it stands — it has to be worked out again first, so a stale
 *   amount is never applied in one click.
 *
 *   Approval writes the decision and its effect together, in one append, by the
 *   person who clicked. The replay refuses a second decision on the same card.
 */

import { raiseDriftCards } from './drift.ts';
import { monthView } from './envelopes.ts';
import { RETIRED } from './plan-rules.ts';
import { ReplayError } from './replay.ts';
import { toSort } from './analytics.ts';
import { savingsCheck } from './sinking.ts';
import {
  ProposalStore, ToolError, appendAfterEffect, inOrder, oneEffectAtATime, recordedArgs, runEffect, toolByName, touches,
} from './tools.ts';
import type { Proposal, Tool, ToolContext } from './tools.ts';
import { CLAUDE, visibleTo } from './types.ts';
import type { Actor, EnvelopeId, Event, EventId, Month, NewEventShape, Offer, OfferPrompt, PlanId, State } from './types.ts';

/**
 * The figures a card was based on: what is left to assign, and where each
 * envelope it names stands. Any change to these and the card's amounts may no
 * longer be right.
 */
export function fingerprint(state: State, month: Month | null, envelopes: readonly EnvelopeId[]): string {
  if (!month) return '';
  const view = monthView(state, month);
  if (!view) return '';
  const rows = [...envelopes].sort().map((id) => {
    const e = view.envelopes.find((x) => x.envelope.id === id);
    return e ? [id, e.available, e.activity] : [id, null, null];
  });
  return JSON.stringify([view.toAssign, ...rows]);
}

/** Put a write tool's proposal in front of the household as a card. `plan` marks one raised by research on that plan. */
export async function offer(ctx: ToolContext, o: {
  tool: string; args: Record<string, unknown>; prompt: OfferPrompt; by?: Actor; replaces?: EventId; plan?: PlanId;
  /** The args of the card this works out again or adjusts: what was stamped on it stays. */
  from?: Record<string, unknown>;
}): Promise<Offer> {
  const tool = toolByName.get(o.tool);
  if (!tool) throw new ToolError(`no tool named ${o.tool}`, 404);
  if (tool.kind !== 'write') throw new ToolError(`${o.tool} answers a question; there is nothing to approve`);

  // A private proposal store: the card is the record, and the in-memory one
  // would only expire it.
  const args = recordedArgs(tool, o.args, ctx, o.from);
  const p = await tool.run(args, { ...ctx, proposals: new ProposalStore() }) as Proposal;
  const state = ctx.store.state;
  const t = touches(p.events);

  const replaces = o.replaces ?? (t.month && t.envelopes.length
    ? [...state.thread.offers.values()].find((x) =>
        (x.status === 'open' || x.status === 'snoozed')
        && x.month === t.month
        && x.envelopes.some((env) => t.envelopes.includes(env)))?.id
    : undefined);

  const [e] = await ctx.store.append(o.by ?? CLAUDE, {
    op: 'proposal.offer', tool: o.tool, args, summary: p.summary, effects: p.effects,
    events: p.events as NewEventShape[], month: t.month, envelopes: t.envelopes,
    fingerprint: fingerprint(state, t.month, t.envelopes), prompt: o.prompt,
    ...(replaces ? { replaces } : {}),
    ...(o.plan ? { plan: o.plan } : {}),
  });
  return ctx.store.state.thread.offers.get(e!.id)!;
}

/**
 * A balance just recorded for the savings account that comes up short of the
 * sinking envelopes is a card on Today, from whoever recorded it: one per
 * balance, since the fold retires the last balance's card when a newer one is
 * recorded.
 */
export async function raiseSavingsCard(ctx: ToolContext, written: readonly Event[]): Promise<Offer | null> {
  const state = ctx.store.state;
  const account = state.savings.account;
  const latest = account ? state.savings.balances.get(account) : undefined;
  if (!latest || !written.some((e) => e.id === latest.event)) return null;
  if (savingsCheck(state, ctx.today)?.status !== 'short') return null;
  if ([...state.thread.offers.values()].some((o) => o.prompt.kind === 'savings' && o.prompt.ref === latest.event)) return null;
  return offer(ctx, { tool: 'savings_short', args: { account }, prompt: { kind: 'savings', ref: latest.event }, by: latest.who });
}

/**
 * What a card from before 0.7.0 would still do that nothing does now: ask a
 * member to take a plan (the `ask_to_take` tool, or any `plan.ask` line), or
 * put a plan on a shelf (a `parent`). Such a card can only be declined. An
 * `answer_ask` card is not closed: an ask already made is still answered.
 */
export function closedCard(o: Offer): string | null {
  if (o.tool === 'ask_to_take' || o.events.some((e) => e.op === 'plan.ask')) return RETIRED.ask;
  if (o.events.some((e) => 'parent' in e && e.parent !== undefined)) return RETIRED.shelf;
  return null;
}

/** The card as it can still be worked on: a closed one is refused as a conflict, in its own words. */
const open = (o: Offer): Offer => {
  const closed = closedCard(o);
  if (closed) throw new ToolError(closed, 409);
  return o;
};

const live = (state: State, id: EventId): Offer => {
  const o = state.thread.offers.get(id);
  if (!o) throw new ToolError('there is no such suggestion', 404);
  if (o.status !== 'open' && o.status !== 'snoozed') throw new ToolError('that suggestion was already decided', 409);
  return o;
};

/** True once any figure the card was based on has changed. */
export const moved = (state: State, o: Offer): boolean =>
  fingerprint(state, o.month, o.envelopes) !== o.fingerprint;

/** True once a put-off card's figures differ from when it was put off. */
export const stirred = (state: State, o: Offer): boolean =>
  fingerprint(state, o.month, o.envelopes) !== (o.snoozedAt ?? o.fingerprint);

/**
 * The card's arguments with what the member chose as they approved it. Only
 * what the tool names in `chosenOnApproval`, and only one of its values: the
 * rest of a card is what was shown, and is never changed at approval.
 */
function chosenArgs(tool: Tool | undefined, o: Offer, chosen: unknown): Record<string, unknown> {
  if (chosen === undefined) return o.args;
  if (typeof chosen !== 'object' || chosen === null || Array.isArray(chosen)) {
    throw new ToolError('args, when given, are what was chosen on approving it');
  }
  const may = tool?.chosenOnApproval ?? {};
  for (const [k, v] of Object.entries(chosen)) {
    const values = may[k];
    if (!values) throw new ToolError(`${k} cannot be chosen on approving this`);
    if (typeof v !== 'string' || !values.includes(v)) throw new ToolError(`${k} is one of ${values.join(', ')}`);
  }
  return { ...o.args, ...chosen };
}

/**
 * Approve, decline or put off a card.
 *
 * An approval carries the approver's reason into the events it appends, so the
 * move says why in the words of the person who made it, not the assistant's.
 * `chosen` is what the member picked on a card with more than one way to say
 * yes (a drift's three choices); its effect runs with it.
 */
export async function decide(ctx: ToolContext, offerId: EventId,
                             decision: 'approved' | 'declined' | 'snoozed', why?: string,
                             chosen?: Record<string, unknown>): Promise<Event[]> {
  const state = ctx.store.state;
  const o = live(state, offerId);
  const tool = toolByName.get(o.tool);
  const args = chosenArgs(tool, o, chosen);
  // A drift is settled by one of its three choices; leaving both is its no.
  // Declined or put off, the question would stay open with nothing asking it.
  if (o.prompt.kind === 'drift' && decision !== 'approved') {
    throw new ToolError('a change on the calendar is settled by choosing: move the plan too, put the calendar back, or leave both');
  }
  const reason = why?.trim();
  // A friend's request turned down is told why, in the member's words.
  if (o.tool === 'approve_booking' && decision === 'declined' && !reason) {
    throw new ToolError('declining needs a reason: the guest is told it');
  }
  const choice = {
    op: 'proposal.decide' as const, proposal: o.id, decision, ...(reason ? { why: reason } : {}),
    ...(decision === 'snoozed' ? { fingerprint: fingerprint(state, o.month, o.envelopes) } : {}),
  };
  // An ask to take a plan is answered, by the member asked: declining it
  // declines the ask, with the reason the asker reads. Anyone else's decision
  // on it goes to the fold, which refuses it in its own words.
  if (o.prompt.kind === 'ask' && decision === 'declined'
      && state.plans.get(String(o.args['plan']))?.asked?.to === ctx.who) {
    if (!reason) throw new ToolError('declining needs a reason: the person who asked reads it');
    return refusedAs409(ctx.store.append(ctx.who,
      [choice, { op: 'plan.ask.decline', plan: String(o.args['plan']), why: reason }]));
  }
  // A decline the tool must carry outside first (a guest mailed the reason):
  // that goes before the line, and if it fails the card stays open. A
  // decline that could not be told is not a decline.
  if (decision === 'declined' && tool?.onDecline) {
    // The hook says a mail refusal in its own words (a 502 naming the reply).
    const onDecline = tool.onDecline.bind(tool);
    return oneAtATime(ctx, o.id, async () => {
      await onDecline(args, ctx, reason);
      return refusedAs409(ctx.store.append(ctx.who, choice));
    });
  }
  // A card that would ask or shelve can only be declined: not put off, not approved.
  if (decision !== 'declined') open(o);
  if (decision !== 'approved') return refusedAs409(ctx.store.append(ctx.who, choice));

  if (moved(state, o)) throw new ToolError('the numbers have moved since this was suggested', 409);

  const events = o.events.map((e) => (reason && 'why' in e ? { ...e, why: reason } : e)) as NewEventShape[];
  let written: Event[];
  if (!tool?.effect) {
    written = await refusedAs409(ctx.store.append(ctx.who, [choice, ...events]));
  } else {
    written = await oneAtATime(ctx, o.id, async () => {
      // The outside work comes first: if it fails the card stays open and nothing is written.
      // One at a time per plan, so its effect reads the plan as the last change left it.
      return oneEffectAtATime(ctx, args, o.id, async () => {
        const extra = await runEffect(tool, args, ctx, events, o.id);
        const done = await appendAfterEffect(tool, args, ctx, extra,
          () => refusedAs409(ctx.store.append(ctx.who, [choice, ...inOrder(tool, events, extra)])));
        // Written: what had to wait for that happens now, and a failure of it is the answer.
        await tool.afterWrite?.(args, ctx, extra);
        return done;
      });
    });
  }
  // A drift its effect found (a date set on an event moved since) has its card raised.
  await raiseDriftCards(ctx, written);
  return written;
}

/** Cards with an effect in progress, keyed by store and offer id. In memory: an effect does not outlive the process. */
const deciding = new Set<string>();

/**
 * A card whose outside work (an effect, a decline's mail) is already under
 * way for someone else is not started again: the second person is told at
 * once, before anything is called. Released however the work ends. A guest
 * withdrawing their request takes the same turn (booking.ts, cancelStay), so
 * a request is never withdrawn while its approval's mail is going out.
 */
export async function oneAtATime<T>(ctx: { store: { readonly path: string } }, id: EventId, work: () => Promise<T>,
                                    busy = 'that card is being decided'): Promise<T> {
  const key = `${ctx.store.path}|${id}`;
  if (deciding.has(key)) throw new ToolError(busy, 409);
  deciding.add(key);
  try {
    return await work();
  } finally {
    deciding.delete(key);
  }
}

/**
 * The fold has the last word: two people approving at once both pass the
 * checks above, and the second append is refused there. That is a conflict
 * someone can act on, not a fault, so it is answered as one.
 */
async function refusedAs409<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (err) {
    if (err instanceof ReplayError) throw new ToolError(err.message.replace(/ \(event .*\)$/, ''), 409);
    throw err;
  }
}

/**
 * A friend's request is answered as it was asked: approved, declined, or met
 * with other dates. It has no figures to work out again, and a member's own
 * version of it would be a request nobody made.
 */
const asAsked = (o: Offer): void => {
  if (o.prompt.kind === 'booking') {
    throw new ToolError("a guest's request is answered as asked: approve it, decline it, or suggest other dates");
  }
};

/** Work a card out again from where things stand now. It replaces the old one. */
export async function refresh(ctx: ToolContext, offerId: EventId): Promise<Offer> {
  const o = open(live(ctx.store.state, offerId));
  asAsked(o);
  return offer(ctx, { tool: o.tool, args: o.args, prompt: o.prompt, by: o.who, replaces: o.id, from: o.args,
    ...(o.plan ? { plan: o.plan } : {}) });
}

/** A member's own version of a card: same tool, their changes. It replaces the original. */
export async function adjust(ctx: ToolContext, offerId: EventId, args: Record<string, unknown>): Promise<Offer> {
  const o = open(live(ctx.store.state, offerId));
  if (o.prompt.kind === 'drift') throw new ToolError('a change on the calendar is settled by choosing, not adjusted');
  asAsked(o);
  return offer(ctx, {
    tool: o.tool, args: { ...o.args, ...args }, prompt: { kind: 'member', ref: o.id },
    by: ctx.who, replaces: o.id, from: o.args, ...(o.plan ? { plan: o.plan } : {}),
  });
}

export type Waiting =
  | { kind: 'offer'; offer: Offer; moved: boolean }
  | { kind: 'flag'; event: EventId }
  | { kind: 'tosort'; count: number };

/**
 * What is waiting on this person.
 *
 * Open cards (an ask only for the member asked), and put-off ones whose numbers have since moved; removed receipts
 * someone else took out that this person has not looked at; and the receipts no
 * envelope has yet, as a single item. A card whose month has closed has nothing
 * left to act on, so it stops waiting.
 */
export function waiting(state: State, who: Actor, events: readonly Event[]): Waiting[] {
  const out: Waiting[] = [];
  for (const o of state.thread.offers.values()) {
    if (o.status !== 'open' && o.status !== 'snoozed') continue;
    // One for someone else's own calendar is theirs alone, and never waits on anyone else.
    if (!visibleTo(o, who)) continue;
    // An ask waits on the member asked, and on nobody else: the asker is waiting on them.
    if (o.prompt.kind === 'ask' && state.plans.get(String(o.args['plan']))?.asked?.to !== who) continue;
    if (o.month && state.months.get(o.month)?.closed) continue;
    const m = moved(state, o);
    // Put off: it waits again once the figures differ from when it was put off.
    if (o.status === 'snoozed' && !stirred(state, o)) continue;
    out.push({ kind: 'offer', offer: o, moved: m });
  }
  const seen = state.thread.seen.get(who);
  // Removals from before there was a thread are history: an upgraded log opens
  // quiet rather than with years of old deletions waiting on someone.
  const since = events.findIndex((e) => e.op.startsWith('thread.') || e.op.startsWith('proposal.'));
  for (const e of since < 0 ? [] : events.slice(since)) {
    if (e.op !== 'txn.remove' || e.who === who || seen?.has(e.id)) continue;
    if (state.txns.has(e.txn)) continue; // put back since
    out.push({ kind: 'flag', event: e.id });
  }
  const u = toSort(state);
  if (u.count) out.push({ kind: 'tosort', count: u.count });
  return out;
}
