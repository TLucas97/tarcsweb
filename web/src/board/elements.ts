// Board elements JSON, documented for models in server/board/schema.ts (BOARD_SCHEMA); keep the two in step.
import { z } from 'zod';
import { bboxOf, round2, simplify } from './geom.ts';
import type { Region } from './lasso.ts';
import { newId } from './pencil.ts';
import { FONT_MAX, labelWidth, LINE_HEIGHT, makeText, measureText, shape, SHAPE_SIZE, TEXT_MAX, wrapText } from './shapes.ts';
import { INK, type Box, type El, type Ellipse, type Icon, type Line, type Poly, type Rect, type Stroke } from './types.ts';

const LIMIT = 100_000;
// Freehand strokes are summarized to at most this many points.
const MAX_PTS = 24;
const MAX_VIA = 254;
const MAX_ELEMENTS = 2000;
// Smallest fitted box side in world units, so an element never collapses to zero.
const MIN_FIT = 2;

const int = z.number().int().min(-LIMIT).max(LIMIT);
const size = z.number().int().min(1).max(LIMIT);
const xy = z.tuple([int, int]);
// role "note" marks an annotation: the annotation color unless a color is given, and smaller default text.
const style = {
  id: z.string().max(64).optional(),
  color: z.string().regex(/^(ink|gray|accent|note|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/).optional(),
  strokeWidth: z.number().int().min(1).max(64).optional(),
  role: z.literal('note').optional(),
};
const dash = { dash: z.enum(['solid', 'dashed', 'dotted']).optional() };
const fill = { fill: z.enum(['none', 'light', 'medium']).optional() };
const box = { x: int, y: int, w: size, h: size };
// Text inside a rect or ellipse, wrapped to its width and centered; labelSize is its font size.
const label = { label: z.string().min(1).max(TEXT_MAX).optional(), labelSize: z.number().int().min(1).max(FONT_MAX).optional() };

const ElementJson = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('rect'), ...box, r: z.number().int().min(0).max(LIMIT).optional(), rot: int.optional(), ...style, ...dash, ...fill, ...label }),
  z.strictObject({ kind: z.literal('ellipse'), ...box, rot: int.optional(), ...style, ...dash, ...fill, ...label }),
  z.strictObject({ kind: z.literal('line'), from: xy, to: xy, ...style, ...dash }),
  // via: points the arrow curves through between from and to.
  z.strictObject({ kind: z.literal('arrow'), from: xy, to: xy, via: z.array(xy).max(MAX_VIA).optional(), ...style, ...dash }),
  z.strictObject({ kind: z.literal('poly'), pts: z.array(xy).min(2).max(256), closed: z.boolean().optional(), ...style, ...dash, ...fill }),
  // align "center" centers the lines on each other; rot turns the text about its box center.
  z.strictObject({ kind: z.literal('text'), x: int, y: int, text: z.string().min(1).max(TEXT_MAX), size: z.number().int().min(1).max(FONT_MAX).optional(), w: size.optional(), h: size.optional(), align: z.enum(['left', 'center']).optional(), rot: int.optional(), ...style }),
  z.strictObject({ kind: z.literal('icon'), ...box, name: z.string().min(1).max(64), ...style }),
  z.strictObject({ kind: z.literal('stroke'), x: int.optional(), y: int.optional(), w: z.number().int().min(0).max(LIMIT).optional(), h: z.number().int().min(0).max(LIMIT).optional(), pts: z.array(xy).min(2).max(512), ...style, ...dash }),
]);

// Text size when the JSON leaves it out.
const TEXT_SIZE = 16;
const NOTE_SIZE = 13;
const textSize = (j: { size?: number; role?: 'note' }) => j.size ?? (j.role === 'note' ? NOTE_SIZE : TEXT_SIZE);
// Text that would need shrinking more than this to stay near the region is rejected as unreadable.
const TEXT_SHRINK_MAX = 3;

// The font size at which a text's measured lines stay within the spill the bounds check allows.
function fitText(j: { x: number; y: number; text: string; size?: number; role?: 'note' }, w: number, h: number) {
  const size = textSize(j), m = measureText(j.text, size), spill = Math.max(w, h) / 2;
  return size * Math.min(1, (w + spill - j.x) / m.w, (h + spill - j.y) / m.h);
}

