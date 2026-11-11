// api/src/search.ts
//
// One search over the household. The documents are in Synology Drive, so Drive
// searches them: plans' pages, briefings, answers and the files on cards, under
// the household's own folder. What is only in the log (plans' titles and notes
// as they are now, what members asked and wrote to each other, the briefings
// and answers written with no session or when Drive refused, the open cards)
// is searched here, in memory.
//
// Drive is asked to look under the household's folder, and nothing it answers
// is taken on trust: an item whose path is not under that folder is dropped
// before anything else is made of it, so a Drive that ignores `location` still
// never shows one household another's files. A hit is only ever something this
// household's log can open: a live plan, a file still on a live plan's card, a
// briefing or an answer it wrote.
//
// Drive needs the member's session, the household and its chosen folder. Without
// any of them, or when Drive refuses, the log is still searched and the answer
// says `documents: 'not searched'`. The sid goes only as the cookie `drive.ts`
// sends: not in a URL, a log line or a file.

import { currentDoc, householdFolder } from './docs.ts';
import { build, counted, daysOf, ordered } from './thread.ts';
import type { DayRow, ThreadEntry } from './thread.ts';
import type { Lane } from './lanes.ts';
import { search } from './drive.ts';
import type { DriveFile } from './drive.ts';
import { ToolError } from './errors.ts';
import { PAGE_NAME } from './pages.ts';
import { SynologyError } from './synology.ts';
import type { DsmFetch } from './synology.ts';
import type { ToolContext } from './tools.ts';
import { visibleTo } from './types.ts';
import type { Actor, Day, Event, EventId, EventOf, PlanId, State } from './types.ts';

export type SearchKind = 'plan' | 'briefing' | 'answer' | 'file' | 'thread';
/** What may be asked for. A thread hit comes back only when no kind is asked for. */
export const SEARCH_KINDS: readonly SearchKind[] = ['plan', 'briefing', 'answer', 'file'];
/** The most hits one search returns. */
export const SEARCH_MAX = 8;

export interface SearchHit {
  readonly kind: SearchKind;
  readonly title: string;
  /** Plain text, never markup: the words around the match. */
  readonly passage: string;
  /** Where to open it: a plan, a day's briefing, a thread event, or a file on a plan. */
  readonly open: {
    readonly plan?: PlanId; readonly day?: Day; readonly event?: EventId;
    readonly file?: { readonly plan: PlanId; readonly name: string };
  };
}

/** How many results Drive is asked for: enough that the cut, after the drops, still has eight to choose from. */
const DRIVE_LIMIT = 50;
/** The most of Drive's passage kept. */
const DRIVE_PASSAGE_MAX = 240;
/** About how much of a matched text the log's passage shows. */
const RAM_PASSAGE = 120;
/** The most of a thread entry's words used as its title. */
const TITLE_MAX = 80;
/** A briefing's file: `<day>-<source>.md`. */
const BRIEFING_FILE = /^(\d{4}-\d{2}-\d{2})-.+\.md$/;

const kindList = SEARCH_KINDS.join(', ').replace(/, (?=[^,]*$)/, ' or ');

/** A kind as asked for: one of SEARCH_KINDS, or none. */
export function searchKind(v: unknown): SearchKind | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' && (SEARCH_KINDS as readonly string[]).includes(v)) return v as SearchKind;
  throw new ToolError(`kind must be ${kindList}`);
}

