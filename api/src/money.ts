/**
 * Money is integer cents. Never floats.
 *
 * 0.1 + 0.2 !== 0.3, and a budget that balances to zero cannot afford that.
 * The whole system stores, sums and compares cents; dollars exist only at the
 * edges — parsing a bank file in, and formatting for display out.
 */

declare const CENTS: unique symbol;
export type Cents = number & { readonly [CENTS]: true };

export const ZERO = 0 as Cents;

/** Trusted constructor for a value already known to be whole cents. */
export const cents = (n: number): Cents => {
  if (!Number.isFinite(n)) throw new RangeError(`not a finite amount: ${n}`);
  return Math.round(n) as Cents;
};

/**
 * Parse a dollar amount from a bank file or a form field.
 * Goes through the string so "84.21" is exactly 8421 rather than 8420.999…,
 * and tolerates the shapes real exports use: "$1,234.56", "(45.00)", "-45".
 */
export function parseDollars(input: string | number): Cents {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new RangeError(`not a finite amount: ${input}`);
    // scale in string space to dodge binary-float drift
    return cents(Number((input * 100).toFixed(4)));
  }
  const raw = input.trim();
  if (!raw) throw new SyntaxError('empty amount');

  const parenthesised = /^\(.*\)$/.test(raw); // accounting negative
  const cleaned = raw.replace(/[()$\s,]/g, '');
  const m = /^(-|\+)?(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!m || (!m[2] && !m[3])) throw new SyntaxError(`cannot read amount: ${input}`);

  const whole = m[2] ?? '';
  const frac = (m[3] ?? '').padEnd(2, '0');
  if (frac.length > 2) {
    // more precision than cents: round rather than silently truncate
    const scaled = Number(`${whole || '0'}.${frac}`) * 100;
    const signed = (m[1] === '-' || parenthesised ? -1 : 1) * scaled;
    return cents(Number(signed.toFixed(4)));
  }
  const magnitude = Number(whole || '0') * 100 + Number(frac || '0');
  const negative = m[1] === '-' || parenthesised;
  return cents(negative ? -magnitude : magnitude);
}

export const toDollars = (c: Cents): number => c / 100;

export const add = (a: Cents, b: Cents): Cents => (a + b) as Cents;
export const sub = (a: Cents, b: Cents): Cents => (a - b) as Cents;
export const neg = (a: Cents): Cents => -a as Cents;
export const abs = (a: Cents): Cents => Math.abs(a) as Cents;
export const sum = (xs: readonly Cents[]): Cents =>
  xs.reduce<Cents>((n, x) => (n + x) as Cents, ZERO);
export const max = (a: Cents, b: Cents): Cents => (a > b ? a : b);
export const isZero = (a: Cents): boolean => a === 0;

/** Split evenly, distributing the remainder a cent at a time so nothing is lost. */
export function split(total: Cents, ways: number): Cents[] {
  if (ways <= 0) throw new RangeError('cannot split zero ways');
  const base = Math.trunc(total / ways);
  let rest = total - base * ways;
  const step = rest < 0 ? -1 : 1;
  return Array.from({ length: ways }, () => {
    let part = base;
    if (rest !== 0) { part += step; rest -= step; }
    return part as Cents;
  });
}

const FMT = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0,
});
const FMT_EXACT = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** Whole dollars — how envelopes read on a phone. */
export const fmt = (c: Cents): string => FMT.format(toDollars(c));
/** Cents included — how a single transaction reads. */
export const fmtExact = (c: Cents): string => FMT_EXACT.format(toDollars(c));