// Same policy for a label: the wrapped block, centered on its shape, must stay within the spill. Shrinking rewraps
// it; 0 when it would need more than TEXT_SHRINK_MAX.
function fitLabelJson(j: { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; rot?: number; label: string; labelSize?: number; role?: 'note' }, w: number, h: number) {
  const spill = Math.max(w, h) / 2, cx = j.x + j.w / 2, cy = j.y + j.h / 2;
  const hx = Math.min(cx + spill, w + spill - cx), hy = Math.min(cy + spill, h + spill - cy);
  const base = textSize({ size: j.labelSize, role: j.role }), maxW = labelWidth(j);
  for (let f = base; f >= base / TEXT_SHRINK_MAX; f *= 0.8) {
    const b = wrapText(j.label, f, maxW), bh = b.lines.length * f * LINE_HEIGHT;
    // A turned block can reach its half diagonal along either axis.
    const ex = j.rot ? Math.hypot(b.w, bh) / 2 : b.w / 2, ey = j.rot ? ex : bh / 2;
    if (ex <= hx && ey <= hy) return f;
  }
  return 0;
}

// A pasted picture: exported so a model knows where it sits, never accepted back (there are no pixels in JSON).
const ImageJson = z.strictObject({ kind: z.literal('image'), ...box, id: style.id });

type ElementJson = z.infer<typeof ElementJson>;
type ImageJson = z.infer<typeof ImageJson>;

// Every point an element reaches, so geometry can be held to the document's size.
function reach(j: ElementJson | ImageJson): number[] {
  switch (j.kind) {
    case 'line':
      return [...j.from, ...j.to];
    case 'arrow':
      return [...j.from, ...j.to, ...(j.via ?? []).flat()];
    case 'stroke':
    case 'poly':
      return j.pts.flat();
    case 'text':
      return [j.x, j.y, j.x + textSize(j), j.y + textSize(j)];
    default:
      return [j.x, j.y, j.x + j.w, j.y + j.h];
  }
}

// Geometry may spill past the document by half its larger side, never more: fitting scales the document,
// so anything far outside would blow up into huge world geometry.
function inBounds(d: { w: number; h: number; elements: (ElementJson | ImageJson)[] }, ctx: z.RefinementCtx) {
  const m = Math.max(d.w, d.h) / 2;
  d.elements.forEach((j, i) => {
    const p = reach(j);
    for (let k = 0; k < p.length; k += 2) {
      if (p[k] < -m || p[k] > d.w + m || p[k + 1] < -m || p[k + 1] > d.h + m) {
        ctx.addIssue({ code: 'custom', path: ['elements', i], message: `Element reaches (${p[k]}, ${p[k + 1]}), far outside the ${d.w}x${d.h} document` });
        return;
      }
    }
  });
}
export const BoardJson = z.strictObject({ w: size, h: size, elements: z.array(ElementJson).max(MAX_ELEMENTS) }).superRefine(inBounds);
export type BoardJson = z.infer<typeof BoardJson>;
// What toJSON exports: the same plus pictures.
const ExportJson = z.strictObject({ w: size, h: size, elements: z.array(z.union([ElementJson, ImageJson])).max(MAX_ELEMENTS) }).superRefine(inBounds);
export type ExportJson = z.infer<typeof ExportJson>;

const toDeg = (rad: number) => Math.round((rad * 180) / Math.PI);

export type Exported = { ok: true; json: ExportJson } | { ok: false; error: string };

// The region's content as JSON: strokes cut at the lasso edge, shapes that are more than half inside.
// Checked against the schema, so content it cannot hold (too many elements, huge text) is an error, not bad JSON.
export function toJSON(region: Region): Exported {
  const json = build(region);
  const r = ExportJson.safeParse(json);
  return r.success ? { ok: true, json } : { ok: false, error: `Cannot export this selection: ${z.prettifyError(r.error)}` };
}

const pairsOf = (pts: readonly number[], X: (v: number) => number, Y: (v: number) => number) => {
  const pairs: [number, number][] = [];
  for (let k = 0; k < pts.length; k += 2) pairs.push([X(pts[k]), Y(pts[k + 1])]);
  if (pairs.length === 1) pairs.push([...pairs[0]]);
  return pairs;
};

