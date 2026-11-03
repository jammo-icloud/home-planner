/**
 * Files on a card.
 *
 * A file on a card is a file on the NAS, uploaded with the member's own DSM
 * session to <the household's folder>/<plan>/<name>, the folder its owner chose
 * for its documents (none is taken until there is one). The log keeps its path,
 * name and size, never the bytes. Downloads come back through the app, with
 * the member's session, so a file is only ever served to someone who can open
 * the card.
 */

import { ToolError } from './errors.ts';
import { nasPathOf } from './folders.ts';
import { fresh, writePlan } from './plan-edits.ts';
import { PAGE_NAME } from './pages.ts';
import { livePlan, required } from './plan-rules.ts';
import { createFolder, downloadFile, requireSid, SynologyError, uploadFile } from './synology.ts';
import type { DsmFetch } from './synology.ts';
import type { ToolContext } from './tools.ts';
import { moveKey, segmentProblem } from './types.ts';
import type { Actor, Plan, PlanId, State } from './types.ts';

/**
 * The deployment's shared folder (`/Planner`), as DSM names it. Never where a
 * file goes: it is where a household that wrote files before there was a
 * choice is carried over from, and the picker's first suggestion.
 */
export const PLANNER_ROOT = process.env['PLANNER_ROOT']?.trim() || null;

/** The largest file a card takes, or hands back. */
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

/** What a member is told while the household has no folder for its documents. */
export const filesOff = (owner: Actor | null): string =>
  `Files on cards are off until ${owner ?? 'the owner'} chooses where documents live, in Settings.`;

/** One path segment, or a ToolError saying why it cannot be: `segmentProblem`'s rule, which the fold shares. */
export function segment(value: string, what: string): string {
  const problem = segmentProblem(value, what);
  if (problem) throw new ToolError(problem);
  return value;
}

/**
 * Where a plan's file lives on the NAS: in the plan's folder, in the folder
 * the household chose. Every part is checked, not only the name, so nothing
 * a log or a request holds can point outside the plan's own folder. With no
 * folder chosen, files are off, and the words say who can turn them on.
 */
export function attachmentPath(state: State, plan: PlanId, name: string): string {
  const folder = state.documents.folder;
  if (!folder) throw new ToolError(filesOff(state.owner), 409);
  return `${nasPathOf(folder)}/${segment(plan, 'the plan')}/${segment(name, 'a file name')}`;
}

/**
 * Where a card's file is now: the folder being left while it waits to move,
 * else the chosen folder. The card's path follows each move (the fold sets it
 * on `documents.moved`), so one already at its place in the chosen folder (put
 * back on the card since the choice) is read there. A File Station folder
 * path; with no folder chosen, files are off.
 */
export function attachmentFolder(state: State, plan: PlanId, name: string): string {
  const { folder, previous, waiting } = state.documents;
  if (!folder) throw new ToolError(filesOff(state.owner), 409);
  const now = nasPathOf(folder);
  if (previous && waiting.has(moveKey({ plan, name }))) {
    const a = state.plans.get(plan)?.attachments.find((x) => x.name === name);
    if (a?.path !== `${now}/${plan}/${name}`) return nasPathOf(previous);
  }
  return now;
}

/** A tool context that knows which household it is in; where its plans' folders are is in its state. */
export type FileContext = ToolContext & { readonly household: string };

const ALREADY_ON_CARD = 'a file with that name is already on this card';

/** Over the cap, said the same way going in and coming out. */
const tooBig = (what: string): ToolError =>
  new ToolError(`${what} is over ${ATTACH_MAX_BYTES / 1024 / 1024} MB, the most a card holds`, 413);

/**
 * Put a file on a card: its folder first (in the household's, made if this is
 * the first), then the bytes, then the line in the log. Nothing is written to the
 * log unless the NAS took the file, and nothing is ever written over: a name
 * already on the card is refused before the NAS is asked, and one still in the
 * plan's folder (taken off the card, which leaves it on the NAS) is refused by
 * the NAS and said as the same conflict.
 */
