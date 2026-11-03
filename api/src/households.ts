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

import { copyFile, mkdir, readFile, readdir, stat, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Store } from './store.ts';
import { scopeOf } from './restore.ts';
import { CONFIG_OPS } from './types.ts';
import type { Actor, Event } from './types.ts';

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
    const store = new Store({ path: this.path(id) });
    await store.load();
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
    this.#open.set(id, store);
    return { id, store };
  }

  /**
   * Write a whole log at once, for a restore that brings its own history.
   *
   * The people in the backup are left behind on purpose. Membership is the one
   * band of the model that is local to a server: those names are DSM accounts
   * on the machine the backup came from, and they may not exist here. What
   * travels is the money — facts, budgets and months. Who may see it is decided
   * again, here, starting with whoever holds the file.
   *
   * The household's own choices are the owner's, and the backup's owner is not
   * this one: left in, the fold would refuse them and the log would not load.
   * So every CONFIG_OPS event is left out, and the time zone and the envelope
   * model, which are about the family rather than the machine, are written again
   * by the new owner once they hold the claim. The folder for documents and the
   * booking switch are not carried: no two households share a folder, and
   * friends book with one household at a time. The answer says what was done.
   *
   * Refuses to land on top of an existing household: overwriting somebody's
   * ledger is not something a file upload should be able to do by accident.
   */
  async createFromLog(who: Actor, label: string, events: Event[], opts: { id?: string } = {}):
  Promise<{ id: string; store: Store; summary: string[] }> {
    const id = opts.id ?? slugify(label);
    if (!isValidId(id)) throw new Error(`"${id}" is not a usable household id`);
    if ((await this.ids()).includes(id)) throw new Error(`a household called "${id}" already exists`);

    await mkdir(join(this.dir, id), { recursive: true });
    const file = this.path(id);
    const carried = events.filter((e) => scopeOf(e) !== 'people' && !CONFIG_OPS.has(e.op));
    const tmp = `${file}.tmp`;
    await writeFile(tmp, carried.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    await rename(tmp, file);

    const store = new Store({ path: file });
    await store.load();
    await store.append(who, { op: 'household.claim', label });

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
    this.#open.set(id, store);
    return { id, store, summary };
  }

  /** Forget the cached replay. The file is untouched. */
  forget(id: string): void { this.#open.delete(id); }
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
