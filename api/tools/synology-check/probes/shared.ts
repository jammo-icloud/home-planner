/** What the probes have in common: a try that prints its code, a throwaway calendar, and its removal. */
import { CAL_VERSION, SynologyError, dsm } from '../../../src/synology.ts';

/** What one call sends, as `dsm` takes it. */
export type Params = Record<string, string | number | boolean | object>;

/** The guide's eight flags, all off, as the app sends them. */
export const FLAGS_OFF = {
  is_hidden_in_cal: false, is_hidden_in_list: false,
  notify_alarm_by_browser: false, notify_alarm_by_mail: false,
  notify_evt_by_browser: false, notify_evt_by_mail: false,
  notify_import_cal_by_browser: false, notify_import_cal_by_mail: false,
} as const;

export const probeName = (): string => `Planner probe ${new Date().toISOString().slice(11, 19)}`;

export const code = (err: unknown): string =>
  err instanceof SynologyError ? `refused, code ${err.code}` : `failed: ${(err as Error).name}: ${(err as Error).message}`;

/** One variant: prints ACCEPTED with the parameter names, or the code; the reply when accepted. */
export async function attempt<T>(label: string, params: Params, call: () => Promise<T>): Promise<T | null> {
  try {
    const got = await call();
    console.log(`  ${label}: ACCEPTED (keys sent: ${Object.keys(params).join(', ')})`);
    return got ?? ({} as T);
  } catch (err) {
    console.log(`  ${label}: ${code(err)}`);
    return null;
  }
}

/** A calendar of the probe's own, made the way the app makes one. */
export async function makeCalendar(sid: string, name: string): Promise<{ cal_id: string; original_cal_id: string }> {
  const made = await dsm<{ cal_id: string; original_cal_id: string }>({
    api: 'SYNO.Cal.Cal', version: CAL_VERSION, method: 'create', sid,
    params: { cal_type: 'event', cal_displayname: name, cal_description: 'probe', cal_color: '#3F6F8C', ...FLAGS_OFF },
  });
  console.log(`Made calendar "${name}".`);
  return made;
}

/** Deletes the probe's calendar, saying so either way. */
export async function deleteCalendar(sid: string, cal_id: string, name: string): Promise<void> {
  try {
    await dsm({ api: 'SYNO.Cal.Cal', version: CAL_VERSION, method: 'delete', sid, params: { cal_id } });
    console.log(`Deleted calendar "${name}"; nothing left behind.`);
  } catch (err) {
    console.log(`Could not delete calendar "${name}" (${code(err)}): delete it in Synology Calendar.`);
  }
}
