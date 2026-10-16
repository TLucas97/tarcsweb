import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import { Matrix, onTheme, tick, watch, type AnyPattern, type LedPattern } from './led.tsx';
import type { Trip } from './robotDirector.ts';

// The robot: three slabs whose 3x3 dots are the LED panel. Each lit dot drives its own segment, and every state
// adds its own posture. Ported from notes/identity/logo/round3/motion2/index.html (the approved prototype).

// Local copy: bits.tsx renders Robot, so importing it from there makes a cycle.
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// The prototype's tuned values.
const TUNE = { speed: 1, motion: 1, glitch: 1, glow: 1, eyeFloor: 0.12, snap: 0.5 };

export type RobotState =
  | 'idle' | 'think' | 'search' | 'read' | 'edit' | 'run' | 'needs' | 'calm' | 'mark' | 'check' | 'fault' | 'delegating'
  | 'done' | 'error' | 'handoff' | 'restack' | 'boot' | 'travel' | 'stopped';
type Level = 'full' | 'mid' | 'tiny';
export type O = Record<string, number>;

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const hash = (q: number, a: number, b = 0) => {
  const x = Math.sin(q * 12.9898 + a * 78.233 + b * 37.719) * 43758.5453;
  return x - Math.floor(x);
};
export const eo = (x: number) => 1 - Math.pow(1 - x, 3);
export const eio = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const eob = (x: number) => 1 + 2.9 * Math.pow(x - 1, 3) + 1.9 * Math.pow(x - 1, 2);
const lin = (x: number) => x;
// Dossi's fit: remap a window of t to a range, with an ease.
export const fit = (v: number, a: number, b: number, lo = 0, hi = 1, ease = lin) => lo + (hi - lo) * ease(clamp((v - a) / (b - a), 0, 1));
export const pulse = (t: number, a: number, m: number, b: number) => (t < a || t >= b ? 0 : t < m ? eo((t - a) / (m - a)) : 1 - eio((t - m) / (b - m)));
export const bell = (u: number) => Math.sin(Math.PI * clamp(u, 0, 1));
export const ring = (x: number, f: number, z: number) => (x <= 0 ? 0 : Math.exp(-z * x) * Math.sin(2 * Math.PI * f * x));
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

// ---- Springs: Apple-style response and damping, sub-stepped at 240 Hz. ----
type Kind = 'servo' | 'pose' | 'wheel' | 'alpha' | 'slow' | 'hinge' | 'row' | 'pitch' | 'lean' | 'squash' | 'flip' | 'lift' | 'open' | 'bloom';
const KIND: Record<Kind, [number, number]> = {
  servo: [0.14, TUNE.snap], pose: [0.42, 0.78], wheel: [0.18, 0.5], alpha: [0.12, 1], slow: [0.5, 1],
  hinge: [0.3, 0.58], row: [0.46, 0.62], pitch: [0.24, 0.8], lean: [0.55, 0.72], squash: [0.2, 0.3], flip: [0.34, 0.85],
  // Takeoff into the hover: a little overshoot reads as floating.
  lift: [0.34, 0.6],
  // Clicked open: underdamped, so he pops open and closes with a small squeeze; the dots trail a little behind.
  open: [0.4, 0.58], bloom: [0.48, 0.72],
};
class Spring {
  rest: number;
  kind: Kind;
  amp: boolean;
  x: number;
  t: number;
  v = 0;
  ok = true;
  constructor(rest: number, kind: Kind, amp: boolean) {
    this.rest = this.x = this.t = rest;
    this.kind = kind;
    this.amp = amp;
  }
  advance(dt: number) {
    if (this.ok) return;
    const [r, z] = KIND[this.kind];
    const w = (2 * Math.PI) / r;
    let n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    while (n--) {
      this.v += (w * w * (this.t - this.x) - 2 * z * w * this.v) * h;
      this.x += this.v * h;
    }
    this.ok = Math.abs(this.t - this.x) < 0.01 && Math.abs(this.v) < 0.01;
    if (this.ok) (this.x = this.t), (this.v = 0);
  }
}
const NAMES: string[] = [];
const REST: Record<string, [number, Kind, boolean]> = {};
const def = (n: string, rest: number, kind: Kind, amp = true) => (NAMES.push(n), (REST[n] = [rest, kind, amp]));
for (let s = 0; s < 3; s++) {
  def(`s${s}.x`, 0, 'servo'); def(`s${s}.y`, s === 2 ? 16 : 0, 'servo'); def(`s${s}.r`, 0, 'pose'); def(`s${s}.yaw`, 0, 'pose');
  for (let k = 0; k < 3; k++) {
    def(`g${s}${k}.x`, 0, 'servo'); def(`g${s}${k}.y`, 0, 'servo'); def(`g${s}${k}.o`, 1, 'alpha', false);
    def(`g${s}${k}.r`, 0, 'hinge'); def(`g${s}${k}.f`, 0, 'flip', false);
  }
  def(`g${s}0.p`, 0, 'pitch'); def(`g${s}2.p`, 0, 'pitch');
}
def('b.x', 0, 'pose'); def('b.y', 0, 'pose'); def('b.r', 0, 'pose'); def('b.sc', 1, 'pose'); def('b.lean', 0, 'lean'); def('b.sq', 0, 'squash');
for (let k = 0; k < 3; k++) def(`row${k}.r`, 0, 'row');
def('w', 0, 'wheel', false); def('spin', 0, 'pose', false);
def('hy', 70, 'slow', false); def('ho', 0, 'alpha', false); def('vo', 0, 'alpha', false); def('go', 0, 'alpha', false);
// Height above the floor, in 512 units; only the strip robot leaves the ground. Poses never touch it.
def('lift', 0, 'lift', false);
// The clicked-open layer (0 shut, 1 open). Like the lift, no state or move pose ever sets it.
def('open', 0, 'open', false); def('bloom', 0, 'bloom', false);
const LAYER = new Set(['lift', 'open', 'bloom']);
// Moves leave the scan line alone too.
const MOVE_SKIP = new Set(['hy', ...LAYER]);
// The open pose, scaled by the `open` spring and added on top of any state or move: slabs fan out, segments part.
const OPEN: O = { 's0.x': -54, 's2.x': 54, 's0.r': -6, 's2.r': 6, 's1.y': -12, 's2.y': -12, 'b.sq': -3 };
for (let s = 0; s < 3; s++) (OPEN[`g${s}0.y`] = -16), (OPEN[`g${s}1.y`] = -6);
// Rings from the centre dot: the bloom reaches the centre first and the corners last, and leaves in reverse.
const RINGD = [2, 1, 2, 1, 0, 1, 2, 1, 2];
// Angles: a baked offset is wrapped, so an interrupted turn swings back the short way.
const ROT = new Set(NAMES.filter((n) => /\.(r|f)$/.test(n) || n === 'spin'));

// Spring names per slab and segment, built once, since the render loops run every frame.
const KS = [0, 1, 2].map((s) => ({
  x: `s${s}.x`, y: `s${s}.y`, r: `s${s}.r`, yaw: `s${s}.yaw`, p: `g${s}0.p`, p2: `g${s}2.p`,
  g: [0, 1, 2].map((k) => ({ x: `g${s}${k}.x`, y: `g${s}${k}.y`, o: `g${s}${k}.o`, r: `g${s}${k}.r`, f: `g${s}${k}.f` })),
}));
export const SEGS: [number, number][] = [];
for (let s = 0; s < 3; s++) for (let k = 0; k < 3; k++) SEGS.push([s, k]);
const DOT_Y = [158, 262, 364];
// Seams between segments and the middle of each, in 512 units: pivots for row and segment turns.
const SEAM = [210, 261.5, 313];
const MIDY = [139.5, 261.5, 378];
const ROWS = ['row0.r', 'row1.r', 'row2.r'];
const ERROR_POSE: O = { 's2.r': 5, 's2.y': 30, 's1.y': 6, 'b.r': 1.5, 's0.r': -2 };
const WHEEL = new Set<RobotState>(['handoff', 'restack']);

