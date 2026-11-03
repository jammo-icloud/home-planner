/**
 * Bank exports into rows the ledger can hold.
 *
 * Receipts are facts, so parsing is the one place a mistake is unrecoverable —
 * a dropped row is money that left the account and landed in no envelope, and
 * nothing downstream can notice. Everything here is therefore deliberately dull:
 * no inference, no cleverness, and an explicit count of what was skipped.
 *
 * Two formats, because those are the two banks and card issuers give:
 *   OFX/QFX  — both the SGML (1.x) and XML (2.x) dialects, one file often
 *              holding several accounts, each in its own statement
 *   CSV      — a header row naming the columns (Posted Date or Date, Payee or
 *              Description, Amount, and optionally a reference and a memo)
 */

import { parseDollars } from './money.ts';
import type { Cents } from './money.ts';

export interface ParsedRow {
  readonly date: string;
  readonly payee: string;
  readonly memo?: string;
  readonly amount: Cents;
  readonly account: string;
  /** The bank's own id for this transaction, when it gives one. */
  readonly reference?: string;
}

/** What an account held on a day, as its statement says: OFX's ledger balance. */
export interface StatementBalance {
  readonly account: string;
  readonly amount: Cents;
  readonly asOf: string;
}

export interface ParseResult {
  readonly rows: readonly ParsedRow[];
  /** One per statement that carries a ledger balance. A CSV carries none. */
  readonly balances: readonly StatementBalance[];
  /** Lines that looked like transactions but could not be read. Never silent. */
  readonly skipped: readonly string[];
  readonly format: 'ofx' | 'csv';
}

/**
 * The key two rows are the same transaction by.
 *
 * The bank's own reference when there is one — that is what it is for. Failing
 * that, date, amount and a truncated payee, which is weak enough that two
 * genuinely identical coffees on one day collapse into one. That is the safer
 * error: a missing row is visible in a reconciliation, a duplicated one silently
 * doubles a category.
 */
export const dedupeKey = (r: ParsedRow): string =>
  r.reference
    ? `f:${r.account}:${r.reference}`
    : `h:${r.date}:${(r.amount / 100).toFixed(2)}:${r.payee.slice(0, 24).toLowerCase()}`;

export const looksLikeOfx = (text: string): boolean =>
  /<OFX>/i.test(text) || /<STMTTRN>/i.test(text) || /^OFXHEADER/im.test(text);

export function parse(text: string): ParseResult {
  return looksLikeOfx(text) ? parseOfx(text) : parseCsv(text);
}

// ─── OFX / QFX ───────────────────────────────────────────────────────────────

const between = (text: string, tag: string): string[] =>
  [...text.matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, 'gis'))].map((m) => m[1] ?? '');

/**
 * SGML OFX does not close its leaf tags, so a value runs to the end of the line
 * rather than to a closing tag. Matching up to `<` as well handles the XML
 * dialect without needing to know which one this is.
 */
const field = (chunk: string, tag: string): string => {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(chunk);
  return (m?.[1] ?? '').trim();
};

/** OFX dates are YYYYMMDD with optional time and timezone glued on. */
const ofxDate = (raw: string): string | null => {
  const d = raw.slice(0, 8);
  if (!/^\d{8}$/.test(d)) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
};

