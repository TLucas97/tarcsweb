import { useSyncExternalStore } from 'react';
import { KEY_SEPARATOR } from '../../../server/stretch.ts';
import type { StretchSeen } from '../../../server/protocol.ts';
import { pref } from '../bits.tsx';
import type { Item } from '../store.ts';
import { replyStretches } from './compose.ts';

// Per message: the stretches open now and every one ever opened (for the note to the model). Kept across reloads.
type Entry = { open: string[]; seen: string[] };

const KEY = 'stretch';
const CAP = 300;
const EMPTY: readonly string[] = [];

let entries: Map<string, Entry> | null = null;
const subs = new Map<string, Set<() => void>>();

function load() {
  if (entries) return entries;
  const saved = pref.get<unknown>(KEY, []);
  const ok = (e: unknown): e is [string, Entry] =>
    Array.isArray(e) && typeof e[0] === 'string' && Array.isArray(e[1]?.open) && Array.isArray(e[1]?.seen);
  entries = new Map(Array.isArray(saved) ? saved.filter(ok) : []);
  return entries;
}

export const openOf = (msg: string): readonly string[] => load().get(msg)?.open ?? EMPTY;

function subscribe(msg: string | undefined, fn: () => void) {
  if (!msg) return () => {};
  const set = subs.get(msg) ?? new Set();
  set.add(fn);
  subs.set(msg, set);
  return () => {
    set.delete(fn);
    if (!set.size) subs.delete(msg);
  };
}

// The open keys of one message; the array is replaced only when that message changes.
export const useOpen = (msg?: string) => useSyncExternalStore((fn) => subscribe(msg, fn), () => (msg ? openOf(msg) : EMPTY));

// Closing a stretch closes every stretch inside it.
export function setOpen(msg: string, key: string, open: boolean) {
  const m = load();
  const e = m.get(msg) ?? { open: [], seen: [] };
  const next = open
    ? { open: e.open.includes(key) ? e.open : [...e.open, key], seen: e.seen.includes(key) ? e.seen : [...e.seen, key] }
    : { open: e.open.filter((k) => k !== key && !k.startsWith(key + KEY_SEPARATOR)), seen: e.seen };
  m.delete(msg);
  m.set(msg, next);
  while (m.size > CAP) m.delete(m.keys().next().value!);
  pref.set(KEY, [...m]);
  for (const fn of subs.get(msg) ?? []) fn();
}

// Replies already reported to the model in this tab, so a second message does not repeat the note.
const reported = new Set<string>();
const REPORTED_MAX = 500;

// What the reader opened in the replies since their last message; null when those replies had no stretch.
export function seenSince(items: Record<string, Item>, order: string[]): { seen: StretchSeen; ids: string[] } | null {
  const ids: string[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const it = items[order[i]];
    if (it?.kind === 'user') break;
    if (it?.kind === 'agent' && !reported.has(it.id)) ids.unshift(it.id);
  }
  const opened: string[] = [];
  const unopened: string[] = [];
  for (const id of ids) {
    const it = items[id];
    if (it?.kind !== 'agent') continue;
    const seen = load().get(id)?.seen ?? EMPTY;
    for (const s of replyStretches(it.text)) {
      const list = seen.includes(s.key) ? opened : unopened;
      const short = s.short.slice(0, 300);
      if (short && !list.includes(short)) list.push(short);
    }
  }
  if (!opened.length && !unopened.length) return null;
  return { seen: { opened: opened.slice(0, 50), unopened: unopened.slice(0, 50) }, ids };
}

export function markReported(ids: string[]) {
  if (reported.size > REPORTED_MAX) reported.clear();
  for (const id of ids) reported.add(id);
}
