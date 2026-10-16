import { create } from 'zustand';
import type { ClientMessage } from '../../server/protocol.ts';

export type SendMsg = Extract<ClientMessage, { type: 'send' }> & { id: string };
// failed: the socket closed before the server echoed the message back.
export type Outgoing = { msg: SendMsg; at: number; failed: boolean };

// Sent messages the server has not echoed yet, oldest first; the echo replaces each with its real row.
export const useOutbox = create<{ list: Outgoing[] }>(() => ({ list: [] }));

const CAP = 20;
const SLOW_MS = 1000;
const set = (fn: (list: Outgoing[]) => Outgoing[]) => useOutbox.setState((s) => ({ list: fn(s.list) }));

export function track(msg: SendMsg) {
  set((list) => [...list, { msg, at: Date.now(), failed: false }].slice(-CAP));
}

export function echoed(id: string) {
  const hit = useOutbox.getState().list.find((o) => o.msg.id === id);
  if (!hit) return;
  // Kept on purpose: a slow echo means the server was busy, and this is how we catch it.
  const ms = Date.now() - hit.at;
  if (ms > SLOW_MS) console.warn(`[send] server echoed the message after ${ms} ms`);
  set((list) => list.filter((o) => o !== hit));
}

export function failSending() {
  if (!useOutbox.getState().list.some((o) => !o.failed)) return;
  set((list) => list.map((o) => (o.failed ? o : { ...o, failed: true })));
}

export function resent(id: string) {
  set((list) => list.map((o) => (o.msg.id === id ? { ...o, at: Date.now(), failed: false } : o)));
}

export function dropOutgoing(id: string) {
  set((list) => list.filter((o) => o.msg.id !== id));
}
