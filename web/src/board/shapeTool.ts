import { round2, segDist2, simplify, streamline } from './geom.ts';
import { newId } from './pencil.ts';
import { colorOf, drawEl, strokeWith } from './render.ts';
import { arrowHead, shape } from './shapes.ts';
import { useBoard } from './store.ts';
import { fillProps, lineProps } from './style.ts';
import type { ShapeKind, Tool, ToolHost } from './tool.ts';
import type { Ellipse, Line, Pt, Rect, Shape } from './types.ts';

// A drag shorter than this (CSS px) makes nothing.
const MIN_DRAG = 4;
const STEP_45 = Math.PI / 4;
// Arrow path, in CSS px: samples closer than PATH_STEP add nothing; PATH_EPS is the simplify tolerance.
const PATH_STEP = 2;
const PATH_EPS = 1.5;
// A path that strays from its chord by less than this (CSS px, or share of the chord) becomes a straight arrow.
const STRAIGHT_PX = 6;
const STRAIGHT_SHARE = 0.05;
// Most samples the live head looks back over.
const HEAD_WALK = 64;

// Drag to draw a rect, ellipse, line or arrow in the next-shape style. Shift makes a square, a circle or a
// 45° line; Alt grows it from the press point. An arrow follows the dragged path unless Shift is held.
export class ShapeTool implements Tool {
  readonly id: ShapeKind;
  private host: ToolHost;
  private from: Pt | null = null;
  private to: Pt = { x: 0, y: 0 };
  private cur: Shape | null = null;
  private elId = '';
  // Arrow path samples, the same as a growing Path2D, their length and how far they reach from the press.
  private path: number[] = [];
  private live: Path2D | null = null;
  private len = 0;
  private reach = 0;
  // The path preview is on the overlay (arrow without Shift, dragged far enough).
  private showing = false;

  constructor(host: ToolHost, id: ShapeKind) {
    this.host = host;
    this.id = id;
  }

  get busy() {
    return !!this.from;
  }

  down(p: Pt) {
    this.from = this.to = p;
    this.cur = null;
    this.elId = newId();
    this.path = [p.x, p.y];
    this.reach = 0;
    this.len = 0;
    this.showing = false;
    if (this.id === 'arrow') {
      this.live = new Path2D();
      this.live.moveTo(p.x, p.y);
    }
  }

  move(list: readonly Pt[]) {
    const a = this.from;
    if (!a || !list.length) return;
    this.to = list[list.length - 1];
    if (this.id === 'arrow') {
      const min = PATH_STEP / this.host.cam.z, pts = this.path;
      for (const p of list) {
        const d = Math.hypot(p.x - pts[pts.length - 2], p.y - pts[pts.length - 1]);
        if (d < min) continue;
        pts.push(p.x, p.y);
        this.live?.lineTo(p.x, p.y);
        this.len += d;
        this.reach = Math.max(this.reach, Math.hypot(p.x - a.x, p.y - a.y));
      }
    }
    this.update();
  }

  refresh() {
    if (this.from) this.update();
  }

  up() {
    const el = this.showing ? this.finishPath() : this.cur;
    this.cancel();
    if (!el) return;
    const made = { ...el, z: this.host.scene.nextZ() };
    this.host.commit({ before: [], after: [made] });
    this.host.made(made);
  }

  cancel() {
    this.from = null;
    this.cur = null;
    this.path = [];
    this.live = null;
    this.showing = false;
    this.host.clearLive();
  }

  drawLive(ctx: CanvasRenderingContext2D) {
    if (this.cur) drawEl(ctx, this.cur, this.host.palette());
    else if (this.showing && this.live) this.drawPath(ctx);
  }

