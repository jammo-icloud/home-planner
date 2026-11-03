// api/test/settings.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { replay, ReplayError } from '../src/replay.ts';
import { parseBackup, scopeOf } from '../src/restore.ts';
import { thread } from '../src/thread.ts';
import { ProposalStore, describe as describeEvent } from '../src/tools.ts';
import type { ToolContext } from '../src/tools.ts';
import { DEFAULT_AREAS, sameCalendar } from '../src/types.ts';
import type { Event } from '../src/types.ts';
import { ToolError } from '../src/errors.ts';
import { NeedsDsm } from '../src/synology.ts';
import { currentPublicUrl, dsmPublicUrl, ensureHouseholdCalendar, replaceHouseholdCalendar, reshareHousehold, targetCalendar } from '../src/settings.ts';
import { resetConnectors } from '../src/connectors.ts';
import { fakeDsm } from './fake-dsm-fetch.ts';

const NOW = '2026-10-29T09:00:00Z';
const TODAY = '2026-10-29';

async function fresh(): Promise<Store> {
  const path = join(await mkdtemp(join(tmpdir(), 'pb-settings-')), 'events.jsonl');
  const s = new Store({ path, now: () => new Date(NOW) });
  await s.load();
  return s;
}

const ctxOf = (store: Store, who = 'alice', sid: string | null = 'S'): ToolContext =>
  ({ store, who, today: TODAY, proposals: new ProposalStore(), sid });

const ev = (who: string, e: Record<string, unknown>, id = `e${Math.random()}`): Event =>
  ({ id, at: NOW, who, ...e }) as unknown as Event;

/** One reply that serves both Cal.create and Sharing.set: set ignores its data. */
const created = () => fakeDsm({ success: true, data: {
  cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', cal_displayname: 'Household',
  cal_color: '#3F6F8C', cal_privilege: 'RW', cal_type: 'event', default_calendar: false,
} });

const body = (c: { body: string }) => decodeURIComponent(c.body);
const isSet = (c: { body: string }) => /api=SYNO\.Cal\.Sharing/.test(body(c)) && /method=set/.test(body(c));
const isCreate = (c: { body: string }) => /api=SYNO\.Cal\.Cal&/.test(body(c) + '&') && /method=create/.test(body(c));

test('areas default to four and are replaced whole', async () => {
  assert.deepEqual(replay([]).settings.areas, DEFAULT_AREAS);
  assert.deepEqual(DEFAULT_AREAS, ['House', 'Money', 'People', 'Trips']);
  const s = await fresh();
  await s.append('alice', { op: 'areas.set', areas: ['House', 'Garden'] });
  assert.deepEqual(s.state.settings.areas, ['House', 'Garden']);
});

test('an empty areas list is refused', async () => {
  const s = await fresh();
  await assert.rejects(() => s.append('alice', { op: 'areas.set', areas: [] }),
    (e: unknown) => e instanceof ReplayError && /at least one/.test(e.message));
  assert.deepEqual(s.state.settings.areas, DEFAULT_AREAS, 'nothing changed');
});

/** A write the log must refuse as a ReplayError (never a TypeError), leaving nothing behind. */
async function refused(s: Store, op: Record<string, unknown>, message: RegExp): Promise<void> {
  const before = await s.since(null);
  await assert.rejects(() => s.append('alice', op as never),
    (e: unknown) => e instanceof ReplayError && message.test(e.message), JSON.stringify(op));
  assert.equal((await s.since(null)).length, before.length, 'nothing was written');
}

test('the log refuses areas that are not a list of distinct, trimmed names', async () => {
  const s = await fresh();
  await refused(s, { op: 'areas.set', areas: 'House' }, /areas must be a list/);
  await refused(s, { op: 'areas.set' }, /areas must be a list/);
  await refused(s, { op: 'areas.set', areas: ['House', ''] }, /every area needs a name/);
  await refused(s, { op: 'areas.set', areas: ['House', 7] }, /every area needs a name/);
  await refused(s, { op: 'areas.set', areas: [' House'] }, /every area needs a name/);
  await refused(s, { op: 'areas.set', areas: ['House', 'house'] }, /two areas have the same name/);
  assert.deepEqual(s.state.settings.areas, DEFAULT_AREAS);
});

