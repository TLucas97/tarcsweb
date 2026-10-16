import { flushSync } from 'react-dom';
import type { ClientMessage } from '../../server/protocol.ts';
import { onHistory, useStore } from './store.ts';

// The conversation mounts a window of rows and the store holds only the newest part of the history;
// code that targets another row loads and mounts it through here first.
type Bridge = { mountAt: (index: number) => void; release: () => void; send: (msg: ClientMessage) => boolean };
let bridge: Bridge | null = null;

export function bindWindow(b: Bridge) {
  bridge = b;
  return () => {
    if (bridge === b) bridge = null;
  };
}

// Stops following the bottom for a scroll the code is about to make.
export function release() {
  bridge?.release();
}

// After the next frame has laid out, so rows just mounted have their place (and the browser's scroll anchoring has run).
export function afterFrames(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

// One history-load at a time; its reply resolves it, true when the page came.
const waiters = new Map<string, (ok: boolean) => void>();
onHistory((msg) => {
  if (msg.type !== 'history') return;
  const key = `${msg.sessionId}:${msg.before}`;
  waiters.get(key)?.(!msg.error);
  waiters.delete(key);
});
let pending: Promise<boolean> | null = null;
// A failed load waits this long before the scroll may ask again.
const RETRY_MS = 3000;
let failedAt = 0;

// Loads the next older page, or every page back to `to` (a seq or an event id). False when nothing came.
export async function loadOlder(to?: { seq?: number; id?: string }): Promise<boolean> {
  if (pending) return to ? pending.then(() => loadOlder(to)) : pending;
  const s = useStore.getState();
  const sid = s.current;
  const before = s.older;
  if (!sid || before === null || !bridge) return false;
  if (to && (to.seq !== undefined ? to.seq >= before : !!to.id && !!s.items[to.id])) return true;
  if (!to && Date.now() - failedAt < RETRY_MS) return false;
  const key = `${sid}:${before}`;
  const ask = bridge.send;
  pending = new Promise<boolean>((done) => {
    const timer = setTimeout(() => finish(false), 20_000);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      waiters.delete(key);
      if (!ok) failedAt = Date.now();
      done(ok);
    };
    waiters.set(key, finish);
    if (!ask({ type: 'history-load', sessionId: sid, before, ...(to?.seq !== undefined ? { until: to.seq } : to?.id ? { id: to.id } : {}) })) finish(false);
  }).finally(() => (pending = null));
  return pending;
}

export const isLoadingOlder = () => !!pending;

// The row an item shows in: a tool inside a group shows in the group's row.
export function rowOf(id: string) {
  const item = useStore.getState().items[id];
  return item?.kind === 'tool' && item.group ? item.group : id;
}

// Mounts the row holding `id` (a row, or a tool inside a group) and lets go of the bottom; false when it is not loaded.
export function showRow(id: string) {
  const s = useStore.getState();
  const i = s.order.lastIndexOf(rowOf(id));
  if (i < 0 || !bridge) return false;
  bridge.release();
  flushSync(() => bridge!.mountAt(i));
  return true;
}

// Loads the history page holding `id` when it is not loaded yet; true once its row can be mounted.
export async function reach(id: string, seq?: number) {
  if (useStore.getState().items[id]) return true;
  const sid = useStore.getState().current;
  await loadOlder(seq !== undefined ? { seq } : { id });
  const s = useStore.getState();
  return s.current === sid && !!s.items[id];
}
