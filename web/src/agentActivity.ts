import { create } from 'zustand';
import type { AgentActivityMessage, ClientMessage, WatchEntry } from '../../server/protocol.ts';

// The open agent detail's Activity, merged from agent-activity replies; capped in entries per agent and agents kept.
const KEEP = 200;
const AGENTS_MAX = 6;
export type Activity = { rev: number; more: number; entries: WatchEntry[]; loaded: boolean };

const key = (sessionId: string, id: string) => `${sessionId}|${id}`;
export const useActivity = create<{ byKey: Record<string, Activity> }>(() => ({ byKey: {} }));
export const activityOf = (s: { byKey: Record<string, Activity> }, sessionId: string, id: string) => s.byKey[key(sessionId, id)];

// Asks per session in send order. Replies carry only agents with news and come back in order,
// so an empty reply settles the oldest ask, never every agent asked in that session.
const asked = new Map<string, string[]>();
const ASKED_MAX = 16;

// send is passed in so store.ts can import this module without pulling in the socket (no cycle).
export function askActivity(send: (m: ClientMessage) => boolean, sessionId: string, id: string) {
  const rev = useActivity.getState().byKey[key(sessionId, id)]?.rev ?? 0;
  if (!send({ type: 'agent-activity', sessionId, since: [[id, rev]] })) return;
  asked.set(sessionId, [...(asked.get(sessionId) ?? []), id].slice(-ASKED_MAX));
}

// Takes this reply's ask off the queue and returns the agent it settles.
function settle(m: AgentActivityMessage) {
  const queue = asked.get(m.sessionId) ?? [];
  const hit = queue.findIndex((id) => m.subs.some((s) => s.aid === id));
  const [id] = queue.splice(hit < 0 ? 0 : hit, 1);
  if (queue.length) asked.set(m.sessionId, queue);
  else asked.delete(m.sessionId);
  return id;
}

export function putAgentActivity(m: AgentActivityMessage) {
  const done = settle(m);
  const ids = done ? [done] : [];
  useActivity.setState((s) => {
    const byKey = { ...s.byKey };
    for (const sub of m.subs) {
      const k = key(m.sessionId, sub.aid);
      const prev = byKey[k];
      let entries = sub.entries;
      // A delta settles entries already shown and appends new ones; a lower rev means the server started over.
      const delta = !!prev && sub.rev >= prev.rev;
      if (delta) {
        const at = new Map(prev.entries.map((e, i) => [e.id, i]));
        entries = prev.entries.slice();
        for (const e of sub.entries) {
          const i = at.get(e.id);
          if (i === undefined) entries.push(e);
          else entries[i] = e;
        }
      }
      const cut = Math.max(0, entries.length - KEEP);
      delete byKey[k];
      // more: what the server had dropped at the first load, plus what was cut here since.
      byKey[k] = { rev: sub.rev, more: (delta && prev ? prev.more : sub.more) + cut, entries: cut ? entries.slice(cut) : entries, loaded: true };
    }
    for (const id of ids ?? []) {
      const k = key(m.sessionId, id);
      if (!byKey[k]) byKey[k] = { rev: 0, more: 0, entries: [], loaded: true };
    }
    const keys = Object.keys(byKey);
    for (const k of keys.slice(0, Math.max(0, keys.length - AGENTS_MAX))) delete byKey[k];
    return { byKey };
  });
}
