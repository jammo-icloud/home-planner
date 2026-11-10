import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = read('../../site/index.html');
const at = page.indexOf('<script type="module">');
const markup = page.slice(0, at);
const script = page.slice(at, page.lastIndexOf('</script>'));
const server = read('../src/server.ts').replaceAll('\\/', '/');
const tools = read('../src/tools.ts');
/** Plan's own markup: "Mine" and "Theirs" stay in Today's filters until 0.8.0. */
const planMarkup = markup.slice(markup.indexOf('<div id="plan"'), markup.indexOf('<div id="plan-card"'));
type Line = readonly [row: string, text: string];
/** On the page before 0.7.0 and after it: the ledger's Kept rows, and what other screens lean on. */
const KEPT: readonly Line[] = [
  ['P1', '<h1>Plan</h1>'], ['P24', 'Mark done'], ['P29', 'Change the due date'], ['P29', 'Set the due date'], ['P30', 'Block time'], ['P30', 'Block it'],
  ['P31', 'Add a chip'], ['P31', 'e.g. researching'], ['P34', 'What this is, and anything worth remembering about it'], ['P36', 'Add a step'],
  ['P36', 'No steps yet.'], ['P36', 'The next step'], ['P37', 'Take it off'], ['P39', 'Attachments are off.'], ['P40', 'Sign in again to add files.'],
  ['P41', 'Drop files here, or choose them'], ['P42', 'is over 25 MB'], ['P46', 'Nothing from Claude on this card yet.'], ['P47', 'Ask Claude about this card'],
  ['P48', "Claude isn't set up on this server."], ['P49', 'Nothing said about this yet.'], ['P49', 'Leave a note'], ['P52', 'Change the money'],
  ['P53', 'Estimated cost'], ['P53', 'At current funding'], ['P56', 'No one is linked to this card yet.'], ['P56', 'Link someone from Contacts'],
  ['P57', 'Search Contacts by name'], ['P58', 'Sign in again to reach Contacts.'], ['P59', 'Let it go'], ['P60', 'Put it on the calendar'],
  ['P61', "cardSection('History'"], ['P62', 'Remove this plan'], ['P62', 'Why remove it? The log keeps it, and your reason.'],
  ['P64', 'id="loading"'], ['P64', 'id="app-err"'], ['P64', 'Reading the log'], ['S7', 'function askAnswer('], ['S7', 'function askCardNode('],
  ['S7', 'Waiting for you'], ['S9', 'const otherMember'], ['S15', 'async function eventPlans('], ['S18', 'function railChips('], ['S11', 'const clockOf'],
  ['S11', 'const todayKey'], ['S5', 'async function openTodayAt('], ['S2', 'async function reloadView('], ['S6', 'function actionButton('],
  ['shared', 'function icon('], ['shared', 'function lucide('], ['shared', 'function chip('], ['shared', 'function inlineForm('],
  ['card', 'function renderCard('], ['card', 'function checklistSection('], ['card', 'function attachmentsSection('], ['card', 'function claudeSection('],
  ['card', 'function betweenSection('], ['card', 'function moneySection('], ['card', 'function peopleSection('], ['card', 'function whenSection('],
  ['card', 'function factsCard('], ['card', 'async function openCard('],
];
/** What 0.7.0 brings, and what it deletes (the spec's "What is deleted"). Each page task adds its lines before it does the work. */
const ADDED: readonly Line[] = [];
const GONE: readonly Line[] = [];
const GONE_FROM_PLAN_MARKUP: readonly string[] = [];
/** Ids reached for at the top level that a function draws before anything asks for them: each named with who draws it. */
const DRAWN_LATER: readonly string[] = [];

describe('the page ledger: Plan, 0.7.0', () => {
  test('every id the script reaches for at load is in the markup', () => {
    const ids = new Set([...script.matchAll(/^\S.*?\$\('([\w-]+)'\)/gm)].map((m) => m[1]!));
    assert.ok(ids.size >= 10, 'the pattern still finds the top-level lookups');
    assert.deepEqual([...ids].filter((id) => !markup.includes(`id="${id}"`) && !DRAWN_LATER.includes(id)), []);
  });
  for (const [name, list, want] of [['kept', KEPT, true], ['added', ADDED, true], ['gone', GONE, false]] as const) {
    test(`what the ledger marks ${name}`, () => {
      assert.deepEqual(list.filter(([, text]) => page.includes(text) !== want).map(([row, text]) => `${row}: ${text}`), []);
    });
  }
  test("Plan's markup has lost the old board's words", () => {
    assert.deepEqual(GONE_FROM_PLAN_MARKUP.filter((text) => planMarkup.includes(text)), []);
  });
  test('every route the page calls is one the server answers', () => {
    const called = new Set([...script.matchAll(/['"`](\/api\/[a-z0-9_/-]*)/g)].map((m) => m[1]!.replace(/\/$/, '')));
    assert.deepEqual([...called].filter((route) => (route.startsWith('/api/tools/')
      ? !tools.includes(`name: '${route.slice('/api/tools/'.length)}'`) : !server.includes(route))), []);
    const subs = new Set([...script.matchAll(/planPath\([^()]*?, ['`]\/([a-z-]+)/g)].map((m) => m[1]!));
    const answered = (/\((state\|[a-z|-]+)\)/.exec(server)?.[1] ?? '').split('|');
    assert.deepEqual([...subs].filter((sub) => !answered.includes(sub)), []);
  });
});
