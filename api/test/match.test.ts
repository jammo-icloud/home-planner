import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDollars } from '../src/money.ts';
import { Store } from '../src/store.ts';
import { SPLIT } from '../src/types.ts';
import { setClaudeClient } from '../src/claude.ts';
import {
  pickerOptions, ruleProblem, suggest, suggestForRows, matchModel, modelChoices, modelSource,
  DEFAULT_MATCH_MODEL, MATCH_MODELS, MATCH_THRESHOLD, SPLIT_OPTION,
} from '../src/match.ts';
import { toolByName, commit, ProposalStore } from '../src/tools.ts';
import type { Proposal } from '../src/tools.ts';
import { fake, said } from './fake-claude.ts';

async function household(): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-match-')), 'events.jsonl');
  const store = new Store({ path, now: () => new Date('2026-08-13T09:00:00Z') });
  await store.load();
  await store.append('alice', [
    { op: 'household.claim', label: 'Home' },
    { op: 'category.add', category: 'people', label: 'People' },
    { op: 'category.add', category: 'house', label: 'House' },
    { op: 'envelope.define', envelope: 'food', label: 'Food', category: 'people', template: parseDollars('600.00'), order: 0 },
    { op: 'envelope.define', envelope: 'util', label: 'Utilities', category: 'house', template: parseDollars('300.00'), order: 1 },
    { op: 'envelope.define', envelope: 'util-old', label: 'Utilities — old house', category: 'house', template: parseDollars('150.00'), order: 2 },
    { op: 'envelope.define', envelope: 'vet', label: 'Vet', category: 'people', template: parseDollars('40.00'), order: 3 },
  ]);
  return store;
}

const sentText = (call: any): string => JSON.stringify(call.messages);
const reply = (matches: unknown[]) => said(JSON.stringify({ matches }));

afterEach(() => { setClaudeClient(null); });

describe('the picker speaks in envelopes', () => {
  test('an envelope is offered by its name, its id the value, under its category', async () => {
    const o = pickerOptions((await household()).state).find((x) => x.value === 'food')!;
    assert.deepEqual(o, { value: 'food', label: 'Food', group: 'People' });
  });

  test('envelopes come in category order, then envelope order, then not spending, then split', async () => {
    const opts = pickerOptions((await household()).state);
    assert.deepEqual(opts.map((x) => x.value), ['food', 'vet', 'util', 'util-old', '__transfer', '__income', '__split']);
    assert.deepEqual([...new Set(opts.map((x) => x.group))], ['People', 'House', 'Not spending', 'Several envelopes']);
  });

  test('only live envelopes are offered: no other heading, and a removed envelope is gone', async () => {
    const store = await household();
    await store.append('alice', { op: 'envelope.remove', envelope: 'util-old', why: 'moved out' });
    const opts = pickerOptions(store.state);
    assert.equal(opts.some((x) => x.value === 'util-old'), false);
    assert.equal(opts.some((x) => x.group === 'Not in this budget'), false);
  });

  test('transfer and income are always offered', async () => {
    const values = pickerOptions((await household()).state).map((x) => x.value);
    assert.ok(values.includes('__transfer') && values.includes('__income'));
  });

  test('the picker ends with the split option, and the model is offered it', async () => {
    const state = (await household()).state;
    const opts = pickerOptions(state);
    assert.deepEqual(opts.at(-1), SPLIT_OPTION);
    assert.deepEqual(SPLIT_OPTION, { value: '__split', label: 'Split across envelopes…', group: 'Several envelopes' });
    const f = fake([reply([])]);
    await suggest(state, ['BIGBOX WHSE #0100'], opts);
    const sent = JSON.parse(f.calls[0].messages.at(-1).content);
    assert.ok(sent.envelopes.some((e: any) => e.id === '__split' && e.group === 'Several envelopes'));
  });
});

