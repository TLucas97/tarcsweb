import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { setPalette, useStore } from './store.ts';
import { openSession } from './socket.ts';
import { closeSession, isBusy, newKey, openNew, renameSession, resumeKey, resumeSession } from './actions.ts';
import { usePins } from './prefs.ts';
import { CodexTag, Glyph, RenameInput, XIcon, ago, baseName, useArm, useEscape } from './bits.tsx';
import { HistIcon, SessionMenu, type MenuTarget } from './SessionMenu.tsx';
import { FolderChip } from './DockFolders.tsx';
import { activityOf } from './led.tsx';
import { useNarrow } from './narrow.ts';
import { TabPhone } from './Remote.tsx';
import type { PastSession, SessionSummary } from '../../server/protocol.ts';

// Tabs shown before the dock's room is first measured, and the most it ever shows (Alt+1…9 reach them all).
const DOCK = 3;
const DOCK_MAX = 9;
// Width a session tab needs with its name open (40px plus NAME_MIN), what the folder chip, All and New take, and the current tab with its full name.
const TAB_MIN = 96;
const FIXED = 370;
const CUR_TAB = 170;
const NAME_MAX = 128;
const NAME_MIN = 56;
// Closed sessions fill the dock only up to its old three-tab size.
const PAST_FILL = 3;
const SHEET_PAST = 6;

// The open tabs on the dock, left to right, for Alt+1…9 and Alt+[ / Alt+].
let dockTabs: readonly string[] = [];
export const visibleTabs = () => dockTabs;

// The room CSS gives the dock at this width (an invisible box per breakpoint), in 16px steps so resizing re-renders rarely.
function useRoom(ref: React.RefObject<HTMLElement | null>) {
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setRoom(Math.floor(e.contentRect.width / 16) * 16));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, [ref]);
  return room;
}

const ListIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M2 3.5h9M2 6.5h9M2 9.5h6" /></svg>
);
const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
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
              <Glyph state={r.state} background={r.background} />
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
function useHoverIntent(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dock = ref.current!;
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
  }, [ref]);
}

