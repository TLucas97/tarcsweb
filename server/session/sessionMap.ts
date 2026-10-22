import { createHash, randomUUID } from 'node:crypto';
import type { ContextUsage, HandoffState, HeadsUp, LimitKey, Limits, SessionMap, SessionSummary, Status, Toast, UiNode } from '../protocol.ts';
import type { AgentTracker } from '../agents.ts';
import { APP_TOOLS, EDIT_TOOLS, toolName } from '../tools.ts';
import { oneLine } from '../text.ts';
import { tuning } from '../profile.ts';
import { FOREVER } from '../dismissals.ts';
import { waitingText, type Ask } from './asks.ts';
import { guard } from './util.ts';

export const TOAST_MS = 5000;
const CTX_WARN = 60;
// A window's reset time to the minute, so a second of jitter in the CLI's report keeps the same id.
const minute = (ms: number | null) => (ms ? Math.round(ms / 60_000) : 0);
const LIMIT_WARN = 80;
const LIMIT_LABEL: Record<LimitKey, string> = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' };
const tok = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const clock = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

// The session state the map reads, taken fresh on every build.
export type MapView = {
  status: Status;
  activity: string;
  turnOpen: boolean;
  turnNo: number;
  stuck: boolean;
  slowFolder: boolean;
  handoff: HandoffState | null;
  ctx: ContextUsage | null;
  cost: number | null;
  tokens: number | null;
  compacting: boolean;
  compactions: number;
  compactError: string | null;
  lastCompact: { pre: number; post: number | null; trigger: string } | null;
  above: UiNode | null;
};

export type MapHost = {
  id: string;
  cwd: string;
  view: () => MapView;
  cards: () => ReadonlyMap<string, Ask>;
  tracker: () => AgentTracker;
  failedAgents: () => { id: string; name: string; error: string; endedAt: number }[];
  chapters: () => SessionMap['chapters'];
  skills: () => SessionMap['skills'];
  peers: (id: string) => SessionSummary[];
  limits: () => Limits | null;
  // Account-wide heads-ups (usage limits): dismissed once for every session, and kept across restarts.
  accountDismissed: (id: string) => boolean;
  dismissAccount: (id: string) => void;
};

// The session map the dock and sheet show: chapters, the live line, heads-ups, usage and toasts.
export class MapFeed {
  private host: MapHost;
  private toasts: Toast[] = [];
  private dismissed = new Set<string>();
  private listeners = new Set<(json: string) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = '';

  constructor(host: MapHost) {
    this.host = host;
  }

  get listening() {
    return this.listeners.size > 0;
  }

  map(): SessionMap {
    const v = this.host.view();
    return {
      chapters: this.host.chapters(), now: this.nowText(v), need: this.host.cards().size > 0, headsUps: this.headsUps(v),
      usage: { ctx: v.ctx, cost: v.cost, tokens: v.tokens, compacting: v.compacting },
      handoff: v.handoff, toasts: this.toasts.filter((t) => t.until > Date.now()), above: v.above,
      skills: this.host.skills(),
    };
  }

  toast(text: string, ms = TOAST_MS) {
    const now = Date.now();
    this.toasts = [...this.toasts.filter((t) => t.until > now).slice(-4), { id: randomUUID(), text, until: now + ms }];
    this.changed();
  }

