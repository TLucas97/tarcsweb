import { SEGS, Rig, bell, eio, eo, eob, fit, hash, pulse, rand, ring, type Move, type O } from './robot.tsx';

// The idle director shared by the strip robot and the hero: the move catalogue (notes/identity/logo/round3/motion3),
// travel, and one calmNow() gate with tiers. Any real input cuts a big act and yields; typing keeps him in place.

export type Table = Record<string, [number, number]>;
export type Pace = { first: readonly [number, number]; rest: readonly [number, number]; small: readonly [number, number]; typing: readonly [number, number] };
type Tier = 'free' | 'typing' | 'yield';
export type Stage = {
  moves: Record<string, Move>;
  // [weight, cooldown s] per act. Big acts run only in the free tier; typing allows in-place ones.
  big: Table;
  small: Table;
  typing: Table;
  pace: Pace;
  // Room above the head, in 512 units.
  headroom(): number;
  // A client point around him, in -1..1. Called in a frame, never in an event.
  around(x: number, y: number): { nx: number; ny: number };
  caret(): { nx: number; ny: number };
  // The host owns him for now (the strip's turn): no idle acts and no blinks.
  busy(): boolean;
  // How likely an eligible act is; 0 skips it. Default: never the same act twice in a row.
  weight?(id: string, w: number, again: boolean, last: number | undefined): number;
};

// How long a click or conversation scroll holds him, and how long typing stays the tier after the last key.
const YIELD = 1.5;
const TYPE_HOLD = 3;

export const rowP = (k: number, key: string, v: number): O => Object.fromEntries([0, 1, 2].map((s) => [`g${s}${k}.${key}`, v]));
const rows = (o: O, k: number, key: string, v: number) => {
  for (let s = 0; s < 3; s++) o[`g${s}${k}.${key}`] = v;
};
const hop = (r: Rig, n: string, v: number, hold = 0.09) => {
  r.tgt(n, r.C[n].t + v);
  r.later(hold, () => r.tgt(n, r.C[n].t - v), 'move');
};
const mv = (r: Rig) => r.move!;
const dirs = new WeakMap<Rig, Director>();
const dir = (r: Rig) => dirs.get(r)!;

