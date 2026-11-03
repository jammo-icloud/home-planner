/**
 * What DSM knows about its accounts: who is in the administrators group, and
 * which accounts exist.
 *
 * Both are asked with the member's own sid, so DSM decides what they may see:
 * an administrator's session can list the group and the accounts, anyone
 * else's is refused (105). Nothing here is kept; the caller asks when it needs
 * to know, and the sid never reaches a log line.
 */

import { dsm, NotAllowed, SynologyError } from './synology.ts';
import type { DsmFetch } from './synology.ts';

/**
 * Provisional: the members of DSM's administrators group. Probe 1 of the
 * check (api/tools/synology-check) confirms the name, version and parameters
 * on the real NAS; if they differ, this one constant is the swap.
 */
export const ADMIN_GROUP_CALL = {
  api: 'SYNO.Core.Group.Member', version: 1, method: 'list', params: { group: 'administrators' },
} as const;

/** Provisional, like the call above: every DSM account. Probe 2 of the check confirms it. */
export const ACCOUNTS_CALL = { api: 'SYNO.Core.User', version: 1, method: 'list' } as const;

/** The names in an answer shaped `{ users: [{ name }] }`, lowercased. */
const namesIn = (data: unknown): string[] => {
  const users = (data as { users?: unknown } | null)?.users;
  if (!Array.isArray(users)) return [];
  return users.flatMap((u: { name?: unknown } | null) => (typeof u?.name === 'string' ? [u.name.toLowerCase()] : []));
};

/**
 * Whether `who` is in DSM's administrators group, asked with their own fresh
 * sid. Any failure is false: a refusal means they are not one, and an outage
 * means they are not known to be one. DSM's 105 (not permitted) is the normal
 * answer for a member who is not an administrator, so it is silent. Any other
 * failure also answers false but warns once, naming the account and only the
 * DSM error code or the error's class: a wrong provisional constant or an
 * outage would otherwise leave a real admin unexplained. Never the sid, never
 * a message body.
 */
export async function isAdministrator(sid: string, who: string, f?: DsmFetch): Promise<boolean> {
  try {
    return namesIn(await dsm<unknown>({ ...ADMIN_GROUP_CALL, sid }, f)).includes(who.trim().toLowerCase());
  } catch (err) {
    if (err instanceof NotAllowed) return false;
    const what = err instanceof SynologyError ? `code ${err.code}` : ((err as Error | null)?.name ?? 'unknown error');
    console.warn(`[budget] could not ask DSM whether ${who} is an administrator: ${what}`);
    return false;
  }
}

/** The DSM accounts this session can list, lowercased. A refusal is a SynologyError. */
export async function listAccounts(sid: string, f?: DsmFetch): Promise<string[]> {
  return namesIn(await dsm<unknown>({ ...ACCOUNTS_CALL, sid }, f));
}
