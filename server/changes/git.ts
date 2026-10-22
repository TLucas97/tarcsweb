import { execFile } from 'node:child_process';
import { join } from 'node:path';

// Git facts for the changes no file tool made; every call is async, bounded and cached per folder.
const TIMEOUT_MS = 4000;
const ROOT_TTL_MS = 60_000;
const STATUS_TTL_MS = 1500;
const CACHE_MAX = 200;
const OUT_MAX = 2_000_000;
// Status entries looked at per scan.
export const STATUS_MAX = 2000;

const git = (cwd: string, args: string[]) =>
  new Promise<string | null>((done) =>
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], { timeout: TIMEOUT_MS, maxBuffer: OUT_MAX, encoding: 'utf8' }, (err, out) => done(err ? null : out)),
  );

function cached<T>(map: Map<string, { at: number; v: Promise<T> }>, key: string, ttl: number, make: () => Promise<T>) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  map.delete(key);
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value!);
  const v = make();
  map.set(key, { at: Date.now(), v });
  return v;
}

const roots = new Map<string, { at: number; v: Promise<string | null> }>();
export const repoRoot = (cwd: string) => cached(roots, cwd, ROOT_TTL_MS, async () => (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim() || null);

// Absolute path to its two-letter porcelain code; untracked folders (a trailing slash) are left out.
const statuses = new Map<string, { at: number; v: Promise<Map<string, string> | null> }>();
export const status = (root: string) =>
  cached(statuses, root, STATUS_TTL_MS, async () => {
    const out = await git(root, ['status', '--porcelain', '-z', '--untracked-files=normal']);
    if (out === null) return null;
    const map = new Map<string, string>();
    const parts = out.split('\u0000');
    for (let i = 0; i < parts.length && map.size < STATUS_MAX; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      const code = e.slice(0, 2);
      // A rename or copy is followed by its old path.
      if (code[0] === 'R' || code[0] === 'C') i++;
      if (code === '!!' || e.endsWith('/')) continue;
      map.set(join(root, e.slice(3)), code);
    }
    return map;
  });

// Lines added and removed against HEAD, per absolute path; binary files are left out.
export async function numstat(root: string, paths: string[]) {
  const map = new Map<string, [number, number]>();
  if (!paths.length) return map;
  const args = ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', 'HEAD', '--', ...paths];
  const out = (await git(root, args)) ?? (await git(root, args.filter((a) => a !== 'HEAD')));
  for (const e of (out ?? '').split('\u0000')) {
    const m = /^(\d+)\t(\d+)\t(.+)$/s.exec(e);
    if (m) map.set(join(root, m[3]), [Number(m[1]), Number(m[2])]);
  }
  return map;
}

// The unified diff of one file against HEAD, null when git has none.
export async function fileDiff(root: string, path: string) {
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', 'HEAD', '--', path];
  return (await git(root, args)) ?? (await git(root, args.filter((a) => a !== 'HEAD')));
}
