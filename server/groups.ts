import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CACHE_DIR } from './config.ts';
import type { SessionGroup } from './protocol.ts';

const DAY = 86400_000;
export const SUMMARY_BYTES = 32768;
const member = z.object({ id: z.string(), savedId: z.string().nullable(), name: z.string(), cwd: z.string(), provider: z.enum(['claude', 'codex']), worktree: z.object({ path: z.string(), repo: z.string(), branch: z.string() }).nullable() });
const group = z.object({ id: z.string(), main: member, children: z.array(member).max(100), entries: z.array(z.object({ seq: z.number(), author: z.string(), text: z.string(), at: z.number() })).max(200), revision: z.number(), read: z.number(), touchedAt: z.number() });
type Member = SessionGroup['main'];

// Only summaries and membership live here; transcripts and worktrees are never removed by group cleanup.
export class GroupStore {
  private groups: SessionGroup[] = [];
  private writing = Promise.resolve();
  private file: string;
  constructor(file = join(CACHE_DIR, 'groups.json')) {
    this.file = file;
    try {
      const raw = z.object({ version: z.literal(1), groups: z.array(group).max(500) }).parse(JSON.parse(readFileSync(file, 'utf8')));
      this.groups = raw.groups;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.log('groups: unreadable cache; starting empty');
    }
  }
  list() { return this.groups; }
  of(id: string) { return this.groups.find((g) => [g.main, ...g.children].some((m) => m.id === id || m.savedId === id)); }
  canAdd(id: string) {
    const g = this.of(id);
    if (g && g.main.id !== id) throw new Error('Sub-sessions cannot create sub-sessions.');
    if (g && g.children.length >= 100) throw new Error('This group has reached its sub-session limit.');
    if (!g && this.groups.length >= 500) throw new Error('Delete an unused group before creating another.');
  }
  add(main: Member, child: Member) {
    this.canAdd(main.id);
    let g = this.of(main.id);
    if (g && g.main.id !== main.id) throw new Error('Sub-sessions cannot create sub-sessions.');
    if (this.of(child.id)) throw new Error('This session already belongs to a group.');
    if (!g) {
      g = { id: randomUUID(), main, children: [], entries: [], revision: 0, read: 0, touchedAt: Date.now() };
      this.groups.push(g);
    }
    g.children.push(child);
    this.touch(g);
    return g;
  }
  bind(id: string, savedId: string | null, patch: Pick<Member, 'name' | 'cwd' | 'provider'>) {
    const g = this.of(id) ?? (savedId ? this.of(savedId) : undefined);
    const m = g && [g.main, ...g.children].find((m) => m.id === id || (savedId && m.savedId === savedId));
    if (!m) return;
    if (m.id === id && m.savedId === savedId && m.name === patch.name && m.cwd === patch.cwd && m.provider === patch.provider) return;
    m.name = patch.name;
    m.cwd = patch.cwd;
    m.provider = patch.provider;
    m.id = id;
    m.savedId = savedId;
    this.save();
  }
  append(id: string, text: string) {
    const g = this.of(id);
    if (!g) throw new Error('This session does not belong to a group.');
    if (!text.trim() || Buffer.byteLength(JSON.stringify({ seq: g.revision + 1, author: id, text, at: Date.now() })) + 2 > SUMMARY_BYTES) throw new Error('Summary entries must fit in 32768 bytes.');
    g.entries.push({ seq: ++g.revision, author: id, text, at: Date.now() });
    // The main session's own entry is not news to it, unless it still had unread ones.
    if (g.main.id === id && g.read === g.revision - 1) g.read = g.revision;
    while (g.entries.length > 200 || Buffer.byteLength(JSON.stringify(g.entries)) > SUMMARY_BYTES) g.entries.shift();
    this.touch(g);
    return g;
  }
  read(id: string, unreadOnly = false) {
    const g = this.of(id);
    if (!g) return '';
    const entries = unreadOnly && g.main.id === id ? g.entries.filter((e) => e.seq > g.read) : g.entries;
    if (g.main.id === id) g.read = g.revision;
    this.touch(g);
    return entries.map((e) => `[${e.author}] ${e.text}`).join('\n\n');
  }
  touch(g: SessionGroup, now = Date.now()) { g.touchedAt = now; this.save(); }
  keep(id: string) { const g = this.groups.find((g) => g.id === id); if (g) this.touch(g); }
  delete(id: string) { this.groups = this.groups.filter((g) => g.id !== id); this.save(); }
  forget(id: string) {
    const g = this.of(id);
    if (!g) return;
    g.children = g.children.filter((m) => m.id !== id && m.savedId !== id);
    // A group without sub-sessions has nothing left to coordinate.
    if (g.main.id === id || g.main.savedId === id || !g.children.length) this.delete(g.id);
    else this.touch(g);
  }
  cleanup(enabled: boolean, active: Set<string>, now = Date.now()) {
    if (!enabled) return;
    const expired = this.groups.filter((g) => now - g.touchedAt >= 30 * DAY && ![g.main, ...g.children].some((m) => active.has(m.id)));
    if (!expired.length) return;
    this.groups = this.groups.filter((g) => !expired.includes(g));
    this.save();
  }
  private save() {
    const text = JSON.stringify({ version: 1, groups: this.groups });
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, this.file);
    }).catch((error) => { console.log(`groups: save failed (${error.message})`); });
  }
  final() { return this.writing; }
}
