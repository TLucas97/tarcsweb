import { cutEl, cutRegion, moveEl, share } from './cut.ts';
import { toJSON } from './elements.ts';
import { bboxOf, intersects, PolyMask, round2, shift, union } from './geom.ts';
import { newId } from './pencil.ts';
import { drawEl } from './render.ts';
import { framePoly, handles, hitTest, isLine, isShape, resizeShape, type Handle } from './shapes.ts';
import { useBoard } from './store.ts';
import { summarize } from './style.ts';
import type { Cursor, Tool, ToolHost } from './tool.ts';
import type { Box, El, Pt, Shape } from './types.ts';

// Lasso samples closer than this many CSS px add nothing.
const MIN_STEP = 2;
// A drag smaller than this (CSS px) is a click: it selects the element under it, or clears the selection.
const MIN_EXTENT = 4;
const PASTE_OFFSET = 24;
const DASH = [5, 4];
// In CSS px: click tolerance, gap between a picked element and its frame, handle size and reach, smallest resize.
const HIT_TOL = 6;
const FRAME_PAD = 6;
const HANDLE = 8;
const HANDLE_REACH = 7;
const MIN_SIZE = 8;
// A marquee selects an element when more than this share of it is inside.
const MARQUEE_SHARE = 0.5;
// The board's own system clipboard format; other apps ignore it, so Ctrl+V there pastes nothing odd.
const CLIP_TYPE = 'web application/x-tarcs-board';

// What a lasso covers, readable as data (later slices send it to a model and replace what is inside).
// `touched` are the scene elements it covers or crosses; replacing them with `outside` plus new elements
// swaps exactly the region's content.
export type Region = {
  poly: readonly number[];
  bbox: Box;
  ids: string[];
  touched: readonly El[];
  inside: readonly El[];
  outside: readonly El[];
  // Set for a clicked selection: the region is just these elements, not everything under its frame.
  only?: readonly string[];
};

// `picks` is set when whole elements were picked (a click, the select tool); the mask is then their frame.
type Sel = { mask: PolyMask; touched: El[]; inside: El[]; outside: El[]; picks?: El[] };

// Survives closing the board, like the drawing.
let clip: { els: El[]; poly: number[] } | null = null;
// The board copy is newer than the system clipboard: writing our format there failed, so an older picture may sit there.
let fresh = false;

// True while a paste should take the board copy even if the system clipboard holds a picture.
export const boardCopyNewer = () => fresh;

// Whether the system clipboard holds the board's format; null when it cannot be read without a permission prompt.
export async function clipboardHoldsBoard(): Promise<boolean | null> {
  try {
    const p = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
    if (p.state !== 'granted') return null;
    return (await navigator.clipboard.read()).some((it) => it.types.includes(CLIP_TYPE));
  } catch {
    return null;
  }
}

// Another app may have copied since, so the system clipboard counts again.
export function clipboardLeft() {
  fresh = false;
}

const byZ = (a: El, b: El) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The resize cursor closest to a handle's direction from the shape's center.
function cursorFor(el: Shape, h: Handle): Cursor {
  const c = isLine(el) && !el.pts ? (h.i ? { x: el.x1, y: el.y1 } : { x: el.x2, y: el.y2 }) : { x: (el.bbox.x0 + el.bbox.x1) / 2, y: (el.bbox.y0 + el.bbox.y1) / 2 };
  const a = ((Math.atan2(h.y - c.y, h.x - c.x) * 180) / Math.PI + 202.5) % 180;
  return a < 45 ? 'ew' : a < 90 ? 'nwse' : a < 135 ? 'ns' : 'nesw';
}

function boxOf(els: readonly El[]): Box | null {
  let b: Box | null = null;
  for (const el of els) b = b ? union(b, el.bbox) : el.bbox;
  return b;
}

const movePoly = (poly: readonly number[], dx: number, dy: number) => poly.map((v, i) => round2(v + (i & 1 ? dy : dx)));
const rectPoly = (b: Box) => [b.x0, b.y0, b.x1, b.y0, b.x1, b.y1, b.x0, b.y1];

