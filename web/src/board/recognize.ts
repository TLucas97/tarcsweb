import { bboxOf, pathLen, polyDist2, segDist2 } from './geom.ts';
import { ellipseContour, rectContour } from './shapes.ts';

// Hold-to-snap: fits a line, an ellipse, a rect, a rounded rect and a polygon to a stroke and returns the clear
// winner, or nothing. Plain geometry. Lengths in CSS px are scaled by the zoom; the rest are ratios of the bbox diagonal.
export const SNAP = {
  DWELL_MS: 450, // hold this long...
  DWELL_PX: 3, // ...within this radius to trigger
  CANCEL_PX: 6, // moving this far from the hold point drops the preview
  MIN_LEN_PX: 24, // shorter strokes never snap
  SAMPLES: 64, // arc-length resampling
  LINE_STRAIGHT: 0.94, // endpoint distance / path length for a line
  LINE_RMS: 0.025,
  LINE_MAX: 0.07,
  LINE_AXIS_DEG: 5, // lines this close to level or plumb snap to it
  CLOSE_GAP: 0.18, // end gap / diagonal for a closed shape
  CLOSE_GAP_PX: 10,
  FIT_RMS: 0.035, // two-way RMS distance / diagonal
  FIT_MAX: 0.07, // worst two-way residual / diagonal
  FIT_FLOOR_PX: 1.5, // tiny shapes are never held to less than this
  WIN: 0.85, // the winner's score must be at most this times the runner-up's
  RECT_STEP_DEG: 3,
  RECT_FINE_DEG: 0.5,
  AXIS_DEG: 8, // rects and ellipses this close to level snap level
  SIDE_SUPPORT: 0.7, // share of each rect side the ink must follow, counting the end gap...
  SIDE_DRAWN: 0.4, // ...of which this much must be real ink
  GAP_SIDE: 0.5, // the end gap may span at most this share of the side it lies on
  SIDE_TOL: 0.06,
  CORNER_TOL: 0.05, // every corner needs ink this close
  ROUND_MIN: 0.1, // corner radius / shorter side, from...
  ROUND_MIN_PX: 8, // ...and never under this in CSS px...
  ROUND_MAX: 0.28, // ...to this; rounder reads as an ellipse
  ROUND_GAIN: 0.85, // rounding must cut the rect's score to this share
  CIRCLE: 0.1, // axes this close (relative) make a circle
  ELLIPSE_BIAS: 0.75, // against a rounded rect, an ellipse ranks as if its score were this much lower
  TRAVERSE_MAX: 1.45, // stroke length / fitted outline: more means it went round more than once
  TRAVERSE_MIN: 0.7,
  TAIL_MAX: 0.25, // a start or end tail past the closing point may be at most this share of the stroke...
  TAIL_COST: 0.25, // ...and trimming one costs this much per unit of length against the end gap it saves
  POLY_TAIL_MAX: 0.12, // a polygon's trimmed tail may be at most this share of the stroke, and either...
  POLY_TAIL_ON: 0.03, // ...retrace the outline within this (/ loop diagonal), or...
  POLY_TAIL_CORNER: 0.1, // ...leave the loop this close to a corner...
  POLY_TAIL_DIST: 0.08, // ...and stray at most this far from the outline (a short overshoot, not a stem)
  POLY_SAMPLES: 128,
  POLY_RDP: 0.035, // corner search tolerance / diagonal
  POLY_MERGE_DEG: 22, // corners turning less than this merge into one side
  POLY_MIN_SIDE: 0.06, // sides shorter than this share of the outline collapse into a corner
  POLY_TRIM: 0.15, // each side's line is fitted without this share at both ends, where corners round off
  POLY_ROUND: 0.35, // corner radius the ink implies / shorter adjacent side: rounder reads as a curve
  POLY_GAP_FREE: 0.005, // ink this close to a corner (/ diagonal) counts as touching it, so tremor is not rounding
  POLY_MAX_SIDES: 10,
  POLY_MANY_DEG: 40, // with 5+ sides, every corner turns at least this much
  POLY_RECT_DEG: 9, // a quad with every corner this close to square is left to the rect fit...
  POLY_GAIN: 0.5, // ...and so is any quad whose score is not below this share of a fitting rect's
  POLY_ELLIPSE_BIAS: 0.6, // against a polygon of 5+ sides, an ellipse ranks as if its score were this much lower
  POLY_AXIS_DEG: 5, // sides this close to level or plumb snap to it
  OPEN_MAX_SIDES: 4, // an open stroke of 2 to this many straight segments becomes an open polyline
  OPEN_RMS: 0.022,
  OPEN_MAX: 0.06,
  OPEN_TURN_DEG: 35, // every bend of an open polyline turns at least this much
};

export type Snap =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'ellipse'; cx: number; cy: number; w: number; h: number; rot: number }
  | { kind: 'rect'; cx: number; cy: number; w: number; h: number; rot: number; r: number }
  | { kind: 'poly'; pts: number[]; closed: boolean };

