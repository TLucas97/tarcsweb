import { execFile } from 'node:child_process';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TreeEntry, TreeFile } from './protocol.ts';
import { inside } from './files.ts';

const LIST_MAX = 2000;
// Go to file: the session folder's file list, cached per folder; ignored marks what git ignores there.
const FILES_TTL_MS = 10_000;
const FILES_MAX = 50_000;
const FIND_MAX = 100;
const GIT_MS = 10_000;
const CACHE_MAX = 16;
const IGNORED_WAIT_MS = 300;
// walked: outside git, the folder walk ran; the tree's listings only need git's answer, so they skip it.
type Files = { at: number; paths: string[]; full: boolean; git: boolean; walked: boolean; ignored: Set<string> | null };
const filesCache = new Map<string, Promise<Files>>();

// NUL-separated paths from git ls-files, relative to cwd; null outside a repo or on any failure.
const lsFiles = (cwd: string, args: string[]) =>
  new Promise<string[] | null>((ok) =>
    execFile('git', ['ls-files', '-z', ...args], { cwd, timeout: GIT_MS, maxBuffer: 64 << 20 }, (err, out) => ok(err ? null : String(out).split('\0').filter(Boolean))),
  );

// Outside git: a plain walk that skips dot entries and node_modules, breadth first up to FILES_MAX.
async function walk(root: string) {
  const paths: string[] = [];
  const queue = [''];
  while (queue.length && paths.length < FILES_MAX) {
    const rel = queue.shift()!;
    const ents = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const d of ents) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) queue.push(p);
      else if (paths.push(p) >= FILES_MAX) break;
    }
  }
  return { paths, full: !queue.length && paths.length < FILES_MAX };
}

async function loadFiles(cwd: string, walkToo: boolean): Promise<Files> {
  const [tracked, ignored] = await Promise.all([lsFiles(cwd, ['-co', '--exclude-standard']), lsFiles(cwd, ['-oi', '--exclude-standard', '--directory'])]);
  if (tracked) {
    // --directory lists a wholly ignored folder once, with a trailing slash.
    const ign = ignored && ignored.length <= FILES_MAX ? new Set(ignored.map((p) => p.replace(/\/$/, ''))) : null;
    return { at: Date.now(), paths: tracked.slice(0, FILES_MAX), full: tracked.length <= FILES_MAX, git: true, walked: false, ignored: ign };
  }
  if (!walkToo) return { at: Date.now(), paths: [], full: false, git: false, walked: false, ignored: null };
  return { at: Date.now(), ...(await walk(cwd)), git: false, walked: true, ignored: null };
}

function filesOf(cwd: string, walkToo = false) {
  const hit = filesCache.get(cwd);
  if (hit) return hit.then((f) => (Date.now() - f.at < FILES_TTL_MS && (f.git || f.walked || !walkToo) ? f : refresh(cwd, walkToo)));
  return refresh(cwd, walkToo);
}
function refresh(cwd: string, walkToo: boolean) {
  const p = loadFiles(cwd, walkToo);
  filesCache.delete(cwd);
  filesCache.set(cwd, p);
  if (filesCache.size > CACHE_MAX) filesCache.delete(filesCache.keys().next().value!);
  return p;
}

// Whether git ignores rel (or a folder above it), from the cached list.
function isIgnored(f: Files, rel: string) {
  if (!f.ignored?.size) return false;
  for (let p = rel; p; p = p.slice(0, Math.max(0, p.lastIndexOf('/')))) if (f.ignored.has(p)) return true;
  return false;
}

// Whether t's letters appear in s in order.
function inOrder(s: string, t: string) {
  let i = 0;
  for (const ch of s) if (ch === t[i] && ++i === t.length) return true;
  return false;
}

// Rank: the file name containing the query, then the path containing it, then the letters in order (in the name
// first); shorter wins ties.
function score(path: string, terms: string[]) {
  const low = path.toLowerCase();
  const base = low.slice(low.lastIndexOf('/') + 1);
  let total = 0;
  for (const t of terms) {
    if (base.includes(t)) total += base.startsWith(t) ? 0 : 1;
    else if (low.includes(t)) total += 3;
    else if (inOrder(base, t)) total += 5;
    else if (inOrder(low, t)) total += 7;
    else return -1;
  }
  return total * 1000 + path.length;
}