// ---- States: an LED pattern, a posture, and loops that react to the same LED events. ----
type Seq = { dur: number; fn(r: Rig, t: number, o: O): void; at?: [number, (r: Rig) => void][]; end?(r: Rig, o: O): void };
type Def = {
  led: AnyPattern;
  pose: O;
  floor?: boolean;
  poseAt?: boolean;
  // Springs the posture leaves where they are, e.g. the wheel carried from the handoff into the re-stack.
  keep?: string[];
  then?: RobotState;
  enter?(r: Rig): void;
  tick?(r: Rig, dt: number, t: number): void;
  hit?(r: Rig, i: number): void;
  seq?: Seq;
};
const ST: Record<RobotState, Def> = {
  idle: { led: 'eyes', pose: {} },
  think: {
    led: 'think', floor: true, pose: { 'b.r': -3, 's0.x': -6, 's2.x': 6, 's1.y': -12, 's0.yaw': 0.12 },
    tick(r, _dt, t) {
      const ph = Math.floor(t / 1.3) % 2;
      r.tgt('b.r', ph ? 4 : -4); r.tgt('s1.y', ph ? -4 : -16); r.tgt('s0.yaw', ph ? 0 : 0.16); r.tgt('s2.yaw', ph ? 0.16 : 0);
      // Every 1.3 s one slab ripples its segments sideways, top to bottom: it is rearranging itself.
      const n = Math.floor((t + 0.65) / 1.3);
      if (n === r.knock) return;
      r.knock = n;
      if (t <= 0.4) return;
      const s = (Math.random() * 3) | 0;
      const dir = Math.random() < 0.5 ? -1 : 1;
      for (let k = 0; k < 3; k++) r.later(k * 0.06, () => r.hop(`g${s}${k}.x`, 18 * dir, 0.22));
    },
    hit(r, i) {
      const s = i % 3, k = (i / 3) | 0;
      r.hop(`g${s}${k}.x`, (Math.random() < 0.5 ? -1 : 1) * 14, 0.12);
      r.hop(`g${s}${k}.y`, -10, 0.12);
    },
  },
  search: {
    led: 'search', floor: true, pose: { 'b.sc': 0.97, vo: 0.85 },
    tick(r, _dt, t) {
      const p = Math.sin((t * Math.PI * 2) / 1.6);
      r.vx = 256 + 200 * p;
      r.tgt('b.x', -14 * p); r.tgt('s1.x', 8 * p); r.tgt('b.r', 2.5 * p); r.tgt('s0.yaw', Math.max(0, p) * 0.28); r.tgt('s2.yaw', Math.max(0, -p) * 0.28);
    },
    hit(r, i) {
      const s = i % 3, k = (i / 3) | 0;
      r.hop(`g${s}${k}.x`, (s - 1) * 16, 0.1);
      r.hop(`g${s}${k}.y`, (k - 1) * 16, 0.1);
    },
  },
  read: {
    led: 'read', floor: true, pose: { 'b.sc': 1.03, 's0.x': 5, 's2.x': -5, 'b.y': -4, ho: 0.75, hy: 158 },
    hit(r, i) {
      const row = (i / 3) | 0, c = i % 3;
      for (let s = 0; s < 3; s++) {
        r.tgt(`g${s}${row}.x`, (c + 1) * 7);
        if (row > 0) r.tgt(`g${s}${row - 1}.x`, 0);
      }
      r.tgt('hy', DOT_Y[row]);
      if (i === 8) r.later(0.16, () => { for (let s = 0; s < 3; s++) r.tgt(`g${s}2.x`, 0); r.tgt('hy', 110); });
    },
  },
  edit: {
    led: 'edit', floor: true, pose: { 'b.y': 6, 's0.x': 3, 's2.x': -3, 'b.sc': 0.99 },
    tick(r) {
      const n = r.m.hold.size;
      if (r.held > 0 && n === 0) r.editClear();
      r.held = n;
    },
    hit(r, i) {
      const s = i % 3, k = (i / 3) | 0;
      r.hop(`g${s}${k}.y`, 18, 0.07); r.hop(`s${s}.y`, 6, 0.07); r.hop('b.y', 3, 0.05);
    },
  },
  run: {
    led: 'run', floor: true, pose: { 'b.r': -2, 'b.y': -6 },
    tick(r) {
      const q = Math.floor(r.T * 20);
      if (q !== r.jq) (r.jq = q), r.tgt('b.x', rand(-1.5, 1.5));
    },
    hit(r, i) {
      const c = i % 3;
      if (r.kickK[c] === r.m.k) return;
      r.kickK[c] = r.m.k;
      r.hop(`s${c}.y`, -32, 0.08); r.hop('b.y', -5, 0.06); r.hop('b.r', c === 1 ? 0 : c ? 1.5 : -1.5, 0.08);
      for (let k = 0; k < 3; k++) r.later(k * 0.025, () => r.hop(`g${c}${k}.y`, -8, 0.06));
    },
  },
  needs: {
    led: 'needs', pose: { 's0.r': -7, 's2.r': 7, 's0.x': -12, 's2.x': 12, 's1.y': -8, 'b.sc': 1.02 },
    tick(r, _dt, t) {
      r.tgt('b.sc', 1.02 + 0.025 * Math.cos((t / 2) * Math.PI * 2));
      const n = Math.floor((t + 0.25) / 2);
      if (n === r.knock) return;
      r.knock = n;
      if (t > 0.5) (r.knock2(), r.later(0.15, () => r.knock2()));
    },
  },
  calm: { led: 'calm', pose: {} },
  delegating: { led: 'delegating', pose: {} },
  mark: { led: 'mark', pose: {} },
  check: { led: 'check', pose: {} },
  fault: { led: 'fault', pose: ERROR_POSE },
  done: {
    led: 'check', pose: {},
    seq: {
      dur: 1.3,
      fn(r, t, o) {
        const p = pulse(t, 0, 0.12, 0.4);
        o['s0.x'] = 26 * p; o['s2.x'] = -26 * p; o['s0.r'] = 4 * p; o['s2.r'] = -4 * p;
        o['b.sc'] = -0.08 * p + 0.1 * pulse(t, 0.12, 0.28, 0.62);
        o['s1.y'] = -22 * pulse(t, 0.12, 0.26, 0.6);
        o['b.y'] = 26 * pulse(t, 0.32, 0.42, 0.72); o['b.r'] = -3 * pulse(t, 0.32, 0.42, 0.72);
        o.go = pulse(t, 0.36, 0.48, 0.86);
        r.gx = fit(t, 0.36, 0.86, -160, 680);
      },
    },
  },
  error: {
    led: 'fault', pose: ERROR_POSE, poseAt: true,
    seq: {
      dur: 1.5,
      fn(_r, t, o) {
        const g = 1 - fit(t, 0.22, 0.4), q = Math.floor(t * 30);
        if (g <= 0) return;
        for (const [s, k] of SEGS) {
          o[`g${s}${k}.x`] = g * 26 * (hash(q, s, k) - 0.5) * 2;
          o[`g${s}${k}.y`] = g * 8 * (hash(q, k, s + 5) - 0.5) * 2;
        }
        o['b.x'] = g * 8 * (hash(q, 9) - 0.5) * 2;
      },
      at: [[0, (r) => r.burst(1.2, 0.45)], [0.28, (r) => (r.pose(ERROR_POSE), r.imp('s2.y', 200))], [0.99, (r) => r.errorTwitch()]],
    },
  },
  // A handoff or compaction in progress: the outer segments split, the slabs fold into a wheel, and it ratchets round.
  handoff: {
    led: 'edit', pose: {},
    enter(r) {
      r.later(0.34, () => r.tgt('w', 0.34));
      r.later(0.51, () => r.tgt('w', 0.67));
      r.later(0.68, () => r.tgt('w', 1));
      r.later(1.3, () => r.ratchet());
    },
    tick(r, _dt, t) {
      const w = r.C.w.x;
      const sp = fit(t, 0, 0.34, 0, 1, eo);
      for (const [s, k] of SEGS) if (k !== 1) r.off[`g${s}${k}.y`] = (k ? 1 : -1) * (18 * sp + 24 * w);
      r.off['s2.y'] = -16 * Math.min(1, w + fit(t, 0.17, 0.34));
    },
  },
  // Handing over: a last fast spin, the wheel unfolds and the slabs re-stack. The prototype's handoff from 0.28 on.
  restack: {
    led: 'think', pose: {}, keep: ['w', 'spin'], then: 'idle',
    seq: {
      dur: 2.45,
      fn(r, t, o) {
        const T = 0.28 + 0.72 * t, w = r.C.w.x;
        for (const [s, k] of SEGS) {
          if (k === 1) continue;
          const n = s * 2 + (k ? 1 : 0), back = fit(T, 0.8 + n * 0.022, 0.88 + n * 0.022, 0, 1, eob);
          o[`g${s}${k}.y`] = (k ? 1 : -1) * (18 * (1 - back) + 24 * w);
        }
        o['s2.y'] = -16 * Math.min(1, w + (1 - fit(T, 0.86, 0.96)));
        o.spin = r.goal * fit(T, 0.3, 0.76, 0, 1, eio);
      },
      at: [
        [0, (r) => (r.goal = Math.ceil((r.C.spin.t + 1) / 360) * 360 + 360 - r.C.spin.t)],
        [(0.77 - 0.28) / 0.72, (r) => (r.tgt('w', 0), r.burst(0.8, 0.3))],
        [(0.86 - 0.28) / 0.72, (r) => { for (let i = 0; i < 9; i++) r.m.hit(i, 1.4); r.m.set('mark'); }],
        [(0.97 - 0.28) / 0.72, (r) => (r.m.set('eyes'), (r.m.b[3] = r.m.b[5] = 1.6))],
      ],
      end: (r, o) => r.settleSpin(o),
    },
  },
  // Self-test as the old Boot.tsx did it (dots 0 to 8, 45 ms apart, then the mark); segments drop in, eyes open, the right slab sags.
  boot: {
    led: 'dark', pose: {}, then: 'idle',
    hit: (r, i) => r.imp(`g${i % 3}${(i / 3) | 0}.y`, -90),
    seq: {
      dur: 2.8,
      fn(r, t, o) {
        const off = fit(t, 0, 0.08, 0, 1, eo);
        for (const [s, k] of SEGS) {
          const n = s * 3 + k, a = 0.1 + n * 0.03, u = fit(t, a, a + 0.09);
          o[`g${s}${k}.o`] = t < 0.1 ? -off : u - 1;
          o[`g${s}${k}.y`] = t < 0.1 ? 22 * off : -80 * (1 - eob(u));
        }
        for (let s = 0; s < 3; s++) o[`s${s}.yaw`] = 0.4 * pulse(t, 0.58 + s * 0.05, 0.62 + s * 0.05, 0.7 + s * 0.05);
        o['s2.y'] = t < 0.1 ? 0 : -16 * (1 - fit(t, 0.88, 1, 0, 1, eob));
        o.hy = fit(t, 0.38, 0.55, 0, 380);
        o.ho = 0.9 * pulse(t, 0.38, 0.41, 0.56);
        const ms = (t - 0.56) * 2.8;
        if (ms >= 0) {
          const i = Math.floor(ms / 0.045);
          if (i < 9) r.m.hit(i, 1);
        }
      },
      at: [
        [0.1, (r) => r.burst(0.6, 0.25)],
        [0.56 + 0.55 / 2.8, (r) => (r.m.set('mark'), r.cue('mark'))],
        [0.86, (r) => (r.m.set('eyes'), (r.m.b[3] = r.m.b[5] = 1.8), r.cue('ready'))],
      ],
    },
  },
  // On the way to the strip's start spot: the LED already shows the work, the body only travels.
  travel: { led: 'think', floor: true, pose: {} },
  // Esc: the lights fold into the centre and go out, a small slump, eyes half shut, then he is himself again.
  stopped: {
    led: 'dark', pose: {}, then: 'idle',
    enter(r) {
      r.light('collapse', 0.4);
      r.imp('b.sq', 70);
      for (let s = 0; s < 3; s++) r.tgt(`g${s}0.p`, 0.35);
      r.lidL = r.lidR = 0.55;
      r.later(0.35, () => { for (let s = 0; s < 3; s++) r.tgt(`g${s}0.p`, 0); });
      r.later(0.45, () => r.m.set('eyes'));
      r.later(0.75, () => (r.lidL = r.lidR = 0));
    },
  },
};

