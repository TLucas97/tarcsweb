import { useEffect } from 'react';
import type { SessionSummary } from '../../server/protocol.ts';
import { openSession } from './socket.ts';
import { useStore } from './store.ts';

const open = new Map<string, Notification>();

function notify(r: SessionSummary, body: string) {
  // One notice per session: a newer one replaces it.
  open.get(r.id)?.close();
  const icon = document.querySelector<HTMLLinkElement>('link[rel=icon]')?.href;
  const n = new Notification(r.name, { body, tag: r.id, ...(icon ? { icon } : {}) });
  n.onclick = () => {
    window.focus();
    openSession(r.id);
    n.close();
  };
  n.onclose = () => open.get(r.id) === n && open.delete(r.id);
  open.set(r.id, n);
}

// Desktop notifications when a session finishes or needs you while the window is in the background.
export function useDesktopNotices() {
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    // Chrome only shows the permission prompt reliably after a gesture, so ask on the first click.
    const ask = () => Notification.permission === 'default' && Notification.requestPermission();
    if (Notification.permission === 'default') addEventListener('pointerdown', ask, { once: true });
    const clear = () => {
      for (const n of open.values()) n.close();
      open.clear();
    };
    addEventListener('focus', clear);

    let prev = new Map(useStore.getState().roster.map((r) => [r.id, r]));
    const unsub = useStore.subscribe((s, old) => {
      // Most store updates are conversation events; only roster changes matter here.
      if (s.roster === old.roster) return;
      const now = new Map(s.roster.map((r) => [r.id, r]));
      if (Notification.permission === 'granted' && !document.hasFocus()) {
        for (const r of s.roster) {
          const was = prev.get(r.id);
          if (!was) continue;
          if (r.needsYou && !was.needsYou) notify(r, 'Waiting for your answer');
          // The session on screen ends as idle, the others as done.
          else if (was.state === 'working' && (r.state === 'done' || r.state === 'idle')) notify(r, 'Finished');
        }
      }
      prev = now;
    });
    return () => {
      unsub();
      removeEventListener('pointerdown', ask);
      removeEventListener('focus', clear);
    };
  }, []);
}
