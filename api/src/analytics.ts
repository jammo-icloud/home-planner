/**
 * Every number the briefing quotes.
 *
 * Deterministic and pure — `today` is always injected, never read from the
 * clock. Claude reads these, explains them and decides what's worth saying; it
 * never computes them. Financial figures have to be identical every time you
 * ask, and reproducible when you ask where one came from.
 */

import { ZERO, add, sub, cents, fmt, sum } from './money.ts';
import type { Cents } from './money.ts';
import { keptIn, monthView } from './envelopes.ts';
import type { EnvelopeView, MonthView } from './envelopes.ts';
import { fundedFor, plannedFor } from './replay.ts';
import { MONTHS_SHORT, SPLIT, isSpend, monthOf, partsOf, prevMonth } from './types.ts';
import type { BillDate, BillRecord, Day, EnvelopeId, Month, State, Txn, TxnId } from './types.ts';

// ─── the month's clock ────────────────────────────────────────────────────────

export interface MonthClock {
  readonly month: Month;
  readonly daysInMonth: number;
  readonly dayOfMonth: number;
  readonly daysLeft: number;
  /** 0..1. Drives every projection. */
  readonly elapsed: number;
  readonly complete: boolean;
}

export function monthClock(month: Month, today: Day): MonthClock {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const current = monthOf(today) === month;
  const past = today.slice(0, 7) > month;
  const dayOfMonth = current ? Number(today.slice(8, 10)) : past ? daysInMonth : 0;
  return {
    month, daysInMonth, dayOfMonth,
    daysLeft: Math.max(0, daysInMonth - dayOfMonth),
    elapsed: daysInMonth === 0 ? 0 : dayOfMonth / daysInMonth,
    complete: past || dayOfMonth >= daysInMonth,
  };
}

// ─── fixed monthly charges ────────────────────────────────────────────────────

export interface FixedCharge {
  /** Normalised payee and envelope together, so callers can match a receipt's part. */
  readonly key: string;
  readonly payee: string;
  readonly envelope: EnvelopeId;
  /** What it bills, averaged across the months it has been seen in. */
  readonly typical: Cents;
  readonly months: readonly Month[];
  /** The date of its latest receipt. */
  readonly lastDate: Day;
}

/**
 * Payees that bill once a month, every month, at about the same amount.
 *
 * The once-per-month test is what separates rent and the power bill from
 * groceries. Both recur, but only one of them is a commitment whose month-end
 * total is already known — a merchant charged eight times in July tells you
 * nothing about what the ninth will be.
 *
 * Deliberately tighter than `recurring()`, which exists to spot subscriptions
 * that crept in. Here a wrong answer suppresses a real overspend warning, so
 * two months is enough evidence to stop extrapolating but a month with two
 * charges in it disqualifies the payee outright.
 *
 * Grouped by payee AND envelope, because a bank descriptor is not always a
 * merchant. Rent and a $60 Zelle payment both arrive as "P2P PAYMENT"; keyed on
 * the descriptor alone the second one makes the month look double-billed and
 * rent starts extrapolating again. The envelopes they are sorted into are what
 * tell them apart; two sorted into one envelope are one charge seen twice.
 * Only whole receipts are charges: a split receipt is skipped here, as a share
 * of a bill is not the bill, though its parts still land and pay in `billsOf`.
 */
/** Empty when the part cannot be a fixed charge at all. */
export const chargeKey = (payee: string, envelope: string | null): string => {
  const p = normalisePayee(payee);
  return p && envelope ? `${p}|${envelope}` : '';
};

