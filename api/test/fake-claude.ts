import { setClaudeClient } from '../src/claude.ts';

/**
 * A stand-in for the Anthropic client.
 *
 * Records what it was sent so the tests can assert on the request — the point
 * of most of these is that Claude is handed formatted dollars and a stable
 * cacheable prefix, which is invisible from the response alone.
 */
export class FakeClaude {
  calls: any[] = [];
  #replies: unknown[];
  constructor(replies: unknown[]) { this.#replies = [...replies]; }
  beta = {
    messages: {
      create: async (req: any) => {
        this.calls.push(JSON.parse(JSON.stringify(req)));
        const next = this.#replies.shift();
        if (next instanceof Error) throw next;
        return next as any;
      },
    },
  };
}

export const said = (text: string) => ({
  model: 'claude-opus-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 100, output_tokens: 50 },
});

export const called = (name: string, input: unknown) => ({
  model: 'claude-opus-5', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'tu_1', name, input }],
  usage: { input_tokens: 100, output_tokens: 50 },
});

export const fake = (replies: unknown[]): FakeClaude => {
  const f = new FakeClaude(replies);
  setClaudeClient(f as unknown as never);
  return f;
};

