import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
/*
 * How an entry matches: every entry names the region of the page it must be found in (default `plan`), and a new
 * entry must match the element itself, a phrase or call only that element has, not a word another screen also uses.
 * KEPT and ADDED are looked for in their region; GONE in its region with comments stripped, so a note about a
 * deleted thing does not fail its deletion but the thing coming back does.
 */
const page = read('../../site/index.html');
const at = page.indexOf('<script type="module">');
const markup = page.slice(0, at);
const script = page.slice(at, page.lastIndexOf('</script>'));
const server = read('../src/server.ts').replaceAll('\\/', '/');
const tools = read('../src/tools.ts');
const between = (text: string, from: string, to: string): string => text.slice(text.indexOf(from), text.indexOf(to));
/** Plan's own markup, the board and the empty card: "Mine" and "Theirs" stay in Today's filters until 0.8.0. */
const planMarkup = markup.slice(markup.indexOf('<div id="plan"'), markup.indexOf('</div>', markup.indexOf('<div id="plan-card"')) + 6);
/** The regions an entry is searched in. `page` is for what truly lives outside Plan's own code and the shared helpers. */
const REGIONS = {
  plan: `${planMarkup}\n${between(script, '// ── plan: the board and the card', '// ── settings')}`,
  shared: between(script, '// ── shared: what every screen calls', '// ── today'),
  css: between(page, '<style', '</style>'),
  page,
} as const;
type Region = keyof typeof REGIONS;
type Line = readonly [row: string, text: string, region?: Region];
const uncommented = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const missing = (list: readonly Line[], want: boolean): string[] => list
  .filter(([, text, region = 'plan']) => (want ? REGIONS[region] : uncommented(REGIONS[region])).includes(text) !== want)
  .map(([row, text, region = 'plan']) => `${row} (${region}): ${text}`);
/** On the page before 0.7.0 and after it: the ledger's Kept rows, and what other screens lean on. */
const KEPT: readonly Line[] = [
  // Region `page`: the page's own loading markup, and helpers that live outside Plan's code and the shared region (Today, the rails, the view loader).
  // Each is a definition or an id, found once, so the whole page cannot satisfy it by accident.
  ['P1', '<h1>Plan</h1>'], ['P24', 'Mark done'], ['P29', 'Change the due date'], ['P29', 'Set the due date'], ['P30', 'Block time'], ['P30', 'Block it'],
  ['P31', 'Add a chip'], ['P31', 'e.g. researching'], ['P34', 'What this is, and anything worth remembering about it'], ['P36', 'Add a step'],
  ['P36', 'No steps yet.'], ['P36', 'The next step'], ['P37', "'Take it off', async"], ['P39', 'Attachments are off.'], ['P40', 'Sign in again to add files.'],
  ['P41', 'Drop files here, or choose them'], ['P42', 'is over 25 MB'], ['P46', 'Nothing from Claude on this card yet.'], ['P47', 'Ask Claude about this card'],
  ['P48', "Claude isn't set up on this server."], ['P49', 'Nothing said about this yet.'], ['P49', "node('button', 'btn', 'Leave a note')"], ['P52', 'Change the money'],
  ['P53', 'Estimated cost'], ['P53', 'At current funding'], ['P56', 'No one is linked to this card yet.'], ['P56', 'Link someone from Contacts'],
  ['P57', 'Search Contacts by name'], ['P58', 'Sign in again to reach Contacts.'], ['P59', 'Let it go'], ['P60', 'Put it on the calendar'],
  ['P61', "cardSection('History'"], ['P62', 'Remove this plan'], ['P62', 'Why remove it? The log keeps it, and your reason.'],
  ['P64', 'id="loading"', 'page'], ['P64', 'id="app-err"', 'page'], ['P64', 'Reading the log', 'page'], ['S7', 'function askAnswer(', 'page'], ['S7', 'function askCardNode(', 'page'],
  ['S7', "node('div', 'waiting', mine ? 'Waiting for you'", 'page'], ['S9', 'const otherMember', 'shared'], ['S15', 'async function eventPlans(', 'page'], ['S18', 'function railChips(', 'page'], ['S11', 'const clockOf', 'shared'],
  ['S11', 'const todayKey', 'shared'], ['S5', 'async function openTodayAt(', 'shared'], ['S2', 'async function reloadView(', 'page'], ['S6', 'function actionButton(', 'page'],
  ['shared', 'function icon(', 'shared'], ['shared', 'function lucide(', 'shared'], ['shared', 'function chip(', 'shared'], ['shared', 'function inlineForm(', 'shared'],
  ['card', 'function renderCard('], ['card', 'function checklistSection('], ['card', 'function attachmentsSection('], ['card', 'function claudeSection('],
  ['card', 'function betweenSection('], ['card', 'function moneySection('], ['card', 'function peopleSection('], ['card', 'function whenSection('],
  ['card', 'function factsCard('], ['card', 'async function openCard('],
];
/** What 0.7.0 brings, and what it deletes (the spec's "What is deleted"). Each page task adds its lines before it does the work. */
const ADDED: readonly Line[] = [
  // A page from another build: the build is the shared region's first line, sent with every request, and linked on the stylesheet.
  ['build', "'x-hp-build': BUILD", 'page'], ['build', "const BUILD = '", 'shared'], ['build', 'href="/tokens.css?v=', 'page'],
  // The four helpers every screen calls, and the person pressed in the people bar, kept for the tab across a reload.
  ['S8', 'function memberDisc(', 'shared'], ['S33', 'function stateGlyph(', 'shared'], ['S33', 'const STATE_WORDS = {', 'shared'],
  ['bar', 'function goalFlag(', 'shared'], ['bar', 'function peopleBar(', 'shared'],
  ['P17', 'function pressPerson(', 'shared'], ['P17', "'hp.person'", 'shared'], ['P17', 'function restorePerson(', 'shared'],
  ['P17', 'restorePerson();', 'page'],
  // Their rules, and the one hit-area helper.
  ['hit', '.hit::after{', 'css'], ['bar', '.seg.people{', 'css'], ['S8', '.who.other', 'css'], ['S8', '.who.sm{', 'css'],
  // The flag is `span.flag`: Today's thread already has a `.line.flag`, which a bare `.flag` rule would reach.
  ['S33', '.st-doing{', 'css'], ['bar', 'span.flag{', 'css'],
];
/** `whoDisc` is searched for on the whole page: Today's rail and the card both called it. */
const GONE: readonly Line[] = [
  ['S8', 'whoDisc(', 'page'],
  // Areas leave Settings: the editor, the counts that gated its Remove, and the read of the whole board that fed them.
  ['S16', '/api/plans?showDone=1', 'page'], ['spec', 'areaCounts', 'page'], ['spec', 'areasItem', 'page'], ['spec', 'areasForm', 'page'],
];
const GONE_FROM_PLAN_MARKUP: readonly string[] = [];
/** Ids reached for at the top level that a function draws before anything asks for them: each named with who draws it. */
const DRAWN_LATER: readonly string[] = [];