// Replaces the system clipboard with the board's format, so a later Ctrl+V pastes this copy, not an older picture.
function claim(json: string | null) {
  fresh = true;
  const Item = globalThis.ClipboardItem;
  if (json === null || !Item || !navigator.clipboard?.write) return;
  const write = navigator.clipboard.write([new Item({ [CLIP_TYPE]: new Blob([json], { type: CLIP_TYPE.slice(4) }) })]);
  write.then(() => void (fresh = false), () => {});
}

// Region selection. The lasso draws a free-form region; the selection is a view until acted on: moving or deleting
// cuts strokes at the edge. The select tool ('select') picks whole elements by click, Shift+click or marquee.
export class Lasso implements Tool {
  readonly id: 'lasso' | 'select';
  private host: ToolHost;
  private mode: 'idle' | 'draw' | 'move' | 'resize' = 'idle';
  private sel: Sel | null = null;
  // The resize gesture: which handle, the shape as it was, and as it is now in the scene.
  private grip: { i: number; from: Shape; cur: Shape } | null = null;
  // Selection before a new lasso started, restored if Escape cancels it.
  private prev: Sel | null = null;
  // Lasso points, or the marquee's start and current corner.
  private pts: number[] = [];
  // Shift held at press: Shift+marquee adds to the picks.
  private adding = false;
  // The element a select-tool press landed on; a click without a drag narrows a multi-selection to it.
  private hit: El | null = null;
  private from: Pt = { x: 0, y: 0 };
  private dx = 0;
  private dy = 0;
  private lifted = false;
  // The selection as a bitmap while it moves, so a move frame costs one drawImage.
  private snap: { cv: OffscreenCanvas; x: number; y: number; s: number; outlined: boolean } | null = null;

  constructor(host: ToolHost, id: 'lasso' | 'select' = 'lasso') {
    this.host = host;
    this.id = id;
  }

  get busy() {
    return this.mode !== 'idle';
  }

  get canPaste() {
    return !!clip;
  }

  private get marquee() {
    return this.id === 'select';
  }

  down(p: Pt, e?: PointerEvent) {
    const h = this.handleAt(p);
    if (h) {
      const el = this.single()!;
      this.mode = 'resize';
      this.grip = { i: h.i, from: el, cur: el };
      return;
    }
    if (this.marquee) return this.pick(p, !!e?.shiftKey);
    if (this.sel?.inside.length && this.sel.mask.inside(p.x, p.y)) return this.startMove(p);
    this.prev = this.sel;
    this.setSel(null);
    this.mode = 'draw';
    this.pts = [p.x, p.y];
    this.host.paintLive(true);
  }

  move(list: readonly Pt[]) {
    if (this.mode === 'draw' && this.marquee) {
      const p = list[list.length - 1];
      if (!p) return;
      this.pts = [this.pts[0], this.pts[1], p.x, p.y];
      this.host.paintLive(true);
    } else if (this.mode === 'draw') {
      const min = MIN_STEP / this.host.cam.z, pts = this.pts;
      let added = false;
      for (const p of list) {
        if (Math.hypot(p.x - pts[pts.length - 2], p.y - pts[pts.length - 1]) < min) continue;
        pts.push(p.x, p.y);
        added = true;
      }
      if (added) this.host.paintLive(true);
    } else if (this.mode === 'move' && list.length) {
      const p = list[list.length - 1];
      this.dx = p.x - this.from.x;
      this.dy = p.y - this.from.y;
      if (!this.lifted && (this.dx || this.dy)) this.lift();
      if (this.lifted) this.host.paintLive();
    } else if (this.mode === 'resize' && list.length && this.grip) {
      const g = this.grip;
      const next = resizeShape(g.from, g.i, list[list.length - 1], MIN_SIZE / this.host.cam.z);
      this.host.edit({ before: [g.cur], after: [next] });
      g.cur = next;
      this.sel = { ...this.sel!, touched: [next], inside: [next], picks: [next] };
      this.host.paintLive(true);
    }
  }