export function fixedCharges(
  state: State,
  opts: { minMonths?: number; tolerance?: number } = {},
): FixedCharge[] {
  const minMonths = opts.minMonths ?? 2;
  const tolerance = opts.tolerance ?? 0.15;

  interface Charge { readonly t: Txn; readonly envelope: EnvelopeId; readonly amount: number }
  const byPayee = new Map<string, Charge[]>();
  for (const t of state.txns.values()) {
    if (t.amount >= 0) continue;
    // transfers, income, splits and unsorted rows are not charges
    if (!isSpend(t.envelope)) continue;
    const key = chargeKey(t.payee, t.envelope);
    if (!key) continue;
    (byPayee.get(key) ?? byPayee.set(key, []).get(key)!).push({ t, envelope: t.envelope, amount: t.amount });
  }

  const out: FixedCharge[] = [];
  for (const [key, txns] of byPayee) {
    const perMonth = new Map<Month, Charge[]>();
    for (const c of txns) {
      const m = monthOf(c.t.date);
      (perMonth.get(m) ?? perMonth.set(m, []).get(m)!).push(c);
    }
    if (perMonth.size < minMonths) continue;
    // a month with two charges in it means this is not a fixed monthly bill
    if ([...perMonth.values()].some((rows) => rows.length !== 1)) continue;

    const amounts = txns.map((c) => Math.abs(c.amount));
    const typical = cents(amounts.reduce((a, b) => a + b, 0) / amounts.length);
    if (!amounts.every((a) => Math.abs(a - typical) <= typical * tolerance)) continue;

    out.push({
      key, payee: txns[0]!.t.payee, envelope: txns[0]!.envelope,
      typical: typical as Cents, months: [...perMonth.keys()].sort(),
      lastDate: txns.reduce((d, c) => (c.t.date > d ? c.t.date : d), txns[0]!.t.date),
    });
  }
  return out.sort((a, b) => b.typical - a.typical);
}

// ─── pace ─────────────────────────────────────────────────────────────────────

export interface Pace {
  readonly envelope: EnvelopeId;
  readonly label: string;
  readonly funded: Cents;
  readonly spent: Cents;
  readonly available: Cents;
  /** Spent so far on charges that arrive once a month at a known amount. */
  readonly committed: Cents;
  /** Committed bills this envelope expects that have not landed yet. */
  readonly stillExpected: Cents;
  /** Spent so far on everything else — the part that genuinely varies. */
  readonly discretionary: Cents;
  /** Month-end total: commitments at their known amount, the rest at this rate. */
  readonly projected: Cents;
  /** Positive means projected to finish over. */
  readonly projectedOver: Cents;
  readonly status: 'ok' | 'watch' | 'over' | 'projected-over';
}

/** An envelope on Today's money rail: what is left, or by how much it is over, as words the engine wrote. */
export interface LowEnvelope {
  readonly envelope: EnvelopeId;
  readonly label: string;
  readonly status: Pace['status'];
  readonly left: string;
  /** How far it is over, when it is; null when it is not. */
  readonly over: string | null;
}

/**
 * The envelopes Today's money rail lists, read from the same pace the
 * briefing is written from, so the two never disagree about what is short:
 * those over, then those projected to finish over, then the rest by least
 * left. One with nothing funded, or with all it was funded still in it, is
 * not low. At most `n`.
 */
export function lowEnvelopes(paced: readonly Pace[], n: number): LowEnvelope[] {
  const rank = (p: Pace) => (p.status === 'over' ? 0 : p.status === 'projected-over' ? 1 : 2);
  return paced
    .filter((p) => rank(p) < 2 || (p.funded > 0 && p.available < p.funded))
    .sort((a, b) => rank(a) - rank(b) || a.available - b.available)
    .slice(0, n)
    .map((p) => ({
      envelope: p.envelope, label: p.label, status: p.status,
      left: fmt((p.available < 0 ? 0 : p.available) as Cents),
      over: p.available < 0 ? fmt(-p.available as Cents) : null,
    }));
}

/**
 * What each envelope is on course to finish the month at.
 *
 * A straight line through everything was wrong in both directions. Rent paid on
 * the 2nd extrapolated to fifteen months of rent and cried wolf; a power bill
 * due on the 25th extrapolated to nearly nothing, read as fine, and then blew
 * the envelope. Neither of those is a forecast anybody should act on.
 *
 * So the month is split. Charges that arrive once a month at a known amount
 * count once, whether or not they have landed yet. Everything else — the part
 * that actually varies with behaviour — is still extrapolated at the current
 * rate, because "at this rate" is what a person means about groceries.
 *
 * Spending from a savings envelope is never extrapolated either: it is
 * periodic by definition and already funded as reserves.
 */
