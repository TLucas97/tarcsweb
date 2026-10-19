import type { Box } from './types.ts';

export const intersects = (a: Box, b: Box) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

export function bboxOf(pts: readonly number[], pad: number): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

export const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
export const grow = (b: Box, d: number): Box => ({ x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d });
export const shift = (b: Box, dx: number, dy: number): Box => ({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy });

export const round2 = (v: number) => Math.round(v * 100) / 100;

export function pathLen(pts: readonly number[]) {
  let n = 0;
  for (let i = 2; i < pts.length; i += 2) n += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return n;
}

export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  const ex = ax + dx * t - px, ey = ay + dy * t - py;
  return ex * ex + ey * ey;
}

// Squared distance from a point to a flat x,y polyline; `closed` adds the last-to-first segment.
export function polyDist2(pts: readonly number[], x: number, y: number, closed = false) {
  const n = pts.length;
  if (n === 2) return (x - pts[0]) ** 2 + (y - pts[1]) ** 2;
  let best = Infinity;
  for (let i = 0; i + 3 < n; i += 2) {
    const d = segDist2(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
    if (d < best) best = d;
  }
  if (closed && n >= 4) best = Math.min(best, segDist2(x, y, pts[n - 2], pts[n - 1], pts[0], pts[1]));
  return best;
}

// Ramer-Douglas-Peucker on a flat x,y polyline.
export function simplify(pts: readonly number[], eps: number): number[] {
  const n = pts.length / 2;
  if (n < 3) return [...pts];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  const e2 = eps * eps;
  while (stack.length) {
    const b = stack.pop()!, a = stack.pop()!;
    let far = -1, fd = e2;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(pts[i * 2], pts[i * 2 + 1], pts[a * 2], pts[a * 2 + 1], pts[b * 2], pts[b * 2 + 1]);
      if (d > fd) (fd = d), (far = i);
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push(a, far, far, b);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

// Parameter t on a→b where it meets segment p→q, or -1.
function segHit(ax: number, ay: number, bx: number, by: number, px: number, py: number, qx: number, qy: number) {
  const dx = bx - ax, dy = by - ay, ex = qx - px, ey = qy - py;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-12) return -1;
  const fx = px - ax, fy = py - ay;
  const t = (fx * ey - fy * ex) / den, s = (fx * dy - fy * dx) / den;
  return s >= 0 && s <= 1 ? t : -1;
}

// A region a centerline can be cut by. `crossings` lists every t in (0,1) where a→b may cross the boundary
// (extra candidates are fine); the pieces between them are classified with `inside` at their midpoints.
export interface Mask {
  readonly bbox: Box;
  inside(x: number, y: number): boolean;
  crossings(ax: number, ay: number, bx: number, by: number, out: number[]): void;
}

// The eraser's sweep over one batch of pointer samples: capsules of radius r between consecutive samples.
export class SweepMask implements Mask {
  readonly bbox: Box;
  private pts: readonly number[];
  private r: number;

  constructor(pts: readonly number[], r: number) {
    this.pts = pts;
    this.r = r;
    this.bbox = bboxOf(pts, r);
  }

  inside(x: number, y: number) {
    return this.near(x, y, 0);
  }

  // Inside the sweep grown by `extra`.
  near(x: number, y: number, extra: number) {
    const p = this.pts, r2 = (this.r + extra) ** 2;
    if (p.length === 2) return segDist2(x, y, p[0], p[1], p[0], p[1]) <= r2;
    for (let i = 0; i + 3 < p.length; i += 2) if (segDist2(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= r2) return true;
    return false;
  }

  // The union's boundary lies on the end circles and the two side lines of each capsule.
  crossings(ax: number, ay: number, bx: number, by: number, out: number[]) {
    const p = this.pts, r = this.r;
    const dx = bx - ax, dy = by - ay, dd = dx * dx + dy * dy;
    if (!dd) return;
    for (let i = 0; i < p.length; i += 2) {
      const fx = ax - p[i], fy = ay - p[i + 1];
      const b = fx * dx + fy * dy, c = fx * fx + fy * fy - r * r;
      const disc = b * b - dd * c;
      if (disc < 0) continue;
      const s = Math.sqrt(disc);
      out.push((-b - s) / dd, (-b + s) / dd);
    }
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ux = p[i + 2] - p[i], uy = p[i + 3] - p[i + 1], ul = Math.hypot(ux, uy);
      if (!ul) continue;
      const nx = (-uy / ul) * r, ny = (ux / ul) * r;
      out.push(segHit(ax, ay, bx, by, p[i] + nx, p[i + 1] + ny, p[i + 2] + nx, p[i + 3] + ny));
      out.push(segHit(ax, ay, bx, by, p[i] - nx, p[i + 1] - ny, p[i + 2] - nx, p[i + 3] - ny));
    }
  }
}

const BANDS = 64;

// Even-odd point-in-polygon, so concave and self-crossing lassos work. Edges are bucketed into horizontal bands,
// so a test only looks at the edges near its row.
export class PolyMask implements Mask {
  readonly bbox: Box;
  readonly poly: readonly number[];
  private bands: number[][];
  private bandH: number;
  // Per-edge stamp, so an edge spanning several bands is tested once per segment.
  private seen: Uint32Array;
  private stamp = 0;

  constructor(poly: readonly number[]) {
    this.poly = poly;
    const b = (this.bbox = bboxOf(poly, 0));
    this.bandH = (b.y1 - b.y0) / BANDS || 1;
    this.bands = Array.from({ length: BANDS }, () => []);
    const n = poly.length / 2;
    this.seen = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const ya = poly[i * 2 + 1], yb = poly[((i + 1) % n) * 2 + 1];
      for (let k = this.band(Math.min(ya, yb)), end = this.band(Math.max(ya, yb)); k <= end; k++) this.bands[k].push(i);
    }
  }

  private band(y: number) {
    return Math.min(BANDS - 1, Math.max(0, Math.floor((y - this.bbox.y0) / this.bandH)));
  }

  inside(x: number, y: number) {
    const b = this.bbox;
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return false;
    const p = this.poly, n = p.length / 2;
    let c = false;
    for (const i of this.bands[this.band(y)]) {
      const j = (i + 1) % n;
      const yi = p[i * 2 + 1], yj = p[j * 2 + 1];
      if (yi > y !== yj > y && x < p[i * 2] + ((y - yi) * (p[j * 2] - p[i * 2])) / (yj - yi)) c = !c;
    }
    return c;
  }

  // Sorted x where the outline crosses row y; even-odd pairs of them bound the inside.
  spans(y: number, out: number[]) {
    out.length = 0;
    const b = this.bbox;
    if (y < b.y0 || y > b.y1) return;
    const p = this.poly, n = p.length / 2;
    for (const i of this.bands[this.band(y)]) {
      const j = (i + 1) % n;
      const yi = p[i * 2 + 1], yj = p[j * 2 + 1];
      if (yi > y !== yj > y) out.push(p[i * 2] + ((y - yi) * (p[j * 2] - p[i * 2])) / (yj - yi));
    }
    out.sort((a, c) => a - c);
  }

  crossings(ax: number, ay: number, bx: number, by: number, out: number[]) {
    const p = this.poly, n = p.length / 2;
    const st = ++this.stamp;
    for (let k = this.band(Math.min(ay, by)), end = this.band(Math.max(ay, by)); k <= end; k++) {
      for (const i of this.bands[k]) {
        if (this.seen[i] === st) continue;
        this.seen[i] = st;
        const j = (i + 1) % n;
        out.push(segHit(ax, ay, bx, by, p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]));
      }
    }
  }
}