// ---- Travel: a gait whose planted slabs never slide, and a roll that folds into the wheel. Positions in px, `u` px per unit. ----
export type Trip = {
  kind: 'gait' | 'roll' | 'none'; from: number; to: number; d: number; dur: number; u: number;
  n: number; L: number; SD: number; SW: number; stag: number; T0: number; tail: number;
  fold: number; unfold: number; turns: number; landed: boolean; planted: Set<number>;
};
export const trip = (o: Partial<Trip>): Trip => ({
  kind: 'none', from: 0, to: 0, d: 1, dur: 0.01, u: 1, n: 1, L: 0, SD: 0, SW: 0, stag: 0, T0: 0, tail: 0,
  fold: 0, unfold: 0, turns: 1, landed: false, planted: new Set(), ...o,
});
export function gait(from: number, to: number, { SD = 0.36, SW = 0.24, stag = 0.08, stride = 120, T0 = 0.12, tail = 0.25 } = {}, u = 1) {
  const dist = to - from, n = Math.max(1, Math.ceil(Math.abs(dist) / (stride * u)));
  return trip({ kind: 'gait', from, to, u, d: dist >= 0 ? 1 : -1, SD, SW, stag, T0, tail, n, L: Math.abs(dist) / n / u, dur: T0 + (n - 1) * SD + 2 * stag + SW + tail });
}
// Each slab steps on its own clock; the position follows their mean, so a planted foot stays put on screen.
export function gaitFn(r: Rig, m: Trip, o: O, s: number) {
  const xs = [0, 0, 0];
  for (let sl = 0; sl < 3; sl++) {
    const j = m.d > 0 ? 2 - sl : sl;
    let x = 0, lift = 0;
    for (let k = 0; k < m.n; k++) {
      const a = m.T0 + k * m.SD + j * m.stag, u = fit(s, a, a + m.SW);
      x += m.L * eio(u);
      lift += bell(u);
      if (u >= 1 && !m.planted.has(k * 3 + sl)) {
        m.planted.add(k * 3 + sl);
        r.imp('b.sq', 24);
        // Footstep light only while idle, so it never mixes with a work pattern.
        if (r.state === 'idle') r.fx.hit(6 + sl, 0.9);
      }
    }
    lift = Math.min(1, lift);
    xs[sl] = x;
    o[`s${sl}.y`] = -lift * (sl === 1 ? 18 : 30);
    o[`s${sl}.r`] = m.d * 7 * lift * (sl === 1 ? 0.5 : 1);
  }
  const mean = (xs[0] + xs[1] + xs[2]) / 3;
  for (let sl = 0; sl < 3; sl++) o[`s${sl}.x`] = m.d * (xs[sl] - mean);
  r.wx = m.from + m.d * mean * m.u;
  const end = m.dur - m.tail;
  o['b.lean'] = 2.2 * m.d * (fit(s, 0.02, 0.22) - fit(s, end - 0.15, end + 0.1));
}
export function roll(from: number, to: number, dur: number, u = 1) {
  const dist = to - from;
  // Whole turns only, so the wheel opens upright without a correcting spin.
  const turns = Math.max(1, Math.round(Math.abs(dist) / (2 * Math.PI * 187 * u)));
  return trip({ kind: 'roll', from, to, u, d: dist >= 0 ? 1 : -1, dur, fold: Math.min(0.1, dur * 0.2), unfold: Math.min(0.15, dur * 0.26), turns });
}
function rollFn(r: Rig, m: Trip, o: O, s: number) {
  const D = m.dur;
  o.w = fit(s, 0, m.fold, 0, 1, eo) * (1 - fit(s, D - m.unfold, D, 0, 1, eio));
  const p = eio(fit(s, m.fold * 0.4, D - m.unfold * 0.5));
  r.wx = m.from + (m.to - m.from) * p;
  o.spin = m.d * m.turns * 360 * p;
  if (s >= D - m.unfold * 0.4 && !m.landed) {
    m.landed = true;
    r.imp('b.sq', 80);
    if (r.state === 'idle') r.light('impact', 0.1);
  }
}
export const travel = (r: Rig, s: number, o: O) => {
  const m = r.move?.trip;
  if (m?.kind === 'gait') gaitFn(r, m, o, s);
  else if (m?.kind === 'roll') rollFn(r, m, o, s);
};
// A look: body shifts, the top row tilts, the near eye flares. Scaled up so it reads at 48 px.
export function look(r: Rig, nx: number, ny: number, hold: number) {
  const down = Math.max(0, ny);
  const keys: O = { 'b.x': nx * 26, 'b.lean': nx * 2.5, 'row0.r': nx * 7, 'b.y': ny * 6, 'g00.p': down * 0.3, 'g10.p': down * 0.3, 'g20.p': down * 0.3 };
  for (const n in keys) r.tgt(n, keys[n]);
  r.fx.hit(nx > 0 ? 5 : 3, 1.3);
  r.later(hold, () => { for (const n in keys) r.tgt(n, r.C[n].rest); }, 'move');
}
// The composer caret in client px (its line's x, the box's middle y), or null without a composer. Reads layout: call in a frame.
let measure: CanvasRenderingContext2D | null = null;
export function caretAt() {
  const ta = document.querySelector<HTMLTextAreaElement>('.input textarea');
  if (!ta) return null;
  const b = ta.getBoundingClientRect();
  measure ??= document.createElement('canvas').getContext('2d')!;
  measure.font = getComputedStyle(ta).font;
  // Multi-line text: only the caret's own line counts.
  const before = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
  return { x: b.left + Math.min(b.width, measure.measureText(before.slice(before.lastIndexOf('\n') + 1)).width), y: b.top + b.height / 2 };
}

