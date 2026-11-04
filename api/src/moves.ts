// api/src/moves.ts
//
// A new folder for the household's documents moves the ones the app wrote, one
// by one, out of the folder being left. The fold has listed them (state
// .documents.waiting); each `documents.moved` takes one off the list and, for a
// Drive document, carries the file as Drive now gives it, so every pointer the
// log has follows (`currentDoc`). A card's file moves through File Station, and
// the card reads it from wherever it is now (`attachmentFolder`).
//
// A file goes to the parent its kind says (`today`, `answers` or its plan's
// id), never to wherever its stale path pointed. Drive's move answers a task id
// and moves in the background, with nothing to ask after it, so a move is
// confirmed only by finding the file at its expected new path under its own
// `permanent_link`, which Drive keeps across a move. A move onto a taken name is
// accepted and does nothing, so another link at that path means the name is
// taken. A card's file is confirmed through File Station's own lists, never
// through Drive, which indexes File Station's changes late.
//
// Files taken off a card, and anything the app did not write, stay behind:
// nothing is deleted. While files wait, the folder being left stays taken in
// the folder registry; the last record lets it go.
//
// Moves run in the pages' lane (`schedulePages`), before the pages, as the
// member whose request it follows. A write about to land on a file still
// waiting moves that file first (`moveFirst`). The sid stays in memory: it is
// not logged, not put in a URL and not written to a file.

import { setTimeout as sleep } from 'node:timers/promises';

import { segment } from './attachments.ts';
import { inHousehold, toDocRef } from './docs.ts';
import type { DocAccess } from './docs.ts';
import { DRIVE_API, DRIVE_NAME_TAKEN, byLink, getFile, isNameTaken, isNoSuchFile, moveFile } from './drive.ts';
import type { DriveFile } from './drive.ts';
import { ToolError } from './errors.ts';
import { drivePathOf, nasPathOf, rememberDocuments } from './folders.ts';
import { PAGE_RETRY_MS } from './pages.ts';
import { oneAtATime } from './settings.ts';
import { SessionLost, SynologyError, createFolder, listFolder, moveOnNas } from './synology.ts';
import type { DsmFetch } from './synology.ts';
import type { Store } from './store.ts';
import type { ToolContext } from './tools.ts';
import type { Actor, Attachment, Event, MoveFile, State } from './types.ts';

/** The most files moved in one pass: the rest wait for the next request, as pages do. */
export const MOVE_BATCH = 25;
/** How long a pass looks for one moved file at its new path before leaving it for the next pass. */
export const MOVE_WAIT_MS = 3000;
/** How often it looks in that time. */
export const MOVE_POLL_MS = 250;

/** File Station's "no such file", and its "a file by that name is there already". */
const NAS_NO_SUCH_FILE = 408;
const NAS_NAME_TAKEN = 414;

/** Where a file goes: `<new>/today`, `<new>/answers` or `<new>/<plan-id>`, worked out from its kind, never its stale path. */
export function destinationOf(state: State, file: MoveFile): { readonly drive: string; readonly nas: string; readonly name: string } {
  const home = state.documents.folder;
  if (!home) throw new Error('there is no folder to move documents to');
  const parent = file.kind === 'doc' ? file.parent : file.plan;
  return { drive: `${drivePathOf(home)}/${parent}`, nas: `${nasPathOf(home)}/${parent}`, name: file.name };
}

export interface MoveFailure { readonly name: string; readonly words: string; readonly at: number }

/** Each store's files that failed to move, by store path, then by moveKey. In memory. */
const failed = new Map<string, Map<string, MoveFailure>>();

/** Files that failed, by store path, in memory: the name and the NAS's words, retried after PAGE_RETRY_MS. */
export function moveFailures(storePath: string): readonly MoveFailure[] {
  return [...(failed.get(storePath)?.values() ?? [])];
}

const backingOff = (path: string, key: string): boolean => {
  const at = failed.get(path)?.get(key)?.at;
  return at !== undefined && Date.now() - at < PAGE_RETRY_MS;
};

function fail(path: string, key: string, name: string, words: string): void {
  let mine = failed.get(path);
  if (!mine) failed.set(path, mine = new Map());
  mine.set(key, { name, words, at: Date.now() });
  console.warn(`[moves] ${name}: ${words}`);
}

function forget(path: string, key: string): void {
  const mine = failed.get(path);
  mine?.delete(key);
  if (mine?.size === 0) failed.delete(path);
}

/** Who moves, and for which household: the narrowest a caller holds. ToolContext is one. */
export type MoveAccess = DocAccess & { readonly store: Store; readonly who: Actor };

/** Whether this access can move anything now: a session, a household, a member, and files waiting to leave a folder. */
const canMove = (a: MoveAccess): boolean => {
  const docs = a.store.state.documents;
  return !!a.sid && !!a.household && docs.folder !== null && docs.previous !== null && docs.waiting.size > 0
    && a.store.state.members.has(a.who);
};

