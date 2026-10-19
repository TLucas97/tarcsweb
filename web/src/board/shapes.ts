import { bboxOf, pathLen, PolyMask, polyDist2, round2, splitRange, union, type Mask } from './geom.ts';
import type { Scene } from './scene.ts';
import type { Box, El, Ellipse, Icon, Img, Line, Poly, Pt, Rect, Shape, Text } from './types.ts';

// Geometry of the parametric elements: boxes, outlines, hit tests, lasso coverage and resizing.

export const FONT = '"Lexend", "Atkinson Hyperlegible", system-ui, sans-serif';
export const LINE_HEIGHT = 1.25;
export const SHAPE_SIZE = 3;
// Shared with the elements JSON schema, so everything on the board can be exported.
export const TEXT_MAX = 2000;
export const FONT_MAX = 1000;
// Most points one straight run of an outline is split into.
const MAX_SPLIT = 256;

export type Boxed = Rect | Ellipse | Text | Icon | Img;

export const isShape = (el: El): el is Shape => el.kind !== 'stroke';
export const isBoxed = (el: El): el is Boxed => el.kind === 'rect' || el.kind === 'ellipse' || el.kind === 'text' || el.kind === 'icon' || el.kind === 'image';
export const isLine = (el: El): el is Line => el.kind === 'line' || el.kind === 'arrow';
// An arrow drawn along a path; it scales and frames like a poly.
export const isPath = (el: El): el is Line & { pts: readonly number[] } => el.kind === 'arrow' && !!el.pts;
const isSegment = (el: El): el is Line & { pts?: undefined } => isLine(el) && !el.pts;
// Shapes that can hold a label.
export const canLabel = (el: El): el is Rect | Ellipse => el.kind === 'rect' || el.kind === 'ellipse';
const rotOf = (el: Boxed) => (el.kind === 'rect' || el.kind === 'ellipse' ? el.rot : el.kind === 'text' ? (el.rot ?? 0) : 0);

// Into the box's frame: origin at its center, unrotated.
export function toLocal(el: Boxed, x: number, y: number): [number, number] {
  const r = rotOf(el), c = Math.cos(r), s = Math.sin(r);
  const dx = x - el.x - el.w / 2, dy = y - el.y - el.h / 2;
  return [dx * c + dy * s, -dx * s + dy * c];
}

export function toWorld(el: Boxed, u: number, v: number): [number, number] {
  const r = rotOf(el), c = Math.cos(r), s = Math.sin(r);
  return [el.x + el.w / 2 + u * c - v * s, el.y + el.h / 2 + u * s + v * c];
}

// Box corners in world space, clockwise from top-left, grown by `pad`.
export function corners(el: Boxed, pad = 0) {
  const hw = el.w / 2 + pad, hh = el.h / 2 + pad;
  return [...toWorld(el, -hw, -hh), ...toWorld(el, hw, -hh), ...toWorld(el, hw, hh), ...toWorld(el, -hw, hh)];
}

// The two barbs of an arrow head at (x2, y2); a path arrow's head follows its last segment, as the curve ends along it.
// `len` overrides the length the head is capped by.
export function arrowHead(el: { x1: number; y1: number; x2: number; y2: number; size: number; pts?: readonly number[] }, len?: number) {
  const p = el.pts, n = p?.length ?? 0, path = !!p && n >= 6;
  let fx = el.x1, fy = el.y1;
  // Aims from about one head length back, so a short last segment does not swing the head.
  if (path) {
    let i = n - 4;
    while (i > 0 && Math.hypot(el.x2 - p[i], el.y2 - p[i + 1]) < 10 + el.size * 2) i -= 2;
    fx = p[i];
    fy = p[i + 1];
  }
  len = (len ?? (path ? pathLen(p) : Math.hypot(el.x2 - el.x1, el.y2 - el.y1))) || 1;
  const h = Math.min(10 + el.size * 2, len * 0.45), a = Math.atan2(el.y2 - fy, el.x2 - fx), spread = 0.5;
  return [el.x2 - h * Math.cos(a - spread), el.y2 - h * Math.sin(a - spread), el.x2 - h * Math.cos(a + spread), el.y2 - h * Math.sin(a + spread)];
}

