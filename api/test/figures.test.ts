import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cents } from '../src/money.ts';
import { Store } from '../src/store.ts';
import type { NewEvent } from '../src/store.ts';
import { INCOME } from '../src/types.ts';
import type { Envelope } from '../src/types.ts';
import type { MonthView } from '../src/envelopes.ts';
import { monthView } from '../src/envelopes.ts';
import { PER_YEAR, cardFor, coverFor, hintFor, incomeSuggestion, lastMonthSpent, monthlyOf, perWord, spentOver } from '../src/figures.ts';
import type { Per } from '../src/figures.ts';

const NOW = '2026-11-04T09:00:00Z';

async function fresh(seed: NewEvent[] = []): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-figures-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('alex', [
    { op: 'household.claim', label: 'Rivera' },
    ...seed,
  ]);
  return store;
}

const env = (store: Store, id: string): Envelope => store.state.envelopes.get(id)!;
/** An envelope with no figure yet, under a heading of its own. */
const withEnv = (id: string, label = id): NewEvent[] => [
  { op: 'category.add', category: id, label: label },
  { op: 'envelope.define', envelope: id, label, category: id, template: cents(0), rollover: true, order: 0, needsFigure: true },
];
const txn = (id: string, date: string, amount: number, envelope: string): NewEvent => ({
  op: 'txn.add',
  txns: [{ id, date, payee: 'VALLEY MARKET', amount: cents(amount), dedupeKey: id, envelope }],
});
const hint = (s: Store, id: string) => hintFor(s.state, env(s, id), '2026-11');

describe('hints', () => {
  test("groceries, dining and transport say last month's imports, and offer the 3-month average", async () => {
    const s = await fresh([
      ...withEnv('groceries'), ...withEnv('dining'), ...withEnv('transport'),
      txn('g1', '2026-10-05', -41240, 'groceries'), txn('g2', '2026-10-20', -20000, 'groceries'),
      txn('d1', '2026-10-06', -9000, 'dining'), txn('t1', '2026-10-07', -15000, 'transport'),
      // Not last month, so not in the text; in the 3-month average.
      txn('g3', '2026-09-30', -99900, 'groceries'),
    ]);
    assert.deepEqual(hint(s, 'groceries'), {
      text: "Last month's imports show $612 at grocers",
      use: { cents: 80600, label: 'Use $806 (3-month average)' },
      averages: [{ months: 1, cents: 61200 }, { months: 3, cents: 80600 }, { months: 6, cents: 80600 }],
    });
    assert.equal(hint(s, 'dining')!.text, "Last month's imports show $90 at restaurants");
    assert.equal(hint(s, 'transport')!.text, "Last month's imports show $150 on fuel and transport");
    assert.equal(lastMonthSpent(s.state, 'groceries', '2026-11'), 61240);
  });

  test('no receipts, or refunds that net to nothing, give no hint', async () => {
    const s = await fresh([
      ...withEnv('groceries'), ...withEnv('dining'),
      txn('r1', '2026-10-05', -5000, 'dining'), txn('r2', '2026-10-06', 5000, 'dining'),
    ]);
    assert.equal(hint(s, 'groceries'), null);
    assert.equal(hint(s, 'dining'), null);
  });

  test('the fixed hints, word for word', async () => {
    const ids = ['upkeep', 'homeins', 'carins', 'healthins', 'emergency', 'travel', 'gifts', 'pets'];
    const s = await fresh(ids.flatMap((id) => withEnv(id)));
    assert.deepEqual(hint(s, 'upkeep'), { text: "A common rule is 1% of the home's value a year." });
    for (const id of ['homeins', 'carins', 'healthins']) {
      assert.deepEqual(hint(s, id), { text: "Your policy's annual premium, divided by 12." });
    }
    assert.deepEqual(hint(s, 'emergency'), { text: 'Many start at $1,000, then three months of the envelopes above.' });
    for (const id of ['travel', 'gifts']) {
      assert.deepEqual(hint(s, id), { text: 'A sinking fund: a yearly amount, saved by the month.' });
    }
    assert.equal(hint(s, 'pets'), null);
  });

  test('rent, tax and elec offer pricing while the budget has a location', async () => {
    const s = await fresh([...withEnv('rent'), ...withEnv('tax'), ...withEnv('elec')]);
    for (const id of ['rent', 'tax', 'elec']) assert.equal(hint(s, id), null);
    await s.append('alex', [{ op: 'household.locate', why: 'setup', location: { label: 'Placitas, NM' } }]);
    for (const id of ['rent', 'tax', 'elec']) {
      assert.deepEqual(hint(s, id), { text: 'Public data for Placitas, NM can price this.', price: true });
    }
  });
});

