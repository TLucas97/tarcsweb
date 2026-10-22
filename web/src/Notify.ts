import { useEffect } from 'react';
import type { AgentRow, AgentState, SessionSummary } from '../../server/protocol.ts';
import { openSession } from './socket.ts';
import { getPref } from './prefs.ts';
import { useStore } from './store.ts';

const open = new Map<string, Notification>();

// tag: one notice per tag, a newer one replaces it; turn notices use the session id.
function notify(r: SessionSummary, body: string, tag = r.id) {
  open.get(tag)?.close();
  const icon = document.querySelector<HTMLLinkElement>('link[rel=icon]')?.href;
  const n = new Notification(r.name, { body, tag, ...(icon ? { icon } : {}) });
  n.onclick = () => {
    window.focus();
    openSession(r.id);
    n.close();
  };
  n.onclose = () => open.get(tag) === n && open.delete(tag);
  open.set(tag, n);
}

// Asked from the switch in Settings › Notifications, never on page load.
export const desktopOn = () => typeof Notification !== 'undefined' && Notification.permission === 'granted' && getPref('desktopNotify');

const active = (st: AgentState) => st === 'running' || st === 'waiting';
// Per session: the last state of each non-main agent, and the ones that ran in the current spell.
type Watch = { states: Map<string, AgentState>; spell: Set<string> };
const watch = new Map<string, Watch>();

// A session's agent rows changed: a notice per failure, and one summary once none is left running.
function agentsChanged(r: SessionSummary | undefined, rows: AgentRow[], show: boolean) {
  const sid = r?.id;
  if (!sid) return;
  const w = watch.get(sid);
  const states = new Map<string, AgentState>();
  for (const a of rows) if (!a.main) states.set(a.id, a.state);
  // The first look only records; rows that ended before it are old news.
  if (!w) return void watch.set(sid, { states, spell: new Set([...states].filter(([, st]) => active(st)).map(([id]) => id)) });
  for (const a of rows) {
    if (a.main) continue;
    const was = w.states.get(a.id);
    if (active(a.state) || was === undefined) w.spell.add(a.id);
    if (show && a.state === 'failed' && was !== 'failed') notify(r, `Agent failed: ${a.name}`, `${sid}:agent:${a.id}`);
  }
  w.states = states;
  if (!w.spell.size || [...states.values()].some(active)) return;
  const ended = rows.filter((a) => !a.main && w.spell.has(a.id));
  w.spell.clear();
  if (!show || !ended.length) return;
  const failed = ended.filter((a) => a.state === 'failed').length;
  const done = `${ended.length} ${ended.length === 1 ? 'agent' : 'agents'} finished`;
  notify(r, failed ? `${done} · ${failed} failed` : done, `${sid}:agents`);
}

// Desktop notifications when a session finishes, needs you, or its agents end while the window is in the background.
export function useDesktopNotices() {
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    const clear = () => {
      for (const n of open.values()) n.close();
      open.clear();
    };
    addEventListener('focus', clear);

    let prev = new Map(useStore.getState().roster.map((r) => [r.id, r]));
    const unsub = useStore.subscribe((s, old) => {
      // Most store updates are conversation events; only roster and agent panel changes matter here.
      if (s.roster === old.roster && s.panels === old.panels) return;
      const show = desktopOn() && !document.hasFocus();
      if (s.roster !== old.roster) {
        const now = new Map(s.roster.map((r) => [r.id, r]));
        if (show) {
          for (const r of s.roster) {
            const was = prev.get(r.id);
            if (!was) continue;
            if (r.needsYou && !was.needsYou) notify(r, 'Waiting for your answer');
            // The session on screen ends as idle, the others as done.
            else if (was.state === 'working' && (r.state === 'done' || r.state === 'idle')) notify(r, 'Finished');
          }
        }
        prev = now;
      }
      if (s.panels === old.panels) return;
      for (const sid in s.panels) if (s.panels[sid] !== old.panels[sid]) agentsChanged(prev.get(sid), s.panels[sid].agents, show);
      for (const sid of watch.keys()) if (!s.panels[sid]) watch.delete(sid);
    });
    return () => {
      unsub();
      removeEventListener('focus', clear);
    };
  }, []);
}
