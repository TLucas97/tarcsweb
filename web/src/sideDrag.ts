import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { heavy } from './perf.ts';
import { fitTools } from './narrow.ts';

// The sidebar's two sizes as the x of its right edge: the 44px rail and the 300px large sidebar, both 6px in (styles.css).
export const RAIL_EDGE = 50;
export const LARGE_EDGE = 306;
const TRAVEL = LARGE_EDGE - RAIL_EDGE;
// Past either size the box resists and never stretches further than this.
const OVER_LARGE = 40;
const OVER_RAIL = 8;
// Less movement than this is a click on the edge, not a drag.
const SLOP = 3;
// Release velocity from the last samples, fading to zero as the pointer rests before letting go; projected over a 0.995 deceleration.
const SAMPLE_MS = 80;
const STILL_MS = 100;
const V_MAX = 3;
const PROJECT_MS = 200;
// Critically damped: a sidebar is heavy and never bounces. Toward the target it keeps the release speed up to what it can carry without overshooting.
const W = 30;

export type DockSize = 'rail' | 'large';
// What steps aside on a size change, [moved, measured, bar]; the same list Dock's mode morph uses. A bar is a full-width
// box (the composer) whose far edge stays put while its near edge moves.
export type Part = readonly [string, string] | readonly [string, string, 'bar'];
type Host = {
  rail: () => HTMLElement | null;
  panel: () => HTMLElement | null;
  size: () => DockSize;
  // Shows both surfaces while the edge moves; false once it has settled.
  live: (on: boolean) => void;
  commit: (to: DockSize) => void;
  parts: readonly Part[];
};
// A surface's box: its three-slice shell (middle and right cap) and its drag edge.
type Box = { el: HTMLElement; m: HTMLElement; r: HTMLElement; edge: HTMLElement; mw: number };
type Look = Map<HTMLElement, { transform?: string; opacity?: string }>;
type BarRun = { anims: Animation[]; undo: () => void };
type Run = { at: (t: number) => number; e1: number; t0: number; ms: number; anims: Animation[]; parts: [HTMLElement, Animation][]; bars: BarRun[] };

export const rubberBand = (x: number, d: number, c = 0.55) => (1 - 1 / ((x * c) / d + 1)) * d;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const edgeOf = (s: DockSize) => (s === 'large' ? LARGE_EDGE : RAIL_EDGE);

function box(el: HTMLElement | null): Box | null {
  const m = el?.querySelector<HTMLElement>(':scope>.dock-shell>.m');
  const r = el?.querySelector<HTMLElement>(':scope>.dock-shell>.r');
  const edge = el?.querySelector<HTMLElement>(':scope>.dedge');
  return el && m && r && edge ? { el, m, r, edge, mw: m.offsetWidth } : null;
}

// Everything the edge position decides: the large sidebar slides in like a drawer, the rail fades out within the first
// 32px and the sidebar fades in just after, so the two barely overlap; past either size only the box (never its content)
// stretches or narrows, with resistance.
function look(rail: Box | null, panel: Box | null, e: number): Look {
  const p = (e - RAIL_EDGE) / TRAVEL;
  const out: Look = new Map();
  if (panel) {
    const over = e > LARGE_EDGE ? rubberBand(e - LARGE_EDGE, OVER_LARGE) : 0;
    out.set(panel.el, { transform: `translateX(${((clamp01(p) - 1) * TRAVEL).toFixed(2)}px)`, opacity: clamp01((p - 0.04) * 7).toFixed(3) });
    out.set(panel.m, { transform: `scaleX(${((panel.mw + over) / (panel.mw || 1)).toFixed(4)})` });
    for (const el of [panel.r, panel.edge]) out.set(el, { transform: `translateX(${over.toFixed(2)}px)` });
  }
  if (rail) {
    const under = e < RAIL_EDGE ? rubberBand(RAIL_EDGE - e, OVER_RAIL) : 0;
    out.set(rail.el, { opacity: (1 - clamp01(p * 8)).toFixed(3) });
    out.set(rail.m, { transform: `scaleX(${((rail.mw - under) / (rail.mw || 1)).toFixed(4)})` });
    for (const el of [rail.r, rail.edge]) out.set(el, { transform: `translateX(${(-under).toFixed(2)}px)` });
  }
  return out;
}

