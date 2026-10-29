import { useSyncExternalStore } from 'react';
import type { PerfProfile } from '../../server/protocol.ts';

// The one place that decides how much motion and background work runs. It imports no visual module, so any of them can use it.
// The server owns the profile; localStorage only keeps the last value for the first paint (index.html reads it too).
const KEY = 'cw:perf';
const valid = (v: unknown): v is PerfProfile => v === 'standard' || v === 'lite';

function cached(): PerfProfile {
  try {
    const v = localStorage.getItem(KEY);
    return valid(v) ? v : 'standard';
  } catch {
    return 'standard';
  }
}

let profile = cached();
// null until the server answers.
let chosen: boolean | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const fn of listeners) fn();
};

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
motionQuery.addEventListener('change', notify);

document.documentElement.dataset.perf = profile;

// styles.css pauses its CSS loops while the tab is hidden.
const markHidden = () => document.documentElement.toggleAttribute('data-hidden', document.hidden);
markHidden();
document.addEventListener('visibilitychange', markHidden);

// Ref callback for long CSS loops that can sit off screen: an off-screen loop still keeps the compositor ticking,
// content-visibility:auto included. styles.css reads --anim-state on the element and its children.
let offscreenIo: IntersectionObserver | null = null;
export function pauseOffscreen(el: Element | null) {
  if (!el) return;
  offscreenIo ??= new IntersectionObserver((es) => {
    for (const e of es) (e.target as HTMLElement).style.setProperty('--anim-state', e.isIntersecting ? 'running' : 'paused');
  });
  offscreenIo.observe(el);
  return () => offscreenIo?.unobserve(el);
}

// Called with the server's value only; the client never sends its cached copy back.
export function setPerf(next: PerfProfile, isChosen: boolean) {
  if (next === profile && isChosen === chosen) return;
  chosen = isChosen;
  if (next !== profile) {
    profile = next;
    document.documentElement.dataset.perf = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {}
  }
  notify();
}

export const perfProfile = () => profile;
export const isLite = () => profile === 'lite';
export const perfChosen = () => chosen;
export const reduceMotion = () => motionQuery.matches;
// Self-running loops: robot, LEDs, backdrop, favicon, boot, flap.
export const ambient = () => reduceMotion() || isLite();
// Costly one-off effects: switchFx, draw and count entrances, live iframes.
export const heavy = () => reduceMotion() || isLite();

// Fires when the profile, its chosen flag or the reduced-motion preference changes.
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export const useLite = () => useSyncExternalStore(subscribe, isLite);
export const useAmbient = () => useSyncExternalStore(subscribe, ambient);