// ---- Moves: the composer prototype's catalogue (motion3 poses, cues and sequences, plus looks and light signals). ----
export const MOVES: Record<string, Move> = {
  column: { name: 'Column', pose: { 's0.yaw': 0.8, 's2.yaw': 0.8, 's0.x': 4, 's2.x': -8, 's2.y': 0, 's1.y': -14 }, light: 'pillar' },
  wheel: { name: 'Wheel', pose: { w: 1, spin: 30 }, light: 'ring' },
  stairs: { name: 'Stairs', pose: { 's1.y': -52, 's2.y': -104 }, light: 'climb' },
  exploded: { name: 'Exploded', pose: { 's0.x': -52, 's2.x': 52, 's2.y': 0, ...rowP(0, 'y', -58), ...rowP(1, 'y', -28), 'g00.r': -8, 'g20.r': 8, 'g10.r': 4, 'g01.r': -3, 'g21.r': 3, 'b.sc': 0.9 }, light: 'burst' },
  arch: { name: 'Arch', pose: { 's0.r': 11, 's2.r': -11, 's2.y': 0, 'g10.y': 72 }, light: 'caret' },
  cheer: { name: 'Cheer', pose: { 's0.r': -14, 's2.r': 14, 's1.y': -18, 's2.y': 0 }, light: 'vee' },
  arrow: { name: 'Arrow', pose: (d) => ({ ...rowP(0, 'x', -40 * d), ...rowP(1, 'x', 40 * d), ...rowP(2, 'x', -40 * d), 'b.lean': 3 * d }), light: (d) => (d > 0 ? 'chevR' : 'chevL') },
  bow: { name: 'Bow', pose: { ...rowP(0, 'p', 0.8), 'b.sq': 9, 'b.lean': 0 }, lid: [0.5, 0.5], light: 'trickle' },
  roof: { name: 'Roof', pose: { 'g00.r': 48, 'g20.r': -48, 's0.x': 6, 's2.x': -6, 'g10.y': 34, 's2.y': 0 }, z: [1, 0, 2], light: 'warm' },
  heart: { name: 'Heart', pose: { 'g01.r': -22, 'g21.r': 22, 's0.x': 40, 's2.x': -40, 'g10.y': 103, 's2.y': 0 }, z: [0, 2, 1], light: 'heart' },
  surprised: { name: 'Surprised', pose: { ...rowP(0, 'y', -20), 'b.sc': 1.03, 'b.y': -8, 's2.y': 0 }, spread: 0, hold: 1.6, light: 'surprise' },
  visor: { name: 'Visor', pose: { ...rowP(0, 'p', 0.55), ...rowP(2, 'p', 0.6), 'b.y': 54, 'g01.x': -6, 'g21.x': 6, 's2.y': 0 }, light: 'kitt' },
  sleepy: { name: 'Sleepy', pose: { 'b.sq': 6, ...rowP(0, 'p', 0.4), 'row0.r': -7, 'b.lean': -2, 's2.y': 28 }, lid: [0.75, 0.75], hold: 2.8, light: 'zz' },
  curious: { name: 'Curious', pose: { 'row0.r': 13, 'b.lean': 3, 'g20.y': -12, 's2.y': 0 }, lid: [0.35, 0], light: 'query' },
  headTilt: {
    name: 'Head Tilt', dur: 2.4,
    cues: [[0, (r) => (r.tgt('row0.r', -15), r.fx.hit(3, 1.2))], [0.8, (r) => (r.tgt('row0.r', 15), r.fx.hit(5, 1.2))], [1.6, (r) => r.tgt('row0.r', 0)]],
  },
  hipSwing: {
    name: 'Hip Swing', dur: 2.3, light: 'feet', lightDur: 1.8,
    cues: [11, -11, 8, -5, 0].map((v, i): [number, (r: Rig) => void] => [i * 0.36, (r) => (r.tgt('row2.r', v), r.tgt('row0.r', -v * 0.35))]),
  },
  twist: {
    name: 'Twist & Return', dur: 2.1, light: 'zed', lightDur: 1,
    cues: [[0, (r) => (r.tgt('row0.r', -7), r.tgt('row2.r', 7))], [0.2, (r) => (r.tgt('row0.r', 40), r.tgt('row2.r', -40))], [1.05, (r) => (r.tgt('row0.r', 0), r.tgt('row2.r', 0))]],
  },
  propeller: {
    name: 'Propeller', dur: 2.7, piv: [[1, 0]], z: [0, 2, 1],
    seq(r, s, o) {
      o['g10.y'] = -100 * fit(s, 0, 0.3, 0, 1, eo) * (1 - fit(s, 1.95, 2.3, 0, 1, eob));
      const a = 720 * eio(fit(s, 0.25, 1.95));
      o['g10.r'] = s >= 1.95 ? 0 : a;
      const n = Math.floor(a / 180);
      if (n === mv(r).n) return;
      mv(r).n = n;
      if (n > 0) r.fx.hit(1, 1.2);
    },
  },
  flapWave: {
    name: 'Flap Wave', dur: 2.0,
    seq(r, s, o) {
      for (const [sl, k] of SEGS) {
        const n = k * 3 + sl, a = 0.08 + n * 0.08, u = fit(s, a, a + 0.42, 0, 1, eio);
        o[`g${sl}${k}.f`] = u >= 1 ? 0 : 360 * u;
        if (u < 1 || mv(r).seen.has(n)) continue;
        mv(r).seen.add(n);
        r.fx.hit(n, 1.1);
      }
    },
  },
  ripple: {
    name: 'Ripple', dur: 2.0,
    cues: [0, 1, 2].flatMap((s): [number, (r: Rig) => void][] => [
      [s * 0.1, (r) => (r.tgt(`s${s}.r`, 9), r.fx.hit(6 + s, 1))], [s * 0.1 + 0.2, (r) => r.tgt(`s${s}.r`, 0)],
      [0.75 + (2 - s) * 0.1, (r) => (r.tgt(`s${s}.r`, -9), r.fx.hit(6 + s, 1))], [0.95 + (2 - s) * 0.1, (r) => r.tgt(`s${s}.r`, 0)],
    ]),
  },
  ratchet: {
    name: 'Ratchet', dur: 3.2, piv: [[0, 0], [1, 0], [2, 0]],
    cues: [
      ...Array.from({ length: 12 }, (_, i): [number, (r: Rig) => void] => [0.1 + i * 0.2, (r) => {
        const s = i % 3;
        r.tgt(`g${s}0.r`, r.C[`g${s}0.r`].t + 90);
        r.fx.hit(s, 1.1);
      }]),
      [2.95, (r) => { for (let s = 0; s < 3; s++) (r.C[`g${s}0.r`].x -= 360), (r.C[`g${s}0.r`].t -= 360); }],
    ],
  },
  scramble: {
    name: 'Scramble', dur: 2.3, light: 'sparkle', lightDur: 1.1,
    cues: [
      [0, (r) => r.setPose({ 'g01.r': 20, 'g00.r': -30, 'g02.r': 14, 'g11.r': -9, 'g10.y': -30, 'g10.r': 24, 'g21.r': 26, 'g20.r': 36, 'g22.r': -14, 's2.y': -16, 's0.y': 10 }, 0.07)],
      [1.15, (r) => (r.setPose({}, 0), r.light('burst', 0.3))],
    ],
  },
  hop: {
    name: 'Hop', dur: 1.7,
    cues: [[0.3, (r) => (r.fx.hit(3, 1.3), r.fx.hit(5, 1.3))], [0.84, (r) => r.land(260)]],
    seq(_r, s, o) {
      const crouch = fit(s, 0, 0.28, 0, 1, eo) * (1 - fit(s, 0.3, 0.38)), u = fit(s, 0.36, 0.84), air = s > 0.36 && s < 0.84 ? 4 * u * (1 - u) : 0;
      o['b.sq'] = 4 * crouch - 5 * pulse(s, 0.3, 0.37, 0.62);
      o['b.y'] = -105 * air;
      rows(o, 0, 'y', 22 * crouch - 10 * air); rows(o, 1, 'y', 11 * crouch); rows(o, 2, 'y', 8 * air);
      o['s0.r'] = -4 * air; o['s2.r'] = 4 * air;
    },
  },
  flip: {
    name: 'Flip', dur: 2.1,
    cues: [[0.42, (r) => r.light('ring', 0.7)], [1.14, (r) => r.land(340)]],
    seq(_r, s, o) {
      const crouch = fit(s, 0, 0.32, 0, 1, eo) * (1 - fit(s, 0.34, 0.42)), u = fit(s, 0.4, 1.14), air = s > 0.4 && s < 1.14 ? 4 * u * (1 - u) : 0;
      o['b.sq'] = 5 * crouch - 5 * pulse(s, 0.34, 0.41, 0.6);
      o['b.y'] = -160 * air;
      o.spin = s >= 1.1 ? 0 : 360 * eio(fit(s, 0.44, 1.1));
      const tuck = Math.min(1, air * 1.6);
      o['s0.x'] = 16 * tuck; o['s2.x'] = -16 * tuck;
      rows(o, 0, 'y', 24 * crouch + 14 * tuck); rows(o, 1, 'y', 12 * crouch); rows(o, 2, 'y', -14 * tuck);
    },
  },
  stretch: {
    name: 'Stretch', dur: 2.9,
    cues: [[2.0, (r) => r.light('fill', 0.5)]],
    seq(r, s, o) {
      const up = fit(s, 0.35, 1.0, 0, 1, eio) * (1 - fit(s, 1.7, 1.95, 0, 1, eo)), pre = pulse(s, 0, 0.25, 0.4);
      o['b.sq'] = 5 * pre - 7 * up;
      rows(o, 0, 'y', -24 * up); rows(o, 1, 'y', -11 * up);
      o['g00.r'] = -32 * up; o['g20.r'] = 32 * up;
      if (up > 0.9) o['b.x'] = (hash(Math.floor(s * 30), 1) - 0.5) * 2.4 * up;
      o['b.r'] = 3 * ring(s - 1.95, 4, 4);
      r.lidL = r.lidR = 0.8 * up;
      if (up > 0.5) r.fx.hit(7, 0.55 * up);
    },
  },
  shakeOff: {
    name: 'Shake Off', dur: 1.7,
    cues: [[0, (r) => r.light('sparkle', 1)], [1.25, (r) => r.imp('b.sq', 120)]],
    seq(_r, s, o) {
      o['b.r'] = 6 * ring(s, 5.2, 2.8);
      for (let k = 0; k < 3; k++) rows(o, k, 'x', (k % 2 ? -1 : 1) * 20 * ring(s - 0.035 * k, 5.2, 2.8) * (k === 1 ? 0.6 : 1));
      o['b.sq'] = 3 * pulse(s, 0, 0.1, 0.3);
    },
  },
  peek: {
    name: 'Peek', dur: 2.6,
    enter: (r) => void (mv(r).d = r.side()),
    cues: [[0.95, (r) => r.fx.hit(mv(r).d > 0 ? 5 : 3, 1.6)], [1.85, (r) => r.imp('b.lean', -mv(r).d * 40)]],
    seq(r, s, o) {
      const d = mv(r).d, e = fit(s, 0.1, 0.55, 0, 1, eio) * (1 - fit(s, 1.55, 1.85, 0, 1, eo));
      o['b.lean'] = 13 * d * e; o['b.x'] = 26 * d * e; o['row0.r'] = -10 * d * e;
      rows(o, 0, 'y', -6 * pulse(s, 0.9, 1.0, 1.2));
      if (d > 0) r.lidL = 0.5 * e;
      else r.lidR = 0.5 * e;
    },
  },
  nod: {
    name: 'Nod', dur: 1.5,
    cues: [[0.28, (r) => r.fx.hit(7, 1)], [0.68, (r) => r.fx.hit(7, 1)]],
    seq(_r, s, o) {
      const n = pulse(s, 0.1, 0.28, 0.5) + pulse(s, 0.5, 0.68, 0.95);
      rows(o, 0, 'p', 0.55 * n);
      o['b.y'] = 5 * n;
    },
  },
  doubleTake: {
    name: 'Double Take', dur: 2.6,
    enter: (r) => void (mv(r).d = r.side()),
    cues: [[1.27, (r) => r.light('surprise', 0.9)]],
    seq(r, s, o) {
      const d = mv(r).d, casual = pulse(s, 0.05, 0.45, 1.0), snap = pulse(s, 1.25, 1.33, 2.3), brow = pulse(s, 1.25, 1.31, 1.9);
      o['b.x'] = 16 * d * casual + 26 * d * snap; o['b.lean'] = 4 * d * snap;
      o['row0.r'] = -6 * d * casual - 9 * d * snap;
      rows(o, 0, 'y', -26 * brow); o['b.sc'] = 0.035 * brow; o['b.y'] = -14 * pulse(s, 1.25, 1.33, 1.6);
    },
  },
  wave: {
    name: 'Wave', dur: 2.7,
    cues: [0.53, 0.99, 1.44, 1.9].map((x): [number, (r: Rig) => void] => [x, (r) => r.fx.hit(2, 1.2)]),
    seq(_r, s, o) {
      const up = fit(s, 0.1, 0.42, 0, 1, eo) * (1 - fit(s, 2.0, 2.35, 0, 1, eio));
      const osc = Math.sin(2 * Math.PI * 2.2 * (s - 0.42)) * fit(s, 0.42, 0.6) * (1 - fit(s, 1.8, 2.0));
      o['g20.r'] = up * (52 + 20 * osc); o['s2.y'] = -16 * up; o['s2.x'] = 6 * up; o['b.lean'] = -2 * up;
    },
  },
  // Signals
  glance: {
    name: 'Glance', dur: 2,
    enter(r) {
      const p = dir(r).ptrN() ?? { nx: r.side() * 0.7, ny: rand(-0.3, 0.3) }, hold = rand(0.8, 1.4);
      look(r, p.nx, p.ny, hold);
      mv(r).dur = hold + 0.6;
    },
  },
  caretLook: {
    name: 'Look at the caret', dur: 1.5,
    enter(r) {
      const c = dir(r).stage.caret();
      look(r, c.nx, c.ny, 0.9);
    },
  },
  wink: { name: 'Wink', dur: 0.9, cues: [[0.05, (r) => ((r.lidR = 1), hop(r, 'g20.y', -8, 0.2))], [0.3, (r) => (r.lidR = 0)]] },
  ping: {
    name: 'Ping', dur: 1.7, light: 'ping', lightDur: 1.5,
    seq: (_r, s, o) => void (o['b.sc'] = 0.012 * (pulse(s, 0, 0.08, 0.4) + pulse(s, 0.8, 0.88, 1.2))),
  },
  ellipsis: {
    name: 'Ellipsis', dur: 1.9, light: 'ellipsis', lightDur: 1.8,
    cues: [0.05, 0.25, 0.45, 0.65, 0.85, 1.05, 1.25, 1.45, 1.65].map((x, i): [number, (r: Rig) => void] => [x, (r) => hop(r, `g${i % 3}2.y`, -5, 0.08)]),
  },
  sparkle: { name: 'Sparkle', dur: 1.1, light: 'sparkle', lightDur: 0.9 },
  pointTo: {
    name: 'Point', dur: 1.5,
    enter(r) {
      mv(r).d = r.side();
      r.light(mv(r).d > 0 ? 'chevR' : 'chevL', 1.1);
    },
    seq: (r, s, o) => void (o['b.lean'] = 2.5 * mv(r).d * pulse(s, 0.05, 0.3, 1.3)),
  },
  twitch: {
    name: 'Twitch', dur: 0.5,
    enter(r) {
      const [s, k] = SEGS[(Math.random() * 9) | 0];
      r.tgt(`g${s}${k}.x`, (Math.random() < 0.5 ? -1 : 1) * 12);
      r.later(0.12, () => r.tgt(`g${s}${k}.x`, 0), 'move');
    },
  },
  fix: { name: 'Re-level', dur: 1.5, cues: [[0, (r) => r.tgt('s2.y', 0)], [0.9, (r) => r.tgt('s2.y', 16)]] },
  // A slow sway in place, small enough to sit next to someone typing.
  sway: {
    name: 'Sway', dur: 2.2,
    enter: (r) => void (mv(r).d = Math.random() < 0.5 ? -1 : 1),
    seq(r, s, o) {
      const e = bell(fit(s, 0, 2.2)), w = mv(r).d * Math.sin(2 * Math.PI * 0.9 * s);
      o['b.lean'] = 1.6 * w * e; o['row0.r'] = 5 * w * e; o['row2.r'] = -2.5 * w * e;
    },
  },
};
// Units a move rises above the head; the director skips the ones the host cannot hold.
const UP: Record<string, number> = { hop: 115, flip: 240, stairs: 110, propeller: 110, exploded: 60, twist: 90, wave: 80, stretch: 30, cheer: 40, scramble: 40, ratchet: 60, surprised: 30, column: 20, wheel: 40 };
const PTR_ONLY = new Set(['glance', 'pointTo']);
// A click opens him: the hold runs from the click (about 0.25 s to open, then ~0.8 s), and each later click keeps him open TAIL more.
const OPEN_HOLD = 1.05;
const OPEN_TAIL = 0.6;
// Now and then a click gets another act instead, weighted; never the first click and never two in a row.
const OTHER = 0.25;
const OTHERS: Record<string, number> = { hop: 3, twist: 2, propeller: 2, wink: 2, ping: 1.5, flip: 0.6 };