export function pace(view: MonthView, clock: MonthClock, state: State): Pace[] {
  const fixed = fixedCharges(state);
  const byKey = new Map(fixed.map((f) => [f.key, f]));

  const bills = billsOf(state, { fixed });

  const out: Pace[] = [];
  for (const e of view.envelopes) {
    if (e.funded === 0 && e.activity === 0) continue;

    let committed = ZERO;
    let discretionary = ZERO;
    // By part: a split receipt counts its share here, never the whole.
    for (const line of e.lines) {
      const t = state.txns.get(line.txnId);
      if (!t) continue;
      const amount = cents(Math.abs(line.amount));
      const key = chargeKey(t.payee, e.envelope.id);
      // The view's own envelope: a live one, or a removed one as it was when it went.
      const sinking = e.envelope.sinking !== undefined;
      if (byKey.has(key) || sinking) {
        committed = add(committed, amount);
      } else {
        discretionary = add(discretionary, amount);
      }
    }

    // Bills this envelope gets every month that have not arrived yet. This is
    // the half that used to read as "ok" right up until it wasn't.
    const stillExpected = clock.complete ? ZERO : billsExpected(bills.get(e.envelope.id) ?? [], clock.month);

    const variable = clock.elapsed > 0 && !clock.complete
      ? cents(discretionary / clock.elapsed)
      : discretionary;
    const projected = add(add(committed, stillExpected), variable);
    const projectedOver = sub(projected, add(e.funded, e.carried));
    // "Watch" needs a rate to watch. An envelope that is nothing but fixed
    // bills sits at exactly 100% of its plan the moment they are paid — that is
    // budgeting working, not a warning, and flagging it every month would teach
    // them to ignore the colour.
    const budgetForMonth = add(e.funded, e.carried);
    const status: Pace['status'] =
      e.available < 0 ? 'over'
      : projectedOver > 0 ? 'projected-over'
      : discretionary > 0 && budgetForMonth > 0 && projected / budgetForMonth > 0.85 ? 'watch'
      : 'ok';
    out.push({
      envelope: e.envelope.id, label: e.envelope.label,
      funded: e.funded, spent: e.activity, available: e.available,
      committed, stillExpected, discretionary,
      projected, projectedOver, status,
    });
  }
  // worst first: that's the order the briefing wants
  const rank = { over: 0, 'projected-over': 1, watch: 2, ok: 3 } as const;
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.projectedOver - a.projectedOver);
}

// ─── plan drift: the signal the immutable plan exists to produce ──────────────

export interface Drift {
  readonly envelope: EnvelopeId;
  readonly label: string;
  readonly months: readonly { month: Month; planned: Cents; funded: Cents; spent: Cents }[];
  /** How many of those months were topped up above plan. */
  readonly toppedUp: number;
  /** Mean funded across the window — the number the plan probably ought to be. */
  readonly averageFunded: Cents;
  readonly averagePlanned: Cents;
}

/**
 * Walk back over open months comparing what was planned against what it took.
 *
 * "Planned $325 three times, funded $421, $390, $408" is a wrong-plan problem,
 * which is a different and more useful finding than "over by $96 this month".
 * Only possible because the opening plan is never overwritten.
 */
export function drift(state: State, month: Month, lookback = 3): Drift[] {
  const months: Month[] = [];
  let cursor = month;
  for (let i = 0; i < lookback; i++) {
    if (state.months.has(cursor)) months.unshift(cursor);
    cursor = prevMonth(cursor);
  }
  if (months.length === 0) return [];

  const views = new Map<Month, MonthView>();
  for (const m of months) {
    const v = monthView(state, m);
    if (v) views.set(m, v);
  }

  const out: Drift[] = [];
  for (const env of state.envelopes.values()) {
    const rows: { month: Month; planned: Cents; funded: Cents; spent: Cents }[] = [];
    for (const m of months) {
      const plan = state.months.get(m);
      const view = views.get(m);
      if (!plan || !view) continue;
      const ev = view.envelopes.find((x) => x.envelope.id === env.id);
      rows.push({
        month: m,
        planned: plannedFor(plan, env.id),
        funded: fundedFor(plan, env.id),
        spent: ev?.activity ?? ZERO,
      });
    }
    if (rows.length === 0) continue;
    const toppedUp = rows.filter((r) => r.funded > r.planned).length;
    out.push({
      envelope: env.id,
      label: env.label,
      months: rows,
      toppedUp,
      averageFunded: cents(sum(rows.map((r) => r.funded)) / rows.length),
      averagePlanned: cents(sum(rows.map((r) => r.planned)) / rows.length),
    });
  }
  // the ones topped up most often, and by the most, first
  return out.sort((a, b2) =>
    b2.toppedUp - a.toppedUp ||
    (b2.averageFunded - b2.averagePlanned) - (a.averageFunded - a.averagePlanned));
}

