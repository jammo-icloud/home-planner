/**
 * Which encoding SYNO.Cal.Event create accepts. The app's event create was
 * refused 9009 on the real NAS (2026-11-03) with the parameters the guide
 * lists; the suspect is `color` sent empty, which the guide says to do for the
 * calendar's own colour but which DSM may read as missing, as it did an empty
 * calendar description.
 */
import { EVENT_VERSION, dsm } from '../../../src/synology.ts';
import { attempt, code, deleteCalendar, makeCalendar, probeName, type Params } from './shared.ts';

export const WHAT = 'Makes a calendar, tries ways of sending SYNO.Cal.Event create, deletes the event and the calendar.';

export async function run(sid: string): Promise<void> {
  const name = probeName();
  const cal = await makeCalendar(sid, name);
  try {
    const start = Math.floor(Date.now() / 1000) + 86400;
    const b = {
      cal_id: cal.cal_id, original_cal_id: cal.original_cal_id,
      summary: 'Planner probe', description: 'From Home Planner · probe', is_all_day: false,
      dtstart: start, dtend: start + 3600, tz_id: 'America/Denver',
    };
    const q = (s: string): string => JSON.stringify(s);
    const variants: [label: string, params: Params][] = [
      ['1 as the app sends it: color empty, notify_setting [] and participant [] as JSON, is_repeat_evt false',
        { ...b, is_repeat_evt: false, color: '', notify_setting: [], participant: [] }],
      ['2 color JSON-quoted empty ("")', { ...b, is_repeat_evt: false, color: '""', notify_setting: [], participant: [] }],
      ['3 color set to the calendar\'s #3F6F8C', { ...b, is_repeat_evt: false, color: '#3F6F8C', notify_setting: [], participant: [] }],
      ['4 no color at all', { ...b, is_repeat_evt: false, notify_setting: [], participant: [] }],
      ['5 color set, no notify_setting and no participant', { ...b, is_repeat_evt: false, color: '#3F6F8C' }],
      ['6 only the guide\'s strings and numbers: no color, no arrays, no is_repeat_evt', { ...b }],
      ['7 everything JSON-quoted: strings in quotes, color "", arrays as JSON',
        { cal_id: q(b.cal_id), original_cal_id: q(b.original_cal_id), summary: q(b.summary), description: q(b.description),
          is_all_day: false, dtstart: b.dtstart, dtend: b.dtend, tz_id: q(b.tz_id),
          is_repeat_evt: false, color: '""', notify_setting: [], participant: [] }],
    ];
    console.log(`Trying SYNO.Cal.Event create v${EVENT_VERSION}:`);
    for (const [label, params] of variants) {
      const made = await attempt<{ evt_id?: number; dav_etag?: string; color?: string }>(label, params,
        () => dsm({ api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'create', sid, params }));
      if (!made) continue;
      console.log(`    reply: evt_id ${typeof made.evt_id}, dav_etag ${typeof made.dav_etag}, color ${JSON.stringify(made.color ?? null)}`);
      if (typeof made.evt_id === 'number') {
        try {
          await dsm({ api: 'SYNO.Cal.Event', version: EVENT_VERSION, method: 'delete', sid,
            params: { evt_id: made.evt_id, cal_id: cal.cal_id, original_cal_id: cal.original_cal_id } });
          console.log('    delete with evt_id, cal_id, original_cal_id: accepted');
        } catch (err) {
          console.log(`    delete: ${code(err)}; the event goes with the calendar`);
        }
      }
      return;
    }
    console.log('  None was accepted.');
  } finally {
    await deleteCalendar(sid, cal.cal_id, name);
  }
}