describe('the page ledger: Plan, 0.7.0', () => {
  test('every id the script reaches for at load is in the markup', () => {
    const ids = new Set([...script.matchAll(/^\S.*?\$\('([\w-]+)'\)/gm)].map((m) => m[1]!));
    assert.ok(ids.size >= 10, 'the pattern still finds the top-level lookups');
    assert.deepEqual([...ids].filter((id) => !markup.includes(`id="${id}"`) && !DRAWN_LATER.includes(id)), []);
  });
  test('the regions the entries are searched in are found', () => {
    for (const [name, text] of Object.entries(REGIONS)) assert.ok(text.length > 500, `the ${name} region is not empty`);
    assert.ok(planMarkup.includes('id="plan-card"'), "Plan's markup runs through the card's element");
    assert.ok(REGIONS.plan.includes('function renderCard('), "the plan region holds the card's script");
    assert.ok(REGIONS.shared.includes('function icon('), 'the shared region holds the helpers');
  });
  for (const [name, list, want] of [['kept', KEPT, true], ['added', ADDED, true], ['gone', GONE, false]] as const) {
    test(`what the ledger marks ${name}`, () => {
      assert.deepEqual(missing(list, want), []);
    });
  }
  test("Plan's markup has lost the old board's words", () => {
    assert.deepEqual(GONE_FROM_PLAN_MARKUP.filter((text) => uncommented(planMarkup).includes(text)), []);
  });
  test('the page, its stylesheet and the package are one build', () => {
    const version = (JSON.parse(read('../package.json')) as { version: string }).version;
    assert.equal(/^const BUILD = '([^']+)';$/m.exec(script)?.[1], version);
    assert.equal(/href="\/tokens\.css\?v=([^"]+)"/.exec(markup)?.[1], version);
  });
  test('every route the page calls is one the server answers', () => {
    const called = new Set([...script.matchAll(/['"`](\/api\/[a-z0-9_/-]*)/g)].map((m) => m[1]!.replace(/\/$/, '')));
    assert.deepEqual([...called].filter((route) => (route.startsWith('/api/tools/')
      ? !tools.includes(`name: '${route.slice('/api/tools/'.length)}'`) : !server.includes(route))), []);
    assert.ok(called.size >= 10, 'the pattern still finds the routes the page calls');
    const subs = new Set([...script.matchAll(/planPath\([^()]*?, ['`]\/([a-z-]+)/g)].map((m) => m[1]!));
    assert.ok(subs.size >= 10, 'the pattern still finds the plan sub-routes');
    const answered = (/\((state\|[a-z|-]+)\)/.exec(server)?.[1] ?? '').split('|');
    assert.deepEqual([...subs].filter((sub) => !answered.includes(sub)), []);
  });
});
