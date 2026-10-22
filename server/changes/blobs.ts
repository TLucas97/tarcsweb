import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from '../config.ts';

// File snapshots by content hash, shared by every session; manifests say which hashes each turn's files had.
const ROOT = join(CACHE_DIR, 'changes');
const BLOBS = join(ROOT, 'blobs');
const SESSIONS = join(ROOT, 'sessions');
// Oldest snapshots go first past DISK_MAX, down to PRUNE_TO; manifests untouched for MANIFEST_DAYS go too.
const DISK_MAX = 400_000_000;
const PRUNE_TO = 320_000_000;
const MANIFEST_DAYS = 30;
// Bytes written between two prune passes, and the delay before the first one.
const PRUNE_EVERY = 64_000_000;
const PRUNE_FIRST_MS = 60_000;
// Texts kept in memory, newest first; the rest is read back from disk.
const MEM_MAX = 24_000_000;
const KNOWN_MAX = 100_000;
// A manifest past this size is not loaded; one with many superseded lines is rewritten once loaded.
const MANIFEST_MAX = 16_000_000;
// Past COMPACT_AT (and twice its last compacted size) a manifest is rewritten with its newest KEEP_MAX characters.
const COMPACT_AT = 4_000_000;
const KEEP_MAX = 4_000_000;

