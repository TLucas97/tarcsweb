import { create } from 'zustand';
import { pref } from './bits.tsx';

export type SideTab = 'tasks' | 'agents' | 'files';

// Kept separate so the card and its panels share counts without an import cycle.
type Side = {
  sessionId: string | null; tab: SideTab; min: boolean; full: boolean; work: string; tasksDone: boolean;
  agents: number; agentState: 'idle' | 'running' | 'waiting' | 'failed' | 'done'; files: number;
};

export const MIN_KEY = 'side.min.sessions';
const TAB_KEY = 'side.tab';

export const useSide = create<Side>(() => {
  const saved = pref.get<string>(TAB_KEY, 'tasks');
  return {
    sessionId: null,
    tab: saved === 'agents' || saved === 'files' ? saved : 'tasks',
    min: false,
    full: false,
    work: '',
    tasksDone: false,
    agents: 0,
    agentState: 'idle',
    files: 0,
  };
});

export function setMin(min: boolean) {
  const { sessionId } = useSide.getState();
  if (sessionId) {
    const ids = pref.get<string[]>(MIN_KEY, []).filter((id) => id !== sessionId);
    // Keep only the 200 most recently minimized sessions, including across reloads.
    pref.set(MIN_KEY, min ? [...ids, sessionId].slice(-200) : ids);
  }
  useSide.setState({ min, full: false });
}

export function pickTab(tab: SideTab) {
  useSide.setState({ tab });
  pref.set(TAB_KEY, tab);
}

// The card's box before a full-screen switch, measured here so SideCard can morph from it after the commit.
export const morph: { el: HTMLElement | null; from: DOMRect | null } = { el: null, from: null };

export function setFull(full: boolean, tab?: SideTab) {
  const s = useSide.getState();
  if (morph.el && !s.min && s.full !== full) morph.from = morph.el.getBoundingClientRect();
  if (tab && s.min) setMin(false);
  useSide.setState(tab ? { full, tab, min: false } : { full });
}
