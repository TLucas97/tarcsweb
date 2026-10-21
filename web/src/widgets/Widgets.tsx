import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { SessionSummary } from '../../../server/protocol.ts';
import { ExpandIcon, Glyph, XIcon, baseName, reduceMotion, springEasing } from '../bits.tsx';
import { ambient, isLite } from '../perf.ts';
import { Led } from '../led.tsx';
import { useAutosize } from '../autosize.ts';
import { Robot, type RobotState } from '../robot.tsx';
import { useLayoutVars } from '../layoutVars.ts';
import { openSession, send } from '../socket.ts';
import { useStore } from '../store.ts';
import { Row } from './Rows.tsx';
import { PANEL, frame, place, removeWidget, setOpen, toFront, useWidgets, type Widget } from './state.ts';

type Size = { w: number; h: number };
type Box = Size & { x: number; y: number };
// Gap to the window edges, and how close to one a drop snaps onto it.
const M = 8;
const SNAP = 28;
const EASE = 'cubic-bezier(.23,1,.32,1)';
const SETTLE = springEasing(600);
const BUBBLE: Size = { w: 44, h: 44 };
const robotState = (s: SessionSummary): RobotState =>
  s.state === 'waiting' ? 'needs' : s.state === 'working' ? 'think' : s.background ? 'delegating' : s.state === 'done' ? 'done' : 'idle';
const OPEN_MS = 340;
const CLOSE_MS = 240;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const translate = (x: number, y: number) => `translate(${x}px,${y}px)`;

// The panel keeps its size but is pushed back inside the window; the bubble the same with its own size.
// Whole pixels only: text on a half-pixel offset renders blurred.
function panelBox(w: Widget, b: Size): Box {
  const pw = Math.round(Math.max(PANEL.minW, Math.min(w.w, b.w - 2 * M)));
  const ph = Math.round(Math.max(PANEL.minH, Math.min(w.h, b.h - 2 * M)));
  return { x: Math.round(clamp(w.x, M, b.w - pw - M)), y: Math.round(clamp(w.y, M, b.h - ph - M)), w: pw, h: ph };
}
const pillBox = (w: Widget, b: Size, p: Size): Box => ({ x: Math.round(clamp(w.x, M, b.w - p.w - M)), y: Math.round(clamp(w.y, M, b.h - p.h - M)), ...p });

// The clip that shows only the bubble's spot inside the panel.
function pillClip(panel: Box, pill: Box) {
  const top = Math.max(0, pill.y - panel.y);
  const left = Math.max(0, pill.x - panel.x);
  return `inset(${top}px ${Math.max(0, panel.w - left - pill.w)}px ${Math.max(0, panel.h - top - pill.h)}px ${left}px round ${pill.h / 2}px)`;
}
const FULL_CLIP = 'inset(0px 0px 0px 0px round 14px)';

// Past an edge the widget follows less and less, up to 60px out.
const band = (d: number) => (60 * d) / (d + 60);
const rubber = (v: number, lo: number, hi: number) => (v < lo ? lo - band(lo - v) : v > hi ? hi + band(v - hi) : v);

// hancore's spring: response is the period in seconds, damping 1 is critical. Reports when it settled.
type Spring = { v: number; t: number; vel: number };
function advance(s: Spring, dt: number, response: number, damping: number) {
  const k = ((2 * Math.PI) / response) ** 2;
  const c = (4 * Math.PI * damping) / response;
  for (let left = Math.min(Math.max(dt, 0), 0.1); left > 1e-6; left -= 1 / 240) {
    const h = Math.min(left, 1 / 240);
    s.vel += (-k * (s.v - s.t) - c * s.vel) * h;
    s.v += s.vel * h;
  }
  const done = Math.abs(s.v - s.t) < 0.001 && Math.abs(s.vel) < 0.01;
  if (done) (s.v = s.t), (s.vel = 0);
  return done;
}

type Drag = {
  pid: number; root: HTMLElement; sx: number; sy: number; ox: number; oy: number; x: number; y: number;
  lo: [number, number]; hi: [number, number]; moved: boolean; samples: { t: number; x: number; y: number }[];
};
// Every edge and corner resizes; the top and left ones move the panel too, so the opposite side stays put.
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Edge = (typeof EDGES)[number];
type Sizing = { pid: number; edge: Edge; root: HTMLElement; panel: HTMLElement; shade: HTMLElement; sx: number; sy: number; from: Box; bounds: Size; cur: Box };
const DEAD = 4;

