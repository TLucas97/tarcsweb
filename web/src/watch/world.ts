import { clamp, eio, eo, fit, hash } from '../robot.tsx';
import { activityOf } from '../led.tsx';
import { cardSlots, packCards, type AgentEnd, type Row, type Station, type WatchModel } from './model.ts';

// Watch mode's world, drawn on one canvas in world units (a 600-unit tall stage scaled to the area).
// Ported from notes/identity/watch/v3.html: the metal floor, workpads, the artifact he builds, rows and leader lines.

export const DH = 600;
export const G = 400;
const FT = 18;
const PANEL = 55;
const ROWS_SHOWN = 5;
const ART_SHOWN = 9;
const GLY = '░▒/\\<>+=*#%&0123456789ABCDEFX';
const MONO = '"CaskaydiaCove Nerd Font Mono","Intel One Mono",ui-monospace,monospace';
const pad2 = (i: number) => String(i).padStart(2, '0');
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const PHASE: Record<string, string> = { explore: 'EXPLORE', build: 'BUILD', check: 'CHECK' };

type Pal = {
  amber: string; ink: string; soft: string; muted: string; faint: string; red: string; green: string; morph: string; line: string; hot: string;
  slab: string[]; slabTop: string; seam: string; seamHi: string; streak: string; shadow: string; shadow2: string; cap: string; capTop: string;
  padIdle: string; padBusy: string; padDone: string; padBusyTop: string; padDoneTop: string; padText: string; padTextDone: string; padEdge: string;
  ped: string; pedTop: string; flash: string; glow: string; walk: string; plug: string; card: string; cardLine: string;
  cRead: [string, string]; cSearch: [string, string]; cEdit: [string, string]; cNew: [string, string]; cRun: [string, string];
  cFault: [string, string]; cRich: [string, string]; cOther: [string, string]; cFixed: [string, string]; beam: string;
  // Callout cards: a question open and answered, an error open and recovered (fill, stroke); glow tints as "r g b".
  nOpen: [string, string]; nDone: [string, string]; fOpen: [string, string]; fDone: [string, string]; glowRgb: string; redRgb: string;
  // Agent cards: running, returned (fill, stroke); the recess the face sits in; the progress track.
  aRun: [string, string]; aDone: [string, string]; slot: string; slotLine: string; barOff: string; barDone: string;
};
const DARK: Pal = {
  amber: '#e8b64c', ink: '#dcd7cc', soft: '#c4beb2', muted: '#a09b8f', faint: '#7d786d', red: '#d08a80', green: '#8fae8c', morph: '#b8954c', line: '#5a564d', hot: '#ffd27a',
  slab: ['#4a463f', '#3a3832', '#2d2b27', '#232220'], slabTop: '#77726a', seam: '#181715', seamHi: 'rgb(255 255 255 / .07)', streak: 'rgb(255 255 255 / .035)',
  shadow: 'rgb(0 0 0 / .22)', shadow2: 'rgb(0 0 0 / .25)', cap: '#5c5850', capTop: '#8a857a',
  padIdle: '#4a4740', padBusy: '#48433a', padDone: '#3d3a34', padBusyTop: '#c9b07a', padDoneTop: '#857658', padText: '#5d5950', padTextDone: '#9a8c6a', padEdge: '#1b1a17',
  ped: '#3a3731', pedTop: '#7a756b', flash: '#fff1cc', glow: 'rgb(232 182 76 / .2)', walk: 'rgb(246 204 112 / .95)', plug: '#26241f',
  card: '#22211d', cardLine: '#4a4740',
  cRead: ['#23221e', '#8d877b'], cSearch: ['#23221e', '#6d685e'], cEdit: ['#7d6230', '#e8b64c'], cNew: ['#e8b64c', '#ffe1a0'], cRun: ['#2b2925', '#6d685e'],
  cFault: ['#6e3a33', '#d08a80'], cRich: ['#a7c49f', '#e4f0dc'], cOther: ['#23221e', '#5a564d'], cFixed: ['#33302b', '#6b5a52'], beam: '#e8b64c',
  nOpen: ['#2b271e', '#e8b64c'], nDone: ['#21231f', '#6b7d68'], fOpen: ['#2c201d', '#d08a80'], fDone: ['#22211d', '#5a564d'], glowRgb: '232 182 76', redRgb: '208 138 128',
  aRun: ['#2b271e', '#e8b64c'], aDone: ['#22211d', '#6d685e'], slot: '#171614', slotLine: '#3d3a34', barOff: '#34322d', barDone: '#8a7a55',
};
const LIGHT: Pal = {
  amber: '#b7841f', ink: '#2b2a27', soft: '#4a4842', muted: '#747168', faint: '#a9a59a', red: '#9f2f2d', green: '#3f7a45', morph: '#a8812f', line: '#c9c3b5', hot: '#d99a1c',
  slab: ['#e2ddd0', '#d3cdbf', '#c5bfaf', '#b8b1a1'], slabTop: '#f7f4ec', seam: '#9e9787', seamHi: 'rgb(255 255 255 / .55)', streak: 'rgb(255 255 255 / .3)',
  shadow: 'rgb(43 42 39 / .08)', shadow2: 'rgb(43 42 39 / .1)', cap: '#aaa394', capTop: '#ece8dd',
  padIdle: '#b9b2a2', padBusy: '#eadfc2', padDone: '#ddd6c4', padBusyTop: '#b7841f', padDoneTop: '#a8925f', padText: '#a39c8c', padTextDone: '#86703f', padEdge: '#a39c8c',
  ped: '#d3ccbc', pedTop: '#f2eee4', flash: '#fff6df', glow: 'rgb(183 132 31 / .18)', walk: 'rgb(183 132 31 / .95)', plug: '#f6f3ec',
  card: '#fffdf8', cardLine: '#d8d2c4',
  cRead: ['#f4f1ea', '#8d877b'], cSearch: ['#f4f1ea', '#b3ad9f'], cEdit: ['#ecd6a4', '#b7841f'], cNew: ['#c9952c', '#7c5612'], cRun: ['#eeeae0', '#a9a39a'],
  cFault: ['#f5d9d5', '#9f2f2d'], cRich: ['#cfe1c9', '#3f7a45'], cOther: ['#f4f1ea', '#c9c3b5'], cFixed: ['#eee9df', '#b9a99f'], beam: '#c99325',
  nOpen: ['#fbf2dd', '#b7841f'], nDone: ['#f1f5ef', '#7d9a78'], fOpen: ['#fcebe8', '#9f2f2d'], fDone: ['#fffdf8', '#d8d2c4'], glowRgb: '183 132 31', redRgb: '159 47 45',
  aRun: ['#fbf2dd', '#b7841f'], aDone: ['#fffdf8', '#c9c3b5'], slot: '#2c2b27', slotLine: '#1b1a17', barOff: '#e4dfd3', barDone: '#c2ae80',
};

export type Area = { x: number; y: number; w: number; h: number };
export type Info = { k: string; tone?: 'red' | 'green' | ''; title: string; path?: string; rows: [string, string, string?][] };
export type Hit = { x: number; y: number; w: number; h: number; key: string; info: () => Info };
type Cell = { t: number; n: number; k: 'read' | 'search' | 'edit' | 'new' | 'run' | 'fault' | 'fixed' | 'needs' | 'rich' | 'agent' | 'other'; col?: string };
type G2 = CanvasRenderingContext2D;
// Callout cards sit right of the station, above the floor; each hangs off its own plug by a leader line.
const SLOT = { dx: 230, y: G - 334, w: 340, gap: 9, col: 384 };
// Cards end above this line, so he never walks through one.
const HEAD = G - 156;
const PLUG = 100;
const ART = -128;
// A card in its column, with the floor plug its leader line rises from.
type Placed = { r: Row; x: number; y: number; w: number; h: number; px: number };
// The robot's panel centre above the floor and its dot pitch, in world units: where a face lifts from and lands.
const FACE_Y = G - 52;
const FACE_P = 30;
const SLOT_P = 6.5;
const FLY = 0.6;
const faceAt = (p: Placed) => ({ x: p.x + 30, y: p.y + p.h / 2 });

// Durations read like the scrubber: "4.2 s", "1:05", "1:02:05".
export function dur(s: number) {
  if (!(s >= 0)) return '';
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const n = Math.round(s), m = Math.floor(n / 60), h = Math.floor(m / 60), p = (v: number) => String(v).padStart(2, '0');
  return h ? `${h}:${p(m % 60)}:${p(n % 60)}` : `${m}:${p(n % 60)}`;
}

// A polyline stroked up to a fraction of its length, so a leader line draws out from its plug.
function polyTo(g: G2, pts: [number, number][], u: number) {
  if (u <= 0) return;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let left = Math.min(1, u) * len;
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length && left > 0; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], d = Math.hypot(bx - ax, by - ay), v = Math.min(1, left / (d || 1));
    g.lineTo(ax + (bx - ax) * v, ay + (by - ay) * v);
    left -= d;
  }
  g.stroke();
}