/** The file at `path`, or null when Drive has nothing there. */
async function lookFor(sid: string, path: string, f?: DsmFetch): Promise<DriveFile | null> {
  try {
    return await getFile(sid, path, f);
  } catch (err) {
    if (isNoSuchFile(err)) return null;
    throw err;
  }
}

type DocFile = Extract<MoveFile, { kind: 'doc' }>;
type CardFile = Extract<MoveFile, { kind: 'card' }>;
type Where = ReturnType<typeof destinationOf>;
/** Append the file's documents.moved as the member: what it is now, or that it is gone. */
type Record = (moved: Extract<Event, { op: 'documents.moved' }>['file'], gone?: boolean) => Promise<Event[]>;

/** The card's file of that name while it is on a live card; undefined once taken off, or its plan removed. */
const onCard = (state: State, file: CardFile): Attachment | undefined => {
  const p = state.plans.get(file.plan);
  return p && !p.removed ? p.attachments.find((x) => x.name === file.name) : undefined;
};

/**
 * Another file holds the name where this one goes: said as Drive's own "taken",
 * so the words moveOne gives a taken name apply. Drive does not refuse a move
 * onto a taken name (the real NAS, 2026-11-03): it accepts it and leaves both
 * files as they were, so a taken name is only ever found by looking.
 */
const nameTaken = (expected: string): SynologyError =>
  new SynologyError(`Drive has another file at ${expected}`, DRIVE_API, [...DRIVE_NAME_TAKEN][0]!, 409);

/**
 * A Drive document: looked for where it goes, then by its link, then moved and
 * looked for again. Drive keeps a file's `permanent_link` when it moves it (the
 * real NAS, 2026-11-03), so the file at the new path is this one only if its
 * link is this one's; a file there under another link is a taken name.
 */
async function moveDoc(sid: string, a: MoveAccess, file: DocFile, to: Where, record: Record, f?: DsmFetch): Promise<Event[]> {
  const expected = `${to.drive}/${to.name}`;
  const movedTo = (d: DriveFile) => ({ link: file.link, doc: toDocRef(d) });
  const ours = (d: DriveFile) => d.permanent_link === file.link;
  // Already there: it was moved and its event lost (a restart mid-move).
  const there = await lookFor(sid, expected, f);
  if (there && ours(there)) return record(movedTo(there));
  const now = await lookFor(sid, byLink(file.link), f);
  if (!now) return record({ link: file.link }, true);
  // A copy-restored household's link names the original's file: not this household's to move.
  if (!inHousehold(now, a.store.state)) return record({ link: file.link });
  // Someone else's file has the name: Drive would accept the move and do nothing.
  if (there) throw nameTaken(expected);
  await moveFile(sid, byLink(file.link), to.drive, f);
  const deadline = Date.now() + MOVE_WAIT_MS;
  for (;;) {
    const landed = await lookFor(sid, expected, f);
    if (landed) {
      if (ours(landed)) return record(movedTo(landed));
      throw nameTaken(expected);
    }
    if (Date.now() + MOVE_POLL_MS > deadline) return []; // not there yet: the next pass looks again
    await sleep(MOVE_POLL_MS);
  }
}

/** The file of that name in a folder, as File Station lists it; nothing in a folder that is not there. */
async function listed(sid: string, folder: string, name: string, f?: DsmFetch): Promise<{ readonly size: number } | undefined> {
  try {
    return (await listFolder(sid, folder, f)).find((x) => !x.isdir && x.name === name);
  } catch (err) {
    if (err instanceof SynologyError && err.code === NAS_NO_SUCH_FILE) return undefined;
    throw err;
  }
}

/**
 * A card's file, through File Station, out of `from`. It counts as moved only
 * when File Station's lists say so: gone from the folder being left, and in the
 * new one at its size. Never by its name in the new folder alone, which a
 * member's own file may have; never by File Station's "finished" alone, which
 * it says of a file it skipped (`skipstatus.status` "all", which `moveOnNas`
 * gives as 414, a taken name); and never through Drive, which on the real NAS
 * (2026-11-03) had not indexed a File Station move 9 seconds later. A move not
 * finished within NAS_MOVE_WAIT_MS is found by the next pass's look.
 */