// ---- The director: the tier comes from recent input. Free roams, typing stays in place, a click or scroll yields briefly. ----
export class Director {
  r: Rig;
  stage: Stage;
  lastYield = -99;
  ptr: { x: number; y: number } | null = null;
  ptrT = -99;
  private lastType = -99;
  private glanceAt = -99;
  private cool: Record<string, number> = {};
  private prev = '';
  private nextBig = 0;
  private quiet: Set<string>;
  private off: () => void;
  // Clicks: how many so far, whether the last one got another act, and the open hold's deadline and single timer.
  private pokes = 0;
  private other = false;
  private lastOther = '';
  private otherAt = -99;
  private openAt = 0;
  private shutAt = 0;
  private shutT = 0;
  private nudgeAt = -99;
  private greetAt = -99;

  constructor(r: Rig, stage: Stage) {
    this.r = r;
    this.stage = stage;
    this.quiet = new Set(Object.keys(stage.typing));
    dirs.set(r, this);
    r.pointer = () => this.ptrN();
    const inInput = (e: Event) => !!(e.target as Element | null)?.closest?.('.input');
    // Keys in the composer are typing; keys elsewhere (shortcuts) only make him yield.
    const onKey = (e: Event) => (inInput(e) ? this.type() : this.yieldNow());
    const onType = (e: Event) => inInput(e) && this.type();
    const onScroll = (e: Event) => (e.target as Element | null)?.closest?.('.conv') && this.yieldNow();
    const onDown = () => this.yieldNow();
    const onMove = (e: PointerEvent) => e.pointerType === 'mouse' && this.pointer(e.clientX, e.clientY);
    const opt = { capture: true, passive: true };
    document.addEventListener('keydown', onKey, opt);
    document.addEventListener('input', onType, opt);
    document.addEventListener('wheel', onScroll, opt);
    document.addEventListener('touchmove', onScroll, opt);
    document.addEventListener('pointerdown', onDown, opt);
    document.addEventListener('pointermove', onMove, { passive: true });
    this.off = () => {
      document.removeEventListener('keydown', onKey, opt);
      document.removeEventListener('input', onType, opt);
      document.removeEventListener('wheel', onScroll, opt);
      document.removeEventListener('touchmove', onScroll, opt);
      document.removeEventListener('pointerdown', onDown, opt);
      document.removeEventListener('pointermove', onMove);
    };
    if (!r.still) this.blinks();
  }
  destroy() {
    this.off();
    clearTimeout(this.shutT);
    dirs.delete(this.r);
  }

