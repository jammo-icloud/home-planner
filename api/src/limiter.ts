/**
 * A sliding window of timestamps per key: how many times something was tried
 * lately, for the limits on the doors anyone can reach (a guest's sign-in, a
 * member's password). Memory only; a restart forgets it, which is the same
 * as waiting.
 */
export class Limiter {
  #hits = new Map<string, number[]>();
  readonly limit: number;
  readonly windowMs: number;
  constructor(limit: number, windowMs: number) { this.limit = limit; this.windowMs = windowMs; }

  #recent(key: string, now: number): number[] {
    const recent = (this.#hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length) this.#hits.set(key, recent); else this.#hits.delete(key);
    return recent;
  }

  /** Count one, if there is room: a request over the limit is refused and not counted. */
  take(key: string, now: number): boolean {
    const recent = this.#recent(key, now);
    if (recent.length >= this.limit) return false;
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }

  /** Give back a place taken at `at` (one taken before the outcome was known, that turned out not to count). */
  refund(key: string, at: number): void {
    const hits = this.#hits.get(key);
    const i = hits?.lastIndexOf(at) ?? -1;
    if (!hits || i < 0) return;
    hits.splice(i, 1);
    if (!hits.length) this.#hits.delete(key);
  }

  /** Whether the key has used its window up, without counting anything. */
  full(key: string, now: number): boolean {
    return this.#recent(key, now).length >= this.limit;
  }

  sweep(now: number): void {
    for (const [k, ts] of this.#hits) if (!ts.some((t) => t > now - this.windowMs)) this.#hits.delete(k);
  }
}
