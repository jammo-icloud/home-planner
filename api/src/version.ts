/**
 * Which software is running: the package version, and the commit it was built
 * from when that can be known. Settings shows it and /api/health answers it,
 * so the owner can tell whether a rebuild on the NAS picked up a push.
 *
 * An image carries version.json, written by the Dockerfile's first stage from
 * the build's own checkout. A checkout run with `npm start` has none, so the
 * commit is read from .git directly: no child process, and so no git needed on
 * the machine. Every read is allowed to fail. A missing or odd file gives
 * nulls, because the version line must never be why the app does not start.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SoftwareVersion {
  name: 'Home Planner';
  version: string;
  commit: string | null;
  commitDate: string | null;
  builtAt: string | null;
}

/** The text of a file, or null for any reason it cannot be read. */
function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function readJson(path: string): unknown {
  const text = readText(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const SHA = /^[0-9a-f]{40}$/;
/** Short, as git shows it by default. */
const short = (sha: string | null): string | null => (sha ? sha.slice(0, 7) : null);

/**
 * The .git directory for a checkout at `top`. In a worktree .git is a file
 * saying `gitdir: <path>`, the path relative to the worktree when it is not
 * absolute.
 */
function gitDirOf(top: string): string | null {
  const dotGit = join(top, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
  } catch { return null; }
  const line = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? '')?.[1]?.trim();
  if (!line) return null;
  return isAbsolute(line) ? line : resolve(top, line);
}

/** The sha a ref names, loose or packed, looked for in each directory in turn. */
function resolveRef(ref: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const loose = readText(join(dir, ref))?.trim() ?? '';
    if (SHA.test(loose)) return loose;
  }
  for (const dir of dirs) {
    for (const line of (readText(join(dir, 'packed-refs')) ?? '').split('\n')) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha && SHA.test(sha)) return sha;
    }
  }
  return null;
}

/** The full sha HEAD points at in the checkout at `top`, or null. */
export function headCommit(top: string): string | null {
  const gitDir = gitDirOf(top);
  if (!gitDir) return null;
  const head = readText(join(gitDir, 'HEAD'))?.trim() ?? '';
  // Detached: HEAD is the sha itself.
  if (SHA.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return null;
  // A worktree keeps its own HEAD but shares branches with the main checkout,
  // which its commondir file names.
  const common = readText(join(gitDir, 'commondir'))?.trim();
  const dirs = common ? [gitDir, isAbsolute(common) ? common : resolve(gitDir, common)] : [gitDir];
  return resolveRef(ref, dirs);
}

/**
 * The version for the package at `root` (the directory holding package.json).
 * version.json, when there is one, is what the image was built from; without
 * it the package and the checkout above it are read.
 */
export function readVersion(root: string, versionPath = join(root, 'version.json')): SoftwareVersion {
  const pkg = readJson(join(root, 'package.json')) as { version?: unknown } | null;
  const pkgVersion = str(pkg?.version) ?? 'unknown';
  const built = readJson(versionPath) as Record<string, unknown> | null;
  if (built && typeof built === 'object') {
    return {
      name: 'Home Planner',
      version: str(built['version']) ?? pkgVersion,
      commit: short(str(built['commit'])),
      commitDate: str(built['commitDate']),
      builtAt: str(built['builtAt']),
    };
  }
  let commit: string | null = null;
  try { commit = short(headCommit(dirname(root))); } catch { commit = null; }
  return { name: 'Home Planner', version: pkgVersion, commit, commitDate: null, builtAt: null };
}

// api/, one up from src/. In the image that is /app, where version.json is copied.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CURRENT = readVersion(PACKAGE_ROOT, process.env['VERSION_PATH'] || join(PACKAGE_ROOT, 'version.json'));

/** What is running, read once when the server loads. */
export function softwareVersion(): SoftwareVersion {
  return { ...CURRENT };
}
