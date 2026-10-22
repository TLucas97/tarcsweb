import { hello, send } from './socket.ts';
import { dropOpen, patchPast, removePast, renameLocal, setDefaults, useStore } from './store.ts';
import { fillComposer } from './PluginBand.tsx';
import { getPins, setPins } from './prefs.ts';
import type { ClientMessage, Settings } from '../../server/protocol.ts';

// Settings › New sessions saved in another window; this one opens new sessions with them too.
addEventListener('storage', (e) => {
  if (e.key !== 'cw:newDefaults' || !e.newValue) return;
  try {
    const d = JSON.parse(e.newValue) as Settings;
    if (d && typeof d.model === 'string') setDefaults({ mode: d.mode, model: d.model, effort: d.effort });
  } catch {}
});

const isOpen = (id: string) => useStore.getState().roster.some((r) => r.id === id);

// One open or resume at a time, so a double click cannot start two sessions. "opened", an error notice or this timeout ends it.
const OPEN_GUARD_MS = 8000;
let openTimer = 0;
function guardedOpen(key: string, msg: ClientMessage) {
  if (useStore.getState().pendingOpen) return false;
  if (!send(msg)) {
    useStore.setState({ notice: 'Not connected', noticeInfo: false });
    return false;
  }
  clearTimeout(openTimer);
  useStore.setState({ pendingOpen: key });
  openTimer = window.setTimeout(() => useStore.getState().pendingOpen === key && useStore.setState({ pendingOpen: null }), OPEN_GUARD_MS);
  return true;
}
export const newKey = (cwd: string) => `new:${cwd}`;
export const resumeKey = (id: string) => `resume:${id}`;
export const openNew = (cwd: string) => guardedOpen(newKey(cwd), { type: 'open', cwd, ...useStore.getState().defaults });
export const resumeSession = (id: string) => guardedOpen(resumeKey(id), { type: 'resume', id });

// The new tab opens when the server answers; a worktree checkout can take a few seconds.
export function branchFrom(sessionId: string, item: string, worktree: boolean) {
  if (!guardedOpen(`branch:${item}`, { type: 'branch', sessionId, item, ...(worktree ? { worktree: true as const } : {}) })) return;
  useStore.setState({ notice: worktree ? 'Creating the worktree and the branch…' : 'Making the branch…', noticeInfo: true });
}

export function togglePin(id: string) {
  const pins = getPins();
  setPins(pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id]);
}
const unpin = (id: string) => getPins().includes(id) && setPins(getPins().filter((p) => p !== id));

// Closing this session would stop a running turn, a pending ask or background agents.
export function isBusy(id: string) {
  const r = useStore.getState().roster.find((x) => x.id === id);
  return !!r && (r.state === 'working' || r.state === 'waiting' || !!r.background);
}

// A busy session closes or archives only on a second press within this window.
const KEY_ARM_MS = 3000;
let keyArm: { id: string; at: number } | null = null;
export function confirmBusy(id: string, again: string) {
  if (isBusy(id) && !(keyArm?.id === id && Date.now() - keyArm.at < KEY_ARM_MS)) {
    keyArm = { id, at: Date.now() };
    useStore.setState({ notice: again, noticeInfo: true });
    return false;
  }
  keyArm = null;
  return true;
}

export function closeByKey(id: string) {
  if (confirmBusy(id, 'Press Alt+W again to stop it and close')) closeSession(id);
}

// Every action updates the screen right away; the server's next list corrects it if the call failed.
export function closeSession(id: string) {
  if (!send({ type: 'close', sessionId: id })) return;
  if (dropOpen(id)) hello();
}

export function renameSession(id: string, title: string) {
  if (send({ type: 'rename', id, title })) renameLocal(id, title);
}

export function setArchived(id: string, archived: boolean) {
  if (!send({ type: 'archive', id, archived })) return;
  patchPast(id, { archived });
  if (archived && isOpen(id) && dropOpen(id)) hello();
}

export function deleteSession(id: string) {
  if (!send({ type: 'delete', id })) return;
  unpin(id);
  removePast(id);
  if (isOpen(id) && dropOpen(id)) hello();
}

// Not optimistic: the server refuses a worktree with uncommitted changes, and then the tab stays.
const DELETE_WAIT_MS = 30_000;
export function deleteWithWorktree(id: string) {
  if (!send({ type: 'delete', id, worktree: true })) return;
  // The server answers a delete with the past list, after a "Delete failed" notice when it did not go through.
  let failed = false;
  const stop = useStore.subscribe((s, prev) => {
    if (s.notice !== prev.notice && s.notice?.startsWith('Delete failed')) failed = true;
    const gone = !s.roster.some((r) => r.id === id);
    if (s.past === prev.past || !(failed || gone)) return;
    done();
    // A failed worktree removal can still have closed the tab; the transcript stays in the list.
    if (gone && dropOpen(id)) hello();
    if (failed) return;
    unpin(id);
    removePast(id);
  });
  const t = setTimeout(stop, DELETE_WAIT_MS);
  const done = () => {
    stop();
    clearTimeout(t);
  };
}

export function listDirs(path: string) {
  send({ type: 'list-dirs', path });
}

// Takes a queued message back; edit puts its text in the composer once the server confirms it was not read yet.
export function unqueue(sessionId: string, id: string, then: 'remove' | 'now' | 'edit', text = '') {
  if (!send({ type: 'unqueue', sessionId, id, then: then === 'edit' ? 'remove' : then }) || then !== 'edit') return;
  const stop = useStore.subscribe((s) => {
    if (s.items[id]) return;
    stop();
    clearTimeout(t);
    fillComposer(text);
  });
  const t = setTimeout(stop, 10_000);
}
