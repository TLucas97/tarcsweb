import { useSyncExternalStore } from 'react';
import { pref } from '../bits.tsx';
import { CHAPTERS, ESSENTIALS, type Chapter } from './chapters.ts';

const KEY = 'tour';
// Chapter ids this browser was already offered; null until the first-run invite gets an answer.
type Seen = { known: string[] };
let seen = pref.get<Seen | null>(KEY, null);

export type Play = { list: Chapter[]; at: number };
let play: Play | null = null;

const subs = new Set<() => void>();
const emit = () => {
  for (const fn of subs) fn();
};
function subscribe(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export const useTourSeen = () => useSyncExternalStore(subscribe, () => seen);
export const useTourPlay = () => useSyncExternalStore(subscribe, () => play);

// Chapters added by an update since this browser last answered the tour.
export const unseen = (s: Seen) => CHAPTERS.filter((c) => !s.known.includes(c.id));

export function markSeen() {
  seen = { known: CHAPTERS.map((c) => c.id) };
  pref.set(KEY, seen);
  emit();
}

export function playTour(list: Chapter[] = ESSENTIALS, at = 0) {
  markSeen();
  play = { list, at };
  emit();
}

export function stepTour(at: number) {
  if (!play || at < 0 || at >= play.list.length) return;
  play = { ...play, at };
  emit();
}

export function closeTour() {
  play = null;
  emit();
}

// Another tab answered the invite.
addEventListener('storage', (e) => {
  if (e.key !== `cw:${KEY}`) return;
  seen = pref.get<Seen | null>(KEY, null);
  emit();
});