// The smooth curve a path arrow is drawn with (quadratics through the midpoints, render.ts's centerPath) as points.
export function curvePts(pts: readonly number[], step: number): number[] {
  const n = pts.length / 2;
  if (n < 3) return [...pts];
  const out = [pts[0], pts[1]];
  let sx = pts[0], sy = pts[1];
  for (let i = 1; i < n - 1; i++) {
    const cx = pts[i * 2], cy = pts[i * 2 + 1], ex = (cx + pts[i * 2 + 2]) / 2, ey = (cy + pts[i * 2 + 3]) / 2;
    const k = Math.max(1, Math.min(32, Math.ceil((Math.hypot(cx - sx, cy - sy) + Math.hypot(ex - cx, ey - cy)) / step)));
    for (let j = 1; j <= k; j++) {
      const t = j / k, u = 1 - t;
      out.push(u * u * sx + 2 * u * t * cx + t * t * ex, u * u * sy + 2 * u * t * cy + t * t * ey);
    }
    sx = ex;
    sy = ey;
  }
  out.push(pts[n * 2 - 2], pts[n * 2 - 1]);
  return out;
}

// Label text keeps this gap (world units) from the shape's edge.
export const LABEL_PAD = 6;
// Wrapped label lines by font size, width and text; cleared when full.
const wraps = new Map<string, { lines: string[]; w: number }>();
const WRAP_CAP = 500;
// Widths measured before the web font loaded are stale.
export const clearWraps = () => wraps.clear();

// The width label text wraps to: the box, or the square inscribed in an ellipse, less padding.
export function labelWidth(el: { kind: 'rect' | 'ellipse'; w: number }) {
  return Math.max(1, (el.kind === 'ellipse' ? el.w * Math.SQRT1_2 : el.w) - 2 * LABEL_PAD);
}

// Greedy word wrap; a word wider than the line breaks between characters.
export function wrapText(text: string, size: number, maxW: number) {
  const key = `${size}|${Math.round(maxW * 10)}|${text}`;
  const hit = wraps.get(key);
  if (hit) return hit;
  mctx ??= new OffscreenCanvas(1, 1).getContext('2d')!;
  const m = mctx;
  m.font = fontOf(size);
  const width = (s: string) => m.measureText(s).width;
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (let word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (width(next) <= maxW) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      // Measures only the growing piece, so a long word costs its length times one line, not its length squared.
      if (width(word) > maxW) {
        let part = '';
        for (const ch of word) {
          if (part && width(part + ch) > maxW) lines.push(part), (part = '');
          part += ch;
        }
        word = part;
      }
      line = word;
    }
    lines.push(line);
  }
  let w = 0;
  for (const l of lines) w = Math.max(w, width(l));
  const out = { lines, w: Math.ceil(w) };
  if (wraps.size >= WRAP_CAP) wraps.clear();
  wraps.set(key, out);
  return out;
}

// A label's lines and text block size, centered on the shape.
export function labelLayout(el: Rect | Ellipse) {
  const { text, fontSize } = el.label!;
  const { lines, w } = wrapText(text, fontSize, labelWidth(el)), lh = fontSize * LINE_HEIGHT;
  return { lines, lh, w, h: lines.length * lh };
}

// Grows the shape's height about its center until its label fits inside.
export function fitLabel<T extends Rect | Ellipse>(el: T): T {
  if (!el.label) return el;
  const L = labelLayout(el), need = round2((el.kind === 'ellipse' ? L.h * Math.SQRT2 : L.h) + 2 * LABEL_PAD);
  if (need <= el.h) return el;
  return shape<Rect | Ellipse>({ ...el, y: round2(el.y - (need - el.h) / 2), h: need }) as T;
}

