// api/test/synology.test.ts
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dsm, requireSid, SessionLost, SynologyError, NotDsm, NeedsDsm, NotAllowed, SESSION_LOST_CODES,
  listCalendars, createCalendar, renameCalendar, shareCalendar, sharingOf,
  createEvent, setEvent, getEvent, listEvents, deleteEvent, EtagMismatch,
  listAddressbooks, listContacts, getContact, createContact, searchContacts,
  createFolder, uploadFile, downloadFile, listFolder,
} from '../src/synology.ts';
import { connectors, forgetProbe, loadConnectors, recordProbe, resetConnectors } from '../src/connectors.ts';
import { fakeDsm, fakeDsmSeq } from './fake-dsm-fetch.ts';

describe('calling Synology', () => {
  test('posts a form with the sid, and returns data', async () => {
    const d = fakeDsm({ success: true, data: { hello: 1 } });
    const out = await dsm<{ hello: number }>({ api: 'SYNO.Cal.Cal', version: 5, method: 'list', sid: 'S' }, d.fn);
    assert.deepEqual(out, { hello: 1 });
    assert.match(d.calls[0]!.url, /\/webapi\/entry\.cgi$/);
    assert.match(d.calls[0]!.body, /api=SYNO\.Cal\.Cal/);
    assert.match(d.calls[0]!.body, /version=5/);
    assert.match(d.calls[0]!.body, /_sid=S/);
    assert.doesNotMatch(d.calls[0]!.url, /_sid/, 'the sid is never in the URL');
  });
  test('object params are sent as JSON', async () => {
    const d = fakeDsm({ success: true, data: {} });
    await dsm({ api: 'SYNO.Cal.Sharing', version: 1, method: 'set', sid: 'S',
      params: { cal_share_setting: { DSM_USER: [{ ug_name: 'bob', cal_privilege: 'RW' }] } } }, d.fn);
    assert.match(decodeURIComponent(d.calls[0]!.body), /cal_share_setting=\{"DSM_USER"/);
  });
  test('success:false is an error with the code, even at HTTP 200', async () => {
    const d = fakeDsm({ success: false, error: { code: 9007 } });
    await assert.rejects(() => dsm({ api: 'SYNO.Cal.Event', version: 5, method: 'create', sid: 'S' }, d.fn),
      (e: unknown) => e instanceof SynologyError && e.code === 9007 && e.api === 'SYNO.Cal.Event');
  });
  test('a lost session is its own error, and says to sign in again', async () => {
    assert.deepEqual([...SESSION_LOST_CODES].sort(), [106, 107, 119]);
    for (const code of [106, 107, 119]) {
      const d = fakeDsm({ success: false, error: { code } });
      await assert.rejects(() => dsm({ api: 'SYNO.Cal.Cal', version: 5, method: 'list', sid: 'S' }, d.fn),
        (e: unknown) => e instanceof SessionLost && e.status === 409 && /sign in again/.test(e.message));
    }
  });
  test('105 is no permission, not a lost session: a 403 naming the API, since signing in again cannot fix it', async () => {
    const d = fakeDsm({ success: false, error: { code: 105 } });
    await assert.rejects(() => dsm({ api: 'SYNO.FileStation.List', version: 2, method: 'list_share', sid: 'S' }, d.fn),
      (e: unknown) => e instanceof NotAllowed && e instanceof SynologyError && !(e instanceof SessionLost)
        && e.status === 403 && e.code === 105
        && e.message === 'your DSM account is not allowed to use SYNO.FileStation.List');
  });
  test('something that is not DSM is named as such', async () => {
    const d = fakeDsm(null, { notJson: true, status: 403 });
    await assert.rejects(() => dsm({ api: 'SYNO.Cal.Cal', version: 5, method: 'list', sid: 'S' }, d.fn), NotDsm);
  });
  test('a NAS that does not answer is a 502 that names the cause', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => dsm({ api: 'SYNO.Cal.Cal', version: 5, method: 'list', sid: 'S' }, down),
      (e: unknown) => e instanceof SynologyError && e.status === 502 && /fetch failed/.test(e.message)
        && /SYNO\.Cal\.Cal/.test(e.message) && !(e instanceof SessionLost) && !(e instanceof NotDsm));
  });
});

test('a context without a sid is refused before any call is made', () => {
  assert.throws(() => requireSid({ sid: null }), NeedsDsm);
  assert.equal(requireSid({ sid: 'S' }), 'S');
});

