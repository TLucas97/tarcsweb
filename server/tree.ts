import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TreeEntry, TreeFile } from './protocol.ts';
import { inside } from './files.ts';

const LIST_MAX = 2000;
// Text above this is not sent at all; the client colors only smaller files.
const READ_MAX = 1 << 20;
const SNIFF = 8000;
const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

// A path the client named, relative to the session folder; null when it, or a symlink on the way, leads outside.
async function within(cwd: string, rel: string) {
  if (rel.includes('\0')) return null;
  const root = await realpath(cwd);
  const full = resolve(root, rel);
  if (!inside(root, full)) return null;
  const real = await realpath(full);
  return inside(root, real) ? real : null;
}

const why = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' ? 'No longer exists' : code === 'EACCES' ? 'No permission to read it' : code === 'ENOTDIR' ? 'Not a folder' : 'Could not read it';
};

export async function listTree(cwd: string, rel: string): Promise<{ entries: TreeEntry[]; more: number } | { error: string }> {
  try {
    const dir = await within(cwd, rel);
    if (!dir) return { error: 'Outside the session folder' };
    const raw = await readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(
      raw.map(async (d): Promise<TreeEntry> => {
        const link = d.isSymbolicLink();
        const isDir = link ? await stat(join(dir, d.name)).then((s) => s.isDirectory(), () => false) : d.isDirectory();
        return { name: d.name, dir: isDir, ...(link ? { link: true } : {}) };
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
