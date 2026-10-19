import { bboxOf, round2, shift, splitByMask, pathLen, type Mask } from './geom.ts';
import { newId } from './pencil.ts';
import type { Scene } from './scene.ts';
import { coverage, moveShape } from './shapes.ts';
import type { El, Stroke } from './types.ts';

// The pieces of one element on each side of a mask. A wholly inside element comes back as itself,
// so its id and cached outline survive.
export type Cut = { inside: El[]; outside: El[] };

// Split pieces keep the parent's z, so they stay at its place in paint order.
export const piece = (src: Stroke, pts: number[]): Stroke => ({ ...src, id: newId(), pts, bbox: bboxOf(pts, src.size / 2 + 1) });

// Null when the mask misses the element. Zero-length pieces are always dropped; the eraser also drops specks
// shorter than `minLen`, while lasso actions pass 0 so no ink outside the selection is lost.
export function cutEl(el: El, m: Mask, minLen = 0): Cut | null {
  if (el.kind !== 'stroke') return coverage(el, m) > 0.5 ? { inside: [el], outside: [] } : null;
  const s = splitByMask(el.pts, m);
  if (!s) return null;
  if (!s.outside.length) return { inside: [el], outside: [] };
  const keep = (runs: number[][]) =>
    runs.filter((r) => { const len = pathLen(r); return len > 0 && len >= minLen; }).map((r) => piece(el, r));
  return { inside: keep(s.inside), outside: keep(s.outside) };
}

// How much of an element a mask holds: by length for strokes, as the lasso rule measures it for shapes.
export function share(el: El, m: Mask) {
  if (el.kind !== 'stroke') return coverage(el, m);
  if (el.pts.length <= 2) return m.inside(el.pts[0], el.pts[1]) ? 1 : 0;
  const s = splitByMask(el.pts, m);
  if (!s) return 0;
  if (!s.outside.length) return 1;
  const len = (runs: number[][]) => runs.reduce((t, r) => t + pathLen(r), 0);
  const a = len(s.inside), b = len(s.outside);
  return a + b > 0 ? a / (a + b) : 0;
}

const byZ = (a: El, b: El) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// What a mask takes from the scene: `touched` elements become `outside` plus `inside`, in paint order.
export function cutRegion(scene: Scene, m: Mask) {
  const touched: El[] = [], inside: El[] = [], outside: El[] = [];
  for (const el of scene.index.query(m.bbox)) {
    const c = cutEl(el, m);
    if (!c?.inside.length) continue;
    touched.push(el);
    inside.push(...c.inside);
    outside.push(...c.outside);
  }
  touched.sort(byZ);
  inside.sort(byZ);
  return { touched, inside, outside };
}

// Same id and z: a moved element replaces itself in history.
export function moveEl(el: El, dx: number, dy: number): El {
  if (el.kind !== 'stroke') return moveShape(el, dx, dy);
  return { ...el, pts: el.pts.map((v, i) => round2(v + (i & 1 ? dy : dx))), bbox: shift(el.bbox, dx, dy) };
}

// How far an element's paint reaches past its geometry.
export function inkPad(el: El) {
  switch (el.kind) {
    case 'text':
    case 'image':
      return 1;
    case 'icon':
      return el.w / 24 + 1;
    default:
      return el.size / 2;
  }
}
