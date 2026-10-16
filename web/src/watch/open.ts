import { useSyncExternalStore } from 'react';
import type { WatchTimelineMessage } from '../../../server/protocol.ts';

// Watch mode's open flag, the socket's event times and the timeline hand-off. Tiny on purpose: App, the strip,
// store.ts and socket.ts import it.
let open = false;
let opener: HTMLElement | null = null;
const subs = new Set<() => void>();

// `from` gets focus back when watch closes.
export function setWatch(on: boolean, from: HTMLElement | null = null) {
  if (open === on) return;
  open = on;
  if (on) opener = from;
  else {
    stamps.clear();
    timeline = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }
  for (const fn of subs) fn();
}
export const isWatching = () => open;

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
export const useWatching = () => useSyncExternalStore(subscribe, () => open);

// Wall clock in epoch seconds; performance-based so it never jumps with the system clock.
export const wallNow = () => (performance.timeOrigin + performance.now()) / 1000;

// Local minus server clock, from the fastest delivery seen: the server's `at` is on its clock, a phone's may differ.
let skew = Infinity;
export const fromServer = (atMs: number) => atMs / 1000 + (Number.isFinite(skew) ? skew : 0);

// Each event's time while watch is open (seconds): the server's `at` when it has one, else its arrival. Capped.
const STAMPS_MAX = 512;
const stamps = new Map<number, number>();
export function stamp(seq: number | undefined, at: number | undefined) {
  if (!open || seq === undefined) return;
  const now = wallNow();
  if (at !== undefined) skew = Math.min(skew, now - at / 1000);
  stamps.set(seq, at !== undefined ? fromServer(at) : now);
  if (stamps.size > STAMPS_MAX) stamps.delete(stamps.keys().next().value!);
}
export const stampOf = (seq: number) => stamps.get(seq);

// watch-timeline replies go to the open model only; nothing in React state holds them.
let timeline: ((m: WatchTimelineMessage) => void) | null = null;
export function onTimeline(fn: ((m: WatchTimelineMessage) => void) | null) {
  timeline = fn;
}
export function deliverTimeline(m: WatchTimelineMessage) {
  if (open) timeline?.(m);
}
