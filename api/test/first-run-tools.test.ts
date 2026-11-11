import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cents } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { ProposalStore, commit, redefine, toolByName } from '../src/tools.ts';
import { ReplayError } from '../src/replay.ts';
import type { Proposal, ToolContext } from '../src/tools.ts';
import { monthView } from '../src/envelopes.ts';
import { STARTER_RULES } from '../src/starter.ts';
import type { NewEvent } from '../src/store.ts';

const NOW = '2026-11-04T09:00:00Z';

/** The Rivera household and nothing else: no categories, no envelopes. */
async function fresh(seed: NewEvent[] = []): Promise<ToolContext> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-first-run-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('alex', [
    { op: 'household.claim', label: 'Rivera' },
    ...seed,
  ]);
  return { store, who: 'alex', today: '2026-11-04', proposals: new ProposalStore(), sid: null };
}

type Row = { label: string; id?: string; category?: string; newCategory?: string };
const make = (c: ToolContext, envelopes: Row[]) =>
  toolByName.get('make_starter_envelopes')!.run({ envelopes }, c) as Proposal;
const income = (c: ToolContext, args: Record<string, unknown>) =>
  toolByName.get('set_month_income')!.run({ ...args }, c) as Proposal;

describe('make_starter_envelopes', () => {
  test('ticked starter rows become envelopes under their starter categories, with no figure', async () => {
    const c = await fresh();
    const p = make(c, [
      { label: 'Rent or mortgage', id: 'rent', category: 'home' },
      { label: 'Groceries', id: 'groceries', category: 'food' },
      { label: 'Health insurance', id: 'healthins', category: 'insurance' },
    ]);
    assert.equal(p.summary, 'Make 3 envelopes');
    assert.ok(p.effects.includes('Every one starts without a figure until it is given one'));
    assert.ok(p.effects.includes('Home: Rent or mortgage'));
    // The starter categories the rows name, in starter order; the rules; then the envelopes.
    assert.deepEqual(p.events.map((e) => e.op === 'category.add' ? e.category : e.op === 'envelope.define' ? e.envelope : e.op),
      ['home', 'food', 'insurance', 'rule.add', 'rule.add', 'rule.add', 'rule.add', 'rent', 'groceries', 'healthins']);
    await commit(p.id, c);

    const e = c.store.state.envelopes.get('rent')!;
    assert.equal(e.category, 'home');
    assert.equal(e.needsFigure, true);
    assert.equal(e.template, 0);
    assert.equal(e.rollover, true);
    assert.deepEqual([...c.store.state.categories.values()].map((x) => x.label), ['Home', 'Food', 'Insurance']);
    assert.equal(c.store.state.rules.length, STARTER_RULES.length);
    assert.deepEqual(c.store.state.rules.map((r) => r.envelope), STARTER_RULES.map((r) => r.envelope));
  });

  test('a renamed row keeps its starter id', async () => {
    const c = await fresh();
    await commit(make(c, [{ label: 'Mortgage', id: 'rent', category: 'home' }]).id, c);
    assert.equal(c.store.state.envelopes.get('rent')!.label, 'Mortgage');
  });

  test('a row of your own takes an id from its name, under a category here or a new one', async () => {
    const c = await fresh([{ op: 'category.add', category: 'everyday', label: 'Everyday' }]);
    const p = make(c, [{ label: 'Pets', category: 'everyday' }, { label: 'Allowance', newCategory: 'Children' }, { label: 'Lessons', newCategory: 'children' }]);
    await commit(p.id, c);
    assert.equal(c.store.state.envelopes.get('pets')!.category, 'everyday');
    assert.equal(c.store.state.envelopes.get('pets')!.needsFigure, true);
    assert.equal(c.store.state.categories.get('children')?.label, 'Children');
    assert.deepEqual(['allowance', 'lessons'].map((id) => c.store.state.envelopes.get(id)!.category), ['children', 'children'], 'one new category, not two');
  });

  test('a starter id or a name already taken takes a fresh id; a starter category here by name is used', async () => {
    const c = await fresh([
      { op: 'category.add', category: 'eating', label: 'Food' },
      { op: 'envelope.define', envelope: 'groceries', label: 'Groceries', category: 'eating', template: cents(0) },
    ]);
    const p = make(c, [{ label: 'Groceries at home', id: 'groceries', category: 'food' }]);
    assert.equal(p.events.some((e) => e.op === 'category.add'), false);
    await commit(p.id, c);
    assert.equal(c.store.state.envelopes.get('groceries-2')!.category, 'eating');
  });

  test('names already taken, a category named twice, or a new category that is here are refused with words', async () => {
    const d = await fresh([
      { op: 'category.add', category: 'food', label: 'Food' },
      { op: 'envelope.define', envelope: 'food', label: 'Groceries', category: 'food', template: cents(0), order: 0 },
    ]);
    const after = d.store.state.lastEventId;
    assert.throws(() => make(d, [{ label: 'groceries ', id: 'groceries', category: 'food' }]), /There is already an envelope called Groceries\./);
    assert.throws(() => make(d, [{ label: 'Dining', category: 'food' }, { label: 'DINING', category: 'food' }]), /DINING is named twice/);
    assert.throws(() => make(d, [{ label: 'Dining', newCategory: ' food' }]), /There is already a category called Food\./);
    assert.throws(() => make(d, [{ label: 'Dining', category: 'food', newCategory: 'Eating' }]), /give one/);
    assert.equal(d.store.state.lastEventId, after);
  });

  test('nothing ticked, a blank name, no category, or an unknown category is refused', async () => {
    const c = await fresh();
    assert.throws(() => make(c, []), /at least one envelope/);
    assert.throws(() => make(c, [{ label: '  ', category: 'home' }]), /name/);
    assert.throws(() => make(c, [{ label: 'Rent' }]), /Rent needs a category/);
    assert.throws(() => make(c, [{ label: 'Rent', category: 'nope' }]), /no category nope/);
    assert.throws(() => make(c, [{ label: '!!!', category: 'home' }]), /letters or numbers/);
  });
});