describe('calendars', () => {
  test('create sends every required field and reads the ids back', async () => {
    const d = fakeDsm({ success: true, data: { cal_id: '/alice/abc/', original_cal_id: '/alice/abc/', cal_displayname: 'Household', cal_color: '#112233', cal_privilege: 'RW', cal_type: 'event', default_calendar: false } });
    const c = await createCalendar('S', { displayname: 'Household', color: '#112233' }, d.fn);
    assert.equal(c.cal_id, '/alice/abc/');
    const b = decodeURIComponent(d.calls[0]!.body);
    // The guide's twelve, and none of the two *_by_push names the real NAS refused with 9009. The
    // description is never sent empty: the real NAS read an empty required field as missing.
    for (const k of ['cal_type=event', 'cal_displayname=Household', 'cal_description=Made+by+Home+Planner.', 'cal_color=#112233',
                     'is_hidden_in_cal=false', 'is_hidden_in_list=false',
                     'notify_alarm_by_browser=false', 'notify_alarm_by_mail=false',
                     'notify_evt_by_browser=false', 'notify_evt_by_mail=false',
                     'notify_import_cal_by_browser=false', 'notify_import_cal_by_mail=false',
    ]) assert.match(b, new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(b, /_by_push/);
  });
  test('rename reads the calendar back and sends the whole of it with the new name, as the guide\'s set requires', async () => {
    const listed = { cal_id: '/alice/abc/', original_cal_id: '/alice/abc/', cal_displayname: 'Household', cal_description: 'ours',
      cal_color: '#112233', cal_privilege: 'RW', cal_type: 'event', default_calendar: false,
      is_hidden_in_cal: false, is_hidden_in_list: true, notify_alarm_by_browser: true, notify_alarm_by_mail: false,
      notify_evt_by_browser: false, notify_evt_by_mail: true, notify_import_cal_by_browser: false, notify_import_cal_by_mail: false };
    const d = fakeDsmSeq([{ success: true, data: { list: [listed] } }, { success: true, data: { ...listed, cal_displayname: 'Home' } }]);
    await renameCalendar('S', { cal_id: '/alice/abc/', original_cal_id: '/alice/abc/' }, 'Home', d.fn);
    assert.equal(d.calls.length, 2);
    assert.match(decodeURIComponent(d.calls[0]!.body), /method=list/);
    const b = decodeURIComponent(d.calls[1]!.body);
    for (const k of ['method=set', 'cal_id=/alice/abc/', 'original_cal_id=/alice/abc/', 'cal_displayname=Home', 'cal_description=ours',
                     'cal_color=#112233', 'is_hidden_in_list=true', 'notify_alarm_by_browser=true', 'notify_evt_by_mail=true',
                     'notify_evt_by_browser=false', 'notify_import_cal_by_mail=false',
    ]) assert.match(b, new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
  test('rename fills in a description when the listed calendar has none, since the NAS refuses an empty one', async () => {
    const listed = { cal_id: '/alice/abc/', original_cal_id: '/alice/abc/', cal_displayname: 'Household', cal_description: '',
      cal_color: '#112233', cal_privilege: 'RW', cal_type: 'event', default_calendar: false };
    const d = fakeDsmSeq([{ success: true, data: { list: [listed] } }, { success: true, data: listed }]);
    await renameCalendar('S', { cal_id: '/alice/abc/', original_cal_id: '/alice/abc/' }, 'Home', d.fn);
    assert.match(decodeURIComponent(d.calls[1]!.body), /cal_description=Made\+by\+Home\+Planner\./);
  });
  test('rename refuses in words when the calendar is not in the list', async () => {
    const d = fakeDsm({ success: true, data: { list: [] } });
    await assert.rejects(renameCalendar('S', { cal_id: '/alice/gone/', original_cal_id: '/alice/gone/' }, 'Home', d.fn),
      (e: Error) => /not in your calendar list/.test(e.message));
    assert.equal(d.calls.length, 1);
  });
  test('share posts the privilege object the 2.4 guide shows', async () => {
    const d = fakeDsm({ success: true });
    await shareCalendar('S', '/alice/abc/', { users: [{ name: 'bob', privilege: 'RW' }] }, d.fn);
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /api=SYNO\.Cal\.Sharing/); assert.match(b, /version=1/); assert.match(b, /method=set/);
    assert.match(b, /cal_share_setting=\{"DSM_USER":\[\{"ug_name":"bob","cal_privilege":"RW"\}\],"DSM_GROUP":\[\]\}/);
  });
  test('share sends the groups it is given back exactly as they were read', async () => {
    const d = fakeDsm({ success: true });
    const groups = [{ ug_name: 'family', cal_privilege: 'RO', extra: 1 }];
    await shareCalendar('S', '/alice/abc/', { users: [], groups }, d.fn);
    assert.match(decodeURIComponent(d.calls[0]!.body),
      /"DSM_GROUP":\[\{"ug_name":"family","cal_privilege":"RO","extra":1\}\]/);
  });
  test('list keeps event calendars and drops task lists', async () => {
    const d = fakeDsm({ success: true, data: [
      { cal_id: '/alice/home/', original_cal_id: '/alice/home/', cal_displayname: 'My Calendar', cal_color: '#fff', cal_privilege: 'RW', cal_type: 'event', default_calendar: true },
      { cal_id: '/alice/todo/', original_cal_id: '/alice/todo/', cal_displayname: 'Tasks', cal_color: '#fff', cal_privilege: 'RW', cal_type: 'todo', default_calendar: false },
    ] });
    const cs = await listCalendars('S', d.fn);
    assert.deepEqual(cs.map((c) => c.displayname), ['My Calendar']);
    assert.equal(cs[0]!.isDefault, true);
  });
  test('sharing reads back as names and privileges', async () => {
    const d = fakeDsm({ success: true, data: { cal_share_setting: {
      DSM_USER: [{ ug_name: 'bob', cal_privilege: 'RO' }], DSM_GROUP: [{ ug_name: 'family', cal_privilege: 'RW' }] } } });
    assert.deepEqual(await sharingOf('S', '/alice/abc/', d.fn), {
      users: [{ name: 'bob', privilege: 'RO' }], groups: [{ ug_name: 'family', cal_privilege: 'RW' }] });
    assert.match(decodeURIComponent(d.calls[0]!.body), /method=get/);
    assert.match(decodeURIComponent(d.calls[0]!.body), /cal_id=\/alice\/abc\//);
  });
  test('list unwraps a cal_list wrapper', async () => {
    const d = fakeDsm({ success: true, data: { cal_list: [
      { cal_id: '/a/h/', original_cal_id: '/a/h/', cal_displayname: 'H', cal_color: '#fff', cal_privilege: 'RO', cal_type: 'event', default_calendar: false },
    ] } });
    assert.deepEqual((await listCalendars('S', d.fn)).map((c) => c.privilege), ['RO']);
  });
  test('list reads the guide\'s { list } wrapper and sends cal_type and is_evt', async () => {
    const d = fakeDsm({ success: true, data: { list: [
      { cal_id: '/a/h/', original_cal_id: '/a/h/', cal_displayname: 'H', cal_color: '#fff', cal_privilege: 'RW', cal_type: 'event', default_calendar: true },
      { cal_id: '/a/t/', original_cal_id: '/a/t/', cal_displayname: 'Inbox', cal_color: '#fff', cal_privilege: 'RW', cal_type: 'todo', default_calendar: true },
    ] } });
    assert.deepEqual((await listCalendars('S', d.fn)).map((c) => c.displayname), ['H']);
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /cal_type=event/); assert.match(b, /is_evt=true/);
  });
});

describe('events', () => {
  const ev = { cal_id: '/a/h/', original_cal_id: '/a/h/', summary: 'Dentist', description: '', is_all_day: false, dtstart: 1762452000, dtend: 1762455600, tz_id: 'America/Denver' };
  const reply = {
    // The four fields set must carry back, as the real NAS returns them.
    notify_setting: [], participant: [], attachments: [], location_info: { address: '', gps: {}, map_type: '', name: '', place_id: '' }, evt_id: 42, ical_uid: 'u@cal.synology.com', dav_etag: 'E1', ...ev, color: '' };
  // The same event as the client holds it after a read: the carried fields are on `carried`, so set needs no extra read.
  const held = { ...reply, carried: { notify_setting: [], participant: [], attachments: [], location_info: reply.location_info } };
  test('create returns the ids the link needs', async () => {
    const d = fakeDsm({ success: true, data: reply });
    const c = await createEvent('S', ev, d.fn);
    assert.equal(c.evt_id, 42); assert.equal(c.ical_uid, 'u@cal.synology.com'); assert.equal(c.dav_etag, 'E1');
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /is_repeat_evt=false/); assert.match(b, /participant=\[\]/); assert.match(b, /notify_setting=\[\]/);
  });
  test('set always carries the stored etag', async () => {
    const d = fakeDsm({ success: true, data: { ...reply, dav_etag: 'E2', summary: 'Dentist (moved)' } });
    const out = await setEvent('S', { ...held }, { summary: 'Dentist (moved)' }, d.fn);
    assert.match(decodeURIComponent(d.calls[0]!.body), /dav_etag=E1/);
    assert.equal(out.dav_etag, 'E2');
  });
  test('set refuses to run without an etag', async () => {
    const d = fakeDsm({ success: true, data: reply });
    await assert.rejects(() => setEvent('S', { ...held, dav_etag: '' }, { summary: 'x' }, d.fn), /etag/);
    assert.equal(d.calls.length, 0);
  });
  test("DSM's refusal of a stale etag is EtagMismatch", async () => {
    const d = fakeDsm({ success: false, error: { code: 9006 } });
    await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, d.fn), EtagMismatch);
  });
  test('list asks for every calendar in the window', async () => {
    const d = fakeDsm({ success: true, data: [reply] });
    const out = await listEvents('S', { calendars: [{ cal_id: '/a/h/', original_cal_id: '/a/h/' }], start: 1, end: 2 }, d.fn);
    assert.equal(out.length, 1);
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /start=1/); assert.match(b, /end=2/); assert.match(b, /cal_id_list=\["\/a\/h\/"\]/);
  });
  test('list reads the guide\'s { list } wrapper', async () => {
    const d = fakeDsm({ success: true, data: { list: [reply, reply] } });
    const out = await listEvents('S', { calendars: [{ cal_id: '/a/h/', original_cal_id: '/a/h/' }], start: 1, end: 2 }, d.fn);
    assert.equal(out.length, 2);
  });
  test('set sends the whole event with the changes applied', async () => {
    const d = fakeDsm({ success: true, data: reply });
    await setEvent('S', { ...held }, { dtstart: 5, dtend: 9 }, d.fn);
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /method=set/); assert.match(b, /evt_id=42/); assert.match(b, /summary=Dentist(&|$)/);
    assert.match(b, /dtstart=5/); assert.match(b, /dtend=9/); assert.match(b, /is_repeat_evt=false/);
    assert.match(b, /notify_setting=\[\]/); assert.match(b, /participant=\[\]/);
    // An empty colour is the JSON literal "": sent plainly empty the real NAS refused it with 9009.
    assert.match(b, /color=(""|%22%22)/);
  });
  test('a stale etag brings back the event as it stands now', async () => {
    const replies: unknown[] = [{ success: false, error: { code: 9006 } }, { success: true, data: { ...reply, dav_etag: 'E9', summary: 'Edited on the NAS' } }];
    const calls: string[] = [];
    const fn = (async (_u: string, init?: RequestInit) => {
      calls.push(decodeURIComponent(String(init?.body)));
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => replies.shift() } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, fn),
      (e: unknown) => e instanceof EtagMismatch && e.status === 409 && e.current?.dav_etag === 'E9' && e.current.summary === 'Edited on the NAS');
    assert.match(calls[1]!, /method=get/);
  });
  test('set sends back notify_setting, participant, location_info and attachments as the event was read', async () => {
    const read = { ...reply, participant: [{ name: 'bob' }], location_info: { ...reply.location_info, name: 'Home' } };
    const d = fakeDsm({ success: true, data: read });
    const e = await getEvent('S', { cal_id: '/a/h/', original_cal_id: '/a/h/', evt_id: 42 }, d.fn);
    await setEvent('S', e, { summary: 'y' }, d.fn);
    assert.equal(d.calls.length, 2, 'no extra read: the event came from DSM');
    const b = decodeURIComponent(d.calls[1]!.body);
    assert.match(b, /participant=\[\{"name":"bob"\}\]/); assert.match(b, /attachments=\[\]/);
    assert.match(b, /location_info=\{"address":"","gps":\{\},"map_type":"","name":"Home","place_id":""\}/);
  });
  test('an event built without those fields is read first, and the etag sent is still the one held', async () => {
    const d = fakeDsm({ success: true, data: { ...reply, dav_etag: 'E5' } });
    await setEvent('S', { ...reply, dav_etag: 'E1' }, { summary: 'y' }, d.fn);
    assert.equal(d.calls.length, 2);
    assert.match(decodeURIComponent(d.calls[0]!.body), /method=get/);
    const b = decodeURIComponent(d.calls[1]!.body);
    assert.match(b, /method=set/); assert.match(b, /dav_etag=E1/); assert.match(b, /location_info=\{/);
  });
  test('any other set failure is an etag mismatch too, except 9007 and 9017', async () => {
    await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, fakeDsm({ success: false, error: { code: 9001 } }).fn), EtagMismatch);
    for (const code of [9007, 9017]) {
      await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, fakeDsm({ success: false, error: { code } }).fn),
        (e: unknown) => e instanceof SynologyError && !(e instanceof EtagMismatch) && e.code === code);
    }
  });
  test('a lost session or an unreachable NAS is never mistaken for an etag mismatch', async () => {
    await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, fakeDsm({ success: false, error: { code: 119 } }).fn), SessionLost);
    const refused = fakeDsm({ success: false, error: { code: 105 } });
    await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, refused.fn), NotAllowed);
    assert.equal(refused.calls.length, 1, 'no second read to look for a moved etag');
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, down),
      (e: unknown) => e instanceof SynologyError && !(e instanceof EtagMismatch) && e.status === 502);
  });
  test('get and delete address the event by its ids', async () => {
    const g = fakeDsm({ success: true, data: reply });
    assert.equal((await getEvent('S', { cal_id: '/a/h/', original_cal_id: '/a/h/', evt_id: 42 }, g.fn)).ical_uid, 'u@cal.synology.com');
    assert.match(decodeURIComponent(g.calls[0]!.body), /method=get/); assert.match(g.calls[0]!.body, /evt_id=42/);
    const x = fakeDsm({ success: true });
    await deleteEvent('S', { cal_id: '/a/h/', original_cal_id: '/a/h/', evt_id: 42 }, x.fn);
    assert.match(x.calls[0]!.body, /method=delete/); assert.match(x.calls[0]!.body, /evt_id=42/);
    assert.doesNotMatch(x.calls[0]!.body, /cal_id/, 'delete takes evt_id alone; the NAS refused the ids with 9009');
  });
  const sequence = (replies: unknown[]) => {
    const calls: string[] = [];
    const fn = (async (_u: string, init?: RequestInit) => {
      calls.push(decodeURIComponent(String(init?.body)));
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => replies.shift() } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    return { fn, calls };
  };
  test('a failed set whose event still has the same etag is not a mismatch', async () => {
    const d = sequence([{ success: false, error: { code: 101 } }, { success: true, data: { ...reply } }]);
    await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, d.fn),
      (e: unknown) => e instanceof SynologyError && !(e instanceof EtagMismatch) && e.code === 101);
    assert.match(d.calls[1]!, /method=get/);
  });
  test('9009 is a mismatch when the etag moved, as the real NAS answers a stale etag, and gone when the event cannot be read', async () => {
    const moved = sequence([{ success: false, error: { code: 9009 } }, { success: true, data: { ...reply, dav_etag: 'E9' } }]);
    await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, moved.fn),
      (e: unknown) => e instanceof EtagMismatch && e.code === 9009 && e.current?.dav_etag === 'E9');
    const gone = sequence([{ success: false, error: { code: 9009 } }, { success: false, error: { code: 9009 } }]);
    await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, gone.fn),
      (e: unknown) => e instanceof SynologyError && !(e instanceof EtagMismatch) && e.code === 9009);
  });
  test('a mismatch stands when the event cannot be fetched, with no current', async () => {
    const d = sequence([{ success: false, error: { code: 9006 } }, { success: false, error: { code: 9001 } }]);
    await assert.rejects(() => setEvent('S', { ...held }, { summary: 'x' }, d.fn),
      (e: unknown) => e instanceof EtagMismatch && e.current === undefined && e.code === 9006);
  });
});