async function moveCard(
  sid: string, from: string, file: CardFile, size: number, to: Where, record: Record, f?: DsmFetch,
): Promise<Event[]> {
  const landed = { plan: file.plan, name: file.name, path: `${to.nas}/${to.name}` };
  const gone = { plan: file.plan, name: file.name };
  const left = `${from}/${file.plan}`;
  const moved = async (bytes: number): Promise<boolean> =>
    !(await listed(sid, left, file.name, f)) && (await listed(sid, to.nas, file.name, f))?.size === bytes;
  const source = await listed(sid, left, file.name, f);
  // Not where it was: moved and its event lost (a restart mid-move), or gone.
  if (!source) return await moved(size) ? record(landed) : record(gone, true);
  let done: boolean;
  try {
    done = await moveOnNas(sid, `${left}/${file.name}`, to.nas, f);
  } catch (err) {
    if (!(err instanceof SynologyError && err.code === NAS_NO_SUCH_FILE)) throw err;
    // Gone since the look: moved by a move asked before, or gone.
    return await moved(source.size) ? record(landed) : record(gone, true);
  }
  if (!done) return []; // not finished yet: the next pass looks again
  if (await moved(source.size)) return record(landed);
  // Finished, and still where it was: skipped for a file of that name in the new folder, said as File Station's 414.
  throw new SynologyError(`File Station left ${file.name} where it was: ${to.nas} has a file by that name`,
    'SYNO.FileStation.CopyMove', NAS_NAME_TAKEN, 409);
}

/**
 * One waiting file, by its moveKey, one at a time per file: its parent made in
 * the new folder, then moved as its kind says (`moveDoc`, `moveCard`). The
 * events recorded, [] for a file not waiting, backing off, failed or not there
 * yet; null when the session is lost, which stops a pass.
 */
async function moveOne(a: MoveAccess, key: string, made: Set<string>, f?: DsmFetch): Promise<Event[] | null> {
  const path = a.store.path;
  return oneAtATime(`${path}|move|${key}`, async () => {
    // Read after the wait: the move ahead of this one may have just recorded it.
    const file = a.store.state.documents.waiting.get(key);
    if (!file || backingOff(path, key)) return [];
    const sid = a.sid!;
    const record: Record = async (moved, gone = false) => {
      const events = await a.store.append(a.who, { op: 'documents.moved', file: moved, ...(gone ? { gone: true as const } : {}) });
      forget(path, key);
      // The folder being left is let go once nothing waits to move out of it.
      const docs = a.store.state.documents;
      if (a.household && docs.waiting.size === 0) rememberDocuments(a.household, docs);
      return events;
    };
    const to = destinationOf(a.store.state, file);
    const parent = file.kind === 'doc' ? file.parent : file.plan;
    try {
      segment(parent, 'a folder');
      segment(file.name, 'a file name');
      const card = file.kind === 'card' ? onCard(a.store.state, file) : undefined;
      // Taken off its card since the choice (or put on it again, in the new folder already): it stays where it is.
      if (file.kind === 'card' && (!card || card.path === `${to.nas}/${to.name}`)) {
        return await record({ plan: file.plan, name: file.name });
      }
      const { folder: home, previous } = a.store.state.documents;
      if (!made.has(to.nas)) {
        await createFolder(sid, nasPathOf(home!), parent, f);
        made.add(to.nas);
      }
      return file.kind === 'doc'
        ? await moveDoc(sid, a, file, to, record, f)
        : await moveCard(sid, nasPathOf(previous!), file, card!.size, to, record, f);
    } catch (err) {
      if (err instanceof SessionLost) return null;
      if (!(err instanceof SynologyError || err instanceof ToolError)) throw err;
      const team = a.store.state.documents.folder!;
      const taken = file.kind === 'doc' ? isNameTaken(err) : err instanceof SynologyError && err.code === NAS_NAME_TAKEN;
      const words = taken
        ? `a file called ${file.name} is already in ${team.team}/${team.folder}/${parent}: move or rename it there`
        : err.message;
      // The NAS's own words may carry the session: it is never logged, nor kept.
      fail(path, key, file.name, words.replaceAll(sid, '…'));
      return [];
    }
  });
}

/** One pass: up to MOVE_BATCH waiting files, in the order the fold listed them, each recorded by documents.moved as ctx.who. A lost session stops it. */
export async function movePass(ctx: ToolContext, f?: DsmFetch): Promise<Event[]> {
  if (!canMove(ctx)) return [];
  const path = ctx.store.path;
  const waiting = ctx.store.state.documents.waiting;
  // A failure kept for a file no longer waiting (moved by another member's pass) is said no more.
  for (const key of failed.get(path)?.keys() ?? []) if (!waiting.has(key)) forget(path, key);
  const keys = [...waiting.keys()].filter((key) => !backingOff(path, key)).slice(0, MOVE_BATCH);
  const made = new Set<string>();
  const out: Event[] = [];
  for (const key of keys) {
    const one = await moveOne(ctx, key, made, f);
    if (one === null) break;
    out.push(...one);
  }
  return out;
}

/** A write about to land on a file still waiting (a briefing written again the same day) moves that file first. */
export async function moveFirst(a: MoveAccess, rel: readonly [folder: string, file: string], f?: DsmFetch): Promise<void> {
  if (!canMove(a)) return;
  const keys = [...a.store.state.documents.waiting]
    .filter(([, file]) => file.kind === 'doc' && file.parent === rel[0] && file.name === rel[1]).map(([key]) => key);
  for (const key of keys) await moveOne(a, key, new Set(), f);
}
