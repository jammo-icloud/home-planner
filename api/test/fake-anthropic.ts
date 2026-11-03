import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeAnthropic { url: string; keys: string[]; answer: 'ok' | 401; close(): Promise<void> }

/** An HTTP server for POST /v1/messages: records x-api-key (or the bearer token), answers a one-text-block message or a 401. */
export async function fakeAnthropic(): Promise<FakeAnthropic> {
  const fake: FakeAnthropic = { url: '', keys: [], answer: 'ok', close: async () => {} };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const bearer = String(req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
      fake.keys.push(String(req.headers['x-api-key'] ?? bearer));
      res.setHeader('content-type', 'application/json');
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
        return;
      }
      if (fake.answer === 401) {
        res.statusCode = 401;
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      let model = 'claude-haiku-5-5';
      try { model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model ?? model; } catch { /* the body is only echoed */ }
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: '{"matches":[]}' }],
        stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return fake;
}