export async function findTree(cwd: string, query: string): Promise<{ paths: string[]; more: boolean; git: boolean } | { error: string }> {
  try {
    const root = await realpath(cwd);
    const f = await filesOf(root, true);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { paths: [], more: false, git: f.git };
    const hits: [number, string][] = [];
    for (const p of f.paths) {
      const s = score(p, terms);
      if (s >= 0) hits.push([s, p]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    return { paths: hits.slice(0, FIND_MAX).map((h) => h[1]), more: hits.length > FIND_MAX || !f.full, git: f.git };
  } catch (err) {
    return { error: why(err) };
  }
}
// Text above this is not sent at all; the client colors only smaller files.
const READ_MAX = 1 << 20;
const SNIFF = 8000;
const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

// A path the client named, relative to the session folder; null when its name leads outside ("..", absolute).
// Symlinks inside the folder are followed, as the file cards do, so a linked folder on another volume opens too.
async function within(cwd: string, rel: string) {
  if (rel.includes('\0')) return null;
  const root = await realpath(cwd);
  const full = resolve(root, rel);
  return inside(root, full) ? realpath(full) : null;
}

const why = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' ? 'No longer exists' : code === 'EACCES' ? 'No permission to read it' : code === 'ENOTDIR' ? 'Not a folder' : 'Could not read it';
};

export async function listTree(cwd: string, rel: string): Promise<{ entries: TreeEntry[]; more: number } | { error: string }> {
  try {
    const dir = await within(cwd, rel);
    if (!dir) return { error: 'Outside the session folder' };
    // A slow first git listing never holds the folder back; its rows just come undimmed.
    const late = new Promise<null>((ok) => setTimeout(ok, IGNORED_WAIT_MS, null));
    const [raw, files] = await Promise.all([readdir(dir, { withFileTypes: true }), Promise.race([realpath(cwd).then((r) => filesOf(r)), late])]);
    const base = rel.split('/').filter((s) => s && s !== '.').join('/');
    const entries = await Promise.all(
      raw.map(async (d): Promise<TreeEntry> => {
        const link = d.isSymbolicLink();
        const isDir = link ? await stat(join(dir, d.name)).then((s) => s.isDirectory(), () => false) : d.isDirectory();
        const ignored = !!files && isIgnored(files, base ? `${base}/${d.name}` : d.name);
        return { name: d.name, dir: isDir, ...(link ? { link: true } : {}), ...(ignored ? { ignored: true } : {}) };
      }),
    );
    entries.sort((a, b) => (a.dir === b.dir ? byName(a.name, b.name) : a.dir ? -1 : 1));
    return { entries: entries.slice(0, LIST_MAX), more: Math.max(0, entries.length - LIST_MAX) };
  } catch (err) {
    return { error: why(err) };
  }
}

export async function readTree(cwd: string, rel: string): Promise<TreeFile> {
  const fail = (error: string): TreeFile => ({ text: null, size: 0, binary: false, tooLarge: false, error });
  try {
    const path = await within(cwd, rel);
    if (!path) return fail('Outside the session folder');
    const st = await stat(path);
    if (!st.isFile()) return fail('Not a file');
    const fh = await open(path, 'r');
    try {
      const head = Buffer.alloc(Math.min(SNIFF, st.size));
      await fh.read(head, 0, head.length, 0);
      // Same rule as git: a NUL byte near the start means binary.
      if (head.includes(0)) return { text: null, size: st.size, binary: true, tooLarge: false };
      if (st.size > READ_MAX) return { text: null, size: st.size, binary: false, tooLarge: true };
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, st.size, 0);
      return { text: buf.toString('utf8', 0, bytesRead), size: st.size, binary: false, tooLarge: false };
    } finally {
      await fh.close();
    }
  } catch (err) {
    return fail(why(err));
  }
}
