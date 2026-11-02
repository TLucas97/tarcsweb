import { create } from 'zustand';
import type { RunClientMessage, RunCommand, RunFolder, RunState } from '../../../server/runbar/types.ts';
import { onRun, send } from '../socket.ts';
import { currentSummary, useStore } from '../store.ts';

// The run bar of the folder on screen; log is the one inline log this window streams.
export const useRun = create<{ folder: RunFolder | null; log: { id: string; text: string } | null }>(() => ({ folder: null, log: null }));

let watched: string | null = null;
let fullLog: { id: string; done: (text: string) => void } | null = null;

onRun((m) => {
  if (m.type === 'run-folder') {
    if (m.folder.folder === watched) useRun.setState({ folder: m.folder });
    return;
  }
  const f = useRun.getState().folder;
  if (!f || m.folder !== f.folder) return;
  if (m.type === 'run-stats') {
    const runs = f.runs.map((r) => {
      const st = m.stats.find((x) => x.id === r.id);
      return st ? { ...r, ports: st.ports, mb: st.mb } : r;
    });
    useRun.setState({ folder: { ...f, runs } });
  } else if (m.type === 'run-log') {
    if (useRun.getState().log?.id === m.id) useRun.setState({ log: { id: m.id, text: m.text } });
  } else if (fullLog?.id === m.id) {
    fullLog.done(m.text);
    fullLog = null;
  }
});

// Follows the session on screen: a new folder or a reconnect asks for its snapshot again.
function watch() {
  const s = useStore.getState();
  const cwd = s.connected ? currentSummary(s)?.cwd ?? null : null;
  if (cwd === watched) return;
  watched = cwd;
  useRun.setState((r) => (r.folder?.folder === cwd ? r : { folder: null, log: null }));
  if (cwd || s.connected) send({ type: 'run-watch', folder: cwd });
}
useStore.subscribe((s, prev) => {
  if (s.connected !== prev.connected) watched = null;
  if (s.connected !== prev.connected || s.current !== prev.current || s.roster !== prev.roster) watch();
  // The new socket streams the open log again.
  const log = useRun.getState().log;
  if (s.connected && !prev.connected && log) runSend({ type: 'run-log', id: log.id });
});
watch();

type FolderMsg = Extract<RunClientMessage, { folder: string }>;
type Omitted<T> = T extends unknown ? Omit<T, 'folder'> : never;
export function runSend(msg: Omitted<FolderMsg>) {
  if (!watched || !send({ ...msg, folder: watched } as FolderMsg)) useStore.setState({ notice: 'Not connected', noticeInfo: false });
}

export function toggleLog(id: string) {
  const open = useRun.getState().log?.id === id;
  useRun.setState({ log: open ? null : { id, text: '' } });
  runSend({ type: 'run-log', id: open ? null : id });
}

export const loadFullLog = (id: string) =>
  new Promise<string>((done) => {
    fullLog = { id, done };
    runSend({ type: 'run-full-log', id });
  });

export const isAlive = (r: RunState | undefined) => r?.phase === 'starting' || r?.phase === 'running';

// What the pill says: its tone and one short line.
export function summarize(f: RunFolder | null): { tone: 'idle' | 'on' | 'busy' | 'bad'; text: string } {
  if (!f) return { tone: 'idle', text: '' };
  const cmd = new Map<string, RunCommand>(f.commands.map((c) => [c.id, c]));
  const runs = f.runs.filter((r) => cmd.has(r.id));
  const failed = runs.find((r) => r.phase === 'failed');
  if (failed) {
    const c = cmd.get(failed.id)!;
    return { tone: 'bad', text: c.kind === 'prod' ? (failed.step?.[0] === 2 ? 'Start failed' : 'Build failed') : `${c.label} failed` };
  }
  const blocked = runs.find((r) => r.phase === 'blocked');
  if (blocked?.holder) return { tone: 'bad', text: `Port :${blocked.holder.port} is busy` };
  const starting = runs.find((r) => r.phase === 'starting');
  if (starting) {
    const c = cmd.get(starting.id)!;
    return { tone: 'busy', text: c.kind === 'prod' ? (starting.step && starting.step[0] < starting.step[1] ? 'Building…' : 'Starting production…') : c.kind === 'action' ? `Running ${c.label}…` : `Starting ${c.label}…` };
  }
  const up = runs.filter((r) => r.phase === 'running' && cmd.get(r.id)!.kind !== 'action');
  if (up.length) {
    const web = up.find((r) => cmd.get(r.id)!.web && r.ports.length);
    return { tone: 'on', text: web ? `${cmd.get(web.id)!.label} :${web.ports[0]} · ${up.length} running` : `${up.length} running` };
  }
  return { tone: 'idle', text: f.commands.some((c) => !c.hidden) ? 'Nothing running' : 'No commands found' };
}