// `note` says why a candidate that fits failed its own checks (for the debug overlay).
export type Candidate = { name: 'line' | 'ellipse' | 'rect' | 'round' | 'poly'; snap: Snap; contour: number[]; score: number; max: number; ok: boolean; note?: string };
export type Recognition = { snap: Snap | null; why: string; candidates: Candidate[] };

const DEG = Math.PI / 180;

function resample(pts: readonly number[], n: number) {
  const total = pathLen(pts), step = total / (n - 1), out = [pts[0], pts[1]];
  let acc = 0;
  for (let i = 2; i < pts.length && out.length < n * 2; i += 2) {
    let px = pts[i - 2], py = pts[i - 1];
    const x = pts[i], y = pts[i + 1];
    let d = Math.hypot(x - px, y - py);
    while (acc + d >= step && d > 0 && out.length < n * 2) {
      const t = (step - acc) / d;
      px += (x - px) * t;
      py += (y - py) * t;
      out.push(px, py);
      d = Math.hypot(x - px, y - py);
      acc = 0;
    }
    acc += d;
  }
  while (out.length < n * 2) out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}

// RMS and worst distance both ways: ink to contour, and contour to ink, so a missing side counts.
function twoWay(s: number[], closed: boolean, contour: number[]) {
  let sum = 0, max = 0, n = 0;
  const add = (d2: number) => {
    sum += d2;
    if (d2 > max) max = d2;
    n++;
  };
  for (let i = 0; i < s.length; i += 2) add(polyDist2(contour, s[i], s[i + 1]));
  for (let i = 0; i < contour.length; i += 2) add(polyDist2(s, contour[i], contour[i + 1], closed));
  return { rms: Math.sqrt(sum / n), max: Math.sqrt(max) };
}

function fitLine(s: number[], raw: readonly number[]) {
  const n = s.length / 2;
  let mx = 0, my = 0;
  for (let i = 0; i < s.length; i += 2) (mx += s[i]), (my += s[i + 1]);
  mx /= n;
  my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < s.length; i += 2) {
    const dx = s[i] - mx, dy = s[i + 1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  let phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let rms = 0, max = 0;
  for (let i = 0; i < s.length; i += 2) {
    const d = Math.abs(-(s[i] - mx) * Math.sin(phi) + (s[i + 1] - my) * Math.cos(phi));
    rms += d * d;
    max = Math.max(max, d);
  }
  rms = Math.sqrt(rms / n);
  const deg = ((phi / DEG) % 180 + 180) % 180;
  const axis = Math.min(deg, 180 - deg) < SNAP.LINE_AXIS_DEG ? 0 : Math.abs(deg - 90) < SNAP.LINE_AXIS_DEG ? 90 : -1;
  if (axis >= 0) phi = axis * DEG;
  const c = Math.cos(phi), si = Math.sin(phi);
  const proj = (x: number, y: number) => {
    const t = (x - mx) * c + (y - my) * si;
    return [mx + t * c, my + t * si];
  };
  const [x1, y1] = proj(raw[0], raw[1]), [x2, y2] = proj(raw[raw.length - 2], raw[raw.length - 1]);
  return { snap: { kind: 'line' as const, x1, y1, x2, y2 }, rms, max };
}

// Real roots of t^3 + a t^2 + b t + c (Numerical Recipes).
function cubic(a: number, b: number, c: number) {
  const q = (a * a - 3 * b) / 9, r = (2 * a * a * a - 9 * a * b + 27 * c) / 54;
  if (r * r < q * q * q) {
    const th = Math.acos(r / Math.sqrt(q * q * q)), m = -2 * Math.sqrt(q);
    return [m * Math.cos(th / 3) - a / 3, m * Math.cos((th + 2 * Math.PI) / 3) - a / 3, m * Math.cos((th - 2 * Math.PI) / 3) - a / 3];
  }
  const A = -Math.sign(r) * Math.cbrt(Math.abs(r) + Math.sqrt(r * r - q * q * q)), B = A ? q / A : 0;
  return [A + B - a / 3];
}

type M3 = number[][];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function inv3(m: M3): M3 | null {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

// Fitzgibbon's direct least-squares ellipse, in Halir and Flusser's numerically stable form, on normalized points.
function fitEllipse(s: number[]) {
  const n = s.length / 2;
  let mx = 0, my = 0;
  for (let i = 0; i < s.length; i += 2) (mx += s[i]), (my += s[i + 1]);
  mx /= n;
  my /= n;
  let sc = 0;
  for (let i = 0; i < s.length; i += 2) sc += (s[i] - mx) ** 2 + (s[i + 1] - my) ** 2;
  sc = Math.sqrt(sc / n) || 1;
  const z = () => [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const S1 = z(), S2 = z(), S3 = z();
  for (let k = 0; k < s.length; k += 2) {
    const x = (s[k] - mx) / sc, y = (s[k + 1] - my) / sc;
    const d1 = [x * x, x * y, y * y], d2 = [x, y, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        S1[i][j] += d1[i] * d1[j];
        S2[i][j] += d1[i] * d2[j];
        S3[i][j] += d2[i] * d2[j];
      }
    }
  }
  const S3i = inv3(S3);
  if (!S3i) return null;
  const T = z(), M = z();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) T[i][j] -= S3i[i][k] * S2[j][k];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    M[i][j] = S1[i][j];
    for (let k = 0; k < 3; k++) M[i][j] += S2[i][k] * T[k][j];
  }
  const N = [M[2].map((v) => v / 2), M[1].map((v) => -v), M[0].map((v) => v / 2)];
  const tr = N[0][0] + N[1][1] + N[2][2];
  const c2 = N[0][0] * N[1][1] - N[0][1] * N[1][0] + N[0][0] * N[2][2] - N[0][2] * N[2][0] + N[1][1] * N[2][2] - N[1][2] * N[2][1];
  const det = N[0][0] * (N[1][1] * N[2][2] - N[1][2] * N[2][1]) - N[0][1] * (N[1][0] * N[2][2] - N[1][2] * N[2][0]) + N[0][2] * (N[1][0] * N[2][1] - N[1][1] * N[2][0]);
  let a1: number[] | null = null;
  for (const l of cubic(-tr, c2, -det)) {
    const r = N.map((row, i) => row.map((v, j) => (i === j ? v - l : v)));
    const vs = [cross(r[0], r[1]), cross(r[0], r[2]), cross(r[1], r[2])];
    const v = vs.reduce((p, q) => (Math.hypot(...q) > Math.hypot(...p) ? q : p));
    if (4 * v[0] * v[2] - v[1] * v[1] > 0) a1 = v;
  }
  if (!a1) return null;
  const a2 = [0, 1, 2].map((i) => T[i][0] * a1[0] + T[i][1] * a1[1] + T[i][2] * a1[2]);
  const [A, B, C] = a1, [D, E, F] = a2;
  const den = B * B - 4 * A * C;
  if (den >= 0) return null;
  const x0 = (2 * C * D - B * E) / den, y0 = (2 * A * E - B * D) / den;
  const F0 = A * x0 * x0 + B * x0 * y0 + C * y0 * y0 + D * x0 + E * y0 + F;
  const th = 0.5 * Math.atan2(B, A - C), c = Math.cos(th), si = Math.sin(th);
  const ap = A * c * c + B * c * si + C * si * si, cp = A * si * si - B * c * si + C * c * c;
  const ra = -F0 / ap, rb = -F0 / cp;
  if (!(ra > 0 && rb > 0)) return null;
  let w = 2 * Math.sqrt(ra) * sc, h = 2 * Math.sqrt(rb) * sc, rot = th;
  if (rot > Math.PI / 4) (rot -= Math.PI / 2), ([w, h] = [h, w]);
  else if (rot <= -Math.PI / 4) (rot += Math.PI / 2), ([w, h] = [h, w]);
  return { cx: x0 * sc + mx, cy: y0 * sc + my, w, h, rot };
}