// One per widget: moves it under the pointer, stretches the bubble along its speed and tilts the panel a little.
// The shape runs on a spring loop that sleeps once settled.
class Handle {
  drag: Drag | null = null;
  sizing: Sizing | null = null;
  kind: 'pill' | 'panel' = 'pill';
  tilt: HTMLElement | null = null;
  shape: Spring = { v: 0, t: 0, vel: 0 };
  angle = 0;
  raf = 0;
  last = 0;
  tail: Drag['samples'] = [];

  down(e: PointerEvent<HTMLElement>, kind: Handle['kind'], root: HTMLElement, box: Box, bounds: Size) {
    if (e.button !== 0 || this.drag || (e.target as Element).closest('button, textarea, a, input')) return false;
    e.currentTarget.setPointerCapture(e.pointerId);
    this.kind = kind;
    // Caught while still settling: it stays where it is on screen instead of jumping to where it was headed.
    let { x, y } = box;
    const running = root.getAnimations();
    if (running.length) {
      const m = new DOMMatrix(getComputedStyle(root).transform);
      (x = m.e), (y = m.f);
      for (const a of running) a.cancel();
      root.style.transform = translate(x, y);
    }
    this.drag = {
      pid: e.pointerId, root, sx: e.clientX, sy: e.clientY, ox: x, oy: y, x, y,
      lo: [M, M], hi: [bounds.w - box.w - M, bounds.h - box.h - M], moved: false, samples: [{ t: e.timeStamp, x, y }],
    };
    return true;
  }

