import { flushSync } from 'react-dom';
import { create } from 'zustand';
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

// One history-load per session at a time; its reply resolves it, true when the page came.
const waiters = new Map<string, (ok: boolean) => void>();
onHistory((msg) => {
  if (msg.type !== 'history') return;
  const key = `${msg.sessionId}:${msg.before}`;
  waiters.get(key)?.(!msg.error);
  waiters.delete(key);
});
const pending = new Map<string, Promise<boolean>>();
// A failed load waits this long before the scroll may ask again; the Retry button skips the wait.
const RETRY_MS = 3000;
const failedAt = new Map<string, number>();
const TIMEOUT_MS = 20_000;

// What the top of each session's history shows: an older page on its way, or the last one that failed.
export const useOlderLoad = create<Record<string, 'loading' | 'failed'>>(() => ({}));
const mark = (sid: string, v: 'loading' | 'failed' | null) =>
  useOlderLoad.setState((s) => {
    const { [sid]: _old, ...rest } = s;
    return v ? { ...rest, [sid]: v } : rest;
  }, true);

// A closed socket never answers, so every load in flight fails now instead of at its timeout.
useStore.subscribe((s, prev) => {
  if (prev.connected && !s.connected) for (const finish of [...waiters.values()]) finish(false);
});

// Loads the next older page, or every page back to `to` (a seq or an event id). False when nothing came.
export async function loadOlder(to?: { seq?: number; id?: string }, force = false): Promise<boolean> {
  const s = useStore.getState();
  const sid = s.current;
  if (!sid) return false;
  const running = pending.get(sid);
  if (running) return to ? running.then(() => loadOlder(to)) : running;
  const before = s.older;
  if (before === null || !bridge) return false;
  if (to && (to.seq !== undefined ? to.seq >= before : !!to.id && !!s.items[to.id])) return true;
  if (!to && !force && Date.now() - (failedAt.get(sid) ?? 0) < RETRY_MS) return false;
  const key = `${sid}:${before}`;
  const ask = bridge.send;
  mark(sid, 'loading');
  const p = new Promise<boolean>((done) => {
    const timer = setTimeout(() => finish(false), TIMEOUT_MS);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      waiters.delete(key);
      if (ok) failedAt.delete(sid);
      else failedAt.set(sid, Date.now());
      mark(sid, ok ? null : 'failed');
      done(ok);
    };
    waiters.set(key, finish);
    if (!ask({ type: 'history-load', sessionId: sid, before, ...(to?.seq !== undefined ? { until: to.seq } : to?.id ? { id: to.id } : {}) })) finish(false);
  }).finally(() => pending.delete(sid));
  pending.set(sid, p);
  return p;
}

export const isLoadingOlder = () => {
  const sid = useStore.getState().current;
  return !!sid && pending.has(sid);
};

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