  // ---- A click on him. Every click is O(1): it moves a deadline, so no input pattern can queue work. ----
  poke() {
    const r = this.r, now = r.now(), m = r.move, o = r.C.open;
    if (r.dead || document.hidden) return;
    this.lastYield = now;
    const first = this.pokes++ === 0;
    if (m?.by === 'poke') {
      // A double click lands inside the act; a later click cuts it (springs carry it home) and opens.
      if (now - this.otherAt < 0.35) return;
      r.stopMove();
    } else if (m && m.by !== 'turn') r.stopMove();
    const rest = o.t === 0 && o.ok && r.C.bloom.ok;
    if (rest && !first && !this.other && this.calm() && Math.random() < OTHER) {
      const id = this.pickOther();
      if (id) {
        this.other = true;
        this.lastOther = id;
        this.otherAt = now;
        return this.play(id, 'poke');
      }
    }
    this.other = false;
    if (o.t === 0) this.openAt = now;
    // Clicks while open: the dots swell a touch, at most four times a second.
    else if (now - this.nudgeAt > 0.25 && !r.still) (this.nudgeAt = now), r.imp('bloom', 1.4), r.wake();
    this.shutAt = Math.max(this.openAt + OPEN_HOLD, now + OPEN_TAIL);
    r.openUp(true);
    if (!this.shutT) this.armShut();
  }
  private armShut() {
    const r = this.r;
    this.shutT = window.setTimeout(() => {
      this.shutT = 0;
      if (r.dead) return;
      if (this.shutAt - r.now() > 0.02) return this.armShut();
      r.openUp(false);
      // He rests a moment after closing before the director picks the next act.
      this.lastYield = r.now();
    }, Math.max(0, (this.shutAt - r.now()) * 1000));
  }
  // Pointer over him: the eyes brighten and he perks up; light only on the idle face, never over a work pattern.
  greet() {
    const r = this.r, now = r.now();
    if (r.still || r.benched || document.hidden || r.C.open.t || now - this.greetAt < 1.5) return;
    this.greetAt = now;
    if (r.m.name === 'eyes') (r.fx.hit(3, 1.4), r.fx.hit(5, 1.4));
    r.imp('b.y', -40);
    r.wake();
  }
  // Another act only on the floor at rest; a turn always gets the open, which keeps its LED pattern readable.
  private calm() {
    const r = this.r;
    return !r.still && !r.benched && r.state === 'idle' && !this.stage.busy() && !r.falling && !r.hovering;
  }
  private pickOther() {
    const room = this.stage.headroom(), list = Object.keys(OTHERS).filter((id) => this.stage.moves[id] && (UP[id] ?? 0) <= room && id !== this.lastOther);
    let x = Math.random() * list.reduce((a, id) => a + OTHERS[id], 0);
    for (const id of list) if ((x -= OTHERS[id]) <= 0) return id;
    return list.at(-1);
  }