// The label as a free text element with the same lines, centered and turned like it, for when its shape turns into strokes.
export function labelText(el: Rect | Ellipse, id: string): Text | null {
  if (!el.label) return null;
  // Wrap breaks add characters, so a near-limit label is cut to stay valid JSON.
  const { fontSize } = el.label, text = labelLayout(el).lines.join('\n').slice(0, TEXT_MAX), m = measureText(text, fontSize);
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  const extra = { align: 'center' as const, ...(el.rot && { rot: el.rot }), ...(el.role && { role: el.role }) };
  return makeText({ id, z: el.z, x: round2(cx - m.w / 2), y: round2(cy - m.h / 2), text, fontSize, color: el.color, ...extra });
}

// A long word or a shrunk shape lets the label spill past the outline, so the bbox covers it.
function withLabel(el: Rect | Ellipse, b: Box): Box {
  if (!el.label?.text) return b;
  const L = labelLayout(el), hw = L.w / 2 + 1, hh = L.h / 2 + 1;
  return union(b, bboxOf([...toWorld(el, -hw, -hh), ...toWorld(el, hw, -hh), ...toWorld(el, hw, hh), ...toWorld(el, -hw, hh)], 0));
}

function shapeBox(el: Shape): Box {
  switch (el.kind) {
    case 'rect':
      return withLabel(el, bboxOf(corners(el), el.size / 2 + 1));
    case 'ellipse': {
      const a = el.w / 2, b = el.h / 2, c = Math.cos(el.rot), s = Math.sin(el.rot);
      const ex = Math.hypot(a * c, b * s), ey = Math.hypot(a * s, b * c), cx = el.x + a, cy = el.y + b, p = el.size / 2 + 1;
      return withLabel(el, { x0: cx - ex - p, y0: cy - ey - p, x1: cx + ex + p, y1: cy + ey + p });
    }
    case 'line':
      return bboxOf([el.x1, el.y1, el.x2, el.y2], el.size / 2 + 1);
    case 'arrow':
      // The curve stays inside its points' hull.
      return bboxOf([...(el.pts ?? [el.x1, el.y1, el.x2, el.y2]), ...arrowHead(el)], el.size / 2 + 1);
    case 'poly':
      return bboxOf(el.pts, el.size / 2 + 1);
    case 'text':
      if (el.rot) return bboxOf(corners(el), 1);
      return { x0: el.x - 1, y0: el.y - 1, x1: el.x + el.w + 1, y1: el.y + el.h + 1 };
    case 'image':
      return { x0: el.x - 1, y0: el.y - 1, x1: el.x + el.w + 1, y1: el.y + el.h + 1 };
    case 'icon': {
      const p = el.w / 24 + 1;
      return { x0: el.x - p, y0: el.y - p, x1: el.x + el.w + p, y1: el.y + el.h + p };
    }
  }
}

type NoBox<T> = T extends unknown ? Omit<T, 'bbox'> : never;

// Builds a shape with its bbox filled in.
export const shape = <T extends Shape>(s: NoBox<T>): T => ({ ...s, bbox: shapeBox(s as unknown as T) }) as unknown as T;

let mctx: OffscreenCanvasRenderingContext2D | null = null;
export const fontOf = (size: number) => `${size}px ${FONT}`;

export function measureText(text: string, size: number) {
  mctx ??= new OffscreenCanvas(1, 1).getContext('2d')!;
  mctx.font = fontOf(size);
  const lines = text.split('\n');
  let w = 0;
  for (const l of lines) w = Math.max(w, mctx.measureText(l).width);
  return { w: Math.ceil(w) + 1, h: Math.ceil(lines.length * size * LINE_HEIGHT) };
}

export function makeText(base: { id: string; z: number; x: number; y: number; text: string; fontSize: number; color: string; role?: 'note'; align?: 'center'; rot?: number }): Text {
  return shape<Text>({ ...base, kind: 'text', ...measureText(base.text, base.fontSize) });
}

