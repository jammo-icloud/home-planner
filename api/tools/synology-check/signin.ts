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
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { OtpRequired, checkWithDsm } from '../../src/auth.ts';

export const ENV_FILE = 'tools/synology-check/.env';

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
