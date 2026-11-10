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
  todayMarkup: markup.slice(markup.indexOf('<div id="briefing"'), markup.indexOf('<!-- Budget, Import and Compare')),
  threadSrc: read('../src/thread.ts'),
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
  ['S9', 'const otherMember', 'shared'], ['S15', 'async function eventPlans(', 'page'], ['S15', "(await api('/api/plans')).rows.flatMap((r) => r.plans)", 'page'], ['S18', 'function railChips(', 'page'], ['S11', 'const clockOf', 'shared'],
  ['S11', 'const todayKey', 'shared'], ['S5', 'async function openTodayAt(', 'shared'], ['S2', 'async function reloadView(', 'page'], ['S6', 'function actionButton(', 'page'],
  ['shared', 'function icon(', 'shared'], ['shared', 'function lucide(', 'shared'], ['shared', 'function chip(', 'shared'], ['shared', 'function inlineForm(', 'shared'],
  ['card', 'function renderCard('], ['card', 'function checklistSection('], ['card', 'function attachmentsSection('], ['card', 'function claudeSection('],
  ['card', 'function betweenSection('], ['card', 'function moneySection('], ['card', 'function peopleSection('], ['card', 'function whenSection('],
  ['card', 'function factsCard('], ['card', 'async function openCard('],
