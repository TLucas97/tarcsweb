import { useSyncExternalStore } from 'react';

// The Browser panel's open flag. The panel registers a closer so a second click on the trigger plays its exit.
let open = false;
let origin: HTMLElement | null = null;
let closer: (() => void) | null = null;
const subs = new Set<() => void>();
const emit = () => {
  for (const fn of subs) fn();
};

export function openBrowser(from: HTMLElement | null) {
  if (open) return;
  open = true;
  origin = from;
  emit();
}

// Unmounts right away; the panel calls it once its exit finished.
export function closedBrowser() {
  if (!open) return;
  open = false;
  if (origin?.isConnected) origin.focus({ preventScroll: true });
  emit();
}

export function toggleBrowser(from: HTMLElement | null) {
  if (!open) return openBrowser(from);
  if (closer) closer();
  else closedBrowser();
}

export function onCloseRequest(fn: (() => void) | null) {
  closer = fn;
}

export const browserOrigin = () => origin;

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
export const useBrowserOpen = () => useSyncExternalStore(subscribe, () => open);
