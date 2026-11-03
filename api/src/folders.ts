/**
 * Where a household's documents live: a folder in a Synology Drive Team
 * Folder, chosen by the household's owner in Settings. This is the picker's
 * logic, in its three steps (a Team Folder, a folder in it, the checks), and
 * "Use this folder", which makes the folder and writes the choice to the log.
 *
 * Every household's folder is also kept here in memory, filled at boot and on
 * every choice, so a choice that is, holds or sits in another household's
 * folder is refused without opening any other log, and without naming it.
 *
 * What is typed is made clean, or refused in words, before the NAS is asked.
 */

import { PLANNER_ROOT, segment } from './attachments.ts';
import { getFile, isNameTaken, isNoSuchFile, listFolders, makeFolder, search, teamFolderMembers, teamFolderName, teamFolders } from './drive.ts';
import { ToolError } from './errors.ts';
import { slugify } from './households.ts';
import type { Households } from './households.ts';
import { SessionLost, SynologyError, requireSid } from './synology.ts';
import type { DsmFetch } from './synology.ts';
import type { ToolContext } from './tools.ts';
import { segmentProblem } from './types.ts';
import { SYSTEM } from './types.ts';
import type { DocumentsFolder, DocumentsState, Event, State } from './types.ts';

/** The folder as Drive addresses it. */
export const drivePathOf = (c: DocumentsFolder): string => `/team-folders/${c.team}/${c.folder}`;

/** The folder as DSM's shared folders name it, the way a person reads it. */
export const nasPathOf = (c: DocumentsFolder): string => `/${c.team}/${c.folder}`;

/**
 * The choice as typed, made clean: segments trimmed, empty ones from a
 * leading, trailing or doubled slash dropped. Words for what cannot be. What
 * comes out passes the fold's own rule for `documents.folder`.
 */
export function cleanFolder(x: { team?: unknown; folder?: unknown }): DocumentsFolder | { problem: string } {
  const team = typeof x.team === 'string' ? x.team.trim() : '';
  if (!team) return { problem: 'choose a Team Folder' };
  const teamProblem = segmentProblem(team, 'the Team Folder');
  if (teamProblem) return { problem: teamProblem };
  const parts = (typeof x.folder === 'string' ? x.folder : '').split('/').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { problem: 'name a folder in it' };
  for (const part of parts) {
    const problem = segmentProblem(part, 'the folder');
    if (problem) return { problem };
  }
  return { team, folder: parts.join('/') };
}

/** The choice made clean, or a refusal in words: nothing unclean reaches the NAS. */
function mustBeClean(c: DocumentsFolder): DocumentsFolder {
  const clean = cleanFolder(c);
  if ('problem' in clean) throw new ToolError(clean.problem);
  return clean;
}

/** Household id → its folder, and the folder it is leaving while files wait to move out of it. */
const registry = new Map<string, { readonly folder: DocumentsFolder; readonly leaving: DocumentsFolder | null }>();

const copyOf = (c: DocumentsFolder): DocumentsFolder => ({ team: c.team, folder: c.folder });

/**
 * The registry: every household's folder, in memory, filled at boot (Task 15)
 * and on every choice. `leaving`, while files wait to move out of it, is taken
 * too, so no other household chooses a folder still being emptied. Null forgets both.
 */
export function rememberFolder(household: string, c: DocumentsFolder | null, leaving: DocumentsFolder | null = null): void {
  if (c) registry.set(household, { folder: copyOf(c), leaving: leaving && copyOf(leaving) });
  else registry.delete(household);
}

/** The household's folder as its log has it now: the one being left is kept until no file waits to move out of it. */
export function rememberDocuments(household: string, docs: Pick<DocumentsState, 'folder' | 'previous' | 'waiting'>): void {
  rememberFolder(household, docs.folder, docs.waiting.size ? docs.previous : null);
}

export function folderOf(household: string): DocumentsFolder | null {
  return registry.get(household)?.folder ?? null;
}