// A stretch of a polyline in parameter space: u = segment index + t, from 0 to point count - 1.
export type Range = [number, number];
export type RangeSplit = { inside: Range[]; outside: Range[] };

const ts: number[] = [];

// Splits [a, b] of a polyline into stretches inside and outside a mask, cut at the exact boundary crossings.
// A tangent touch has the same side on both sides of it, so it never cuts. Null when nothing is inside.
export function splitRange(pts: readonly number[], a: number, b: number, m: Mask): RangeSplit | null {
  const n = pts.length / 2;
  if (n === 1) return m.inside(pts[0], pts[1]) ? { inside: [[0, 0]], outside: [] } : null;
  const box = m.bbox;
  const out: RangeSplit = { inside: [], outside: [] };
  let side: boolean | null = null, start = a, any = false;
  const at = (u: number, s: boolean) => {
    if (s) any = true;
    if (side === null) side = s;
    else if (s !== side) {
      (side ? out.inside : out.outside).push([start, u]);
      start = u;
      side = s;
    }
  };
  for (let i = Math.floor(a), end = Math.min(n - 1, Math.ceil(b)); i < end; i++) {
    const t0 = Math.max(0, a - i), t1 = Math.min(1, b - i);
    if (t1 <= t0) continue;
    const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[i * 2 + 2], by = pts[i * 2 + 3];
    if (Math.max(ax, bx) < box.x0 || Math.min(ax, bx) > box.x1 || Math.max(ay, by) < box.y0 || Math.min(ay, by) > box.y1) {
      at(i + t0, false);
      continue;
    }
    ts.length = 0;
    m.crossings(ax, ay, bx, by, ts);
    ts.push(t1);
    ts.sort((x, y) => x - y);
    let prev = t0;
    for (const t of ts) {
      if (t <= prev + 1e-9 || t > t1) continue;
      const mid = (prev + t) / 2;
      at(i + prev, m.inside(ax + (bx - ax) * mid, ay + (by - ay) * mid));
      prev = t;
    }
  }
  if (side !== null) (side ? out.inside : out.outside).push([start, b]);
  return any ? out : null;
}

