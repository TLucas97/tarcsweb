import { getStroke, type Vec2 } from './vendor/perfect-freehand.ts';
import { intersects } from './geom.ts';
import { iconPath } from './icons.ts';
import { bitmapOf } from './images.ts';
import { arrowHead, fontOf, labelLayout, LINE_HEIGHT } from './shapes.ts';
import { dashOf, FILL_ALPHA } from './style.ts';
import type { Box, Dash, El, Ellipse, Img, Line, Poly, Rect, Stroke } from './types.ts';
import { INK } from './types.ts';

// One outline per element object; elements are immutable, so the cache never goes stale and drops with the element.
const paths = new WeakMap<El, Path2D>();

// Constant width for mouse input: no thinning, no simulated pressure, streamline already baked into the points.
const strokeOpts = (size: number) => ({ size, thinning: 0, smoothing: 0.5, streamline: 0, simulatePressure: false, last: true });

// Smooth closed path through the outline's midpoints (perfect-freehand README's getSvgPathFromStroke, built directly).
function outlinePath(o: Vec2[]) {
  const p = new Path2D();
  const n = o.length;
  if (n < 2) return p;
  p.moveTo((o[0][0] + o[1][0]) / 2, (o[0][1] + o[1][1]) / 2);
  for (let i = 1; i <= n; i++) {
    const a = o[i % n], b = o[(i + 1) % n];
    p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  p.closePath();
  return p;
}

function strokePath(el: Stroke) {
  if (el.dash) return centerPath(el.pts);
  const pts: number[][] = [];
  for (let i = 0; i < el.pts.length; i += 2) pts.push([el.pts[i], el.pts[i + 1]]);
  return outlinePath(getStroke(pts, strokeOpts(el.size)));
}

// A dashed stroke is stroked along its smoothed centerline, since a filled outline cannot carry a dash.
function centerPath(pts: readonly number[]) {
  const p = new Path2D(), n = pts.length / 2;
  p.moveTo(pts[0], pts[1]);
  if (n === 1) p.lineTo(pts[0], pts[1]);
  for (let i = 1; i < n - 1; i++) p.quadraticCurveTo(pts[i * 2], pts[i * 2 + 1], (pts[i * 2] + pts[i * 2 + 2]) / 2, (pts[i * 2 + 1] + pts[i * 2 + 3]) / 2);
  if (n > 1) p.lineTo(pts[n * 2 - 2], pts[n * 2 - 1]);
  return p;
}

// Outline centerlines in world space; drawn with ctx.stroke at the element's width.
function shapePath(el: Rect | Ellipse | Line | Poly) {
  const p = new Path2D();
  switch (el.kind) {
    case 'poly':
      p.moveTo(el.pts[0], el.pts[1]);
      for (let i = 2; i < el.pts.length; i += 2) p.lineTo(el.pts[i], el.pts[i + 1]);
      if (el.closed) p.closePath();
      return p;
    case 'rect': {
      const local = new Path2D();
      local.roundRect(-el.w / 2, -el.h / 2, el.w, el.h, Math.min(el.r, el.w / 2, el.h / 2));
      p.addPath(local, new DOMMatrix().translateSelf(el.x + el.w / 2, el.y + el.h / 2).rotateSelf((el.rot * 180) / Math.PI));
      return p;
    }
    case 'ellipse':
      p.ellipse(el.x + el.w / 2, el.y + el.h / 2, el.w / 2, el.h / 2, el.rot, 0, Math.PI * 2);
      return p;
    // An arrow's head is drawn apart, so it stays solid on a dashed shaft.
    case 'line':
    case 'arrow':
      if (el.pts) return centerPath(el.pts);
      p.moveTo(el.x1, el.y1);
      p.lineTo(el.x2, el.y2);
      return p;
  }
}

function pathOf(el: Stroke | Rect | Ellipse | Line | Poly) {
  let p = paths.get(el);
  if (!p) {
    p = el.kind === 'stroke' ? strokePath(el) : shapePath(el);
    paths.set(el, p);
  }
  return p;
}

// `accent` is the selection highlight; gray, hue and note resolve the named element colors (light-theme values when absent).
export type Palette = { ink: string; grid: string; accent: string; gray?: string; hue?: string; note?: string };
export function colorOf(c: string, pal: Palette) {
  switch (c) {
    case INK:
      return pal.ink;
    case 'gray':
      return pal.gray ?? '#747168';
    case 'accent':
      return pal.hue ?? '#2f6bd0';
    case 'note':
      return pal.note ?? '#d4462e';
    default:
      return c;
  }
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// `tint` overrides the element's color, for selection highlights.
export function drawEl(ctx: Ctx, el: El, pal: Palette, tint?: string) {
  if (el.kind === 'image') return drawImage(ctx, el, tint);
  const color = tint ?? colorOf(el.color, pal);
  switch (el.kind) {
    case 'stroke':
      if (el.dash) {
        strokeWith(ctx, color, el.size, el.dash);
        ctx.stroke(pathOf(el));
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = color;
        ctx.fill(pathOf(el));
      }
      return;
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'arrow':
    case 'poly': {
      const path = pathOf(el);
      const fill = el.kind === 'line' || el.kind === 'arrow' || (el.kind === 'poly' && !el.closed) ? undefined : (el as Rect | Ellipse | Poly).fill;
      if (fill) {
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * FILL_ALPHA[fill];
        ctx.fillStyle = color;
        ctx.fill(path);
        ctx.globalAlpha = a;
      }
      strokeWith(ctx, color, el.size, el.dash);
      ctx.stroke(path);
      if (el.dash) ctx.setLineDash([]);
      if (el.kind === 'arrow') {
        const [ax, ay, bx, by] = arrowHead(el);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(el.x2, el.y2);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      if ((el.kind === 'rect' || el.kind === 'ellipse') && el.label) drawLabel(ctx, el, color);
      return;
    }
    case 'text': {
      ctx.fillStyle = color;
      ctx.font = fontOf(el.fontSize);
      ctx.textBaseline = 'middle';
      const lh = el.fontSize * LINE_HEIGHT;
      if (!el.rot && !el.align) {
        el.text.split('\n').forEach((line, i) => ctx.fillText(line, el.x, el.y + (i + 0.5) * lh));
        return;
      }
      ctx.save();
      ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
      if (el.rot) ctx.rotate(el.rot);
      if (el.align) ctx.textAlign = 'center';
      el.text.split('\n').forEach((line, i) => ctx.fillText(line, el.align ? 0 : -el.w / 2, (i + 0.5) * lh - el.h / 2));
      ctx.restore();
      return;
    }
    case 'icon': {
      ctx.save();
      ctx.translate(el.x, el.y);
      ctx.scale(el.w / 24, el.h / 24);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(iconPath(el.name));
      ctx.restore();
      return;
    }
  }
}

// Wrapped lines centered on the shape and turned with it.
export function drawLabel(ctx: Ctx, el: Rect | Ellipse, color: string) {
  const L = labelLayout(el);
  ctx.save();
  ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
  if (el.rot) ctx.rotate(el.rot);
  ctx.fillStyle = color;
  ctx.font = fontOf(el.label!.fontSize);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  L.lines.forEach((line, i) => ctx.fillText(line, 0, (i + 0.5) * L.lh - L.h / 2));
  ctx.restore();
}

export function strokeWith(ctx: Ctx, color: string, size: number, dash: Dash | undefined) {
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash(dashOf(dash, size));
}

// A tint (selection) washes over the picture instead of replacing it; a missing bitmap shows as an empty frame.
function drawImage(ctx: Ctx, el: Img, tint?: string) {
  const b = bitmapOf(el.src);
  if (b) ctx.drawImage(b, el.x, el.y, el.w, el.h);
  if (b && !tint) return;
  ctx.save();
  if (tint) {
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = tint;
    ctx.fillRect(el.x, el.y, el.w, el.h);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = tint ?? '#8a867c';
  ctx.lineWidth = 2;
  ctx.strokeRect(el.x, el.y, el.w, el.h);
  ctx.restore();
}

// Dot grid so pan and zoom read on an empty board; spacing doubles until dots sit at least 16 CSS px apart.
export function drawGrid(ctx: CanvasRenderingContext2D, view: Box, z: number, pal: Palette) {
  let step = 24;
  while (step * z < 16) step *= 2;
  const r = 1 / z;
  ctx.fillStyle = pal.grid;
  for (let x = Math.ceil(view.x0 / step) * step; x <= view.x1; x += step) {
    for (let y = Math.ceil(view.y0 / step) * step; y <= view.y1; y += step) ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

// `over` lets the active tool draw an element it is changing live; it returns true when it did.
export function drawScene(ctx: CanvasRenderingContext2D, order: readonly El[], view: Box, z: number, pal: Palette, over?: (el: El) => boolean) {
  drawGrid(ctx, view, z, pal);
  for (const el of order) if (intersects(el.bbox, view) && !over?.(el)) drawEl(ctx, el, pal);
}