// Closed outline of a (rounded) rect as flat points, with no segment longer than `step`.
export function rectContour(cx: number, cy: number, w: number, h: number, rot: number, r: number, step: number) {
  const hw = w / 2, hh = h / 2;
  r = Math.max(0, Math.min(r, hw, hh));
  const local: number[] = [];
  const quads = [[hw - r, -hh + r, -Math.PI / 2], [hw - r, hh - r, 0], [-hw + r, hh - r, Math.PI / 2], [-hw + r, -hh + r, Math.PI]];
  const arcN = r > 0 ? Math.max(3, Math.min(16, Math.ceil((r * Math.PI) / 2 / step))) : 0;
  for (const [qx, qy, a0] of quads) {
    if (!arcN) local.push(qx, qy);
    else for (let k = 0; k <= arcN; k++) {
      const a = a0 + (k / arcN) * (Math.PI / 2);
      local.push(qx + r * Math.cos(a), qy + r * Math.sin(a));
    }
  }
  // Starts on the top-left corner so the closing point repeats it.
  const first = local.splice(local.length - 2 * (arcN + 1));
  local.unshift(...first);
  local.push(local[0], local[1]);
  const c = Math.cos(rot), s = Math.sin(rot), out: number[] = [];
  for (let i = 0; i < local.length; i += 2) {
    const u = local[i], v = local[i + 1];
    if (i) {
      const pu = local[i - 2], pv = local[i - 1], n = Math.min(MAX_SPLIT, Math.ceil(Math.hypot(u - pu, v - pv) / step));
      for (let k = 1; k < n; k++) {
        const t = k / n, iu = pu + (u - pu) * t, iv = pv + (v - pv) * t;
        out.push(cx + iu * c - iv * s, cy + iu * s + iv * c);
      }
    }
    out.push(cx + u * c - v * s, cy + u * s + v * c);
  }
  return out;
}

// Closed outline of an ellipse with `n` points plus the repeated first one.
export function ellipseContour(cx: number, cy: number, w: number, h: number, rot: number, n: number) {
  const a = w / 2, b = h / 2, c = Math.cos(rot), s = Math.sin(rot), out: number[] = [];
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * Math.PI * 2, u = a * Math.cos(t), v = b * Math.sin(t);
    out.push(cx + u * c - v * s, cy + u * s + v * c);
  }
  return out;
}

const densify = (pts: number[], step: number) => {
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    const px = pts[i - 2], py = pts[i - 1], x = pts[i], y = pts[i + 1], n = Math.min(MAX_SPLIT, Math.ceil(Math.hypot(x - px, y - py) / step));
    for (let k = 1; k < n; k++) out.push(px + ((x - px) * k) / n, py + ((y - py) * k) / n);
    out.push(x, y);
  }
  return out;
};

const runs = new WeakMap<El, number[][]>();

// The centerlines a shape is drawn with, as polylines. The eraser turns them into strokes; text and icons have none.
export function outlineRuns(el: Shape): number[][] {
  let r = runs.get(el);
  if (r) return r;
  const step = Math.max(6, 'size' in el ? el.size * 2 : 6);
  switch (el.kind) {
    case 'poly':
      r = [densify(el.closed ? [...el.pts, el.pts[0], el.pts[1]] : [...el.pts], step)];
      break;
    case 'rect':
      r = [rectContour(el.x + el.w / 2, el.y + el.h / 2, el.w, el.h, el.rot, el.r, step)];
      break;
    case 'ellipse': {
      const per = Math.PI * (el.w + el.h) / 2;
      r = [ellipseContour(el.x + el.w / 2, el.y + el.h / 2, el.w, el.h, el.rot, Math.max(24, Math.min(256, Math.ceil(per / 6))))];
      break;
    }
    case 'line':
      r = [densify([el.x1, el.y1, el.x2, el.y2], step)];
      break;
    case 'arrow': {
      const [ax, ay, bx, by] = arrowHead(el);
      r = [densify(el.pts ? curvePts(el.pts, step) : [el.x1, el.y1, el.x2, el.y2], step), [ax, ay, el.x2, el.y2, bx, by]];
      break;
    }
    default:
      r = [];
  }
  runs.set(el, r);
  return r;
}

