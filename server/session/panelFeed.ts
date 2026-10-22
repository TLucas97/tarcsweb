import type { Panel } from '../protocol.ts';
import type { AgentTracker } from '../agents.ts';
import { tuning } from '../profile.ts';
import { guard } from './util.ts';

const FAILED_MAX = 10;

// Rows whose JSON changed since the last send, and the id list when it changed; sent is rebuilt in the current order.
export function diffRows(rows: { id: string }[], sent: Map<string, string>) {
  const prev = new Map(sent);
  const before = [...prev.keys()];
  const changed: string[] = [];
  let moved = rows.length !== before.length;
  sent.clear();
  for (const [i, r] of rows.entries()) {
    const j = JSON.stringify(r);
    if (prev.get(r.id) !== j) changed.push(j);
    if (before[i] !== r.id) moved = true;
    sent.set(r.id, j);
  }
  return { changed, order: moved ? JSON.stringify(rows.map((r) => r.id)) : null };
}

export type PanelHost = {
  id: string;
  tracker: () => AgentTracker;
  mapListening: () => boolean;
  mapChanged: () => void;
  onChange: () => void;
};

// The agents panel's live feed: coalesced row patches, plus the failed-agent list the heads-ups read.
export class PanelFeed {
  private host: PanelHost;
  private listeners = new Set<(json: string) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  // What the panel's clients hold, as row JSON by id in order, so a tick sends only what changed.
  private sentAgents = new Map<string, string>();
  private sentProcs = new Map<string, string>();
  private sentActive = false;
  // Failed subagent rows for the heads-up list, refreshed with the panel; newest first, capped at FAILED_MAX.
  failedAgents: { id: string; name: string; error: string; endedAt: number }[] = [];
  private failedKey = '';
  private background = false;
  // The tracker's process key the map was last asked to rebuild for.
  private mapProcs = '';

  constructor(host: PanelHost) {
    this.host = host;
  }

  // The new client gets the whole panel; everyone gets the same serialized patches after that.
  subscribe(fn: (json: string) => void) {
    const full = this.flush();
    this.listeners.add(fn);
    fn(full);
    return () => this.listeners.delete(fn);
  }

  // Sends listeners the rows that changed since the last send and returns the whole panel as a message.
  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.host.tracker().snapshot();
    this.noteFailed(p);
    const agents = diffRows(p.agents, this.sentAgents);
    const procs = diffRows(p.procs, this.sentProcs);
    const head = `{"type":"panel","sessionId":${JSON.stringify(this.host.id)},"active":${p.active}`;
    const any = agents.changed.length || procs.changed.length || agents.order || procs.order || p.active !== this.sentActive;
    this.sentActive = p.active;
    if (any && this.listeners.size) {
      const order = `${agents.order ? `,"agentOrder":${agents.order}` : ''}${procs.order ? `,"procOrder":${procs.order}` : ''}`;
      const patch = `${head},"full":false,"agents":[${agents.changed.join(',')}],"procs":[${procs.changed.join(',')}]${order}}`;
      for (const fn of this.listeners) fn(patch);
    }
    return `${head},"full":true,"agents":[${[...this.sentAgents.values()].join(',')}],"procs":[${[...this.sentProcs.values()].join(',')}]}`;
  }

  // Coalesced: a burst of stream events becomes one patch.
  changed() {
    const tracker = this.host.tracker();
    // The map reads only process counts from the tracker; subagent text deltas leave it as it was.
    const procs = tracker.procState().key;
    // The dock shows background work, so the roster hears when it starts or stops.
    const bg = tracker.agentsRunning();
    if (procs !== this.mapProcs || bg !== this.background) {
      this.mapProcs = procs;
      this.host.mapChanged();
    }
    if (bg !== this.background) {
      this.background = bg;
      this.host.onChange();
    }
    this.timer ??= setTimeout(() => guard('panel flush', () => {
      this.timer = null;
      // With nobody listening the sent rows go stale; the next subscribe reconciles them.
      if (this.listeners.size) this.flush();
      else if (this.host.mapListening()) this.noteFailed(this.host.tracker().snapshot());
    }), tuning().panelMs);
  }

  private noteFailed(p: Panel) {
    const rows = p.agents.filter((a) => !a.main && a.state === 'failed' && a.kind !== 'workflow');
    rows.sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0));
    const top = rows.slice(0, FAILED_MAX);
    const key = top.map((a) => `${a.id}:${a.endedAt}`).join('|');
    if (key === this.failedKey) return;
    this.failedKey = key;
    this.failedAgents = top.map((a) => ({ id: a.id, name: a.name, error: a.summary || a.now || a.said || 'See the agent for details', endedAt: a.endedAt ?? 0 }));
    this.host.mapChanged();
  }
}