function paint(l: Look) {
  for (const [el, k] of l) {
    if (k.transform !== undefined) el.style.transform = k.transform;
    if (k.opacity !== undefined) el.style.opacity = k.opacity;
  }
}

function clear(b: Box | null) {
  if (!b?.el.isConnected) return;
  for (const el of [b.el, b.m, b.r, b.edge]) {
    el.style.transform = '';
    el.style.opacity = '';
  }
}

// The edge's path from e0 to e1, carrying the release velocity (px/ms); ms is when it is within half a pixel.
function curve(e0: number, e1: number, v0: number) {
  const d0 = e0 - e1;
  let v = Math.max(-V_MAX, Math.min(V_MAX, v0)) * 1000;
  if (v * d0 < 0) v = Math.sign(v) * Math.min(Math.abs(v), W * Math.abs(d0));
  const at = (t: number) => e1 + (d0 + (v + W * d0) * t) * Math.exp(-W * t);
  let end = 0;
  for (let t = 0; t < 2; t += 1 / 240) if (Math.abs(at(t) - e1) > 0.5) end = t;
  return { at, ms: Math.ceil((end + 1 / 60) * 1000) };
}

export type BarSnapshot = { box: DOMRect; items: Map<HTMLElement, DOMRect> };
const barRuns = new WeakMap<HTMLElement, BarRun>();

// The bar's laid-out controls, toolbar and display: contents sets included; popovers and hidden controls are left out.
function barItems(el: HTMLElement) {
  const items = new Map<HTMLElement, DOMRect>();
  const walk = (parent: HTMLElement) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue;
      const display = getComputedStyle(child).display;
      if (child.classList.contains('tools') || display === 'contents') walk(child);
      else if (!child.hasAttribute('popover')) {
        const r = child.getBoundingClientRect();
        if (r.width && r.height) items.set(child, r);
      }
    }
  };
  walk(el);
  return items;
}

// Measure individual toolbar controls: right-anchored controls must not inherit the left edge's movement.
export function snapBar(el: HTMLElement): BarSnapshot {
  const box = el.getBoundingClientRect();
  if (barRuns.has(el)) {
    const inset = getComputedStyle(el).clipPath.match(/^inset\(([^)]+)\)/)?.[1].split(' round ')[0].split(' ');
    const top = inset ? Math.max(0, parseFloat(inset[0])) : 0;
    const left = inset?.[3] ? parseFloat(inset[3]) : 0;
    box.x += left;
    box.width -= left;
    box.y += top;
    box.height -= top;
  }
  const items = barItems(el);
  for (const [child, r] of items) {
    if (!(child instanceof HTMLTextAreaElement)) continue;
    const right = getComputedStyle(child).clipPath.match(/^inset\([^ ]+ ([\d.]+)px/);
    if (right) r.width = Math.max(0, r.width - Number(right[1]));
  }
  return { box, items };
}

export const stopBar = (el: HTMLElement) => barRuns.get(el)?.undo();