/** The refusal of a second change of folder while files wait to move: asked before the NAS is, as the fold asks it. */
export function stillMoving(state: Pick<State, 'documents'>): ToolError | null {
  const waiting = state.documents.waiting.size;
  return waiting ? new ToolError(`Wait until the ${waiting} documents have moved.`, 409) : null;
}

const partsOf = (c: DocumentsFolder): string[] => [c.team, ...c.folder.split('/')].map((s) => s.toLowerCase());

/** Another household's folder (or one it is leaving) that is this one, holds it or sits in it; compared segment by segment, case-blind. */
export function takenBy(c: DocumentsFolder, household: string): string | null {
  const mine = partsOf(c);
  for (const [other, { folder, leaving }] of registry) {
    if (other === household) continue;
    for (const held of leaving ? [folder, leaving] : [folder]) {
      const theirs = partsOf(held);
      const shared = Math.min(mine.length, theirs.length);
      if (mine.slice(0, shared).every((s, i) => s === theirs[i])) return other;
    }
  }
  return null;
}

export const TAKEN = 'Another household on this NAS keeps its documents there';
export const NOT_TEAM_FOLDER = 'A shared folder not listed here is not a Team Folder yet. Enable it in Synology Drive Admin Console, Team Folder.';

const notTeamFolder = (team: string): string => `${team} is not a Team Folder. ${NOT_TEAM_FOLDER}`;
const cannotWriteTo = (team: string): string => `You cannot write to ${team}: ask the NAS's administrator for Read/Write on it.`;

export interface TeamRow { readonly name: string; readonly canWrite: boolean; readonly fromDeployment: boolean }

/** Step 1: Team Folders, PLANNER_ROOT's first and marked; one you cannot write is kept, greyed by the page. */
export async function pickerTeams(sid: string, f?: DsmFetch): Promise<TeamRow[]> {
  const deployment = PLANNER_ROOT ? teamFolderName(PLANNER_ROOT) : null;
  const rows = (await teamFolders(sid, f)).map((t) => ({ name: t.name, canWrite: t.canWrite, fromDeployment: t.name === deployment }));
  return [...rows.filter((r) => r.fromDeployment), ...rows.filter((r) => !r.fromDeployment)];
}

/** Step 2: the folders in it, and a new name suggested from the household's label (slugify; `-2`, `-3` past a taken one). */
export async function pickerFolders(
  sid: string, team: string, label: string, f?: DsmFetch,
): Promise<{ folders: string[]; suggested: string }> {
  const name = segment(team.trim(), 'the Team Folder');
  const folders = await listFolders(sid, `/team-folders/${name}`, f);
  const taken = new Set(folders.map((n) => n.toLowerCase()));
  const base = slugify(label);
  let suggested = base;
  for (let n = 2; taken.has(suggested); n++) suggested = `${base}-${n}`;
  return { folders, suggested };
}

export interface FolderChecks {
  readonly teamFolder: boolean; readonly writable: boolean;
  /** true: a page there came back with its words; false: names only; null: not known yet (nothing there to find). */
  readonly indexed: boolean | null;
  /** Household members the Team Folder's members list does not show able to write. */
  readonly cannotWrite: readonly string[];
  /** False when the NAS would not give the members list (or there is no Team Folder to ask): `cannotWrite` is then not known, not empty. */
  readonly membersKnown: boolean;
  /** The blocking ones, in words; empty when the folder may be used. */
  readonly problems: readonly string[];
}

/** Every page's frontmatter opens `planner: 1`, so a page in an indexed folder is found by its words. */
const INDEX_KEYWORD = 'planner';

/**
 * A NAS failure on an advisory call, which must not block a folder the
 * blocking checks passed. A session that ended is not one: it says sign in
 * again wherever it is met.
 */
const advisoryFailure = (err: unknown): boolean => err instanceof SynologyError && !(err instanceof SessionLost);

/**
 * Whether Universal Search reads the folder's pages: by their words, by their
 * names only, or not known yet. A folder not made yet has nothing in it to
 * find, and a search the NAS refuses tells nothing either: both are not known.
 */
