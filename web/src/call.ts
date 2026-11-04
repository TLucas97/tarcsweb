import { useSyncExternalStore } from 'react';
import type { CallActivity, CallMessage, CallReport, CallState, CallUsage } from '../../server/protocol.ts';
import { onCall, send } from './socket.ts';
import { attachDraft } from './Composer.tsx';
import { ambient } from './perf.ts';

// A voice call with Codex realtime from this window. The mic and Codex's voice go over WebRTC straight to the realtime
// service; the server starts the call, redials it and keeps the transcript.
const ACTS_SHOWN = 100;
// A link that stays disconnected this long counts as lost; shorter blips recover on their own.
const DISCONNECT_GRACE_MS = 4000;

export type CallView = {
  // Made here per call; the server tags every message with it, so a previous call's late messages are dropped.
  id: string;
  sessionId: string;
  name: string;
  state: CallState;
  // When the call first went live, for the elapsed time.
  liveAt: number | null;
  muted: boolean;
  // End was clicked and the server has not confirmed yet.
  ending: boolean;
  error: string | null;
  // The saved conversation; a report can be made only when there is one.
  file: string | null;
  report: CallReport | null;
  // Full screen, or minimized to the side card's Call tab.
  full: boolean;
  // The agent behind the voice is working on something it was asked.
  busy: boolean;
  // What that agent did, oldest first; capped at ACTS_SHOWN.
  acts: CallActivity[];
  // The latest running totals; null until the server measures any.
  usage: CallUsage | null;
};

let view: CallView | null = null;
const subs = new Set<() => void>();
const set = (v: CallView | null) => {
  view = v;
  for (const fn of subs) fn();
};
const patch = (p: Partial<CallView>) => view && set({ ...view, ...p });
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
export const callActive = (v: CallView | null) => !!v && (v.state === 'connecting' || v.state === 'live' || v.state === 'reconnecting');
export const useCall = () => useSyncExternalStore(subscribe, () => view);
// Booleans, so the header button and the mount re-render only when they flip.
export const useCallActive = () => useSyncExternalStore(subscribe, () => callActive(view));
export const useCallOpen = () => useSyncExternalStore(subscribe, () => view !== null);

// One word for the side card's Call tab, so the card re-renders only when it changes; null without a call.
export type CallMark = 'connecting' | 'live' | 'working' | 'ended' | 'error';
const markOf = (v: CallView | null): CallMark | null => {
  if (!v) return null;
  if (v.state === 'ended' || v.state === 'error') return v.state;
  if (v.ending || v.state !== 'live') return 'connecting';
  return v.busy ? 'working' : 'live';
};
export const useCallMark = () => useSyncExternalStore(subscribe, () => markOf(view));

// The running call's media; all null between calls.
let mic: MediaStream | null = null;
let pc: RTCPeerConnection | null = null;
let audio: HTMLAudioElement | null = null;
// Numbers this call's offers; each link takes its number before it negotiates, so a late answer never lands on a newer link.
let offerNo = 0;
// The server has heard of this call, so ending it has to go through the server.
let known = false;
// Offers are made one at a time, so a new one never closes a link that is still negotiating.
let offering: Promise<void> = Promise.resolve();
let graceTimer = 0;
// Mic and Codex levels for the orb. Only a call that shows the animated orb opens one, so Lite never starts an AudioContext.
type Meter = {
  ctx: AudioContext; mic: AnalyserNode; out: AnalyserNode;
  micSrc: MediaStreamAudioSourceNode | null; outSrc: MediaStreamAudioSourceNode | null; buf: Float32Array<ArrayBuffer>;
};
let meter: Meter | null = null;
const METER_SAMPLES = 1024;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isCurrent = (id: string) => view?.id === id;

// Opened in the call button's click where it can: an AudioContext made outside a user gesture may start suspended.
function openMeter(): Meter {
  if (meter) return meter;
  const ctx = new AudioContext();
  void ctx.resume().catch(() => {});
  const analyser = () => Object.assign(ctx.createAnalyser(), { fftSize: METER_SAMPLES, smoothingTimeConstant: 0 });
  meter = { ctx, mic: analyser(), out: analyser(), micSrc: null, outSrc: null, buf: new Float32Array(METER_SAMPLES) };
  meterIn();
  meterOut();
  return meter;
}

// The mic arrives after the click, once its prompt is answered.
function meterIn() {
  if (!meter || meter.micSrc || !mic) return;
  meter.micSrc = meter.ctx.createMediaStreamSource(mic);
  meter.micSrc.connect(meter.mic);
}

