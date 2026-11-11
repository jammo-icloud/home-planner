import { readFileSync } from 'node:fs';

import { snapshot, fixedCharges, lowEnvelopes, donors, monthClock } from '../src/analytics.ts';
import { monthView, openMonths } from '../src/envelopes.ts';
import type { Event, State } from '../src/types.ts';

/** Every figure the budget gives, in plain rows, so a field added to a type later does not alter them. */
export type Figures = { fixed: readonly unknown[]; months: Record<string, any> };

/** A fixture log by name, from ./fixtures/<name>.jsonl. */
export function readLog(name: string): Event[] {
  const text = readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8');
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Event);
}

/** The first of the next month, as a day. */
const nextFirst = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

const lastDay = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export function figuresOf(state: State): Figures {
  const months: Record<string, any> = {};
  for (const month of openMonths(state)) {
    for (const today of [`${month}-01`, `${month}-12`, lastDay(month), nextFirst(month)]) {
      const snap = snapshot(state, month, today);
      if (!snap) continue;
      const view = monthView(state, month)!;
      const clock = monthClock(month, today);
      const first = view.envelopes[0]?.envelope.id ?? '';
      months[`${month}/${today}`] = {
        pace: snap.pace.map((p) => [p.envelope, p.funded, p.spent, p.available, p.committed, p.stillExpected, p.discretionary, p.projected, p.projectedOver, p.status]),
        low: lowEnvelopes(snap.pace, 8).map((l) => [l.envelope, l.status, l.left, l.over]),
        donors: donors(view, clock, first, state).map((d) => [d.envelope, d.available, d.spare]),
      };
    }
  }
  return { fixed: fixedCharges(state).map((f) => [f.key, f.payee, f.envelope, f.typical, f.months]), months };
}
