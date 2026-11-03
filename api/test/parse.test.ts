import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parse, parseOfx, parseCsv, csvDate, splitCsvLine, dedupeKey, looksLikeOfx } from '../src/parse.ts';
import { parseDollars, fmtExact } from '../src/money.ts';

/** The SGML dialect of QFX: leaf tags are never closed. */
const QFX = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKACCTFROM><ACCTID>1234567890</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803120000[-7:MST]<TRNAMT>-310.50<FITID>2026080301<NAME>ACH Debit EXAMPLE POWER BILLP</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260801<TRNAMT>4000.00<FITID>2026080101<NAME>ACH Deposit PAYROLL</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>4321</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260810<TRNAMT>-13.75<FITID>24000001<NAME>CITY TOLLS ONLINE LAKESIDE OH</STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>`;

const CSV = `Posted Date,Reference Number,Payee,Address,Amount
08/10/2026,24000000000000000000001,"CITY TOLLS ONLINE LAKESIDE OH","LAKESIDE      OH ",-13.75
08/03/2026,24000000000000000000002,"EXAMPLE GROCER, INC 800-555-0100","CA ",-414.31
08/04/2026,24000000999,"REFUND, EXAMPLE GROCER","CA ",17.24
`;

describe('OFX and QFX', () => {
  test('unclosed SGML leaf tags are read to end of line', () => {
    const { rows, skipped } = parseOfx(QFX);
    assert.equal(skipped.length, 0);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.payee, 'ACH Debit EXAMPLE POWER BILLP');
  });

  test('a date with time and timezone glued on still reads as a day', () => {
    assert.equal(parseOfx(QFX).rows[0]!.date, '2026-08-03');
  });

  test('amounts keep their sign and land on the cent', () => {
    const rows = parseOfx(QFX).rows;
    assert.equal(fmtExact(rows[0]!.amount), '-$310.50');
    assert.equal(fmtExact(rows[1]!.amount), '$4,000.00', 'income is not flipped');
  });

  test('each transaction keeps the account it came from', () => {
    // One QFX export is often several accounts in one file, and a receipt that
    // forgets which account it came from cannot be deduped against next month.
    const rows = parseOfx(QFX).rows;
    assert.equal(rows[0]!.account, '1234567890');
    assert.equal(rows[2]!.account, '4321', 'the credit card statement is a separate scope');
  });

  test('the XML dialect parses the same way', () => {
    const xml = `<?xml version="1.0"?><OFX><STMTRS><BANKACCTFROM><ACCTID>1</ACCTID></BANKACCTFROM>`
      + `<STMTTRN><DTPOSTED>20260701</DTPOSTED><TRNAMT>-10.00</TRNAMT>`
      + `<FITID>x1</FITID><NAME>SHOP</NAME></STMTTRN></STMTRS></OFX>`;
    const { rows } = parseOfx(xml);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.payee, 'SHOP');
    assert.equal(fmtExact(rows[0]!.amount), '-$10.00');
  });

  test('a row missing an amount is reported, never dropped in silence', () => {
    const bad = `<OFX><STMTRS><STMTTRN><DTPOSTED>20260701<NAME>NO AMOUNT</STMTTRN></STMTRS></OFX>`;
    const { rows, skipped } = parseOfx(bad);
    assert.equal(rows.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!, /NO AMOUNT/);
  });
});

describe("a statement's balance", () => {
  /** Savings and a card in one SGML file, each with its ledger balance; Savings has an available balance after it. */
  const STATEMENTS = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKACCTFROM><ACCTID>5550001</ACCTID><ACCTTYPE>SAVINGS</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261015<TRNAMT>500.00<FITID>s1<NAME>Transfer from checking</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>12500.00<DTASOF>20261031120000.000[-7:MST]</LEDGERBAL>
<AVAILBAL><BALAMT>12000.00<DTASOF>20261031</AVAILBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CCACCTFROM><ACCTID>4321</CCACCTFROM>
<BANKTRANLIST></BANKTRANLIST>
<LEDGERBAL><BALAMT>-310.50<DTASOF>20261030</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>`;

  test('the ledger balance and its day are read for each account, not the available balance', () => {
    const { balances, skipped } = parseOfx(STATEMENTS);
    assert.deepEqual(skipped, []);
    assert.deepEqual(balances, [
      { account: '5550001', amount: 1250000, asOf: '2026-10-31' },
      { account: '4321', amount: -31050, asOf: '2026-10-30' },
    ]);
  });

  test('the XML dialect reads the same way', () => {
    const xml = '<?xml version="1.0"?><OFX><STMTRS><BANKACCTFROM><ACCTID>77</ACCTID></BANKACCTFROM>'
      + '<BANKTRANLIST></BANKTRANLIST><LEDGERBAL><BALAMT>1,204.10</BALAMT><DTASOF>20261101</DTASOF></LEDGERBAL></STMTRS></OFX>';
    assert.deepEqual(parseOfx(xml).balances, [{ account: '77', amount: 120410, asOf: '2026-11-01' }]);
  });

  test('a statement without one has none, and one that cannot be read is said, not guessed', () => {
    assert.deepEqual(parseOfx(QFX).balances, []);
    const bad = parseOfx('<OFX><STMTRS><ACCTID>8<LEDGERBAL><BALAMT>lots<DTASOF>20261031</LEDGERBAL></STMTRS></OFX>');
    assert.deepEqual(bad.balances, []);
    assert.deepEqual(bad.skipped, ['account 8: could not read the statement balance']);
  });

  test('a CSV carries none', () => {
    assert.deepEqual(parseCsv(CSV).balances, []);
  });
});