// ─── recurring merchants ──────────────────────────────────────────────────────

export interface Recurring {
  readonly payee: string;
  readonly envelope: string | null;
  readonly months: readonly Month[];
  readonly typical: Cents;
  /** True when it recurs but no rule covers it — a subscription you haven't noticed. */
  readonly unruled: boolean;
}

/**
 * Merchants charging in three or more distinct months at a stable amount.
 * Catches subscriptions that crept in without ever being planned for.
 */
export function recurring(state: State, opts: { minMonths?: number; tolerance?: number } = {}): Recurring[] {
  const minMonths = opts.minMonths ?? 3;
  const tolerance = opts.tolerance ?? 0.15;

  const byPayee = new Map<string, Txn[]>();
  for (const t of state.txns.values()) {
    if (t.amount >= 0) continue; // inflows aren't subscriptions
    const key = normalisePayee(t.payee);
    if (!key) continue;
    (byPayee.get(key) ?? byPayee.set(key, []).get(key)!).push(t);
  }

  const out: Recurring[] = [];
  for (const [key, txns] of byPayee) {
    const months = [...new Set(txns.map((t) => monthOf(t.date)))].sort();
    if (months.length < minMonths) continue;
    const amounts = txns.map((t) => Math.abs(t.amount));
    const typical = cents(amounts.reduce((a, b) => a + b, 0) / amounts.length);
    // a real subscription is roughly the same every time
    const steady = amounts.every((a) => Math.abs(a - typical) <= typical * tolerance);
    if (!steady) continue;
    const covered = state.rules.some((r) => key.includes(r.match.toLowerCase()));
    out.push({
      payee: txns[0]!.payee,
      envelope: txns[0]!.envelope,
      months,
      typical: typical as Cents,
      unruled: !covered,
    });
  }
  return out.sort((a, b) => b.typical - a.typical);
}

/**
 * How a bill is known: the payee with its reference tail stripped. This is a
 * format in the log (a bill's key is written into `bill.set`), so it is never
 * changed, and it does not call `normalisePayee`, which may be.
 */