export function parseOfx(text: string): ParseResult {
  const rows: ParsedRow[] = [];
  const balances: StatementBalance[] = [];
  const skipped: string[] = [];

  // Statements first, so each transaction keeps the account it belongs to. A
  // file with three accounts in it is the normal case, not the exception.
  const statements = [...between(text, 'STMTRS'), ...between(text, 'CCSTMTRS')];
  const scopes = statements.length ? statements : [text];

  for (const stmt of scopes) {
    const account = field(stmt, 'ACCTID') || field(stmt, 'BANKID') || 'unknown';
    for (const tr of between(stmt, 'STMTTRN')) {
      const date = ofxDate(field(tr, 'DTPOSTED'));
      const rawAmount = field(tr, 'TRNAMT');
      const payee = (field(tr, 'NAME') || field(tr, 'MEMO')).trim();
      if (!date || !rawAmount) { skipped.push(payee || 'a transaction with no date or amount'); continue; }

      let amount: Cents;
      try { amount = parseDollars(rawAmount); }
      catch { skipped.push(`${payee}: could not read the amount "${rawAmount}"`); continue; }

      const memo = field(tr, 'MEMO');
      const reference = field(tr, 'FITID');
      rows.push({
        date, payee: payee || 'Unknown', amount, account,
        ...(memo && memo !== payee ? { memo } : {}),
        ...(reference ? { reference } : {}),
      });
    }
    // The ledger balance, never the available one: it is what the statement
    // says the account held at the day it names, which is what Savings is
    // checked against. Its own aggregate, so the available balance's BALAMT
    // after it cannot be read in its place.
    const ledger = between(stmt, 'LEDGERBAL')[0];
    if (ledger !== undefined) {
      const asOf = ofxDate(field(ledger, 'DTASOF'));
      let amount: Cents | null = null;
      try { amount = parseDollars(field(ledger, 'BALAMT')); } catch { /* said below */ }
      if (asOf && amount !== null) balances.push({ account, amount, asOf });
      else skipped.push(`account ${account}: could not read the statement balance`);
    }
  }
  return { rows, balances, skipped, format: 'ofx' };
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/** Handles quoted fields and doubled quotes; anything fancier is not a bank export. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
};

const HEADERS = {
  date: ['posted date', 'date', 'transaction date', 'post date', 'effective date'],
  payee: ['payee', 'description', 'name', 'merchant', 'transaction description'],
  amount: ['amount', 'debit', 'transaction amount'],
  reference: ['reference number', 'reference', 'transaction id', 'fitid'],
  memo: ['memo', 'notes', 'address'],
} as const;

const findColumn = (header: string[], names: readonly string[]): number =>
  header.findIndex((h) => names.includes(h.toLowerCase().replace(/^﻿/, '').trim()));

/** MM/DD/YYYY, YYYY-MM-DD or DD/MM/YYYY when the first number cannot be a month. */
export function csvDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (!m) return null;
  let [, a, b, y] = m as unknown as [string, string, string, string];
  // US banks write month first. Only swap when the first number cannot be one.
  if (Number(a) > 12) [a, b] = [b, a];
  return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
}

export function parseCsv(text: string): ParseResult {
  const rows: ParsedRow[] = [];
  const skipped: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows, balances: [], skipped: ['the file has no rows'], format: 'csv' };

  const header = splitCsvLine(lines[0]!);
  const iDate = findColumn(header, HEADERS.date);
  const iPayee = findColumn(header, HEADERS.payee);
  const iAmount = findColumn(header, HEADERS.amount);
  const iRef = findColumn(header, HEADERS.reference);
  const iMemo = findColumn(header, HEADERS.memo);

  if (iDate < 0 || iPayee < 0 || iAmount < 0) {
    return {
      rows: [], balances: [],
      skipped: [`could not find date, description and amount columns in: ${header.join(', ')}`],
      format: 'csv',
    };
  }

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const date = csvDate(cells[iDate] ?? '');
    const payee = (cells[iPayee] ?? '').trim();
    const rawAmount = (cells[iAmount] ?? '').trim();
    if (!date || !rawAmount) { skipped.push(line.slice(0, 60)); continue; }

    let amount: Cents;
    try { amount = parseDollars(rawAmount); }
    catch { skipped.push(`${payee}: could not read the amount "${rawAmount}"`); continue; }

    const memo = iMemo >= 0 ? (cells[iMemo] ?? '').trim() : '';
    const reference = iRef >= 0 ? (cells[iRef] ?? '').trim() : '';
    rows.push({
      date, payee: payee || 'Unknown', amount, account: 'csv',
      ...(memo ? { memo } : {}),
      ...(reference ? { reference } : {}),
    });
  }
  return { rows, balances: [], skipped, format: 'csv' };
}
