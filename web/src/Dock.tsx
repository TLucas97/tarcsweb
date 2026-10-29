import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { setPalette, useStore } from './store.ts';
import { openSession } from './socket.ts';
import { closeSession, isBusy, newKey, openNew, renameSession, resumeKey, resumeSession } from './actions.ts';
import { getPref, setPref, usePins, usePref } from './prefs.ts';
import { Chev, CodexTag, RenameInput, XIcon, ago, baseName, useArm, useEscape } from './bits.tsx';
import { HistIcon, SessionMenu, type MenuTarget } from './SessionMenu.tsx';
import { FolderChip, FolderIcon, TermIcon, needsYou, subLabel, termState, termTone } from './DockFolders.tsx';
import { activityOf } from './led.tsx';
import { useNarrow } from './narrow.ts';
import { heavy } from './perf.ts';
import { useLayoutVars } from './layoutVars.ts';
import { ColorDot, SessionTile } from './sessionColor.tsx';
import { TabPhone } from './Remote.tsx';
import { terminalName, useTerminal } from './terminal.ts';
import { ChunkGuard } from './Stale.tsx';
import { useSideDrag, type DockSize } from './sideDrag.ts';
import type { PastSession, SessionSummary } from '../../server/protocol.ts';

// The large sidebar's list loads on first use; hovering the rail fetches it ahead of a drag or Expand. Once fetched, lazy
// gets an already-settled thenable and renders in the same pass, since a Suspense round would hold the list back mid-slide.
type PanelModule = typeof import('./DockPanel.tsx');
let panelModule: PanelModule | null = null;
const loadPanel = () => import('./DockPanel.tsx').then((m) => (panelModule = m));
const DockPanel = lazy(() => (panelModule ? ({ then: (done: (m: PanelModule) => void) => done(panelModule!) } as unknown as Promise<PanelModule>) : loadPanel()));
const preloadPanel = () => void loadPanel().catch(() => {});

// Tabs shown before the dock's room is first measured, and the most it ever shows.
const DOCK = 3;
const DOCK_MAX = 9;
// Width a session tab needs with its name open (40px plus NAME_MIN), what the folder chip, All and New take, and the current tab with its full name.
const TAB_MIN = 96;
const FIXED = 370;
const CUR_TAB = 170;
const NAME_MAX = 128;
const NAME_MIN = 56;
// The sidebar toggle at the end of the top dock.
const TOGGLE = 34;
// Sidebar rows have a fixed height (36px plus the 2px gap), so the indicator and hover move by translateY alone.
const ROW = 38;
// All, Expand, the toggle, the separator and padding; the folder chip and New sit in the window's corners.
const RAIL_FIXED = 150;
// Closed sessions fill the dock only up to its old three-tab size.
const PAST_FILL = 3;
const SHEET_PAST = 6;
const MORPH = 420;
const STAGGER = 14;
const EASE = 'cubic-bezier(.16,1,.3,1)';
// Dwell dim: how long the pointer rests on the rail or its menus before the app behind darkens, and how dark per theme.
const DWELL_MS = 3000;
const DIM_DARK = 0.08;
const DIM_LIGHT = 0.04;
// Crossing the gap between the rail and a menu keeps the dim.
const LEAVE_MS = 150;
// Matches the .fdim fade-out, so the dock stays above the scrim until it is gone.
const UNDIM_MS = 250;

// Terminal sessions listed under the folder's tabs; the rest stay reachable through the asks band and the palette.
const TERM_MAX = 3;

// A top tab shows its state only by the robot, so screen readers get it as text.
function TabState({ x }: { x: SessionSummary }) {
  const st = needsYou(x) ? 'needs you' : x.state === 'working' ? 'working' : x.state === 'done' ? 'finished' : null;
  return st && <span className="sr">, {st}</span>;
}

// The room CSS gives the dock (an invisible box per breakpoint and mode), in 16px steps so resizing re-renders rarely.
function useRoom(ref: React.RefObject<HTMLElement | null>) {
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const w = Math.floor(e.contentRect.width / 16) * 16;
      const h = Math.floor(e.contentRect.height / 16) * 16;
      setRoom((r) => (r.w === w && r.h === h ? r : { w, h }));
    });
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, [ref]);
  return room;
}

// Where every dock item and the dock's box were before a change, for FLIP.
type ModeFlip = { items: Map<string, DOMRect>; box: DOMRect; conv: (DOMRect | null)[] };
// The rail, or the large sidebar and the rail hidden behind it.
type Roots = (HTMLElement | null)[];
const itemsOf = (roots: Roots) => roots.flatMap((r) => (r ? [...r.querySelectorAll<HTMLElement>('[data-k]')] : []));

function snapItems(roots: Roots) {
  const items = new Map<string, DOMRect>();
  const els = itemsOf(roots);
  // Rects first, mid-flight transforms included, so an interrupted morph starts where it is. A hidden copy never wins.
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width || !items.has(el.dataset.k!)) items.set(el.dataset.k!, r);
  }
  for (const el of els) for (const a of el.getAnimations()) a.cancel();
  return items;
}

