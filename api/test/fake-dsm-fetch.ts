// api/test/fake-dsm-fetch.ts
//
// Not a test file: shared by the tests that talk to a stubbed DSM. It lives
// apart from synology.test.ts so importing it does not register those tests
// a second time.

/** DSM, stubbed, in the shape auth.test.ts already uses. */
/** A reply to give back: a value, or a function that picks the value on each call. */
export const fakeDsm = (reply: unknown, opts: { status?: number; notJson?: boolean } = {}) => {
  const calls: { url: string; body: string; method: string; headers: Headers }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? ''), method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    return {
      ok: true, status: opts.status ?? 200,
      headers: new Headers({ 'content-type': opts.notJson ? 'text/html' : 'application/json' }),
      json: async () => { if (opts.notJson) throw new SyntaxError('nope'); return typeof reply === 'function' ? reply() : reply; },
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
};

/** DSM, stubbed, answering `replies` in order (the last one again if there are more calls). */
export const fakeDsmSeq = (replies: unknown[]) => {
  let i = 0;
  return fakeDsm(() => replies[Math.min(i++, replies.length - 1)]);
};
