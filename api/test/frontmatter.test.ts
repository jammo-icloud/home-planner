// api/test/frontmatter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderFrontmatter, parseFrontmatter } from '../src/frontmatter.ts';
import { PAGE_KEYS, type FrontValue } from '../src/types.ts';

const PLAN: Record<string, FrontValue> = {
  planner: 1, kind: 'plan', id: 'p-1', title: 'Fix: the gate', area: 'House', state: 'doing', parent: null,
  due: '2026-11-20', people: ['contacts:4123'], envelope: 'house-repairs', estimate: 185000, event: 'mvsyzlo0-000260',
};

test('keys in their fixed order, quoting only what needs it', () => {
  const out = renderFrontmatter('plan', PLAN, { estimate: 'cents, as everywhere' });
  assert.equal(out, '---\nplanner: 1\nkind: plan\nid: p-1\ntitle: "Fix: the gate"\narea: House\nstate: doing\n'
    + 'parent: null\ndue: 2026-11-20\npeople: [contacts:4123]\nenvelope: house-repairs\n'
    + 'estimate: 185000  # cents, as everywhere\nevent: mvsyzlo0-000260\n---\n\n');
});

test('keys are written in the set order whatever order they were given', () => {
  const shuffled = Object.fromEntries(Object.entries(PLAN).reverse());
  assert.equal(renderFrontmatter('plan', shuffled), renderFrontmatter('plan', PLAN));
});

test('what render wrote, parse reads back', () => {
  const out = renderFrontmatter('plan', PLAN, { estimate: 'cents, as everywhere', due: 'by the 20th' });
  const p = parseFrontmatter(out + 'body')!;
  assert.deepEqual(p.values, PLAN);
  assert.equal(p.body, 'body');
});

test('every kind of value comes back as it went in', () => {
  const awkward: string[] = [
    '', ' padded ', 'a: b', 'a #b', 'two\nlines', 'tab\t', '"quoted"', "it's", '[x]', '{x}', 'a, b', '#tag', '&a', '*a', '!a',
    '|a', '>a', '%a', '@a', '`a', '-5', '0', 'null', 'true', 'false', '~', 'a#b', 'plain words', 'back\\slash', 'ünï 🙂',
  ];
  for (const title of awkward) {
    const out = renderFrontmatter('plan', { ...PLAN, title });
    assert.deepEqual(parseFrontmatter(out)!.values.title, title, JSON.stringify(title));
  }
  const lists: (readonly string[])[] = [[], ['a'], ['a', 'b'], ['a, b', 'c]d', ' e ', '', '1', 'null', '"q"', "it's", 'x #y', 'f: g']];
  for (const people of lists) {
    const out = renderFrontmatter('plan', { ...PLAN, people });
    assert.deepEqual(parseFrontmatter(out)!.values.people, people, JSON.stringify(people));
  }
  for (const estimate of [0, -1, 185000]) {
    const out = renderFrontmatter('plan', { ...PLAN, estimate });
    assert.equal(parseFrontmatter(out)!.values.estimate, estimate);
  }
});

test('what an editor does is still read: key order, spaces, comments, single quotes', () => {
  const p = parseFrontmatter("---\ntitle:   'It''s done'   # mine\nplanner: 1\n---\nrest")!;
  assert.deepEqual(p.values, { title: "It's done", planner: 1 });
  assert.equal(p.body, 'rest');
});

test('a comment is dropped outside quotes and kept inside them', () => {
  const p = parseFrontmatter('---\n# a whole line\na: "x # y"  # gone\nb: \'p # q\' # gone\nc: it\'s  # gone\nd: [ "a # b", c ]  # gone\ne: x#y\n\nf: ~\n---\n')!;
  assert.deepEqual(p.values, { a: 'x # y', b: 'p # q', c: "it's", d: ['a # b', 'c'], e: 'x#y', f: null });
  assert.equal(p.body, '');
});

test('a list splits on commas outside quotes', () => {
  const p = parseFrontmatter('---\nl: [a,  "b, c" , \'d, e\' ,f]\nm: []\n---\n')!;
  assert.deepEqual(p.values, { l: ['a', 'b, c', 'd, e', 'f'], m: [] });
});

test('a key outside the set, or a missing one, is refused by render', () => {
  assert.throws(() => renderFrontmatter('answer', { planner: 1, kind: 'answer', replyTo: 'e1', plan: null, model: 'm', extra: 'x' }), /extra/);
  assert.throws(() => renderFrontmatter('answer', { planner: 1, kind: 'answer', replyTo: 'e1', plan: null }), /model/);
});

test('no fence is null', () => {
  assert.equal(parseFrontmatter('# just markdown'), null);
  assert.equal(parseFrontmatter('---\nnever closed: 1\n'), null);
});

test('a string that looks like a number stays a string', () => {
  const out = renderFrontmatter('plan', { ...PLAN, title: '2026' });
  assert.match(out, /\ntitle: "2026"\n/);
  assert.equal(parseFrontmatter(out)!.values.title, '2026');
  assert.equal(parseFrontmatter('---\ntitle: 2026\n---\n')!.values.title, 2026);
});

test('the key sets are what the pages are written from', () => {
  for (const kind of ['plan', 'briefing', 'answer'] as const) {
    assert.equal(new Set(PAGE_KEYS[kind]).size, PAGE_KEYS[kind].length, kind);
  }
});
