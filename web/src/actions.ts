import { hello, send } from './socket.ts';
import { dropOpen, patchPast, removePast, renameLocal, useStore } from './store.ts';
import { fillComposer } from './PluginBand.tsx';

const isOpen = (id: string) => useStore.getState().roster.some((r) => r.id === id);

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
