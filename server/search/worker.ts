import { parentPort, workerData } from 'node:worker_threads';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { markBuilt, openIndex, type Source, type Titles } from './db.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';

// Every provider that feeds the index.
const SOURCES: Source[] = [claude, codex];
// Text kept per session: the start (what it was about) and the newest part.
const CAP = 200_000;
const HEAD = 40_000;
const cap = (s: string) => (s.length <= CAP ? s : s.slice(0, HEAD) + '\n' + s.slice(s.length - (CAP - HEAD)));

type Row = { id: number; path: string; mtime: number; size: number; offset: number; cwd: string; titles: string; tag: string | null };
export type ScanResult = { files: number; changed: number; removed: number; ms: number } | { error: string };

const path = (workerData as { path: string }).path;
await mkdir(dirname(path), { recursive: true });
const db = openIndex(path, 5000);
const q = {
  rows: db.prepare('SELECT id, path, mtime, size, offset, cwd, titles, tag FROM files WHERE source = ?'),
  body: db.prepare('SELECT body FROM docs WHERE rowid = ?'),
  drop: db.prepare('DELETE FROM files WHERE id = ?'),
  dropDoc: db.prepare('DELETE FROM docs WHERE rowid = ?'),
  add: db.prepare('INSERT INTO files (path, source, sid, cwd, mtime, size, offset, titles, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  addDoc: db.prepare('INSERT INTO docs (rowid, title, body) VALUES (?, ?, ?)'),
  set: db.prepare('UPDATE files SET cwd = ?, mtime = ?, size = ?, offset = ?, titles = ?, tag = ? WHERE id = ?'),
  setDoc: db.prepare('UPDATE docs SET title = ?, body = ? WHERE rowid = ?'),
};

function tx(fn: () => void) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

async function scan(src: Source) {
  const files = await src.list();
  const known = new Map((q.rows.all(src.name) as Row[]).map((r) => [r.path, r]));
  const listed = new Set(files.map((f) => f.path));
  let removed = 0;
  tx(() => {
    for (const r of known.values()) {
      if (listed.has(r.path)) continue;
      q.drop.run(r.id);
      q.dropDoc.run(r.id);
      removed++;
    }
  });
  let changed = 0;
  for (const f of files) {
    const r = known.get(f.path);
    if (r && r.mtime === f.mtime && r.size === f.size) continue;
    // A file that shrank was rewritten, so it is read again from the start.
    const fresh = !r || f.size < r.offset;
    const titles: Titles = fresh ? {} : JSON.parse(r.titles);
    let cwd = fresh ? '' : r.cwd;
    let tag = fresh ? null : r.tag;
    let parts: string[] = [];
    let len = 0;
    let offset: number;
    try {
      offset = await src.read(f, fresh ? 0 : r.offset, {
        text(s) {
          parts.push(s);
          len += s.length + 1;
          if (len <= 2 * CAP) return;
          parts = [cap(parts.join('\n'))];
          len = parts[0].length;
        },
        title(kind, s) {
          if (kind !== 'first' || !titles.first) titles[kind] = s;
        },
        cwd(s) {
          cwd ||= s;
        },
        tag(t) {
          tag = t || null;
        },
      });
    } catch {
      // Deleted or unreadable since the listing; the next scan settles it.
      continue;
    }
    const old = r && !fresh ? ((q.body.get(r.id) as { body: string } | undefined)?.body ?? '') : '';
    const body = cap([old, ...parts].filter(Boolean).join('\n'));
    const title = [...new Set([titles.custom, titles.ai, titles.first].filter(Boolean))].join('\n');
    const json = JSON.stringify(titles);
    tx(() => {
      if (r) {
        q.set.run(cwd, f.mtime, f.size, offset, json, tag, r.id);
        if (fresh || parts.length || json !== r.titles) q.setDoc.run(title, body, r.id);
      } else {
        const id = Number(q.add.run(f.path, src.name, f.sid, cwd, f.mtime, f.size, offset, json, tag).lastInsertRowid);
        q.addDoc.run(id, title, body);
      }
    });
    changed++;
  }
  return { files: files.length, changed, removed };
}

async function run(): Promise<ScanResult> {
  const t0 = performance.now();
  const total = { files: 0, changed: 0, removed: 0 };
  for (const src of SOURCES) {
    const r = await scan(src);
    total.files += r.files;
    total.changed += r.changed;
    total.removed += r.removed;
  }
  markBuilt(db);
  return { ...total, ms: Math.round(performance.now() - t0) };
}

run()
  .catch((e: unknown): ScanResult => ({ error: e instanceof Error ? e.message : String(e) }))
  .then((r) => {
    db.close();
    parentPort!.postMessage(r);
  });
