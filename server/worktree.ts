import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { CACHE_DIR } from './config.ts';
import { isDir } from './dirs.ts';
import type { Worktree } from './lineage.ts';

const run = promisify(execFile);
// Branch worktrees live only here; tarcsweb never removes one anywhere else.
export const WORKTREES = join(CACHE_DIR, 'worktrees');
const GIT_MS = 15_000;
// A checkout of a large repo takes a while.
const ADD_MS = 120_000;

const git = (cwd: string, args: string[], timeout = GIT_MS) => run('git', args, { cwd, timeout, maxBuffer: 8 << 20 }).then((r) => r.stdout.trim());
const errText = (e: unknown) => ((e as { stderr?: string }).stderr?.trim() || (e instanceof Error ? e.message : String(e))).split('\n')[0];

// The repo a folder sits in: its top level, the HEAD commit, and the folder's path inside it; null outside git.
export async function repoOf(cwd: string) {
  try {
    const [top, head, real] = await Promise.all([git(cwd, ['rev-parse', '--show-toplevel']), git(cwd, ['rev-parse', '--verify', 'HEAD']), realpath(cwd)]);
    const sub = relative(await realpath(top), real);
    return { top, head, sub: sub.startsWith('..') ? '' : sub };
  } catch {
    return null;
  }
}

// /tmp is RAM on some machines, so a worktree there would eat memory and vanish on reboot.
async function root() {
  await mkdir(WORKTREES, { recursive: true });
  const real = await realpath(WORKTREES);
  const tmps = new Set(['/tmp', '/dev/shm', await realpath(tmpdir()).catch(() => tmpdir())]);
  if ([...tmps].some((t) => real === t || real.startsWith(t + sep))) throw new Error(`The worktree folder ${real} is in temporary memory; set CW_CACHE to a folder on disk.`);
  return real;
}

// A new worktree on a new branch at the source's HEAD; uncommitted changes stay behind. cwd keeps the source's subfolder.
export async function addWorktree(cwd: string, short: string): Promise<{ worktree: Worktree; cwd: string }> {
  const repo = await repoOf(cwd);
  if (!repo) throw new Error('This folder is not in a git repository with a commit.');
  const base = await root();
  const name = basename(repo.top).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'repo';
  const path = join(base, `${name}-${short}`);
  const branch = `tarcsweb/branch-${short}`;
  try {
    await git(repo.top, ['worktree', 'add', '-b', branch, path, repo.head], ADD_MS);
  } catch (e) {
    throw new Error(`git worktree add failed: ${errText(e)}`);
  }
  const inner = repo.sub ? join(path, repo.sub) : path;
  return { worktree: { path, repo: repo.top, branch }, cwd: (await isDir(inner)) ? inner : path };
}

// Only a direct child of WORKTREES counts, checked on real paths so a symlink cannot point it elsewhere.
async function managed(path: string) {
  const [base, real] = await Promise.all([realpath(WORKTREES).catch(() => null), realpath(path).catch(() => null)]);
  return !!base && !!real && dirname(real) === base;
}

// Why the worktree cannot be removed, or null when it can.
export async function blockedRemove(w: Worktree): Promise<string | null> {
  if (!(await isDir(w.path))) return null;
  if (!(await managed(w.path))) return `${w.path} is not a worktree tarcsweb made, so it was left alone.`;
  try {
    if (await git(w.path, ['status', '--porcelain'])) return `${w.path} has uncommitted changes, so it was kept.`;
  } catch (e) {
    return `Could not check ${w.path}: ${errText(e)}`;
  }
  return null;
}

// Without --force, git itself also refuses a dirty worktree. The branch stays, since it may hold commits.
export async function removeWorktree(w: Worktree) {
  const why = await blockedRemove(w);
  if (why) throw new Error(why);
  if (!(await isDir(w.path))) return;
  try {
    await git(w.repo, ['worktree', 'remove', w.path]);
  } catch (e) {
    throw new Error(`git worktree remove failed: ${errText(e)}`);
  }
}

// Undo for a worktree made moments ago that nothing used: the fresh branch goes too (-d, so only if it has no new commits).
export async function dropFreshWorktree(w: Worktree) {
  await removeWorktree(w);
  await git(w.repo, ['branch', '-d', w.branch]).catch(() => {});
}
