import {
  BOARD_API, BOARD_DEFAULT, CONTEXT_BYTES_MAX, CONTEXT_MAX, OVERVIEW_PX_MAX, REGION_PX_MAX, type BoardContext, type JobEvent, type ModelsReply, type SubmitBody,
} from '../../../server/board/api.ts';
import { cutRegion } from './cut.ts';
import { fromJSON, toJSON, type BoardJson, type ExportJson } from './elements.ts';
import type { BoardEngine } from './engine.ts';
import { PolyMask, union } from './geom.ts';
import type { Region } from './lasso.ts';
import { drawingPng } from './overview.ts';
import { drawEl, type Palette } from './render.ts';
import { outlineRuns } from './shapes.ts';
import { useBoard, type JobUi } from './store.ts';
import type { Box, El } from './types.ts';

// Refine: the lasso region goes to the server as a PNG plus elements JSON, with the rest of the drawing as read-only
// context, and the returned elements replace exactly that region as one undo step. One job per board, with the model and effort picked in the refine field.

// Fixed dark ink on transparency, so the picture reads the same whatever the board's theme.
const PNG_PAL: Palette = { ink: '#1f1e1c', grid: 'transparent', accent: '#c2410c' };
// Small regions are drawn larger so a model can read them; output never exceeds REGION_PX_MAX per side.
const PNG_SCALE = 2;
const MARK_R = 9;
const MARK_FONT = '600 11px system-ui, sans-serif';
// A returned element within this many units of its input counts as unchanged, and the original is kept.
const SAME_TOL = 1;
// Context reaches this far around the region: a share of its larger side, clamped, in world units.
const CONTEXT_MARGIN_SHARE = 1;
const CONTEXT_MARGIN_MIN = 400;
const CONTEXT_MARGIN_MAX = 1200;
const OVERVIEW_PAD = 24;

// fast: the model's Fast tier, sent only when the model offers it. provider: the model's, filled in at send.
export type ModelPick = { model: string; effort: string; fast: boolean; provider?: string };

type Job = {
  eng: BoardEngine;
  // Date.now() at submit, for the chip's elapsed time.
  t0: number;
  region: Region;
  // The elements JSON sent; its ids are 1-based indexes into region.inside.
  doc: ExportJson;
  // Where the result lands: the box toJSON measured from, so a same-size answer maps 1:1.
  target: Box;
  revision: number;
  ctrl: AbortController;
  id: string | null;
  es: EventSource | null;
  // A valid result held while the person chooses Apply anyway or Discard.
  json: string | null;
  // Removes the listeners waiting for a gesture to end before applying.
  unwait: (() => void) | null;
  provider: string | undefined;
  // Scene elements sent as context; elements are immutable, so a changed one is no longer the same object.
  context: readonly El[];
};

let job: Job | null = null;

const show = (ui: JobUi | null) => useBoard.setState({ job: ui });

// The world box the job chip sits next to.
export const jobBox = (): Box | null => job?.target ?? null;
export const jobStarted = () => job?.t0 ?? null;

let models: Promise<ModelsReply> | null = null;

// The server's model list, loaded once per page on intent (it boots the board's Codex); a failed load is retried on the next call.
export function loadModels(): Promise<ModelsReply> {
  models ??= fetch(`${BOARD_API}/models`)
    .then((r) => r.json() as Promise<ModelsReply>)
    .catch(() => ({ models: [], default: BOARD_DEFAULT, error: 'Could not reach the server' }))
    .then((r) => {
      if (r.error) models = null;
      return r;
    });
  return models;
}

// An empty selection has nothing to clean up, so it needs a prompt.
export const selectionEmpty = (eng: BoardEngine) => eng.selection()?.inside.length === 0;

async function post<T>(path: string, body: BodyInit, type: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, { method: 'POST', body, headers: { 'content-type': type }, signal });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `The server answered ${r.status}`);
  return data as T;
}

// Points on the element's ink, middle first, so a mark lands near the element's middle when it can.
function inkPoints(el: El): number[] {
  let pts: readonly number[];
  if (el.kind === 'stroke') pts = el.pts;
  else if (el.kind === 'text' || el.kind === 'icon' || el.kind === 'image') {
    const g: number[] = [];
    for (let i = 0; i <= 4; i++) for (let k = 0; k <= 4; k++) g.push(el.x + (el.w * k) / 4, el.y + (el.h * i) / 4);
    pts = g;
  } else pts = outlineRuns(el).flat();
  const n = pts.length / 2, mid = n >> 1, out: number[] = [];
  for (let d = 0; d <= n; d++) {
    for (const i of d ? [mid + d, mid - d] : [mid]) if (i >= 0 && i < n) out.push(pts[i * 2], pts[i * 2 + 1]);
  }
  return out;
}