// What steps aside for the rail or the large sidebar, before the mode or size flips: [moved, measured]. The title's box
// resizes around centered text at wide widths, so the session name is measured: only a real move of the text animates.
const CONV_PARTS = [['.conv .col', '.conv .col'], ['.title', '.title b'], ['.rstrip', '.rstrip'], ['.hus', '.hus'], ['.input', '.input', 'bar']] as const;
function snapConv() {
  return CONV_PARTS.map(([move, at]) => {
    const el = document.querySelector<HTMLElement>(move);
    if (el) for (const a of el.getAnimations()) if (a.id === 'dock-slide') a.cancel();
    return document.querySelector(at)?.getBoundingClientRect() ?? null;
  });
}

// Top bar to rail and back: the same elements fly to their new place, staggered; the box fades out there and in here.
function morph(roots: Roots, f: ModeFlip) {
  let i = 0;
  for (const el of itemsOf(roots)) {
    const last = el.getBoundingClientRect();
    if (!last.width) continue;
    const first = f.items.get(el.dataset.k!);
    if (!first?.width) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: MORPH / 2, fill: 'backwards' });
      continue;
    }
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: MORPH, easing: EASE, delay: i++ * STAGGER, fill: 'backwards' });
  }
  // The conversation and title start with the tabs and land with the last one.
  const total = MORPH + Math.max(0, i - 1) * STAGGER;
  CONV_PARTS.forEach(([move, at], n) => {
    const el = document.querySelector<HTMLElement>(move);
    const first = f.conv[n];
    const last = document.querySelector(at)?.getBoundingClientRect();
    if (!el || !first || !last) return;
    const dx = first.left - last.left;
    // The rest is bottom-anchored, so only the title moves vertically.
    const dy = move === '.title' ? first.top - last.top : 0;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: total, easing: EASE, id: 'dock-slide' });
  });
  for (const r of roots) {
    r?.querySelector(':scope>.dock-shell')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: MORPH - 200, fill: 'backwards' });
    r?.querySelector(':scope>.rail-ind')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: MORPH - 140, fill: 'backwards' });
  }
  const ghost = document.createElement('div');
  ghost.className = 'dock-ghost';
  Object.assign(ghost.style, { left: `${f.box.left}px`, top: `${f.box.top}px`, width: `${f.box.width}px`, height: `${f.box.height}px` });
  document.body.append(ghost);
  const a = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease', fill: 'forwards' });
  a.onfinish = a.oncancel = () => ghost.remove();
}

// One shared highlight and one tooltip card for the rail; both glide between rows once shown, and appear in place.
function useRailHover(ref: React.RefObject<HTMLElement | null>, on: boolean, setTip: (k: string | null) => void) {
  useEffect(() => {
    if (!on) return;
    const nav = ref.current!;
    const hov = nav.querySelector<HTMLElement>('.rail-hov')!;
    const tip = nav.querySelector<HTMLElement>('.rail-tip')!;
    const rafs = new Set<number>();
    const place = (el: HTMLElement, transform: string) => {
      if (el.style.opacity === '1' || heavy()) {
        el.style.transform = transform;
        el.style.opacity = '1';
        return;
      }
      el.classList.add('rsnap');
      el.style.transform = transform;
      // Two frames: the jump has to paint before the glide is switched back on.
      const a = requestAnimationFrame(() => {
        rafs.delete(a);
        const b = requestAnimationFrame(() => {
          rafs.delete(b);
          el.classList.remove('rsnap');
          el.style.opacity = '1';
        });
        rafs.add(b);
      });
      rafs.add(a);
    };
    const hideTip = () => {
      tip.style.opacity = '0';
    };
    const hide = () => {
      for (const r of rafs) cancelAnimationFrame(r);
      rafs.clear();
      hov.style.opacity = '0';
      hideTip();
    };
    const show = (it: HTMLElement | null) => {
      if (!it || it.classList.contains('dsep')) return;
      // The corner buttons sit outside the rail's box: they light up on their own and the card goes beside them.
      if (it.classList.contains('rc')) {
        hov.style.opacity = '0';
        const r = it.getBoundingClientRect();
        const n = nav.getBoundingClientRect();
        setTip(it.dataset.k!);
        return place(tip, `translate(${r.right - n.right}px, calc(${r.top + r.height / 2 - n.top}px - 50%))`);
      }
      place(hov, `translateY(${it.offsetTop}px)`);
      // The rename field pops out where the card would go.
      if (it.classList.contains('editing')) return hideTip();
      setTip(it.dataset.k!);
      place(tip, `translateY(calc(${it.offsetTop + it.offsetHeight / 2}px - 50%))`);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const t = e.target as Element;
      // The folder menu is a DOM child of the rail, so hovering it never leaves the rail; the drag edge names nothing.
      if (t.closest('.pop, .dedge')) return hide();
      const it = t.closest<HTMLElement>('[data-k]');
      if (it) show(it);
    };
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      if (t.matches(':focus-visible') && !t.closest('.pop')) show(t.closest<HTMLElement>('[data-k]'));
    };
    nav.addEventListener('pointerover', onOver);
    nav.addEventListener('pointerleave', hide);
    nav.addEventListener('pointerdown', hideTip);
    nav.addEventListener('focusin', onFocus);
    nav.addEventListener('focusout', hide);
    return () => {
      hide();
      nav.removeEventListener('pointerover', onOver);
      nav.removeEventListener('pointerleave', hide);
      nav.removeEventListener('pointerdown', hideTip);
      nav.removeEventListener('focusin', onFocus);
      nav.removeEventListener('focusout', hide);
    };
  }, [ref, on, setTip]);
}