describe("the household's model", () => {
  test("the household's model is the one asked, else the deployment's, else the default", async () => {
    const store = await household();
    const options = pickerOptions(store.state);
    const f = fake([reply([]), reply([])]);
    await suggest(store.state, ['ACME'], options);
    assert.equal(f.calls[0].model, 'claude-haiku-5-5');
    await store.append('alice', { op: 'envelopes.model', model: 'claude-sonnet-5-5' });
    await suggest(store.state, ['ACME'], options);
    assert.equal(f.calls[1].model, 'claude-sonnet-5-5');
  });

  test('the deployment model is read on each call, and the household outranks it', async () => {
    const store = await household();
    const was = process.env['CLAUDE_MATCH_MODEL'];
    process.env['CLAUDE_MATCH_MODEL'] = 'claude-opus-5-5';
    try {
      const f = fake([reply([]), reply([])]);
      const options = pickerOptions(store.state);
      await suggest(store.state, ['ACME'], options);
      assert.equal(f.calls[0].model, 'claude-opus-5-5');
      await store.append('alice', { op: 'envelopes.model', model: 'claude-sonnet-5-5' });
      await suggest(store.state, ['ACME'], options);
      assert.equal(f.calls[1].model, 'claude-sonnet-5-5');
    } finally {
      if (was === undefined) delete process.env['CLAUDE_MATCH_MODEL']; else process.env['CLAUDE_MATCH_MODEL'] = was;
    }
  });

  test('which of the three it came from is said in the words the screens use', async () => {
    const store = await household();
    assert.equal(modelSource(store.state, {}), 'default');
    assert.equal(matchModel(store.state, {}), DEFAULT_MATCH_MODEL);
    assert.equal(modelSource(store.state, { CLAUDE_MATCH_MODEL: 'claude-opus-5-5' }), 'from the deployment');
    assert.equal(matchModel(store.state, { CLAUDE_MATCH_MODEL: 'claude-opus-5-5' }), 'claude-opus-5-5');
    await store.append('alice', { op: 'envelopes.model', model: 'claude-sonnet-5-5' });
    assert.equal(modelSource(store.state, { CLAUDE_MATCH_MODEL: 'claude-opus-5-5' }), 'saved');
    assert.equal(matchModel(store.state, { CLAUDE_MATCH_MODEL: 'claude-opus-5-5' }), 'claude-sonnet-5-5');
    await store.append('alice', { op: 'envelopes.model', model: null });
    assert.equal(modelSource(store.state, {}), 'default');
  });

  test("the compose files pass an empty .env's model on as empty, so the row says default", async () => {
    const store = await household();
    for (const file of ['docker-compose.yml', 'docker.yml']) {
      const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
      const line = text.split('\n').find((l) => l.trim().startsWith('CLAUDE_MATCH_MODEL:'));
      assert.equal(line?.trim(), 'CLAUDE_MATCH_MODEL: "${CLAUDE_MATCH_MODEL:-}"', file);
    }
    // What compose passes when .env leaves it out.
    assert.equal(modelSource(store.state, { CLAUDE_MATCH_MODEL: '' }), 'default');
  });

  test('the deployment model is offered too, and marked', () => {
    assert.deepEqual(modelChoices({ CLAUDE_MATCH_MODEL: 'claude-opus-5-5' }).at(-1),
      { id: 'claude-opus-5-5', label: 'claude-opus-5-5', fromDeployment: true });
    assert.deepEqual(modelChoices({}).map((c) => [c.id, c.fromDeployment]), MATCH_MODELS.map((m) => [m.id, false]));
    assert.equal(modelChoices({ CLAUDE_MATCH_MODEL: 'claude-sonnet-5-5' }).length, MATCH_MODELS.length, 'one already on the list is not offered twice');
  });
});

