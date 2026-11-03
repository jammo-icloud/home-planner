/**
 * Sending one plain-text email, by speaking SMTP ourselves.
 *
 * Synology has no API for sending mail, so the app talks to whatever the owner
 * points it at (MailPlus on the NAS, or an external relay) the way any mail
 * client does: EHLO, STARTTLS where offered, AUTH PLAIN when there is a login,
 * then MAIL FROM, RCPT TO, DATA, QUIT. No dependency: `node:net` and `node:tls`
 * are enough for one short message.
 *
 * Every reply is checked against the code the step expects. Anything else, a
 * refused recipient (550) included, is a `MailError` carrying the server's own
 * words in `reply`, so the caller can treat it as a failed send and show why.
 * Nothing here logs: the password and the message body go on the wire and
 * nowhere else.
 */

import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type { Socket } from 'node:net';
import tls from 'node:tls';

/**
 * The mail server settings. Declared here, not imported from `booking.ts`, because
 * this file was written before that one existed; `BookingConfig['smtp']` is this
 * shape, and `booking.ts` can import the name from here.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  /** Empty means the server needs no login. */
  user: string;
  pass: string;
  from: string;
  /**
   * STARTTLS and port 465 verify the server's certificate against its name. A NAS
   * with its default self-signed certificate fails that check, by design: the
   * owner should give the NAS a Let's Encrypt certificate, or use an external
   * relay (Task 1 documents it).
   *
   * Send the password over a connection that is not TLS. Off unless the owner says
   * so: Task 1 wires it from `SMTP_PLAIN_AUTH=1`, for a relay on the NAS itself.
   */
  allowPlainAuth?: boolean;
}

/*
 * Two things this does not do, because the booking emails are short plain text:
 * it sends `Content-Transfer-Encoding: 8bit` without checking that the server
 * advertised 8BITMIME, and it does not fold body lines longer than 998
 * characters (the SMTP limit).
 */
export interface Mail { to: string; subject: string; text: string }

export interface SendOptions {
  /**
   * How to reach the server. The tests use this to hand in a plain `net`
   * connection to an in-process fake. A socket from here is used as it comes: on
   * 465 it is taken to be TLS already, so STARTTLS is not attempted on it (as with
   * the default connection); on any other port STARTTLS is negotiated on it when
   * the server offers it.
   */
  connect?: (host: string, port: number) => Promise<Socket>;
  /** How long to wait for the connection and for each reply. Default 15 s. */
  timeoutMs?: number;
}

/** What went wrong in the conversation. `reply` is the server's whole reply (or our one-line account of why there was none). */
export class MailError extends Error {
  readonly reply: string;
  /** The server had the whole message and then said nothing, or hung up: it may have gone after all. */
  readonly uncertain: boolean;
  constructor(reply: string, uncertain = false) {
    super(reply);
    this.name = 'MailError';
    this.reply = reply;
    this.uncertain = uncertain;
  }
}

const TIMEOUT_MS = 15_000;
const IMPLICIT_TLS_PORT = 465;
const CRLF = '\r\n';
/** The most reply text we will hold, buffered or queued. A server has no reason to send more. */
const MAX_REPLY_BYTES = 64 * 1024;

interface Reply { code: string; text: string }

/** Reads a socket as SMTP replies: whole replies, multi-line ones (`250-…` then `250 …`) joined. */
class Wire {
  readonly socket: Socket;
  private readonly label: string;
  private readonly timeoutMs: number;
  private readonly clean: (text: string) => string;
  private buf = '';
  private pending: string[] = [];
  private pendingCode = '';
  private pendingLen = 0;
  private readyLen = 0;
  private ready: Reply[] = [];
  private failure: MailError | null = null;
  private waiter: { resolve: (r: Reply) => void; reject: (e: MailError) => void; timer: NodeJS.Timeout } | null = null;

  private readonly onData = (chunk: string): void => {
    if (this.failure) return;
    this.buf += chunk;
    for (;;) {
      if (this.buf.length + this.pendingLen + this.readyLen > MAX_REPLY_BYTES) { this.fail(new MailError(`${this.label} sent too long a reply`)); return; }
      const eol = this.buf.indexOf('\n');
      if (eol < 0) return;
      const line = this.buf.slice(0, eol).replace(/\r$/, '');
      this.buf = this.buf.slice(eol + 1);
      this.pending.push(line);
      this.pendingLen += line.length;
      const m = /^(\d{3})([ -]|$)/.exec(line);
      // Not a reply line at all, or a continuation under a different code than the first line's.
      if (!m || (this.pendingCode && m[1] !== this.pendingCode)) { this.fail(new MailError(this.clean(this.pending.join('\n')))); return; }
      this.pendingCode = m[1]!;
      if (m[2] !== '-') {
        const text = this.pending.join('\n');
        this.ready.push({ code: m[1]!, text });
        this.readyLen += text.length;
        this.pendingLen = 0;
        this.pending = [];
        this.pendingCode = '';
        this.settle();
      }
    }
  };
  private readonly onError = (e: Error): void => this.fail(new MailError(`${this.label}: ${e.message}`));
  private readonly onClose = (): void => this.fail(new MailError(`${this.label} closed the connection`));

