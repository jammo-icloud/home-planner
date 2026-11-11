/**
 * The append-only log on disk, and the derived state in memory.
 *
 * One file, one line per event, never rewritten. State is a replay held in RAM
 * and rebuilt on boot — so the cache is disposable and the file is the only
 * thing that has to survive. Two people appending can't collide because nothing
 * is ever updated in place; the log just grows and the later event wins.
 */

import { appendFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { apply, replay, validate, requireReason, ReplayError } from './replay.ts';
import { ToolError } from './errors.ts';
import type { Actor, Event, NewEventShape, State } from './types.ts';

/** An event as callers write it: the store stamps id, timestamp and actor. */
export type NewEvent = NewEventShape;

export interface StoreOptions {
  /** Path to the log. Defaults to `data/events.jsonl` beside the package. */
  path?: string;
  /** Injected so tests are deterministic and replay stays reproducible. */
  now?: () => Date;
}

export interface LoadReport {
  events: number;
  skipped: { line: number; reason: string }[];
}

/**
 * The id sequence, one for the whole process rather than one per store. Every
 * household's log is a store, and two of them writing in the same millisecond
 * would otherwise both hand out `<ms>-000001`: harmless in either log alone,
 * but a backup of one restored into the other is refused for the colliding id.
 * Each store, on loading or adopting, moves it past the ids it holds.
 */
let seq = 0;

/** A new event id: sortable, collision-free within a process, and readable in the raw file. */
export function newEventId(now: Date = new Date()): string {
  return `${now.getTime().toString(36)}-${String(++seq).padStart(6, '0')}`;
}

/** Keep the sequence past an id already in a log. */
function pastId(id: string): void {
  const n = Number(id.split('-').at(-1));
  if (Number.isFinite(n) && n > seq) seq = n;
}

export class Store {
  readonly path: string;
  #now: () => Date;
  #state: State;
  /** Serialises appends. One process, so a promise chain is the whole story. */
  #tail: Promise<unknown> = Promise.resolve();
  #report: LoadReport = { events: 0, skipped: [] };
  /**
   * Set when the household this log belongs to has been removed. Every write
   * checks it before touching the disk, because each one starts with a mkdir
   * that would otherwise bring the deleted directory back with a log that has
   * no claim in it: a household nobody can see that still holds the name.
   */
  #closed = false;

  constructor(opts: StoreOptions = {}) {
    this.path = resolve(opts.path ?? 'data/events.jsonl');
    this.#now = opts.now ?? (() => new Date());
    this.#state = replay([]);
  }

  get state(): State { return this.#state; }
  get loadReport(): LoadReport { return this.#report; }
  get closed(): boolean { return this.#closed; }

  /** No more writes, ever: the household is gone. Reads of what is in memory still answer. */
  close(): void { this.#closed = true; }

  /** A 409, so a request that was already on its way when the household went answers that, not a 500. */
  #refuseIfClosed(): void {
    if (this.#closed) throw new ToolError('this household was removed', 409);
  }

  /**
   * Read the whole log and replay it.
   *
   * A malformed line is skipped and reported rather than fatal: a half-written
   * final line after a crash must not take the budget down, and losing the last
   * event is recoverable in a way "the app won't start" is not.
   */
  async load(): Promise<LoadReport> {
    const report: LoadReport = { events: 0, skipped: [] };
    if (!existsSync(this.path)) {
      this.#state = replay([]);
      this.#report = report;
      return report;
    }
    const text = await readFile(this.path, 'utf8');
    const events: Event[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!.trim();
      if (!raw) continue;
      let parsed: Event;
      try {
        parsed = JSON.parse(raw) as Event;
      } catch {
        report.skipped.push({ line: i + 1, reason: 'unparseable JSON' });
        continue;
      }
      try {
        validate(parsed);
      } catch (err) {
        report.skipped.push({ line: i + 1, reason: (err as Error).message });
        continue;
      }
      events.push(parsed);
    }
    this.#state = replay(events);
    // Continue the id sequence past whatever is already on disk.
    for (const e of events) pastId(e.id);
    report.events = events.length;
    this.#report = report;
    return report;
  }

  /** Sortable, collision-free within a process (across every household's log), and readable in the raw file. */
  #id(): string {
    return newEventId(this.#now());
  }

  /**
   * Append events and advance state.
   *
   * Validated before anything touches the disk, and written as one call so a
   * partial batch can't land. Appends are serialised, so concurrent callers
   * queue rather than interleave.
   */
  async append(who: Actor, events: NewEvent | NewEvent[]): Promise<Event[]> {
    const batch = Array.isArray(events) ? events : [events];
    if (batch.length === 0) return [];

    const run = async (): Promise<Event[]> => {
      // Checked when the queued write runs, not when it was asked for: it may have waited behind the removal.
      this.#refuseIfClosed();
      const at = this.#now().toISOString();
      const stamped = batch.map((e) => ({ id: this.#id(), at, who, ...e }) as Event);

      // Validate the whole batch, and dry-run the replay, before writing.
      // A rejected batch must leave both the file and memory untouched.
      for (const e of stamped) { validate(e); requireReason(e); }
      const next = apply(this.#state, stamped);

      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, stamped.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

      this.#state = next;
      return stamped;
    };

    const queued = this.#tail.then(run, run);
    this.#tail = queued.catch(() => undefined);
    return queued;
  }

  /**
   * Append events that already happened, verbatim.
   *
   * The counterpart to `append` for a restore. Three things differ, and all
   * three follow from the same fact — these events are history, not decisions
   * being made now:
   *
   *  - id, timestamp and actor are kept. Re-stamping would date a receipt from
   *    March to today and attribute it to whoever pressed the button, which is
   *    a lie about who spent the money and when.
   *  - `requireReason` does not run. It is a write-time guard on a new choice;
   *    a note cannot be invented years later for a deletion someone else made,
   *    and demanding one would make old logs unrestorable.
   *  - ids are checked for collision instead of generated. A duplicate id would
   *    make two different events indistinguishable in a file that is only ever
   *    read back by id.
   *
   * The replay rules still apply in full: a batch that would not fold is
   * refused, and neither the file nor memory is touched.
   */
  async adopt(events: Event[]): Promise<Event[]> {
    if (events.length === 0) return [];

    const run = async (): Promise<Event[]> => {
      this.#refuseIfClosed();
      const here = await this.ids();
      for (const e of events) {
        validate(e);
        if (here.has(e.id)) throw new ReplayError(`event ${e.id} is already in this log`);
      }
      const next = apply(this.#state, events);

      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

      this.#state = next;
      // Keep generating ids past anything just adopted, or the next new event
      // could be handed an id one of these already holds.
      for (const e of events) pastId(e.id);
      return events;
    };

    const queued = this.#tail.then(run, run);
    this.#tail = queued.catch(() => undefined);
    return queued;
  }

  /**
   * Every event id in the log on disk, as `adopt` checks a restore against.
   * Read from the file, not kept in memory: it is asked only when restoring.
   */
  async ids(): Promise<ReadonlySet<string>> {
    const here = new Set<string>();
    if (!existsSync(this.path)) return here;
    for (const line of (await readFile(this.path, 'utf8')).split('\n')) {
      const raw = line.trim();
      if (!raw) continue;
      try { here.add((JSON.parse(raw) as Event).id); } catch { /* reported by load() */ }
    }
    return here;
  }

  /** Events since a given id, for "what changed since you last looked". */
  async since(eventId: string | null): Promise<Event[]> {
    if (!existsSync(this.path)) return [];
    const text = await readFile(this.path, 'utf8');
    const all: Event[] = [];
    for (const line of text.split('\n')) {
      const raw = line.trim();
      if (!raw) continue;
      try { all.push(JSON.parse(raw) as Event); } catch { /* reported by load() */ }
    }
    if (!eventId) return all;
    const i = all.findIndex((e) => e.id === eventId);
    return i < 0 ? all : all.slice(i + 1);
  }

  /** Replace the log wholesale. Only for seeding an empty install. */
  async seed(events: Event[]): Promise<void> {
    this.#refuseIfClosed();
    if (existsSync(this.path)) {
      const existing = await readFile(this.path, 'utf8');
      if (existing.trim()) throw new ReplayError('refusing to seed over an existing log');
    }
    for (const e of events) validate(e);
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    await rename(tmp, this.path);
    await this.load();
  }
}