describe('a figure given as the bill is known', () => {
  test('monthlyOf rounds up at the cent', () => {
    assert.equal(monthlyOf({ amount: cents(120000), per: 'year' }), 10000);
    // 4000 × 52 / 12 = 17333.33…: up to the next cent, and twelve of them cover the year.
    assert.equal(monthlyOf({ amount: cents(4000), per: 'week' }), 17334);
    assert.ok(monthlyOf({ amount: cents(4000), per: 'week' }) * 12 >= 4000 * 52);
    assert.equal(monthlyOf({ amount: cents(25000), per: 'quarter' }), 8334);
    assert.equal(monthlyOf({ amount: cents(100000), per: 'month' }), 100000);
    assert.equal(monthlyOf({ amount: cents(1), per: 'year' }), 1);
    assert.equal(monthlyOf({ amount: cents(2600), per: 'fortnight' }), 5634);
    assert.equal(monthlyOf({ amount: cents(60000), per: 'half-year' }), 10000);
  });

  test('perWord and PER_YEAR name every period', () => {
    assert.deepEqual(PER_YEAR, { week: 52, fortnight: 26, month: 12, quarter: 4, 'half-year': 2, year: 1 });
    assert.deepEqual((Object.keys(PER_YEAR) as Per[]).map(perWord), ['week', 'fortnight', 'month', 'quarter', 'half year', 'year']);
  });
});

describe('averages of receipts', () => {
  test('spentOver averages only the months that had receipts', async () => {
    const s = await fresh([
      ...withEnv('pets'), ...withEnv('books'),
      txn('p1', '2026-10-12', -30000, 'pets'),
      // A refund counts against its month.
      txn('p2', '2026-07-03', -10000, 'pets'), txn('p3', '2026-07-20', 2000, 'pets'),
      // This month, and seven months back: in no window.
      txn('p4', '2026-11-01', -99999, 'pets'), txn('p5', '2026-04-30', -99999, 'pets'),
    ]);
    assert.equal(spentOver(s.state, 'pets', '2026-11', 1), 30000);
    assert.equal(spentOver(s.state, 'pets', '2026-11', 3), 30000);
    // Two of the six months had receipts: the mean of those two, not a third of it.
    assert.equal(spentOver(s.state, 'pets', '2026-11', 6), 19000);
    assert.equal(spentOver(s.state, 'books', '2026-11', 6), null);
    assert.equal(lastMonthSpent(s.state, 'pets', '2026-11'), 30000);
    assert.equal(lastMonthSpent(s.state, 'books', '2026-11'), 0);
  });

  test('hintFor offers the averages to any envelope, 3-month first', async () => {
    const s = await fresh([
      ...withEnv('pets'),
      txn('p1', '2026-10-12', -10000, 'pets'), txn('p2', '2026-08-12', -20000, 'pets'), txn('p3', '2026-05-12', -60000, 'pets'),
    ]);
    assert.deepEqual(hint(s, 'pets'), {
      text: 'Your receipts average $150 a month over the last 3 months',
      use: { cents: 15000, label: 'Use $150 (3-month average)' },
      averages: [{ months: 1, cents: 10000 }, { months: 3, cents: 15000 }, { months: 6, cents: 30000 }],
    });
  });

  test('receipts only further back than three months offer the 6-month average to use', async () => {
    const s = await fresh([...withEnv('pets'), txn('p1', '2026-06-12', -45000, 'pets')]);
    assert.deepEqual(hint(s, 'pets'), {
      text: 'Your receipts average $450 a month over the last 6 months',
      use: { cents: 45000, label: 'Use $450 (6-month average)' },
      averages: [{ months: 6, cents: 45000 }],
    });
  });

  test('a priced envelope with receipts keeps its pricing beside the averages', async () => {
    const s = await fresh([...withEnv('rent'), txn('r1', '2026-10-01', -150000, 'rent')]);
    await s.append('alex', [{ op: 'household.locate', why: 'setup', location: { label: 'Placitas, NM' } }]);
    const h = hint(s, 'rent')!;
    assert.equal(h.price, true);
    assert.deepEqual(h.averages, [{ months: 1, cents: 150000 }, { months: 3, cents: 150000 }, { months: 6, cents: 150000 }]);
    assert.equal(h.use!.label, 'Use $1,500 (3-month average)');
  });

  test('an envelope that has receipts gets the averages before its fixed text; with none it keeps it', async () => {
    const s = await fresh([...withEnv('homeins'), ...withEnv('carins'), txn('c1', '2026-10-01', -12000, 'carins')]);
    assert.deepEqual(hint(s, 'homeins'), { text: "Your policy's annual premium, divided by 12." });
    assert.equal(hint(s, 'carins')!.use!.label, 'Use $120 (3-month average)');
  });

  test('a sinking envelope gets no averages', async () => {
    const s = await fresh([
      ...withEnv('travel'),
      { op: 'envelope.define', envelope: 'travel', label: 'travel', category: 'travel', template: cents(0), order: 0, needsFigure: true,
        sinking: { kind: 'by', target: cents(120000), by: '2027-06' } },
      txn('t1', '2026-10-01', -50000, 'travel'),
    ]);
    assert.deepEqual(hint(s, 'travel'), { text: 'A sinking fund: a yearly amount, saved by the month.' });
  });
});

