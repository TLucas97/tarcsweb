import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { CACHE_DIR } from '../config.ts';
import { tuning } from '../profile.ts';
import type { SearchHit } from '../protocol.ts';
import { hiddenThreads } from '../codex/hidden.ts';
import type { ScanResult } from './worker.ts';
import type { Answer, Ask } from './query.ts';

// Full-text index of past conversations. Workers build and query it, so neither gigabytes of transcripts nor
// snippet work ever stalls the event loop.
const DB_PATH = process.env.CW_SEARCH_DB || join(CACHE_DIR, 'search.db');
const FIRST_SCAN_MS = 5000;
const STALE_MS = 60_000;
// The query worker costs memory while alive, so it stops once searches have been quiet this long.
const READER_IDLE_MS = 30_000;
const LIMIT = 30;
const MAX_WORDS = 12;

// Each word is quoted so FTS5 syntax in the input is just text. The last word also matches as a prefix,
// from 3 letters: "de"* expands to thousands of words and makes the query slow.
export function ftsQuery(input: string) {
  const words = input.split(/\s+/).map((w) => w.replace(/"/g, ' ').trim()).filter((w) => /[\p{L}\p{N}]/u.test(w)).slice(0, MAX_WORDS);
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 && w.length >= 3 ? '*' : ''}`).join(' ');
}

// A small young generation keeps an idle worker from holding tens of MB it only needed for a moment.
const worker = (file: string) => {
  const w = new Worker(new URL(file, import.meta.url), { workerData: { path: DB_PATH }, resourceLimits: { maxYoungGenerationSizeMb: 4 } });
  w.unref();
  return w;
};

class SearchIndex {
  private scanning = false;
  private again = false;
  private scannedAt = 0;
  private scanned = false;
  // Deleted sessions stay hidden until a scan drops their rows.
  private removed = new Set<string>();
  private reader: Worker | null = null;
  private readerIdle: ReturnType<typeof setTimeout> | null = null;
  private calls = new Map<number, (a: Answer) => void>();
  private seq = 0;

  start() {
    if (!tuning().searchBootScan) return;
    setTimeout(() => { if (tuning().searchBootScan) this.refresh(); }, FIRST_SCAN_MS).unref();
  }

  // Rescans in the background; again: run once more after a scan in progress, since it may have listed files before a change.
  refresh(again = false) {
    if (this.scanning) {
      this.again ||= again;
      return;
    }
    this.scanning = true;
    this.scannedAt = Date.now();
    const gone = new Set(this.removed);
    const w = worker('./worker.ts');
    w.on('message', (r: ScanResult) => {
      if ('error' in r) return console.error(`search: index scan failed: ${r.error}`);
      const first = !this.scanned;
      this.scanned = true;
      for (const id of gone) this.removed.delete(id);
      if (first || r.changed || r.removed) console.log(`search: ${r.files} sessions, ${r.changed} indexed, ${r.removed} dropped in ${r.ms} ms`);
    });
    w.on('error', (e: Error) => console.error(`search: index worker failed: ${e.message}`));
    w.on('exit', () => {
      this.scanning = false;
      if (!this.again) return;
      this.again = false;
      this.refresh();
    });
  }

  private ask(fts: string | null, cwd: string | null, limit = LIMIT, recent = 0): Promise<Answer> {
    if (!this.reader) {
      const w = (this.reader = worker('./query.ts'));
      w.on('message', (a: Answer) => {
        this.calls.get(a.id)?.(a);
        this.calls.delete(a.id);
      });
      w.on('error', (e: Error) => console.error(`search: query worker failed: ${e.message}`));
      w.on('exit', () => {
        if (this.reader === w) this.reader = null;
        for (const [id, done] of this.calls) done({ id, hits: [], ready: false });
        this.calls.clear();
      });
    }
    if (this.readerIdle) clearTimeout(this.readerIdle);
    this.readerIdle = setTimeout(() => void this.reader?.terminate(), READER_IDLE_MS);
    this.readerIdle.unref();
    const id = ++this.seq;
    const reader = this.reader;
    return new Promise((done) => {
      this.calls.set(id, done);
      reader.postMessage({ id, fts, cwd, limit, removed: [...this.removed], recent } satisfies Ask);
    });
  }

  // Answers from the index as it is now; a stale index rescans in the background for the next search.
  async query(input: string, cwd: string | null = null): Promise<{ hits: SearchHit[]; indexing: boolean }> {
    if (Date.now() - this.scannedAt > STALE_MS) this.refresh();
    const fts = ftsQuery(input);
    if (!fts) return { hits: [], indexing: !this.scanned };
    const a = await this.ask(fts, cwd);
    return { hits: await shown(a.hits), indexing: !this.scanned && !a.ready };
  }

  // Sessions an AI search picks from: the best matches for fts (any word), then the newest ones.
  async candidates(fts: string | null, cwd: string | null, limit: number, recent: number): Promise<{ hits: SearchHit[]; indexing: boolean }> {
    if (Date.now() - this.scannedAt > STALE_MS) this.refresh();
    const a = await this.ask(fts, cwd, limit, recent);
    return { hits: await shown(a.hits), indexing: !this.scanned && !a.ready };
  }

  // The app deleted a session: hide it now and let a scan drop its row.
  forget(id: string) {
    this.removed.add(id);
    this.refresh(true);
  }
}

// Threads the app started for codex_agent are indexed like any other, but they are not sessions of their own.
async function shown(hits: SearchHit[]) {
  if (!hits.some((h) => h.provider === 'codex')) return hits;
  const hidden = await hiddenThreads.all().catch(() => new Set<string>());
  return hits.filter((h) => h.provider !== 'codex' || !hidden.has(h.id));
}

export const search = new SearchIndex();
