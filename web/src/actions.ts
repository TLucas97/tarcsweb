import { hello, send } from './socket.ts';
import { dropOpen, patchPast, removePast, renameLocal, useStore } from './store.ts';
import { fillComposer } from './PluginBand.tsx';

const isOpen = (id: string) => useStore.getState().roster.some((r) => r.id === id);

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
  removePast(id);
  if (isOpen(id) && dropOpen(id)) hello();
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