type Bounds = { u0: number; u1: number; v0: number; v1: number };

// Distance from a local point to a (rounded) box outline.
function boxDist(u: number, v: number, b: Bounds, r: number) {
  const hw = (b.u1 - b.u0) / 2, hh = (b.v1 - b.v0) / 2;
  const qx = Math.abs(u - (b.u0 + b.u1) / 2) - (hw - r), qy = Math.abs(v - (b.v0 + b.v1) / 2) - (hh - r);
  return Math.abs(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r);
}

function local(s: number[], th: number) {
  const c = Math.cos(th), si = Math.sin(th), out = new Array<number>(s.length);
  for (let i = 0; i < s.length; i += 2) {
    out[i] = s[i] * c + s[i + 1] * si;
    out[i + 1] = -s[i] * si + s[i + 1] * c;
  }
  return out;
}

// Box edges at angle th: each side sits at the mean of the ink nearest to it, measured away from the corners.
function fitBox(s: number[], th: number) {
  const q = local(s, th);
  const b = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
  for (let i = 0; i < q.length; i += 2) {
    b.u0 = Math.min(b.u0, q[i]);
    b.u1 = Math.max(b.u1, q[i]);
    b.v0 = Math.min(b.v0, q[i + 1]);
    b.v1 = Math.max(b.v1, q[i + 1]);
  }
  for (let it = 0; it < 3; it++) {
    const sum = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
    const mu = (b.u1 - b.u0) * 0.15, mv = (b.v1 - b.v0) * 0.15;
    for (let i = 0; i < q.length; i += 2) {
      const u = q[i], v = q[i + 1];
      const d = [Math.abs(u - b.u0), Math.abs(u - b.u1), Math.abs(v - b.v0), Math.abs(v - b.v1)];
      const k = d.indexOf(Math.min(...d));
      const mid = k < 2 ? v > b.v0 + mv && v < b.v1 - mv : u > b.u0 + mu && u < b.u1 - mu;
      if (!mid) continue;
      sum[k] += k < 2 ? u : v;
      cnt[k]++;
    }
    if (cnt[0]) b.u0 = sum[0] / cnt[0];
    if (cnt[1]) b.u1 = sum[1] / cnt[1];
    if (cnt[2]) b.v0 = sum[2] / cnt[2];
    if (cnt[3]) b.v1 = sum[3] / cnt[3];
  }
  return { q, b };
}