export function Dock() {
  const roster = useStore((s) => s.roster);
  const dockOrder = useStore((s) => s.dockOrder);
  const recent = useStore((s) => s.recent);
  const current = useStore((s) => s.current);
  const past = useStore((s) => s.past);
  const picked = useStore((s) => s.folder);
  const pending = useStore((s) => s.pendingOpen);
  const curPattern = useStore((s) => activityOf(s.current ? s.maps[s.current]?.now : undefined));
  const pins = usePins();
  const ref = useRef<HTMLElement>(null);
  const roomRef = useRef<HTMLElement>(null);
  const room = useRoom(roomRef);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [armed, press] = useArm();
  const narrow = useNarrow();
  const [sheetWanted, setSheet] = useState(false);
  const sheet = narrow && sheetWanted;
  useHoverIntent(ref);

  // The dock lists one folder: open sessions there first, then its most recent past ones.
  const folder = picked ?? roster.find((r) => r.id === current)?.cwd ?? null;
  const byId = new Map(roster.map((r) => [r.id, r]));
  const pinned = new Set(pins);
  const inDock = (r: SessionSummary) => !folder || r.cwd === folder || r.id === current;
  // Pinned tabs first, then the order each session opened in, so a tab never moves when another is picked.
  const tabs = [...pins.flatMap((id) => byId.get(id) ?? []), ...dockOrder.flatMap((id) => (pinned.has(id) ? [] : byId.get(id) ?? []))].filter(inDock);
  // Never fewer than the old three tabs, except on narrow windows where only the current one shows.
  const fit = room ? Math.max(narrow ? 1 : DOCK, Math.min(DOCK_MAX, 1 + Math.floor((room - FIXED - CUR_TAB) / TAB_MIN))) : DOCK;
  // What does not fit goes to All: the current tab always stays, then pinned ones, then the most recently used.
  let shown = tabs;
  if (tabs.length > fit) {
    const used = new Map(recent.map((id, i) => [id, i]));
    const weight = (r: SessionSummary) => (r.id === current ? -2 : pinned.has(r.id) ? -1 : (used.get(r.id) ?? recent.length));
    const keep = new Set(tabs.toSorted((a, b) => weight(a) - weight(b)).slice(0, fit).map((r) => r.id));
    shown = tabs.filter((r) => keep.has(r.id));
  }
  const shownKey = shown.map((r) => r.id).join(' ');
  useEffect(() => {
    dockTabs = shownKey ? shownKey.split(' ') : [];
  }, [shownKey]);
  // With many tabs, the names that open on hover shrink so the whole dock still fits its room.
  const others = shown.length - Number(shown.some((r) => r.id === current));
  const nameMax = room && others ? Math.max(NAME_MIN, Math.min(NAME_MAX, Math.floor((room - FIXED - CUR_TAB) / others) - (TAB_MIN - NAME_MIN))) : NAME_MAX;
  const openIds = new Set(roster.map((r) => r.id));
  const folderPast = folder ? past.filter((p) => p.cwd === folder && !p.archived && !openIds.has(p.id)) : [];
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

  const onMenu = (e: MouseEvent<HTMLElement>, id: string, past = false) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    // At the pointer, like any context menu; a keyboard-opened menu has no pointer and uses the tab's edge.
    const target = { id, left: (e.clientX || r.left + 12) - 12, top: r.bottom + 8, past };
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

  return (
    <>
      <i className="dock-room" ref={roomRef} aria-hidden="true"></i>
      <nav className="tabs rise" ref={ref} aria-label="Sessions" style={nameMax < NAME_MAX ? ({ '--nm': `${nameMax}px` } as CSSProperties) : undefined}>
        {folder && (
          <FolderChip folder={folder} />
        )}
        {shown.map((x) =>
          x.id === editing ? (
            <div key={x.id} className="tab editing" data-id={x.id} aria-current={x.id === current ? 'page' : undefined}>
              <Glyph state={x.state} background={x.background} pattern={x.id === current ? curPattern : undefined} />
              <RenameInput className="nm" value={x.name} onDone={(name) => { if (name) renameSession(x.id, name); setEditing(null); }} />
            </div>
          ) : (
            <button
              key={x.id} className="tab" data-id={x.id} aria-current={x.id === current ? 'page' : undefined} data-menu={menu?.id === x.id ? '' : undefined}
              data-arm={armed === x.id ? '' : undefined} data-pin={pinned.has(x.id) ? '' : undefined}
              aria-haspopup={narrow && x.id === current ? 'dialog' : undefined} aria-expanded={narrow && x.id === current ? sheet : undefined}
              onClick={() => (narrow && x.id === current ? setSheet(!sheet) : pick(x.id))}
              onContextMenu={(e) => onMenu(e, x.id)} onAuxClick={(e) => onAux(e, x.id)} onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            >
              <Glyph state={x.state} background={x.background} pattern={x.id === current ? curPattern : undefined} />
              <span className="nm">{x.name}</span>
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
            key={p.id} className="tab past" data-id={p.id} title={p.name} data-menu={menu?.id === p.id ? '' : undefined}
            aria-busy={pending === resumeKey(p.id) || undefined} onClick={() => resumeSession(p.id)} onContextMenu={(e) => onMenu(e, p.id, true)}
          >
            {pending === resumeKey(p.id) ? <span className="g spin"></span> : <HistIcon />}
            <span className="nm">{p.name}</span>
            {p.provider === 'codex' && <CodexTag />}
          </button>
        ))}
        {more && (
          <button
            className="tab more" aria-haspopup="dialog" aria-label={folder ? `All sessions in ${baseName(folder)}` : 'All sessions'}
            title={folder ? `All sessions in ${baseName(folder)}` : undefined} onClick={() => setPalette('switch', folder)}
          >
            <ListIcon />
            <span className="nm">All</span>
            {hiddenNeedsYou && <i className="flag"></i>}
          </button>
        )}
        <button
          className="tab plus" aria-label={folder ? `New session in ${baseName(folder)}` : 'New session'} title={folder ? `New session in ${baseName(folder)}` : 'New session'}
          aria-busy={newPending || undefined} onClick={newSession}
        >
          {newPending ? <span className="g spin"></span> : <PlusIcon />}
          <span className="nm">New</span>
        </button>
        <i className="hl"></i>
      </nav>
      <SessionMenu target={menu} onClose={() => setMenu(null)} onRename={setEditing} />
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