/** The words searched for: at least two letters, once the spaces round them are gone. */
export function searchWords(v: unknown): string {
  const words = typeof v === 'string' ? v.trim() : '';
  if (words.length < 2) throw new ToolError('search for at least two letters');
  return words;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** At most `max` characters, the last of them `…` when anything was cut. */
const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/**
 * Drive's passage as text: every tag taken out (a tag cut off at the end too),
 * leaving the words either side as they were, so a highlighted part of a word
 * stays one word; on one line, at most 240.
 */
const drivePassage = (snippet: string): string =>
  cut(oneLine(snippet.replace(/<[^>]*(?:>|$)/g, '')), DRIVE_PASSAGE_MAX);

/** About RAM_PASSAGE characters of `text` around the first match, on one line; `…` where it was cut. */
function around(text: string, words: string): string {
  const flat = oneLine(text);
  const at = Math.max(0, flat.toLowerCase().indexOf(words.toLowerCase()));
  if (flat.length <= RAM_PASSAGE) return flat;
  const start = Math.max(0, Math.min(at - Math.floor((RAM_PASSAGE - words.length) / 2), flat.length - RAM_PASSAGE));
  const end = Math.min(flat.length, start + RAM_PASSAGE);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

const has = (text: string, words: string): boolean => text.toLowerCase().includes(words.toLowerCase());

/** The thread events a Drive hit opens: the briefing by its document's link, and the answer to each question. */
function threadIndex(state: State, events: readonly Event[]): {
  briefings: Map<string, EventOf<'thread.briefing'>>; answers: Map<EventId, EventOf<'thread.answer'>>;
  asks: Map<EventId, EventOf<'thread.ask'>>;
} {
  const briefings = new Map<string, EventOf<'thread.briefing'>>();
  const answers = new Map<EventId, EventOf<'thread.answer'>>();
  const asks = new Map<EventId, EventOf<'thread.ask'>>();
  // In log order, so the latest for a link (a briefing written again in place of one) wins.
  for (const e of events) {
    if (e.op === 'thread.briefing' && e.doc) briefings.set(currentDoc(state, e.doc).link, e);
    else if (e.op === 'thread.answer') answers.set(e.replyTo, e);
    else if (e.op === 'thread.ask') asks.set(e.id, e);
  }
  return { briefings, answers, asks };
}

/**
 * A Drive item as a hit, or null. `rel` is its path under the household's
 * folder, which the caller has already checked it is under.
 */
function driveHit(state: State, index: ReturnType<typeof threadIndex>, item: DriveFile, rel: string): SearchHit | null {
  const parts = rel.split('/');
  if (parts.length !== 2 || item.type !== 'file' || item.removed) return null;
  const [folder, name] = parts as [string, string];
  const passage = drivePassage(item.content_snippet);

  if (folder === 'today') {
    const day = BRIEFING_FILE.exec(name)?.[1];
    if (!day) return null;
    const b = index.briefings.get(item.permanent_link);
    return { kind: 'briefing', title: b ? oneLine(b.headline) : `The briefing for ${day}`, passage, open: { day, ...(b ? { event: b.id } : {}) } };
  }
  if (folder === 'answers') {
    if (!name.endsWith('.md')) return null;
    const a = index.answers.get(name.slice(0, -'.md'.length));
    if (!a) return null;
    const asked = index.asks.get(a.replyTo);
    return { kind: 'answer', title: cut(oneLine(asked?.question ?? a.text), TITLE_MAX), passage, open: { event: a.id } };
  }

  const plan = state.plans.get(folder);
  if (!plan || plan.removed) return null;
  if (name === PAGE_NAME) return { kind: 'plan', title: plan.title, passage, open: { plan: plan.id } };
  if (!plan.attachments.some((a) => a.name === name)) return null;
  return { kind: 'file', title: name, passage, open: { file: { plan: plan.id, name } } };
}

/** Drive's hits, in Drive's order, and whether Drive answered as many as it was asked for; null when Drive was not, or could not be, asked. */
async function fromDrive(
  ctx: ToolContext, words: string, events: readonly Event[], f?: DsmFetch,
): Promise<{ hits: SearchHit[]; atLimit: boolean } | null> {
  const home = householdFolder(ctx.store.state);
  if (home === null || !ctx.sid || !ctx.household) return null;
  let items: DriveFile[];
  try {
    items = await search(ctx.sid, { keyword: words, location: home, limit: DRIVE_LIMIT }, f);
  } catch (err) {
    if (err instanceof SynologyError || err instanceof ToolError) return null;
    throw err;
  }
  const prefix = `${home}/`;
  const index = threadIndex(ctx.store.state, events);
  const hits: SearchHit[] = [];
  for (const item of items) {
    // Another household's, whatever Drive was asked: dropped before anything is made of it.
    // `display_path` is the whole /team-folders/<team>/… path; Drive's `path` is
    // relative to the Team Folder (the real NAS, 2026-11-03), so it is never compared.
    if (!item.display_path.startsWith(prefix)) continue;
    const hit = driveHit(ctx.store.state, index, item, item.display_path.slice(prefix.length));
    if (hit) hits.push(hit);
  }
  return { hits, atLimit: items.length >= DRIVE_LIMIT };
}

/**
 * The log's hits: live plans by title and notes, then the thread (newest
 * first): its questions and notes, and the briefings and answers whose words
 * are in the log rather than in Drive (a briefing another took the place of
 * is not one), then open cards.
 */
function fromLog(ctx: ToolContext, words: string, events: readonly Event[]): SearchHit[] {
  const state = ctx.store.state;
  const hits: SearchHit[] = [];
  for (const p of state.plans.values()) {
    if (p.removed) continue;
    const text = has(p.title, words) ? p.title : has(p.notes, words) ? p.notes : null;
    if (text !== null) hits.push({ kind: 'plan', title: p.title, passage: around(text, words), open: { plan: p.id } });
  }
  const replaced = new Set(events.flatMap((e) => (e.op === 'thread.briefing' && e.replaces ? [e.replaces] : [])));
  const asks = new Map(events.flatMap((e) => (e.op === 'thread.ask' ? [[e.id, e.question] as const] : [])));
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.op === 'thread.briefing') {
      if (e.doc || replaced.has(e.id)) continue;
      const text = has(e.body ?? '', words) ? e.body! : has(e.headline, words) ? e.headline : null;
      if (text !== null) {
        hits.push({ kind: 'briefing', title: oneLine(e.headline), passage: around(text, words), open: { day: e.day, event: e.id } });
      }
      continue;
    }
    if (e.op === 'thread.answer') {
      if (!e.doc && has(e.text, words)) {
        const title = cut(oneLine(asks.get(e.replyTo) ?? e.text), TITLE_MAX);
        hits.push({ kind: 'answer', title, passage: around(e.text, words), open: { event: e.id } });
      }
      continue;
    }
    const text = e.op === 'thread.ask' ? e.question : e.op === 'thread.note' ? e.text : null;
    if (text !== null && has(text, words)) {
      hits.push({ kind: 'thread', title: cut(oneLine(text), TITLE_MAX), passage: around(text, words), open: { event: e.id } });
    }
  }
  const open = [...state.thread.offers.values()]
    .filter((o) => o.status === 'open' && visibleTo(o, ctx.who) && has(o.summary, words))
    .reverse();
  for (const o of open) {
    hits.push({ kind: 'thread', title: cut(oneLine(o.summary), TITLE_MAX), passage: around(o.summary, words), open: { event: o.id } });
  }
  return hits;
}

