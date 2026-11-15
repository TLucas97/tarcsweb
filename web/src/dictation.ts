import { useSyncExternalStore } from 'react';
import type { ClientMessage, SttMessage, SttState } from '../../server/protocol.ts';
import { onStt, send } from './socket.ts';
import { useStore } from './store.ts';
import { getPref } from './prefs.ts';
import { inTauri } from './tauri.ts';

// Voice input: hold Space in the composer, or toggle the mic button; the server's hidden Claude Code transcribes.
// waiting: held while the engine still boots; it records as soon as the engine is ready, if still held.
export type DictPhase = 'idle' | 'waiting' | 'listening' | 'transcribing';
export type HoldBy = 'key' | 'pointer';
type Snap = { phase: DictPhase; by: HoldBy; engine: SttState; reason: string | null };

let snap: Snap = { phase: 'idle', by: 'key', engine: 'idle', reason: null };
const subs = new Set<() => void>();
const set = (p: Partial<Snap>) => {
  if (inTauri() && p.phase !== undefined && p.phase !== snap.phase) breadcrumb('phase', { from: snap.phase, to: p.phase });
  snap = { ...snap, ...p };
  for (const fn of subs) fn();
};
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
export const useDictation = () => useSyncExternalStore(subscribe, () => snap);

// The composer that receives the final text.
let sink: ((text: string) => void) | null = null;
export const setDictationSink = (fn: ((text: string) => void) | null) => void (sink = fn);

const notice = (text: string, info: boolean) => useStore.setState({ notice: text, noticeInfo: info });

// Keeps the engine up while the user writes; the server kills it after 10 idle minutes.
const WARM_EVERY_MS = 60_000;
let warmedAt = 0;
export function warmStt() {
  if (!getPref('voiceInput')) return;
  const now = Date.now();
  if (now - warmedAt < WARM_EVERY_MS) return;
  if (sendStt({ type: 'stt-warm' })) warmedAt = now;
}

// Never stuck on "Transcribing…" if the answer gets lost.
const TRANSCRIBE_TIMEOUT_MS = 35_000;
let holding: HoldBy | null = null;
let doneTimer = 0;
// take: the server's messages about this take drive the phase (0 = none). prev: a released take still owed its text
// while a newer hold waits for the engine.
let seq = 0;
let take = 0;
let prev = 0;

type Crumb = Record<string, string | number | boolean | null | undefined>;
const breadcrumbs: Crumb[] = [];
let holdTimer = 0;

function breadcrumb(event: string, data: Crumb = {}) {
  if (!inTauri()) return;
  breadcrumbs.push({ at: Date.now(), event, take, phase: snap.phase, holding, ...data });
  if (breadcrumbs.length > 20) breadcrumbs.shift();
}

export function recordDictationKey(e: Pick<KeyboardEvent, 'type' | 'key' | 'repeat' | 'target'>) {
  if (!inTauri()) return;
  breadcrumb(e.type, {
    key: e.key === ' ' ? 'Space' : ['Escape', 'Process', 'Unidentified'].includes(e.key) ? e.key : 'other',
    repeat: e.repeat, target: e.target instanceof Element ? e.target.tagName : null,
  });
}

function reportHold(reason: string) {
  if (!inTauri()) return;
  breadcrumb('diagnostic', { reason, engine: snap.engine });
  send({ type: 'client-diag', scope: 'dictation', events: breadcrumbs.slice() });
}

function sendStt(message: Extract<ClientMessage, { type: 'stt-warm' | 'stt-start' | 'stt-stop' | 'stt-cancel' }>) {
  const sent = send(message);
  if (inTauri()) breadcrumb('stt-out', { message: message.type, sent, ...('take' in message ? { messageTake: message.take } : {}) });
  return sent;
}

export const isHolding = () => holding !== null;

const onKeyUp = (e: KeyboardEvent) => {
  if (e.key === ' ') endHold();
};
// The desktop hold needs a keyboard exit when the Space release never reaches the page.
const onEscape = (e: KeyboardEvent) => {
  recordDictationKey(e);
  if (e.key !== 'Escape' || e.isComposing || !holding) return;
  e.preventDefault();
  e.stopPropagation();
  if (take) sendStt({ type: 'stt-cancel', take });
  unhook();
  take = 0;
  setPhase('idle');
  reportHold('escape');
};
// Focus leaving the window swallows the key-up, so leaving ends the hold too.
const onLeave = () => {
  breadcrumb('blur');
  endHold();
};
const onVisibility = () => {
  if (inTauri()) breadcrumb('visibilitychange', { hidden: document.hidden });
  if (document.hidden) endHold();
};

