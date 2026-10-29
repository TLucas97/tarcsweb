import { create } from 'zustand';
import type { FolderMenuView, ServerMessage } from '../../server/protocol.ts';
import { onFolder, send } from './socket.ts';
import { useStore } from './store.ts';
import { openNew, resumeSession } from './actions.ts';

// The file manager's right-click items: the Settings switch that installs them, and the opens they send here.
export const useFolderMenu = create<{ menu: FolderMenuView | null }>(() => ({ menu: null }));

type FolderMessage = Extract<ServerMessage, { type: 'folder-menu' | 'open-folder' }>;
const waiting = new Map<string, (error: string | null) => void>();
// Time for the opened session's backlog to land and the title effect to run.
const RAISE_AFTER_MS = 800;
let seq = 0;

const raise = () => send({ type: 'raise', title: document.title });

function open(cwd: string | null, resume: string | null) {
  if (resume) resumeSession(resume);
  else if (cwd) openNew(cwd);
}

// A live window has its title right now, so the server can find it before the session switch renames it.
const openHere = (cwd: string, resume: string | null) => {
  raise();
  open(cwd, resume);
};

onFolder((msg: FolderMessage) => {
  if (msg.type === 'open-folder') return openHere(msg.cwd, msg.resume);
  useFolderMenu.setState({ menu: msg.menu });
  if (msg.reply) {
    waiting.get(msg.reply.req)?.(msg.reply.error);
    waiting.delete(msg.reply.req);
  }
});

// The window used last gets the next right-click open.
addEventListener('focus', () => send({ type: 'seen' }));

// A window the server opened for a right-click carries ?open=<folder> or ?resume=<id>; handled once, after the first hello.
const params = new URLSearchParams(location.search);
const boot = { cwd: params.get('open'), resume: params.get('resume') };
if (boot.cwd || boot.resume) {
  params.delete('open');
  params.delete('resume');
  const q = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
  const stop = useStore.subscribe((s) => {
    if (!s.serverId) return;
    stop();
    // After the hello's own handlers (defaults are fitted right after the store update).
    setTimeout(() => {
      open(boot.cwd, boot.resume);
      // A new window's first title is generic, so it asks for the raise once the session is on screen.
      const off = useStore.subscribe((x) => {
        if (x.pendingOpen) return;
        off();
        setTimeout(raise, RAISE_AFTER_MS);
      });
    }, 0);
  });
}

export const loadFolderMenu = () => send({ type: 'folder-menu-load' });

// Resolves with the server's error, null once done.
export function setFolderMenu(on: boolean): Promise<string | null> {
  const req = `f${++seq}`;
  if (!send({ type: 'folder-menu-set', on, req })) return Promise.resolve('Not connected to the server');
  return new Promise((done) => {
    const timer = setTimeout(() => {
      waiting.delete(req);
      done('The server did not answer');
    }, 15_000);
    waiting.set(req, (error) => {
      clearTimeout(timer);
      done(error);
    });
  });
}