describe('set_month_income', () => {
  const open = (): NewEvent[] => [
    { op: 'category.add', category: 'rent', label: 'Rent or mortgage' },
    { op: 'envelope.define', envelope: 'rent', label: 'Rent', category: 'rent', template: cents(100000), order: 0 },
    { op: 'month.open', month: '2026-11', income: cents(0) },
  ];

  test("sets the open month's income", async () => {
    const c = await fresh(open());
    await commit(income(c, { amountCents: 640000 }).id, c);
    const v = monthView(c.store.state, '2026-11')!;
    assert.equal(v.income, 640000);
    assert.equal(v.toAssign, 540000);
  });

  test('refuses a month that is not open or is closed', async () => {
    const c = await fresh(open());
    assert.throws(() => income(c, { month: '2026-12', amountCents: 1 }), /2026-12 is not open/);
    assert.throws(() => income(c, { amountCents: -1 }), /not less than nothing/);
    await c.store.append('alex', [{ op: 'month.close', month: '2026-11', closed: true, why: 'done' }]);
    assert.throws(() => income(c, { amountCents: 1 }), /closed/);
  });
});

describe('giving an envelope a figure', () => {
  const flagged = (extra: Record<string, unknown> = {}): NewEvent[] => [
    { op: 'category.add', category: 'groceries', label: 'Groceries' },
    { op: 'envelope.define', envelope: 'groceries', label: 'Groceries', category: 'groceries', template: cents(0), order: 0, needsFigure: true, ...extra } as NewEvent,
    { op: 'month.open', month: '2026-11', income: cents(640000) },
  ];
  const figure = (c: ToolContext, args: Record<string, unknown>) =>
    toolByName.get('set_envelope_figure')!.run({ envelope: 'groceries', ...args }, c) as Proposal;
  const groceries = (c: ToolContext) => c.store.state.envelopes.get('groceries')!;
  const funded = (c: ToolContext, month = '2026-11') =>
    monthView(c.store.state, month)!.envelopes.find((e) => e.envelope.id === 'groceries')!.funded;

  test("a figure writes the template and this month's assignment, and clears the flag", async () => {
    const c = await fresh(flagged());
    const p = figure(c, { amountCents: 61200 });
    assert.deepEqual(p.events.map((e) => e.op), ['envelope.define', 'assign']);
    assert.ok(p.effects[0]!.startsWith('From this month on'));
    await commit(p.id, c);
    assert.equal(groceries(c).template, 61200);
    assert.equal(funded(c), 61200);
    assert.equal('needsFigure' in groceries(c), false);
  });

  test('zero on purpose is a figure', async () => {
    const c = await fresh(flagged());
    await commit(figure(c, { amountCents: 0 }).id, c);
    assert.equal('needsFigure' in groceries(c), false);
  });

  test("a priced envelope's source goes when a person changes the figure", async () => {
    const c = await fresh(flagged({ source: 'a statement' }));
    await commit(figure(c, { amountCents: 50000 }).id, c);
    assert.equal(groceries(c).source, undefined);
  });

  test('in a month that is not open, only the template is written', async () => {
    const c = await fresh(flagged());
    const p = figure(c, { amountCents: 50000, month: '2026-12' });
    assert.deepEqual(p.events.map((e) => e.op), ['envelope.define']);
    assert.ok(p.effects.includes('This month is not open or is closed, so only the months to come change'));
    await commit(p.id, c);
    assert.equal(groceries(c).template, 50000);
    assert.throws(() => figure(c, { amountCents: -1 }), /a figure is not less than nothing/);
  });

  test('define_envelope without a template keeps the template, the flag and the source; with one clears them', async () => {
    const c = await fresh(flagged({ source: 'a statement' }));
    const rename = (extra: Record<string, unknown>) => toolByName.get('define_envelope')!.run({
      envelope: 'groceries', label: 'Food at home', ...extra,
    }, c) as Proposal;
    await commit(rename({}).id, c);
    assert.equal(groceries(c).label, 'Food at home');
    assert.equal(groceries(c).needsFigure, true);
    assert.equal(groceries(c).source, 'a statement');
    assert.equal(groceries(c).template, 0);

    await commit(rename({ templateCents: 50000 }).id, c);
    assert.equal('needsFigure' in groceries(c), false);
    assert.equal(groceries(c).source, undefined);
    assert.equal(groceries(c).template, 50000);
  });

  test('a new envelope defined without a template starts with no figure', async () => {
    const c = await fresh(flagged());
    await c.store.append('alex', [{ op: 'category.add', category: 'pets', label: 'Pets' }]);
    const p = toolByName.get('define_envelope')!.run({
      envelope: 'pets', label: 'Pets', category: 'pets',
    }, c) as Proposal;
    await commit(p.id, c);
    const e = c.store.state.envelopes.get('pets')!;
    assert.equal(e.needsFigure, true);
    assert.equal(e.template, 0);
  });

  test("setting this month's assignment by hand clears the flag, and keeps the template and the source", async () => {
    const c = await fresh(flagged({ source: 'a statement' }));
    const p = toolByName.get('set_assignment')!.run({
      envelope: 'groceries', toCents: 40000, why: 'by hand',
    }, c) as Proposal;
    assert.deepEqual(p.events.map((e) => e.op), ['assign', 'envelope.define']);
    await commit(p.id, c);
    assert.equal(funded(c), 40000);
    assert.equal(groceries(c).template, 0);
    assert.equal('needsFigure' in groceries(c), false);
    assert.equal(groceries(c).source, 'a statement');
  });

  const assign = (c: ToolContext, args: Record<string, unknown>) =>
    toolByName.get('set_assignment')!.run({ envelope: 'groceries', why: 'cover', ...args }, c) as Proposal;
  const receipt = (c: ToolContext, amount: number) => c.store.append('alex', [{ op: 'txn.add', txns: [
    { id: 'r1', date: '2026-11-03', payee: 'VALLEY MARKET #101', amount: cents(-amount), dedupeKey: 'r1', envelope: 'groceries' },
  ] } as NewEvent]);

  test('an assignment only while short is refused once the envelope is no longer short', async () => {
    const c = await fresh(flagged());
    // Nothing spent and nothing funded: available is 0, so it is not short.
    assert.throws(() => assign(c, { toCents: 4000, onlyWhileShort: true }),
      (e: any) => e.status === 409 && /Groceries is no longer short/.test(e.message));
  });

  test('an assignment only while short goes through while it is short', async () => {
    const c = await fresh(flagged());
    await receipt(c, 4000);
    const p = assign(c, { toCents: 4000, onlyWhileShort: true });
    await commit(p.id, c);
    assert.equal(funded(c), 4000);
  });

  test('an assignment without onlyWhileShort is set whether or not it is short', async () => {
    const c = await fresh(flagged());
    const p = assign(c, { toCents: 4000 });
    await commit(p.id, c);
    assert.equal(funded(c), 4000);
  });
});