function boxRms(q: number[], b: Bounds, r: number) {
  let sum = 0;
  for (let i = 0; i < q.length; i += 2) sum += boxDist(q[i], q[i + 1], b, r) ** 2;
  return Math.sqrt(sum / (q.length / 2));
}

function rectSnap(b: Bounds, th: number, r: number): Snap {
  const cu = (b.u0 + b.u1) / 2, cv = (b.v0 + b.v1) / 2, c = Math.cos(th), si = Math.sin(th);
  let w = b.u1 - b.u0, h = b.v1 - b.v0, rot = th;
  if (rot > Math.PI / 4) (rot -= Math.PI / 2), ([w, h] = [h, w]);
  return { kind: 'rect', cx: cu * c - cv * si, cy: cu * si + cv * c, w, h, rot, r };
}

// Every side's straight part must have ink along most of it and every corner ink near it, so a triangle,
// an open shape or a blob never passes as a box.
function sidesHeld(sn: Extract<Snap, { kind: 'rect' }>, s: number[], tol: number, cornerTol: number) {
  const c = Math.cos(sn.rot), si = Math.sin(sn.rot), hw = sn.w / 2, hh = sn.h / 2, r = sn.r;
  const k = r * (1 - Math.SQRT1_2);
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const cu = u * (hw - k), cv = v * (hh - k);
    if (polyDist2(s, sn.cx + cu * c - cv * si, sn.cy + cu * si + cv * c, true) > cornerTol * cornerTol) return false;
  }
  const sides = [[-hw + r, -hh, hw - r, -hh], [hw, -hh + r, hw, hh - r], [hw - r, hh, -hw + r, hh], [-hw, hh - r, -hw, -hh + r]];
  for (const [au, av, bu, bv] of sides) {
    let ink = 0, closing = 0;
    for (let k = 0; k < 8; k++) {
      const t = (k + 0.5) / 8, u = au + (bu - au) * t, v = av + (bv - av) * t;
      const x = sn.cx + u * c - v * si, y = sn.cy + u * si + v * c;
      if (polyDist2(s, x, y) <= tol * tol) ink++;
      else if (polyDist2(s, x, y, true) <= tol * tol) closing++;
    }
    if (ink / 8 < SNAP.SIDE_DRAWN || (ink + closing) / 8 < SNAP.SIDE_SUPPORT) return false;
  }
  // The end gap may fill part of a side, never most of one: that side was never drawn (an open U).
  const n = s.length, g = Math.hypot(s[n - 2] - s[0], s[n - 1] - s[1]);
  const mx = (s[0] + s[n - 2]) / 2 - sn.cx, my = (s[1] + s[n - 1]) / 2 - sn.cy;
  const mu = mx * c + my * si, mv = -mx * si + my * c;
  const along = hw - Math.abs(mu) < hh - Math.abs(mv) ? sn.h : sn.w;
  return g <= SNAP.GAP_SIDE * along;
}

// The closed part of a stroke: where its end comes back nearest its start, with any tail running past that
// point (an overshoot, or a start drawn down a side) trimmed off. Null when the ends never meet within `tol`.
function closeLoop(s: number[], tol: number) {
  const n = s.length / 2, w = Math.floor(n * SNAP.TAIL_MAX), step = pathLen(s) / (n - 1);
  let best = { i: 0, j: n - 1, d: Infinity, cost: Infinity };
  for (let i = 0; i <= w; i++) {
    for (let j = n - 1 - w; j < n; j++) {
      const d = Math.hypot(s[j * 2] - s[i * 2], s[j * 2 + 1] - s[i * 2 + 1]), cost = d + SNAP.TAIL_COST * step * (i + n - 1 - j);
      if (cost < best.cost) best = { i, j, d, cost };
    }
  }
  if (best.d > tol) return null;
  // Each tail runs from the stroke's end to its cut point, which comes last.
  const end: number[] = [];
  for (let k = n - 1; k >= best.j; k--) end.push(s[k * 2], s[k * 2 + 1]);
  const tails = [s.slice(0, best.i * 2 + 2), end];
  return { loop: s.slice(best.i * 2, best.j * 2 + 2), tails: tails.filter((t) => t.length >= 4) };
}

// A trimmed tail is fine when it retraces the outline, or is a short overshoot ending at a corner; a stem
// sticking out of the shape keeps the polygon from snapping.
function tailsOk(tails: number[][], pts: number[], total: number, d: number, px: number) {
  for (const t of tails) {
    if (pathLen(t) > SNAP.POLY_TAIL_MAX * total) return false;
    let far = 0;
    for (let k = 0; k < t.length; k += 2) far = Math.max(far, polyDist2(pts, t[k], t[k + 1], true));
    far = Math.sqrt(far);
    if (far <= Math.max(SNAP.POLY_TAIL_ON * d, 2 * px)) continue;
    const cx = t[t.length - 2], cy = t[t.length - 1], reach = Math.max(SNAP.POLY_TAIL_CORNER * d, 8 * px);
    let corner = false;
    for (let k = 0; k < pts.length; k += 2) if (Math.hypot(pts[k] - cx, pts[k + 1] - cy) <= reach) corner = true;
    if (!corner || far > Math.max(SNAP.POLY_TAIL_DIST * d, 8 * px)) return false;
  }
  return true;
}

