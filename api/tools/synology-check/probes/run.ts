/**
 * Runs one probe against the real NAS: `npm run synology:probe -- <name>`.
 *
 * A probe is a small script beside this one that tries several ways of making
 * one DSM call, stops at the first the NAS accepts, and deletes what it made.
 * Each prints only codes and parameter names, never the sid, the password or a
 * reply body. The account and the NAS come from tools/synology-check/.env (see
 * signin.ts); a one-time code is asked for on the terminal.
 *
 * Each probe exports `run(sid): Promise<void>` and a `WHAT` sentence.
 */
// First, so tools/synology-check/.env is read before anything fixes DSM_URL at load.
import { account, signIn } from '../signin.ts';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_VERSION, DSM_URL } from '../../../src/auth.ts';
import { dsm } from '../../../src/synology.ts';

const here = dirname(fileURLToPath(import.meta.url));
const NOT_PROBES = new Set(['run.ts', 'shared.ts']);
const names = readdirSync(here).filter((f) => f.endsWith('.ts') && !NOT_PROBES.has(f)).map((f) => f.slice(0, -3)).sort();
const name = process.argv[2]?.trim() ?? '';

if (!names.includes(name)) {
  console.log(name ? `No probe called "${name}".` : 'Which probe?');
  for (const n of names) {
    const m = await import(join(here, `${n}.ts`)) as { WHAT?: string };
    console.log(`  ${n}  ${m.WHAT ?? ''}`);
  }
  console.log('Run one with: npm run synology:probe -- <name>');
  process.exit(name ? 1 : 0);
}

const probe = await import(join(here, `${name}.ts`)) as { WHAT: string; run: (sid: string) => Promise<void> };
const { user, pass } = account();
console.log(`${probe.WHAT}\nSigning in to ${DSM_URL} as ${user}.`);
const sid = await signIn(user, pass);
try {
  await probe.run(sid);
} finally {
  await dsm({ api: 'SYNO.API.Auth', version: AUTH_VERSION, method: 'logout', sid }).catch(() => undefined);
  console.log('Signed out.');
}