export const ledOf = (s: RobotState) => ST[s].led;

// ---- Light gestures: a second 9-dot layer composited with max(), so a move adds light and never hides the LED state. ----
type Light = { tau: number; step(f: Fx, k: number): void };
class Fx {
  b = new Float32Array(9);
  g: Light | null = null;
  k = 0;
  acc = 0;
  left = 0;
  busy = false;
  hit(i: number, v: number) {
    this.b[i] = Math.max(this.b[i], v);
    this.busy = true;
  }
  update(dt: number) {
    if (this.g) {
      this.acc += dt;
      while (this.acc >= 0.05) (this.acc -= 0.05), this.k++, this.g.step(this, this.k);
      this.left -= dt;
    }
    const f = Math.exp(-dt / (this.g?.tau ?? 0.18));
    if (this.g && this.left <= 0) this.g = null;
    let any = false;
    for (let i = 0; i < 9; i++) {
      this.b[i] *= f;
      if (this.b[i] < 0.004) this.b[i] = 0;
      else any = true;
    }
    this.busy = !!this.g || any;
  }
  clear() {
    this.b.fill(0);
    this.g = null;
    this.busy = false;
  }
}
const RING = [0, 1, 2, 5, 8, 7, 6, 3];
// Lights the dots of `order` one after another, `every` ticks apart; `keep` leaves the earlier ones lit.
const build = (order: number[], every: number, v = 1, keep = true) => (f: Fx, k: number) => {
  const n = Math.floor((k - 1) / every);
  for (let j = 0; j <= Math.min(n, order.length - 1); j++) if (keep || j === n) f.hit(order[j], v);
};
export const LIGHT: Record<string, Light> = {
  pillar: { tau: 0.3, step: build([7, 4, 1], 3, 0.85) },
  ring: { tau: 0.2, step: (f, k) => k % 2 === 0 && f.hit(RING[(k / 2) % 8], 1) },
  climb: { tau: 0.3, step(f, k) { const c = Math.floor(k / 4) % 5; if (k % 4 === 0 && c < 3) f.hit([6, 4, 2][c], 1); } },
  burst: { tau: 0.35, step(f, k) { for (let i = 0; i < 9; i++) f.hit(i, k === 1 ? 1.3 : 0.32); } },
  caret: { tau: 0.25, step: build([6, 3, 1, 5, 8], 2) },
  vee: { tau: 0.25, step: build([7, 3, 5, 0, 2], 2) },
  chevR: { tau: 0.25, step: build([0, 4, 6], 2) },
  chevL: { tau: 0.25, step: build([2, 4, 8], 2) },
  trickle: { tau: 0.3, step(f, k) { const r = Math.floor((k - 1) / 4); if ((k - 1) % 4 === 0 && r < 3) for (let c = 0; c < 3; c++) f.hit(r * 3 + c, 0.9); } },
  warm: { tau: 0.5, step(f, k) { const b = 0.55 + 0.45 * (0.5 - 0.5 * Math.cos((k / 14) * Math.PI)); f.hit(4, b); f.hit(3, 0.6 + 0.6 * b); f.hit(5, 0.6 + 0.6 * b); } },
  heart: { tau: 0.18, step(f, k) { const q = k % 18, v = q < 2 || (q >= 4 && q < 6) ? 1.35 : 0.85; for (const i of [0, 2, 3, 4, 5, 7]) f.hit(i, v); } },
  surprise: { tau: 0.12, step(f) { f.hit(3, 1.6); f.hit(5, 1.6); f.hit(7, 0.9); } },
  kitt: { tau: 0.22, step: (f, k) => k % 2 === 0 && f.hit([3, 4, 5, 4][(k / 2) % 4], 1.1) },
  zz: { tau: 0.6, step(f, k) { const q = k % 30; if (q === 1) f.hit(8, 0.5); if (q === 10) f.hit(5, 0.55); if (q === 19) f.hit(2, 0.6); } },
  query: { tau: 0.2, step: (f, k) => k % 10 < 5 && f.hit(2, 1) },
  impact: { tau: 0.25, step(f, k) { if (k === 1) for (const i of [6, 7, 8]) f.hit(i, 1.4); } },
  sparkle: { tau: 0.12, step(f) { if (Math.random() < 0.7) f.hit((Math.random() * 9) | 0, rand(0.7, 1.2)); } },
  ping: { tau: 0.22, step(f, k) { const q = k % 16; if (q === 1) f.hit(4, 1.3); if (q === 3) for (const i of [1, 3, 5, 7]) f.hit(i, 0.9); if (q === 5) for (const i of [0, 2, 6, 8]) f.hit(i, 0.55); } },
  ellipsis: { tau: 0.2, step: (f, k) => k % 4 === 1 && f.hit([6, 7, 8][Math.floor(k / 4) % 3], 1) },
  fill: { tau: 0.4, step(f, k) { const r = Math.min(2, Math.floor((k - 1) / 3)); for (let j = 0; j <= r; j++) for (let c = 0; c < 3; c++) f.hit((2 - j) * 3 + c, 0.8); } },
  zed: { tau: 0.25, step: build([0, 1, 2, 4, 6, 7, 8], 1, 0.9) },
  feet: { tau: 0.18, step: (f, k) => k % 3 === 0 && f.hit([6, 7, 8, 7][(k / 3) % 4], 1) },
  // Esc: whatever was lit folds into the centre dot and goes out.
  collapse: { tau: 0.16, step(f, k) { if (k === 1) for (const i of RING) f.hit(i, 0.7); if (k === 3) for (const i of [1, 3, 5, 7]) f.hit(i, 0.85); if (k === 5) f.hit(4, 1.3); } },
};

// ---- Moves: one-off acts an idle director plays (see robotDirector.ts), on top of the current state. ----
export type Move = {
  name: string;
  dur?: number;
  // A held posture: springs go there, stay `hold` seconds, then come back.
  pose?: O | ((d: number) => O);
  hold?: number;
  spread?: number;
  lid?: [number, number];
  light?: string | ((d: number) => string);
  lightDur?: number;
  z?: number[];
  piv?: [number, number][];
  cues?: [number, (r: Rig) => void][];
  // Offsets by seconds into the move; they are baked into the springs when it ends or is cut.
  seq?: (r: Rig, s: number, o: O) => void;
  enter?(r: Rig): void;
  after?(r: Rig): void;
};
// d: the side the move faces; n and seen: per-move counters; trip (and back): travel plans for moves that walk or roll.
export type Playing = { id: string; by: string; M: Move; tok: number; dur: number; d: number; n: number; seen: Set<number>; trip?: Trip; back?: Trip };