  up() {
    if (this.mode === 'draw') {
      this.mode = 'idle';
      this.prev = null;
      if (this.marquee) this.closeMarquee();
      else this.close();
    } else if (this.mode === 'move') {
      this.mode = 'idle';
      if (this.lifted) this.drop();
      else if (this.marquee && (this.sel?.picks?.length ?? 0) > 1) this.setSel(this.hit ? this.pickSel([this.hit]) : null);
    } else if (this.mode === 'resize' && this.grip) {
      const { from, cur } = this.grip;
      this.mode = 'idle';
      this.grip = null;
      if (cur !== from) this.host.record({ before: [from], after: [cur] });
      this.setSel(this.pickSel([cur]));
    }
    this.hit = null;
    this.host.paintLive(true);
  }

  cancel() {
    if (this.mode === 'draw') {
      this.setSel(this.prev);
      this.prev = null;
    } else if (this.mode === 'move' && this.lifted && this.sel) {
      this.host.edit({ before: this.sel.outside, after: this.sel.touched });
    } else if (this.mode === 'resize' && this.grip) {
      const { from, cur } = this.grip;
      this.host.edit({ before: [cur], after: [from] });
      this.setSel(this.pickSel([from]));
    }
    this.mode = 'idle';
    this.grip = null;
    this.hit = null;
    this.lifted = false;
    this.pts = [];
    this.host.paintLive(true);
  }

  hover(p: Pt | null) {
    const h = p && this.handleAt(p);
    if (h) return this.host.setCursor(cursorFor(this.single()!, h));
    const over = !!p && ((!!this.sel?.inside.length && this.sel.mask.inside(p.x, p.y)) || (this.marquee && !!this.hitAt(p)));
    this.host.setCursor(over ? 'move' : null);
  }

  // Selects one element, as a click would.
  select(el: El) {
    this.setSel(this.pickSel([el]));
    this.host.paintLive(true);
  }

