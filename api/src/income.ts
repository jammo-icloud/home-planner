/**
 * What comes in, and what it would do.
 *
 * Two ideas kept apart on purpose:
 *
 *   A SOURCE is part of the plan — a salary, recorded in the log like an
 *   envelope template. It says what arrives, how often, and whose it is.
 *
 *   A SCENARIO is a question. "What if one of us took a job at $3,500 a month"
 *   is arithmetic over the sources plus a hypothetical one, and it writes
 *   nothing. You can ask it as many times as you like and the log never knows.
 *
 * The calendar is the whole point. Paid every two weeks is 26 payments a year,
 * not 24, so two months in every year carry a third paycheque — real money that
 * people plan around badly because a monthly average hides it.
 */

import { ZERO, add, cents } from './money.ts';
import type { Cents } from './money.ts';
import type { Actor, Month, State } from './types.ts';

export type Frequency = 'monthly' | 'semimonthly' | 'biweekly' | 'weekly' | 'annual' | 'once';

export interface IncomeSource {
  readonly id: string;
  readonly label: string;
  /** Whose income it is — someone planning their own is the reason this exists. */
  readonly who: Actor;
  /** What arrives each time it is paid — not a monthly equivalent. */
  readonly amount: Cents;
  readonly frequency: Frequency;
  /** A real payday. Everything after is counted from here. */
  readonly anchor: string;
  /** Last month it pays, when it is known to stop. */
  readonly until?: Month;
}

const daysInMonth = (month: Month): number => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

const utc = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const DAY = 86_400_000;

/**
 * The paydays that actually fall in a month.
 *
 * Counted, never averaged. A biweekly salary anchored on a Friday lands three
 * times in some months, and that third payment is the difference between a
 * month that balances and one that does not.
 */
export function paydaysIn(source: IncomeSource, month: Month): string[] {
  if (source.until && month > source.until) return [];
  const first = utc(`${month}-01`);
  const last = utc(`${month}-${String(daysInMonth(month)).padStart(2, '0')}`);
  const anchor = utc(source.anchor);
  if (Number.isNaN(anchor)) return [];
  const out: string[] = [];
  const push = (t: number) => out.push(new Date(t).toISOString().slice(0, 10));

  switch (source.frequency) {
    case 'monthly': {
      // The anchor's day of the month, clamped so the 31st still pays in February.
      const day = Math.min(Number(source.anchor.slice(8, 10)), daysInMonth(month));
      if (anchor <= last) push(utc(`${month}-${String(day).padStart(2, '0')}`));
      return out;
    }
    case 'semimonthly': {
      // Twice a month, always: the anchor's day and the same day a fortnight on.
      const d1 = Math.min(Number(source.anchor.slice(8, 10)), daysInMonth(month));
      const d2 = Math.min(d1 + 15, daysInMonth(month));
      for (const d of [d1, d2]) {
        const t = utc(`${month}-${String(d).padStart(2, '0')}`);
        if (t >= anchor) push(t);
      }
      return out;
    }
    case 'biweekly':
    case 'weekly': {
      const step = source.frequency === 'weekly' ? 7 * DAY : 14 * DAY;
      // Walk forward from the anchor rather than computing an offset: the
      // arithmetic is obvious, and a household salary is never far from today.
      let t = anchor;
      if (t < first) t += Math.ceil((first - t) / step) * step;
      for (; t <= last; t += step) push(t);
      return out;
    }
    case 'annual': {
      if (source.anchor.slice(5, 7) === month.slice(5, 7) && utc(`${month}-01`) >= utc(`${source.anchor.slice(0, 7)}-01`)) {
        push(utc(`${month}-${source.anchor.slice(8, 10)}`));
      }
      return out;
    }
    case 'once':
      if (source.anchor.slice(0, 7) === month) push(anchor);
      return out;
  }
}

export const monthlyTotal = (source: IncomeSource, month: Month): Cents =>
  cents(paydaysIn(source, month).length * source.amount);

/** Every source given, the household's plus any hypothetical ones, for one month. */
export function incomeFor(
  sources: readonly IncomeSource[],
  month: Month,
): { total: Cents; lines: { source: IncomeSource; paydays: string[]; total: Cents }[] } {
  const lines = sources.map((source) => {
    const paydays = paydaysIn(source, month);
    return { source, paydays, total: cents(paydays.length * source.amount) };
  });
  return { total: lines.reduce((n, l) => add(n, l.total), ZERO), lines };
}

export const sourcesFor = (state: State): IncomeSource[] => [...state.incomeSources.values()];

/** The month after this one. Kept here so projection does not import a whole module. */
export function nextMonth(month: Month): Month {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export interface ProjectedMonth {
  readonly month: Month;
  readonly total: Cents;
  /** True when a fortnightly source paid three times — the month worth noticing. */
  readonly extraPayday: boolean;
  readonly lines: { label: string; who: Actor; paydays: number; total: Cents }[];
}

/**
 * Project forward from a month.
 *
 * Deliberately month by month rather than an annual figure divided by twelve.
 * The question a planner has to answer is "can we cover the plan in March",
 * and an average cannot answer it.
 */
export function project(
  sources: readonly IncomeSource[],
  from: Month,
  months: number,
): ProjectedMonth[] {
  const out: ProjectedMonth[] = [];
  let month = from;
  for (let i = 0; i < months; i++) {
    const { total, lines } = incomeFor(sources, month);
    out.push({
      month, total,
      extraPayday: lines.some((l) =>
        (l.source.frequency === 'biweekly' && l.paydays.length === 3)
        || (l.source.frequency === 'weekly' && l.paydays.length === 5)),
      lines: lines.filter((l) => l.paydays.length > 0).map((l) => ({
        label: l.source.label, who: l.source.who, paydays: l.paydays.length, total: l.total,
      })),
    });
    month = nextMonth(month);
  }
  return out;
}
