// api/src/docs.ts
//
// Documents are prose a person reads. A briefing, one of Claude's answers, a
// plan: each is a markdown page in Drive that opens in any editor and makes
// sense there. The frontmatter at the top is for the app (it says what the page
// is and what it answers); everything under it is for people, and is all a
// reader needs. The app never puts anything in the body that a person would
// have to skip.
//
// This file is the pages themselves, as pure functions: what to write for a
// briefing or an answer, and the way back from the page to its words. Same
// input, same bytes; there is no timestamp in a page, so writing it again
// changes nothing.
//
// The rest is the way to and from Drive. A page is written to the member's own
// Synology Drive session, under the folder the household's owner chose for its
// documents (nothing is written until there is one); the effect comes first,
// and the log's record of it only after, so a page the NAS did not take is
// never recorded as kept. The sid goes only as the cookie `drive.ts` sends:
// not in a URL, a log line or a file.

import { ToolError } from './errors.ts';
import { segment } from './attachments.ts';
import { byLink, isNoSuchFile, listTeamFolders, readFile, writeFile } from './drive.ts';
import type { DriveFile } from './drive.ts';
import { drivePathOf, nasPathOf } from './folders.ts';
import { renderFrontmatter, parseFrontmatter } from './frontmatter.ts';
import { SessionLost, SynologyError, createFolder, requireSid } from './synology.ts';
import type { DsmFetch } from './synology.ts';
import { PAGE_FORMAT } from './types.ts';
import type { BriefingSource, Day, DocRef, DocumentsFolder, EventId, PlanId, State } from './types.ts';

/** The file a briefing is kept in: its day and its source. */
export const briefingFile = (day: Day, source: BriefingSource): string => `${day}-${source}.md`;

/** A heading is one line: whatever line breaks the words had are spaces. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The words under the page's `# heading`, from the text after the frontmatter: the heading and the blank line below it are not part of them. */
function underHeading(page: string): string {
  const rest = parseFrontmatter(page)?.body ?? page;
  const nl = rest.indexOf('\n');
  if (!rest.startsWith('# ') || nl === -1) return rest;
  return rest.slice(nl + 1).replace(/^\n/, '');
}

/** The page for one briefing: its headline as the heading, its body under it. */
export function renderBriefingPage(b: {
  day: Day; source: BriefingSource; writtenBy: 'claude' | 'fallback'; headline: string; body: string;
}): string {
  const front = renderFrontmatter('briefing', {
    planner: PAGE_FORMAT, kind: 'briefing', day: b.day, source: b.source, writtenBy: b.writtenBy,
  });
  return `${front}# ${oneLine(b.headline)}\n\n${b.body}\n`;
}

/** The body a briefing page was written from. */
export function briefingBodyFrom(page: string): string {
  return underHeading(page).replace(/\n$/, '');
}

const TOOLS = '\n## Tools\n';

/**
 * The page for one answer: the question as the heading, the answer under it,
 * and the tools Claude used to get there, once each in the order it first used
 * them. With none, there is no Tools section.
 */
export function renderAnswerPage(a: {
  replyTo: EventId; plan: PlanId | null; model: string; question: string; text: string; tools: readonly string[];
}): string {
  const front = renderFrontmatter('answer', {
    planner: PAGE_FORMAT, kind: 'answer', replyTo: a.replyTo, plan: a.plan, model: a.model,
  });
  const tools = [...new Set(a.tools)];
  const used = tools.length === 0 ? '' : `${TOOLS}${tools.map((t) => `- ${t}\n`).join('')}`;
  return `${front}# ${oneLine(a.question)}\n\n${a.text}\n${used}`;
}

/**
 * The text an answer page was written from: between the heading and the Tools
 * section. The last `## Tools` heading is the page's own only when what follows
 * is the list the renderer writes (every non-empty line a `- <name>` item);
 * anything else is the answer's words, and they are returned whole.
 */
