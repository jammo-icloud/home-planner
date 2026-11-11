/**
 * What the members did directly, one line per decision.
 *
 * This is not a log viewer. A log viewer answers "what happened"; the question
 * that matters in a shared budget is "did a member decide something I should
 * know about". So a removal carries enough detail to act on without going
 * looking for the transaction, and the thread flags it for the others.
 */

import { describe } from './tools.ts';
import type { EnvelopeBefore } from './tools.ts';
import { fmtExact } from './money.ts';
import { isSpend } from './types.ts';
import type { Actor, Event, State, Txn } from './types.ts';
import type { Store } from './store.ts';

export interface Removed {
  readonly txnId: string;
  readonly date: string;
  readonly payee: string;
  readonly amount: string;
  /** The envelope it was in, when it was in one. */
  readonly envelope: string | null;
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
  // The app turning old shelves into goals, once, when it opens a log that still had one.
  'shelves.retire',
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
 * For each `envelope.define` in the log, the envelope as it stood just before it: `null` when
 * it was not there (the define added it), so a line can say whether it was added, renamed,
 * put under another category, given a figure, or several of these. A goal left out of a
 * define stays as it was; a removal clears the record.
 */
export function envelopeBefores(log: readonly Event[]): Map<string, EnvelopeBefore> {
  const now = new Map<string, NonNullable<EnvelopeBefore>>();
  const out = new Map<string, EnvelopeBefore>();
  for (const e of log) {
    if (e.op === 'envelope.remove') { now.delete(e.envelope); continue; }
    if (e.op !== 'envelope.define') continue;
    const was = now.get(e.envelope) ?? null;
    out.set(e.id, was);
    const sinking = e.sinking === undefined ? was?.sinking : e.sinking ?? undefined;
    now.set(e.envelope, { label: e.label, category: e.category, template: e.template, ...(sinking ? { sinking } : {}) });
  }
  return out;
}

/**
 * The name each removed category had when it went, by the removal's event id: once removed a
 * category keeps no record, and an id is not a word a person reads.
 */
function removedCategoryNames(log: readonly Event[]): Map<string, string> {
  const label = new Map<string, string>();
  const out = new Map<string, string>();
  for (const e of log) {
    if (e.op === 'category.add' || e.op === 'category.rename') label.set(e.category, e.label);
    else if (e.op === 'category.remove') {
      const was = label.get(e.category);
      if (was !== undefined) out.set(e.id, was);
    }
  }
  return out;
}

/** Names as a list, "A, B and C", at most six of them and then "and N more". */
function names(xs: readonly string[]): string {
  const shown = xs.length > 6 ? xs.slice(0, 6) : xs;
  const rest = xs.length - shown.length;
  if (rest) return `${shown.join(', ')} and ${rest} more`;
  return shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

/**
 * Several envelope defines written together, as one line that names every envelope: the ones
 * added ("added the envelopes Rent, Groceries and Dining under Home" when they share a category),
 * then the ones changed, each by what it did when there are only a few.
 */
function envelopesLine(group: readonly Event[], state: State, befores: ReadonlyMap<string, EnvelopeBefore>): string {
  const defines = group.filter((e): e is Extract<Event, { op: 'envelope.define' }> => e.op === 'envelope.define');
  const added = defines.filter((e) => befores.get(e.id) === null);
  const changed = defines.filter((e) => befores.get(e.id) !== null);
  const parts: string[] = [];
  if (added.length) {
    const cats = new Set(added.map((e) => e.category));
    const under = cats.size === 1 ? ` under ${state.categories.get(added[0]!.category)?.label ?? added[0]!.category}` : '';
    parts.push(added.length === 1 ? describe(added[0]!, state, null).what
      : `added the envelopes ${names(added.map((e) => e.label))}${under}`);
  }
  if (changed.length) {
    parts.push(changed.length <= 3
      ? changed.map((e) => describe(e, state, befores.get(e.id)).what).join('; ')
      : `changed the envelopes ${names(changed.map((e) => e.label))}`);
  }
  return parts.join('; ');
}

/**
 * Every change anyone made directly, one line per decision, oldest first.
 *
 * A bulk sort writes one event per receipt. Thirty-three lines saying the same
 * thing is not thirty-three decisions, and reads as noise that trains people
 * to skim the one line that mattered.
 */
export function changes(
  all: readonly Event[],
  state: State,
  /** The whole log, when `all` is only some of it: where an envelope's earlier record is found. */
  log: readonly Event[] = all,
): Change[] {
  const befores = envelopeBefores(log);
  const goneCategories = removedCategoryNames(log);
  const meaningful = all.filter(isChange);
  const out: Change[] = [];
  for (let i = 0; i < meaningful.length; i++) {
    const e = meaningful[i]!;
    const group = [e];
    while (i + 1 < meaningful.length && sameAction(e, meaningful[i + 1]!)) group.push(meaningful[++i]!);
    const d = describe(e, state, befores.get(e.id));
    // A category removed reads by the name it had, which only the log still holds.
    const gone = e.op === 'category.remove' && !state.categories.has(e.category) ? goneCategories.get(e.id) : undefined;
    if (gone !== undefined) d.what = `removed the category ${gone}`;
    const removed = e.op === 'txn.remove' ? findRemoved(meaningful, e.txn, state) : undefined;
    out.push({
      id: e.id, at: e.at, who: e.who,
      what: group.length === 1 ? d.what
        : e.op === 'envelope.define' ? envelopesLine(group, state, befores)
        // Categories or rules added together are named, each of them: "Home (7 times)" would name one.
        : e.op === 'category.add' ? `added the categories ${names(group.map((x) => (x as Extract<Event, { op: 'category.add' }>).label))}`
        : e.op === 'rule.add' ? `added the rules ${names(group.map((x) => `"${(x as Extract<Event, { op: 'rule.add' }>).match}"`))}`
        : `${d.what} (${group.length} times)`,
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
export function findRemoved(events: readonly Event[], txnId: string, state: State): Removed | undefined {
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
      envelope: isSpend(t.envelope) ? t.envelope : null,
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
