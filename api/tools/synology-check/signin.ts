/**
 * The check's and the probes' sign-in: the account from the environment, the
 * one-time code from the terminal.
 *
 * `npm run synology:check` and `npm run synology:probe` load
 * `tools/synology-check/.env` when it exists (Node's --env-file-if-exists), so
 * CHECK_USER, CHECK_PASS and DSM_URL can live there instead of on every command
 * line. The file is covered by the repository's `.env` ignore rule; keep it
 * mode 0600, since it holds the password in clear.
 *
 * When DSM wants a one-time code, the code is asked for on the terminal and the
 * sign-in tried again. CHECK_OTP, when set, is used first without asking. The
 * code is never printed back, and neither is the password.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { OtpRequired, checkWithDsm } from '../../src/auth.ts';

export const ENV_FILE = 'tools/synology-check/.env';

/**
 * Node's --env-file never overrides a variable the shell already has, even one
 * exported empty (a `read -rs CHECK_PASS` answered with return, say), and then
 * the file's value is silently lost. So the file is read here too, and fills
 * in every key whose value in the environment is empty or absent. A value the
 * shell set to something still wins.
 */
function fillFromEnvFile(): void {
  let text: string;
  try { text = readFileSync(ENV_FILE, 'utf8'); } catch { return; }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/^[A-Z_][A-Z0-9_]*$/.test(key) && !process.env[key]) process.env[key] = value;
  }
}
fillFromEnvFile();

/** The account the environment names, or a sentence saying what to set. */
export function account(): { user: string; pass: string } {
  const user = process.env['CHECK_USER']?.trim() ?? '';
  const pass = process.env['CHECK_PASS'] ?? '';
  if (!user || !pass) {
    throw new Error(`Set CHECK_USER and CHECK_PASS to a DSM account, in ${ENV_FILE} (see .env.example beside it) or on the command line.`);
  }
  return { user, pass };
}

/** Ask the terminal for the code; null when there is no terminal to ask. */
async function askCode(user: string): Promise<string | null> {
  if (!stdin.isTTY) return null;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const code = (await rl.question(`DSM wants a one-time code for ${user}: `)).trim();
    return code || null;
  } finally {
    rl.close();
  }
}

/**
 * Sign in, asking for a one-time code when DSM wants one. Throws with a plain
 * sentence when the sign-in cannot be completed.
 */
export async function signIn(user: string, pass: string): Promise<string> {
  let otp = process.env['CHECK_OTP']?.trim() || undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await checkWithDsm(user, pass, otp)).sid;
    } catch (err) {
      if (!(err instanceof OtpRequired)) throw err;
      const code = await askCode(user);
      if (!code) {
        throw new Error(`DSM wants a one-time code for ${user}: run this from a terminal, or set CHECK_OTP to the current code.`);
      }
      otp = code;
    }
  }
  throw new Error(`DSM did not accept a one-time code for ${user} after three tries.`);
}
