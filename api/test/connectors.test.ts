import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectors, loadConnectors, resetConnectors, resolvedEnv, saveConnector, sourceOf, recordTest, lastSavedBy,
} from '../src/connectors.ts';

let path = '';
beforeEach(async () => { resetConnectors(); path = join(await mkdtemp(join(tmpdir(), 'pb-conn-')), 'connectors.json'); });
const MAIL = { host: 'mail.example.com', port: 587, user: 'robot', pass: 'hunter2-long', from: 'house@example.com', plainAuth: false };

describe('connectors.json', () => {
  test('a saved value is written over the deployment, an off deletes it, a clear brings it back', async () => {
    loadConnectors(path);
    const env = { DSM_PUBLIC_URL: 'https://env.example.com', ANTHROPIC_AUTH_TOKEN: 'tok' };
    assert.equal(sourceOf('publicUrl', env), 'from the deployment');
    await saveConnector('publicUrl', { value: 'https://nas.example.com:5001' }, 'carol');
    assert.equal(resolvedEnv(env)['DSM_PUBLIC_URL'], 'https://nas.example.com:5001');
    assert.equal(sourceOf('publicUrl', env), 'saved');
    await saveConnector('publicUrl', { off: true }, 'carol');
    assert.equal(resolvedEnv(env)['DSM_PUBLIC_URL'], undefined);
    assert.equal(sourceOf('publicUrl', env), 'off');
    await saveConnector('publicUrl', { clear: true }, 'carol');
    assert.equal(resolvedEnv(env)['DSM_PUBLIC_URL'], 'https://env.example.com');
    assert.equal(sourceOf('census', {}), 'default');
  });
  test('a saved Claude key wins over the deployment token; mail fills every SMTP variable', async () => {
    loadConnectors(path);
    await saveConnector('claude', { value: 'sk-saved' }, 'carol');
    await saveConnector('mail', { value: { ...MAIL, plainAuth: true } }, 'carol');
    const env = resolvedEnv({ ANTHROPIC_AUTH_TOKEN: 'tok' });
    assert.equal(env['ANTHROPIC_API_KEY'], 'sk-saved');
    assert.equal(env['ANTHROPIC_AUTH_TOKEN'], undefined);
    assert.deepEqual([env['SMTP_HOST'], env['SMTP_PORT'], env['SMTP_PLAIN_AUTH']], ['mail.example.com', '587', '1']);
  });
  test('the file is 0600, written whole, and holds no old password and no .tmp afterwards', async () => {
    loadConnectors(path);
    await saveConnector('mail', { value: MAIL }, 'carol');
    await saveConnector('mail', { value: { ...MAIL, pass: 'correct-horse-2' } }, 'carol');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, /hunter2-long/);
    assert.deepEqual((await readdir(join(path, '..'))).sort(), ['connectors.json']);
  });
  test('a file that does not parse is reported, ignored and left as it was', async () => {
    await writeFile(path, '{ not json');
    const { problems } = loadConnectors(path);
    assert.equal(problems.length, 1);
    assert.deepEqual(connectors(), { version: 1 });
    assert.equal(await readFile(path, 'utf8'), '{ not json');
  });
  test('a key of the wrong shape is ignored, the rest kept', async () => {   // Review Focus 1
    await writeFile(path, JSON.stringify({ version: 1,
      signIn: { value: 'alice', by: 'carol', at: '2026-11-02T00:00:00Z' },
      bookUrl: { value: 'https://book.example.com', by: 'carol', at: '2026-11-02T00:00:00Z' } }));
    const { problems } = loadConnectors(path);
    assert.match(problems.join(' '), /signIn/);
    assert.equal(connectors().signIn, undefined);
    assert.equal(resolvedEnv({ ALLOWED_USERS: 'alice,bob' })['ALLOWED_USERS'], 'alice,bob');
    assert.equal(resolvedEnv({})['BOOK_URL'], 'https://book.example.com');
  });
  test('who may sign in saved as off in the file is ignored, so sign-in still works', async () => {
    await writeFile(path, JSON.stringify({ version: 1,
      signIn: { off: true, by: 'carol', at: '2026-11-02T00:00:00Z' },
      bookUrl: { value: 'https://book.example.com', by: 'carol', at: '2026-11-02T00:00:00Z' } }));
    const { problems } = loadConnectors(path);
    assert.equal(problems.length, 1);
    assert.match(problems.join(' '), /signIn/);
    assert.equal(connectors().signIn, undefined);
    assert.equal(resolvedEnv({ ALLOWED_USERS: 'alice,bob' })['ALLOWED_USERS'], 'alice,bob');
    assert.equal(sourceOf('signIn', { ALLOWED_USERS: 'alice,bob' }), 'from the deployment');
    assert.equal(resolvedEnv({})['BOOK_URL'], 'https://book.example.com');
  });
  test('a test result or a probe of the wrong shape is dropped and named, the rest kept', async () => {
    const at = '2026-11-02T00:00:00Z';
    await writeFile(path, JSON.stringify({ version: 1,
      census: { value: 'k', by: 'carol', at },
      mailTest: { at, to: 'me@example.com', ok: 'yes', words: 'sent' },
      claudeTest: { at, ok: true, words: 'worked', worked: 7 },
      probed: { contactsVersion: { version: '2', min: 1, max: 3, at } } }));
    const { problems } = loadConnectors(path);
    assert.equal(problems.length, 3);
    for (const key of ['mailTest', 'claudeTest', 'probed']) assert.match(problems.join(' '), new RegExp(key));
    assert.deepEqual(connectors(), { version: 1, census: { value: 'k', by: 'carol', at } });
  });
  test('who may sign in is never off', async () => {
    loadConnectors(path);
    await assert.rejects(() => saveConnector('signIn', { off: true }, 'carol'), /cannot be off/);
  });
  test('a clear forgets its test; the last to save is named', async () => {
    loadConnectors(path);
    await saveConnector('mail', { value: MAIL }, 'carol', new Date('2026-11-01T00:00:00Z'));
    await recordTest('mailTest', { at: '2026-11-01T00:00:01Z', to: 'me@example.com', ok: true, words: 'sent' });
    await saveConnector('census', { value: 'k' }, 'dave', new Date('2026-11-02T00:00:00Z'));
    assert.equal(lastSavedBy(), 'dave');
    await saveConnector('mail', { clear: true }, 'carol');
    assert.equal(connectors().mailTest, undefined);
  });
  test('before a file is named, saves stay in memory and nothing is written', async () => {
    await saveConnector('census', { value: 'k' }, 'carol');
    assert.equal(resolvedEnv({})['CENSUS_API_KEY'], 'k');
    await assert.rejects(() => stat(path));
  });
});
