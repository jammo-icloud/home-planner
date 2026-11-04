/**
 * Which encoding SYNO.Cal.Cal create accepts. Settled on the real NAS on
 * 2026-11-03: plain strings and the eight flags as words are taken, and a
 * required field sent empty (the description) is refused 9009. Kept so the
 * same question can be asked again of another NAS or DSM version.
 */
import { CAL_VERSION, dsm } from '../../../src/synology.ts';
import { attempt, deleteCalendar, FLAGS_OFF, probeName, type Params } from './shared.ts';

export const WHAT = 'Tries ways of sending SYNO.Cal.Cal create, stops at the first accepted, and deletes that calendar.';

export async function run(sid: string): Promise<void> {
  const name = probeName();
  const q = (s: string): string => JSON.stringify(s);
  const base = { cal_type: 'event', cal_displayname: name, cal_color: '#3F6F8C', ...FLAGS_OFF };
  const variants: [label: string, params: Params][] = [
    ['1 plain strings, empty description, eight flags (what the app sent before 2026-11-03)', { ...base, cal_description: '' }],
    ['2 plus is_evt=true, as list needed', { ...base, cal_description: '', is_evt: true }],
    ['3 non-empty description (what the app sends now)', { ...base, cal_description: 'probe' }],
    ['4 non-empty description plus is_evt=true', { ...base, cal_description: 'probe', is_evt: true }],
    ['5 strings JSON-quoted, flags as words',
      { ...FLAGS_OFF, cal_type: q('event'), cal_displayname: q(name), cal_description: q(''), cal_color: q('#3F6F8C') }],
    ['6 only the type, name, description and color, no flags',
      { cal_type: 'event', cal_displayname: name, cal_description: 'probe', cal_color: '#3F6F8C' }],
  ];
  console.log(`Trying SYNO.Cal.Cal create v${CAL_VERSION}:`);
  for (const [label, params] of variants) {
    const made = await attempt<{ cal_id?: string }>(label, params,
      () => dsm({ api: 'SYNO.Cal.Cal', version: CAL_VERSION, method: 'create', sid, params }));
    if (!made) continue;
    console.log(`    reply has cal_id: ${typeof made.cal_id === 'string' ? 'yes' : `no, keys ${Object.keys(made).join(', ')}`}`);
    if (typeof made.cal_id === 'string') await deleteCalendar(sid, made.cal_id, name);
    return;
  }
  console.log('  None was accepted.');
}
