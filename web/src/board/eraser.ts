import { inkPad, piece } from './cut.ts';
import { bboxOf, grow, pathLen, rangePts, splitRange, SweepMask, union, type Range } from './geom.ts';
import { newId } from './pencil.ts';
import { colorOf, drawEl, drawLabel, strokeWith } from './render.ts';
import { canLabel, labelText, outlineRuns } from './shapes.ts';
import { ERASER_DEFAULT, notice } from './store.ts';
import type { Tool, ToolHost } from './tool.ts';
import type { Box, El, Icon, Img, Pt, Stroke, Text } from './types.ts';

export const ERASER_MIN = 3;
export const ERASER_MAX = 80;
// Pieces shorter than this many CSS px are dropped instead of left as specks.
const MIN_PIECE = 1;
// How close (CSS px) the eraser must come to a glyph or icon line to take the element.
const INK_TOL = 2;
// Ink sampling grid: at most this many cells across an element.
const INK_CELLS = 128;
const INK_PAL = { ink: '#000', grid: '#000', accent: '#000' };

// World-space centers of the painted cells of a text, icon or picture, rendered once per element.
const inks = new WeakMap<El, { dots: number[]; cell: number }>();

function inkDots(el: Text | Icon | Img) {
  let d = inks.get(el);
  if (d) return d;
  const b = el.bbox, bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const s = Math.min(2, INK_CELLS / Math.max(bw, bh, 1));
  const cw = Math.max(1, Math.ceil(bw * s)), ch = Math.max(1, Math.ceil(bh * s));
  const ctx = new OffscreenCanvas(cw, ch).getContext('2d', { willReadFrequently: true })!;
  ctx.setTransform(s, 0, 0, s, -b.x0 * s, -b.y0 * s);
  drawEl(ctx, el, INK_PAL);
  const px = ctx.getImageData(0, 0, cw, ch).data, dots: number[] = [];
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (px[(y * cw + x) * 4 + 3] > 64) dots.push(b.x0 + (x + 0.5) / s, b.y0 + (y + 0.5) / s);
  d = { dots, cell: 1 / s };
  inks.set(el, d);
  return d;
}

// Partial eraser: each batch of pointer samples sweeps capsules that cut the strokes under them.
// During the drag a touched stroke is only a list of surviving parameter ranges, drawn as a plain polyline;
// pieces and their outlines are built once, on pointerup, as one history entry.
export class Eraser implements Tool {
  readonly id = 'eraser';
  size = ERASER_DEFAULT;
  private host: ToolHost;
  private on = false;
  private at: Pt | null = null;
  // Per touched element: its centerlines (a shape's outline turned into strokes) and what survives of each.
  private work = new Map<string, { orig: El; parts: { src: Stroke; ranges: Range[] }[] }>();
  private touched: Box | null = null;

  constructor(host: ToolHost) {
    this.host = host;
  }

  get busy() {
    return this.on;
  }

  down(p: Pt) {
    this.on = true;
    this.at = p;
    this.sweep([p.x, p.y]);
    this.host.paintLive(true);
  }

  move(list: readonly Pt[]) {
    if (!this.on || !list.length) return;
    const pts = this.at ? [this.at.x, this.at.y] : [];
    for (const p of list) pts.push(p.x, p.y);
    this.at = list[list.length - 1];
    this.sweep(pts);
    this.host.paintLive(true);
  }

  up() {
    if (!this.on) return;
    this.on = false;
    const min = MIN_PIECE / this.host.cam.z;
    const before: El[] = [], after: El[] = [];
    for (const { orig, parts } of this.work.values()) {
      before.push(orig);
      const label = canLabel(orig) && labelText(orig, newId());
      if (label) after.push(label);
      for (const { src, ranges } of parts) {
        for (const [a, b] of ranges) {
          const pts = rangePts(src.pts, a, b);
          if (pathLen(pts) >= min) after.push(piece(src, pts));
        }
      }
    }
    this.work.clear();
    this.touched = null;
    if (before.length) this.host.commit({ before, after });
    // An erased outline is open strokes, which cannot hold a fill.
    if (before.some((el) => 'fill' in el && el.fill)) notice('Erasing a filled shape removes its fill · Ctrl+Z to undo');
  }

  cancel() {
    if (!this.on) return;
    this.on = false;
    this.work.clear();
    if (this.touched) this.host.repaint(this.touched);
    this.touched = null;
    this.host.paintLive(true);
  }