/**
 * Search the household for `words`: Drive's hits first, in Drive's order, then
 * the log's. A plan Drive found is not listed again from the log. `kind`
 * keeps only that kind; at most SEARCH_MAX come back.
 */
export async function searchHousehold(
  ctx: ToolContext, words: string, kind?: SearchKind, f?: DsmFetch,
): Promise<{ hits: SearchHit[]; documents: 'searched' | 'not searched' }> {
  const asked = searchWords(words);
  const only = searchKind(kind);
  const events = await ctx.store.since(null);
  const drive = await fromDrive(ctx, asked, events, f);
  const found = drive?.hits ?? [];
  const drivePlans = new Set(found.filter((h) => h.kind === 'plan').map((h) => h.open.plan));
  const log = fromLog(ctx, asked, events).filter((h) => h.kind !== 'plan' || !drivePlans.has(h.open.plan));
  const hits = [...found, ...log].filter((h) => only === undefined || h.kind === only).slice(0, SEARCH_MAX);
  return { hits, documents: drive === null ? 'not searched' : 'searched' };
}

/** The most rows the record's search keeps: the newest. */
export const RECORD_MAX = 100;

export interface RecordResults {
  /** Who is pressed; everyone when the person asked had no match. */
  who: Actor | 'everyone';
  /** Newest day first; only days with a match. */
  days: DayRow[];
  /** The matching entries, in `ordered`'s order. */
  entries: (ThreadEntry & { passage?: string })[];
  /** More matched than are shown. */
  capped: boolean;
  /** Plans and files, which are not days. */
  elsewhere: (SearchHit & { on?: string })[];
  documents: 'searched' | 'not searched';
}

/** The words an entry is searched by, the one it shows first; a match in a later one earns a passage. */
function textsOf(e: ThreadEntry): string[] {
  switch (e.kind) {
    case 'note': return [e.text];
    case 'ask': return [e.text, ...(e.answer ? [e.answer.text] : [])];
    case 'briefing': return [e.headline, ...(e.body ? [e.body] : [])];
    case 'change': return [e.what, ...(e.why ? [e.why] : []), ...(e.flag?.removed ? [e.flag.removed.payee] : [])];
    case 'card': return [e.offer.summary, ...e.offer.effects, ...(e.offer.why ? [e.offer.why] : []), ...(e.ask?.why ? [e.ask.why] : [])];
    case 'decision': return [];
  }
}