function build(region: Region): ExportJson {
  const ox = Math.floor(region.bbox.x0), oy = Math.floor(region.bbox.y0);
  const X = (v: number) => Math.round(v - ox), Y = (v: number) => Math.round(v - oy);
  const elements = region.inside.map((el, i): ElementJson | ImageJson => {
    const id = String(i + 1);
    const bx = (b: { x: number; y: number; w: number; h: number }) => ({ x: X(b.x), y: Y(b.y), w: Math.max(1, Math.round(b.w)), h: Math.max(1, Math.round(b.h)) });
    if (el.kind === 'image') return { id, kind: 'image', ...bx(el) };
    // The annotation color alone also reads as a note; a note's color is written only when it differs.
    const note = el.role === 'note' || el.color === 'note';
    const st = {
      ...(note && { role: 'note' as const }),
      ...(el.color !== INK && !(note && el.color === 'note') && { color: el.color }),
      ...('size' in el && el.size !== SHAPE_SIZE && { strokeWidth: Math.min(64, Math.max(1, Math.round(el.size))) }),
      ...('dash' in el && el.dash && { dash: el.dash }),
    };
    const fl = 'fill' in el && el.fill ? { fill: el.fill } : {};
    const lb = (el.kind === 'rect' || el.kind === 'ellipse') && el.label ? { label: el.label.text, labelSize: Math.min(FONT_MAX, Math.max(1, Math.round(el.label.fontSize))) } : {};
    switch (el.kind) {
      case 'poly':
        return { id, kind: 'poly', pts: pairsOf(el.pts, X, Y), ...(el.closed && { closed: true, ...fl }), ...st };
      case 'rect':
        return { id, kind: 'rect', ...bx(el), ...(el.r > 0.5 && { r: Math.round(el.r) }), ...(toDeg(el.rot) && { rot: toDeg(el.rot) }), ...st, ...fl, ...lb };
      case 'ellipse':
        return { id, kind: 'ellipse', ...bx(el), ...(toDeg(el.rot) && { rot: toDeg(el.rot) }), ...st, ...fl, ...lb };
      case 'line':
        return { id, kind: el.kind, from: [X(el.x1), Y(el.y1)], to: [X(el.x2), Y(el.y2)], ...st };
      case 'arrow': {
        if (!el.pts) return { id, kind: 'arrow', from: [X(el.x1), Y(el.y1)], to: [X(el.x2), Y(el.y2)], ...st };
        let eps = 1, pts = [...el.pts];
        while (pts.length / 2 > MAX_PTS) pts = simplify(el.pts, (eps *= 1.5));
        const pairs = pairsOf(pts, X, Y);
        return { id, kind: 'arrow', from: pairs[0], to: pairs[pairs.length - 1], via: pairs.slice(1, -1), ...st };
      }
      case 'text':
        return { id, kind: 'text', x: X(el.x), y: Y(el.y), text: el.text, size: Math.max(1, Math.round(el.fontSize)), ...(el.align && { align: el.align }), ...(toDeg(el.rot ?? 0) && { rot: toDeg(el.rot ?? 0) }), ...st };
      case 'icon':
        return { id, kind: 'icon', ...bx(el), name: el.name, ...st };
      case 'stroke': {
        const b = bboxOf(el.pts, 0);
        let eps = Math.max(1, Math.hypot(b.x1 - b.x0, b.y1 - b.y0) * 0.01), pts = simplify(el.pts, eps);
        while (pts.length / 2 > MAX_PTS) pts = simplify(el.pts, (eps *= 1.5));
        return { id, kind: 'stroke', x: X(b.x0), y: Y(b.y0), w: Math.round(b.x1 - b.x0), h: Math.round(b.y1 - b.y0), pts: pairsOf(pts, X, Y), ...st };
      }
    }
  });
  return { w: Math.max(1, Math.ceil(region.bbox.x1) - ox), h: Math.max(1, Math.ceil(region.bbox.y1) - oy), elements };
}

export type Parsed = { ok: true; elements: El[] } | { ok: false; error: string };