describe('contacts', () => {
  // The version is kept, so these calls do not ask for it.
  beforeEach(async () => { resetConnectors(); await recordProbe({ version: 1, min: 1, max: 1, at: '' }); });
  test('a get or create reply with no data is a not-DSM error naming the api, not a TypeError', async () => {
    await assert.rejects(() => getContact('S', 1, fakeDsm({ success: true }).fn),
      (e: unknown) => e instanceof NotDsm && /SYNO\.Contacts\.Contact/.test(e.message));
    await assert.rejects(() => createContact('S', { addressbook_id: 7, full_name: 'X' }, fakeDsm({ success: true }).fn),
      (e: unknown) => e instanceof NotDsm && e.api === 'SYNO.Contacts.Contact');
  });
  const alice = { id: 1, addressbook_id: 7, full_name: 'Alice Anderson', tel: [{ value: '555' }], email: 'a@b', org: 'Acme' };
  const sandy = { id: 2, addressbook_id: 7, full_name: 'Sandy Jones', phone: '777', emails: [{ value: 's@j' }, { value: 's2@j' }] };
  test('list maps a reply, tolerating strings and {value} lists for phones and emails', async () => {
    const d = fakeDsm({ success: true, data: { contacts: [alice, sandy, { id: 3, addressbook_id: 7 }] } });
    const out = await listContacts('S', { addressbook_id: 7, limit: 50, offset: 10 }, d.fn);
    assert.deepEqual(out[0], { id: 1, addressbook_id: 7, full_name: 'Alice Anderson', phones: ['555'], emails: ['a@b'], org: 'Acme' });
    assert.deepEqual(out[1]!.phones, ['777']); assert.deepEqual(out[1]!.emails, ['s@j', 's2@j']);
    assert.deepEqual(out[2], { id: 3, addressbook_id: 7, full_name: '', phones: [], emails: [], org: '' });
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /api=SYNO\.Contacts\.Contact/); assert.match(b, /method=list/);
    assert.match(b, /addressbook_id=7/); assert.match(b, /limit=50/); assert.match(b, /offset=10/);
  });
  test('list also accepts a bare array', async () => {
    const d = fakeDsm({ success: true, data: [alice] });
    assert.equal((await listContacts('S', {}, d.fn))[0]!.full_name, 'Alice Anderson');
  });
  test('list reads the singular keys the real NAS answers with', async () => {
    const c = fakeDsm({ success: true, data: { contact: [alice, sandy], offset: 0 } });
    assert.deepEqual((await listContacts('S', {}, c.fn)).map((x) => x.id), [1, 2]);
    const b = fakeDsm({ success: true, data: {
      addressbook: [{ id: 7, name: 'Household', shared_from: '', shared_with: [], type: 'personal', mode: 'rw' }], total: 1 } });
    assert.deepEqual(await listAddressbooks('S', b.fn), [{ id: 7, name: 'Household' }]);
  });
  test('search matches full_name case-insensitively on a list of two', async () => {
    const d = fakeDsm({ success: true, data: [alice, sandy] });
    assert.deepEqual((await searchContacts('S', 'and', d.fn)).map((c) => c.id), [1, 2]);
    const d2 = fakeDsm({ success: true, data: [alice, sandy] });
    assert.deepEqual((await searchContacts('S', 'ALICE', d2.fn)).map((c) => c.id), [1]);
    const d3 = fakeDsm({ success: true, data: [alice, sandy] });
    assert.deepEqual(await searchContacts('S', 'zzz', d3.fn), []);
  });
  test('create posts full_name and addressbook_id and returns the contact', async () => {
    const d = fakeDsm({ success: true, data: alice });
    const c = await createContact('S', { addressbook_id: 7, full_name: 'Alice Anderson', phones: ['555'], emails: ['a@b'], org: 'Acme' }, d.fn);
    assert.equal(c.id, 1);
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /method=create/); assert.match(b, /full_name=Alice\+Anderson/); assert.match(b, /addressbook_id=7/);
  });
  test('get addresses the contact by id', async () => {
    const d = fakeDsm({ success: true, data: { contact: alice } });
    assert.equal((await getContact('S', 1, d.fn)).org, 'Acme');
    assert.match(d.calls[0]!.body, /method=get/); assert.match(d.calls[0]!.body, /id=1/);
  });
  test('addressbooks are listed', async () => {
    const d = fakeDsm({ success: true, data: { addressbooks: [{ id: 7, name: 'Household' }] } });
    assert.deepEqual(await listAddressbooks('S', d.fn), [{ id: 7, name: 'Household' }]);
    assert.match(d.calls[0]!.body, /api=SYNO\.Contacts\.Addressbook/);
  });
  test('every call uses the contacts api and the version kept', async () => {
    const calls = [
      (f: typeof globalThis.fetch) => listAddressbooks('S', f),
      (f: typeof globalThis.fetch) => listContacts('S', {}, f),
      (f: typeof globalThis.fetch) => getContact('S', 1, f),
      (f: typeof globalThis.fetch) => createContact('S', { addressbook_id: 7, full_name: 'X' }, f),
      (f: typeof globalThis.fetch) => searchContacts('S', 'x', f),
    ];
    for (const call of calls) {
      const d = fakeDsm({ success: true, data: [alice] });
      await call(d.fn);
      assert.match(d.calls[0]!.body, /api=SYNO\.Contacts\.(Contact|Addressbook)/);
      assert.match(d.calls[0]!.body, /version=1(&|$)/);
      assert.doesNotMatch(d.calls[0]!.url, /_sid/);
    }
  });
});

