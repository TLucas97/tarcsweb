import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import type { SessionSummary, TerminalSession } from '../../server/protocol.ts';
import { heavy } from './perf.ts';
import { moveSession, sessionOrder, setPalette, useStore } from './store.ts';
import { openSession } from './socket.ts';
import { ownsCtrlKeys } from './appWindow.ts';
import { usePins } from './prefs.ts';
import { closeSession, isBusy, openNew, resumeSession } from './actions.ts';
import { Check, Chev, GLYPH, Glyph, ago, baseName, tilde, useArm } from './bits.tsx';
import { HistIcon } from './SessionMenu.tsx';
import { Robot } from './robot.tsx';
import { SessionTile, Swatches } from './sessionColor.tsx';
import { WidgetButton } from './widgets/WidgetButton.tsx';

// Drill in/out: the views slide this far and this long; EASE is var(--out).
const SLIDE_MS = 200;
const SHIFT = 28;
const EASE = 'cubic-bezier(.23,1,.32,1)';
// Open entrance: the first rows rise in, one after another.
const RISE_ROWS = 8;
const RISE_MS = 130;
const RISE_STEP = 12;
// The hover highlight's own height; shorter rows scale it.
const ROW_H = 36;

// var(--out) sampled per frame, so the height FLIP and its counter-scale stay exact inverses.
function outEase(p: number) {
  const b = (t: number, a: number, c: number) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * c + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    if (b(t, 0.23, 0.32) < p) lo = t;
    else hi = t;
  }
  return b((lo + hi) / 2, 1, 1);
}

function flipFrames(s0: number) {
  const outer: Keyframe[] = [];
  const inner: Keyframe[] = [];
  for (let i = 0; i <= 20; i++) {
    const s = s0 + (1 - s0) * outEase(i / 20);
    outer.push({ transform: `scaleY(${s})` });
    inner.push({ transform: `scaleY(${1 / s})` });
  }
  return [outer, inner];
}

// One highlight glides between the hovered rows by translateY; it appears in place and hides when the pointer leaves.
function useRowGlide(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const box = ref.current!;
    const hl = box.querySelector<HTMLElement>(':scope>.fhl')!;
    let raf = 0;
    const hide = () => {
      cancelAnimationFrame(raf);
      hl.style.opacity = '0';
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const t = e.target as Element;
      const it = t.closest<HTMLElement>('.fv.cur .frw') ?? t.closest<HTMLElement>('.fv.cur .fr');
      if (!it) return;
      const to = `translateY(${it.offsetTop}px) scaleY(${it.offsetHeight / ROW_H})`;
      if (hl.style.opacity === '1' || heavy()) {
        hl.style.transform = to;
        hl.style.opacity = '1';
        return;
      }
      hl.classList.add('rsnap');
      hl.style.transform = to;
      cancelAnimationFrame(raf);
      // Two frames: the jump has to paint before the glide is switched back on.
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          hl.classList.remove('rsnap');
          hl.style.opacity = '1';
        });
      });
    };
    box.addEventListener('pointerover', onOver);
    box.addEventListener('pointerleave', hide);
    return () => {
      hide();
      box.removeEventListener('pointerover', onOver);
      box.removeEventListener('pointerleave', hide);
    };
  }, [ref]);
}

// Drag reorder: a press becomes a drag after DRAG_PX; a put-back eases home in SETTLE_MS.
const DRAG_PX = 4;
const SETTLE_MS = 150;

// grab: what a press must land on; item: the element that moves (carries data-id); peers: the items it moves among.
export type RowDrag = {
  grab: string;
  item: (el: HTMLElement) => HTMLElement;
  peers: (box: HTMLElement, item: HTMLElement) => HTMLElement[];
  onDrop: (id: string, to: string, after: boolean) => void;
};

