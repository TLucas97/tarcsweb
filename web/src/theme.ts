import { useSyncExternalStore } from 'react';
import { pref } from './bits.tsx';

export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_MODES: [ThemeMode, string, string][] = [
  ['system', 'System', 'Follows the OS setting'],
  ['light', 'Light', 'Warm paper'],
  ['dark', 'Dark', 'Matte dark'],
];

// Keep in sync with the boot script in index.html, which treats a missing value as dark.
const DEFAULT: ThemeMode = 'dark';
const media = matchMedia('(prefers-color-scheme: dark)');
const subs = new Set<() => void>();

function read(): ThemeMode {
  const m = pref.get<unknown>('theme', DEFAULT);
  return m === 'system' || m === 'light' || m === 'dark' ? m : DEFAULT;
}

let mode = read();
let dark = false;
let meta: HTMLMetaElement | null = null;

function apply() {
  dark = mode === 'dark' || (mode === 'system' && media.matches);
  const root = document.documentElement;
  const next = dark ? 'dark' : 'light';
  if (root.dataset.theme !== next) root.dataset.theme = next;
  // Only while dark: a theme-color in light would recolor the app window's titlebar.
  if (dark && !meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#1e1d1a';
    document.head.append(meta);
  } else if (!dark && meta) {
    meta.remove();
    meta = null;
  }
  for (const fn of subs) fn();
}

export const themeMode = () => mode;
export const isDark = () => dark;

export function setThemeMode(m: ThemeMode) {
  mode = m;
  pref.set('theme', m);
  apply();
}

export function onTheme(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export const useThemeMode = () => useSyncExternalStore(onTheme, themeMode);
export const useDark = () => useSyncExternalStore(onTheme, isDark);

media.addEventListener('change', () => {
  if (mode === 'system') apply();
});
// Another tab changed the theme.
addEventListener('storage', (e) => {
  if (e.key !== 'cw:theme') return;
  mode = read();
  apply();
});

apply();
