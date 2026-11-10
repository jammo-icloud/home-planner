import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The block has no DOM in it: it is read out of the page and run here.
const page = readFileSync(new URL('../../site/index.html', import.meta.url), 'utf8');
const block = page.slice(page.indexOf('// ── the calendar: what a day shows ──'), page.indexOf('// ── the calendar: end of what a day shows ──'));
const keyAt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clockOf = (s: number) => new Date(s * 1000).toISOString().slice(11, 16);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekdayLong = (k: string) => DAYS[new Date(`${k}T12:00:00Z`).getUTCDay()]!;
const weekdayShort = (k: string) => weekdayLong(k).slice(0, 3);
const listOf = (n: string[]) => (n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`);
const f = new Function('keyAt', 'clockOf', 'weekdayLong', 'weekdayShort', 'listOf', `${block}
return { calKey, calTitle, dayView, dayMarks, markList, marksWords, barEntries, pressedOn, clashLine, alsoHasLine, nowIndex, whenOf, rowWords, moneyWords, visitNeedsEveryone, nightHeld, dayShort, dayLong, CAL_HOUSEHOLD };`)(keyAt, clockOf, weekdayLong, weekdayShort, listOf) as any;

const H = (d: string, h = 0) => Date.parse(`${d}T${String(h).padStart(2, '0')}:00:00Z`) / 1000;
const D = '2026-11-14', NEXT = '2026-11-15';   // a Saturday, a Sunday
const timed = (summary: string, from: number, to: number, more = {}) => ({ summary, is_all_day: false, dtstart: H(D, from), dtend: H(D, to), calendar: 'mine', owner: 'alice', label: 'Mine', kind: 'other', ...more });
const allDay = (summary: string, first = D, after = NEXT, more = {}) => ({ summary, is_all_day: true, dtstart: H(first), dtend: H(after), calendar: 'household', owner: null, label: 'Household', kind: 'other', ...more });
const plan = (state: string, goal: string | null = null) => ({ id: 'gate', title: 'Fix the gate', state, owner: 'bob', goal, area: 'House' });
const due = (state: string, goal: string | null = null, more = {}) => allDay('Fix the gate', D, NEXT, { kind: 'due', plan: plan(state, goal), ...more });
const HELD = { held: { kind: 'stay', id: 's', request: 'r', name: 'Dana', headcount: 2 } };
const on = (events: any[], money: any[] = [], thread: any[] = []) => ({ events, money, thread, goals: [] });
const ALL = { pressed: null, goal: null, over: { plans: true, budget: true, record: true } };
const lens = (more: object) => ({ ...ALL, ...more });
const off = (k: string) => lens({ over: { ...ALL.over, [k]: false } });
const marks = (d: any, l: any = ALL, day = D) => f.dayMarks(day, d, l);
const hers = { calendar: 'partner', owner: 'casey', label: 'Casey' };

describe('the count', () => {
  test('a span counts on each day; a stay holds the nights before its last day', () =>
    assert.deepEqual(['2026-11-13', D, NEXT].map((d) => marks(on([allDay('x', '2026-11-13', NEXT, HELD)]), ALL, d).count), [1, 1, 0]));
  test('never money or the record', () => assert.equal(marks(on([], [{ day: D, kind: 'bill', short: false }], [{ day: D, entries: 3, by: [], waiting: 0 }])).count, 0));
  test('Plans off takes a date and a block; an appointment for a plan stays', () => {
    const d = on([due('doing'), timed('B', 9, 10, { kind: 'block', plan: plan('doing') }), timed('A', 11, 12, { kind: 'appointment', plan: plan('doing') })]);
    assert.deepEqual([marks(d).count, marks(d, off('plans')).count], [3, 1]);
  });
  test('a goal chip keeps only the plan rows that carry it, ignoring case', () =>
    assert.equal(marks(on([due('doing', 'New roof'), due('planning', 'Garden'), timed('Swim', 9, 10)]), lens({ goal: 'new roof' })).count, 2));
  test('a goal chip leaves an appointment for another goal showing', () => {
    const d = on([due('doing', 'New roof'), timed('Roofer visit', 9, 10, { kind: 'appointment', plan: plan('doing', 'Garden') })]);
    assert.deepEqual([f.dayView(D, d, lens({ goal: 'New roof' })).shown.length, f.dayView(D, d, lens({ goal: 'New roof' })).hidden.length], [2, 0]);
  });
});

describe('whose it is', () => {
  const members = ['alice', 'bob', 'casey'];
  const d = on([timed('Mine', 9, 10), timed('Hers', 11, 12, hers), timed('Club', 13, 14, { calendar: 'partner', owner: null, label: 'Club' }), due('doing', null, { calendar: 'partner', owner: 'bob' }), allDay('Bins'), allDay('Asked', D, NEXT, { proposed: 'o1' })]);
  test("a plan's date is Household wherever its event sits; a calendar that is no member's has no key", () =>
    assert.deepEqual(d.events.map((e: any) => f.calKey(e)), ['alice', 'casey', null, f.CAL_HOUSEHOLD, f.CAL_HOUSEHOLD, f.CAL_HOUSEHOLD]));
  test('the bar: members in order with a row, then Household', () =>
    assert.deepEqual(f.barEntries(d.events, [D], ALL, members).map((e: any) => [e.key, e.label, e.n]), [['alice', 'alice', 1], ['casey', 'casey', 1], [f.CAL_HOUSEHOLD, 'Household', 3]]));
  test('a count is the sum of its day counts', () => {
    const two = on([allDay('Trip', D, '2026-11-16', { calendar: 'partner', owner: 'bob', label: 'Bob' }), timed('Mine', 9, 10)]);
    const n = f.barEntries(two.events, [D, NEXT], ALL, members).find((e: any) => e.key === 'bob').n;
    assert.equal(n, marks(two, lens({ pressed: 'bob' })).count + marks(two, lens({ pressed: 'bob' }), NEXT).count);
  });
  test('under two entries there is no bar; a person with no entry falls back to Everyone', () => {
    assert.deepEqual(f.barEntries([timed('Mine', 9, 10)], [D], ALL, members), []);
    assert.equal(f.pressedOn('bob', [{ key: 'alice' }, { key: f.CAL_HOUSEHOLD }]), null);
    assert.equal(f.pressedOn('alice', [{ key: 'alice' }, { key: f.CAL_HOUSEHOLD }]), 'alice');
  });
});

describe('the marks', () => {
  test('the glyph: doing, else planning, else done', () => {
    assert.deepEqual([[due('done'), due('planning'), due('doing')], [due('done'), due('planning')], [due('done')]].map((e) => marks(on(e)).glyph), ['doing', 'planning', 'done']);
    assert.equal(marks(on([due('doing')]), off('plans')).glyph, null);
  });
  test('money: short, else unpaid, else paid; a pressed calendar does not move it', () => {
    const m = (...k: [string, boolean][]) => on([], k.map(([kind, short]) => ({ day: D, kind, short })));
    assert.deepEqual([m(['paid', false], ['bill', true]), m(['paid', false], ['due', false]), m(['paid', false])].map((d) => marks(d).money), ['short', 'due', 'paid']);
    assert.equal(marks(m(['due', false]), lens({ pressed: 'bob' })).money, 'due');
    assert.equal(marks(m(['due', false]), off('budget')).money, null);
    assert.equal(marks({ ...m(['due', false]), money: null }).money, null);
  });
  test('a filter never clears a real clash on a row it leaves showing', () => {
    const d = on([timed('A', 9, 11, { clash: true }), timed('B', 10, 12, { clash: true, ...hers })]);
    assert.deepEqual([marks(d, lens({ pressed: 'alice' })).clash, marks(d, lens({ pressed: 'bob' })).clash], [true, false]);
  });
  test('five marks on a phone leave the hatch out', () => {
    const m = { count: 2, glyph: 'doing', money: 'due', clash: true, held: true };
    assert.deepEqual(f.markList(m, 4), ['count', 'glyph', 'money', 'clash']);
    assert.equal(f.markList(m).length, 5);
  });
  test('the accessible name says the date and every mark', () => {
    const say = (m: object) => f.marksWords('Saturday 14 November', m);
    assert.equal(say({ count: 4, glyph: 'doing', money: 'due', clash: true, held: true }), 'Saturday 14 November, 4 things, a plan in progress, money, a clash, nights held');
    assert.equal(say({ count: 1, glyph: 'planning', money: 'short', clash: false, held: false }), 'Saturday 14 November, 1 thing, a plan in planning, money short');
    assert.equal(say({ count: 1, glyph: 'done', money: 'paid', clash: false, held: false }), 'Saturday 14 November, 1 thing, a plan done, bills paid');
    assert.equal(say({ count: 0, glyph: null, money: null, clash: false, held: false }), 'Saturday 14 November, nothing on');
  });
});

describe('the card', () => {
  test('rows in their order', () => {
    const v = f.dayView(D, on([timed('Late', 15, 16), timed('Early', 9, 10), allDay('B'), allDay('A'), due('doing')]), ALL);
    assert.deepEqual([v.due.length, v.allDay.map((e: any) => e.summary), v.timed.map((e: any) => e.summary)], [1, ['A', 'B'], ['Early', 'Late']]);
  });
  test("clash phrases: one per group with two showing, the second row's start", () => {
    const c = { clash: true };
    assert.equal(f.clashLine([timed('A', 9, 11, c), timed('B', 10, 12, c), timed('C', 15, 17, c), timed('D', 16, 17, c), timed('E', 16, 18, c)]), '2 at 10:00 · 3 at 16:00');
    assert.equal(f.clashLine([timed('A', 9, 11, c)]), '');
  });
  test('"also has": what the pressed calendar or goal hides, clashing rows first; an overlay off is not reported', () => {
    const d = on([timed('Mine', 9, 11, { clash: true }), allDay('Bins'), allDay('x', D, NEXT, HELD), timed('Her thing', 10, 11, { clash: true, ...hers })]);
    assert.equal(f.alsoHasLine(D, f.dayView(D, d, lens({ pressed: 'alice' }))), 'Saturday also has 3 other things: Her thing, Bins and Dana staying.');
    assert.equal(f.alsoHasLine(D, f.dayView(D, on([due('doing')]), off('plans'))), '');
    assert.equal(f.alsoHasLine(D, f.dayView(D, on(['A', 'B', 'C', 'D', 'E'].map((s) => allDay(s))), lens({ pressed: 'alice' }))), 'Saturday also has 5 other things: A, B, C and 2 more.');
    assert.equal(f.alsoHasLine(D, f.dayView(D, on([allDay('Bins')]), lens({ pressed: 'alice' }))), 'Saturday also has 1 other thing: Bins.');
  });
  test('the now line, and when across days', () => {
    const rows = [timed('A', 9, 10), timed('B', 15, 16)];
    assert.deepEqual([8, 12, 20].map((h) => f.nowIndex(rows, H(D, h))).concat(f.nowIndex([], H(D, 12))), [0, 1, 2, -1]);
    assert.deepEqual(f.whenOf(rows[0], D), { top: '09:00', under: '10:00', bold: true });
    assert.deepEqual(f.whenOf({ ...rows[0], dtstart: H('2026-11-11', 9), dtend: H('2026-11-20', 9) }, D), { top: 'from Wed', under: 'to Fri', bold: false });
  });
  test('words', () => {
    assert.deepEqual([f.calTitle(allDay('')), f.dayLong('2026-11-12'), f.dayShort('2026-11-16')], ['Busy', 'Thursday 12', 'Mon 16']);
    assert.equal(f.calTitle(allDay('Dana staying (2)', D, NEXT, HELD)), 'Dana staying');
    const kept = [allDay('x', D, NEXT, { held: { kind: 'block', id: 'b', by: 'bob' } })];
    assert.deepEqual([f.nightHeld(D, kept), f.nightHeld(NEXT, kept)], [true, false]);
    assert.equal(f.rowWords(timed('Swim', 9, 10, { clash: true }), D, 'alice'), '09:00 to 10:00, Swim, on your calendar, clashes with another event');
    assert.equal(f.rowWords(due('doing'), D, 'alice'), 'due, Fix the gate, on Household, Doing');
    assert.equal(f.moneyWords({ kind: 'autopay', label: 'Utilities', name: 'Example Power', about: '$146', short: false }), 'Auto Pay, Utilities, Example Power, about $146');
    assert.equal(f.moneyWords({ kind: 'short', billKind: 'bill', label: 'Utilities', name: 'Example Power', about: '$146', left: '$14', short: true }), 'Bill, Utilities, Example Power, about $146, $14 left');
    assert.equal(f.moneyWords({ kind: 'payby', label: 'Util', name: 'Example Power', short: false }), 'Pay By, Util, Example Power');
  });
  test('a deep link: a row a filter hides draws under Everyone; one no longer there opens the day', () => {
    const d = on([timed('Hers', 9, 10, { evt_id: 7, ...hers }), timed('Mine', 11, 12, { evt_id: 8 })]);
    assert.deepEqual(['7', '8'].map((k) => f.visitNeedsEveryone(D, k, d, lens({ pressed: 'alice' }))), [true, false]);
    assert.equal(f.visitNeedsEveryone(D, '9', d, ALL), 'absent');
    assert.equal(f.visitNeedsEveryone(D, 'gate', on([due('doing')]), off('plans')), true);
  });
});