/** A household with alice in it, so plans can be made in its areas. */
async function claimed(): Promise<Store> {
  const s = await fresh();
  await s.append('alice', { op: 'household.claim', label: 'Home' });
  return s;
}

test('renaming an area moves its live plans with it, in one step', async () => {
  const s = await claimed();
  await s.append('alice', [
    { op: 'plan.create', plan: 'coast', title: 'The coast', area: 'Trips' },
    { op: 'plan.create', plan: 'tent', title: 'Buy a tent', area: 'Trips', parent: 'coast' },
    { op: 'plan.create', plan: 'old', title: 'Old trip', area: 'Trips' },
    { op: 'plan.remove', plan: 'old', why: 'went already' },
    { op: 'plan.create', plan: 'gate', title: 'Fix the gate', area: 'House' },
  ]);
  await s.append('alice', { op: 'areas.rename', from: 'Trips', to: 'Travel' });
  assert.deepEqual(s.state.settings.areas, ['House', 'Money', 'People', 'Travel'], 'renamed where it stood');
  assert.equal(s.state.plans.get('coast')!.area, 'Travel');
  assert.equal(s.state.plans.get('tent')!.area, 'Travel', 'a shelf\'s items move with it');
  assert.equal(s.state.plans.get('gate')!.area, 'House');
  assert.equal(s.state.plans.get('old')!.area, 'Trips', 'a removed plan is history, and keeps its area');
  assert.deepEqual(replay(await s.since(null)).plans.get('tent'), s.state.plans.get('tent'), 'a replay agrees');
  // The old name is free again, and a plan can no longer be made in it.
  await assert.rejects(() => s.append('alice', { op: 'plan.create', plan: 'x', title: 'X', area: 'Trips' }),
    (e: unknown) => e instanceof ReplayError && /not one of this household's areas/.test(e.message));
});

test('a rename to a name already used, or from one that is not there, is refused', async () => {
  const s = await claimed();
  await refused(s, { op: 'areas.rename', from: 'Trips', to: 'House' }, /already an area/);
  await refused(s, { op: 'areas.rename', from: 'Trips', to: 'house' }, /already an area/);
  await refused(s, { op: 'areas.rename', from: 'Garden', to: 'Yard' }, /no area called Garden/);
  await refused(s, { op: 'areas.rename', from: 'Trips', to: 'Trips' }, /already its name/);
  await refused(s, { op: 'areas.rename', from: 'Trips', to: '' }, /needs a name/);
  await refused(s, { op: 'areas.rename', from: 'Trips', to: ' Travel' }, /needs a name/);
  await refused(s, { op: 'areas.rename', from: 'Trips' }, /needs a name/);
  await refused(s, { op: 'areas.rename', from: 7, to: 'Travel' }, /needs a name/);
  assert.deepEqual(s.state.settings.areas, DEFAULT_AREAS);
  // A change of case alone is a rename like any other.
  await s.append('alice', { op: 'areas.rename', from: 'Trips', to: 'TRIPS' });
  assert.deepEqual(s.state.settings.areas, ['House', 'Money', 'People', 'TRIPS']);
});

test('a rename restores with the settings, and reads as one in the thread', async () => {
  const s = await claimed();
  const [e] = await s.append('alice', { op: 'areas.rename', from: 'Trips', to: 'Travel' });
  assert.equal(scopeOf(e!), 'settings');
  assert.equal(describeEvent(e!, s.state).what, 'renamed the area Trips to Travel');
  const { entries } = await thread(s, { who: 'alice', budget: null });
  assert.ok(entries.some((x) => x.kind === 'change' && x.what === 'renamed the area Trips to Travel'));
});

test('the log refuses links that are not labelled web addresses', async () => {
  const s = await fresh();
  await refused(s, { op: 'links.set', links: { label: 'Bank', url: 'https://bank.example' } }, /links must be a list/);
  await refused(s, { op: 'links.set', links: [null] }, /every link needs a label/);
  await refused(s, { op: 'links.set', links: [{ label: ' ', url: 'https://bank.example' }] }, /every link needs a label/);
  await refused(s, { op: 'links.set', links: [{ label: 'Oops', url: 'javascript:alert(1)' }] }, /a link must be http or https/);
  await refused(s, { op: 'links.set', links: [{ label: 'Oops', url: 'not a url' }] }, /a link must be http or https/);
  await refused(s, { op: 'links.set', links: [{ label: 'Oops' }] }, /a link must be http or https/);
  assert.deepEqual(s.state.settings.links, []);
});

test('the log refuses a calendar without both of its ids', async () => {
  const s = await fresh();
  const ids = /cal_id and original_cal_id/;
  await refused(s, { op: 'calendar.household', cal_id: '/alice/hh/', name: 'Household' }, ids);
  await refused(s, { op: 'calendar.household', cal_id: '', original_cal_id: '/alice/hh/', name: 'Household' }, ids);
  await refused(s, { op: 'calendar.target', cal_id: '/alice/hh/', original_cal_id: '' }, ids);
  await refused(s, { op: 'calendar.target', original_cal_id: '/alice/hh/' }, ids);
  await refused(s, { op: 'calendar.conflicts', calendars: 'all' }, /calendars must be a list/);
  await refused(s, { op: 'calendar.conflicts', calendars: [{ cal_id: '/alice/home/', label: 'Home' }] }, ids);
  await refused(s, { op: 'calendar.conflicts', calendars: [null] }, ids);
  await refused(s, { op: 'calendar.household.rename', name: 'Ours' }, /no Household calendar to rename/);
  assert.equal(s.state.calendar.household, null);
  assert.equal(s.state.calendar.target, null);
  assert.equal(s.state.calendar.conflicts.size, 0);
});

test('a restored backup skips malformed settings lines, naming why, rather than failing', () => {
  const line = (n: number, e: Record<string, unknown>) => JSON.stringify({ id: `b${n}`, at: NOW, who: 'alice', ...e });
  const backup = parseBackup([
    line(1, { op: 'areas.set', areas: ['House'] }),
    line(2, { op: 'links.set', links: [{ label: 'x', url: 'javascript:alert(1)' }] }),
    line(3, { op: 'areas.set', areas: 'House' }),
    line(4, { op: 'calendar.target', cal_id: '/a/' }),
  ].join('\n'));
  assert.deepEqual(backup.events.map((e) => e.id), ['b1']);
  assert.equal(backup.skipped.length, 3);
  assert.match(backup.skipped[0]!, /line 2: a link must be http or https/);
  assert.match(backup.skipped[1]!, /line 3: areas must be a list/);
  assert.match(backup.skipped[2]!, /line 4: .*cal_id and original_cal_id/);
});

test('the Household calendar keeps its ids and maker when it is renamed', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
  await refused(s, { op: 'calendar.household.rename', name: ' ' }, /needs a name/);
  await refused(s, { op: 'calendar.household.rename', name: ' Ours' }, /needs a name/);
  await refused(s, { op: 'calendar.household.rename' }, /needs a name/);
  await s.append('bob', { op: 'calendar.household.rename', name: 'Ours' });
  assert.deepEqual(s.state.calendar.household,
    { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Ours', by: 'alice' });
});

test('links are replaced whole', async () => {
  const s = await fresh();
  assert.deepEqual(s.state.settings.links, []);
  await s.append('alice', { op: 'links.set', links: [{ label: 'Bank', url: 'https://bank.example' }] });
  await s.append('bob', { op: 'links.set', links: [{ label: 'Power', url: 'https://power.example' }] });
  assert.deepEqual(s.state.settings.links, [{ label: 'Power', url: 'https://power.example' }]);
});

test('conflict calendars are per member', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'calendar.conflicts', calendars: [
    { cal_id: '/alice/home/', original_cal_id: '/alice/home/', label: 'Home' },
    { cal_id: '/alice/work/', original_cal_id: '/alice/work/', label: 'Work' },
  ] });
  await s.append('bob', { op: 'calendar.conflicts', calendars: [
    { cal_id: '/bob/home/', original_cal_id: '/bob/home/', label: 'Home' },
  ] });
  assert.equal(s.state.calendar.conflicts.get('alice')!.length, 2);
  assert.equal(s.state.calendar.conflicts.get('bob')!.length, 1);
  assert.equal(s.state.calendar.conflicts.get('carol'), undefined);
  // Survives the incremental path as well as a whole replay.
  await s.append('alice', { op: 'areas.set', areas: ['House'] });
  assert.equal(s.state.calendar.conflicts.get('alice')!.length, 2);
});

