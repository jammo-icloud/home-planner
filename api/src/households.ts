/**
 * Many households on one NAS.
 *
 * One log per household, in its own directory. There is no separate registry:
 * a household's log already records who claimed it and who they shared it with,
 * so asking the logs is asking the only source of truth. An index would be a
 * second copy of that, and the first time the two disagreed, someone would be
 * locked out of their own money by a stale file.
 *
 * Listing reads only the membership events — a cheap scan. Opening replays the
 * whole log and caches it, which happens when somebody actually looks.
 */

import { copyFile, link, mkdir, open, readFile, readdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { replay, replayLeavingOut } from './replay.ts';
import { newEventId, Store } from './store.ts';
import { scopeOf } from './restore.ts';
import { CONFIG_OPS, SYSTEM } from './types.ts';
import type { Actor, Event } from './types.ts';

/**
 * Turn a log's shelves into goals, if it still has one: true when it wrote the line.
 *
 * The one write no member asked for, so the log is copied beside itself first,
 * to `<log>.before-0.7.0`, and never over a copy already there: that copy is
 * the log as it was before any retirement, and an older build opens it. A copy
 * that cannot be made throws, and nothing is written; the caller's open fails.
 *
 * The copy is the owner's only way back, so it is whole or absent: written to
 * `<log>.before-0.7.0.partial`, synced, then linked to its name, which refuses
 * an existing file in one step. A crash mid-copy leaves only the partial file,
 * which the next attempt writes over and removes.
 */
export async function retireShelves(store: Store, copy: typeof copyFile = copyFile): Promise<boolean> {
  if (![...store.state.plans.values()].some((p) => !p.removed && p.parent !== null)) return false;
  const kept = `${store.path}.before-0.7.0`;
  const partial = `${kept}.partial`;
  try {
    await copy(store.path, partial);
    const fh = await open(partial, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
    try {
      await link(partial, kept);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  } finally {
    await rm(partial, { force: true });
  }
  await store.append(SYSTEM, { op: 'shelves.retire' });
  return true;
}

export interface HouseholdInfo {
  readonly id: string;
  readonly label: string;
  readonly owner: Actor | null;
  readonly members: readonly Actor[];
  /** Bytes on disk. Enough for an admin to see what is worth reclaiming. */
  readonly size: number;
  readonly lastActivity: string | null;
}

/** A household id is a directory name, so it may only be one. */
export const isValidId = (id: string): boolean => /^[a-z0-9][a-z0-9-]{0,38}$/.test(id);

export const slugify = (label: string): string =>
  label.toLowerCase()
    // Apostrophes disappear rather than becoming separators: "Mum's" is one
    // word to a person, and "mum-s" reads like a mistake.
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 39)
  || `household-${Date.now().toString(36)}`;

export class Households {
  readonly dir: string;
  #open = new Map<string, Store>();
  /**
   * How many times each id has been removed. An `open()` notes it before its
   * load and compares after, so a load that straddles a removal is never cached.
   */
  #removals = new Map<string, number>();

  constructor(dir: string) { this.dir = resolve(dir); }

  async ids(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    const entries = await readdir(this.dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && isValidId(e.name))
      .filter((e) => existsSync(join(this.dir, e.name, 'events.jsonl')))
      .map((e) => e.name)
      .sort();
  }

  path(id: string): string { return join(this.dir, id, 'events.jsonl'); }

  /**
   * Who is in each household, without replaying any of them.
   *
   * Only four event types decide membership, so this reads the file and ignores
   * everything else. A household with a hundred thousand receipts costs the same
   * to list as an empty one.
   */
  async list(): Promise<HouseholdInfo[]> {
    const out: HouseholdInfo[] = [];
    for (const id of await this.ids()) {
      const file = this.path(id);
      let text: string;
      try { text = await readFile(file, 'utf8'); } catch { continue; }

      let label = id;
      let owner: Actor | null = null;
      const members = new Set<Actor>();
      let lastActivity: string | null = null;

      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let e: Event;
        try { e = JSON.parse(line) as Event; } catch { continue; }
        lastActivity = e.at ?? lastActivity;
        if (e.op === 'household.claim') { owner = e.who; label = e.label; members.add(e.who); }
        else if (e.op === 'member.add') members.add(e.member);
        else if (e.op === 'member.remove') members.delete(e.member);
      }

      let size = 0;
      try { size = (await stat(file)).size; } catch { /* just reported as zero */ }
      out.push({ id, label, owner, members: [...members], size, lastActivity });
    }
    return out;
  }

  /** The households this person may actually open. */
  async forUser(who: Actor): Promise<HouseholdInfo[]> {
    return (await this.list()).filter((h) => h.members.includes(who));
  }

  /** Replayed and cached. The cache is disposable; the file is not. */
  async open(id: string): Promise<Store> {
    if (!isValidId(id)) throw new Error(`"${id}" is not a household id`);
    const cached = this.#open.get(id);
    if (cached) return cached;
    const generation = this.#removals.get(id) ?? 0;
    const store = new Store({ path: this.path(id) });
    await store.load();
    // Removed while this was loading: caching it would serve, and let a write
    // recreate, a log that is gone. The caller gets it closed, never cached.
    if ((this.#removals.get(id) ?? 0) !== generation) {
      store.close();
      return store;
    }
    // Before any request reads it. A throw here is the open failing, loudly.
    await retireShelves(store);
    this.#open.set(id, store);
    return store;
  }

  /**
   * A new household, claimed by whoever asked for it.
   *
   * The claim is the first event, so a household is never ownerless — there is
   * no window in which a directory exists that nobody can administer.
   */
  async create(who: Actor, label: string, opts: { id?: string } = {}): Promise<{ id: string; store: Store }> {
    const id = opts.id ?? slugify(label);
    if (!isValidId(id)) throw new Error(`"${id}" is not a usable household id`);
    if ((await this.ids()).includes(id)) throw new Error(`a household called "${id}" already exists`);

    await mkdir(join(this.dir, id), { recursive: true });
    const store = new Store({ path: this.path(id) });
    await store.load();
    await store.append(who, { op: 'household.claim', label });
    await retireShelves(store);
    this.#open.set(id, store);
    return { id, store };
  }

  /**
   * Write a whole log at once, for a restore that brings its own history.
   *
   * Who holds the file decides what comes with it. When it is the backup's
   * owner, this is someone restoring their own household: the people come too,
   * in their own order, and the backup's claim stays where it was, carrying
   * the new label. It is the same person, so the fold takes it, and every
   * member and every plan comes back.
   *
   * When it is someone else, the people are left behind. Membership is the one
   * band of the model that is local to a server: those names are DSM accounts
   * on the machine the backup came from, and they may not exist here. What
   * travels is the money — facts, budget and months — under a claim by
   * whoever holds the file, written before every carried line so their own
   * lines and the money fold. A carried line the fold still refuses because
   * its author, or whom it asks or hands a plan to, is not a member here is
   * left out. Once one has been, a later plan, conversation or booking line
   * the fold refuses is left out too: it may lean on what went (a plan, a
   * guest, an appointment, a goal), and no list of what leans on what would
   * stay complete. It is counted apart, in words that do not claim why.
   * Which lines, and how many, is decided by folding, not by guessing. Nobody's
   * `who` is rewritten. A refusal of a money or settings line, or any refusal
   * before something was left out, is a broken backup, and fails the restore
   * with nothing written.
   *
   * The household's own choices are the owner's, and the backup's owner may not
   * be this one: left in, the fold would refuse them and the log would not load.
   * So every CONFIG_OPS event is left out, and the time zone and the envelope
   * model, which are about the family rather than the machine, are written again
   * by the new owner once they hold the claim. The folder for documents and the
   * booking switch are not carried: no two households share a folder, and
   * friends book with one household at a time. The answer says what was done.
   *
   * The log lands whole or not at all (a temporary file, then a rename), and
   * only once the lines that stand have been replayed whole in memory.
   * Refuses to land on top of an existing household: overwriting somebody's
   * ledger is not something a file upload should be able to do by accident.
   */
  async createFromLog(who: Actor, label: string, events: Event[], opts: { id?: string } = {}):
  Promise<{ id: string; store: Store; summary: string[] }> {
    const id = opts.id ?? slugify(label);
    if (!isValidId(id)) throw new Error(`"${id}" is not a usable household id`);
    if ((await this.ids()).includes(id)) throw new Error(`a household called "${id}" already exists`);

    const claim = events.find((e) => e.op === 'household.claim');
    let lines: Event[];
    if (claim?.op === 'household.claim' && claim.who === who) {
      lines = events.filter((e) => !CONFIG_OPS.has(e.op)).map((e) => (e === claim ? { ...claim, label } : e));
    } else {
      const taken = new Set(events.map((e) => e.id));
      let mine = newEventId();
      while (taken.has(mine)) mine = newEventId();
      const claimed = { id: mine, at: new Date().toISOString(), who, op: 'household.claim', label } as Event;
      lines = [claimed, ...events.filter((e) => scopeOf(e) !== 'people' && !CONFIG_OPS.has(e.op))];
    }

    // Who is not here, and what of theirs stays behind, in the order first met.
    const wrote = new Map<Actor, Event[]>();
    const toward = new Map<Actor, number>();
    let after = 0;
    const kept = replayLeavingOut(lines, (e, err) => {
      if (err.outsider !== undefined) {
        if (err.outsider === e.who) wrote.set(e.who, [...(wrote.get(e.who) ?? []), e]);
        else toward.set(err.outsider, (toward.get(err.outsider) ?? 0) + 1);
        return true;
      }
      const band = scopeOf(e);
      if ((wrote.size || toward.size) && (band === 'plans' || band === 'thread' || band === 'bookings')) {
        after++;
        return true;
      }
      return false;
    });
    replay(kept); // what will be on disk folds whole, or nothing is written

    await mkdir(join(this.dir, id), { recursive: true });
    const file = this.path(id);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    await rename(tmp, file);

    const store = new Store({ path: file });
    await store.load();

    const summary: string[] = [];
    const zone = events.findLast((e) => e.op === 'household.zone');
    if (zone?.op === 'household.zone') {
      await store.append(who, { op: 'household.zone', zone: zone.zone });
      summary.push(`kept the time zone, ${zone.zone}`);
    }
    const model = events.findLast((e) => e.op === 'envelopes.model');
    if (model?.op === 'envelopes.model') {
      await store.append(who, { op: 'envelopes.model', model: model.model });
      summary.push(`kept the envelope model, ${model.model ?? 'the default'}`);
    }
    if (events.some((e) => e.op === 'documents.folder' || e.op === 'documents.moved' || e.op === 'guests.booking')) {
      summary.push('The copy chooses its own folder for documents and starts with booking off: '
        + 'no two households share a folder, and friends book with one household at a time.');
    }
    const count = (n: number, kind: string) => `${n} ${kind}line${n === 1 ? '' : 's'}`;
    for (const [person, theirs] of wrote) {
      const kind = theirs.every((e) => scopeOf(e) === 'plans') ? 'plan '
        : theirs.every((e) => scopeOf(e) === 'bookings') ? 'booking ' : '';
      summary.push(`Left out ${count(theirs.length, kind)} written by ${person}, who is not a member here.`);
    }
    for (const [person, n] of toward) {
      summary.push(`Left out ${count(n, 'plan ')} asking or handing a plan to ${person}, who is not a member here.`);
    }
    if (after) summary.push(`Left out ${count(after, 'more ')} this household refused once those were gone.`);
    await retireShelves(store);
    this.#open.set(id, store);
    return { id, store, summary };
  }

  /** Forget the cached replay. The file is untouched. */
  forget(id: string): void { this.#open.delete(id); }

  /**
   * Delete a household: its directory, log and all.
   *
   * The one place the app deletes anything. Everywhere else a change is a new
   * event and the past stays readable; this ends the past. It is allowed because
   * the owner asked for exactly this, by typing the household's name back, and
   * a backup taken first is the way back. Whether `who` may is the route's
   * question, as it is for create and open.
   *
   * The id must be a directory name before it is joined to anything, so no
   * path from a request can reach outside the households folder. Before the
   * directory goes: the removal is counted, so an `open()` already loading it
   * is not cached; the cached store is closed, so a request already holding
   * it cannot write and bring the directory back; and the cache is forgotten,
   * so nothing serves the replay of a log that is gone and a household made
   * again under the same name starts from an empty one.
   *
   * If the rm fails partway, the cache is already forgotten, the owner gets a
   * 500, and sessions keep the id. That is acceptable: every next request
   * re-reads membership from whatever is left on disk.
   */
  async remove(id: string): Promise<void> {
    if (!isValidId(id)) throw new Error(`"${id}" is not a household id`);
    this.#removals.set(id, (this.#removals.get(id) ?? 0) + 1);
    this.#open.get(id)?.close();
    this.forget(id);
    await rm(join(this.dir, id), { recursive: true, force: true });
  }
}

export interface Adoption {
  readonly id: string;
  readonly owner: Actor;
  /** The admin was made a member, because the owner may not be able to sign in. */
  readonly addedAdmin: Actor | null;
  /** Nobody may be able to open this: no admin was configured to fall back on. */
  readonly ownerless: boolean;
}

/**
 * Bring a pre-many-households install forward.
 *
 * An install from before this existed has its whole budget in one log, claimed
 * by whatever name that single-user server ran under — which need not be a DSM
 * account that exists on this NAS. Left alone, the sign-in succeeds and the
 * household list comes back empty, with the money on disk and nothing able to
 * open it.
 *
 * So the administrator is added as a member. That adds membership rather than
 * rewriting the claim: the log still records who claimed it, and the addition is
 * an ordinary event anyone can read. It is deliberately narrow — only here, only
 * when they are not already a member. Being an admin is not otherwise a way into
 * a household.
 *
 * Does nothing if any household already exists: adoption is a one-time move, and
 * running it twice would be a second copy of the same money.
 */
export async function adoptSingleLog(
  households: Households,
  logPath: string,
  admin: Actor | null,
): Promise<Adoption | null> {
  if ((await households.ids()).length) return null;
  if (!existsSync(resolve(logPath))) return null;

  const old = new Store({ path: logPath });
  await old.load();
  if (!old.state.owner) return null;

  const id = slugify(old.state.label || 'household');
  await mkdir(join(households.dir, id), { recursive: true });
  await copyFile(resolve(logPath), households.path(id));

  const store = await households.open(id);
  const owner = store.state.owner!;
  if (admin && !store.state.members.has(admin)) {
    // Authored by the owner because only the owner may add a member, and that
    // invariant is worth more than this one migration. What the log cannot say
    // is that the server did this rather than the person — the caller says so.
    await store.append(owner, {
      op: 'member.add', member: admin,
      why: `added by the server when this log was adopted as a household, so that ${admin} `
        + `can open it — it was claimed by ${owner}, which may not be an account on this machine`,
    });
    return { id, owner, addedAdmin: admin, ownerless: false };
  }
  return { id, owner, addedAdmin: null, ownerless: !admin };
}