// ---- Views, all on canvas: no style or layout work per frame, only one bitmap to repaint. ----
// full: every effect; mid: slabs, segments and LEDs; tiny: the small mark, LEDs plus one slab offset.
const CX = [139, 256, 373];
const HX = [198, 256, 318];
const WA = [-60, 0, 60];
// mark.svg's slabs: face, bevel (outer slabs) and hinge, in its 512-unit space; x0/x1 bound the drawing.
const SLABS = [
  { fx: 84, fw: 114, bevel: [88, 64], hinge: 194, x0: 60, x1: 206 },
  { fx: 203, fw: 106, bevel: null, hinge: 309, x0: 199, x1: 321 },
  { fx: 318, fw: 110, bevel: [424, 448], hinge: 0, x0: 314, x1: 452 },
];
const ART_Y = [62, 447];
const BANDS = [[-200, 210], [210, 313], [313, 700]];
const dotR = (s: number, k: number) => (s === 1 && k === 1 ? 14 : 28);
// The canvas covers this much more than the box on each side, so moves past the box are not cut.
const BLEED = 64;

type Slice = { on: boolean; y: number; h: number; dx: number; life: number; q: number };
type Ctx = CanvasRenderingContext2D;
const lg = (c: Ctx, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]) => {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  for (const [o, col] of stops) g.addColorStop(o, col);
  return g;
};
const rg = (c: Ctx, x: number, y: number, r: number, stops: [number, string][]) => {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  for (const [o, col] of stops) g.addColorStop(o, col);
  return g;
};
const canvasOf = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
};

// Static art is baked once per scale (device px per unit): each slab, the lit eye and its glow.
type Baked = { slabs: HTMLCanvasElement[]; eye: HTMLCanvasElement[]; glow: HTMLCanvasElement[] };
const baked = new Map<number, Baked>();
function bake(k: number): Baked {
  const hit = baked.get(k);
  if (hit) return hit;
  if (baked.size > 8) baked.clear();
  const slabs = SLABS.map((S, s) => {
    const c = canvasOf((S.x1 - S.x0) * k, (ART_Y[1] - ART_Y[0]) * k);
    const g = c.getContext('2d')!;
    g.setTransform(k, 0, 0, k, -S.x0 * k, -ART_Y[0] * k);
    if (S.bevel) {
      const [a, b] = S.bevel;
      g.fillStyle = lg(g, Math.min(a, b), 0, Math.max(a, b), 0, [[0, '#7a6f62'], [0.35, '#b0a494'], [1, '#8d8274']]);
      g.beginPath();
      g.moveTo(a, 70); g.lineTo(b, 86); g.lineTo(b, 426); g.lineTo(a, 442);
      g.closePath();
      g.fill();
    }
    g.beginPath();
    g.roundRect(S.fx, 69, S.fw, 374, 7);
    g.fillStyle = lg(g, 0, 69, 0, 443, [[0, '#2e2d2a'], [1, '#252421']]);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = '#0d0c0b';
    g.stroke();
    // Faint seams where the segments part; at rest they read as panel lines.
    for (const y of [210, 313]) {
      g.globalAlpha = 0.45;
      g.fillStyle = '#0d0c0b';
      g.fillRect(S.fx + 4, y - 1, S.fw - 8, 2);
      g.globalAlpha = 0.18;
      g.fillStyle = '#6a6358';
      g.fillRect(S.fx + 4, y + 1, S.fw - 8, 1);
    }
    g.globalAlpha = 1;
    for (let j = 0; j < 3; j++) {
      const d = dotR(s, j), x = CX[s], y = DOT_Y[j];
      g.fillStyle = '#141311';
      g.beginPath();
      g.arc(x, y, d + 4, 0, 7);
      g.fill();
      g.fillStyle = rg(g, x - 0.24 * d, y - 0.36 * d, 1.5 * d, [[0, '#8a8172'], [0.55, '#5c554b'], [1, '#3a3630']]);
      g.beginPath();
      g.arc(x, y, d, 0, 7);
      g.fill();
    }
    if (S.hinge) {
      g.fillStyle = lg(g, S.hinge, 0, S.hinge + 10, 0, [[0, '#6d6357'], [0.5, '#a99c8c'], [1, '#5a5248']]);
      for (const y of [66, 417]) {
        g.beginPath();
        g.roundRect(S.hinge, y, 10, 26, 3);
        g.fill();
      }
    }
    return c;
  });
  // Index 0: the 28-unit dots, 1: the small center dot.
  const eye = [28, 14].map((d) => {
    const c = canvasOf(2 * d * k + 2, 2 * d * k + 2);
    const g = c.getContext('2d')!;
    g.setTransform(k, 0, 0, k, c.width / 2, c.height / 2);
    g.fillStyle = rg(g, -0.1 * d, -0.2 * d, 1.3 * d, [[0, '#ffe58a'], [0.6, '#f2c255'], [1, '#c58f22']]);
    g.beginPath();
    g.arc(0, 0, d, 0, 7);
    g.fill();
    return c;
  });
  const glow = [28, 14].map((d) => {
    const r = 1.8 * d;
    const c = canvasOf(2 * r * k + 2, 2 * r * k + 2);
    const g = c.getContext('2d')!;
    g.setTransform(k, 0, 0, k, c.width / 2, c.height / 2);
    g.fillStyle = rg(g, 0, 0, r, [[0.45, 'rgb(232 182 76 / .55)'], [0.7, 'rgb(232 182 76 / .18)'], [1, 'rgb(232 182 76 / 0)']]);
    g.fillRect(-r, -r, 2 * r, 2 * r);
    return c;
  });
  const out = { slabs, eye, glow };
  baked.set(k, out);
  return out;
}

// Canvases cannot read CSS variables; the floor's shade follows the page theme and repaints when it changes.
const dark = () => document.documentElement.dataset.theme === 'dark';

const DEG = Math.PI / 180;
// A baked sprite drawn centered on (x, y), `scale` times its natural size.
const sprite = (g: Ctx, c: HTMLCanvasElement, k: number, x: number, y: number, scale = 1) => {
  const w = (c.width / k) * scale;
  g.drawImage(c, x - w / 2, y - w / 2, w, w);
};

// The full and mid robot, ported from the prototype's SVG rig (same transform chain per slab and segment).
const rotAbout = (g: Ctx, x: number, y: number, a: number) => {
  g.translate(x, y);
  g.rotate(a * DEG);
  g.translate(-x, -y);
};

// Canvas reach around the 512 box, in units: box robots get a margin all round, the strip robot room to stride and hop.
export type Reach = { l: number; t: number; w: number; h: number };
const BOX: Reach = { l: BLEED, t: BLEED, w: 512 + 2 * BLEED, h: 512 + 2 * BLEED };
export const STRIP_REACH: Reach = { l: 230, t: 330, w: 972, h: 800 };

