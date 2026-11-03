// api/test/setup.test.ts
//
// Today's setup notices, from states built by replay: no store, no NAS, no server.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { needsAdmin } from '../src/connectors-view.ts';
import type { ConnectorRow, RowId } from '../src/connectors-view.ts';
import { PAGE_RETRY_MS } from '../src/pages.ts';
import { replay } from '../src/replay.ts';
import { setupNotices } from '../src/setup.ts';
import { SYSTEM } from '../src/types.ts';
import type { Event, NewEventShape } from '../src/types.ts';

const NOW = '2026-11-02T09:00:00Z';

type Line = readonly [who: string, e: NewEventShape];

/** A state from these events, each by who wrote it. */
const stateOf = (...events: Line[]) =>
  replay(events.map(([who, e], i) => ({ id: `e${i + 1}`, at: NOW, who, ...e }) as unknown as Event));

/** A household claimed by alice, with bob a member. */
const CLAIMED: Line[] = [
  ['alice', { op: 'household.claim', label: 'Home' }],
  ['alice', { op: 'member.add', member: 'bob', why: 'my partner' }],
];

const NAMES: Record<RowId, string> = {
  claude: 'Claude', drive: 'Synology Drive', calendar: 'Calendar on phones', mail: 'Mail',
  booking: 'Booking', 'sign-in': 'Who may sign in', pricing: 'Pricing sources',
};
const rowName = (id: RowId): string => NAMES[id];

const base = {
  state: stateOf(...CLAIMED), who: 'alice', admin: false, sandbox: false, env: {},
  teamFolder: null, failures: [], adminRows: [], rowName,
};

const DOC = { link: 'f3c1', file_id: '881', hash: 'abc', version_id: '1', path: '/team-folders/Planner/h1/today/2026-11-02-household.md' };
const ANSWER = { link: 'a9e2', file_id: '882', hash: 'def', version_id: '1', path: '/team-folders/Planner/h1/answers/2026-11-02-food.md' };