  move(e: PointerEvent<HTMLElement>) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pid) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DEAD) return;
      d.moved = true;
      d.root.classList.add('drag');
    }
    d.x = rubber(d.ox + dx, d.lo[0], d.hi[0]);
    d.y = rubber(d.oy + dy, d.lo[1], d.hi[1]);
    d.root.style.transform = translate(d.x, d.y);
    d.samples.push({ t: e.timeStamp, x: d.x, y: d.y });
    if (d.samples.length > 8) d.samples.shift();
    this.wake();
  }

  // Returns where it lands (null for a tap). A flick carries it on; an edge close by pulls it in.
  up(e: PointerEvent<HTMLElement>): [number, number] | null {
    const d = this.drag;
    if (!d || e.pointerId !== d.pid) return null;
    this.drag = null;
    this.tail = d.samples;
    d.root.classList.remove('drag');
    if (!d.moved) return null;
    const [vx, vy] = e.type === 'pointercancel' ? [0, 0] : this.velocity(e.timeStamp, d.samples);
    const carry = this.kind === 'pill' ? 110 : 70;
    const land = (v: number, speed: number, lo: number, hi: number) => {
      const p = clamp(v + clamp(speed, -3, 3) * carry, lo, hi);
      return Math.round(p - lo < SNAP ? lo : hi - p < SNAP ? hi : p);
    };
    const fx = land(d.x, vx, d.lo[0], d.hi[0]);
    const fy = land(d.y, vy, d.lo[1], d.hi[1]);
    d.root.style.transform = translate(fx, fy);
    if (!reduceMotion()) d.root.animate([{ transform: translate(d.x, d.y) }, { transform: translate(fx, fy) }], { duration: SETTLE.ms, easing: SETTLE.easing });
    this.wake();
    return [fx, fy];
  }

  velocity(now: number, s: Drag['samples']): [number, number] {
    const recent = s.filter((p) => now - p.t < 90);
    if (recent.length < 2 || now - recent[recent.length - 1].t > 60) return [0, 0];
    const a = recent[0];
    const z = recent[recent.length - 1];
    const dt = Math.max(z.t - a.t, 8);
    return [(z.x - a.x) / dt, (z.y - a.y) / dt];
  }

  wake() {
    if (!this.raf && !ambient()) this.raf = requestAnimationFrame(this.tick);
  }

  tick = (now: number) => {
    this.raf = 0;
    const el = this.tilt;
    if (!el) return;
    const dt = this.last ? (now - this.last) / 1000 : 1 / 60;
    this.last = now;
    const held = !!this.drag?.moved;
    const [vx, vy] = held ? this.velocity(now, this.drag!.samples) : [0, 0];
    const speed = Math.hypot(vx, vy);
    if (this.kind === 'pill') {
      this.shape.t = held ? Math.min(speed * 0.05, 0.16) : 0;
      if (speed > 0.08) this.angle = Math.atan2(vy, vx);
    } else this.shape.t = held ? clamp(vx * 1.2, -1.6, 1.6) : 0;
    // Held it follows closely; let go it wobbles back once or twice.
    const settled = advance(this.shape, dt, 0.32, held ? 1 : 0.42);
    const s = this.shape.v;
    el.style.transform = this.kind === 'pill' ? `rotate(${this.angle}rad) scale(${1 + s},${1 - s * 0.6}) rotate(${-this.angle}rad)` : `rotate(${s}deg)`;
    if (!this.drag && settled) {
      el.style.transform = '';
      this.last = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  sizeDown(e: PointerEvent<HTMLElement>, root: HTMLElement, panel: HTMLElement, shade: HTMLElement, box: Box, bounds: Size) {
    if (e.button !== 0 || this.drag) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const edge = e.currentTarget.dataset.edge as Edge;
    this.sizing = { pid: e.pointerId, edge, root, panel, shade, sx: e.clientX, sy: e.clientY, from: box, bounds, cur: box };
    root.classList.add('sizing');
  }

  sizeMove(e: PointerEvent<HTMLElement>) {
    const r = this.sizing;
    if (!r || e.pointerId !== r.pid) return;
    const { from: f, bounds: b, edge } = r;
    const dx = Math.round(e.clientX - r.sx);
    const dy = Math.round(e.clientY - r.sy);
    let { x, y, w, h } = f;
    if (edge.includes('e')) w = clamp(f.w + dx, PANEL.minW, b.w - f.x - M);
    if (edge.includes('s')) h = clamp(f.h + dy, PANEL.minH, b.h - f.y - M);
    if (edge.includes('w')) (x = clamp(f.x + dx, M, f.x + f.w - PANEL.minW)), (w = f.x + f.w - x);
    if (edge.includes('n')) (y = clamp(f.y + dy, M, f.y + f.h - PANEL.minH)), (h = f.y + f.h - y);
    r.cur = { x, y, w, h };
    r.root.style.transform = translate(x, y);
    for (const el of [r.panel, r.shade]) (el.style.width = `${w}px`), (el.style.height = `${h}px`);
  }

  sizeUp(e: PointerEvent<HTMLElement>): Box | null {
    const r = this.sizing;
    if (!r || e.pointerId !== r.pid) return null;
    this.sizing = null;
    r.root.classList.remove('sizing');
    return r.cur;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

const OpenIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5.5 2.5h6v6M11.5 2.5 4 10M2.5 6v5.5H8" /></svg>
);
const MinIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><path d="M3.5 7h7" /></svg>
);
const SendIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 11.5V2.8M3.4 6.3 7 2.7l3.6 3.6" /></svg>
);
const DownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 2v8M2.8 6.8 6 10l3.2-3.2" /></svg>
);
const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" fill="currentColor" /></svg>
);