describe('the income suggestion', () => {
  test("is a source's paydays this month, else last month's imports", async () => {
    const s = await fresh();
    assert.equal(incomeSuggestion(s.state, '2026-11'), null);

    await s.append('alex', [txn('i1', '2026-10-01', 320000, INCOME), txn('i2', '2026-10-15', 320000, INCOME)]);
    assert.deepEqual(incomeSuggestion(s.state, '2026-11'), { cents: 640000, from: 'imports' });

    await s.append('alex', [{ op: 'income.source.define', source: 'pay', label: 'Pay', earner: 'alex',
      amount: cents(640000), frequency: 'monthly', anchor: '2026-10-01' }]);
    assert.deepEqual(incomeSuggestion(s.state, '2026-11'), { cents: 640000, from: 'source' });
  });

  test('a biweekly source counts its three paydays, not a twelfth of a year', async () => {
    const s = await fresh([{ op: 'income.source.define', source: 'pay', label: 'Pay', earner: 'alex',
      amount: cents(200000), frequency: 'biweekly', anchor: '2026-11-02' }]);
    assert.deepEqual(incomeSuggestion(s.state, '2026-11'), { cents: 600000, from: 'source' });
  });
});

/** A month with `priced` envelopes funded and `flagged` waiting for a figure. */
function view(o: { income: number; funded: number; priced: number; flagged: number }): MonthView {
  const mk = (i: number, needs: boolean) => ({
    envelope: { id: `e${i}`, label: `E${i}`, order: i, ...(needs ? { needsFigure: true as const } : {}) },
  });
  const envelopes = [
    ...Array.from({ length: o.flagged }, (_, i) => mk(i, true)),
    ...Array.from({ length: o.priced }, (_, i) => mk(o.flagged + i, false)),
  ];
  return { income: o.income, funded: o.funded, toAssign: o.income - o.funded, envelopes } as unknown as MonthView;
}
const GREEN = 'When every envelope has a figure and they add up to income, this card turns green.';

describe('the card', () => {
  test('while envelopes need a figure', () => {
    const c = cardFor(view({ income: 640000, funded: 208800, priced: 3, flagged: 17 }));
    assert.deepEqual(c, {
      tone: 'warm', headline: '$4,312 still to assign',
      line: 'Income is $6,400. The 3 priced envelopes plan $2,088. The other 17 need a figure; give each one and this reaches zero.',
      next: 'e0', green: GREEN,
    });
  });

  test('in its other states', () => {
    const one = cardFor(view({ income: 640000, funded: 100000, priced: 1, flagged: 1 }));
    assert.equal(one.line, 'Income is $6,400. The 1 priced envelope plans $1,000. The other 1 needs a figure; give it one and this reaches zero.');
    assert.equal(cardFor(view({ income: 640000, funded: 0, priced: 0, flagged: 20 })).line,
      'Income is $6,400. None of the 20 envelopes has a figure yet; give each one and this reaches zero.');
    assert.equal(cardFor(view({ income: 640000, funded: 0, priced: 0, flagged: 1 })).line,
      'Income is $6,400. The envelope has no figure yet; give it one and this reaches zero.');

    const left = cardFor(view({ income: 640000, funded: 609000, priced: 2, flagged: 0 }));
    assert.equal(left.tone, 'warm');
    assert.equal(left.headline, '$310 still to assign');
    assert.equal(left.line, 'Income is $6,400 and every envelope has a figure. $310 is still unassigned.');
    assert.equal(left.next, null);

    const done = cardFor(view({ income: 640000, funded: 640000, priced: 2, flagged: 0 }));
    assert.deepEqual([done.tone, done.headline, done.next], ['done', 'Nothing left to assign', null]);
    assert.equal(done.line, 'Income is $6,400 and every envelope has a figure. They add up to the income.');

    const over = cardFor(view({ income: 640000, funded: 671000, priced: 2, flagged: 0 }));
    assert.deepEqual([over.tone, over.headline], ['over', '$310 over']);
    assert.equal(over.line, 'Income is $6,400 and every envelope has a figure. They plan $310 more than the income.');
    assert.equal(cardFor(view({ income: 640000, funded: 671000, priced: 2, flagged: 1 })).tone, 'over');
  });

  test('with no income the line says so', () => {
    assert.equal(cardFor(view({ income: 0, funded: 0, priced: 0, flagged: 20 })).line,
      'No income is set for this month yet. None of the 20 envelopes has a figure yet; give each one and this reaches zero.');
    assert.equal(cardFor(view({ income: 0, funded: 0, priced: 2, flagged: 0 })).line,
      'No income is set for this month yet. Every envelope has a figure. They add up to the income.');
  });

  test('next is the flagged envelope with the lowest order, wherever it is listed', () => {
    const v = {
      income: 640000, funded: 0, toAssign: 640000,
      envelopes: [
        { envelope: { id: 'late', label: 'Late', order: 5, needsFigure: true } },
        { envelope: { id: 'priced', label: 'Priced', order: 0 } },
        { envelope: { id: 'early', label: 'Early', order: 2, needsFigure: true } },
      ],
    } as unknown as MonthView;
    assert.equal(cardFor(v).next, 'early');
  });
});