// After the pointer rests on the dock (rail or top bar) or a menu opened from it, a scrim darkens the app; the dock is
// lifted above it and the menus sit in the top layer. One document listener covers every piece. The large sidebar is
// read in place beside the chat, so resting on it dims nothing.
function useDwellDim(ref: React.RefObject<HTMLElement | null>, dimRef: React.RefObject<HTMLElement | null>, side: boolean, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const nav = ref.current!;
    const dim = dimRef.current!;
    const area = side ? 'nav.tabs.rail, [data-dock-menu]' : 'nav.tabs, #folderPop, [data-dock-menu]';
    let wait = 0;
    let leave = 0;
    let lift = 0;
    let x = -1;
    let y = -1;
    const on = () => {
      clearTimeout(lift);
      nav.dataset.dwell = '';
      dim.style.setProperty('--dim', String(document.documentElement.dataset.theme === 'dark' ? DIM_DARK : DIM_LIGHT));
      dim.classList.add('on');
    };
    const off = () => {
      clearTimeout(wait);
      clearTimeout(leave);
      wait = leave = 0;
      if (!dim.classList.contains('on')) return;
      dim.classList.remove('on');
      lift = window.setTimeout(() => delete nav.dataset.dwell, UNDIM_MS);
    };
    const enter = () => {
      clearTimeout(leave);
      leave = 0;
      if (wait || dim.classList.contains('on')) return;
      wait = window.setTimeout(() => {
        wait = 0;
        on();
      }, DWELL_MS);
    };
    const exit = () => {
      if (leave || (!wait && !dim.classList.contains('on'))) return;
      leave = window.setTimeout(off, LEAVE_MS);
    };
    // New, alone in its corner, is a button to press, not a list to browse.
    const check = (t: Element | null) => (t?.closest(area) && !t.closest('.plus.rc') ? enter() : exit());
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      x = e.clientX;
      y = e.clientY;
    };
    const onOver = (e: PointerEvent) => e.pointerType === 'mouse' && check(e.target as Element);
    const onOut = (e: PointerEvent) => !e.relatedTarget && exit();
    // A menu that opens or closes under a still pointer fires no pointerover, so hit-test the last position.
    const onToggle = () => x >= 0 && check(document.elementFromPoint(x, y));
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerover', onOver, { passive: true });
    document.addEventListener('pointerout', onOut, { passive: true });
    document.addEventListener('toggle', onToggle, true);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('toggle', onToggle, true);
      off();
      clearTimeout(lift);
      delete nav.dataset.dwell;
    };
  }, [ref, dimRef, side, active]);
}

const ListIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M2 3.5h9M2 6.5h9M2 9.5h6" /></svg>
);
const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
);
// A window with a bar on the left (to the sidebar) or on top (back to tabs on top).
const ModeIcon = ({ side }: { side: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
    <rect x="1.5" y="2.5" width="11" height="9" rx="2" /><path d={side ? 'M1.5 5.5h11' : 'M5 2.5v9'} />
  </svg>
);
const SideChev = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={open ? 'M7.5 2.5 4 6l3.5 3.5' : 'M4.5 2.5 8 6 4.5 9.5'} />
  </svg>
);

type SheetProps = {
  open: SessionSummary[];
  past: PastSession[];
  current: string | null;
  onPick: (id: string, past: boolean) => void;
  onNew: () => void;
  onAll: () => void;
  onMenu: (e: MouseEvent<HTMLElement>, id: string, past: boolean) => void;
};