  // The live path is one Path2D grown per sample; only the last stretch and the head are built per frame.
  private drawPath(ctx: CanvasRenderingContext2D) {
    const st = this.base(), pts = this.path, n = pts.length, b = this.to;
    strokeWith(ctx, colorOf(st.color, this.host.palette()), st.size, st.dash);
    ctx.stroke(this.live!);
    ctx.beginPath();
    ctx.moveTo(pts[n - 2], pts[n - 1]);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // The head aims from about one head length back, so sample jitter does not swing it.
    const reach = 10 + st.size * 2;
    let i = n - 2;
    for (let k = 0; k < HEAD_WALK && i > 0 && Math.hypot(b.x - pts[i], b.y - pts[i + 1]) < reach; k++) i -= 2;
    const [ax, ay, bx, by] = arrowHead({ x1: pts[i], y1: pts[i + 1], x2: b.x, y2: b.y, size: st.size }, this.len + Math.hypot(b.x - pts[n - 2], b.y - pts[n - 1]));
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // The drawn path ending at the pointer, unsmoothed while dragging.
  private rawPath() {
    const pts = [...this.path], b = this.to;
    if (pts[pts.length - 2] !== b.x || pts[pts.length - 1] !== b.y) pts.push(b.x, b.y);
    return pts;
  }

  private arrow(pts: readonly number[]): Line {
    const n = pts.length, ends = { x1: round2(pts[0]), y1: round2(pts[1]), x2: round2(pts[n - 2]), y2: round2(pts[n - 1]) };
    return shape<Line>({ kind: 'arrow', ...this.base(), ...ends, ...(n > 4 && { pts: pts.map(round2) }) });
  }

  // Smoothed and simplified; a nearly straight path becomes a straight arrow.
  private finishPath(): Line {
    const raw = this.rawPath(), z = this.host.cam.z, n = raw.length;
    const x1 = raw[0], y1 = raw[1], x2 = raw[n - 2], y2 = raw[n - 1];
    let dev = 0;
    for (let i = 2; i < n - 2; i += 2) dev = Math.max(dev, segDist2(raw[i], raw[i + 1], x1, y1, x2, y2));
    if (Math.sqrt(dev) <= Math.max(STRAIGHT_PX / z, Math.hypot(x2 - x1, y2 - y1) * STRAIGHT_SHARE)) return this.arrow([x1, y1, x2, y2]);
    const pts = simplify(streamline(raw, 0.5, PATH_STEP / z), PATH_EPS / z), reach = 10 + this.base().size * 2;
    // Points within a head length of the tip are the flick at release; dropping them keeps the shaft in line with the head.
    while (pts.length > 4 && Math.hypot(pts[pts.length - 4] - pts[pts.length - 2], pts[pts.length - 3] - pts[pts.length - 1]) < reach) pts.splice(pts.length - 4, 2);
    return this.arrow(pts);
  }

  private update() {
    const a = this.from!, b = this.to, { shift, alt } = this.host.mods();
    let dx = b.x - a.x, dy = b.y - a.y;
    const was = this.cur || this.showing, path = this.id === 'arrow' && !shift;
    this.showing = false;
    if (Math.max(Math.hypot(dx, dy), path ? this.reach : 0) * this.host.cam.z < MIN_DRAG) this.cur = null;
    else if (path) {
      this.cur = null;
      this.showing = true;
    } else if (this.id === 'line' || this.id === 'arrow') {
      // The end follows the pointer's projection onto the nearest 45° direction.
      if (shift) {
        const ang = Math.round(Math.atan2(dy, dx) / STEP_45) * STEP_45, c = Math.cos(ang), s = Math.sin(ang), len = dx * c + dy * s;
        dx = len * c;
        dy = len * s;
      }
      const x1 = alt ? a.x - dx : a.x, y1 = alt ? a.y - dy : a.y;
      this.cur = shape<Line>({ kind: this.id, ...this.base(), x1: round2(x1), y1: round2(y1), x2: round2(a.x + dx), y2: round2(a.y + dy) });
    } else {
      if (shift) {
        const s = Math.max(Math.abs(dx), Math.abs(dy));
        dx = (Math.sign(dx) || 1) * s;
        dy = (Math.sign(dy) || 1) * s;
      }
      const x0 = alt ? a.x - Math.abs(dx) : Math.min(a.x, a.x + dx), y0 = alt ? a.y - Math.abs(dy) : Math.min(a.y, a.y + dy);
      const k = alt ? 2 : 1, minSide = 1 / this.host.cam.z;
      const box = { x: round2(x0), y: round2(y0), w: round2(Math.max(minSide, Math.abs(dx) * k)), h: round2(Math.max(minSide, Math.abs(dy) * k)), rot: 0 };
      const st = useBoard.getState().next.shape;
      this.cur = this.id === 'rect'
        ? shape<Rect>({ kind: 'rect', ...this.base(), ...fillProps(st), ...box, r: st.radius })
        : shape<Ellipse>({ kind: 'ellipse', ...this.base(), ...fillProps(st), ...box });
    }
    if (this.cur || this.showing || was) this.host.paintLive(true);
  }

  private base() {
    return { id: this.elId, z: 0, ...lineProps(useBoard.getState().next.shape) };
  }
}