type Line2 = { x: number; y: number; dx: number; dy: number };

// Least-squares line through samples a..b (indices mod n), pointing along the stroke; near-level or plumb sides snap.
function sideLine(p: number[], n: number, a: number, b: number): Line2 {
  const cut = Math.floor((b - a) * SNAP.POLY_TRIM), lo = b - a >= 4 ? a + cut : a, hi = b - a >= 4 ? b - cut : b;
  let mx = 0, my = 0, k = 0;
  for (let i = lo; i <= hi; i++) (mx += p[(i % n) * 2]), (my += p[(i % n) * 2 + 1]), k++;
  mx /= k;
  my /= k;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = lo; i <= hi; i++) {
    const dx = p[(i % n) * 2] - mx, dy = p[(i % n) * 2 + 1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  let phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const deg = ((phi / DEG) % 180 + 180) % 180;
  if (Math.min(deg, 180 - deg) < SNAP.POLY_AXIS_DEG) phi = 0;
  else if (Math.abs(deg - 90) < SNAP.POLY_AXIS_DEG) phi = Math.PI / 2;
  let dx = Math.cos(phi), dy = Math.sin(phi);
  const ex = p[(b % n) * 2] - p[(a % n) * 2], ey = p[(b % n) * 2 + 1] - p[(a % n) * 2 + 1];
  if (dx * ex + dy * ey < 0) (dx = -dx), (dy = -dy);
  return { x: mx, y: my, dx, dy };
}

// Worst distance from one line to the middle of samples a..b (indices mod n, a may be negative).
function spanDev(p: number[], n: number, a: number, b: number) {
  if (a < 0) (a += n), (b += n);
  const l = sideLine(p, n, a, b), cut = Math.floor((b - a) * SNAP.POLY_TRIM);
  let max = 0;
  for (let i = a + cut; i <= b - cut; i++) max = Math.max(max, Math.abs((p[(i % n) * 2 + 1] - l.y) * l.dx - (p[(i % n) * 2] - l.x) * l.dy));
  return max;
}

const turnDeg = (ax: number, ay: number, bx: number, by: number) => {
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  return la && lb ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) / DEG : 0;
};

function meet(l: Line2, m: Line2): [number, number] | null {
  const den = l.dx * m.dy - l.dy * m.dx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((m.x - l.x) * m.dy - (m.y - l.y) * m.dx) / den;
  return [l.x + l.dx * t, l.y + l.dy * t];
}

function rdp(p: number[], a: number, b: number, eps2: number, out: number[]) {
  let far = -1, fd = eps2;
  for (let i = a + 1; i < b; i++) {
    const d = segDist2(p[i * 2], p[i * 2 + 1], p[a * 2], p[a * 2 + 1], p[b * 2], p[b * 2 + 1]);
    if (d > fd) (fd = d), (far = i);
  }
  if (far < 0) return;
  rdp(p, a, far, eps2, out);
  out.push(far);
  rdp(p, far, b, eps2, out);
}

type PolyFit = { pts: number[]; turns: number[]; why: string | null };

