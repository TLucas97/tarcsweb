import { useSyncExternalStore } from 'react';

// The runner egg's open flag and its popup placement. Tiny on purpose: App, Working and the strip import it.
let open = false;
const subs = new Set<() => void>();

export function setRunner(on: boolean) {
  if (open === on) return;
  open = on;
  for (const fn of subs) fn();
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
export const useRunning = () => useSyncExternalStore(subscribe, () => open);

// Above the robot's body with its arrow on him; called from the click that opens it, so reading the rect is fine.
export function openEgg(pop: HTMLElement, hit: HTMLElement) {
  const b = hit.getBoundingClientRect(), cx = b.left + b.width / 2, x = Math.min(Math.max(cx, 150), innerWidth - 150);
  pop.style.left = `${x}px`;
  pop.style.bottom = `${innerHeight - b.top + 12}px`;
  pop.style.setProperty('--rn-ax', `${cx - x}px`);
  if (!pop.matches(':popover-open')) pop.showPopover();
}