/** The passage of an entry's match: the answer's opening for a question found in itself, the words around the match otherwise. */
function passageOf(e: ThreadEntry, words: string): string | undefined {
  const texts = textsOf(e);
  const at = texts.findIndex((t) => has(t, words));
  if (at < 0) return undefined;
  if (e.kind === 'ask') {
    if (!e.answer) return undefined;
    return at === 0 ? around(e.answer.text, '') : around(e.answer.text, words);
  }
  return at === 0 ? undefined : around(texts[at]!, words);
}

/**
 * Search the record for `words`: the entries whose words match, as day cards
 * (newest `RECORD_MAX`, the day's numbers counting only matches), and the
 * plans and files they are not. Drive's briefings and answers join the
 * entries they are the words of.
 */
export async function searchRecord(
  ctx: ToolContext, words: string, o: { lane?: Lane; person?: Actor | 'everyone' }, f?: DsmFetch,
): Promise<RecordResults> {
  const asked = searchWords(words);
  const events = await ctx.store.since(null);
  const state = ctx.store.state;
  const all = ordered(build(events, state, ctx.who));
  const drive = await fromDrive(ctx, asked, events, f);

  const passages = new Map<EventId, string>();
  const matched = new Set<EventId>();
  for (const e of all) {
    if (e.kind !== 'decision' && textsOf(e).some((t) => has(t, asked))) matched.add(e.id);
  }
  // Drive's words for a briefing or an answer: they join the entry that shows it, and replace its own passage.
  const answerOf = new Map<EventId, ThreadEntry>();
  for (const e of all) if (e.kind === 'ask' && e.answer) answerOf.set(e.answer.id, e);
  const byId = new Map(all.map((e) => [e.id, e] as const));
  for (const h of drive?.hits ?? []) {
    if ((h.kind !== 'briefing' && h.kind !== 'answer') || !h.open.event) continue;
    const entry = h.kind === 'briefing' ? byId.get(h.open.event) : answerOf.get(h.open.event);
    if (!entry || (h.kind === 'briefing' && entry.kind !== 'briefing')) continue;
    matched.add(entry.id);
    passages.set(entry.id, h.passage);
  }

  const lane = o.lane;
  const window = { from: '0000-01-01', to: '9999-12-31', ...(lane ? { lane } : {}) };
  let person: Actor | 'everyone' = o.person ?? 'everyone';
  // A person with no match falls back to everyone, as the day list does.
  if (person !== 'everyone' && !daysOf(all, state, ctx.who, { ...window, who: person, only: matched }).some((d) => d.count > 0)) {
    person = 'everyone';
  }

  const shown = all.filter((e) => matched.has(e.id) && counted(e, lane, person));
  // The newest are kept; within a day they stay morning to night.
  const newest = shown.map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.day < b.e.day ? 1 : a.e.day > b.e.day ? -1 : 0) || (a.e.at < b.e.at ? 1 : a.e.at > b.e.at ? -1 : 0) || b.i - a.i)
    .slice(0, RECORD_MAX).map((x) => x.e.id);
  const kept = new Set(newest);
  const entries = shown.filter((e) => kept.has(e.id)).map((e) => {
    const passage = passages.get(e.id) ?? passageOf(e, asked);
    return passage === undefined ? e : { ...e, passage };
  });
  const capped = shown.length > RECORD_MAX || (drive?.atLimit ?? false);
  const days = daysOf(all, state, ctx.who, { ...window, who: person, only: kept }).filter((d) => d.count > 0);

  let elsewhere: (SearchHit & { on?: string })[] = [];
  if (lane === undefined || lane === 'plans') {
    const found = (drive?.hits ?? []).filter((h) => h.kind === 'plan' || h.kind === 'file');
    const driven = new Set(found.filter((h) => h.kind === 'plan').map((h) => h.open.plan));
    const log = fromLog(ctx, asked, events).filter((h) => h.kind === 'plan' && !driven.has(h.open.plan));
    elsewhere = [...found, ...log].slice(0, SEARCH_MAX).map((h) => {
      const title = h.kind === 'file' && h.open.file ? state.plans.get(h.open.file.plan)?.title : undefined;
      return title === undefined ? h : { ...h, on: title };
    });
  }
  return { who: person, days, entries, capped, elsewhere, documents: drive === null ? 'not searched' : 'searched' };
}