function unhook() {
  holding = null;
  removeEventListener('keyup', onKeyUp, true);
  if (inTauri()) {
    clearTimeout(holdTimer);
    removeEventListener('keydown', onEscape, true);
    removeEventListener('keyup', recordDictationKey, true);
  }
  removeEventListener('blur', onLeave);
  document.removeEventListener('visibilitychange', onVisibility);
}

// Gives up on a take whose answer never came, on both sides.
function giveUp(t: number) {
  if (take !== t || snap.phase !== 'transcribing') return;
  sendStt({ type: 'stt-cancel', take: t });
  unhook();
  take = 0;
  set({ phase: 'idle' });
}

// Every way into "Transcribing…" arms the fallback; every way out clears it.
function setPhase(phase: DictPhase, extra: Partial<Snap> = {}) {
  if (phase !== 'transcribing') clearTimeout(doneTimer);
  else if (snap.phase !== 'transcribing') doneTimer = window.setTimeout(giveUp, TRANSCRIBE_TIMEOUT_MS, take);
  set({ ...extra, phase });
}

export function startHold(by: HoldBy) {
  if (holding || !getPref('voiceInput')) return false;
  const id = ++seq;
  if (!sendStt({ type: 'stt-start', take: id })) return false;
  // A take still transcribing keeps its text; this one waits until the engine is free.
  const busy = snap.phase === 'transcribing';
  if (busy) prev = take;
  take = id;
  holding = by;
  warmedAt = Date.now();
  if (inTauri()) {
    addEventListener('keydown', onEscape, true);
    addEventListener('keyup', recordDictationKey, true);
    // Report a long hold without cutting off valid dictation.
    holdTimer = window.setTimeout(() => {
      if (holding && (snap.phase === 'listening' || snap.phase === 'waiting')) reportHold('hold-over-35s');
    }, TRANSCRIBE_TIMEOUT_MS);
  }
  if (by === 'key') addEventListener('keyup', onKeyUp, true);
  addEventListener('blur', onLeave);
  document.addEventListener('visibilitychange', onVisibility);
  setPhase(snap.engine === 'ready' && !busy ? 'listening' : 'waiting', { by });
  return true;
}

export function endHold() {
  if (!holding) return;
  unhook();
  // The take already ended while the key was still down.
  if (!take) return;
  if (snap.phase === 'waiting') {
    sendStt({ type: 'stt-cancel', take });
    take = 0;
    setPhase('idle');
    notice('Voice input is still starting. Hold again in a moment.', true);
  } else {
    sendStt({ type: 'stt-stop', take });
    setPhase('transcribing');
  }
}

function answer(m: SttMessage) {
  if (m.text) sink?.(m.text);
  else if (m.error) notice(m.error, m.error === 'No speech detected');
}

onStt((m) => {
  if (inTauri()) breadcrumb('stt-in', m ? {
    state: m.state, messageTake: m.take, textChars: m.text?.length,
    error: m.error !== undefined, cancelled: m.cancelled === true,
  } : { disconnected: true });
  if (!m) {
    unhook();
    take = prev = 0;
    setPhase('idle', { engine: 'idle' });
    return;
  }
  if (m.take === undefined) return set({ engine: m.state, reason: m.state === 'unavailable' ? m.error ?? snap.reason : snap.reason });
  const over = m.text !== undefined || m.error !== undefined || m.cancelled === true;
  if (over && m.take === prev) {
    prev = 0;
    return answer(m);
  }
  // Late messages about a take this client already gave up on.
  if (m.take !== take) return;
  if (over) {
    take = 0;
    setPhase('idle', m.state === 'unavailable' ? { engine: 'unavailable', reason: m.error ?? snap.reason } : {});
    return answer(m);
  }
  if (m.state === 'starting' && holding) return setPhase('waiting');
  // A quick release can beat the engine's "recording" echo; the take is already transcribing then.
  if (m.state === 'recording') return setPhase(holding ? 'listening' : 'transcribing');
  if (m.state === 'transcribing') setPhase('transcribing');
});