describe("Today's setup notices", () => {
  test('no folder: the owner is asked to choose, the member to ask the owner', () => {
    const [o] = setupNotices({ ...base, who: 'alice' });
    assert.deepEqual(o, { kind: 'folder', text: 'Your documents are not in Drive yet',
      action: { label: 'Choose a folder', open: 'settings', step: 'folder' } });
    assert.deepEqual(setupNotices({ ...base, who: 'bob' }),
      [{ kind: 'folder', text: 'Documents are not in Drive yet. Ask alice to choose a folder.' }]);
  });

  test('a carried-over plain share is worded for what it is', () => {
    const state = stateOf(...CLAIMED, [SYSTEM, { op: 'documents.folder', team: 'Planner', folder: 'home', source: 'deployment' }]);
    assert.deepEqual(setupNotices({ ...base, state, teamFolder: false }), [{
      kind: 'not-team-folder',
      text: 'Your documents are not in Drive yet: Planner/home is not a Team Folder. Enable it in Synology Drive Admin Console, Team Folder, or choose another folder.',
      action: { label: 'Choose another folder', open: 'settings', step: 'folder' },
    }]);
    assert.deepEqual(setupNotices({ ...base, state, who: 'bob', teamFolder: false }).map((n) => n.text),
      ['Documents are not in Drive yet. Ask alice to choose a folder.']);
    // A Team Folder, or one this session has not asked about lately, says nothing.
    assert.deepEqual(setupNotices({ ...base, state, teamFolder: true }), []);
    assert.deepEqual(setupNotices({ ...base, state, teamFolder: null }), []);
  });

  test("an admin's card names the rows that need them; the owner's comes first; the sandbox sees none", () => {
    const n = setupNotices({ ...base, who: 'alice', admin: true, adminRows: ['mail', 'claude'], rowName });
    assert.deepEqual(n.map((x) => x.kind), ['folder', 'connectors']);
    assert.equal(n[1]!.text, 'Set up the NAS: Mail and Claude.');
    assert.deepEqual(n[1]!.action, { label: 'Open Connectors', open: 'connectors', row: 'mail' });
    assert.equal(setupNotices({ ...base, admin: true, adminRows: ['calendar', 'mail', 'pricing'] }).at(-1)!.text,
      'Set up the NAS: Calendar on phones, Mail and Pricing sources.');
    // Nobody but an admin is told, whatever the rows say.
    assert.deepEqual(setupNotices({ ...base, who: 'bob', adminRows: ['mail'] }).map((x) => x.kind), ['folder']);
    assert.deepEqual(setupNotices({ ...base, sandbox: true, admin: true, adminRows: ['mail'], rowName }), []);
  });

  test('a row left off on purpose is not on the card', () => {
    const row = (id: RowId, state: ConnectorRow['state'], source: ConnectorRow['source']): ConnectorRow =>
      ({ id, state, source, line: '', form: {} });
    assert.deepEqual(needsAdmin([row('mail', 'off', 'off'), row('claude', 'off', 'off'), row('pricing', 'off', 'off')]), []);
    const state = stateOf(...CLAIMED, ['alice', { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'owner' }]);
    assert.deepEqual(setupNotices({ ...base, state, admin: true, adminRows: needsAdmin([row('mail', 'off', 'off')]) }), []);
  });

  test('the move is said to everyone, and a failure with its name and when', () => {
    const state = stateOf(...CLAIMED,
      ['alice', { op: 'household.zone', zone: 'America/Denver' }],
      ['alice', { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'owner' }],
      ['claude', { op: 'thread.briefing', day: '2026-11-02', source: 'household', budget: null, headline: 'Today', doc: DOC, writtenBy: 'fallback' }],
      ['bob', { op: 'thread.ask', question: 'How is food?', budget: null }],
      ['claude', { op: 'thread.answer', replyTo: 'e6', text: 'Fine.', tools: [], model: 'm', doc: ANSWER }],
      ['alice', { op: 'documents.folder', team: 'Planner', folder: 'h2', source: 'owner' }],
    );
    for (const who of ['alice', 'bob']) {
      assert.deepEqual(setupNotices({ ...base, state, who }), [{ kind: 'moving', text: 'Moving 2 documents to Planner/h2' }], who);
    }
    // 14:20 in Denver, on November 2nd, is 21:20 UTC.
    const failures = [{ name: '2026-11-02-food.md', words: 'a file of that name is already there', at: Date.parse('2026-11-02T21:20:00Z') - PAGE_RETRY_MS }];
    assert.deepEqual(setupNotices({ ...base, state, who: 'bob', failures }), [{
      kind: 'moving',
      text: 'Moving 2 documents to Planner/h2. 1 could not be moved yet: 2026-11-02-food.md. Trying again at 14:20.',
    }]);
  });

  test('booking off for a lost calendar, to the owner, until a calendar is chosen', () => {
    const cal = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' };
    const lost: Line[] = [...CLAIMED,
      ['alice', { op: 'documents.folder', team: 'Planner', folder: 'h1', source: 'owner' }],
      ['alice', { op: 'calendar.household', ...cal }],
      ['alice', { op: 'guests.booking', on: true }],
      ['alice', { op: 'guest.allow', email: 'guests@example.com', name: 'Nguyen family', why: 'old friends' }],
      ['guest:guests@example.com', {
        op: 'proposal.offer', tool: 'approve_booking',
        args: { email: 'guests@example.com', name: 'Nguyen family', arrive: '2026-12-12', depart: '2026-12-15', headcount: 3, note: 'hi' },
        summary: 'Nguyen family would like to come', effects: [], events: [], budget: null, month: null, envelopes: [],
        fingerprint: '', prompt: { kind: 'booking', ref: null },
      } as NewEventShape],
      [SYSTEM, { op: 'guests.booking', on: false, calendarGone: true }],
    ];
    const state = stateOf(...lost);
    assert.deepEqual(setupNotices({ ...base, state }), [{
      kind: 'booking-off',
      text: 'Booking is off: the household calendar is gone. Choose one, then turn booking on again, and 1 request waiting still stands.',
      action: { label: 'Choose a calendar', open: 'settings', step: 'calendar' },
    }]);
    assert.deepEqual(setupNotices({ ...base, state, who: 'bob' }), [], 'the owner only');
    // Two waiting: the verb agrees.
    const second = stateOf(...lost.slice(0, -1), ['guest:guests@example.com', {
      op: 'proposal.offer', tool: 'approve_booking',
      args: { email: 'guests@example.com', name: 'Nguyen family', arrive: '2027-01-02', depart: '2027-01-05', headcount: 3, note: 'again' },
      summary: 'Nguyen family would like to come again', effects: [], events: [], budget: null, month: null, envelopes: [],
      fingerprint: '', prompt: { kind: 'booking', ref: null },
    } as NewEventShape], lost.at(-1)!);
    assert.equal(setupNotices({ ...base, state: second })[0]!.text,
      'Booking is off: the household calendar is gone. Choose one, then turn booking on again, and 2 requests waiting still stand.');
    // Nothing ahead: the sentence ends at the calendar.
    const quiet = stateOf(...lost.filter(([who]) => !who.startsWith('guest:')));
    assert.equal(setupNotices({ ...base, state: quiet })[0]!.text,
      'Booking is off: the household calendar is gone. Choose one, then turn booking on again.');
    const chosen = stateOf(...lost,
      ['alice', { op: 'calendar.household', cal_id: '/alice/new/', original_cal_id: '/alice/new/', name: 'Household', replaces: cal.cal_id }]);
    assert.deepEqual(setupNotices({ ...base, state: chosen }), [], 'gone once a calendar is chosen');
  });
});