// Soft light baked once per tint: a radial gradient per frame would cost more than one drawImage.
const sprites = new Map<string, HTMLCanvasElement>();
function glow(g: G2, x: number, y: number, r: number, a: number, rgb: string) {
  if (a <= 0.01) return;
  let c = sprites.get(rgb);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = 128;
    const s = c.getContext('2d')!, gr = s.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, `rgb(${rgb} / .9)`); gr.addColorStop(0.35, `rgb(${rgb} / .35)`); gr.addColorStop(1, `rgb(${rgb} / 0)`);
    s.fillStyle = gr;
    s.fillRect(0, 0, 128, 128);
    sprites.set(rgb, c);
  }
  const a0 = g.globalAlpha;
  g.globalAlpha = a0 * a;
  g.drawImage(c, x - r, y - r, 2 * r, 2 * r);
  g.globalAlpha = a0;
}

// ---- An agent's face: a copy of his 3x3 panel. Its LED patterns are led.tsx's, replayed from a seed so any T draws the same frame. ----
type Pat = 'think' | 'search' | 'read' | 'edit' | 'run' | 'check' | 'fault' | 'calm';
const RING = [0, 1, 2, 5, 8, 7, 6, 3];
const CHECK = [3, 7, 5, 2];
const XS = [0, 2, 4, 6, 8];
const TAU: Record<Pat, number> = { think: 0.38, search: 0.2, read: 0.13, edit: 0.16, run: 0.14, check: 0.25, fault: 0.07, calm: 0.5 };
const STILL: Record<Pat, number[]> = { think: [4], search: [4, 1, 2], read: [0, 1, 2], edit: [0, 1, 2, 3, 4], run: [3, 4, 5], check: CHECK, fault: XS, calm: [4] };
const hit = (b: Float32Array, i: number, v: number) => void (b[i] = Math.max(b[i], v));
function tickPat(p: Pat, k: number, seed: number, b: Float32Array) {
  switch (p) {
    case 'think': if (k % 4 === 0) hit(b, (hash(k, seed, 9) * 9) | 0, 1); break;
    case 'search': if (k % 2 === 0) hit(b, RING[(k / 2) % 8], 1); break;
    case 'read': { const c = ((k / 2) | 0) % 12; if (k % 2 === 0 && c < 9) hit(b, c, 1); break; }
    case 'edit': { const c = ((k / 3) | 0) % 13; if (k % 3 === 0 && c < 9) hit(b, c, 1); break; }
    case 'run': { const c = ((k / 2) | 0) % 4; if (k % 2 === 0 && c < 3) for (const r of [0, 1, 2]) hit(b, r * 3 + c, r === 1 ? 1 : 0.75); break; }
    case 'check': CHECK.forEach((i, n) => k >= n * 1.4 && (b[i] = 1)); break;
    case 'fault':
      if (k <= 10) { if (k % 2 === 0) for (const i of XS) hit(b, i, 1.25); break; }
      for (const i of XS) hit(b, i, 0.42 + 0.16 * (0.5 + 0.5 * Math.cos((k / 8) * Math.PI)));
      if (hash(k, seed, 3) < 0.04) hit(b, XS[(hash(k, seed, 4) * 5) | 0], 1);
      break;
    case 'calm': { const v = 0.5 + 0.4 * (0.5 + 0.5 * Math.cos((k / 32) * Math.PI)); hit(b, 4, v); for (const i of [1, 3, 5, 7]) hit(b, i, v * 0.3); }
  }
}
// The panel `age` seconds into a pattern: the last few 20 fps ticks replayed with their decay.
function ledFrame(p: Pat, age: number, seed: number, b: Float32Array, still: boolean) {
  b.fill(0);
  if (still || age < 0) {
    for (const i of STILL[p]) b[i] = 1;
    return;
  }
  const K = Math.floor(age / 0.05), tau = TAU[p], f = Math.exp(-0.05 / tau);
  for (let k = Math.max(0, K - Math.ceil((4 * tau) / 0.05)); k <= K; k++) {
    for (let i = 0; i < 9; i++) b[i] *= f;
    tickPat(p, k, seed, b);
  }
  if (p === 'search') hit(b, 4, 0.22);
  if (p === 'edit') {
    const c = ((K / 3) | 0) % 13;
    if (c < 12) for (let i = 0; i <= Math.min(c, 8); i++) b[i] = Math.max(b[i], 1);
  }
}
const FACE = { plate: '#2c2b27', edge: '#0d0c0b', off: '#4a453d', on: '#f2c255', onRgb: '242 194 85', red: '#d08a80', redRgb: '208 138 128' };
// p: dot pitch in world units; plate: 0 to 1, the dark square behind the dots.
function drawFace(g: G2, x: number, y: number, p: number, b: ArrayLike<number>, alpha: number, plate: number, red = false) {
  const r = p * 0.3, a0 = g.globalAlpha;
  if (plate > 0.01) {
    g.globalAlpha = a0 * alpha * plate;
    g.fillStyle = FACE.plate; g.strokeStyle = FACE.edge; g.lineWidth = Math.max(1, p * 0.1);
    g.beginPath(); g.roundRect(x - p * 1.75, y - p * 1.75, p * 3.5, p * 3.5, p * 0.45); g.fill(); g.stroke();
  }
  for (let i = 0; i < 9; i++) {
    const cx = x + ((i % 3) - 1) * p, cy = y + (((i / 3) | 0) - 1) * p, v = Math.min(1.3, b[i]);
    g.globalAlpha = a0 * alpha;
    g.fillStyle = FACE.off; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
    if (v > 0.02) {
      glow(g, cx, cy, r * 3.2, Math.min(1, v) * 0.7, red ? FACE.redRgb : FACE.onRgb);
      g.globalAlpha = a0 * alpha * Math.min(1, v * 1.1);
      g.fillStyle = red ? FACE.red : FACE.on; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
    }
  }
  g.globalAlpha = a0;
}
const quad = (a: number, c: number, b: number, u: number) => (1 - u) * (1 - u) * a + 2 * (1 - u) * u * c + u * u * b;

export class World {
  P = DARK;
  dark = true;
  sans = '"Lexend",system-ui,sans-serif';
  ts = 1;
  area: Area = { x: 0, y: 0, w: 1, h: 1 };
  s = 1;
  dpr = 1;
  cam = 0;
  floorEnd = 0;
  live = true;
  still = false;
  T = 0;
  hits: Hit[] = [];
  robotX = NaN;
  // Something on screen keeps moving on its own (a pulse, sparks): the loop repaints the world at 20 fps.
  anim = false;
  faces = false;
  // The next agent end ahead of view time on the cards drawn, so the loop is awake when it comes.
  next = Infinity;
  private leds = new Float32Array(9);
  private m: WatchModel | null = null;
  private vx0 = 0;
  private vx1 = 0;
  private memo = new Map<string, unknown>();
  private grads = new Map<number, CanvasGradient>();
  private tf = { k: 1, ox: 0, oy: 0 };

  // Canvases cannot see CSS variables: palette, fonts and text size are read here, on open and on every theme change.
  theme() {
    const root = document.documentElement;
    this.dark = root.dataset.theme === 'dark';
    this.P = this.dark ? DARK : LIGHT;
    const cs = getComputedStyle(root);
    this.sans = cs.getPropertyValue('--sans').trim() || this.sans;
    this.ts = parseFloat(cs.getPropertyValue('--text-scale')) || 1;
    this.memo.clear();
    this.grads.clear();
  }

  layout(a: Area, dpr: number) {
    this.area = a;
    this.dpr = dpr;
    this.s = a.h / DH;
  }

  get vw() {
    return this.area.w / this.s;
  }

  font(size: number, weight = 400, mono = true) {
    return `${weight} ${(size * this.ts).toFixed(2)}px ${mono ? MONO : this.sans}`;
  }

