// The browser sockets' secret for this server run. It comes with every hello on the main socket, and the browser
// sockets reconnect at once when it changes (a restarted server).
let key: string | null = null;
const subs = new Set<() => void>();

export function setBrowserKey(next: string) {
  if (!next || next === key) return;
  key = next;
  for (const fn of subs) fn();
}

// Null until the main socket said hello.
export const browserSocketUrl = (watch: boolean) =>
  key ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/browser?${watch ? 'watch=1&' : ''}key=${encodeURIComponent(key)}` : null;

export function onBrowserKey(fn: () => void) {
  subs.add(fn);
  return () => void subs.delete(fn);
}