// Corners by Ramer-Douglas-Peucker, then near-straight corners and tiny sides merge away; each side becomes the
// least-squares line through its middle and the corners its neighbours' crossings. `p` is evenly resampled.
function fitPoly(p: number[], closed: boolean, eps: number, free: number): PolyFit | null {
  const n = p.length / 2;
  if (n < 8) return null;
  let v: number[] = [0];
  if (closed) {
    let far = 0, fd = -1;
    for (let i = 1; i < n; i++) {
      const d = (p[i * 2] - p[0]) ** 2 + (p[i * 2 + 1] - p[1]) ** 2;
      if (d > fd) (fd = d), (far = i);
    }
    rdp(p, 0, far, eps * eps, v);
    v.push(far);
    rdp(p, far, n - 1, eps * eps, v);
  } else {
    rdp(p, 0, n - 1, eps * eps, v);
    v.push(n - 1);
  }
  // Side k runs from v[k] to v[k + 1]; a closed outline's last side wraps through the start.
  const sides = () => (closed ? v.length : v.length - 1);
  const end = (k: number) => (k + 1 < v.length ? v[k + 1] : v[0] + n);
  let lines: Line2[] = [], turns: number[] = [];
  for (let guard = 0; guard < 64; guard++) {
    const m = sides();
    if (m < (closed ? 3 : 1)) return null;
    lines = [];
    for (let k = 0; k < m; k++) lines.push(sideLine(p, n, v[k], end(k)));
    // Turn at vertex k, between side k - 1 and side k; an open stroke's ends never turn.
    turns = v.map((_, k) => (!closed && (k === 0 || k === v.length - 1) ? 180 : turnDeg(lines[(k - 1 + m) % m].dx, lines[(k - 1 + m) % m].dy, lines[k].dx, lines[k].dy)));
    let short = -1;
    for (let k = 0; k < m; k++) if ((end(k) - v[k]) / n < SNAP.POLY_MIN_SIDE && (short < 0 || end(k) - v[k] < end(short) - v[short])) short = k;
    if (short >= 0 && m > (closed ? 3 : 1)) {
      const k2 = (short + 1) % v.length;
      if (!closed && short === 0) v.splice(1, 1);
      else if (!closed && k2 === v.length - 1) v.splice(short, 1);
      else {
        const mid = Math.round((v[short] + end(short)) / 2) % n;
        v = v.filter((_, k) => k !== short && k !== k2);
        v.push(mid);
        v.sort((a, b) => a - b);
      }
      continue;
    }
    let weak = -1;
    for (let k = 0; k < v.length; k++) if (turns[k] < SNAP.POLY_MERGE_DEG && (weak < 0 || turns[k] < turns[weak])) weak = k;
    // A corner from a wobble: one straight line covers both its sides as well as the corner search tolerance.
    if (weak < 0 && m > (closed ? 3 : 1)) {
      let best = eps;
      for (let k = closed ? 0 : 1; k < (closed ? v.length : v.length - 1); k++) {
        const a = k ? v[k - 1] : v[v.length - 1] - n, b = end(k), d = spanDev(p, n, a, b);
        if (d <= best) (best = d), (weak = k);
      }
    }
    if (weak < 0) break;
    v.splice(weak, 1);
  }
  const m = sides(), pts: number[] = [];
  for (let k = 0; k < v.length; k++) {
    if (!closed && (k === 0 || k === v.length - 1)) {
      // Open ends: the stroke's end projected onto its side's line.
      const l = lines[k === 0 ? 0 : m - 1], i = v[k], t = (p[i * 2] - l.x) * l.dx + (p[i * 2 + 1] - l.y) * l.dy;
      pts.push(l.x + l.dx * t, l.y + l.dy * t);
      continue;
    }
    const q = meet(lines[(k - 1 + m) % m], lines[k % m]);
    if (!q) return null;
    pts.push(q[0], q[1]);
  }
  if (closed ? m < 3 || m > SNAP.POLY_MAX_SIDES : m < 2 || m > SNAP.OPEN_MAX_SIDES) return { pts, turns, why: `${m} sides` };
  // The ink's gap to each corner gives the radius it was rounded with; a curve cut into sides has corners
  // about as round as the sides are long.
  const np = pts.length / 2, len = (a: number, b: number) => Math.hypot(pts[b * 2] - pts[a * 2], pts[b * 2 + 1] - pts[a * 2 + 1]);
  for (let k = closed ? 0 : 1; k < (closed ? np : np - 1); k++) {
    if (!closed && turns[k] < SNAP.OPEN_TURN_DEG) return { pts, turns, why: 'soft bend' };
    // Lumps on a circle make corners of uneven, often shallow turns.
    if (closed && m >= 5 && turns[k] < SNAP.POLY_MANY_DEG) return { pts, turns, why: 'soft corner' };
    const gap = Math.max(0, Math.sqrt(polyDist2(p, pts[k * 2], pts[k * 2 + 1], closed)) - free);
    const r = gap / (1 / Math.cos((turns[k] * DEG) / 2) - 1);
    if (r > SNAP.POLY_ROUND * Math.min(len(k, (k + 1) % np), len(k, (k - 1 + np) % np))) return { pts, turns, why: 'round corner' };
  }
  if (closed) {
    // The end gap may close part of a side, never most of one (an open U is not a box).
    const gap = Math.hypot(p[n * 2 - 2] - p[0], p[n * 2 - 1] - p[1]);
    const k = v.length - 1, a = pts.length / 2;
    const side = Math.hypot(pts[(k * 2 + 2) % (a * 2)] - pts[k * 2], pts[(k * 2 + 3) % (a * 2)] - pts[k * 2 + 1]);
    if (gap > SNAP.GAP_SIDE * side) return { pts, turns, why: 'gap' };
  }
  return { pts, turns, why: null };
}

const polyContour = (pts: number[], closed: boolean, step: number) => {
  const c = closed ? [...pts, pts[0], pts[1]] : pts, out = [c[0], c[1]];
  for (let i = 2; i < c.length; i += 2) {
    const k = Math.max(1, Math.min(256, Math.ceil(Math.hypot(c[i] - c[i - 2], c[i + 1] - c[i - 1]) / step)));
    for (let j = 1; j <= k; j++) out.push(c[i - 2] + ((c[i] - c[i - 2]) * j) / k, c[i - 1] + ((c[i + 1] - c[i - 1]) * j) / k);
  }
  return out;
};

