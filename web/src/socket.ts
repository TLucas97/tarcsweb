import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type SttMessage } from '../../server/protocol.ts';
import { markStale } from './Stale.tsx';
import { applyMessage, cachedSeq, selectSession, setConnected, useStore } from './store.ts';
import { answerUiPrompt } from './PluginBand.tsx';
import { applySetup, fitDefaults, resetLogin, type SetupMessage } from './setup.ts';
import { applyUpdate } from './releases.ts';
import { stamp } from './watch/open.ts';
import { bindSender, connectionLost, echoed, failSend, flush, isTracking } from './outbox.ts';
import { getPref } from './prefs.ts';
import { pref } from './bits.tsx';
import { setPerf } from './perf.ts';
import { setMachine } from './machine.ts';
import { setBrowserKey } from './browser/key.ts';
import { applyToolOutput } from './toolOutput.ts';
import { historyClosed } from './convWindow.ts';

let ws: WebSocket | null = null;
let retry = 0;
let retryTimer = 0;
// The socket whose hello reply already flushed the outbox.
let flushedOn: WebSocket | null = null;
const SETUP = new Set<ServerMessage['type']>(['connect-status', 'settings', 'login', 'codex-status', 'codex-login', 'codex-models'] satisfies SetupMessage['type'][]);

// Voice input registers here, so this module never imports dictation.ts (no cycle). null means the socket closed.
let sttHandler: ((m: SttMessage | null) => void) | null = null;
export const onStt = (fn: (m: SttMessage | null) => void) => void (sttHandler = fn);
// The sound engine registers when its lazy chunk starts; null when it stops.
type VoiceLine = Extract<ServerMessage, { type: 'voice-line' }>;
let voiceLineHandler: ((m: VoiceLine) => void) | null = null;
export const onVoiceLine = (fn: ((m: VoiceLine) => void) | null) => void (voiceLineHandler = fn);
// The skills library registers when its lazy chunk loads; nothing asks for these before that.
const SKILLS = new Set<ServerMessage['type']>(['skills', 'skills-suggested', 'skills-organize-progress', 'skills-organized']);
type SkillsMessage = Extract<ServerMessage, { type: 'skills' | 'skills-suggested' | 'skills-organize-progress' | 'skills-organized' }>;
// The library and the slash menu's skill paths both read the catalog.
const skillsHandlers = new Set<(m: SkillsMessage) => void>();
export const onSkills = (fn: (m: SkillsMessage) => void) => void skillsHandlers.add(fn);
// The @ menu and the file picker register through mention/ask.ts, which matches answers by req.
type MentionsMessage = Extract<ServerMessage, { type: 'mentions' }>;
let mentionHandler: ((m: MentionsMessage) => void) | null = null;
export const onMentions = (fn: (m: MentionsMessage) => void) => void (mentionHandler = fn);
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

// A tab coming back or the network returning skips the rest of the backoff, or checks that the open socket still works.
function reconnectNow() {
  if (ws) return probe(ws);
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  connect();
}

// Heartbeat: a ping every PING_MS; with nothing back in PONG_MS the link is dead even if the browser has not noticed.
const PING_MS = 15_000;
const PONG_MS = 10_000;
let pingTimer = 0;
let pongTimer = 0;
let drop: (() => void) | null = null;

function probe(sock: WebSocket) {
  if (sock !== ws || sock.readyState !== WebSocket.OPEN || pongTimer) return;
  sock.send('{"type":"ping"}');
  pongTimer = window.setTimeout(() => {
    pongTimer = 0;
    if (sock === ws) drop?.();
  }, PONG_MS);
}

function stopBeat() {
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
  pingTimer = pongTimer = 0;
}
let watching = false;

// The session on screen survives a reload; the first hello drops it if the server no longer has it. Each embed keeps its own.
const VIEW_KEY = `view:${new URLSearchParams(location.search).get('embed') ?? 'app'}`;
function keepView() {
  const id = pref.get<string | null>(VIEW_KEY, null);
  if (id && !useStore.getState().current) selectSession(id);
  useStore.subscribe((s, prev) => s.current !== prev.current && pref.set(VIEW_KEY, s.current));
}

export function connect() {
  if (!watching) {
    watching = true;
    keepView();
    addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', () => !document.hidden && reconnectNow());
  }
  retryTimer = 0;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const sock = new WebSocket(url);
  ws = sock;

  sock.onopen = () => {
    retry = 0;
    stopBeat();
    pingTimer = window.setInterval(() => probe(sock), PING_MS);
    hello();
    send({ type: 'list-past' });
  };

  sock.onmessage = (ev) => {
    // Any message proves the link is alive, so a pong stuck behind a big backlog does not count as lost.
    clearTimeout(pongTimer);
    pongTimer = 0;
    const msg = JSON.parse(ev.data) as ServerMessage;
    if (msg.type === 'pong') return;
    // The server had no session for this send; its row fails instead of a notice.
    if (msg.type === 'notice' && msg.unsent && failSend(msg.unsent, 'closed')) return;
    // Chrome lets a page close its own window when it has no history, as the --app window does.
    if (msg.type === 'bye') return window.close();
    if (msg.type === 'ui-prompt') {
      const answer = answerUiPrompt(msg);
      if (answer) send(answer);
      return;
    }
    if (SETUP.has(msg.type)) return applySetup(msg as SetupMessage);
    if (msg.type === 'update') return applyUpdate(msg);
    if (msg.type === 'perf') return setPerf(msg.perf, msg.chosen);
    if (msg.type === 'machine') return setMachine(msg.facts);
    if (msg.type === 'tool-output') return applyToolOutput(msg);
    if (msg.type === 'stt') return sttHandler?.(msg);
    if (msg.type === 'voice-line') return voiceLineHandler?.(msg);
    if (SKILLS.has(msg.type)) return skillsHandlers.forEach((fn) => fn(msg as SkillsMessage));
    if (msg.type === 'mentions') return mentionHandler?.(msg);
    if (msg.type === 'peek-events') {
      // A widget's own sends echo here.
      if (isTracking()) for (const e of msg.events) if (e.type === 'user') echoed(e.id);
      return peekHandler?.(msg);
    }
    if (msg.type === 'opened' && msg.widget) {
      useStore.setState({ palette: null, notice: null });
      return widgetOpened?.(msg.sessionId);
    }
    if ('seq' in msg) stamp(msg.seq, msg.at);
    landOpening(msg);
    const opened = applyMessage(msg);
    // hello carries the server's defaults, which may predate its Codex status.
    if (msg.type === 'hello') {
      fitDefaults();
      setBrowserKey(msg.browserKey);
      // A server from another build would be misread; a reload fetches the client it serves.
      if (msg.protocol !== undefined && msg.protocol !== PROTOCOL_VERSION) markStale();
    }
    if (isTracking()) {
      if (msg.type === 'user') echoed(msg.id);
      else if (msg.type === 'events') for (const e of msg.events) if (e.type === 'user') echoed(e.id);
    }
    if (msg.type === 'hello' && flushedOn !== sock) {
      flushedOn = sock;
      flush(msg.serverId);
    }
    if (opened) openSession(opened);
  };

  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    drop = null;
    stopBeat();
    connectionLost();
    setConnected(false);
    historyClosed();
    sttHandler?.(null);
    resetLogin();
    retryTimer = window.setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
  };
  // A dead link's close handshake can hang, so the socket is treated as closed right away.
  drop = () => {
    const onclose = sock.onclose;
    sock.onmessage = sock.onclose = null;
    sock.close();
    onclose?.call(sock, new CloseEvent('close'));
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
bindSender(send);

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