// The newest rows, kept at the bottom as the main conversation does: followed before paint, also when the
// view shrinks (the reply box grows, the panel resizes), and let go only when the reader scrolls up.
const Feed = memo(function Feed({ sid, working }: { sid: string; working: boolean }) {
  const order = useWidgets((s) => s.convs[sid]?.order);
  const scroller = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const intent = useRef(0);
  // Scrolled up far enough that a way back to the latest message helps.
  const [away, setAway] = useState(false);

  useLayoutEffect(() => {
    const sc = scroller.current!;
    const toEnd = () => {
      if (stick.current) sc.scrollTop = sc.scrollHeight;
    };
    toEnd();
    const ro = new ResizeObserver(toEnd);
    ro.observe(col.current!);
    ro.observe(sc);
    // Sending from this widget goes back to the bottom, even from far up.
    follow.set(sid, () => {
      stick.current = true;
      sc.scrollTop = sc.scrollHeight;
      setAway(false);
    });
    return () => {
      ro.disconnect();
      follow.delete(sid);
    };
  }, [sid]);

  const byReader = () => void (intent.current = Date.now());
  // A scroll the reader did not make (rows growing, a clamp) never lets go of the bottom.
  const onScroll = () => {
    const sc = scroller.current!;
    const gap = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    if (gap <= 24) stick.current = true;
    else if (Date.now() - intent.current < 400) stick.current = false;
    else if (stick.current) sc.scrollTop = sc.scrollHeight;
    const far = gap > sc.clientHeight * 0.6;
    if (far !== away) setAway(far);
  };
  const toLatest = () => {
    const sc = scroller.current!;
    stick.current = true;
    sc.scrollTo({ top: sc.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' });
  };

  return (
    <div className="wg-feed wg-fade">
      <div className="wg-scroll" ref={scroller} onScroll={onScroll} onWheel={byReader} onPointerDown={byReader} onTouchMove={byReader} onKeyDown={byReader}>
        <div className="wg-col" ref={col}>
          {!order ? <p className="wg-empty">Loading…</p> : !order.length ? <p className="wg-empty">No messages yet</p> : order.map((id, i) => <Row key={id} sid={sid} id={id} live={working && i === order.length - 1} />)}
          {working && <p className="wg-work"><Led size="sm" pattern="think" />Working…</p>}
        </div>
      </div>
      {away && <button type="button" className="wg-latest" onClick={toLatest}><DownIcon />Latest</button>}
    </div>
  );
});

// Unsent text survives collapsing and reopening the widget; it goes when the widget closes.
const drafts = new Map<string, string>();
// Each open feed's "back to the bottom", called on send.
const follow = new Map<string, () => void>();

function Input({ sid, working }: { sid: string; working: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [has, setHas] = useState(() => !!drafts.get(sid)?.trim());
  useAutosize(ref, has);
  const warmed = useRef(false);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const t = ref.current!;
    const text = t.value.trim();
    if (!text || !send({ type: 'send', id: crypto.randomUUID(), sessionId: sid, text })) return;
    follow.get(sid)?.();
    t.value = '';
    drafts.delete(sid);
    setHas(false);
  };
  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    const v = e.currentTarget.value;
    drafts.set(sid, v);
    setHas(!!v.trim());
    // Typing is the intent that starts the session's CLI, as in the main composer.
    if (!warmed.current) warmed.current = !!send({ type: 'warm', sessionId: sid });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    // Esc here must not stop the session on screen.
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.currentTarget.blur();
    }
  };

  return (
    <form className="wg-ft wg-fade" onSubmit={submit}>
      <textarea ref={ref} rows={1} defaultValue={drafts.get(sid) ?? ''} placeholder="Reply…" aria-label="Reply" onInput={onInput} onKeyDown={onKeyDown} />
      {working && !has ? (
        <button type="button" className="wg-send stop" title="Stop" aria-label="Stop" onClick={() => send({ type: 'interrupt', sessionId: sid })}><StopIcon /></button>
      ) : (
        <button type="submit" className="wg-send" title="Send" aria-label="Send" disabled={!has}><SendIcon /></button>
      )}
    </form>
  );
}

const close = (id: string) => {
  drafts.delete(id);
  removeWidget(id);
};

type MenuAt = { id: string; el: HTMLElement; expand: () => void };

// Right-click menu for a bubble; opens below it, or above when the composer is in the way.
function BubbleMenu({ at, onClose }: { at: MenuAt | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const pop = ref.current!;
    if (!at) {
      if (pop.matches(':popover-open')) pop.hidePopover();
      return;
    }
    if (!pop.matches(':popover-open')) pop.showPopover();
    const r = at.el.getBoundingClientRect();
    const up = r.bottom + 8 + pop.offsetHeight > innerHeight - 12;
    pop.style.left = Math.max(12, Math.min(r.left, innerWidth - pop.offsetWidth - 12)) + 'px';
    pop.style.top = (up ? r.top - 8 - pop.offsetHeight : r.bottom + 8) + 'px';
    pop.style.transformOrigin = up ? 'bottom left' : 'top left';
    pop.querySelector<HTMLElement>('.mi')?.focus({ preventScroll: true });
  }, [at]);

  useEffect(() => {
    const pop = ref.current!;
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'closed') return;
      if (document.activeElement === document.body || pop.contains(document.activeElement)) at?.el.focus({ preventScroll: true });
      onClose();
    };
    pop.addEventListener('toggle', onToggle);
    return () => pop.removeEventListener('toggle', onToggle);
  }, [at, onClose]);

  const act = (fn: () => void) => () => {
    ref.current!.hidePopover();
    fn();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...ref.current!.querySelectorAll<HTMLElement>('.mi')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  const id = at?.id ?? '';

  return (
    <div className="pop ctx wg-menu" popover="auto" ref={ref} role="menu" aria-label="Widget" onKeyDown={onKeyDown}>
      <button className="mi" role="menuitem" onClick={act(() => at?.expand())}>
        <span className="nm2"><ExpandIcon out={false} />Expand</span><small>Chat with it right here</small>
      </button>
      <button className="mi" role="menuitem" onClick={act(() => openSession(id))}>
        <span className="nm2"><OpenIcon />Open the session</span><small>The widget comes back when you leave</small>
      </button>
      <div className="sep"></div>
      <button className="mi" role="menuitem" onClick={act(() => close(id))}>
        <span className="nm2"><XIcon />Close widget</span><small>The session keeps running</small>
      </button>
    </div>
  );
}