// A spot where the whole label shows: on the ink inside the lasso, else nudged inward from the first ink inside.
function markAt(el: El, m: PolyMask, r: number, area: Box): [number, number] | null {
  const ok = (x: number, y: number) => x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1 && m.inside(x, y);
  const fits = (x: number, y: number) => {
    if (!ok(x, y)) return false;
    for (let k = 0; k < 8; k++) if (!ok(x + Math.cos((k * Math.PI) / 4) * r, y + Math.sin((k * Math.PI) / 4) * r)) return false;
    return true;
  };
  const pts = inkPoints(el);
  let first: [number, number] | null = null;
  for (let i = 0; i < pts.length; i += 2) {
    if (fits(pts[i], pts[i + 1])) return [pts[i], pts[i + 1]];
    if (!first && ok(pts[i], pts[i + 1])) first = [pts[i], pts[i + 1]];
  }
  if (!first) return null;
  for (const d of [1, 2, 3]) {
    for (let k = 0; k < 8; k++) {
      const x = first[0] + Math.cos((k * Math.PI) / 4) * r * d, y = first[1] + Math.sin((k * Math.PI) / 4) * r * d;
      if (fits(x, y)) return [x, y];
    }
  }
  return first;
}

const boxGap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));

// What stays on the board once the region is replaced: untouched elements and the outside pieces of cut strokes.
function remaining(eng: BoardEngine, region: Region): El[] {
  const gone = new Set(region.touched);
  return [...region.outside, ...eng.scene.order.filter((el) => !gone.has(el))];
}

type JsonEl = Record<string, unknown> & { id?: string };

// The nearest remaining elements, as JSON in the region's coordinates with ids "c1", "c2", ...; within a margin
// around the region and capped by count and size, nearest first.
function contextJson(rest: readonly El[], region: Region): { json: JsonEl[]; els: El[] } {
  const b = region.bbox, margin = Math.min(CONTEXT_MARGIN_MAX, Math.max(CONTEXT_MARGIN_MIN, Math.max(b.x1 - b.x0, b.y1 - b.y0) * CONTEXT_MARGIN_SHARE));
  const near = rest.map((el) => ({ el, d: boxGap(el.bbox, b) })).filter((x) => x.d <= margin).sort((x, y) => x.d - y.d).slice(0, CONTEXT_MAX).map((x) => x.el);
  if (!near.length) return { json: [], els: [] };
  let all = b;
  for (const el of near) all = union(all, el.bbox);
  // Exported in a box that holds them all, then shifted by whole units into the region's frame.
  const exp = toJSON({ poly: [], bbox: all, ids: [], touched: [], inside: near, outside: [] });
  if (!exp.ok) return { json: [], els: [] };
  const dx = Math.floor(all.x0) - Math.floor(b.x0), dy = Math.floor(all.y0) - Math.floor(b.y0);
  const at = (p: unknown) => [(p as number[])[0] + dx, (p as number[])[1] + dy];
  const out = exp.json.elements.map((raw) => {
    const e: JsonEl = { ...(raw as JsonEl), id: `c${raw.id}` };
    if (typeof e.x === 'number') (e.x += dx), (e.y = (e.y as number) + dy);
    if (e.from) (e.from = at(e.from)), (e.to = at(e.to));
    if (Array.isArray(e.pts)) e.pts = e.pts.map(at);
    if (Array.isArray(e.via)) e.via = e.via.map(at);
    return e;
  });
  const bytes = new TextEncoder();
  while (out.length && bytes.encode(JSON.stringify(out)).length > CONTEXT_BYTES_MAX) out.pop();
  return { json: out, els: near.slice(0, out.length) };
}

// Context ids are read-only: a model that hands them back would duplicate what stays on the board.
const isContext = (e: unknown) => /^c\d+$/.test(String((e as JsonEl | null)?.id ?? ''));
function withoutContext(json: string): unknown {
  try {
    const d = JSON.parse(json) as { elements?: unknown };
    return d && typeof d === 'object' && Array.isArray(d.elements) ? { ...d, elements: d.elements.filter((e) => !isContext(e)) } : d;
  } catch {
    return json;
  }
}

