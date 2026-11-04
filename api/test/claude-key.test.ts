import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeAnthropic } from './fake-anthropic.ts';

const fake = await fakeAnthropic();
process.env['ANTHROPIC_BASE_URL'] = fake.url;
delete process.env['ANTHROPIC_API_KEY'];
delete process.env['ANTHROPIC_AUTH_TOKEN'];
const { claudeConfigured, classify, testClaude } = await import('../src/claude.ts');
const { saveConnector, loadConnectors, claudeHealth } = await import('../src/connectors.ts');
loadConnectors(join(await mkdtemp(join(tmpdir(), 'pb-claude-')), 'connectors.json'));
const SCHEMA = { type: 'object', additionalProperties: false, required: ['matches'], properties: { matches: { type: 'array' } } };

describe('the Claude key', () => {
  test('a base URL alone is not a key: Claude is off, and the briefing falls back', () => {
    assert.equal(claudeConfigured(), false);
  });
  test('a key saved on This NAS is used by the next call, and a new one by the call after, without a restart', async () => {
    await saveConnector('claude', { value: 'sk-one' }, 'carol');
    assert.equal(claudeConfigured(), true);
    await classify('claude-haiku-5-5', 'sys', 'x', SCHEMA);
    await saveConnector('claude', { value: 'sk-two' }, 'carol');
    await classify('claude-haiku-5-5', 'sys', 'x', SCHEMA);
    assert.deepEqual(fake.keys.slice(-2), ['sk-one', 'sk-two']);
  });
  test('off beats the deployment; clear brings the deployment back', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-env';
    await saveConnector('claude', { off: true }, 'carol');
    assert.equal(claudeConfigured(), false);
    await saveConnector('claude', { clear: true }, 'carol');
    await classify('claude-haiku-5-5', 'sys', 'x', SCHEMA);
    assert.equal(fake.keys.at(-1), 'sk-env');
    delete process.env['ANTHROPIC_API_KEY'];
  });
  test('a 401 from a live call is remembered, and Test says the key is no good, never the key', async () => {
    await saveConnector('claude', { value: 'sk-revoked' }, 'carol');
    fake.answer = 401;
    await assert.rejects(() => classify('claude-haiku-5-5', 'sys', 'x', SCHEMA));
    assert.notEqual(claudeHealth().rejectedAt, null);
    const t = await testClaude();
    assert.deepEqual(t, { ok: false, words: 'the key has expired or been revoked' });
    fake.answer = 'ok';
    assert.deepEqual(await testClaude(), { ok: true, words: 'Claude answered' });
    assert.equal(claudeHealth().rejectedAt, null);
  });
});
after(() => fake.close());