// Each redial brings a new remote stream; the output meter follows it.
function meterOut() {
  if (!meter) return;
  meter.outSrc?.disconnect();
  const s = audio?.srcObject;
  meter.outSrc = s instanceof MediaStream && s.getAudioTracks().length ? meter.ctx.createMediaStreamSource(s) : null;
  meter.outSrc?.connect(meter.out);
}

function level(a: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  const rms = Math.sqrt(sum / buf.length);
  // A gate for line noise, then a curve that lifts quiet speech.
  return rms < 0.004 ? 0 : Math.min(1, Math.sqrt(rms) * 1.8);
}

// The orb says when it animates; between, the AudioContext sleeps. Ending the call still closes it.
export function meterActive(on: boolean) {
  if (meter) void (on ? meter.ctx.resume() : meter.ctx.suspend()).catch(() => {});
}

// [mic, Codex] from 0 to 1, read once per orb frame; a muted mic reads as silence. The orb smooths them.
export function callLevels(): [number, number] {
  if (!mic) return [0, 0];
  // Opened here when the click did not (reduced motion or Lite turned off mid-call).
  const m = openMeter();
  return [level(m.mic, m.buf), level(m.out, m.buf)];
}

function micError(e: unknown) {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access is blocked. Allow it for this page in the browser, then call again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found. Connect one, then call again.';
  if (name === 'NotReadableError') return 'The microphone is busy in another app or could not start.';
  return `The microphone could not start${e instanceof Error && e.message ? `: ${e.message}` : '.'}`;
}

function closePeer() {
  clearTimeout(graceTimer);
  if (!pc) return;
  pc.onconnectionstatechange = pc.ontrack = null;
  pc.close();
  pc = null;
}

function releaseMedia() {
  closePeer();
  void meter?.ctx.close().catch(() => {});
  meter = null;
  for (const t of mic?.getTracks() ?? []) t.stop();
  mic = null;
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    audio = null;
  }
}

// Ends the call on screen; once the server knows it, it ends there too, so what was said is still saved.
function fail(error: string) {
  if (!view) return;
  if (known) send({ type: 'call-stop', callId: view.id });
  releaseMedia();
  patch({ state: 'error', error, ending: false });
}

// A fresh peer link on the same mic, offered to the server; the old link closes first.
async function dial(id: string) {
  if (!isCurrent(id) || !callActive(view) || !mic) return;
  closePeer();
  const no = ++offerNo;
  const peer = new RTCPeerConnection();
  pc = peer;
  for (const t of mic.getAudioTracks()) peer.addTrack(t, mic);
  // The realtime service expects this channel; nothing is ever sent on it.
  peer.createDataChannel('oai-events');
  peer.ontrack = (e) => {
    if (!audio) return;
    audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    meterOut();
  };
  peer.onconnectionstatechange = () => watch(peer);
  try {
    await peer.setLocalDescription(await peer.createOffer());
  } catch (e) {
    if (peer === pc) fail(`The call link could not start: ${errText(e)}`);
    return;
  }
  if (peer !== pc || !view) return;
  if (send({ type: 'call-start', sessionId: view.sessionId, callId: id, sdp: peer.localDescription!.sdp, offer: no })) known = true;
  else fail('Not connected to tarcsweb. Try again when the connection returns.');
}

const offer = (id: string) => (offering = offering.then(() => dial(id)).catch((e: unknown) => {
  if (isCurrent(id)) fail(`The call link could not start: ${errText(e)}`);
}));

// The browser's own link died while the server still has the call live: redial with a fresh offer.
function linkLost(peer: RTCPeerConnection) {
  if (peer !== pc || !view || view.state !== 'live') return;
  const { id } = view;
  patch({ state: 'reconnecting' });
  void offer(id);
}

function watch(peer: RTCPeerConnection) {
  if (peer !== pc) return;
  clearTimeout(graceTimer);
  if (peer.connectionState === 'failed') linkLost(peer);
  else if (peer.connectionState === 'disconnected') graceTimer = window.setTimeout(linkLost, DISCONNECT_GRACE_MS, peer);
}