describe('Haiku suggests', () => {
  test('it is sent only payees and labels, once each', async () => {
    const state = (await household()).state;
    const f = fake([reply([])]);
    await suggest(state, ['HILLTOP FOODS #12', 'HILLTOP FOODS #12', 'EXAMPLE ENERGY'], pickerOptions(state));
    assert.equal(f.calls.length, 1);
    const text = sentText(f.calls[0]);
    assert.equal(text.match(/HILLTOP FOODS #12/g)?.length, 1);
    assert.doesNotMatch(text, /\$/);
    assert.doesNotMatch(text, /2026-\d\d-\d\d/);
    assert.equal(f.calls[0].model, 'claude-haiku-5-5');
    assert.equal(f.calls[0].output_config.format.type, 'json_schema');
    assert.equal(f.calls[0].temperature, undefined);
  });

  test('a low-confidence, unknown or unasked answer is dropped', async () => {
    const state = (await household()).state;
    fake([reply([
      { payee: 'HILLTOP FOODS', choice: 'food', confidence: 0.95 },
      { payee: 'EXAMPLE ENERGY', choice: 'util', confidence: MATCH_THRESHOLD - 0.1 },
      { payee: 'MYSTERY', choice: 'nope', confidence: 0.99 },
      { payee: 'NOT SENT', choice: 'food', confidence: 0.99 },
    ])]);
    const got = await suggest(state, ['HILLTOP FOODS', 'EXAMPLE ENERGY', 'MYSTERY'], pickerOptions(state));
    assert.deepEqual([...got.entries()], [['HILLTOP FOODS', { value: 'food', confidence: 0.95 }]]);
  });

  test('no key means no call and no suggestions', async () => {
    setClaudeClient(null);
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const state = (await household()).state;
      const got = await suggest(state, ['HILLTOP FOODS'], pickerOptions(state));
      assert.equal(got.size, 0);
    } finally { if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved; }
  });
});

describe('suggesting for an import', () => {
  const rows = [
    { id: 'a', payee: 'HILLTOP FOODS', envelope: null },
    { id: 'b', payee: 'PAYROLL ACME', envelope: '__income' },
  ];

  test('rows a rule sorted are never sent', async () => {
    const state = (await household()).state;
    const f = fake([reply([{ payee: 'HILLTOP FOODS', choice: 'food', confidence: 0.9 }])]);
    const out = await suggestForRows(state, rows);
    assert.doesNotMatch(sentText(f.calls[0]), /PAYROLL/);
    assert.deepEqual([...out.suggested.entries()], [['a', { value: 'food', confidence: 0.9 }]]);
  });

  test('when Haiku fails, there are no suggestions and it says why', async () => {
    const state = (await household()).state;
    fake([Object.assign(new Error('529 overloaded'), { status: 529 })]);
    const out = await suggestForRows(state, rows);
    assert.equal(out.suggested.size, 0);
    assert.match(out.error ?? '', /overloaded/);
  });

  test('nothing unsorted means no call at all', async () => {
    const state = (await household()).state;
    const f = fake([]);
    await suggestForRows(state, [rows[1]!]);
    assert.equal(f.calls.length, 0);
  });
});

describe('Haiku may answer split, and writes the rule', () => {
  const ledger = async () => {
    const store = await household();
    await store.append('alice', [
      { op: 'txn.add', txns: [
        { id: 'c', date: '2026-08-05', payee: 'BIGBOX WHSE #0100', amount: parseDollars('-165.00'), dedupeKey: 'c', envelope: null },
        { id: 'k', date: '2026-08-06', payee: 'HILLTOP FOODS #12', amount: parseDollars('-40.00'), dedupeKey: 'k', envelope: 'food' },
      ] },
      { op: 'txn.split', txn: 'c', parts: [{ envelope: 'food', amount: parseDollars('-120.00') }, { envelope: 'vet', amount: parseDollars('-45.00') }] },
      { op: 'rule.add', rule: 'r-power', match: 'EXAMPLE POWER', envelope: 'util' },
    ]);
    return store.state;
  };

  test('a split answer keeps only known, non-split parts', async () => {
    const state = await ledger();
    fake([reply([{ payee: 'BIGBOX WHSE #0999', choice: '__split', confidence: 0.9, rule: 'bigbox',
      parts: ['food', 'nope', '__split', 'food'] }])]);
    const got = await suggest(state, ['BIGBOX WHSE #0999'], pickerOptions(state));
    assert.deepEqual(got.get('BIGBOX WHSE #0999'), { value: '__split', confidence: 0.9, rule: 'bigbox', parts: ['food'] });
  });

  test('parts are dropped when the choice is one envelope, and an empty list is omitted', async () => {
    const state = await ledger();
    fake([reply([
      { payee: 'QUIKSTOP', choice: 'food', confidence: 0.9, rule: 'quik', parts: ['food', 'vet'] },
      { payee: 'TARGET', choice: '__split', confidence: 0.9, rule: 'target', parts: ['nope', '__split'] },
    ])]);
    const got = await suggest(state, ['QUIKSTOP', 'TARGET'], pickerOptions(state));
    assert.deepEqual(got.get('QUIKSTOP'), { value: 'food', confidence: 0.9, rule: 'quik' });
    assert.deepEqual(got.get('TARGET'), { value: '__split', confidence: 0.9, rule: 'target' });
  });

  test('the rule is kept only when it is at least 3 letters, in the payee, and contradicts nothing', async () => {
    const state = await ledger();
    assert.equal(ruleProblem(state, 'HILLTOP FOODS #12 SPRINGFIELD', 'hilltop foods', 'food'), null);
    assert.match(ruleProblem(state, 'HILLTOP FOODS #12 SPRINGFIELD', 'ki', 'food')!, /3 characters/);
    assert.match(ruleProblem(state, 'HILLTOP FOODS #12 SPRINGFIELD', 'walmart', 'food')!, /not in the payee/);
    assert.match(ruleProblem(state, 'BIGBOX WHSE #0100', 'bigbox', 'food')!, /already filed/);
    assert.equal(ruleProblem(state, 'BIGBOX WHSE #0100', 'bigbox', SPLIT), null);
    assert.match(ruleProblem(state, 'EXAMPLE POWER BILLPAY', 'EXAMPLE POWER', 'util')!, /already a rule/);
    assert.match(ruleProblem(state, 'EXAMPLE POWER BILLPAY', '', 'util')!, /3 characters/);
  });

  test('a good rule rides along with the suggestion', async () => {
    const state = await ledger();
    fake([reply([{ payee: 'QUIKSTOP #5', choice: 'food', confidence: 0.9, rule: 'quik' }])]);
    const got = await suggest(state, ['QUIKSTOP #5'], pickerOptions(state));
    assert.deepEqual(got.get('QUIKSTOP #5'), { value: 'food', confidence: 0.9, rule: 'quik' });
  });

  test('a suggestion survives a bad rule; the rule does not', async () => {
    const state = await ledger();
    fake([reply([
      { payee: 'QUIKSTOP #5', choice: 'food', confidence: 0.9, rule: 'qu' },
      { payee: 'SHELL OIL', choice: 'food', confidence: 0.9, rule: 'chevron' },
      { payee: 'BIGBOX GAS', choice: 'food', confidence: 0.9, rule: 'bigbox' },
      { payee: 'EXAMPLE POWER BILLPAY', choice: 'util', confidence: 0.9, rule: 'example power' },
    ])]);
    const got = await suggest(state, ['QUIKSTOP #5', 'SHELL OIL', 'BIGBOX GAS', 'EXAMPLE POWER BILLPAY'], pickerOptions(state));
    assert.equal(got.size, 4);
    for (const [payee, value] of [['QUIKSTOP #5', 'food'], ['SHELL OIL', 'food'], ['BIGBOX GAS', 'food'], ['EXAMPLE POWER BILLPAY', 'util']] as const) {
      assert.deepEqual(got.get(payee), { value, confidence: 0.9 }, payee);
    }
  });

  test('rows a split rule caught are never sent, from either screen', async () => {
    const state = await ledger();
    // The import screen: the rule already marked the row split.
    const f = fake([]);
    const imported = await suggestForRows(state, [{ id: 'i', payee: 'BIGBOX WHSE', envelope: '__split' }]);
    assert.equal(f.calls.length, 0);
    assert.equal(imported.suggested.size, 0);
    assert.equal(imported.toDivide.size, 0, 'a row already marked split is skipped, not counted as unsorted');

    // The queue: the row is open, but a rule in the ledger says split.
    const store = await household();
    await store.append('alice', { op: 'rule.add', rule: 'r-c', match: 'BIGBOX', envelope: '__split' });
    const g = fake([reply([{ payee: 'HILLTOP FOODS', choice: 'food', confidence: 0.9, rule: 'hilltop foods' }])]);
    const queue = await suggestForRows(store.state, [
      { id: 'q', payee: 'BIGBOX WHSE', envelope: null },
      { id: 'm', payee: 'WAREHOUSE', memo: 'bigbox run', envelope: null },
      { id: 'k', payee: 'HILLTOP FOODS', envelope: null },
    ]);
    assert.deepEqual([...queue.toDivide].sort(), ['m', 'q']);
    assert.doesNotMatch(sentText(g.calls[0]), /BIGBOX|WAREHOUSE/);
    assert.deepEqual([...queue.suggested.entries()],
      [['k', { value: 'food', confidence: 0.9, rule: 'hilltop foods' }]]);
  });

  test('when only split rows are open there is no call at all', async () => {
    const store = await household();
    await store.append('alice', { op: 'rule.add', rule: 'r-c', match: 'BIGBOX', envelope: '__split' });
    const f = fake([]);
    const out = await suggestForRows(store.state, [{ id: 'q', payee: 'BIGBOX WHSE', envelope: null }]);
    assert.equal(f.calls.length, 0);
    assert.deepEqual([...out.toDivide], ['q']);
    assert.equal(out.suggested.size, 0);
  });
});

describe('accepting a suggestion on the Unsorted list', () => {
  test('is recorded as suggested by Claude; anything else is refused', async () => {
    const store = await household();
    await store.append('alice', { op: 'txn.add', txns: [
      { id: 'u1', date: '2026-08-02', payee: 'SAFEWAY', amount: parseDollars('-9.00'), dedupeKey: 'u1', envelope: null }] });
    const ctx = { store, who: 'alice', today: '2026-08-13', proposals: new ProposalStore(), sid: null };
    const run = (a: Record<string, unknown>) =>
      toolByName.get('sort_receipts')!.run({ assignments: [a] }, ctx) as Proposal;
    assert.throws(() => run({ txnId: 'u1', envelope: 'food', suggestedBy: 'someone' }), /suggestedBy/);
    await commit(run({ txnId: 'u1', envelope: 'food', suggestedBy: 'claude' }).id, ctx);
    assert.equal(store.state.txns.get('u1')?.suggestedBy, 'claude');
  });
});

describe('ruleProblem', () => {
  const rules = async () => {
    const store = await household();
    await store.append('alice', [
      { op: 'txn.add', txns: [
        { id: 'a', date: '2026-08-03', payee: 'VALLEY MARKET #101', amount: parseDollars('-84.21'), dedupeKey: 'a', envelope: 'food' },
        { id: 'b', date: '2026-08-04', payee: 'EXAMPLE POWER BILL', memo: 'Valley gift', amount: parseDollars('-120.00'), dedupeKey: 'b', envelope: 'util' },
        { id: 'c', date: '2026-08-05', payee: 'BIGBOX WHSE', amount: parseDollars('-165.00'), dedupeKey: 'c', envelope: null },
      ] },
      { op: 'txn.split', txn: 'c', parts: [{ envelope: 'food', amount: parseDollars('-120.00') }, { envelope: 'vet', amount: parseDollars('-45.00') }] },
      { op: 'rule.add', rule: 'r-power', match: 'EXAMPLE POWER', envelope: 'util' },
    ]);
    return store.state;
  };

  test('an empty or short match is a problem, even with no payee to look in', async () => {
    const s = await rules();
    assert.equal(ruleProblem(s, null, '', 'food'), 'a rule needs at least 3 characters');
    assert.equal(ruleProblem(s, null, '  ', 'food'), 'a rule needs at least 3 characters');
    assert.equal(ruleProblem(s, 'QUIKSTOP', 'QU', 'food'), 'a rule needs at least 3 characters');
  });

  test('the payee is only checked when one is given, and case does not matter', async () => {
    const s = await rules();
    assert.equal(ruleProblem(s, 'QUIKSTOP 5', 'quik', 'vet'), null);
    assert.equal(ruleProblem(s, 'QUIKSTOP 5', 'shell', 'vet'), 'not in the payee');
    assert.equal(ruleProblem(s, null, 'shell', 'vet'), null);
  });

  test('a match that is already a rule is a problem, case-insensitively', async () => {
    const s = await rules();
    assert.equal(ruleProblem(s, null, 'example power', 'util'), 'already a rule');
  });

  test('a match that hits receipts filed elsewhere names where, by label', async () => {
    const s = await rules();
    // "valley" is in a's payee (Food) and b's memo (Utilities), as byRule() reads them.
    assert.equal(ruleProblem(s, null, 'valley', 'vet'), 'already filed under Food, Utilities');
    assert.equal(ruleProblem(s, null, 'valley', 'food'), 'already filed under Utilities', 'its own target is not a conflict');
  });

  test('a split receipt counts as filed under a split, unless the rule targets split', async () => {
    const s = await rules();
    assert.equal(ruleProblem(s, null, 'bigbox', 'food'), 'already filed under a split');
    assert.equal(ruleProblem(s, null, 'bigbox', SPLIT), null);
  });

  test('an unsorted receipt never blocks', async () => {
    const store = await household();
    await store.append('alice', [
      { op: 'txn.add', txns: [{ id: 'u', date: '2026-08-05', payee: 'QUIKSTOP', amount: parseDollars('-10.15'), dedupeKey: 'u', envelope: null }] },
    ]);
    assert.equal(ruleProblem(store.state, null, 'quik', 'food'), null);
  });
});
