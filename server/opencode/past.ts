import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PastSession } from '../protocol.ts';
import { CACHE_DIR } from '../config.ts';
import { oneLine } from '../text.ts';
import { opencode, type SessionInfo } from './client.ts';
import { opencodeServer } from './server.ts';
import { hiddenThreads } from './hidden.ts';
import { MAIN_MARK } from './main.ts';

const TTL_MS = 5 * 60_000;
// Sessions listed per archived state; the rest stay reachable in OpenCode itself.
const LIST_MAX = 500;
const PAGE = 200;
// The last listing, so the session list shows OpenCode rows without starting its server.
const FILE = join(CACHE_DIR, 'opencode-past.json');

const ours = (s: SessionInfo) => !s.parentID && s.metadata?.tarcsweb === MAIN_MARK.tarcsweb;
const rowOf = (s: SessionInfo, archived: boolean): PastSession => ({
  id: s.id, name: oneLine(s.title || 'Untitled', 80), cwd: s.location.directory, branch: null, lastModified: s.time.updated, archived, provider: 'opencode',
});

async function listAll(archived: boolean, hidden: Set<string>) {
  const out: PastSession[] = [];
  let cursor: string | undefined;
  let seen = 0;
  do {
    const r = await opencode.listSessions({ archived, limit: PAGE, cursor });
    for (const s of r.data) if (ours(s) && !hidden.has(s.id)) out.push(rowOf(s, archived));
    seen += r.data.length;
    // A next cursor comes even on the last page, so a short page ends the listing.
    cursor = r.data.length < PAGE ? undefined : r.cursor.next;
  } while (cursor && seen < LIST_MAX * 4 && out.length < LIST_MAX);
  return out;
}

// The OpenCode sessions this app created as main tabs; its own helper sessions (opencode_agent) stay out.
export class OpencodePast {
  rows: PastSession[] = [];
  private at = 0;
  private read = false;
  private loading: Promise<boolean> | null = null;
  private seq = 0;

  // Reads the saved rows once, then re-lists only while the OpenCode server runs anyway; true when the rows changed.
  refresh(): Promise<boolean> {
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  private async load() {
    let changed = false;
    if (!this.read) {
      this.read = true;
      const saved: unknown = await readFile(FILE, 'utf8').then((t) => JSON.parse(t), () => []);
      if (Array.isArray(saved) && saved.length) {
        this.rows = saved.filter((r): r is PastSession => !!r && typeof r === 'object' && typeof (r as PastSession).id === 'string').map((r) => ({ ...r, provider: 'opencode' }));
        changed = true;
      }
    }
    if (!opencodeServer.running || Date.now() - this.at < TTL_MS) return changed;
    this.at = Date.now();
    try {
      const hidden = await hiddenThreads.all();
      const [live, archived] = await Promise.all([listAll(false, hidden), listAll(true, hidden)]);
      this.rows = [...live, ...archived].sort((a, b) => b.lastModified - a.lastModified);
      this.save();
      return true;
    } catch (e) {
      console.warn(`[opencode] could not list sessions: ${e instanceof Error ? e.message : String(e)}`);
      return changed;
    }
  }

  get(id: string) {
    return this.rows.find((r) => r.id === id);
  }

  // A session closed or edited here, put back without a re-list.
  put(row: PastSession) {
    this.rows = [row, ...this.rows.filter((r) => r.id !== row.id)].sort((a, b) => b.lastModified - a.lastModified);
    this.save();
  }

  drop(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id);
    this.save();
  }

  // Edits made in place on a row.
  changed() {
    this.save();
  }

  private save() {
    const tmp = `${FILE}.${process.pid}.${++this.seq}.tmp`;
    void mkdir(CACHE_DIR, { recursive: true })
      .then(() => writeFile(tmp, JSON.stringify(this.rows.slice(0, LIST_MAX * 2))))
      .then(() => rename(tmp, FILE))
      .catch((e: unknown) => console.warn(`[opencode] session list not saved: ${e instanceof Error ? e.message : String(e)}`));
  }
}
