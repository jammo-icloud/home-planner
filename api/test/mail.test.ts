// api/test/mail.test.ts
//
// The SMTP side of booking: sendMail speaks to an in-process fake server over a
// plain `net` connection handed in through `opts.connect`. That is also why TLS
// (STARTTLS, implicit TLS on 465) is not exercised here: a plain socket cannot be
// upgraded without certificates. What is tested for STARTTLS is that it is asked
// for, and that a refusal is an error rather than a quiet fall back to clear text.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';

import { sendMail, MailError, type SmtpConfig } from '../src/mail.ts';

interface Fake {
  port: number;
  commands: string[];   // every command line the client sent, in order, DATA body excluded
  data: string[];       // the DATA payload(s), exactly as received, terminator included
  close(): Promise<void>;
}

interface Script {
  greeting?: string | null;            // null: accept the connection and say nothing
  ehlo?: string[];                     // lines of the EHLO reply, without the code
  ehloRaw?: string;                    // the EHLO reply, written as it is
  quit?: string | null;                // full reply to QUIT; null: say nothing
  rcpt?: string;                       // full reply to RCPT TO
  auth?: string | ((line: string) => string);  // full reply to AUTH
  starttls?: string;                   // full reply to STARTTLS
  afterData?: string | null | 'hang up'; // full reply once the message is in; null: say nothing; 'hang up': close
}

