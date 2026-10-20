import { grow, union } from './geom.ts';
import type { Region } from './lasso.ts';
import { drawEl, type Palette } from './render.ts';
import type { Box, El } from './types.ts';

// Board pictures: the whole drawing with a region marked (the model's overview), or just the selection (the chat).

// Fixed dark ink on white, so the picture reads the same whatever the board's theme.
export const SNAP_PAL: Palette = { ink: '#1f1e1c', grid: 'transparent', accent: '#c2410c' };
// Light enough that the neighbours' style still reads.
const DIM = 0.35;
// Frame line and its gap around a 'box' region, in output px.
const FRAME_PX = 3;
const FRAME_PAD = 8;
const BORDER = '#d9d5cc';

export type Snapshot = { blob: Blob; box: Box; scale: number; w: number; h: number };

type Opts = {
  maxPx: number;
  maxScale: number;
  // World units around the content.
  pad: number;
  // 'lasso' outlines the lasso itself; 'box' frames its bounds, padded, plus a thin border around the whole picture.
  frame: 'lasso' | 'box';
};

// Every element's box joined with the region's, so an empty region off to the side still shows.
function contentBox(els: readonly El[], region: Region): Box {
  let b = region.bbox;
  for (const el of els) b = union(b, el.bbox);
  return b;
}

// The elements drawn on white, fitted to `box`.
function paint(els: readonly El[], box: Box, o: Pick<Opts, 'maxPx' | 'maxScale'>) {
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const s = Math.min(o.maxScale, o.maxPx / Math.max(bw, bh));
  const w = Math.max(1, Math.min(o.maxPx, Math.round(bw * s))), h = Math.max(1, Math.min(o.maxPx, Math.round(bh * s)));
  const cv = new OffscreenCanvas(w, h);
  const c = cv.getContext('2d')!;
  c.fillStyle = '#fff';
  c.fillRect(0, 0, w, h);
  c.setTransform(s, 0, 0, s, -box.x0 * s, -box.y0 * s);
  for (const el of els) drawEl(c, el, SNAP_PAL);
  return { cv, c, s, w, h, bw, bh };
}

// Only these elements, cropped to them; null when there are none.
export function elementsPng(els: readonly El[], o: Pick<Opts, 'maxPx' | 'maxScale' | 'pad'>): Promise<Snapshot> | null {
  if (!els.length) return null;
  let b = els[0].bbox;
  for (const el of els) b = union(b, el.bbox);
  const box = grow(b, o.pad);
  const { cv, s, w, h } = paint(els, box, o);
  return cv.convertToBlob({ type: 'image/png' }).then((blob) => ({ blob, box, scale: s, w, h }));
}

export function drawingPng(els: readonly El[], region: Region, o: Opts): Promise<Snapshot> {
  const box = grow(contentBox(els, region), o.pad);
  const { cv, c, s, w, h, bw, bh } = paint(els, box, o);
  const mark = new Path2D();
  if (o.frame === 'lasso') {
    const p = region.poly;
    mark.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) mark.lineTo(p[i], p[i + 1]);
    mark.closePath();
  } else {
    const f = grow(region.bbox, FRAME_PAD / s);
    mark.roundRect(f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0, 6 / s);
  }
  // Everything outside the mark fades, so the region stands out.
  const fade = new Path2D();
  fade.rect(box.x0, box.y0, bw, bh);
  fade.addPath(mark);
  c.fillStyle = `rgb(255 255 255 / ${DIM})`;
  c.fill(fade, 'evenodd');
  c.strokeStyle = SNAP_PAL.accent;
  c.lineWidth = FRAME_PX / s;
  c.lineJoin = 'round';
  c.stroke(mark);
  if (o.frame === 'box') {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.strokeStyle = BORDER;
    c.lineWidth = 2;
    c.strokeRect(1, 1, w - 2, h - 2);
  }
  return cv.convertToBlob({ type: 'image/png' }).then((blob) => ({ blob, box, scale: s, w, h }));
}
