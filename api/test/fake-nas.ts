// api/test/fake-nas.ts
//
// Not a test file: a fake NAS for the tests that talk to DSM and Drive. It
// starts the fake DSM on a free port with alice, bob and carol (`admins` names
// those in DSM's administrators group; none by default), and hands back
// `via`, a fetch that sends any DSM or Drive URL to it whatever origin the URL
// names, so `DSM_URL` need not be set before src/ is imported. `via` records
// each call, and can be told to answer a refusal in place of the fake.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start } from '../tools/fake-dsm/server.ts';
import type { FakeDsm } from '../tools/fake-dsm/server.ts';
import type { DsmFetch } from '../src/synology.ts';

export interface FakeNas {
  nas: FakeDsm; via: DsmFetch;
  calls: { method: string; path: string }[];          // path = pathname, or `entry.cgi:<api>.<method>`
  signIn(who: string): Promise<string>;                // accounts alice, bob, carol, password 'pw'
  fail(when: (method: string, path: string) => boolean, code: number): void;  // answer success:false with code
  ok(): void;
  close(): Promise<void>;
}

const PASSWORD = 'pw';

/** The api and method of a WebAPI call: in the query for a download, else a form or multipart field. */
function apiOf(url: URL, body: unknown): string {
  if (url.searchParams.has('api')) return `${url.searchParams.get('api')}.${url.searchParams.get('method') ?? ''}`;
  const text = typeof body === 'string' ? body
    : body instanceof Uint8Array ? Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('latin1')
      : '';
  const part = (name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(text)?.[1];
  const form = new URLSearchParams(text);
  return `${part('api') ?? form.get('api') ?? ''}.${part('method') ?? form.get('method') ?? ''}`;
}

export async function fakeNas(o: {
  teamFolders?: readonly string[]; admins?: readonly string[];
  /** Account → the Team Folders it may only read. */
  readOnly?: Readonly<Record<string, readonly string[]>>;
} = {}): Promise<FakeNas> {
  const root = await mkdtemp(join(tmpdir(), 'pb-fake-nas-'));
  const admins = o.admins ?? [];
  const nas = await start({
    port: 0, root, log: () => {},
    accounts: Object.fromEntries(['alice', 'bob', 'carol'].map((name) =>
      [name, { password: PASSWORD, admin: admins.includes(name) }])),
    ...(o.teamFolders ? { teamFolders: o.teamFolders } : {}),
    ...(o.readOnly ? { readOnly: o.readOnly } : {}),
  });
  const origin = `http://127.0.0.1:${nas.port}`;
  const calls: { method: string; path: string }[] = [];
  let failing: { when: (method: string, path: string) => boolean; code: number }[] = [];

  const via: DsmFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // DSM_URL may be unset, which leaves src/ asking for a path with no origin.
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const path = url.pathname === '/webapi/entry.cgi' ? `entry.cgi:${apiOf(url, init?.body)}` : url.pathname;
    calls.push({ method, path });
    const refusal = failing.find((f) => f.when(method, path));
    if (refusal) return Response.json({ success: false, error: { code: refusal.code } });
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  }) as DsmFetch;

  return {
    nas, via, calls,
    signIn: async (who) => {
      const res = await fetch(`${origin}/webapi/entry.cgi`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ api: 'SYNO.API.Auth', version: '6', method: 'login', account: who, passwd: PASSWORD }).toString(),
      });
      const body = await res.json() as { success: boolean; data?: { sid?: string }; error?: { code?: number } };
      if (!body.success || !body.data?.sid) throw new Error(`fake NAS: ${who} could not sign in (code ${body.error?.code ?? '?'})`);
      return body.data.sid;
    },
    fail: (when, code) => { failing.push({ when, code }); },
    ok: () => { failing = []; },
    close: async () => {
      await nas.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
