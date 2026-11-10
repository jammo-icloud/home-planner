/**
 * What the two of you did directly, one line per decision.
 *
 * This is not a log viewer. A log viewer answers "what happened"; the question
 * that matters in a shared budget is "did my partner decide something I should
 * know about". So a removal carries enough detail to act on without going
 * looking for the transaction, and the thread flags it for the other person.
 */

import { describe } from './tools.ts';
import { fmtExact } from './money.ts';
import { isSpend } from './types.ts';
import type { Actor, Event, State, Txn } from './types.ts';
import type { Store } from './store.ts';

export interface Removed {
  readonly txnId: string;
  readonly date: string;
  readonly payee: string;
  readonly amount: string;
  readonly category: string | null;
  /** False when the receipt is back in the ledger, so review can be closed. */
  readonly stillGone: boolean;
}

/**
 * Ops that are not a change anyone made to the money: the app's own
 * bookkeeping, and the conversation, which the thread shows in its own shape.
 */
const NOT_A_CHANGE = new Set<string>(['briefing.read', 'prediction.record',
  'thread.briefing', 'thread.ask', 'thread.note', 'thread.answer',
  'proposal.offer', 'proposal.decide', 'flag.seen',
  // One member's own preferences: how the app looks to them, and which of
  // their calendars are checked. Not something the household decided.
  'scheme.set', 'calendar.conflicts',
  // Where an area stands in the list: an order, not a decision about the household.
  'areas.move',
  // The app keeping a plan's page in Drive written: the change was the plan's.
  'plan.doc',
  // A file carried to the household's new folder: the change was the choice of folder.
  'documents.moved']);

/** True for a change someone made directly, as opposed to bookkeeping or conversation. */
export const isChange = (e: Event): boolean => !NOT_A_CHANGE.has(e.op);

/** Decisions that hide money are never collapsed — each one is its own choice. */
const REVIEWABLE = new Set(['txn.remove']);

/**
 * Consecutive events collapse into one line when they say the same thing.
 *
 * Never for a removal: four deletions are four separate judgements about four
 * different receipts, and folding them into one line showed a single receipt as
 * if it stood for all of them.
 */
const sameAction = (a: Event, b: Event): boolean =>
  !REVIEWABLE.has(a.op)
  && a.op === b.op && a.who === b.who && a.at === b.at
  && (a as { why?: string }).why === (b as { why?: string }).why;

export interface Change {
  readonly id: string;
  readonly at: string;
  readonly who: Actor;
  readonly what: string;
  readonly why: string | null;
  readonly count: number;
  /** The events this line stands for, first to last. */
  readonly events: readonly Event[];
  /** Set on a removal: what it took out, so nobody has to go looking. */
  readonly removed?: Removed;
}

/**
 * Every change anyone made directly, one line per decision, oldest first.
 *
 * A bulk sort writes one event per receipt. Thirty-three lines saying the same
 * thing is not thirty-three decisions, and reads as noise that trains people
 * to skim the one line that mattered.
 */
export function changes(all: readonly Event[], state: State): Change[] {
  const meaningful = all.filter(isChange);
  const out: Change[] = [];
  for (let i = 0; i < meaningful.length; i++) {
    const e = meaningful[i]!;
    const group = [e];
    while (i + 1 < meaningful.length && sameAction(e, meaningful[i + 1]!)) group.push(meaningful[++i]!);
    const d = describe(e, state);
    const removed = e.op === 'txn.remove' ? findRemoved(meaningful, e.txn, state) : undefined;
    out.push({
      id: e.id, at: e.at, who: e.who,
      what: group.length > 1 ? `${d.what} (${group.length} times)` : d.what,
      why: d.why, count: group.length, events: group,
      ...(removed ? { removed } : {}),
    });
  }
  return out;
}

/**
 * Find the receipt a removal removed.
 *
 * The log still holds it — that is the point of never rewriting. Scanning back
 * for the `txn.add` that introduced it costs a pass over the file and saves the
 * other person going to look for something that is no longer there.
 */
function findRemoved(events: readonly Event[], txnId: string, state: State): Removed | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.op !== 'txn.add') continue;
    const t = e.txns.find((x: Txn) => x.id === txnId);
    if (!t) continue;
    return {
      txnId,
      date: t.date,
      payee: t.payee,
      amount: fmtExact(t.amount),
      category: t.category !== null && isSpend(t.category) ? t.category : null,
      stillGone: !state.txns.has(txnId),
    };
  }
  return undefined;
}

/**
 * The receipt a removal took out, ready to be put back.
 *
 * Exported so the restore path and the activity list agree on what was removed
 * rather than each reconstructing it their own way.
 */
export async function removedTxn(store: Store, txnId: string): Promise<Txn | undefined> {
  const all = await store.since(null);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]!;
    if (e.op !== 'txn.add') continue;
    const t = e.txns.find((x: Txn) => x.id === txnId);
    if (t) return t;
  }
  return undefined;
}
