// api/test/version.test.ts
//
// The version line, read from temp directories laid out as a checkout or an
// image would be: the package in api/, and .git (or nothing) beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readVersion, softwareVersion } from '../src/version.ts';

const SHA = '202134c9e1f0a8b7c6d5e4f3a2b1c0d9e8f7a6b5';
const OTHER = 'abcdef0123456789abcdef0123456789abcdef01';

/** A top directory with api/package.json at 0.1.0; returns both paths. */
async function layout(): Promise<{ top: string; root: string }> {
  const top = await mkdtemp(join(tmpdir(), 'pb-version-'));
  const root = join(top, 'api');
  await mkdir(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }));
  return { top, root };
}

test('version.json, when the image has one, is what is reported', async () => {
  const { root } = await layout();
  await writeFile(join(root, 'version.json'), JSON.stringify({
    version: '0.1.0', commit: '202134c', commitDate: '2026-11-03T19:12:00+00:00', builtAt: '2026-11-03T19:40:00.000Z',
  }));
  assert.deepEqual(readVersion(root), {
    name: 'Home Planner', version: '0.1.0', commit: '202134c',
    commitDate: '2026-11-03T19:12:00+00:00', builtAt: '2026-11-03T19:40:00.000Z',
  });
});

test('version.json written without git gives the version and build time only', async () => {
  const { root } = await layout();
  await writeFile(join(root, 'version.json'), JSON.stringify({ version: '0.1.0', commit: null, commitDate: null, builtAt: '2026-11-03T19:40:00.000Z' }));
  assert.deepEqual(readVersion(root), { name: 'Home Planner', version: '0.1.0', commit: null, commitDate: null, builtAt: '2026-11-03T19:40:00.000Z' });
});

test('VERSION_PATH points somewhere else', async () => {
  const { top, root } = await layout();
  const elsewhere = join(top, 'v.json');
  await writeFile(elsewhere, JSON.stringify({ version: '9.9.9', commit: SHA, commitDate: null, builtAt: null }));
  const v = readVersion(root, elsewhere);
  assert.equal(v.version, '9.9.9');
  assert.equal(v.commit, '202134c');
});

test('with no file, a checkout on a branch gives the branch tip, short', async () => {
  const { top, root } = await layout();
  await mkdir(join(top, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(join(top, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(top, '.git', 'refs', 'heads', 'main'), SHA + '\n');
  assert.deepEqual(readVersion(root), { name: 'Home Planner', version: '0.1.0', commit: '202134c', commitDate: null, builtAt: null });
});

test('a branch that is only in packed-refs is found there', async () => {
  const { top, root } = await layout();
  await mkdir(join(top, '.git'));
  await writeFile(join(top, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(top, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/other\n${SHA} refs/heads/main\n`);
  assert.equal(readVersion(root).commit, '202134c');
});

test('with no file, a detached HEAD is the sha itself', async () => {
  const { top, root } = await layout();
  await mkdir(join(top, '.git'));
  await writeFile(join(top, '.git', 'HEAD'), SHA + '\n');
  assert.equal(readVersion(root).commit, '202134c');
});

test('a worktree follows its gitdir file, and finds the branch in the shared directory', async () => {
  const { top, root } = await layout();
  const main = await mkdtemp(join(tmpdir(), 'pb-version-main-'));
  const wt = join(main, '.git', 'worktrees', 'one');
  await mkdir(wt, { recursive: true });
  await mkdir(join(main, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(join(top, '.git'), `gitdir: ${wt}\n`);
  await writeFile(join(wt, 'HEAD'), 'ref: refs/heads/feature\n');
  await writeFile(join(wt, 'commondir'), '../..\n');
  await writeFile(join(main, '.git', 'refs', 'heads', 'feature'), SHA + '\n');
  assert.equal(readVersion(root).commit, '202134c');
});

test('nothing readable gives nulls and the package version, never a throw', async () => {
  const { top, root } = await layout();
  // A .git that says nothing useful, and a version.json that is not JSON.
  await mkdir(join(top, '.git'));
  await writeFile(join(top, '.git', 'HEAD'), 'ref: refs/heads/gone\n');
  await writeFile(join(root, 'version.json'), '{not json');
  assert.deepEqual(readVersion(root), { name: 'Home Planner', version: '0.1.0', commit: null, commitDate: null, builtAt: null });
});

test('with no package.json at all the version is unknown, not a throw', async () => {
  const top = await mkdtemp(join(tmpdir(), 'pb-version-'));
  assert.deepEqual(readVersion(join(top, 'missing')), { name: 'Home Planner', version: 'unknown', commit: null, commitDate: null, builtAt: null });
});

test('softwareVersion answers for this package', () => {
  const v = softwareVersion();
  assert.equal(v.name, 'Home Planner');
  assert.equal(typeof v.version, 'string');
});