export async function attach(
  ctx: FileContext, id: PlanId, file: { name: string; bytes: Uint8Array }, f?: DsmFetch,
): Promise<Plan> {
  const p = livePlan(ctx.store.state, id);
  const path = attachmentPath(ctx.store.state, p.id, file.name);
  // The plan's own page lives in this folder in Drive; a file by that name would be written over it.
  if (file.name.toLowerCase() === PAGE_NAME) {
    throw new ToolError(`${PAGE_NAME} is the plan's own page in Drive; give this file another name`, 409);
  }
  if (p.attachments.some((a) => a.name === file.name)) throw new ToolError(ALREADY_ON_CARD, 409);
  const sid = requireSid(ctx);
  if (file.bytes.length > ATTACH_MAX_BYTES) throw tooBig(file.name);
  const folder = path.slice(0, path.lastIndexOf('/'));
  const parent = folder.slice(0, folder.lastIndexOf('/'));
  await createFolder(sid, parent, p.id, f);
  try {
    await uploadFile(sid, { folder, name: file.name, bytes: file.bytes, overwrite: false }, f);
  } catch (err) {
    // 414 is File Station's "already exists": a file taken off this card stays in its folder.
    if (err instanceof SynologyError && err.code === 414) {
      throw new ToolError('a file with that name is already in this card\'s folder on the NAS, from before it was '
        + 'taken off the card; give this one another name', 409);
    }
    throw err;
  }
  await writePlan(ctx, { op: 'plan.attach', plan: p.id, path, name: file.name, size: file.bytes.length });
  return fresh(ctx, p.id);
}

/** The attachment of that name on the plan, or a 404. */
function attachmentOf(p: Plan, name: string) {
  const a = p.attachments.find((x) => x.name === name);
  if (!a) throw new ToolError(`${p.title} has no file named ${name}`, 404);
  return a;
}

/** Take a file off a card, with a reason. The file itself stays on the NAS. */
export async function detach(ctx: ToolContext, id: PlanId, name: string, why: string): Promise<Plan> {
  const p = livePlan(ctx.store.state, id);
  const a = attachmentOf(p, name);
  await writePlan(ctx, { op: 'plan.detach', plan: p.id, path: a.path, why: required(why, 'why') });
  return fresh(ctx, p.id);
}

/**
 * A card's file, read from the NAS with the member's session, from wherever it
 * is now (`attachmentFolder`). Only a file on the card, only from the plan's
 * own folder, and never one over the cap: a size in the log over it is refused
 * before the NAS is asked, and the read itself stops at the cap.
 */
export async function readAttachment(
  ctx: FileContext, id: PlanId, name: string, f?: DsmFetch,
): Promise<{ name: string; bytes: Uint8Array }> {
  const state = ctx.store.state;
  const p = livePlan(state, id);
  if (!state.documents.folder) throw new ToolError(filesOff(state.owner), 409);
  const a = attachmentOf(p, name);
  if (a.size > ATTACH_MAX_BYTES) throw tooBig(a.name);
  const path = `${attachmentFolder(state, p.id, a.name)}/${segment(p.id, 'the plan')}/${segment(a.name, 'a file name')}`;
  const sid = requireSid(ctx);
  try {
    const { bytes } = await downloadFile(sid, path, f, { maxBytes: ATTACH_MAX_BYTES });
    return { name: a.name, bytes };
  } catch (err) {
    // 408 is File Station's "no such file": moved or deleted on the NAS since.
    if (err instanceof SynologyError && err.code === 408) {
      throw new ToolError(`${a.name} is no longer on the NAS at ${path}`, 404);
    }
    if (err instanceof SynologyError && err.status === 413) throw tooBig(a.name);
    throw err;
  }
}