// 2 when `p` is on the element's ink, 1 when inside an outline shape, 0 for a miss.
function hitLevel(el: El, p: Pt, tol: number) {
  if (el.kind === 'stroke') return polyDist2(el.pts, p.x, p.y) <= (el.size / 2 + tol) ** 2 ? 2 : 0;
  if (el.kind === 'text' && el.rot) {
    const [u, v] = toLocal(el, p.x, p.y);
    return Math.abs(u) <= el.w / 2 + tol && Math.abs(v) <= el.h / 2 + tol ? 2 : 0;
  }
  if (el.kind === 'text' || el.kind === 'icon' || el.kind === 'image') {
    return p.x >= el.x - tol && p.x <= el.x + el.w + tol && p.y >= el.y - tol && p.y <= el.y + el.h + tol ? 2 : 0;
  }
  const reach = (el.size / 2 + tol) ** 2;
  for (const run of outlineRuns(el)) if (polyDist2(run, p.x, p.y) <= reach) return 2;
  if (el.kind === 'poly') return el.closed && el.pts.length >= 6 && new PolyMask(el.pts).inside(p.x, p.y) ? 1 : 0;
  if (el.kind === 'rect') {
    const [u, v] = toLocal(el, p.x, p.y);
    return Math.abs(u) <= el.w / 2 && Math.abs(v) <= el.h / 2 ? 1 : 0;
  }
  if (el.kind === 'ellipse') {
    const [u, v] = toLocal(el, p.x, p.y);
    return (u / (el.w / 2)) ** 2 + (v / (el.h / 2)) ** 2 <= 1 ? 1 : 0;
  }
  return 0;
}

// The element under `p`: ink beats the inside of an outline, then the topmost wins.
export function hitTest(scene: Scene, p: Pt, tol: number): El | null {
  let best: El | null = null, level = 0;
  for (const el of scene.index.query({ x0: p.x - tol, y0: p.y - tol, x1: p.x + tol, y1: p.y + tol })) {
    const l = hitLevel(el, p, tol);
    if (l > level || (l && l === level && best && (el.z > best.z || (el.z === best.z && el.id > best.id)))) (best = el), (level = l);
  }
  return best;
}

const GRID = 8;

const xs: number[] = [];

// Area of a convex quad (flat corners) inside an even-odd polygon, by rows. Rows sit at the midpoints between
// the polygon's own vertex heights, where the inside width is close to linear, so the sum is near exact.
function areaInside(c: number[], m: PolyMask) {
  const poly = m.poly;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 1; i < 8; i += 2) (y0 = Math.min(y0, c[i])), (y1 = Math.max(y1, c[i]));
  const cuts = [y0, y1];
  for (let i = 1; i < 8; i += 2) cuts.push(c[i]);
  for (let i = 1; i < poly.length; i += 2) if (poly[i] > y0 && poly[i] < y1) cuts.push(poly[i]);
  if (cuts.length > 512) for (let k = 1; k < 128; k++) cuts.push(y0 + ((y1 - y0) * k) / 128);
  cuts.sort((a, b) => a - b);
  let area = 0;
  for (let k = 1; k < cuts.length; k++) {
    const h = cuts[k] - cuts[k - 1];
    if (h <= 0) continue;
    // Two rows per band absorb the kinks where lasso edges cross each other or the quad.
    for (const f of [0.25, 0.75]) {
      const y = cuts[k - 1] + h * f;
      let a = Infinity, b = -Infinity;
      for (let i = 0; i < 8; i += 2) {
        const ax = c[i], ay = c[i + 1], bx = c[(i + 2) % 8], by = c[(i + 3) % 8];
        if (ay > y === by > y) continue;
        const x = ax + ((y - ay) * (bx - ax)) / (by - ay);
        a = Math.min(a, x);
        b = Math.max(b, x);
      }
      if (b <= a) continue;
      m.spans(y, xs);
      for (let i = 0; i + 1 < xs.length; i += 2) area += Math.max(0, Math.min(b, xs[i + 1]) - Math.max(a, xs[i])) * (h / 2);
    }
  }
  return area;
}