// The points of [a, b]: interpolated ends plus the original vertices between them.
export function rangePts(pts: readonly number[], a: number, b: number): number[] {
  const n = pts.length / 2;
  if (n === 1) return [pts[0], pts[1]];
  const out: number[] = [];
  const add = (x: number, y: number) => {
    if (out.length && Math.abs(x - out[out.length - 2]) < 1e-6 && Math.abs(y - out[out.length - 1]) < 1e-6) return;
    out.push(x, y);
  };
  const lerp = (u: number) => {
    const i = Math.min(Math.floor(u), n - 2), t = u - i;
    if (t === 0) return add(pts[i * 2], pts[i * 2 + 1]);
    add(round2(pts[i * 2] + (pts[i * 2 + 2] - pts[i * 2]) * t), round2(pts[i * 2 + 1] + (pts[i * 2 + 3] - pts[i * 2 + 1]) * t));
  };
  lerp(a);
  for (let k = Math.floor(a) + 1; k < b; k++) add(pts[k * 2], pts[k * 2 + 1]);
  lerp(b);
  return out;
}

export type Split = { inside: number[][]; outside: number[][] };

// Whole-polyline split, as point runs. Null when no part is inside.
export function splitByMask(pts: readonly number[], m: Mask): Split | null {
  const s = splitRange(pts, 0, pts.length / 2 - 1, m);
  if (!s) return null;
  const toPts = (r: Range) => rangePts(pts, r[0], r[1]);
  return { inside: s.inside.map(toPts), outside: s.outside.map(toPts) };
}

// perfect-freehand's streamline, applied once at commit so a later split piece renders exactly like the original.
// Unlike getStrokePoints it keeps the first points, so the stroke starts where the press was.
export function streamline(pts: readonly number[], amount: number, minStep: number): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts.map(round2);
  const t = 0.15 + (1 - amount) * 0.85;
  const out = [round2(pts[0]), round2(pts[1])];
  let px = pts[0], py = pts[1];
  const min2 = minStep * minStep;
  for (let i = 1; i < n - 1; i++) {
    px += (pts[i * 2] - px) * t;
    py += (pts[i * 2 + 1] - py) * t;
    const dx = px - out[out.length - 2], dy = py - out[out.length - 1];
    if (dx * dx + dy * dy >= min2) out.push(round2(px), round2(py));
  }
  out.push(round2(pts[pts.length - 2]), round2(pts[pts.length - 1]));
  return out;
}
