import { bboxOf } from './geom.ts';
import { fitLabel, makeText, shape, SHAPE_SIZE } from './shapes.ts';
import type { ToolId } from './tool.ts';
import type { Dash, El, Ellipse, Fill, Poly, Rect, Shape } from './types.ts';
import { INK } from './types.ts';

// The style controls: what an element shows and what the next stroke, shape or text gets.

export type DashOpt = 'solid' | Dash;
export type FillOpt = 'none' | Fill;
export type Style = { color: string; width: number; dash: DashOpt; fill: FillOpt; radius: number; font: number };
export type StyleKey = keyof Style;
export type StylePatch = Partial<Style>;
// Per control: its value, null when the selection mixes values, absent when nothing selected supports it.
export type Summary = { [K in StyleKey]?: Style[K] | null };

export const COLORS = [
  { id: INK, label: 'Ink' },
  { id: 'gray', label: 'Gray' },
  { id: 'accent', label: 'Blue' },
  { id: 'note', label: 'Annotation' },
] as const;
export const WIDTHS = [
  { px: 2, label: 'Thin' },
  { px: SHAPE_SIZE, label: 'Regular' },
  { px: 5, label: 'Bold' },
  { px: 8, label: 'Extra bold' },
] as const;
export const DASHES = [
  { id: 'solid', label: 'Solid' },
  { id: 'dashed', label: 'Dashed' },
  { id: 'dotted', label: 'Dotted' },
] as const;
export const FILLS = [
  { id: 'none', label: 'No fill' },
  { id: 'light', label: 'Light fill' },
  { id: 'medium', label: 'Medium fill' },
] as const;
export const RADII = [
  { px: 0, label: 'Square corners' },
  { px: 6, label: 'Slightly rounded' },
  { px: 14, label: 'Rounded' },
  { px: 28, label: 'Very rounded' },
] as const;
// Text sizes in CSS px at the zoom new text is placed at, and in world units for a selection.
export const FONTS = [
  { px: 14, label: 'Small', short: 'S' },
  { px: 20, label: 'Medium', short: 'M' },
  { px: 28, label: 'Large', short: 'L' },
  { px: 40, label: 'Extra large', short: 'XL' },
] as const;

export const FILL_ALPHA: Record<Fill, number> = { light: 0.08, medium: 0.18 };

const BASE: Style = { color: INK, width: SHAPE_SIZE, dash: 'solid', fill: 'none', radius: 0, font: 20 };
// Defaults match what the tools drew before styles existed.
export const DEFAULT_STYLES = { pen: BASE, shape: BASE, text: BASE };
export type StyleGroup = keyof typeof DEFAULT_STYLES;

// The dash pattern for a line of width `size`; round caps grow each dash by `size`, so gaps add it back.
export function dashOf(dash: Dash | undefined, size: number): number[] {
  if (dash === 'dashed') return [size * 2.5 + 3, size * 3.5 + 4];
  if (dash === 'dotted') return [0, size * 2 + 2];
  return [];
}

// The fields a new stroke or shape takes from a style; solid and unfilled stay absent.
export const lineProps = (s: Style) => ({ color: s.color, size: s.width, ...(s.dash !== 'solid' && { dash: s.dash }) });
export const fillProps = (s: Style) => (s.fill !== 'none' ? { fill: s.fill } : {});

// The controls an element supports, with its values.
function valuesOf(el: El): StylePatch {
  switch (el.kind) {
    case 'stroke':
    case 'line':
    case 'arrow':
      return { color: el.color, width: el.size, dash: el.dash ?? 'solid' };
    case 'ellipse':
      return { color: el.color, width: el.size, dash: el.dash ?? 'solid', fill: el.fill ?? 'none', ...(el.label && { font: el.label.fontSize }) };
    case 'poly':
      return { color: el.color, width: el.size, dash: el.dash ?? 'solid', ...(el.closed && { fill: el.fill ?? 'none' }) };
    case 'rect':
      return { color: el.color, width: el.size, dash: el.dash ?? 'solid', fill: el.fill ?? 'none', radius: el.r, ...(el.label && { font: el.label.fontSize }) };
    case 'text':
      return { color: el.color, font: el.fontSize };
    case 'icon':
      return { color: el.color };
    case 'image':
      return {};
  }
}

export function summarize(els: readonly El[]): Summary {
  const out: Record<string, unknown> = {};
  for (const el of els) {
    for (const [k, v] of Object.entries(valuesOf(el))) {
      if (!(k in out)) out[k] = v;
      else if (out[k] !== v) out[k] = null;
    }
  }
  return out as Summary;
}

// Which next-element style each drawing tool uses.
export const STYLE_GROUP: Partial<Record<ToolId, StyleGroup>> = { pencil: 'pen', rect: 'shape', ellipse: 'shape', line: 'shape', arrow: 'shape', text: 'text' };

// Which next-element style a restyled element feeds, so a pick on a selection carries to the next one drawn.
export const KIND_GROUP: Partial<Record<El['kind'], StyleGroup>> = { stroke: 'pen', rect: 'shape', ellipse: 'shape', line: 'shape', arrow: 'shape', poly: 'shape', text: 'text' };

// What the controls show for a tool's next element; null for tools that draw nothing.
export function toolSummary(tool: ToolId, next: typeof DEFAULT_STYLES): Summary | null {
  const group = STYLE_GROUP[tool];
  if (!group) return null;
  const s = next[group];
  const line = { color: s.color, width: s.width, dash: s.dash };
  switch (tool) {
    case 'pencil':
    case 'line':
    case 'arrow':
      return line;
    case 'ellipse':
      return { ...line, fill: s.fill };
    case 'rect':
      return { ...line, fill: s.fill, radius: s.radius };
    case 'text':
      return { color: s.color, font: s.font };
    default:
      return null;
  }
}

const setDash = <T extends { dash?: Dash }>(el: T, d: DashOpt): T => {
  const { dash: _, ...rest } = el;
  return (d === 'solid' ? rest : { ...rest, dash: d }) as T;
};
const setFill = <T extends { fill?: Fill }>(el: T, f: FillOpt): T => {
  const { fill: _, ...rest } = el;
  return (f === 'none' ? rest : { ...rest, fill: f }) as T;
};

// The element with the patch applied where it supports it, same id and z; unchanged elements come back as themselves.
export function restyle(el: El, p: StylePatch): El {
  const has = valuesOf(el);
  const want = (k: StyleKey) => p[k] !== undefined && k in has && has[k] !== p[k];
  if (!(['color', 'width', 'dash', 'fill', 'radius', 'font'] as const).some(want)) return el;
  if (el.kind === 'image') return el;
  let n: El = want('color') ? { ...el, color: p.color! } : el;
  if (n.kind === 'text') return want('font') ? makeText({ ...n, fontSize: p.font! }) : n;
  if (n.kind === 'icon') return shape(n);
  if (want('width')) n = { ...n, size: p.width! };
  if (want('dash')) n = setDash(n, p.dash!);
  if (n.kind === 'stroke') return { ...n, bbox: bboxOf(n.pts, n.size / 2 + 1) };
  if (want('fill') && (n.kind === 'rect' || n.kind === 'ellipse' || n.kind === 'poly')) n = setFill<Rect | Ellipse | Poly>(n, p.fill!);
  if (want('radius') && n.kind === 'rect') n = { ...n, r: p.radius! };
  if (want('font') && (n.kind === 'rect' || n.kind === 'ellipse') && n.label) return fitLabel(shape<Rect | Ellipse>({ ...n, label: { ...n.label, fontSize: p.font! } }));
  return shape(n as Shape);
}
