import { randomUUID } from 'node:crypto';
import { basename, sep } from 'node:path';
import { deleteSession, forkSession, getSessionInfo, getSessionMessages, listSessions, renameSession, tagSession } from '@anthropic-ai/claude-agent-sdk';
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
import { forgetMcp } from './mcp.ts';
import { tuning } from './profile.ts';
import { search } from './search/index.ts';
import { ARCHIVED_TAG, CODEX_EFFORTS, EFFORTS, MODEL_IDS, MODES, PROVIDER_CAPS, codexDefault, providerOf, type CodexModel, type Effort, type Folder, type LimitKey, type Limits, type PastSession, type SessionSummary, type Settings } from './protocol.ts';
import { Workspace, interruptNote, validEffort, type Tab } from './workspace.ts';
import { codex } from './codex/client.ts';
import { codexAccount } from './codex/account.ts';
import { connect } from './connect.ts';
import { CodexPast } from './codex/past.ts';
import { codexHistory } from './codex/history.ts';
import { archiveThread, deleteThread, readThread, setThreadName, unarchiveThread } from './codex/threads.ts';
import type { Thread } from './codex/types.ts';
import { LineageStore, type Worktree } from './lineage.ts';
import { forkPoint, moveTranscript } from './branch.ts';
import { transcriptCwd } from './watch.ts';
import { addWorktree, blockedRemove, dropFreshWorktree, removeWorktree, repoKey } from './worktree.ts';
import { saveHandoff } from './session/handoff.ts';
import type { SessionTransfer } from './appTools.ts';
import { GroupStore } from './groups.ts';
import type { GroupState, SessionOrigin } from './protocol.ts';

// Edits made here update the cached list in place, so a re-list only picks up sessions made elsewhere.
const PAST_TTL_MS = 60_000;
const EXIT_WAIT_MS = 3000;
// Read at use time: saving settings replaces config.defaults, and resumed tabs must see the new ones.
const defaults = (): Settings => config.defaults;
// A Claude transcript always reopens on Claude, even when the default model is a Codex one.
const CLAUDE_FALLBACK = 'claude-sonnet-5-5';
const claudeDefaults = (): Settings => {
  const d = defaults();
  return providerOf(d.model) === 'claude' ? d : { ...d, model: CLAUDE_FALLBACK };
};

// Claude signed out and Codex signed in: a new tab asking for Claude starts on Codex instead.
const codexOnly = (s: Settings) => providerOf(s.model) === 'claude' && connect.status?.loggedIn === false && !!codexAccount.status?.signedIn;
export const tabDefaults = (s: Settings, models: CodexModel[] | null = codexAccount.cachedModels): Settings =>
  (codexOnly(s) && models && codexDefault(models, s)) || s;

