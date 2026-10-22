import { create } from 'zustand';
import type { ClientMessage } from '../../server/protocol.ts';
import { useStore } from './store.ts';
import { claim, forget, loadSaved, PAGE, save, type Saved } from './outboxDb.ts';

export type SendMsg = Extract<ClientMessage, { type: 'send' }> & { id: string };
// pending: waits for the connection and goes out on its own; sent: no echo yet; failed: needs the user.
// server: the server it was meant for; a resend after a restart could land in a session that no longer exists.
export type Outgoing = {
  msg: SendMsg; at: number; state: 'pending' | 'sent' | 'failed'; server: string | null;
  why?: 'restart' | 'reload' | 'closed'; missing?: string[];
};

// Messages the server has not echoed yet, oldest first; the echo replaces each with its real row.
export const useOutbox = create<{ list: Outgoing[] }>(() => ({ list: [] }));

const CAP = 50;
const SLOW_MS = 1000;
const set = (fn: (list: Outgoing[]) => Outgoing[]) => useOutbox.setState((s) => ({ list: fn(s.list) }));

// socket.ts hands its send in, so this module never imports it (no cycle).
let wire: (msg: SendMsg) => boolean = () => false;
export const bindSender = (fn: (msg: SendMsg) => boolean) => void (wire = fn);

// The one way a message leaves a composer: saved to IndexedDB, sent now or once connected. Resolves once saved.
export function submit(msg: SendMsg) {
  const at = Date.now();
  const server = useStore.getState().serverId;
  const state = wire(msg) ? 'sent' : 'pending';
  set((list) => [...list, { msg, at, state, server } satisfies Outgoing].slice(-CAP));
  return save(msg, at, server);
}

// Echo ids seen before the saved rows were read, so those rows are not brought back.
let early: Set<string> | null = new Set();

export function echoed(id: string) {
  early?.add(id);
  const hit = useOutbox.getState().list.find((o) => o.msg.id === id);
  if (!hit) return;
  // Kept on purpose: a slow echo means the server was busy, and this is how we catch it.
  const ms = Date.now() - hit.at;
  if (hit.state === 'sent' && ms > SLOW_MS) console.warn(`[send] server echoed the message after ${ms} ms`);
  set((list) => list.filter((o) => o !== hit));
  void forget(id);
}

export const isTracking = () => early !== null || useOutbox.getState().list.length > 0;

// The socket closed: what was on its way goes out again after the reconnect.
export function connectionLost() {
  if (!useOutbox.getState().list.some((o) => o.state === 'sent')) return;
  set((list) => list.map((o) => (o.state === 'sent' ? { ...o, state: 'pending' } : o)));
}

// After hello: waiting rows for this server go out (the server drops ids it already has); rows for an earlier one fail.
export function flush(serverId: string) {
  const list = useOutbox.getState().list;
  if (!list.some((o) => o.state === 'pending')) return;
  const at = Date.now();
  set((l) => l.map((o) => {
    if (o.state !== 'pending') return o;
    if (o.server !== null && o.server !== serverId) return { ...o, state: 'failed', why: 'restart' };
    return wire(o.msg) ? { ...o, state: 'sent', at, server: serverId } : o;
  }));
}

// The server had no session for this row; false when the row is not tracked here.
export function failSend(id: string, why: 'closed') {
  if (!useOutbox.getState().list.some((o) => o.msg.id === id)) return false;
  set((list) => list.map((o) => (o.msg.id === id ? { ...o, state: 'failed', why } : o)));
  return true;
}

// "Send again" is the user's call, so it goes to whichever server answers next.
export function resend(id: string) {
  const at = Date.now();
  const server = useStore.getState().serverId;
  set((list) => list.map((o) => {
    if (o.msg.id !== id) return o;
    const { why: _why, ...rest } = o;
    return wire(o.msg) ? { ...rest, state: 'sent', at, server } : { ...rest, state: 'pending', at, server: null };
  }));
}

// The label of a row that is not on the wire; failed ones name the attachments to add again.
export function outgoingNote(o: Outgoing) {
  if (o.state === 'pending') return 'Waiting for connection';
  if (o.state !== 'failed') return null;
  const base = o.why === 'closed' ? 'This session was closed elsewhere' : o.why === 'restart' ? 'Not sent · the server restarted' : 'Not sent before the page reloaded';
  return o.missing?.length ? `${base} · re-add ${o.missing.join(', ')}` : base;
}

export function discard(id: string) {
  set((list) => list.filter((o) => o.msg.id !== id));
  void forget(id);
}

// Other open tabs answer for the rows they saved, so a reload here never takes over their in-flight messages.
const PING_MS = 300;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('cw-outbox') : null;
channel?.addEventListener('message', (e) => {
  if (Array.isArray(e.data?.who) && e.data.who.includes(PAGE)) channel.postMessage({ here: PAGE });
});

function livePages(pages: string[]) {
  const live = new Set<string>();
  if (!channel || !pages.length) return Promise.resolve(live);
  const on = (e: MessageEvent) => void (pages.includes(e.data?.here) && live.add(e.data.here));
  channel.addEventListener('message', on);
  channel.postMessage({ who: pages });
  return new Promise<Set<string>>((ok) => setTimeout(() => {
    channel.removeEventListener('message', on);
    ok(live);
  }, PING_MS));
}

// Saved rows that never got an echo come back as failed, for the user to send again or discard.
void loadSaved().then(async (rows) => {
  const live = await livePages([...new Set(rows.flatMap((r) => (r.page && r.page !== PAGE ? [r.page] : [])))]);
  const seen = early!;
  early = null;
  const { items } = useStore.getState();
  const mine = new Set(useOutbox.getState().list.map((o) => o.msg.id));
  const back: Outgoing[] = [];
  const claimed: Saved[] = [];
  for (const r of rows) {
    if (seen.has(r.id) || items[r.id]) void forget(r.id);
    else if (!mine.has(r.id) && !(r.page && live.has(r.page))) {
      back.push({ msg: r.msg, at: r.at, state: 'failed', server: r.server, why: 'reload', ...(r.missing.length ? { missing: r.missing } : {}) });
      claimed.push(r);
    }
  }
  void claim(claimed);
  if (back.length) set((list) => [...back, ...list].slice(-CAP));
});