function rigView(host: HTMLElement, r: Rig, px: number, full: boolean, tile: boolean, strip: boolean, reach = BOX) {
  // Twice the device resolution: the box can land on a half pixel, and sprites move by fractions; both blur at 1x.
  const dpr = Math.min(2, devicePixelRatio || 1) * 2;
  const R = strip ? STRIP_REACH : reach;
  const u = px / 512;
  const cv = canvasOf(R.w * u * dpr, R.h * u * dpr);
  cv.style.cssText = strip
    ? `position:absolute;left:0;top:0;width:${R.w * u}px;height:${R.h * u}px;will-change:transform`
    : `width:${R.w * u}px;height:${R.h * u}px;margin:${-R.t * u}px ${(512 + R.l - R.w) * u}px ${(512 + R.t - R.h) * u}px ${-R.l * u}px`;
  host.replaceChildren(cv);
  r.cv = cv;
  const ctx = cv.getContext('2d')!;
  const k = cv.width / R.w;
  const art = bake(k);
  // Glitch slices copy the body alone, shifted; it goes through this buffer only while a slice is on.
  let buf: HTMLCanvasElement | null = null;
  // The motion3 chain: body lean and squash about the feet, then per segment a row turn, the slab, its hinge,
  // the segment's own turn, pitch and flip. Slabs draw in r.z order.
  const body = (g: Ctx) => {
    g.setTransform(k, 0, 0, k, R.l * k, R.t * k);
    g.translate(r.V('b.x'), r.V('b.y') - r.hover());
    const lean = r.V('b.lean'), sq = r.V('b.sq') / 100;
    if (lean || sq) {
      g.translate(256, 443);
      g.rotate(lean * DEG);
      g.scale(1 + 0.5 * sq, 1 - sq);
      g.translate(-256, -443);
    }
    g.translate(256, 256);
    g.rotate(r.V('b.r') * DEG);
    g.scale(r.V('b.sc'), r.V('b.sc'));
    g.translate(-256, -256);
    const base = g.getTransform();
    const w = clamp(r.C.w.x + (r.off.w || 0), -0.2, 1.3), spin = r.V('spin');
    for (const s of r.z) {
      const S = SLABS[s], K = KS[s], hx = HX[s], cx = CX[s];
      const yaw = full ? clamp(r.V(K.yaw), 0, 0.9) : 0;
      const r1 = r.V(K.g[1].r);
      for (let j = 0; j < 3; j++) {
        const Gs = K.g[j], o = clamp(r.V(Gs.o), 0, 1);
        if (o < 0.005) continue;
        g.setTransform(base);
        const rr = r.V(ROWS[j]);
        if (rr) rotAbout(g, 256, SEAM[j], rr);
        g.translate(r.V(K.x), r.V(K.y));
        g.translate(256, 256);
        g.rotate((w * WA[s] + spin) * DEG);
        g.translate(-256 + w * (256 - cx), -256);
        g.translate(cx, 443);
        g.rotate(r.V(K.r) * DEG);
        g.translate(hx - cx, -443);
        if (yaw) g.scale(1 - 0.62 * yaw, 1);
        g.translate(-hx, 0);
        g.translate(r.V(Gs.x), r.V(Gs.y));
        if (r1) rotAbout(g, cx, SEAM[1], r1);
        if (j !== 1) {
          const rj = r.V(Gs.r);
          if (rj) rotAbout(g, cx, r.piv[s][j] ? MIDY[j] : SEAM[j], rj);
        }
        const p = j === 1 ? 0 : clamp(r.V(j ? K.p2 : K.p), 0, 0.95);
        if (p) {
          g.translate(0, SEAM[j]);
          g.scale(1, 1 - 0.7 * p);
          g.translate(0, -SEAM[j]);
        }
        const f = r.V(Gs.f);
        let fl = 0;
        if (f) {
          const c = Math.cos(f * DEG);
          fl = 1 - Math.abs(c);
          g.translate(0, MIDY[j]);
          g.scale(1, Math.max(0.03, Math.abs(c)));
          g.translate(0, -MIDY[j]);
        }
        const y0 = Math.max(BANDS[j][0], ART_Y[0]), y1 = Math.min(BANDS[j][1], ART_Y[1]);
        g.globalAlpha = o;
        g.drawImage(art.slabs[s], 0, (y0 - ART_Y[0]) * k, (S.x1 - S.x0) * k, (y1 - y0) * k, S.x0, y0, S.x1 - S.x0, y1 - y0);
        // A slab turning away, pitching or flipping darkens.
        const shade = Math.max(yaw * 0.55, p * 0.5, fl * 0.6);
        if (shade > 0.01) {
          g.save();
          g.beginPath();
          g.rect(S.fx - 2, y0, S.fw + 4, y1 - y0);
          g.clip();
          g.globalAlpha = o * shade;
          g.fillStyle = '#000';
          g.beginPath();
          g.roundRect(S.fx, 69, S.fw, 374, 7);
          g.fill();
          g.restore();
        }
        const b = r.lit(j * 3 + s);
        if (b > 0.01) {
          const small = s === 1 && j === 1 ? 1 : 0, a = o * Math.min(1, b * 1.05), bl = r.bloomOf(j * 3 + s);
          g.globalAlpha = a * 0.86 * TUNE.glow;
          sprite(g, art.glow[small], k, cx, DOT_Y[j], (b > 1.02 ? 1 + 0.4 * (b - 1) : 1) * (1 + 0.55 * bl));
          g.globalAlpha = a;
          sprite(g, art.eye[small], k, cx, DOT_Y[j], 1 + 0.4 * bl);
        }
      }
    }
    g.globalAlpha = 1;
  };
  return () => {
    const g = ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(k, 0, 0, k, R.l * k, R.t * k);
    if (tile) {
      g.fillStyle = '#1e1d1a';
      g.beginPath();
      g.roundRect(0, 0, 512, 512, 114);
      g.fill();
    }
    if (strip) {
      // Contact shade on the floor; it shrinks and fades as he leaves the ground.
      const up = Math.max(0, r.hover() - r.V('b.y')), sh = 1 - Math.min(0.6, up / 260);
      const feet = (r.V('s0.x') + r.V('s1.x') + r.V('s2.x')) / 3;
      g.globalAlpha = sh;
      g.fillStyle = dark() ? 'rgb(10 9 8 / .55)' : 'rgb(43 42 39 / .1)';
      g.beginPath();
      g.roundRect(80 + (356 * (1 - sh)) / 2 + r.V('b.x') + feet, 441, 356 * sh, 9, 4.5);
      g.fill();
      g.globalAlpha = 1;
    } else {
      g.fillStyle = dark() ? 'rgb(18 17 15 / .8)' : 'rgb(43 42 39 / .08)';
      g.beginPath();
      g.roundRect(72, 440, 372, 10, 5);
      g.fill();
    }
    if (!full) return body(g);
    if (!r.SL.some((s) => s.on)) body(g);
    else {
      buf ??= canvasOf(cv.width, cv.height);
      const b = buf.getContext('2d')!;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.clearRect(0, 0, buf.width, buf.height);
      body(b);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(buf, 0, 0);
      for (const s of r.SL) {
        if (!s.on) continue;
        // The band shows the page under it, then the body shifted sideways and a faint amber wash.
        g.setTransform(k, 0, 0, k, R.l * k, R.t * k);
        g.clearRect(14, s.y, 484, s.h);
        g.save();
        g.beginPath();
        g.rect(14, s.y, 484, s.h);
        g.clip();
        g.setTransform(1, 0, 0, 1, s.dx * k, 0);
        g.drawImage(buf, 0, 0);
        g.restore();
        g.globalAlpha = 0.06;
        g.fillStyle = '#e8b64c';
        g.fillRect(14, s.y, 484, s.h);
        g.globalAlpha = 1;
      }
    }
    // Scan line, search beam and the done glint, inside the face area.
    const ho = clamp(r.V('ho'), 0, 1), vo = clamp(r.V('vo'), 0, 1), go = clamp(r.V('go'), 0, 1);
    if (ho < 0.005 && vo < 0.005 && go < 0.005) return;
    g.setTransform(k, 0, 0, k, R.l * k, R.t * k);
    g.save();
    g.beginPath();
    g.roundRect(60, 62, 392, 396, 10);
    g.clip();
    if (ho >= 0.005) {
      const y = r.V('hy');
      g.globalAlpha = ho;
      g.fillStyle = lg(g, 0, y - 16, 0, y, [[0, 'rgb(232 182 76 / 0)'], [1, 'rgb(232 182 76 / .28)']]);
      g.fillRect(60, y - 16, 392, 16);
      g.fillStyle = '#ffd27a';
      g.fillRect(60, y - 1, 392, 2);
    }
    if (vo >= 0.005) {
      const x = r.vx;
      g.globalAlpha = vo;
      g.fillStyle = lg(g, x - 34, 0, x + 34, 0, [[0, 'rgb(232 182 76 / 0)'], [0.5, 'rgb(232 182 76 / .2)'], [1, 'rgb(232 182 76 / 0)']]);
      g.fillRect(x - 34, 62, 68, 396);
      g.globalAlpha = vo * 0.8;
      g.fillStyle = '#ffd27a';
      g.fillRect(x - 1, 62, 2, 396);
    }
    if (go >= 0.005) {
      g.translate(r.gx, 0);
      g.rotate(18 * DEG);
      g.fillStyle = '#fff4dc';
      g.globalAlpha = go * 0.22;
      g.fillRect(-30, -120, 34, 760);
      g.globalAlpha = go * 0.16;
      g.fillRect(12, -120, 8, 760);
    }
    g.restore();
    g.globalAlpha = 1;
  };
}

// One glow sprite for every small robot, drawn once.
let tinyGlow: HTMLCanvasElement | null = null;
function glowSprite() {
  if (tinyGlow) return tinyGlow;
  tinyGlow = canvasOf(64, 64);
  const g = tinyGlow.getContext('2d')!;
  g.fillStyle = rg(g, 32, 32, 32, [[0.3, 'rgb(232 182 76 / .6)'], [1, 'rgb(232 182 76 / 0)']]);
  g.fillRect(0, 0, 64, 64);
  return tinyGlow;
}