describe('the cover for a short envelope', () => {
  const TODAY = '2026-11-04';
  // An envelope with a figure, funded by its template when the month opens.
  const funded = (id: string, amount: number, label = id): NewEvent[] => [
    { op: 'category.add', category: id, label: label },
    { op: 'envelope.define', envelope: id, label, category: id, template: cents(amount), rollover: true, order: 0 },
  ];
  const open = (income: number): NewEvent => ({ op: 'month.open', month: '2026-11', income: cents(income) });
  const coverOf = (s: Store, id = 'groceries') => {
    const v = monthView(s.state, '2026-11')!;
    return coverFor(s.state, v, id, TODAY);
  };

  test("a short envelope's cover names the receipt, what it had, and who can spare it", async () => {
    const s = await fresh([
      ...funded('groceries', 4540, 'Groceries'), ...funded('a', 90000), ...funded('b', 50000),
      ...funded('c', 30000), ...funded('d', 1000),
      open(300000),
      txn('g1', '2026-11-03', -8740, 'groceries'),
    ]);
    const c = coverOf(s)!;
    assert.equal(c.amount, 4200);
    assert.equal(c.hadLeft, 4540);
    assert.deepEqual(c.receipt, { payee: 'VALLEY MARKET', amount: 8740 });
    assert.deepEqual(c.donors.map((d) => d.envelope), ['a', 'b', 'c'], '1000 cannot spare 4200, so it is never offered');
  });

  test('an envelope already short before the latest receipt says so', async () => {
    const s = await fresh([
      ...funded('groceries', 1000, 'Groceries'), open(100000),
      txn('g0', '2026-11-01', -3000, 'groceries'), txn('g1', '2026-11-03', -2000, 'groceries'),
    ]);
    const c = coverOf(s)!;
    assert.equal(c.hadLeft, -2000);
    assert.equal(c.alreadyShort, true);
    const t = await fresh([...funded('groceries', 4540, 'Groceries'), open(4540), txn('g1', '2026-11-03', -8740, 'groceries')]);
    assert.equal(coverOf(t)!.alreadyShort, false);
  });

  test('the unassigned option is what is unassigned, up to the shortfall, and absent at zero', async () => {
    const seed = (income: number) => [
      ...funded('groceries', 4540, 'Groceries'), open(income), txn('g1', '2026-11-03', -8740, 'groceries'),
    ];
    assert.equal(coverOf(await fresh(seed(4540 + 100000)))!.assign, 4200);
    assert.equal(coverOf(await fresh(seed(4540 + 2000)))!.assign, 2000);
    assert.equal(coverOf(await fresh(seed(4540)))!.assign, null);
  });

  test('no one can spare it: no donors', async () => {
    const s = await fresh([...funded('groceries', 4540, 'Groceries'), open(4540), txn('g1', '2026-11-03', -8740, 'groceries')]);
    assert.deepEqual(coverOf(s)!.donors, []);
  });

  test('an envelope not short has no cover', async () => {
    const s = await fresh([...funded('groceries', 4540, 'Groceries'), open(4540), txn('g1', '2026-11-03', -4540, 'groceries')]);
    assert.equal(coverOf(s), null);
  });
});
