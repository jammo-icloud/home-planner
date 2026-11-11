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
/** Plan's own markup, the board and the empty card. */
const planMarkup = markup.slice(markup.indexOf('<div id="plan"'), markup.indexOf('</div>', markup.indexOf('<div id="plan-card"')) + 6);
/** The regions an entry is searched in. `page` is for what truly lives outside Plan's own code and the shared helpers. */
const REGIONS = {
  plan: `${planMarkup}\n${between(script, '// ── plan: the board and the card', '// ── settings')}`,
  today: between(script, '// ── today', '// ── budget'),
  todayMarkup: markup.slice(markup.indexOf('<div id="briefing"'), markup.indexOf('<div class="page-head budget-head"')),
  threadSrc: read('../src/thread.ts'),
  shared: between(script, '// ── shared: what every screen calls', '// ── today'),
  calendar: between(script, '// ── the calendar', '// ── views'),
  calendarMarkup: markup.slice(markup.indexOf('<div id="calendar"'), markup.indexOf('<div id="settings"')),
  calendarView: read('../src/calendar-view.ts'),
  css: between(page, '<style', '</style>'),
  budget: between(script, '// ── budget', '// ── plan: the board and the card'),
  budgetMarkup: markup.slice(markup.indexOf('<div class="page-head budget-head"'), markup.indexOf('<!-- Plan: the board')),
  matchSrc: read('../src/match.ts'),
  page,
} as const;
type Region = keyof typeof REGIONS;
type Line = readonly [row: string, text: string, region?: Region];
const uncommented = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const missing = (list: readonly Line[], want: boolean): string[] => list
  .filter(([, text, region = 'plan']) => (want ? REGIONS[region] : uncommented(REGIONS[region])).includes(text) !== want)
  .map(([row, text, region = 'plan']) => `${row} (${region}): ${text}`);
