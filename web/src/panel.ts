import { create } from 'zustand';
import type { AgentRow, AgentText, Panel, PanelPatch } from '../../server/protocol.ts';

// Agents panel rows arrive as patches; their long text loads on demand into a small capped store.
const TEXT_MAX = 12;
const textKey = (sessionId: string, id: string) => `${sessionId}|${id}`;

export const useAgentTexts = create<{ byKey: Record<string, AgentText> }>(() => ({ byKey: {} }));

export function putAgentText(sessionId: string, id: string, detail: AgentText | null) {
  useAgentTexts.setState((s) => {
    const key = textKey(sessionId, id);
    const rest = Object.entries(s.byKey).filter(([k]) => k !== key);
    if (!detail) return { byKey: Object.fromEntries(rest) };
    return { byKey: Object.fromEntries([...rest.slice(-(TEXT_MAX - 1)), [key, detail]]) };
  });
}

export const loadedText = (s: { byKey: Record<string, AgentText> }, sessionId: string, id: string) => s.byKey[textKey(sessionId, id)];

function mergeRows<T extends { id: string }>(prev: T[], changed: T[], order?: string[]) {
  if (!changed.length && !order) return prev;
  const byId = new Map(prev.map((r) => [r.id, r]));
  for (const r of changed) byId.set(r.id, r);
  return (order ?? prev.map((r) => r.id)).flatMap((id) => byId.get(id) ?? []);
}

// A server started before row patches existed sends whole panels with the text inline; it is kept here until that server restarts.
type LegacyRow = AgentRow & { text?: string; task?: string; result?: string | null; followUps?: { at: number; text: string }[] };
const legacy = new Map<string, AgentText>();
const LEGACY_MAX = 200;

function fromLegacy(sessionId: string, r: LegacyRow): AgentRow {
  if (r.text === undefined) return r;
  const { text, task = '', result = null, followUps = [], ...row } = r;
  const key = textKey(sessionId, r.id);
  legacy.delete(key);
  if (legacy.size >= LEGACY_MAX) legacy.delete(legacy.keys().next().value!);
  legacy.set(key, { rev: 0, task, text, result, followUps });
  const said = text.trim().split('\n').filter((l) => l.trim()).pop()?.trim() ?? '';
  return { ...row, said, rev: 0, followUpCount: followUps.length, lastFollowUp: followUps.at(-1)?.text ?? null };
}

export const legacyText = (sessionId: string, id: string) => legacy.get(textKey(sessionId, id));

export function mergePanel(sessionId: string, prev: Panel | undefined, msg: PanelPatch): Panel {
  if (msg.full === undefined) return { active: msg.active, agents: msg.agents.map((r) => fromLegacy(sessionId, r)), procs: msg.procs };
  if (msg.full || !prev) return { active: msg.active, agents: msg.agents, procs: msg.procs };
  return { active: msg.active, agents: mergeRows(prev.agents, msg.agents, msg.agentOrder), procs: mergeRows(prev.procs, msg.procs, msg.procOrder) };
}