// Share of a shape inside a lasso: of its box area for boxes and closed polys, of its length for lines and open polys.
// Share of a polyline's length inside a mask.
function lengthInside(p: readonly number[], m: Mask) {
  let inside = 0, all = 0;
  for (let i = 2; i < p.length; i += 2) {
    const len = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]), s = splitRange([p[i - 2], p[i - 1], p[i], p[i + 1]], 0, 1, m);
    all += len;
    if (s) inside += len * s.inside.reduce((t, [a, c]) => t + c - a, 0);
  }
  return all ? inside / all : 0;
}

export function coverage(el: Shape, m: Mask) {
  let n = 0, total = 0;
  if (isPath(el)) return lengthInside(outlineRuns(el)[0], m);
  if (isLine(el)) {
    const s = splitRange([el.x1, el.y1, el.x2, el.y2], 0, 1, m);
    return s ? s.inside.reduce((t, [a, b]) => t + b - a, 0) : 0;
  }
  if (el.kind === 'poly') {
    const b = bboxOf(el.pts, 0), w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (el.closed && w > 0 && h > 0) {
      if ('spans' in m) return areaInside([b.x0, b.y0, b.x1, b.y0, b.x1, b.y1, b.x0, b.y1], m as PolyMask) / (w * h);
      for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++, total++) if (m.inside(b.x0 + ((i + 0.5) / GRID) * w, b.y0 + ((j + 0.5) / GRID) * h)) n++;
      return n / total;
    }
    return lengthInside(el.closed ? [...el.pts, el.pts[0], el.pts[1]] : el.pts, m);
  }
  if ('spans' in m && el.w > 0 && el.h > 0) return areaInside(corners(el), m as PolyMask) / (el.w * el.h);
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++, total++) {
      const [x, y] = toWorld(el, ((i + 0.5) / GRID - 0.5) * el.w, ((j + 0.5) / GRID - 0.5) * el.h);
      if (m.inside(x, y)) n++;
    }
  }
  return n / total;
}

export function moveShape(el: Shape, dx: number, dy: number): Shape {
  const pts = (p: readonly number[]) => p.map((v, i) => v + (i & 1 ? dy : dx));
  if (isLine(el)) return shape<Line>({ ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy, ...(el.pts && { pts: pts(el.pts) }) });
  if (el.kind === 'poly') return shape<Poly>({ ...el, pts: pts(el.pts) });
  return shape<Boxed>({ ...el, x: el.x + dx, y: el.y + dy });
}

// A polygon around one selected element, for its selection frame and move hit area.
export function framePoly(el: El, pad: number): number[] {
  if (isBoxed(el)) return corners(el, pad);
  if (isSegment(el)) {
    const dx = el.x2 - el.x1, dy = el.y2 - el.y1, len = Math.hypot(dx, dy) || 1;
    const w = pad + el.size / 2 + (el.kind === 'arrow' ? Math.min(10 + el.size * 2, len * 0.45) * 0.5 : 0);
    const ux = dx / len, uy = dy / len, nx = -uy * w, ny = ux * w, ex = ux * pad, ey = uy * pad;
    return [el.x1 - ex + nx, el.y1 - ey + ny, el.x2 + ex + nx, el.y2 + ey + ny, el.x2 + ex - nx, el.y2 + ey - ny, el.x1 - ex - nx, el.y1 - ey - ny];
  }
  const b = el.bbox;
  return [b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y0 - pad, b.x1 + pad, b.y1 + pad, b.x0 - pad, b.y1 + pad];
}

// Handle signs on the box, clockwise from top-left; text and icons scale from corners only.
const SIGNS = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const uniform = (el: Shape) => el.kind === 'text' || el.kind === 'icon' || el.kind === 'image';

