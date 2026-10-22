import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// What a revert may read back; anything bigger was never tracked with its text.
const READ_MAX = 4_000_000;

// The file's text, null when it does not exist; undefined when it cannot be compared (too big, binary, unreadable).
export async function readText(path: string): Promise<string | null | undefined> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > READ_MAX) return undefined;
    const text = await readFile(path, 'utf8');
    return text.includes('\u0000') ? undefined : text;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

// Writes through a temp file in the same folder, so a reader never sees half a file; a symlink keeps pointing at its target.
export async function writeAtomic(path: string, text: string) {
  const real = await realpath(path).catch(() => path);
  const mode = await stat(real).then((s) => s.mode & 0o7777, () => null);
  await mkdir(dirname(real), { recursive: true });
  const tmp = join(dirname(real), `.${basename(real)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, text);
    if (mode !== null) await chmod(tmp, mode);
    await rename(tmp, real);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function removeFile(path: string) {
  await unlink(path).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });
}
