import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { oneLine } from '../text.ts';
import { ARCHIVED_TAG, type SearchHit } from '../protocol.ts';
import { VERSION, titleOf } from './db.ts';

// Answers searches off the main thread: snippet() re-reads each hit's text, tens of ms for common words.
// recent: also add this many of the newest sessions, matching or not (AI search candidates).
export type Ask = { id: number; fts: string | null; cwd: string | null; limit: number; removed: string[]; recent?: number };
export type Answer = { id: number; hits: SearchHit[]; ready: boolean };

const SHOWN = `f.source IN ('claude', 'codex')`;
// Ranked ids first, snippets only for the rows shown: in one query SQLite builds a snippet for every match.
const RANK = `SELECT docs.rowid AS id FROM docs JOIN files f ON f.id = docs.rowid WHERE docs MATCH ? AND ${SHOWN} ORDER BY bm25(docs, 4.0, 1.0) LIMIT ?`;
// A folder's page filters in SQL, so its hits are not cut by the global top results.
const RANK_IN = `SELECT docs.rowid AS id FROM docs JOIN files f ON f.id = docs.rowid WHERE docs MATCH ? AND ${SHOWN} AND f.cwd = ? ORDER BY bm25(docs, 4.0, 1.0) LIMIT ?`;
// \u0002 and \u0003 wrap each match. node:sqlite binds numbers as REAL, which an FTS5 rowid lookup ignores, hence the CAST.
const SNIPPET = `SELECT snippet(docs, -1, char(2), char(3), '…', 14) AS snip FROM docs WHERE docs MATCH ? AND rowid = CAST(? AS INTEGER)`;
// A recent session that does not match shows its opening text instead of a snippet.
const HEAD = 'SELECT substr(body, 1, 300) AS snip FROM docs WHERE rowid = CAST(? AS INTEGER)';
const RECENT = `SELECT id FROM files f WHERE ${SHOWN} ORDER BY mtime DESC LIMIT ?`;
const RECENT_IN = `SELECT id FROM files f WHERE ${SHOWN} AND cwd = ? ORDER BY mtime DESC LIMIT ?`;
const FILE = 'SELECT sid, source, cwd, mtime, titles, tag FROM files WHERE id = ?';
type FileRow = { sid: string; source: string; cwd: string; mtime: number; titles: string; tag: string | null };

const path = (workerData as { path: string }).path;
let q: {
  db: DatabaseSync; rank: StatementSync; rankIn: StatementSync; snippet: StatementSync; head: StatementSync; recent: StatementSync; recentIn: StatementSync;
  file: StatementSync; version: StatementSync;
} | null = null;

// A first build in progress still answers, from the sessions indexed so far; ready says it finished.
function answer({ fts, cwd, limit, removed, recent = 0 }: Ask): Omit<Answer, 'id'> {
  q ??= (() => {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000');
    return {
      db, rank: db.prepare(RANK), rankIn: db.prepare(RANK_IN), snippet: db.prepare(SNIPPET), head: db.prepare(HEAD), recent: db.prepare(RECENT),
      recentIn: db.prepare(RECENT_IN), file: db.prepare(FILE), version: db.prepare('PRAGMA user_version'),
    };
  })();
  const st = q;
  const ready = (st.version.get() as { user_version: number }).user_version === VERSION;
  const gone = new Set(removed);
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  const add = (id: number) => {
    const r = st.file.get(id) as FileRow | undefined;
    if (!r || gone.has(r.sid) || seen.has(r.sid)) return false;
    seen.add(r.sid);
    const s = fts ? (st.snippet.get(fts, id) as { snip: string } | undefined) : undefined;
    const snip = s?.snip ?? (st.head.get(id) as { snip: string } | undefined)?.snip ?? '';
    hits.push({
      id: r.sid, name: oneLine(titleOf(JSON.parse(r.titles)), 80), cwd: r.cwd, branch: null, lastModified: Math.round(r.mtime),
      archived: r.tag === ARCHIVED_TAG, provider: r.source === 'codex' ? 'codex' : 'claude', source: r.source, snippet: oneLine(snip, 300),
    });
    return true;
  };
  const ranked = !fts ? [] : cwd ? st.rankIn.all(fts, cwd, limit + gone.size) : st.rank.all(fts, limit + gone.size);
  let n = 0;
  for (const { id } of ranked as { id: number }[]) if (n < limit && add(id)) n++;
  const newest = !recent ? [] : cwd ? st.recentIn.all(cwd, recent + limit + gone.size) : st.recent.all(recent + limit + gone.size);
  n = 0;
  for (const { id } of newest as { id: number }[]) if (n < recent && add(id)) n++;
  return { hits, ready };
}

parentPort!.on('message', (ask: Ask) => {
  let out: Omit<Answer, 'id'>;
  try {
    out = answer(ask);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // No file or tables yet is the normal state before the first build; anything else is worth a log line.
    if (!/unable to open|no such table/.test(msg)) console.error(`search: query failed: ${msg}`);
    q?.db.close();
    q = null;
    out = { hits: [], ready: false };
  }
  parentPort!.postMessage({ id: ask.id, ...out } satisfies Answer);
});