// Interior angles all near 90 degrees: a box, which the rect fit draws better.
const squarish = (turns: number[]) => turns.length === 4 && turns.every((t) => Math.abs(t - 90) <= SNAP.POLY_RECT_DEG);

// An open stroke of a few straight segments with sharp bends (an L, a short zigzag) becomes an open polyline.
function openPoly(fine: number[], s: number[], D: number, px: number): Recognition {
  const f = fitPoly(fine, false, Math.max(SNAP.POLY_RDP * D, 2 * px), Math.max(SNAP.POLY_GAP_FREE * D, 1.5 * px));
  if (!f) return { snap: null, why: 'open', candidates: [] };
  const floor = SNAP.FIT_FLOOR_PX * px, contour = polyContour(f.pts, false, Math.max(2 * px, pathLen(f.pts) / 96)), t = twoWay(s, false, contour);
  const ok = !f.why && t.rms <= Math.max(SNAP.OPEN_RMS * D, floor) && t.max <= Math.max(SNAP.OPEN_MAX * D, 2 * floor);
  const snap: Snap = { kind: 'poly', pts: f.pts, closed: false };
  const c: Candidate = { name: 'poly', snap, contour, score: t.rms / D, max: t.max / D, ok, ...(f.why && { note: f.why }) };
  return ok ? { snap, why: 'polyline', candidates: [c] } : { snap: null, why: `open${f.why ? ` (${f.why})` : ''}`, candidates: [c] };
}