// Drags a row among its peers, rows of any height; dropping outside the box's parent puts it back.
export function useRowDrag(ref: RefObject<HTMLDivElement | null>, opts: RowDrag) {
  const drop = useEffectEvent(opts.onDrop);
  const pick = useEffectEvent((el: HTMLElement) => opts.item(el));
  const peers = useEffectEvent((box: HTMLElement, el: HTMLElement) => opts.peers(box, el));
  const grab = opts.grab;
  useEffect(() => {
    const box = ref.current!;
    let press: { row: HTMLElement; pid: number; y0: number } | null = null;
    let d: { row: HTMLElement; pid: number; y0: number; rows: HTMLElement[]; from: number; to: number; mids: number[]; half: number; min: number; max: number; step: number } | null = null;
    let settling: HTMLElement[] = [];
    let settle = 0;
    let swallow = 0;
    const reset = (rows: HTMLElement[]) => {
      for (const r of rows) {
        r.style.transform = '';
        r.classList.remove('fdrag', 'fshift', 'fout');
      }
      box.classList.remove('dragging');
    };
    const outside = (e: PointerEvent) => {
      const r = box.parentElement!.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    const start = (e: PointerEvent, row: HTMLElement, y0: number) => {
      const rows = peers(box, row);
      const from = rows.indexOf(row);
      if (rows.length < 2 || from < 0) return null;
      clearTimeout(settle);
      reset(settling);
      row.setPointerCapture(e.pointerId);
      box.classList.add('dragging');
      row.classList.add('fdrag');
      for (const r of rows) if (r !== row) r.classList.add('fshift');
      // Read once at the start: the others move by the held row's height plus the gap between rows.
      const tops = rows.map((r) => r.offsetTop);
      const hs = rows.map((r) => r.offsetHeight);
      const n = rows.length - 1;
      return {
        row, pid: e.pointerId, y0, rows, from, to: from, mids: tops.map((t, i) => t + hs[i] / 2), half: hs[from] / 2,
        min: tops[0] - tops[from], max: tops[n] + hs[n] - tops[from] - hs[from], step: hs[from] + tops[1] - tops[0] - hs[0],
      };
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType !== 'mouse') return;
      const hit = (e.target as Element).closest<HTMLElement>(grab);
      press = hit && box.contains(hit) ? { row: pick(hit), pid: e.pointerId, y0: e.clientY } : null;
    };
    const move = (e: PointerEvent) => {
      if (!d) {
        if (!press || e.pointerId !== press.pid || Math.abs(e.clientY - press.y0) < DRAG_PX) return;
        d = start(e, press.row, press.y0);
        press = null;
        if (!d) return;
      }
      if (e.pointerId !== d.pid) return;
      const { row, rows, from, step, mids } = d;
      const y = Math.max(d.min, Math.min(d.max, e.clientY - d.y0));
      row.style.transform = `translateY(${y}px)`;
      const out = outside(e);
      row.classList.toggle('fout', out);
      // The held row takes the place of the farthest peer whose middle its leading edge has passed.
      const mid = mids[from] + y;
      let to = from;
      if (!out) for (let i = 0; i < rows.length; i++) if ((i > from && mid + d.half > mids[i]) || (i < from && mid - d.half < mids[i] && to === from)) to = i;
      if (to === d.to) return;
      d.to = to;
      rows.forEach((r, i) => {
        if (r === row) return;
        const shift = i > from && i <= to ? -step : i < from && i >= to ? step : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const up = (e: PointerEvent) => {
      press = null;
      if (!d || e.pointerId !== d.pid) return;
      const { row, rows, from, to } = d;
      d = null;
      // The release still fires a click on the row; it must not open the session.
      swallow = performance.now();
      if (e.type === 'pointerup' && !outside(e) && to !== from) {
        reset(rows);
        return drop(row.dataset.id!, rows[to].dataset.id!, to > from);
      }
      row.classList.add('fshift');
      for (const r of rows) r.style.transform = '';
      settling = rows;
      settle = window.setTimeout(() => reset(rows), SETTLE_MS);
    };
    const click = (e: Event) => {
      if (performance.now() - swallow > 300) return;
      swallow = 0;
      e.preventDefault();
      e.stopPropagation();
    };
    box.addEventListener('pointerdown', down);
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
    // The menu closing mid-drag (Esc) takes the capture away without a pointerup.
    box.addEventListener('lostpointercapture', up);
    box.addEventListener('click', click, true);
    return () => {
      clearTimeout(settle);
      box.removeEventListener('pointerdown', down);
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
      box.removeEventListener('lostpointercapture', up);
      box.removeEventListener('click', click, true);
    };
  }, [ref, grab]);
}

export const FolderIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.5 1.6h5.5c.7 0 1.2.5 1.2 1.2v6.2c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" /></svg>
);

type Row = { cwd: string; here: boolean; right: React.ReactNode; needs?: boolean };

export const needsYou = (r: SessionSummary) => r.needsYou || r.state === 'waiting';
export const subLabel = (r: SessionSummary) =>
  needsYou(r) ? 'needs you' : r.state === 'working' ? 'working' : r.state === 'done' ? 'done' : r.background ? 'agents running' : ago(r.lastActive);
const subTone = (r: SessionSummary) => (needsYou(r) ? ' needs' : r.state === 'done' ? ' done' : '');

// A prompt glyph with a dot that says the terminal session's state; the rail and the large sidebar list them under the tabs.
export const TermIcon = ({ tone }: { tone: string }) => (
  <span className={`term-ic${tone}`} aria-hidden="true">
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3.4 4.6 6 2 8.6M6 9h4" /></svg>
    <i></i>
  </span>
);
export const termState = (t: TerminalSession) => (t.asks.length || t.state === 'waiting' ? 'needs you' : t.state === 'working' ? 'working' : 'in a terminal');
export const termTone = (t: TerminalSession) => (t.asks.length || t.state === 'waiting' ? ' needs' : t.state === 'working' ? ' working' : '');

// Right-click on a session row: a small colour picker, nested in the folder menu so that menu stays open.
function ColorPop({ at, onClose }: { at: { id: string; x: number; y: number } | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pop = ref.current!;
    if (!at) {
      if (pop.matches(':popover-open')) pop.hidePopover();
      return;
    }
    pop.style.left = Math.min(at.x, innerWidth - 300) + 'px';
    pop.style.top = Math.min(at.y + 8, innerHeight - 60) + 'px';
    if (!pop.matches(':popover-open')) pop.showPopover();
  }, [at]);
  useEffect(() => {
    const pop = ref.current!;
    const onToggle = (e: Event) => (e as ToggleEvent).newState === 'closed' && onClose();
    pop.addEventListener('toggle', onToggle);
    return () => pop.removeEventListener('toggle', onToggle);
  }, [onClose]);
  return (
    <div className="pop cpop" popover="auto" ref={ref}>
      {at && <Swatches id={at.id} onDone={() => ref.current!.hidePopover()} />}
    </div>
  );
}

// Folder chip with a popover: every open session (numbered, draggable), folders that have open sessions, a few recent ones, and the full picker.
// side: the dock is a left rail, so the menu opens to its right.
export function FolderChip({ folder, side = false }: { folder: string; side?: boolean }) {
  const roster = useStore((s) => s.roster);
  const dockOrder = useStore((s) => s.dockOrder);
  const pins = usePins();
  const past = useStore((s) => s.past);
  const home = useStore((s) => s.home);
  const current = useStore((s) => s.current);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // A folder opens inside the menu, so the reader picks the session (or makes one a widget) instead of jumping to its latest.
  const [into, setInto] = useState<string | null>(null);
  // The view sliding out during a drill; it stays mounted (inert) until its slide ends.
  const [leaving, setLeaving] = useState<{ v: string | null } | null>(null);
  const [colorAt, setColorAt] = useState<{ id: string; x: number; y: number } | null>(null);
  const closeColor = useCallback(() => setColorAt(null), []);
  const isSide = useEffectEvent(() => side);
  const boxRef = useRef<HTMLDivElement>(null);
  const [armed, press] = useArm();
  // Taken at the click, before the swap: the menu's visible height and the scroll to leave and to land on.
  const snap = useRef<{ h: number; from: number; to: number } | null>(null);
  const rootScroll = useRef(0);
  const flip = useRef<Animation[]>([]);
  const gen = useRef(0);
  useRowGlide(boxRef);
  // Active rows move within their group (working, or the rest); pinned ones always lead, so they stay put.
  useRowDrag(boxRef, {
    grab: '.fv.cur .fr.fact:not([data-pin])', item: (el) => el,
    peers: (box, row) => [...box.querySelectorAll<HTMLElement>(`.fv.cur .fr.fact[data-grp="${row.dataset.grp}"]:not([data-pin])`)],
    onDrop: (id, to, after) => moveSession([id], [to], after),
  });

  useEffect(() => {
    if (into) popRef.current?.querySelector<HTMLElement>('.fv.cur :is(.fr.ss, .fr.fnew)')?.focus({ preventScroll: true });
  }, [into]);

  // Runs only after a drill click (snap is set), so the layout reads here are FLIP's, not a mount read.
  useLayoutEffect(() => {
    const s = snap.current;
    snap.current = null;
    if (!s) return;
    const pop = popRef.current!;
    const box = boxRef.current!;
    const cur = box.querySelector<HTMLElement>(':scope>.fv.cur')!;
    const out = box.querySelector<HTMLElement>(':scope>.fv.out');
    const hl = box.querySelector<HTMLElement>(':scope>.fhl')!;
    hl.classList.add('rsnap');
    hl.style.opacity = '0';
    // The leaving view keeps its place on screen while the scroll jumps to the new view's spot.
    if (out) out.style.top = s.to - s.from + 'px';
    pop.scrollTop = s.to;
    if (!out) return;
    if (pop.scrollTop !== s.to) out.style.top = pop.scrollTop - s.from + 'px';

    // Interrupted mid-slide: both views start from where they are now.
    const dir = into ? 1 : -1;
    const now = (el: HTMLElement, rest: Keyframe): Keyframe => {
      if (!el.getAnimations().length) return rest;
      const cs = getComputedStyle(el);
      return { transform: cs.transform, opacity: cs.opacity };
    };
    const a = now(cur, { transform: `translateX(${dir * SHIFT}px)`, opacity: 0 });
    const b = now(out, { transform: 'none', opacity: 1 });
    for (const x of [...cur.getAnimations(), ...out.getAnimations()]) x.cancel();
    cur.animate([a, { transform: 'none', opacity: 1 }], { duration: SLIDE_MS, easing: EASE });
    const gone = out.animate([b, { transform: `translateX(${-dir * SHIFT}px)`, opacity: 0 }], { duration: SLIDE_MS, easing: EASE, fill: 'forwards' });
    const g = ++gen.current;
    gone.finished.then(() => g === gen.current && setLeaving(null), () => {});

    // Height: the menu takes its new size at once and a scaleY FLIP (content counter-scaled) eases it there.
    for (const x of flip.current) x.cancel();
    flip.current = [];
    const h = pop.offsetHeight;
    const s0 = s.h / h;
    if (!h || Math.abs(s0 - 1) < 0.02) return;
    box.style.transformOrigin = `0 ${pop.scrollTop - box.offsetTop}px`;
    const [outer, inner] = flipFrames(s0);
    flip.current = [pop.animate(outer, { duration: SLIDE_MS, easing: 'linear' }), box.animate(inner, { duration: SLIDE_MS, easing: 'linear' })];
  }, [into]);

  useEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    const onBefore = (e: Event) => {
      const on = (e as ToggleEvent).newState === 'open';
      setOpen(on);
      if (!on) {
        setInto(null);
        setLeaving(null);
        gen.current++;
        snap.current = null;
        for (const x of flip.current) x.cancel();
        flip.current = [];
        for (const v of boxRef.current?.children ?? []) for (const x of v.getAnimations()) x.cancel();
      } else if (!heavy()) {
        const rows = [...pop.querySelectorAll<HTMLElement>('.fv.cur>:is(.pg, .fr, .frw)')].slice(0, RISE_ROWS);
        rows.forEach((el, i) =>
          el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: RISE_MS, delay: i * RISE_STEP, easing: EASE, fill: 'backwards' }),
        );
      }
      const r = btnRef.current?.getBoundingClientRect();
      if (!on || !r) return;
      pop.classList.toggle('rail', isSide());
      if (isSide()) {
        const top = Math.max(12, r.top - 6);
        pop.style.left = r.right + 10 + 'px';
        pop.style.top = top + 'px';
        pop.style.maxHeight = `calc(100vh - ${top + 12}px)`;
        return;
      }
      pop.style.left = Math.max(12, r.left - 3) + 'px';
      pop.style.top = r.bottom + 11 + 'px';
      pop.style.maxHeight = '';
    };
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === 'open') pop.querySelector<HTMLElement>('.fv.cur :is(.fr.here, .fr)')?.focus({ preventScroll: true });
    };
    pop.addEventListener('beforetoggle', onBefore);
    pop.addEventListener('toggle', onToggle);
    return () => {
      pop.removeEventListener('beforetoggle', onBefore);
      pop.removeEventListener('toggle', onToggle);
    };
  }, []);

  const groups = new Map<string, typeof roster>();
  for (const r of roster) groups.set(r.cwd, [...(groups.get(r.cwd) ?? []), r]);
  const openRows: Row[] = [...groups.entries()]
    .sort((a, b) => Number(b[0] === folder) - Number(a[0] === folder) || Math.max(...b[1].map((r) => r.lastActive)) - Math.max(...a[1].map((r) => r.lastActive)))
    .map(([cwd, rs]) => {
      const here = cwd === folder;
      const needs = rs.some((r) => r.needsYou || r.state === 'waiting');
      const working = rs.some((r) => r.state === 'working');
      const background = rs.some((r) => r.background);
      const right = needs ? (
        <><Glyph state="waiting" />needs you</>
      ) : working ? (
        <><Robot size={GLYPH} state="think" />working</>
      ) : background ? (
        <><Robot size={GLYPH} state="delegating" />agents running</>
      ) : (
        <>{rs.length} open</>
      );
      return { cwd, here, right, needs };
    });

  const openIds = new Set(roster.map((r) => r.id));
  const latest = new Map<string, number>();
  for (const p of past) if (!p.archived && !openIds.has(p.id) && !groups.has(p.cwd)) latest.set(p.cwd, Math.max(latest.get(p.cwd) ?? 0, p.lastModified));
  const recentRows: Row[] = [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cwd, at]) => ({ cwd, here: cwd === folder, right: <>{ago(at)}</> }));

  const elsewhere = roster.some((r) => r.cwd !== folder && (r.needsYou || r.state === 'waiting'));
  // Work still running in another folder is easy to forget, so the chip says so too.
  const busy = !elsewhere && roster.some((r) => r.cwd !== folder && (r.state === 'working' || r.background));
  const busyMain = busy && roster.some((r) => r.cwd !== folder && r.state === 'working');
  // Finished turns nobody has looked at yet, outside the session on screen.
  const doneN = roster.filter((r) => r.id !== current && r.state === 'done' && !needsYou(r)).length;

  // Every open session in the reader's order, numbered for Ctrl/Alt+digit; those at work sit on top.
  const num = new Map(sessionOrder({ roster, dockOrder }, pins).map((id, i) => [id, i + 1]));
  const pinned = new Set(pins);
  const byNum = (a: SessionSummary, b: SessionSummary) => (num.get(a.id) ?? Infinity) - (num.get(b.id) ?? Infinity);
  const atWork = (r: SessionSummary) => !needsYou(r) && (r.state === 'working' || r.background);
  const activeWork = roster.filter(atWork).sort(byNum);
  const activeRest = roster.filter((r) => !atWork(r)).sort(byNum);
  const mod = ownsCtrlKeys() ? 'Ctrl' : 'Alt';

  const hide = () => popRef.current?.hidePopover();
  // Drill in or out; the slide and height FLIP run in the layout effect on into.
  const swap = (next: string | null) => {
    const pop = popRef.current!;
    const from = pop.scrollTop;
    if (next) rootScroll.current = from;
    const mid = flip.current.some((a) => a.playState === 'running');
    const scale = mid ? new DOMMatrix(getComputedStyle(pop).transform).d : 1;
    snap.current = { h: pop.offsetHeight * scale, from, to: next ? 0 : rootScroll.current };
    if (!heavy()) setLeaving({ v: into });
    setInto(next);
  };
  const go = (cwd: string) => swap(cwd);
  const onColor = (e: MouseEvent<HTMLElement>, id: string) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const at = { id, x: e.clientX || r.left + 24, y: e.clientY || r.bottom };
    // On Linux contextmenu fires on press; opening before the release would let it light-dismiss the picker.
    if (e.buttons & 2) addEventListener('pointerup', () => setTimeout(() => setColorAt(at)), { once: true });
    else setColorAt(at);
  };
  const pick = (id: string) => {
    hide();
    if (id !== current) openSession(id);
  };
  // Middle-click closes an open session, like its dock tab; a busy one takes a second press.
  const aux = (id: string) => ({
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (!isBusy(id) || press(id)) closeSession(id);
    },
    onMouseDown: (e: MouseEvent) => e.button === 1 && e.preventDefault(),
  });
  const sub = (r: SessionSummary, text: string) =>
    armed === r.id ? <span className="fs farm" role="status">Stop and close? Click again</span> : <span className="fs">{text}</span>;
  const back = () => {
    const was = into;
    swap(null);
    if (was) requestAnimationFrame(() => popRef.current?.querySelector<HTMLElement>(`.fv.cur .fr[data-cwd="${CSS.escape(was)}"]`)?.focus({ preventScroll: true }));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (into && (e.key === 'ArrowLeft' || e.key === 'Backspace')) {
      e.preventDefault();
      return back();
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = [...(popRef.current?.querySelectorAll<HTMLElement>('.fv.cur .fr') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  };

  const render = (r: Row) => (
    <button key={r.cwd} type="button" role="menuitem" data-cwd={r.cwd} className={`fr${r.here ? ' here' : ''}${r.needs ? ' needs' : ''}`} aria-current={r.here || undefined} onClick={() => go(r.cwd)}>
      <FolderIcon />
      <span className="fn" dir="auto">{baseName(r.cwd)}</span>
      <span className="fp">{tilde(r.cwd, home)}</span>
      <span className="fs">{r.right}</span>
      <span className="fck" aria-hidden="true">{r.here && <Check />}</span>
    </button>
  );

  // One folder's sessions; v is the folder.
  const folderView = (v: string) => {
    const vOpen = (groups.get(v) ?? []).toSorted((a, b) => b.lastActive - a.lastActive);
    const vPast = past.filter((p) => p.cwd === v && !p.archived && !openIds.has(p.id)).sort((a, b) => b.lastModified - a.lastModified);
    return (
      <>
        <button type="button" role="menuitem" className="fr fback" aria-label="Back to folders" onClick={back}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.5 3.5 5 7l3.5 3.5" /></svg>
          <span className="fn" dir="auto">{baseName(v)}</span>
          <span className="fp">{tilde(v, home)}</span>
        </button>
        {vOpen.length > 0 && <div className="pg"><span>Open sessions</span></div>}
        {vOpen.map((r) => (
          <div key={r.id} className="frw">
            <button
              type="button" role="menuitem" className={`fr ss${r.needsYou ? ' needs' : ''}`} title={r.name} aria-current={r.id === current || undefined}
              onClick={() => pick(r.id)} onContextMenu={(e) => onColor(e, r.id)} {...aux(r.id)}
            >
              <SessionTile id={r.id} state={r.state} needsYou={r.needsYou} background={r.background} />
              <span className="fn" dir="auto">{r.name}</span>
              {sub(r, r.needsYou ? 'needs you' : r.state === 'working' ? 'working' : ago(r.lastActive))}
              <span className="fck" aria-hidden="true">{r.id === current && <Check />}</span>
            </button>
            <WidgetButton id={r.id} open className="fwg" onDone={hide} />
          </div>
        ))}
        {vPast.length > 0 && <div className="pg"><span>Recent sessions</span></div>}
        {vPast.slice(0, 5).map((p) => (
          <div key={p.id} className="frw">
            <button type="button" role="menuitem" className="fr ss" title={p.name} onClick={() => { hide(); resumeSession(p.id); }}>
              <HistIcon />
              <span className="fn" dir="auto">{p.name}</span>
              <span className="fs">{ago(p.lastModified)}</span>
            </button>
            <WidgetButton id={p.id} open={false} className="fwg" onDone={hide} />
          </div>
        ))}
        <div className="sep"></div>
        <button type="button" role="menuitem" className="fr fnew" onClick={() => { hide(); openNew(v); }}>
          <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <span className="fn">New session here</span>
        </button>
        {vPast.length > 5 && (
          <button type="button" role="menuitem" className="fr fall" onClick={() => { hide(); setPalette('switch', v); }}>
            <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M2 3.5h9M2 6.5h9M2 9.5h6" /></svg>
            <span className="fn">All {vPast.length} sessions…</span>
          </button>
        )}
      </>
    );
  };

  // grp keeps a drag inside its group; the number is the session's place in the reader's order.
  const activeRow = (r: SessionSummary, grp: string) => {
    const n = num.get(r.id);
    return (
      <button
        key={r.id} type="button" role="menuitem" title={r.name} aria-current={r.id === current || undefined} data-id={r.id} data-grp={grp} data-pin={pinned.has(r.id) ? '' : undefined}
        className={`fr ss fact${subTone(r)}`} onClick={() => pick(r.id)} onContextMenu={(e) => onColor(e, r.id)} {...aux(r.id)}
      >
        <SessionTile id={r.id} state={r.state} needsYou={r.needsYou} background={r.background} />
        <span className="fn" dir="auto">{r.name}</span>
        <span className="ff">{baseName(r.cwd)}</span>
        {sub(r, r.state === 'done' && !needsYou(r) ? `done · ${ago(r.doneAt)}` : subLabel(r))}
        {n && n <= 9 ? <kbd className="fnum" title={`${mod}+${n}`}>{n}</kbd> : <span className="fnum" aria-hidden="true"></span>}
        <span className="fck" aria-hidden="true">{r.id === current && <Check />}</span>
      </button>
    );
  };

  const rootView = () => (
    <>
      {roster.length > 0 && <div className="pg"><span>Active</span></div>}
      {activeWork.map((r) => activeRow(r, 'work'))}
      {activeWork.length > 0 && activeRest.length > 0 && <div className="fgap" aria-hidden="true"><i></i></div>}
      {activeRest.map((r) => activeRow(r, 'rest'))}
      {openRows.length > 0 && <div className="pg"><span>Folders</span></div>}
      {openRows.map(render)}
      {recentRows.length > 0 && <div className="pg"><span>Recent</span></div>}
      {recentRows.map(render)}
      <div className="sep"></div>
      <button type="button" role="menuitem" className="fr fall" onClick={() => { hide(); setPalette('folder'); }}>
        <FolderIcon />
        <span className="fn">All folders…</span>
        <span className="fs"><kbd>alt N</kbd></span>
      </button>
    </>
  );

  const view = (v: string | null) => (v ? folderView(v) : rootView());
  const vkey = (v: string | null) => (v ? `in:${v}` : 'root');

  return (
    <>
      <button
        type="button" ref={btnRef} className={`tab fchip-tab${side ? ' rc' : ''}`} popoverTarget="folderPop" aria-haspopup="menu" aria-expanded={open}
        data-open={open ? '' : undefined} data-k="fchip" title={side ? undefined : tilde(folder, home)}
      >
        <FolderIcon /><span className="fnm">{baseName(folder)}</span><Chev />
        {(elsewhere || busy) && (
          <span className="fled" role="img" aria-label={elsewhere ? 'Another folder needs you' : 'Work is running in another folder'}>
            <Robot size={GLYPH} state={elsewhere ? 'needs' : busyMain ? 'think' : 'delegating'} />
          </span>
        )}
        {doneN > 0 && (
          <span className="fdn" role="img" aria-label={`${doneN} ${doneN > 1 ? 'sessions' : 'session'} finished`}>
            <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.2 5.2 4.2 7.2 7.8 3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {doneN}
          </span>
        )}
      </button>
      <div className="pop fpop" id="folderPop" popover="auto" ref={popRef} role="menu" aria-label={into ? `Sessions in ${baseName(into)}` : 'Folders'} onKeyDown={onKeyDown}>
        <div className="fvs" ref={boxRef}>
          <i className="fhl" aria-hidden="true"></i>
          {leaving && leaving.v !== into && (
            <div key={vkey(leaving.v)} className="fv out" inert>
              {view(leaving.v)}
            </div>
          )}
          <div key={vkey(into)} className="fv cur">
            {view(into)}
          </div>
        </div>
        <ColorPop at={colorAt} onClose={closeColor} />
      </div>
    </>
  );
}