describe('CSV', () => {
  test('quoted fields containing commas do not split the row', () => {
    const { rows, skipped } = parseCsv(CSV);
    assert.equal(skipped.length, 0);
    assert.equal(rows.length, 3);
    assert.equal(rows[1]!.payee, 'EXAMPLE GROCER, INC 800-555-0100');
  });

  test('US dates are read month-first', () => {
    assert.equal(parseCsv(CSV).rows[0]!.date, '2026-08-10');
  });

  test('a refund keeps its positive sign', () => {
    assert.equal(fmtExact(parseCsv(CSV).rows[2]!.amount), '$17.24');
  });

  test('columns are found by name, so column order does not matter', () => {
    const reordered = `Amount,Description,Date\n-5.00,COFFEE,2026-08-01\n`;
    const { rows } = parseCsv(reordered);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.payee, 'COFFEE');
    assert.equal(fmtExact(rows[0]!.amount), '-$5.00');
  });

  test('an unrecognisable header fails loudly instead of importing nothing', () => {
    const { rows, skipped } = parseCsv('foo,bar\n1,2\n');
    assert.equal(rows.length, 0);
    assert.match(skipped[0]!, /could not find date/);
  });

  test('doubled quotes inside a quoted field', () => {
    assert.deepEqual(splitCsvLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c']);
  });

  test('a day that cannot be a month swaps to day-first', () => {
    assert.equal(csvDate('13/08/2026'), '2026-08-13');
    assert.equal(csvDate('08/13/2026'), '2026-08-13');
    assert.equal(csvDate('2026-08-13'), '2026-08-13');
    assert.equal(csvDate('rubbish'), null);
  });
});

describe('telling the formats apart', () => {
  test('by content, not by filename — banks name these files anything', () => {
    assert.equal(looksLikeOfx(QFX), true);
    assert.equal(looksLikeOfx(CSV), false);
    assert.equal(parse(QFX).format, 'ofx');
    assert.equal(parse(CSV).format, 'csv');
  });
});

describe('the key two rows are the same receipt by', () => {
  test('the bank reference is used when there is one', () => {
    const [row] = parseOfx(QFX).rows;
    assert.equal(dedupeKey(row!), 'f:1234567890:2026080301');
  });

  test('the same transaction in two exports keys identically', () => {
    const a = parseOfx(QFX).rows[2]!;                       // from the QFX, account 4321
    const b = { ...a, account: '4321' };
    assert.equal(dedupeKey(a), dedupeKey(b));
  });

  test('without a reference it falls back to date, amount and payee', () => {
    const row = { date: '2026-08-01', payee: 'CORNER SHOP', amount: parseDollars('-5.00'), account: 'x' };
    assert.equal(dedupeKey(row), 'h:2026-08-01:-5.00:corner shop');
  });

  test('two different amounts on the same day are different receipts', () => {
    const base = { date: '2026-08-01', payee: 'SHOP', account: 'x' };
    assert.notEqual(
      dedupeKey({ ...base, amount: parseDollars('-5.00') }),
      dedupeKey({ ...base, amount: parseDollars('-6.00') }));
  });
});