test('a second Household calendar is refused', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
  await assert.rejects(
    () => s.append('bob', { op: 'calendar.household', cal_id: '/bob/hh/', original_cal_id: '/bob/hh/', name: 'Household' }),
    (e: unknown) => e instanceof ReplayError && /the household calendar is already set/.test(e.message));
  assert.equal(s.state.calendar.household!.cal_id, '/alice/hh/');
});

test('a Household calendar that is gone is replaced only by naming the one it replaces', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
  await s.append('alice', { op: 'calendar.target', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' });
  const second = { op: 'calendar.household', cal_id: '/bob/hh/', original_cal_id: '/bob/hh/', name: 'Home' };
  await refused(s, second, /the household calendar is already set/);
  await refused(s, { ...second, replaces: '/somewhere/else/' }, /the household calendar is already set/);
  await refused(s, { ...second, replaces: '' }, /replaces/);

  await s.append('bob', { ...second, replaces: '/alice/hh/' } as never);
  assert.deepEqual(s.state.calendar.household,
    { cal_id: '/bob/hh/', original_cal_id: '/bob/hh/', name: 'Home', by: 'bob' });
  assert.equal(s.state.calendar.target, null, 'plans that went on the old one go on the new one');
  assert.deepEqual(targetCalendar(s.state), { cal_id: '/bob/hh/', original_cal_id: '/bob/hh/' });
  // The same from a whole replay as from the incremental path.
  assert.deepEqual(replay(await s.since(null)).calendar.household, s.state.calendar.household);
  await refused(s, { ...second, cal_id: '/carol/hh/', original_cal_id: '/carol/hh/', replaces: '/alice/hh/' },
    /the household calendar is already set/);
});

test('replacing the Household calendar leaves a calendar someone chose for plans alone', async () => {
  const s = await fresh();
  await s.append('alice', HH);
  await s.append('alice', { op: 'calendar.target', cal_id: '/alice/plans/', original_cal_id: '/alice/plans/' });
  await s.append('bob', { op: 'calendar.household', cal_id: '/bob/hh/', original_cal_id: '/bob/hh/', name: 'Household', replaces: '/alice/hh/' });
  assert.deepEqual(s.state.calendar.target, { cal_id: '/alice/plans/', original_cal_id: '/alice/plans/' });
});

test('there is nothing to replace before the first Household calendar', async () => {
  const s = await fresh();
  await refused(s, { op: 'calendar.household', cal_id: '/bob/hh/', original_cal_id: '/bob/hh/', name: 'Household', replaces: '/alice/hh/' },
    /no household calendar to replace/);
});

test('a replacement reads as one in the activity', () => {
  const what = (e: Record<string, unknown>) => describeEvent(ev('bob', e)).what;
  assert.equal(what({ ...HH }), 'set up the Household calendar');
  assert.equal(what({ ...HH, replaces: '/old/' }), 'replaced the Household calendar');
});

test('replaceHouseholdCalendar makes a new one as whoever asks, records what it replaces, and shares it', async () => {
  const s = await fresh();
  await s.append('alice', HH);
  const d = fakeDsm({ success: true, data: {
    cal_id: '/bob/hh2/', original_cal_id: '/bob/hh2/', cal_displayname: 'Household',
    cal_color: '#3F6F8C', cal_privilege: 'RW', cal_type: 'event', default_calendar: false,
  } });
  const ref = await replaceHouseholdCalendar(ctxOf(s, 'bob'), ['alice', 'bob', 'carol'], d.fn);
  assert.deepEqual(ref, { cal_id: '/bob/hh2/', original_cal_id: '/bob/hh2/' });
  assert.equal(d.calls.filter(isCreate).length, 1);
  const share = body(d.calls.find(isSet)!);
  assert.match(share, /"ug_name":"alice","cal_privilege":"RW"/);
  assert.match(share, /"ug_name":"carol","cal_privilege":"RW"/);
  assert.doesNotMatch(share, /"ug_name":"bob"/);
  assert.equal(s.state.calendar.household!.by, 'bob');
  const last = (await s.since(null)).at(-1) as Event & { replaces?: string };
  assert.equal(last.op, 'calendar.household');
  assert.equal(last.replaces, '/alice/hh/');

  // With nothing to replace, it is just the first one.
  const empty = await fresh();
  await empty.append('alice', { op: 'household.claim', label: 'Home' });
  const first = created();
  await replaceHouseholdCalendar(ctxOf(empty), ['alice'], first.fn);
  assert.equal(empty.state.calendar.household!.cal_id, '/alice/hh/');
  assert.equal(((await empty.since(null))[0] as Event & { replaces?: string }).replaces, undefined);
});

test('ensureHouseholdCalendar creates once, shares with everyone but the creator, and records it', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'household.claim', label: 'Home' });
  const d = created();
  const ref = await ensureHouseholdCalendar(ctxOf(s), ['alice', 'bob'], d.fn);
  assert.equal(d.calls.length, 2);
  assert.equal(d.calls.filter(isCreate).length, 1);
  assert.match(body(d.calls.find(isCreate)!), /cal_displayname=Household/);
  assert.match(body(d.calls.find(isCreate)!), /cal_color=#3F6F8C/);
  assert.equal(s.state.calendar.household!.cal_id, '/alice/hh/');
  assert.equal(s.state.calendar.household!.name, 'Household');
  const share = body(d.calls.find(isSet)!);
  assert.match(share, /"ug_name":"bob","cal_privilege":"RW"/);
  assert.doesNotMatch(share, /"ug_name":"alice"/);
  assert.deepEqual(ref, { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' });

  const d2 = created();
  const again = await ensureHouseholdCalendar(ctxOf(s), ['alice', 'bob'], d2.fn);
  assert.equal(d2.calls.length, 0);
  assert.deepEqual(again, ref);
});

test("a member does not make the Household calendar by using it: that is the owner's choice", async () => {
  const s = await fresh();
  await s.append('alice', { op: 'household.claim', label: 'Home' });
  await s.append('alice', { op: 'member.add', member: 'bob', why: 'my partner' });
  const d = created();
  await assert.rejects(ensureHouseholdCalendar(ctxOf(s, 'bob'), ['alice', 'bob'], d.fn),
    (e: unknown) => e instanceof ToolError && e.status === 403 && e.message === "only alice can choose the household's calendar");
  assert.equal(d.calls.length, 0, 'the NAS was not asked');
  assert.equal(s.state.calendar.household, null);
  await ensureHouseholdCalendar(ctxOf(s, 'alice'), ['alice', 'bob'], d.fn);
  assert.equal(s.state.calendar.household!.by, 'alice');
});

test('two members opening the app at once create one calendar', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'household.claim', label: 'Home' });
  const d = created();
  const [a, b] = await Promise.all([
    ensureHouseholdCalendar(ctxOf(s, 'alice'), ['alice', 'bob'], d.fn),
    ensureHouseholdCalendar(ctxOf(s, 'bob'), ['alice', 'bob'], d.fn),
  ]);
  assert.equal(d.calls.filter(isCreate).length, 1);
  assert.deepEqual(a, b);
  assert.equal((await s.since(null)).filter((e) => e.op === 'calendar.household').length, 1);
});

