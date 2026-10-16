import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { deleteSession, getSessionInfo, getSessionMessages, listSessions, renameSession, tagSession } from '@anthropic-ai/claude-agent-sdk';
import type { SDKRateLimitInfo, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { Session, oneLine, shortTitle, type Hub } from './session.ts';
import { historyOf } from './history.ts';
import { Titles } from './titles.ts';
import { Voice } from './voice.ts';
import { Phone } from './phone.ts';
import { closeNotes } from './notes.ts';
import { CommandCache } from './commands.ts';
import { Dismissals } from './dismissals.ts';
import { expand, gitBranch, hasSubdirs, isDir } from './dirs.ts';
import { config } from './config.ts';
import { search } from './search/index.ts';
import { ARCHIVED_TAG, type Folder, type LimitKey, type Limits, type PastSession, type SessionSummary, type Settings } from './protocol.ts';

// Edits made here update the cached list in place, so a re-list only picks up sessions made elsewhere.
const PAST_TTL_MS = 60_000;
const EXIT_WAIT_MS = 3000;
// Idle CLIs kept alive (each holds 300-500 MB with its MCPs); older idle ones stop and resume on the next message.
const IDLE_CLIS = 1;
const DEFAULTS: Settings = config.defaults;

// Distinct project folders, most recent first, skipping ones that are gone.
async function recentFolders(list: SDKSessionInfo[]): Promise<Folder[]> {
  const paths = [...new Set(list.flatMap((s) => s.cwd ?? []))];
  const exists = await Promise.all(paths.map(isDir));
  // Transcripts store "HEAD" outside a repo, so ask git for the branch shown today.
  return Promise.all(
    paths.filter((_, i) => exists[i]).map(async (path) => {
      const [branch, hasChildren] = await Promise.all([gitBranch(path), hasSubdirs(path)]);
      return { path, branch, hasChildren };
    }),
  );
}

const titleOf = (s: SDKSessionInfo) => oneLine(s.customTitle || s.summary || s.firstPrompt || 'Untitled', 80);

const LIMIT_KEYS: LimitKey[] = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
// Undocumented in sdk.d.ts, but the CLI sends every window's utilization here (0-1, resetsAt in seconds).
type UnifiedWindows = Partial<Record<string, { utilization?: number; resetsAt?: number }>>;

function mergeLimits(prev: Limits | null, info: SDKRateLimitInfo): Limits {
  const windows = { ...prev?.windows };
  const put = (key: string, utilization: number | undefined, resetsAt: number | undefined) => {
    if (!LIMIT_KEYS.includes(key as LimitKey)) return;
    const w = windows[key as LimitKey];
    windows[key as LimitKey] = {
      pct: typeof utilization === 'number' ? utilization * 100 : (w?.pct ?? null),
      resetsAt: typeof resetsAt === 'number' ? resetsAt * 1000 : (w?.resetsAt ?? null),
    };
  };
  const unified = (info as { unifiedWindows?: UnifiedWindows }).unifiedWindows;
  for (const [key, w] of Object.entries(unified ?? {})) put(key, w?.utilization, w?.resetsAt);
  if (info.rateLimitType) put(info.rateLimitType, info.utilization, info.resetsAt);
  return { windows, status: info.status, type: info.rateLimitType ?? null, resetsAt: info.resetsAt ? info.resetsAt * 1000 : null };
}
export class SessionManager {
  private sessions = new Map<string, Session>();
  private listeners = new Set<() => void>();
  private past: { at: number; list: SDKSessionInfo[]; folders: Folder[] } | null = null;
  private pastLoad: Promise<void> | null = null;
  private notifyQueued = false;
  private capQueued = false;
  private resuming = new Map<string, Promise<Session>>();
  private limits: Limits | null = null;
  private limitListeners = new Set<(l: Limits) => void>();
  readonly titles = new Titles();
  readonly voice = new Voice();
  private phone = new Phone();
  private dismissals = new Dismissals();
  private hub: Hub = {
    titles: this.titles,
    voice: this.voice,
    phone: this.phone,
    commands: new CommandCache(),
    accountDismissed: (id) => this.dismissals.has(id),
    dismissAccount: (id) => {
      this.dismissals.add(id);
      for (const s of this.sessions.values()) s.mapChanged();
    },
    limits: () => this.limits,
    peers: (id) => this.roster().filter((s) => s.id !== id),
    rateLimit: (info) => {
      this.limits = mergeLimits(this.limits, info);
      for (const s of this.sessions.values()) s.mapChanged();
      for (const fn of this.limitListeners) fn(this.limits);
    },
    cliIdle: () => {
      if (this.capQueued) return;
      this.capQueued = true;
      queueMicrotask(() => {
        this.capQueued = false;
        this.capIdle();
      });
    },
  };

  // Least recently used first out; a session that is working, waiting on the user or running agents never counts as idle.
  private capIdle() {
    const idle = [...this.sessions.values()].filter((s) => s.idleCli).sort((a, b) => b.usedAt - a.usedAt);
    for (const s of idle.slice(IDLE_CLIS)) s.release();
  }

  currentLimits() {
    return this.limits;
  }

  onLimits(fn: (l: Limits) => void) {
    this.limitListeners.add(fn);
    return () => this.limitListeners.delete(fn);
  }

  get(id: string) {
    return this.sessions.get(id);
  }

  syncHandoffAt() {
    for (const s of this.sessions.values()) s.syncHandoffAt();
  }

  roster(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  onRoster(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Several changes in one tick become one roster broadcast.
  private changed = () => {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const fn of this.listeners) fn();
      // Other sessions' heads-up list shows this one's state.
      for (const s of this.sessions.values()) s.mapChanged();
    });
  };

  private add(s: Session) {
    this.sessions.set(s.id, s);
    this.changed();
    return s;
  }

  async openNew(path: string, settings: Settings) {
    const cwd = expand(path);
    if (!(await isDir(cwd))) throw new Error(`Not a folder: ${path}`);
    const s = new Session({ id: randomUUID(), cwd, name: basename(cwd) || cwd, branch: await gitBranch(cwd), resumeId: null, ...settings }, this.changed, this.hub);
    return this.add(s);
  }

  resume(id: string) {
    const open = this.sessions.get(id);
    if (open) return Promise.resolve(open);
    // Two clicks on the same row must not start two processes.
    let p = this.resuming.get(id);
    if (!p) {
      p = this.load(id).finally(() => this.resuming.delete(id));
      this.resuming.set(id, p);
    }
    return p;
  }

  private async load(id: string) {
    const info = await getSessionInfo(id);
    if (!info) throw new Error('That session was not found.');
    if (!info.cwd || !(await isDir(info.cwd))) throw new Error(`Its folder no longer exists: ${info.cwd ?? 'unknown'}`);
    const messages = await getSessionMessages(id, { dir: info.cwd });
    // The transcript's branch is stale (and "HEAD" outside a repo), so read it live.
    const branch = await gitBranch(info.cwd);
    const { events, chapters, tools } = historyOf(messages, info.cwd);
    const first = messages[0] as (SessionMessage & { isCompactSummary?: boolean }) | undefined;
    const firstUuid = first?.isCompactSummary ? first.uuid : undefined;
    const s = new Session({ id, cwd: info.cwd, name: shortTitle(titleOf(info)), branch, resumeId: id, chapters, tools, firstUuid, ...DEFAULTS }, this.changed, this.hub);
    s.seed(events);
    return this.add(s);
  }

  async pastSessions(): Promise<{ sessions: PastSession[]; folders: Folder[] }> {
    if (!this.past || Date.now() - this.past.at > PAST_TTL_MS) {
      this.pastLoad ??= (async () => {
        const list = await listSessions({ limit: 500 });
        this.past = { at: Date.now(), list, folders: await recentFolders(list) };
      })().finally(() => (this.pastLoad = null));
      await this.pastLoad;
    }
    const sessions = this.past!.list
      .filter((s) => !this.sessions.has(s.sessionId))
      .map((s) => ({
        id: s.sessionId, name: titleOf(s), cwd: s.cwd ?? '', branch: s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : null,
        lastModified: s.lastModified, archived: s.tag === ARCHIVED_TAG,
      }));
    return { sessions, folders: this.past!.folders };
  }

  // The cached past entry for a transcript, if the list is loaded.
  private pastEntry(tid: string) {
    return this.past?.list.find((x) => x.sessionId === tid);
  }

  // A closed session goes back into the cached list (and its folder to the front) instead of forcing a re-list.
  private async remember(s: Session) {
    const tid = s.transcriptId;
    const past = this.past;
    if (!past || !tid) return;
    const old = past.list.find((x) => x.sessionId === tid);
    const lastModified = Math.max(old?.lastModified ?? 0, s.wroteAt) || Date.now();
    const entry: SDKSessionInfo = { ...old, sessionId: tid, summary: old?.summary ?? s.name, lastModified, cwd: s.cwd, ...(s.branch ? { gitBranch: s.branch } : {}) };
    past.list = [entry, ...past.list.filter((x) => x !== old)].sort((a, b) => b.lastModified - a.lastModified);
    const folder = past.folders.find((f) => f.path === s.cwd);
    if (folder && !s.wroteAt) return;
    const moved = folder ?? { path: s.cwd, branch: s.branch, hasChildren: await hasSubdirs(s.cwd) };
    past.folders = [moved, ...past.folders.filter((f) => f.path !== s.cwd)];
  }

  // Frees the CLI process and drops the session from the dock; the transcript stays.
  async close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.changed();
    this.voice.clear(id);
    await this.remember(s);
    await Promise.race([s.close(), new Promise((r) => setTimeout(r, EXIT_WAIT_MS))]);
  }

  async rename(id: string, title: string) {
    const s = this.sessions.get(id);
    if (s) await s.rename(title);
    else await renameSession(id, title);
    const e = this.pastEntry(s?.transcriptId ?? id);
    if (e) e.customTitle = title;
  }

  // Archiving an open session closes it first; unarchiving leaves it running.
  async setArchived(id: string, archived: boolean) {
    const tid = archived ? await this.detach(id) : (this.sessions.get(id)?.transcriptId ?? id);
    if (!tid) return;
    await tagSession(tid, archived ? ARCHIVED_TAG : null);
    const e = this.pastEntry(tid);
    if (e) e.tag = archived ? ARCHIVED_TAG : undefined;
  }

  async remove(id: string) {
    const tid = await this.detach(id);
    if (!tid) return;
    await deleteSession(tid);
    search.forget(tid);
    const past = this.past;
    const gone = this.pastEntry(tid);
    if (!past || !gone) return;
    past.list = past.list.filter((x) => x !== gone);
    if (!past.list.some((x) => x.cwd === gone.cwd)) past.folders = past.folders.filter((f) => f.path !== gone.cwd);
  }

  // Closes the session if open; returns its transcript id, or null when nothing was saved yet.
  private async detach(id: string) {
    const s = this.sessions.get(id);
    if (!s) return id;
    const tid = s.transcriptId;
    await this.close(id);
    return tid;
  }

  closeAll() {
    this.titles.close();
    this.voice.close();
    this.phone.close();
    closeNotes();
    for (const s of this.sessions.values()) s.close();
  }
}
