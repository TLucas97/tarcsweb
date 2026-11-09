import { useEffect } from 'react';
import { useStore } from './store.ts';

// One polite live region for the page, made on first use, so cards never mount a region each.
let region: HTMLElement | null = null;

export function announce(text: string) {
  if (!region) {
    region = document.createElement('div');
    region.className = 'sr';
    region.setAttribute('role', 'status');
    document.body.append(region);
  }
  const r = region;
  // Cleared first and set a frame later, so a fresh region or a repeated text is still read.
  r.textContent = '';
  requestAnimationFrame(() => (r.textContent = text));
}

// A visual or prototype card while its input streams: one note when writing starts and one when it ends, never per KB.
export function useBuildNotice(id: string, building: boolean) {
  useEffect(() => {
    if (!building) return;
    const sid = useStore.getState().current;
    announce('Writing the page');
    return () => {
      const s = useStore.getState();
      const it = s.items[id];
      // Only a real end speaks: the call became its card or its check row. A tab switch or a scroll-out stays silent.
      if (s.current === sid && it && !(it.kind === 'rich' && it.partial)) announce('Page written');
    };
  }, [id, building]);
}
