/**
 * Which encoding SYNO.Cal.Event set accepts. Settled on the real NAS on
 * 2026-11-03: set needs `attachments` and a `location_info` of the full shape
 * get returns (an empty object is refused), plain or JSON-quoted strings are
 * both fine, the read-only keys may be echoed or left out, and a stale etag is
 * refused 9009. Every variant runs, so a run bisects a new NAS's answers.
 */
import { EVENT_VERSION, dsm } from '../../../src/synology.ts';
import { attempt, code, deleteCalendar, makeCalendar, probeName, type Params } from './shared.ts';

export const WHAT = 'Makes a calendar and an event, tries ways of sending SYNO.Cal.Event set, then deletes both.';

type Raw = Record<string, unknown> & { evt_id: number; dav_etag: string };

export async function run(sid: string): Promise<void> {
  const name = probeName();
  const cal = await makeCalendar(sid, name);
  try {
    const start = Math.floor(Date.now() / 1000) + 86400;
    const fields = {
      cal_id: cal.cal_id, original_cal_id: cal.original_cal_id,
      summary: 'Planner probe', description: 'From Home Planner · probe', is_all_day: false,
      dtstart: start, dtend: start + 3600, tz_id: 'America/Denver',
      is_repeat_evt: false, color: '""', notify_setting: [], participant: [],
    };
    const made = await dsm<Raw>({ api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'create', sid, params: fields });
    console.log(`Made event ${made.evt_id}; create answered the keys: ${Object.keys(made).sort().join(', ')}`);
    const got = await dsm<Raw>({ api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'get', sid,
      params: { evt_id: made.evt_id, cal_id: cal.cal_id, original_cal_id: cal.original_cal_id } });
    console.log(`get answered the keys: ${Object.keys(got).sort().join(', ')}`);
    console.log(`  location_info is ${typeof got['location_info']}, attachments is ${Array.isArray(got['attachments']) ? 'an array' : typeof got['attachments']}`);

    const moved = { ...fields, dtstart: start + 3600, dtend: start + 7200 };
    const base = { ...moved, evt_id: made.evt_id, dav_etag: got.dav_etag };
    // What get returned, every key, as a form value: strings plain (empty as ""), the rest as JSON.
    const echo: Params = {};
    for (const [k, v] of Object.entries(got)) {
      if (v === null || v === undefined) continue;
      echo[k] = typeof v === 'string' ? (v === '' ? '""' : v) : (typeof v === 'object' ? v : (v as string | number | boolean));
    }
    for (const k of ['notify_setting', 'participant', 'location_info', 'attachments', 'extra_info', 'personal_property', 'evt_ical', 'dtstart_string']) {
      const v = got[k];
      const shape = v === undefined ? 'absent' : Array.isArray(v) ? `array of ${v.length}` : v === null ? 'null' : typeof v === 'object' ? `object with keys ${Object.keys(v as object).join(', ') || '(none)'}` : `${typeof v} of ${String(v).length} characters`;
      console.log(`  ${k}: ${shape}`);
    }
    const q = (v: unknown): string => JSON.stringify(String(v));
    const quotedStrings = (o: Params): Params =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? (v === '""' ? v : q(v)) : v]));
    const without = (o: Params, ...keys: string[]): Params => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
    const asGot = (...keys: string[]): Params => Object.fromEntries(keys.filter((k) => got[k] !== undefined && got[k] !== null).map((k) => [k, got[k] as string | number | boolean | object]));
    const full: Params = { ...echo, cal_id: cal.cal_id, dtstart: start + 3600, dtend: start + 7200 };
    const READ_ONLY = ['owner_id', 'owner_name', 'ical_uid', 'create_time', 'modify_time', 'last_modify_user'];
    // Every variant runs; the etag is carried from each accepted reply to the next.
    const variants: [label: string, params: Params][] = [
      ['1 the echo of get with cal_id, strings quoted (accepted 2026-11-03)', quotedStrings(full)],
      ['2 the echo, strings plain', full],
      ['3 the echo minus evt_ical', quotedStrings(without(full, 'evt_ical'))],
      ['4 the echo minus extra_info and personal_property', quotedStrings(without(full, 'extra_info', 'personal_property'))],
      ['5 the echo minus dtstart_string and dtend_string', quotedStrings(without(full, 'dtstart_string', 'dtend_string'))],
      ['6 the echo minus the read-only keys (owner_*, ical_uid, create_time, modify_time, last_modify_user)', quotedStrings(without(full, ...READ_ONLY))],
      ['7 the app\'s fields plus notify_setting, participant, location_info, attachments as get returned them, plain',
        { ...base, ...asGot('notify_setting', 'participant', 'location_info', 'attachments') }],
      ['8 the same plus extra_info and personal_property as get returned them, plain',
        { ...base, ...asGot('notify_setting', 'participant', 'location_info', 'attachments', 'extra_info', 'personal_property') }],
      ['9 the same plus evt_ical as get returned it, plain',
        { ...base, ...asGot('notify_setting', 'participant', 'location_info', 'attachments', 'extra_info', 'personal_property', 'evt_ical') }],
      ['10 the same plus dtstart_string and dtend_string, plain',
        { ...base, ...asGot('notify_setting', 'participant', 'location_info', 'attachments', 'extra_info', 'personal_property', 'evt_ical', 'dtstart_string', 'dtend_string') }],
    ];
    console.log(`Trying SYNO.Cal.Event set v${EVENT_VERSION}, every variant, with the current etag each time:`);
    let etag = got.dav_etag;
    let lastAccepted: Params | null = null;
    for (const [label, params] of variants) {
      const p = { ...params, dav_etag: params['dav_etag'] === q(got.dav_etag) ? q(etag) : etag };
      const after = await attempt<Raw>(label, p, () => dsm({ api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'set', sid, params: p }));
      if (!after) continue;
      console.log(`    reply: new etag ${typeof after.dav_etag === 'string' && after.dav_etag !== etag ? 'yes' : 'no'}`);
      if (typeof after.dav_etag === 'string') etag = after.dav_etag;
      lastAccepted = p;
    }
    if (lastAccepted) {
      try {
        await dsm({ api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'set', sid, params: { ...lastAccepted, dav_etag: got.dav_etag } });
        console.log('  The last accepted set again with the FIRST etag, now stale: ACCEPTED (DSM does not check the etag)');
      } catch (err) {
        console.log(`  The last accepted set again with the FIRST etag, now stale: ${code(err)}`);
      }
    }
    try {
      await dsm({ api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'delete', sid, params: { evt_id: made.evt_id } });
      console.log('Deleted the event.');
    } catch (err) {
      console.log(`Could not delete the event: ${code(err)}; it goes with the calendar.`);
    }
  } finally {
    await deleteCalendar(sid, cal.cal_id, name);
  }
}