// ── Bills on the envelope's page (0.9.0, Part 1): its own block, so a branch working elsewhere in this file merges beside it. ──
const billsPage = between(script, "// ── an envelope's page", '// ── the unsorted queue');
const billsCode = between(script, "// ── an envelope's bills", '// ── the unsorted queue');
const BILLS_KEPT: readonly (readonly [row: string, text: string])[] = [
  ['E1', "back: 'Budget', onBack: () => closeEnvelopePage()"], ['E2', 'function envCard('], ['E2', 'coverBlock(e)'],
  ['E3', 'How much each month?'], ['E3', 'From this month on'], ['E4', "envSection('Each month')"], ['E4', "textBtn('Change', 'btn bare', 'change'"],
  ['E5', 'goalForm(each.slot, e,'], ['E6', "envSection('This month')"], ['E6', "'adjust', () => openFundingPage()"],
  ['E6', 'Nothing funded yet. Give it a figure first.'], ['E7', "envSection('Receipts')"], ['E7', 'void showReceipts(rcpts, e)'],
  ['E8', 'Make this a savings goal'], ['E8', 'Change its goal'], ['E8', 'Remove this envelope'],
  ['E9', "host.querySelector('.ep-slot [data-cancel]')"], ['E9', "document.addEventListener('keydown', envPageEscape)"],
  ['E10', 'const open = !month.closed'], ['S19', 'async function openBudgetAt('],
];
const BILLS_ADDED: readonly (readonly [row: string, text: string])[] = [
  ['B1', "envSection('Bills', 'bills')"], ['B2', 'if (!e.sinking) body.appendChild(billsSection(e, open))'],
  ['B3', "No bills in this envelope's receipts yet."], ['B4', 'envLine(b.name, b.line'], ['B5', "'Set a date'"], ['B5', "'Change'"],
  ['B6', "'Add a bill'"], ['B7', "'Example Water'"], ['B7', 'maxLength = 60'], ['B8', "'Auto Pay'"], ['B8', "'Pay by'"], ['B8', "['due', 'Due']"],
  ['B9', "'every month'"], ['B9', "'every quarter'"], ['B9', "'every six months'"], ['B9', "'every year'"],
  ['B10', "'Day of the month'"], ['B10', 'In a shorter month it falls on the last day.'], ['B10', 'A day from 1 to 31.'],
  ['B11', "'Next date'"], ['B12', "'Clear the date'"], ['B12', "dataset.cancel = ''"], ['B13', "'Remove this bill'"],
  ['form', "approveNow('set_bill'"], ['form', 'function closeEpForm('], ['form', 'function closeBillForm('], ['form', "'Give it a name'"], ['form', 'Choose the next date.'],
];
/** Words this part may never say, and shared rows it may not disturb: S22 one error box, S3 nothing bound at load, the household's clock. */
const BILLS_NEVER: readonly string[] = ['showProblem(', 'new Date(', 'overdue', 'Overdue', 'missed', ' late'];
describe("the page ledger: Bills on the envelope's page, 0.9.0 Part 1", () => {
  test('the section is inside the envelope page, and the markers are found', () => {
    assert.ok(billsPage.length > 500 && billsCode.length > 500);
    const hook = billsPage.indexOf('billsSection(e, open)');
    assert.ok(billsPage.indexOf("envSection('This month')") < hook && hook < billsPage.indexOf("envSection('Receipts')"));
  });
  test('what the envelope page keeps', () => {
    assert.deepEqual(BILLS_KEPT.filter(([, t]) => !billsPage.includes(t)).map(([r, t]) => `${r}: ${t}`), []);
    assert.equal(page.includes('chosenBudget'), false, 'S21: one budget, none chosen');
    assert.ok(page.includes('id="unsorted-q"'), 'S20');
  });
  test('a saved bill reads the budget again even when the page changed meanwhile', async () => {
    const start = billsCode.indexOf('const send = async (args, focus) => {');
    const end = billsCode.indexOf('\n  };', start);
    assert.ok(start > 0 && end > start, 'the send door is found');
    const body = billsCode.slice(start, end + 5).replace('const send =', 'return');
    const run = async (changePage: boolean) => {
      const calls: string[] = [];
      const page: { focusNext?: unknown } = {};
      const state = { envelopePage: page as unknown };
      const fn = new Function('approveNow', 'loadBudget', 'buttons', 'say', 'err', 'b', 'getEnvelopePage', 'page',
        `let envelopePage; Object.defineProperty(globalThis, '__x', { configurable: true, get: () => 0 });
         const get = getEnvelopePage; ${body.replace(/envelopePage/g, 'get()')}`);
      const send = fn(async () => { if (changePage) state.envelopePage = {}; calls.push('set_bill'); return { proposal: { events: [{ bill: 'k' }] } }; },
        async () => { calls.push('loadBudget'); }, () => [], () => {}, { focus() {} }, { key: 'k' }, () => state.envelopePage, page);
      await send({}, null);
      return calls;
    };
    assert.deepEqual(await run(false), ['set_bill', 'loadBudget']);
    assert.deepEqual(await run(true), ['set_bill', 'loadBudget']);
  });
  test('what Bills adds', () => {
    // B2 is the hook in renderEnvelopePage. Every other row is the new block's own: 'Change' alone is on the page already.
    assert.deepEqual(BILLS_ADDED.filter(([r, t]) => !(r === 'B2' ? billsPage : billsCode).includes(t)).map(([r, t]) => `${r}: ${t}`), []);
    assert.ok(between(billsPage, 'const openGoal =', 'const drawEach =').includes('closeBillForm()'), 'E5');
    assert.ok(between(billsPage, 'const drawEach =', "const now = envSection('This month')").includes('closeBillForm()'), 'E4');
  });
  test('what Bills never does', () => {
    const code = uncommented(billsCode);
    assert.deepEqual(BILLS_NEVER.filter((t) => code.includes(t)), []);
    assert.equal(/^(?!(?:async )?function )\S.*\$\('/m.test(code), false, 'S3: nothing is bound at load');
  });
});

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
  ['S15', 'async function eventPlans(', 'page'], ['S15', "(await api('/api/plans')).rows.flatMap((r) => r.plans)", 'page'], ['S18', 'function railChips(', 'page'], ['S11', 'const clockOf', 'shared'],
  ['S11', 'const todayKey', 'shared'], ['S5', 'async function openTodayAt(', 'shared'], ['S2', 'async function reloadView(', 'page'], ['S6', 'function actionButton(', 'page'],
  ['shared', 'function icon(', 'shared'], ['shared', 'function lucide(', 'shared'], ['shared', 'function chip(', 'shared'], ['shared', 'function inlineForm(', 'shared'],
  ['card', 'function renderCard('], ['card', 'function checklistSection('], ['card', 'function attachmentsSection('], ['card', 'function claudeSection('],
  ['card', 'function betweenSection('], ['card', 'function moneySection('], ['card', 'function peopleSection('], ['card', 'function whenSection('],
  ['card', 'function factsCard('], ['card', 'async function openCard('],
// Today (0.8.0): what stands before the rebuild and after it.
['T1', 'Put Home Planner on your Home Screen', 'todayMarkup'], ['T1', 'function homeBanner(', 'page'], ['T2', 'openSettings(a.group, a.row)', 'today'],
['T19', 'Sign in again to read the whole ${what}.', 'today'], ['T19', 'The full text is on the old NAS.', 'today'], ['T19', 'The whole ${what} could not be read just now.', 'today'],
['T24', 'Claude answered · ', 'today'], ['T25', 'Read the whole answer', 'today'], ['T26', 'Looked at ${looked.join(', 'today'], ['T27', "Claude didn't answer this one.", 'today'], ['T27', "'Ask again'", 'today'],
['T30', 'not in the ledger', 'page'], ['T30', 'function removedBlock(', 'page'], ['T31', 'Why it belongs after all', 'page'], ['T31', "'Leave it'", 'page'], ['T32', "'/api/thread/seen'", 'today'],
['T36', "o.tool === 'move_money' || o.tool === 'set_assignment'", 'today'], ['T37', 'The numbers have moved since this was suggested.', 'today'], ['T37', "'Work it out again'", 'today'],
['T38', 'Reason, as it will read in the record', 'today'], ['T38', 'Approving needs a reason, the same as moving money', 'today'], ['T39', 'function adjustForm(', 'today'], ['T39', 'Amount to move', 'today'], ['T39', 'Fund it at', 'today'], ['T39', "'Suggest this instead'", 'today'], ['T39', 'Enter an amount in dollars', 'today'], ['T39', 'It needs a reason', 'today'],
['T42', 'Replaced by a newer suggestion for the same envelopes.', 'today'], ['T43', '. It comes back if its numbers change.', 'today'], ['T45', 'ctx.pending.has(o.id)', 'today'],
['T48', "actionButton('Take it'", 'today'], ['T48', ' reads this`', 'today'], ['T48', 'Declining needs a reason', 'today'], ['T51', 'Taken by ', 'today'], ['T51', 'The ask to ', 'today'],
['T52', "plan: 'Move the plan too'", 'today'], ['T52', "plan: 'Take the change'", 'today'], ['T52', "calendar: 'Put the page back'", 'today'], ['T52', "leave: 'Leave both'", 'today'], ['T54', 'if (!d.deleted)', 'today'], ['T55', 'd.unreadable === true', 'today'],
['T57', "plan: 'Moved the plan too'", 'today'], ['T57', "leave: 'Left both'", 'today'], ['T57', "plan: 'Took the change made in Drive'", 'today'], ['T57', "leave: 'Left the page as edited'", 'today'], ['T57', '; it changed again since, and the newer card asks about it', 'today'], ['T57', '; let go when the plan was removed', 'today'],
['T59', 'Seen by ', 'today'], ['T59', 'A newer balance came in since', 'today'], ['T59', 'Put away by ', 'today'], ['T60', "'Suggest other dates'", 'today'], ['T62', 'Declining needs a reason: they will read it', 'today'],
['T63', "'Suggest these dates'", 'today'], ['T63', 'Choose the day they would arrive and the day they would leave', 'today'], ['T63', 'They leave after they arrive', 'today'], ['T63', 'Suggesting other dates needs a reason: they will read it', 'today'],
['T66', 'Replaced by a newer request', 'today'], ['T66', 'Withdrawn by them', 'today'], ['T67', "'Take it off the calendar'", 'today'], ['T68', 'Taken off the calendar by ', 'today'], ['T68', 'Left on the calendar by ', 'today'], ['T69', 'dataset.offer', 'today'], ['T69', 'dataset.drift', 'today'],
['T74', 'id="leave-note"', 'todayMarkup'], ['T75', 'id="ask-claude"', 'todayMarkup'], ['T76', "Claude isn't set up on this server. Notes still work.", 'today'], ['T77', 'Asking Claude…', 'today'], ['T78', "Claude couldn't answer: ${r.error}", 'today'],
['T81', 'Yours · what the briefing was written from', 'todayMarkup'], ['T83', '.today > .yours{', 'css'], ['T84', 'function calendarRail(', 'today'], ['T84', 'function eventWhen(', 'today'], ['T88', 'could not be read just now.`', 'today'], ['T89', 'cal.unavailable', 'today'], ['T90', 'Nothing on your calendars today or tomorrow.', 'today'],
['T91', 'Plans that need you', 'todayMarkup'], ['T91', 'function plansRail(', 'today'], ['T93', 'Nothing of yours is due this week, or in Doing.', 'today'], ['T94', 'Money this month', 'todayMarkup'], ['T94', 'function moneyRail(', 'today'],
['T103', 'Nothing in the household matches that.', 'page'], ['T104', 'The search could not be done just now.', 'page'], ['T105', 'Sign in again to search briefings, answers and files too.', 'page'], ['T112', 'function showProblem(', 'page'], ['T114', 'Open it from the template', 'page'],
['T118', "ev.key === 'Enter' && !ev.shiftKey", 'today'], ['T119', '!ev.isComposing', 'today'],
['S12', 'const dayKey', 'today'], ['S12', 'const timeOf', 'today'], ['S12', 'const fmtDate', 'today'], ['S12', 'const asOf', 'today'], ['S13', 'const docTexts', 'today'], ['S13', 'function readDocText(', 'today'], ['S13', 'const docRead', 'today'], ['S13', 'let docHousehold', 'today'],
['S14', 'claudeOn = who.claude === true', 'page'], ['S20', 'id="unsorted-q"', 'page'], ['S24', 'let calWeek', 'page'], ['S27', 'const bookingHere', 'page'], ['S27', 'const dsmCalendarUrl', 'page'],
// The Calendar (0.9.0): what stands before the rebuild and after it.
['C2', 'aria-label="Previous week"', 'calendarMarkup'], ['C2', 'aria-label="Next week"', 'calendarMarkup'], ['C3', 'This week', 'calendarMarkup'], ['C4', '.formatRange(keyDate(calWeek), keyDate(days[6]))', 'calendar'],
['C13', "node('div', 'adlab', 'all day')", 'calendar'], ['C14', "hourLabels('hours')", 'calendar'], ['C14', '.week .col.is-today{', 'css'], ['C15', 'function timedBoxes(', 'calendar'], ['C15', "'↑ '", 'calendar'], ['C15', "' ↓'", 'calendar'],
['C16', 'function nowLine(', 'calendar'], ['C16', 'Now, ${clockOf(Date.now() / 1000)}', 'calendar'], ['C17', 'function evClasses(', 'calendar'], ['C17', '.ev.proposed{', 'css'], ['C17', '.ev.drift{', 'css'], ['C17', '.ev.off{', 'css'], ['C17', '.ev.held{', 'css'], ['C20', "|| 'Busy'", 'calendar'],
['C28', 'days.includes(today) ? today : days[0]', 'calendar'], ['C29', 'await loadCalendar(calWeek ?? todayKey())', 'page'], ['C30', 'function evOpen(', 'calendar'], ['C30', 'openCard(e.plan.id)', 'calendar'], ['S5', 'openTodayAt({ drift: e.drift })', 'calendar'], ['S5', 'openTodayAt({ offer: e.proposed })', 'calendar'],
['C32', "placeholder: 'Dentist'", 'calendar'], ['C32', "'All day'", 'calendar'], ['C32', "'From'", 'calendar'], ['C32', "'To'", 'calendar'], ['C37', 'Nothing else at that time on ${listOf(out.checked)}.', 'calendar'], ['C37', 'There is no calendar to check it against yet.', 'calendar'], ['C42', "'Save'", 'calendar'],
['C45', "'Change this event'", 'calendar'], ['C45', "'Ends on'", 'calendar'], ['C45', "node('span', 'quiet', 'For ')", 'calendar'], ['C47', 'Take it off the calendar for good?', 'calendar'], ['C47', "'Delete it'", 'calendar'], ['C47', "'Keep it'", 'calendar'], ['C48', 'so only its owner changes it.', 'calendar'], ['C48', 'so it is changed where it was made.', 'calendar'], ['C48', ', shared with you', 'calendar'],
['C49', 'Kept for the household: ${heldNights(first, last)}', 'calendar'], ['C49', "'Why open them again'", 'calendar'], ['C49', 'Friends see these nights as taken.', 'calendar'], ['C51', "'Keep nights for the household'", 'calendar'], ['C51', "'First night'", 'calendar'], ['C51', "'Last night'", 'calendar'], ['C51', "placeholder: 'Family is here'", 'calendar'],
['C58', 'marked.push(', 'calendarView'], ['C59', 'offCalendar: true', 'calendarView'], ['C60', "o.tool !== 'propose_event'", 'calendarView'], ['C61', 'driftOf(e.evt_id)', 'calendarView'], ['C62', 'export function markClashes(', 'calendarView'], ['C63', 'stayEvents', 'calendarView'], ['S28', 'by: b.by', 'calendarView'],
['C64', 'if (mine === calFetch) showProblem(ex)', 'calendar'], ['C64', "$('loading').hidden = false", 'calendar'], ['C65', 'if (mine !== calFetch) return;', 'calendar'], ['C66', 'const bookingHere', 'calendar'], ['C67', 'const dsmCalendarUrl', 'calendar'],
['S11', 'const keyAt', 'shared'], ['S11', 'const mondayOf', 'shared'], ['S14', 'myName = who.who', 'page'],
];
/** What 0.7.0 brings, and what it deletes (the spec's "What is deleted"). Each page task adds its lines before it does the work. */
const ADDED: readonly Line[] = [
  ['T70', 'function renderWaiting(', 'today'], ['T70', 'In no envelope yet', 'today'], ['S20', "$('unsorted-q').scrollIntoView({ block: 'start' })", 'today'], ['T72', 'Waiting on you · ', 'today'], ['T72', '`Show all ${', 'today'], ['wait', 'suggested it · ', 'today'], ['wait', ' asked you · ', 'today'], ['wait', ' removed it · ', 'today'], ['wait', ' · the numbers have moved', 'today'], ['wait', '#t-waiting', 'css'],
  // A page from another build: the build is the shared region's first line, sent with every request, and linked on the stylesheet.
  ['build', "'x-hp-build': BUILD", 'page'], ['build', "const BUILD = '", 'shared'], ['build', 'href="/tokens.css?v=', 'page'],
  // The four helpers every screen calls, and the person pressed in the people bar, kept for the tab across a reload.
  ['S8', 'function memberDisc(', 'shared'], ['S33', 'function stateGlyph(', 'shared'], ['S33', 'const STATE_WORDS = {', 'shared'],
  ['bar', 'function goalFlag(', 'shared'], ['bar', 'function peopleBar(', 'shared'], ['bar', "'person:everyone'", 'shared'],
  ['P17', 'function pressPerson(', 'shared'], ['P17', "'hp.person'", 'shared'], ['P17', 'function restorePerson(', 'shared'],
  ['P17', 'restorePerson();', 'page'],
  // Their rules, and the one hit-area helper.
  ['hit', '.hit::after{', 'css'], ['bar', '.seg.people{', 'css'], ['S8', '.who.other', 'css'], ['S8', '.who.sm{', 'css'],
  // The flag is `span.flag`: Today's thread already has a `.line.flag`, which a bare `.flag` rule would reach.
  ['S33', '.st-doing{', 'css'], ['bar', 'span.flag{', 'css'],
  // The board (Task 11): its markup, the head, the people bar, the rows, the add row in every area and "A new area" last.
  ['markup', '<div id="plan-board">'], ['markup', 'id="plan-count"'], ['markup', 'id="plan-people"'], ['markup', 'id="plan-goals"'],
  ['markup', 'id="plan-areas"'], ['markup', 'id="plan-quiet"'], ['markup', 'id="plan-foot"'], ['markup', '<section id="area-page" hidden>'],
  ['board', 'function renderPlan('], ['P2', "label: 'Whose plans'"], ['P11', 'function planRow('], ['P12', 'function planMeta('],
  ['P13', "'pm pm-env neg'"], ['P9', "'No plans'"], ['P3', "'erow fold hit'"],
  ['P7', 'Nothing is planned yet. Anything the household means to do goes here.'],
  ['P4', '`A new plan in ${area}'], ['P5', "label: 'The new plan'"], ['P5', "'e.g. Fix the fence gate'"], ['P5', "say('Give it a name')"],
  ['board', "'A new area'"], ['board', "label: 'The new area'"], ['board', "'e.g. Garden'"],
  ['board', 'It joins the board at the bottom. Rename it, move it or remove it from its own page.'], ['board', "'/api/settings/areas/add'"],
  ['board', '#plan-areas{', 'css'], ['board', '.erow.plan{', 'css'], ['board', '.erow.fold{', 'css'], ['board', '.erow.add{', 'css'],
  ['S33', 'STATE_WORDS[s]'],
  // The Area page (Task 12): opened from an area's heading or its done row, renamed, moved and removed from its foot.
  // One Escape cancels an open form before it goes Back, through the shared mark every form on Plan carries.
  ['area', 'async function openArea('], ['area', 'function closeArea('], ['area', 'function areaEscape('], ['area', 'function clearAreaPage('],
  ['area', 'function cancelOpen(', 'shared'], ['area', 'function cancelMark(', 'shared'],
  ['area', "'Rename this area'"], ['area', "'Move up'"], ['area', "'Move down'"], ['area', "'Remove this area'"],
  ['area', "'Its plans go with it.'"], ['area', "'Rename it'"], ['area', "'A household keeps at least one area.'"],
  ['area', "'Nothing is in it, so removing it loses nothing.'"], ['area', 'An area is removed once it holds nothing.'],
  ['area', "'Nothing planned yet'"], ['area', 'on the board'], ['area', "'/api/settings/areas/rename'"],
  ['area', "'/api/settings/areas/move'"], ['area', "'/api/settings/areas/remove'"], ['area', "id: 'area-page-h'"],
  ['P3', "focus: 'done'"], ['P3', "'Done', 'done'"], ['P3', 'pm-done'],
  // Goals on the board (Task 13): the goal row, what a pressed goal changes, and the foot that renames or removes it.
  ['goals', "'All goals'"], ['goals', 'function pressGoal('], ['goals', 'function goalFoot('], ['goals', "'Toward '"], ['goals', "'toward '"], ['goals', ' toward it'],
  ['goals', 'toward this goal'], ['goals', "'Rename this goal'"], ['goals', "'Remove this goal'"], ['goals', 'Both act on all '], ['goals', 'Both act on the 1 plan that carries it${g.done ? \', which is done\''], ['goals', 'off 1 plan${g.done ? \', which is done\''], ['goals', 'holds 1 plan${all.done ? \', which is done\'', 'page'],
  ['goals', 'The new name goes on all '], ['goals', 'Rename it on '], ['goals', "'Leave the plans as they are'"],
  ['goals', 'The goal ends here: it leaves the filter row. Putting the same words on a plan later starts it again.'],
  ['goals', "'Remove the goal'"], ['goals', '/api/goals/rename'], ['goals', '/api/goals/remove'],
  ['goals', '#plan-goals button', 'css'],
  // The card (Task 14): where it was opened from and the way back, one Escape that closes a form before it goes Back,
  // and the head's keeps (the title, the chips row, a finished plan's "Done", Due date and Block time).
  ['card', 'function cardEscape('], ['card', 'async function closeCard('], ['card', 'let cardFrom'], ['P51', "note: 'Also in Today'"], ['P50', 'Leave a note about this'],
  ['P21', "title.setAttribute('aria-label', `${v.title}, rename`)"], ['P25', "chip('', 'Done', 'check')"], ['P33', 'staleChip(v.daysInState)'],
  ['P31', 'Take off ${t}`'], ['P68', 'cancelMark(input, close)'], ['P68', 'cancelMark(row, close)'], ['P68', 'cancelMark(cancel, close)', 'shared'], ['P68', 'cancelMark(cancelSearch, closeSearch)'], ['P68', 'cancelMark(cancelMoney, closeMoney)'], ['P68', 'cancelMark(f, closeApprove)', 'page'], ['P68', 'function offerButtons(', 'page'], ['P68', 'cancelMark(amountField, closeAdjust)', 'page'], ['P50', 'keepTextOnEscape(q)'], ['P50', 'keepTextOnEscape(t)'], ['P23', "stateGlyph(s, { small: true })"],
  // The card's Owner and Goal (Task 15): who owns it and since when, handed on or taken at once with a word, and the one goal.
  ['P27', 'function ownerSection('], ['P27', 'Who owns it?'], ['P27', 'Why them, or what to know first'], ['P27', 'Hand it to '], ['P27', ' can hand it back.'],
  ['P27', 'It becomes yours at once and shows in Today.'], ['P27', 'A word about why (optional)'], ['P27', '; nothing moves.'], ['P27', ' has it.'],
  ['P27', 'It is yours.'], ['P27', 'It is answered on Today; handing it to anyone settles it.'], ['P27', "'/hand'"],
  ['P27', 'cancelMark(cancelOwner, closeOwner)'], ['P27', 'function radioList('], ['P27', 'input[type=radio]:checked', 'css'],
  ['goal', 'function goalSection('], ['goal', 'Set a goal'], ['goal', 'this plan stands on its own'], ['goal', 'the only plan toward it'],
  ['goal', 'What is it toward?'], ['goal', 'A new goal…'], ['goal', 'e.g. New roof'],
  ['goal', 'A goal begins when a plan carries it. This plan will be its first.'], ['goal', 'ends here: no other plan carries it.'],
  ['goal', 'is already a goal; this plan joins it.'], ['goal', "'/goal'"], ['goal', 'cancelMark(cancelGoal, closeGoal)'],
  // Leaving a household (a switch, the picker, sign-out) goes through onlyToday, which empties every screen first and
  // moves the turn on, so no read still out from the household left can draw into the next one.
  ['switch', 'function onlyToday() {\n  forgetHousehold();', 'page'], ['switch', 'function forgetHousehold() {\n  householdTurn++;', 'page'],
  ['switch', 'let householdTurn = 0;', 'shared'],
  // Every card is its own entry (Task 4): the briefing that settles a replaced one, what an approval applied, and a guest's name.
  ['S25', 'settle(', 'threadSrc'], ['S26', 'appliedBy', 'threadSrc'], ['S29', 'guestEmail(', 'threadSrc'],
  // Today as day cards (Task 7): the frame, the day cards, and getting to a row.
  ['T7', 'function dayCard(', 'today'], ['T7', "'Today'", 'today'], ['T7', 'aria-expanded', 'today'], ['T7', 'function dayName(', 'shared'], ['T7', 'function monthName(', 'shared'], ['T7', 'function clockAt(', 'shared'],
  ['T8', 'New since you last looked', 'today'], ['S1', "api('/api/briefing/read', { upTo: threadData.last })", 'today'], ['S1', 'function watchLastRow(', 'today'], ['T9', "todayKind === 'all'", 'today'], ['T7', 'for (const day of daysOpen) if (!dayRows.has(day) && held.has(day))', 'today'],
  ['T11', "if (view === 'today') { window.scrollTo({ top: 0 }); await loadThread(); }", 'page'], ['T12', 'if (rowFormOpen()) return;', 'today'], ['S5', 'openTodayAt({ drift: e.drift })', 'page'], ['S5', 'openTodayAt({ offer: e.proposed })', 'page'], ['T109', "block: 'center'", 'shared'],
  ['T111', "$('loading').hidden = false", 'today'], ['T114', "new Error('no open month')", 'today'], ['T115', 'Nothing yet today. Ask Claude something, or leave a note.', 'today'], ['T117', 'if (turn !== loadTurn || household !== householdTurn) return;', 'today'],
  ['S2', 'else await loadThread();', 'today'], ['S3', "$('days').addEventListener('focusin'", 'today'], ['S31', "$('days').addEventListener('focusout'", 'today'],
  ['frame', '<h1>Today</h1>', 'todayMarkup'], ['frame', 'id="today-day"', 'todayMarkup'], ['frame', 'id="t-kinds"', 'todayMarkup'], ['frame', 'id="t-people"', 'todayMarkup'], ['frame', 'id="t-waiting"', 'todayMarkup'], ['frame', 'id="day-today"', 'todayMarkup'], ['frame', 'id="earlier-days"', 'todayMarkup'], ['frame', '.day-open{', 'css'], ['frame', '.day-body', 'css'],
  // A row is lane, who, what and when (Task 8).
  ['T21', 'function entShell(', 'today'], ['T21', 'left a note', 'today'], ['T21', 'asked Claude', 'today'], ['T22', 'planCrumb(e.plan)', 'today'], ['T23', "e.kind === 'ask' && e.plan", 'today'], ['T29', "node('span', 'ent-why'", 'today'], ['T31', 'refused.textContent = ex.message', 'page'], ['T33', 'No reason was given for this.', 'today'],
  ['S11', 'clockOf(', 'shared'], ['S29', 'name ?? nameOf(who)', 'today'],
  ['hand', ' handed ', 'today'], ['hand', ' took ', 'today'], ['cal', ' added ', 'today'], ['cal', 'the Household calendar', 'today'], ['cal', 'their own calendar', 'today'], ['cal', 'your own calendar', 'today'], ['cal', ' renamed ', 'today'], ['late', 'Suggested on ', 'today'], ['open', "'Open the plan'", 'today'], ['open', "'Open the envelope'", 'today'], ['open', "'Open the day'", 'today'],
  ['lane', 'function laneIcon(', 'shared'], ['lane', "'message-square':", 'shared'], ['lane', 'function claudeDisc(', 'shared'], ['lane', '.who.claude', 'css'], ['ent', '.ent{', 'css'], ['ent', 'cursor:pointer;text-decoration:underline', 'css'],
  // A waiting card is a dashed block in its own row (Task 9).
  ['T20', "From the day's briefing", 'today'], ['T28', 'From your question at ', 'today'], ['T46', 'In place of an earlier suggestion', 'today'], ['T46', ' suggested', 'today'], ['T47', "label = 'Waiting'", 'today'], ['T34', 'function waitingBlock(', 'today'], ['T35', "'Not now'", 'today'], ['T34', '.block-err', 'css'], ['T40', 'function blockSlot(', 'today'], ['T40', 'function actionButton(label, cls, act, slot = null)', 'today'], ['T41', 'function decidedLine(', 'today'], ['T44', "o.status === 'snoozed'", 'today'],
  ['T49', 'asked you to take', 'today'], ['T50', 'mine ? \'Waiting for you\' : `Waiting on ${ask.to}`', 'today'], ['T53', 'DRIFT_LABELS[on].chip', 'today'], ['T56', 'planCrumb(e.plan)', 'today'], ['T58', "actionButton('Seen it'", 'today'], ['T61', 'clash: e.blocked', 'today'], ['T62', 'Reason (they will read it)', 'today'], ['T63', 'Why these instead (they will read it)', 'today'], ['T64', 'function bookingSend(', 'today'], ['T65', '/^approved\\b/.test(ex.message)', 'today'],
  ['T120', 'why.focus()', 'today'], ['T120', 'arrive.focus()', 'today'], ['T121', 'b.disabled = true', 'today'], ['S6', '.is-decided', 'css'], ['S7', 'function askAnswer(', 'today'], ['S22', 'showProblem(ex)', 'today'], ['esc', 'function todayEscape(', 'today'], ['esc', 'cancelMark(row, closeDecline)', 'today'], ['esc', 'cancelMark(row, closeBooking)', 'today'],
  // The briefing opens its day (Task 10).
  // Yours is a strip on a phone and a column on the desk (Task 11).
  ['T82', 'function yoursStrip(', 'today'], ['T85', ' more`', 'today'], ['T81', "'Yours'", 'today'], ['T87', 'function householdDisc(', 'shared'], ['T87', 'e.owner', 'today'], ['T96', 'yoursRails', 'today'], ['S10', 'householdDisc(e.label)', 'today'], ['S32', 'yoursStrip()', 'today'], ['strip', '.yours-strip', 'css'],
  ['T14', "Claude · the day's briefing", 'today'], ['T14', '.day .claude', 'css'], ['T15', 'Briefing · written without Claude', 'today'], ['T16', "'headline'", 'today'], ['T17', 'Read the whole briefing', 'today'], ['T18', 'Reading the briefing…', 'today'],
  // Kinds, people, empty days and the earlier months (Task 12).
  ['T4', 'const KINDS = ', 'today'], ['T4', "['all', 'All']", 'today'], ['T4', "['notes', 'Notes']", 'today'], ['T4', 'function pressKind(', 'today'], ['T4', "label: 'Whose'", 'today'], ['T4', "plural: 'entries'", 'today'], ['T4', '.filters.kinds', 'css'], ['T6', '`Show ${', 'today'], ['T6', 'function showMonth(', 'today'], ['sort', 'function flipSort(', 'today'], ['sort', "'Newest first'", 'today'], ['sort', "'Oldest first'", 'today'], ['sort', "'arrow-up-down':", 'shared'], ['empty', 'function emptyLine(', 'today'], ['empty', 'Nothing under ${', 'today'], ['left', 'and are left out.', 'today'], ['left', 'and is left out.', 'today'], ['bar', 'plural', 'shared'],
  ['T97', 'id="t-search-q"', 'todayMarkup'], ['T97', 'id="t-search-btn"', 'todayMarkup'], ['T97', 'Search the household', 'todayMarkup'], ['T98', 'setTimeout(() => { void askRecord(words); }, 250)', 'today'], ['T98', 'if (asked !== recordAsked) return;', 'today'], ['T99', 'in the record for', 'today'], ['T99', 'Claude answered: ', 'today'], ['T99', 'function markWords(', 'today'], ['T101', 'if (leaveSearch()) ev.preventDefault();', 'today'], ['T101', 'else if (leaveSearch()) ev.preventDefault();', 'today'], ['T101', "!$('briefing').classList.contains('searching-record') && cancelOpen($('days'))", 'today'], ['T102', "'Show in its day'", 'today'], ['T102', "'_blank', 'noopener'", 'today'], ['T107', 'function todaySearchReset(', 'today'], ['S23', 'todaySearchReset();', 'page'], ['S3', "$('t-search-q').addEventListener", 'today'],
  // The composer (Task 15).
  ['T73', 'Ask Claude, or leave a note for the others', 'todayMarkup'], ['T79', 'id="say-note" aria-live="polite"', 'todayMarkup'], ['T79', 'Goes into today', 'today'], ['T80', 'function afterSend(', 'today'], ['T80', 'Left in today. It shows under Everyone.', 'today'], ['T80', 'row.style.scrollMarginBottom = (bar', 'today'], ['T71', '.composer.resting', 'css'], ['T71', "$('composer').classList.add('resting')", 'today'], ['T119', "if (!text) { $('say').focus(); return; }", 'today'], ['T74', "$('leave-note').disabled = true", 'today'], ['T75', "$('ask-claude').disabled = !claudeOn", 'today'],
  ['srch', 'Elsewhere · ', 'today'], ['srch', 'A plan · ', 'today'], ['srch', 'A file on ', 'today'], ['srch', 'Searched every day since the record began.', 'today'], ['srch', 'Showing the newest 100. Add a word to narrow it.', 'today'], ['srch', 'function searchActive(', 'today'], ['srch', '  search: \'<path', 'shared'], ['srch', '  x: \'<path', 'shared'], ['mark', '--mark-fill', 'css'],
  // What a day shows, in one block (Calendar Task 5).
  ['block', '// ── the calendar: what a day shows ──', 'calendar'], ['C21', 'function dayMarks(', 'calendar'], ['C22', 'function marksWords(', 'calendar'], ['C20', "e.summary || 'Busy'", 'calendar'],
  // The head, the calendars bar, the overlays and the strip of marks (Calendar Task 6).
  ['C1', 'class="cal-month on-phone hit" id="cal-month"', 'calendarMarkup'], ['C5', 'id="cal-keep"', 'calendarMarkup'], ['C6', 'id="cal-dsm"', 'calendarMarkup'], ['C7', 'id="cal-new"', 'calendarMarkup'], ['btn', 'class="btn small hit" id="cal-prev"', 'calendarMarkup'], ['btn', 'class="btn small hit" id="cal-next"', 'calendarMarkup'], ['btn', 'class="btn small hit on-desk" id="cal-this"', 'calendarMarkup'], ['btn', 'class="btn small hit on-phone" id="cal-today"', 'calendarMarkup'], ['btn', '.cal-bar .btn.small{min-height:var(--control)', 'css'],
  ['bar', 'id="cal-people"', 'calendarMarkup'], ['bar', "label: 'Whose calendar'", 'calendar'], ['bar', "noun: 'thing'", 'calendar'], ['bar', 'calHousehold = false', 'shared'], ['bar', 'function calPress(', 'calendar'],
  ['over', 'aria-label="Over the calendar"', 'calendarMarkup'], ['over', "'hp.calOver'", 'calendar'], ['over', "lucide('sun')", 'calendar'], ['over', 'function renderOverlays(', 'calendar'], ['over', '#cal-over{', 'css'],
  ['C21', 'function dayCell(', 'calendar'], ['C21', "node('span', 'marks')", 'calendar'], ['C21', '.daystrip .marks', 'css'], ['C22', 'marksWords(', 'calendar'], ['C23', 'calDay = key;', 'calendar'],
  ['C56', "Plans' dates, held nights, money and the record are still shown.", 'calendar'], ['C57', 'could not be read just now; the rest is shown.', 'calendar'],
  ['S2', "else if (view === 'calendar') await loadCalendar(calWeek)", 'page'], ['S27', 'bookingHere()', 'calendar'], ['S27', 'dsmCalendarUrl()', 'calendar'], ['S14', 'peopleOrder()', 'calendar'],
  // The day card: one card of plain rows (Calendar Task 7).
  ['C24', 'function renderDayCard(', 'calendar'], ['C24', 'id="cal-card"', 'calendarMarkup'], ['C24', "'Nothing on.'", 'calendar'], ['C24', 'clashLine(', 'calendar'], ['C24', 'dayLong(', 'calendar'], ['row', 'function calRow(', 'calendar'], ['row', '.erow.cal{', 'css'], ['row', '--when', 'css'],
  ['C25', "'NIGHTS'", 'calendar'], ['C25', "'ALL DAY'", 'calendar'], ['C25', ' staying', 'calendar'], ['C25', 'kept by ${nameIn(', 'calendar'], ['C26', 'whenOf(', 'calendar'], ['C27', 'nowIndex(', 'calendar'], ['C27', '.cal-now{', 'css'], ['C31', 'openTodayAt({ offer: e.held.request })', 'calendar'],
  ['C59', 'not on the calendar yet', 'calendar'], ['C60', 'proposed, not approved', 'calendar'], ['C61', 'moved on the calendar', 'calendar'], ['C62', '.erow.cal.clash{', 'css'], ['C7', 'Add to ${', 'calendar'], ['C66', 'nightHeld(', 'calendar'], ['C6', 'id="cal-foot"', 'calendarMarkup'],
  ['money', "'AUTO PAY'", 'calendar'], ['money', "'PAY BY'", 'calendar'], ['money', "'BILL'", 'calendar'], ['money', "'PAID'", 'calendar'], ['money', "'DUE'", 'calendar'], ['money', ' · no receipt yet', 'calendar'], ['money', ' left`', 'calendar'], ['money', ' over`', 'calendar'], ['money', ' bills, about ', 'calendar'],
  ['rec', "The day's record", 'calendar'], ['rec', ' waiting on you', 'calendar'], ['rec', 'openTodayAt({ day', 'calendar'], ['rec', 'function dayWriters(', 'shared'], ['rec', 'dayWriters(', 'today'], ['also', 'alsoHasLine(', 'calendar'], ['also', "calAlso.setAttribute('aria-live', 'polite')", 'calendar'],
  ['S8', 'memberDisc(', 'calendar'], ['S10', 'householdDisc(e.label)', 'calendar'], ['S19', "focus === 'bills'", 'page'], ['S19', "focus === true || focus === 'cover'", 'page'],
  // The month picker (Calendar Task 8).
  ['month', 'function openPicker(', 'calendar'], ['month', 'function shutPicker(', 'calendar'], ['month', "'Previous month'", 'calendar'], ['month', "'Next month'", 'calendar'], ['month', '.daystrip.month', 'css'], ['C1', "$('cal-month').setAttribute('aria-expanded'", 'calendar'],
  // Forms in place (Calendar Task 9).
  ['C8', 'function calMount(', 'calendar'], ['C55', 'function closeCalOpen(', 'calendar'], ['C68', 'function calEscape(', 'calendar'], ['C68', "document.addEventListener('keydown', calEscape)", 'calendar'], ['C69', 'first.focus({ preventScroll: true })', 'calendar'],
  ['form', 'ep-form cal-form', 'calendar'], ['C33', "panelField('Day'", 'calendar'], ['C34', "'Which calendar'", 'calendar'], ['C34', "panelLabel('On')", 'calendar'], ['C35', "'For a plan'", 'calendar'], ['C36', "'Notes'", 'calendar'], ['C38', "'Overlaps '", 'calendar'], ['C39', "'Free from'", 'calendar'], ['C40', 'Sign in again to check for overlaps.', 'calendar'], ['C40', 'Overlaps could not be checked just now.', 'calendar'], ['C41', 'ex.status !== 400', 'calendar'],
  ['C43', 'say(ex.message)', 'calendar'], ['C44', 'async function afterCalChange(', 'calendar'], ['C46', 'except: e.evt_id', 'calendar'], ['C50', "'Open these nights'", 'calendar'], ['C52', "'Keep these nights'", 'calendar'], ['C52', 'Nights of a confirmed stay cannot be kept.', 'calendar'], ['C53', 'afterCalChange(from.value', 'calendar'], ['S15', 'await eventPlans()', 'calendar'], ['form', '.cal-form{', 'css'], ['form', '.cal-form .clashes .clash{color:var(--problem)', 'css'],
  // The desk (Calendar Task 10): day heads, the panel of a day, owners named, money in the all-day row.
  ['C12', 'function dayHead(', 'calendar'], ['C8', 'calWeek === mondayOf(day) && calWeekData.week === calWeek) openPanelDay(day)', 'calendar'], ['C12', "node('button', `dh", 'calendar'], ['C12', '.week .dh[aria-current="date"]', 'css'], ['C8', 'function openPanelDay(', 'calendar'], ['C8', 'function pressDayHead(', 'calendar'], ['C18', 'e.owner', 'calendar'],
  ['C18', 'stateGlyph(e.plan.state, { small: true })', 'calendar'], ['C19', "el.setAttribute('aria-label', rowWords(", 'calendar'], ['desk', 'function moneyBox(', 'calendar'], ['desk', '.ev.money{', 'css'], ['desk', '.ev.money.paid{', 'css'], ['desk', '.ev.money.short{', 'css'], ['desk', 'new ResizeObserver(', 'calendar'],
  // Deep links (Task 11 of the Calendar plan): Today lands on a day and a row, and Back from a plan returns there.
  ['S24', 'async function openCalendarAt(', 'calendar'], ['S24', 'calWeek = mondayOf(day)', 'calendar'], ['T86', 'openCalendarAt(day, e.evt_id)', 'today'], ['S24', 'openCalendarAt(todayKey())', 'today'], ['S24', 'openCalendarAt(o.calendar, o.key)', 'today'], ['back', "view === 'plan' || view === 'calendar'", 'plan'], ['visit', 'visitNeedsEveryone(', 'calendar'], ['visit', '.erow.cal.landed{', 'css'],
];
/** `whoDisc` is searched for on the whole page: Today's rail and the card both called it. */
const GONE: readonly Line[] = [
  ['T70', 'function unsortedItem(', 'page'], ['T70', 'They are in no envelope yet, so no envelope counts them as spent.', 'page'],
  ['S8', 'whoDisc(', 'page'],
  // Areas leave Settings: the editor, the counts that gated its Remove, and the read of the whole board that fed them.
  ['S16', '/api/plans?showDone=1', 'page'], ['spec', 'areaCounts', 'page'], ['spec', 'areasItem', 'page'], ['spec', 'areasForm', 'page'],
  // The old board (Task 11): its filters, lanes, cards and New plan form, and every shelf on the page.
  ['spec', 'planFilter'], ['spec', 'planShowDone'], ['spec', 'planRows'], ['spec', 'planAreas'], ['spec', 'LANES'], ['spec', 'laneLabel'],
  ['spec', 'renderBoard'], ['spec', 'boardCard'], ['spec', 'function planChips('], ['spec', 'newPlan('], ['spec', 'isShelf'],
  ['spec', 'plan-form', 'page'], ['spec', 'plan-filters', 'page'], ['spec', 'plan-new', 'page'], ['spec', 'plan-empty', 'page'],
  ['spec', 'plan-theirs', 'page'], ['spec', 'plan-done', 'page'], ['spec', "'Theirs'"], ['spec', 'Show done', 'page'], ['spec', 'New plan', 'page'],
  ['spec', 'the two of you', 'page'], ['spec', 'the clock runs', 'page'], ['spec', 'no clock', 'page'], ['spec', 'On a shelf', 'page'],
  ['spec', 'Not on a shelf', 'page'], ['spec', 'On this shelf', 'page'], ['spec', 'Add an item', 'page'], ['spec', 'The item'],
  ['spec', '· holds '], ['spec', 'shelf:', 'shared'], ['spec', "icon('shelf'", 'page'], ['spec', 'v.shelf'],
  // Names the spec lists that no entry above said: the filter's showDone, any shelf, and the shelf helpers.
  ['spec', 'showDone', 'page'], ['spec', 'shelf', 'page'], ['spec', 'Shelf', 'page'], ['spec', 'shelfFor', 'page'], ['spec', 'liveChildren', 'page'],
  ['spec', '.board', 'css'], ['spec', '.lane', 'css'], ['spec', '.bcard', 'css'], ['spec', '.shelf', 'css'], ['spec', '.ask-line', 'css'],
  ['spec', '#plan-form', 'css'], ['spec', '#plan-empty', 'css'],
  // The card (Task 14): the old Back that always went to the board, the old note and placeholder, the ask chip, the head's owner.
  ['P51', "Also in Today's thread"], ['P50', 'Leave a note for '], ['P50', 'betweenSection(v, theirs)'], ['P32', 'asked ${v.asked.to}'],
  ['P22', "node('div', 'waiting', 'Waiting for you')"],
  ['spec', 'function opensItsDay', 'threadSrc'], ['spec', 'const standalone', 'threadSrc'], ['spec', 'cardsFor', 'threadSrc'],
  ['P28', '/ask-to-take', 'page'], ['P28', 'Asking needs a reason'], ['P28', 'They read this on the card'], ['P28', 'Ask ${theirs}'], ['P27', "node('span', 'owner')"], ['card', '#plan-card .back{display:none}', 'css'],
  ['T4', 'id="t-filters"', 'page'], ['T4', 'threadFilter', 'page'], ['T4', '>Mine<', 'page'], ['T4', '>Theirs<', 'page'], ['T4', '>Everything<', 'page'], ['T5', 'id="t-all"', 'page'], ['T5', 'threadAll', 'page'], ['T5', 'All budgets', 'page'], ['T6', 'id="t-earlier"', 'page'], ['T6', 'Show earlier', 'page'], ['T10', 'document.documentElement.scrollHeight', 'today'], ['T13', 'id="thread"', 'page'], ['T13', "$('thread')", 'page'], ['T72', 'id="tray"', 'page'], ['T72', "$('tray')", 'page'], ['T72', ' waiting on you`', 'page'], ['T110', 'filterBeforeDetour', 'page'], ['S4', 'endFilterDetour', 'page'], ['T116', 'Nothing is waiting on you.', 'page'], ['spec', "$('composer'))", 'today'],
  ['spec', 'adjusted a suggestion', 'page'], ['T47', 'Waiting for either of you', 'page'], ['spec', 'Reason — they will read it', 'page'], ['spec', 'Why these instead — they will read it', 'page'], ['spec', "node('div', 'line')", 'today'],
  ['T21', "node('div', 'turn')", 'today'], ['T21', "'msg member'", 'today'], ['S32', 'dataset.kind = e.kind', 'today'],
  ['T82', 'placeYours', 'page'], ['T92', 'asked ${c.asked.to}', 'page'], ['T92', '${c.owner} asked', 'page'], ['S9', 'otherMember() ?? e.label', 'today'],
  ['T17', 'Read all of it', 'page'], ['spec', "'msg claude'", 'today'], ['spec', "node('div', 'bubble'", 'today'],
  ['T73', 'leave a note for each other', 'page'],
  ['spec', '.thread-tools', 'css'], ['spec', '.allb', 'css'], ['spec', '.tday', 'css'], ['spec', '.msg .by', 'css'], ['spec', '.msg.claude', 'css'], ['spec', '.msg.member', 'css'], ['spec', '.bubble', 'css'], ['spec', '.turn{', 'css'], ['T33', '.line{', 'css'], ['T33', '.line b', 'css'], ['T33', '.line .why', 'css'], ['T33', '.line.flag', 'css'], ['T33', '.line .row', 'css'], ['T72', '.tray', 'css'], ['T92', '.chip.asked', 'css'],
  ['T34', 'border-left:3px solid var(--caution-line);box-shadow:none', 'css'], ['T34', '.card.offer.moved{border-left-color', 'css'], ['T97', '.search-list', 'css'], ['T97', '.search-hit', 'css'], ['T97', '.top-inner > .search', 'css'], ['T99', '#search-notes', 'css'],
  ['T97', 'id="search"', 'page'], ['T97', 'id="search-q"', 'page'], ['T97', 'id="search-list"', 'page'], ['T100', 'function searchMark(', 'page'], ['T106', 'function searchSay(', 'page'], ['T106', "Today doesn't show that one", 'page'], ['T108', 'function searchOpen(', 'page'], ['T99', 'function searchDraw(', 'page'], ['T102', 'function searchGo(', 'page'], ['spec', 'SEARCH_KINDS', 'page'], ['spec', 'function searchClose(', 'page'], ['spec', 'searchClear(', 'page'], ['spec', 'searchReset(', 'page'],
  // The Calendar's legends, hint, dots and the helpers that served them (Calendar Task 6).
  ['C9', 'function legend(', 'page'], ['C9', 'cal-legend', 'page'], ['C10', 'legend(', 'calendar'], ['C11', 'Shows your calendar', 'page'], ['S3', 'cal-block', 'page'], ['C21', '.dots', 'css'], ['spec', '.legend', 'css'], ['spec', '.sw{', 'css'], ['spec', '.sw.', 'css'], ['spec', 'sourceName', 'page'], ['C6', 'class="btn small" id="cal-dsm"', 'calendarMarkup'], ['C56', 'Due dates from your plans are still shown', 'page'], ['C57', 'the rest of the week is shown', 'page'],
  // The phone's hour grid and its title (Calendar Task 7).
  ['C26', 'dayview', 'page'], ['C26', "hourLabels('hrs')", 'page'], ['C24', 'cal-day-count', 'page'], ['C24', 'cal-day-title', 'page'], ['C24', '.day-head', 'css'], ['C26', 'id="cal-day"', 'page'], ['spec', 'evNode(e, long', 'page'], ['spec', 'evSub(e, long', 'page'], ['spec', 'timedBoxes(events, day, long)', 'page'], ['spec', 'renderDay(', 'page'],
  // Forms in place (Calendar Task 9): the panel's old words and its closer.
  ['spec', 'Block these nights', 'page'], ['C50', 'Unblock these nights', 'page'], ['C52', 'cannot be blocked', 'page'], ['C34', 'Where it goes', 'page'], ['C35', 'Plan (optional)', 'page'], ['C36', 'Notes (optional)', 'page'], ['C38', 'Clashes with ${', 'page'], ['C39', 'Free instead', 'page'], ['C40', 'check for clashes', 'page'], ['spec', 'closeCalPanel', 'page'], ['spec', 'Plan › ${e.plan.title}', 'calendar'],
  // The desk (Calendar Task 10): the title attribute and the tags go, the dimmed second line goes.
  ['C19', 'el.title = said.join', 'page'], ['C18', "parts.push('clash')", 'page'], ['C18', "parts.push('from Plan')", 'page'], ['S9', 'otherMember', 'page'], ['spec', '.ev .s{display:block;opacity', 'css'],
  ['S24', 'openCalendarDay', 'page'],
];
const GONE_FROM_PLAN_MARKUP: readonly string[] = ['Both', 'Mine', 'Theirs'];
/** Ids reached for at the top level that a function draws before anything asks for them: each named with who draws it. */
const DRAWN_LATER: readonly string[] = [];

describe('the page ledger', () => {
  test('a Calendar form says a refusal once: only a week that cannot be read uses the error box', () => {
    assert.equal(uncommented(REGIONS.calendar).split('showProblem(').length - 1, 2); // loadCalendar, openPicker
    assert.equal(uncommented(REGIONS.calendar).includes("$('app-err')"), false);
  });
  test('the Calendar says none of the words the spec retired', () => {
    const text = uncommented(REGIONS.calendar) + uncommented(REGIONS.calendarMarkup);
    for (const w of ['Block nights', 'Unblock', 'overdue', 'thread']) assert.equal(new RegExp(`['\`>]${w}`, 'i').test(text), false, w);
  });
  test('every id the script reaches for at load is in the markup', () => {
    const ids = new Set([...script.matchAll(/^\S.*?\$\('([\w-]+)'\)/gm)].map((m) => m[1]!));
    assert.ok(ids.size >= 8, 'the pattern still finds the top-level lookups');
    assert.deepEqual([...ids].filter((id) => !markup.includes(`id="${id}"`) && !DRAWN_LATER.includes(id)), []);
  });
  test('the regions the entries are searched in are found', () => {
    for (const [name, text] of Object.entries(REGIONS)) assert.ok(text.length > 500, `the ${name} region is not empty`);
    assert.ok(planMarkup.includes('id="plan-card"'), "Plan's markup runs through the card's element");
    assert.ok(REGIONS.plan.includes('function renderCard('), "the plan region holds the card's script");
    assert.ok(REGIONS.today.includes('function renderSetupNotes('), 'the today region holds its script');
    assert.ok(REGIONS.shared.includes('function icon('), 'the shared region holds the helpers');
    assert.ok(REGIONS.calendar.includes('function evClasses('), 'the calendar region holds its script');
  });
  for (const [name, list, want] of [['kept', KEPT, true], ['added', ADDED, true], ['gone', GONE, false]] as const) {
    test(`what the ledger marks ${name}`, () => {
      assert.deepEqual(missing(list, want), []);
    });
  }
  test("Plan's markup has lost the old board's words", () => {
    assert.deepEqual(GONE_FROM_PLAN_MARKUP.filter((text) => uncommented(planMarkup).includes(text)), []);
  });
  test('the contrast tool lists no short pair', () => {
    assert.doesNotMatch(read('../../docs/superpowers/design/tools/contrast.py'), /\("--ink-faint","--accent-tint",4\.5/);
  });
  test('the page, its stylesheet and the package are one build', () => {
    const version = (JSON.parse(read('../package.json')) as { version: string }).version;
    assert.equal(/^const BUILD = '([^']+)';$/m.exec(script)?.[1], version);
    assert.equal(/href="\/tokens\.css\?v=([^"]+)"/.exec(markup)?.[1], version);
  });
  test('every route the page calls is one the server answers', () => {
    const called = new Set([...script.matchAll(/['"`](\/api\/[a-z0-9_/-]*)/g)].map((m) => m[1]!.replace(/\/$/, '')));
    for (const m of script.matchAll(/approveNow\('([a-z_]+)'|tool: '([a-z_]+)'/g)) called.add(`/api/tools/${m[1] ?? m[2]}`);
    const unanswered = [...called].filter((route) => (route.startsWith('/api/tools/')
      ? !tools.includes(`name: '${route.slice('/api/tools/'.length)}'`) : !server.includes(route)));
    assert.deepEqual(unanswered, []);
    assert.ok(called.size >= 10, 'the pattern still finds the routes the page calls');
    const subs = new Set([...script.matchAll(/planPath\([^()]*?, ['`]\/([a-z-]+)/g)].map((m) => m[1]!));
    assert.ok(subs.size >= 10, 'the pattern still finds the plan sub-routes');
    const answered = (/\((state\|[a-z|-]+)\)/.exec(server)?.[1] ?? '').split('|');
    assert.deepEqual([...subs].filter((sub) => !answered.includes(sub)), []);
  });
});

test('a suggestion\'s buttons run Decline, Adjust, Not now, Approve', () => {
  const b = between(REGIONS.today, 'function offerButtons(', '/** The screen a button acted on');
  const at = ["'Decline'", "'Adjust'", "'Not now'", "'Approve'"].map((w) => b.indexOf(w));
  assert.ok(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1]!)), String(at));
});

test("Today's new rules name tokens, never literals", () => {
  const css = between(REGIONS.css, '/* ── today: day cards ── */', '/* ── end of today ── */').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(css.length > 200, 'the section is found');
  assert.deepEqual(css.replace(/[^{}]+\{/g, '{').match(/#[0-9a-f]{3,8}\b|rgba?\(|\d(px|em|rem)\b|font-weight:\s*\d|letter-spacing:\s*-?[\d.]|opacity:/gi), null);
});

test("the people bar presses Everyone when the pressed member has nothing in view, the choice kept", () => {
  const b = between(REGIONS.today, 'function drawPeople(', '/** What the kind and person pressed leave out');
  assert.match(b, /people\.some\(\(p\) => p\.key === threadData\.who\)/, 'pressed is a member only when among the people shown');
  assert.doesNotMatch(b, /pressPerson\(null\)/, 'the choice is not cleared');
});

test("the Calendar's one grid column is bounded, so a wide people bar scrolls inside it and never widens the page", () => {
  const rule = REGIONS.css.match(/#calendar\{display:grid;[^}]*\}/);
  assert.ok(rule, 'the grid rule is found');
  assert.match(rule[0], /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

describe('after the final review', () => {
  const today = REGIONS.today;
  test('a pressed person who has left is let go before Today or search sends who', () => {
    assert.match(between(script, 'function livePerson(', 'const peopleOrder'), /!members\.includes\(personPressed\)\) pressPerson\(null\)/);
    assert.match(between(today, 'function threadParams(', 'async function loadThread('), /livePerson\(\) !== null\) q\.set\('who'/);
    assert.match(between(today, 'async function askRecord(', 'function markWords('), /livePerson\(\) !== null\) q\.set\('who'/);
    assert.doesNotMatch(between(today, 'function threadParams(', 'async function loadThread('), /personPressed !== null\) q\.set/);
  });
  test('the members changing lets a pressed person who left go', () => {
    assert.match(between(script, 'async function changeMembers(', 'function membersItem('), /members = out\.members;\s*livePerson\(\);/);
  });
  test("today's card calls the day empty only when nothing is in it, and says what is narrowed inside the card", () => {
    const card = between(today, 'function dayCard(', 'const KINDS');
    assert.match(card, /!entries\.length && today && row\.total === 0\) body\.appendChild\(node\('p', 'quiet', 'Nothing yet today\./);
    assert.match(card, /section\.appendChild\(node\('p', 'empty-line', none\)\)/);
    assert.doesNotMatch(between(today, 'function renderToday(', 'function todayEscape('), /emptyLine\(\)/);
  });
  test('a search answered as everyone shows Everyone pressed', () => {
    const b = script.slice(script.indexOf('function drawRecord('), script.indexOf('function drawRecord(') + 1200);
    assert.match(b, /out\.who === 'everyone' && personPressed !== null/);
    assert.match(b, /b\.dataset\.key === 'person:everyone'/);
  });
  test('a draw leaves Ask Claude and the composer note alone while a question is out or a result is held', () => {
    const draw = between(today, 'function renderToday(', 'function todayEscape(');
    assert.match(draw, /if \(!sayBusy\) \$\('ask-claude'\)\.disabled = !claudeOn;/);
    assert.match(draw, /if \(!sayBusy && !sayHeld\) sayDefault\(\);/);
    const ask = between(today, 'async function askClaude(', "$('composer').addEventListener");
    assert.match(ask, /sayBusy\+\+;[\s\S]*sayBusy--;/);
  });
});

// ── 0.9.2: the Settings tidy and three Calendar fixes. Every element the release touches, with its fate. ──
describe('the page ledger: 0.9.2', () => {
  const setupCode = between(script, 'function setupItem(', '/** Whether Universal Search reads');
  const groupsCode = between(script, 'function settingsGroups(', '/** A row by its key');
  const closeCode = between(script, 'function closePage(', '/** Whether the open page is one the person may only read');
  const KEPT_092: readonly Line[] = [
    // Setup's five rows stay in the Household group, the Savings account where Budget was (0.10.0's B63), Setup still first while it is there.
    ['setup', 'items: [setupItem(), zoneItem(), modelItem(), membersItem(), savingsItem(), hcalItem(), guestsItem(), documentsItem(),', 'page'],
    ['setup', "const STEP_ROW = { folder: 'documents', zone: 'zone', calendar: 'hcal', booking: 'guests', model: 'model' };", 'page'],
    ['setup', "if (su.first === step.id) b.setAttribute('aria-current', 'step');", 'page'],
    ['setup', "const reads = ['conflicts', 'hcal', 'setup'];", 'page'],
    ['setup', 'openSettings(a.group, a.row)', 'today'],
    ['setup', "const index = node('nav', 'set-index');", 'page'],
    // The phone's one way in: the You group's row, opening its sheet, whose Done comes back to the list.
    ['phone', 'items: [appearanceItem(), conflictsItem(), phoneItem()],', 'page'],
    ['phone', "open: () => { sheetFromSettings('row-phone'); void openPhoneSheet(); },", 'page'],
    ['phone', 'id="phone-sec"', 'page'], ['phone', "$('phone-close').addEventListener('click', () => closePhoneSheet());", 'page'],
    ['phone', 'id="me-settings">Settings</button>', 'page'],
    // A bill's own words, everywhere the Calendar says one.
    ['bill', "const KIND_WORDS = { due: 'DUE', autopay: 'AUTO PAY', payby: 'PAY BY', bill: 'BILL', paid: 'PAID' };", 'calendar'],
    ['bill', "const BILL_KINDS = [['due', 'Due'], ['autopay', 'Auto Pay'], ['payby', 'Pay by']];", 'page'],
    ['bill', '.ev.money.short{background:var(--problem-tint);color:var(--problem)}', 'css'],
    ['bill', "figure: m.over ? `${m.over} over` : `${m.left} left`, figCls: 'cal-short'", 'calendar'],
    ['bill', "if (m.short) sub.push(' · ', node('span', 'cal-short'", 'calendar'],
    // The form still comes into view at its top, its first field focused.
    ['form', "el.scrollIntoView({ block: 'start' });\n  first.focus({ preventScroll: true });", 'calendar'],
  ];
  const ADDED_092: readonly Line[] = [
    ['setup', 'if (done === steps.length) return null;', 'page'], ['setup', 'function backLabel(page) {', 'page'],
    ['setup', 'if (page?.from && pageFor(page.from.key, page.from.group)) {', 'page'],
    ['bill', "const MONEY_MARK_ORDER = ['due', 'payby', 'bill', 'autopay', 'paid'];", 'calendar'],
    ['bill', "autopay: 'a bill on Auto Pay'", 'calendar'], ['bill', "payby: 'a Pay by bill'", 'calendar'], ['bill', "payby: 'Pay by'", 'calendar'],
    // A desk box says the bill's kind in the words every name uses, not lowercased.
    ['bill', 'const w = MONEY_KIND_WORDS[m.billKind];', 'calendar'], ['bill', 'const w = MONEY_KIND_WORDS[m.kind];', 'calendar'],
    ['bill', 'under = `${MONEY_KIND_WORDS.paid} · ${m.name}`;', 'calendar'],
    ['bill', "const quietBill = (m) => m.kind === 'autopay' && !m.short;", 'calendar'],
    ['bill', '.mk-m:is(.due,.payby,.bill){color:var(--caution)}', 'css'], ['bill', '.mk-m.autopay{color:var(--ink-soft)}', 'css'],
    ['bill', '.ev.money.autopay{', 'css'], ['bill', '.erow.cal.autopay,', 'css'],
    ['hit', "`${evClasses(e)}${open ? ' hit' : ''}`", 'calendar'], ['hit', "node('button', `ev money hit", 'calendar'],
    ['hit', '.week .ev.hit::after{z-index:-1;', 'css'], ['hit', '.week .adrow{isolation:isolate}', 'css'],
    ['hit', 'isolation:isolate;clip-path:inset(', 'css'], ['hit', '.week .col .ev .s{flex:0 1 auto;min-height:0}', 'css'],
  ];
  const GONE_092: readonly Line[] = [
    ['phone', 'id="me-phone"', 'page'], ['phone', "$('me-phone')", 'page'],
    ['bill', "'Pay By'", 'page'], ['bill', "v.money.some((m) => m.kind !== 'paid') ? 'due'", 'calendar'], ['bill', "due: 'money'", 'calendar'],
    ['bill', "'a bill to pay by'", 'calendar'], ['bill', 'KIND_WORDS[m.kind].toLowerCase()', 'calendar'],
    ['bill', 'KIND_WORDS[m.billKind].toLowerCase()', 'calendar'], ['bill', 'under = `paid · ${m.name}`', 'calendar'],
    ['setup', "'All chosen'", 'page'],
    ['form', 'cal-room', 'page'],
    ['hit', 'overflow:hidden;text-decoration:none', 'css'],
  ];
  test('what 0.9.2 keeps, adds and takes away', () => {
    assert.deepEqual(missing(KEPT_092, true), []);
    assert.deepEqual(missing(ADDED_092, true), []);
    assert.deepEqual(missing(GONE_092, false), []);
  });
  test('the markers are found', () => assert.ok(setupCode.length > 300 && groupsCode.length > 300 && closeCode.length > 300));
  test('Setup is a row only while a step is not chosen', () => {
    const SETUP_ORDER = ['folder', 'zone', 'calendar', 'booking', 'model'];
    const run = (done: boolean[]) => new Function('settingsData', 'SETUP_ORDER', 'SETUP_LABELS', 'STEP_ROW', 'pageFor', 'node', 'settingItem', 'settingsPage', 'openPage',
      `${setupCode}\nreturn setupItem();`)(
      { setup: { youOwn: true, owner: 'alice', first: null, steps: SETUP_ORDER.map((id, i) => ({ id, done: done[i] })) } },
      SETUP_ORDER, {}, {}, () => null, () => ({}), () => ({}), null, () => {});
    assert.equal(run([true, true, true, true, true]), null);
    const one = run([true, false, true, true, true]);
    assert.deepEqual([one.key, one.status, one.attention], ['setup', '4 of 5 chosen', true]);
    assert.match(groupsCode, /\]\.filter\(Boolean\)/, 'a null row is left out of the list and of the side index');
  });
  test("a step opened from Setup goes Back to Setup while it is there, else to the list at the step's own row", () => {
    // closePage itself, run against stubs: the list or the Setup page drawn, and the rows it scrolls and focuses.
    const back = (setupThere: boolean) => {
      const said: string[] = [];
      const row = (sel: string) => ({
        scrollIntoView: (o: { block: string }) => said.push(`scroll ${sel} ${o.block}`),
        focus: () => said.push(`focus ${sel}`),
      });
      const host = { querySelector: (sel: string) => row(sel) };
      const fn = new Function('pageFor', 'renderSettingsPage', 'renderSettingsList', 'renderNasPanel', 'onHouseholds', 'settingsHost', 'document', 'window', 'CSS', 'pageEscape',
        `let settingsPage = null, settingsEditing = null, folderPick = null, restorePick = null;\n${closeCode}\n`
        + 'return (page) => { settingsPage = page; closePage(); return settingsPage; };');
      const run = fn(
        (key: string) => (key === 'setup' && !setupThere ? null : { key }),
        () => said.push('draw Setup'), () => said.push('draw list'), () => said.push('draw NAS'), () => false, () => host,
        { removeEventListener() {} }, { scrollTo: (o: { top: number }) => said.push(`scrollTo ${o.top}`) }, { escape: (s: string) => s }, () => {});
      const setup = { key: 'setup', group: 'household', listScroll: 0, returnTo: 'row-setup', from: null };
      const now = run({ key: 'hcal', group: 'household', listScroll: 0, returnTo: 'row-hcal', from: setup });
      return { said, now };
    };
    const gone = back(false);
    assert.equal(gone.now, null, 'no page is open: the list is');
    assert.deepEqual(gone.said, ['draw list', 'scroll [data-key="row-hcal"] center', 'focus [data-key="row-hcal"]']);
    const there = back(true);
    assert.equal(there.now?.key, 'setup', 'Setup is the open page again');
    assert.deepEqual(there.said, ['draw Setup', 'focus .set-page [data-key="row-hcal"]']);
    assert.match(between(script, 'function redrawPage(', '/** A refusal in the open page'), /backLine\.textContent = backLabel\(page\)/);
    assert.match(between(script, 'function renderSettingsPage(', '/** Where the open page'), /back\.append\(icon\('back', 'i'\), backLabel\(page\)\)/);
  });
  test("a spent phone code's page sends the member to Settings, not to a menu item that is gone", () => {
    assert.ok(server.includes('make a new one from Settings › You › Your iPhone and Mac.</p>'), 'KEPT');
    assert.equal(uncommented(server).includes('make a new one from Set up your iPhone'), false, 'GONE');
  });
  test('no document sends anyone to the phone sheet through the person menu', () => {
    for (const doc of ['../../README.md', '../../DEPLOY.md']) assert.doesNotMatch(read(doc), /iPhone\*{0,2}\s+from the person menu/i, doc);
    assert.match(read('../../DEPLOY.md'), /from Settings › You › Your iPhone and Mac/);
  });
});

// ── 0.10.0: one budget, receipts sorted into envelopes, categories as headings. Rows B1 to B84 of plan 2026-11-10-one-budget-envelopes. ──
const KEPT_010: readonly Line[] = [
  // Task 7: the head's menu keeps Where it is, local pricing and Discard; the card, Income, Needs you, the rows and the month's end stay.
  ['B4', 'id="bud-where"', 'budgetMarkup'], ['B4', 'Not set yet, so local costs cannot be looked up', 'budget'],
  ['B5', 'id="bud-seed">Price it from local data', 'budgetMarkup'], ['B8', 'id="month-discard"', 'budgetMarkup'], ['B8', "`Discard ${name}'s plan`", 'budget'],
  ['B13', 'id="ta-next"', 'budgetMarkup'], ['B13', '<span class="k">Planned</span>', 'budgetMarkup'],
  ['B14', 'Record an income', 'budgetMarkup'], ['B14', 'id="inc-what-if"', 'budgetMarkup'], ['B15', 'id="needs-h">Needs you<', 'budgetMarkup'],
  ['B19', 'function envelopeRow(', 'budget'], ['B19', "amt = 'No figure yet'", 'budget'],
  ['B26', 'id="month-close"', 'budgetMarkup'], ['B26', '`Reopen ${name}`', 'budget'],
  // Task 9: the envelope's page keeps its card, its sections, the funding page, Bills, Receipts, the foot and Escape.
  ['B29', 'function envCard(', 'budget'], ['B29', 'How much each month?', 'budget'], ['B29', 'function coverBlock(', 'budget'],
  ['B30', "envSection('Each month')", 'budget'], ['B31', 'function openFundingPage(', 'budget'], ['B31', "epField('Take it from', from)", 'budget'],
  ['B32', "envSection('Bills', 'bills')", 'budget'], ['B33', 'Nothing has been spent from this envelope yet.', 'budget'],
  ['B33', 'do not trust this envelope', 'budget'], ['B34', 'Make this a savings goal', 'budget'], ['B34', 'Remove this envelope', 'budget'],
  ['B39', "host.querySelector('.ep-slot [data-cancel]')", 'budget'],
  // Task 10: To sort's words, the split rule's mark, Suggest, the split editor and its words, Import's words, Put it back, Today's waiting item.
  ['B40', 'Give each one an envelope.', 'budget'], ['B43', 'a rule says: divide this', 'budget'], ['B44', 'Nothing confident enough to suggest', 'budget'],
  ['B48', 'function splitEditor(', 'budget'], ['B48', '+ another line', 'budget'], ['B48', 'an envelope is on two lines', 'budget'],
  ['B48', 'a split needs two envelopes', 'budget'], ['B50', 'Drop a bank export here, or choose one', 'page'],
  ['B51', '<div class="k">Sorted by rule</div>', 'page'], ['B52', 'Sort these by hand, or try again later.', 'budget'],
  ['B53', 'Accept all suggestions', 'budget'], ['B55', 'What does Savings show today?', 'budget'],
  ['B56', 'Every receipt has an envelope.', 'budget'], ['B57', 'still need an envelope.', 'budget'], ['B59', 'Put it back', 'budget'],
  ['B83', 'In no envelope yet', 'today'], ['B47', "'Split across envelopes…'", 'matchSrc'],
  // Task 11: the savings account's form, its hint, and the Months band's words.
  ['B65', "submit: 'Record it'", 'page'], ['B65', 'Envelopes saved in Savings are checked against this account.', 'page'],
  ['B68', 'Opened plans and every move made in them.', 'page'],
  // Task 12: the walkthrough's heading, rail and words; the income step's; the pricing step's two buttons.
  ['B69', "Start the household's budget", 'budgetMarkup'], ['B69', "['envelopes', 'Envelopes']", 'budget'],
  ['B71', 'the same every month', 'budget'], ['B71', 'seen in imports', 'budget'],
  ['B74', "'Set the location'", 'budget'], ['B74', "'Finish'", 'budget'],
  ['B73', 'Start with these envelopes.', 'budget'], ['B73', "'Add one of your own'", 'budget'],
  ['B73', 'priced in step 3', 'budget'], ['B73', 'e.g. Childcare, Pets, Tuition, HOA', 'budget'],
];
const ADDED_010: readonly Line[] = [
  // Task 7: the head names the month; two tabs; Where it is for the household; the list by category; the words that named a budget.
  ['B1', 'id="budget-month"', 'budgetMarkup'], ['B10', "const BUDGET_SUBS = ['budget', 'import'];", 'page'], ['B10', 'aria-label="Budget or Import"', 'budgetMarkup'],
  ['B12', "panel('Where it is'", 'budget'], ['B12', "tool: 'set_location'", 'budget'],
  ['B17', 'function categoryBand(', 'budget'], ['B17', 'for (const c of result.categories)', 'budget'],
  ['B18', 'function savingsCheckLine(', 'budget'], ['B18', "openSettings('household', 'savings')", 'budget'],
  ['B20', "'No envelopes yet'", 'budget'], ['B27', "'erow-removed'", 'budget'], ['B72', '`Open ${monthLong(fr.month)}`', 'budget'],
  ['B75', "Claude · the budget's briefing", 'today'], ['B77', 'The budget is not started yet.', 'page'], ['B78', 'This month is not open yet.', 'today'],
  ['B79', 'The budget has no plan for this month yet. ', 'page'], ['B80', "lab('Envelope', envSel)", 'plan'],
  ['B84', 'async function loadBudgetMeta(', 'budget'], ['B84', "api('/api/budget')", 'budget'], ['B84', 'async function openBudgetAt(envelope, focus)', 'budget'],
  // Pins moved here from the 0.7.0 lists (T3, T113, S19): a notice and a change open the envelope alone; Today's problem is said once.
  ['T3', 'openBudgetAt(a.envelope, a.cover === true)', 'today'], ['S19', 'openBudgetAt(o.envelope)', 'today'],
  ['T113', "new Error('The budget is not started yet.')", 'today'],
  // Fix round 1: the menu hidden until the budget is started (as the base hid it with no budget), and the pins the review found missing.
  ['B8', "$('budget-menu-btn').closest('.menu').hidden = !budgetMeta.started;", 'budget'], ['B8', "$('month-discard').addEventListener('click', () => {\n  if (!month) return;", 'budget'],
  ['B1', "$('budget-month').textContent = monthLong(result.month);", 'budget'],
  ['B77', "box.append('The budget is not started yet. ', textBtn('Open Budget'", 'page'],
  ['B80', `"This month isn't open"`, 'plan'], ['B80', '{ envelope: envSel.value || null }', 'plan'],
  ['B27', "node(e.removed ? 'div' : 'button'", 'budget'], ['B27', "node('span', 'erow-title')", 'budget'],
  ['B18', "appendChild(rows);\n  }\n  // The check against the account is about the savings envelopes together, wherever they sit: after the last band.\n  if (result.savings) $('bands').appendChild(savingsCheckLine(result.savings));", 'budget'],
  // Task 8: an empty category's own Add an envelope; the heading's menu; the two add rows; the two short forms, written at once.
  ['B21', 'addEnvelopeForm(slot, { category: c.id })', 'budget'],
  ['B22', 'function categoryMenu(', 'budget'], ['B22', "'Move up'", 'budget'], ['B22', "'Move down'", 'budget'],
  ['B22', "'Move its envelopes first.'", 'budget'], ['B22', "approveNow('rename_category'", 'budget'],
  ['B22', "approveNow('move_category'", 'budget'], ['B22', "approveNow('remove_category'", 'budget'], ['B22', 'function menuOn(', 'page'],
  ['B23', 'id="cat-add"', 'budgetMarkup'], ['B23', 'id="env-new" type="button">Add an envelope', 'budgetMarkup'],
  ['B23', 'class="add-row hit" id="env-new"', 'budgetMarkup'],
  ['B24', 'function addEnvelopeForm(', 'budget'], ['B24', "'New category…'", 'budget'], ['B24', "approveNow('add_envelope'", 'budget'],
  ['B24', "focus: 'change'", 'budget'],
  ['B25', 'function addCategoryForm(', 'budget'], ['B25', "approveNow('add_category'", 'budget'], ['B25', "'Add it'", 'budget'],
  // Task 9: the page's line names the category; Rename and Change its category in the foot, written at once; one estimate; Remove's count sentence.
  ['B28', 'month.categories.find((c) => c.id === e.category)', 'budget'],
  ['B35', "textBtn('Rename', 'link hit', 'rename'", 'budget'],
  ['B36', "textBtn('Change its category', 'link hit', 'move'", 'budget'], ['B36', "approveNow('change_envelope'", 'budget'],
  ['B37', "'It costs'", 'budget'], ['B37', 'Leave the cost empty for none.', 'budget'],
  // B38: the count sentence is not the server's first effect ("<name> disappears from the budget" is), so it is found by its words.
  ['B38', "headLine.textContent = proposal.effects?.find((x) => x.includes('back to To sort'))", 'budget'],
  // Task 9 fix round 1: one form at a time across Each month and the foot; a late goal proposal stays out of a slot
  // given back; a category just removed leaves the list; the foot form's Cancel is what Escape presses.
  ['B34', "each.slot.querySelector(':scope > .goal-form, :scope > form')", 'budget'], ['B34', 'closeBillForm();\n      closeFoot();\n      const amt', 'budget'],
  ['B37', 'if (envelopePage !== page || !wrap.isConnected) return;\n      showProposal(slot, proposal, go);', 'budget'],
  ['B36', 'categories = categories.filter((c) => c.id !== gone.id);', 'budget'], ['B36', 'field.el.replaceWith(fresh.el);', 'budget'],
  ['B35', "form.setAttribute('aria-labelledby', title.id);", 'budget'],
  ['B39', "const cancel = textBtn('Cancel', 'btn', null, close);\n    cancel.dataset.cancel = '';\n    const save = node('button', 'btn primary', 'Save');", 'budget'],
  // Task 10: To sort holds what the server says it holds; a pick, an Accept, a split and an Edit are written at once; a rule is
  // offered after, shown, and kept only by Remember it; Import and Restore read and send an envelope; Today counts what To sort holds.
  ['B83', "w.kind === 'tosort'", 'today'], ['B40', 'toSortOnly: true', 'budget'], ['B41', "approveNow('sort_receipts'", 'budget'],
  ['B42', 'function ruleOffer(', 'budget'], ['B42', "'Show the rule'", 'budget'], ['B42', "'/api/tools/add_rule'", 'budget'],
  ['B46', 't.missing', 'budget'], ['B48', 'envelope: l.sel.value', 'budget'],
  ['B49', "approveNow('sort_receipts', { assignments: [entry] })", 'budget'], ['B54', 'r.envelope', 'budget'],
  ['B60', 'envelopeSelect(options, r.envelope ?? null, { allowSplit: false })', 'budget'],
  // Task 10 fix round 1: a row's unsaved work (a suggestion, a split being typed, a refusal) survives another row's
  // sort; an overtaken draw draws nothing; a refusal after a redraw is said on the fresh row; a split line whose
  // envelope has gone is counted again; Edit's focus is asked of one draw; Restore's "no envelope" is null; Import
  // counts its own file's receipts still to sort.
  ['B41', 'const queueKept = { turn: -1, rows: new Map() };', 'budget'], ['B41', 'const kept = queueKept.rows.get(t.id);', 'budget'],
  ['B44', "...(row.tag && row.suggestion ? { suggestion: row.suggestion } : {}),", 'budget'],
  ['B46', "...(row.editor ? { split: row.editor.parts(), was: row.was } : {}),", 'budget'],
  ['B41', 'if (turn !== householdTurn || load !== queueLoads) return;', 'budget'], ['B41', 'const fresh = queueRows.get(row.id);', 'budget'],
  ['B48', "if (sel.closest('.split-line')) sel.dispatchEvent(new Event('change'));", 'budget'],
  ['B49', 'if (page.focusReceipts === draw) {', 'budget'], ['B60', 'envelope: sel.value || null', 'budget'],
  ['B57', '${out.added - out.sorted} still need an envelope.', 'budget'],
  // Task 11: the guards name the phone sheet alone; Settings' Savings account row; Backup's two renamed bands and the scope `budget`.
  ['B62', "if (!$('phone-sec').hidden) return;", 'page'],
  ['B63', "key: 'savings', title: 'Savings account'", 'page'], ['B63', 'The account the envelopes saved in Savings live in.', 'page'],
  ['B66', "name: 'Receipts and rules'", 'page'], ['B66', "Needs the budget's envelopes.", 'page'],
  ['B67', "{ key: 'budget', name: 'Budget'", 'page'], ['B67', "new Set(['facts', 'budget', 'months', 'thread'])", 'page'],
  // Task 12: Where it is in place of naming a budget, its Skip held on the page; the envelopes under the starter categories.
  ['B70', 'function walkWhereStep(', 'budget'], ['B70', "node('h2', '', 'Where it is')", 'budget'], ['B70', 'Give a town or a ZIP, or Skip.', 'budget'],
  // Fix round 1: the lone income step takes focus as the others do; the income step's secondary first; an unticked chip quiet by colour.
  ['B72', "walkFocus('alone');", 'budget'], ['B71', 'acts.append(...[other, save].filter(Boolean));', 'budget'],
  ['B73', '.walk-row.off .chip{color:var(--ink-soft)', 'css'],
  ['B70', "approveNow('set_location'", 'budget'], ['B70', 'walkWhereSkipped = true', 'budget'],
  ['B73', 'for (const [gi, g] of fr.categories.entries())', 'budget'], ['B73', 'categoryField(fr.categories', 'budget'],
  // Two rows Task 10 carried without a pin, so the completeness test below finds every row: Import's rules offered one by one.
  ['B58', 'void ruleOffer(item, { match, envelope: r.envelope, label, txnId: r.id }', 'budget'],
];
const GONE_010: readonly Line[] = [
  // Task 7: every trace of a second budget, Compare, the outside note and the savings band of its own.
  ['B1', 'function markChosenBudget(', 'page'], ['B2', 'budget-switch', 'page'], ['B3', 'budget-pick', 'page'],
  ['B6', 'bud-rename', 'page'], ['B6', 'Rename this budget', 'page'], ['B7', 'bud-new', 'page'], ['B7', 'New budget', 'page'],
  ['B9', 'bud-archive', 'page'], ['B9', 'Archive this budget', 'page'],
  ['B10', 'data-sub="compare"', 'page'], ['B11', 'id="compare"', 'page'], ['B11', 'compare_budgets', 'page'], ['B11', 'function loadCompare(', 'page'],
  ['B11', 'Pick two different budgets.', 'page'], ['B11', '.verdict', 'css'], ['B11', 'table.cmp', 'css'],
  ['B12', 'blank if it is a period, not a place', 'page'], ['B12', 'Where is ${b?.label', 'page'],
  ['B16', 'outside-box', 'page'], ['B16', 'no envelope here covers', 'page'], ['B16', 'Add an envelope for them', 'page'],
  ['B17', 'result.groups', 'page'], ['B17', 'bands.get(e.group)', 'page'], ['B18', 'function savingsBand(', 'page'],
  ['B72', "?.label ?? 'this budget'", 'page'], ['B75', 'Claude · briefing for ', 'page'], ['B76', 'live.length > 1 ? live.find', 'page'],
  ['B77', 'no budgets yet', 'page'], ['B77', 'This household has no budget yet.', 'page'], ['B78', 'No budget has this month open yet.', 'page'],
  ['B79', "b?.label ?? 'This budget'", 'page'], ['B80', "lab('Budget', budgetSel)", 'page'], ['B80', "a budget'}; this month isn't open", 'page'],
  ['B81', 'the budgets side by side', 'page'], ['B82', 'chosenBudget', 'page'], ['B82', 'loadBudgets', 'page'], ['B82', "'/api/budgets'", 'page'],
  ['B82', 'budget: month.budget', 'page'], ['B84', 'openBudgetAt(m.budget', 'page'],
  // Task 8: the old Add an envelope panel, its Band and Fed by, its figure, and the tool it proposed. With the Categories
  // sheet gone (Task 11), no field anywhere on the page is called Band.
  ['B24', "panel('Add an envelope'", 'page'], ['B24', 'Fed by (choose one or more)', 'page'], ['B24', "label: 'Band'", 'page'],
  ['B24', 'Leave it empty to give it a figure later.', 'page'], ['B24', 'catOptions', 'page'], ['B24', "tool: 'define_envelope'", 'page'],
  // Task 9: the group or Savings on the page's line, the estimates kept on the categories, and Remove's old line.
  ['B28', "e.sinking ? 'Saved in Savings' : e.group", 'page'],
  ['B37', 'Kept on the categories, so every budget sets aside the same.', 'page'], ['B37', 'e.categories', 'page'],
  ['B38', 'Its receipts stay, but stop belonging to any envelope.', 'page'],
  // Task 10: the uncategorised filter, the remember tick and its text, the per-row picker list, the proposal a sort was, the
  // category a restore sent. `r.category` is pinned with Task 12's rows, on the whole budget region.
  ['B83', "w.kind === 'unsorted'", 'page'], ['B41', 'uncategorizedOnly', 'page'], ['B42', "' remember '", 'page'],
  ['B42', 'remember: always ask to divide', 'page'], ['B42', 'Payee text the rule matches', 'page'],
  ['B47', 'Not in this budget', 'matchSrc'], ['B47', 'records the category that feeds it', 'page'],
  ['B49', "'/api/tools/categorize_transactions'", 'page'], ['B54', 'r.options ?? preview.options', 'page'],
  ['B60', 'for (const c of await categoryList())', 'page'], ['B60', '...(sel.value ? { category: sel.value } : {})', 'page'],
  // Task 11: the Categories sheet, its panels, its list and cache; Settings' categories line; Backup's old band names.
  ['B61', 'cat-sec', 'page'], ['B61', 'function renderCategories(', 'page'], ['B61', 'function openCategories(', 'page'],
  ['B61', 'Shared by every budget', 'page'], ['B61', "'Add the starter set'", 'page'], ['B61', "'Stop using a category'", 'page'],
  ['B61', "['House', 'People', 'Future']", 'page'], ['B61', 'function categoryList(', 'page'], ['B61', 'categoriesCache', 'page'],
  ['B61', '.cat-kind', 'css'], ['B64', 'Edit the categories', 'page'], ['B64', 'categoriesInUse', 'page'],
  ['B66', 'Receipts, categories and rules', 'page'], ['B67', 'Budgets and envelopes', 'page'], ['B67', 'how categories are grouped', 'page'],
  // Task 12: naming a budget, and the groups the envelopes step drew. With the walkthrough's rows gone, `r.category` is gone from the whole budget region.
  ['B70', 'Name the budget', 'page'], ['B70', 'Make the budget', 'page'], ['B70', "'create_budget'", 'page'], ['B70', 'fr.budget', 'page'],
  ['B73', "'Group'", 'page'], ['B73', 'fr.groups', 'page'], ['B54', 'r.category', 'budget'], ['B73', '.walk-row.off .chip{opacity', 'css'],
  // The two rows Task 10 carried without a pin here: the proposal a sort was (B45, also its own test below) and Import's rules shown together (B58).
  ['B45', "api('/api/tools/categorize_transactions', { assignments })", 'page'], ['B58', "'Remember them'", 'page'], ['B58', "'Show the rules'", 'page'],
];
/** To sort's own code, for what it may never say again. */
const queue = between(script, '// ── the unsorted queue', '// ── reading the screen again');
describe('the page ledger: 0.10.0', () => {
  test('what 0.10.0 keeps, adds and takes away', () => {
    assert.deepEqual(missing(KEPT_010, true), []);
    assert.deepEqual(missing(ADDED_010, true), []);
    assert.deepEqual(missing(GONE_010, false), []);
  });
  test('To sort shows nothing before it is written (B45)', () => {
    assert.ok(queue.includes('async function loadUnsorted('), 'the queue is found');
    assert.equal(uncommented(queue).includes('Show what this would do'), false);
  });
  test('every row of the ledger is pinned', () => {
    const rows = new Set([...KEPT_010, ...ADDED_010, ...GONE_010].map(([r]) => r));
    assert.deepEqual(Array.from({ length: 84 }, (_, i) => `B${i + 1}`).filter((r) => !rows.has(r)), []);
  });
  test('a household chosen on the picker that cannot then be read (a log from before 0.10.0) lands back on the picker, saying why', () => {
    const open = between(script, 'async function openHousehold(', "$('hh-signout')");
    assert.match(open, /try \{ await enterApp\(\); \} catch \(ex\) \{ await pickerSaying\(ex\); \}/);
  });
});