async function indexed(sid: string, c: DocumentsFolder, f?: DsmFetch): Promise<boolean | null> {
  let hits;
  try {
    hits = await search(sid, { keyword: INDEX_KEYWORD, location: drivePathOf(c) }, f);
  } catch (err) {
    if (advisoryFailure(err)) return null;
    throw err;
  }
  if (!hits.length) return null;
  return hits.some((h) => h.content_snippet !== '');
}

/**
 * The household's members the Team Folder's list leaves out, or names only as
 * a viewer; null when the NAS will not give the list (it may need rights an
 * ordinary owner lacks), which is not known rather than everyone.
 */
async function cannotWrite(sid: string, teamId: string, members: readonly string[], f?: DsmFetch): Promise<string[] | null> {
  let list;
  try {
    list = await teamFolderMembers(sid, teamId, f);
  } catch (err) {
    if (advisoryFailure(err)) return null;
    throw err;
  }
  const writers = new Set(list.filter((m) => m.role !== 'viewer').map((m) => m.name.toLowerCase()));
  return members.filter((m) => !writers.has(m.toLowerCase()));
}

/** Step 3, making nothing: the Team Folder asked again, writable by this session, not another household's; indexing and members advise only. */
export async function checkFolder(
  sid: string, c: DocumentsFolder, o: { household: string; members: readonly string[] }, f?: DsmFetch,
): Promise<FolderChecks> {
  const clean = mustBeClean(c);
  const team = (await teamFolders(sid, f)).find((t) => t.name === clean.team);
  const problems: string[] = [];
  if (!team) problems.push(notTeamFolder(clean.team));
  else if (!team.canWrite) problems.push(cannotWriteTo(clean.team));
  if (takenBy(clean, o.household) !== null) problems.push(TAKEN);
  if (!team) return { teamFolder: false, writable: false, indexed: null, cannotWrite: [], membersKnown: false, problems };
  const index = await indexed(sid, clean, f);
  const members = await cannotWrite(sid, team.team_id, o.members, f);
  return {
    teamFolder: true,
    writable: team.canWrite,
    indexed: index,
    cannotWrite: members ?? [],
    membersKnown: members !== null,
    problems,
  };
}

/** The folder at `c` is there, made if it was not. One whose name is taken by a file is refused. */
async function ensureFolder(sid: string, c: DocumentsFolder, f?: DsmFetch): Promise<void> {
  let there;
  try {
    there = await getFile(sid, drivePathOf(c), f);
  } catch (err) {
    if (!isNoSuchFile(err)) throw err;
  }
  if (there) {
    if (there.type !== 'dir') throw new ToolError(`${nasPathOf(c)} is a file, not a folder`, 409);
    return;
  }
  try {
    await makeFolder(sid, drivePathOf(c), f);
  } catch (err) {
    // Made by someone else since it was looked for: it is there, which is all that is asked.
    if (!isNameTaken(err)) throw err;
  }
}

/** "Use this folder": refuse what checkFolder blocks; make each missing segment with POST files; check again; append documents.folder as ctx.who; remember it. */
export async function chooseFolder(
  ctx: ToolContext & { readonly household: string }, c: DocumentsFolder, f?: DsmFetch,
): Promise<Event[]> {
  const state = ctx.store.state;
  if (ctx.who !== state.owner) throw new ToolError(`only ${state.owner ?? 'the owner'} can change this`, 403);
  const clean = mustBeClean(c);
  // The fold refuses a change while files wait to move; asked here first, so no folder is made for it.
  const moving = stillMoving(state);
  if (moving) throw moving;
  const sid = requireSid(ctx);
  const o = { household: ctx.household, members: [...state.members] };

  const before = await checkFolder(sid, clean, o, f);
  if (before.problems.length) throw new ToolError(before.problems.join(' '), 409);
  const parts = clean.folder.split('/');
  for (let i = 1; i <= parts.length; i++) await ensureFolder(sid, { team: clean.team, folder: parts.slice(0, i).join('/') }, f);
  const after = await checkFolder(sid, clean, o, f);
  if (after.problems.length) throw new ToolError(after.problems.join(' '), 409);

  // Claimed with no await between the last look and the claim, so of two
  // households racing for nested folders exactly one gets past here; the
  // claim is let go if the log refuses the choice. The folder being left is
  // held with it, until the log says nothing waits to move out of it.
  if (takenBy(clean, ctx.household) !== null) throw new ToolError(TAKEN, 409);
  const held = registry.get(ctx.household);
  rememberFolder(ctx.household, clean, ctx.store.state.documents.folder);
  let events: Event[];
  try {
    events = await ctx.store.append(ctx.who, { op: 'documents.folder', team: clean.team, folder: clean.folder, source: 'owner' });
  } catch (err) {
    if (held) registry.set(ctx.household, held);
    else registry.delete(ctx.household);
    throw err;
  }
  rememberDocuments(ctx.household, ctx.store.state.documents);
  return events;
}

