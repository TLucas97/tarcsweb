import { execFile } from 'node:child_process';
import { opendir, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Dir } from './protocol.ts';

const run = promisify(execFile);
const MAX_DIRS = 400;
const LOOKUPS = 12;
const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

// One git process per folder per TTL; lists of folders ask for the same ones again and again.
const BRANCH_TTL_MS = 30_000;
const BRANCHES_MAX = 500;
const branches = new Map<string, { at: number; branch: Promise<string | null> }>();

// fresh skips the TTL (a turn end, right after a possible checkout) but shares a lookup under FRESH_MS old.
const FRESH_MS = 1000;
export function gitBranch(cwd: string, timeout = 2000, fresh = false) {
  const hit = branches.get(cwd);
  if (hit && Date.now() - hit.at < (fresh ? FRESH_MS : BRANCH_TTL_MS)) return hit.branch;
  branches.delete(cwd);
  if (branches.size >= BRANCHES_MAX) branches.delete(branches.keys().next().value!);
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout }).then(
    ({ stdout }) => {
      const b = stdout.trim();
      return b && b !== 'HEAD' ? b : null;
    },
    () => null,
  );
  branches.set(cwd, { at: Date.now(), branch });
  return branch;
}

export async function isDir(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function expand(path: string) {
  const p = path.trim();
  return resolve(p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);
}

const visible = (name: string) => !name.startsWith('.') && name !== 'node_modules';
const dirEntry = async (parent: string, d: Dirent) => visible(d.name) && (d.isDirectory() || (d.isSymbolicLink() && (await isDir(join(parent, d.name)))));

// Stops at the first subfolder, so a huge folder costs one read.
export async function hasSubdirs(path: string) {
  try {
    for await (const d of await opendir(path)) if (await dirEntry(path, d)) return true;
  } catch {}
  return false;
}

async function isRepo(path: string) {
  try {
    await stat(join(path, '.git'));
    return true;
  } catch {
    return false;
  }
}

// Runs fn over items with at most `limit` in flight, keeping order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Subfolders only, never files; hidden folders and node_modules are skipped.
export async function listDirs(input: string): Promise<{ path: string; branch: string | null; dirs: Dir[] }> {
  const path = expand(input);
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? `No such folder: ${input}` : code === 'ENOTDIR' ? `Not a folder: ${input}` : code === 'EACCES' ? `No permission to read ${input}` : String(err));
  }
  const keep = await Promise.all(entries.map((d) => dirEntry(path, d)));
  const names = entries.filter((_, i) => keep[i]).map((d) => d.name).sort(byName).slice(0, MAX_DIRS);
  const [branch, dirs] = await Promise.all([
    gitBranch(path, 800),
    mapLimit(names, LOOKUPS, async (name) => {
      const full = join(path, name);
      const [repo, hasChildren] = await Promise.all([isRepo(full), hasSubdirs(full)]);
      return { name, path: full, branch: repo ? await gitBranch(full, 800) : null, hasChildren };
    }),
  ]);
  return { path, branch, dirs };
}

const FIND_DEPTH = 5;
const FIND_MAX = 30;
const FIND_VISITS = 6000;
const FIND_MS = 600;

// Folders under home whose name contains the query, shallow ones first; capped in depth, count and time.
// "area" finds "Área": case and accents are ignored.
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export async function findDirs(query: string): Promise<Dir[]> {
  const q = fold(query.trim());
  if (!q) return [];
  const hits: string[] = [];
  const until = Date.now() + FIND_MS;
  let level = [homedir()];
  let visits = 0;
  for (let depth = 0; depth < FIND_DEPTH && level.length && hits.length < FIND_MAX; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (Date.now() > until || visits++ > FIND_VISITS) break;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of entries) {
        if (!d.isDirectory() || !visible(d.name)) continue;
        const full = join(dir, d.name);
        if (fold(d.name).includes(q) && hits.length < FIND_MAX) hits.push(full);
        next.push(full);
      }
    }
    level = next;
  }
  return mapLimit(hits, LOOKUPS, async (path) => {
    const [repo, hasChildren] = await Promise.all([isRepo(path), hasSubdirs(path)]);
    return { name: path.split('/').pop()!, path, branch: repo ? await gitBranch(path, 800) : null, hasChildren };
  });
}
