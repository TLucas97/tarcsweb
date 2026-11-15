import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CACHE_DIR } from './config.ts';
import { LIVE_SERVER, tmpName } from './workspace.ts';
import { capReply } from './commander.ts';
import { oneLine } from './text.ts';

// Keep pointers small; closed entries expire after 30 days and leave before open follow-ups under either cap.
const AGE_MS = 30 * 86400_000, ENTRIES_MAX = 200, BYTES_MAX = 32768, TEXT_MAX = 600, SAVE_MS = 2000;
const FILE = join(CACHE_DIR, 'commander-log.json');
const entry = z.object({ id: z.string(), at: z.number(), by: z.enum(['commander', 'app']), text: z.string().trim().min(1).max(TEXT_MAX), sessionId: z.string().optional(), sessionName: z.string().optional(), open: z.boolean(), closedAt: z.number().optional() });
type Entry = z.infer<typeof entry>;
export type LogArgs = { action: 'read' | 'append' | 'close' | 'reopen' | 'remove'; query?: string; session_id?: string; open_only?: boolean; limit?: number; text?: string; open?: boolean; id?: string };

export class CommanderLog {
  private entries: Entry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing = Promise.resolve();
  constructor() {
    if (!LIVE_SERVER) return;
    try {
      this.entries = z.array(entry).parse(JSON.parse(readFileSync(FILE, 'utf8')));
      this.prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.log('commander log: unreadable cache; starting empty');
    }
  }
  append(by: Entry['by'], text: string, session?: { id: string; name: string }, open = false) {
    if (!text.trim() || text.trim().length > TEXT_MAX) throw new Error(`Log text must be 1–${TEXT_MAX} characters.`);
    const at = Date.now();
    const row: Entry = { id: randomUUID(), at, by, text: oneLine(text.trim(), TEXT_MAX), open, ...(!open && { closedAt: at }), ...(session && { sessionId: session.id, sessionName: session.name }) };
    this.entries.push(row);
    this.prune();
    this.save();
    return row.id;
  }
  // For the reader on screen: every kept entry, oldest first.
  list() {
    this.prune();
    return this.entries;
  }
  run(args: LogArgs, session?: { id: string; name: string }) {
    this.prune();
    if (args.action === 'read') {
      const query = args.query?.toLowerCase();
      const rows = this.entries.filter((e) => (!query || `${e.text} ${e.sessionName ?? ''}`.toLowerCase().includes(query)) && (!args.session_id || e.sessionId === args.session_id) && (!args.open_only || e.open)).slice().reverse().slice(0, args.limit ?? 30);
      return capReply(rows.map((e) => `${new Date(e.at).toISOString()} ${e.open ? '[open] ' : ''}${e.by}${e.sessionId ? ` · ${oneLine(e.sessionName ?? '', 80)} (${e.sessionId})` : ''}: ${e.text} [${e.id}]`).join('\n') || 'The commander log has no matching entries.');
    }
    if (args.action === 'append') return `Added log entry ${this.append('commander', args.text ?? '', session, args.open)}.`;
    const row = this.entries.find((e) => e.id === args.id);
    if (!row) throw new Error('No log entry with that id. Read commander_log for entry ids.');
    if (args.action === 'remove') this.entries = this.entries.filter((e) => e !== row);
    else {
      row.open = args.action === 'reopen';
      if (row.open) delete row.closedAt;
      else row.closedAt = Date.now();
    }
    this.prune();
    this.save();
    return `Log entry ${args.id} ${args.action === 'remove' ? 'removed' : row.open ? 'reopened' : 'closed'}.`;
  }
  private prune() {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.open || Date.now() - (e.closedAt ?? e.at) < AGE_MS);
    while (this.entries.length > ENTRIES_MAX || Buffer.byteLength(JSON.stringify(this.entries)) > BYTES_MAX) {
      const closed = this.entries.findIndex((e) => !e.open);
      this.entries.splice(closed < 0 ? 0 : closed, 1);
    }
    if (this.entries.length !== before) this.save();
  }
  private save() {
    if (!LIVE_SERVER || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, SAVE_MS);
  }
  private flush() {
    if (!LIVE_SERVER) return;
    const text = JSON.stringify(this.entries);
    this.writing = this.writing.then(async () => {
      await mkdir(CACHE_DIR, { recursive: true });
      const tmp = tmpName(FILE);
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, FILE);
    }).catch((error) => { console.log(`commander log: save failed (${error.message})`); });
  }
  final() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; this.flush(); }
    return this.writing;
  }
}
