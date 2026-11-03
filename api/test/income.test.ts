import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { paydaysIn, incomeFor, project, monthlyTotal, nextMonth } from '../src/income.ts';
import type { IncomeSource, Frequency } from '../src/income.ts';
import { parseDollars, fmt } from '../src/money.ts';

const source = (over: Partial<IncomeSource> & { frequency: Frequency; anchor: string }): IncomeSource => ({
  id: 's1', budget: 'harbor', label: 'Salary', who: 'alice',
  amount: parseDollars('1000.00'),
  ...over,
} as IncomeSource);

describe('counting real paydays', () => {
  test('fortnightly pays three times in the months it does', () => {
    // 2026-01-02 is a Friday. Paying every two weeks from there lands on
    // Jan 2, 16, 30 — three in January — and twice in February.
    const s = source({ frequency: 'biweekly', anchor: '2026-01-02' });
    assert.deepEqual(paydaysIn(s, '2026-01'), ['2026-01-02', '2026-01-16', '2026-01-30']);
    assert.equal(paydaysIn(s, '2026-02').length, 2);
  });

  test('over a year it is 26 payments, not 24', () => {
    const s = source({ frequency: 'biweekly', anchor: '2026-01-02' });
    let total = 0;
    for (let m = 1; m <= 12; m++) total += paydaysIn(s, `2026-${String(m).padStart(2, '0')}`).length;
    assert.equal(total, 26, 'the two extra paydays are the whole point of counting');
  });

  test('twice a month is always exactly twice, whatever the month', () => {
    const s = source({ frequency: 'semimonthly', anchor: '2026-01-15' });
    for (const m of ['2026-01', '2026-02', '2026-06']) {
      assert.equal(paydaysIn(s, m).length, 2, `${m} should pay twice`);
    }
  });

  test('a monthly salary on the 31st still pays in February', () => {
    const s = source({ frequency: 'monthly', anchor: '2026-01-31' });
    assert.deepEqual(paydaysIn(s, '2026-02'), ['2026-02-28']);
    assert.deepEqual(paydaysIn(s, '2026-04'), ['2026-04-30']);
  });

  test('weekly lands five times in some months', () => {
    const s = source({ frequency: 'weekly', anchor: '2026-01-02' });
    assert.equal(paydaysIn(s, '2026-01').length, 5);
    assert.equal(paydaysIn(s, '2026-02').length, 4);
  });

  test('nothing is paid before it starts', () => {
    const s = source({ frequency: 'biweekly', anchor: '2026-06-05' });
    assert.deepEqual(paydaysIn(s, '2026-05'), []);
    assert.ok(paydaysIn(s, '2026-06').length > 0);
  });

  test('nothing is paid after it stops', () => {
    const s = source({ frequency: 'monthly', anchor: '2026-01-15', until: '2026-03' });
    assert.equal(paydaysIn(s, '2026-03').length, 1);
    assert.deepEqual(paydaysIn(s, '2026-04'), []);
  });

  test('a one-off pays exactly once, in its own month', () => {
    const s = source({ frequency: 'once', anchor: '2026-05-20' });
    assert.deepEqual(paydaysIn(s, '2026-05'), ['2026-05-20']);
    assert.deepEqual(paydaysIn(s, '2026-06'), []);
  });

  test('an annual payment returns on its anniversary', () => {
    const s = source({ frequency: 'annual', anchor: '2026-03-01' });
    assert.equal(paydaysIn(s, '2026-03').length, 1);
    assert.equal(paydaysIn(s, '2027-03').length, 1);
    assert.equal(paydaysIn(s, '2026-04').length, 0);
  });

  test('the month total is the payday count times the amount, never an average', () => {
    const s = source({ frequency: 'biweekly', anchor: '2026-01-02', amount: parseDollars('1500.00') });
    assert.equal(fmt(monthlyTotal(s, '2026-01')), '$4,500', 'three paydays');
    assert.equal(fmt(monthlyTotal(s, '2026-02')), '$3,000', 'two');
  });
});

describe('what a second income would do', () => {
  const alice = source({
    id: 'j', label: 'Alice — salary', who: 'alice',
    frequency: 'semimonthly', anchor: '2026-01-15', amount: parseDollars('4800.00'),
  });
  const bob = source({
    id: 'h', label: 'Bob — new job', who: 'bob',
    frequency: 'biweekly', anchor: '2026-09-04', amount: parseDollars('1500.00'),
  });

  test('one income on its own', () => {
    assert.equal(fmt(incomeFor([alice], '2026-09').total), '$9,600');
  });

  test('adding a hypothetical income changes nothing on disk — it is arithmetic', () => {
    const withJob = incomeFor([alice, bob], '2026-09');
    assert.equal(fmt(withJob.total), '$12,600');
    assert.equal(withJob.lines.length, 2);
    // The original list is untouched; a scenario is a question, not a change.
    assert.equal(fmt(incomeFor([alice], '2026-09').total), '$9,600');
  });

  test('the three-paycheque month is called out, because it is the one people miss', () => {
    const months = project([alice, bob], '2026-09', 6);
    const flagged = months.filter((m) => m.extraPayday).map((m) => m.month);
    assert.ok(flagged.length >= 1, 'at least one month in six carries a third payment');
    for (const m of months) {
      const line = m.lines.find((l) => l.who === 'bob')!;
      assert.equal(line.paydays === 3, m.extraPayday);
    }
  });

  test('a projection is month by month, never an annual figure over twelve', () => {
    // "Can we cover the plan in March" is the question, and an average cannot
    // answer it — the months genuinely differ.
    const months = project([bob], '2026-09', 12);
    const totals = new Set(months.map((m) => m.total));
    assert.ok(totals.size > 1, 'the months are not all the same, and should not read as if they were');
  });

  test('a job that starts later shows up only from then', () => {
    const months = project([alice, bob], '2026-07', 4);
    assert.equal(months[0]!.lines.length, 1, 'July: just Alice');
    assert.equal(months[0]!.month, '2026-07');
    assert.equal(months[2]!.lines.length, 2, 'September: both');
  });

  test('a job that ends stops counting', () => {
    const contract = { ...bob, until: '2026-10' as const };
    const months = project([contract], '2026-09', 4);
    assert.ok(months[0]!.total > 0);
    assert.equal(months[2]!.total, 0, 'November pays nothing');
  });

  test('months roll over the year end', () => {
    assert.equal(nextMonth('2026-12'), '2027-01');
    assert.equal(project([alice], '2026-11', 3).map((m) => m.month).join(','), '2026-11,2026-12,2027-01');
  });
});