  key(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && this.sel) {
      this.remove();
      return true;
    }
    if (mod && !e.shiftKey && e.code === 'KeyC' && this.sel) return this.copy(), true;
    if (mod && !e.shiftKey && e.code === 'KeyX' && this.sel) return this.copy(), this.remove(), true;
    return false;
  }

  escape() {
    if (!this.sel) return false;
    this.clear();
    return true;
  }

  reset() {
    this.setSel(null);
    this.host.setCursor(null);
  }

  clear() {
    this.setSel(null);
    this.host.setCursor(null);
    this.host.paintLive(true);
  }

  // Deletes what is inside; strokes crossing the edge keep their outside part.
  remove() {
    const s = this.sel;
    if (!s) return;
    if (s.touched.length) this.host.commit({ before: s.touched, after: s.outside });
    this.clear();
  }

  copy() {
    if (!this.sel?.inside.length) return;
    clip = { els: [...this.sel.inside].sort(byZ), poly: [...this.sel.mask.poly] };
    useBoard.setState({ canPaste: true });
    const r = this.region(), ex = r && toJSON(r);
    claim(ex?.ok ? JSON.stringify(ex.json) : null);
  }

  // Restyles everything selected as one history entry. A lasso cuts strokes at its edge first, but only the
  // ones the change actually touches.
  restyle(fn: (el: El) => El) {
    const s = this.sel;
    if (!s || this.mode !== 'idle') return;
    const before: El[] = [], after: El[] = [];
    if (s.picks) {
      const next = s.picks.map((el) => {
        const n = fn(el);
        if (n !== el) before.push(el), after.push(n);
        return n;
      });
      if (!after.length) return;
      this.host.commit({ before, after });
      this.setSel(this.pickSel(next));
    } else {
      const touched: El[] = [], inside: El[] = [], outside: El[] = [];
      for (const el of s.touched) {
        const c = cutEl(el, s.mask);
        if (!c) continue;
        const styled = c.inside.map(fn);
        if (styled.every((n, i) => n === c.inside[i])) {
          touched.push(el);
          inside.push(...c.inside);
          outside.push(...c.outside);
          continue;
        }
        before.push(el);
        after.push(...c.outside, ...styled);
        touched.push(...styled);
        inside.push(...styled);
      }
      if (!before.length) return;
      this.host.commit({ before, after });
      this.setSel({ mask: s.mask, touched: touched.sort(byZ), inside: inside.sort(byZ), outside });
    }
    this.host.paintLive(true);
  }

  // Elements the board clipboard and the current selection hold, including ones lifted off the scene mid-drag.
  held(): readonly El[] {
    const s = this.sel;
    return [...(clip?.els ?? []), ...(s ? [...s.inside, ...s.touched] : []), ...(this.grip ? [this.grip.from, this.grip.cur] : [])];
  }

  // Pastes offset from the last copy or paste, or centered in view when that spot is off screen.
  paste() {
    if (!clip) return;
    const { scene } = this.host;
    const b = bboxOf(clip.poly, 0);
    let dx = PASTE_OFFSET, dy = PASTE_OFFSET;
    const view = this.host.view();
    if (!intersects(shift(b, dx, dy), view)) {
      dx = (view.x0 + view.x1) / 2 - (b.x0 + b.x1) / 2;
      dy = (view.y0 + view.y1) / 2 - (b.y0 + b.y1) / 2;
    }
    const els = clip.els.map((el) => ({ ...moveEl(el, dx, dy), id: newId(), z: scene.nextZ() }));
    const poly = movePoly(clip.poly, dx, dy);
    clip = { els, poly };
    if (els.length) this.host.commit({ before: [], after: els });
    if (this.marquee && els.length) this.setSel(this.pickSel(els));
    else this.setSel({ mask: new PolyMask(poly), touched: els, inside: els, outside: [] });
    this.host.paintLive(true);
  }

  // The selection's world bounds while no gesture runs, for controls placed next to it.
  bounds(): Box | null {
    return this.sel && this.mode === 'idle' ? this.sel.mask.bbox : null;
  }

  // Cut fresh from the scene: after a move or paste the polygon may cover ink the drag selection never held.
  region(): Region | null {
    const s = this.sel;
    if (!s || this.mode !== 'idle') return null;
    if (s.picks) {
      const ids = s.picks.map((el) => el.id);
      return { poly: s.mask.poly, bbox: s.mask.bbox, ids, touched: s.picks, inside: s.picks, outside: [], only: ids };
    }
    const c = cutRegion(this.host.scene, s.mask);
    return { poly: s.mask.poly, bbox: s.mask.bbox, ids: c.touched.map((el) => el.id), ...c };
  }

  drawLive(ctx: CanvasRenderingContext2D, full: boolean) {
    const pal = this.host.palette();
    const z = this.host.cam.z;
    ctx.lineWidth = 1.25 / z;
    ctx.strokeStyle = pal.accent;
    ctx.setLineDash(DASH.map((d) => d / z));
    if (this.mode === 'draw' && this.marquee) {
      const [x0, y0, x1 = x0, y1 = y0] = this.pts;
      this.outline(ctx, rectPoly({ x0, y0, x1, y1 }), 0, 0, true);
    } else if (this.mode === 'draw') {
      this.outline(ctx, this.pts, 0, 0, false);
    } else if (this.sel && this.lifted) {
      // First move frame copies the highlight already on the overlay instead of rasterizing the selection again.
      if (full) this.snapshot(ctx);
      else if (!this.snap) this.grab(ctx);
      if (!full) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
      }
      const s = this.snap;
      if (s) ctx.drawImage(s.cv, s.x + this.dx, s.y + this.dy, s.cv.width / s.s, s.cv.height / s.s);
      if (!s?.outlined) this.outline(ctx, this.sel.mask.poly, this.dx, this.dy, true);
    } else if (this.sel) {
      const view = this.host.view();
      for (const el of this.sel.inside) if (intersects(el.bbox, view)) drawEl(ctx, el, pal, pal.accent);
      const picks = this.sel.picks;
      const one = this.grip?.cur ?? (picks?.length === 1 ? picks[0] : null);
      this.outline(ctx, one ? framePoly(one, FRAME_PAD / z) : this.sel.mask.poly, 0, 0, true);
      const el = this.single();
      if (el) {
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff';
        const s = HANDLE / z;
        for (const h of handles(el)) {
          ctx.fillRect(h.x - s / 2, h.y - s / 2, s, s);
          ctx.strokeRect(h.x - s / 2, h.y - s / 2, s, s);
        }
      }
    }
    ctx.setLineDash([]);
  }

  // Select tool press: a handle was already ruled out. Shift toggles the element under the pointer; a press on
  // an element or inside the selection moves it; empty space starts a marquee.
  private pick(p: Pt, shiftKey: boolean) {
    const hit = this.hitAt(p), picks = this.sel?.picks ?? [];
    if (shiftKey && hit) {
      const next = picks.includes(hit) ? picks.filter((el) => el !== hit) : [...picks, hit];
      this.setSel(next.length ? this.pickSel(next) : null);
      this.host.paintLive(true);
      return;
    }
    if (hit && !shiftKey) {
      if (!picks.includes(hit)) this.setSel(this.pickSel([hit]));
      this.hit = hit;
      this.host.paintLive(true);
      return this.startMove(p);
    }
    if (!shiftKey && this.sel?.inside.length && this.sel.mask.inside(p.x, p.y)) return this.startMove(p);
    this.prev = this.sel;
    this.adding = shiftKey;
    if (!shiftKey) this.setSel(null);
    this.mode = 'draw';
    this.pts = [p.x, p.y];
    this.host.paintLive(true);
  }

  private hitAt(p: Pt) {
    return hitTest(this.host.scene, p, HIT_TOL / this.host.cam.z);
  }

  private startMove(p: Pt) {
    this.mode = 'move';
    this.from = p;
    this.dx = this.dy = 0;
    this.lifted = false;
  }

  // The one shape selected whole, which gets resize handles.
  single(): Shape | null {
    const s = this.sel;
    if (!s || s.inside.length !== 1 || s.touched.length !== 1) return null;
    const el = s.inside[0];
    return isShape(el) && el === s.touched[0] ? el : null;
  }

  private handleAt(p: Pt): Handle | null {
    const el = this.single();
    if (!el) return null;
    const r = HANDLE_REACH / this.host.cam.z;
    for (const h of handles(el)) if (Math.abs(p.x - h.x) <= r && Math.abs(p.y - h.y) <= r) return h;
    return null;
  }

  // Whole elements; one gets its own frame, several share the box around their frames.
  private pickSel(els: El[]): Sel {
    const pad = FRAME_PAD / this.host.cam.z;
    let poly = framePoly(els[0], pad);
    if (els.length > 1) {
      let b = bboxOf(poly, 0);
      for (const el of els.slice(1)) b = union(b, bboxOf(framePoly(el, pad), 0));
      poly = rectPoly(b);
    }
    const sorted = [...els].sort(byZ);
    return { mask: new PolyMask(poly), touched: sorted, inside: sorted, outside: [], picks: sorted };
  }

  private outline(ctx: CanvasRenderingContext2D, p: readonly number[], dx: number, dy: number, closed: boolean) {
    if (p.length < 4) return;
    ctx.beginPath();
    ctx.moveTo(p[0] + dx, p[1] + dy);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] + dx, p[i + 1] + dy);
    if (closed) ctx.closePath();
    ctx.stroke();
  }

  private setSel(s: Sel | null) {
    this.sel = s;
    this.snap = null;
    useBoard.setState({ selection: !!s, selStyle: s ? summarize(s.inside) : null });
  }

  private close() {
    const poly = this.pts;
    this.pts = [];
    const b = bboxOf(poly, 0);
    const min = MIN_EXTENT / this.host.cam.z;
    if (poly.length < 6 || (b.x1 - b.x0 < min && b.y1 - b.y0 < min)) {
      const hit = this.hitAt({ x: poly[0], y: poly[1] });
      if (hit) this.setSel(this.pickSel([hit]));
      return;
    }
    const mask = new PolyMask(poly.map(round2));
    this.setSel({ mask, ...cutRegion(this.host.scene, mask) });
  }

  // Elements mostly inside the marquee, whole; Shift adds them to the picks it started with.
  private closeMarquee() {
    const [x0, y0, x1 = x0, y1 = y0] = this.pts;
    this.pts = [];
    const add = this.adding ? (this.sel?.picks ?? []) : [];
    this.adding = false;
    const min = MIN_EXTENT / this.host.cam.z;
    if (Math.abs(x1 - x0) < min && Math.abs(y1 - y0) < min) return;
    const b = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
    const mask = new PolyMask(rectPoly(b));
    const got = [...add];
    for (const el of this.host.scene.index.query(b)) if (!got.includes(el) && share(el, mask) > MARQUEE_SHARE) got.push(el);
    this.setSel(got.length ? this.pickSel(got) : null);
  }

  // First pixel of a move: the selected ink leaves the scene (crossing strokes keep their outside part) and rides the overlay.
  private lift() {
    const s = this.sel!;
    this.lifted = true;
    this.snap = null;
    this.host.edit({ before: s.touched, after: s.outside });
  }

  private drop() {
    const s = this.sel!;
    const { dx, dy } = this;
    const moved = s.inside.map((el) => moveEl(el, dx, dy));
    this.host.edit({ before: [], after: moved });
    this.host.record({ before: s.touched, after: [...s.outside, ...moved] });
    this.lifted = false;
    if (s.picks) this.setSel(this.pickSel(moved));
    else this.setSel({ mask: new PolyMask(movePoly(s.mask.poly, dx, dy)), touched: moved, inside: moved, outside: [] });
  }

  private snapshot(ctx: CanvasRenderingContext2D) {
    this.snap = null;
    const ink = boxOf(this.sel!.inside);
    if (!ink) return;
    const v = this.host.view();
    const vw = v.x1 - v.x0, vh = v.y1 - v.y0;
    // Covers the selection up to one view beyond each edge, so ink dragged in from off screen still shows.
    const a = { x0: Math.max(ink.x0, v.x0 - vw), y0: Math.max(ink.y0, v.y0 - vh), x1: Math.min(ink.x1, v.x1 + vw), y1: Math.min(ink.y1, v.y1 + vh) };
    if (a.x1 <= a.x0 || a.y1 <= a.y0) return;
    let s = ctx.getTransform().a;
    const cap = ctx.canvas.width * ctx.canvas.height * 2;
    const px = (a.x1 - a.x0) * (a.y1 - a.y0) * s * s;
    if (px > cap) s *= Math.sqrt(cap / px);
    const cv = new OffscreenCanvas(Math.ceil((a.x1 - a.x0) * s), Math.ceil((a.y1 - a.y0) * s));
    const o = cv.getContext('2d')!;
    o.setTransform(s, 0, 0, s, -a.x0 * s, -a.y0 * s);
    const pal = this.host.palette();
    for (const el of this.sel!.inside) drawEl(o, el, pal, pal.accent);
    this.snap = { cv, x: a.x0, y: a.y0, s, outlined: false };
  }

  // The resting overlay (highlight and outline) as a bitmap; ink outside the view joins only after the drop.
  private grab(ctx: CanvasRenderingContext2D) {
    const src = ctx.canvas, cam = this.host.cam;
    const cv = new OffscreenCanvas(src.width, src.height);
    cv.getContext('2d')!.drawImage(src, 0, 0);
    this.snap = { cv, x: cam.x, y: cam.y, s: ctx.getTransform().a, outlined: true };
  }
}
