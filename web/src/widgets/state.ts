import { create } from 'zustand';
import type { SessionSummary } from '../../../server/protocol.ts';
import { pref } from '../bits.tsx';
import { onPeek, onWidgetOpened, send } from '../socket.ts';
import { foldConv, useStore, type Conv } from '../store.ts';

// A session widget: a small live chat with another session, floating over this window.
// x, y place the bubble; the open panel sits there too, pushed back inside the window when it would spill.
// z orders them (highest on top) without moving DOM nodes, so a focused input keeps its focus.
export type Widget = { id: string; x: number; y: number; w: number; h: number; open: boolean; z: number };
export const WIDGET_MAX = 3;
export const PANEL = { w: 380, h: 460, minW: 300, minH: 240 };
// Rows a widget keeps; older ones are dropped, the full session still has them.
const CONV_MAX = 160;

type WState = { list: Widget[]; convs: Record<string, Conv> };

export const useWidgets = create<WState>(() => ({ list: pref.get<Widget[]>('widgets', []).slice(0, WIDGET_MAX), convs: {} }));

function trim(c: Conv): Conv {
  if (c.order.length <= CONV_MAX) return c;
  const cut = c.order.length - CONV_MAX;
  const items = { ...c.items };
  for (const k of c.order.slice(0, cut)) {
    const it = items[k];
    if (it?.kind === 'group') for (const t of it.tools) delete items[t];
    delete items[k];
  }
  return { ...c, order: c.order.slice(cut), items };
}

onPeek((m) =>
  useWidgets.setState((s) => {
    const w = s.list.find((x) => x.id === m.sessionId);
    if (!w) return s;
    return { convs: { ...s.convs, [m.sessionId]: trim(foldConv(s.convs[m.sessionId] ?? null, m.events, m.replace)) } };
  }),
);

const patch = (id: string, p: Partial<Widget>) => useWidgets.setState((s) => ({ list: s.list.map((w) => (w.id === id ? { ...w, ...p } : w)) }));

export function addWidget(id: string) {
  const { list } = useWidgets.getState();
  if (list.length >= WIDGET_MAX || list.some((w) => w.id === id)) return;
  // New ones line up down the right side, under the agents panel's top edge.
  const x = Math.max(12, innerWidth - PANEL.w - 24 - list.length * 28);
  const y = 64 + list.length * 28;
  useWidgets.setState({ list: [...list, { id, x, y, w: PANEL.w, h: PANEL.h, open: true, z: topZ(list) + 1 }] });
}

const topZ = (list: Widget[]) => list.reduce((m, w) => Math.max(m, w.z ?? 0), 0);

// A closed session is resumed first; the server's answer then adds the widget without switching to it.
export function widgetFor(id: string, open: boolean) {
  const { list } = useWidgets.getState();
  if (list.length >= WIDGET_MAX || list.some((w) => w.id === id)) return;
  if (open) addWidget(id);
  else send({ type: 'resume', id, widget: true });
}
onWidgetOpened(addWidget);

export function removeWidget(id: string) {
  useWidgets.setState((s) => {
    const { [id]: _, ...convs } = s.convs;
    return { list: s.list.filter((w) => w.id !== id), convs };
  });
}

export function setOpen(id: string, open: boolean) {
  patch(id, { open });
}
export const place = (id: string, x: number, y: number) => patch(id, { x: Math.round(x), y: Math.round(y) });
export const frame = (id: string, x: number, y: number, w: number, h: number) => patch(id, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });

export function toFront(id: string) {
  const { list } = useWidgets.getState();
  const top = topZ(list);
  const w = list.find((x) => x.id === id);
  if (w && (w.z !== top || list.filter((x) => x.z === top).length > 1)) patch(id, { z: top + 1 });
}

// The server streams every widget whose session is not already on screen; a bubble needs it for its badge.
let sent = '';
function syncPeek() {
  const { connected, current, roster } = useStore.getState();
  if (!connected) return void (sent = '');
  const ids = useWidgets.getState().list.filter((w) => w.id !== current && roster.some((r) => r.id === w.id)).map((w) => w.id);
  const key = ids.join(',');
  if (key !== sent && send({ type: 'peek', ids })) sent = key;
}

// A session that closed takes its widget with it. The roster arrives before hello, so a fresh connection has
// the whole list; after that only a session seen and then gone counts, since a resumed one may not be listed yet.
const seen = new Set<string>();
function prune(roster: SessionSummary[], fresh: boolean) {
  for (const w of useWidgets.getState().list) {
    const there = roster.some((r) => r.id === w.id);
    if (there) seen.add(w.id);
    else if (fresh || seen.has(w.id)) seen.delete(w.id), removeWidget(w.id);
  }
}

useStore.subscribe((s, p) => {
  if (s.connected && (s.roster !== p.roster || !p.connected)) prune(s.roster, !p.connected);
  if (s.connected !== p.connected || s.current !== p.current || s.roster !== p.roster) syncPeek();
});

useWidgets.subscribe((s, p) => {
  if (s.list === p.list) return;
  pref.set('widgets', s.list);
  syncPeek();
});