// Distinct project folders, most recent first, skipping ones that are gone.
async function recentFolders(list: { cwd?: string }[]): Promise<Folder[]> {
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
// The id a closed session is listed under: its transcript, or its Codex thread.
const savedIdOf = (s: Session) => (s.provider === 'codex' ? s.codexThreadId : s.transcriptId);

// The thread's own model, or the catalog default when it never recorded one.
async function codexModel(t: Thread) {
  if (t.model && providerOf(t.model) === 'codex') return t.model;
  const def = (await codexAccount.models()).find((m) => m.isDefault);
  if (!def) throw new Error('Codex has no default model to resume this thread with.');
  return def.id;
}

// A saved tab's settings, or null when they no longer fit its provider.
const settingsOf = (t: Tab): Settings | null =>
  MODES.includes(t.mode) && providerOf(t.model) === t.provider && (t.provider === 'codex' || MODEL_IDS.includes(t.model)) && validEffort(t.provider, t.effort)
    ? { mode: t.mode, model: t.model, effort: t.effort }
    : null;

// A restored tab keeps its browser choice, null included; one saved before the choice existed asks on its next browser call.
const choiceOf = (t: Tab) => t.browserChoice ?? null;

const parkedSummary = (t: Tab): SessionSummary => ({
  id: t.id, name: t.name, cwd: t.cwd, branch: t.branch, state: 'idle', needsYou: false, background: false, lastActive: t.lastActive, doneAt: 0,
  mode: t.mode, model: t.model, effort: t.effort, mcp: [], browserChoice: choiceOf(t), provider: t.provider, caps: PROVIDER_CAPS[t.provider], fresh: !t.transcriptId && !t.codexThreadId,
  ...(t.interrupted ? { interrupted: true as const } : {}),
});

function tabOfSession(s: Session): Tab {
  const sum = s.summary();
  return {
    id: s.id, cwd: s.cwd, name: s.name, ...(s.spoken ? { spoken: s.spoken } : {}), branch: s.branch, provider: s.provider, transcriptId: s.transcriptId, codexThreadId: s.codexThreadId,
    mode: s.mode, model: s.model, effort: s.effort, lastActive: s.lastActive,
    interrupted: interruptNote(sum.state === 'working', sum.needsYou, sum.background) ?? s.interruptedNote, browserChoice: sum.browserChoice ?? null,
  };
}

// Branch links a parent's summary carries, newest first; older ones drop off the list.
const BRANCH_LINKS = 12;

const LIMIT_KEYS: LimitKey[] =['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
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
  private codexPast = new CodexPast();
  private codexFolders: Folder[] = [];
  private pastLoad: Promise<void> | null = null;
  private notifyQueued = false;
  private capQueued = false;
  private resuming = new Map<string, Promise<Session>>();
  // Tabs from before a server restart: listed in the dock, loaded on first view, and no CLI until intent.
  private parked = new Map<string, Tab>();
  private waking = new Map<string, Promise<Session | undefined>>();
  // Dock order across parked and live tabs.
  private rank = new Map<string, number>();
  private ranks = 0;
  private workspace = new Workspace(() => this.tabs());
  private lineage = new LineageStore();
  readonly groups = new GroupStore();
  // Source tabs with a branch being made, so a double click cannot fork twice.
  private branching = new Set<string>();
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
    peers: (id) => this.peers(id),
    peerAsk: (id) => this.sessions.get(id)?.plainAsk() ?? null,
    sessions: (id) => ({
      open: async (args, signal) => {
        const s = await this.openSeeded(id, args, signal);
        return `Opened session ${s.id} in ${s.cwd}. Its first turn has the handoff and user instruction. Use session_message with this id for follow-ups.`;
      },
      message: async (target, text) => {
        await this.groupMessage(id, target, text, 'agent');
        return `Message sent to session ${target}.`;
      },
      summary: async (text, report) => {
        if (!text) return this.readGroup(id) || 'The shared summary is empty.';
        const g = this.groups.append(id, text);
        if (report && g.main.id !== id && (this.sessions.has(g.main.id) || this.parked.has(g.main.id))) {
          await this.groupMessage(id, g.main.id, text, 'agent');
        }
        this.changed();
        return 'Shared summary updated.';
      },
    }),
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

  constructor() {
    for (const t of this.workspace.load()) {
      this.parked.set(t.id, t);
      this.rank.set(t.id, this.ranks++);
    }
  }

  private byRank = (a: { id: string }, b: { id: string }) => (this.rank.get(a.id) ?? Infinity) - (this.rank.get(b.id) ?? Infinity);

  private tabs(): Tab[] {
    return [...[...this.sessions.values()].map(tabOfSession), ...this.parked.values()].sort(this.byRank);
  }

  // Least recently used first out; a session that is working, waiting on the user or running agents never counts as idle.
  // A CLI just warmed for typing ranks ahead of used ones, so another tab's turn end does not stop it.
  capIdle() {
    const all = [...this.sessions.values()].sort((a, b) => Number(b.warmFresh) - Number(a.warmFresh) || b.usedAt - a.usedAt);
    for (const s of all.filter((x) => x.idleCli).slice(tuning().idleClis)) s.release();
    for (const s of all.filter((x) => x.idleThread).slice(tuning().idleThreads)) s.release();
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

  // The open tab for an id: its own, its transcript (lineage links use those), or the Codex thread a new tab started.
  private openFor(id: string) {
    return this.sessions.get(id) ?? [...this.sessions.values()].find((s) => s.transcriptId === id || s.codexThreadId === id);
  }

  private parkedFor(id: string) {
    return this.parked.get(id) ?? [...this.parked.values()].find((t) => t.transcriptId === id || t.codexThreadId === id);
  }

  private isCodex(id: string) {
    const s = this.openFor(id);
    if (s) return s.provider === 'codex';
    const t = this.parkedFor(id);
    return t ? t.provider === 'codex' : !!this.codexPast.get(id);
  }

  // A restored tab loads its history when first viewed; its CLI still starts only on intent.
  wake(id: string): Promise<Session | undefined> {
    const t = this.parked.get(id);
    if (!t) return Promise.resolve(this.sessions.get(id));
    let p = this.waking.get(id);
    if (!p) {
      p = this.unpark(t).finally(() => this.waking.delete(id));
      this.waking.set(id, p);
    }
    return p;
  }

  private async unpark(t: Tab) {
    let s: Session;
    try {
      s = await this.restoreTab(t);
    } catch (err) {
      if (this.parked.delete(t.id)) {
        this.rank.delete(t.id);
        this.changed();
      }
      throw err;
    }
    // Closed while it loaded.
    if (!this.parked.delete(t.id)) {
      void s.close();
      return undefined;
    }
    s.lastActive = t.lastActive;
    if (t.interrupted) s.markInterrupted(t.interrupted);
    return this.add(s);
  }

  private async restoreTab(t: Tab): Promise<Session> {
    if (t.provider === 'codex' && t.codexThreadId) return this.codexTab(t.codexThreadId, t);
    if (t.provider === 'claude') {
      // A first turn cut off by the restart left a transcript the tab had not recorded yet.
      const tid = t.transcriptId ?? t.id;
      const info = await getSessionInfo(tid);
      if (info) return this.claudeTab(tid, info, t);
      if (t.transcriptId) throw new Error('That session was not found.');
    }
    if (!(await isDir(t.cwd))) throw new Error(`Its folder no longer exists: ${t.cwd}`);
    const settings = settingsOf(t) ?? tabDefaults(defaults());
    return new Session({ id: t.id, cwd: t.cwd, name: t.name, branch: await gitBranch(t.cwd), resumeId: null, browserChoice: choiceOf(t), ...settings }, this.changed, this.hub);
  }

  syncHandoffAt() {
    for (const s of this.sessions.values()) s.syncHandoffAt();
  }

  syncBrowserAgents() {
    for (const s of this.sessions.values()) void s.syncBrowserAgents();
  }

  syncBrowserSupport() {
    for (const s of this.sessions.values()) s.syncBrowserSupport();
  }

  roster(): SessionSummary[] {
    for (const s of this.sessions.values()) this.groups.bind(s.id, savedIdOf(s), s);
    const rows: [SessionSummary, string | null][] = [
      ...[...this.sessions.values()].map((s): [SessionSummary, string | null] => [s.summary(), s.transcriptId]),
      ...[...this.parked.values()].map((t): [SessionSummary, string | null] => [parkedSummary(t), t.transcriptId]),
    ];
    const names = new Map(rows.flatMap(([r, tid]) => (tid ? [[tid, r.name] as const] : [])));
    return rows.map(([r, tid]) => {
      const g = this.groups.of(r.id);
      return { ...this.withLineage(r, tid, names), ...(g ? { group: { id: g.id, mainId: g.main.id } } : {}) };
    }).sort(this.byRank);
  }

  groupState(): GroupState[] {
    for (const s of this.sessions.values()) {
      const g = this.groups.of(s.id);
      if (g && s.lastActive > g.touchedAt) this.groups.touch(g, s.lastActive);
    }
    this.groups.cleanup(config.groupAutoCleanup, new Set([...this.sessions.values()].filter((s) => s.status === 'working').map((s) => s.id)));
    return this.groups.list().map(({ entries, ...g }) => ({ ...g, unread: g.revision - g.read, cleanupAt: config.groupAutoCleanup ? g.touchedAt + 30 * 86400_000 : null, cleanupNotice: config.groupAutoCleanup && Date.now() - g.touchedAt >= 23 * 86400_000 }));
  }

  async groupMessage(id: string, target: string, text: string, actor: SessionOrigin['actor']) {
    if (target === id) throw new Error('Choose another session.');
    const s = await this.wake(target);
    if (!s) throw new Error('That session is not open.');
    const g = this.groups.of(id);
    const role = g && this.groups.of(target) === g ? (g.main.id === id ? 'main' : 'child') : 'peer';
    s.send(text, [], [], [], false, undefined, undefined, [], { sessionId: id, role, actor });
    if (g) this.groups.touch(g);
    this.changed();
  }

  readGroup(id: string, unreadOnly = false) { const text = this.groups.read(id, unreadOnly); this.changed(); return text; }
  keepGroup(id: string) { this.groups.keep(id); this.changed(); }
  deleteGroup(id: string) { this.groups.delete(id); this.changed(); }

  // Every session's map reads its peers on each rebuild, so a live peer's summary is rebuilt only when its peerKey changes.
  // Rows skip lineage; one entry per open session.
  private peerRows = new Map<string, { key: string; row: SessionSummary }>();
  private peers(id: string): SessionSummary[] {
    if (this.peerRows.size > this.sessions.size) for (const k of this.peerRows.keys()) if (!this.sessions.has(k)) this.peerRows.delete(k);
    const out: SessionSummary[] = [];
    for (const s of this.sessions.values()) {
      if (s.id === id) continue;
      const key = s.peerKey();
      let c = this.peerRows.get(s.id);
      if (c?.key !== key) this.peerRows.set(s.id, (c = { key, row: s.summary() }));
      out.push(c.row);
    }
    for (const t of this.parked.values()) if (t.id !== id) out.push(parkedSummary(t));
    return out.sort(this.byRank);
  }

  // Open tabs show their current names; closed ones the name saved when the branch was made.
  private withLineage(r: SessionSummary, tid: string | null, names: Map<string, string>): SessionSummary {
    const up = this.lineage.of(tid);
    const kids = this.lineage.childrenOf(tid);
    if (!up && !kids.length) return r;
    return {
      ...r,
      ...(up ? { parent: { id: up.parent, name: names.get(up.parent) ?? up.parentName } } : {}),
      ...(up?.worktree ? { worktree: up.worktree.path } : {}),
      ...(kids.length ? { branches: kids.slice(-BRANCH_LINKS).reverse().map((k) => ({ id: k.child, name: names.get(k.child) ?? k.name })) } : {}),
    };
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
      this.workspace.changed();
      for (const fn of this.listeners) fn();
      // Other sessions' heads-up list shows this one's state.
      for (const s of this.sessions.values()) s.mapChanged();
    });
  };

  private add(s: Session) {
    this.groups.bind(s.id, savedIdOf(s), s);
    this.sessions.set(s.id, s);
    if (!this.rank.has(s.id)) this.rank.set(s.id, this.ranks++);
    this.changed();
    return s;
  }

  async openNew(path: string, asked: Settings) {
    const cwd = expand(path);
    if (!(await isDir(cwd))) throw new Error(`Not a folder: ${path}`);
    const settings = codexOnly(asked) ? tabDefaults(asked, await codexAccount.models().catch(() => null)) : asked;
    const s = new Session({ id: randomUUID(), cwd, name: basename(cwd) || cwd, branch: await gitBranch(cwd), resumeId: null, newSession: true, ...settings }, this.changed, this.hub);
    return this.add(s);
  }

  async openSeeded(id: string, args: SessionTransfer, signal?: AbortSignal, actor: SessionOrigin['actor'] = 'agent') {
    const source = this.sessions.get(id);
    if (!source) throw new Error('That session is not open.');
    const group = this.groups.of(id);
    if (args.subsession) this.groups.canAdd(id);
    let cwd = expand(args.folder);
    if (!(await isDir(cwd))) throw new Error(`Not a folder: ${args.folder}`);
    const repo = await repoKey(cwd);
    const overlaps = repo && (await Promise.all(this.tabs().map((t) => repoKey(t.cwd)))).includes(repo);
    const own = args.subsession ? !!overlaps || !!args.worktree : overlaps ? await source.askWorktree(cwd, signal) : false;
    signal?.throwIfAborted();
    const doc = await saveHandoff(randomUUID(), args.handoff);
    let worktree: Worktree | null = null;
    let tab: Session;
    try {
      if (own) ({ cwd, worktree } = await addWorktree(cwd, randomUUID().slice(0, 8)));
      signal?.throwIfAborted();
      tab = await this.openNew(cwd, source.settings());
    } catch (err) {
      if (worktree) await dropFreshWorktree(worktree);
      throw err;
    }
    if (args.subsession) {
      this.groups.add({ id, savedId: savedIdOf(source), name: source.name, cwd: source.cwd, provider: source.provider, worktree: null }, { id: tab.id, savedId: savedIdOf(tab), name: tab.name, cwd, provider: tab.provider, worktree });
      if (!group) this.groups.append(id, args.handoff.slice(0, 2000));
    }
    const summary = args.subsession ? this.groups.read(tab.id) : '';
    this.changed();
    tab.seedSwitch(doc, source.provider, source.name, [], `User instruction:\n${args.instruction}\n\nWork in ${cwd}. Paths in the handoff may belong to the source checkout. Source session: ${id}. ${args.subsession ? `You are a sub-session. Do not create sub-sessions. Read and append decisions with group_summary; send a short report with report=true when done. Shared summary:\n${summary}\n` : ''}Start working on the user instruction now.`, { sessionId: id, role: args.subsession ? 'main' : 'peer', actor });
    return tab;
  }

  // A tab with messages moving to the other provider: it writes a handoff, a new tab on that provider starts from it, and the old tab stays.
  async switchProvider(id: string, model: string, effort: Effort) {
    const old = this.sessions.get(id);
    if (!old) throw new Error('That session is not open.');
    const doc = await old.prepareSwitch(providerOf(model));
    let s: Session;
    try {
      s = new Session({ id: randomUUID(), cwd: old.cwd, name: old.name, branch: await gitBranch(old.cwd), resumeId: null, newSession: true, mode: old.mode, model, effort }, this.changed, this.hub);
    } catch (e) {
      old.switchFailed(e);
      throw e;
    }
    this.add(s);
    s.seedSwitch(doc, old.provider, old.name, old.switched(s.id));
    return s;
  }

  // A new tab whose transcript is a saved fork of this one through item, with the same settings; the source stays as it is.
  // In a worktree, the fork moves to a new git worktree at the source's HEAD (uncommitted changes are not copied).
  async branch(id: string, item: string, inWorktree: boolean) {
    const src = this.sessions.get(id);
    if (!src) throw new Error('That session is not open.');
    if (src.provider !== 'claude') throw new Error('Codex conversations cannot be branched yet.');
    const tid = src.transcriptId;
    if (!tid) throw new Error('Nothing is saved yet. Send a message first.');
    if (this.branching.has(id)) throw new Error('A branch of this session is already being made.');
    this.branching.add(id);
    try {
      const at = forkPoint(await getSessionMessages(tid, { dir: src.cwd }), item, src.turnRunning);
      const title = `${src.name} (branch)`;
      const { sessionId: fork } = await forkSession(tid, { dir: src.cwd, upToMessageId: at, title });
      let cwd = src.cwd;
      let worktree: Worktree | null = null;
      if (inWorktree) {
        try {
          ({ worktree, cwd } = await addWorktree(src.cwd, fork.slice(0, 8)));
          await moveTranscript(fork, src.cwd, cwd);
        } catch (e) {
          if (worktree) await dropFreshWorktree(worktree).catch((err) => console.log(`branch: could not undo worktree ${worktree?.path}: ${String(err)}`));
          await deleteSession(fork).catch(() => {});
          throw e;
        }
      }
      this.lineage.add({ child: fork, parent: tid, parentName: src.name, name: title, at, worktree, createdAt: Date.now() });
      const info = await getSessionInfo(fork, { dir: cwd });
      if (!info) throw new Error('The branch was saved but could not be read back. Open it from the session list.');
      const tab = this.add(await this.claudeTab(fork, info, undefined, src.settings(), true));
      // Earlier messages still name the source checkout; edits there would land outside this branch.
      if (worktree) tab.noteOnce(`This conversation was branched into a git worktree. Work in ${cwd} from now on; paths under ${src.cwd} in earlier messages belong to the original checkout, so do not edit files there.`);
      return tab;
    } finally {
      this.branching.delete(id);
    }
  }

  resume(id: string) {
    const open = this.openFor(id);
    if (open) return Promise.resolve(open);
    const t = this.parkedFor(id);
    if (t) return this.wake(t.id).then((s) => s ?? Promise.reject(new Error('That session was closed.')));
    // Two clicks on the same row must not start two processes.
    let p = this.resuming.get(id);
    if (!p) {
      p = this.load(id).finally(() => this.resuming.delete(id));
      this.resuming.set(id, p);
    }
    return p;
  }

  private async load(id: string) {
    if (this.codexPast.get(id)) return this.loadCodex(id);
    const info = await getSessionInfo(id);
    // Not a transcript: maybe a Codex thread the cached list has not seen yet.
    if (!info && (await codex.checkBinary()).path) return this.loadCodex(id);
    if (!info) throw new Error('That session was not found.');
    return this.add(await this.claudeTab(id, info));
  }

  // Reopening it from history then keeps the model and effort; Codex threads record their own.
  private keepSettings(t: Pick<Tab, 'provider' | 'transcriptId' | 'model' | 'effort'>) {
    if (t.provider === 'claude' && t.transcriptId) this.workspace.remember(t.transcriptId, t.model, t.effort);
  }

  // The mode is not kept, so a reopened session never starts in Bypass unasked.
  private closedSettings(id: string): Settings | null {
    const c = this.workspace.recall(id);
    return c && MODEL_IDS.includes(c.model) && EFFORTS.includes(c.effort) ? { ...claudeDefaults(), model: c.model, effort: c.effort } : null;
  }

  // A restored tab keeps its own id, name, settings and browser choice; a branch takes its source's settings and starts
  // from the Settings browser default.
  private async claudeTab(id: string, info: SDKSessionInfo, tab?: Tab, from?: Settings, newSession = false) {
    const cwd = info.cwd || (await transcriptCwd(id));
    if (!cwd || !(await isDir(cwd))) throw new Error(`Its folder no longer exists: ${cwd ?? 'unknown'}`);
    const messages = await getSessionMessages(id, { dir: cwd });
    // The transcript's branch is stale (and "HEAD" outside a repo), so read it live.
    const branch = await gitBranch(cwd);
    const { events, chapters, tools } = historyOf(messages, cwd);
    const first = messages[0] as (SessionMessage & { isCompactSummary?: boolean }) | undefined;
    const firstUuid = first?.isCompactSummary ? first.uuid : undefined;
    const settings = (tab && settingsOf(tab)) || from || this.closedSettings(id) || claudeDefaults();
    const s = new Session(
      {
        id: tab?.id ?? id, cwd, name: tab?.name ?? shortTitle(titleOf(info)), ...(tab?.spoken ? { spoken: tab.spoken } : {}), branch, resumeId: id, newSession, chapters, tools, firstUuid,
        ...(tab ? { browserChoice: choiceOf(tab) } : {}), ...settings,
      },
      this.changed, this.hub,
    );
    s.seed(events);
    return s;
  }

  // A Codex thread as a tab whose id is the thread id; its newest turns show now, older ones load as the reader scrolls up.
  private async loadCodex(id: string) {
    return this.add(await this.codexTab(id));
  }

  private async codexTab(id: string, tab?: Tab) {
    const t = await readThread(id).catch(() => {
      throw new Error('That session was not found.');
    });
    if (!(await isDir(t.cwd))) throw new Error(`Its folder no longer exists: ${t.cwd}`);
    const [history, branch, model] = await Promise.all([codexHistory(id, t.cwd), gitBranch(t.cwd), codexModel(t)]);
    const name = tab?.name ?? shortTitle(oneLine(t.name || this.codexPast.get(id)?.name || t.preview || 'Untitled', 80));
    const effort = CODEX_EFFORTS.includes(t.reasoningEffort as Effort) ? (t.reasoningEffort as Effort) : 'medium';
    const { events, chapters, tools, earlier } = history;
    const settings = (tab && settingsOf(tab)) || { mode: defaults().mode, model, effort };
    const s = new Session(
      {
        id: tab?.id ?? id, cwd: t.cwd, name, ...(tab?.spoken ? { spoken: tab.spoken } : {}), branch, resumeId: null, codexThreadId: id, chapters, tools, ...(earlier ? { earlier } : {}),
        ...(tab ? { browserChoice: choiceOf(tab) } : {}), ...settings,
      },
      this.changed, this.hub,
    );
    s.seed(events);
    return s;
  }

  // Codex rows refresh only on intent or while the app-server runs anyway; true when the caller should send the list again.
  async refreshCodex(intent: boolean) {
    if (!(await this.codexPast.refresh(intent))) return false;
    this.codexFolders = await recentFolders(this.codexPast.rows.filter((r) => !r.archived));
    return true;
  }

  async pastSessions(): Promise<{ sessions: PastSession[]; folders: Folder[] }> {
    if (!this.past || Date.now() - this.past.at > PAST_TTL_MS) {
      this.pastLoad ??= (async () => {
        const list = await listSessions({ limit: 500 });
        this.past = { at: Date.now(), list, folders: await recentFolders(list) };
      })().finally(() => (this.pastLoad = null));
      await this.pastLoad;
    }
    const parked = [...this.parked.values()];
    const listed = new Set([...this.sessions.keys(), ...parked.flatMap((t) => [t.id, t.transcriptId ?? t.id, t.codexThreadId ?? t.id])]);
    const sessions: PastSession[] = this.past!.list
      .filter((s) => !listed.has(s.sessionId))
      .map((s) => ({
        id: s.sessionId, name: titleOf(s), cwd: s.cwd ?? '', branch: s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : null,
        lastModified: s.lastModified, archived: s.tag === ARCHIVED_TAG, provider: 'claude',
      }));
    if (!this.codexPast.rows.length) return { sessions, folders: this.past!.folders };
    const open = new Set([...listed, ...[...this.sessions.values()].flatMap((s) => s.codexThreadId ?? [])]);
    const all = [...sessions, ...this.codexPast.rows.filter((r) => !open.has(r.id))].sort((a, b) => b.lastModified - a.lastModified);
    // Folders from both lists, most recent first; open tabs count too, since the lists leave them out.
    const at = new Map<string, number>();
    for (const s of all) if (!s.archived) at.set(s.cwd, Math.max(at.get(s.cwd) ?? 0, s.lastModified));
    for (const s of [...this.sessions.values(), ...parked]) at.set(s.cwd, Math.max(at.get(s.cwd) ?? 0, s.lastActive));
    const claude = new Set(this.past!.folders.map((f) => f.path));
    const folders = [...this.past!.folders, ...this.codexFolders.filter((f) => !claude.has(f.path))].sort((a, b) => (at.get(b.path) ?? 0) - (at.get(a.path) ?? 0));
    return { sessions: all, folders };
  }

  // The cached past entry for a transcript, if the list is loaded.
  private pastEntry(tid: string) {
    return this.past?.list.find((x) => x.sessionId === tid);
  }

  // A closed session goes back into the cached list (and its folder to the front) instead of forcing a re-list.
  private async remember(s: Session) {
    const tid = savedIdOf(s);
    if (tid && s.provider === 'codex') {
      const old = this.codexPast.get(tid);
      const lastModified = Math.max(old?.lastModified ?? 0, s.wroteAt) || Date.now();
      this.codexPast.put({ id: tid, name: s.name, cwd: s.cwd, branch: s.branch, lastModified, archived: old?.archived ?? false, provider: 'codex' });
    }
    const past = this.past;
    if (!past || !tid) return;
    if (s.provider === 'claude') {
      const old = past.list.find((x) => x.sessionId === tid);
      const lastModified = Math.max(old?.lastModified ?? 0, s.wroteAt) || Date.now();
      const entry: SDKSessionInfo = { ...old, sessionId: tid, summary: old?.summary ?? s.name, lastModified, cwd: s.cwd, ...(s.branch ? { gitBranch: s.branch } : {}) };
      past.list = [entry, ...past.list.filter((x) => x !== old)].sort((a, b) => b.lastModified - a.lastModified);
    }
    const folder = past.folders.find((f) => f.path === s.cwd);
    if (folder && !s.wroteAt) return;
    const moved = folder ?? { path: s.cwd, branch: s.branch, hasChildren: await hasSubdirs(s.cwd) };
    past.folders = [moved, ...past.folders.filter((f) => f.path !== s.cwd)];
  }

  // Frees the CLI process and drops the session from the dock; the transcript stays.
  async close(id: string) {
    const live = this.sessions.get(id);
    if (live) this.groups.bind(id, savedIdOf(live), live);
    const p = this.parked.get(id);
    if (p) {
      this.parked.delete(id);
      this.rank.delete(id);
      this.keepSettings(p);
      this.changed();
      return;
    }
    const s = this.sessions.get(id);
    if (!s) return;
    this.keepSettings(s);
    this.sessions.delete(id);
    this.rank.delete(id);
    this.changed();
    this.voice.clear(id);
    await this.remember(s);
    await Promise.race([s.close(), new Promise((r) => setTimeout(r, EXIT_WAIT_MS))]);
  }

  async rename(id: string, title: string) {
    const s = this.openFor(id);
    const p = s ? undefined : this.parkedFor(id);
    if (s) await s.rename(title);
    else if (p) {
      p.name = title;
      this.changed();
      if (p.provider === 'codex' && p.codexThreadId) await setThreadName(p.codexThreadId, title);
      else if (p.provider === 'claude' && p.transcriptId) await renameSession(p.transcriptId, title);
    } else if (this.codexPast.get(id)) await setThreadName(id, title);
    else await renameSession(id, title);
    const row = this.codexPast.get(s?.codexThreadId ?? p?.codexThreadId ?? id);
    if (row) row.name = title;
    const e = this.pastEntry(s?.transcriptId ?? p?.transcriptId ?? id);
    if (e) e.customTitle = title;
    this.lineage.rename(s?.transcriptId ?? p?.transcriptId ?? id, title);
  }

  // Archiving an open session closes it first; unarchiving leaves it running.
  async setArchived(id: string, archived: boolean) {
    const codexTab = this.isCodex(id);
    const tid = archived ? await this.detach(id) : ((codexTab ? this.openFor(id)?.codexThreadId : this.sessions.get(id)?.transcriptId) ?? id);
    if (!tid) return;
    if (codexTab) {
      await (archived ? archiveThread(tid) : unarchiveThread(tid));
      const row = this.codexPast.get(tid);
      if (row) row.archived = archived;
      return;
    }
    await tagSession(tid, archived ? ARCHIVED_TAG : null);
    const e = this.pastEntry(tid);
    if (e) e.tag = archived ? ARCHIVED_TAG : undefined;
  }

  // withWorktree also removes a branch's managed worktree; it is checked before anything closes, so a dirty one keeps the tab.
  async remove(id: string, withWorktree = false) {
    const own = this.openFor(id)?.transcriptId ?? this.parkedFor(id)?.transcriptId ?? id;
    const wt = withWorktree ? this.lineage.of(own)?.worktree : null;
    if (withWorktree) {
      if (!wt) throw new Error('This session has no worktree made by tarcsweb.');
      const why = this.worktreeShared(wt, id, own) ?? (await blockedRemove(wt));
      if (why) throw new Error(why);
    }
    const codexTab = this.isCodex(id);
    // MCP choices are saved under the tab id, which can differ from the transcript or thread id.
    const tabId = (this.openFor(id) ?? this.parkedFor(id))?.id ?? id;
    const tid = await this.detach(id);
    if (!tid) { this.groups.forget(tabId); return forgetMcp([id, tabId]); }
    if (codexTab) {
      await deleteThread(tid);
      this.groups.forget(tabId);
      this.codexPast.rows = this.codexPast.rows.filter((r) => r.id !== tid);
      return forgetMcp([id, tabId, tid]);
    }
    if (wt) await removeWorktree(wt);
    await deleteSession(tid);
    this.groups.forget(tabId);
    forgetMcp([id, tabId, tid]);
    this.lineage.forget(tid);
    search.forget(tid);
    const past = this.past;
    const gone = this.pastEntry(tid);
    if (!past || !gone) return;
    past.list = past.list.filter((x) => x !== gone);
    if (!past.list.some((x) => x.cwd === gone.cwd)) past.folders = past.folders.filter((f) => f.path !== gone.cwd);
  }

  // Why another session still needs the worktree folder: an open tab working in it, or a branch made without its own worktree.
  private worktreeShared(wt: Worktree, id: string, tid: string): string | null {
    const self = this.openFor(id) ?? this.parkedFor(id);
    const other = [...this.sessions.values(), ...this.parked.values()].find((t) => t !== self && (t.cwd === wt.path || t.cwd.startsWith(wt.path + sep)));
    const name = other?.name ?? this.lineage.childrenOf(tid).find((l) => !l.worktree)?.name;
    return name ? `"${name}" still works in ${wt.path}, so the worktree was kept.` : null;
  }

  // Closes the session if open; returns its transcript or thread id, or null when nothing was saved yet.
  private async detach(id: string) {
    const s = this.openFor(id);
    const p = s ? undefined : this.parkedFor(id);
    if (p) {
      await this.close(p.id);
      return p.provider === 'codex' ? p.codexThreadId : p.transcriptId;
    }
    if (!s) return id;
    const tid = savedIdOf(s);
    await this.close(s.id);
    return tid;
  }

  closeAll() {
    this.workspace.final();
    this.lineage.final();
    void this.groups.final();
    this.titles.close();
    this.voice.close();
    this.phone.close();
    closeNotes();
    for (const s of this.sessions.values()) s.close();
  }
}