  // Pointer around him, or null when it has not moved for 30 s.
  ptrN() {
    if (!this.ptr || this.r.now() - this.ptrT > 30) return null;
    return this.stage.around(this.ptr.x, this.ptr.y);
  }
  private ready() {
    const r = this.r;
    return !r.still && !r.benched && !document.hidden && r.state === 'idle' && !this.stage.busy() && !r.move && !r.falling && !r.C.open.t;
  }
  private tier(): Tier {
    const now = this.r.now();
    if (now - this.lastYield < YIELD) return 'yield';
    return now - this.lastType < TYPE_HOLD ? 'typing' : 'free';
  }
  private pick(table: Table) {
    const now = this.r.now(), list: [string, number][] = [], room = this.stage.headroom();
    let sum = 0;
    for (const id in table) {
      const [w, cd] = table[id], last = this.cool[id], again = id === this.prev;
      if (now - (last ?? -999) < cd || (UP[id] ?? 0) > room) continue;
      if (PTR_ONLY.has(id) && (!this.ptrN() || now - this.glanceAt < rand(10, 18))) continue;
      const wt = this.stage.weight ? this.stage.weight(id, w, again, last) : again ? 0 : w;
      if (wt <= 0) continue;
      list.push([id, wt]);
      sum += wt;
    }
    let x = Math.random() * sum;
    for (const [id, w] of list) if ((x -= w) <= 0) return id;
    return list.at(-1)?.[0];
  }
  play(id: string, by = 'dir') {
    const M = this.stage.moves[id];
    this.r.play(id, M, by, by === 'dir' && M.pose ? rand(1.2, 2.2) : undefined);
  }
  private go(id: string) {
    const r = this.r;
    this.cool[id] = r.now();
    this.prev = id;
    if (PTR_ONLY.has(id)) this.glanceAt = r.now();
    this.play(id);
  }
  // Big acts run only in the free tier; otherwise the check comes back once the tier can have changed.
  private big() {
    const r = this.r, now = r.now(), P = this.stage.pace;
    if (this.tier() !== 'free') return this.schedule(Math.max(this.lastYield + YIELD, this.lastType + TYPE_HOLD) - now + rand(0.4, 1.2));
    if (!this.ready()) return this.schedule(r.move ? 0.8 : 1.5);
    const id = this.pick(this.stage.big);
    if (id) {
      if (Math.random() < 0.3) r.blink();
      this.go(id);
    }
    this.schedule((r.move?.dur ?? 0) + rand(...P.rest));
  }
  private schedule(d: number) {
    const r = this.r;
    r.clearTimers('dir');
    this.nextBig = r.now() + d;
    r.later(d, () => this.big(), 'dir');
  }
  private small() {
    const r = this.r, t = this.tier(), P = this.stage.pace;
    if (t !== 'yield' && this.ready() && (t === 'typing' || this.nextBig - r.now() > 1.8)) {
      const id = this.pick(t === 'typing' ? this.stage.typing : this.stage.small);
      if (id) this.go(id);
    }
    r.later(rand(...(t === 'typing' ? P.typing : P.small)), () => this.small(), 'dir2');
  }
  private blinks() {
    const r = this.r;
    if (!r.still && r.state === 'idle' && !this.stage.busy()) {
      r.blink();
      if (Math.random() < 0.2) r.later(0.3, () => r.blink(), 'idle');
    }
    r.later(rand(2.6, 6.4), () => this.blinks(), 'life');
  }
  start() {
    const r = this.r;
    r.clearTimers('dir', 'dir2');
    if (r.still) return;
    this.schedule(rand(...this.stage.pace.first));
    r.later(rand(1, 2), () => this.small(), 'dir2');
  }
  // A big act stops where it is (springs carry it home); small in-place ones may finish. Returns whether it cut.
  private cut() {
    const m = this.r.move;
    if (m?.by !== 'dir' || this.quiet.has(m.id)) return false;
    this.r.stopMove();
    return true;
  }
  private yieldNow() {
    this.lastYield = this.r.now();
    if (this.cut()) this.schedule(YIELD + rand(0.6, 1.6));
  }
  // Pointer moves never cut the show; after a still spell one may earn a short glance.
  private pointer(x: number, y: number) {
    const r = this.r, now = r.now(), was = this.ptrT;
    this.ptr = { x, y };
    this.ptrT = now;
    if (now - was > 6 && now - this.glanceAt > 8 && this.ready() && this.tier() === 'free' && Math.random() < 0.5) {
      this.glanceAt = now;
      r.later(0.25, () => this.ready() && this.play('glance'), 'dir2');
    }
  }
  // Typing quiets him without freezing him; the first key of a burst earns one look at the caret, played in the next frame.
  private type() {
    const r = this.r, now = r.now(), fresh = now - this.lastType > 2.5;
    this.lastType = now;
    // The first key cuts even a quiet act, so the look always lands.
    const cut = fresh && r.move?.by === 'dir' ? (r.stopMove(), true) : this.cut();
    if (cut) this.schedule(TYPE_HOLD + rand(0.5, 1.5));
    if (fresh && !r.still && !r.benched) r.later(0, () => this.ready() && this.play('caretLook', 'type'), 'dir2');
  }
}