// The small mark (svg/mark-small.svg) on a canvas, since many sit on screen at once: dots are LEDs, and only the
// right slab moves, snapped to whole pixels. A frame that looks the same as the last one is not drawn.
function tinyView(host: HTMLElement, r: Rig, px: number, tile: boolean) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const cv = canvasOf(px * dpr, px * dpr);
  host.replaceChildren(cv);
  const ctx = cv.getContext('2d')!;
  const k = cv.width / 32;
  const unit = 32 / px;
  const xs = [6, 16, 26], ys = [9, 15.5, 22];
  const shown = new Float32Array(10).fill(-1);
  const now = new Float32Array(10);
  return () => {
    // The biggest vertical move of any slab drives the right slab.
    let dev = 0;
    for (let s = 0; s < 3; s++) {
      const K = KS[s];
      const d = r.V(K.y) - r.C[K.y].rest + (r.V(K.g[0].y) + r.V(K.g[1].y) + r.V(K.g[2].y)) / 3;
      if (Math.abs(d) > Math.abs(dev)) dev = d;
    }
    now[9] = Math.round((2 + clamp(dev / 4 + r.V('b.y') / 8 - 2 * clamp(r.C.w.x, 0, 1), -4, 3)) / unit) * unit;
    let same = now[9] === shown[9];
    for (let i = 0; i < 9; i++) {
      now[i] = Math.round(Math.min(1.2, r.lit(i)) * 32) / 32;
      same &&= now[i] === shown[i];
    }
    if (same) return;
    shown.set(now);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, 32, 32);
    ctx.globalAlpha = 1;
    if (tile) {
      ctx.fillStyle = '#1e1d1a';
      ctx.beginPath();
      ctx.roundRect(0, 0, 32, 32, 7);
      ctx.fill();
    }
    for (let s = 0; s < 3; s++) {
      const dy = s === 2 ? now[9] : 0;
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#3d3a34';
      ctx.beginPath();
      ctx.roundRect(xs[s] - 4, 5 + dy, 8, 21, 1);
      ctx.fill();
      for (let j = 0; j < 3; j++) {
        const c = s === 1 && j === 1, cx = xs[s], cy = ys[j] + dy, b = now[j * 3 + s];
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#6a6358';
        ctx.beginPath();
        ctx.arc(cx, cy, c ? 1 : 1.7, 0, 7);
        ctx.fill();
        if (b < 0.01) continue;
        const g = c ? 3 : 4.6;
        ctx.globalAlpha = Math.min(0.9, 0.9 * b) * TUNE.glow;
        ctx.drawImage(glowSprite(), cx - g, cy - g, g * 2, g * 2);
        ctx.globalAlpha = Math.min(1, b * 1.05);
        ctx.fillStyle = '#f2c255';
        ctx.beginPath();
        ctx.arc(cx, cy, c ? 1.5 : 2.6, 0, 7);
        ctx.fill();
      }
    }
  };
}

// ---- The rig: one per robot on screen. One state, one sequence progress, one timer queue on its own clock. ----
type Timer = { at: number; fn: () => void; tag: string };
// driven: an outside loop calls step() (watch mode), so the rig never joins the ticker on its own.
type RigOpts = { level: Level; px: number; tile: boolean; still: boolean; strip?: boolean; reach?: Reach; cue: (c: string) => void; driven?: boolean };
// Fall from the hover, in units/s²: about a quarter second from the working row to the floor.
const FALL_G = 9000;
// Hover bob, in units and seconds: a pixel at 48 px.
const BOB: [number, number] = [11, 2.4];

export class Rig {
  C: Record<string, Spring> = {};
  springs: Spring[] = [];
  m = new Matrix('eyes');
  fx = new Fx();
  SL: Slice[] = [];
  // Moves: per-eye lids, slab draw order, segments that turn about their middle, the move playing and its offsets.
  lidL = 0;
  lidR = 0;
  z = [0, 1, 2];
  piv = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  move: Playing | null = null;
  mseq: { fn: NonNullable<Move['seq']>; t: number; dur: number; o: O } | null = null;
  private tok = 0;
  cv: HTMLCanvasElement | null = null;
  // Strip robot: where its 512 box starts in the strip (px; the hero's side step uses units), whether it hovers, and a fall.
  wx = 0;
  hovering = false;
  falling = false;
  onStep: (() => void) | null = null;
  onLand: (() => void) | null = null;
  // Pointer around the robot in -1..1, or null; an idle director sets it.
  pointer: () => { nx: number; ny: number } | null = () => null;
  state: RobotState = 'calm';
  led: AnyPattern | null = null;
  st = 0;
  T = 0;
  off: O = {};
  // Gait offsets written by a host every frame (watch mode's walk), added on top of everything else.
  goff: O = {};
  driven = false;
  seq: (Seq & { t: number; fired: number }) | null = null;
  timers: Timer[] = [];
  lid = 0;
  held = 0;
  knock = -1;
  jq = -1;
  kickK = [-1, -1, -1];
  vx = 256;
  gx = -200;
  goal = 0;
  eyeFloor = false;
  level: Level;
  still: boolean;
  // Off screen, or not the lead character: holds its resting frame and does not tick.
  seen = true;
  benched = false;
  dead = false;
  cue: (c: string) => void;
  render: () => void;
  private sub: (() => void) | null = null;
  private wakeT = 0;
  private sleptAt = 0;
  private unwatch: () => void;
  private unTheme: () => void;

  constructor(host: HTMLElement, o: RigOpts) {
    for (const n of NAMES) this.springs.push((this.C[n] = new Spring(...REST[n])));
    this.level = o.level;
    this.still = o.still;
    this.cue = o.cue;
    this.driven = !!o.driven;
    if (o.level === 'full') this.SL = Array.from({ length: 6 }, () => ({ on: false, y: 0, h: 0, dx: 0, life: 0, q: -1 }));
    this.render = o.level === 'tiny' ? tinyView(host, this, o.px, o.tile) : rigView(host, this, o.px, o.level === 'full', o.tile, !!o.strip, o.reach);
    this.m.onHit = (i) => ST[this.state].hit?.(this, i);
    // Only a robot on screen runs.
    this.unwatch = this.driven ? () => {} : watch(host, (v) => {
      this.seen = v;
      if (v) this.wake();
      else this.sleep();
    });
    // The floor's shade follows the theme even while the robot sleeps.
    this.unTheme = o.level === 'tiny' ? () => {} : onTheme(() => this.render());
  }

  destroy() {
    this.dead = true;
    this.unTheme();
    this.unwatch();
    this.sub?.();
    this.sub = null;
    clearTimeout(this.wakeT);
    this.timers = [];
  }