export type Handle = { i: number; x: number; y: number };

// Polys get the handles of their points' box and scale their points with it.
export function handles(el: Shape): Handle[] {
  if (el.kind === 'poly' || isLine(el)) {
    if (el.kind !== 'poly' && !el.pts) return [{ i: 0, x: el.x1, y: el.y1 }, { i: 1, x: el.x2, y: el.y2 }];
    const b = bboxOf(el.pts!, 0), mid = (lo: number, hi: number, s: number) => (s < 0 ? lo : s > 0 ? hi : (lo + hi) / 2);
    return SIGNS.map(([sx, sy], i) => ({ i, x: mid(b.x0, b.x1, sx), y: mid(b.y0, b.y1, sy) }));
  }
  const out: Handle[] = [];
  SIGNS.forEach(([sx, sy], i) => {
    if (uniform(el) && (!sx || !sy)) return;
    const [x, y] = toWorld(el, (sx * el.w) / 2, (sy * el.h) / 2);
    out.push({ i, x, y });
  });
  return out;
}

// Scales the points about the box side opposite handle `i`; a flat axis (a level polyline) keeps its size.
function scalePts(pts: readonly number[], i: number, p: Pt, min: number): number[] | null {
  const b = bboxOf(pts, 0), [sx, sy] = SIGNS[i];
  const fx = sx < 0 ? b.x1 : b.x0, fy = sy < 0 ? b.y1 : b.y0, ew = b.x1 - b.x0, eh = b.y1 - b.y0;
  const kx = sx && ew > 1e-6 ? Math.max(min, sx * (p.x - fx)) / ew : 1;
  const ky = sy && eh > 1e-6 ? Math.max(min, sy * (p.y - fy)) / eh : 1;
  if (!Number.isFinite(kx * ky)) return null;
  return pts.map((v, k) => (k & 1 ? fy + (v - fy) * ky : fx + (v - fx) * kx));
}

// The shape with handle `i` dragged to `p`; the opposite side stays put.
export function resizeShape(el: Shape, i: number, p: Pt, min: number): Shape {
  if (isLine(el)) {
    if (!el.pts) return shape<Line>(i === 0 ? { ...el, x1: p.x, y1: p.y } : { ...el, x2: p.x, y2: p.y });
    const pts = scalePts(el.pts, i, p, min), n = pts?.length ?? 0;
    return pts ? shape<Line>({ ...el, pts, x1: pts[0], y1: pts[1], x2: pts[n - 2], y2: pts[n - 1] }) : el;
  }
  if (el.kind === 'poly') {
    const pts = scalePts(el.pts, i, p, min);
    return pts ? shape<Poly>({ ...el, pts }) : el;
  }
  const [sx, sy] = SIGNS[i];
  const [qu, qv] = toLocal(el, p.x, p.y);
  const fu = (-sx * el.w) / 2, fv = (-sy * el.h) / 2;
  // Degenerate boxes count as `min` wide, so ratios below never divide by zero.
  const ew = Math.max(min, el.w), eh = Math.max(min, el.h);
  let w = sx ? Math.max(min, sx * (qu - fu)) : ew;
  let h = sy ? Math.max(min, sy * (qv - fv)) : eh;
  let font = 0;
  if (uniform(el)) {
    const k = Math.max(w / ew, h / eh);
    if (el.kind === 'text') {
      font = Math.min(FONT_MAX, Math.max(4, Math.round(el.fontSize * k * 10) / 10));
      ({ w, h } = measureText(el.text, font));
    } else (w = ew * k), (h = eh * k);
  }
  if (!Number.isFinite(w + h + qu + qv)) return el;
  const [cx, cy] = toWorld(el, sx ? fu + (sx * w) / 2 : 0, sy ? fv + (sy * h) / 2 : 0);
  const box = { x: cx - w / 2, y: cy - h / 2, w, h };
  if (el.kind === 'text') return shape<Text>({ ...el, ...box, fontSize: font });
  return shape<Boxed>({ ...el, ...box });
}