  private remember<T>(k: string, f: () => T): T {
    let v = this.memo.get(k) as T | undefined;
    if (v === undefined) {
      if (this.memo.size > 3000) this.memo.clear();
      this.memo.set(k, (v = f()));
    }
    return v;
  }
  private tw(g: G2, str: string) {
    return this.remember(`m|${g.font}|${str}`, () => g.measureText(str).width);
  }
  private fit1(g: G2, str: string, max: number) {
    return this.remember(`f|${g.font}|${max | 0}|${str}`, () => {
      if (g.measureText(str).width <= max) return str;
      let lo = 0, hi = str.length;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (g.measureText(str.slice(0, m) + '…').width <= max) lo = m;
        else hi = m - 1;
      }
      return str.slice(0, lo) + '…';
    });
  }
  private wrap(g: G2, text: string, max: number) {
    return this.remember(`w|${g.font}|${max | 0}|${text}`, () => {
      const lines: string[] = [];
      let cur = '';
      for (const w of text.split(/(?<= )|(?<=\/)/)) {
        const t = cur + w;
        if (g.measureText(t.trimEnd()).width > max && cur) (lines.push(cur.trimEnd()), (cur = w));
        else cur = t;
      }
      if (cur) lines.push(cur.trimEnd());
      return lines;
    });
  }

  private age(t: number) {
    return this.still ? 1e3 : this.T - t;
  }
  private wall(T: number) {
    return this.m ? this.m.wallOf(T) : T;
  }
  // A subtle C-style scramble while a text is fresh, only when watching live.
  private txt(g: G2, str: string, x: number, y: number, color: string, t: number | null = null) {
    if (t != null && this.live && !this.still) {
      const a = this.age(t);
      if (a >= 0 && a < 0.36) {
        const tick = Math.floor(a * 20), seed = (t * 7.31) % 97;
        let out = '';
        for (let i = 0; i < str.length; i++) out += str[i] === ' ' || a >= 0.06 + hash(i, seed, 5) * 0.3 ? str[i] : GLY[(hash(i, seed, tick) * GLY.length) | 0];
        g.fillStyle = this.P.morph;
        g.fillText(out, x, y);
        return;
      }
    }
    g.fillStyle = color;
    g.fillText(str, x, y);
  }
  private hit(x: number, y: number, w: number, h: number, key: string, info: () => Info) {
    const { k, ox, oy } = this.tf;
    this.hits.push({ x: ox + x * k, y: oy + y * k, w: w * k, h: h * k, key, info });
  }

  // ---- Beam: a wedge of light and a spray of glyphs from his panel to the thing being made. ----
  private beam(g: G2, t: number, px: number, bx: number, by: number, bw: number, bh: number, seed = 0) {
    if (this.still) return;
    const a = this.age(t);
    if (a < 0 || a > 0.75) return;
    const on = fit(a, 0, 0.07) * (1 - fit(a, 0.3, 0.75));
    // From his panel where he is now: a beam's tail can outlast his stay by a few frames.
    const sx = (Number.isNaN(this.robotX) ? px : this.robotX) + 18, sy = G - PANEL - 8, P = this.P;
    g.save();
    g.globalAlpha = 0.09 * on;
    g.fillStyle = P.beam;
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(bx, by); g.lineTo(bx + bw, by); g.lineTo(bx + bw, by + bh); g.lineTo(bx, by + bh); g.closePath(); g.fill();
    g.globalAlpha = 0.5 * on;
    g.strokeStyle = P.hot;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(bx, by + bh / 2); g.stroke();
    g.font = `10px ${MONO}`;
    const tick = Math.floor(a * 20);
    for (let q = 0; q < 10; q++) {
      const d0 = hash(q, seed, 1) * 0.16, u = fit(a, d0, d0 + 0.28);
      if (u <= 0 || u >= 1) continue;
      const tx = bx + hash(q, seed, 2) * bw, ty = by + hash(q, seed, 3) * bh, e = eo(u);
      g.globalAlpha = 1 - u * 0.8;
      g.fillStyle = q % 3 ? P.hot : P.amber;
      g.fillText(GLY[(hash(q, seed, tick) * GLY.length) | 0], lerp(sx, tx, e), lerp(sy, ty, e) - Math.sin(Math.PI * u) * 14 * (hash(q, seed, 4) - 0.5));
    }
    g.restore();
  }

  // ---- Floor ----
  private slabGrad(g: G2, y: number) {
    let gr = this.grads.get(y);
    if (!gr) {
      gr = g.createLinearGradient(0, y, 0, y + FT);
      const [a, b, c, d] = this.P.slab;
      gr.addColorStop(0, a); gr.addColorStop(0.14, b); gr.addColorStop(0.6, c); gr.addColorStop(1, d);
      this.grads.set(y, gr);
    }
    return gr;
  }
  private slab(g: G2, xa: number, xb: number, y: number, seam = 160) {
    if (xb <= xa) return;
    const P = this.P;
    g.fillStyle = P.shadow; g.fillRect(xa + 2, y + FT, xb - xa - 4, 9);
    g.fillStyle = P.shadow2; g.fillRect(xa + 1, y + FT, xb - xa - 2, 3);
    g.fillStyle = this.slabGrad(g, y); g.fillRect(xa, y, xb - xa, FT);
    g.fillStyle = P.slabTop; g.fillRect(xa, y, xb - xa, 1.2);
    g.fillStyle = P.streak; g.fillRect(xa, y + 6, xb - xa, 1); g.fillRect(xa, y + 11, xb - xa, 1);
    for (let x = Math.ceil(xa / seam) * seam; x < xb - 2; x += seam) {
      g.fillStyle = P.seam; g.fillRect(x, y + 2, 1.2, FT - 2);
      g.fillStyle = P.seamHi; g.fillRect(x + 1.2, y + 2, 1, FT - 2);
    }
  }
  private cap(g: G2, x: number, y: number, side: number) {
    const cx = side < 0 ? x : x - 5;
    g.fillStyle = this.P.cap; g.fillRect(cx, y, 5, FT);
    g.fillStyle = this.P.capTop; g.fillRect(cx, y, 5, 1.2);
  }
  private walkLine(g: G2, x0: number, x1: number, y: number) {
    if (x1 <= x0) return;
    g.lineCap = 'round';
    g.strokeStyle = this.P.glow; g.lineWidth = 6; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.strokeStyle = this.P.walk; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
  }
  // Workpad inlaid where he stands; it warms while he works on it.
  private pad(g: G2, st: Station, here: boolean, done: boolean, xa: number, xb: number, y: number) {
    const P = this.P, busy = here && !done;
    if (!here) {
      g.strokeStyle = P.padIdle; g.lineWidth = 1; g.setLineDash([4, 4]);
      g.strokeRect(xa + 0.5, y + 2.5, xb - xa - 1, FT - 4); g.setLineDash([]);
    } else {
      g.fillStyle = busy ? P.padBusy : P.padDone; g.fillRect(xa, y + 1.2, xb - xa, FT - 1.2);
      g.fillStyle = busy ? P.padBusyTop : P.padDoneTop; g.fillRect(xa, y, xb - xa, busy ? 1.6 : 1.2);
      g.fillStyle = P.padEdge; g.fillRect(xa, y + 2, 1, FT - 2); g.fillRect(xb - 1, y + 2, 1, FT - 2);
    }
    g.font = `600 10px ${MONO}`;
    g.fillStyle = !here ? P.padText : busy ? P.amber : P.padTextDone;
    g.textBaseline = 'middle';
    g.fillText(st.kind === 'step' ? pad2(st.num + 1) : PHASE[st.phase ?? ''] ?? 'WORK', xa + 8, y + FT / 2 + 1);
    g.textBaseline = 'alphabetic';
  }
  private plug(g: G2, x: number, y: number, col: string) {
    g.fillStyle = this.P.plug; g.strokeStyle = col; g.lineWidth = 1.4;
    g.beginPath(); g.roundRect(x - 6, y - 5, 12, 7, 2); g.fill(); g.stroke();
    g.fillStyle = col; g.beginPath(); g.arc(x, y - 1.5, 1.8, 0, 7); g.fill();
  }
  // A box drawn as if assembled: outline traces round, fill comes in, a scan line passes down it.
  private matBox(g: G2, x: number, y: number, w: number, h: number, t: number, stroke: string, fill: string, lw = 1.4) {
    const a = this.live ? this.age(t) : 9, m = fit(a, 0.04, 0.42, 0, 1, eo);
    if (m <= 0) return 0;
    const Pm = 2 * (w + h);
    g.save();
    g.globalAlpha = fit(a, 0.12, 0.45); g.fillStyle = fill;
    g.beginPath(); g.roundRect(x, y, w, h, 9); g.fill();
    g.globalAlpha = 1; g.strokeStyle = stroke; g.lineWidth = lw;
    if (m < 1) g.setLineDash([Pm * m, Pm]);
    g.beginPath(); g.roundRect(x, y, w, h, 9); g.stroke(); g.setLineDash([]);
    if (a > 0.18 && a < 0.62 && !this.still) {
      const yy = y + h * fit(a, 0.18, 0.62, 0, 1, eio);
      g.globalAlpha = 0.85 * (1 - fit(a, 0.5, 0.62)); g.fillStyle = this.P.hot; g.fillRect(x + 2, yy, w - 4, 1.2);
      g.globalAlpha = 0.12; g.fillRect(x + 2, y + 2, w - 4, yy - y - 2);
    }
    g.restore();
    return fit(a, 0.22, 0.5);
  }

  // ---- One frame. ----
  draw(g: G2, m: WatchModel, T: number, robotX: number) {
    const a = this.area, s = this.s, dpr = this.dpr;
    this.T = T;
    this.m = m;
    this.robotX = robotX;
    this.hits = [];
    this.anim = this.faces = false;
    this.next = Infinity;
    this.tf = { k: s, ox: a.x - this.cam * s, oy: a.y };
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(a.x, a.y, a.w, a.h);
    g.save();
    g.beginPath(); g.rect(a.x, a.y, a.w, a.h); g.clip();
    g.setTransform(dpr * s, 0, 0, dpr * s, dpr * this.tf.ox, dpr * this.tf.oy);
    this.vx0 = this.cam - 40;
    this.vx1 = this.cam + this.vw + 40;
    const st = m.stations;
    if (!st.length) return void g.restore();
    const f0 = st[0].x - 420, f1 = Math.max(this.floorEnd, st[0].x + 420);
    const xa = Math.max(f0, this.vx0), xb = Math.min(f1, this.vx1);
    this.slab(g, xa, xb, G);
    if (f0 >= this.vx0) this.cap(g, f0, G, -1);
    if (f1 <= this.vx1) this.cap(g, f1, G, 1);
    this.walkLine(g, Math.max(st[0].x - 80, this.vx0), Math.min(robotX, this.vx1), G);
    // Stations sit in x order, so the visible ones are a contiguous run.
    let lo = 0, hi = st.length - 1, i0 = st.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      // A station's cards reach up to four columns right of it.
      if (st[mid].x + 1800 >= this.vx0) (i0 = mid), (hi = mid - 1);
      else lo = mid + 1;
    }
    for (let i = i0; i < st.length && st[i].x - 340 <= this.vx1; i++) this.station(g, m, st[i], i, T);
    g.restore();
    g.globalAlpha = 1;
  }

  // Floor end eases out as new stations appear, so the floor grows instead of popping.
  floorTarget(m: WatchModel, T: number) {
    const st = m.stations;
    for (let i = st.length - 1; i >= 0; i--) if (T >= shownAt(st[i])) return st[i].x + 420;
    return (st[0]?.x ?? 0) + 420;
  }

  // The dotted sky is a CSS layer moved by transform (parallax at 0.12): repainting it with the world cost frames at 4x.
  skyBox() {
    const s = this.s, step = 34 * s;
    return { top: this.area.y + 20 * s, h: (G - 80) * s, step, x: -((this.cam * s * 0.12) % step) };
  }

  // ---- A station: its pad, title, the artifact he builds and the rows under the floor. ----
  private station(g: G2, m: WatchModel, st: Station, i: number, T: number) {
    const P = this.P, xs = st.x, sched = i < m.routeLen, here = sched && T >= st.arr;
    const shown = shownAt(st);
    if (T < shown - 0.01) return;
    const ap = this.still ? 1 : fit(T - shown, 0, 0.5, 0, 1, eo);
    if (st.kind === 'start') {
      g.fillStyle = P.ped; g.fillRect(xs - 90, G - 6, 180, 6);
      g.fillStyle = P.pedTop; g.fillRect(xs - 90, G - 6, 180, 1.2);
      return;
    }
    if (st.kind === 'ask') return this.ask(g, st, here, ap);
    const done = !Number.isNaN(st.done) && T >= st.done, busy = here && !done;
    g.globalAlpha = ap;
    this.pad(g, st, here, done, xs - 120, xs + 120, G);
    // Title: a faint promise ahead of him, written properly once he is there.
    const sx = xs - 170, sy = G - 290;
    g.font = this.font(18, 500, false);
    const lines = this.wrap(g, st.label || 'Working', 330).slice(0, 3);
    const ta = here && this.live ? this.age(st.arr) : 9, rev = here ? fit(ta, 0.05, 0.5, 0, 1, eo) : 1;
    g.globalAlpha = ap * (here ? 1 : 0.55);
    g.font = this.font(13, 600);
    const tag = st.kind === 'step' ? pad2(st.num + 1) : PHASE[st.phase ?? ''] ?? 'WORK';
    const sTxt = `${tag}  ${done ? '✓ DONE' : here ? '● NOW' : 'NEXT'}`;
    this.txt(g, sTxt, sx + 12, sy, here ? P.amber : P.faint, done ? st.done : here ? st.arr : null);
    if (done && here && !st.past) {
      g.font = this.font(12);
      g.fillStyle = P.faint;
      g.fillText(dur(this.wall(st.done) - this.wall(st.arr)), sx + 24 + this.tw(g, sTxt) * 1.08, sy);
    }
    g.save();
    g.font = this.font(18, 500, false);
    const lh = 23 * this.ts;
    const tw0 = Math.max(...lines.map((l) => this.tw(g, l)), 10) + 20;
    if (rev < 1) (g.beginPath(), g.rect(sx, sy + 6, tw0 * rev + 12, lines.length * lh + 12), g.clip());
    g.fillStyle = !here ? P.faint : busy ? P.ink : P.soft;
    lines.forEach((l, j) => g.fillText(l, sx + 12, sy + 26 + j * lh));
    g.restore();
    if (rev > 0 && rev < 1) {
      g.fillStyle = P.hot; g.globalAlpha = 0.9;
      g.fillRect(sx + 12 + tw0 * rev, sy + 8, 1.5, lines.length * lh + 4);
    }
    g.globalAlpha = 1;
    if (here) this.beam(g, st.arr, xs, sx + 8, sy + 6, Math.min(tw0, 320), lines.length * lh + 8, 11 + st.id);
    const info = () => this.infoStation(m, st);
    this.hit(sx, sy - 16, 340, 30 + lines.length * lh, `st|${st.id}`, info);
    this.hit(xs - 120, G, 240, FT, `st|${st.id}`, info);
    if (!here) return;
    const n = visibleRows(st, T);
    const art = this.artifact(g, st, n, xs + ART, G, 17, done);
    this.hit(xs + ART - art.w / 2, art.top, art.w, G - art.top, `art|${st.id}`, info);
    this.sparks(g, st, xs + ART, art.top);
    this.rows(g, st, n, xs - 150, G + FT + 2, G + FT + 32, 27, 520, 13.5);
    this.callouts(g, st);
  }

  // An error he has not got past sparks off the artifact for a moment; after that the red cells and its card say it.
  private sparks(g: G2, st: Station, cx: number, top: number) {
    if (this.still) return;
    for (let i = st.calls.length - 1; i >= 0; i--) {
      const f = st.calls[i];
      if (f.kind !== 'fault' || f.t > this.T || (f.res !== null && this.T >= f.res)) continue;
      const a = this.age(f.t);
      if (a > 2.7) return;
      this.anim = true;
      if (a < 0.8) glow(g, cx, G - 40, 120 * (1 - a / 0.8) + 20, 1 - a / 0.8, this.P.redRgb);
      for (let q = 0; q < 8; q++) {
        const life = 0.9, ph = ((a + q * 0.17) % life) / life, ang = hash(q, 7, 1) * Math.PI - Math.PI, sp = 26 + hash(q, 8, 1) * 40;
        g.globalAlpha = (1 - ph) * (1 - fit(a, 2.2, 2.7));
        g.fillStyle = q % 2 ? this.P.hot : this.P.red;
        g.fillRect(cx + Math.cos(ang) * sp * ph, top + 10 + Math.sin(ang) * sp * ph + 40 * ph * ph, 2.5, 2.5);
      }
      g.globalAlpha = 1;
      return;
    }
  }

  // ---- Cards: the latest question, the latest error and each agent here, in columns, each on its own plug. ----
  // Slots keep the order things first appeared in, so a new card never moves the ones already standing.
  private placeCards(g: G2, st: Station): Placed[] {
    const slots = cardSlots(st, this.T), cols = packCards(slots), out: Placed[] = [];
    for (let i = 0; i < slots.length; ) {
      const c = cols[i];
      let k = i;
      while (k < slots.length && cols[k] === c) k++;
      const col = slots.slice(i, k);
      const hs = col.map((r) => (r.kind === 'agent' ? this.agentH() : this.callH(g, r)));
      const total = hs.reduce((a, b) => a + b, 0) + (hs.length - 1) * SLOT.gap;
      // A full column lifts so its last card clears his head as he walks past.
      let y = Math.max(24, Math.min(SLOT.y, HEAD - total));
      const x = st.x + SLOT.dx + c * SLOT.col;
      col.forEach((r, j) => {
        out.push({ r, x, y, w: SLOT.w, h: hs[j], px: c ? x - 34 + j * 12 : st.x + PLUG + j * 30 });
        y += hs[j] + SLOT.gap;
      });
      i = k;
    }
    return out;
  }
  private callH(g: G2, r: Row) {
    g.font = this.font(13);
    return Math.round(44 + Math.min(3, this.wrap(g, r.label, SLOT.w - 28).length) * 18 * this.ts);
  }
  private agentH() {
    return Math.round(50 + 16 * this.ts);
  }

  private callouts(g: G2, st: Station) {
    for (const p of this.placeCards(g, st)) p.r.kind === 'agent' ? this.agentCard(g, st, p) : this.card(g, st, p);
  }

  // Plug on the floor, then the leader: up from it, a rounded corner, across to the card's middle.
  private leader(g: G2, p: Placed, cy: number, col: string, alpha: number, t: number) {
    const rr = Math.min(18, (p.x - p.px) / 2);
    g.strokeStyle = col; g.lineWidth = 1.5; g.lineCap = 'round'; g.lineJoin = 'round';
    g.globalAlpha = alpha;
    polyTo(g, [[p.px, G - 5], [p.px, cy + rr], [p.px + rr, cy], [p.x, cy]], this.live ? fit(this.age(t), 0, 0.4, 0, 1, eo) : 1);
    g.globalAlpha = 1;
    g.lineCap = 'butt';
  }

  private card(g: G2, st: Station, pl: Placed) {
    const P = this.P, T = this.T, r = pl.r, { x, y, w, h, px } = pl, isNeeds = r.kind === 'needs';
    const open = r.res === null || T < r.res;
    const [fill, stroke] = isNeeds ? (open ? P.nOpen : P.nDone) : open ? P.fOpen : P.fDone;
    const good = isNeeds && !r.err;
    g.font = this.font(13);
    const lines = this.wrap(g, r.label, w - 28).slice(0, 3);
    if (this.wrap(g, r.label, w - 28).length > 3) lines[2] = this.fit1(g, lines[2] + '…', w - 28);
    const lh = 18 * this.ts;
    const col = open ? (isNeeds ? P.amber : P.red) : isNeeds ? (good ? P.green : P.faint) : P.line;
    this.plug(g, px, G, col);
    if (isNeeds && open && !this.still) {
      this.anim = true;
      const p = 0.5 + 0.5 * Math.cos(this.age(r.t) * 5);
      g.globalAlpha = 0.25 + 0.5 * p;
      g.strokeStyle = P.amber; g.lineWidth = 1.5;
      g.beginPath(); g.arc(px, G - 2, 12 + 4 * p, 0, 7); g.stroke();
      g.globalAlpha = 1;
    }
    this.leader(g, pl, y + Math.min(h / 2, 39), open ? col : P.line, open ? 0.75 : 1, r.t);
    const c = this.matBox(g, x, y, w, h, r.t + 0.15, stroke, fill, open ? 1.8 : 1.3);
    if (!c) return;
    g.globalAlpha = c;
    const head = open ? (isNeeds ? 'Needs you' : 'Error') : r.ans || (isNeeds ? 'Answered' : 'Recovered');
    g.font = this.font(14, 600, false);
    this.txt(g, head, x + 14, y + 25, open ? (isNeeds ? P.amber : P.red) : good || !isNeeds ? P.green : P.muted, open ? null : r.res);
    const w1 = open ? this.wall(T) : r.w1 ?? this.wall(r.res!);
    const span = dur(Math.max(0, w1 - r.w0));
    const when = isNeeds ? `${open ? 'waiting' : 'waited'} ${span}` : open ? span : `after ${span}`;
    g.font = this.font(12);
    g.textAlign = 'right';
    this.txt(g, when, x + w - 14, y + 25, open ? P.muted : P.faint, open ? null : r.res);
    g.textAlign = 'left';
    g.font = this.font(13);
    const ink = open ? (isNeeds ? P.ink : P.red) : P.faint;
    lines.forEach((l, j) => {
      const ly = y + 48 + j * lh;
      this.txt(g, l, x + 14, ly, ink, r.t);
      // A recovered error stays readable, struck through.
      if (!open && !isNeeds) {
        g.strokeStyle = P.faint; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x + 14, ly - 4); g.lineTo(x + 14 + this.tw(g, l), ly - 4); g.stroke();
      }
    });
    g.globalAlpha = 1;
    this.beam(g, r.t + 0.15, st.x, x, y, w, h, 81 + st.id);
    if (!open) this.beam(g, r.res!, st.x, x, y, w, h, 83 + st.id);
    this.hit(x, y, w, h, `call|${st.id}|${r.key}`, () => this.infoCall(st, r));
  }

  // Where an agent stands at view time T: running until its end, then how it ended.
  private agentAt(r: Row): AgentEnd & { state: AgentEnd['fin'] } {
    const e = this.m!.agentEnd(r);
    return { ...e, state: e.end !== null && this.T >= e.end ? e.fin : 'running' };
  }
  // Out of his panel: [0, 1] while the face flies to its card. Home: the same on the way back once it returns.
  private outU(r: Row) {
    return this.still ? 1 : fit(this.T - r.t, 0.05, 0.05 + FLY);
  }
  private homeU(e: AgentEnd & { state: string }) {
    if (e.end === null || (e.state !== 'done' && e.state !== 'stopped')) return 0;
    return this.still ? 1 : fit(this.T - e.end, 0, FLY);
  }
  // The face's pattern: what the agent is doing while it runs, a check once it returns, the X if it failed.
  private faceLed(r: Row, e: AgentEnd & { state: string }, b: Float32Array) {
    const T = this.T, run = e.state === 'running';
    const pat: Pat = run ? (activityOf(this.m!.agentNote(r.aid, this.wall(T))?.s) as Pat) : e.state === 'failed' ? 'fault' : e.state === 'stopped' ? 'calm' : 'check';
    const age = T - (run ? r.t : e.end!);
    // Running faces keep moving; an outcome plays once and settles on its still frame.
    const settled = !run && age > (pat === 'fault' ? 0.9 : 1.2);
    ledFrame(pat, age, hash(r.t, 3, 1) * 97, b, this.still || settled);
    // A running face is small: 10 fps of world repaints is enough for it; an outcome plays at the usual 20.
    if (!this.still && !settled) run ? (this.faces = true) : (this.anim = true);
    if (pat === 'fault' && settled) for (const i of XS) b[i] = 0.8;
  }

  // An agent's card: its face sits in the recess at the left, its name, state, last line and a progress bar beside it.
  private agentCard(g: G2, st: Station, pl: Placed) {
    const P = this.P, T = this.T, r = pl.r, { x, y, w, h, px } = pl, e = this.agentAt(r), s = e.state;
    const run = s === 'running', bad = s === 'failed';
    const col = run ? P.amber : bad ? P.red : s === 'stopped' ? P.faint : P.barDone;
    this.plug(g, px, G, col);
    this.leader(g, pl, y + Math.min(h / 2, 39), col, run || bad ? 0.75 : 1, r.t);
    if (e.end !== null && e.end > T) this.next = Math.min(this.next, e.end);
    const [fill, stroke] = run ? P.aRun : bad ? P.fOpen : P.aDone;
    const c = this.matBox(g, x, y, w, h, r.t + 0.15, stroke, fill, run ? 1.6 : 1.3);
    if (!c) return;
    g.globalAlpha = c;
    const { x: fx, y: fy } = faceAt(pl), p = e.p;
    g.fillStyle = P.slot; g.strokeStyle = P.slotLine; g.lineWidth = 1;
    g.beginPath(); g.roundRect(fx - 18, fy - 18, 36, 36, 6); g.fill(); g.stroke();
    const tx = x + 58, right = x + w - 12, ny = y + 24;
    g.font = this.font(12);
    const tag = run ? 'running' : bad ? 'failed ✕' : s === 'stopped' ? 'stopped' : 'returned ✓';
    const tagW = this.tw(g, tag);
    g.textAlign = 'right';
    this.txt(g, tag, right, ny, run ? P.amber : bad ? P.red : s === 'stopped' ? P.faint : P.green, run ? r.t : e.end);
    g.textAlign = 'left';
    g.font = this.font(14, 600, false);
    this.txt(g, this.fit1(g, p?.name || r.label, right - tagW - 10 - tx), tx, ny, P.ink, r.t);
    // Running: the step it reported by this view time; ended: the last line it said.
    const note = run ? this.m!.agentNote(r.aid, this.wall(T)) : null;
    const line = run ? note?.s || (e.fin === 'running' ? 'Starting' : 'Working') : p?.said || (bad ? 'Failed' : s === 'stopped' ? 'Stopped' : 'Returned');
    g.font = this.font(12);
    this.txt(g, this.fit1(g, line, right - tx), tx, ny + 18 * this.ts, run ? P.muted : bad ? P.red : P.soft, run ? r.t : e.end);
    // Progress: one segment per step it reported; without steps, a dashed track while it runs.
    const took = dur(Math.max(0, (run ? this.wall(T) : !p && r.w1 !== null ? r.w1 : this.wall(e.end!)) - r.w0));
    g.font = this.font(11);
    const dw = this.tw(g, took), by = y + h - 14, bw = right - dw - 10 - tx;
    g.fillStyle = P.faint;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(took, right, by + 2);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    const steps = run ? (note && note.d >= 0 && note.n > 0 ? { done: note.d, total: note.n } : null) : p?.steps && p.steps.total > 0 ? p.steps : null;
    if (steps) {
      const n = Math.min(12, steps.total), done = run ? Math.min(n, steps.done) : bad ? Math.min(n - 1, steps.done) : n, sw = (bw - (n - 1) * 3) / n;
      for (let i = 0; i < n; i++) (g.fillStyle = i < done ? (run ? P.amber : P.barDone) : P.barOff), g.fillRect(tx + i * (sw + 3), by, sw, 4);
      if (bad) this.stop(g, tx + done * (sw + 3) - 1.5, by);
    } else if (run) {
      g.strokeStyle = P.amber; g.lineWidth = 4; g.setLineDash([6, 5]);
      g.beginPath(); g.moveTo(tx, by + 2); g.lineTo(tx + bw, by + 2); g.stroke(); g.setLineDash([]);
    } else {
      g.fillStyle = bad || s === 'stopped' ? P.barOff : P.barDone; g.fillRect(tx, by, bw, 4);
      if (bad) this.stop(g, tx + bw - 3, by);
    }
    if (s === 'done') (g.fillStyle = P.green), g.beginPath(), g.arc(tx + bw + 4, by + 2, 2.6, 0, 7), g.fill();
    // The face: in its recess once it has landed; a faint print of it after it went home.
    const out = this.outU(r), home = this.homeU(e), b = this.leds;
    if (out >= 1 && home <= 0) {
      this.faceLed(r, e, b);
      drawFace(g, fx, fy, SLOT_P, b, bad ? 0.9 : 1, 1, bad);
      if (bad) {
        g.strokeStyle = P.red; g.lineWidth = 2; g.lineCap = 'round';
        g.beginPath(); g.moveTo(fx - 9, fy - 9); g.lineTo(fx + 9, fy + 9); g.moveTo(fx + 9, fy - 9); g.lineTo(fx - 9, fy + 9); g.stroke();
        g.lineCap = 'butt';
      }
    } else if (home >= 1) {
      ledFrame('check', 0, 0, b, true);
      drawFace(g, fx, fy, SLOT_P, b, 0.22, 0);
    }
    g.globalAlpha = 1;
    this.beam(g, r.t + 0.15, st.x, x, y, w, h, 71 + st.id);
    if (!run && e.end !== null) this.beam(g, e.end, st.x, x, y, w, h, 73 + st.id);
    this.hit(x, y, w, h, `ag|${st.id}|${r.key}`, () => this.infoAgent(st, r));
  }
  // A failed run's bar ends on a short red post.
  private stop(g: G2, x: number, y: number) {
    g.fillStyle = this.P.red;
    g.fillRect(x, y - 5, 3, 14);
  }

  // Faces that landed back on him in the last 0.6 s: his panel pulses once for each.
  landings(m: WatchModel, T: number, out: number[]) {
    if (this.still) return;
    for (const { row: r } of m.agents) {
      if (r.t > T) continue;
      const e = m.agentEnd(r);
      if (e.end === null || (e.fin !== 'done' && e.fin !== 'stopped')) continue;
      const a = T - e.end - FLY;
      if (a >= 0 && a < 0.6) out.push(e.end + FLY);
    }
  }

  // ---- Faces in the air, drawn on the canvas above the robot: out of his panel to its card, and home when it returns. ----
  // Returns whether one is flying.
  flights(g: G2, m: WatchModel, T: number, robotX: number) {
    if (this.still || !m.agents.length) return false;
    this.T = T;
    this.m = m;
    let any = false, cache: Station | null = null, placed: Placed[] = [];
    const b = this.leds;
    for (const { row: r, st } of m.agents) {
      if (r.t > T) continue;
      const e = this.agentAt(r), out = this.outU(r), home = this.homeU(e);
      const flying = out > 0 && out < 1 ? out : home > 0 && home < 1 ? 1 - home : -1;
      if (flying < 0) continue;
      if (cache !== st) (cache = st), (placed = this.placeCards(g, st));
      const pl = placed.find((p) => p.r === r);
      if (!pl) continue;
      if (!any) {
        any = true;
        const a = this.area, s = this.s;
        g.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * (a.x - this.cam * s), this.dpr * a.y);
      }
      // One arc from his panel up and over into the recess; the face shrinks from his panel's size to the card's.
      const u = eio(flying), sx = robotX, sy = FACE_Y, { x: fx, y: fy } = faceAt(pl);
      const cx = lerp(sx, fx, 0.4), cy = Math.min(sy, fy) - 60;
      const x = quad(sx, cx, fx, u), y = quad(sy, cy, fy, u), pitch = lerp(FACE_P, SLOT_P, u);
      // Leaving him it fades in over his own panel; landing back it fades into it.
      this.faceLed(r, e, b);
      drawFace(g, x, y, pitch, b, fit(flying, 0, 0.12), fit(flying, 0.3, 0.7));
    }
    return any;
  }

  private ask(g: G2, st: Station, here: boolean, ap: number) {
    const P = this.P, x = st.x - 150, w = 410, y = G - 346;
    g.globalAlpha = ap;
    this.plug(g, x + 30, G, here ? P.amber : P.line);
    g.globalAlpha = 1;
    if (!here) return;
    g.font = this.font(15, 400, false);
    const all = this.wrap(g, st.label, w - 32);
    const lines = all.slice(0, 4);
    if (all.length > 4) lines[3] = this.fit1(g, lines[3] + '…', w - 32);
    const lh = 21 * this.ts, h = 62 + lines.length * lh;
    g.strokeStyle = P.line; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x + 30, y + h); g.lineTo(x + 30, G - 5); g.stroke();
    const c = this.matBox(g, x, y, w, h, st.arr, P.cardLine, P.card);
    g.globalAlpha = c;
    g.font = this.font(12, 600);
    g.fillStyle = P.faint;
    g.fillText('YOU ASKED', x + 16, y + 24);
    g.textAlign = 'right';
    if (!st.past) g.fillText(clockOf(this.wall(st.t0)), x + w - 16, y + 24);
    g.textAlign = 'left';
    g.font = this.font(15, 400, false);
    g.fillStyle = P.ink;
    lines.forEach((l, i) => g.fillText(l, x + 16, y + 50 + i * lh));
    g.globalAlpha = 1;
    this.beam(g, st.arr, st.x, x, y, w, h, 91 + st.id);
    this.hit(x, y, w, h, `ask|${st.id}`, () => ({ k: 'YOU ASKED', title: st.label, rows: st.past ? [['From', 'before watch opened']] : [['At', clockOf(this.wall(st.t0))]] }));
  }

  // The Overview's large sculpture of a station at T: settled, no flashes or scramble. Returns its top and width.
  sculpture(g: G2, m: WatchModel, st: Station, T: number, C: number, cx: number, base: number) {
    const still = this.still, live = this.live, t0 = this.T, m0 = this.m;
    Object.assign(this, { still: true, live: false, T, m });
    const r = this.artifact(g, st, visibleRows(st, T), cx, base, C, !Number.isNaN(st.done) && T >= st.done);
    Object.assign(this, { still, live, T: t0, m: m0 });
    return r;
  }
  // Facts for the Overview: an agent's state at T and the panel row behind it.
  agentFacts(m: WatchModel, r: Row, T: number) {
    const m0 = this.m, t0 = this.T;
    this.m = m;
    this.T = T;
    const e = this.agentAt(r);
    this.m = m0;
    this.T = t0;
    return e;
  }

  // ---- The artifact: a small sculpture of cells, one row per thing he made here. ----
  private artifact(g: G2, st: Station, n: number, cx: number, base: number, C: number, done: boolean) {
    const P = this.P, T = this.T, gap = Math.round(C * 0.28), pw = 5 * (C + gap) + 6;
    g.fillStyle = P.ped; g.fillRect(cx - pw / 2, base - 7, pw, 7);
    g.fillStyle = P.pedTop; g.fillRect(cx - pw / 2, base - 7, pw, 1.2);
    const from = Math.max(0, n - ART_SHOWN);
    // Older rows sink into the pedestal; a count beside it says how many.
    if (from > 0) {
      g.font = `600 10px ${MONO}`;
      g.fillStyle = P.faint;
      g.textAlign = 'right';
      g.fillText(`×${from + 1}`, cx - pw / 2 - 5, base - 1);
      g.textAlign = 'left';
    }
    let top = base - 7;
    for (let r = from; r < n; r++) {
      const row = st.rows[r], it = cellOf(row, T, P, row.kind === 'agent' ? this.agentAt(row).state : '');
      const y = base - 7 - (r - from + 1) * (C + gap), x0 = cx - (it.n * (C + gap) - gap) / 2;
      top = y;
      for (let c = 0; c < it.n; c++) {
        const x = x0 + c * (C + gap), a = this.live ? this.age(it.t + c * 0.05) : 9;
        if (a < 0) continue;
        if (a < 0.3 && !this.still) {
          g.strokeStyle = P.morph; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, C - 1, C - 1);
          g.font = `${Math.round(C * 0.8)}px ${MONO}`; g.fillStyle = P.hot; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(GLY[(hash(c, it.t, Math.floor(a * 20)) * GLY.length) | 0], x + C / 2, y + C / 2 + 1);
          g.textAlign = 'left'; g.textBaseline = 'alphabetic';
          continue;
        }
        this.cell(g, it, x, y, C);
        if (a < 0.7 && !this.still) {
          g.globalAlpha = (1 - a / 0.7) * 0.6; g.fillStyle = P.flash; g.fillRect(x, y, C, C); g.globalAlpha = 1;
        }
      }
    }
    if (done) {
      const a = this.live ? this.age(st.done) : 9, w = 5 * (C + gap) - gap;
      g.globalAlpha = fit(a, 0, 0.4);
      g.fillStyle = P.hot; g.fillRect(cx - w / 2, top - gap - 3, w, 2);
      glow(g, cx, top - gap - 2, C * 3, 0.35, P.glowRgb);
      g.font = `600 13px ${MONO}`; g.fillStyle = P.amber; g.textAlign = 'center'; g.fillText('✓', cx, top - gap - 10); g.textAlign = 'left';
      g.globalAlpha = 1;
    }
    return { top: top - (done ? 26 : 4), w: pw };
  }
  private cell(g: G2, it: Cell, x: number, y: number, C: number) {
    const P = this.P, r = Math.max(2, C * 0.18);
    const box = ([f, s]: [string, string], lw = 1.2) => {
      g.fillStyle = f; g.strokeStyle = s; g.lineWidth = lw;
      g.beginPath(); g.roundRect(x + 0.5, y + 0.5, C - 1, C - 1, r); g.fill(); g.stroke();
    };
    switch (it.k) {
      case 'read': box(P.cRead); break;
      case 'search': box(P.cSearch); g.fillStyle = P.muted; g.beginPath(); g.arc(x + C / 2, y + C / 2, C * 0.16, 0, 7); g.fill(); break;
      case 'edit': box(P.cEdit); break;
      case 'new': box(P.cNew); break;
      case 'run': box(P.cRun); g.fillStyle = it.col ?? P.amber; g.fillRect(x + C * 0.25, y + C * 0.42, C * 0.5, C * 0.16); break;
      case 'fault': box(P.cFault); break;
      // Recovered: the red cell cools and gets a slash.
      case 'fixed': box(P.cFixed); g.strokeStyle = P.cFixed[1]; g.beginPath(); g.moveTo(x + 3, y + C - 3); g.lineTo(x + C - 3, y + 3); g.stroke(); break;
      case 'needs': {
        const c = it.col ?? P.amber;
        box([P.cRead[0], c]); g.strokeStyle = c; g.beginPath(); g.arc(x + C / 2, y + C / 2, C * 0.24, 0, 7); g.stroke();
        break;
      }
      case 'rich': box(P.cRich); break;
      case 'agent': {
        const c = it.col ?? P.amber;
        box([P.cRead[0], c]);
        g.fillStyle = c;
        const a0 = g.globalAlpha;
        for (let i = 0; i < 9; i++) {
          g.globalAlpha = a0 * (i % 2 ? 0.45 : 0.9);
          g.fillRect(x + C * (0.22 + 0.22 * (i % 3)) - 1, y + C * (0.22 + 0.22 * ((i / 3) | 0)) - 1, 2.2, 2.2);
        }
        g.globalAlpha = a0;
        break;
      }
      default: box(P.cOther);
    }
  }

  // ---- Rows under the floor, on one trunk line from the pad: the newest few, written left to right by the beam. ----
  private rows(g: G2, st: Station, n: number, x: number, yTop: number, y0: number, dy: number, maxW: number, size: number) {
    const P = this.P, T = this.T;
    if (!n) return;
    const from = Math.max(0, n - ROWS_SHOWN), earlier = from + (n === st.rows.length ? st.more : 0);
    const shown = n - from + (earlier ? 1 : 0);
    const last = y0 + (shown - 1) * dy;
    g.strokeStyle = P.line; g.lineWidth = 1.5; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(x, yTop); g.lineTo(x, last); g.stroke();
    let j = 0;
    if (earlier) {
      g.font = this.font(12.5);
      g.fillStyle = P.faint;
      g.textBaseline = 'middle';
      g.strokeStyle = P.line; g.beginPath(); g.moveTo(x, y0); g.lineTo(x + 9, y0); g.stroke();
      g.fillText(`+${earlier} earlier`, x + 16, y0 + 1);
      g.textBaseline = 'alphabetic';
      j = 1;
    }
    for (let k = from; k < n; k++, j++) {
      const r = st.rows[k], y = y0 + j * dy, a = this.live ? this.age(r.t) : 9;
      // Text appears left to right behind a bright edge, as the beam writes it.
      const rev = this.still ? 1 : fit(a, 0.08, 0.42, 0, 1, eo);
      g.globalAlpha = this.still ? 1 : fit(a, 0, 0.12);
      g.strokeStyle = P.line; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 9, y); g.stroke();
      g.textBaseline = 'middle';
      this.icon(g, r, x + 22, y);
      const tx = x + 38;
      const meta: [string, string][] = [];
      let name = r.label, col = P.ink, tMeta = r.t;
      if (r.kind === 'file') {
        name = r.label.slice(r.label.lastIndexOf('/') + 1) || r.label;
        col = r.mode === 'read' ? P.soft : P.ink;
        tMeta = r.tLast;
        if (r.mode === 'read') meta.push(['read', P.faint]);
        else {
          meta.push([`+${r.add}`, P.green], [`−${r.rm}`, P.red]);
          if (r.created) meta.push(['new', P.amber]);
        }
        if (r.err && r.res != null && T >= r.res) meta.push(['failed', P.red]);
      } else if (r.kind === 'run') {
        if (r.res != null && T >= r.res) (meta.push([r.err ? 'failed' : 'ok', r.err ? P.red : P.green]), (tMeta = r.res));
        else meta.push(['running', P.amber]);
      } else if (r.kind === 'search') (col = P.soft), meta.push(['search', P.faint]);
      else if (r.kind === 'needs') {
        if (r.res != null && T >= r.res) (meta.push([r.ans.toLowerCase() || 'answered', r.err ? P.faint : P.green]), (tMeta = r.res), (col = P.soft));
        else meta.push(['asked you', P.amber]);
      } else if (r.kind === 'fault') {
        const fixed = r.res != null && T >= r.res;
        col = fixed ? P.faint : P.red;
        if (fixed) (meta.push(['recovered', P.green]), (tMeta = r.res!));
      } else if (r.kind === 'agent') {
        const a = this.agentAt(r), s = a.state;
        meta.push([s === 'running' ? 'agent' : s === 'done' ? 'returned' : s, s === 'failed' ? P.red : s === 'done' ? P.green : P.faint]);
        if (s !== 'running') tMeta = a.end!;
      }
      g.font = this.font(size);
      const metaW = meta.reduce((w, [t]) => w + this.tw(g, t) + 8, 0);
      const shownName = this.fit1(g, name, maxW - 38 - metaW - 6);
      const nw = this.tw(g, shownName);
      const fullW = nw + 10 + metaW;
      g.save();
      if (rev < 1) (g.beginPath(), g.rect(tx - 2, y - 14, fullW * rev + 2, 28), g.clip());
      this.txt(g, shownName, tx, y + 1, col, r.t);
      if (r.kind === 'fault' && col === P.faint) (g.strokeStyle = P.faint), (g.lineWidth = 1), g.beginPath(), g.moveTo(tx, y + 1), g.lineTo(tx + nw, y + 1), g.stroke();
      let mx = tx + nw + 10;
      for (const [t, c] of meta) (this.txt(g, t, mx, y + 1, c, tMeta), (mx += this.tw(g, t) + 8));
      g.restore();
      if (rev > 0 && rev < 1) (g.fillStyle = P.hot), (g.globalAlpha = 0.9), g.fillRect(tx + fullW * rev, y - 9, 1.5, 18);
      g.textBaseline = 'alphabetic';
      g.globalAlpha = 1;
      this.beam(g, r.t, st.x, tx - 6, y - 10, Math.min(fullW, 220), 20, k + st.id * 7);
      if (r.tLast !== r.t) this.beam(g, r.tLast, st.x, tx - 6, y - 10, Math.min(fullW, 220), 20, k + 31);
      if (r.res != null) this.beam(g, r.res, st.x, tx - 6, y - 10, Math.min(fullW, 220), 20, k + 53);
      this.hit(x + 10, y - dy / 2 + 1, mx - x - 10, dy - 2, `row|${st.id}|${r.key}`, () => this.infoRow(st, r));
    }
  }
  private icon(g: G2, r: Row, cx: number, cy: number) {
    const P = this.P;
    g.lineWidth = 1.5;
    if (r.kind === 'file') {
      if (r.mode === 'read') {
        g.strokeStyle = P.muted; g.beginPath(); g.arc(cx, cy, 5.5, 0, 7); g.stroke();
        g.fillStyle = P.muted; g.beginPath(); g.arc(cx, cy, 1.8, 0, 7); g.fill();
      } else {
        g.fillStyle = r.created ? P.amber : P.cEdit[0]; g.strokeStyle = P.amber; g.lineWidth = 1.2;
        g.beginPath(); g.roundRect(cx - 6, cy - 6, 12, 12, 2.5); g.fill(); g.stroke();
      }
    } else if (r.kind === 'search') {
      g.strokeStyle = P.muted; g.beginPath(); g.arc(cx - 1.5, cy - 1.5, 4.5, 0, 7); g.moveTo(cx + 2, cy + 2); g.lineTo(cx + 6, cy + 6); g.stroke();
    } else if (r.kind === 'run') {
      g.font = `600 14px ${MONO}`; g.fillStyle = P.amber; g.textAlign = 'center'; g.fillText('$', cx, cy + 1); g.textAlign = 'left';
    } else if (r.kind === 'fault') {
      g.strokeStyle = r.res != null && this.T >= r.res ? P.faint : P.red; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx - 4.5, cy - 4.5); g.lineTo(cx + 4.5, cy + 4.5); g.moveTo(cx + 4.5, cy - 4.5); g.lineTo(cx - 4.5, cy + 4.5); g.stroke();
    } else if (r.kind === 'needs') {
      g.strokeStyle = r.res != null && this.T >= r.res ? (r.err ? P.faint : P.green) : P.amber; g.beginPath(); g.arc(cx, cy, 5, 0, 7); g.stroke();
    } else if (r.kind === 'agent') {
      const s = this.agentAt(r).state;
      g.fillStyle = s === 'running' ? P.amber : s === 'failed' ? P.red : s === 'done' ? P.green : P.muted;
      for (let i = 0; i < 9; i++) g.fillRect(cx - 5.5 + (i % 3) * 4.5, cy - 5.5 + ((i / 3) | 0) * 4.5, 2.2, 2.2);
    } else {
      g.fillStyle = r.kind === 'rich' ? P.green : P.muted;
      g.beginPath(); g.arc(cx, cy, 3, 0, 7); g.fill();
    }
  }

  // ---- Hover card content ----
  private infoStation(m: WatchModel, st: Station): Info {
    const T = this.T, here = m.stations.indexOf(st) < m.routeLen && T >= st.arr, done = !Number.isNaN(st.done) && T >= st.done;
    const n = here ? visibleRows(st, T) : 0;
    let read = 0, edited = 0, add = 0, rm = 0, runs = 0, searches = 0;
    for (let i = 0; i < n; i++) {
      const r = st.rows[i];
      if (r.kind === 'file') r.mode === 'read' ? read++ : (edited++, (add += r.add), (rm += r.rm));
      else if (r.kind === 'run') runs++;
      else if (r.kind === 'search') searches++;
    }
    const head = st.kind === 'step' ? `STEP ${st.num + 1}${st.plan ? ` OF ${st.plan.texts.length}` : ''}` : `${PHASE[st.phase ?? ''] ?? 'WORK'} PHASE`;
    const rows: [string, string, string?][] = [];
    if (here && !st.past) rows.push(['Arrived', `${clockOf(this.wall(st.arr))} · ${st.legs.map((l) => l.g).join(' + ')}`]);
    if (done && here && !st.past) rows.push(['Finished', `${clockOf(this.wall(st.done))} · ${dur(this.wall(st.done) - this.wall(st.arr))}`]);
    if (st.past) rows.push(['From', 'before watch opened']);
    if (here) rows.push(['Files', `${read} read, ${edited} edited`]);
    if (edited) rows.push(['Lines', `+${add} −${rm}`]);
    if (searches || runs) rows.push(['Calls', `${searches} search, ${runs} run`]);
    if (st.plan) rows.push(['Plan', st.plan.title || 'Plan']);
    return { k: `${head} · ${done ? 'DONE' : here ? 'IN PROGRESS' : 'NEXT'}`, title: st.label || 'Working', rows };
  }
  private infoRow(st: Station, r: Row): Info {
    const T = this.T, at = st.past ? 'before watch opened' : clockOf(r.w0);
    if (r.kind === 'file') {
      return {
        k: r.created ? 'FILE · CREATED' : r.mode === 'edited' ? 'FILE · EDITED' : 'FILE · READ', title: r.label.slice(r.label.lastIndexOf('/') + 1), path: r.label,
        rows: [['In', st.label], r.mode === 'edited' ? ['Lines here', `+${r.add} −${r.rm}`] : ['First read', at], ['Calls', String(r.n)]],
      };
    }
    if (r.kind === 'run') {
      const out = r.res != null && T >= r.res;
      return { k: 'COMMAND', tone: out ? (r.err ? 'red' : 'green') : '', title: `$ ${r.label}`, rows: [['Started', at], ['Result', out ? (r.err ? 'failed' : 'ok') : 'running', out ? (r.err ? 'r' : 'g') : 'a'], ...(out && !st.past ? [['Took', dur(this.took(r))] as [string, string]] : [])] };
    }
    if (r.kind === 'needs' || r.kind === 'fault') return this.infoCall(st, r);
    if (r.kind === 'agent') return this.infoAgent(st, r);
    const k = { search: 'SEARCH', agent: 'AGENT', rich: 'CARD', other: 'TOOL' }[r.kind as string] ?? 'TOOL';
    return { k, title: r.label, rows: [['At', at], ['In', st.label]] };
  }
  private infoAgent(st: Station, r: Row): Info {
    const e = this.agentAt(r), s = e.state, p = e.p, at = st.past ? 'before watch opened' : clockOf(r.w0);
    const rows: [string, string, string?][] = [['Started', at], ['In', st.label || 'Working']];
    if (s === 'running') rows.push(['Running for', dur(this.wall(this.T) - r.w0), 'a']);
    else if (!st.past) rows.push([s === 'done' ? 'Returned' : s === 'failed' ? 'Failed' : 'Stopped', `${clockOf(this.wall(e.end!))} · after ${dur(this.wall(e.end!) - r.w0)}`, s === 'done' ? 'g' : s === 'failed' ? 'r' : '']);
    if (p?.model) rows.push(['Model', p.model]);
    if (p?.steps?.task) rows.push(['Task', p.steps.task]);
    if (s === 'running' && e.fin === 'running' && p?.now) rows.push(['Now', p.now]);
    if (s !== 'running' && p?.said) rows.push(['Said', p.said, s === 'failed' ? 'r' : '']);
    const k = s === 'running' ? 'AGENT · RUNNING' : s === 'done' ? 'AGENT · RETURNED' : s === 'failed' ? 'AGENT · FAILED' : 'AGENT · STOPPED';
    return { k, tone: s === 'failed' ? 'red' : s === 'done' ? 'green' : '', title: p?.name || r.label, rows };
  }
  private infoCall(st: Station, r: Row): Info {
    const T = this.T, open = r.res === null || T < r.res, isNeeds = r.kind === 'needs';
    const at = st.past ? 'before watch opened' : clockOf(r.w0);
    const rows: [string, string, string?][] = [[isNeeds ? 'Asked' : 'At', at], ['In', st.label || 'Working']];
    if (open) rows.push([isNeeds ? 'Waiting' : 'Since', dur(this.wall(T) - r.w0), isNeeds ? 'a' : 'r']);
    else if (!st.past) rows.push([isNeeds ? r.ans || 'Answered' : 'Recovered', `after ${dur(this.took(r))}`, isNeeds && r.err ? '' : 'g']);
    return { k: isNeeds ? (open ? 'NEEDS YOU' : 'QUESTION') : open ? 'ERROR' : 'ERROR · RECOVERED', tone: isNeeds ? (open ? '' : 'green') : open ? 'red' : 'green', title: r.label, rows };
  }
  // Real time from a row to its outcome, cut idle included.
  private took(r: Row) {
    return (r.w1 ?? this.wall(r.res ?? r.t)) - r.w0;
  }
}