export const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');
const blobPath = (h: string) => join(BLOBS, h.slice(0, 2), h);
const tmpName = (path: string) => `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;

class Blobs {
  private mem = new Map<string, string>();
  private memSize = 0;
  // Texts not yet on disk; the write queue holds them until it lands.
  private pending = new Map<string, string>();
  // Hashes this process wrote or refreshed, so a repeat costs nothing.
  private known = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private written = 0;
  private pruning = false;
  private pruned = false;
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;

  put(text: string) {
    const h = hashOf(text);
    this.remember(h, text);
    if (this.known.has(h) || this.pending.has(h)) return h;
    this.pending.set(h, text);
    this.chain = this.chain.then(() => this.write(h, text)).finally(() => this.pending.delete(h));
    return h;
  }

  peek(h: string) {
    const t = this.mem.get(h);
    if (t !== undefined) {
      this.mem.delete(h);
      this.mem.set(h, t);
      return t;
    }
    return this.pending.get(h);
  }

  async get(h: string): Promise<string | null> {
    const t = this.peek(h);
    if (t !== undefined) return t;
    try {
      const text = await readFile(blobPath(h), 'utf8');
      this.remember(h, text);
      return text;
    } catch {
      return null;
    }
  }

  private remember(h: string, text: string) {
    if (this.mem.has(h)) return void this.peek(h);
    if (text.length > MEM_MAX / 4) return;
    this.mem.set(h, text);
    this.memSize += text.length;
    for (const [k, v] of this.mem) {
      if (this.memSize <= MEM_MAX) break;
      this.mem.delete(k);
      this.memSize -= v.length;
    }
  }

  private async write(h: string, text: string) {
    const path = blobPath(h);
    try {
      // An existing blob only gets a fresh mtime, so pruning keeps what is still in use.
      const now = new Date();
      await utimes(path, now, now).catch(async () => {
        await mkdir(join(BLOBS, h.slice(0, 2)), { recursive: true });
        const tmp = tmpName(path);
        await writeFile(tmp, text);
        await rename(tmp, path).catch(async (err) => {
          await rm(tmp, { force: true });
          throw err;
        });
        this.written += text.length;
      });
      if (this.known.size >= KNOWN_MAX) this.known.clear();
      this.known.add(h);
    } catch (err) {
      console.warn('[changes] snapshot not saved', err);
    }
    this.schedulePrune();
  }

  private schedulePrune() {
    if (this.pruneTimer || this.pruning || (this.pruned && this.written < PRUNE_EVERY)) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null;
      void this.prune();
    }, this.pruned ? 0 : PRUNE_FIRST_MS);
    this.pruneTimer.unref?.();
  }

  private async prune() {
    this.pruning = true;
    this.pruned = true;
    this.written = 0;
    try {
      const files: { path: string; h: string; size: number; at: number }[] = [];
      let total = 0;
      for (const dir of await readdir(BLOBS).catch(() => [] as string[])) {
        for (const h of await readdir(join(BLOBS, dir)).catch(() => [] as string[])) {
          const path = join(BLOBS, dir, h);
          const st = await stat(path).catch(() => null);
          if (!st?.isFile()) continue;
          // A crashed write leaves its temp file behind.
          if (h.endsWith('.tmp')) {
            if (Date.now() - st.mtimeMs > 3_600_000) await unlink(path).catch(() => {});
            continue;
          }
          files.push({ path, h, size: st.size, at: st.mtimeMs });
          total += st.size;
        }
      }
      if (total > DISK_MAX) {
        files.sort((a, b) => a.at - b.at);
        for (const f of files) {
          if (total <= PRUNE_TO) break;
          if (this.mem.has(f.h) || this.pending.has(f.h)) continue;
          await unlink(f.path).catch(() => {});
          this.known.delete(f.h);
          total -= f.size;
        }
      }
      const old = Date.now() - MANIFEST_DAYS * 86_400_000;
      for (const name of await readdir(SESSIONS).catch(() => [] as string[])) {
        const path = join(SESSIONS, name);
        const st = await stat(path).catch(() => null);
        if (st && st.mtimeMs < old) await unlink(path).catch(() => {});
      }
    } catch (err) {
      console.warn('[changes] prune failed', err);
    } finally {
      this.pruning = false;
    }
  }
}

export const blobs = new Blobs();

const manifestPath = (id: string) => join(SESSIONS, `${id.replace(/[^\w-]/g, '_')}.jsonl`);

// One session's file states as JSON lines; a later line for the same group and file replaces the earlier one.
export class Manifest<T> {
  private path: string;
  // The path once queued moves land.
  private next: string;
  private key: (line: T) => string;
  // Load, appends, compaction and moves share one chain, so a compaction never drops a line appended meanwhile.
  private chain: Promise<unknown> = Promise.resolve();
  private size = 0;
  private compacted = 0;

  constructor(sessionId: string, key: (line: T) => string) {
    this.path = this.next = manifestPath(sessionId);
    this.key = key;
  }

  private queue<R>(fn: () => Promise<R>, fallback: R, what: string): Promise<R> {
    const p = this.chain.then(fn).catch((err) => {
      console.warn(`[changes] ${what}`, err);
      return fallback;
    });
    this.chain = p;
    return p;
  }

  append(lines: T[]) {
    if (!lines.length) return;
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    void this.queue(async () => {
      await mkdir(SESSIONS, { recursive: true });
      await appendFile(this.path, text);
      this.size += Buffer.byteLength(text);
      // Compacted while it grows, so a long session stays well under MANIFEST_MAX.
      if (this.size > COMPACT_AT && this.size > this.compacted * 2) {
        await this.compact((await this.read()).out).catch((err) => {
          this.compacted = this.size;
          console.warn('[changes] manifest not compacted', err);
        });
      }
    }, undefined, 'manifest not saved');
  }

  load(): Promise<T[]> {
    return this.queue(async () => {
      const st = await stat(this.path).catch(() => null);
      if (!st || st.size > MANIFEST_MAX) return [];
      this.size = st.size;
      const { out, n } = await this.read();
      if (n > 1000 && n > out.length * 2) await this.compact(out).catch((err) => console.warn('[changes] manifest not compacted', err));
      return out;
    }, [], 'manifest not loaded');
  }

  // Follows the session to a new id (a Codex thread id once known), taking its saved lines along.
  move(sessionId: string) {
    const to = manifestPath(sessionId);
    if (to === this.next) return;
    this.next = to;
    void this.queue(async () => {
      await rename(this.path, to).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      });
      this.path = to;
    }, undefined, 'manifest not moved');
  }

  private async read() {
    const latest = new Map<string, T>();
    let n = 0;
    for (const raw of (await readFile(this.path, 'utf8')).split('\n')) {
      if (!raw) continue;
      try {
        const line = JSON.parse(raw) as T;
        latest.delete(this.key(line));
        latest.set(this.key(line), line);
        n++;
      } catch {}
    }
    return { out: [...latest.values()], n };
  }

  // Keeps the newest lines up to KEEP_MAX characters; only runs inside the chain.
  private async compact(lines: T[]) {
    const rows: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0 && size < KEEP_MAX; i--) {
      const row = JSON.stringify(lines[i]);
      rows.push(row);
      size += row.length + 1;
    }
    const text = rows.reverse().join('\n') + '\n';
    const tmp = tmpName(this.path);
    try {
      await writeFile(tmp, text);
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    this.size = this.compacted = Buffer.byteLength(text);
  }
}