// `px` is world units per CSS px.
export function recognize(raw: readonly number[], px: number): Recognition {
  const none = (why: string, candidates: Candidate[] = []): Recognition => ({ snap: null, why, candidates });
  const len = pathLen(raw);
  if (raw.length < 6 || len < SNAP.MIN_LEN_PX * px) return none('short');
  const s0 = resample(raw, SNAP.SAMPLES);
  const bb0 = bboxOf(s0, 0), D0 = Math.hypot(bb0.x1 - bb0.x0, bb0.y1 - bb0.y0);
  const floor = SNAP.FIT_FLOOR_PX * px;
  const n = s0.length;
  const chord = Math.hypot(s0[n - 2] - s0[0], s0[n - 1] - s0[1]);

  // Measured on the resampled path, so hand tremor does not count as length.
  if (chord / pathLen(s0) >= SNAP.LINE_STRAIGHT) {
    const l = fitLine(s0, raw);
    const ok = l.rms <= Math.max(SNAP.LINE_RMS * D0, floor) && l.max <= Math.max(SNAP.LINE_MAX * D0, 2 * floor);
    const c: Candidate = { name: 'line', snap: l.snap, contour: [l.snap.x1, l.snap.y1, l.snap.x2, l.snap.y2], score: l.rms / D0, max: l.max / D0, ok };
    return ok ? { snap: l.snap, why: 'line', candidates: [c] } : none('wobbly line', [c]);
  }
  const fine = resample(raw, SNAP.POLY_SAMPLES);
  const closing = closeLoop(fine, Math.max(SNAP.CLOSE_GAP * D0, SNAP.CLOSE_GAP_PX * px));
  if (!closing) return openPoly(fine, s0, D0, px);
  const loop = closing.loop;

  // Boxes and ellipses are fitted to the whole stroke, as tuned; the polygon sees the loop with its tails trimmed.
  const s = s0, D = D0, ls = resample(loop, SNAP.SAMPLES), lb = bboxOf(ls, 0), LD = Math.hypot(lb.x1 - lb.x0, lb.y1 - lb.y0);
  // A closed shape is gone round about once: a spiral or a scribbled-over loop is not.
  const once = (on: number[], contour: number[]) => {
    const k = pathLen(on) / pathLen(contour);
    return k >= SNAP.TRAVERSE_MIN && k <= SNAP.TRAVERSE_MAX;
  };
  const fitOk = (rms: number, max: number, contour: number[], on = s, d = D) => rms <= Math.max(SNAP.FIT_RMS * d, floor) && max <= Math.max(SNAP.FIT_MAX * d, 3 * floor) && once(on, contour);
  const cands: Candidate[] = [];
  const add = (name: Candidate['name'], snap: Snap, contour: number[], extra = true, on = s, d = D) => {
    const t = twoWay(on, true, contour);
    const c: Candidate = { name, snap, contour, score: t.rms / d, max: t.max / d, ok: extra && fitOk(t.rms, t.max, contour, on, d) };
    cands.push(c);
    return c;
  };

  const e = fitEllipse(s);
  let ell: Candidate | null = null;
  if (e) {
    let { w, h, rot } = e;
    if (Math.abs(w - h) / Math.max(w, h) < SNAP.CIRCLE) (w = h = (w + h) / 2), (rot = 0);
    else if (Math.abs(rot) < SNAP.AXIS_DEG * DEG) rot = 0;
    const sn: Snap = { kind: 'ellipse', cx: e.cx, cy: e.cy, w, h, rot };
    // Scored on the raw fit, before the circle and level snaps.
    const fit = ellipseContour(e.cx, e.cy, e.w, e.h, e.rot, 96), t = twoWay(s, true, fit);
    ell = { name: 'ellipse', snap: sn, contour: ellipseContour(e.cx, e.cy, w, h, rot, 96), score: t.rms / D, max: t.max / D, ok: fitOk(t.rms, t.max, fit) };
    cands.push(ell);
  }

  // Coarse angle search, then a fine one around the best; the box is symmetric every 90 degrees.
  let best = { th: 0, rms: Infinity, b: null as Bounds | null };
  const tryAt = (th: number) => {
    const { q, b } = fitBox(s, th);
    const rms = boxRms(q, b, 0);
    if (rms < best.rms) best = { th, rms, b };
  };
  for (let d = 0; d < 90; d += SNAP.RECT_STEP_DEG) tryAt(d * DEG);
  const th0 = best.th;
  for (let d = -SNAP.RECT_STEP_DEG; d <= SNAP.RECT_STEP_DEG; d += SNAP.RECT_FINE_DEG) tryAt(th0 + d * DEG);
  let th = best.th;
  const deg = ((th / DEG) % 90 + 90) % 90;
  if (deg < SNAP.AXIS_DEG || deg > 90 - SNAP.AXIS_DEG) th = deg < 45 ? 0 : Math.PI / 2;
  const { q, b } = fitBox(s, th);
  const short = Math.min(b.u1 - b.u0, b.v1 - b.v0);
  const tol = Math.max(SNAP.SIDE_TOL * D, 3 * px), ctol = Math.max(SNAP.CORNER_TOL * D, 4 * px);
  const step = Math.max(2 * px, (2 * (b.u1 - b.u0 + b.v1 - b.v0)) / 96);
  const rectOf = (r: number) => rectSnap(b, th, r) as Extract<Snap, { kind: 'rect' }>;
  const contourOf = (sn: Extract<Snap, { kind: 'rect' }>) => rectContour(sn.cx, sn.cy, sn.w, sn.h, sn.rot, sn.r, step);
  const sharp = rectOf(0);
  const rect = add('rect', sharp, contourOf(sharp), short > 0 && sidesHeld(sharp, s, tol, ctol));
  let bestR = 0, bestRms = Infinity;
  const r0 = Math.max(SNAP.ROUND_MIN * short, SNAP.ROUND_MIN_PX * px), r1 = SNAP.ROUND_MAX * short;
  for (let k = 0; k <= 10 && r0 <= r1; k++) {
    const r = r0 + ((r1 - r0) * k) / 10, rms = boxRms(q, b, r);
    if (rms < bestRms) (bestRms = rms), (bestR = r);
  }
  let box = rect;
  if (bestR > 0) {
    const rr = rectOf(bestR);
    const round = add('round', rr, contourOf(rr), sidesHeld(rr, s, tol, ctol));
    if (round.ok && round.score <= SNAP.ROUND_GAIN * rect.score) box = round;
  }

  // A polygon joins only when it passed its own checks. Triangles and skewed quads are never boxes;
  // a near-square quad is the rect fit's, unless that fit failed.
  const pool: (Candidate | null)[] = [ell, box];
  const pf = fitPoly(loop, true, Math.max(SNAP.POLY_RDP * LD, 2 * px), Math.max(SNAP.POLY_GAP_FREE * LD, 1.5 * px));
  let poly: Candidate | null = null;
  if (pf) {
    const closedPts = [...pf.pts, pf.pts[0], pf.pts[1]];
    const tails = !pf.why && tailsOk(closing.tails, pf.pts, pathLen(fine), LD, px);
    poly = add('poly', { kind: 'poly', pts: pf.pts, closed: true }, polyContour(pf.pts, true, Math.max(2 * px, pathLen(closedPts) / 96)), !pf.why && tails, ls, LD);
    const sides = pf.pts.length / 2;
    if (pf.why) poly.note = pf.why;
    else if (!tails) poly.note = 'tail';
    const boxy = box.ok && sides === 4 && (squarish(pf.turns) || poly.score > SNAP.POLY_GAIN * box.score);
    if (poly.ok && !boxy) {
      if (sides <= 4) pool.splice(1, 1);
      pool.push(poly);
    }
  }

  // A lumpy circle fits a big-radius rounded rect, or a many-sided polygon, about as well as an ellipse;
  // the ellipse is the likelier intent.
  const rival = pool.includes(box) && box.name === 'round' ? SNAP.ELLIPSE_BIAS : 1;
  const bias = Math.min(rival, poly && pool.includes(poly) && poly.snap.kind === 'poly' && poly.snap.pts.length > 8 ? SNAP.POLY_ELLIPSE_BIAS : 1);
  const rank = (c: Candidate) => (c === ell ? c.score * bias : c.score);
  const ranked = pool.filter((c): c is Candidate => !!c).sort((x, y) => rank(x) - rank(y));
  const [win, next] = ranked;
  if (!win?.ok) return none('no fit', cands);
  if (next && rank(win) > SNAP.WIN * rank(next)) return none(`ambiguous ${win.name}/${next.name}`, cands);
  return { snap: win.snap, why: win.name, candidates: cands };
}
