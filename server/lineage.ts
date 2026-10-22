import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from './config.ts';
import { LIVE_SERVER, tmpName } from './workspace.ts';

// Test servers share the cache dir, so like the workspace manifest only the live server reads or writes it.
const FILE = join(CACHE_DIR, 'branches.json');
const MAX = 500;
const WRITE_MS = 1000;
const VERSION = 1;

// A git worktree tarcsweb made for a branch: its folder, the repo it belongs to, and the branch checked out there.
export type Worktree = { path: string; repo: string; branch: string };

// One branch made here, keyed by the fork's transcript id; parent is the source transcript, at the message it was cut after.
export type Lineage = { child: string; parent: string; parentName: string; name: string; at: string; worktree: Worktree | null; createdAt: number };

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;

function worktreeOf(v: unknown): Worktree | null {
  const w = v as Record<string, unknown> | null;
  return w && typeof w === 'object' && str(w.path) && str(w.repo) && str(w.branch) ? { path: w.path, repo: w.repo, branch: w.branch } : null;
}

function lineageOf(v: unknown): Lineage | null {
  const l = v as Record<string, unknown> | null;
  if (!l || typeof l !== 'object' || !str(l.child) || !str(l.parent) || !str(l.parentName) || !str(l.name) || !str(l.at)) return null;
  return {
    child: l.child, parent: l.parent, parentName: l.parentName, name: l.name, at: l.at, worktree: worktreeOf(l.worktree),
    createdAt: typeof l.createdAt === 'number' ? l.createdAt : 0,
  };
}

// Which tab was branched from which, kept at CACHE_DIR/branches.json (capped at MAX, oldest out) so it survives a restart.
export class LineageStore {
  private byChild = new Map<string, Lineage>();
  private kids = new Map<string, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;

  constructor() {
    if (!LIVE_SERVER) return;
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as { version?: unknown; branches?: unknown };
      if (raw.version !== VERSION || !Array.isArray(raw.branches)) return;
      for (const v of raw.branches.slice(-MAX)) {
        const l = lineageOf(v);
        if (l) this.put(l);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.log(`lineage: ${FILE} is unreadable, starting empty (${(err as Error).message})`);
    }
  }

  of(child: string | null) {
    return child ? this.byChild.get(child) : undefined;
  }

  childrenOf(parent: string | null): Lineage[] {
    const ids = parent ? this.kids.get(parent) : undefined;
    return ids ? [...ids].flatMap((id) => this.byChild.get(id) ?? []) : [];
  }

  add(l: Lineage) {
    this.put(l);
    while (this.byChild.size > MAX) this.forget(this.byChild.keys().next().value!, false);
    this.changed();
  }

  // Keeps the saved names of closed tabs in step with a rename.
  rename(id: string, name: string) {
    let hit = false;
    const own = this.byChild.get(id);
    if (own) {
      own.name = name;
      hit = true;
    }
    for (const l of this.childrenOf(id)) {
      l.parentName = name;
      hit = true;
    }
    if (hit) this.changed();
  }

  forget(child: string, save = true) {
    const l = this.byChild.get(child);
    if (!l) return;
    this.byChild.delete(child);
    const set = this.kids.get(l.parent);
    set?.delete(child);
    if (set && !set.size) this.kids.delete(l.parent);
    if (save) this.changed();
  }

  private put(l: Lineage) {
    this.byChild.delete(l.child);
    this.byChild.set(l.child, l);
    let set = this.kids.get(l.parent);
    if (!set) this.kids.set(l.parent, (set = new Set()));
    set.add(l.child);
  }

  private json() {
    return JSON.stringify({ version: VERSION, branches: [...this.byChild.values()] });
  }

  // At shutdown: anything changed this run goes out now, and async writes still in flight never land over it.
  final() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    const tmp = tmpName(FILE);
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(tmp, this.json());
      renameSync(tmp, FILE);
    } catch (err) {
      rmSync(tmp, { force: true });
      console.log(`lineage: saving at shutdown failed (${(err as Error).message})`);
    }
  }

  private changed() {
    if (!LIVE_SERVER || this.closed || this.timer) return;
    this.dirty = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      const text = this.json();
      const tmp = tmpName(FILE);
      this.writing = this.writing
        .then(() => mkdir(CACHE_DIR, { recursive: true }))
        .then(() => writeFile(tmp, text))
        .then(() => (this.closed ? rm(tmp, { force: true }) : rename(tmp, FILE)))
        .catch(async (err) => {
          await rm(tmp, { force: true });
          console.log(`lineage: saving failed (${(err as Error).message})`);
        });
    }, WRITE_MS);
    this.timer.unref();
  }
}