// Pin the box over both sizes, clip its moving edges, and FLIP each control from its own position.
export function slideBar(el: HTMLElement, first: BarSnapshot, last: DOMRect, ts: number[], rest: (k: number) => number, ms: number, easing = 'linear'): BarRun {
  stopBar(el);
  // The toolbar takes the tier of its new width before anything is measured.
  fitTools(el);
  const n = ts.length - 1;
  const u = Math.min(first.box.left, last.left);
  const cs = getComputedStyle(el);
  const saved = [el.style.left, el.style.paddingLeft, el.style.paddingTop, el.style.minHeight];
  // Rows can change with the width: a taller box opens upward, a shorter one keeps its old height above the content
  // until the clip closes over it.
  let dh = el.getBoundingClientRect().height - first.box.height;
  if (Math.abs(dh) < .5) dh = 0;
  if (dh < 0) {
    el.style.paddingTop = `${parseFloat(cs.paddingTop) - dh}px`;
    el.style.minHeight = `${first.box.height}px`;
  }
  if (last.left > u) {
    el.style.left = `${u}px`;
    el.style.paddingLeft = `${parseFloat(cs.paddingLeft) + last.left - u}px`;
  }
  const dx = first.box.left - last.left;
  const kf = (f: (k: number) => Keyframe) => ts.map((_, k) => ({ ...f(k), offset: k / n }));
  const top = (k: number) => (dh > 0 ? dh * rest(k) : -dh * (1 - rest(k))) - 1;
  // The ring and shadow overhang the box; only the moving edges are cut.
  const box = el.animate(kf((k) => ({ clipPath: `inset(${top(k).toFixed(2)}px -24px -1px ${(last.left - u + dx * rest(k)).toFixed(2)}px round ${cs.borderTopLeftRadius})` })), { duration: ms, easing, fill: 'forwards' });
  const now = barItems(el);
  const tool = (c: HTMLElement) => !!c.closest('.tools');
  // New rows, or a toolbar control that appears, goes or changes width (fold, tight), would slide controls over each
  // other; then whatever moves fades in where it lands instead.
  const retier = dh !== 0 || [...first.items.keys()].some((c) => tool(c) && !now.has(c))
    || [...now].some(([c, r]) => tool(c) && Math.abs((first.items.get(c)?.width ?? -2) - r.width) > 1);
  const kids: Animation[] = [];
  for (const [child, to] of now) {
    const from = first.items.get(child);
    const x = from ? from.left - to.left : 0;
    const y = from ? from.top - to.top : 0;
    const still = retier ? 2 : .5;
    if (from && Math.abs(x) < still && Math.abs(y) < still) continue;
    if (retier || !from) {
      kids.push(child.animate(kf((k) => ({ opacity: (1 - rest(k)).toFixed(3) })), { duration: ms, easing, fill: 'forwards' }));
      continue;
    }
    // The textarea has its final width already; trim the growing side until the box catches up.
    const trim = child instanceof HTMLTextAreaElement ? Math.max(0, to.width - from.width) : 0;
    kids.push(child.animate(kf((k) => ({
      transform: `translate(${(x * rest(k)).toFixed(2)}px,${(y * rest(k)).toFixed(2)}px)`,
      ...(trim ? { clipPath: `inset(0 ${(trim * rest(k)).toFixed(2)}px 0 0)` } : {}),
    })), { duration: ms, easing, fill: 'forwards' }));
  }
  const anims = [box, ...kids];
  const undo = () => {
    if (barRuns.get(el)?.undo !== undo) return;
    barRuns.delete(el);
    for (const a of anims) a.cancel();
    [el.style.left, el.style.paddingLeft, el.style.paddingTop, el.style.minHeight] = saved;
  };
  const run = { anims, undo };
  barRuns.set(el, run);
  return run;
}

// One sidebar edge gesture at a time: press, drag (the box follows from the first pixel), release (snap to the nearer size
// after projecting the throw) or cancel (back to where it started). A press during a settle grabs the box where it is.
class SideDrag {
  private e = RAIL_EDGE;
  private from: DockSize = 'rail';
  private off = 0;
  private x0 = 0;
  private moved = false;
  private pid = -1;
  private el: HTMLElement | null = null;
  private samples: { x: number; t: number }[] = [];
  private run: Run | null = null;
  private gen = 0;
  private queued: { to: DockSize; v: number } | null = null;
  private ready = false;
  private boxes: { rail: Box | null; panel: Box | null } | null = null;
  private pins = new Set<HTMLElement>();
  private heldBars: BarRun[] = [];

  private h: Host;
  constructor(h: Host) {
    this.h = h;
  }

  private surfaces() {
    const b = this.boxes;
    const rail = this.h.rail();
    const panel = this.h.panel();
    if (!b || b.rail?.el !== rail || b.panel?.el !== panel || !b.rail?.mw) this.boxes = { rail: box(rail), panel: box(panel) };
    return this.boxes!;
  }

  private paint() {
    const s = this.surfaces();
    paint(look(s.rail, s.panel, this.e));
  }