describe('a figure kept with its basis', () => {
  const plain = (extra: Record<string, unknown> = {}): NewEvent[] => [
    { op: 'category.add', category: 'carins', label: 'Car insurance' },
    { op: 'envelope.define', envelope: 'carins', label: 'Car insurance', category: 'carins', template: cents(10000), order: 0, ...extra } as NewEvent,
    { op: 'month.open', month: '2026-11', income: cents(640000) },
  ];
  const carins = (c: ToolContext) => c.store.state.envelopes.get('carins')!;
  const figure = (c: ToolContext, args: Record<string, unknown>) =>
    toolByName.get('set_envelope_figure')!.run({ envelope: 'carins', ...args }, c) as Proposal;
  const funded = (c: ToolContext) =>
    monthView(c.store.state, '2026-11')!.envelopes.find((e) => e.envelope.id === 'carins')!.funded;
  const YEARLY = { amount: cents(120000), per: 'year' as const };
  const basisOf = (e: NewEvent): unknown => (e as { basis?: unknown }).basis;

  test('redefine carries a basis, and a figure given as a monthly clears it', async () => {
    const c = await fresh(plain({ basis: YEARLY }));
    const env = carins(c);
    assert.deepEqual(env.basis, YEARLY);
    // No figure: everything is carried, the basis among it.
    assert.deepEqual(basisOf(redefine(env, { label: 'Car' })), YEARLY);
    // A figure without a basis is a monthly: the old yearly basis goes.
    assert.equal('basis' in redefine(env, { figure: { template: cents(9000) } }), false);
    // A figure with one writes it.
    const quarterly = { amount: cents(30000), per: 'quarter' as const };
    assert.deepEqual(basisOf(redefine(env, { figure: { template: cents(10000), basis: quarterly } })), quarterly);
    // An envelope with none, rewritten without a figure, stays with none.
    const { basis: _gone, ...bare } = env;
    assert.equal('basis' in redefine(bare, { label: 'Car' }), false);
  });

  test('set_envelope_figure with a basis writes the monthly it computes and keeps the basis', async () => {
    const c = await fresh(plain());
    const p = figure(c, { basis: { amountCents: 120000, per: 'year' } });
    assert.equal(p.summary, 'Car insurance: $1,200.00 a year ($100.00 a month)');
    const define = p.events[0] as { op: string; template: number; basis?: unknown };
    assert.equal(define.template, 10000);
    assert.deepEqual(define.basis, YEARLY);
    assert.deepEqual(p.events[1], { op: 'assign', month: '2026-11', envelope: 'carins', to: 10000, why: 'gave it a figure' });
    await commit(p.id, c);
    assert.equal(carins(c).template, 10000);
    assert.deepEqual(carins(c).basis, YEARLY);
    assert.equal(funded(c), 10000);

    // A week rounds up at the cent; a half year reads as words.
    assert.equal(figure(c, { basis: { amountCents: 4000, per: 'week' } }).summary, 'Car insurance: $40.00 a week ($173.34 a month)');
    assert.equal(figure(c, { basis: { amountCents: 60000, per: 'half-year' } }).summary, 'Car insurance: $600.00 a half year ($100.00 a month)');

    // Given as a monthly, the basis goes.
    await commit(figure(c, { amountCents: 9000 }).id, c);
    assert.equal(carins(c).template, 9000);
    assert.equal('basis' in carins(c), false);
  });

  test('set_envelope_figure refuses both or neither of amountCents and basis, and an unknown per', async () => {
    const c = await fresh(plain());
    assert.throws(() => figure(c, { amountCents: 100, basis: { amountCents: 1200, per: 'year' } }), /give amountCents or basis, not both/);
    assert.throws(() => figure(c, {}), /a figure needs amountCents or basis/);
    assert.throws(() => figure(c, { basis: { amountCents: 1200, per: 'decade' } }),
      /per is one of week, fortnight, month, quarter, half-year, year/);
    assert.throws(() => figure(c, { basis: { amountCents: -1, per: 'year' } }), /a figure is not less than nothing/);
  });

  test('define_envelope takes a basis beside templateCents', async () => {
    const c = await fresh(plain());
    const define = (extra: Record<string, unknown>) => toolByName.get('define_envelope')!.run({
      envelope: 'carins', label: 'Car insurance', ...extra,
    }, c) as Proposal;
    assert.throws(() => define({ templateCents: 100, basis: { amountCents: 1200, per: 'year' } }), /give templateCents or basis, not both/);
    await commit(define({ basis: { amountCents: 25000, per: 'quarter' } }).id, c);
    assert.equal(carins(c).template, 8334);
    assert.deepEqual(carins(c).basis, { amount: 25000, per: 'quarter' });
    // A rename keeps it; a template drops it.
    await commit(define({ label: 'Car' }).id, c);
    assert.deepEqual(carins(c).basis, { amount: 25000, per: 'quarter' });
    await commit(define({ templateCents: 9000 }).id, c);
    assert.equal('basis' in carins(c), false);

    await c.store.append('alex', [{ op: 'category.add', category: 'pets', label: 'Pets' }]);
    await commit((toolByName.get('define_envelope')!.run({
      envelope: 'pets', label: 'Pets', category: 'pets', basis: { amountCents: 1200, per: 'year' },
    }, c) as Proposal).id, c);
    const pets = c.store.state.envelopes.get('pets')!;
    assert.equal(pets.template, 100);
    assert.deepEqual(pets.basis, { amount: 1200, per: 'year' });
    assert.equal('needsFigure' in pets, false);
  });

  test("setting this month's assignment by hand keeps the basis with the template", async () => {
    const c = await fresh(plain({ basis: YEARLY, needsFigure: true }));
    const p = toolByName.get('set_assignment')!.run({
      envelope: 'carins', toCents: 4000, why: 'by hand',
    }, c) as Proposal;
    assert.deepEqual(p.events.map((e) => e.op), ['assign', 'envelope.define']);
    await commit(p.id, c);
    assert.equal(funded(c), 4000);
    assert.equal(carins(c).template, 10000);
    assert.equal('needsFigure' in carins(c), false);
    assert.deepEqual(carins(c).basis, YEARLY);
  });

  test('an envelope.define with a bad basis does not replay', async () => {
    for (const basis of [{ amount: -1, per: 'year' }, { amount: 1000, per: 'decade' }, { amount: 1.5, per: 'year' }, 'yearly', null]) {
      await assert.rejects(() => fresh(plain({ basis })), (e: unknown) =>
        e instanceof ReplayError && /basis/.test(e.message), JSON.stringify(basis));
    }
  });

  test('an envelope.define without basis still replays and the envelope has none', async () => {
    const c = await fresh(plain());
    assert.equal('basis' in carins(c), false);
    // Read back from the log as a fresh load would.
    const again = new Store({ path: c.store.path, now: () => new Date(NOW) });
    await again.load();
    assert.equal('basis' in again.state.envelopes.get('carins')!, false);
  });
});