const WidgetView = memo(function WidgetView({ w, b, z, s, onMenu }: { w: Widget; b: Size; z: number; s: SessionSummary; onMenu: (at: MenuAt) => void }) {
  const root = useRef<HTMLElement>(null);
  const tilt = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  const [h] = useState(() => new Handle());
  // Asks still open in the widget's feed; needsYou covers one older than the peek tail.
  const asks = useWidgets((x) => Math.max(x.convs[w.id]?.asks ?? 0, s.needsYou ? 1 : 0));
  // The bubble's box at the moment it opened, for the morph; a collapse in flight ignores a second one.
  const from = useRef<Box | null>(null);
  const closing = useRef(false);

  const pb = panelBox(w, b);
  const qb = pillBox(w, b, BUBBLE);
  const box = w.open ? pb : qb;
  // The name tip opens toward the side with room.
  const tipLeft = qb.x > b.w / 2;

  useEffect(() => {
    h.tilt = tilt.current;
    return () => h.stop();
  }, [h, w.open]);

  // Opening grows the panel out of the bubble's spot; the content fades in once there is room for it.
  useLayoutEffect(() => {
    const start = from.current;
    from.current = null;
    if (!w.open || !start || reduceMotion()) return;
    // Lite fades instead of morphing: clip-path animates on the main thread.
    if (isLite()) {
      for (const el of [panel.current!, shade.current!]) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
      return;
    }
    panel.current!.animate([{ clipPath: pillClip(pb, start) }, { clipPath: FULL_CLIP }], { duration: OPEN_MS, easing: EASE });
    for (const c of panel.current!.querySelectorAll<HTMLElement>('.wg-fade')) c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: OPEN_MS, easing: 'ease' });
    shade.current!.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: OPEN_MS + 80, easing: 'ease' });
    // Only on open: the panel box of that render is the morph's end.
  }, [w.open]);

  const expand = () => {
    from.current = qb;
    toFront(w.id);
    setOpen(w.id, true);
  };

  // Closing shrinks the panel back into the bubble, which then takes its place.
  const collapse = () => {
    const el = panel.current;
    if (!el || closing.current) return;
    if (reduceMotion()) return setOpen(w.id, false);
    closing.current = true;
    const to = pillBox(w, b, BUBBLE);
    const lite = isLite();
    for (const c of lite ? [] : el.querySelectorAll<HTMLElement>('.wg-fade')) c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: 'ease', fill: 'forwards' });
    shade.current!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease', fill: 'forwards' });
    const out = lite ? [{ opacity: 1 }, { opacity: 0 }] : [{ clipPath: FULL_CLIP }, { clipPath: pillClip(pb, to) }];
    el.animate(out, { duration: lite ? 120 : CLOSE_MS, easing: lite ? 'ease' : EASE, fill: 'forwards' }).finished.then(
      () => {
        closing.current = false;
        setOpen(w.id, false);
      },
      () => void (closing.current = false),
    );
  };

  const onDown = (e: PointerEvent<HTMLElement>) => h.down(e, w.open ? 'panel' : 'pill', root.current!, box, b);
  const onMove = (e: PointerEvent<HTMLElement>) => h.move(e);
  const onUp = (e: PointerEvent<HTMLElement>) => {
    const was = h.drag;
    const at = h.up(e);
    if (at) place(w.id, at[0], at[1]);
    else if (was && !was.moved && !w.open && e.type === 'pointerup') expand();
  };

  const sizeDown = (e: PointerEvent<HTMLElement>) => h.sizeDown(e, root.current!, panel.current!, shade.current!, pb, b);
  const sizeUp = (e: PointerEvent<HTMLElement>) => {
    const f = h.sizeUp(e);
    if (f) frame(w.id, f.x, f.y, f.w, f.h);
  };

  const working = s.state === 'working';
  const grab = { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };

  return (
    <section ref={root} className={`wg${w.open ? ' open' : ''}`} style={{ transform: translate(box.x, box.y), zIndex: z }} aria-label={`${s.name} widget`} onPointerDownCapture={() => toFront(w.id)}>
      <div className="wg-tilt" ref={tilt}>
        {/* Keyed, so the bubble never reuses the panel's shadow node and the animations left on it. */}
        {w.open ? (
          <Fragment key="panel">
            <div className="wg-shade" ref={shade} style={{ width: pb.w, height: pb.h }} />
            <div className="wg-panel" ref={panel} style={{ width: pb.w, height: pb.h }}>
              <header className="wg-hd wg-fade" {...grab} onDoubleClick={(e) => !(e.target as Element).closest('button') && collapse()}>
                <Glyph state={s.state} background={s.background} />
                <b className="wg-nm" title={s.name}>{s.name}</b>
                <span className="wg-dir">{baseName(s.cwd)}</span>
                <span className="wg-hb">
                  <button type="button" title="Open the session" aria-label="Open the session" onClick={() => openSession(w.id)}><OpenIcon /></button>
                  <button type="button" title="Minimize" aria-label="Minimize" onClick={collapse}><MinIcon /></button>
                  <button type="button" title="Close widget" aria-label="Close widget" onClick={() => close(w.id)}><XIcon /></button>
                </span>
              </header>
              <Feed sid={w.id} working={working} />
              <Input sid={w.id} working={working} />
            </div>
            {/* Outside the panel's clip, so they straddle the edge and leave the scrollbar free. */}
            {EDGES.map((d) => (
              <div key={d} className={`wg-rs ${d}`} data-edge={d} aria-hidden="true" onPointerDown={sizeDown} onPointerMove={(e) => h.sizeMove(e)} onPointerUp={sizeUp} onPointerCancel={sizeUp} />
            ))}
          </Fragment>
        ) : (
          <div
            key="bubble" className={`wg-bub${asks ? ' needs' : ''}${tipLeft ? ' tl' : ''}`} role="button" tabIndex={0}
            aria-label={`Open ${s.name}${asks ? `, ${asks} waiting for you` : ''}`} aria-haspopup="menu" {...grab}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), expand())}
            onContextMenu={(e) => {
              e.preventDefault();
              onMenu({ id: w.id, el: e.currentTarget, expand });
            }}
          >
            <Robot size={24} state={robotState(s)} />
            {asks > 0 && <span key={asks} className="wg-badge">{asks > 9 ? '9+' : asks}</span>}
            <span className="wg-tip">{s.name}</span>
          </div>
        )}
      </div>
    </section>
  );
});

// Above everything but the composer: the layer ends where the composer starts.
export default function Widgets() {
  const list = useWidgets((s) => s.list);
  const current = useStore((s) => s.current);
  const roster = useStore((s) => s.roster);
  const ref = useRef<HTMLDivElement>(null);
  const bind = useLayoutVars(ref);
  const [bounds, setBounds] = useState<Size | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [closeMenu] = useState(() => () => setMenu(null));

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setBounds((p) => (p && p.w === e.contentRect.width && p.h === e.contentRect.height ? p : { w: e.contentRect.width, h: e.contentRect.height })));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);

  const ranks = list.map((w) => w.z).sort((a, c) => a - c);
  return (
    <div className="wg-layer" ref={bind}>
      {bounds &&
        list.map((w) => {
          const s = w.id === current ? undefined : roster.find((r) => r.id === w.id);
          return s ? <WidgetView key={w.id} w={w} b={bounds} z={ranks.indexOf(w.z) + 1} s={s} onMenu={setMenu} /> : null;
        })}
      <BubbleMenu at={menu} onClose={closeMenu} />
    </div>
  );
}