async function fakeSmtp(script: Script = {}): Promise<Fake> {
  const commands: string[] = [];
  const data: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    sock.setEncoding('utf8');
    if (script.greeting !== null) sock.write(`${script.greeting ?? '220 fake ESMTP ready'}\r\n`);
    let buf = '';
    let inData = false;
    sock.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data.push(buf.slice(0, end + 5));
          buf = buf.slice(end + 5);
          inData = false;
          if (script.afterData === 'hang up') { sock.destroy(); return; }
          if (script.afterData !== null) sock.write(`${script.afterData ?? '250 queued'}\r\n`);
          continue;
        }
        const eol = buf.indexOf('\r\n');
        if (eol < 0) return;
        const line = buf.slice(0, eol);
        buf = buf.slice(eol + 2);
        commands.push(line);
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO' && script.ehloRaw !== undefined) sock.write(script.ehloRaw);
        else if (verb === 'EHLO') {
          const lines = script.ehlo ?? ['fake', '8BITMIME'];
          sock.write(lines.map((l, i) => `250${i < lines.length - 1 ? '-' : ' '}${l}`).join('\r\n') + '\r\n');
        } else if (verb === 'STARTTLS') sock.write(`${script.starttls ?? '220 go ahead'}\r\n`);
        else if (verb === 'AUTH') sock.write(`${typeof script.auth === 'function' ? script.auth(line) : (script.auth ?? '235 2.7.0 welcome')}\r\n`);
        else if (verb === 'MAIL') sock.write('250 ok\r\n');
        else if (verb === 'RCPT') sock.write(`${script.rcpt ?? '250 ok'}\r\n`);
        else if (verb === 'DATA') { sock.write('354 go on\r\n'); inData = true; }
        else if (verb === 'QUIT') { if (script.quit !== null) sock.write(`${script.quit ?? '221 bye'}\r\n`); sock.end(); }
        else sock.write('500 what\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, commands, data,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

const cfgFor = (f: Fake, over: Partial<SmtpConfig> = {}): SmtpConfig =>
  ({ host: 'mail.example.test', port: f.port, user: '', pass: '', from: 'house@example.com', ...over });

// Hand sendMail a plain connection to the fake, whatever host and port the config names.
const toFake = (f: Fake) => ({
  connect: async (): Promise<net.Socket> => {
    const s = net.connect(f.port, '127.0.0.1');
    await once(s, 'connect');
    return s;
  },
});

async function sawQuit(f: Fake): Promise<void> {
  for (let i = 0; i < 100 && !f.commands.includes('QUIT'); i++) await new Promise((r) => setTimeout(r, 10));
}

const mail = { to: 'guest@example.com', subject: 'Your booking', text: 'See you Friday.' };

async function withFake(script: Script, fn: (f: Fake) => Promise<void>): Promise<void> {
  const f = await fakeSmtp(script);
  try { await fn(f); } finally { await f.close(); }
}

describe('sending mail', () => {
  test('a plain conversation: EHLO, MAIL, RCPT, DATA, the message, QUIT', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), mail, 'The Smiths', toFake(f));
      assert.match(f.commands[0]!, /^EHLO \S+$/);
      assert.deepEqual(f.commands.slice(1), [
        'MAIL FROM:<house@example.com>',
        'RCPT TO:<guest@example.com>',
        'DATA',
        'QUIT',
      ]);
      assert.equal(f.data.length, 1);
      assert.ok(f.data[0]!.endsWith('\r\n.\r\n'), 'the body ends with CRLF . CRLF');
    });
  });

  test('the headers', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), mail, 'The Smiths', toFake(f));
      const [head, body] = f.data[0]!.split('\r\n\r\n');
      const lines = head!.split('\r\n');
      assert.ok(lines.includes('From: "The Smiths" <house@example.com>'));
      assert.ok(lines.includes('To: guest@example.com'));
      assert.ok(lines.includes('Subject: Your booking'));
      assert.ok(lines.includes('MIME-Version: 1.0'));
      assert.ok(lines.includes('Content-Type: text/plain; charset=utf-8'));
      assert.ok(lines.includes('Content-Transfer-Encoding: 8bit'));
      assert.ok(lines.some((l) => /^Date: \w{3}, \d{1,2} \w{3} \d{4} \d\d:\d\d:\d\d [+-]\d{4}$/.test(l)), lines.join('|'));
      assert.ok(lines.some((l) => /^Message-ID: <[0-9a-f-]{36}@example\.com>$/.test(l)));
      assert.equal(body, 'See you Friday.\r\n.\r\n');
    });
  });

  test('a multi-line EHLO reply is read to its last line', async () => {
    await withFake({ ehlo: ['fake', 'PIPELINING', 'SIZE 10240000', '8BITMIME'] }, async (f) => {
      await sendMail(cfgFor(f), mail, 'The Smiths', toFake(f));
      assert.equal(f.commands.length, 5);
    });
  });

  test('a body line that starts with a dot arrives dot-stuffed, with CRLF line endings', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), { ...mail, text: 'one\n.two\r\n..three\rfour' }, 'The Smiths', toFake(f));
      const body = f.data[0]!.split('\r\n\r\n')[1];
      assert.equal(body, 'one\r\n..two\r\n...three\r\nfour\r\n.\r\n');
    });
  });

  test('a body that already ends in a newline does not grow a blank line', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), { ...mail, text: 'hello\n' }, 'The Smiths', toFake(f));
      assert.equal(f.data[0]!.split('\r\n\r\n')[1], 'hello\r\n.\r\n');
    });
  });

  test('the server accepts the connection and refuses the recipient: a MailError carrying the 550 line', async () => {
    await withFake({ rcpt: '550 5.1.1 <guest@example.com> no such user' }, async (f) => {
      await assert.rejects(sendMail(cfgFor(f), mail, 'The Smiths', toFake(f)), (e: unknown) => {
        assert.ok(e instanceof MailError);
        assert.match(e.reply, /550/);
        assert.match(e.reply, /no such user/);
        return true;
      });
      assert.ok(!f.commands.includes('DATA'), 'nothing is sent after the refusal');
    });
  });

  test('a multi-line refusal carries every line of it', async () => {
    await withFake({ rcpt: '550-5.7.1 relay denied\r\n550 5.7.1 see policy' }, async (f) => {
      await assert.rejects(sendMail(cfgFor(f), mail, 'The Smiths', toFake(f)), (e: unknown) => {
        assert.ok(e instanceof MailError);
        assert.match(e.reply, /relay denied/);
        assert.match(e.reply, /see policy/);
        return true;
      });
    });
  });

  test('a greeting that is not 220 is an error', async () => {
    await withFake({ greeting: '554 no service here' }, async (f) => {
      await assert.rejects(sendMail(cfgFor(f), mail, 'The Smiths', toFake(f)), /554 no service here/);
    });
  });

  test('with a user set, AUTH PLAIN is sent as base64 of NUL user NUL pass, and 235 is expected', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f, { user: 'house', pass: 's3cret', allowPlainAuth: true }), mail, 'The Smiths', toFake(f));
      const auth = f.commands.find((c) => c.startsWith('AUTH'))!;
      assert.equal(auth, `AUTH PLAIN ${Buffer.from('\0house\0s3cret').toString('base64')}`);
      assert.ok(f.commands.indexOf(auth) < f.commands.indexOf('MAIL FROM:<house@example.com>'));
    });
  });

  test('with no user, AUTH is not attempted', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), mail, 'The Smiths', toFake(f));
      assert.ok(!f.commands.some((c) => c.startsWith('AUTH')));
    });
  });

  test('a refused login is a MailError, and the password is not in it', async () => {
    await withFake({ auth: '535 5.7.8 bad credentials' }, async (f) => {
      await assert.rejects(sendMail(cfgFor(f, { user: 'house', pass: 's3cret', allowPlainAuth: true }), mail, 'The Smiths', toFake(f)), (e: unknown) => {
        assert.ok(e instanceof MailError);
        assert.match(e.reply, /535/);
        assert.doesNotMatch(String(e) + e.reply, /s3cret/);
        return true;
      });
      assert.ok(!f.commands.includes('DATA'));
    });
  });

  test('a server that offers STARTTLS is asked for it, and a refusal is an error, not a fall back to clear text', async () => {
    await withFake({ ehlo: ['fake', 'STARTTLS'], starttls: '454 TLS not available now' }, async (f) => {
      await assert.rejects(
        sendMail(cfgFor(f, { user: 'house', pass: 's3cret', allowPlainAuth: true }), mail, 'The Smiths', toFake(f)),
        (e: unknown) => e instanceof MailError && /454/.test(e.reply),
      );
      assert.deepEqual(f.commands.map((c) => c.split(' ')[0]), ['EHLO', 'STARTTLS']);
    });
  });

  test('no TLS on offer and a login set: the password is not sent, the connection is closed with QUIT, and the error says why', async () => {
    await withFake({}, async (f) => {
      await assert.rejects(
        sendMail(cfgFor(f, { user: 'house', pass: 's3cret', port: 587 }), mail, 'The Smiths', toFake(f)),
        (e: unknown) => {
          assert.ok(e instanceof MailError);
          assert.equal(e.reply, 'mail.example.test:587 offers no TLS; set SMTP_PLAIN_AUTH=1 only if this relay is on the NAS itself');
          assert.doesNotMatch(e.reply, /s3cret/);
          return true;
        },
      );
      assert.ok(!f.commands.some((c) => c.startsWith('AUTH')), 'no AUTH line');
      await sawQuit(f); // the QUIT is sent without being waited for
      assert.deepEqual(f.commands.map((c) => c.split(' ')[0]), ['EHLO', 'QUIT']);
    });
  });

  test('allowPlainAuth: true lets AUTH go ahead without TLS', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f, { user: 'house', pass: 's3cret', allowPlainAuth: true }), mail, 'The Smiths', toFake(f));
      assert.ok(f.commands.some((c) => c.startsWith('AUTH PLAIN ')));
    });
  });

  test('allowPlainAuth: false is the same as unset', async () => {
    await withFake({}, async (f) => {
      await assert.rejects(sendMail(cfgFor(f, { user: 'house', pass: 'x', allowPlainAuth: false }), mail, 'The Smiths', toFake(f)), /offers no TLS/);
    });
  });

  test('on 465 the connection is taken to be TLS already, so a login needs no flag', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f, { user: 'house', pass: 's3cret', port: 465 }), mail, 'The Smiths', toFake(f));
      assert.ok(f.commands.some((c) => c.startsWith('AUTH PLAIN ')));
    });
  });

  test('with no user there is no AUTH and no complaint about TLS', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f, { port: 587 }), mail, 'The Smiths', toFake(f));
      assert.ok(!f.commands.some((c) => c.startsWith('AUTH')));
    });
  });

  test('a subject with an accent is sent RFC 2047 encoded', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), { ...mail, subject: 'Réservation confirmée' }, 'The Smiths', toFake(f));
      const head = f.data[0]!.split('\r\n\r\n')[0]!;
      const m = head.match(/^Subject: (=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)$/m);
      assert.ok(m, head);
      assert.equal(Buffer.from(m![1]!.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'), 'Réservation confirmée');
    });
  });

  test('a long non-ASCII subject is split into encoded words that each fit a line, and decodes whole', async () => {
    await withFake({}, async (f) => {
      const subject = 'Réservation confirmée pour la maison ' + 'é'.repeat(60);
      await sendMail(cfgFor(f), { ...mail, subject }, 'The Smiths', toFake(f));
      const head = f.data[0]!.split('\r\n\r\n')[0]!;
      const block = head.match(/Subject: [^]*?(?=\r\n[A-Z][\w-]*:|$)/)![0];
      const words = block.replace(/^Subject: /, '').split('\r\n ');
      assert.ok(words.length > 1);
      let decoded = '';
      for (const w of words) {
        assert.ok(w.length <= 75, w);
        const mm = w.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
        assert.ok(mm, w);
        decoded += Buffer.from(mm![1]!, 'base64').toString('utf8');
      }
      assert.equal(decoded, subject);
    });
  });

  test('a display name with a quote and a newline is sanitised, and cannot inject a header', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), mail, 'The "Smiths"\r\nBcc: evil@example.net', toFake(f));
      const head = f.data[0]!.split('\r\n\r\n')[0]!;
      const lines = head.split('\r\n');
      assert.ok(lines.includes('From: "The SmithsBcc: evil@example.net" <house@example.com>'), head);
      assert.ok(!lines.some((l) => l.startsWith('Bcc:')));
    });
  });

  test('a subject with CR or LF cannot inject a header', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), { ...mail, subject: 'Hi\r\nBcc: evil@example.net' }, 'The Smiths', toFake(f));
      const lines = f.data[0]!.split('\r\n\r\n')[0]!.split('\r\n');
      assert.ok(lines.includes('Subject: HiBcc: evil@example.net'));
      assert.ok(!lines.some((l) => l.startsWith('Bcc:')));
    });
  });

  test('a server that quotes the AUTH line back: neither the password nor its base64 is in the error', async () => {
    const pass = 's3cret-pass';
    const token = Buffer.from(`\0house\0${pass}`).toString('base64');
    for (const reply of [
      (line: string) => `500 5.5.1 Command unrecognized: "${line}"`,
      () => `535 5.7.8 rejected ${pass} for house`,
      () => `535-5.7.8 tried ${token}\r\n535 5.7.8 done`,
    ]) {
      await withFake({ auth: reply }, async (f) => {
        await assert.rejects(sendMail(cfgFor(f, { user: 'house', pass, allowPlainAuth: true }), mail, 'The Smiths', toFake(f)), (e: unknown) => {
          assert.ok(e instanceof MailError);
          for (const text of [e.reply, e.message, String(e)]) {
            assert.ok(!text.includes(pass), text);
            assert.ok(!text.includes(token), text);
          }
          assert.match(e.reply, /^5\d\d/);
          assert.match(e.reply, /\[redacted\]/);
          return true;
        });
      });
    }
  });

  test('a one-character password does not eat the reply code', async () => {
    await withFake({ auth: '535 5.7.8 not 5' }, async (f) => {
      await assert.rejects(sendMail(cfgFor(f, { user: 'house', pass: '5', allowPlainAuth: true }), mail, 'The Smiths', toFake(f)),
        (e: unknown) => e instanceof MailError && e.reply.startsWith('535 ') && !/ 5$/.test(e.reply));
    });
  });

  test('once the message is accepted, a QUIT that fails does not make the send a failure', async () => {
    await withFake({ quit: '421 shutting down' }, async (f) => {
      await sendMail(cfgFor(f), mail, 'The Smiths', toFake(f));
      assert.equal(f.data.length, 1);
    });
    await withFake({ quit: null }, async (f) => {
      await sendMail(cfgFor(f), mail, 'The Smiths', { ...toFake(f), timeoutMs: 50 });
      assert.equal(f.data.length, 1);
    });
  });

  test('the plain-auth refusal does not wait for QUIT to be answered', async () => {
    await withFake({ quit: null }, async (f) => {
      const t0 = Date.now();
      await assert.rejects(sendMail(cfgFor(f, { user: 'house', pass: 'x' }), mail, 'The Smiths', { ...toFake(f), timeoutMs: 5000 }), /offers no TLS/);
      assert.ok(Date.now() - t0 < 1000, 'the error is not held up by a silent server');
      await sawQuit(f);
      assert.ok(f.commands.includes('QUIT'), 'QUIT was still sent');
    });
  });

  test('a continuation line under a different code than the first is an error', async () => {
    await withFake({ ehloRaw: '250-fake\r\n550 oh no\r\n' }, async (f) => {
      await assert.rejects(sendMail(cfgFor(f), mail, 'The Smiths', toFake(f)), (e: unknown) => e instanceof MailError && /550 oh no/.test(e.reply));
    });
  });

  test('a reply that never ends (250- with no last line) hits the timeout', async () => {
    await withFake({ ehloRaw: '250-fake\r\n250-more\r\n' }, async (f) => {
      await assert.rejects(sendMail(cfgFor(f, { port: 25 }), mail, 'The Smiths', { ...toFake(f), timeoutMs: 50 }), /mail\.example\.test:25 did not answer/);
    });
  });

  test('a reply bigger than 64 KiB is cut off, with or without a line break', async () => {
    await withFake({ ehloRaw: '250 ' + 'x'.repeat(100_000) }, async (f) => {
      await assert.rejects(sendMail(cfgFor(f), mail, 'The Smiths', toFake(f)), /too long a reply/);
    });
    await withFake({ ehloRaw: '250-' + 'x'.repeat(70_000) + '\r\n250 y\r\n' }, async (f) => {
      await assert.rejects(sendMail(cfgFor(f), mail, 'The Smiths', toFake(f)), /too long a reply/);
    });
  });

  test('a first body line that starts with a dot is stuffed too', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), { ...mail, text: '.hidden\nnext' }, 'The Smiths', toFake(f));
      assert.equal(f.data[0]!.split('\r\n\r\n')[1], '..hidden\r\nnext\r\n.\r\n');
    });
  });

  test('a non-ASCII display name is an encoded phrase, not a quoted string', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), mail, 'Maison Dupré "chez nous"', toFake(f));
      const head = f.data[0]!.split('\r\n\r\n')[0]!;
      const m = head.match(/^From: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?= <house@example\.com>$/m);
      assert.ok(m, head);
      assert.equal(Buffer.from(m![1]!, 'base64').toString('utf8'), 'Maison Dupré chez nous');
    });
  });

  test('a backslash in an ASCII display name is escaped inside the quotes', async () => {
    await withFake({}, async (f) => {
      await sendMail(cfgFor(f), mail, 'A\\B', toFake(f));
      assert.ok(f.data[0]!.split('\r\n\r\n')[0]!.split('\r\n').includes('From: "A\\\\B" <house@example.com>'));
    });
  });

  test('a recipient that is not a plain address never reaches the wire', async () => {
    await withFake({}, async (f) => {
      for (const to of ['guest@example.com>\r\nRCPT TO:<evil@example.net', 'no-at-sign', 'a b@example.com', 'a,b@example.com', 'a@example.com;b@example.com', '(x)@example.com', '']) {
        await assert.rejects(sendMail(cfgFor(f), { ...mail, to }, 'The Smiths', toFake(f)), MailError);
      }
      assert.deepEqual(f.commands, []);
    });
  });

  test('a server that never answers is a MailError naming it, and the socket is closed', async () => {
    await withFake({ greeting: null }, async (f) => {
      let sock: net.Socket | undefined;
      const connect = async () => {
        sock = net.connect(f.port, '127.0.0.1');
        await once(sock, 'connect');
        return sock;
      };
      await assert.rejects(
        sendMail(cfgFor(f, { host: 'mail.example.test', port: 25 }), mail, 'The Smiths', { connect, timeoutMs: 50 }),
        /mail\.example\.test:25 did not answer/,
      );
      assert.ok(sock!.destroyed, 'the socket is destroyed');
    });
  });

  test('a server that goes quiet, or hangs up, once it has the message: the error says it may not have gone', async () => {
    for (const afterData of [null, 'hang up'] as const) {
      await withFake({ afterData }, async (f) => {
        await assert.rejects(sendMail(cfgFor(f), mail, 'The Smiths', { ...toFake(f), timeoutMs: 50 }),
          (e: unknown) => e instanceof MailError && /it may not have gone/.test(e.reply) && /mail\.example\.test/.test(e.reply), String(afterData));
        assert.equal(f.data.length, 1, 'the message did reach the server');
      });
    }
    // A refusal of the message itself is a refusal, said as the server said it.
    await withFake({ afterData: '554 5.7.1 message refused' }, async (f) => {
      await assert.rejects(sendMail(cfgFor(f), mail, 'The Smiths', toFake(f)),
        (e: unknown) => e instanceof MailError && e.reply === '554 5.7.1 message refused');
    });
  });

  test('a server that hangs up mid-conversation is a MailError', async () => {
    const server = net.createServer((s) => { s.write('220 hi\r\n'); s.once('data', () => s.destroy()); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as net.AddressInfo).port;
    try {
      await assert.rejects(
        sendMail({ host: 'h.test', port, user: '', pass: '', from: 'a@example.com' }, mail, 'X', {
          connect: async () => { const s = net.connect(port, '127.0.0.1'); await once(s, 'connect'); return s; },
        }),
        MailError,
      );
    } finally { server.close(); }
  });

  test('nothing the conversation logs includes the password or the message', async () => {
    const seen: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { seen.push(a.join(' ')); };
    try {
      await withFake({ rcpt: '550 nope' }, async (f) => {
        await sendMail(cfgFor(f, { user: 'house', pass: 's3cret', allowPlainAuth: true }), mail, 'The Smiths', toFake(f)).catch(() => {});
      });
    } finally { Object.assign(console, orig); }
    assert.deepEqual(seen, []);
  });
});
