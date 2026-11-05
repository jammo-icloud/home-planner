import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cents } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { ProposalStore, commit, toolByName } from '../src/tools.ts';
import type { Proposal, ToolContext } from '../src/tools.ts';
import { monthView } from '../src/envelopes.ts';
import { STARTER_RULES } from '../src/starter.ts';
import type { NewEvent } from '../src/store.ts';

const NOW = '2026-11-04T09:00:00Z';

/** The Rivera household with a budget called Placitas and nothing else: no categories, no envelopes. */
async function fresh(seed: NewEvent[] = []): Promise<ToolContext> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-first-run-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date(NOW) });
  await store.load();
  await store.append('alex', [
    { op: 'household.claim', label: 'Rivera' },
    { op: 'budget.create', budget: 'placitas', label: 'Placitas' },
    ...seed,
  ]);
  return { store, who: 'alex', today: '2026-11-04', proposals: new ProposalStore(), sid: null };
}

type Row = { label: string; group: string; category?: string };
const make = (c: ToolContext, envelopes: Row[]) =>
  toolByName.get('make_starter_envelopes')!.run({ budget: 'placitas', envelopes }, c) as Proposal;
const income = (c: ToolContext, args: Record<string, unknown>) =>
  toolByName.get('set_month_income')!.run({ budget: 'placitas', ...args }, c) as Proposal;

describe('make_starter_envelopes', () => {
  test('ticked starter rows become envelopes in their groups, with no figure', async () => {
    const c = await fresh();
    const p = make(c, [
      { label: 'Rent or mortgage', group: 'Home', category: 'rent' },
      { label: 'Groceries', group: 'Food', category: 'groceries' },
      { label: 'Health insurance', group: 'Insurance', category: 'healthins' },
    ]);
    assert.equal(p.summary, 'Make 3 envelopes in Placitas');
    assert.ok(p.effects.includes('Every one starts as Action required until it has a figure'));
    assert.ok(p.effects.includes('Home: Rent or mortgage'));
    await commit(p.id, c);

    const e = c.store.state.budgets.get('placitas')!.envelopes.get('rent')!;
    assert.equal(e.group, 'Home');
    assert.equal(e.needsFigure, true);
    assert.equal(e.template, 0);
    assert.equal(e.rollover, true);
    assert.deepEqual(e.match.categories, ['rent']);
    assert.equal(c.store.state.categories.get('rent')?.label, 'Rent or mortgage');
    assert.equal(c.store.state.rules.length, STARTER_RULES.length);
  });

  test('a renamed row keeps its category and the category its starter name', async () => {
    const c = await fresh();
    await commit(make(c, [{ label: 'Mortgage', group: 'Home', category: 'rent' }]).id, c);
    assert.equal(c.store.state.budgets.get('placitas')!.envelopes.get('rent')!.label, 'Mortgage');
    assert.equal(c.store.state.categories.get('rent')?.label, 'Rent or mortgage');
  });

  test('a row of your own makes its category', async () => {
    const c = await fresh();
    await commit(make(c, [{ label: 'Pets', group: 'Everyday' }]).id, c);
    assert.equal(c.store.state.categories.get('pets')?.label, 'Pets');
    assert.equal(c.store.state.categories.get('pets')?.kind, 'People');
    assert.equal(c.store.state.budgets.get('placitas')!.envelopes.get('pets')!.needsFigure, true);
  });

  test('a row of your own reuses a category by name', async () => {
    const c = await fresh([{ op: 'category.define', category: 'animals', label: 'Pets' }]);
    const p = make(c, [{ label: 'pets', group: 'Everyday' }]);
    assert.equal(p.events.some((e) => e.op === 'category.define' && e.category === 'pets'), false);
    await commit(p.id, c);
    assert.deepEqual(c.store.state.budgets.get('placitas')!.envelopes.get('animals')!.match.categories, ['animals']);
  });

  test('two rows on one category, or one already fed, are refused with words', async () => {
    const c = await fresh();
    const before = c.store.state.lastEventId;
    assert.throws(() => make(c, [
      { label: 'Groceries', group: 'Food', category: 'groceries' },
      { label: 'Groceries', group: 'Food' },
    ]), /Groceries and Groceries would both be fed by groceries/);
    assert.equal(c.store.state.lastEventId, before);

    const d = await fresh([
      { op: 'category.define', category: 'groceries', label: 'Groceries' },
      { op: 'envelope.define', budget: 'placitas', envelope: 'food', label: 'Food', group: 'Food',
        match: { categories: ['groceries'] }, template: cents(0), order: 0 },
    ]);
    const after = d.store.state.lastEventId;
    assert.throws(() => make(d, [{ label: 'Groceries', group: 'Food', category: 'groceries' }]), /groceries already feeds/);
    assert.equal(d.store.state.lastEventId, after);
  });

  test('nothing ticked, a blank name, or an unknown category is refused', async () => {
    const c = await fresh();
    assert.throws(() => make(c, []), /at least one envelope/);
    assert.throws(() => make(c, [{ label: '  ', group: 'Home' }]), /name/);
    assert.throws(() => make(c, [{ label: 'Rent', group: 'Home', category: 'nope' }]), /no category nope/);
    assert.throws(() => make(c, [{ label: '!!!', group: 'Home' }]), /letters or numbers/);
  });
});