test('a new member is added to the share when the calendar already exists', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
  // One reply serves both Sharing.get and Sharing.set: bob is already shared.
  const d = fakeDsm({ success: true, data: { cal_share_setting: {
    DSM_USER: [{ ug_name: 'bob', cal_privilege: 'RW' }], DSM_GROUP: [] } } });
  // Opened by alice, who made it: only the owner can change who it is shared with.
  const ref = await ensureHouseholdCalendar(ctxOf(s, 'alice'), ['alice', 'bob', 'carol'], d.fn);
  const sets = d.calls.filter(isSet);
  assert.equal(sets.length, 1);
  const share = body(sets[0]!);
  assert.match(share, /"ug_name":"bob"/);
  assert.match(share, /"ug_name":"carol","cal_privilege":"RW"/);
  assert.doesNotMatch(share, /"ug_name":"alice"/);
  assert.deepEqual(ref, { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' });
});

test('a member who did not make it gets the calendar and leaves its sharing alone', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
  const d = fakeDsm({ success: true, data: { cal_share_setting: { DSM_USER: [], DSM_GROUP: [] } } });
  const ref = await ensureHouseholdCalendar(ctxOf(s, 'bob'), ['alice', 'bob', 'carol'], d.fn);
  assert.equal(d.calls.length, 0);
  assert.deepEqual(ref, { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' });
});

test('the Household calendar remembers who made it', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
  assert.equal(s.state.calendar.household!.by, 'alice');
});

const HH = { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' } as const;
const sharing = (users: { ug_name: string; cal_privilege: 'RO' | 'RW' }[], groups: unknown[] = []) =>
  fakeDsm({ success: true, data: { cal_share_setting: { DSM_USER: users, DSM_GROUP: groups } } });

test('re-sharing hands the calendar\'s group shares back unchanged', async () => {
  const s = await fresh();
  await s.append('alice', HH);
  const d = sharing([], [{ ug_name: 'family', cal_privilege: 'RO' }]);
  await ensureHouseholdCalendar(ctxOf(s), ['alice', 'bob'], d.fn);
  const sets = d.calls.filter(isSet);
  assert.equal(sets.length, 1);
  assert.match(body(sets[0]!), /"ug_name":"bob","cal_privilege":"RW"/);
  assert.match(body(sets[0]!), /"DSM_GROUP":\[\{"ug_name":"family","cal_privilege":"RO"\}\]/);
});

test('a member is matched with DSM\'s spelling of their name whatever its case', async () => {
  const s = await fresh();
  await s.append('alice', HH);
  const d = sharing([{ ug_name: 'Bob', cal_privilege: 'RW' }]);
  await ensureHouseholdCalendar(ctxOf(s), ['alice', 'bob'], d.fn);
  assert.equal(d.calls.filter(isSet).length, 0);
});

test('after a member is removed, re-sharing drops them and keeps everyone else as they were', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'household.claim', label: 'Home' });
  await s.append('alice', { op: 'member.add', member: 'bob', why: 'lives here' });
  await s.append('alice', { op: 'member.add', member: 'carol', why: 'lives here' });
  await s.append('alice', HH);
  const shared = [{ ug_name: 'bob', cal_privilege: 'RO' as const }, { ug_name: 'carol', cal_privilege: 'RW' as const }];
  const first = sharing(shared);
  await ensureHouseholdCalendar(ctxOf(s), [...s.state.members], first.fn);
  assert.equal(first.calls.filter(isSet).length, 0, 'everyone already has it');

  await s.append('alice', { op: 'member.remove', member: 'carol', why: 'moved out' });
  const d = sharing(shared, [{ ug_name: 'family', cal_privilege: 'RO' }]);
  await reshareHousehold(ctxOf(s), d.fn);
  const sets = d.calls.filter(isSet);
  assert.equal(sets.length, 1);
  assert.match(body(sets[0]!), /"DSM_USER":\[\{"ug_name":"bob","cal_privilege":"RO"\}\]/, 'exactly bob, at his privilege');
  assert.match(body(sets[0]!), /"DSM_GROUP":\[\{"ug_name":"family"/);

  // Someone the log never counted is dropped the same way.
  await s.append('alice', { op: 'member.add', member: 'dan', why: 'lodger' });
  const again = sharing([{ ug_name: 'bob', cal_privilege: 'RO' }, { ug_name: 'mallory', cal_privilege: 'RW' }]);
  await reshareHousehold(ctxOf(s), again.fn);
  const set = body(again.calls.find(isSet)!);
  assert.match(set, /"ug_name":"dan","cal_privilege":"RW"/);
  assert.doesNotMatch(set, /mallory/);
});

test('only the calendar\'s maker re-shares after a membership change, and a refusal is swallowed', async () => {
  const none = await fresh();
  const d0 = sharing([]);
  await reshareHousehold(ctxOf(none), d0.fn);
  assert.equal(d0.calls.length, 0, 'no Household calendar, nothing to share');

  const s = await fresh();
  await s.append('alice', { op: 'household.claim', label: 'Home' });
  await s.append('alice', { op: 'member.add', member: 'bob', why: 'lives here' });
  await s.append('bob', { op: 'calendar.household', cal_id: '/bob/hh/', original_cal_id: '/bob/hh/', name: 'Household' });
  const d = sharing([]);
  await reshareHousehold(ctxOf(s, 'alice'), d.fn);
  assert.equal(d.calls.length, 0, 'alice did not make it, so DSM would refuse her');
  await reshareHousehold(ctxOf(s, 'bob', null), d.fn);
  assert.equal(d.calls.length, 0, 'no DSM session');
  const refusing = fakeDsm({ success: false, error: { code: 9009 } });
  await reshareHousehold(ctxOf(s, 'bob'), refusing.fn);
  assert.equal(refusing.calls.length, 1, 'tried, failed, and said nothing');
});

test('a calendar is the same one when either of its ids matches', () => {
  const owner = { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' };
  assert.equal(sameCalendar(owner, { cal_id: '/bob/shared-1/', original_cal_id: '/alice/hh/' }), true);
  assert.equal(sameCalendar(owner, { cal_id: '/alice/hh/', original_cal_id: '/other/' }), true);
  assert.equal(sameCalendar(owner, { cal_id: '/bob/home/', original_cal_id: '/bob/home/' }), false);
});

test('nothing is shared when everyone already has it', async () => {
  const s = await fresh();
  await s.append('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' });
  const d = fakeDsm({ success: true, data: { cal_share_setting: {
    DSM_USER: [{ ug_name: 'bob', cal_privilege: 'RW' }], DSM_GROUP: [] } } });
  await ensureHouseholdCalendar(ctxOf(s), ['alice', 'bob'], d.fn);
  assert.equal(d.calls.filter(isSet).length, 0);
});

test('without a DSM session nothing is created', async () => {
  const s = await fresh();
  const d = created();
  await assert.rejects(() => ensureHouseholdCalendar(ctxOf(s, 'alice', null), ['alice', 'bob'], d.fn), NeedsDsm);
  assert.equal(d.calls.length, 0);
  assert.equal(s.state.calendar.household, null);
});

test('targetCalendar is the chosen one, else the Household one, else null', () => {
  assert.equal(targetCalendar(replay([])), null);
  const household = ev('alice', { op: 'calendar.household', cal_id: '/alice/hh/', original_cal_id: '/alice/hh/', name: 'Household' }, 'e1');
  assert.deepEqual(targetCalendar(replay([household])), { cal_id: '/alice/hh/', original_cal_id: '/alice/hh/' });
  const chosen = ev('bob', { op: 'calendar.target', cal_id: '/bob/plans/', original_cal_id: '/bob/plans/' }, 'e2');
  assert.deepEqual(targetCalendar(replay([household, chosen])), { cal_id: '/bob/plans/', original_cal_id: '/bob/plans/' });
});

test('appearance is per member and defaults to nothing', async () => {
  const s = await fresh();
  assert.equal(replay([]).settings.appearance.get('alice'), undefined);
  await s.append('alice', { op: 'scheme.set', scheme: 'lapis', mode: 'dark' });
  await s.append('bob', { op: 'scheme.set', scheme: 'graphite', mode: 'match' });
  assert.equal(s.state.settings.appearance.size, 2);
  assert.deepEqual(s.state.settings.appearance.get('alice'), { scheme: 'lapis', mode: 'dark' });
  assert.deepEqual(s.state.settings.appearance.get('bob'), { scheme: 'graphite', mode: 'match' });
  await assert.rejects(() => s.append('alice', { op: 'scheme.set', scheme: 'ruby', mode: 'dark' } as never), ReplayError);
  await assert.rejects(() => s.append('alice', { op: 'scheme.set', scheme: 'lapis', mode: 'dim' } as never), ReplayError);
  assert.deepEqual(s.state.settings.appearance.get('alice'), { scheme: 'lapis', mode: 'dark' });
});

test('a scheme reads with its name and how it follows the device', () => {
  const line = (scheme: string, mode: string) =>
    describeEvent(ev('alice', { op: 'scheme.set', scheme, mode })).what;
  assert.equal(line('lapis', 'dark'), 'chose the Lapis scheme, dark');
  assert.equal(line('quartz', 'light'), 'chose the Quartz scheme, light');
  assert.equal(line('graphite', 'match'), 'chose the Graphite scheme, matching the device');
});

test('DSM_PUBLIC_URL is DSM\'s public origin, or nothing', () => {
  assert.equal(dsmPublicUrl(undefined), null);
  assert.equal(dsmPublicUrl(''), null);
  assert.equal(dsmPublicUrl('   '), null);
  assert.equal(dsmPublicUrl('https://nas.example.com:5001'), 'https://nas.example.com:5001');
  // Only the origin: a slash, a path or a query would make a link of it that DSM does not answer.
  assert.equal(dsmPublicUrl(' https://nas.example.com:5001/ '), 'https://nas.example.com:5001');
  assert.equal(dsmPublicUrl('https://nas.example.com/some/path?x=1'), 'https://nas.example.com');
  assert.equal(dsmPublicUrl('http://nas.local:5000'), 'http://nas.local:5000');
  // A guess is not an address: no scheme, another scheme, or a login in the URL is unset.
  assert.equal(dsmPublicUrl('nas.example.com'), null);
  assert.equal(dsmPublicUrl('ftp://nas.example.com'), null);
  assert.equal(dsmPublicUrl('javascript:alert(1)'), null);
  assert.equal(dsmPublicUrl('https://me:secret@nas.example.com'), null);
});

test('the public address is read when asked, not when loaded', async () => {
  resetConnectors();
  process.env['DSM_PUBLIC_URL'] = 'https://a.example.com';
  assert.equal(currentPublicUrl(), 'https://a.example.com');
  process.env['DSM_PUBLIC_URL'] = 'https://b.example.com/path';
  assert.equal(currentPublicUrl(), 'https://b.example.com');
  delete process.env['DSM_PUBLIC_URL'];
});
