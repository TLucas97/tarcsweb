// Slash names to SKILL.md paths, from the skills catalog, so a skill picked in the "/" menu becomes a chip.
import { onSkills, send } from '../socket.ts';
import type { SkillRef } from './ref.tsx';

const WAIT_MS = 3000;
let byCmd = new Map<string, SkillRef>();
let waiters: (() => void)[] = [];

onSkills((m) => {
  if (m.type !== 'skills') return;
  byCmd = new Map(m.catalog.skills.flatMap((s) => (s.cmd ? [[s.cmd, { name: s.name, path: s.path }] as const] : [])));
  const ws = waiters;
  waiters = [];
  ws.forEach((fn) => fn());
});

// Asked when the menu opens, so a pick usually finds the path already here; at most once per FRESH_MS per session.
const FRESH_MS = 30_000;
let asked = { id: '', at: 0 };
export function loadSkillPaths(sessionId: string | null, force = false) {
  const id = sessionId ?? '';
  if (!force && asked.id === id && Date.now() - asked.at < FRESH_MS) return;
  if (send({ type: 'skills-load', ...(sessionId ? { sessionId } : {}) })) asked = { id, at: Date.now() };
}

// The chip for a slash name, waiting for the catalog when it has not come yet; null when no SKILL.md is known.
export async function skillRef(cmd: string, sessionId: string | null): Promise<SkillRef | null> {
  const hit = byCmd.get(cmd);
  if (hit) return hit;
  await new Promise<void>((ok) => {
    const t = setTimeout(ok, WAIT_MS);
    waiters.push(() => (clearTimeout(t), ok()));
    loadSkillPaths(sessionId, true);
  });
  return byCmd.get(cmd) ?? null;
}