// The overview and context for a region that is part of a larger drawing; nothing when the region is all there is.
// The context elements still on the board are kept on the job, so editing one counts as "the drawing changed".
async function contextFor(eng: BoardEngine, region: Region, j: Job): Promise<BoardContext | undefined> {
  const rest = remaining(eng, region);
  if (!rest.length) return undefined;
  const { json: elements, els } = contextJson(rest, region);
  j.context = els.filter((el) => eng.scene.byId.get(el.id) === el);
  const signal = j.ctrl.signal;
  const snap = await drawingPng(eng.scene.order, region, { maxPx: OVERVIEW_PX_MAX, maxScale: 1, pad: OVERVIEW_PAD, frame: 'lasso' });
  const asset = await post<{ id: string }>(`${BOARD_API}/assets`, snap.blob, 'image/png', signal);
  const ox = Math.floor(region.bbox.x0), oy = Math.floor(region.bbox.y0);
  const box = { x: Math.floor(snap.box.x0) - ox, y: Math.floor(snap.box.y0) - oy, w: Math.max(1, Math.round(snap.box.x1 - snap.box.x0)), h: Math.max(1, Math.round(snap.box.y1 - snap.box.y0)) };
  return { elements, overview: { image: asset.id, box } };
}

// Transparent PNG of what the lasso holds, clipped to it, each element marked with its id from toJSON (1, 2, ...).
export function regionPng(region: Region, json: ExportJson): Promise<Blob> {
  const ox = Math.floor(region.bbox.x0), oy = Math.floor(region.bbox.y0);
  const s = Math.min(PNG_SCALE, REGION_PX_MAX / Math.max(json.w, json.h));
  const cv = new OffscreenCanvas(Math.max(1, Math.min(REGION_PX_MAX, Math.round(json.w * s))), Math.max(1, Math.min(REGION_PX_MAX, Math.round(json.h * s))));
  const c = cv.getContext('2d')!;
  c.setTransform(s, 0, 0, s, -ox * s, -oy * s);
  const p = region.poly, clip = new Path2D();
  clip.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) clip.lineTo(p[i], p[i + 1]);
  clip.closePath();
  c.clip(clip, 'evenodd');
  for (const el of region.inside) drawEl(c, el, PNG_PAL);
  const mask = new PolyMask(p), r = (MARK_R + 1) / s;
  const area = { x0: ox, y0: oy, x1: ox + cv.width / s, y1: oy + cv.height / s };
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.font = MARK_FONT;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  region.inside.forEach((el, i) => {
    const at = markAt(el, mask, r, area);
    if (!at) return;
    const x = (at[0] - ox) * s, y = (at[1] - oy) * s;
    c.fillStyle = PNG_PAL.accent;
    c.beginPath();
    c.arc(x, y, MARK_R, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#fff';
    c.fillText(String(i + 1), x, y + 0.5);
  });
  return cv.convertToBlob({ type: 'image/png' });
}

// Sends the current selection. An empty prompt asks for the base cleanup; an empty selection asks the model to
// draw the prompt from scratch into its box.
export async function refine(eng: BoardEngine, prompt: string, pick: ModelPick) {
  if (job) return;
  const region = eng.selection();
  if (!region) return;
  const exp = eng.toJSON(region);
  const ox = Math.floor(region.bbox.x0), oy = Math.floor(region.bbox.y0);
  const doc: ExportJson = exp.ok ? exp.json : { w: 1, h: 1, elements: [] };
  const j: Job = {
    eng, t0: Date.now(), region, doc, target: { x0: ox, y0: oy, x1: ox + doc.w, y1: oy + doc.h }, revision: eng.revision, ctrl: new AbortController(), id: null, es: null, json: null,
    unwait: null, provider: pick.provider, context: [],
  };
  job = j;
  if (!exp.ok) return fail(j, exp.error);
  show({ phase: 'running', text: 'Sending the selection' });
  try {
    const png = await regionPng(region, doc);
    if (job !== j) return;
    const [asset, context] = await Promise.all([post<{ id: string }>(`${BOARD_API}/assets`, png, 'image/png', j.ctrl.signal), contextFor(eng, region, j)]);
    const body: SubmitBody = {
      image: asset.id, elements: doc, prompt: prompt.trim(), target: { w: doc.w, h: doc.h }, context, revision: j.revision, model: pick.model, effort: pick.effort || undefined, fast: pick.fast,
      provider: pick.provider,
    };
    if (job !== j) return;
    // Not abortable: a job the server already started must get its id back so a cancel can reach it.
    const { id } = await post<{ id: string }>(`${BOARD_API}/jobs`, JSON.stringify(body), 'application/json');
    j.id = id;
    if (job !== j) return void cancelOnServer(id);
    listen(j);
  } catch (e) {
    if (job === j) fail(j, e instanceof TypeError || !(e as Error).message ? 'Could not reach the server' : (e as Error).message);
  }
}