describe('set_month_income', () => {
  const open = (): NewEvent[] => [
    { op: 'category.define', category: 'rent', label: 'Rent or mortgage' },
    { op: 'envelope.define', budget: 'placitas', envelope: 'rent', label: 'Rent', group: 'Home',
      match: { categories: ['rent'] }, template: cents(100000), order: 0 },
    { op: 'month.open', budget: 'placitas', month: '2026-11', income: cents(0) },
  ];

  test("sets the open month's income", async () => {
    const c = await fresh(open());
    await commit(income(c, { amountCents: 640000 }).id, c);
    const v = monthView(c.store.state, 'placitas', '2026-11')!;
    assert.equal(v.income, 640000);
    assert.equal(v.toAssign, 540000);
  });

  test('refuses a month that is not open or is closed', async () => {
    const c = await fresh(open());
    assert.throws(() => income(c, { month: '2026-12', amountCents: 1 }), /2026-12 is not open for Placitas/);
    assert.throws(() => income(c, { amountCents: -1 }), /not less than nothing/);
    await c.store.append('alex', [{ op: 'month.close', budget: 'placitas', month: '2026-11', closed: true, why: 'done' }]);
    assert.throws(() => income(c, { amountCents: 1 }), /closed/);
  });
});

describe('giving an envelope a figure', () => {
  const flagged = (extra: Record<string, unknown> = {}): NewEvent[] => [
    { op: 'category.define', category: 'groceries', label: 'Groceries' },
    { op: 'envelope.define', budget: 'placitas', envelope: 'groceries', label: 'Groceries', group: 'Food',
      match: { categories: ['groceries'] }, template: cents(0), order: 0, needsFigure: true, ...extra } as NewEvent,
    { op: 'month.open', budget: 'placitas', month: '2026-11', income: cents(640000) },
  ];
  const figure = (c: ToolContext, args: Record<string, unknown>) =>
    toolByName.get('set_envelope_figure')!.run({ budget: 'placitas', envelope: 'groceries', ...args }, c) as Proposal;
  const groceries = (c: ToolContext) => c.store.state.budgets.get('placitas')!.envelopes.get('groceries')!;
  const funded = (c: ToolContext, month = '2026-11') =>
    monthView(c.store.state, 'placitas', month)!.envelopes.find((e) => e.envelope.id === 'groceries')!.funded;

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
      budget: 'placitas', envelope: 'groceries', label: 'Food at home', group: 'Food',
      categories: ['groceries'], ...extra,
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
    await c.store.append('alex', [{ op: 'category.define', category: 'pets', label: 'Pets' }]);
    const p = toolByName.get('define_envelope')!.run({
      budget: 'placitas', envelope: 'pets', label: 'Pets', group: 'Everyday', categories: ['pets'],
    }, c) as Proposal;
    await commit(p.id, c);
    const e = c.store.state.budgets.get('placitas')!.envelopes.get('pets')!;
    assert.equal(e.needsFigure, true);
    assert.equal(e.template, 0);
  });

  test("setting this month's assignment by hand clears the flag, and keeps the template and the source", async () => {
    const c = await fresh(flagged({ source: 'a statement' }));
    const p = toolByName.get('set_assignment')!.run({
      budget: 'placitas', envelope: 'groceries', toCents: 40000, why: 'by hand',
    }, c) as Proposal;
    assert.deepEqual(p.events.map((e) => e.op), ['assign', 'envelope.define']);
    await commit(p.id, c);
    assert.equal(funded(c), 40000);
    assert.equal(groceries(c).template, 0);
    assert.equal('needsFigure' in groceries(c), false);
    assert.equal(groceries(c).source, 'a statement');
  });

  const assign = (c: ToolContext, args: Record<string, unknown>) =>
    toolByName.get('set_assignment')!.run({ budget: 'placitas', envelope: 'groceries', why: 'cover', ...args }, c) as Proposal;
  const receipt = (c: ToolContext, amount: number) => c.store.append('alex', [{ op: 'txn.add', txns: [
    { id: 'r1', date: '2026-11-03', payee: 'VALLEY MARKET #101', amount: cents(-amount), dedupeKey: 'r1', category: 'groceries' },
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