  hover(p: Pt | null) {
    this.at = p;
    this.host.paintLive(true);
  }

  // Draws what survives of a touched stroke, only the segments near `view`.
  paintEl(ctx: CanvasRenderingContext2D, el: El, view: Box) {
    const w = this.work.get(el.id);
    if (!w) return false;
    for (const part of w.parts) this.paintPart(ctx, part.src, part.ranges, view);
    if (canLabel(w.orig) && w.orig.label) drawLabel(ctx, w.orig, colorOf(w.orig.color, this.host.palette()));
    return true;
  }

  private paintPart(ctx: CanvasRenderingContext2D, src: Stroke, ranges: Range[], view: Box) {
    const p = src.pts, n = p.length / 2, pad = src.size;
    strokeWith(ctx, colorOf(src.color, this.host.palette()), src.size, src.dash);
    ctx.beginPath();
    for (const [a, b] of ranges) {
      const end = rangePts(p, b, b);
      let [px, py] = rangePts(p, a, a), pen = false;
      const to = (x: number, y: number) => {
        if (Math.max(px, x) + pad < view.x0 || Math.min(px, x) - pad > view.x1 || Math.max(py, y) + pad < view.y0 || Math.min(py, y) - pad > view.y1) pen = false;
        else {
          if (!pen) ctx.moveTo(px, py);
          ctx.lineTo(x, y);
          pen = true;
        }
        px = x;
        py = y;
      };
      for (let k = Math.floor(a) + 1; k < b && k < n; k++) to(p[k * 2], p[k * 2 + 1]);
      to(end[0], end[1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    return true;
  }

  drawLive(ctx: CanvasRenderingContext2D) {
    if (!this.at) return;
    const z = this.host.cam.z;
    ctx.beginPath();
    ctx.arc(this.at.x, this.at.y, this.size / z, 0, Math.PI * 2);
    ctx.fillStyle = this.host.palette().grid;
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = this.host.palette().ink;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Text and icons go only when the sweep reaches their glyphs or lines, not the empty part of their box.
  private touchesInk(el: Text | Icon | Img, m: SweepMask) {
    const { dots, cell } = inkDots(el);
    const extra = cell * 0.75 + INK_TOL / this.host.cam.z, b = m.bbox;
    for (let i = 0; i < dots.length; i += 2) {
      const x = dots[i], y = dots[i + 1];
      if (x < b.x0 - extra || x > b.x1 + extra || y < b.y0 - extra || y > b.y1 + extra) continue;
      if (m.near(x, y, extra)) return true;
    }
    return false;
  }

  private sweep(pts: number[]) {
    const r = this.size / this.host.cam.z;
    const m = new SweepMask(pts, r);
    let pad = -1;
    for (const el of this.host.scene.index.query(m.bbox)) {
      let w = this.work.get(el.id);
      const fresh = !w;
      if (!w) {
        // Text, icons and pictures go whole on first touch; other shapes become strokes along their outline.
        if (el.kind === 'text' || el.kind === 'icon' || el.kind === 'image') {
          if (!this.touchesInk(el, m)) continue;
          w = { orig: el, parts: [] };
        } else {
          const lines = el.kind === 'stroke' ? [el] : outlineRuns(el).map((pts): Stroke => ({ kind: 'stroke', id: newId(), z: el.z, pts, color: el.color, size: el.size, ...(el.dash && { dash: el.dash }), ...(el.role && { role: el.role }), bbox: bboxOf(pts, el.size / 2 + 1) }));
          w = { orig: el, parts: lines.map((src) => ({ src, ranges: [[0, src.pts.length / 2 - 1] as Range] })) };
        }
      }
      let hit = !w.parts.length;
      for (const part of w.parts) {
        const next: Range[] = [];
        for (const rg of part.ranges) {
          const s = splitRange(part.src.pts, rg[0], rg[1], m);
          if (s) (hit = true), next.push(...s.outside);
          else next.push(rg);
        }
        part.ranges = next;
      }
      if (!hit) continue;
      this.work.set(el.id, w);
      this.touched = this.touched ? union(this.touched, el.bbox) : el.bbox;
      pad = Math.max(pad, inkPad(el));
      // A shape's first touch changes how all of it is drawn.
      if (fresh && el.kind !== 'stroke') this.host.repaint(grow(el.bbox, 1));
    }
    // Ink changes only near the sweep, so only that rect repaints.
    if (pad >= 0) this.host.repaint(grow(m.bbox, pad + 1));
  }
}
