import { bboxOf, round2, streamline } from './geom.ts';
import { recognize, SNAP, type Candidate, type Recognition, type Snap } from './recognize.ts';
import { colorOf, drawEl, strokeWith } from './render.ts';
import { shape } from './shapes.ts';
import { useBoard } from './store.ts';
import { lineProps, type Style } from './style.ts';
import type { Tool, ToolHost } from './tool.ts';
import type { Ellipse, Line, Poly, Pt, Rect, Shape, Stroke } from './types.ts';
const STREAMLINE = 0.5;
// Samples closer than this many CSS px to the last one add nothing visible.
const MIN_SCREEN_STEP = 0.5;
// The raw stroke fades to this while a snap preview shows over it.
const RAW_ALPHA = 0.3;
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).get('snap-debug') === '1';
const DEBUG_COLORS: Record<Candidate['name'], string> = { line: '#2f7fd8', ellipse: '#c2410c', rect: '#15803d', round: '#9333ea', poly: '#0e7490' };

let seq = 0;
// Not crypto.randomUUID: it needs a secure context, and the app is also opened over plain http on the LAN.
export const newId = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function snapEl(s: Snap, id: string, z: number, st: Style): Shape {
  const style = { id, z, ...lineProps(st) };
  if (s.kind === 'line') return shape<Line>({ kind: 'line', ...style, x1: round2(s.x1), y1: round2(s.y1), x2: round2(s.x2), y2: round2(s.y2) });
  if (s.kind === 'poly') return shape<Poly>({ kind: 'poly', ...style, pts: s.pts.map(round2), closed: s.closed });
  const box = { x: round2(s.cx - s.w / 2), y: round2(s.cy - s.h / 2), w: round2(s.w), h: round2(s.h), rot: s.rot };
  if (s.kind === 'ellipse') return shape<Ellipse>({ kind: 'ellipse', ...style, ...box });
  return shape<Rect>({ kind: 'rect', ...style, ...box, r: round2(s.r) });
}

// Raw samples go to the overlay as a polyline segment by segment; the outline is computed once, on release.
// Holding still near the end of a stroke previews a clean shape; release commits it, moving away drops it.
export class Pencil implements Tool {
  readonly id = 'pencil';
  private pts: number[] = [];
  // Points already painted on the overlay.
  private drawn = 0;
  private on = false;
  private host: ToolHost;
  // Where the pointer last settled, and when.
  private anchor: Pt = { x: 0, y: 0 };
  private settled = 0;
  private timer = 0;
  private preview: Shape | null = null;
  private debug: Recognition | null = null;
  // Read at press, so a style change never restyles a stroke halfway.
  private style: Style = useBoard.getState().next.pen;
  // Length of the live polyline already drawn, for the dash offset.
  private len = 0;

  constructor(host: ToolHost) {
    this.host = host;
  }

  get busy() {
    return this.on;
  }

  down(p: Pt) {
    this.style = useBoard.getState().next.pen;
    this.on = true;
    this.pts = [p.x, p.y];
    this.drawn = 0;
    this.anchor = p;
    this.settle();
    this.host.paintLive();
  }

  move(list: readonly Pt[]) {
    if (!this.on || !list.length) return;
    const z = this.host.cam.z;
    const min = MIN_SCREEN_STEP / z;
    const pts = this.pts;
    let added = false;
    for (const p of list) {
      const dx = p.x - pts[pts.length - 2], dy = p.y - pts[pts.length - 1];
      if (dx * dx + dy * dy < min * min) continue;
      pts.push(p.x, p.y);
      added = true;
    }
    const last = list[list.length - 1];
    const d = Math.hypot(last.x - this.anchor.x, last.y - this.anchor.y) * z;
    const full = !!(this.preview || this.debug);
    if (d > (this.preview ? SNAP.CANCEL_PX : SNAP.DWELL_PX)) {
      this.preview = this.debug = null;
      this.anchor = last;
      this.settle();
    }
    if (added || full) this.host.paintLive(full);
  }

