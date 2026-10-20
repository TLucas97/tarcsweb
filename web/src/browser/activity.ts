import { useSyncExternalStore } from 'react';
import type { BrowserClientMessage, BrowserServerMessage, BrowserStatus, BrowserTool, BrowserWhy } from '../../../server/protocol.ts';
import { useStore } from '../store.ts';
import { openBrowser } from './open.ts';
import { browserSocketUrl, onBrowserKey } from './key.ts';

// Tool calls on the panel's Chrome arrive on a small watch socket that stays open while the panel is closed.
type Acted = { tool: BrowserTool; at: number };

let acted: Acted | null = null;
const subs = new Set<() => void>();
// Whether Chrome runs and why, and the agents switch, for the header icon; the panel need not be open.
type Run = { status: BrowserStatus; why: BrowserWhy | null; agents: boolean };
let run: Run = { status: 'stopped', why: null, agents: false };
let watchWs: WebSocket | null = null;

// Saved on the server, which echoes it to every page.
export function setBrowserAgents(on: boolean) {
  if (watchWs?.readyState === WebSocket.OPEN) watchWs.send(JSON.stringify({ type: 'agents', on } satisfies BrowserClientMessage));
}
const runSubs = new Set<() => void>();
// Session to the last turn that opened the panel, so closing it holds for the rest of that turn.
const OPENED_MAX = 32;
const opened = new Map<string, number>();

function onActivity(m: Extract<BrowserServerMessage, { type: 'activity' }>) {
  acted = { tool: m.tool, at: Date.now() };
  for (const fn of subs) fn();
  if (m.session !== useStore.getState().current || opened.get(m.session) === m.turn) return;
  opened.delete(m.session);
  opened.set(m.session, m.turn);
  if (opened.size > OPENED_MAX) opened.delete(opened.keys().next().value!);
  openBrowser(null);
}

let started = false;

export function watchBrowser() {
  if (started) return;
  started = true;
  let retry = 0;
  let ws: WebSocket | null = null;
  let timer = 0;
  const connect = () => {
    clearTimeout(timer);
    // Without a key yet, the main socket's hello calls back through onBrowserKey.
    const url = browserSocketUrl(true);
    if (!url) return;
    const sock = new WebSocket(url);
    ws = watchWs = sock;
    sock.onopen = () => (retry = 0);
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data) as BrowserServerMessage;
      if (m.type === 'activity') onActivity(m);
      else if (m.type === 'run') setRun({ status: m.status, why: m.why, agents: m.agents === true });
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setRun({ status: 'stopped', why: null, agents: run.agents });
      timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
    };
  };
  // A new key means a restarted server, so a pending retry goes now.
  onBrowserKey(() => {
    if (ws?.readyState === WebSocket.OPEN) return;
    const old = ws;
    ws = null;
    old?.close();
    retry = 0;
    connect();
  });
  connect();
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
export const useBrowserActivity = () => useSyncExternalStore(subscribe, () => acted);

function setRun(next: Run) {
  if (next.status === run.status && next.why === run.why && next.agents === run.agents) return;
  run = next;
  for (const fn of runSubs) fn();
}
const subscribeRun = (fn: () => void) => {
  runSubs.add(fn);
  return () => void runSubs.delete(fn);
};
export const useBrowserRun = () => useSyncExternalStore(subscribeRun, () => run);