  V(n: string) {
    // Hovering by the working line he sinks a little as he opens, so the parted top stays inside the strip.
    const c = this.C[n], w = OPEN[n] ?? (n === 'b.y' ? 36 * clamp(this.C.lift.x / 150, 0, 1) : 0);
    const x = c.x + (this.off[n] || 0) + (this.goff[n] || 0) + (w ? w * this.C.open.x : 0);
    return c.amp ? c.rest + (x - c.rest) * TUNE.motion : x;
  }
  // The open bloom per dot, 0 to a little over 1; it only ever lights dots on the idle face, so a work pattern stays readable.
  bloomOf(i: number) {
    const B = this.C.bloom.x, a = 0.24 * RINGD[i];
    return B <= a ? 0 : Math.min(1.3, (B - a) / (1 - a));
  }
  lit(i: number) {
    const b = this.m.b[i];
    // Delegating: the orbit is the information, so idle acts add no light over it.
    const v = Math.max(this.eyeFloor && (i === 3 || i === 5) ? Math.max(b, TUNE.eyeFloor) : b, this.m.name === 'delegating' ? 0 : this.fx.b[i]);
    return this.m.name === 'eyes' && this.C.bloom.x > 0 ? Math.max(v, 0.95 * Math.min(1, this.bloomOf(i))) : v;
  }
  // Height above the floor in units, with the hover's bob once he is up.
  hover() {
    const x = this.C.lift.x + (this.off.lift || 0);
    if (!this.hovering || this.still || x < 1) return x;
    return x + BOB[0] * Math.sin((this.T * 2 * Math.PI) / BOB[1]) * Math.min(1, x / 200);
  }
  light(name: string, dur?: number) {
    const L = LIGHT[name];
    if (!L || this.still) return;
    Object.assign(this.fx, { g: L, k: 0, acc: 0, left: dur ?? 1.6, busy: true });
    this.wake();
  }
  tgt(n: string, v: number) {
    const c = this.C[n];
    c.t = v;
    c.ok = false;
  }
  imp(n: string, v: number) {
    const c = this.C[n];
    c.v += v;
    c.ok = false;
  }
  // Servo hop: jump the target by a step, hold, then step back; overlapping hops add up.
  hop(n: string, v: number, hold = 0.09) {
    this.tgt(n, this.C[n].t + v);
    this.later(hold, () => this.tgt(n, this.C[n].t - v));
  }
  pose(o: O, keep: string[] = []) {
    for (const n of NAMES) if (!LAYER.has(n) && !keep.includes(n)) this.tgt(n, o[n] ?? this.C[n].rest);
  }
  // A move's posture: slabs set off a little apart, from the side the move faces.
  setPose(p: O, spread = 0.05) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (const n of NAMES) {
      if (MOVE_SKIP.has(n)) continue;
      const v = p[n] ?? this.C[n].rest;
      if (this.C[n].t === v) continue;
      const s = n[0] === 's' || n[0] === 'g' ? +n[1] : -1;
      const d = s < 0 || !spread ? 0 : spread * (dir > 0 ? s : 2 - s);
      if (!d) this.tgt(n, v);
      else this.later(d, () => this.tgt(n, v), 'move');
    }
  }
  later(d: number, fn: () => void, tag = 'state') {
    this.timers.push({ at: this.now() + d, fn, tag });
    if (!this.sub && this.sleptAt) this.arm();
  }
  // Sim time that keeps running while asleep, so a timer set then counts from now, not from when it fell asleep.
  now() {
    return this.sleptAt ? this.T + ((performance.now() - this.sleptAt) / 1000) * TUNE.speed : this.T;
  }
  clearTimers(...tags: string[]) {
    this.timers = this.timers.filter((x) => !tags.includes(x.tag));
  }
  // An interrupted sequence hands its current offsets to the springs, so the next state starts from where the body is.
  bake(o: O) {
    for (const n in o) {
      this.C[n].x += ROT.has(n) ? wrap180(o[n]) : o[n];
      this.C[n].ok = false;
    }
  }

  // ---- Moves: one at a time, cut by a token; a cut hands its offsets to the springs. ----
  side() {
    const p = this.pointer();
    return p ? (p.nx >= 0 ? 1 : -1) : Math.random() < 0.5 ? -1 : 1;
  }
  play(id: string, M: Move, by: string, hold?: number) {
    this.stopMove();
    // The side reads the pointer against the strip's box, so only moves that face a side ask for it.
    const tok = ++this.tok, d = typeof M.pose === 'function' || typeof M.light === 'function' ? this.side() : 1;
    const mv: Playing = { id, by, M, tok, dur: M.dur ?? (M.hold ?? 2.2) + 0.9, d, n: -1, seen: new Set() };
    this.move = mv;
    if (this.still || this.benched) {
      this.move = null;
      return M.after?.(this);
    }
    if (M.z) this.z = M.z.slice();
    for (const [s, k] of M.piv ?? []) this.piv[s][k] = 1;
    M.enter?.(this);
    const pose = typeof M.pose === 'function' ? M.pose(d) : M.pose;
    if (pose) {
      const h = hold ?? M.hold ?? 2.2;
      mv.dur = h + 0.9;
      this.setPose(pose, M.spread ?? 0.05);
      if (M.lid) [this.lidL, this.lidR] = M.lid;
      this.later(h, () => (this.setPose({}, 0.04), (this.lidL = this.lidR = 0)), 'move');
    }
    const ln = typeof M.light === 'function' ? M.light(d) : M.light;
    if (ln) this.light(ln, M.lightDur ?? (pose ? mv.dur - 0.9 : mv.dur));
    for (const [at, fn] of M.cues ?? []) this.later(at, () => this.move?.tok === tok && fn(this), 'move');
    if (M.seq) this.mseq = { fn: M.seq, t: 0, dur: mv.dur, o: {} };
    this.later(mv.dur + 0.05, () => this.finish(tok), 'move');
    this.wake();
  }
  private finish(tok: number) {
    if (this.move?.tok !== tok) return;
    const M = this.move.M;
    this.move = null;
    this.lidL = this.lidR = 0;
    M.after?.(this);
  }
  stopMove() {
    if (!this.move) return;
    this.clearTimers('move');
    const q = this.mseq;
    if (q) {
      this.bake(q.o);
      for (const n in q.o) this.off[n] = (this.off[n] ?? 0) - q.o[n];
      this.mseq = null;
    }
    for (const n of ROT) this.C[n].x = wrap180(this.C[n].x);
    this.pose(ST[this.state].pose);
    Object.assign(this, { lidL: 0, lidR: 0, move: null });
    this.fx.g = null;
    this.wake();
  }
  // Draw order and pivots go back once nothing moves, so a cut move never leaves a slab drawn out of order.
  private tidy() {
    if (this.move) return;
    if (this.z[0] !== 0 || this.z[1] !== 1) this.z = [0, 1, 2];
    for (const p of this.piv) p.fill(0);
  }
  land(v: number) {
    this.imp('b.sq', v * 0.6);
    for (let s = 0; s < 3; s++) (this.imp(`g${s}0.y`, v * 0.9), this.imp(`g${s}1.y`, v * 0.45));
    this.light('impact', 0.1);
  }
  // The new pattern's first frame now, so the LED changes on the same frame as the text next to it.
  prime() {
    this.m.b.fill(0);
    this.m.p.step(this.m);
    if (this.still || this.benched) this.m.still();
    this.render();
  }
  // Strip robot: up into the hover (a short crouch first), or a fall back to the floor that lands with a squash.
  rise(to: number) {
    this.falling = false;
    this.hovering = true;
    if (this.still || this.benched) return this.snapLift(to);
    this.tgt('b.sq', 7);
    this.later(0.07, () => {
      this.tgt('b.sq', 0);
      this.imp('b.sq', -60);
      this.tgt('lift', to);
    }, 'air');
    this.wake();
  }
  fall() {
    this.clearTimers('air');
    this.hovering = false;
    const c = this.C.lift;
    c.t = 0;
    if (this.still || this.benched || c.x < 1) return this.snapLift(0);
    // A fall starts from rest: an upward bob or the takeoff's overshoot would read as a second hop.
    c.v = Math.min(0, c.v);
    this.falling = true;
    this.wake();
  }
  snapLift(to: number) {
    const c = this.C.lift;
    c.t = c.x = to;
    c.v = 0;
    c.ok = true;
    this.render();
    this.onStep?.();
  }
  // Clicked open or shut. Springs retarget from wherever they are, so a click mid-close re-opens without a snap.
  openUp(on: boolean) {
    const v = on ? 1 : 0, o = this.C.open, b = this.C.bloom;
    if (o.t === v) return;
    if (this.still || this.benched || !this.seen || document.hidden) {
      for (const c of [o, b]) Object.assign(c, { x: v, t: v, v: 0, ok: true });
      this.render();
      this.onStep?.();
      // Reduced motion: no travel, only a short fade into the new frame.
      if (this.still && !document.hidden) this.cv?.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
      return;
    }
    this.tgt('open', v);
    this.tgt('bloom', v);
    // A small crouch before the pop.
    if (on) this.imp('b.sq', 45);
    this.wake();
  }
  // Leaving the wheel: keep the visible angle but drop whole turns, so the slabs swing back to upright the short way.
  settleSpin(o: O) {
    const s = this.C.spin;
    const vis = s.x + (o.spin ?? 0);
    const n = Math.round(vis / 360) * 360;
    s.x = vis - n;
    s.t = 0;
    s.ok = false;
    delete o.spin;
  }
  knock2() {
    this.hop('s2.y', -26, 0.07);
  }
  blink() {
    this.lid = 1;
    this.later(0.11, () => (this.lid = 0), 'idle');
  }
  ratchet() {
    if (this.state !== 'handoff') return;
    this.tgt('spin', this.C.spin.t + 60);
    this.later(0.75, () => this.ratchet());
  }
  editClear() {
    this.burst(0.7, 0.22);
    SEGS.forEach(([s, k], n) => this.later(n * 0.012, () => {
      this.tgt(`g${s}${k}.x`, (Math.random() < 0.5 ? -1 : 1) * rand(10, 22));
      this.later(0.1, () => this.tgt(`g${s}${k}.x`, 0));
    }));
  }
  errorTwitch() {
    if (this.state !== 'error') return;
    const [s, k] = SEGS[(Math.random() * 9) | 0];
    this.tgt(`g${s}${k}.x`, (Math.random() < 0.5 ? -1 : 1) * 14);
    this.later(0.08, () => this.tgt(`g${s}${k}.x`, 0));
    if (Math.random() < 0.5) this.burst(0.3, 0.12);
    this.later(rand(2.2, 3.6), () => this.errorTwitch());
  }
  // Glitch slices: thin bands of the body shifted sideways in 20 fps steps, then slid back.
  burst(a: number, dur = 0.2) {
    a *= TUNE.glitch;
    if (a < 0.03 || !this.SL.length) return;
    const n = Math.min(6, Math.round(1 + a * 3.5));
    for (let i = 0; i < n; i++) {
      Object.assign(this.SL[i], { on: true, life: dur * rand(0.6, 1.2), y: rand(70, 430), h: rand(4, 6 + 24 * Math.min(1.4, a + 0.3)), dx: (Math.random() < 0.5 ? -1 : 1) * rand(6, 36) * a, q: -1 });
    }
  }
  slices(dt: number) {
    const q = Math.floor(this.T * 20);
    for (const s of this.SL) {
      if (!s.on) continue;
      if (s.life > 0) {
        s.life -= dt;
        if (q === s.q) continue;
        s.q = q;
        if (Math.random() < 0.35) s.dx = -s.dx * rand(0.4, 1.2);
        if (Math.random() < 0.2) s.y = clamp(s.y + rand(-30, 30), 70, 440);
      } else {
        s.dx *= Math.exp(-dt / 0.045);
        if (Math.abs(s.dx) < 0.3) s.on = false;
      }
    }
  }

  set(name: RobotState, led: AnyPattern | null = null, { quiet = false, from = 0, force = false } = {}) {
    if (name === this.state && !force) {
      if (led === this.led) return;
      this.led = led;
      this.m.set(led ?? ST[name].led);
      // A still robot never ticks, so the new pattern's resting frame is drawn now.
      if (this.still || this.benched) this.stillFrame();
      return;
    }
    const was = this.state;
    // Only a folded wheel can re-stack; anything else just rests.
    if (name === 'restack' && was !== 'handoff' && !this.still) name = 'idle';
    // A new state cuts an idle act; the trip to the strip's start spot runs to its end.
    if (this.move && this.move.by !== 'turn') this.stopMove();
    const d = ST[name];
    if (!(was === 'handoff' && name === 'restack')) {
      if (WHEEL.has(was) && !WHEEL.has(name)) this.settleSpin(this.off);
      this.bake(this.off);
    }
    this.off = {};
    this.seq = null;
    this.gx = -200;
    this.clearTimers('state', 'idle');
    Object.assign(this, { state: name, led, st: 0, lid: 0, lidL: 0, lidR: 0, held: 0, knock: -1, kickK: [-1, -1, -1], eyeFloor: !!d.floor });
    this.m.reset(led ?? d.led);
    this.pose(d.poseAt ? {} : d.pose, was === 'handoff' ? d.keep : []);
    if (this.still || this.benched) return this.stillFrame();
    // Starting part-way skips the cues before (and at) that point.
    if (d.seq) this.seq = { ...d.seq, t: from, fired: from > 0 ? d.seq.at?.filter(([t]) => t <= from).length ?? 0 : 0 };
    if (!quiet) this.burst(0.4, 0.18);
    d.enter?.(this);
    this.wake();
  }
  // Reduced motion, or a robot that is not the lead: the settled pose and the pattern's resting frame, drawn once.
  stillFrame() {
    const d = ST[this.state];
    this.sleep();
    this.pose(d.pose);
    for (const n of NAMES) {
      const c = this.C[n];
      c.x = c.t;
      c.v = 0;
      c.ok = true;
    }
    this.off = {};
    this.seq = null;
    for (const s of this.SL) s.on = false;
    this.clearTimers('state', 'idle', 'move', 'air');
    // A trip cut short still arrives, so the strip knows where he is.
    const arrive = this.move?.by === 'turn' ? this.move.M.after : null;
    Object.assign(this, { lid: 0, lidL: 0, lidR: 0, move: null, mseq: null, falling: false, z: [0, 1, 2] });
    for (const p of this.piv) p.fill(0);
    this.fx.clear();
    this.m.reset(d.then ? 'eyes' : this.led ?? d.led);
    this.m.still();
    this.render();
    this.onStep?.();
    arrive?.(this);
  }
  hold(on: boolean) {
    if (on === this.benched || this.dead) return;
    this.benched = on;
    if (on) this.stillFrame();
    else this.set(this.state, this.led, { quiet: true, force: true });
  }

  step(dt: number) {
    this.T += dt;
    this.st += dt;
    if (this.timers.length) {
      this.timers.sort((a, b) => a.at - b.at);
      while (this.timers.length && this.timers[0].at <= this.T) this.timers.shift()!.fn();
    }
    const d = ST[this.state];
    d.tick?.(this, dt, this.st);
    // A move's offsets and the state's sequence add up; with neither, the state's tick owns `off`.
    let o: O | null = null;
    const ms = this.mseq;
    if (ms) {
      ms.t = Math.min(1, ms.t + dt / ms.dur);
      const om: O = {};
      ms.fn(this, ms.t * ms.dur, om);
      ms.o = om;
      if (ms.t >= 1) (this.bake(om), (this.mseq = null));
      else o = om;
    }
    const q = this.seq;
    if (q) {
      q.t = Math.min(1, q.t + dt / q.dur);
      const at = q.at ?? [];
      while (q.fired < at.length && at[q.fired][0] <= q.t) at[q.fired++][1](this);
      const os: O = {};
      q.fn(this, q.t, os);
      if (q.t >= 1) {
        q.end?.(this, os);
        this.bake(os);
        this.off = o ?? {};
        this.seq = null;
        if (d.then) this.set(d.then, null, { quiet: true });
      } else {
        o ??= {};
        for (const n in os) o[n] = (o[n] ?? 0) + os[n];
      }
    }
    if (ms || q) this.off = o ?? {};
    if (this.falling) {
      const c = this.C.lift;
      c.v -= FALL_G * dt;
      c.x += c.v * dt;
      c.ok = true;
      if (c.x <= 0) {
        c.x = c.v = 0;
        this.falling = false;
        this.land(260);
        this.onLand?.();
      }
    }
    for (const c of this.springs) c.advance(dt);
    this.m.lid = this.lid;
    this.m.lidL = this.lidL;
    this.m.lidR = this.lidR;
    this.m.update(dt);
    if (this.fx.busy || this.fx.g) this.fx.update(dt);
    if (this.SL.length) this.slices(dt);
    if (!this.busy()) this.tidy();
    this.render();
    this.onStep?.();
  }
  busy() {
    // A move holding a pose is not busy: its timers wake the loop when the pose lets go.
    if (this.seq || this.mseq || this.falling || this.m.busy || this.fx.busy || this.SL.some((s) => s.on)) return true;
    for (const c of this.springs) if (!c.ok) return true;
    return false;
  }
  private frame = (dt: number) => {
    this.step(dt * TUNE.speed);
    if (!this.busy()) this.sleep();
  };
  // The shared ticker runs only while something moves; asleep, the next timer wakes it. A hidden tab stops the ticker.
  wake = () => {
    if (this.sub || !this.seen || this.still || this.benched || this.dead || this.driven) return;
    clearTimeout(this.wakeT);
    // Time asleep still counts for timers; physics dt stays clamped.
    if (this.sleptAt) this.T += ((performance.now() - this.sleptAt) / 1000) * TUNE.speed;
    this.sleptAt = 0;
    this.sub = tick(this.frame);
  };
  private sleep() {
    this.sub?.();
    this.sub = null;
    if (this.driven) return;
    this.sleptAt = performance.now();
    this.arm();
  }
  private arm() {
    clearTimeout(this.wakeT);
    if (!this.timers.length || !this.seen || this.still || this.benched) return;
    let next = Infinity;
    for (const x of this.timers) next = Math.min(next, x.at);
    this.wakeT = window.setTimeout(this.wake, Math.max(0, ((next - this.now()) * 1000) / TUNE.speed));
  }
}

