// api/src/pages.ts
//
// A plan's page: `plan.md`, beside the plan's files in Synology Drive. This is
// the deterministic render of a plan from replayed state, and the inverse
// read of what an editor has left there. The same state is always the same
// bytes (no timestamp), so a page that differs from its render has been edited.
//
// The body is fixed so it can be read back:
//
//   # <title>
//
//   <notes>            (only when the notes are not blank)
//
//   ## Checklist
//   - [x] done item
//   - [ ] open item
//
//   ## Files
//   - name
//
// The title is taken from the frontmatter; the H1 is for the eye. Notes are
// whatever lies between the H1 and the LAST `## Checklist` line, so notes with
// such a line of their own read back whole.
//
// The page follows the log, never the other way round: after a request that
// may have changed a plan has been answered, every page that is behind is
// written (`schedulePages`), and only then is `plan.doc` appended. Drive being
// down holds the pages back, never the plan.

import { inHousehold, writeDocOrRefusal } from './docs.ts';
import { byLink, getFile, isNoSuchFile } from './drive.ts';
import { ToolError } from './errors.ts';
import { renderFrontmatter, parseFrontmatter } from './frontmatter.ts';
import { cents } from './money.ts';
import { movePass } from './moves.ts';
import { pageView } from './plan-rules.ts';
import { replay } from './replay.ts';
import { oneAtATime, planKey } from './settings.ts';
import { SessionLost, SynologyError } from './synology.ts';
import type { DsmFetch } from './synology.ts';
import type { ToolContext } from './tools.ts';
import { PAGE_FIELDS, moveKey } from './types.ts';
import type {
  Event, EventId, FrontValue, PageChange, PageDrift, PageField, PageValue, PageView, Plan, PlanId, State,
} from './types.ts';

/** The page's file name, in the plan's folder. No attachment may take it (see `attach`). */
export const PAGE_NAME = 'plan.md';

const FILES = '\n## Files\n';

/** What the page says about itself: the view, and the last log event it reflects. */
export interface ParsedPage { readonly view: PageView; readonly event: EventId | null }

/** A plan's page, as bytes. The plan must exist (removed ones too: their page says so). */
export function renderPlanPage(state: State, id: PlanId): string {
  const p = state.plans.get(id);
  if (!p) throw new Error(`no such plan: ${id}`);
  const v = pageView(p);
  const front = renderFrontmatter('plan', {
    planner: 1, kind: 'plan', id: v.id, title: v.title, area: v.area, state: v.state,
    parent: v.parent, due: v.due, people: v.people, envelope: v.envelope, estimate: v.estimate, event: p.pageEvent,
  }, { estimate: 'cents, as everywhere', event: 'the last log event this page reflects' });
  const heading = `# ${v.title.replace(/\s+/g, ' ').trim()}\n\n`;
  const notes = v.notes.trim() === '' ? '' : `${v.notes}\n\n`;
  const checklist = v.checklist.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}\n`).join('');
  const files = v.files.map((f) => `- ${f}\n`).join('');
  return `${front}${heading}${notes}## Checklist\n${checklist}${FILES}${files}`;
}

/** Text, or a number an editor left unquoted; nothing else. */
function text(v: FrontValue | undefined): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}

/** A nullable text key: absent, `null` and an emptied `key:` (read as '') are all nothing. */
function nullableText(v: FrontValue | undefined): string | null | undefined {
  if (v === undefined || v === null || v === '') return null;
  return text(v) ?? undefined;
}

const STATES: ReadonlySet<string> = new Set(['planning', 'doing', 'done', 'removed']);

/**
 * The sections of the body, from after the H1 block; null when either heading
 * is gone. The renderer always writes both, so a missing one is a page broken
 * in an editor, never an emptied one. A heading may carry trailing spaces.
 */