export async function startCall(sessionId: string, name: string) {
  if (callActive(view)) return;
  releaseMedia();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  offerNo = 0;
  known = false;
  set({
    id, sessionId, name, state: 'connecting', liveAt: null, muted: false, ending: false, error: null, file: null, report: null, full: true, busy: false, acts: [],
    usage: null,
  });
  if (!navigator.mediaDevices?.getUserMedia) return fail('The microphone needs a secure page: open tarcsweb on localhost or over https.');
  // Still inside the click, before the first await; the still orb (Lite, reduced motion) reads no levels.
  if (!ambient()) openMeter();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    if (isCurrent(id) && view?.state === 'connecting') fail(micError(e));
    return;
  }
  // Ended or replaced while the mic prompt was open.
  if (!isCurrent(id) || view?.state !== 'connecting' || view.ending) {
    for (const t of stream.getTracks()) t.stop();
    return;
  }
  mic = stream;
  meterIn();
  audio = new Audio();
  audio.autoplay = true;
  await offer(id);
}

export function endCall() {
  if (!view || !callActive(view) || view.ending) return;
  const asked = known && send({ type: 'call-stop', callId: view.id });
  releaseMedia();
  // Nothing reached the server yet (the mic prompt was still open), so it ends here.
  patch(asked ? { ending: true } : { state: 'ended', ending: false });
}

export function toggleMute() {
  if (!view || !mic) return;
  const muted = !view.muted;
  for (const t of mic.getAudioTracks()) t.enabled = !muted;
  patch({ muted });
}

export function makeReport() {
  if (!view?.file || view.report?.state === 'working') return;
  if (!send({ type: 'call-report', callId: view.id })) return patch({ report: { state: 'failed', error: 'Not connected to tarcsweb. Try again when the connection returns.' } });
  patch({ report: { state: 'working' } });
}

export function closeCall() {
  if (!view) return;
  send({ type: 'call-dismiss', callId: view.id });
  releaseMedia();
  set(null);
}

export const setCallFull = (full: boolean) => view && view.full !== full && patch({ full });

function apply(m: CallMessage) {
  if (!view || m.callId !== view.id) return;
  // A line or a note from the old link must not undo a redial this window started, and an ended or failed call stays so:
  // an in-flight message never revives it, and the server's "ended" answer to a failure here keeps it failed.
  const keep = (view.state === 'reconnecting' && m.state === 'live' && m.sdp === undefined) || view.state === 'ended' || view.state === 'error';
  const next: Partial<CallView> = keep ? {} : { state: m.state };
  if (m.sdp !== undefined) {
    const peer = pc;
    if (m.offer !== offerNo || !peer) return;
    void peer.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch((e: unknown) => {
      if (peer === pc) fail(`The call could not connect: ${errText(e)}`);
    });
    next.liveAt = view.liveAt ?? Date.now();
    next.error = null;
  }
  // Only a message naming the offer that is gone asks for a new one, and not when a newer one is already out.
  if (m.state === 'reconnecting' && m.offer !== undefined && m.offer >= offerNo) void offer(view.id);
  if (m.busy !== undefined) next.busy = m.busy;
  if (m.activity) {
    const a = m.activity;
    const i = view.acts.findIndex((x) => x.id === a.id);
    const acts = i < 0 ? [...view.acts, a] : view.acts.with(i, a);
    next.acts = (a.text ? acts : acts.filter((x) => x.id !== a.id)).slice(-ACTS_SHOWN);
  }
  // A step whose end never came is over once the turn is; subagents and commands outlive it.
  if (m.busy === false) next.acts = (next.acts ?? view.acts).map((a) => (a.kind === 'step' && a.state === 'running' ? { ...a, state: 'done' } : a));
  if (m.state === 'ended' || m.state === 'error') {
    releaseMedia();
    Object.assign(next, { ending: false, busy: false });
  }
  // Report messages carry no file; the saved conversation stays.
  if (m.file !== undefined) next.file = m.file;
  if (m.usage) next.usage = m.usage;
  if (m.error !== undefined) next.error = m.error;
  if (m.report) {
    next.report = m.report;
    if (m.report.state === 'ready') attachDraft(view.sessionId, m.report.text);
  }
  patch(next);
}

// The server ends the call when this socket goes; a report it was writing is lost with it.
function socketLost() {
  if (!view) return;
  releaseMedia();
  patch({
    ...(callActive(view) ? { state: 'error' as const, error: 'The connection to tarcsweb dropped, so the call ended.' } : {}),
    ending: false, busy: false, file: null, report: view.report?.state === 'working' ? { state: 'failed', error: 'The connection to tarcsweb dropped.' } : view.report,
  });
}

onCall((m) => (m ? apply(m) : socketLost()));
