/**
 * What the budget's bills put on the Calendar: a row for each bill on the day it
 * falls or was paid, and one "short" row on today for an envelope with less
 * left than its bills still expect. It reads the log and writes nothing.
 */
import { fmt, fmtExact } from './money.ts';
import type { Cents } from './money.ts';
import { billOccurrences, billsExpected, billsOf } from './analytics.ts';
import type { Bill, BillOccurrence } from './analytics.ts';
import { monthView } from './envelopes.ts';
import { monthOf } from './types.ts';
import type { Day, EnvelopeId, State } from './types.ts';

export interface MoneyRow {
  readonly day: Day; readonly kind: 'due' | 'autopay' | 'payby' | 'bill' | 'paid' | 'short';
  readonly envelope: EnvelopeId;
  /** The envelope's name. */
  readonly label: string;
  /** The bill's key and name; a short row's are its first bill's. */
  readonly bill?: string; readonly name: string;
  /** Paid: `fmtExact` of what was paid. Not paid: `fmt` of the typical amount; a short row's, of the sum expected. */
  readonly amount?: string; readonly about?: string;
  readonly noReceipt?: true;
  /** `fmt` of what is available, when `short`: `left` while it is not below nothing, `over` once it is. */
  readonly left?: string; readonly over?: string;
  readonly short: boolean;
  /** A short row's: how many bills it is about, and the first one's day and kind. */
  readonly bills?: number; readonly billDay?: Day; readonly billKind?: 'due' | 'autopay' | 'payby' | 'bill';
}

const byDayThenName = (a: MoneyRow, b: MoneyRow): number =>
  a.day < b.day ? -1 : a.day > b.day ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** `to` is inclusive. */
export function calendarMoney(state: State, w: { from: Day; to: Day; today: Day }): MoneyRow[] {
  const month = monthOf(w.today);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const inWindow = (d: Day): boolean => d >= w.from && d <= w.to;
  const allBills = billsOf(state);
  const view = monthView(state, month);
  const available = new Map<EnvelopeId, Cents>((view?.envelopes ?? []).map((e) => [e.envelope.id, e.available]));

  const shorts: MoneyRow[] = [];
  const rest: MoneyRow[] = [];
  for (const envelope of [...state.envelopes.values()].sort((a, b) => a.order - b.order)) {
    if (envelope.sinking) continue;
    const bills: readonly Bill[] = allBills.get(envelope.id) ?? [];
    const left = available.get(envelope.id);
    const short: Cents | null = left !== undefined && !envelope.needsFigure ? billsExpected(bills, month) : null;
    const isShort = left !== undefined && short !== null && short > 0 && left < short;
    const figures = !isShort || left === undefined ? {} : left >= 0 ? { left: fmt(left) } : { over: fmt(-left as Cents) };
    const base = { envelope: envelope.id, label: envelope.label };

    const unpaid: MoneyRow[] = [];
    const paid: MoneyRow[] = [];
    const thisMonth: { bill: Bill; occ: BillOccurrence }[] = [];
    for (const bill of bills) {
      const wide = billOccurrences(bill, w.from < first ? w.from : first, w.to > last ? w.to : last);
      for (const occ of wide) {
        const mine = { ...base, bill: bill.key, name: bill.name };
        if (occ.paid) {
          if (!inWindow(occ.paid.day)) continue;
          paid.push({ ...mine, day: occ.paid.day, kind: 'paid', amount: fmtExact(occ.paid.amount), short: false });
          continue;
        }
        let row: MoneyRow;
        if (occ.dated && bill.date) {
          const drawn = (bill.since !== null && occ.day >= bill.since) || monthOf(occ.day) === month;
          if (!drawn) continue;
          row = { ...mine, day: occ.day, kind: bill.date.kind, short: false,
            ...(occ.about !== null ? { about: fmt(occ.about) } : {}), ...(occ.day < w.today ? { noReceipt: true as const } : {}) };
        } else {
          if (occ.about === null || occ.month < month) continue;
          row = { ...mine, day: occ.day, kind: 'bill', about: fmt(occ.about), short: false };
        }
        if (monthOf(occ.day) === month) thisMonth.push({ bill, occ });
        if (!inWindow(occ.day)) continue;
        unpaid.push(isShort && monthOf(occ.day) === month ? { ...row, short: true, ...figures } : row);
      }
    }
    unpaid.sort(byDayThenName);
    paid.sort(byDayThenName);
    rest.push(...unpaid, ...paid);

    if (isShort && inWindow(w.today)) {
      const unpaidNow = thisMonth
        .filter((x) => !x.occ.paid && x.occ.about !== null)
        .sort((a, b) => (a.occ.day < b.occ.day ? -1 : a.occ.day > b.occ.day ? 1 : a.bill.name < b.bill.name ? -1 : a.bill.name > b.bill.name ? 1 : 0));
      const head = unpaidNow[0];
      shorts.push({
        ...base, day: w.today, kind: 'short', short: true, name: head?.bill.name ?? envelope.label,
        ...(head ? { bill: head.bill.key, billDay: head.occ.day, billKind: head.occ.dated && head.bill.date ? head.bill.date.kind : 'bill' as const } : {}),
        about: fmt(short!), bills: unpaidNow.length, ...figures,
      });
    }
  }
  return [...shorts, ...rest];
}
