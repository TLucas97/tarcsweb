import { useSyncExternalStore } from 'react';
import { pref } from './bits.tsx';
import { isLite, subscribe as onPerf } from './perf.ts';

const FONT_IDS = ['lexend', 'noto-serif', 'dyslexic', 'roboto-mono', 'roboto-slab', 'bebas', 'jetbrains-mono', 'fira-code', 'bricolage', 'maven'] as const;
// The working soundscapes; each id is a loop in public/sounds/focus (notes/promo/tools/focussounds.py --loop).
export const FOCUS_IDS = ['pad-drift', 'lofi-keys', 'robot-plinks', 'rain-tones', 'hum-evolved', 'beta-pulse-120', 'airport-loops', 'robot-workshop'] as const;
const PERCENTS: readonly number[] = Array.from({ length: 101 }, (_, i) => i);
// Volume slider percent to gain: square law, so each step sounds even; 100% is +6 dB over the old "high" (0.8).
export const loudness = (v: number) => 1.6 * (v / 100) ** 2;
// The old Low/Medium/High as the slider values with the same gain.
const OLD_VOLUME: Record<string, number> = { low: 40, mid: 56, high: 71 };

// Appearance prefs kept in this browser. Each value is mirrored on <html> as data-<key>; index.html does it before first paint.
// A new pref is one entry here plus a usePref(key) where it is read.
export const PREFS = {
  font: { def: 'lexend', values: FONT_IDS },
  // Replies, sent messages and the composer text; 'app' follows the app font.
  msgFont: { def: 'app', values: ['app', ...FONT_IDS] },
  textScale: { def: 'm', values: ['s', 'm', 'l', 'xl'] },
  backdrop: { def: true, values: [true, false] },
  clickRipple: { def: true, values: [true, false] },
  // The app's own cursor set (arrow, hand, I-beam, grab, resize...) instead of the system one.
  cursor: { def: true, values: [true, false] },
  // Also sent to the server, which writes the prompt and the TL;DR by it.
  replyStyle: { def: 'stretch', values: ['stretch', 'summary'] },
  // Hold Space in the composer to dictate; off means Space only types and the engine never starts.
  voiceInput: { def: true, values: [true, false] },
  // Playback speed of the spoken recaps and replay summaries.
  voiceRate: { def: 1, values: [1, 1.25, 1.5, 2, 3] },
  // The robot's sounds: what plays while agents work (the classic hum, a soundscape, a random one each time), its spoken lines, and the short effects.
  soundWork: { def: 'classic', values: ['off', 'random', 'classic', ...FOCUS_IDS] },
  soundVoice: { def: true, values: [true, false] },
  soundFx: { def: true, values: [true, false] },
  // Slider percents: the working sound, and the voice (lines, names, recaps) with the effects. See loudness().
  soundWorkVolume: { def: 60, values: PERCENTS },
  soundVoiceVolume: { def: 60, values: PERCENTS },
  // Desktop notices also need the browser's permission, asked when this is turned on in Settings.
  desktopNotify: { def: true, values: [true, false] },
  // Session tabs on top or in a left rail; narrow windows always use the top.
  dockMode: { def: 'top', values: ['top', 'side'] },
  // The sidebar's size: the 44px rail or the large sidebar with tab details; kept while tabs are on top.
  dockSize: { def: 'large', values: ['rail', 'large'] },
  // Skills library: how the folders group, and which parts of the chat a deep suggestion reads.
  skillsGroup: { def: 'source', values: ['source', 'author', 'theme'] },
  skillsDeepRecent: { def: true, values: [true, false] },
  skillsDeepSummary: { def: true, values: [true, false] },
} as const;

export type PrefKey = keyof typeof PREFS;
export type PrefValue<K extends PrefKey> = (typeof PREFS)[K]['values'][number];
type Prefs = { [K in PrefKey]: PrefValue<K> };

const KEY = 'prefs';
// The scale moved down a step when textSize became textScale; index.html maps it the same way before first paint.
const OLD_TEXT_SIZE: Record<string, string> = { s: 'm', m: 'l', l: 'xl' };
// The one sounds switch became three; if it was off, all three start off.
const OLD_SOUNDS = ['soundHum', 'soundVoice', 'soundFx'];
const subs = new Set<() => void>();

function read(): Prefs {
  const saved = pref.get<Record<string, unknown> | null>(KEY, null) ?? {};
  if (saved.textScale === undefined && typeof saved.textSize === 'string') saved.textScale = OLD_TEXT_SIZE[saved.textSize];
  if (saved.sounds === false) for (const k of OLD_SOUNDS) saved[k] ??= false;
  // The hum switch became a choice of working sound; on was the classic hum.
  if (saved.soundWork === undefined && typeof saved.soundHum === 'boolean') saved.soundWork = saved.soundHum ? 'classic' : 'off';
  // "Font in messages only" became its own messages font; index.html maps it the same way before first paint.
  if (saved.msgFont === undefined && saved.fontScope === 'messages') [saved.msgFont, saved.font] = [saved.font, 'lexend'];
  // The one Low/Medium/High volume became two sliders; both start where it was.
  if (typeof saved.soundVolume === 'string' && saved.soundVolume in OLD_VOLUME) {
    saved.soundWorkVolume ??= OLD_VOLUME[saved.soundVolume];
    saved.soundVoiceVolume ??= OLD_VOLUME[saved.soundVolume];
  }
  const out: Record<string, unknown> = {};
  for (const [k, d] of Object.entries(PREFS)) out[k] = (d.values as readonly unknown[]).includes(saved[k]) ? saved[k] : d.def;
  return out as Prefs;
}

let prefs = read();

// Lite reads these as off without touching the saved choice, so leaving Lite restores it.
const LITE_OFF: Partial<Prefs> = { backdrop: false, clickRipple: false, soundWork: 'off', soundVoice: false, soundFx: false };
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

// Runs after any pref or the Lite profile changes.
export function subscribe(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export const usePref = <K extends PrefKey>(key: K): PrefValue<K> => useSyncExternalStore(subscribe, () => effective(key));
export const useSavedPref = <K extends PrefKey>(key: K): PrefValue<K> => useSyncExternalStore(subscribe, () => prefs[key]);

// Pinned dock tabs by session id, in pin order. Not in PREFS: they are ids, not one of a fixed set of values.
const PINS_KEY = 'dock.pins';
const PINS_MAX = 24;
const pinSubs = new Set<() => void>();
const readPins = () => {
  const v = pref.get<unknown>(PINS_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-PINS_MAX) : [];
};
let pins = readPins();

export const getPins = (): readonly string[] => pins;
export function setPins(next: string[]) {
  pins = next.slice(-PINS_MAX);
  pref.set(PINS_KEY, pins);
  for (const fn of pinSubs) fn();
}
function subscribePins(fn: () => void) {
  pinSubs.add(fn);
  return () => {
    pinSubs.delete(fn);
  };
}
export const usePins = () => useSyncExternalStore(subscribePins, getPins);

// Another tab changed a pref or the pins.
addEventListener('storage', (e) => {
  if (e.key === `cw:${PINS_KEY}`) {
    pins = readPins();
    for (const fn of pinSubs) fn();
    return;
  }
  if (e.key !== `cw:${KEY}`) return;
  prefs = read();
  apply();
});

onPerf(apply);
apply();