// Today (0.8.0): what stands before the rebuild and after it.
['T1', 'Put Home Planner on your Home Screen', 'todayMarkup'], ['T1', 'function homeBanner(', 'page'], ['T2', 'openSettings(a.group, a.row)', 'today'], ['T3', 'openBudgetAt(a.budget, a.envelope, a.cover === true)', 'today'],
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
['T91', 'Plans that need you', 'todayMarkup'], ['T91', 'function plansRail(', 'today'], ['T93', 'Nothing of yours is due this week, or in Doing.', 'today'], ['T94', 'Money this month', 'todayMarkup'], ['T94', 'function moneyRail(', 'today'], ['T95', 'No budget has this month open yet.', 'today'],
['T103', 'Nothing in the household matches that.', 'page'], ['T104', 'The search could not be done just now.', 'page'], ['T105', 'Sign in again to search briefings, answers and files too.', 'page'], ['T112', 'function showProblem(', 'page'], ['T113', 'This household has no budget yet. ', 'page'], ['T114', 'Open it from the template', 'page'],
['T118', "ev.key === 'Enter' && !ev.shiftKey", 'today'], ['T119', '!ev.isComposing', 'today'],
['S12', 'const dayKey', 'today'], ['S12', 'const timeOf', 'today'], ['S12', 'const fmtDate', 'today'], ['S12', 'const asOf', 'today'], ['S13', 'const docTexts', 'today'], ['S13', 'function readDocText(', 'today'], ['S13', 'const docRead', 'today'], ['S13', 'let docHousehold', 'today'],
['S14', 'claudeOn = who.claude === true', 'page'], ['S20', 'id="unsorted-q"', 'page'], ['S20', 'async function categoryList(', 'page'], ['S21', 'const chosenBudget', 'page'], ['S24', 'let calWeek', 'page'], ['S27', 'const bookingHere', 'page'], ['S27', 'const dsmCalendarUrl', 'page'],
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
  ['T111', "$('loading').hidden = false", 'today'], ['T113', "new Error('This household has no budgets yet.", 'today'], ['T114', "new Error('no open month')", 'today'], ['T115', 'Nothing yet today. Ask Claude something, or leave a note.', 'today'], ['T117', 'if (turn !== loadTurn || household !== householdTurn) return;', 'today'],
  ['S2', 'else await loadThread();', 'today'], ['S3', "$('days').addEventListener('focusin'", 'today'], ['S31', "$('days').addEventListener('focusout'", 'today'],
  ['frame', '<h1>Today</h1>', 'todayMarkup'], ['frame', 'id="today-day"', 'todayMarkup'], ['frame', 'id="t-kinds"', 'todayMarkup'], ['frame', 'id="t-people"', 'todayMarkup'], ['frame', 'id="t-waiting"', 'todayMarkup'], ['frame', 'id="day-today"', 'todayMarkup'], ['frame', 'id="earlier-days"', 'todayMarkup'], ['frame', '.day-open{', 'css'], ['frame', '.day-body', 'css'],
  // A row is lane, who, what and when (Task 8).
  ['T21', 'function entShell(', 'today'], ['T21', 'left a note', 'today'], ['T21', 'asked Claude', 'today'], ['T22', 'planCrumb(e.plan)', 'today'], ['T23', "e.kind === 'ask' && e.plan", 'today'], ['T29', "node('span', 'ent-why'", 'today'], ['T31', 'refused.textContent = ex.message', 'page'], ['T33', 'No reason was given for this.', 'today'],
  ['S11', 'clockOf(', 'shared'], ['S24', 'function openCalendarDay(', 'shared'], ['S24', 'calWeek = mondayOf(day)', 'shared'], ['S29', 'name ?? nameOf(who)', 'today'], ['S19', 'openBudgetAt(o.budget, o.envelope)', 'today'],
  ['hand', ' handed ', 'today'], ['hand', ' took ', 'today'], ['cal', ' added ', 'today'], ['cal', 'the Household calendar', 'today'], ['cal', 'their own calendar', 'today'], ['cal', 'your own calendar', 'today'], ['cal', ' renamed ', 'today'], ['late', 'Suggested on ', 'today'], ['open', "'Open the plan'", 'today'], ['open', "'Open the envelope'", 'today'], ['open', "'Open the day'", 'today'],
  ['lane', 'function laneIcon(', 'shared'], ['lane', "'message-square':", 'shared'], ['lane', 'function claudeDisc(', 'shared'], ['lane', '.who.claude', 'css'], ['ent', '.ent{', 'css'], ['ent', 'cursor:pointer;text-decoration:underline', 'css'],
  // A waiting card is a dashed block in its own row (Task 9).
  ['T20', "From the day's briefing", 'today'], ['T28', 'From your question at ', 'today'], ['T46', 'In place of an earlier suggestion', 'today'], ['T46', ' suggested', 'today'], ['T47', "label = 'Waiting'", 'today'], ['T34', 'function waitingBlock(', 'today'], ['T35', "'Not now'", 'today'], ['T34', '.block-err', 'css'], ['T40', 'function blockSlot(', 'today'], ['T40', 'function actionButton(label, cls, act, slot = null)', 'today'], ['T41', 'function decidedLine(', 'today'], ['T44', "o.status === 'snoozed'", 'today'],
  ['T49', 'asked you to take', 'today'], ['T50', 'mine ? \'Waiting for you\' : `Waiting on ${ask.to}`', 'today'], ['T53', 'DRIFT_LABELS[on].chip', 'today'], ['T56', 'planCrumb(e.plan)', 'today'], ['T58', "actionButton('Seen it'", 'today'], ['T61', 'clash: e.blocked', 'today'], ['T62', 'Reason (they will read it)', 'today'], ['T63', 'Why these instead (they will read it)', 'today'], ['T64', 'function bookingSend(', 'today'], ['T65', '/^approved\\b/.test(ex.message)', 'today'],
  ['T120', 'why.focus()', 'today'], ['T120', 'arrive.focus()', 'today'], ['T121', 'b.disabled = true', 'today'], ['S6', '.is-decided', 'css'], ['S7', 'function askAnswer(', 'today'], ['S22', 'showProblem(ex)', 'today'], ['esc', 'function todayEscape(', 'today'], ['esc', 'cancelMark(row, closeDecline)', 'today'], ['esc', 'cancelMark(row, closeBooking)', 'today'],
  // The briefing opens its day (Task 10).
  // Yours is a strip on a phone and a column on the desk (Task 11).
  ['T82', 'function yoursStrip(', 'today'], ['T85', ' more`', 'today'], ['T81', "'Yours'", 'today'], ['T86', 'e.plan ? openCard(e.plan.id)', 'today'], ['T87', 'function householdDisc(', 'shared'], ['T87', 'e.owner', 'today'], ['T96', 'yoursRails', 'today'], ['S10', 'householdDisc(e.label)', 'today'], ['S32', 'yoursStrip()', 'today'], ['strip', '.yours-strip', 'css'],
  ['T14', "Claude · the day's briefing", 'today'], ['T14', 'Claude · briefing for ', 'today'], ['T14', '.day .claude', 'css'], ['T15', 'Briefing · written without Claude', 'today'], ['T16', "'headline'", 'today'], ['T17', 'Read the whole briefing', 'today'], ['T18', 'Reading the briefing…', 'today'],
  // Kinds, people, empty days and the earlier months (Task 12).
  ['T4', 'const KINDS = ', 'today'], ['T4', "['all', 'All']", 'today'], ['T4', "['notes', 'Notes']", 'today'], ['T4', 'function pressKind(', 'today'], ['T4', "label: 'Whose'", 'today'], ['T4', "plural: 'entries'", 'today'], ['T4', '.filters.kinds', 'css'], ['T6', '`Show ${', 'today'], ['T6', 'function showMonth(', 'today'], ['sort', 'function flipSort(', 'today'], ['sort', "'Newest first'", 'today'], ['sort', "'Oldest first'", 'today'], ['sort', "'arrow-up-down':", 'shared'], ['empty', 'function emptyLine(', 'today'], ['empty', 'Nothing under ${', 'today'], ['left', 'and are left out.', 'today'], ['left', 'and is left out.', 'today'], ['bar', 'plural', 'shared'],
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
];
const GONE_FROM_PLAN_MARKUP: readonly string[] = ['Both', 'Mine', 'Theirs'];
/** Ids reached for at the top level that a function draws before anything asks for them: each named with who draws it. */
const DRAWN_LATER: readonly string[] = [];

describe('the page ledger', () => {
  test('every id the script reaches for at load is in the markup', () => {
    const ids = new Set([...script.matchAll(/^\S.*?\$\('([\w-]+)'\)/gm)].map((m) => m[1]!));
    assert.ok(ids.size >= 10, 'the pattern still finds the top-level lookups');
    assert.deepEqual([...ids].filter((id) => !markup.includes(`id="${id}"`) && !DRAWN_LATER.includes(id)), []);
  });
  test('the regions the entries are searched in are found', () => {
    for (const [name, text] of Object.entries(REGIONS)) assert.ok(text.length > 500, `the ${name} region is not empty`);
    assert.ok(planMarkup.includes('id="plan-card"'), "Plan's markup runs through the card's element");
    assert.ok(REGIONS.plan.includes('function renderCard('), "the plan region holds the card's script");
    assert.ok(REGIONS.today.includes('function renderSetupNotes('), 'the today region holds its script');
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
