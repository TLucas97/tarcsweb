import { MediaCall } from './media.ts';
import type { HelperClientMessage, HelperServerMessage } from '../protocol.ts';

const credentials = location.hash.slice(1).split(':');
history.replaceState(null, '', location.pathname);
const [runId, token] = credentials;
credentials.length = 0;
const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/voice-helper`);
let media: MediaCall | null = null;
let timer = 0;
let stopped = false;
let ready = false;
let intervalMs = 50;

function send(message: HelperClientMessage) {
  if (!stopped && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  timer = 0;
  media?.dispose();
  media = null;
  socket.close();
}
function failure(code: string, message: string) {
  send({ type: 'helper-error', runId, code, message: message.slice(0, 1000) });
  stop();
}
function meter(on: boolean) {
  media?.meterActive(on);
  clearInterval(timer);
  timer = 0;
  if (on && media) timer = window.setInterval(() => {
    if (socket.bufferedAmount || !media) return;
    try {
      const { mic, out } = media.levels();
      send({ type: 'helper-levels', runId, mic, out });
    } catch (e) {
      failure('meter', e instanceof Error ? e.message : String(e));
    }
  }, intervalMs);
}

socket.onopen = () => send({ type: 'helper-hello', version: 1, runId, token });
socket.onclose = stop;
socket.onerror = stop;
window.addEventListener('pagehide', stop);
socket.onmessage = (event) => {
  const m = JSON.parse(String(event.data)) as HelperServerMessage;
  if (stopped || m.runId !== runId) return;
  if (m.type === 'helper-stop') return stop();
  if (m.type === 'helper-ready') {
    if (ready) return;
    ready = true;
    intervalMs = Math.max(50, m.levelsMs);
    media = new MediaCall({
      offer(sdp, offer) { send({ type: 'helper-offer', runId, sdp, offer }); },
      state(state) { send({ type: 'helper-media', runId, ...state }); },
      pause() { send({ type: 'helper-pause', runId }); },
      rt(events) { send({ type: 'helper-rt', runId, events }); },
      error: failure,
    }, true);
    media.mute(m.muted, m.seq);
    media.held(m.held);
    meter(m.meter);
    void media.start().catch((e: unknown) => failure('media', e instanceof Error ? e.message : String(e)));
  } else if (m.type === 'helper-answer') {
    void media?.answer(m.sdp, m.offer);
  } else if (m.type === 'helper-redial') {
    void media?.redial(m.offer);
  } else if (m.type === 'helper-control') {
    if (m.muted !== undefined && m.seq !== undefined) media?.mute(m.muted, m.seq);
    if (m.meter !== undefined) meter(m.meter);
    if (m.held !== undefined) media?.held(m.held);
  }
};