// ─── carried over at boot ────────────────────────────────────────────────────

/**
 * The log names a file the app wrote under this folder: a document on a
 * briefing, an answer or a plan's page (by its Drive path), or a file on a
 * card (by its path on the NAS). A pointer under any other folder does not
 * count: a household restored as a copy keeps the original's pointers, and
 * the copy chooses from scratch.
 */
export function namesAFile(events: readonly Event[], folder: DocumentsFolder): boolean {
  const drive = `${drivePathOf(folder)}/`;
  const nas = `${nasPathOf(folder)}/`;
  return events.some((e) => {
    if (e.op === 'plan.attach') return e.path.startsWith(nas);
    if (e.op === 'thread.briefing' || e.op === 'thread.answer' || e.op === 'plan.doc') return typeof e.doc?.path === 'string' && e.doc.path.startsWith(drive);
    return false;
  });
}

/** PLANNER_ROOT's first segment is the team; the rest of it, then the household's id, is the folder. */
export function carriedFolder(root: string, household: string): DocumentsFolder {
  const [team = '', ...rest] = root.split('/').map((s) => s.trim()).filter(Boolean);
  return { team, folder: [...rest, household].join('/') };
}

/**
 * Each household with no documents.folder whose log names a file under the
 * folder the carry-over would choose gets that folder, by system, from the
 * deployment. A folder another household holds is left alone, and said. Answers
 * who got what. The registry is filled for every household first, by the caller.
 */
export async function carryOver(households: Households, root: string | null): Promise<{ id: string; folder: DocumentsFolder }[]> {
  const carried: { id: string; folder: DocumentsFolder }[] = [];
  if (!root) return carried;
  for (const id of await households.ids()) {
    let store: Awaited<ReturnType<Households['open']>>;
    try {
      store = await households.open(id);
    } catch (err) {
      // Passed over, as the registry's own loop passes it: one log that cannot be read does not stop boot.
      console.warn(`[budget] ${id}: could not be opened, so its folder is not carried over (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (store.state.documents.folder) continue;
    const clean = cleanFolder(carriedFolder(root, id));
    if ('problem' in clean) {
      console.warn(`[budget] ${id}: its files cannot be carried over from ${root} (${clean.problem}); the owner chooses in Settings`);
      continue;
    }
    if (!namesAFile(await store.since(null), clean)) continue;
    const holder = takenBy(clean, id);
    if (holder !== null) {
      console.warn(`[budget] ${id}: ${nasPathOf(clean)} is taken by another household, so its folder is not carried over; the owner chooses in Settings`);
      continue;
    }
    try {
      await store.append(SYSTEM, { op: 'documents.folder', team: clean.team, folder: clean.folder, source: 'deployment' });
    } catch (err) {
      console.warn(`[budget] ${id}: its folder ${nasPathOf(clean)} was not carried over (${err instanceof Error ? err.message : String(err)}); the owner chooses in Settings`);
      continue;
    }
    rememberFolder(id, clean);
    carried.push({ id, folder: clean });
  }
  return carried;
}