describe('the Contacts version', () => {
  const info = (min: number, max: number) => ({ success: true, data: { 'SYNO.Contacts.Contact': { minVersion: min, maxVersion: max } } });
  const books = { success: true, data: { addressbooks: [] } };

  test('asked once, without a session, and kept: 1 when the range holds it', async () => {
    resetConnectors();
    const d = fakeDsmSeq([info(1, 2), books, books]);
    await listAddressbooks('S', d.fn); await listAddressbooks('S', d.fn);
    assert.match(d.calls[0]!.body, /api=SYNO\.API\.Info/);
    assert.match(d.calls[0]!.body, /query=SYNO\.Contacts\.Contact/);
    assert.doesNotMatch(d.calls[0]!.body, /_sid/);
    assert.doesNotMatch(d.calls[0]!.url, /_sid/);
    assert.equal(d.calls.length, 3, 'asked once, then kept');
    assert.match(d.calls[1]!.body, /version=1(&|$)/);
    assert.match(d.calls[1]!.body, /_sid=S/);
    const kept = connectors().probed!.contactsVersion;
    assert.deepEqual([kept.version, kept.min, kept.max], [1, 1, 2]);
    assert.ok(Number.isFinite(Date.parse(kept.at)));
  });
  test('else the lowest offered', async () => {
    resetConnectors();
    const d = fakeDsmSeq([info(2, 3), books]);
    await listAddressbooks('S', d.fn);
    assert.match(d.calls[1]!.body, /version=2(&|$)/);
    assert.equal(connectors().probed!.contactsVersion.version, 2);
  });
  test('a NAS that does not list Contacts is called at 1 and nothing is kept', async () => {
    resetConnectors();
    const d = fakeDsmSeq([{ success: true, data: {} }, books]);
    await listAddressbooks('S', d.fn);
    assert.match(d.calls[1]!.body, /version=1(&|$)/);
    assert.equal(connectors().probed, undefined);
  });
  test('a version DSM refuses is asked about again, once', async () => {
    resetConnectors();
    await recordProbe({ version: 1, min: 1, max: 1, at: '' });
    const d = fakeDsmSeq([{ success: false, error: { code: 104 } }, info(2, 3), books]);
    await listAddressbooks('S', d.fn);
    assert.equal(d.calls.length, 3);
    assert.match(d.calls[0]!.body, /api=SYNO\.Contacts\.Addressbook/);
    assert.match(d.calls[0]!.body, /version=1(&|$)/);
    assert.match(d.calls[1]!.body, /api=SYNO\.API\.Info/);
    assert.match(d.calls[2]!.body, /version=2(&|$)/);
    assert.equal(connectors().probed!.contactsVersion.version, 2);
  });
  test('a second 104 is the answer: no third call', async () => {
    resetConnectors();
    await recordProbe({ version: 1, min: 1, max: 1, at: '' });
    const refused = { success: false, error: { code: 104 } };
    const d = fakeDsmSeq([refused, info(1, 1), refused]);
    await assert.rejects(() => listAddressbooks('S', d.fn), (e: unknown) => e instanceof SynologyError && e.code === 104);
    assert.equal(d.calls.length, 3);
  });
  test('any other refusal keeps the probe', async () => {
    resetConnectors();
    await recordProbe({ version: 1, min: 1, max: 1, at: '' });
    const d = fakeDsm({ success: false, error: { code: 102 } });
    await assert.rejects(() => listAddressbooks('S', d.fn), (e: unknown) => e instanceof SynologyError && e.code === 102);
    assert.equal(d.calls.length, 1);
    assert.equal(connectors().probed!.contactsVersion.version, 1);
  });
  test('the probe is written to the file only when the connectors file was named', async () => {
    resetConnectors();
    const dir = mkdtempSync(join(tmpdir(), 'probe-'));
    try {
      const path = join(dir, 'connectors.json');
      loadConnectors(path);
      await recordProbe({ version: 2, min: 1, max: 3, at: '2026-11-03T00:00:00.000Z' });
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).probed.contactsVersion.version, 2);
      await forgetProbe();
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).probed, undefined);
      assert.equal(connectors().probed, undefined);
    } finally { resetConnectors(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('file station', () => {
  const lost = (code: number) => fakeDsm({ success: false, error: { code } });
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof globalThis.fetch;

  /** A fetch that answers with raw bytes, as a download does. */
  const fakeFile = (bytes: Uint8Array, type: string | null, status = 200) => {
    const calls: { url: string; method: string; headers: Headers }[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
      return {
        ok: status >= 200 && status < 300, status,
        headers: new Headers(type ? { 'content-type': type } : {}),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    return { fn, calls };
  };
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  test('create folder posts the parent, the name and force_parent', async () => {
    const d = fakeDsm({ success: true, data: { folders: [] } });
    await createFolder('S', '/family/Budget', 'Receipts', d.fn);
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /api=SYNO\.FileStation\.CreateFolder/); assert.match(b, /version=2/); assert.match(b, /method=create/);
    assert.match(b, /folder_path=\/family\/Budget/); assert.match(b, /name=Receipts/); assert.match(b, /force_parent=true/);
  });

  test('upload is multipart with the text parts first and the file part last', async () => {
    const d = fakeDsm({ success: true, data: { file: 'a.txt' } });
    await uploadFile('S', { folder: '/family/Budget', name: 'a.txt', bytes: new TextEncoder().encode('hello bytes'), overwrite: true }, d.fn);
    const call = d.calls[0]!;
    assert.equal(call.method, 'POST');
    assert.match(call.url, /\/webapi\/entry\.cgi$/);
    assert.doesNotMatch(call.url, /_sid/, 'the sid is never in the URL');
    const type = call.headers.get('content-type')!;
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(type)?.[1];
    assert.ok(boundary, `content-type names a boundary: ${type}`);
    const body = call.body;
    assert.ok(body.startsWith(`--${boundary}\r\n`)); assert.ok(body.endsWith(`\r\n--${boundary}--\r\n`));
    const field = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body)?.[1];
    assert.equal(field('api'), 'SYNO.FileStation.Upload'); assert.equal(field('version'), '2');
    assert.equal(field('method'), 'upload'); assert.equal(field('path'), '/family/Budget');
    assert.equal(field('create_parents'), 'true'); assert.equal(field('overwrite'), 'true');
    assert.ok(body.lastIndexOf('name="file"') > body.lastIndexOf('name="path"'));
    for (const k of ['api', 'version', 'method', 'path', 'create_parents', 'overwrite', '_sid']) {
      assert.ok(body.lastIndexOf('name="file"') > body.indexOf(`name="${k}"`), `${k} comes before the file`);
    }
    assert.equal(field('_sid'), 'S');
    assert.match(body, /name="file"; filename="a\.txt"\r\nContent-Type: application\/octet-stream\r\n\r\nhello bytes\r\n--/);
  });
  test('upload sends no overwrite part unless asked to replace, and keeps binary bytes intact', async () => {
    const seen: Uint8Array[] = [];
    const f = (async (_u: string, init?: RequestInit) => {
      seen.push(init!.body as Uint8Array);
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ success: true, data: {} }) } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    await uploadFile('S', { folder: '/f', name: 'x.bin', bytes: Uint8Array.from([0, 255, 13, 10, 128]) }, f);
    const sent = Buffer.from(seen[0]!);
    // overwrite=false would have File Station skip the file and still say success.
    assert.doesNotMatch(sent.toString('latin1'), /name="overwrite"/);
    await uploadFile('S', { folder: '/f', name: 'x.bin', bytes: new Uint8Array(), overwrite: false }, f);
    assert.doesNotMatch(Buffer.from(seen[1]!).toString('latin1'), /name="overwrite"/, 'false is the same as left out');
    const tail = Buffer.from([0, 255, 13, 10, 128]);
    assert.ok(sent.includes(Buffer.concat([Buffer.from('\r\n\r\n'), tail, Buffer.from('\r\n--')])), 'the file bytes are in the body untouched');
  });
  test('a quote in the file name cannot break out of the header', async () => {
    const d = fakeDsm({ success: true, data: {} });
    await uploadFile('S', { folder: '/f', name: 'a"b\r\nc.txt', bytes: new Uint8Array() }, d.fn);
    assert.match(d.calls[0]!.body, /filename="a%22bc\.txt"/);
  });
  test('upload failures are classified like every other DSM failure', async () => {
    const up = (f: typeof globalThis.fetch) => uploadFile('S', { folder: '/f', name: 'a', bytes: new Uint8Array() }, f);
    await assert.rejects(() => up(lost(119).fn), SessionLost);
    await assert.rejects(() => up(lost(414).fn), (e: unknown) => e instanceof SynologyError && e.code === 414 && e.api === 'SYNO.FileStation.Upload');
    await assert.rejects(() => up(fakeDsm(null, { notJson: true, status: 404 }).fn), NotDsm);
    await assert.rejects(() => up(down), (e: unknown) => e instanceof SynologyError && e.status === 502 && /fetch failed/.test(e.message));
  });

  test('upload: a reply body that cannot be read is the NAS not answering', async () => {
    const broken = (async () => ({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); },
    } as unknown as Response)) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => uploadFile('S', { folder: '/f', name: 'a', bytes: new Uint8Array() }, broken),
      (e: unknown) => e instanceof SynologyError && e.status === 502 && !(e instanceof NotDsm));
  });

  test('download is a GET with the sid in a cookie, never in the URL', async () => {
    const bytes = Uint8Array.from([0, 255, 1, 2, 128]);
    const d = fakeFile(bytes, 'image/png');
    const out = await downloadFile('S', '/family/Budget/r 1.png', d.fn);
    assert.deepEqual([...out.bytes], [...bytes]); assert.equal(out.contentType, 'image/png');
    const call = d.calls[0]!;
    assert.equal(call.method, 'GET');
    assert.match(call.url, /\/webapi\/entry\.cgi\?/);
    assert.doesNotMatch(call.url, /_sid|=S(&|$)/);
    assert.equal(call.headers.get('cookie'), 'id=S');
    const q = new URL(call.url).searchParams;
    assert.equal(q.get('api'), 'SYNO.FileStation.Download'); assert.equal(q.get('version'), '2');
    assert.equal(q.get('method'), 'download'); assert.equal(q.get('mode'), 'download');
    assert.equal(q.get('path'), '/family/Budget/r 1.png');
  });
  test('a download with no content-type is octet-stream', async () => {
    assert.equal((await downloadFile('S', '/a', fakeFile(new Uint8Array([1]), null).fn)).contentType, 'application/octet-stream');
  });
  test('a JSON error body, at HTTP 200 or not, is classified like any DSM failure', async () => {
    await assert.rejects(() => downloadFile('S', '/a', fakeFile(json({ success: false, error: { code: 408 } }), 'application/json').fn),
      (e: unknown) => e instanceof SynologyError && e.code === 408 && e.api === 'SYNO.FileStation.Download');
    await assert.rejects(() => downloadFile('S', '/a', fakeFile(json({ success: false, error: { code: 119 } }), 'text/plain').fn), SessionLost);
    await assert.rejects(() => downloadFile('S', '/a', fakeFile(json({ success: false, error: { code: 408 } }), 'application/json', 404).fn),
      (e: unknown) => e instanceof SynologyError && e.code === 408);
  });
  test('a text or JSON file is a download, not an error', async () => {
    const text = new TextEncoder().encode('just a note');
    assert.deepEqual([...(await downloadFile('S', '/a.txt', fakeFile(text, 'text/plain').fn)).bytes], [...text]);
    const doc = json({ success: true, data: 1 });
    assert.deepEqual([...(await downloadFile('S', '/a.json', fakeFile(doc, 'application/json').fn)).bytes], [...doc]);
  });
  test('a small body is looked at for a DSM error whatever its content-type', async () => {
    await assert.rejects(() => downloadFile('S', '/a', fakeFile(json({ success: false, error: { code: 119 } }), null).fn), SessionLost);
    await assert.rejects(() => downloadFile('S', '/a', fakeFile(json({ success: false, error: { code: 119 } }), 'application/octet-stream').fn), SessionLost);
    // ...and a small file that merely parses as something else is still the file.
    const note = json({ success: true });
    assert.deepEqual([...(await downloadFile('S', '/a', fakeFile(note, null).fn)).bytes], [...note]);
  });
  test('with a cap, a file over it is refused with 413, from its declared length or as it arrives', async () => {
    const big = new Uint8Array(4096).fill(7);
    const over = (e: unknown) => e instanceof SynologyError && e.status === 413 && e.api === 'SYNO.FileStation.Download';
    // Declared over the cap: refused before the body is read at all.
    const declared = (async () => new Response(new ReadableStream({
      pull(c) { c.enqueue(big); c.close(); },
    }), { headers: { 'content-type': 'image/png', 'content-length': '4096' } })) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => downloadFile('S', '/a.png', declared, { maxBytes: 1024 }), over);
    // No length, or a smaller one than the truth: the read stops once it passes the cap.
    const chunks = [big.subarray(0, 1000), big.subarray(1000, 2000), big.subarray(2000)];
    let sent = 0;
    const streamed = (async () => new Response(new ReadableStream({
      pull(c) { const next = chunks[sent++]; if (next) c.enqueue(next); else c.close(); },
    }), { headers: { 'content-type': 'image/png' } })) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => downloadFile('S', '/a.png', streamed, { maxBytes: 1500 }), over);
    // At or under the cap, it is the file.
    assert.deepEqual([...(await downloadFile('S', '/a.png', fakeFile(big, 'image/png').fn, { maxBytes: 4096 })).bytes], [...big]);
  });
  test('a body read that times out midway is the NAS not answering, not a raw TimeoutError', async () => {
    const slow = (async () => ({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
    } as unknown as Response)) as unknown as typeof globalThis.fetch;
    await assert.rejects(() => downloadFile('S', '/a', slow),
      (e: unknown) => e instanceof SynologyError && e.status === 502 && e.api === 'SYNO.FileStation.Download'
        && /did not answer/.test(e.message) && /aborted due to timeout/.test(e.message)
        && !(e instanceof EtagMismatch) && !(e instanceof SessionLost) && !(e instanceof NotDsm));
  });
  test('a comma in a name or path is refused before any call', async () => {
    const d = fakeDsm({ success: true, data: {} });
    await assert.rejects(() => createFolder('S', '/x', 'a,b', d.fn), (e: unknown) => e instanceof SynologyError && e.status === 400);
    await assert.rejects(() => downloadFile('S', '/x/a,b', d.fn), (e: unknown) => e instanceof SynologyError && e.status === 400);
    await assert.rejects(() => listFolder('S', '/x,y', d.fn), (e: unknown) => e instanceof SynologyError && e.status === 400);
    assert.equal(d.calls.length, 0);
  });
  test('a non-2xx that is not DSM, and an unreachable NAS, fail as such', async () => {
    await assert.rejects(() => downloadFile('S', '/a', fakeFile(new TextEncoder().encode('<html>'), 'text/html', 502).fn), NotDsm);
    await assert.rejects(() => downloadFile('S', '/a', down),
      (e: unknown) => e instanceof SynologyError && e.status === 502 && /fetch failed/.test(e.message) && !(e instanceof NotDsm));
  });

  test('list maps data.files and asks for the size', async () => {
    const d = fakeDsm({ success: true, data: { total: 2, offset: 0, files: [
      { path: '/family/a.pdf', name: 'a.pdf', isdir: false, additional: { size: 1234 } },
      { path: '/family/sub', name: 'sub', isdir: true, additional: { size: 4096 } },
      { path: '/family/b', name: 'b', isdir: false },
    ] } });
    assert.deepEqual(await listFolder('S', '/family', d.fn), [
      { name: 'a.pdf', size: 1234, isdir: false }, { name: 'sub', size: 4096, isdir: true }, { name: 'b', size: 0, isdir: false },
    ]);
    const b = decodeURIComponent(d.calls[0]!.body);
    assert.match(b, /api=SYNO\.FileStation\.List/); assert.match(b, /version=2/); assert.match(b, /method=list/);
    assert.match(b, /folder_path=\/family/); assert.match(b, /additional=\["size"\]/);
  });
});
