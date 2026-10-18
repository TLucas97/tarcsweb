import { useSyncExternalStore } from 'react';
import { pref } from './bits.tsx';
import { isLite, subscribe as onPerf } from './perf.ts';

// Appearance prefs kept in this browser. Each value is mirrored on <html> as data-<key>; index.html does it before first paint.
// A new pref is one entry here plus a usePref(key) where it is read.
export const PREFS = {
  font: { def: 'lexend', values: ['lexend', 'noto-serif'] },
  textScale: { def: 'm', values: ['s', 'm', 'l', 'xl'] },
  backdrop: { def: true, values: [true, false] },
  clickRipple: { def: true, values: [true, false] },
  // The app's own arrow; text, link and resize cursors stay native.
  cursor: { def: true, values: [true, false] },
  // Also sent to the server, which writes the prompt and the TL;DR by it.
  replyStyle: { def: 'stretch', values: ['stretch', 'summary'] },
  // Hold Space in the composer to dictate; off means Space only types and the engine never starts.
  voiceInput: { def: true, values: [true, false] },
  // Playback speed of the spoken recaps and replay summaries.
  voiceRate: { def: 1, values: [1, 1.25, 1.5, 2, 3] },
} as const;

export type PrefKey = keyof typeof PREFS;
export type PrefValue<K extends PrefKey> = (typeof PREFS)[K]['values'][number];
type Prefs = { [K in PrefKey]: PrefValue<K> };

const KEY = 'prefs';
// The scale moved down a step when textSize became textScale; index.html maps it the same way before first paint.
const OLD_TEXT_SIZE: Record<string, string> = { s: 'm', m: 'l', l: 'xl' };
const subs = new Set<() => void>();

function read(): Prefs {
  const saved = pref.get<Record<string, unknown> | null>(KEY, null) ?? {};
  if (saved.textScale === undefined && typeof saved.textSize === 'string') saved.textScale = OLD_TEXT_SIZE[saved.textSize];
  const out: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(PREFS)) out[k] = (d.values as readonly unknown[]).includes(saved[k]) ? saved[k] : d.def;
  return out as Prefs;
}

let prefs = read();

// Lite reads these as off without touching the saved choice, so leaving Lite restores it.
const LITE_OFF: Partial<Prefs> = { backdrop: false, clickRipple: false };
const effective = <K extends PrefKey>(key: K): PrefValue<K> => (isLite() && key in LITE_OFF ? LITE_OFF[key]! : prefs[key]);

function apply() {
  const root = document.documentElement;
  for (const k of Object.keys(prefs) as PrefKey[]) {
    const v = String(effective(k));
    if (root.dataset[k] !== v) root.dataset[k] = v;
  }
  for (const fn of subs) fn();
}

// The value in effect; Settings shows the saved one with getSavedPref/useSavedPref.
export const getPref = <K extends PrefKey>(key: K): PrefValue<K> => effective(key);
export const getSavedPref = <K extends PrefKey>(key: K): PrefValue<K> => prefs[key];

export function setPref<K extends PrefKey>(key: K, value: PrefValue<K>) {
  if (prefs[key] === value) return;
  prefs = { ...prefs, [key]: value };
  pref.set(KEY, prefs);
  apply();
}

function subscribe(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export const usePref = <K extends PrefKey>(key: K): PrefValue<K> => useSyncExternalStore(subscribe, () => effective(key));
export const useSavedPref = <K extends PrefKey>(key: K): PrefValue<K> => useSyncExternalStore(subscribe, () => prefs[key]);

// Another tab changed a pref.
addEventListener('storage', (e) => {
  if (e.key !== `cw:${KEY}`) return;
  prefs = read();
  apply();
});

onPerf(apply);
apply();