  // Stops a running settle where it is; the conversation keeps its place until the next release moves it.
  private halt() {
    const r = this.run;
    if (!r) return false;
    this.run = null;
    this.gen++;
    // The animations' own clock, so a slowed timeline (DevTools) still grabs the box where it is drawn.
    const now = (r.anims[0] ?? r.parts[0]?.[1])?.currentTime;
    const ms = typeof now === 'number' ? now : performance.now() - r.t0;
    this.e = ms >= r.ms ? r.e1 : r.at(ms / 1000);
    for (const [el, a] of r.parts) {
      const tf = getComputedStyle(el).transform;
      a.cancel();
      el.style.transform = tf === 'none' ? '' : tf;
      this.pins.add(el);
    }
    for (const bar of r.bars) for (const a of bar.anims) a.pause();
    this.heldBars.push(...r.bars);
    for (const a of r.anims) a.cancel();
    this.paint();
    return true;
  }

  down = (ev: ReactPointerEvent<HTMLElement>) => {
    if (ev.button !== 0 || this.pid !== -1) return;
    ev.preventDefault();
    const grabbed = this.halt() || !!this.queued;
    if (!grabbed) this.e = edgeOf(this.h.size());
    this.queued = null;
    this.from = this.h.size();
    this.off = ev.clientX - this.e;
    this.x0 = ev.clientX;
    this.samples = [{ x: ev.clientX, t: ev.timeStamp }];
    this.moved = grabbed;
    this.pid = ev.pointerId;
    const el = (this.el = ev.currentTarget);
    el.setPointerCapture(ev.pointerId);
    el.dataset.held = '';
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onCancel);
    el.addEventListener('lostpointercapture', this.onCancel);
    addEventListener('keydown', this.onKey, true);
    addEventListener('blur', this.onCancel);
  };

  private onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== this.pid) return;
    if (!this.moved) {
      if (Math.abs(ev.clientX - this.x0) < SLOP) return;
      this.moved = true;
      this.h.live(true);
    }
    this.e = ev.clientX - this.off;
    const s = this.samples;
    s.push({ x: ev.clientX, t: ev.timeStamp });
    while (s.length > 2 && ev.timeStamp - s[0].t > SAMPLE_MS) s.shift();
    this.paint();
  };

  private onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== this.pid) return;
    this.release();
    if (!this.moved) return;
    const s = this.samples;
    const a = s[0];
    const b = s[s.length - 1];
    const v = b.t === a.t ? 0 : ((b.x - a.x) / (b.t - a.t)) * Math.max(0, 1 - (ev.timeStamp - b.t) / STILL_MS);
    const land = this.e + Math.max(-V_MAX, Math.min(V_MAX, v)) * PROJECT_MS;
    this.settle(land - RAIL_EDGE < LARGE_EDGE - land ? 'rail' : 'large', v);
  };

  // Escape, a lost pointer or a window switch put the sidebar back where the drag started.
  private onCancel = () => {
    if (this.pid === -1) return;
    this.release();
    if (this.moved) this.settle(this.from, 0);
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    this.onCancel();
  };

  private release() {
    const el = this.el!;
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onCancel);
    el.removeEventListener('lostpointercapture', this.onCancel);
    removeEventListener('keydown', this.onKey, true);
    removeEventListener('blur', this.onCancel);
    if (el.hasPointerCapture(this.pid)) el.releasePointerCapture(this.pid);
    delete el.dataset.held;
    this.el = null;
    this.pid = -1;
  }

  // The buttons: the same settle as a release with no throw.
  toggle = (to: DockSize) => {
    if (this.pid !== -1) return;
    if (!this.halt() && !this.queued) this.e = edgeOf(this.h.size());
    this.from = this.h.size();
    this.h.live(true);
    this.settle(to, 0);
  };

  private settle(to: DockSize, v: number) {
    // Waits for the render that shows both surfaces; shown() resumes it.
    if (!this.ready) return void (this.queued = { to, v });
    this.queued = null;
    const s = this.surfaces();
    const parts = this.h.parts;
    const before = parts.map(([, at]) => document.querySelector(at)?.getBoundingClientRect());
    const barBefore = parts.map(([move, , bar]) => {
      const el = bar && document.querySelector<HTMLElement>(move);
      return el ? snapBar(el) : null;
    });
    for (const bar of this.heldBars) bar.undo();
    this.heldBars = [];
    for (const [move, , bar] of parts) if (bar) {
      const el = document.querySelector<HTMLElement>(move);
      if (el) stopBar(el);
    }
    for (const el of this.pins) el.style.transform = '';
    this.pins.clear();
    if (to !== this.h.size()) this.h.commit(to);
    const e0 = this.e;
    const e1 = (this.e = edgeOf(to));
    paint(look(s.rail, s.panel, e1));
    const gen = ++this.gen;
    if (heavy()) return void this.finish(gen);

    const c = curve(e0, e1, v);
    // Released right on the size: the box has nowhere to go, the conversation still eases on a resting spring.
    const still = Math.abs(e0 - e1) < 1;
    const resting = curve(1, 0, 0);
    const q = (t: number) => (still ? 1 - resting.at(t) : 1 - (c.at(t) - e1) / (e0 - e1));
    const ms = still ? resting.ms : c.ms;
    const n = Math.max(2, Math.round(ms / 16));
    const ts = Array.from({ length: n + 1 }, (_, i) => (i / n) * (ms / 1000));
    const frames = ts.map((t, i) => look(s.rail, s.panel, i === n ? e1 : c.at(t)));
    const anims: Animation[] = [];
    for (const el of frames[0].keys()) {
      const kf = frames.map((f, i) => ({ ...f.get(el), offset: i / n }));
      if (kf.every((k) => k.transform === kf[0].transform && k.opacity === kf[0].opacity)) continue;
      anims.push(el.animate(kf, { duration: ms, easing: 'linear' }));
    }
    const rest = (k: number) => (k === n ? 0 : 1 - q(ts[k]));
    const moving: [HTMLElement, Animation][] = [];
    const bars: BarRun[] = [];
    const barAnims: Animation[] = [];
    parts.forEach(([move, at, bar], i) => {
      const el = document.querySelector<HTMLElement>(move);
      const first = before[i];
      const last = document.querySelector(at)?.getBoundingClientRect();
      if (!el || !first || !last) return;
      const dx = first.left - last.left;
      const dy = move === '.title' ? first.top - last.top : 0;
      if (!bar && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      for (const a of el.getAnimations()) if (a.id === 'dock-slide') a.cancel();
      const fromBar = barBefore[i];
      if (bar && fromBar) {
        const b = slideBar(el, fromBar, last, ts, rest, ms);
        bars.push(b);
        barAnims.push(...b.anims);
        return;
      }
      const kf = ts.map((_, k) => ({ transform: `translate(${(dx * rest(k)).toFixed(2)}px,${(dy * rest(k)).toFixed(2)}px)`, offset: k / n }));
      moving.push([el, el.animate(kf, { duration: ms, easing: 'linear', id: 'dock-slide' })]);
    });
    this.run = { at: c.at, e1, t0: performance.now(), ms, anims, parts: moving, bars };
    void Promise.allSettled([...anims, ...barAnims, ...moving.map(([, a]) => a)].map((a) => a.finished)).then(() => this.finish(gen, bars));
  }

  private finish(gen: number, bars: BarRun[] = []) {
    if (gen !== this.gen) return;
    for (const bar of bars) bar.undo();
    this.run = null;
    this.h.live(false);
  }

  // Called from the layout effect of the render that shows (or hides) the second surface.
  shown = () => {
    this.ready = true;
    this.boxes = null;
    this.paint();
    const q = this.queued;
    if (q) this.settle(q.to, q.v);
  };

  settled = () => {
    this.ready = false;
    const b = this.boxes;
    this.boxes = null;
    clear(b?.rail ?? null);
    clear(b?.panel ?? null);
  };

  // Tabs moved to the top or the dock went away mid-gesture: drop everything at once.
  stop = () => {
    if (this.pid !== -1) this.release();
    this.halt();
    for (const bar of this.heldBars) bar.undo();
    this.heldBars = [];
    for (const el of this.pins) el.style.transform = '';
    this.pins.clear();
    this.queued = null;
    this.gen++;
    this.settled();
    this.h.live(false);
  };
}

export function useSideDrag(host: Host) {
  const [drag] = useState(() => new SideDrag(host));
  useEffect(() => drag.stop, [drag]);
  return drag;
}