  constructor(socket: Socket, label: string, timeoutMs: number, clean: (text: string) => string) {
    this.socket = socket;
    this.clean = clean;
    this.label = label;
    this.timeoutMs = timeoutMs;
    socket.setEncoding('utf8');
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  /** Stop listening, before the socket is handed to TLS. */
  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    // An error on the old socket after this must not be an unhandled 'error' event.
    this.socket.on('error', () => {});
  }

  private fail(e: MailError): void {
    this.failure ??= e;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(this.failure);
    }
  }

  private settle(): void {
    if (this.waiter && this.ready.length) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(this.take());
    }
  }

  private take(): Reply {
    const r = this.ready.shift()!;
    this.readyLen -= r.text.length;
    return r;
  }

  read(): Promise<Reply> {
    if (this.ready.length) return Promise.resolve(this.take());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new MailError(`${this.label} did not answer`)), this.timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  write(line: string): void {
    this.socket.write(line);
  }

  /** Send a command line and require the reply to carry `code`. */
  async command(line: string, code: string): Promise<Reply> {
    this.write(line + CRLF);
    return this.expect(code);
  }

  async expect(code: string): Promise<Reply> {
    const r = await this.read();
    if (r.code !== code) throw new MailError(this.clean(r.text));
    return r;
  }
}

/** The default way in: TCP, or TLS from the first byte on 465. */
function dial(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const label = `${host}:${port}`;
    const implicit = port === IMPLICIT_TLS_PORT;
    const s: Socket = implicit ? tls.connect({ host, port, ...serverName(host) }) : net.connect({ host, port });
    const done = (settle: () => void): void => { clearTimeout(timer); s.off('error', onError); settle(); };
    const timer = setTimeout(() => { s.destroy(); done(() => reject(new MailError(`${label} did not answer`))); }, timeoutMs);
    const onError = (e: Error): void => { s.destroy(); done(() => reject(new MailError(`${label}: ${e.message}`))); };
    s.once(implicit ? 'secureConnect' : 'connect', () => done(() => resolve(s)));
    s.on('error', onError);
  });
}

/** `servername` is for names; given an IP address Node warns and ignores it. */
function serverName(host: string): { servername?: string } {
  return net.isIP(host) ? {} : { servername: host };
}

/** Wait for a TLS handshake on a socket we handed to `tls.connect`. */
function secure(plain: Socket, host: string, label: string, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const t = tls.connect({ socket: plain, ...serverName(host) });
    const done = (settle: () => void): void => { clearTimeout(timer); t.off('error', onError); settle(); };
    const timer = setTimeout(() => { t.destroy(); done(() => reject(new MailError(`${label} did not answer`))); }, timeoutMs);
    const onError = (e: Error): void => { t.destroy(); done(() => reject(new MailError(`${label}: ${e.message}`))); };
    t.once('secureConnect', () => done(() => resolve(t)));
    t.on('error', onError);
  });
}

// ---- the message ----------------------------------------------------------

/** Header values never carry a line break: that is how a header gets injected. */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, '');

/**
 * An address we are willing to put in a command line: one `@`, nothing that
 * could end the command or start another, at most 254 characters. The guest
 * list takes none this refuses (types.ts isEmail).
 */
function addressOf(a: string): string {
  if (a.length > 254 || !/^[^\s<>"\\@,;()]+@[^\s<>"\\@,;()]+$/.test(a)) throw new MailError(`"${oneLine(a).slice(0, 80)}" is not an email address`);
  return a;
}

/**
 * Wipes the login out of text that comes back from the server before it becomes an
 * error. Some servers answer a command they do not understand by quoting it, and
 * the AUTH line is the password in base64. The three-digit code at the start of
 * each line is kept, so a password of "5" cannot eat the "550".
 */
function redactor(cfg: SmtpConfig): (text: string) => string {
  const secrets = [authToken(cfg), cfg.pass].filter((x) => x.length > 0);
  return (text) => text.split('\n').map((line) => {
    const head = /^\d{3}[ -]?/.exec(line)?.[0] ?? '';
    let rest = line.slice(head.length);
    for (const secret of secrets) rest = rest.split(secret).join('[redacted]');
    return head + rest;
  }).join('\n');
}

/** What follows `AUTH PLAIN `: the login, base64. Empty when there is no login. */
const authToken = (cfg: SmtpConfig): string =>
  cfg.user ? Buffer.from(`\0${cfg.user}\0${cfg.pass}`, 'utf8').toString('base64') : '';