export function answerTextFrom(page: string): string {
  const under = underHeading(page);
  const at = under.lastIndexOf(TOOLS);
  const lines = at === -1 ? [] : under.slice(at + TOOLS.length).split('\n').filter((l) => l !== '');
  const isList = lines.length > 0 && lines.every((l) => /^- \S/.test(l));
  return (isList ? under.slice(0, at) : under).replace(/\n$/, '');
}

/** How much of an answer the thread shows before the page is the place to read the rest. */
export const ANSWER_HEADLINE_MAX = 280;

/** An answer's first paragraph; past the max it is cut at a word and ends with `…`. */
export function answerHeadline(text: string): string {
  const first = (text.trim().split(/\n[ \t]*\n/)[0] ?? '').trim();
  if (first.length <= ANSWER_HEADLINE_MAX) return first;
  const room = first.slice(0, ANSWER_HEADLINE_MAX);
  if (/\s/.test(first[ANSWER_HEADLINE_MAX]!)) return `${room.trimEnd()}…`;
  const lastSpace = room.search(/\s\S*$/);
  return `${(lastSpace > 0 ? room.slice(0, lastSpace) : room).trimEnd()}…`;
}

// ─── to and from Drive ───────────────────────────────────────────────────────

/** Who is asking, and for which household: the session id, the household, and its state, which says where its folder is. */
export interface DocAccess { readonly sid: string | null; readonly household?: string; readonly store: { readonly state: State } }

/** A file as the log remembers it: the link to read it by, and what it was when written. */
export const toDocRef = (f: DriveFile): DocRef => ({
  // `display_path`, the whole /team-folders/<team>/… path: Drive's `path` is relative to the Team Folder.
  link: f.permanent_link, file_id: f.file_id, hash: f.hash, version_id: f.version_id, path: f.display_path,
});

/** A document as it is now: followed through every move the log has recorded. */
export const currentDoc = (state: State, doc: DocRef): DocRef => state.documents.relinked.get(doc.link) ?? doc;

/** The household's folder as Drive addresses it, or null until one is chosen. */
export const householdFolder = (state: State): string | null =>
  state.documents.folder ? drivePathOf(state.documents.folder) : null;

/**
 * Under the chosen folder; while files wait to move, under the folder being
 * left too, since a file not moved yet is still this household's. A link kept
 * in a household restored as a copy on the same NAS still names the original
 * household's file: that file is not this household's to read, diff or write
 * over.
 */
export function inHousehold(file: DriveFile, state: State): boolean {
  const { folder, previous, waiting } = state.documents;
  const homes: DocumentsFolder[] = [];
  if (folder) homes.push(folder);
  if (previous && waiting.size) homes.push(previous);
  // Only `display_path` is the whole /team-folders/<team>/… path; Drive's `path`
  // is relative to the Team Folder (the real NAS, 2026-11-03).
  return homes.some((c) => file.display_path.startsWith(`${drivePathOf(c)}/`));
}

/** The folders already made in this process, by File Station path: asking again is a call saved. */
const made = new Set<string>();

/**
 * Folder first (File Station createFolder, once per process per folder), then the
 * versioned write. Null for no folder, sid or household, or any refusal; a refusal
 * is logged with the path and the NAS's words, never the sid.
 */
export async function writeDoc(
  a: DocAccess, rel: readonly [folder: string, file: string], text: string, f?: DsmFetch,
): Promise<DocRef | null> {
  const out = await writeDocOrRefusal(a, rel, text, f);
  return out instanceof Error ? null : out;
}

/**
 * `writeDoc`, saying why when the NAS refused: the refusal in place of the
 * file, so a caller can tell a session that ended from a Drive that is down.
 * Null for no folder, sid or household, as `writeDoc`; null too, without
 * asking Drive, when this session was told, within the last ten minutes,
 * that the folder's Team Folder is not one.
 */
