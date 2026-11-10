import { build, ordered } from '../src/thread.ts';
import type { ThreadEntry, WaitingItem } from '../src/thread.ts';
import { waiting } from '../src/offers.ts';
import type { Waiting } from '../src/offers.ts';
import type { Store } from '../src/store.ts';
import type { Actor } from '../src/types.ts';

/** Every entry the viewer can see, newest day first, and what waits on them: what the old thread() answered before any narrowing. */
export async function everyEntry(s: Store, who: Actor): Promise<{ entries: ThreadEntry[]; waiting: Waiting[] | WaitingItem[] }> {
  const events = await s.since(null);
  return { entries: ordered(build(events, s.state, who)), waiting: waiting(s.state, who, events) };
}