  // Listeners get the serialized map message, built once for every client.
  subscribe(fn: (json: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Coalesced and deduplicated: streaming text only matters when the live line changes.
  changed() {
    this.timer ??= setTimeout(() => guard('map flush', () => {
      this.timer = null;
      if (!this.listeners.size) return;
      const json = JSON.stringify(this.map());
      if (json === this.last) return;
      this.last = json;
      const msg = `{"type":"map","sessionId":${JSON.stringify(this.host.id)},${json.slice(1)}`;
      for (const fn of this.listeners) fn(msg);
    }), tuning().mapMs);
  }

  dismiss(id: string) {
    if (id.startsWith('limit') || id.startsWith(FOREVER)) {
      this.host.dismissAccount(id);
      return;
    }
    this.dismissed.add(id);
    this.changed();
  }

  private nowText(v: MapView) {
    if (v.handoff?.phase === 'writing') return 'Writing the handoff';
    if (v.handoff?.phase === 'handing') return 'Handing over';
    if (v.compacting) return 'Compacting the conversation';
    const ask = this.host.cards().values().next().value;
    if (ask) return waitingText(ask);
    if (v.status === 'working') return v.activity || 'Thinking';
    const { running } = this.host.tracker().procState();
    return running ? `Idle · ${running} process${running > 1 ? 'es' : ''} running` : 'Idle';
  }

  private headsUps(v: MapView): HeadsUp[] {
    const out: HeadsUp[] = [];
    const add = (h: Omit<HeadsUp, 'dismissable'>, dismissable = true) => out.push({ ...h, dismissable });
    for (const [id, a] of this.host.cards()) {
      if (a.tool === APP_TOOLS.choice || a.tool === APP_TOOLS.round) {
        const text = a.tool === APP_TOOLS.round ? 'Some questions are waiting for you' : 'A question is waiting for you';
        add({ id: `choice:${id}`, need: true, text, detail: a.summary, action: { kind: 'review', target: id } }, false);
        continue;
      }
      const what = a.tool === 'Bash' ? 'A command' : EDIT_TOOLS.test(a.tool) ? 'A file edit' : toolName(a.tool);
      add({ id: `perm:${id}`, need: true, text: `${what} is waiting for you`, detail: `${toolName(a.tool)} · ${a.summary}`, action: { kind: 'review', target: id } }, false);
    }
    if (v.stuck && (v.status === 'working' || v.turnOpen)) {
      add({
        id: `stop-stuck:${v.turnNo}`, need: true, text: 'Claude Code is not responding',
        detail: 'Force stop ends its process, and background agents stop with it. The conversation is kept.', action: { kind: 'force-stop', target: this.host.id },
      });
    }
    const peers = this.host.peers(this.host.id);
    for (const p of peers.filter((x) => x.needsYou)) {
      add({ id: `peer:${p.id}:waiting`, need: true, text: `${p.name} needs you`, detail: 'Another session is waiting for a permission', action: { kind: 'switch', target: p.id } });
    }
    const limits = this.host.limits();
    if (limits?.status === 'rejected') {
      const label = LIMIT_LABEL[limits.type as LimitKey] ?? 'usage';
      add({ id: `limit-rejected:${limits.type}:${minute(limits.resetsAt)}`, need: true, text: 'Usage limit reached', detail: `The ${label} limit${limits.resetsAt ? ` resets ${clock(limits.resetsAt)}` : ' is used up'}`, action: null });
    }
    for (const p of this.host.tracker().procState().failed) {
      const detail = [p.exit !== null ? `Exit code ${p.exit}` : '', p.summary ?? ''].filter(Boolean).join(' · ') || 'See the log';
      add({ id: `proc:${p.id}`, need: false, text: `${oneLine(p.command, 60)} failed`, detail, action: { kind: 'log', target: p.id } });
    }
    for (const a of this.host.failedAgents()) {
      add({ id: `agent-failed:${a.id}:${a.endedAt}`, need: false, text: `${oneLine(a.name, 60)} failed`, detail: oneLine(a.error, 160), action: { kind: 'agent', target: a.id } });
    }
    if (v.slowFolder) {
      const id = `${FOREVER}${createHash('sha1').update(this.host.cwd).digest('hex').slice(0, 16)}`;
      add({ id, need: false, text: 'Slow folder: move it into your Linux home', detail: 'This project is on the Windows drive, where file access from WSL is slow. Moving it into your Linux home folder makes everything faster.', action: null });
    }
    for (const p of peers.filter((x) => x.state === 'done')) {
      add({ id: `peer:${p.id}:done:${p.doneAt}`, need: false, text: `${p.name} finished`, detail: 'A turn ended in another session', action: { kind: 'switch', target: p.id } });
    }
    if (v.compacting) add({ id: 'compacting', need: false, text: 'Compacting the conversation', detail: 'Older turns are being summarized', action: null }, false);
    else if (v.compactError) add({ id: `compact-failed:${v.compactions}`, need: false, text: 'Compaction failed', detail: oneLine(v.compactError, 120), action: null });
    else if (v.lastCompact) {
      const c = v.lastCompact;
      const how = c.trigger === 'handoff' ? 'with a handoff' : c.trigger === 'manual' ? 'by request' : 'automatic';
      const detail = `${tok(c.pre)}${c.post !== null ? ` → ${tok(c.post)}` : ''} tokens · ${how}`;
      add({ id: `compacted:${v.compactions}`, need: false, text: 'Context compacted', detail, action: null });
    }
    if (v.ctx && v.ctx.pct >= CTX_WARN) {
      const band = Math.floor(v.ctx.pct / 10) * 10;
      const at = v.ctx.compactAt !== null ? ` · compacts at ${v.ctx.compactAt}%` : '';
      add({ id: `ctx:${band}`, need: false, text: 'Context is filling up', detail: `${v.ctx.pct}% used${at}`, action: null });
    }
    if (limits && limits.status !== 'rejected') {
      for (const [key, w] of Object.entries(limits.windows) as [LimitKey, { pct: number | null; resetsAt: number | null }][]) {
        const warned = limits.status === 'allowed_warning' && limits.type === key;
        if (!warned && (w.pct === null || w.pct < LIMIT_WARN)) continue;
        const pct = w.pct !== null ? `${Math.round(w.pct)}% used` : 'Getting close';
        add({
          id: `limit:${key}:${minute(w.resetsAt)}:${w.pct !== null ? Math.floor(w.pct / 10) : 'w'}`, need: false, text: `Close to the ${LIMIT_LABEL[key]} limit`,
          detail: `${pct}${w.resetsAt ? ` · resets ${clock(w.resetsAt)}` : ''}`, action: null,
        });
      }
    }
    return out.filter((h) => !this.dismissed.has(h.id) && !this.host.accountDismissed(h.id));
  }
}
