// api/src/sign.ts
//
// Signing the calendar profile with the NAS's own certificate, so iOS shows it
// as Verified rather than "Not Signed" in red.
//
// The certificate, its key and the chain are copies on the data volume, put
// there by a DSM scheduled task (DEPLOY.md, Signing the calendar profile). The
// app never reads the private key: it checks the file can be read and hands its
// path to the openssl CLI, so the key cannot reach a log line, an error or a
// file the app writes. The certificate is public, and is read here only to say
// whose it is and until when.
//
// Signing is a nicety. Anything that goes wrong here leaves the profile
// unsigned, never undelivered.
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export type SigningStatus =
  | { readonly signed: true; readonly signedAs: string; readonly validTo: string }
  | { readonly signed: false; readonly reason: 'no-directory' | 'no-certificate' | 'unreadable' | 'expired' | 'invalid' };

/** Paths to the files openssl signs with, and what the certificate says of itself. */
export interface Signer {
  readonly cert: string;
  readonly key: string;
  readonly chain: string | null;
  readonly signedAs: string;
  readonly validTo: string;
}

type Unsigned = Extract<SigningStatus, { signed: false }>['reason'];
const off = (reason: Unsigned): { signer: null; status: SigningStatus } => ({ signer: null, status: { signed: false, reason } });

/** Whether a file can be read: 'missing' and 'unreadable' are different advice to whoever set up the copy. */
async function readable(path: string): Promise<'ok' | 'missing' | 'unreadable'> {
  try {
    await access(path, constants.R_OK);
    return 'ok';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

/**
 * The name a phone sees the profile signed by: the certificate's first DNS
 * name, which is what a Let's Encrypt certificate is issued for, else its
 * common name.
 */
function signerName(cert: X509Certificate): string {
  const dns = /(?:^|,\s*)DNS:([^,\s]+)/.exec(cert.subjectAltName ?? '')?.[1];
  if (dns) return dns;
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1]?.trim();
  return cn || 'the certificate';
}

/** Reads cert.pem, privkey.pem and (optionally) chain.pem from `dir`; never throws. */
export async function loadSigner(dir: string | undefined, now: () => number = Date.now):
  Promise<{ signer: Signer | null; status: SigningStatus }> {
  try {
    if (!dir) return off('no-directory');
    try {
      if (!(await stat(dir)).isDirectory()) return off('no-directory');
    } catch {
      return off('no-directory');
    }
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'privkey.pem');
    const chainPath = join(dir, 'chain.pem');
    const certState = await readable(cert);
    const keyState = await readable(key);
    if (certState === 'missing' || keyState === 'missing') return off('no-certificate');
    if (certState === 'unreadable' || keyState === 'unreadable') return off('unreadable');

    let x509: X509Certificate;
    try {
      x509 = new X509Certificate(await readFile(cert));
    } catch {
      return off('invalid');
    }
    const until = Date.parse(x509.validTo);
    if (!Number.isFinite(until)) return off('invalid');
    if (until <= now()) return off('expired');

    const validTo = new Date(until).toISOString();
    const signedAs = signerName(x509);
    const chain = (await readable(chainPath)) === 'ok' ? chainPath : null;
    return { signer: { cert, key, chain, signedAs, validTo }, status: { signed: true, signedAs, validTo } };
  } catch {
    // Nothing above should throw, but a status line must never take the page down.
    return off('unreadable');
  }
}

/**
 * The first line openssl wrote to stderr, as the reason it gave. A line that
 * looks like PEM is dropped, so even an openssl that echoed a file could not
 * put a key into a log line.
 */
function opensslReason(stderr: string): string {
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.includes('-----'));
  return (line ?? 'no reason given').slice(0, 200);
}

/** `openssl smime -sign … -nodetach -outform DER`, the XML on stdin, DER on stdout. Rejects on any openssl failure. */
export function signProfile(xml: string, signer: Signer): Promise<Buffer> {
  const args = [
    'smime', '-sign', '-signer', signer.cert, '-inkey', signer.key,
    ...(signer.chain ? ['-certfile', signer.chain] : []),
    '-nodetach', '-outform', 'DER',
  ];
  return new Promise((resolve, reject) => {
    const child = execFile('openssl', args, { encoding: 'buffer', maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const why = code === 'ENOENT' ? 'openssl is not installed' : opensslReason(stderr.toString('utf8'));
        reject(new Error(`openssl could not sign the profile: ${why}`));
        return;
      }
      if (stdout.length === 0) {
        reject(new Error('openssl could not sign the profile: it wrote nothing'));
        return;
      }
      resolve(stdout);
    });
    // A child that dies before reading its input closes the pipe; the
    // callback above already says why, so the write error is not news.
    child.stdin?.on('error', () => {});
    child.stdin?.end(xml);
  });
}

/** The signed DER when the directory yields a signer and openssl succeeds, else the XML; one console.warn line on an openssl failure, naming the reason and never a file's contents. */
export async function signedOrPlain(xml: string, dir: string | undefined): Promise<Buffer | string> {
  const { signer } = await loadSigner(dir);
  if (!signer) return xml;
  try {
    return await signProfile(xml, signer);
  } catch (err) {
    console.warn(`[budget] profile signing failed, sending it unsigned: ${(err as Error).message}`);
    return xml;
  }
}
