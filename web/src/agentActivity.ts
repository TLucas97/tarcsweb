import { create } from 'zustand';
import type { AgentActivityMessage, ClientMessage, WatchEntry } from '../../server/protocol.ts';

// The open agent detail's Activity, merged from agent-activity replies; capped in entries per agent and agents kept.
const KEEP = 200;
const AGENTS_MAX = 6;
export type Activity = { rev: number; more: number; entries: WatchEntry[]; loaded: boolean };

const key = (sessionId: string, id: string) => `${sessionId}|${id}`;
export const useActivity = create<{ byKey: Record<string, Activity> }>(() => ({ byKey: {} }));
export const activityOf = (s: { byKey: Record<string, Activity> }, sessionId: string, id: string) => s.byKey[key(sessionId, id)];

// Replies carry only agents with news, so every asked agent counts as loaded once its session answers.
const asked = new Map<string, Set<string>>();

// send is passed in so store.ts can import this module without pulling in the socket (no cycle).
export function askActivity(send: (m: ClientMessage) => boolean, sessionId: string, id: string) {
  const rev = useActivity.getState().byKey[key(sessionId, id)]?.rev ?? 0;
  if (!send({ type: 'agent-activity', sessionId, since: [[id, rev]] })) return;
  const set = asked.get(sessionId) ?? new Set();
  set.add(id);
  asked.set(sessionId, set);
}

export function putAgentActivity(m: AgentActivityMessage) {
  const ids = asked.get(m.sessionId);
  asked.delete(m.sessionId);
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