  up() {
    if (!this.on) return;
    this.on = false;
    this.stopTimer();
    const { scene, cam } = this.host;
    const pts = streamline(this.pts, STREAMLINE, MIN_SCREEN_STEP / cam.z);
    this.pts = [];
    const el: Stroke = { kind: 'stroke', id: newId(), z: scene.nextZ(), pts, ...lineProps(this.style), bbox: bboxOf(pts, this.style.width / 2 + 1) };
    this.host.commit({ before: [], after: [el] });
    // Two entries, so the first undo brings back the freehand stroke.
    if (this.preview) this.host.commit({ before: [el], after: [{ ...this.preview, z: el.z }] });
    this.preview = this.debug = null;
  }

  cancel() {
    this.on = false;
    this.stopTimer();
    this.pts = [];
    this.preview = this.debug = null;
    this.host.clearLive();
  }

  drawLive(ctx: CanvasRenderingContext2D, full: boolean) {
    if (!this.on) return;
    const pts = this.pts, st = this.style;
    const n = pts.length / 2;
    let from = full ? 0 : this.drawn;
    const pal = this.host.palette();
    const color = colorOf(st.color, pal);
    ctx.fillStyle = color;
    if (full && this.preview) ctx.globalAlpha = RAW_ALPHA;
    // A dot on press, so the stroke shows from the first pixel.
    if (from === 0) {
      this.len = 0;
      ctx.beginPath();
      ctx.arc(pts[0], pts[1], st.width / 2, 0, Math.PI * 2);
      ctx.fill();
      from = 1;
    }
    if (n > from) {
      const dash = st.dash === 'solid' ? undefined : st.dash;
      strokeWith(ctx, color, st.width, dash);
      // Each batch continues the dash pattern where the last one stopped.
      ctx.lineDashOffset = this.len;
      ctx.beginPath();
      ctx.moveTo(pts[(from - 1) * 2], pts[(from - 1) * 2 + 1]);
      for (let i = from; i < n; i++) {
        ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
        if (dash) this.len += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
      }
      ctx.stroke();
      if (dash) {
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
    }
    ctx.globalAlpha = 1;
    this.drawn = n;
    if (!full) return;
    if (this.preview) drawEl(ctx, this.preview, pal);
    if (this.debug) this.drawDebug(ctx, this.debug);
  }

  private settle() {
    this.settled = performance.now();
    if (!this.timer) this.timer = window.setTimeout(this.tick, SNAP.DWELL_MS);
  }

  private stopTimer() {
    clearTimeout(this.timer);
    this.timer = 0;
  }

  // One timer per hold: it re-arms for the remaining time while the pointer keeps moving.
  private tick = () => {
    this.timer = 0;
    if (!this.on || this.preview || this.debug) return;
    const wait = this.settled + SNAP.DWELL_MS - performance.now();
    if (wait > 1) {
      this.timer = window.setTimeout(this.tick, wait);
      return;
    }
    const r = recognize(this.pts, 1 / this.host.cam.z);
    if (r.snap) this.preview = snapEl(r.snap, newId(), 0, this.style);
    if (DEBUG) this.debug = r;
    if (r.snap || DEBUG) this.host.paintLive(true);
  };

  // ?snap-debug=1: every fitted candidate with its score, and why the winner won or nothing did.
  private drawDebug(ctx: CanvasRenderingContext2D, r: Recognition) {
    const z = this.host.cam.z;
    ctx.lineWidth = 1.5 / z;
    for (const c of r.candidates) {
      ctx.strokeStyle = DEBUG_COLORS[c.name];
      ctx.setLineDash(c.ok ? [] : [4 / z, 3 / z]);
      ctx.beginPath();
      ctx.moveTo(c.contour[0], c.contour[1]);
      for (let i = 2; i < c.contour.length; i += 2) ctx.lineTo(c.contour[i], c.contour[i + 1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const b = bboxOf(this.pts, 0);
    ctx.font = `${12 / z}px ui-monospace, monospace`;
    ctx.textBaseline = 'bottom';
    const lines = [`snap: ${r.snap ? r.why : `none (${r.why})`}`, ...r.candidates.map((c) => `${c.name} ${c.score.toFixed(3)} max ${c.max.toFixed(3)} ${c.ok ? 'ok' : 'x'}${c.note ? ` ${c.note}` : ''}`)];
    lines.forEach((l, i) => {
      ctx.fillStyle = i ? DEBUG_COLORS[r.candidates[i - 1].name] : this.host.palette().ink;
      ctx.fillText(l, b.x0, b.y0 - (lines.length - 1 - i) * (15 / z) - 6 / z);
    });
  }
}