export async function writeDocOrRefusal(
  a: DocAccess, rel: readonly [folder: string, file: string], text: string, f?: DsmFetch,
): Promise<DocRef | SynologyError | ToolError | null> {
  const home = a.store.state.documents.folder;
  if (!home || !a.sid || !a.household) return null;
  // Only this session's own no: which Team Folders Drive lists depends on who asks.
  if (teamFolderKnown(a.sid, home.team) === false) return null;
  let path = rel.join('/');
  let folderPath: string | null = null;
  try {
    const [folder, file] = [segment(rel[0], 'a folder'), segment(rel[1], 'a file name')];
    path = `${drivePathOf(home)}/${folder}/${file}`;
    const parent = nasPathOf(home);
    folderPath = `${parent}/${folder}`;
    if (!made.has(folderPath)) {
      await createFolder(a.sid, parent, folder, f);
      made.add(folderPath);
    }
    return toDocRef(await writeFile(a.sid, path, text, f));
  } catch (err) {
    if (!(err instanceof SynologyError || err instanceof ToolError)) throw err;
    // The folder was deleted on the NAS since this process made it: the next write makes it again.
    if (folderPath && isNoSuchFile(err)) made.delete(folderPath);
    console.warn(`[docs] kept in the log: ${path} (${err.message})`);
    return err;
  }
}

/** A page that Drive no longer has, said for the person reading it. */
export class DocGone extends ToolError {
  constructor(message = 'that page is not in Synology Drive any more; the full text is on the old NAS') {
    super(message, 404);
    this.name = 'DocGone';
  }
}

/** The file's text, by link. NeedsDsm without a sid; DocGone when Drive has no such file. */
export async function readDoc(a: DocAccess, doc: DocRef, f?: DsmFetch): Promise<string> {
  const sid = requireSid(a);
  try {
    return await readFile(sid, byLink(doc.link), f);
  } catch (err) {
    if (isNoSuchFile(err)) throw new DocGone();
    throw err;
  }
}

const STATUS_TTL_MS = 10 * 60 * 1000;

/**
 * What each session was told of a Team Folder, by sid and team, and until
 * when. Drive lists the Team Folders the person asking can see, so one
 * member's answer is never another's. The sid never leaves memory.
 */
const told = new Map<string, { readonly answer: boolean; readonly until: number }>();

/** What this session learned of a Team Folder, kept with documentsStatus's answer: true, false, or null for not asked (or not lately). */
export function teamFolderKnown(sid: string, team: string): boolean | null {
  const key = `${sid}|${team}`;
  const it = told.get(key);
  if (!it) return null;
  if (it.until > Date.now()) return it.answer;
  told.delete(key);
  return null;
}

const SIGN_IN_AGAIN = 'Sign in again to keep briefings and answers in Synology Drive; until then they are kept in the log.';

/** Whether documents go to Drive for this person now, and if not, why they stay in the log. */
export async function documentsStatus(a: DocAccess, f?: DsmFetch): Promise<{ on: boolean; why: string | null }> {
  const state = a.store.state;
  const home = state.documents.folder;
  if (!home) {
    return {
      on: false,
      why: `Briefings and answers are kept in the log until ${state.owner ?? 'the owner'} chooses where documents live, in Settings.`,
    };
  }
  if (!a.sid) return { on: false, why: SIGN_IN_AGAIN };
  const now = Date.now();
  for (const [key, it] of told) if (it.until <= now) told.delete(key);
  const key = `${a.sid}|${home.team}`;
  // A yes is kept; a no is asked again, so a Team Folder enabled since is seen at once.
  if (told.get(key)?.answer === true) return { on: true, why: null };
  let names: string[];
  try {
    names = await listTeamFolders(a.sid, f);
  } catch (err) {
    if (!(err instanceof SynologyError || err instanceof ToolError)) throw err;
    // The session ended on the NAS: it is the member who must sign in again, not Drive that is down.
    if (err instanceof SessionLost) return { on: false, why: SIGN_IN_AGAIN };
    return { on: false, why: `Synology Drive did not answer (${err.message}); briefings and answers are kept in the log until it does.` };
  }
  if (!names.includes(home.team)) {
    told.set(key, { answer: false, until: now + STATUS_TTL_MS });
    return {
      on: false,
      why: `${home.team} is not a Team Folder in Synology Drive, so briefings and answers are kept in the log (DEPLOY.md, Documents in Synology Drive).`,
    };
  }
  told.set(key, { answer: true, until: now + STATUS_TTL_MS });
  return { on: true, why: null };
}