export function billKey(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[#*]\s*\w+/g, ' ')
    .replace(/\b\d[\d-]{2,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

/** Strip the reference tail so the same merchant groups across months. */
export function normalisePayee(payee: string): string {
  return (payee ?? '')
    .toLowerCase()
    .replace(/[#*]\s*\w+/g, ' ')
    .replace(/\b\d[\d-]{2,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

// ─── bills ────────────────────────────────────────────────────────────────────

export interface BillPaid { readonly txnId: string; readonly day: Day; readonly amount: Cents; readonly payee: string }
export interface BillCharge { readonly key: string; readonly typical: Cents; readonly lastDate: Day; readonly landed: ReadonlySet<Month> }
export interface Bill {
  /** Where it is listed and drawn now: it follows its receipts. */
  readonly envelope: EnvelopeId;
  /** The envelope its record lives under (where a change is written); null when no record exists. */
  readonly home: EnvelopeId | null;
  readonly key: string;
  readonly name: string;
  readonly byHand: boolean;
  readonly date: BillDate | null;
  readonly since: Day | null;
  /** The typical amount; null when the receipts give none. */
  readonly about: Cents | null;
  readonly charges: readonly BillCharge[];
  readonly receipts: readonly BillPaid[];
  readonly lastPaid: BillPaid | null;
}

interface BillPart extends BillPaid { readonly month: Month; readonly charge: string; readonly key: string }

/**
 * Each live envelope's bills: the fixed charges that land in it, and the dates
 * and names members gave. Receipts are counted by part, as `pace` counts them,
 * and a charge is placed by the envelope its part is sorted into, as `pace` places it.
 */
export function billsOf(
  state: State,
  opts: { fixed?: readonly FixedCharge[] } = {},
): ReadonlyMap<EnvelopeId, readonly Bill[]> {
  const out = new Map<EnvelopeId, readonly Bill[]>();
  const fixed = opts.fixed ?? fixedCharges(state);
  const byKey = new Map(fixed.map((f) => [f.key, f]));

  const parts = new Map<EnvelopeId, BillPart[]>();
  const landed = new Map<EnvelopeId, Map<string, Set<Month>>>();
  const charged = new Map<EnvelopeId, Map<string, FixedCharge>>();
  for (const t of state.txns.values()) {
    // a whole receipt places a charge, in the live envelope it is sorted into
    const f = isSpend(t.envelope) ? byKey.get(chargeKey(t.payee, t.envelope)) : undefined;
    const home = f && isSpend(t.envelope) ? state.envelopes.get(t.envelope) : undefined;
    if (f && home) (charged.get(home.id) ?? charged.set(home.id, new Map()).get(home.id)!).set(f.key, f);
    // parts say what landed and what was paid, each in its live envelope
    for (const p of partsOf(t)) {
      if (!isSpend(p.envelope)) continue;
      const env = state.envelopes.get(p.envelope);
      if (!env) continue;
      const charge = chargeKey(t.payee, p.envelope);
      const month = monthOf(t.date);
      (parts.get(env.id) ?? parts.set(env.id, []).get(env.id)!).push({
        txnId: t.id, day: t.date, month, amount: cents(-p.amount), payee: t.payee, charge, key: billKey(t.payee),
      });
      const byCharge = landed.get(env.id) ?? landed.set(env.id, new Map()).get(env.id)!;
      (byCharge.get(charge) ?? byCharge.set(charge, new Set()).get(charge)!).add(month);
    }
  }

  const isFor = (part: BillPart, rec: BillRecord): boolean => rec.key !== '' && part.key.includes(rec.key);
  const records = [...state.bills.values()];

  // where each record is listed
  const listed = new Map<EnvelopeId, BillRecord[]>();
  const list = (id: EnvelopeId, rec: BillRecord) => (listed.get(id) ?? listed.set(id, []).get(id)!).push(rec);
  for (const rec of records) {
    const own = state.envelopes.get(rec.envelope);
    if (own && (parts.get(own.id) ?? []).some((p) => isFor(p, rec))) { list(own.id, rec); continue; }
    let best: { id: EnvelopeId; day: Day; order: number } | null = null;
    for (const env of state.envelopes.values()) {
      if (env.id === rec.envelope || env.sinking) continue;
      if (records.some((r) => r.envelope === env.id && r.key === rec.key)) continue;
      let day: Day | null = null;
      for (const p of parts.get(env.id) ?? []) if (isFor(p, rec) && (day === null || p.day > day)) day = p.day;
      if (day === null) continue;
      if (!best || day > best.day || (day === best.day && env.order < best.order)) best = { id: env.id, day, order: env.order };
    }
    if (best) list(best.id, rec);
    else if (own) list(own.id, rec);
  }

  for (const env of state.envelopes.values()) {
    const recs = (listed.get(env.id) ?? []).slice().sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    // the listed record that takes a key: the exact one, else the longest it contains
    const taker = (key: string): BillRecord | null => {
      if (key === '') return null;
      const exact = recs.find((r) => r.key === key);
      if (exact) return exact;
      let found: BillRecord | null = null;
      for (const r of recs) if (r.key !== '' && key.includes(r.key) && (!found || r.key.length > found.key.length)) found = r;
      return found;
    };
    interface Acc { rec: BillRecord | null; key: string; charges: FixedCharge[]; parts: BillPart[] }
    const accs = new Map<string, Acc>();
    for (const r of recs) accs.set(r.key, { rec: r, key: r.key, charges: [], parts: [] });
    for (const f of (charged.get(env.id) ?? new Map<string, FixedCharge>()).values()) {
      const key = billKey(f.payee) || f.key;
      const into = taker(key)?.key ?? key;
      (accs.get(into) ?? accs.set(into, { rec: null, key: into, charges: [], parts: [] }).get(into)!).charges.push(f);
    }
    for (const p of parts.get(env.id) ?? []) {
      const rec = taker(p.key);
      const acc = accs.get(rec ? rec.key : p.key);
      if (acc) acc.parts.push(p);
    }
    const bills: Bill[] = [];
    for (const a of accs.values()) {
      const receipts = a.parts.filter((p) => p.amount > 0)
        .sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : x.txnId < y.txnId ? -1 : x.txnId > y.txnId ? 1 : 0))
        .map((p): BillPaid => ({ txnId: p.txnId, day: p.day, amount: p.amount, payee: p.payee }));
      const lastPaid = receipts.length ? receipts[receipts.length - 1]! : null;
      const charges = a.charges.map((f): BillCharge => ({
        key: f.key, typical: f.typical, lastDate: f.lastDate, landed: landed.get(env.id)?.get(f.key) ?? new Set<Month>(),
      }));
      bills.push({
        envelope: env.id, home: a.rec?.envelope ?? null, key: a.key,
        name: a.rec?.byHand ? a.rec.name : lastPaid?.payee ?? a.rec?.name ?? a.charges[0]!.payee,
        byHand: a.rec?.byHand ?? false,
        date: a.rec?.date ?? null, since: a.rec?.since ?? null,
        about: charges.length ? sum(charges.map((c) => c.typical)) : null,
        charges, receipts, lastPaid,
      });
    }
    bills.sort((x, y) => (x.date === null ? 1 : 0) - (y.date === null ? 1 : 0) || x.name.localeCompare(y.name) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    out.set(env.id, bills);
  }
  return out;
}

// ─── a bill's dates ───────────────────────────────────────────────────────────

const lastDayOf = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayAt = (y: number, m: number, d: number): Day => `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDayOf(y, m))).padStart(2, '0')}`;
const ymOf = (day: Day): number => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
const dayNumber = (day: Day): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86400000;
const shiftDays = (day: Day, by: number): Day => new Date((dayNumber(day) + by) * 86400000).toISOString().slice(0, 10);
const monthsIn = (from: Day, to: Day): Month[] => {
  const out: Month[] = [];
  for (let i = ymOf(from); i <= ymOf(to); i++) out.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  return out;
};

/** The days a date falls on within [from, to], ascending. A day past a short month's end is held to its last day, never carried forward. */
export function billDatesIn(date: BillDate, from: Day, to: Day): readonly Day[] {
  const out: Day[] = [];
  if (from > to) return out;
  const lo = ymOf(from), hi = ymOf(to);
  if (date.per === 'month') {
    for (let i = lo; i <= hi; i++) out.push(dayAt(Math.floor(i / 12), (i % 12) + 1, date.day));
  } else {
    const step = date.per === 'quarter' ? 3 : date.per === 'half-year' ? 6 : 12;
    const base = ymOf(date.on), d = Number(date.on.slice(8, 10));
    for (let k = Math.ceil((lo - base) / step); base + k * step <= hi; k++) {
      const i = base + k * step;
      out.push(dayAt(Math.floor(i / 12), (i % 12) + 1, d));
    }
  }
  return out.filter((x) => x >= from && x <= to);
}

export interface BillOccurrence { readonly month: Month; readonly day: Day; readonly dated: boolean; readonly paid: BillPaid | null; readonly about: Cents | null }

/** Each date of a dated bill with the receipt that paid it: every receipt pays its nearest date, the earlier on a tie, and a date keeps its first. */
function datePayments(date: BillDate, receipts: readonly BillPaid[]): Map<Day, BillPaid> {
  const paid = new Map<Day, BillPaid>();
  for (const r of receipts) {
    const near = billDatesIn(date, shiftDays(r.day, -400), shiftDays(r.day, 400));
    let best: Day | null = null, gap = Infinity;
    for (const d of near) {
      const g = Math.abs(dayNumber(d) - dayNumber(r.day));
      if (g < gap) { best = d; gap = g; }
    }
    if (best !== null && !paid.has(best)) paid.set(best, r);
  }
  return paid;
}

const landedIn = (c: BillCharge, month: Month): boolean => c.landed.has(month);

export function billOccurrences(bill: Bill, from: Day, to: Day): readonly BillOccurrence[] {
  const out: BillOccurrence[] = [];
  if (from > to) return out;
  if (bill.date) {
    const paid = datePayments(bill.date, bill.receipts);
    const days = new Set(billDatesIn(bill.date, shiftDays(from, -400), shiftDays(to, 400)));
    for (const d of days) {
      const p = paid.get(d) ?? null;
      if (!((d >= from && d <= to) || (p !== null && p.day >= from && p.day <= to))) continue;
      out.push({ month: monthOf(d), day: d, dated: true, paid: p, about: p ? null : bill.about });
    }
    return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }
  const last = bill.lastPaid;
  if (!last) return out;
  for (const month of monthsIn(from, to)) {
    const first = bill.receipts.find((r) => monthOf(r.day) === month) ?? null;
    const allLanded = bill.charges.every((c) => landedIn(c, month));
    if (bill.charges.length > 0 && allLanded && first === null) continue;
    const paid = first && allLanded ? first : null;
    const left = sum(bill.charges.filter((c) => !landedIn(c, month)).map((c) => c.typical));
    const [y, m] = month.split('-').map(Number) as [number, number];
    const day = dayAt(y, m, Number(last.day.slice(8, 10)));
    if (!((day >= from && day <= to) || (paid !== null && paid.day >= from && paid.day <= to))) continue;
    out.push({ month, day, dated: false, paid, about: paid || bill.charges.length === 0 || left <= 0 ? null : left });
  }
  return out;
}

/** What these bills still expect in a month: the short row's sum. */
export function billsExpected(bills: readonly Bill[], month: Month): Cents {
  const [y, m] = month.split('-').map(Number) as [number, number];
  let total = 0;
  for (const bill of bills) {
    if (bill.date) {
      const paid = datePayments(bill.date, bill.receipts);
      for (const d of billDatesIn(bill.date, `${month}-01`, `${month}-${String(lastDayOf(y, m)).padStart(2, '0')}`)) {
        if (!paid.has(d)) total += bill.about ?? 0;
      }
    } else {
      total += sum(bill.charges.filter((c) => !landedIn(c, month)).map((c) => c.typical));
    }
  }
  return cents(total);
}

// ─── the queue ────────────────────────────────────────────────────────────────

export interface ToSort {
  readonly count: number;
  /** Money out. This is the figure that means "spending not yet accounted for". */
  readonly outflow: Cents;
  /** Money in — paycheques and card payments that just haven't been ruled yet. */
  readonly inflow: Cents;
  readonly oldest: Day | null;
  readonly txnIds: readonly TxnId[];
  /** For a split receipt held for a part: the envelopes of its parts that are not there. */
  readonly missing: ReadonlyMap<TxnId, readonly EnvelopeId[]>;
}

/** The parts of a receipt whose envelope is neither live nor kept by its month's history. */
function missingParts(state: State, t: Txn): EnvelopeId[] {
  const month = monthOf(t.date);
  return partsOf(t).flatMap((p) =>
    isSpend(p.envelope) && !state.envelopes.has(p.envelope) && !keptIn(state, p.envelope, month) ? [p.envelope] : []);
}

/**
 * Whether To sort holds this receipt: it has no envelope, or it (or a part of
 * it) names one that is not here, unless its month keeps that envelope in its
 * history. A split held for a part still counts its other parts where they are.
 */
export function inToSort(state: State, t: Txn): boolean {
  return t.envelope === null || missingParts(state, t).length > 0;
}

/**
 * The receipts To sort holds, with money in and money out kept apart.
 *
 * Summing the absolute value of both would report an unsorted paycheque and a
 * card payment as if they were unexplained spending — on a real import that
 * reads as tens of thousands of dollars missing, which is alarming and false.
 */
export function toSort(state: State): ToSort {
  const ids: TxnId[] = [];
  const missing = new Map<TxnId, EnvelopeId[]>();
  let outflow = ZERO;
  let inflow = ZERO;
  let oldest: Day | null = null;
  for (const t of state.txns.values()) {
    if (t.envelope !== null) {
      const gone = missingParts(state, t);
      if (!gone.length) continue;
      if (t.envelope === SPLIT) missing.set(t.id, gone);
    }
    ids.push(t.id);
    if (t.amount < 0) outflow = add(outflow, cents(-t.amount));
    else inflow = add(inflow, cents(t.amount));
    if (!oldest || t.date < oldest) oldest = t.date;
  }
  return { count: ids.length, outflow, inflow, oldest, txnIds: ids, missing };
}

// ─── where to pull money from ─────────────────────────────────────────────────

export interface Donor {
  readonly envelope: EnvelopeId;
  readonly label: string;
  readonly available: Cents;
  /** Spare after leaving the rest of the month's usual burn alone. */
  readonly spare: Cents;
}

/**
 * Envelopes that could fund a shortfall without being pushed over themselves.
 *
 * Answers "what should I pull from to increase food, and by how much" with a
 * ranked list rather than a guess — the projection decides what's genuinely
 * spare, not just what currently has a balance.
 */
export function donors(view: MonthView, clock: MonthClock, exclude: EnvelopeId, state: State): Donor[] {
  const paced = new Map(pace(view, clock, state).map((p) => [p.envelope, p]));
  const out: Donor[] = [];
  for (const e of view.envelopes) {
    if (e.envelope.id === exclude || e.removed) continue;
    if (e.available <= 0) continue;
    const p = paced.get(e.envelope.id);
    // keep back whatever it still looks likely to spend
    const stillLikely = p ? max0(sub(p.projected, e.activity)) : ZERO;
    const spare = max0(sub(e.available, stillLikely));
    if (spare <= 0) continue;
    out.push({ envelope: e.envelope.id, label: e.envelope.label, available: e.available, spare });
  }
  return out.sort((a, b) => b.spare - a.spare);
}

const max0 = (c: Cents): Cents => (c > 0 ? c : ZERO);

// ─── one bundle for the briefing ──────────────────────────────────────────────

export interface Snapshot {
  readonly month: Month;
  readonly clock: MonthClock;
  readonly view: MonthView;
  readonly pace: readonly Pace[];
  readonly drift: readonly Drift[];
  readonly toSort: ToSort;
  readonly recurring: readonly Recurring[];
  readonly balanced: boolean;
}

/**
 * Everything the briefing needs in one call.
 *
 * Tools are shaped like the questions people ask, not like tables — answering
 * "how are we doing?" shouldn't cost six round trips.
 */
export function snapshot(state: State, month: Month, today: Day): Snapshot | null {
  const view = monthView(state, month);
  if (!view) return null;
  const clock = monthClock(month, today);
  return {
    month, clock, view,
    pace: pace(view, clock, state),
    drift: drift(state, month),
    toSort: toSort(state),
    recurring: recurring(state).filter((r) => r.unruled),
    balanced: Math.abs(view.toAssign) < 100,
  };
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const ordinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};

/** A bill's date in words, lower-case for a sentence: "due on the 16th, every month". */
export function billDateWords(date: BillDate): string {
  const verb = date.kind === 'due' ? 'due on' : date.kind === 'autopay' ? 'Auto Pay on' : 'pay by';
  if (date.per === 'month') return `${verb} the ${ordinal(date.day)}, every month`;
  const [, m, d] = date.on.split('-').map(Number) as [number, number, number];
  const every = date.per === 'quarter' ? 'every quarter' : date.per === 'half-year' ? 'every six months' : 'every year';
  return `${verb} ${d} ${MONTHS_LONG[m - 1]}, ${every}`;
}

/** What a bill's row says under its name: what the receipts know, then its date if a member set one. */
export function billLine(bill: Bill): string {
  const parts: string[] = [];
  if (bill.about !== null) parts.push(`about ${fmt(bill.about)}`);
  parts.push(bill.lastPaid
    ? `last paid ${Number(bill.lastPaid.day.slice(8, 10))} ${MONTHS_SHORT[Number(bill.lastPaid.day.slice(5, 7)) - 1]}`
    : 'no receipts yet');
  if (bill.date) {
    const words = billDateWords(bill.date);
    parts.push(words.charAt(0).toUpperCase() + words.slice(1));
  }
  return parts.join(' · ');
}