function sections(body: string): { notes: string; checklist: string; files: string } | null {
  let at = -1;
  let len = 0;
  for (const m of body.matchAll(/\n## Checklist[ \t]*\n/g)) { at = m.index; len = m[0].length; }
  if (at === -1) return null;
  // Notes: after the H1 line and the blank line under it, less the one newline that ends them
  // (the heading's own match took the other).
  const head = body.slice(0, at);
  const afterH1 = head.startsWith('#') ? head.slice(head.indexOf('\n') + 1) : head;
  const notes = afterH1.replace(/^\n/, '').replace(/\n$/, '');
  const rest = body.slice(at + len);
  const f = /\n## Files[ \t]*(?:\n|$)/.exec(rest);
  if (!f) return null;
  return { notes, checklist: rest.slice(0, f.index + 1), files: rest.slice(f.index + f[0].length) };
}

/**
 * What a page says, or null when it cannot be read as a plan's page: no
 * frontmatter, a different kind, a version of the format this does not read, an
 * id, title, area or state that cannot be read, or a body missing its
 * `## Checklist` or `## Files` heading (the renderer always writes both, so a
 * missing one is a page broken in an editor, never an emptied one: reading it
 * as empty would offer to clear real notes, items and files). An emptied
 * nullable key (`parent:`, `due:`, `envelope:`, `estimate:`) reads as null, an
 * emptied `people:` as no one. Windows line endings read as the same page.
 */
export function parsePlanPage(source: string): ParsedPage | null {
  const fm = parseFrontmatter(source.replaceAll('\r\n', '\n'));
  if (!fm) return null;
  const f = fm.values;
  if (f['kind'] !== 'plan' || f['planner'] !== 1) return null;

  const id = text(f['id']);
  const title = text(f['title']);
  const area = text(f['area']);
  const state = text(f['state']);
  const parent = nullableText(f['parent']);
  const due = nullableText(f['due']);
  const envelope = nullableText(f['envelope']);
  const event = nullableText(f['event']);
  if (!id || title === null || !area || !state || !STATES.has(state)) return null;
  if (parent === undefined || due === undefined || envelope === undefined || event === undefined) return null;

  const est = f['estimate'];
  let estimate: ReturnType<typeof cents> | null;
  if (est === undefined || est === null || est === '') estimate = null;
  else if (typeof est === 'number') estimate = cents(est);
  else return null;

  const ppl = f['people'];
  const people: string[] = ppl === undefined || ppl === null || ppl === '' ? []
    : typeof ppl === 'string' ? [ppl]
      : typeof ppl === 'number' ? [String(ppl)] : [...ppl];

  const s = sections(fm.body);
  if (!s) return null;
  const checklist: { text: string; done: boolean }[] = [];
  for (const line of s.checklist.split('\n')) {
    const m = /^[-*] \[([ xX])\] ?(.*?)\s*$/.exec(line);
    if (m) checklist.push({ text: m[2]!, done: m[1] !== ' ' });
  }
  const files: string[] = [];
  for (const line of s.files.split('\n')) {
    const m = /^[-*] (.*?)\s*$/.exec(line);
    if (m && m[1]) files.push(m[1]);
  }

  return {
    view: {
      id, title, area, state: state as PageView['state'], parent, due, people,
      envelope, estimate, notes: s.notes, checklist, files,
    },
    event,
  };
}

// ─── from Drive ──────────────────────────────────────────────────────────────

/**
 * The page as the app wrote it at `at`: the plan's view after replaying the log up to and including that
 * event. Null if either is unknown (or the plan was not yet made by then). Replays a slice of the log, so
 * the caller asks only for a file whose hash has moved.
 */
export function pageAt(events: readonly Event[], id: PlanId, at: EventId): PageView | null {
  const end = events.findIndex((e) => e.id === at);
  if (end === -1) return null;
  const p = replay(events.slice(0, end + 1)).plans.get(id);
  return p ? pageView(p) : null;
}

/** Trailing spaces off each line, three or more newlines to two, trimmed. */
export const normalizeNotes = (s: string): string =>
  s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

/** Whether two pages say the same thing in a field, by the field's own comparison. */
function same(field: PageField, a: PageView, b: PageView): boolean {
  switch (field) {
    case 'notes': return normalizeNotes(a.notes) === normalizeNotes(b.notes);
    case 'checklist':
      return a.checklist.length === b.checklist.length
        && a.checklist.every((x, i) => x.text.trim() === b.checklist[i]!.text.trim() && x.done === b.checklist[i]!.done);
    case 'people': case 'files': {
      const x = a[field];
      const y = b[field];
      return x.length === y.length && x.every((v, i) => v === y[i]);
    }
    default: return a[field] === b[field];
  }
}

/**
 * Three-way: a field is a change only where theirs differs from what was written (base), and the plan now
 * does not already say theirs. `from` is the plan now; `to` is theirs. Notes compare normalized; checklist
 * items compare by trimmed text and done, in order; frontmatter key order never matters. Every field is
 * diffed, the planner's own (parent, people, envelope, files) too: they are said, never taken.
 */
export function diffPage(base: PageView, theirs: PageView, now: PageView): PageChange[] {
  const changes: PageChange[] = [];
  for (const field of PAGE_FIELDS) {
    if (same(field, base, theirs) || same(field, now, theirs)) continue;
    changes.push({ field, from: now[field] as PageValue, to: theirs[field] as PageValue });
  }
  return changes;
}

// ─── to Drive ────────────────────────────────────────────────────────────────

/** The most pages written in one go: the rest wait for the next request. */
export const PAGE_BATCH = 25;

/** After Drive refuses a page, how long before it is asked for one again. */
export const PAGE_RETRY_MS = 10 * 60 * 1000;

/** Whether what the page in Drive shows is not the plan as the log has it now. */
export const pageBehind = (p: Plan): boolean => p.page === null || p.page.event !== p.pageEvent;

/** When Drive last refused a page, by store path. */
const lastRefused = new Map<string, number>();

/** Plans already said to have a file of their own called plan.md, by `${store.path}|${plan}`. */
const saidTaken = new Set<string>();

/** The newest follow-on for each store: `pagesIdle` waits on it, and every one before it. */
const following = new Map<string, Promise<void>>();

/**
 * Pages to write again by path whatever Drive has for them, by
 * `${store.path}|${plan}`; `checkPages` finds them: gone from Drive, or behind
 * the plan and written at an event the log cannot replay to, so nothing on
 * them can be said against what was written. In memory: a restart finds them again.
 */
const rebuild = new Set<string>();
const rebuildKey = (ctx: ToolContext, id: PlanId): string => `${ctx.store.path}|${id}`;

/** The follow-on writes this plan's page again by its path, without looking at what Drive has first. A page holds no decision, so nothing is asked. */
export function rebuildPage(ctx: ToolContext, id: PlanId): void {
  rebuild.add(rebuildKey(ctx, id));
}

/** Each store's last whole look at its pages (`checkPages`): the household folder's cursor then, and when it began. In memory. */
const pagesSeen = new Map<string, { cursor: string; at: number }>();
export const lastPagesLook = (path: string): { cursor: string; at: number } | undefined => pagesSeen.get(path);
export const rememberPagesLook = (path: string, cursor: string, at: number): void => { pagesSeen.set(path, { cursor, at }); };
/** The next `checkPages` looks at every page, whatever the cursor says. */
export const forgetPagesLook = (path: string): void => { pagesSeen.delete(path); };

/** The drift on a plan's page still waiting for a member's answer, with the id of the event that noted it. */
export function openPageDrift(state: State, id: PlanId): { id: EventId; drift: PageDrift } | null {
  for (const [at, d] of state.pageDrifts) if (d.plan === id && d.resolved === null) return { id: at, drift: d };
  return null;
}

/**
 * Whether the follow-on writes this plan's page: behind the log, or gone from
 * Drive. Never while an edit made to it in Drive waits on its card (writing
 * then would put the plan over what they wrote before anyone has chosen), nor
 * over a member's own file of that name, nor while the page waits to move to
 * a new folder (written first, it would be a second page there). A plan
 * removed before it ever had a page (before pages were written at all) gets none.
 */
const toWrite = (ctx: ToolContext, p: Plan): boolean =>
  !(p.removed && p.page === null)
  && (pageBehind(p) || rebuild.has(rebuildKey(ctx, p.id))) && !openPageDrift(ctx.store.state, p.id) && !nameTaken(ctx, p)
  && !(p.page && ctx.store.state.documents.waiting.has(moveKey(p.page.doc)));

/** Whether a page may be asked for at all: a session, a household, and a folder chosen for its documents. */
const canWrite = (ctx: ToolContext): boolean => !!ctx.sid && !!ctx.household && ctx.store.state.documents.folder !== null;

const backingOff = (path: string): boolean => {
  const at = lastRefused.get(path);
  return at !== undefined && Date.now() - at < PAGE_RETRY_MS;
};

/**
 * A file attached before plan.md was the page's name, in any case. It is the
 * member's own, so the page is never versioned over it; said once per process.
 */
function nameTaken(ctx: ToolContext, p: Plan): boolean {
  if (!p.attachments.some((a) => a.name.toLowerCase() === PAGE_NAME)) return false;
  const key = `${ctx.store.path}|${p.id}`;
  if (!saidTaken.has(key)) {
    saidTaken.add(key);
    console.warn(`[pages] ${p.id} has a file of its own called ${PAGE_NAME}; its page is not written over it`);
  }
  return true;
}

/**
 * Write one plan's page (by path, `<household>/<plan>/plan.md`), then append plan.doc as ctx.who. [] when skipped or refused.
 *
 * The plan's lock (the one every edit to it takes) covers only the read, the
 * skips and the render, never the upload: a member's edit must not wait on
 * Drive. That is safe because plan.doc records the pageEvent the page was
 * rendered from: an edit that lands during the upload moves the plan's
 * pageEvent past it, so the page stays behind and the next follow-on writes it
 * again. Page writes are already one at a time per household (`schedulePages`).
 *
 * A page the app has written before is looked at first (one GET by its link,
 * outside the lock for the same reason): the app never writes over an edit it
 * has not seen. Gone, it is written again by path; a hash other than the one
 * written is someone's edit, so nothing is written (not a refusal) and the
 * next `checkPages` looks at every page and asks about it. A page `checkPages`
 * marked to rebuild is written by path without the look, and so is one whose
 * link names a file outside this household's folder (a household restored as
 * a copy on the same NAS): that file is not this household's page.
 */
export async function writePlanPage(ctx: ToolContext, id: PlanId, f?: DsmFetch): Promise<Event[]> {
  return (await writeOne(ctx, id, f)).written;
}

/**
 * Drive refused: the follow-on backs off for everyone, unless it was this
 * member's session that ended, which says nothing of Drive. Either way the
 * batch stops.
 */
function refused(ctx: ToolContext, err: unknown): { written: Event[]; stop: true } {
  if (!(err instanceof SessionLost)) lastRefused.set(ctx.store.path, Date.now());
  return { written: [], stop: true };
}

/** `writePlanPage`, and whether the batch it is part of stops. */
async function writeOne(ctx: ToolContext, id: PlanId, f?: DsmFetch): Promise<{ written: Event[]; stop: boolean }> {
  if (!canWrite(ctx)) return { written: [], stop: false };
  const page = await oneAtATime(planKey(ctx.store.path, id), async () => {
    // Read after the wait: the change ahead of this one may have just landed.
    const p = ctx.store.state.plans.get(id);
    if (!p || !toWrite(ctx, p)) return null;
    const look = p.page && !rebuild.has(rebuildKey(ctx, id)) ? p.page.doc : null;
    return { text: renderPlanPage(ctx.store.state, id), event: p.pageEvent, look };
  });
  if (!page) return { written: [], stop: false };
  if (page.look) {
    try {
      const there = await getFile(ctx.sid!, byLink(page.look.link), f);
      // Another household's file is not looked at: written again by its path, here.
      if (inHousehold(there, ctx.store.state) && there.hash !== page.look.hash) {
        forgetPagesLook(ctx.store.path);
        return { written: [], stop: false };
      }
    } catch (err) {
      if (!(err instanceof SynologyError || err instanceof ToolError)) throw err;
      if (!isNoSuchFile(err)) {
        console.warn(`[pages] kept in the log: could not look at ${id}'s page in Drive before writing it (${err.message})`);
        return refused(ctx, err);
      }
      // Gone: written again by its path.
    }
  }
  const doc = await writeDocOrRefusal(ctx, [id, PAGE_NAME], page.text, f);
  if (!doc) return { written: [], stop: false };
  if (doc instanceof Error) return refused(ctx, doc);
  // By path, so a page that was gone is a file again, and plan.doc names it as it now is.
  const written = await ctx.store.append(ctx.who, { op: 'plan.doc', plan: id, doc, event: page.event });
  rebuild.delete(rebuildKey(ctx, id));
  return { written, stop: false };
}

/**
 * Every page that is behind or gone from Drive (or just `only`), oldest pageEvent first, at most PAGE_BATCH;
 * none waiting on a drift's card, and nothing within PAGE_RETRY_MS of a refusal.
 */
export async function followOn(ctx: ToolContext, f?: DsmFetch, only?: PlanId): Promise<Event[]> {
  if (!canWrite(ctx)) return [];
  const path = ctx.store.path;
  if (backingOff(path)) return [];
  // Event ids sort by time, so the oldest change waits least.
  const behind = [...ctx.store.state.plans.values()]
    .filter((p) => (only === undefined || p.id === only) && toWrite(ctx, p))
    .sort((a, b) => (a.pageEvent < b.pageEvent ? -1 : a.pageEvent > b.pageEvent ? 1 : 0))
    .slice(0, PAGE_BATCH);
  const written: Event[] = [];
  for (const p of behind) {
    const one = await writeOne(ctx, p.id, f);
    written.push(...one.written);
    // A refusal stops the batch: the rest would only be refused too.
    if (one.stop) break;
  }
  return written;
}

/** The documents still to move to a new folder (movePass), then followOn: after the response, one at a time per household, never thrown. */
export function schedulePages(ctx: ToolContext, only?: PlanId): void {
  if (!canWrite(ctx)) return;
  const path = ctx.store.path;
  const sid = ctx.sid!;
  const run = oneAtATime(`${path}|pages`, async () => {
    await movePass(ctx);
    return followOn(ctx, undefined, only);
  }).then(
    () => undefined,
    (err: unknown) => {
      const said = err instanceof Error ? err.message : String(err);
      console.warn(`[pages] the pages were not brought up to date: ${said.replaceAll(sid, '…')}`);
    },
  );
  following.set(path, run);
  void run.then(() => { if (following.get(path) === run) following.delete(path); });
}

/** Resolves once every follow-on scheduled so far for this store has finished. */
export function pagesIdle(path: string): Promise<void> {
  return following.get(path) ?? Promise.resolve();
}