// Only one full-body character moves at a time: the newest lead; the others hold their resting frame.
const leads: Rig[] = [];
const crown = () => leads.forEach((r, i) => r.hold(i !== leads.length - 1));
export function joinLeads(r: Rig) {
  leads.push(r);
  crown();
  return () => {
    leads.splice(leads.indexOf(r), 1);
    r.hold(false);
    crown();
  };
}

type Props = {
  state: RobotState;
  // Box size in CSS px: 80 and up gets every effect, 32 to 79 the slabs and segments, below 32 the small mark.
  size: number;
  // Overrides the state's LED pattern, e.g. the handoff's phases.
  led?: LedPattern;
  // A full-body character that takes part in "one at a time".
  lead?: boolean;
  still?: boolean;
  tile?: boolean;
  // Starts a sequence part-way, e.g. the boot from dark instead of powering down first.
  from?: number;
  onCue?: (cue: string) => void;
  className?: string;
};

// Decorative, so it is aria-hidden; the state lives in real text next to it. The idle hero is HeroRobot (robotHero.tsx).
export function Robot({ state, size, led, lead = false, still = false, tile, from = 0, onCue, className = '' }: Props) {
  const host = useRef<HTMLSpanElement>(null);
  const rig = useRef<Rig | null>(null);
  const level: Level = size >= 80 ? 'full' : size >= 32 ? 'mid' : 'tiny';
  const withTile = tile ?? level === 'tiny';
  const cue = useEffectEvent((c: string) => onCue?.(c));
  const first = useEffectEvent(() => ({ state, led, from }));

  // Before paint, so the robot never shows unposed.
  useLayoutEffect(() => {
    const el = host.current!;
    const r = new Rig(el, { level, px: size, tile: withTile, still: still || reduceMotion(), cue: (c) => cue(c) });
    rig.current = r;
    const f = first();
    r.set(f.state, f.led ?? null, { quiet: true, from: f.from, force: true });
    r.render();
    return () => {
      r.destroy();
      rig.current = null;
      el.replaceChildren();
    };
  }, [level, size, withTile, still]);

  useEffect(() => {
    rig.current?.set(state, led ?? null);
  }, [state, led]);

  useEffect(() => {
    const r = rig.current;
    if (!lead || !r || level === 'tiny') return;
    return joinLeads(r);
  }, [lead, level, size, withTile, still]);

  return <span ref={host} className={`rbt ${level}${className ? ` ${className}` : ''}`} style={{ width: size, height: size }} aria-hidden="true" />;
}
