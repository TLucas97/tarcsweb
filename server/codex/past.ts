import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PastSession } from '../protocol.ts';
import { isDir } from '../dirs.ts';
import { oneLine } from '../text.ts';
import { codex } from './client.ts';
import { hiddenThreads } from './hidden.ts';
import type { Thread, ThreadListResponse } from './types.ts';

const TTL_MS = 5 * 60_000;
// Threads listed per archived state; the rest stay reachable through the Codex CLI.
const LIST_MAX = 500;
const PAGE = 200;

const rowOf = (t: Thread): PastSession => ({
  id: t.id, name: oneLine(t.name || t.preview || 'Untitled', 80), cwd: t.cwd, branch: t.gitInfo?.branch || null,
  lastModified: t.updatedAt * 1000, archived: false, provider: 'codex',
});
// Subagents and ephemeral threads are not sessions of their own.
const listed = (t: Thread) => !t.ephemeral && !t.parentThreadId;

// seen holds every id the listing returned; complete says it reached the end, so a hidden id missing from it is gone.
async function listAll(archived: boolean, hidden: Set<string>) {
  const out: PastSession[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const r: ThreadListResponse = await codex.peek('thread/list', { cursor, limit: PAGE, sortKey: 'updated_at', archived });
    for (const t of r.data) {
      seen.add(t.id);
      if (listed(t) && !hidden.has(t.id)) out.push({ ...rowOf(t), archived });
    }
    cursor = r.nextCursor;
  } while (cursor && out.length < LIST_MAX);
  return { rows: out, seen, complete: !cursor };
}

// The user's Codex threads from the app-server's own index, cached; edits made here update it in place.
export class CodexPast {
  rows: PastSession[] = [];
  private at = 0;
  private loading: Promise<boolean> | null = null;

  // Refreshes a stale list on intent, or when the app-server runs anyway; true when the rows were reloaded.
  refresh(intent: boolean): Promise<boolean> {
    if (Date.now() - this.at < TTL_MS || (!intent && !codex.running)) return Promise.resolve(false);
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  private async load() {
    const bin = await codex.checkBinary();
    if (!bin.path || !(await isDir(process.env.CODEX_HOME || join(homedir(), '.codex')))) {
      this.at = Date.now();
      return false;
    }
    try {
      const hidden = await hiddenThreads.all();
      const [live, archived] = await Promise.all([listAll(false, hidden), listAll(true, hidden)]);
      this.rows = [...live.rows, ...archived.rows].sort((a, b) => b.lastModified - a.lastModified);
      if (live.complete && archived.complete) void hiddenThreads.keepOnly(new Set([...live.seen, ...archived.seen])).catch(() => {});
      this.at = Date.now();
      return true;
    } catch (e) {
      console.warn(`[codex] could not list threads: ${e instanceof Error ? e.message : String(e)}`);
      // Back off for a full TTL, so every Start or Ctrl+K open does not boot the app-server again.
      this.at = Date.now();
      return false;
    }
  }

  get(id: string) {
    return this.rows.find((r) => r.id === id);
  }

  // A thread closed or edited here, put back at the front without a re-list.
  put(row: PastSession) {
    this.rows = [row, ...this.rows.filter((r) => r.id !== row.id)].sort((a, b) => b.lastModified - a.lastModified);
  }
}