// When a station shows up on the floor: as he sets off toward it, or when a plan promised it.
export const shownAt = (st: Station) => (Number.isNaN(st.dep) ? st.t0 : Math.min(st.t0, st.dep));

// Rows already made by view time T; rows are kept in the order he makes them.
export function visibleRows(st: Station, T: number) {
  let n = st.rows.length;
  while (n > 0 && st.rows[n - 1].t > T) n--;
  return n;
}

function cellOf(r: Row, T: number, P: Pal, agent: string): Cell {
  switch (r.kind) {
    case 'file':
      if (r.mode === 'read') return { t: r.t, n: 2, k: 'read' };
      return { t: r.tEdit ?? r.t, n: clamp(1 + Math.round(Math.log2(r.add + r.rm + 1) / 1.6), 1, 5), k: r.created ? 'new' : 'edit' };
    case 'search': return { t: r.t, n: 1, k: 'search' };
    case 'run': return { t: r.t, n: 1, k: 'run', col: r.res != null && T >= r.res ? (r.err ? P.red : P.green) : P.amber };
    case 'fault': return { t: r.t, n: 2, k: r.res != null && T >= r.res ? 'fixed' : 'fault' };
    case 'needs': return { t: r.t, n: 1, k: 'needs', col: r.res != null && T >= r.res ? (r.err ? P.faint : P.green) : P.amber };
    case 'rich': return { t: r.t, n: 3, k: 'rich' };
    case 'agent': return { t: r.t, n: 1, k: 'agent', col: agent === 'running' ? P.amber : agent === 'failed' ? P.red : agent === 'done' ? P.green : P.faint };
    default: return { t: r.t, n: 1, k: 'other' };
  }
}

// Time of day for a wall time (epoch seconds), with the date when it is not today.
// Cached per second: ask cards call it every frame they are drawn.
const clocks = new Map<number, string>();
export const clockOf = (wall: number) => {
  const k = Math.floor(wall);
  let s = clocks.get(k);
  if (s !== undefined) return s;
  const d = new Date(k * 1000), p = (v: number) => String(v).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  s = d.toDateString() === new Date().toDateString() ? time : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
  if (clocks.size > 256) clocks.clear();
  clocks.set(k, s);
  return s;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