const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1);

/** Plain printable ASCII goes as it is; anything else as RFC 2047 encoded words of at most 75 characters, folded; a code point is never split. */
function encodeWords(subject: string): string {
  if (!/[^\x20-\x7e]/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = '';
  const flush = (): void => { if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`); chunk = ''; };
  for (const ch of subject) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) flush();
    chunk += ch;
  }
  flush();
  return words.join(CRLF + ' ');
}

/** `Thu, 29 Oct 2026 10:00:00 +0000` (RFC 5322). */
function dateHeader(now: Date): string {
  return now.toUTCString().replace(/ GMT$/, ' +0000');
}

/** CRLF line endings, a leading dot doubled, and a final CRLF so the terminator starts its own line. */
function bodyOf(text: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, '\n').replace(/\n$/, '').split('\n');
  return lines.map((l) => (l.startsWith('.') ? '.' + l : l)).join(CRLF) + CRLF;
}

function messageOf(cfg: SmtpConfig, m: Mail, displayName: string): string {
  const plain = oneLine(displayName).replace(/"/g, '');
  // An ASCII name is a quoted string; any other must be an encoded phrase, which cannot sit inside quotes.
  const name = /[^\x20-\x7e]/.test(plain) ? encodeWords(plain) : `"${plain.replace(/\\/g, '\\\\')}"`;
  const headers = [
    `From: ${name} <${cfg.from}>`,
    `To: ${m.to}`,
    `Subject: ${encodeWords(oneLine(m.subject))}`,
    `Date: ${dateHeader(new Date())}`,
    `Message-ID: <${randomUUID()}@${domainOf(cfg.from)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return headers.join(CRLF) + CRLF + CRLF + bodyOf(m.text) + '.' + CRLF;
}

// ---- the conversation -----------------------------------------------------

export async function sendMail(cfg: SmtpConfig, m: Mail, displayName: string, opts: SendOptions = {}): Promise<void> {
  // Checked before anything is dialled: these two go into command lines.
  const from = addressOf(cfg.from);
  const to = addressOf(m.to);
  const message = messageOf({ ...cfg, from }, { ...m, to }, displayName);

  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const label = `${cfg.host}:${cfg.port}`;
  const clean = redactor(cfg);
  const sockets: Socket[] = [];
  try {
    const first = await (opts.connect ? opts.connect(cfg.host, cfg.port) : dial(cfg.host, cfg.port, timeoutMs));
    sockets.push(first);
    let wire = new Wire(first, label, timeoutMs, clean);
    await wire.expect('220');

    // The name we give the server is the domain we send as: a real, dotted name, and nothing about this machine.
    const ehlo = `EHLO ${domainOf(from)}`;
    const caps = (await wire.command(ehlo, '250')).text;

    let encrypted = cfg.port === IMPLICIT_TLS_PORT;
    if (!encrypted && /^250[ -]STARTTLS\s*$/im.test(caps)) {
      await wire.command('STARTTLS', '220');
      wire.detach();
      const upgraded = await secure(wire.socket, cfg.host, label, timeoutMs);
      sockets.push(upgraded);
      wire = new Wire(upgraded, label, timeoutMs, clean);
      await wire.command(ehlo, '250');
      encrypted = true;
    }

    if (cfg.user && !encrypted && cfg.allowPlainAuth !== true) {
      // Hang up politely, then refuse: the password never leaves this process.
      // Not awaited: a server that never answers must not hold up the error.
      wire.write('QUIT' + CRLF);
      throw new MailError(`${label} offers no TLS; set SMTP_PLAIN_AUTH=1 only if this relay is on the NAS itself`);
    }
    if (cfg.user) {
      await wire.command(`AUTH PLAIN ${authToken(cfg)}`, '235');
    }
    await wire.command(`MAIL FROM:<${from}>`, '250');
    await wire.command(`RCPT TO:<${to}>`, '250');
    await wire.command('DATA', '354');
    wire.write(message);
    // The message is on the wire. Silence or a hang-up now is not a refusal:
    // the server may have taken it, so the error says it may not have gone.
    // A reply that is not 250 is a refusal of the message, in its own words.
    let accepted: Reply;
    try {
      accepted = await wire.read();
    } catch (err) {
      const why = err instanceof MailError ? err.reply : (err as Error)?.message ?? String(err);
      throw new MailError(`${why} once it had the message, so it may not have gone`, true);
    }
    if (accepted.code !== '250') throw new MailError(clean(accepted.text));
    // The message is accepted. Whatever QUIT meets now, the mail was sent and must not be reported as failed.
    await wire.command('QUIT', '221').catch(() => {});
  } finally {
    for (const s of sockets) s.destroy();
  }
}
