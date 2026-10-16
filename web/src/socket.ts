import type { ClientMessage, ServerMessage, SttMessage } from '../../server/protocol.ts';
import { applyMessage, selectSession, setConnected, useStore } from './store.ts';
import { answerUiPrompt } from './PluginBand.tsx';
import { applySetup, resetLogin, type SetupMessage } from './setup.ts';
import { applyUpdate } from './releases.ts';
import { stamp } from './watch/open.ts';
import { echoed, failSending, useOutbox } from './outbox.ts';
import { getPref } from './prefs.ts';

let ws: WebSocket | null = null;
let retry = 0;
const SETUP = new Set<ServerMessage['type']>(['connect-status', 'settings', 'login', 'codex-status', 'codex-login', 'codex-models'] satisfies SetupMessage['type'][]);

// Voice input registers here, so this module never imports dictation.ts (no cycle). null means the socket closed.
let sttHandler: ((m: SttMessage | null) => void) | null = null;
export const onStt = (fn: (m: SttMessage | null) => void) => void (sttHandler = fn);

// Subscribes to whatever session is on screen now.
export function hello() {
  const { current, lastSeq, serverId } = useStore.getState();
  send({ type: 'hello', sessionId: current, afterSeq: current ? lastSeq : 0, ...(serverId ? { serverId } : {}) });
}

export function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const sock = new WebSocket(url);
  ws = sock;

  sock.onopen = () => {
    retry = 0;
    hello();
    send({ type: 'list-past' });
  };

  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    // Chrome lets a page close its own window when it has no history, as the --app window does.
    if (msg.type === 'bye') return window.close();
    if (msg.type === 'ui-prompt') {
      const answer = answerUiPrompt(msg);
      if (answer) send(answer);
      return;
    }
    if (SETUP.has(msg.type)) return applySetup(msg as SetupMessage);
    if (msg.type === 'update') return applyUpdate(msg);
    if (msg.type === 'stt') return sttHandler?.(msg);
    if ('seq' in msg) stamp(msg.seq, msg.at);
    const opened = applyMessage(msg);
    if (useOutbox.getState().list.length) {
      if (msg.type === 'user') echoed(msg.id);
      else if (msg.type === 'events') for (const e of msg.events) if (e.type === 'user') echoed(e.id);
    }
    if (opened) openSession(opened);
  };

  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    failSending();
    setConnected(false);
    sttHandler?.(null);
    resetLogin();
    setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
  };
}

export function send(msg: ClientMessage) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  // Whatever may start a CLI says which reply style this browser wants.
  const out = msg.type === 'send' || msg.type === 'warm' || msg.type === 'reload' ? { ...msg, style: getPref('replyStyle') } : msg;
  ws.send(JSON.stringify(out));
  if (msg.type === 'interrupt') useStore.setState((s) => ({ stops: s.stops + 1 }));
  return true;
}

// Shows a session and subscribes to its events from where this client left off.
export function openSession(id: string) {
  if (useStore.getState().current === id) return;
  selectSession(id);
  hello();
}

// Back to the Start screen. The session keeps running; this window only stops watching it.
export function showStart() {
  if (!useStore.getState().current) return;
  selectSession(null);
  hello();
}