function listen(j: Job) {
  const es = new EventSource(`${BOARD_API}/jobs/${j.id}/events`);
  j.es = es;
  es.onmessage = (m) => {
    if (job !== j) return es.close();
    let e: JobEvent;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    if (e.type === 'progress') return show({ phase: 'running', text: e.text });
    // A Claude job asks the CLI for the account's models, so the next picker refetches the list.
    if (j.provider === 'claude') models = null;
    es.close();
    j.es = null;
    if (e.type === 'done') result(j, e.json);
    else if (e.type === 'failed') fail(j, e.error);
    else end(j);
  };
  // A dropped stream reconnects by itself and the server replays the state; only a closed one is an error.
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED || job !== j || j.es !== es) return;
    j.es = null;
    fail(j, 'Lost the connection to the server');
  };
}

function result(j: Job, json: string) {
  const parsed = fromJSON(withoutContext(json), j.target, () => 0);
  if (!parsed.ok) return fail(j, `The result was not valid board elements. ${parsed.error.split('\n')[0]}`);
  apply(j, json, false);
}

// Elements are immutable, so the region is unchanged exactly when it still covers the very same objects.
function changed(j: Job) {
  const { eng, region } = j;
  if (eng.revision === j.revision) return false;
  if (j.context.some((el) => eng.scene.byId.get(el.id) !== el)) return true;
  if (region.only) return region.touched.some((el) => eng.scene.byId.get(el.id) !== el);
  const now = cutRegion(eng.scene, new PolyMask(region.poly)).touched;
  return now.length !== region.touched.length || now.some((el, i) => el !== region.touched[i]);
}

// Equal up to SAME_TOL on every number; ids and a stroke's or text's derived box do not count.
function same(a: unknown, b: unknown, kind?: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= SAME_TOL;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return a === b;
  const k = (kind ?? (a as { kind?: unknown }).kind) as string;
  const skip = new Set(['id', ...(k === 'stroke' ? ['x', 'y', 'w', 'h'] : k === 'text' ? ['w', 'h'] : [])]);
  const ka = Object.keys(a).filter((x) => !skip.has(x)), kb = Object.keys(b).filter((x) => !skip.has(x));
  const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
  return ka.length === kb.length && ka.every((x) => x in rb && same(ra[x], rb[x], k));
}

// The result's elements; with `keep`, ones the model left unchanged stay the original elements, not the summary.
function build(j: Job, json: string, keep: boolean): El[] | string {
  const data = withoutContext(json) as BoardJson;
  const r = j.eng.fromJSON(data, j.target);
  if (!r.ok) return r.error;
  if (!keep || data.w !== j.doc.w || data.h !== j.doc.h) return r.elements;
  const used = new Set<number>();
  return r.elements.map((el, i) => {
    const id = data.elements[i].id, at = id && /^\d+$/.test(id) ? Number(id) - 1 : -1;
    const orig = j.doc.elements[at];
    if (!orig || used.has(at) || !same(data.elements[i], orig)) return el;
    used.add(at);
    return j.region.inside[at];
  });
}

// Pending gestures and text edits land first, then the region is checked again right before the swap;
// only Apply anyway (`force`) skips that check.
function apply(j: Job, json: string, force: boolean) {
  if (job !== j) return;
  if (j.eng.busy) {
    if (j.unwait) return;
    const retry = () => queueMicrotask(() => {
      if (job !== j || j.eng.busy) return;
      j.unwait?.();
      j.unwait = null;
      apply(j, json, force);
    });
    const types = ['pointerup', 'pointercancel', 'keyup', 'focusout'] as const;
    for (const t of types) addEventListener(t, retry);
    j.unwait = () => types.forEach((t) => removeEventListener(t, retry));
    return;
  }
  if (!force && changed(j)) {
    j.json = json;
    return show({ phase: 'stale', text: 'The drawing changed.' });
  }
  const els = build(j, json, !force);
  if (typeof els === 'string') return fail(j, els);
  if (!j.eng.replaceRegion(j.region, els)) return fail(j, 'Board is busy');
  end(j);
}

function fail(j: Job, error: string) {
  if (job !== j) return;
  j.ctrl.abort();
  j.es?.close();
  j.es = null;
  j.unwait?.();
  j.unwait = null;
  show({ phase: 'failed', text: error });
}

function end(j: Job) {
  if (job !== j) return;
  j.ctrl.abort();
  j.es?.close();
  j.unwait?.();
  job = null;
  show(null);
}

const cancelOnServer = (id: string) => void fetch(`${BOARD_API}/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});

// Cancel, Discard and Dismiss: the board is left as it is.
export function dismissJob() {
  const j = job;
  if (!j) return;
  if (j.id && j.es) cancelOnServer(j.id);
  end(j);
}

export function applyAnyway() {
  const j = job;
  if (j?.json) apply(j, j.json, true);
}

// The board closed: a job only makes sense against the open board.
export function detachJobs(eng: BoardEngine) {
  if (job?.eng === eng) dismissJob();
}