// Narrow windows: the folder's open and recent sessions in one list, opened from the current tab.
function SessionsSheet({ open, past, current, onPick, onNew, onAll, onMenu }: SheetProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.ss-row[aria-current], .ss-row')?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="ssheet" ref={ref} role="dialog" aria-label="Sessions">
      <div className="ss-top">
        <b>Sessions</b>
        <button type="button" className="ss-new" onClick={onNew}><PlusIcon />New</button>
      </div>
      <div className="ss-list">
        {open.length > 0 && <div className="ss-sec">Open</div>}
        {open.map((r) => {
          const need = r.needsYou || r.state === 'waiting';
          return (
            <button
              key={r.id} type="button" className="ss-row" aria-current={r.id === current ? 'page' : undefined} title={r.name}
              onClick={() => onPick(r.id, false)} onContextMenu={(e) => onMenu(e, r.id, false)}
            >
              <SessionTile id={r.id} state={r.state} needsYou={r.needsYou} background={r.background} />
              <span className="ss-n">{r.name}</span>
              {r.provider === 'codex' && <CodexTag />}
              <span className={`ss-st${need ? ' need' : ''}`}>{need ? 'needs you' : r.state === 'working' ? 'working' : ago(r.lastActive)}</span>
            </button>
          );
        })}
        {past.length > 0 && <div className="ss-sec">Recent</div>}
        {past.map((p) => (
          <button key={p.id} type="button" className="ss-row" title={p.name} onClick={() => onPick(p.id, true)} onContextMenu={(e) => onMenu(e, p.id, true)}>
            <span className="ss-ic"><HistIcon /></span>
            <span className="ss-n">{p.name}</span>
            {p.provider === 'codex' && <CodexTag />}
            <span className="ss-st">{ago(p.lastModified)}</span>
          </button>
        ))}
        <button type="button" className="ss-row ss-all" onClick={onAll}>
          <span className="ss-ic"><ListIcon /></span>
          <span className="ss-n">All sessions…</span>
        </button>
      </div>
    </section>
  );
}

// Hover intent: names open when the pointer slows over a session tab, never when it passes by or sits on All / New.
function useHoverIntent(ref: React.RefObject<HTMLElement | null>, off: boolean) {
  useEffect(() => {
    const dock = ref.current!;
    // The sidebar shows names by expanding on click instead.
    if (off) return void dock.classList.remove('open');
    let timer = 0;
    let last: { x: number; y: number; t: number } | null = null;
    const setOpen = (on: boolean) => dock.classList.toggle('open', on);
    const onMove = (e: PointerEvent) => {
      // Qt WebEngine repeats the last position every frame while the page repaints; only real moves restart the wait.
      if (last && e.clientX === last.x && e.clientY === last.y) return;
      const now = performance.now();
      const v = last ? Math.hypot(e.clientX - last.x, e.clientY - last.y) / Math.max(1, now - last.t) : 0;
      last = { x: e.clientX, y: e.clientY, t: now };
      if (dock.classList.contains('open') || e.pointerType !== 'mouse') return;
      clearTimeout(timer);
      if (!(e.target as Element).closest('[data-id]')) return;
      timer = window.setTimeout(() => setOpen(true), v < 0.25 ? 60 : 180);
    };
    const onLeave = () => {
      clearTimeout(timer);
      last = null;
      setOpen(false);
    };
    dock.addEventListener('pointermove', onMove);
    dock.addEventListener('pointerleave', onLeave);
    return () => {
      clearTimeout(timer);
      dock.removeEventListener('pointermove', onMove);
      dock.removeEventListener('pointerleave', onLeave);
    };
  }, [ref, off]);
}

