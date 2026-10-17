import type { ClientMessage, ServerMessage, SttMessage } from '../../server/protocol.ts';
import { applyMessage, cachedSeq, selectSession, setConnected, useStore } from './store.ts';
import { answerUiPrompt } from './PluginBand.tsx';
import { applySetup, fitDefaults, resetLogin, type SetupMessage } from './setup.ts';
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
// The skills library registers when its lazy chunk loads; nothing asks for these before that.
const SKILLS = new Set<ServerMessage['type']>(['skills', 'skills-suggested', 'skills-organize-progress', 'skills-organized']);
type SkillsMessage = Extract<ServerMessage, { type: 'skills' | 'skills-suggested' | 'skills-organize-progress' | 'skills-organized' }>;
let skillsHandler: ((m: SkillsMessage) => void) | null = null;
export const onSkills = (fn: (m: SkillsMessage) => void) => void (skillsHandler = fn);
// Session widgets register here, so this module never imports their state (no cycle).
type PeekMessage = Extract<ServerMessage, { type: 'peek-events' }>;
let peekHandler: ((m: PeekMessage) => void) | null = null;
export const onPeek = (fn: (m: PeekMessage) => void) => void (peekHandler = fn);
// A session resumed for a widget opens beside the one on screen instead of replacing it.
let widgetOpened: ((id: string) => void) | null = null;
export const onWidgetOpened = (fn: (id: string) => void) => void (widgetOpened = fn);

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
    if (SKILLS.has(msg.type)) return skillsHandler?.(msg as SkillsMessage);
    if (msg.type === 'peek-events') return peekHandler?.(msg);
    if (msg.type === 'opened' && msg.widget) {
      useStore.setState({ palette: null, notice: null });
      return widgetOpened?.(msg.sessionId);
    }
    if ('seq' in msg) stamp(msg.seq, msg.at);
    landOpening(msg);
    const opened = applyMessage(msg);
    // hello carries the server's defaults, which may predate its Codex status.
    if (msg.type === 'hello') fitDefaults();
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

// A cached session switches in once its missed events land, so its first frame already holds them. Past this, it
// switches anyway and the events follow.
const OPEN_WAIT = 250;
let opening: { id: string; timer: number } | null = null;

function stopOpening() {
  if (opening) clearTimeout(opening.timer);
  opening = null;
}

function switchTo(id: string | null) {
  stopOpening();
  selectSession(id);
  hello();
}

// Shows a session and subscribes to its events from where this client left off.
export function openSession(id: string) {
  // Back to the session on screen before another one landed: drop that switch and watch this one again.
  if (useStore.getState().current === id) return void (opening && switchTo(id));
  if (opening?.id === id) return;
  const seq = cachedSeq(id);
  const { serverId } = useStore.getState();
  if (seq === null || !send({ type: 'hello', sessionId: id, afterSeq: seq, ...(serverId ? { serverId } : {}) })) return switchTo(id);
  stopOpening();
  opening = { id, timer: window.setTimeout(() => switchTo(id), OPEN_WAIT) };
}

// The reply to openSession's early hello: switch and apply the backlog in the same render.
function landOpening(msg: ServerMessage) {
  if (!opening || !('sessionId' in msg) || msg.sessionId !== opening.id) return;
  // A restarted server or a closed session takes the plain path, which handles both.
  if (msg.type === 'hello' && (msg.reset || !msg.found)) switchTo(opening.id);
  else if (msg.type === 'events') {
    stopOpening();
    selectSession(msg.sessionId);
  }
}

// Back to the Start screen. The session keeps running; this window only stops watching it.
export function showStart() {
  if (!useStore.getState().current && !opening) return;
  switchTo(null);
}