// Validates JSON (a string or a parsed value) and builds new elements scaled uniformly and centered into `target`.
// Nothing is built when any part is off-schema.
export function fromJSON(input: unknown, target: Box, nextZ: () => number): Parsed {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
    }
  }
  const r = BoardJson.safeParse(data);
  if (!r.success) return { ok: false, error: z.prettifyError(r.error) };
  const { w, h, elements } = r.data;
  const tw = target.x1 - target.x0, th = target.y1 - target.y0;
  if (!(tw > 0 && th > 0)) return { ok: false, error: 'Target box is empty' };
  const k = Math.min(tw / w, th / h);
  const ox = target.x0 + (tw - w * k) / 2, oy = target.y0 + (th - h * k) / 2;
  const X = (v: number) => round2(ox + v * k), Y = (v: number) => round2(oy + v * k), L = (v: number) => Math.max(MIN_FIT, round2(v * k));
  const fonts: number[] = [];
  const tooLong = (t: string) => ({ ok: false as const, error: `Text "${t.slice(0, 40).replace(/\s+/g, ' ')}" is too long for the ${w}x${h} region` });
  for (const [i, j] of elements.entries()) {
    if (j.kind === 'text') {
      const f = fitText(j, w, h);
      if (f < textSize(j) / TEXT_SHRINK_MAX) return tooLong(j.text);
      fonts[i] = f;
    } else if ((j.kind === 'rect' || j.kind === 'ellipse') && j.label) {
      const f = fitLabelJson({ ...j, label: j.label }, w, h);
      if (!f) return tooLong(j.label);
      fonts[i] = f;
    }
  }
  const out = elements.map((j, i): El => {
    const base = { id: newId(), z: nextZ(), color: j.color ?? (j.role === 'note' ? 'note' : INK), ...(j.role === 'note' && { role: j.role }) };
    const sz = j.strokeWidth ?? SHAPE_SIZE;
    const ln = { ...base, size: sz, ...('dash' in j && j.dash && j.dash !== 'solid' && { dash: j.dash }) };
    const fl = 'fill' in j && j.fill && j.fill !== 'none' ? { fill: j.fill } : {};
    const lb = 'label' in j && j.label ? { label: { text: j.label, fontSize: Math.min(FONT_MAX, Math.max(1, round2(fonts[i] * k))) } } : {};
    switch (j.kind) {
      case 'rect':
        return shape<Rect>({ kind: 'rect', ...ln, ...fl, ...lb, x: X(j.x), y: Y(j.y), w: L(j.w), h: L(j.h), rot: ((j.rot ?? 0) * Math.PI) / 180, r: round2((j.r ?? 0) * k) });
      case 'ellipse':
        return shape<Ellipse>({ kind: 'ellipse', ...ln, ...fl, ...lb, x: X(j.x), y: Y(j.y), w: L(j.w), h: L(j.h), rot: ((j.rot ?? 0) * Math.PI) / 180 });
      case 'line':
        return shape<Line>({ kind: j.kind, ...ln, x1: X(j.from[0]), y1: Y(j.from[1]), x2: X(j.to[0]), y2: Y(j.to[1]) });
      case 'arrow': {
        const pts = j.via?.length ? [j.from, ...j.via, j.to].flatMap(([x, y]) => [X(x), Y(y)]) : null;
        return shape<Line>({ kind: 'arrow', ...ln, x1: X(j.from[0]), y1: Y(j.from[1]), x2: X(j.to[0]), y2: Y(j.to[1]), ...(pts && { pts }) });
      }
      case 'poly':
        return shape<Poly>({ kind: 'poly', ...ln, ...(j.closed && fl), pts: j.pts.flatMap(([x, y]) => [X(x), Y(y)]), closed: j.closed ?? false });
      case 'text':
        return makeText({ ...base, x: X(j.x), y: Y(j.y), text: j.text, fontSize: Math.min(FONT_MAX, Math.max(1, round2(fonts[i] * k))), ...(j.align === 'center' && { align: 'center' as const }), ...(j.rot && { rot: (j.rot * Math.PI) / 180 }) });
      case 'icon':
        return shape<Icon>({ kind: 'icon', ...base, x: X(j.x), y: Y(j.y), w: L(j.w), h: L(j.h), name: j.name });
      case 'stroke': {
        const pts = j.pts.flatMap(([x, y]) => [X(x), Y(y)]);
        const el: Stroke = { kind: 'stroke', ...ln, pts, bbox: bboxOf(pts, sz / 2 + 1) };
        return el;
      }
    }
  });
  return { ok: true, elements: out };
}