export function Dock() {
  const roster = useStore((s) => s.roster);
  const dockOrder = useStore((s) => s.dockOrder);
  const recent = useStore((s) => s.recent);
  const current = useStore((s) => s.current);
  const past = useStore((s) => s.past);
  const picked = useStore((s) => s.folder);
  const pending = useStore((s) => s.pendingOpen);
  const groups = useStore((s) => s.groups);
  const terminal = useTerminal((s) => s.sessions);
  const curPattern = useStore((s) => activityOf(s.current ? s.maps[s.current]?.now : undefined));
  const pins = usePins();
  const ref = useRef<HTMLElement>(null);
  const roomRef = useRef<HTMLElement>(null);
  const room = useRoom(roomRef);
  // The rail's room and the New corner both sit above the composer, so both read its height.
  const roomEl = useLayoutVars(roomRef);
  const newEl = useLayoutVars();
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [armed, press] = useArm();
  const narrow = useNarrow();
  const [sheetWanted, setSheet] = useState(false);
  const sheet = narrow && sheetWanted;
  // The sidebar: narrow windows keep the top dock and have no toggle.
  const canSide = !narrow;
  const mode = usePref('dockMode');
  const side = canSide && mode === 'side';
  // The large sidebar replaces the rail and pushes the chat; while its edge moves (live) both are shown.
  const size = usePref('dockSize');
  const large = side && size === 'large';
  const [liveWanted, setLive] = useState(false);
  const live = side && liveWanted;
  const railGone = large && !live;
  const panelRef = useRef<HTMLElement>(null);
  // The size button the keyboard pressed; focus moves to its counterpart once the size settles.
  const focusTo = useRef<DockSize | null>(null);
  const drag = useSideDrag({
    rail: () => ref.current, panel: () => panelRef.current, size: () => getPref('dockSize'), live: setLive,
    commit: (to) => setPref('dockSize', to), parts: CONV_PARTS,
  });
  const flip = useRef<ModeFlip | null>(null);
  const indRef = useRef<HTMLElement>(null);
  const indFolder = useRef<string | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const dimRef = useRef<HTMLElement>(null);
  useHoverIntent(ref, side);
  useRailHover(ref, side, setTip);
  useDwellDim(ref, dimRef, side, !large);

  // The dock lists one folder: open sessions there first, then its most recent past ones.
  const folder = picked ?? roster.find((r) => r.id === current)?.cwd ?? null;
  const byId = new Map(roster.map((r) => [r.id, r]));
  const pinned = new Set(pins);
  const inDock = (r: SessionSummary) => !folder || r.cwd === folder || r.id === current;
  // Pinned tabs first, then the order each session opened in, so a tab never moves when another is picked.
  const tabs = [...pins.flatMap((id) => byId.get(id) ?? []), ...dockOrder.flatMap((id) => (pinned.has(id) ? [] : byId.get(id) ?? []))].filter(inDock);
  // Never fewer than the old three tabs, except on narrow windows where only the current one shows. The rail counts rows instead.
  const fixed = FIXED + (canSide ? TOGGLE : 0);
  const fit = side
    ? Math.max(DOCK, Math.min(DOCK_MAX, Math.floor((room.h - RAIL_FIXED) / ROW)))
    : room.w ? Math.max(narrow ? 1 : DOCK, Math.min(DOCK_MAX, 1 + Math.floor((room.w - fixed - CUR_TAB) / TAB_MIN))) : DOCK;
  // What does not fit goes to All: the current tab always stays, then pinned ones, then the most recently used.
  let shown = tabs;
  if (tabs.length > fit) {
    const used = new Map(recent.map((id, i) => [id, i]));
    const weight = (r: SessionSummary) => (r.id === current ? -2 : pinned.has(r.id) ? -1 : (used.get(r.id) ?? recent.length));
    const keep = new Set(tabs.toSorted((a, b) => weight(a) - weight(b)).slice(0, fit).map((r) => r.id));
    shown = tabs.filter((r) => keep.has(r.id));
  }
  const shownKey = shown.map((r) => r.id).join(' ');
  // With many tabs, the names that open on hover shrink so the whole dock still fits its room.
  const others = shown.length - Number(shown.some((r) => r.id === current));
  const nameMax = !side && room.w && others ? Math.max(NAME_MIN, Math.min(NAME_MAX, Math.floor((room.w - fixed - CUR_TAB) / others) - (TAB_MIN - NAME_MIN))) : NAME_MAX;
  const openIds = new Set(roster.map((r) => r.id));
  // A session running in a terminal shows as its own row, not as a past one.
  const termIds = new Set(terminal.map((t) => t.id));
  const termShown = terminal.filter((t) => !openIds.has(t.id) && (!folder || t.cwd === folder)).slice(0, TERM_MAX);
  const folderPast = folder ? past.filter((p) => p.cwd === folder && !p.archived && !openIds.has(p.id) && !termIds.has(p.id)) : [];
  const pastShown = folderPast.slice(0, Math.max(0, Math.min(fit, PAST_FILL) - shown.length));
  const hiddenNeedsYou = roster.some((r) => r.needsYou && !shown.includes(r));
  const more = folder
    ? roster.some((r) => r.cwd === folder && !shown.includes(r)) || folderPast.length > pastShown.length
    : roster.length > shown.length;

  // Opening a session hands the dock back to that session's folder.
  useEffect(() => {
    if (useStore.getState().folder) useStore.setState({ folder: null });
  }, [current]);

  // The sheet lists the whole folder; widening the window puts the full dock back, so it closes.
  const sheetRows = tabs;
  const closeSheet = (refocus = false) => {
    setSheet(false);
    if (refocus) ref.current!.querySelector<HTMLElement>('.tab[aria-current]')?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!narrow) setSheet(false);
  }, [narrow]);
  useEscape(sheet, () => closeSheet(true));
  const newSession = () => (folder ? openNew(folder) : setPalette('folder'));
  const newPending = !!folder && pending === newKey(folder);

  const pick = (id: string) => {
    if (id !== current) openSession(id);
  };

  // Expand, Collapse and a main session's sub-session count; a drag on either edge does the same with the pointer.
  const toggleSize = (to: DockSize, e: MouseEvent) => {
    preloadPanel();
    focusTo.current = e.detail === 0 ? to : null;
    drag.toggle(to);
  };
  useLayoutEffect(() => {
    if (live) {
      drag.shown();
      return;
    }
    drag.settled();
    const to = focusTo.current;
    focusTo.current = null;
    if (to) document.querySelector<HTMLElement>(to === 'large' ? '.dpanel .dp-col' : '.tabs.rail .rexp')?.focus({ preventScroll: true });
  }, [live, drag]);
  useEffect(() => {
    if (!side) drag.stop();
  }, [side, drag]);

  const toggleMode = () => {
    drag.stop();
    const nav = ref.current!;
    const panel = panelRef.current;
    if (!heavy()) flip.current = { items: snapItems([nav, panel]), box: (panel ?? nav).getBoundingClientRect(), conv: snapConv() };
    nav.classList.remove('open');
    setPref('dockMode', side ? 'top' : 'side');
  };

  useLayoutEffect(() => {
    const f = flip.current;
    flip.current = null;
    if (f) morph([ref.current, panelRef.current], f);
  }, [side]);

  // The current session's indicator: slides between rows; appears in place when the rail or its folder changes.
  const pastKey = pastShown.map((p) => p.id).join(' ');
  useLayoutEffect(() => {
    const ind = indRef.current;
    if (!ind) return;
    // Hidden behind the large sidebar it keeps an old row, so coming back it jumps.
    if (railGone) return void delete ind.dataset.ready;
    let raf = requestAnimationFrame(() => {
      const row = ref.current!.querySelector<HTMLElement>(':scope>.tab[aria-current]');
      if (!row) return void (ind.style.opacity = '0');
      const jump = !ind.dataset.ready || indFolder.current !== folder || heavy();
      indFolder.current = folder;
      ind.style.opacity = '';
      if (jump) ind.classList.add('rsnap');
      ind.style.transform = `translateY(${row.offsetTop}px)`;
      if (jump) raf = requestAnimationFrame(() => {
        ind.classList.remove('rsnap');
        ind.dataset.ready = '1';
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [side, current, shownKey, pastKey, folder, editing, more, railGone]);

  const onMenu = (e: MouseEvent<HTMLElement>, id: string, past = false) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    // At the pointer, like any context menu; a keyboard-opened menu has no pointer and uses the tab's edge. The sidebar opens it to its right.
    const box = (large && panelRef.current) || ref.current!;
    const target = side
      ? { id, left: box.getBoundingClientRect().right + 10, top: r.top, past }
      : { id, left: (e.clientX || r.left + 12) - 12, top: r.bottom + 8, past };
    // On Linux this fires on press; opening before the release would let the release light-dismiss the menu.
    if (e.buttons & 2) addEventListener('pointerup', () => setTimeout(() => setMenu(target)), { once: true });
    else setMenu(target);
  };
  // A busy tab (running turn, open ask, background agents) closes only on a second press.
  const tryClose = (id: string) => {
    if (!isBusy(id) || press(id)) closeSession(id);
  };
  // Middle-click closes, like browser tabs; mousedown is cancelled so it does not start autoscroll.
  const onAux = (e: MouseEvent, id: string) => {
    if (e.button !== 1) return;
    e.preventDefault();
    tryClose(id);
  };

  // The collapsed rail's tooltip card: a session's name, folder and state, or what a fixed item does.
  const tipRow = tip ? byId.get(tip) : undefined;
  const tipPast = tip && !tipRow ? pastShown.find((p) => p.id === tip) : undefined;
  const tipTerm = tip?.startsWith('t:') ? termShown.find((t) => `t:${t.id}` === tip) : undefined;
  const inFolder = folder ? `In ${baseName(folder)}` : undefined;
  const tipFixed: Record<string, [string, string?]> = {
    fchip: [folder ? baseName(folder) : 'Folders', 'Switch folder or session'], all: ['All sessions', inFolder], new: ['New session', inFolder],
    xp: ['Expand', 'Tab details and sub-sessions'], mode: ['Tabs on top'],
  };
  const tipText = tip ? tipFixed[tip] : undefined;
  const tone = (r: SessionSummary) => (needsYou(r) ? ' needs' : r.state === 'done' ? ' done' : '');
  // A main session's sub-sessions, open or closed; the rail shows only their count.
  const kidsOf = new Map(groups.map((g) => [g.main.id, g.children.length]));
  const kids = (r: SessionSummary) => kidsOf.get(r.id) ?? 0;
  const subs = (n: number) => `${n} sub-session${n > 1 ? 's' : ''}`;
  const tipKids = tipRow ? kids(tipRow) : 0;
  const renamed = (id: string, name: string | null) => {
    if (name) renameSession(id, name);
    setEditing(null);
  };
  // One folder chip at a time: the rail's while it shows, the large sidebar's once that has settled (both own #folderPop).
  const panelChip = large && !live;

  return (
    <>
      <i className={`dock-room${side ? ' rail' : ''}`} ref={roomEl} aria-hidden="true"></i>
      {side && (large || live) && (
        <nav className="dpanel" ref={panelRef} aria-label="Sessions">
          <i className="dock-shell s3" aria-hidden="true"><b className="m"></b><b className="l"></b><b className="r"></b></i>
          <div className="dp-head">
            {folder && panelChip && <FolderChip folder={folder} />}
            {folder && !panelChip && (
              <span className="tab fchip-tab" aria-hidden="true"><FolderIcon /><span className="fnm">{baseName(folder)}</span><Chev /></span>
            )}
            {!folder && <b className="dp-title">Sessions</b>}
          </div>
          <ChunkGuard>
            <Suspense fallback={<div className="dp-list"></div>}>
              <DockPanel
                tabs={tabs} past={folderPast} term={termShown} current={current} pending={pending} menuId={menu?.id ?? null} editing={editing} armed={armed}
                curPattern={curPattern} onPick={pick} onMenu={onMenu} onClose={tryClose} onAux={onAux} onRenamed={renamed}
              />
            </Suspense>
          </ChunkGuard>
          <div className="dp-foot">
            <button
              type="button" className="dp-new" data-k="new" aria-label={folder ? `New session in ${baseName(folder)}` : 'New session'} aria-busy={newPending || undefined}
              onClick={newSession}
            >
              {newPending ? <span className="g spin"></span> : <PlusIcon />}<span>New session</span>
            </button>
            <button
              type="button" className="dp-ib" data-k="all" aria-haspopup="dialog" aria-label={folder ? `All sessions in ${baseName(folder)}` : 'All sessions'} title="All sessions"
              onClick={() => setPalette('switch', folder)}
            ><ListIcon /></button>
            <button type="button" className="dp-ib" data-k="mode" aria-label="Show tabs on top" title="Tabs on top" onClick={toggleMode}><ModeIcon side /></button>
            <button type="button" className="dp-ib dp-col" aria-expanded="true" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={(e) => toggleSize('rail', e)}>
              <SideChev open />
            </button>
          </div>
          <i className="dedge" aria-hidden="true" onPointerDown={drag.down}></i>
        </nav>
      )}
      <nav
        className={`tabs rise${side ? ' rail' : ''}${railGone ? ' gone' : ''}`} ref={ref} aria-label="Sessions"
        style={nameMax < NAME_MAX ? ({ '--nm': `${nameMax}px` } as CSSProperties) : undefined} onPointerEnter={side ? preloadPanel : undefined}
      >
        <i className="dock-shell s3" aria-hidden="true"><b className="m"></b><b className="l"></b><b className="r"></b></i>
        {side && <i className="rail-hov" aria-hidden="true"></i>}
        {side && <i className="rail-ind s3" ref={indRef} aria-hidden="true"><b className="m"></b><b className="l"></b><b className="r"></b></i>}
        {folder && !panelChip && (
          <FolderChip folder={folder} side={side} />
        )}
        {shown.map((x) =>
          x.id === editing && !railGone ? (
            <div key={x.id} className="tab editing" data-id={x.id} data-k={x.id} aria-current={x.id === current ? 'page' : undefined}>
              <SessionTile id={x.id} state={x.state} needsYou={x.needsYou} background={x.background} pattern={x.id === current ? curPattern : undefined} />
              <RenameInput className="nm" value={x.name} onDone={(name) => renamed(x.id, name)} />
            </div>
          ) : (
            <button
              key={x.id} className="tab" data-id={x.id} data-k={x.id} aria-current={x.id === current ? 'page' : undefined} data-menu={menu?.id === x.id ? '' : undefined}
              data-arm={armed === x.id ? '' : undefined} data-pin={pinned.has(x.id) ? '' : undefined}
              aria-haspopup={narrow && x.id === current ? 'dialog' : undefined} aria-expanded={narrow && x.id === current ? sheet : undefined}
              onClick={() => (narrow && x.id === current ? setSheet(!sheet) : pick(x.id))}
              onContextMenu={(e) => onMenu(e, x.id)} onAuxClick={(e) => onAux(e, x.id)} onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            >
              <SessionTile id={x.id} state={x.state} needsYou={x.needsYou} background={x.background} pattern={x.id === current ? curPattern : undefined} />
              <span className="nm" dir="auto">{x.name}</span>
              <TabState x={x} />
              {side && kids(x) > 0 && (
                <>
                  <span className="sr">, {subs(kids(x))}</span>
                  <span
                    className="rsub" aria-hidden="true" title={`${subs(kids(x))} · Show in the large sidebar`}
                    onClick={(e) => { e.stopPropagation(); toggleSize('large', e); }}
                  >{kids(x)}</span>
                </>
              )}
              {armed === x.id && <span className="arm-tip" role="status">Stop and close? Click again</span>}
              {x.provider === 'codex' && <CodexTag />}
              {x.remote && <TabPhone state={x.remote.state} />}
              {narrow && x.id === current && (
                <svg className="dchev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 6.2 5 3.7l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
              <span
                className="tx" aria-hidden="true" title={armed === x.id ? 'Click again to stop it and close' : 'Close (alt W)'}
                onClick={(e) => { e.stopPropagation(); tryClose(x.id); }}
              ><XIcon /></span>
            </button>
          ),
        )}
        {pastShown.map((p) => (
          <button
            key={p.id} className="tab past" data-id={p.id} data-k={p.id} title={side ? undefined : p.name} data-menu={menu?.id === p.id ? '' : undefined}
            aria-busy={pending === resumeKey(p.id) || undefined} onClick={() => resumeSession(p.id)} onContextMenu={(e) => onMenu(e, p.id, true)}
          >
            {pending === resumeKey(p.id) ? <span className="g spin"></span> : <HistIcon />}
            <span className="nm" dir="auto">{p.name}</span>
            {p.provider === 'codex' && <CodexTag />}
          </button>
        ))}
        {termShown.map((t) => {
          const name = terminalName(t, past);
          const st = termState(t);
          return (
            <button
              key={`t:${t.id}`} className="tab past term" data-id={t.id} data-k={`t:${t.id}`}
              title={side ? undefined : `${name} · ${st} · Click to resume it here`} aria-busy={pending === resumeKey(t.id) || undefined}
              onClick={() => resumeSession(t.id)}
            >
              {pending === resumeKey(t.id) ? <span className="g spin"></span> : <TermIcon tone={termTone(t)} />}
              <span className="nm" dir="auto">{name}</span>
              <span className="sr">, {st}</span>
            </button>
          );
        })}
        {side && <i className="dsep" data-k="sep" aria-hidden="true"></i>}
        {more && (
          <button
            className="tab more" data-k="all" aria-haspopup="dialog" aria-label={folder ? `All sessions in ${baseName(folder)}` : 'All sessions'}
            title={folder && !side ? `All sessions in ${baseName(folder)}` : undefined} onClick={() => setPalette('switch', folder)}
          >
            <ListIcon />
            <span className="nm">All</span>
            {hiddenNeedsYou && <i className="flag"></i>}
          </button>
        )}
        <button
          className={`tab plus${side ? ' rc' : ''}`} ref={newEl} data-k="new" aria-label={folder ? `New session in ${baseName(folder)}` : 'New session'}
          title={side ? undefined : folder ? `New session in ${baseName(folder)}` : 'New session'} aria-busy={newPending || undefined} onClick={newSession}
        >
          {newPending ? <span className="g spin"></span> : <PlusIcon />}
          <span className="nm">New</span>
        </button>
        {side && (
          <button className="tab rexp" data-k="xp" aria-expanded="false" aria-label="Expand sidebar" onClick={(e) => toggleSize('large', e)}>
            <SideChev open={false} />
            <span className="nm" aria-hidden="true">Expand</span>
          </button>
        )}
        {canSide && (
          <button
            className="tab dmode" data-k="mode" aria-label={side ? 'Show tabs on top' : 'Show tabs in a sidebar'}
            title={side ? undefined : 'Show tabs in a sidebar'} onClick={toggleMode}
          >
            <ModeIcon side={side} />
            <span className="nm" aria-hidden="true">{side ? 'Tabs on top' : 'Sidebar'}</span>
          </button>
        )}
        <i className="hl"></i>
        {side && (
          <div className="rail-tip" aria-hidden="true">
            {tipRow ? (
              <>
                <div className="rt1"><span className="rtn">{tipRow.name}</span>{tipRow.id === current && <span className="rtnow">viewing</span>}</div>
                <div className="rt2">
                  <ColorDot id={tipRow.id} />{baseName(tipRow.cwd)} · <span className={`rts${tone(tipRow)}`}>{subLabel(tipRow)}</span>{tipKids > 0 && ` · ${subs(tipKids)}`}
                </div>
              </>
            ) : tipPast ? (
              <>
                <div className="rt1"><span className="rtn">{tipPast.name}</span></div>
                <div className="rt2">Closed · {ago(tipPast.lastModified)}</div>
              </>
            ) : tipTerm ? (
              <>
                <div className="rt1"><span className="rtn">{terminalName(tipTerm, past)}</span></div>
                <div className="rt2">{baseName(tipTerm.cwd)} · <span className={`rts${termTone(tipTerm)}`}>{termState(tipTerm)}</span> · click to resume here</div>
              </>
            ) : tipText ? (
              <>
                <div className="rt1">{tipText[0]}</div>
                {tipText[1] && <div className="rt2">{tipText[1]}</div>}
              </>
            ) : null}
          </div>
        )}
        {side && <i className="dedge" aria-hidden="true" onPointerDown={drag.down}></i>}
      </nav>
      <SessionMenu target={menu} onClose={() => setMenu(null)} onRename={setEditing} />
      {createPortal(<i className="fdim" ref={dimRef} aria-hidden="true"></i>, document.body)}
      {narrow && <div className={`scrim${sheet ? ' on' : ''}`} aria-hidden="true" onClick={() => closeSheet()} />}
      {sheet && (
        <SessionsSheet
          open={sheetRows} past={folderPast.slice(0, SHEET_PAST)} current={current} onMenu={onMenu}
          onPick={(id, past) => {
            closeSheet();
            if (past) resumeSession(id);
            else openSession(id);
          }}
          onNew={() => {
            closeSheet();
            newSession();
          }}
          onAll={() => {
            closeSheet();
            setPalette('switch', folder);
          }}
        />
      )}
    </>
  );
}
